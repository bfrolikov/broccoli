"""Firefox popup/category smoke test using geckodriver and Python's stdlib."""
import base64
import io
import json
from pathlib import Path
import subprocess
import threading
import time
import urllib.error
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
UUID = "c2d9e36d-d43b-4af7-8778-3145d93d5540"
ADDON = "broccoli@bfrolikov.github.io"
state = {"categories": ["math"]}


class API(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond({"status": "OK", "categories": state["categories"]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if self.path == "/auth/register":
            assert body == {"email": "approved@example.com", "password": "password"}
            state["registered_email"] = body["email"]
            self.respond({"status": "OK"})
        elif self.path == "/auth/login" and "email" in body:
            assert body == {"email": state["registered_email"], "password": "password"}
            self.respond({"access_token": "test-access", "refresh_token": "test-refresh", "expires_in": 900})
        elif self.path == "/categories/":
            state["categories"] = body["categories"]
            self.respond({"status": "OK"})
        else:
            self.respond({"access_token": "test-access", "refresh_token": "test-refresh", "expires_in": 900})

    def respond(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), API)
    api = "http://127.0.0.1:" + str(server.server_port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    driver = subprocess.Popen(["geckodriver", "--port", "14445", "--log", "error"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sid = None

    def call(path, data=None, method="POST"):
        request = urllib.request.Request("http://127.0.0.1:14445" + path, data=json.dumps(data).encode() if data is not None else None, headers={"Content-Type": "application/json"}, method=method)
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)["value"]

    def execute(script):
        return call("/session/" + sid + "/execute/sync", {"script": script, "args": []})

    def wait(script):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if execute("return " + script):
                return
            time.sleep(0.1)
        raise AssertionError("Timed out waiting for popup state: " + script)

    try:
        for _ in range(100):
            try:
                call("/status", method="GET")
                break
            except (urllib.error.URLError, ConnectionError):
                time.sleep(0.1)
        session = call("/session", {"capabilities": {"alwaysMatch": {"browserName": "firefox", "moz:firefoxOptions": {"args": ["-headless"], "prefs": {"extensions.webextensions.uuids": json.dumps({ADDON: UUID})}}}}})
        sid = session["sessionId"]
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as output:
            for file in (ROOT / "firefox").iterdir():
                if file.is_file():
                    if file.name == "manifest.json":
                        manifest = json.loads(file.read_text())
                        manifest["host_permissions"] = [
                            "http://127.0.0.1/*" if origin == "https://api.anti-brainrot-blocker.fyi/*" else origin
                            for origin in manifest["host_permissions"]
                        ]
                        output.writestr(file.name, json.dumps(manifest))
                    elif file.name == "compatibility.js":
                        # Only the disposable test package uses the local fixture.
                        output.writestr(file.name, file.read_text().replace('"https://api.anti-brainrot-blocker.fyi"', json.dumps(api)))
                    else:
                        output.write(file, file.name)
        call("/session/" + sid + "/moz/addon/install", {"addon": base64.b64encode(archive.getvalue()).decode(), "temporary": True})
        popup = "moz-extension://" + UUID + "/popup.html"
        call("/session/" + sid + "/url", {"url": popup})
        wait("document.getElementById('username') !== null")
        assert execute("return document.getElementById('api')") is None
        execute("for(const [id,value] of Object.entries(" + json.dumps({"username": "user", "password": "password"}) + ")) { const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('input')); }")
        # Allow input messages to reach the background, then destroy the page.
        time.sleep(0.2)
        call("/session/" + sid + "/url", {"url": "about:blank"})
        call("/session/" + sid + "/url", {"url": popup})
        wait("document.getElementById('username').value === 'user'")
        assert execute("return document.getElementById('password').value") == ""
        execute("document.getElementById('password').value='password'")
        element = call("/session/" + sid + "/element", {"using": "css selector", "value": "#login-button"})
        call("/session/" + sid + "/element/" + next(iter(element.values())) + "/click", {})
        wait("!document.getElementById('category-section').hidden && !document.getElementById('category-editor').disabled")
        assert execute("return document.getElementById('password').value") == ""
        assert execute("return getComputedStyle(document.getElementById('retry-categories')).display") == "none"
        assert execute("return document.querySelectorAll('#reload-categories, #save-categories, textarea').length") == 0
        assert execute("return document.querySelector('#selected-categories button').textContent") == "math ×"
        execute("const e=document.getElementById('new-category');e.value=' programming ';document.getElementById('add-category').click()")
        wait("document.getElementById('category-status').textContent === 'Categories saved.'")
        assert state["categories"] == ["math", "programming"]
        execute("const e=document.getElementById('new-category');e.value='temporary';e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))")
        wait("document.getElementById('category-status').textContent === 'Categories saved.'")
        assert state["categories"] == ["math", "programming", "temporary"]
        execute("document.querySelector('[aria-label=\"Remove temporary\"]').click()")
        wait("document.getElementById('category-status').textContent === 'Categories saved.'")
        assert state["categories"] == ["math", "programming"]
        call("/session/" + sid + "/url", {"url": "about:blank"})
        call("/session/" + sid + "/url", {"url": popup})
        wait("!document.getElementById('category-editor').disabled")
        assert execute("return document.querySelectorAll('#selected-categories button').length") == 2
        execute("document.querySelector('#category-dropdown summary').click();document.querySelector('#category-options input').click()")
        assert execute("return document.querySelectorAll('#selected-categories button').length") == 1
        execute("document.querySelector('#category-options input').click()")
        assert execute("return document.querySelectorAll('#selected-categories button').length") == 2
        execute("for(const b of [...document.querySelectorAll('#selected-categories button')]) b.click()")
        wait("document.getElementById('category-status').textContent === 'Categories saved.'")
        assert state["categories"] == []
        execute("document.getElementById('logout').click()")
        wait("!document.getElementById('login').hidden")
        assert execute("return document.getElementById('password').value") == ""
        execute("document.getElementById('show-register').click()")
        execute("document.getElementById('register-email').value='approved@example.com';"
                "document.getElementById('register-password').value='password';"
                "document.getElementById('register-button').click()")
        wait("!document.getElementById('logout').hidden")
        assert execute("return document.getElementById('register-password').value") == ""
        print("Firefox: email registration and automatic sign-in passed.")
        print("Firefox: login draft restoration, password clearing, category read/save, and logout passed.")
    finally:
        if sid:
            call("/session/" + sid, method="DELETE")
        try:
            driver.terminate()
            driver.wait(timeout=10)
        except PermissionError:
            # Snap can disallow signaling its launcher; the WebDriver session
            # above has still been deleted and the browser is closed.
            pass
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
