"use strict";
let queue = Promise.resolve();
let generation = 0;
// Restrict credentials before servicing any message in Chrome. Firefox's API
// does not offer setAccessLevel; its content scripts never request credentials.
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
  const { apiURL: previousURL } =
    await extensionAPI.storage.local.get("apiURL");
  const { loginDraft, draftEpoch } = await extensionAPI.storage.session.get([
    "loginDraft",
    "draftEpoch",
  ]);
  const customSession = !!previousURL && !isProductionOrigin(previousURL);
  const customDraft =
    !!loginDraft?.apiURL && !isProductionOrigin(loginDraft.apiURL);
  if (customSession) await clearAuth();
  await extensionAPI.storage.local.remove("apiURL");
  if (customSession || loginDraft?.apiURL !== undefined) {
    await extensionAPI.storage.session.set({
      loginDraft:
        customSession || customDraft
          ? {}
          : {
              username:
                typeof loginDraft?.username === "string"
                  ? loginDraft.username
                  : "",
              password:
                typeof loginDraft?.password === "string"
                  ? loginDraft.password
                  : "",
            },
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
  await extensionAPI.storage.session.remove(["accessToken", "expires"]);
  await extensionAPI.storage.local.remove("refreshToken");
  await notify();
}
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
        res.status === 401
          ? path === "/auth/login"
            ? "Incorrect username or password."
            : "Your session expired. Please log in again."
          : "Unable to reach the API or check this video.",
      );
      error.status = res.status;
      throw error;
    }
    return res.status === 204 ? null : await res.json();
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
  }
}
async function saveTokens(data) {
  if (
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    data.expires_in !== 900
  )
    throw Error("Invalid login response.");
  await extensionAPI.storage.local.set({ refreshToken: data.refresh_token });
  await extensionAPI.storage.session.set({
    accessToken: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}
async function access(force = false) {
  const state = await extensionAPI.storage.session.get([
    "accessToken",
    "expires",
  ]);
  if (!force && state.accessToken && state.expires > Date.now() + 30000)
    return state.accessToken;
  const { refreshToken } = await extensionAPI.storage.local.get("refreshToken");
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
  const { refreshToken } = await extensionAPI.storage.local.get("refreshToken");
  await clearAuth();
  await resetDraft(true);
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
async function resetDraft(all) {
  const stored = await extensionAPI.storage.session.get([
    "loginDraft",
    "draftEpoch",
  ]);
  const draft = all ? {} : { ...stored.loginDraft, password: "" };
  await extensionAPI.storage.session.set({
    loginDraft: draft,
    draftEpoch: (stored.draftEpoch || 0) + 1,
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
  if (sender.id !== extensionAPI.runtime.id) return;
  const privileged = sender.url?.startsWith(extensionAPI.runtime.getURL(""));
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
      !/^[\w-]{11}$/.test(msg.videoID || "")
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
  if (!privileged) return;
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
        const draft = msg.draft;
        if (
          !draft ||
          ["username", "password"].some(
            (k) => typeof draft[k] !== "string" || draft[k].length > 8192,
          )
        )
          throw Error("Invalid login draft.");
        await extensionAPI.storage.session.set({
          loginDraft: {
            username: draft.username,
            password: draft.password,
          },
        });
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
          await extensionAPI.storage.local.get("refreshToken");
        return {
          loggedIn: !!refreshToken,
        };
      }
      if (msg.type === "login") {
        await clearAuth();
        await saveTokens(
          await request("/auth/login", {
            username: msg.username,
            password: msg.password,
          }),
        );
        await resetDraft(false);
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
