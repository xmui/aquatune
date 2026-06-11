/* ============================================================================
 * AquaSynth Studio (Phase 1, increments 2–4)
 *
 * A small skeuomorphic mini-DAW: transport + arrangement timeline (clips on
 * per-track lanes) + a pattern editor (step grid for drums, piano-roll for
 * melodic), driven by a sample-accurate Web-Audio scheduler. Built on the pure
 * engine in ./aquasynth-engine.js. Reuses the app's shared AudioContext
 * (window.actx / window.masterComp) and the existing drum-synth voices.
 *
 * Exposes window.openStudio() (called by the OS launcher) + window.Studio API.
 * ========================================================================== */
import * as E from './aquasynth-engine.js';

const TRACK_COLORS = ['#ff5d73', '#ffb020', '#ffd23f', '#4cd07d', '#36c5f0', '#7c8cff', '#c977ff', '#ff6fd0'];
const DRUM_FNS = { kick: 'drumKick', snare: 'drumSnare', hihat: 'drumHihat', openhh: 'drumOpenHH', clap: 'drumClap', tom: 'drumTom', crash: 'drumCrash', cowbell: 'drumCowbell' };
const DRUM_VOICES = ['kick', 'snare', 'hihat', 'openhh', 'clap', 'tom', 'crash', 'cowbell'];
const CHIP_WAVES = ['pulse', 'triangle', 'sawtooth', 'noise'];
// Sound presets (mirror the legacy AquaSynth variety). Each sets synth params + fx.
const PRESETS = [
  { name: 'Square Lead',  type: 'chip', params: { wave: 'pulse',    a: 0.005, d: 0.05, s: 0.7, r: 0.12, cut: 12000, res: 1, fenv: 0, vibrato: true } },
  { name: 'Saw Lead',     type: 'chip', params: { wave: 'sawtooth', a: 0.004, d: 0.08, s: 0.6, r: 0.12, cut: 4500, res: 3, fenv: 0.45 } },
  { name: 'Chip Arp',     type: 'chip', params: { wave: 'pulse',    a: 0.002, d: 0.04, s: 0.3, r: 0.05, cut: 8000, res: 2, fenv: 0.3 } },
  { name: 'Pluck',        type: 'chip', params: { wave: 'pulse',    a: 0.002, d: 0.12, s: 0.0, r: 0.08, cut: 5000, res: 4, fenv: 0.6 } },
  { name: 'Sub Bass',     type: 'chip', params: { wave: 'triangle', a: 0.004, d: 0.1,  s: 0.85, r: 0.1, cut: 1200, res: 2, fenv: 0.2 } },
  { name: 'Reese Bass',   type: 'chip', params: { wave: 'sawtooth', a: 0.005, d: 0.1,  s: 0.85, r: 0.12, cut: 900, res: 6, fenv: 0.3 }, fx: { drive: 0.4 } },
  { name: 'Soft Pad',     type: 'chip', params: { wave: 'triangle', a: 0.3,  d: 0.25, s: 0.85, r: 0.6, cut: 3000, res: 1, fenv: 0.2 }, fx: { reverb: 0.35, chorus: 0.4 } },
  { name: 'Noise Hit',    type: 'chip', params: { wave: 'noise',    a: 0.002, d: 0.1,  s: 0.2, r: 0.1, cut: 12000, res: 1, fenv: 0 } },
  { name: 'Toy Piano',    type: 'keys', params: { preset: 'toypiano', a: 0.005, d: 0.2, s: 0.4, r: 0.3, cut: 12000, res: 1, fenv: 0 } },
  { name: 'Glass Bells',  type: 'keys', params: { preset: 'toypiano', a: 0.002, d: 0.5, s: 0.0, r: 0.5, cut: 12000, res: 1, fenv: 0 }, fx: { reverb: 0.45 } },
  { name: 'Organ',        type: 'keys', params: { preset: 'organ', a: 0.02, d: 0.05, s: 0.9, r: 0.1, cut: 12000, res: 1, fenv: 0 } },
  { name: 'Warm Strings', type: 'keys', params: { preset: 'organ', a: 0.25, d: 0.2, s: 0.85, r: 0.5, cut: 4000, res: 1, fenv: 0.3 }, fx: { reverb: 0.4, chorus: 0.5 } },
  { name: 'Casio Tone',   type: 'keys', params: { preset: 'casio', a: 0.005, d: 0.1, s: 0.6, r: 0.15, cut: 9000, res: 1, fenv: 0 } },
];
function applyPreset(inst, preset) {
  Object.assign(inst.params, JSON.parse(JSON.stringify(preset.params)));
  if (preset.fx) Object.assign(inst.fx, preset.fx);
  inst.name = preset.name;
  inst._chain = null;              // rebuild so drive/sends pick up new values
  renderAll();
  if (_playing) _events = E.expandArrangement(project);
}
const LOOKAHEAD = 0.12, TICK_MS = 25;
const EDITOR_LO = 48; // C3 — piano-roll bottom note

let project = null;
let _master = null, _noiseBuf = null, _buses = null;
let _playing = false, _schedTimer = null, _rafId = null;
let _loopBase = 0, _evIdx = 0, _events = [], _songSec = 0;
let _loop = true;
let _pxPerBar = 96;            // timeline zoom
let _selInstId = null;         // selected track (drives the editor)
let _selClipId = null;         // selected clip (drives which pattern the editor edits)
let _rollTool = 'draw';        // piano-roll tool: 'draw' (pencil) | 'select' (marquee)
let _selNotes = new Set();     // selected note objects in the piano roll
let _built = false;
let _recording = false, _quantize = 1, _recOct = 4; // recording + quantize (steps) + computer-kbd octave
const _pending = {};           // midi -> pending note start during recording
const _heldKeys = {};          // computer-key debounce

/* ---- audio plumbing ----------------------------------------------------- */
function actx() { if (window.initActx) window.initActx(); return window.actx; }
function master() {
  const c = actx();
  if (!_master || _master.context !== c) {
    _master = c.createGain();
    _master.gain.value = project ? project.master : 0.9;
    _master.connect(window.masterComp || c.destination);
  }
  return _master;
}
function noiseBuf(c) {
  if (_noiseBuf && _noiseBuf._sr === c.sampleRate) return _noiseBuf;
  const n = c.sampleRate, b = c.createBuffer(1, n, c.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  b._sr = c.sampleRate; _noiseBuf = b; return b;
}

// Optional per-voice resonant lowpass with an envelope (cut>=11000 = bypassed,
// so it's a no-op unless the track's CUT knob is lowered). Used by all melodic voices.
function applyFilter(c, src, dest, t, p = {}) {
  const cut = p.cut;
  if (cut == null || cut >= 11000) { src.connect(dest); return; }
  const f = c.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = p.res ?? 1;
  const base = Math.max(60, cut), amt = (p.fenv ?? 0) * 7000;
  const a = p.a ?? 0.006, d = p.d ?? 0.04;
  f.frequency.setValueAtTime(base, t);
  if (amt > 1) {
    f.frequency.linearRampToValueAtTime(Math.min(16000, base + amt), t + a + 0.001);
    f.frequency.exponentialRampToValueAtTime(base, t + a + d + 0.06);
  }
  src.connect(f); f.connect(dest);
}

// Chiptune / melodic voice: pulse/triangle/saw oscillator or band-passed noise,
// with a short AD-S-R gain envelope. Works on any context (live or offline render).
function chipVoice(c, dest, midi, t, dur, vel, params = {}) {
  const freq = E.midiToFreq(midi);
  const wave = params.wave || 'pulse';
  const a = params.a ?? 0.006, d = params.d ?? 0.04, s = params.s ?? 0.65, r = params.r ?? 0.08;
  const peak = 0.26 * (vel ?? 0.9);
  const end = t + Math.max(0.06, dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * s), t + a + d);
  g.gain.setValueAtTime(Math.max(0.0001, peak * s), Math.max(t + a + d, end));
  g.gain.exponentialRampToValueAtTime(0.0001, end + r);
  applyFilter(c, g, dest, t, params);
  if (wave === 'noise') {
    const src = c.createBufferSource(); src.buffer = noiseBuf(c); src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.min(freq * 2, 8000); bp.Q.value = 5;
    src.connect(bp); bp.connect(g); src.start(t); src.stop(end + r + 0.02);
  } else {
    const osc = c.createOscillator();
    osc.type = wave === 'pulse' ? 'square' : wave;
    osc.frequency.setValueAtTime(freq, t);
    // gentle vibrato for character
    if (params.vibrato) {
      const lfo = c.createOscillator(), lg = c.createGain();
      lfo.frequency.value = 5.5; lg.gain.value = freq * 0.01;
      lfo.connect(lg); lg.connect(osc.frequency); lfo.start(t); lfo.stop(end + r + 0.02);
    }
    osc.connect(g); osc.start(t); osc.stop(end + r + 0.02);
  }
}

// Toy/vintage keys: FM bell (toy piano), additive organ, or simple Casio-ish tone.
function keysVoice(c, dest, midi, t, dur, vel, params = {}) {
  const freq = E.midiToFreq(midi), preset = params.preset || 'toypiano';
  const end = t + Math.max(0.18, dur), peak = 0.26 * (vel ?? 0.9);
  const g = c.createGain(); applyFilter(c, g, dest, t, params);
  if (preset === 'organ') {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    g.gain.setValueAtTime(peak, Math.max(t + 0.02, end)); g.gain.exponentialRampToValueAtTime(0.0001, end + 0.06);
    [[1, 1], [2, 0.5], [3, 0.34], [4, 0.22]].forEach(([h, a], i) => { const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = freq * h * (1 + (i ? (i % 2 ? 0.004 : -0.004) : 0)); const og = c.createGain(); og.gain.value = a; o.connect(og); og.connect(g); o.start(t); o.stop(end + 0.07); });
  } else if (preset === 'casio') {
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.01); g.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.6), end); g.gain.exponentialRampToValueAtTime(0.0001, end + 0.08);
    const o1 = c.createOscillator(); o1.type = 'square'; o1.frequency.value = freq;
    const o2 = c.createOscillator(); o2.type = 'triangle'; o2.frequency.value = freq * 2.01;
    const o2g = c.createGain(); o2g.gain.value = 0.4;
    const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 6; lg.gain.value = freq * 0.012; lfo.connect(lg); lg.connect(o1.frequency); lfo.start(t); lfo.stop(end + 0.09);
    o1.connect(g); o2.connect(o2g); o2g.connect(g); o1.start(t); o2.start(t); o1.stop(end + 0.09); o2.stop(end + 0.09);
  } else { // toypiano — FM bell
    const car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain();
    car.frequency.value = freq; mod.frequency.value = freq * 3.0;
    mg.gain.setValueAtTime(freq * 4, t); mg.gain.exponentialRampToValueAtTime(freq * 0.3, t + 0.35);
    mod.connect(mg); mg.connect(car.frequency);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, end + 0.3);
    car.connect(g); car.start(t); mod.start(t); car.stop(end + 0.4); mod.stop(end + 0.4);
  }
}

