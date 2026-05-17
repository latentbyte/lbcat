// ==UserScript==
// @name        Example Test Script
// @namespace   browser-control-test
// @match       https://example.com/*
// @grant       none
// @version     1.0
// @author      browser-control
// @description Example userscript for testing browser-control-push-all
// ==/UserScript==

// simple test script that adds a banner to example.com
(function () {
  "use strict";

  const banner = document.createElement("div");
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: #4CAF50;
    color: white;
    padding: 10px;
    text-align: center;
    font-family: sans-serif;
    font-size: 14px;
    z-index: 999999;
  `;
  banner.textContent = "browser-control test script loaded successfully";

  if (document.body) {
    document.body.appendChild(banner);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      document.body.appendChild(banner);
    });
  }

  console.log("[browser-control-test] Script loaded at", new Date().toISOString());
})();
