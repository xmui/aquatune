// AquaTune — page-context shim (injected by aq-bridge.js, runs in the PAGE world).
// Exposes a tiny analyser-compatible object the visualizer can read from, fed by the FFT
// messages the extension relays. AquaTune's _vizAnalyser()/_vizActxRunning() detect this.

(() => {
  'use strict';
  if (window.__aqExtShimInstalled) return;
  window.__aqExtShimInstalled = true;

  const STALE_MS = 1000; // if no frame for this long, consider the feed dead and fall back

  let latestFreq = new Uint8Array(128);
  let latestTime = new Uint8Array(128).fill(128);
  let lastFrameTs = 0;
  let playing = false;

  // Minimal AnalyserNode-compatible surface used by the visualizer
  const shim = {
    fftSize: 256,
    frequencyBinCount: 128,
    getByteFrequencyData(out) { out.set(latestFreq.subarray(0, out.length)); },
    getByteTimeDomainData(out) { out.set(latestTime.subarray(0, out.length)); },
  };
  window.__aqExtAnalyser = shim;
  window.__aqExtPresent = false;
  window.__aqExtActive = false;

  function refreshActive() {
    window.__aqExtActive = window.__aqExtPresent
      && playing
      && (Date.now() - lastFrameTs < STALE_MS);
  }
  setInterval(refreshActive, 250);

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;                 // only same-window relays
    const m = ev.data;
    if (!m || m.__aqext !== true) return;
    if (m.type === 'hello') { window.__aqExtPresent = true; return; }
    if (m.type === 'bye')   { window.__aqExtPresent = false; window.__aqExtActive = false; return; }
    if (m.type !== 'fft' || !Array.isArray(m.freq)) return;
    window.__aqExtPresent = true;
    const n = m.binCount || m.freq.length;
    if (latestFreq.length !== n) { latestFreq = new Uint8Array(n); latestTime = new Uint8Array(n); }
    latestFreq.set(m.freq);
    if (Array.isArray(m.time)) latestTime.set(m.time);
    playing = !!m.playing;
    lastFrameTs = Date.now();
    refreshActive();
  });

  // Let the app know the bridge is present even before audio starts
  window.dispatchEvent(new CustomEvent('aqext-ready'));
})();