function sampleBuffer(inst, c) {
  // live ctx buffer is cached on the instrument; offline uses the passed-in map
  return inst._buf && inst._buf.sampleRate === c.sampleRate ? inst._buf : null;
}
function samplerVoice(c, dest, midi, t, dur, vel, inst, bufOverride) {
  const buf = bufOverride || sampleBuffer(inst, c); if (!buf) return;
  const src = c.createBufferSource(); src.buffer = buf;
  src.playbackRate.value = E.midiToFreq(midi) / E.midiToFreq(inst.params.baseNote || 60);
  if (inst.params.loop) src.loop = true;
  const g = c.createGain(); g.gain.value = 0.85 * (vel ?? 0.9); src.connect(g); applyFilter(c, g, dest, t, inst.params);
  src.start(t);
  if (inst.params.loop || inst.params.oneShot === false) { const end = t + Math.max(0.05, dur); g.gain.setValueAtTime(g.gain.value, end); g.gain.exponentialRampToValueAtTime(0.0001, end + 0.06); src.stop(end + 0.07); }
}

/* ---- per-track FX chain:  in → drive → pan → gain → (dry + FX sends) → master --- */
function setDriveCurve(ws, amount) {
  if (!amount || amount <= 0) { ws.curve = null; return; }
  const k = amount * 100, n = 256, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = (Math.PI + k) * x / (Math.PI + k * Math.abs(x)); }
  ws.curve = curve; ws.oversample = '2x';
}
// Build a track chain on any context, summing dry to `dest` (+ FX sends, added in P3).
function buildChain(c, inst, dest, buses) {
  const fx = inst.fx || (inst.fx = E.defaultFx());
  const input = c.createGain();
  const drive = c.createWaveShaper(); setDriveCurve(drive, fx.drive || 0);
  const pan = c.createStereoPanner ? c.createStereoPanner() : null; if (pan) pan.pan.value = fx.pan || 0;
  const gain = c.createGain(); gain.gain.value = fx.level ?? 0.9;
  input.connect(drive);
  if (pan) { drive.connect(pan); pan.connect(gain); } else { drive.connect(gain); }
  gain.connect(dest); // dry
  const chain = { ctx: c, input, drive, pan, gain, sends: {} };
  if (buses) attachSends(c, chain, fx, buses); // P3
  return chain;
}
function getLiveChain(inst) {
  const c = actx();
  if (!inst._chain || inst._chain.ctx !== c) inst._chain = buildChain(c, inst, master(), liveBuses());
  return inst._chain;
}
function applyChainParams(inst) {
  const ch = inst._chain; if (!ch) return; const fx = inst.fx || {};
  setDriveCurve(ch.drive, fx.drive || 0);
  if (ch.pan) ch.pan.pan.setTargetAtTime(fx.pan || 0, ch.ctx.currentTime, 0.01);
  ch.gain.gain.setTargetAtTime(fx.level ?? 0.9, ch.ctx.currentTime, 0.01);
  updateSends(ch, fx);
}
/* ---- shared FX send buses: reverb (convolver), delay (+fb), chorus (LFO) ---- */
function makeImpulse(c, seconds) {
  const len = Math.floor(c.sampleRate * seconds), buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2); }
  return buf;
}
function makeBuses(c, dest) {
  // reverb
  const reverb = c.createGain();
  const conv = c.createConvolver(); conv.buffer = makeImpulse(c, 2.2);
  const revWet = c.createGain(); revWet.gain.value = 0.9;
  reverb.connect(conv); conv.connect(revWet); revWet.connect(dest);
  // delay (feedback echo)
  const delay = c.createGain();
  const dl = c.createDelay(2); dl.delayTime.value = 0.33;
  const fb = c.createGain(); fb.gain.value = 0.36;
  const dWet = c.createGain(); dWet.gain.value = 0.9;
  delay.connect(dl); dl.connect(fb); fb.connect(dl); dl.connect(dWet); dWet.connect(dest);
  // chorus (LFO-modulated short delay)
  const chorus = c.createGain();
  const cd = c.createDelay(0.05); cd.delayTime.value = 0.02;
  const lfo = c.createOscillator(); lfo.frequency.value = 0.5;
  const lg = c.createGain(); lg.gain.value = 0.006; lfo.connect(lg); lg.connect(cd.delayTime); try { lfo.start(); } catch (_) {}
  const cWet = c.createGain(); cWet.gain.value = 0.9;
  chorus.connect(cd); cd.connect(cWet); cWet.connect(dest);
  return { ctx: c, reverb, delay, chorus };
}
function liveBuses() { const c = actx(); if (!_buses || _buses.ctx !== c) _buses = makeBuses(c, master()); return _buses; }
function attachSends(c, chain, fx, buses) {
  if (!buses) { chain.sends = {}; return; }
  const mk = (busInput, amt) => { const g = c.createGain(); g.gain.value = amt || 0; chain.gain.connect(g); g.connect(busInput); return g; };
  chain.sends = { reverb: mk(buses.reverb, fx.reverb), delay: mk(buses.delay, fx.delay), chorus: mk(buses.chorus, fx.chorus) };
}
function updateSends(chain, fx) {
  if (!chain || !chain.sends) return;
  const t = chain.ctx.currentTime;
  for (const k of ['reverb', 'delay', 'chorus']) if (chain.sends[k]) chain.sends[k].gain.setTargetAtTime(fx[k] || 0, t, 0.01);
}
// Backfill synth params + fx on instruments from older projects / MIDI imports.
function normalizeInstruments() {
  for (const i of project.instruments) {
    i.params = Object.assign(E.defaultParams(i.type), i.params || {});
    i.fx = Object.assign(E.defaultFx(), i.fx || {});
    i._chain = null;
  }
}

/* ---- SF2 soundfont instrument ------------------------------------------ */
function buildSF2Zones(parsed, presetIndex, c) {
  const preset = parsed.presets[presetIndex] || parsed.presets[0];
  const smpl = parsed.smpl;
  return preset.zones.map(z => {
    const len = Math.max(1, z.end - z.start), rate = z.rate || 44100;
    const buf = c.createBuffer(1, len, rate); const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = smpl[z.start + i] / 32768;
    return Object.assign({}, z, { _buf: buf, loopStartSec: (z.loopStart - z.start) / rate, loopEndSec: (z.loopEnd - z.start) / rate });
  });
}
// (re)build the selected preset's zones for the given context, caching on the instrument
function ensureSF2(inst, c) {
  const pi = inst.params.presetIndex || 0;
  if (inst._sf2 && inst._sf2.ctx === c && inst._sf2.presetIndex === pi) return inst._sf2;
  if (!inst._sf2 || !inst._sf2.parsed) {
    if (!inst.sampleRef || !project.samples[inst.sampleRef]) return null;
    try { inst._sf2 = { parsed: E.parseSF2(b64ToBuf(project.samples[inst.sampleRef])) }; } catch (_) { return null; }
  }
  inst._sf2.ctx = c; inst._sf2.presetIndex = pi; inst._sf2.zones = buildSF2Zones(inst._sf2.parsed, pi, c);
  inst.params.presetNames = inst._sf2.parsed.presets.map(p => p.name);
  return inst._sf2;
}
function pickZone(zones, midi) {
  let best = null;
  for (const z of zones) { if (midi >= z.lo && midi <= z.hi) return z; }
  for (const z of zones) { if (!best || Math.abs(z.root - midi) < Math.abs(best.root - midi)) best = z; }
  return best;
}
function sf2Voice(c, dest, midi, t, dur, vel, inst, zonesOverride) {
  const zones = zonesOverride || (ensureSF2(inst, c) || {}).zones; if (!zones || !zones.length) return;
  const z = pickZone(zones, midi); if (!z || !z._buf) return;
  const src = c.createBufferSource(); src.buffer = z._buf;
  const tune = Math.pow(2, ((z.coarse || 0) * 100 + (z.fine || 0)) / 1200);
  src.playbackRate.value = (E.midiToFreq(midi) / E.midiToFreq(z.root || 60)) * tune;
  if (z.loop && z.loopEndSec > z.loopStartSec) { src.loop = true; src.loopStart = z.loopStartSec; src.loopEnd = z.loopEndSec; }
  const p = inst.params, a = p.a ?? 0.004, r = p.r ?? 0.25, peak = 0.9 * (vel ?? 0.9), end = t + Math.max(0.05, dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, Math.max(t + a, end)); g.gain.exponentialRampToValueAtTime(0.0001, end + r);
  src.connect(g); applyFilter(c, g, dest, t, p);
  src.start(t); src.stop(end + r + 0.05);
}

function triggerEvent(ev, when) {
  const inst = project.instruments.find(i => i.id === ev.instId);
  if (!inst || inst._mute) return;
  if (project.instruments.some(i => i._solo) && !inst._solo) return; // solo overrides
  const c = actx();
  const dest = getLiveChain(inst).input;
  if (inst.type === 'drum') {
    const fn = DRUM_FNS[(inst.params && inst.params.voice) || 'kick'];
    if (typeof window[fn] === 'function') { try { window[fn](when); return; } catch (_) {} }
    chipVoice(c, dest, ev.midi, when, ev.durSec, ev.vel, { wave: 'noise' });
  } else if (inst.type === 'keys') {
    keysVoice(c, dest, ev.midi, when, ev.durSec, ev.vel, inst.params || {});
  } else if (inst.type === 'sampler') {
    samplerVoice(c, dest, ev.midi, when, ev.durSec, ev.vel, inst);
  } else if (inst.type === 'sf2') {
    sf2Voice(c, dest, ev.midi, when, ev.durSec, ev.vel, inst);
  } else {
    chipVoice(c, dest, ev.midi, when, ev.durSec, ev.vel, inst.params || {});
  }
}

/* ---- transport / scheduler --------------------------------------------- */
let _studioMusicMs = 0, _studioMusicLast = 0;  // accrue Music XP while making beats
function play() {
  if (_playing) return;
  const c = actx();
  _events = E.expandArrangement(project);
  _songSec = E.songLengthSec(project) || E.secPerBar(project.bpm) * 4;
  _evIdx = 0;
  _loopBase = c.currentTime + 0.08;
  _playing = true;
  _studioMusicLast = performance.now();
  _schedTimer = setInterval(scheduleTick, TICK_MS);
  scheduleTick();
  _rafId = requestAnimationFrame(playheadTick);
  syncTransportUI();
}
function stop() {
  _playing = false;
  if (_schedTimer) { clearInterval(_schedTimer); _schedTimer = null; }
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  const ph = document.getElementById('st-playhead'); if (ph) ph.style.transform = 'translateX(0px)';
  const rph = document.getElementById('st-roll-ph'); if (rph) rph.style.display = 'none';
  syncTransportUI();
}
function togglePlay() { _playing ? stop() : play(); }

