// AquaTune — YouTube audio capture content script.
// Runs inside youtube.com frames (including the embedded player iframe used by AquaTune).
// Taps the <video> element via Web Audio, reads the frequency/time-domain data, and relays
// it to the background service worker, which forwards it to the AquaTune page.
//
// IMPORTANT: createMediaElementSource() reroutes the element's audio out of the default
// output. We therefore connect the source to BOTH the analyser AND ctx.destination, or
// YouTube would go silent. A media element can only be wrapped once, so we guard with a flag.

(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  if (!api?.runtime?.id) return;

  const FFT_SIZE = 256;          // -> frequencyBinCount = 128, matches AquaTune's analyser exactly
  const SEND_INTERVAL_MS = 33;   // ~30fps to keep message overhead low

  let ctx = null;
  let analyser = null;
  let freqBuf = null;
  let timeBuf = null;
  let boundVideo = null;
  let rafId = null;
  let lastSend = 0;

  function ensureGraph(video) {
    // Reuse the graph if we're already bound to this exact element
    if (boundVideo === video && analyser) return true;
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      // A given element can only be passed to createMediaElementSource once.
      if (video.__aqExtSourced) {
        // Already wired by us previously (element reused across SPA navigations) — keep going.
      } else {
        const src = ctx.createMediaElementSource(video);
        analyser = ctx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0.8;
        src.connect(analyser);
        src.connect(ctx.destination); // keep audio audible
        video.__aqExtSourced = true;
        video.__aqExtAnalyser = analyser;
      }
      analyser = video.__aqExtAnalyser || analyser;
      freqBuf = new Uint8Array(analyser.frequencyBinCount);
      timeBuf = new Uint8Array(analyser.frequencyBinCount);
      boundVideo = video;
      return true;
    } catch (e) {
      // Autoplay/user-gesture issues can throw; we'll retry on the next tick.
      return false;
    }
  }

  function findVideo() {
    const v = document.querySelector('video');
    return (v && v.readyState >= 1) ? v : null;
  }

  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    const video = findVideo();
    if (!video) return;
    if (!ensureGraph(video)) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }

    if (ts - lastSend < SEND_INTERVAL_MS) return;
    lastSend = ts;

    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(timeBuf);
    const playing = !video.paused && !video.ended && video.readyState > 2;

    try {
      api.runtime.sendMessage({
        __aqext: true,
        v: 1,
        type: 'fft',
        binCount: freqBuf.length,
        freq: Array.from(freqBuf),
        time: Array.from(timeBuf),
        playing,
        ts: Date.now(),
      });
    } catch (e) { /* background may be asleep; ignore */ }
  }

  function start() {
    if (rafId) return;
    // Announce presence so AquaTune can show a "live from YouTube" badge
    try { api.runtime.sendMessage({ __aqext: true, v: 1, type: 'hello', ts: Date.now() }); } catch (e) {}
    rafId = requestAnimationFrame(loop);
  }

  // Resume the context on any user gesture (helps with autoplay policy)
  ['click', 'keydown', 'play'].forEach(ev =>
    document.addEventListener(ev, () => { if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {}); }, true)
  );

  // Re-bind when YouTube swaps the <video> across SPA navigations
  window.addEventListener('yt-navigate-finish', () => { boundVideo = null; });
  const mo = new MutationObserver(() => { if (!findVideo()) boundVideo = null; });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  start();
})();
