const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function area() {
  const data = {};
  return {
    data,
    async get(keys) {
      return Object.fromEntries(
        (Array.isArray(keys) ? keys : [keys]).map((k) => [k, data[k]]),
      );
    },
    async set(value) {
      Object.assign(data, structuredClone(value));
    },
    async remove(key) {
      for (const k of Array.isArray(key) ? key : [key]) delete data[k];
    },
    async clear() {
      for (const k of Object.keys(data)) delete data[k];
    },
  };
}
for (const target of ["firefox", "chrome"]) {
  const directory = path.join(__dirname, "..", target);
  test(target + ": extension folder contains all referenced assets", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(directory, "manifest.json")),
    );
    const pending = [
      manifest.action.default_popup,
      ...(manifest.background.scripts || []),
      ...(manifest.background.service_worker ? [manifest.background.service_worker] : []),
      ...manifest.content_scripts.flatMap((script) => [...script.js, ...script.css]),
    ];
    const checked = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (checked.has(file)) continue;
      checked.add(file);
      const filename = fs.realpathSync(path.join(directory, file));
      assert.ok(filename.startsWith(directory + path.sep), `${file} must be inside ${target}/`);
      assert.ok(fs.statSync(filename).isFile(), `${file} must be a regular file`);
      const source = fs.readFileSync(filename, "utf8");
      const references = file.endsWith(".html")
        ? [...source.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)].map((match) => match[1])
        : [...source.matchAll(/importScripts\(([^)]+)\)/g)].flatMap((match) =>
            [...match[1].matchAll(/["']([^"']+)["']/g)].map((argument) => argument[1]),
          );
      pending.push(...references.map((reference) => path.join(path.dirname(file), reference)));
    }
    assert.deepEqual(manifest.content_scripts[0].js, [
      "compatibility.js",
      "content.js",
    ]);
    assert.deepEqual(manifest.host_permissions, [
      "https://www.youtube.com/*",
      "https://api.anti-brainrot-blocker.fyi/*",
    ]);
    assert.equal(manifest.optional_host_permissions, undefined);
    if (target === "chrome") {
      assert.equal(manifest.background.service_worker, "worker.js");
      assert.equal(manifest.minimum_chrome_version, "120");
      assert.equal(manifest.browser_specific_settings, undefined);
    } else
      assert.deepEqual(manifest.background.scripts, [
        "compatibility.js",
        "background.js",
      ]);
  });
  function background(previous) {
    let listener;
    let calls = [];
    let notifications = 0;
    let tabURL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    let responder = () => ({
      status: 200,
      body: {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 900,
      },
    });
    const local = previous?.local || area(),
      session = previous?.session || area();
    const restrictions = [];
    local.setAccessLevel = session.setAccessLevel = async (value) => {
      restrictions.push(value.accessLevel);
    };
    const timers = new Map();
    let timerID = 0;
    let heartbeats = 0;
    let now = Math.floor(Date.now() / 1000) * 1000;
    const browser = {
      storage: { local, session },
      runtime: {
        id: "test",
        getURL: (p) =>
          (target === "chrome" ? "chrome-extension://" : "moz-extension://") +
          "test/" +
          p,
        getPlatformInfo: async () => {
          heartbeats++;
        },
        onMessage: { addListener: (fn) => (listener = fn) },
      },
      tabs: {
        get: async (id) => ({ id, url: tabURL }),
        query: async () => [{ id: 1 }],
        sendMessage: async () => {
          notifications++;
        },
      },
      webNavigation: {
        onHistoryStateUpdated: { addListener() {} },
        onReferenceFragmentUpdated: { addListener() {} },
      },
    };
    const context = {
      [target === "chrome" ? "chrome" : "browser"]: browser,
      URL,
      AbortSignal,
      Date: class extends Date { static now() { return now; } },
      console,
      setInterval: (fn, delay) => {
        assert.equal(delay, 20000);
        timers.set(++timerID, fn);
        return timerID;
      },
      clearInterval: (id) => timers.delete(id),
      fetch: async (url, options) => {
        calls.push({ url, options });
        const r = await responder(url, options);
        return {
          ok: r.status < 400,
          status: r.status,
          headers: new Headers(r.headers),
          json: async () => r.body,
          text: async () => r.body ?? "",
        };
      },
    };
    vm.createContext(context);
    vm.runInContext(
      fs.readFileSync(path.join(directory, "compatibility.js"), "utf8"),
      context,
    );
    vm.runInContext(
      fs.readFileSync(path.join(directory, "background.js"), "utf8"),
      context,
    );
    const invoke = (msg, sender) =>
      new Promise((resolve) => {
        assert.equal(
          listener(msg, sender, (value) => resolve(structuredClone(value))),
          true,
        );
      });
    const send = (msg, inTab = false, content = false) =>
      invoke(msg, {
        id: "test",
        url: content ? "https://www.youtube.com/" : browser.runtime.getURL("popup.html"),
        ...(inTab ? { tab: { id: 5 } } : {}),
      });
    const check = (
      id = "dQw4w9WgXcQ",
      source = "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      current = `https://www.youtube.com/watch?v=${id}`,
      frameId = 0,
    ) => {
      tabURL = current;
      return invoke(
        { type: "check", videoID: id },
        { id: "test", tab: { id: 1 }, frameId, url: source },
      );
    };
    return {
      local,
      session,
      invoke,
      send,
      check,
      calls,
      timers,
      restrictions,
      heartbeat: () => heartbeats,
      notifications: () => notifications,
      advanceTime: (ms) => (now += ms),
      respond: (fn) => (responder = fn),
    };
  }
  test(
    target +
      ": " +
      "login and token rotation use session storage only",
    async () => {
      const b = background();
      assert.equal(
        (await b.send({ type: "login", username: "user", password: "secret" }))
          .ok,
        true,
      );
      assert.equal(b.local.data.refreshToken, undefined);
      assert.equal(b.local.data.accessToken, undefined);
      assert.equal(b.session.data.accessToken, "access");
      assert.equal(b.session.data.refreshToken, "refresh");
      b.advanceTime(901000);
      b.respond((url) =>
        url.endsWith("/auth/refresh")
          ? {
              status: 200,
              body: {
                access_token: "new",
                refresh_token: "rotated",
                expires_in: 900,
              },
            }
          : { status: 200, body: { status: "OK", allowed: true } },
      );
      const results = await Promise.all([b.check(), b.check()]);
      assert.ok(results.every((r) => r.state === "allowed"));
      assert.equal(
        b.calls.filter((c) => c.url.endsWith("/auth/refresh")).length,
        1,
      );
      assert.equal(b.session.data.refreshToken, "rotated");
      assert.equal(b.local.data.refreshToken, undefined);
      assert.ok(
        b.calls
          .filter((c) => c.url.includes("/videos/"))
          .every((c) => c.options.headers.Authorization === "Bearer new"),
      );
    },
  );
  test(
    target +
      ": " +
      "errors stay closed; network failure preserves login; rejected refresh clears it",
    async () => {
      const b = background();
      assert.equal((await b.check()).state, "login");
      await b.session.set({ refreshToken: "old" });
      b.respond(() => {
        throw Error("offline");
      });
      assert.equal((await b.check()).state, "error");
      assert.equal(b.session.data.refreshToken, "old");
      b.respond(() => ({ status: 401 }));
      assert.equal((await b.check()).state, "login");
      assert.equal(b.session.data.refreshToken, undefined);
    },
  );
  test(target + ": " + "logout clears credentials", async () => {
    const b = background();
    await b.send({ type: "login", username: "user", password: "pass" });
    assert.equal((await b.send({ type: "status" }, true)).loggedIn, true);
    assert.equal((await b.send({ type: "logout" })).ok, true);
    assert.deepEqual(b.local.data, {});
    assert.equal(b.session.data.accessToken, undefined);
    assert.equal(b.session.data.refreshToken, undefined);
    assert.deepEqual(JSON.parse(b.calls.at(-1).options.body), { refresh_token: "refresh" });
    assert.deepEqual(b.session.data.loginDraft, {});
  });
  test(target + ": account operations require a message from the popup", async () => {
    const b = background();
    const scheme = target === "chrome" ? "chrome-extension:" : "moz-extension:";
    for (const sender of [
      { id: "another-extension", url: `${scheme}//test/popup.html` },
      { id: "test", url: `${scheme}//test/other.html` },
      { id: "test", url: "https://www.youtube.com/", tab: { id: 1 } },
    ]) {
      assert.equal(await b.invoke({ type: "draftGet" }, sender), undefined);
      assert.equal(await b.invoke({ type: "logout" }, sender), undefined);
    }
  });
  test(target + ": " + "old check cannot unlock after logout", async () => {
    const b = background();
    await b.send({ type: "login", username: "u", password: "p" });
    let finish;
    b.respond((url) =>
      url.includes("/videos/")
        ? new Promise((resolve) => (finish = resolve))
        : { status: 204 },
    );
    const pending = b.check();
    await tick();
    await b.send({ type: "logout" });
    finish({ status: 200, body: { status: "OK", allowed: true } });
    assert.equal((await pending).state, "stale");
  });
  function content() {
    let listener, interval;
    let held = false;
    let url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const requests = [];
    const events = {};
    class Element {
      constructor() {
        this.dataset = {};
        this.children = [];
        this.isConnected = true;
      }
      setAttribute() {}
      append(...v) {
        this.children.push(...v);
      }
      replaceChildren() {
        this.children = [];
      }
      remove() {
        this.isConnected = false;
      }
    }
    const container = new Element();
    class Media {
      pause() {
        this.pauses++;
      }
      constructor() {
        this.pauses = 0;
      }
      closest() {
        return container;
      }
    }
    const video = new Media();
    const document = {
      documentElement: { classList: { toggle: (name, on) => (held = on) } },
      querySelectorAll: () => [video],
      createElement: () => new Element(),
      addEventListener: (name, fn) => (events[name] = fn),
    };
    const context = {
      document,
      location: {
        get href() {
          return url;
        },
      },
      URL,
      HTMLMediaElement: Media,
      MutationObserver: class {
        observe() {}
      },
      queueMicrotask,
      window: { addEventListener: (name, fn) => (events[name] = fn) },
      setInterval: (fn) => (interval = fn),
      [target === "chrome" ? "chrome" : "browser"]: {
        runtime: {
          getURL: (p) =>
            (target === "chrome" ? "chrome-extension://" : "moz-extension://") +
            "test/" +
            p,
          onMessage: { addListener: (fn) => (listener = fn) },
          sendMessage: () => new Promise((resolve) => requests.push(resolve)),
        },
      },
    };
    vm.createContext(context);
    vm.runInContext(
      fs.readFileSync(path.join(directory, "compatibility.js"), "utf8"),
      context,
    );
    vm.runInContext(
      fs.readFileSync(path.join(directory, "content.js"), "utf8"),
      context,
    );
    return {
      video,
      requests,
      held: () => held,
      nav: (raw) => {
        url = raw;
        interval();
      },
      change: () => listener({ type: "changed" }),
      container,
    };
  }
  test(
    target +
      ": " +
      "player held during login/check/error/blocked; stale navigation ignored",
    async () => {
      const c = content();
      assert.equal(c.held(), true);
      assert.ok(c.video.pauses > 0);
      c.nav("https://www.youtube.com/shorts/abcdefghijk");
      assert.equal(c.requests.length, 2);
      c.requests[0]({ state: "allowed" });
      await tick();
      assert.equal(c.held(), true);
      c.requests[1]({ state: "blocked" });
      await tick();
      assert.equal(c.held(), true);
      for (const state of ["login", "error", "allowed"]) {
        c.change();
        assert.equal(c.held(), true);
        c.requests.at(-1)({ state });
        await tick();
        assert.equal(c.held(), state !== "allowed");
      }
      c.nav("https://www.youtube.com/");
      assert.equal(c.held(), false);
    },
  );

  test(target + ": all API operations use the fixed DNS endpoint", async () => {
    const b = background();
    assert.deepEqual(await b.send({ type: "status" }), { loggedIn: false });
    assert.ok(
      (await b.send({ type: "configure", apiURL: "https://old-api.example" }))
        .error,
    );
    // A stale or injected storage setting must never affect request destinations.
    await b.local.set({ apiURL: "http://localhost:8080" });
    await b.send({
      type: "login",
      username: "user",
      password: "secret",
      apiURL: "https://old-api.example",
    });
    b.respond((url, options) => {
      if (url.endsWith("/auth/logout")) return { status: 204 };
      if (url.endsWith("/categories/"))
        return { status: 200, body: { status: "OK", categories: [] } };
      return { status: 200, body: { status: "OK", allowed: true } };
    });
    assert.equal((await b.check()).state, "allowed");
    await b.send({ type: "categoriesGet" });
    await b.send({ type: "categoriesSet", categories: ["math"] });
    await b.send({ type: "logout" });
    assert.ok(b.calls.length >= 5);
    assert.ok(
      b.calls.every(
        (call) =>
          new URL(call.url).origin === "https://api.anti-brainrot-blocker.fyi",
      ),
    );
  });

  test(
    target + ": upgrade clears credentials and drafts from custom servers",
    async () => {
      for (const oldURL of [
        "https://old-api.example",
        "http://localhost:8080",
      ]) {
        const local = area(),
          session = area();
        await local.set({ apiURL: oldURL, refreshToken: "custom-refresh" });
        await session.set({
          accessToken: "custom-access",
          expires: Date.now() + 900000,
          loginDraft: {
            apiURL: oldURL,
            username: "old-user",
            password: "old-secret",
          },
          draftEpoch: 3,
        });
        const b = background({ local, session });
        assert.deepEqual(await b.send({ type: "status" }), { loggedIn: false });
        assert.equal(local.data.apiURL, undefined);
        assert.equal(local.data.refreshToken, undefined);
        assert.equal(session.data.accessToken, undefined);
        assert.equal(session.data.refreshToken, undefined);
        assert.deepEqual((await b.send({ type: "draftGet" })).draft, {});
        assert.equal((await b.send({ type: "draftGet" })).epoch, 4);
        assert.equal(b.calls.length, 0);
      }
    },
  );

  test(
    target +
      ": upgrade moves production tokens to memory and removes saved passwords",
    async () => {
      for (const oldURL of [
        undefined,
        "https://api.anti-brainrot-blocker.fyi",
        "https://api.anti-brainrot-blocker.fyi:443/",
      ]) {
        const local = area(),
          session = area();
        await local.set({
          ...(oldURL ? { apiURL: oldURL } : {}),
          refreshToken: "production-refresh",
        });
        await session.set({
          accessToken: "production-access",
          expires: Date.now() + 900000,
          loginDraft: {
            ...(oldURL ? { apiURL: "" } : {}),
            username: "user",
            password: "draft-secret",
          },
        });
        const b = background({ local, session });
        assert.equal((await b.send({ type: "status" })).loggedIn, true);
        assert.equal(local.data.apiURL, undefined);
        assert.equal(local.data.refreshToken, undefined);
        assert.equal(session.data.accessToken, "production-access");
        assert.equal(session.data.refreshToken, "production-refresh");
        assert.deepEqual(session.data.loginDraft, { username: "user" });
        assert.deepEqual((await b.send({ type: "draftGet" })).draft, { username: "user" });
        b.respond(() => ({
          status: 200,
          body: { status: "OK", allowed: true },
        }));
        assert.equal((await b.check()).state, "allowed");
        assert.equal(
          b.calls[0].options.headers.Authorization,
          "Bearer production-access",
        );
        assert.equal(
          new URL(b.calls[0].url).origin,
          "https://api.anti-brainrot-blocker.fyi",
        );
      }
    },
  );

  test(
    target +
      ": upgrade discards unsaved credentials drafted for another server",
    async () => {
      const local = area(),
        session = area();
      await session.set({
        loginDraft: {
          apiURL: "https://old-api.example",
          username: "old-user",
          password: "old-secret",
        },
      });
      const b = background({ local, session });
      assert.deepEqual((await b.send({ type: "draftGet" })).draft, {});
      assert.equal(b.calls.length, 0);
    },
  );

  test(
    target + ": popup logs in without backend settings or permission prompts",
    async () => {
      const b = background();
      const popup = popupWithBackground(b);
      await popup.settle();
      popup.type("username", "user");
      popup.type("password", "secret");
      b.respond((url) =>
        url.endsWith("/auth/login")
          ? {
              status: 200,
              body: {
                access_token: "access",
                refresh_token: "refresh",
                expires_in: 900,
              },
            }
          : { status: 200, body: { status: "OK", categories: [] } },
      );
      popup.submit("login");
      await popup.flush();
      await tick();
      assert.equal((await b.send({ type: "status" })).loggedIn, true);
      assert.equal(popup.elements.password.value, "");
      const html = fs.readFileSync(path.join(directory, "popup.html"), "utf8");
      assert.doesNotMatch(html, /id="(?:api|settings|save-api)"/);
      assert.ok(
        b.calls.every(
          (call) =>
            new URL(call.url).origin ===
            "https://api.anti-brainrot-blocker.fyi",
        ),
      );
    },
  );

  test(target + ": rejected popup login explains credentials and allows retry", async () => {
    const b = background();
    const popup = popupWithBackground(b);
    await popup.settle();
    popup.type("username", "user");
    popup.type("password", "wrong password");
    b.respond(() => ({status: 401}));
    await popup.submit("login");
    assert.equal(popup.elements.status.textContent, "Incorrect email, username, or password.");
    assert.equal(popup.elements.login.hidden, false);
    assert.equal(popup.elements["login-button"].disabled, false);
    assert.equal(popup.elements.password.value, "wrong password");
    assert.equal((await b.send({type: "status"})).loggedIn, false);
    const failed = b.calls.find(call => call.url.endsWith("/auth/login"));
    assert.deepEqual(JSON.parse(failed.options.body), {username: "user", password: "wrong password"});
    popup.type("password", "correct password");
    b.respond(url => url.endsWith("/auth/login")
      ? {status: 200, body: {access_token: "a", refresh_token: "r", expires_in: 900}}
      : {status: 200, body: {status: "OK", categories: []}});
    await popup.submit("login");
    assert.equal((await b.send({type: "status"})).loggedIn, true);
    assert.equal(popup.elements.login.hidden, true);
    assert.equal(popup.elements.password.value, "");
  });
  test(
    target + ": delayed 401 cannot reuse credentials from a replacement login",
    async () => {
      const b = background();
      await b.send({
        type: "login",
        username: "old-user",
        password: "old-secret",
      });
      let finish;
      b.respond(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = b.check();
      await tick();
      assert.ok(finish);
      b.respond((url) =>
        url.endsWith("/auth/logout")
          ? { status: 204 }
          : {
              status: 200,
              body: {
                access_token: "new-access",
                refresh_token: "new-refresh",
                expires_in: 900,
              },
            },
      );
      await b.send({ type: "logout" });
      await b.send({
        type: "login",
        username: "new-user",
        password: "new-secret",
      });
      const count = b.calls.length;
      finish({ status: 401 });
      assert.equal((await pending).state, "stale");
      assert.equal(b.calls.length, count);
      assert.equal(b.session.data.accessToken, "new-access");
      assert.equal(b.session.data.refreshToken, "new-refresh");
    },
  );

  test(
    target +
      ": YouTube SPA checks use current tab URL rather than original document URL",
    async () => {
      const b = background();
      await b.send({ type: "login", username: "u", password: "p" });
      b.respond(() => ({ status: 200, body: { status: "OK", allowed: true } }));
      for (const source of [
        "https://www.youtube.com/",
        "https://www.youtube.com/watch?v=mg79n_ndR68",
      ]) {
        assert.equal((await b.check("EgnAN0ZUl08", source)).state, "allowed");
        assert.ok(b.calls.at(-1).url.endsWith("/videos/EgnAN0ZUl08/check"));
      }
      assert.equal(
        (
          await b.check(
            "EgnAN0ZUl08",
            "https://www.youtube.com/",
            "https://www.youtube.com/shorts/EgnAN0ZUl08",
          )
        ).state,
        "allowed",
      );
      const count = b.calls.length;
      assert.equal(
        (await b.check("EgnAN0ZUl08", "https://example.com/")).state,
        "error",
      );
      assert.equal(
        (
          await b.check(
            "EgnAN0ZUl08",
            "https://www.youtube.com/",
            "https://www.youtube.com/watch?v=mg79n_ndR68",
          )
        ).state,
        "stale",
      );
      assert.equal(
        (
          await b.check(
            "EgnAN0ZUl08",
            "https://www.youtube.com/",
            "https://www.youtube.com/watch?v=EgnAN0ZUl08",
            1,
          )
        ).state,
        "error",
      );
      assert.equal(b.calls.length, count);
    },
  );

  function popupWithBackground(b) {
    const ids = [
      "username",
      "password",
      "status",
      "login",
      "logout",
      "category-section",
      "category-form",
      "category-status",
      "retry-categories",
      "category-editor",
      "category-options",
      "selected-categories",
      "new-category",
      "add-category",
      "login-button",
      "register",
      "show-register",
      "register-email",
      "register-password",
      "register-button",
      "back-to-login",
      "show-recovery",
      "recovery-code",
      "recovery-email",
      "send-code",
      "reset-code",
      "check-code",
      "cancel-recovery",
      "recovery-password",
      "new-password",
      "confirm-password",
      "reset-password",
      "cancel-reset",
    ];
    function element() {
      return {
        value: "", hidden: false, textContent: "", disabled: false,
        children: [], listeners: {},
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this[name] = value; },
        focus() {},
        checkValidity() { return /^[^@\s]+@[^@\s]+$/.test(this.value); },
        addEventListener(name, fn) { this.listeners[name] = fn; },
      };
    }
    const elements = Object.fromEntries(ids.map(id => [id, element()]));
    const context = vm.createContext({
      URL,
      TextEncoder,
      document: { getElementById: (id) => elements[id], createTextNode: text => ({textContent:text}), createElement: element },
      [target === "chrome" ? "chrome" : "browser"]: {
        runtime: {
          getURL: (p) =>
            (target === "chrome" ? "chrome-extension://" : "moz-extension://") +
            "test/" +
            p,
          sendMessage: (msg) => b.send(msg),
        },
      },
    });
    vm.runInContext(
      fs.readFileSync(path.join(directory, "compatibility.js"), "utf8"),
      context,
    );
    vm.runInContext(
      fs.readFileSync(path.join(directory, "popup.js"), "utf8"),
      context,
    );
    return {
      elements, context,
      async settle() {
        await vm.runInContext("ready", context);
        await tick();
      },
      async saved() {
        await vm.runInContext("categorySave", context);
        await tick();
      },
      async flush() {
        await vm.runInContext("draftQueue", context);
        await tick();
      },
      type(id, value) {
        elements[id].value = value;
        elements[id].listeners.input?.();
      },
      submit(id) {
        return elements[id].onsubmit({ preventDefault() {} });
      },
    };
  }
  test(
    target +
      ": popup remembers only the login identifier",
    async () => {
      const b = background();
      let popup = popupWithBackground(b);
      await popup.settle();
      popup.type("username", "user");
      popup.type("password", "secret");
      await popup.flush();
      assert.equal(b.local.data.loginDraft, undefined);
      assert.deepEqual(b.session.data.loginDraft, { username: "user" });
      popup = popupWithBackground(background(b));
      await popup.settle();
      assert.equal(popup.elements.password.value, "");
      assert.equal(popup.elements.username.value, "user");
      popup.type("password", "discard when switching forms");
      popup.elements["show-recovery"].onclick();
      assert.equal(popup.elements.password.value, "");
      const epoch = (await b.send({ type: "draftGet" })).epoch;
      await b.send({ type: "draftSet", epoch, draft: { username: "user", password: "legacy password" } });
      b.respond(() => ({ status: 401 }));
      await b.send({ type: "login", username: "user", password: "bad" });
      assert.deepEqual((await b.send({ type: "draftGet" })).draft, { username: "user" });
      b.respond(() => ({
        status: 200,
        body: { access_token: "a", refresh_token: "r", expires_in: 900 },
      }));
      await b.send({ type: "login", username: "user", password: "secret" });
      assert.deepEqual(b.session.data.loginDraft, { username: "user" });
      assert.equal(
        (
          await b.send({
            type: "draftSet",
            epoch,
            draft: { username: "u", password: "late" },
          })
        ).ok,
        false,
      );
      await b.send({ type: "logout" });
      assert.deepEqual((await b.send({ type: "draftGet" })).draft, {});
      await b.session.clear();
      assert.deepEqual((await b.send({ type: "draftGet" })).draft, {});
    },
  );
  test(target + ": registration signs in with email or returns to email login", async () => {
    for (const automaticLoginWorks of [true, false]) {
      const b = background();
      const popup = popupWithBackground(b);
      const credentials = { email: "approved@example.com", password: "new password" };
      const tokens = { access_token: "a", refresh_token: "r", expires_in: 900 };
      b.respond(url => url.endsWith("/auth/register")
        ? { status: 200, body: { status: "OK" } }
        : url.endsWith("/auth/login")
          ? automaticLoginWorks ? { status: 200, body: tokens } : { status: 401 }
          : { status: 200, body: { status: "OK", categories: [] } });
      await popup.settle();
      await b.send({ type: "register", ...credentials }, true, true);
      assert.equal(b.calls.length, 0);
      popup.elements["show-register"].onclick();
      assert.equal(popup.elements.login.hidden, true);
      popup.type("register-email", credentials.email);
      popup.type("register-password", credentials.password);
      await popup.submit("register");
      assert.deepEqual(b.calls.slice(0, 2).map(call => [
        new URL(call.url).pathname, JSON.parse(call.options.body),
      ]), [["/auth/register", credentials], ["/auth/login", credentials]]);
      assert.deepEqual(b.session.data.loginDraft, { username: credentials.email });
      assert.equal(popup.elements["register-password"].value, "");
      assert.equal(popup.elements.register.hidden, true);
      assert.equal(popup.elements.login.hidden, automaticLoginWorks);
      if (!automaticLoginWorks) {
        assert.equal(popup.elements.status.textContent, "Account created. Please log in.");
        assert.equal(popup.elements.username.value, credentials.email);
        assert.equal(popup.elements.password.value, "");
        b.respond(url => url.endsWith("/auth/login")
          ? { status: 200, body: tokens }
          : { status: 200, body: { status: "OK", categories: [] } });
        popup.type("password", credentials.password);
        await popup.submit("login");
        assert.deepEqual(JSON.parse(b.calls[2].options.body), credentials);
      }
      assert.equal(b.session.data.refreshToken, "r");
      assert.equal(popup.elements["category-section"].hidden, false);
    }
  });

  test(target + ": failed registration stays on the form and never attempts login", async () => {
    const b = background();
    const popup = popupWithBackground(b);
    await popup.settle();
    popup.elements["show-register"].onclick();
    popup.type("register-email", "test@example.com");
    popup.type("register-password", "🦊".repeat(19));
    await popup.submit("register");
    assert.match(popup.elements.status.textContent, /72 UTF-8 bytes/);
    assert.equal(b.calls.length, 0);
    popup.type("register-password", "new password");
    for (const [status, message] of [
      [403, /approve this email/],
      [409, /already registered/],
      [400, /valid email/],
      [429, /Too many registration attempts/],
    ]) {
      b.respond(() => ({ status }));
      await popup.submit("register");
      assert.match(popup.elements.status.textContent, message);
      assert.equal(popup.elements.register.hidden, false);
      assert.equal(popup.elements["register-button"].disabled, false);
      assert.equal(b.session.data.loginDraft, undefined);
    }
    assert.equal(b.calls.length, 4);
    assert.ok(b.calls.every(call => call.url.endsWith("/auth/register")));
    popup.elements["back-to-login"].onclick();
    assert.equal(popup.elements.login.hidden, false);
    assert.equal(popup.elements["register-password"].value, "");
  });

  test(target + ": recovery validates the emailed code before resetting the password", async () => {
    const b = background();
    const email = "user@example.com";
    const password = "🦊".repeat(18);
    await b.session.set({ loginDraft: { username: email } });
    const popup = popupWithBackground(b);
    await popup.settle();
    const elements = popup.elements;

    for (const type of ["requestResetCode", "checkResetCode", "resetPassword"])
      await b.send({ type, email, token: "012345", password }, true, true);
    elements["show-recovery"].onclick();
    assert.equal(elements.login.hidden, true);
    assert.equal(elements["recovery-code"].hidden, false);
    assert.equal(elements["recovery-password"].hidden, true);
    assert.equal(elements["recovery-email"].value, email);
    assert.equal(b.calls.length, 0);

    let respondToSend;
    b.respond(() => new Promise(resolve => { respondToSend = resolve; }));
    const sending = elements["send-code"].onclick();
    await tick();
    assert.equal(elements["send-code"].disabled, true);
    await elements["send-code"].onclick();
    assert.equal(b.calls.length, 1);
    respondToSend({ status: 204 });
    await sending;
    assert.match(elements.status.textContent, /If an account exists/);

    popup.type("reset-code", "12345");
    await popup.submit("recovery-code");
    assert.match(elements.status.textContent, /six-digit reset code/);
    assert.equal(b.calls.length, 1);
    popup.type("reset-code", "012345");
    b.respond(() => ({ status: 200, body: { valid: false } }));
    await popup.submit("recovery-code");
    assert.match(elements.status.textContent, /invalid or expired/);
    assert.equal(elements["recovery-password"].hidden, true);

    b.respond(() => ({ status: 200, body: { valid: true } }));
    await popup.submit("recovery-code");
    assert.equal(elements["recovery-password"].hidden, false);
    for (const invalid of ["1234567", "🦊".repeat(19)]) {
      popup.type("new-password", invalid);
      popup.type("confirm-password", invalid);
      await popup.submit("recovery-password");
      assert.match(elements.status.textContent, /8 characters.*72 UTF-8 bytes/);
    }
    popup.type("new-password", password);
    await popup.submit("recovery-password");
    assert.match(elements.status.textContent, /passwords do not match/);
    assert.equal(b.calls.length, 3);

    popup.type("confirm-password", password);
    b.respond(() => ({ status: 204 }));
    await popup.submit("recovery-password");
    assert.deepEqual(b.calls.map(({ url, options }) => {
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, undefined);
      return [new URL(url).pathname, JSON.parse(options.body)];
    }), [
      ["/auth/forgot-password", { email }],
      ["/auth/check-token", { email, token: "012345" }],
      ["/auth/check-token", { email, token: "012345" }],
      ["/auth/reset-password", { email, token: "012345", new_password: password }],
    ]);
    for (const id of ["recovery-email", "reset-code", "new-password", "confirm-password", "password"])
      assert.equal(elements[id].value, "");
    assert.equal(elements["recovery-password"].hidden, true);
    assert.equal(elements.login.hidden, false);
    assert.equal(elements.username.value, email);
    assert.match(elements.status.textContent, /Password reset/);
    assert.deepEqual(b.session.data.loginDraft, { username: email });
    assert.equal(b.session.data.refreshToken, undefined);

    b.respond(url => url.endsWith("/auth/login")
      ? { status: 200, body: { access_token: "a", refresh_token: "r", expires_in: 900 } }
      : { status: 200, body: { status: "OK", categories: [] } });
    popup.type("password", password);
    await popup.submit("login");
    assert.deepEqual(JSON.parse(b.calls[4].options.body), { email, password });
    assert.equal(elements["category-section"].hidden, false);
  });

  test(target + ": recovery handles request failures, expired codes, and cancellation", async () => {
    const b = background();
    const popup = popupWithBackground(b);
    await popup.settle();
    const elements = popup.elements;
    popup.type("username", "legacy-user");
    elements["show-recovery"].onclick();
    assert.equal(elements["recovery-email"].value, "");
    await elements["send-code"].onclick();
    assert.equal(b.calls.length, 0);

    popup.type("recovery-email", "user@example.com");
    b.respond(() => ({ status: 429 }));
    await elements["send-code"].onclick();
    assert.match(elements.status.textContent, /Too many requests for a reset code/);
    assert.equal(elements["send-code"].disabled, false);

    popup.type("reset-code", "012345");
    b.respond(() => ({ status: 200, body: { valid: "true" } }));
    await popup.submit("recovery-code");
    assert.match(elements.status.textContent, /Unable to verify/);
    assert.equal(elements["recovery-password"].hidden, true);

    b.respond(() => ({ status: 200, body: { valid: true } }));
    await popup.submit("recovery-code");
    popup.type("new-password", "new password");
    popup.type("confirm-password", "new password");
    b.respond(() => { throw Error("offline"); });
    await popup.submit("recovery-password");
    assert.match(elements.status.textContent, /temporarily unavailable/);
    assert.equal(elements["recovery-password"].hidden, false);
    assert.equal(elements["reset-password"].disabled, false);
    assert.equal(elements["new-password"].value, "new password");

    b.respond(() => ({ status: 400, body: "Invalid reset token\n" }));
    await popup.submit("recovery-password");
    assert.match(elements.status.textContent, /invalid or expired/);
    assert.equal(elements["recovery-code"].hidden, false);
    assert.equal(elements["recovery-email"].value, "user@example.com");
    for (const id of ["reset-code", "new-password", "confirm-password"])
      assert.equal(elements[id].value, "");

    popup.type("reset-code", "054321");
    b.respond(() => ({ status: 200, body: { valid: true } }));
    await popup.submit("recovery-code");
    popup.type("new-password", "another password");

    const reopened = popupWithBackground(b);
    await reopened.settle();
    reopened.elements["show-recovery"].onclick();
    assert.equal(reopened.elements["recovery-code"].hidden, false);
    assert.equal(reopened.elements["recovery-password"].hidden, true);
    assert.equal(reopened.elements["reset-code"].value, "");
    assert.equal(reopened.elements["new-password"].value, "");

    elements["cancel-reset"].onclick();
    assert.equal(elements.login.hidden, false);
    assert.equal(elements["new-password"].value, "");
    assert.deepEqual(b.session.data.loginDraft, { username: "legacy-user" });
  });

  test(target + ": recovery reports validation errors and honors Retry-After at each step", async () => {
    const b = background();
    const popup = popupWithBackground(b);
    await popup.settle();
    const elements = popup.elements;
    const email = "user@example.com";
    elements["show-recovery"].onclick();
    popup.type("recovery-email", "invalid-email");
    await elements["send-code"].onclick();
    assert.match(elements.status.textContent, /valid account email/);
    assert.equal(b.calls.length, 0);
    popup.type("recovery-email", email);
    popup.type("reset-code", "012345");

    for (const { submit, invalid, retryAfter, seconds, success, form } of [
      {
        submit: () => elements["send-code"].onclick(),
        invalid: /valid account email/,
        retryAfter: () => "12",
        seconds: 12,
        success: { status: 204 },
        form: "recovery-code",
      },
      {
        submit: () => popup.submit("recovery-code"),
        invalid: /email address.*six-digit reset code/,
        retryAfter: () => new Date(b.advanceTime(0) + 5000).toUTCString(),
        seconds: 5,
        success: { status: 200, body: { valid: true } },
        form: "recovery-code",
      },
      {
        submit: () => popup.submit("recovery-password"),
        invalid: /8 characters.*72 UTF-8 bytes/,
        retryAfter: () => undefined,
        seconds: 60,
        success: { status: 204 },
        form: "recovery-password",
      },
    ]) {
      if (form === "recovery-password") {
        popup.type("new-password", "new password");
        popup.type("confirm-password", "new password");
      }
      b.respond(() => ({ status: 400, body: "Bad Request\n" }));
      await submit();
      assert.match(elements.status.textContent, invalid);
      assert.equal(elements[form].hidden, false);

      const retryHeader = retryAfter();
      b.respond(() => ({ status: 429, headers: retryHeader ? { "Retry-After": retryHeader } : {} }));
      await submit();
      assert.match(elements.status.textContent, new RegExp(`Try again in ${seconds} seconds`));
      assert.equal(elements[form].hidden, false);
      const attemptCount = b.calls.length;
      b.advanceTime((seconds - 1) * 1000);
      b.respond(() => success);
      await submit();
      assert.equal(b.calls.length, attemptCount);
      assert.match(elements.status.textContent, /Try again in 1 second\./);
      b.advanceTime(1000);
      await submit();
      assert.equal(b.calls.length, attemptCount + 1);
    }
    assert.equal(elements.login.hidden, false);
    assert.match(elements.status.textContent, /Password reset/);
  });

  test(target + ": category controls autosave, normalize names, and notify tabs", async () => {
    const b = background();
    await b.session.set({ refreshToken: "old" });
    let values = ["math"], writes = 0;
    b.respond((url, options) => {
      if (url.endsWith("/auth/refresh")) return {status: 200, body: {
        access_token: "a", refresh_token: "r", expires_in: 900,
      }};
      if (options.method === "POST") {
        writes++;
        values = JSON.parse(options.body).categories;
      }
      return {status: 200, body: {status: "OK", categories: values}};
    });
    const popup = popupWithBackground(b);
    await popup.settle();
    const count = b.notifications();
    popup.type("new-category", " programming ");
    await popup.elements["add-category"].onclick();
    assert.deepEqual(values, ["math", "programming"]);
    assert.ok(b.notifications() > count);
    const savedWrites = writes;
    popup.type("new-category", " math ");
    await popup.elements["add-category"].onclick();
    popup.type("new-category", "   ");
    await popup.elements["add-category"].onclick();
    popup.type("new-category", "typing alone");
    await popup.saved();
    assert.equal(writes, savedWrites);
    const checkbox = popup.elements["category-options"].children[0].children[0];
    checkbox.checked = false;
    checkbox.listeners.change();
    await popup.saved();
    assert.deepEqual(values, ["programming"]);
    const reselect = popup.elements["category-options"].children[0].children[0];
    reselect.checked = true;
    reselect.listeners.change();
    await popup.saved();
    assert.deepEqual(values, ["programming", "math"]);
    for (const tag of [...popup.elements["selected-categories"].children]) tag.listeners.click();
    await popup.saved();
    assert.deepEqual(values, []);
    assert.equal(popup.elements["category-status"].textContent, "Categories saved.");
    const html = fs.readFileSync(path.join(directory, "popup.html"), "utf8");
    assert.doesNotMatch(html, /id="save-categories"/);
  });
  test(target + ": failed autosave preserves selections and retries saving without reloading", async () => {
    const b = background();
    await b.session.set({ accessToken: "a", refreshToken: "r", expires: Date.now() + 900000 });
    let fail = false, gets = 0, values = ["math"];
    b.respond((url, options) => {
      if (options.method === "POST") {
        if (fail) return {status: 500};
        values = JSON.parse(options.body).categories;
      } else gets++;
      return {status: 200, body: {status: "OK", categories: values}};
    });
    const popup = popupWithBackground(b);
    await popup.settle();
    fail = true;
    popup.type("new-category", "new edits");
    await popup.elements["add-category"].onclick();
    assert.equal(popup.elements["selected-categories"].children.length, 2);
    assert.equal(popup.elements["category-editor"].disabled, false);
    assert.match(popup.elements["category-status"].textContent, /Unable to save/);
    assert.equal(popup.elements["retry-categories"].hidden, false);
    fail = false;
    await popup.elements["retry-categories"].onclick();
    assert.deepEqual(values, ["math", "new edits"]);
    assert.equal(gets, 1);
    assert.equal(popup.elements["retry-categories"].hidden, true);
  });
  test(target + ": category editing waits for automatic load and failed loads can be retried", async () => {
    const b = background();
    await b.session.set({ accessToken: "a", refreshToken: "r", expires: Date.now() + 900000 });
    let finish;
    b.respond(() => new Promise(resolve => { finish = resolve; }));
    const popup = popupWithBackground(b);
    await tick();
    assert.equal(popup.elements["category-editor"].disabled, true);
    popup.type("new-category", "too early");
    await popup.elements["add-category"].onclick();
    finish({status: 200, body: {status: "OK", categories: ["math"]}});
    await popup.settle();
    assert.equal(popup.elements["category-editor"].disabled, false);
    assert.equal(popup.elements["selected-categories"].children.length, 1);
    b.respond(() => ({status: 500}));
    const failed = popupWithBackground(b);
    await failed.settle();
    assert.equal(failed.elements["category-editor"].disabled, true);
    assert.equal(failed.elements["retry-categories"].hidden, false);
    b.respond(() => ({status: 200, body: {status: "OK", categories: ["restored"]}}));
    await failed.elements["retry-categories"].onclick();
    assert.equal(failed.elements["selected-categories"].children[0].textContent, "restored ×");
  });
  test(target + ": rapid edits serialize and coalesce into the latest autosave", async () => {
    const b = background();
    await b.session.set({ accessToken: "a", refreshToken: "r", expires: Date.now() + 900000 });
    b.respond(() => ({status: 200, body: {status: "OK", categories: ["math"]}}));
    const popup = popupWithBackground(b);
    await popup.settle();
    const writes = [], pending = [];
    b.respond((url, options) => {
      writes.push(JSON.parse(options.body).categories);
      return new Promise(resolve => pending.push(resolve));
    });
    popup.type("new-category", "first");
    const saving = popup.elements["add-category"].onclick();
    await tick();
    popup.type("new-category", "<custom & safe>");
    let prevented = false;
    popup.elements["new-category"].listeners.keydown({key: "Enter", preventDefault() { prevented = true; }});
    popup.type("new-category", "latest");
    popup.elements["add-category"].onclick();
    assert.equal(prevented, true);
    assert.equal(writes.length, 1);
    assert.equal(popup.elements["category-editor"].disabled, false);
    pending.shift()({status: 200, body: {status: "OK"}});
    await tick();
    assert.equal(popup.elements["category-status"].textContent, "Saving…");
    assert.deepEqual(writes, [["math", "first"], ["math", "first", "<custom & safe>", "latest"]]);
    pending.shift()({status: 200, body: {status: "OK"}});
    await saving;
    assert.equal(popup.elements["category-status"].textContent, "Categories saved.");
    assert.equal(popup.elements["selected-categories"].children[2].textContent, "<custom & safe> ×");
    popup.type("new-category", "will fail");
    const failedSave = popup.elements["add-category"].onclick();
    await tick();
    popup.type("new-category", "keep latest");
    popup.elements["add-category"].onclick();
    pending.shift()({status: 500});
    await failedSave;
    assert.equal(writes.length, 3);
    assert.equal(popup.elements["retry-categories"].hidden, false);
    const retry = popup.elements["retry-categories"].onclick();
    await tick();
    assert.deepEqual(writes[3], ["math", "first", "<custom & safe>", "latest", "will fail", "keep latest"]);
    pending.shift()({status: 200, body: {status: "OK"}});
    await retry;
    assert.equal(popup.elements["category-status"].textContent, "Categories saved.");
  });
  test(target + ": stale category loads and saves cannot restore a signed-out view", async () => {
    for (const saving of [false, true]) {
      const b = background();
      await b.session.set({ accessToken: "a", refreshToken: "r", expires: Date.now() + 900000 });
      b.respond(() => ({status: 200, body: {status: "OK", categories: ["math"]}}));
      const popup = popupWithBackground(b);
      await popup.settle();
      let finish;
      b.respond(() => new Promise(resolve => { finish = resolve; }));
      let pending;
      if (saving) {
        popup.type("new-category", "pending");
        pending = popup.elements["add-category"].onclick();
        popup.type("new-category", "queued");
        popup.elements["add-category"].onclick();
      } else pending = vm.runInContext("loadCategories()", popup.context);
      await tick();
      popup.context[target === "chrome" ? "chrome" : "browser"].runtime.sendMessage =
        async () => ({loggedIn: false});
      await vm.runInContext("update()", popup.context);
      const calls = b.calls.length;
      finish({status: 200, body: {status: "OK", categories: ["stale"]}});
      await pending;
      assert.equal(popup.elements["category-section"].hidden, true);
      assert.equal(popup.elements["selected-categories"].children.length, 0);
      assert.equal(popup.elements["category-editor"].disabled, true);
      assert.equal(popup.elements["category-status"].textContent, "");
      assert.equal(b.calls.length, calls);
    }
  });
  test(target + ": tokens survive a background restart and clear when the browser closes", async () => {
    const b = background();
    await b.send({ type: "login", username: "u", password: "p" });
    assert.equal(b.restrictions.length, target === "chrome" ? 2 : 0);
    assert.ok(b.restrictions.every((x) => x === "TRUSTED_CONTEXTS"));
    const restarted = background(b);
    restarted.respond(() => ({
      status: 200,
      body: { status: "OK", allowed: true },
    }));
    assert.equal((await restarted.check()).state, "allowed");
    assert.equal(restarted.calls.length, 1); // access token survives worker suspension
    await b.session.clear();
    const fresh = background(b);
    assert.equal((await fresh.send({ type: "status" })).loggedIn, false);
    assert.equal((await fresh.check()).state, "login");
    assert.equal(fresh.calls.length, 0);
  });
  test(
    target + ": heartbeat exists only during requests, including errors",
    async () => {
      const b = background();
      let finish;
      b.respond(() => new Promise((resolve) => (finish = resolve)));
      const pending = b.send({ type: "login", username: "u", password: "p" });
      await tick();
      assert.equal(b.timers.size, target === "chrome" ? 1 : 0);
      for (const fn of b.timers.values()) await fn();
      assert.equal(b.heartbeat(), target === "chrome" ? 1 : 0);
      finish({
        status: 200,
        body: { access_token: "a", refresh_token: "r", expires_in: 900 },
      });
      await pending;
      assert.equal(b.timers.size, 0);
      b.respond(() => {
        throw Error("offline");
      });
      await b.check();
      assert.equal(b.timers.size, 0);
    },
  );
}