function scheduleTick() {
  const c = actx(); const horizon = c.currentTime + LOOKAHEAD;
  let guard = 0;
  while (guard++ < 5000) {
    if (_evIdx < _events.length) {
      const ev = _events[_evIdx];
      const absT = _loopBase + ev.timeSec;
      if (absT < horizon) { triggerEvent(ev, Math.max(absT, c.currentTime)); _evIdx++; continue; }
    }
    const iterEnd = _loopBase + _songSec;
    if (_evIdx >= _events.length && iterEnd < horizon) {
      if (_loop) { _loopBase = iterEnd; _evIdx = 0; continue; }
      else { stop(); return; }
    }
    break;
  }
}
function playheadTick() {
  if (!_playing) return;
  // accrue Music XP for time spent making beats (~20 XP / 60s, like watching video)
  const _pnow = performance.now();
  _studioMusicMs += Math.min(1000, _pnow - (_studioMusicLast || _pnow));
  _studioMusicLast = _pnow;
  if (_studioMusicMs >= 60000) { _studioMusicMs = 0; if (window.aqAddXp) window.aqAddXp('music', 20); }
  const c = actx();
  let songT = c.currentTime - _loopBase;
  if (songT < 0) songT = 0;
  const bar = songT / E.secPerBar(project.bpm);
  const ph = document.getElementById('st-playhead');
  if (ph) ph.style.transform = `translateX(${bar * _pxPerBar}px)`;
  // mirror it in the piano roll, mapped to the selected pattern's local position
  const rph = document.getElementById('st-roll-ph');
  if (rph) {
    const pat = selectedPattern();
    if (pat) {
      const clip = selectedClip();
      const start = clip ? clip.startBar : 0;
      const span = pat.bars || 1;
      const localBar = (((bar - start) % span) + span) % span;
      rph.style.transform = `translateX(${localBar * E.STEPS_PER_BAR * ROLL.STEP_W}px)`;
      rph.style.display = '';
    } else rph.style.display = 'none';
  }
  _rafId = requestAnimationFrame(playheadTick);
}

/* ---- project bootstrap (a fun default so it's playable on open) -------- */
function demoProject() {
  const p = E.makeProject('Demo Jam'); p.bpm = 120;
  const mk = (type, name, params) => { const i = E.makeInstrument(type, name, params); p.instruments.push(i); return i; };
  const kick = mk('drum', 'Kick', { voice: 'kick', drumMidi: 36 });
  const snare = mk('drum', 'Snare', { voice: 'snare', drumMidi: 38 });
  const hat = mk('drum', 'Hat', { voice: 'hihat', drumMidi: 42 });
  const lead = mk('chip', 'Chip Lead', { wave: 'pulse', vibrato: true });
  const bass = mk('chip', 'Chip Bass', { wave: 'triangle' });

  const kp = E.makePattern('Kick', 1); [0, 4, 8, 12].forEach(s => kp.steps[s] = 1);
  const sp = E.makePattern('Snare', 1); [4, 12].forEach(s => sp.steps[s] = 1);
  const hp = E.makePattern('Hat', 1); [0, 2, 4, 6, 8, 10, 12, 14].forEach(s => hp.steps[s] = 1);
  const lp = E.makePattern('Riff', 2);
  [[72, 0], [76, 2], [79, 4], [76, 6], [74, 8], [72, 10], [67, 12], [72, 14],
   [72, 16], [79, 18], [84, 20], [79, 22], [77, 24], [74, 26], [71, 28], [74, 30]]
    .forEach(([m, s]) => lp.notes.push({ midi: m, start: s, len: 2, vel: 0.85 }));
  const bp = E.makePattern('Bass', 1);
  [[36, 0], [36, 6], [43, 8], [41, 12]].forEach(([m, s]) => bp.notes.push({ midi: m, start: s, len: 2, vel: 0.95 }));
  p.patterns.push(kp, sp, hp, lp, bp);

  E.ensureTrack(p, kick.id).clips.push(E.makeClip(kp.id, 0, 4));
  E.ensureTrack(p, snare.id).clips.push(E.makeClip(sp.id, 0, 4));
  E.ensureTrack(p, hat.id).clips.push(E.makeClip(hp.id, 0, 4));
  E.ensureTrack(p, lead.id).clips.push(E.makeClip(lp.id, 0, 2));
  E.ensureTrack(p, lead.id).clips.push(E.makeClip(lp.id, 2, 2));
  E.ensureTrack(p, bass.id).clips.push(E.makeClip(bp.id, 0, 4));
  return p;
}

/* ---- UI ----------------------------------------------------------------- */
function instColor(instId) {
  const idx = project.instruments.findIndex(i => i.id === instId);
  return TRACK_COLORS[((idx % TRACK_COLORS.length) + TRACK_COLORS.length) % TRACK_COLORS.length];
}
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function renderAll() { renderTracks(); renderTimeline(); renderEditor(); syncTransportUI(); }

function renderTracks() {
  const host = document.getElementById('st-tracks'); if (!host) return;
  host.innerHTML = '';
  project.instruments.forEach(inst => {
    const row = el('div', 'st-track' + (inst.id === _selInstId ? ' sel' : ''));
    row.style.borderLeftColor = instColor(inst.id);
    row.onclick = () => { if (_selInstId !== inst.id) { _selInstId = inst.id; _selClipId = null; _selNotes.clear(); } renderAll(); };
    row.oncontextmenu = e => { e.preventDefault(); _selInstId = inst.id; renderAll(); showTrackMenu(inst, row, e); };
    const icon = inst.type === 'drum' ? '🥁' : (inst.params && inst.params.wave === 'noise' ? '📻' : '🎹');
    row.appendChild(el('div', 'st-tname', `<span>${icon}</span><b>${esc(inst.name)}</b>`));
    const ctrls = el('div', 'st-tctrls');
    const solo = el('button', 'st-mini solo' + (inst._solo ? ' on' : ''), 'S');
    solo.title = 'Solo'; solo.onclick = e => { e.stopPropagation(); inst._solo = !inst._solo; renderTracks(); };
    const mute = el('button', 'st-mini' + (inst._mute ? ' on' : ''), 'M');
    mute.title = 'Mute'; mute.onclick = e => { e.stopPropagation(); inst._mute = !inst._mute; renderTracks(); };
    const more = el('button', 'st-mini more', '⋯');
    more.title = 'Track options'; more.onclick = e => { e.stopPropagation(); showTrackMenu(inst, more); };
    ctrls.appendChild(solo); ctrls.appendChild(mute); ctrls.appendChild(more);
    row.appendChild(ctrls);
    host.appendChild(row);
  });
  const add = el('button', 'st-addtrack', '＋ Add Track');
  add.onclick = showAddTrackMenu;
  host.appendChild(add);
}

/* ---- right-click / context menus --------------------------------------- */
function showCtxMenu(items, x, y) {
  document.getElementById('st-ctxmenu')?.remove();
  const m = el('div', 'st-addmenu'); m.id = 'st-ctxmenu';
  m.style.position = 'fixed'; m.style.left = Math.min(x, window.innerWidth - 170) + 'px'; m.style.top = Math.min(y, window.innerHeight - 30 - items.length * 30) + 'px'; m.style.bottom = 'auto'; m.style.zIndex = 9000;
  items.forEach(([lbl, fn]) => { const b = el('button', 'st-addmenu-opt', lbl); b.onclick = () => { m.remove(); fn(); }; m.appendChild(b); });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('pointerdown', function h(ev) { if (!ev.target.closest('#st-ctxmenu')) { m.remove(); document.removeEventListener('pointerdown', h); } }), 0);
}
function showTrackMenu(inst, anchor, ev) {
  const r = anchor.getBoundingClientRect();
  const x = ev ? ev.clientX : r.left, y = ev ? ev.clientY : r.bottom + 4;
  showCtxMenu([
    ['＋ Add clip', () => addClipAt(inst, Math.ceil(E.songLengthBars(project)))],
    ['⎘ Duplicate track', () => duplicateTrack(inst)],
    ['🗑 Delete track', () => deleteTrack(inst)],
  ], x, y);
}
function showClipMenu(inst, clip, ev) {
  showCtxMenu([
    ['✎ Edit pattern', () => selectClip(inst, clip)],
    ['⎘ Duplicate clip', () => duplicateClip(inst, clip)],
    ['❖ Make unique', () => makeClipUnique(inst, clip)],
    ['🗑 Delete clip', () => deleteClip(inst, clip)],
  ], ev.clientX, ev.clientY);
}
function duplicateClip(inst, clip) {
  const t = E.getTrack(project, inst.id); const len = clip.lenBars || 1;
  t.clips.push(E.makeClip(clip.patternId, clip.startBar + len, len)); // shares the pattern
  renderTimeline(); if (_playing) _events = E.expandArrangement(project);
}
function deleteClip(inst, clip) {
  const t = E.getTrack(project, inst.id); t.clips = t.clips.filter(c => c.id !== clip.id);
  renderTimeline(); if (_playing) _events = E.expandArrangement(project);
}
function duplicateTrack(inst) {
  const ni = E.makeInstrument(inst.type, inst.name + ' copy', JSON.parse(JSON.stringify(inst.params)));
  ni.fx = JSON.parse(JSON.stringify(inst.fx || E.defaultFx()));
  if (inst.sampleRef && project.samples[inst.sampleRef]) { project.samples[ni.id] = project.samples[inst.sampleRef]; ni.sampleRef = ni.id; }
  const at = project.instruments.indexOf(inst);
  project.instruments.splice(at + 1, 0, ni);
  const track = E.getTrack(project, inst.id);
  const map = {};
  const nt = E.ensureTrack(project, ni.id);
  (track ? track.clips : []).forEach(clip => {
    if (!map[clip.patternId]) {
      const op = E.getPattern(project, clip.patternId);
      const np = E.makePattern(op.name, op.bars); np.steps = op.steps.slice(); np.notes = op.notes.map(n => ({ ...n }));
      project.patterns.push(np); map[clip.patternId] = np.id;
    }
    nt.clips.push(E.makeClip(map[clip.patternId], clip.startBar, clip.lenBars));
  });
  _selInstId = ni.id;
  decodeAllSamples(); renderAll();
  if (_playing) _events = E.expandArrangement(project);
}
function deleteTrack(inst) {
  if (project.instruments.length <= 1) { toastSafe('Keep at least one track'); return; }
  if (inst._chain) { try { inst._chain.input.disconnect(); inst._chain.gain.disconnect(); } catch (_) {} inst._chain = null; }
  const track = E.getTrack(project, inst.id);
  const usedHere = new Set((track ? track.clips : []).map(c => c.patternId));
  project.instruments = project.instruments.filter(i => i.id !== inst.id);
  project.arrangement = project.arrangement.filter(t => t.instId !== inst.id);
  const stillUsed = new Set(); project.arrangement.forEach(t => t.clips.forEach(c => stillUsed.add(c.patternId)));
  project.patterns = project.patterns.filter(p => !(usedHere.has(p.id) && !stillUsed.has(p.id))); // drop orphaned patterns
  if (inst.sampleRef && project.samples[inst.sampleRef]) delete project.samples[inst.sampleRef];
  if (_selInstId === inst.id) _selInstId = project.instruments[0] ? project.instruments[0].id : null;
  renderAll();
  if (_playing) _events = E.expandArrangement(project);
}

