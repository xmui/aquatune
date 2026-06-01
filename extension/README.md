# AquaTune Audio Visualizer Bridge (MVP)

A small browser extension that captures **YouTube audio** and streams its frequency data to
AquaTune, so the in-app visualizer reacts to what's actually playing. The AquaTune page itself
can't read the YouTube iframe's audio (cross-origin), which is exactly the gap this fills.

## How it works

```
[youtube.com frame]            (extension runtime)         [AquaTune page]
 yt-capture.js  ──sendMessage──►  background.js  ──tabs.sendMessage──►  aq-bridge.js
   taps <video> via Web Audio                                              │ window.postMessage
   AnalyserNode (fftSize 256)                                              ▼
   ~30fps FFT frames                                              aq-page-shim.js
                                                          window.__aqExtAnalyser / __aqExtActive
                                                                            │
                                                          AquaTune _vizAnalyser() reads it
```

- `yt-capture.js` — runs in YouTube frames, wraps the `<video>` with
  `createMediaElementSource` + `AnalyserNode`, and (crucially) reconnects the source to
  `ctx.destination` so audio stays audible. Sends `{type:'fft', freq, time, playing}` frames.
- `background.js` — relays those frames to any open AquaTune tab.
- `aq-bridge.js` — injects the page shim and forwards frames into the page via `postMessage`.
- `aq-page-shim.js` — exposes an `AnalyserNode`-compatible `window.__aqExtAnalyser` and a
  `window.__aqExtActive` flag. AquaTune's `_vizAnalyser()` / `_vizActxRunning()` use these and
  fall back to the page's own analyser when the feed is stale (>1s) or absent.

`fftSize` is 256 on both sides, so `frequencyBinCount` is 128 and the data shape matches
AquaTune's internal analyser exactly — no changes to the drawing code are needed.

## Load it (Chrome / Edge)

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Open AquaTune (e.g. `http://localhost:5173`) **and** a YouTube tab (or let AquaTune play via
   its embedded YouTube player). Play something — the visualizer should react to real audio.

## Load it (Firefox)

1. Go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** → pick `manifest.json`.
3. Firefox supports MV3; the `browser_specific_settings.gecko.id` here is required. Each script
   uses `const api = globalThis.browser ?? globalThis.chrome;` so the same code runs on both.

## Configuring your AquaTune origin

`manifest.json` lists AquaTune origins under `host_permissions`, the AquaTune `content_scripts`
match, and `web_accessible_resources`. The defaults cover `localhost`, `127.0.0.1`, and
`*.aquatune.app`. Add your deployed origin to all three places if it differs.

## MVP scope / known limitations

- Single YouTube source assumed; multiple simultaneous YouTube tabs aren't disambiguated.
- FFT frames are sent as plain arrays (simple, slightly chatty). Base64/transferable packing is
  a future optimization.
- First playback may need a user gesture (click/keypress) for the AudioContext to resume — this
  is standard browser autoplay policy.
