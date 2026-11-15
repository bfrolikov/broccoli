"use strict";
(() => {
  let current = null,
    state = "checking",
    revision = 0,
    scheduled = false;
  const covers = new Map();
  function id() {
    const u = new URL(location.href);
    const v =
      u.pathname === "/watch"
        ? u.searchParams.get("v")
        : u.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
    return /^[\w-]{11}$/.test(v || "") ? v : null;
  }
  function render() {
    const held = !!current && state !== "allowed";
    document.documentElement?.classList.toggle("broccoli-hold", held);
    for (const [container, cover] of covers) {
      if (!held || !container.isConnected || !cover.isConnected) {
        cover.remove();
        covers.delete(container);
      }
    }
    if (!held) return;
    document.querySelectorAll("video").forEach((video) => {
      video.pause();
      const container =
        video.closest(".html5-video-player") || video.parentElement;
      if (!container) return;
      let cover = covers.get(container);
      if (!cover) {
        cover = document.createElement("div");
        cover.className = "broccoli-cover";
        cover.setAttribute("role", "status");
        container.append(cover);
        covers.set(container, cover);
      }
      const label =
        state === "login"
          ? "Log in using the extension."
          : state === "blocked"
            ? "Blocked"
            : state === "error"
              ? "Unable to check"
              : "Checking video…";
      if (cover.dataset.state === state) return;
      cover.dataset.state = state;
      cover.replaceChildren();
      const message = document.createElement("span");
      message.textContent = label;
      cover.append(message);
      if (state === "error") {
        const retry = document.createElement("button");
        retry.textContent = "Retry";
        retry.onclick = () => check(true);
        cover.append(retry);
      }
    });
  }
  async function check(force = false) {
    const next = id();
    if (!force && next === current) {
      render();
      return;
    }
    current = next;
    const rev = ++revision;
    state = "checking";
    render();
    if (!next) return;
    try {
      const result = await extensionAPI.runtime.sendMessage({
        type: "check",
        videoID: next,
      });
      if (rev !== revision || id() !== next) return;
      state = ["allowed", "blocked", "login", "error"].includes(result?.state)
        ? result.state
        : "error";
    } catch {
      if (rev !== revision) return;
      state = "error";
    }
    render();
  }
  document.addEventListener(
    "play",
    (e) => {
      if (
        current &&
        state !== "allowed" &&
        e.target instanceof HTMLMediaElement
      )
        e.target.pause();
    },
    true,
  );
  document.addEventListener("yt-navigate-start", () => {
    revision++;
    current = id();
    state = "checking";
    render();
  });
  document.addEventListener("yt-navigate-finish", () => check(true));
  window.addEventListener("popstate", () => check(true));
  extensionAPI.runtime.onMessage.addListener((msg) => {
    if (msg.type === "changed" || msg.type === "navigate") check(true);
  });
  new MutationObserver(() => {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        check();
      });
    }
  }).observe(document, { childList: true, subtree: true });
  // Poll URL changes as a fallback for YouTube's different navigation paths.
  setInterval(() => check(), 250);
  check();
})();