function renderTimeline() {
  const ruler = document.getElementById('st-ruler');
  const lanes = document.getElementById('st-lanes');
  if (!ruler || !lanes) return;
  const bars = Math.max(8, Math.ceil(E.songLengthBars(project)) + 2);
  const width = bars * _pxPerBar;
  ruler.style.width = lanes.style.width = width + 'px';
  ruler.innerHTML = '';
  for (let b = 0; b < bars; b++) {
    const tick = el('div', 'st-bar-tick', `<span>${b + 1}</span>`);
    tick.style.left = (b * _pxPerBar) + 'px'; tick.style.width = _pxPerBar + 'px';
    ruler.appendChild(tick);
  }
  lanes.innerHTML = '';
  project.instruments.forEach(inst => {
    const lane = el('div', 'st-lane');
    lane.dataset.inst = inst.id;
    for (let b = 0; b < bars; b++) { const g = el('div', 'st-lane-grid'); g.style.left = (b * _pxPerBar) + 'px'; g.style.width = _pxPerBar + 'px'; lane.appendChild(g); }
    const track = E.getTrack(project, inst.id);
    (track ? track.clips : []).forEach(clip => lane.appendChild(buildClip(inst, clip)));
    // click empty lane → add a clip
    lane.addEventListener('dblclick', e => {
      if (e.target !== lane && !e.target.classList.contains('st-lane-grid')) return;
      const bar = Math.floor((e.offsetX) / _pxPerBar);
      addClipAt(inst, bar);
    });
    lane.addEventListener('contextmenu', e => {
      if (e.target !== lane && !e.target.classList.contains('st-lane-grid')) return; // clip has its own menu
      e.preventDefault();
      const bar = Math.floor(e.offsetX / _pxPerBar);
      showCtxMenu([['＋ Add clip here', () => addClipAt(inst, bar)]], e.clientX, e.clientY);
    });
    lanes.appendChild(lane);
  });
  const ph = el('div', '', ''); ph.id = 'st-playhead'; ph.className = 'st-playhead'; lanes.appendChild(ph);
}

function buildClip(inst, clip) {
  const pat = E.getPattern(project, clip.patternId);
  const lenBars = clip.lenBars || (pat ? pat.bars : 1);
  const c = el('div', 'st-clip' + (clip.id === _selClipId ? ' sel' : ''));
  c.style.left = (clip.startBar * _pxPerBar) + 'px';
  c.style.width = (lenBars * _pxPerBar - 2) + 'px';
  c.style.background = instColor(inst.id);
  c.innerHTML = `<span class="st-clip-name">${esc(pat ? pat.name : '?')}</span><i class="st-clip-resize"></i>`;
  c.onclick = e => { e.stopPropagation(); selectClip(inst, clip); };
  c.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); showClipMenu(inst, clip, e); };
  // drag to move / resize
  c.addEventListener('pointerdown', e => startClipDrag(e, inst, clip, c));
  return c;
}

function selectClip(inst, clip) {
  _selInstId = inst.id; _selClipId = clip.id; _selNotes.clear();
  renderAll();
}
let _clipDrag = null;
function startClipDrag(e, inst, clip, node) {
  e.preventDefault(); e.stopPropagation();
  if (_selClipId !== clip.id) { _selInstId = inst.id; _selClipId = clip.id; _selNotes.clear(); } // select on grab
  const resize = e.target.classList.contains('st-clip-resize');
  _clipDrag = { inst, clip, node, resize, x0: e.clientX, startBar0: clip.startBar, len0: clip.lenBars || 1 };
  node.setPointerCapture(e.pointerId);
  node.addEventListener('pointermove', onClipDrag);
  node.addEventListener('pointerup', endClipDrag);
}
function onClipDrag(e) {
  if (!_clipDrag) return;
  const dBar = Math.round((e.clientX - _clipDrag.x0) / _pxPerBar);
  if (_clipDrag.resize) {
    _clipDrag.clip.lenBars = Math.max(1, _clipDrag.len0 + dBar);
  } else {
    _clipDrag.clip.startBar = Math.max(0, _clipDrag.startBar0 + dBar);
  }
  const lenBars = _clipDrag.clip.lenBars || 1;
  _clipDrag.node.style.left = (_clipDrag.clip.startBar * _pxPerBar) + 'px';
  _clipDrag.node.style.width = (lenBars * _pxPerBar - 2) + 'px';
}
function endClipDrag(e) {
  if (!_clipDrag) return;
  try { _clipDrag.node.releasePointerCapture(e.pointerId); } catch (_) {}
  _clipDrag.node.removeEventListener('pointermove', onClipDrag);
  _clipDrag.node.removeEventListener('pointerup', endClipDrag);
  _clipDrag = null;
  renderAll(); // refresh editor too (selection / length may have changed)
  if (_playing) { _events = E.expandArrangement(project); }
}

function addClipAt(inst, bar) {
  // each new clip gets its OWN fresh pattern, so a track can hold several
  // distinct patterns (use the clip menu's "Duplicate" to repeat one).
  const pat = E.makePattern(inst.name, 1); project.patterns.push(pat);
  const clip = E.makeClip(pat.id, Math.max(0, bar), pat.bars);
  E.ensureTrack(project, inst.id).clips.push(clip);
  _selInstId = inst.id; _selClipId = clip.id; _selNotes.clear();
  renderAll();
  if (_playing) _events = E.expandArrangement(project);
}
// Clone the selected clip's pattern so edits no longer affect its siblings.
function makeClipUnique(inst, clip) {
  const op = E.getPattern(project, clip.patternId); if (!op) return;
  const np = E.makePattern(op.name, op.bars); np.steps = op.steps.slice(); np.notes = op.notes.map(n => ({ ...n }));
  project.patterns.push(np); clip.patternId = np.id;
  renderAll(); if (_playing) _events = E.expandArrangement(project);
  toastSafe('Pattern is now unique to this clip');
}

/* ---- pattern editor (step grid for drums, piano-roll for melodic) ------ */
// The editor edits the SELECTED clip's pattern (falling back to the selected
// track's first clip), so different clips on a track edit different patterns.
function selectedClip() {
  const t = _selInstId && E.getTrack(project, _selInstId);
  if (!t || !t.clips.length) return null;
  return t.clips.find(c => c.id === _selClipId) || t.clips[0];
}
function selectedPattern() {
  const c = selectedClip();
  return c ? E.getPattern(project, c.patternId) : null;
}
// Grow/shrink a pattern's bar length (preserving existing steps/notes in range).
function setPatternBars(pat, bars) {
  bars = Math.max(1, Math.min(8, bars | 0));
  if (bars === pat.bars) return;
  const oldBars = pat.bars;
  const n = bars * E.STEPS_PER_BAR;
  const steps = new Array(n).fill(0);
  for (let i = 0; i < Math.min(n, pat.steps.length); i++) steps[i] = pat.steps[i];
  pat.steps = steps;
  pat.notes = pat.notes.filter(no => no.start < n);
  pat.bars = bars;
  // Keep clips that were 1:1 with this pattern in sync, so the colored block in
  // the arrangement grows/shrinks with the pattern (clips that were intentionally
  // looped to a different length are left alone).
  project.arrangement.forEach(t => (t.clips || []).forEach(c => {
    if (c.patternId === pat.id && (c.lenBars == null || c.lenBars === oldBars)) c.lenBars = bars;
  }));
  renderEditor(); renderTimeline(); if (_playing) _events = E.expandArrangement(project);
}
function renderEditor() {
  const host = document.getElementById('st-editor'); if (!host) return;
  const prevRoll = host.querySelector('.st-roll');       // capture scroll before clearing
  const prevScroll = prevRoll ? { t: prevRoll.scrollTop, l: prevRoll.scrollLeft } : null;
  host.innerHTML = '';
  const inst = project.instruments.find(i => i.id === _selInstId);
  const pat = selectedPattern();
  if (!inst || !pat) { host.appendChild(el('div', 'st-editor-empty', 'Select a track to edit its pattern')); return; }
  const head = el('div', 'st-editor-head');
  head.innerHTML = `<b style="color:${instColor(inst.id)}">${esc(inst.name)}</b> · <span class="st-dim">${esc(pat.name)}</span>`;
  // pattern length stepper
  const len = el('div', 'st-bars');
  len.append(el('button', 'st-bars-btn', '−'), el('span', 'st-bars-n', pat.bars + ' bar' + (pat.bars > 1 ? 's' : '')), el('button', 'st-bars-btn', '＋'));
  len.children[0].onclick = () => setPatternBars(pat, pat.bars - 1);
  len.children[2].onclick = () => setPatternBars(pat, pat.bars + 1);
  head.appendChild(len);
  if (inst.type !== 'drum') {
    const tools = el('div', 'st-rolltools');
    const mk = (id, label, title) => { const b = el('button', 'st-rolltool' + (_rollTool === id ? ' on' : ''), label); b.title = title; b.onclick = () => { _rollTool = id; renderEditor(); }; return b; };
    tools.append(mk('draw', '✎ Draw', 'Pencil: click/drag to add notes'), mk('select', '⬚ Select', 'Marquee: drag a box to select notes'));
    head.appendChild(tools);
  }
  head.appendChild(randomizeControls(inst, pat));
  host.appendChild(head);
  if (inst.type !== 'drum') host.appendChild(deviceStrip(inst));
  host.appendChild(inst.type === 'drum' ? buildStepGrid(inst, pat) : buildPianoRoll(inst, pat));
  // preserve piano-roll scroll across re-renders (or center on ~C4 the first time)
  const roll = host.querySelector('.st-roll');
  if (roll) {
    if (prevScroll) { roll.scrollTop = prevScroll.t; roll.scrollLeft = prevScroll.l; }
    else roll.scrollTop = Math.max(0, (rollTopMidi() - 60) * ROLL.ROW_H - 120); // center ~C4
  }
}

// 🎲 randomizer controls (scale/key for melodic, genre for drums).
function randomizeControls(inst, pat) {
  const g = el('div', 'st-rnd');
  const mkSel = (vals, cur, set) => { const s = el('select', 'st-rnd-sel'); vals.forEach(v => { const o = document.createElement('option'); o.value = o.textContent = v; if (v === cur) o.selected = true; s.appendChild(o); }); s.onchange = () => set(s.value); return s; };
  const P = inst.params;
  if (inst.type === 'drum') {
    g.appendChild(mkSel(E.RND_GENRES, P.rndGenre || 'straight', v => P.rndGenre = v));
  } else {
    g.appendChild(mkSel(Object.keys({ C: 0, 'C#': 0, D: 0, 'D#': 0, E: 0, F: 0, 'F#': 0, G: 0, 'G#': 0, A: 0, 'A#': 0, B: 0 }), P.rndKey || 'C', v => P.rndKey = v));
    g.appendChild(mkSel(E.RND_SCALES, P.rndScale || 'pentatonic', v => P.rndScale = v));
  }
  const dice = el('button', 'st-rnd-btn', '🎲');
  dice.title = 'Randomize this pattern';
  dice.onclick = () => {
    if (inst.type === 'drum') pat.steps = E.randomDrumPattern({ voice: P.voice || 'kick', genre: P.rndGenre || 'straight', bars: pat.bars });
    else pat.notes = E.randomMelody({ scale: P.rndScale || 'pentatonic', key: P.rndKey || 'C', bars: pat.bars, lo: EDITOR_LO + 2, hi: EDITOR_LO + 24 });
    renderEditor();
    if (_playing) _events = E.expandArrangement(project);
  };
  g.appendChild(dice);
  return g;
}

