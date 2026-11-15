"use strict";
const API_URL = "https://api.anti-brainrot-blocker.fyi";
// MV3 APIs used here support promises natively in both target browsers.
const extensionAPI = globalThis.browser || globalThis.chrome;
const isChromeExtension = extensionAPI.runtime
  .getURL("")
  .startsWith("chrome-extension://");
