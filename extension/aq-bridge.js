// AquaTune — bridge content script (runs on the AquaTune origin).
// 1. Injects aq-page-shim.js into the PAGE context (content scripts are isolated from page JS,
//    so the shim that the app reads must live in the page world).
// 2. Receives relayed FFT messages from the background worker and forwards them into the page
//    via window.postMessage, where the shim picks them up.

(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;

  // Inject the page-context shim as early as possible
  try {
    const s = document.createElement('script');
    s.src = api.runtime.getURL('aq-page-shim.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}

  // Relay extension-runtime messages into the page
  api.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__aqext !== true) return;
    try { window.postMessage(msg, window.location.origin); } catch (e) {}
  });
})();