// A small labelled rotary knob backed by bindKnob.
function knobCell(label, get, set, opts = {}) {
  const cell = el('div', 'st-kcell');
  const k = el('div', 'st-knob sm');
  bindKnob(k, get, set, opts);
  cell.appendChild(k); cell.appendChild(el('div', 'st-klabel', label));
  return cell;
}
// Per-track "device": sound selector + synth knobs (ADSR, filter, drive, FX sends, mix).
function deviceStrip(inst) {
  const wrap = el('div', 'st-device');
  const P = inst.params, F = inst.fx || (inst.fx = E.defaultFx());
  const live = () => applyChainParams(inst);
  // sound selector
  const top = el('div', 'st-device-top');
  if (inst.type === 'chip' || inst.type === 'keys') {
    const ps = el('select', 'st-rnd-sel');
    const ph = document.createElement('option'); ph.textContent = '✦ Preset…'; ph.value = ''; ps.appendChild(ph);
    PRESETS.filter(pr => pr.type === inst.type).forEach(pr => { const o = document.createElement('option'); o.value = pr.name; o.textContent = pr.name; ps.appendChild(o); });
    ps.onchange = () => { const pr = PRESETS.find(x => x.name === ps.value); if (pr) applyPreset(inst, pr); };
    top.appendChild(ps);
  }
  if (inst.type === 'chip') {
    const sel = el('select', 'st-wave');
    CHIP_WAVES.forEach(w => { const o = document.createElement('option'); o.value = w; o.textContent = w; if ((P.wave || 'pulse') === w) o.selected = true; sel.appendChild(o); });
    sel.onchange = () => { P.wave = sel.value; }; top.appendChild(sel);
  } else if (inst.type === 'keys') {
    const sel = el('select', 'st-wave');
    ['toypiano', 'organ', 'casio'].forEach(w => { const o = document.createElement('option'); o.value = w; o.textContent = w; if ((P.preset || 'toypiano') === w) o.selected = true; sel.appendChild(o); });
    sel.onchange = () => { P.preset = sel.value; }; top.appendChild(sel);
  } else if (inst.type === 'sampler') {
    const b = el('button', 'st-wave', '🎙️ ' + (P.sampleName ? esc(P.sampleName).slice(0, 16) : 'Load sample'));
    b.onclick = () => loadSampleFor(inst); top.appendChild(b);
  } else if (inst.type === 'sf2') {
    const names = P.presetNames || [];
    top.appendChild(el('span', 'st-dim', '🎵 SF2'));
    const sel = el('select', 'st-sf2-sel');
    sel.title = 'Choose an instrument (preset) from the SoundFont';
    if (!names.length) { const o = document.createElement('option'); o.textContent = '(import a .sf2)'; sel.appendChild(o); sel.disabled = true; }
    names.forEach((n, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = (i + 1) + '. ' + (n || ('Preset ' + i)).slice(0, 28); if ((P.presetIndex || 0) === i) o.selected = true; sel.appendChild(o); });
    sel.onchange = () => { P.presetIndex = parseInt(sel.value) || 0; if (window.actx) ensureSF2(inst, window.actx); renderAll(); if (_playing) _events = E.expandArrangement(project); };
    top.appendChild(sel);
    const rep = el('button', 'st-wave', '📂'); rep.title = 'Load a different .sf2 file'; rep.onclick = () => importSF2(inst); top.appendChild(rep);
  }
  wrap.appendChild(top);
  // knob bank
  const bank = el('div', 'st-knobs');
  bank.append(
    knobCell('ATK', () => P.a, v => P.a = v, { min: 0.001, max: 0.6, def: 0.006 }),
    knobCell('DEC', () => P.d, v => P.d = v, { min: 0, max: 0.8, def: 0.05 }),
    knobCell('SUS', () => P.s, v => P.s = v, { min: 0, max: 1, def: 0.6 }),
    knobCell('REL', () => P.r, v => P.r = v, { min: 0.02, max: 2, def: 0.15 }),
    knobCell('CUT', () => P.cut, v => P.cut = v, { min: 200, max: 12000, def: 12000 }),
    knobCell('RES', () => P.res, v => P.res = v, { min: 0.5, max: 18, def: 1 }),
    knobCell('F.ENV', () => P.fenv, v => P.fenv = v, { min: 0, max: 1, def: 0 }),
    knobCell('DRIVE', () => F.drive, v => { F.drive = v; live(); }, { min: 0, max: 1, def: 0 }),
    knobCell('VERB', () => F.reverb, v => { F.reverb = v; live(); }, { min: 0, max: 1, def: 0 }),
    knobCell('DLY', () => F.delay, v => { F.delay = v; live(); }, { min: 0, max: 1, def: 0 }),
    knobCell('CHOR', () => F.chorus, v => { F.chorus = v; live(); }, { min: 0, max: 1, def: 0 }),
    knobCell('PAN', () => F.pan, v => { F.pan = v; live(); }, { min: -1, max: 1, def: 0 }),
    knobCell('LVL', () => F.level, v => { F.level = v; live(); }, { min: 0, max: 1.2, def: 0.9 }),
  );
  wrap.appendChild(bank);
  wrap.appendChild(buildMiniKeysSection()); // collapsible on-screen keyboard (plays + records)
  return wrap;
}

// On-screen keyboard wrapped with a collapse toggle (state persisted)
function buildMiniKeysSection() {
  const sec = el('div', 'st-mk-wrap');
  const collapsed = localStorage.getItem('aq_studio_keys_collapsed') === '1';
  if (collapsed) sec.classList.add('collapsed');
  const bar = el('div', 'st-mk-bar');
  const btn = el('button', 'st-mk-toggle', (collapsed ? '▸' : '▾') + ' KEYS');
  btn.onclick = () => {
    const c = sec.classList.toggle('collapsed');
    localStorage.setItem('aq_studio_keys_collapsed', c ? '1' : '0');
    btn.textContent = (c ? '▸' : '▾') + ' KEYS';
  };
  bar.appendChild(btn);
  sec.appendChild(bar);
  sec.appendChild(buildMiniKeys());
  return sec;
}

function buildStepGrid(inst, pat) {
  const grid = el('div', 'st-stepgrid');
  const steps = pat.bars * E.STEPS_PER_BAR;
  grid.style.gridTemplateColumns = `repeat(${steps}, 1fr)`;
  for (let s = 0; s < steps; s++) {
    const cell = el('button', 'st-step' + (pat.steps[s] ? ' on' : '') + (s % 4 === 0 ? ' beat' : ''));
    cell.style.setProperty('--c', instColor(inst.id));
    cell.onclick = () => { pat.steps[s] = pat.steps[s] ? 0 : 1; cell.classList.toggle('on', !!pat.steps[s]); if (pat.steps[s]) triggerEvent({ instId: inst.id, midi: inst.params.drumMidi || 36, durSec: 0.1, vel: 0.9 }, actx().currentTime); if (_playing) _events = E.expandArrangement(project); };
    grid.appendChild(cell);
  }
  return grid;
}

function audition(inst, midi, dur = 0.3) {
  const c = actx(), dest = getLiveChain(inst).input;
  if (inst.type === 'keys') keysVoice(c, dest, midi, c.currentTime, dur, 0.9, inst.params);
  else if (inst.type === 'sampler') samplerVoice(c, dest, midi, c.currentTime, dur, 0.9, inst);
  else if (inst.type === 'sf2') sf2Voice(c, dest, midi, c.currentTime, dur, 0.9, inst);
  else chipVoice(c, dest, midi, c.currentTime, dur, 0.9, inst.params);
}
/* ---- live recording (on-screen keys + computer keys + Web MIDI) -------- */
function curStep() {
  const c = actx(); const songT = c.currentTime - _loopBase;
  return songT < 0 ? 0 : Math.round(songT / E.secPerStep(project.bpm));
}
function qStep(step) { return Math.round(step / _quantize) * _quantize; }
function noteOn(midi, vel = 0.9) {
  const inst = project.instruments.find(i => i.id === _selInstId); if (!inst) return;
  audition(inst, midi, 0.5);
  if (!_recording || !_playing) return;
  const pat = selectedPattern(); if (!pat) return;
  const patSteps = pat.bars * E.STEPS_PER_BAR;
  const g = curStep();
  if (inst.type === 'drum') {
    const step = ((qStep(g) % patSteps) + patSteps) % patSteps;
    pat.steps[step] = 1; _events = E.expandArrangement(project); renderEditor();
  } else {
    const step = ((qStep(g) % patSteps) + patSteps) % patSteps;
    _pending[midi] = { step, g: qStep(g) };
  }
}
function noteOff(midi) {
  const p = _pending[midi]; if (!p) return; delete _pending[midi];
  const inst = project.instruments.find(i => i.id === _selInstId); if (!inst) return;
  const pat = selectedPattern(); if (!pat) return;
  const patSteps = pat.bars * E.STEPS_PER_BAR;
  let len = qStep(curStep()) - p.g; if (len < 1) len = _quantize; len = Math.max(1, Math.min(patSteps, len));
  if (!pat.notes.some(n => n.midi === midi && n.start === p.step)) pat.notes.push({ midi, start: p.step, len, vel: 0.85 });
  _events = E.expandArrangement(project);
  if (_selInstId === inst.id) renderEditor();
}
const KB_W = { a: 0, s: 2, d: 4, f: 5, g: 7, h: 9, j: 11, k: 12, l: 14 };
const KB_B = { w: 1, e: 3, t: 6, y: 8, u: 10, o: 13 };
let _inputBound = false;
function setupInput() {
  if (_inputBound) return; _inputBound = true;
  const open = () => document.getElementById('studio-win')?.classList.contains('open');
  document.addEventListener('keydown', e => {
    if (!open() || e.repeat) return;
    if (window.aqIsActiveApp && !window.aqIsActiveApp('studio')) return;   // another window owns the keys
    if (e.target && e.target.closest && e.target.closest('input,select,textarea')) return;
    const key = (e.key || '').toLowerCase();
    // command shortcuts with modifiers (don't trigger notes)
    if (e.ctrlKey || e.metaKey || e.altKey) {
      const inst = project.instruments.find(i => i.id === _selInstId);
      if (key === 'd' && inst) { e.preventDefault(); duplicateTrack(inst); }
      return;
    }
    // single-key commands (these letters are not in the note map)
    switch (key) {
      case ' ': e.preventDefault(); togglePlay(); return;
      case 'delete': case 'backspace': if (deleteSelectedNotes()) e.preventDefault(); return;
      case 'r': e.preventDefault(); document.getElementById('st-rec')?.click(); return;
      case 'q': e.preventDefault(); cycleQuant(); return;
      case '[': e.preventDefault(); zoomBy(-1); return;
      case ']': e.preventDefault(); zoomBy(1); return;
      case ',': e.preventDefault(); setBpm(project.bpm - 1); return;
      case '.': e.preventDefault(); setBpm(project.bpm + 1); return;
      case '/': e.preventDefault(); toastSafe('Keys: Space play · R rec · Q quantize · [ ] zoom · , . tempo · Z/X octave · ⌘D dup track · A–L/W–O notes'); return;
      case 'z': _recOct = Math.max(0, _recOct - 1); return;
      case 'x': _recOct = Math.min(7, _recOct + 1); return;
    }
    const semi = key in KB_W ? KB_W[key] : (key in KB_B ? KB_B[key] : null);
    if (semi == null || _heldKeys[key]) return;
    _heldKeys[key] = true; e.preventDefault();
    noteOn((_recOct + 1) * 12 + semi, 0.9);
  });
  document.addEventListener('keyup', e => {
    const key = e.key.toLowerCase();
    const semi = key in KB_W ? KB_W[key] : (key in KB_B ? KB_B[key] : null);
    if (semi == null) return; delete _heldKeys[key];
    noteOff((_recOct + 1) * 12 + semi);
  });
  // Web MIDI input (hardware keyboards)
  if (navigator.requestMIDIAccess) {
    navigator.requestMIDIAccess().then(acc => {
      const hook = inp => { inp.onmidimessage = onMIDI; };
      acc.inputs.forEach(hook);
      acc.onstatechange = ev => { if (ev.port && ev.port.type === 'input' && ev.port.state === 'connected') hook(ev.port); };
    }).catch(() => {});
  }
}
function onMIDI(e) {
  const [status, note, vel] = e.data; const cmd = status & 0xf0;
  if (cmd === 0x90 && vel > 0) noteOn(note, vel / 127);
  else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) noteOff(note);
}
// compact 2-octave on-screen keyboard (device panel)
function bindMiniKey(node, midi) {
  node.addEventListener('pointerdown', e => { e.preventDefault(); node.classList.add('on'); noteOn(midi, 0.9); try { node.setPointerCapture(e.pointerId); } catch (_) {} });
  const up = () => { node.classList.remove('on'); noteOff(midi); };
  node.addEventListener('pointerup', up);
  node.addEventListener('pointerleave', e => { if (e.buttons) up(); });
}
function buildMiniKeys() {
  const wrap = el('div', 'st-mk');
  const whiteSemis = [0, 2, 4, 5, 7, 9, 11], blackAfter = { 0: 1, 1: 3, 3: 6, 4: 8, 5: 10 };
  const octs = 2, W = octs * 7;
  for (let o = 0; o < octs; o++) for (let wi = 0; wi < 7; wi++) {
    const i = o * 7 + wi, midi = (_recOct + 1 + o) * 12 + whiteSemis[wi];
    const k = el('div', 'st-mk-w'); k.style.left = (i / W * 100) + '%'; k.style.width = (100 / W) + '%';
    bindMiniKey(k, midi); wrap.appendChild(k);
  }
  for (let o = 0; o < octs; o++) for (let wi = 0; wi < 7; wi++) {
    if (!(wi in blackAfter)) continue;
    const i = o * 7 + wi, midi = (_recOct + 1 + o) * 12 + blackAfter[wi];
    const bk = el('div', 'st-mk-b'); bk.style.left = ((i + 1) / W * 100 - (100 / W) * 0.3) + '%'; bk.style.width = (100 / W * 0.6) + '%';
    bindMiniKey(bk, midi); wrap.appendChild(bk);
  }
  return wrap;
}

