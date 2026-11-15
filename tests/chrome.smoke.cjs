// Run with playwright-core and Chromium installed; see extension/README.md.
const { chromium } = require("playwright-core");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ytb-chrome-"));
  let context, server;
  const launch = (dir) =>
    chromium.launchPersistentContext(
      path.join(temp, path.basename(dir) + "-profile"),
      {
        executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          `--disable-extensions-except=${dir}`,
          `--load-extension=${dir}`,
        ],
      },
    );
  const worker = async (ctx) =>
    ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker"));
  try {
    const packaged = path.resolve(__dirname, "../chrome");
    context = await launch(packaged);
    let sw = await worker(context);
    assert.ok(sw.url().endsWith("/worker.js"));
    await sw.evaluate(() => chrome.runtime.getManifest());
    console.log("Unmodified Chrome extension installed successfully.");
    await context.close();
    context = null;
    // Rewrite only a disposable test copy to use the local fixture server.
    // Distributed extensions always use the production DNS endpoint.
    const fixture = path.join(temp, "fixture");
    fs.cpSync(packaged, fixture, { recursive: true });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixture, "manifest.json")),
    );
    manifest.host_permissions = manifest.host_permissions.map((origin) =>
      origin === "https://api.anti-brainrot-blocker.fyi/*"
        ? "http://127.0.0.1/*"
        : origin,
    );
    fs.writeFileSync(
      path.join(fixture, "manifest.json"),
      JSON.stringify(manifest),
    );
    let delay = 35000,
      allowed = true,
      categories = ["math"];
    server = http.createServer((req, res) => {
      const reply = (data) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      };
      if (req.url === "/auth/login") {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          const credentials = JSON.parse(body);
          if (credentials.username !== "user" || credentials.password !== "password") {
            res.statusCode = 401;
            return reply({error: "Unauthorized"});
          }
          reply({access_token: "access", refresh_token: "refresh", expires_in: 900});
        });
      } else if (req.url.startsWith("/auth/"))
        reply({access_token: "access", refresh_token: "refresh", expires_in: 900});
      else if (req.url === "/categories/") {
        if (req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            categories = JSON.parse(body).categories;
            allowed = categories.length > 0;
            reply({ status: "OK" });
          });
        } else reply({ status: "OK", categories });
      } else if (req.url.includes("/videos/"))
        setTimeout(() => reply({ status: "OK", allowed }), delay);
      else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const api = `http://127.0.0.1:${server.address().port}`;
    const compatibility = path.join(fixture, "compatibility.js");
    fs.writeFileSync(
      compatibility,
      fs
        .readFileSync(compatibility, "utf8")
        .replace(
          '"https://api.anti-brainrot-blocker.fyi"',
          JSON.stringify(api),
        ),
    );
    context = await launch(fixture);
    sw = await worker(context);
    const extensionOrigin = sw.url().split("/").slice(0, 3).join("/");
    let popup = await context.newPage();
    await popup.goto(extensionOrigin + "/popup.html");
    assert.equal(await popup.locator("#api, #settings").count(), 0);
    await popup.locator("#username").fill("user");
    await popup.locator("#password").fill("password");
    // Destroy the popup page: minimizing closes the actual toolbar popup similarly.
    await popup.close();
    const restored = await context.newPage();
    await restored.goto(extensionOrigin + "/popup.html");
    await restored.waitForFunction(
      () => document.getElementById("password").value === "password",
    );
    console.log("Username and password survived popup recreation.");
    assert.equal(await restored.locator("#username").inputValue(), "user");
    await restored.locator("#password").fill("wrong password");
    await restored.locator("#login button").click();
    await restored.getByText("Incorrect username or password.", {exact: true}).waitFor();
    assert.equal(await restored.locator("#password").inputValue(), "wrong password");
    assert.equal(await restored.locator("#login-button").isEnabled(), true);
    await restored.locator("#password").fill("password");
    await restored.locator("#login button").click();
    popup = restored;
    await popup.locator("#logout").waitFor({ state: "visible" });
    await popup.waitForFunction(
      () => document.querySelector("#selected-categories button")?.textContent === "math ×",
    );
    assert.equal(await popup.locator("#password").inputValue(), "");
    assert.equal(await popup.locator("#retry-categories").isVisible(), false);
    assert.equal(await popup.locator("#reload-categories, #save-categories, textarea").count(), 0);
    await popup.locator("#new-category").fill(" programming ");
    await popup.locator("#add-category").click();
    await popup.getByText("Categories saved.", { exact: true }).waitFor();
    assert.deepEqual(categories, ["math", "programming"]);
    await popup.locator("#new-category").fill("temporary");
    await popup.locator("#new-category").press("Enter");
    await popup.getByText("Categories saved.", { exact: true }).waitFor();
    assert.deepEqual(categories, ["math", "programming", "temporary"]);
    await popup.getByRole("button", { name: "Remove temporary", exact: true }).click();
    await popup.locator("#new-category").fill("math");
    await popup.locator("#add-category").click();
    await popup.locator("#category-dropdown summary").click();
    await popup.getByLabel("math", { exact: true }).uncheck();
    await popup.getByLabel("math", { exact: true }).check();
    await popup.getByText("Categories saved.", { exact: true }).waitFor();
    assert.deepEqual([...categories].sort(), ["math", "programming"]);
    const page = await context.newPage();
    await page.route("https://www.youtube.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<html><body><div class="html5-video-player" style="position:relative;width:640px;height:360px"><video controls></video></div></body></html>',
      }),
    );
    await page.goto("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await page.waitForFunction(() =>
      document.documentElement.classList.contains("ytb-hold"),
    );
    const start = Date.now();
    await page.waitForFunction(
      () => !document.documentElement.classList.contains("ytb-hold"),
      {},
      { timeout: 50000 },
    );
    assert.ok(Date.now() - start > 30000);
    console.log(
      "35-second check completed without worker termination; player remained held until allowed.",
    );
    // Suspend the worker through CDP and let a new popup message wake it.
    const cdp = await context.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    await popup.reload();
    await popup.locator("#logout").waitFor({ state: "visible" });
    delay = 0;
    allowed = false;
    await page.goto("https://www.youtube.com/shorts/abcdefghijk");
    await page.getByText("Blocked", { exact: true }).waitFor();
    console.log("Session survived worker restart; Shorts blocked correctly.");
    delay = 0;
    await popup.waitForFunction(() => !document.getElementById("category-editor").disabled);
    assert.equal(await popup.locator("#selected-categories button").count(), 2);
    while (await popup.locator("#selected-categories button").count())
      await popup.locator("#selected-categories button").first().click();
    await popup.getByText("Categories saved.", { exact: true }).waitFor();
    assert.deepEqual(categories, []);
    console.log("Category editing, normalization, and clearing passed.");
    await popup.locator("#logout").click();
    await page
      .getByText("Log in using the extension.", { exact: true })
      .waitFor();
    assert.equal(await page.locator("video").evaluate((v) => v.paused), true);
    console.log("Logout re-covered the player.");
  } finally {
    if (context) await context.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
