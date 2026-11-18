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
          json: async () => r.body,
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
      send,
      check,
      calls,
      timers,
      restrictions,
      heartbeat: () => heartbeats,
      notifications: () => notifications,
      respond: (fn) => (responder = fn),
    };
  }
  test(
    target +
      ": " +
      "login persists only refresh credentials and restores session after restart",
    async () => {
      const b = background();
      assert.equal(
        (await b.send({ type: "login", username: "user", password: "secret" }))
          .ok,
        true,
      );
      assert.equal(b.local.data.refreshToken, "refresh");
      assert.equal(b.local.data.accessToken, undefined);
      assert.equal(b.session.data.accessToken, "access");
      await b.session.clear();
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
      assert.equal(b.local.data.refreshToken, "rotated");
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
      await b.local.set({ refreshToken: "old" });
      b.respond(() => {
        throw Error("offline");
      });
      assert.equal((await b.check()).state, "error");
      assert.equal(b.local.data.refreshToken, "old");
      b.respond(() => ({ status: 401 }));
      assert.equal((await b.check()).state, "login");
      assert.equal(b.local.data.refreshToken, undefined);
    },
  );
  test(target + ": " + "logout clears credentials", async () => {
    const b = background();
    await b.send({ type: "login", username: "user", password: "pass" });
    assert.equal((await b.send({ type: "status" }, true)).loggedIn, true);
    assert.equal((await b.send({ type: "logout" })).ok, true);
    assert.deepEqual(b.local.data, {});
    assert.equal(b.session.data.accessToken, undefined);
    assert.deepEqual(b.session.data.loginDraft, {});
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
        assert.deepEqual((await b.send({ type: "draftGet" })).draft, {});
        assert.equal((await b.send({ type: "draftGet" })).epoch, 4);
        assert.equal(b.calls.length, 0);
      }
    },
  );

  test(
    target +
      ": upgrade retains production sessions and strips legacy draft URLs",
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
            apiURL: "",
            username: "user",
            password: "draft-secret",
          },
        });
        const b = background({ local, session });
        assert.equal((await b.send({ type: "status" })).loggedIn, true);
        assert.equal(local.data.apiURL, undefined);
        assert.equal(session.data.accessToken, "production-access");
        assert.deepEqual((await b.send({ type: "draftGet" })).draft, {
          username: "user",
          password: "draft-secret",
        });
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
      assert.equal(b.local.data.refreshToken, "new-refresh");
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
    ];
    function element() {
      return {
        value: "", hidden: false, textContent: "", disabled: false,
        children: [], listeners: {},
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        setAttribute(name, value) { this[name] = value; },
        focus() {},
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
      ": login draft survives popup recreation and failed login but clears after success",
    async () => {
      const b = background();
      let popup = popupWithBackground(b);
      await popup.settle();
      popup.type("username", "user");
      popup.type("password", "secret");
      await popup.flush();
      assert.equal(b.local.data.loginDraft, undefined);
      popup = popupWithBackground(background(b));
      await popup.settle();
      assert.equal(popup.elements.password.value, "secret");
      assert.equal(popup.elements.username.value, "user");
      const epoch = (await b.send({ type: "draftGet" })).epoch;
      b.respond(() => ({ status: 401 }));
      await b.send({ type: "login", username: "user", password: "bad" });
      assert.equal(
        (await b.send({ type: "draftGet" })).draft.password,
        "secret",
      );
      b.respond(() => ({
        status: 200,
        body: { access_token: "a", refresh_token: "r", expires_in: 900 },
      }));
      await b.send({ type: "login", username: "user", password: "secret" });
      assert.equal((await b.send({ type: "draftGet" })).draft.password, "");
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
      assert.deepEqual(b.session.data.loginDraft, { username: credentials.email, password: "" });
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
      assert.equal(b.local.data.refreshToken, "r");
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

  test(target + ": category controls autosave, normalize names, and notify tabs", async () => {
    const b = background();
    await b.local.set({ refreshToken: "old" });
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
    await b.local.set({ refreshToken: "r" });
    await b.session.set({ accessToken: "a", expires: Date.now() + 900000 });
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
    await b.local.set({ refreshToken: "r" });
    await b.session.set({ accessToken: "a", expires: Date.now() + 900000 });
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
    await b.local.set({ refreshToken: "r" });
    await b.session.set({ accessToken: "a", expires: Date.now() + 900000 });
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
      await b.local.set({ refreshToken: "r" });
      await b.session.set({ accessToken: "a", expires: Date.now() + 900000 });
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
  test(target + ": storage restrictions and worker restart", async () => {
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
    fresh.respond((url) =>
      url.endsWith("/auth/refresh")
        ? {
            status: 200,
            body: {
              access_token: "restored",
              refresh_token: "next",
              expires_in: 900,
            },
          }
        : { status: 200, body: { status: "OK", allowed: false } },
    );
    assert.equal((await fresh.check()).state, "blocked");
    assert.equal(fresh.calls.length, 2);
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