/* ---- piano roll (DAW-style: draw / move / resize / marquee-select) ------ */
const ROLL = { STEP_W: 22, ROW_H: 14, ROWS: 37 }; // 37 rows ≈ 3 octaves from EDITOR_LO
function rollTopMidi() { return EDITOR_LO + ROLL.ROWS - 1; }
const _isBlack = midi => [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);

function buildPianoRoll(inst, pat) {
  const steps = pat.bars * E.STEPS_PER_BAR, top = rollTopMidi();
  const wrap = el('div', 'st-roll');
  const keys = el('div', 'st-roll-keys');
  for (let r = 0; r < ROLL.ROWS; r++) {
    const midi = top - r;
    const k = el('div', 'st-roll-key' + (_isBlack(midi) ? ' black' : ''), E.midiToName(midi));
    k.onclick = () => audition(inst, midi, 0.28);
    keys.appendChild(k);
  }
  const grid = el('div', 'st-roll-grid');
  grid.style.width = (steps * ROLL.STEP_W) + 'px';
  grid.style.height = (ROLL.ROWS * ROLL.ROW_H) + 'px';
  // background: black-key row shading + octave lines + bar/beat verticals
  for (let r = 0; r < ROLL.ROWS; r++) {
    const midi = top - r;
    if (_isBlack(midi)) { const rb = el('div', 'st-roll-rowbg'); rb.style.top = (r * ROLL.ROW_H) + 'px'; rb.style.height = ROLL.ROW_H + 'px'; grid.appendChild(rb); }
    if (((midi % 12) + 12) % 12 === 0) { const ol = el('div', 'st-roll-octline'); ol.style.top = (r * ROLL.ROW_H) + 'px'; grid.appendChild(ol); }
  }
  for (let s = 0; s <= steps; s++) {
    const ln = el('div', 'st-roll-vline' + (s % E.STEPS_PER_BAR === 0 ? ' bar' : (s % 4 === 0 ? ' beat' : '')));
    ln.style.left = (s * ROLL.STEP_W) + 'px'; grid.appendChild(ln);
  }
  pat.notes.forEach(n => grid.appendChild(buildNote(inst, n, top)));
  grid.addEventListener('pointerdown', e => onRollDown(e, inst, pat, grid, top));
  // right-edge handle: drag to grow/shrink the pattern's bar length
  const rs = el('div', 'st-roll-rs');
  rs.title = 'Drag to change pattern length';
  rs.addEventListener('pointerdown', e => startRollResize(e, pat, grid));
  grid.appendChild(rs);
  // playhead (mirrors the arrangement board's), positioned during playback
  const ph = el('div', 'st-roll-ph'); ph.id = 'st-roll-ph'; ph.style.display = 'none';
  grid.appendChild(ph);
  wrap.appendChild(keys); wrap.appendChild(grid);
  return wrap;
}
function buildNote(inst, n, top) {
  const b = el('div', 'st-note' + (_selNotes.has(n) ? ' sel' : ''));
  b.style.left = (n.start * ROLL.STEP_W) + 'px';
  b.style.top = ((top - n.midi) * ROLL.ROW_H) + 'px';
  b.style.width = Math.max(6, n.len * ROLL.STEP_W - 1) + 'px';
  b.style.height = (ROLL.ROW_H - 1) + 'px';
  b.style.background = instColor(inst.id);
  b._note = n;
  b.appendChild(el('i', 'st-note-rs'));
  b.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); deleteNote(n); };
  return b;
}
function deleteNote(n) {
  const pat = selectedPattern(); if (!pat) return;
  const i = pat.notes.indexOf(n); if (i >= 0) pat.notes.splice(i, 1);
  _selNotes.delete(n); renderEditor(); if (_playing) _events = E.expandArrangement(project);
}
function deleteSelectedNotes() {
  if (!_selNotes.size) return false;
  const pat = selectedPattern(); if (!pat) return false;
  pat.notes = pat.notes.filter(n => !_selNotes.has(n));
  _selNotes.clear(); renderEditor(); if (_playing) _events = E.expandArrangement(project);
  return true;
}
function rollXY(e, grid) { const r = grid.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function snapStep(step) { const q = _quantize || 1; return Math.max(0, Math.round(step / q) * q); }
function refreshNotePositions(grid, top) {
  grid.querySelectorAll('.st-note').forEach(eln => { const n = eln._note; if (!n) return;
    eln.style.left = (n.start * ROLL.STEP_W) + 'px'; eln.style.top = ((top - n.midi) * ROLL.ROW_H) + 'px';
    eln.style.width = Math.max(6, n.len * ROLL.STEP_W - 1) + 'px'; });
}
function rollDrag(grid, e, onMove, onUp) {
  try { grid.setPointerCapture(e.pointerId); } catch (_) {}
  const mv = ev => onMove(ev);
  const up = ev => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); try { grid.releasePointerCapture(ev.pointerId); } catch (_) {} onUp && onUp(ev); };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
}
// Drag the piano roll's right edge to grow/shrink the pattern's bar length.
function startRollResize(e, pat, grid) {
  e.preventDefault(); e.stopPropagation();
  const x0 = e.clientX, bars0 = pat.bars;
  let target = bars0;
  rollDrag(grid, e, ev => {
    const dBar = Math.round((ev.clientX - x0) / (ROLL.STEP_W * E.STEPS_PER_BAR));
    target = Math.max(1, Math.min(8, bars0 + dBar));
    grid.style.width = (target * E.STEPS_PER_BAR * ROLL.STEP_W) + 'px'; // live preview
  }, () => {
    if (target !== bars0) setPatternBars(pat, target); // rebuilds roll + syncs clips
    else renderEditor();                                // restore preview width
  });
}
function onRollDown(e, inst, pat, grid, top) {
  e.preventDefault();
  const steps = pat.bars * E.STEPS_PER_BAR;
  const noteEl = e.target.closest('.st-note');
  const { x, y } = rollXY(e, grid);
  if (noteEl && noteEl._note) {
    const n = noteEl._note;
    if (e.shiftKey) { _selNotes.has(n) ? _selNotes.delete(n) : _selNotes.add(n); renderEditor(); return; }
    if (!_selNotes.has(n)) { _selNotes.clear(); _selNotes.add(n); }
    grid.querySelectorAll('.st-note').forEach(el2 => el2.classList.toggle('sel', _selNotes.has(el2._note)));
    const handle = e.target.classList.contains('st-note-rs') || (x - (n.start + n.len) * ROLL.STEP_W) > -7;
    if (handle) startNoteResize(e, grid, n);
    else startNoteMove(e, grid, n, top);
    return;
  }
  if (_rollTool === 'draw') {
    const start = Math.min(snapStep(Math.floor(x / ROLL.STEP_W)), steps - 1);
    const midi = Math.max(EDITOR_LO, Math.min(top, top - Math.floor(y / ROLL.ROW_H)));
    const n = { midi, start, len: Math.max(1, _quantize), vel: 0.85 };
    pat.notes.push(n); _selNotes.clear(); _selNotes.add(n);
    grid.appendChild(buildNote(inst, n, top));
    audition(inst, midi, 0.28);
    if (_playing) _events = E.expandArrangement(project);
    startNoteResize(e, grid, n);             // drag right to set length
  } else {
    startMarquee(e, inst, pat, grid, top);
  }
}
function startNoteMove(e, grid, n, top) {
  const x0 = e.clientX, y0 = e.clientY;
  const sel = _selNotes.has(n) ? [..._selNotes] : [n];
  const base = sel.map(o => ({ o, start: o.start, midi: o.midi }));
  const pat = selectedPattern(); const steps = pat ? pat.bars * E.STEPS_PER_BAR : 64;
  const q = _quantize || 1;
  rollDrag(grid, e, ev => {
    const dStep = q * Math.round(((ev.clientX - x0) / ROLL.STEP_W) / q);
    const dRow = Math.round((ev.clientY - y0) / ROLL.ROW_H);
    for (const b of base) {
      b.o.start = Math.max(0, Math.min(steps - 1, b.start + dStep));
      b.o.midi = Math.max(EDITOR_LO, Math.min(rollTopMidi(), b.midi - dRow));
    }
    refreshNotePositions(grid, top);
  }, () => { renderEditor(); if (_playing) _events = E.expandArrangement(project); });
}
function startNoteResize(e, grid, n) {
  const x0 = e.clientX, len0 = n.len, q = _quantize || 1;
  rollDrag(grid, e, ev => {
    const d = Math.round((ev.clientX - x0) / ROLL.STEP_W);
    n.len = Math.max(q, Math.round(Math.max(1, len0 + d) / q) * q);
    const eln = [...grid.querySelectorAll('.st-note')].find(el2 => el2._note === n);
    if (eln) eln.style.width = Math.max(6, n.len * ROLL.STEP_W - 1) + 'px';
  }, () => { renderEditor(); if (_playing) _events = E.expandArrangement(project); });
}
function startMarquee(e, inst, pat, grid, top) {
  const box = el('div', 'st-marquee'); grid.appendChild(box);
  const p0 = rollXY(e, grid);
  rollDrag(grid, e, ev => {
    const p = rollXY(ev, grid);
    box.style.left = Math.min(p.x, p0.x) + 'px'; box.style.top = Math.min(p.y, p0.y) + 'px';
    box.style.width = Math.abs(p.x - p0.x) + 'px'; box.style.height = Math.abs(p.y - p0.y) + 'px';
  }, ev => {
    const p = rollXY(ev, grid);
    const l = Math.min(p.x, p0.x), rgt = Math.max(p.x, p0.x), tp = Math.min(p.y, p0.y), bot = Math.max(p.y, p0.y);
    if (!ev.shiftKey) _selNotes.clear();
    for (const n of pat.notes) {
      const nl = n.start * ROLL.STEP_W, nr = (n.start + n.len) * ROLL.STEP_W, ntp = (top - n.midi) * ROLL.ROW_H, nbot = ntp + ROLL.ROW_H;
      if (nl < rgt && nr > l && ntp < bot && nbot > tp) _selNotes.add(n);
    }
    box.remove(); renderEditor();
  });
}

