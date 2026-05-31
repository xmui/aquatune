// AquaTune — background service worker (MV3).
// Relays FFT messages from YouTube-frame content scripts to the AquaTune page's content
// script. A direct postMessage from the (cross-origin, possibly cross-tab) YouTube frame to
// the AquaTune top frame isn't reliable, so we route through the extension runtime here.

const api = globalThis.browser ?? globalThis.chrome;

// AquaTune pages we forward to. Keep in sync with manifest host_permissions.
const AQ_MATCHES = [
  'http://localhost/*',
  'http://127.0.0.1/*',
  'https://*.aquatune.app/*',
];

function forwardToAquaTune(msg) {
  api.tabs.query({ url: AQ_MATCHES }, (tabs) => {
    if (!tabs || !tabs.length) return;
    for (const tab of tabs) {
      try { api.tabs.sendMessage(tab.id, msg, () => void api.runtime.lastError); } catch (e) {}
    }
  });
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.__aqext !== true) return;
  // Only relay messages that originated from a YouTube frame
  const url = sender?.url || sender?.tab?.url || '';
  if (!/youtube\.com/.test(url)) return;
  forwardToAquaTune(msg);
});
