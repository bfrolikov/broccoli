"use strict";
let queue = Promise.resolve();
let generation = 0;
// Session storage is private to trusted extension contexts by default. Protect
// Chrome's legacy local storage too, until any old refresh token is removed.
const storageRestricted = isChromeExtension
  ? Promise.all([
      extensionAPI.storage.local.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      }),
      extensionAPI.storage.session.setAccessLevel({
        accessLevel: "TRUSTED_CONTEXTS",
      }),
    ])
  : Promise.resolve();
const storageReady = storageRestricted.then(migrateLegacySettings);
storageReady.catch(() => {});
function serial(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}
function isProductionOrigin(raw) {
  try {
    return new URL(raw).origin === API_URL;
  } catch {
    return false;
  }
}
async function migrateLegacySettings() {
  const { apiURL: previousURL, refreshToken } =
    await extensionAPI.storage.local.get(["apiURL", "refreshToken"]);
  const { loginDraft, draftEpoch, refreshToken: currentRefreshToken } =
    await extensionAPI.storage.session.get([
      "loginDraft",
      "draftEpoch",
      "refreshToken",
    ]);
  const customSession = !!previousURL && !isProductionOrigin(previousURL);
  const customDraft =
    !!loginDraft?.apiURL && !isProductionOrigin(loginDraft.apiURL);
  if (customSession) await clearAuth();
  else if (!currentRefreshToken && typeof refreshToken === "string" && refreshToken)
    await extensionAPI.storage.session.set({ refreshToken });
  await extensionAPI.storage.local.remove(["apiURL", "refreshToken"]);
  if (customSession || loginDraft?.apiURL !== undefined || loginDraft?.password !== undefined) {
    await extensionAPI.storage.session.set({
      loginDraft:
        customSession || customDraft || typeof loginDraft?.username !== "string"
          ? {}
          : { username: loginDraft.username },
      draftEpoch: (draftEpoch || 0) + 1,
    });
  }
}
async function notify() {
  generation++;
  const tabs = await extensionAPI.tabs.query({
    url: "https://www.youtube.com/*",
  });
  await Promise.all(
    tabs.map((t) =>
      extensionAPI.tabs.sendMessage(t.id, { type: "changed" }).catch(() => {}),
    ),
  );
}
async function clearAuth() {
  await extensionAPI.storage.session.remove(["accessToken", "expires", "refreshToken"]);
  await notify();
}
const registrationErrors = {
  400: "Enter a valid email and a password of at least 8 characters and at most 72 UTF-8 bytes.",
  403: "Ask the admin to approve this email before registering.",
  409: "This email is already registered. Please log in.",
  429: "Too many registration attempts. Please try again in a minute.",
};
const recoveryRequests = {
  requestResetCode: {
    path: "/auth/forgot-password",
    invalid: "Enter a valid account email address.",
    limited: "Too many requests for a reset code.",
  },
  checkResetCode: {
    path: "/auth/check-token",
    invalid: "Check your email address and enter the six-digit reset code.",
    limited: "Too many attempts to verify a reset code.",
  },
  resetPassword: {
    path: "/auth/reset-password",
    invalid: "The reset details were rejected. Use at least 8 characters and at most 72 UTF-8 bytes for the new password.",
    limited: "Too many attempts to reset your password.",
  },
};
const recoveryCooldowns = new Map();
async function request(path, body, token) {
  // Finite API calls reset Chrome's worker idle timer while a check is pending.
  const heartbeat = isChromeExtension
    ? setInterval(() => {
        extensionAPI.runtime.getPlatformInfo().catch(() => {});
      }, 20000)
    : null;
  try {
    const res = await fetch(API_URL + path, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(65000),
    });
    if (!res.ok) {
      const error = Error(
        path === "/auth/register"
          ? registrationErrors[res.status] || "Unable to create an account. Please try again."
          : res.status === 401
          ? path === "/auth/login"
            ? "Incorrect email, username, or password."
            : "Your session expired. Please log in again."
          : "Unable to reach the API or check this video.",
      );
      error.status = res.status;
      if (res.status === 429) error.retryAfter = res.headers.get("Retry-After")?.trim();
      if (path === "/auth/reset-password" && res.status === 400) {
        error.invalidResetCode = (await res.text()).trim() === "Invalid reset token";
      }
      throw error;
    }
    return res.status === 204 ? null : await res.json();
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
  }
}
function retryDeadline(header, now) {
  if (/^\d+$/.test(header)) {
    const deadline = now + Number(header) * 1000;
    if (Number.isFinite(deadline)) return deadline;
  }
  const deadline = /^[A-Za-z]/.test(header || "") ? Date.parse(header) : NaN;
  return Number.isFinite(deadline) ? deadline : now + 60000;
}
function recoveryLimitMessage(message, deadline) {
  const seconds = Math.ceil((deadline - Date.now()) / 1000);
  if (seconds <= 0) return message + " Please try again.";
  return message + ` Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}
async function recoverPassword(msg, operation) {
  const { refreshToken } = await extensionAPI.storage.session.get("refreshToken");
  if (refreshToken) throw Error("Log out before resetting your password.");

  const { email, token, password } = msg;
  const { path, invalid, limited } = operation;
  const cooldown = recoveryCooldowns.get(path);
  if (cooldown) {
    if (cooldown.deadline <= Date.now()) recoveryCooldowns.delete(path);
    else if (cooldown.email === email) throw Error(recoveryLimitMessage(limited, cooldown.deadline));
  }

  const body = { email };
  if (msg.type !== "requestResetCode") body.token = token;
  if (msg.type === "resetPassword") body.new_password = password;

  let data;
  try {
    data = await request(path, body);
  } catch (e) {
    if (e.invalidResetCode) return { invalidCode: true };
    if (e.status === 400) throw Error(invalid);
    if (e.status === 429) {
      const deadline = retryDeadline(e.retryAfter, Date.now());
      recoveryCooldowns.set(path, { email, deadline });
      throw Error(recoveryLimitMessage(limited, deadline));
    }
    throw Error("Password recovery is temporarily unavailable. Please try again.");
  }

  if (msg.type === "checkResetCode") {
    if (typeof data?.valid !== "boolean") throw Error("Unable to verify the code. Please try again.");
    return { valid: data.valid };
  }
  if (data !== null) throw Error("Unable to confirm the request. Please try again.");
  if (msg.type === "resetPassword") await resetDraft(email);
  return { ok: true };
}
async function saveTokens(data) {
  if (
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    data.expires_in !== 900
  )
    throw Error("Invalid login response.");
  await extensionAPI.storage.session.set({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
async function access(force = false) {
  const { accessToken, expires, refreshToken } = await extensionAPI.storage.session.get([
    "accessToken",
    "expires",
    "refreshToken",
  ]);
  if (!force && accessToken && expires > Date.now() + 30000) return accessToken;
  if (!refreshToken) {
    const e = Error("Please log in.");
    e.status = 401;
    throw e;
  }
  try {
    return await saveTokens(
      await request("/auth/refresh", {
        refresh_token: refreshToken,
      }),
    );
  } catch (e) {
    if (e.status === 401) await clearAuth();
    throw e;
  }
}
async function logout() {
  const { refreshToken } = await extensionAPI.storage.session.get("refreshToken");
  await clearAuth();
  await resetDraft();
  if (refreshToken) {
    try {
      await request("/auth/logout", { refresh_token: refreshToken });
    } catch {
      throw Error(
        "Signed out locally. Server revocation failed; the session will expire automatically.",
      );
    }
  }
}
async function resetDraft(username) {
  const { draftEpoch } = await extensionAPI.storage.session.get("draftEpoch");
  await extensionAPI.storage.session.set({
    loginDraft: username === undefined ? {} : { username },
    draftEpoch: (draftEpoch || 0) + 1,
  });
}
// Called inside the auth queue; do not enqueue a second operation here.
async function authenticatedRequest(path, body) {
  let token = await access();
  try {
    return await request(path, body, token);
  } catch (e) {
    if (e.status !== 401) throw e;
    token = await access(true);
    return request(path, body, token);
  }
}
function videoID(raw) {
  const u = new URL(raw);
  if (u.origin !== "https://www.youtube.com") return null;
  const id =
    u.pathname === "/watch"
      ? u.searchParams.get("v")
      : u.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
  return /^[\w-]{11}$/.test(id || "") ? id : null;
}
function handleMessage(msg, sender) {
  if (sender.id !== extensionAPI.runtime.id || typeof msg?.type !== "string") return;
  if (msg.type === "check") {
    // sender.url can retain the document's original URL after YouTube uses
    // history.pushState. Validate the source origin, then read the current tab URL.
    let source;
    try {
      source = new URL(sender.url);
    } catch {
      return Promise.resolve({ state: "error" });
    }
    if (
      !sender.tab ||
      source.origin !== "https://www.youtube.com" ||
      (sender.frameId !== undefined && sender.frameId !== 0) ||
      typeof msg.videoID !== "string" ||
      !/^[\w-]{11}$/.test(msg.videoID)
    )
      return Promise.resolve({ state: "error" });
    return (async () => {
      const epoch = generation;
      try {
        const tab = await extensionAPI.tabs.get(sender.tab.id);
        if (videoID(tab.url) !== msg.videoID) return { state: "stale" };
        let token = await serial(() =>
          epoch === generation ? access() : null,
        );
        if (epoch !== generation) return { state: "stale" };
        let data;
        try {
          data = await request(
            `/videos/${encodeURIComponent(msg.videoID)}/check`,
            null,
            token,
          );
        } catch (e) {
          if (e.status !== 401) throw e;
          if (epoch !== generation) return { state: "stale" };
          token = await serial(async () => {
            if (epoch !== generation) return null;
            const current =
              await extensionAPI.storage.session.get("accessToken");
            return access(current.accessToken === token);
          });
          if (epoch !== generation) return { state: "stale" };
          data = await request(
            `/videos/${encodeURIComponent(msg.videoID)}/check`,
            null,
            token,
          );
        }
        if (epoch !== generation) return { state: "stale" };
        if (data.status !== "OK" || typeof data.allowed !== "boolean")
          throw Error("Invalid check response");
        return { state: data.allowed ? "allowed" : "blocked" };
      } catch (e) {
        return { state: e.status === 401 ? "login" : "error" };
      }
    })();
  }
  if (sender.url !== extensionAPI.runtime.getURL("popup.html")) return;
  return serial(async () => {
    try {
      if (msg.type === "draftGet") {
        const data = await extensionAPI.storage.session.get([
          "loginDraft",
          "draftEpoch",
        ]);
        return { draft: data.loginDraft || {}, epoch: data.draftEpoch || 0 };
      }
      if (msg.type === "draftSet") {
        const data = await extensionAPI.storage.session.get("draftEpoch");
        if (msg.epoch !== (data.draftEpoch || 0)) return { ok: false };
        const username = msg.draft?.username;
        if (typeof username !== "string" || username.length > 8192)
          throw Error("Invalid login draft.");
        await extensionAPI.storage.session.set({ loginDraft: { username } });
        return { ok: true };
      }
      if (msg.type === "categoriesGet") {
        const data = await authenticatedRequest("/categories/");
        if (
          data.status !== "OK" ||
          !Array.isArray(data.categories) ||
          data.categories.some((c) => typeof c !== "string")
        )
          throw Error("Invalid category response.");
        return { categories: data.categories };
      }
      if (msg.type === "categoriesSet") {
        if (
          !Array.isArray(msg.categories) ||
          msg.categories.some((c) => typeof c !== "string")
        )
          throw Error("Invalid categories.");
        const data = await authenticatedRequest("/categories/", {
          categories: msg.categories,
        });
        if (data.status !== "OK") throw Error("Unable to save categories.");
        await notify();
        return { ok: true };
      }
      if (msg.type === "status") {
        const { refreshToken } =
          await extensionAPI.storage.session.get("refreshToken");
        return {
          loggedIn: !!refreshToken,
        };
      }
      if (Object.hasOwn(recoveryRequests, msg.type)) {
        return await recoverPassword(msg, recoveryRequests[msg.type]);
      }
      if (msg.type === "register") {
        const { refreshToken } = await extensionAPI.storage.session.get("refreshToken");
        if (refreshToken) throw Error("Log out before creating an account.");
        const { email, password } = msg;
        const credentials = { email, password };
        const registration = await request("/auth/register", credentials);
        if (registration?.status !== "OK") throw Error("Unable to confirm account creation.");
        await resetDraft(email);
        try {
          await saveTokens(await request("/auth/login", credentials));
        } catch {
          return { signedIn: false };
        }
        await notify();
        return { signedIn: true };
      }
      if (msg.type === "login") {
        await clearAuth();
        await saveTokens(
          await request("/auth/login", {
            ...(msg.username.includes("@")
              ? { email: msg.username }
              : { username: msg.username }),
            password: msg.password,
          }),
        );
        await resetDraft(msg.username);
        await notify();
        return { ok: true };
      }
      if (msg.type === "logout") {
        await logout();
        return { ok: true };
      }
      throw Error("Unsupported action");
    } catch (e) {
      return { error: e.message };
    }
  });
}
// Callback responses work in both browsers, including Chrome versions without
// promise-returning onMessage listeners. Register synchronously on worker startup.
extensionAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  storageReady
    .then(() => handleMessage(msg, sender))
    .then(sendResponse, () =>
      sendResponse({
        state: "error",
        error: "Extension initialization or request failed.",
      }),
    );
  return true;
});
function navigation(details) {
  if (details.frameId === 0)
    extensionAPI.tabs
      .sendMessage(details.tabId, { type: "navigate" })
      .catch(() => {});
}
extensionAPI.webNavigation.onHistoryStateUpdated.addListener(navigation, {
  url: [{ hostEquals: "www.youtube.com" }],
});
extensionAPI.webNavigation.onReferenceFragmentUpdated.addListener(navigation, {
  url: [{ hostEquals: "www.youtube.com" }],
});