/* ---- add-track menu ----------------------------------------------------- */
function showAddTrackMenu() {
  const existing = document.getElementById('st-addmenu'); if (existing) { existing.remove(); return; }
  const menu = el('div', '', '');
  menu.id = 'st-addmenu'; menu.className = 'st-addmenu';
  const ico = pr => pr.type === 'keys' ? '🎹' : (pr.params.wave === 'noise' ? '📻' : '🎛️');
  const opts = [
    ...PRESETS.map(pr => [`${ico(pr)} ${pr.name}`, () => addInstrument(pr.type, pr.name, pr.params, pr.fx)]),
    ['🎙️ Sampler', () => addInstrument('sampler', 'Sampler', { baseNote: 60, oneShot: true })],
    ['🎵 SF2 SoundFont', () => importSF2()],
    ...DRUM_VOICES.map(v => [`🥁 ${v}`, () => addInstrument('drum', v[0].toUpperCase() + v.slice(1), { voice: v, drumMidi: 36 })]),
  ];
  opts.forEach(([label, fn]) => { const b = el('button', 'st-addmenu-opt', label); b.onclick = () => { fn(); menu.remove(); }; menu.appendChild(b); });
  document.getElementById('studio-win').appendChild(menu);
  setTimeout(() => document.addEventListener('pointerdown', function h(ev) { if (!ev.target.closest('#st-addmenu') && !ev.target.closest('.st-addtrack')) { menu.remove(); document.removeEventListener('pointerdown', h); } }), 0);
}
function addInstrument(type, name, params, fx) {
  const inst = E.makeInstrument(type, name, params);
  if (fx) Object.assign(inst.fx, fx);
  project.instruments.push(inst);
  const pat = E.makePattern(name, 1);
  if (type === 'drum') [0, 4, 8, 12].forEach(s => { if (params.voice === 'kick' || params.voice === 'snare') pat.steps[s] = params.voice === 'snare' ? (s % 8 === 4 ? 1 : 0) : 1; });
  project.patterns.push(pat);
  E.ensureTrack(project, inst.id).clips.push(E.makeClip(pat.id, 0, Math.max(1, Math.ceil(E.songLengthBars(project)) || 1)));
  _selInstId = inst.id;
  renderAll();
}

/* ---- transport UI / knobs ---------------------------------------------- */
function syncTransportUI() {
  const play = document.getElementById('st-play'); if (play) play.textContent = _playing ? '⏹' : '▶';
  const bpm = document.getElementById('st-bpm-val'); if (bpm) bpm.textContent = String(project.bpm).padStart(3, '0');
  const loop = document.getElementById('st-loop'); if (loop) loop.classList.toggle('on', _loop);
  const rec = document.getElementById('st-rec'); if (rec) rec.classList.toggle('on', _recording);
}
function setBpm(v) { project.bpm = Math.max(40, Math.min(240, Math.round(v))); syncTransportUI(); if (_playing) _events = E.expandArrangement(project); }
function zoomBy(dir) { _pxPerBar = Math.max(40, Math.min(220, _pxPerBar + dir * 24)); renderTimeline(); }
function cycleQuant() {
  const order = [4, 2, 1]; _quantize = order[(order.indexOf(_quantize) + 1) % order.length];
  const sel = document.getElementById('st-quant'); if (sel) sel.value = String(_quantize);
  toastSafe('Quantize: 1/' + (16 / _quantize));
}

function bindKnob(node, get, set, opts = {}) {
  const min = opts.min ?? 0, max = opts.max ?? 1, step = opts.step ?? (max - min) / 100;
  let drag = null;
  const render = () => { const v = get(); const ang = -135 + 270 * ((v - min) / (max - min)); node.style.setProperty('--ang', ang + 'deg'); };
  node.addEventListener('pointerdown', e => { drag = { y: e.clientY, v: get() }; node.setPointerCapture(e.pointerId); e.preventDefault(); });
  node.addEventListener('pointermove', e => { if (!drag) return; const dv = -(e.clientY - drag.y) * step * 2; set(Math.max(min, Math.min(max, drag.v + dv))); render(); });
  node.addEventListener('pointerup', e => { drag = null; try { node.releasePointerCapture(e.pointerId); } catch (_) {} });
  node.addEventListener('dblclick', () => { set(opts.def ?? (min + max) / 2); render(); });
  render();
}

/* ---- draggable divider between the arrangement board and the editor ----- */
function setupEditorSplit() {
  const split = document.getElementById('st-vsplit');
  const editor = document.getElementById('st-editor-wrap');
  if (!split || !editor) return;
  const saved = parseInt(localStorage.getItem('aq_studio_editor_h') || '0', 10);
  if (saved >= 120) editor.style.height = saved + 'px';
  if (split._splitInit) return;
  split._splitInit = true;
  split.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startY = e.clientY, startH = editor.getBoundingClientRect().height;
    const max = Math.round(window.innerHeight * 0.7);
    try { split.setPointerCapture(e.pointerId); } catch (_) {}
    const move = ev => {
      const h = Math.max(120, Math.min(max, startH + (startY - ev.clientY)));
      editor.style.height = h + 'px';
    };
    const up = ev => {
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      try { split.releasePointerCapture(ev.pointerId); } catch (_) {}
      localStorage.setItem('aq_studio_editor_h', String(Math.round(editor.getBoundingClientRect().height)));
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
}

/* ---- build the window once --------------------------------------------- */
function build() {
  if (_built) return; _built = true;
  if (!project) project = demoProject();
  const root = document.getElementById('studio-win'); if (!root) return;

  // transport handlers
  const playBtn = document.getElementById('st-play');
  if (playBtn) playBtn.onclick = togglePlay;
  const loopBtn = document.getElementById('st-loop');
  if (loopBtn) loopBtn.onclick = () => { _loop = !_loop; syncTransportUI(); };
  const recBtn = document.getElementById('st-rec');
  if (recBtn) recBtn.onclick = () => { _recording = !_recording; if (_recording && !_playing) play(); syncTransportUI(); };
  const quant = document.getElementById('st-quant');
  if (quant) quant.onchange = () => { _quantize = parseInt(quant.value) || 1; };
  setupInput();
  setupEditorSplit();
  // BPM: scrub vertically or click to type
  const bpmBox = document.getElementById('st-bpm');
  if (bpmBox) {
    let d = null;
    bpmBox.addEventListener('pointerdown', e => { d = { y: e.clientY, v: project.bpm }; bpmBox.setPointerCapture(e.pointerId); });
    bpmBox.addEventListener('pointermove', e => { if (!d) return; setBpm(d.v - Math.round((e.clientY - d.y) / 3)); });
    bpmBox.addEventListener('pointerup', e => { d = null; try { bpmBox.releasePointerCapture(e.pointerId); } catch (_) {} });
    bpmBox.addEventListener('dblclick', () => { const v = prompt('Tempo (BPM):', project.bpm); if (v) setBpm(parseInt(v) || project.bpm); });
  }
  const knob = document.getElementById('st-master-knob');
  if (knob) bindKnob(knob, () => project.master, v => { project.master = v; if (_master) _master.gain.value = v; }, { min: 0, max: 1, def: 0.9 });
  const zoomIn = document.getElementById('st-zoom-in'), zoomOut = document.getElementById('st-zoom-out');
  if (zoomIn) zoomIn.onclick = () => { _pxPerBar = Math.min(220, _pxPerBar + 24); renderTimeline(); };
  if (zoomOut) zoomOut.onclick = () => { _pxPerBar = Math.max(40, _pxPerBar - 24); renderTimeline(); };
  // IO toolbar
  const bind = (id, fn) => { const e = document.getElementById(id); if (e) e.onclick = fn; };
  bind('st-new', newProject);
  bind('st-save', saveProject); bind('st-open', loadProject);
  bind('st-export-midi', exportMIDIFile); bind('st-import-midi', importMIDIFile);
  bind('st-render-wav', renderWAV);

  // (keyboard shortcuts incl. Space are handled in setupInput, document-level)
  _selInstId = project.instruments[0] ? project.instruments[0].id : null;
  renderAll();
  decodeAllSamples();
}

/* ---- sample loading / decoding ----------------------------------------- */
function b64ToBuf(dataUrl) {
  const b64 = (dataUrl.split(',')[1]) || dataUrl; const bin = atob(b64);
  const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function fileToDataURL(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }); }

async function decodeAllSamples() {
  const c = actx();
  for (const inst of project.instruments) {
    if (inst.type === 'sampler' && inst.sampleRef && project.samples[inst.sampleRef] && !sampleBuffer(inst, c)) {
      try { inst._buf = await c.decodeAudioData(b64ToBuf(project.samples[inst.sampleRef]).slice(0)); } catch (_) {}
    } else if (inst.type === 'sf2' && inst.sampleRef && project.samples[inst.sampleRef]) {
      try { ensureSF2(inst, c); } catch (_) {}
    }
  }
  renderEditor();
}
function loadSampleFor(inst) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'audio/*';
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    try {
      const url = await fileToDataURL(f);
      const c = actx();
      inst._buf = await c.decodeAudioData(b64ToBuf(url).slice(0));
      inst.sampleRef = inst.id; project.samples[inst.id] = url; inst.params.sampleName = f.name;
      renderEditor(); toastSafe('🎙️ Sample: ' + f.name);
    } catch (_) { toastSafe('Could not load that audio'); }
  };
  input.click();
}

/* ---- IO: save/load projects, MIDI in/out, WAV render ------------------- */
function download(data, filename, mime) {
  const blob = new Blob([data], { type: mime || 'application/octet-stream' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
}
function pickFile(accept, asArrayBuffer, cb) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = accept;
  inp.onchange = () => { const f = inp.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => cb(r.result, f); asArrayBuffer ? r.readAsArrayBuffer(f) : r.readAsText(f); };
  inp.click();
}
function toastSafe(m) { if (typeof window.toast === 'function') window.toast(m); }
// Import a SoundFont. With `target` set, swap the SF2 on an existing track;
// otherwise create a new SF2 instrument.
function importSF2(target) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = '.sf2';
  input.onchange = async () => {
    const f = input.files[0]; if (!f) return;
    toastSafe('Loading ' + f.name + '…');
    try {
      const ab = await f.arrayBuffer();
      const parsed = E.parseSF2(ab);                          // validate before committing
      const url = await fileToDataURL(f);
      if (target && target.type === 'sf2') {
        if (target.sampleRef) delete project.samples[target.sampleRef];
        project.samples[target.id] = url; target.sampleRef = target.id;
        target._sf2 = { parsed, ctx: actx(), presetIndex: 0, zones: buildSF2Zones(parsed, 0, actx()) };
        target.params.presetIndex = 0; target.params.presetNames = parsed.presets.map(p => p.name);
        target.name = f.name.replace(/\.sf2$/i, '').slice(0, 18);
        _selInstId = target.id; renderAll();
        toastSafe('🎵 ' + target.name + ' · ' + parsed.presets.length + ' presets'); return;
      }
      const inst = E.makeInstrument('sf2', f.name.replace(/\.sf2$/i, '').slice(0, 18), { presetIndex: 0, a: 0.004, d: 0, s: 1, r: 0.25, cut: 12000, res: 1, fenv: 0 });
      project.samples[inst.id] = url; inst.sampleRef = inst.id;
      inst._sf2 = { parsed, ctx: actx(), presetIndex: 0, zones: buildSF2Zones(parsed, 0, actx()) };
      inst.params.presetNames = parsed.presets.map(p => p.name);
      project.instruments.push(inst);
      const pat = E.makePattern(inst.name, 1); project.patterns.push(pat);
      const clip = E.makeClip(pat.id, 0, Math.max(1, Math.ceil(E.songLengthBars(project)) || 1));
      E.ensureTrack(project, inst.id).clips.push(clip);
      _selInstId = inst.id; _selClipId = clip.id; renderAll();
      toastSafe('🎵 ' + inst.name + ' · ' + parsed.presets.length + ' presets');
    } catch (e) { toastSafe('SF2 load failed: ' + (e && e.message || e)); }
  };
  input.click();
}

// Start fresh with an empty project (no tracks). Add tracks with "＋ Add Track".
function newProject() {
  if (project && project.instruments.length && typeof confirm === 'function' && !confirm('Start a new empty project? Unsaved changes will be lost.')) return;
  stop();
  project = E.makeProject('Untitled');
  _selInstId = null; _selClipId = null; _selNotes.clear(); _events = null;
  renderAll();
  toastSafe('🆕 New empty project');
}
function saveProject() {
  const clean = JSON.parse(JSON.stringify(project, (k, v) => (k && k[0] === '_') ? undefined : v));
  download(JSON.stringify(clean), (project.name || 'project').replace(/\s+/g, '_') + '.aqs.json', 'application/json');
  toastSafe('🎛️ Project saved');
}
function loadProject() {
  pickFile('.json,application/json', false, (txt) => {
    try { const pj = JSON.parse(txt); if (!pj.instruments) throw 0; window.Studio.load(pj); toastSafe('🎛️ Project loaded'); }
    catch (_) { toastSafe('Not a valid project file'); }
  });
}
function exportMIDIFile() { download(E.exportMIDI(project), (project.name || 'song').replace(/\s+/g, '_') + '.mid', 'audio/midi'); toastSafe('🎼 MIDI exported'); }
function importMIDIFile() {
  pickFile('.mid,.midi,audio/midi', true, (buf) => {
    try { const pj = E.importMIDI(new Uint8Array(buf)); if (!pj.instruments.length) throw 0; window.Studio.load(pj); toastSafe('🎼 MIDI imported'); }
    catch (_) { toastSafe('MIDI import failed'); }
  });
}

// Offline drum synthesis (the live drum voices use the shared actx; render needs its own).
function offlineDrum(c, dest, voice, t) {
  const g = c.createGain(); g.connect(dest);
  if (voice === 'kick' || voice === 'tom') {
    const o = c.createOscillator(); const hi = voice === 'kick' ? 150 : 220, lo = voice === 'kick' ? 45 : 90;
    o.frequency.setValueAtTime(hi, t); o.frequency.exponentialRampToValueAtTime(lo, t + 0.12);
    g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g); o.start(t); o.stop(t + 0.26);
  } else if (voice === 'snare' || voice === 'clap') {
    const n = c.createBufferSource(); n.buffer = noiseBuf(c); const bp = c.createBiquadFilter(); bp.type = 'highpass'; bp.frequency.value = 1400;
    g.gain.setValueAtTime(0.6, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(bp); bp.connect(g); n.start(t); n.stop(t + 0.2);
  } else { // hats / cymbals / cowbell → bright short noise
    const n = c.createBufferSource(); n.buffer = noiseBuf(c); const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500;
    const dur = (voice === 'openhh' || voice === 'crash') ? 0.32 : 0.05;
    g.gain.setValueAtTime(0.35, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    n.connect(hp); hp.connect(g); n.start(t); n.stop(t + dur + 0.02);
  }
}
async function renderWAV() {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) { toastSafe('Offline render unsupported'); return; }
  const sr = 44100, dur = Math.max(2, E.songLengthSec(project) + 1.5);
  toastSafe('🌊 Rendering WAV…');
  const oc = new OAC(2, Math.ceil(sr * dur), sr);
  const m = oc.createGain(); m.gain.value = project.master ?? 0.9; m.connect(oc.destination);
  // pre-decode sampler audio + build SF2 zones into the offline context
  const offBuf = {}, offSF2 = {};
  for (const inst of project.instruments) {
    if (inst.type === 'sampler' && inst.sampleRef && project.samples[inst.sampleRef]) {
      try { offBuf[inst.id] = await oc.decodeAudioData(b64ToBuf(project.samples[inst.sampleRef]).slice(0)); } catch (_) {}
    } else if (inst.type === 'sf2' && inst.sampleRef && project.samples[inst.sampleRef]) {
      try { offSF2[inst.id] = buildSF2Zones(E.parseSF2(b64ToBuf(project.samples[inst.sampleRef])), inst.params.presetIndex || 0, oc); } catch (_) {}
    }
  }
  const buses = makeBuses(oc, m);              // P3 FX buses on the offline ctx
  const chains = {};
  const chainIn = inst => (chains[inst.id] || (chains[inst.id] = buildChain(oc, inst, m, buses))).input;
  const anySolo = project.instruments.some(i => i._solo);
  for (const ev of E.expandArrangement(project)) {
    const inst = project.instruments.find(i => i.id === ev.instId); if (!inst || inst._mute) continue;
    if (anySolo && !inst._solo) continue;
    const dest = chainIn(inst);
    if (inst.type === 'drum') offlineDrum(oc, dest, (inst.params && inst.params.voice) || 'kick', ev.timeSec);
    else if (inst.type === 'keys') keysVoice(oc, dest, ev.midi, ev.timeSec, ev.durSec, ev.vel, inst.params || {});
    else if (inst.type === 'sampler') { if (offBuf[inst.id]) samplerVoice(oc, dest, ev.midi, ev.timeSec, ev.durSec, ev.vel, inst, offBuf[inst.id]); }
    else if (inst.type === 'sf2') { if (offSF2[inst.id]) sf2Voice(oc, dest, ev.midi, ev.timeSec, ev.durSec, ev.vel, inst, offSF2[inst.id]); }
    else chipVoice(oc, dest, ev.midi, ev.timeSec, ev.durSec, ev.vel, inst.params || {});
  }
  try { const buf = await oc.startRendering(); download(E.encodeWAV(buf), (project.name || 'song').replace(/\s+/g, '_') + '.wav', 'audio/wav'); toastSafe('🌊 WAV downloaded'); }
  catch (_) { toastSafe('Render failed'); }
}

/* ---- public entry ------------------------------------------------------- */
window.openStudio = function () {
  const win = document.getElementById('studio-win'); if (!win) return;
  win.classList.add('open');
  if (window.OS && window.OS.register) { window.OS.register('studio'); window.OS.focus('studio'); }
  build();
  syncTransportUI();
  scopeStart();
};

/* ---- oscilloscope (master output waveform) ----------------------------- */
let _scope = null, _scopeRaf = null;
function scopeAnalyser() {
  const c = window.actx; if (!c) return null;
  if (!_scope || _scope.context !== c) { _scope = c.createAnalyser(); _scope.fftSize = 1024; try { master().connect(_scope); } catch (_) {} }
  return _scope;
}
function drawScope() {
  const cv = document.getElementById('st-scope'); if (!cv) return;
  const w = cv.width = cv.clientWidth || 220, h = cv.height = cv.clientHeight || 34;
  const ctx = cv.getContext('2d'); if (!ctx) return;
  ctx.fillStyle = '#0a0c10'; ctx.fillRect(0, 0, w, h);
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--st-accent') || '#36c5f0').trim() || '#36c5f0';
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.beginPath();
  const an = scopeAnalyser();
  if (an) {
    const buf = new Uint8Array(an.fftSize); an.getByteTimeDomainData(buf);
    for (let i = 0; i < w; i++) { const v = (buf[Math.floor(i / w * buf.length)] - 128) / 128; const y = h / 2 - v * (h / 2 - 2); i ? ctx.lineTo(i, y) : ctx.moveTo(i, y); }
  } else { ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); } // no audio context yet → flat line
  ctx.stroke();
}
function scopeTick() {
  const win = document.getElementById('studio-win');
  if (!win || !win.classList.contains('open')) { _scopeRaf = null; return; } // self-stop when closed
  drawScope();
  _scopeRaf = requestAnimationFrame(scopeTick);
}
function scopeStart() { if (!_scopeRaf) _scopeRaf = requestAnimationFrame(scopeTick); }
window.Studio = {
  play, stop, togglePlay, setBpm, saveProject, loadProject, exportMIDIFile, importMIDIFile, renderWAV,
  get project() { return project; },
  load(p) { stop(); project = p; project.samples = project.samples || {}; project.instruments.forEach(i => { i._buf = null; }); normalizeInstruments(); _selInstId = project.instruments[0] ? project.instruments[0].id : null; if (_master) _master.gain.value = project.master ?? 0.9; renderAll(); decodeAllSamples(); },
};

// minimal HTML escaper (the app's global esc may not be visible to modules)
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
