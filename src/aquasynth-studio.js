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
const LOOKAHEAD = 0.12, TICK_MS = 25;
const EDITOR_LO = 48; // C3 — piano-roll bottom note

let project = null;
let _master = null, _noiseBuf = null;
let _playing = false, _schedTimer = null, _rafId = null;
let _loopBase = 0, _evIdx = 0, _events = [], _songSec = 0;
let _loop = true;
let _pxPerBar = 96;            // timeline zoom
let _selInstId = null;         // selected track (drives the editor)
let _built = false;

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
  g.connect(dest);
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

function triggerEvent(ev, when) {
  const inst = project.instruments.find(i => i.id === ev.instId);
  if (!inst || inst._mute) return;
  const c = actx();
  if (inst.type === 'drum') {
    const fn = DRUM_FNS[(inst.params && inst.params.voice) || 'kick'];
    if (typeof window[fn] === 'function') { try { window[fn](when); return; } catch (_) {} }
    chipVoice(c, master(), ev.midi, when, ev.durSec, ev.vel, { wave: 'noise' });
  } else {
    chipVoice(c, master(), ev.midi, when, ev.durSec, ev.vel, inst.params || {});
  }
}

/* ---- transport / scheduler --------------------------------------------- */
function play() {
  if (_playing) return;
  const c = actx();
  _events = E.expandArrangement(project);
  _songSec = E.songLengthSec(project) || E.secPerBar(project.bpm) * 4;
  _evIdx = 0;
  _loopBase = c.currentTime + 0.08;
  _playing = true;
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
  const c = actx();
  let songT = c.currentTime - _loopBase;
  if (songT < 0) songT = 0;
  const bar = songT / E.secPerBar(project.bpm);
  const ph = document.getElementById('st-playhead');
  if (ph) ph.style.transform = `translateX(${bar * _pxPerBar}px)`;
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
    row.onclick = () => { _selInstId = inst.id; renderAll(); };
    const icon = inst.type === 'drum' ? '🥁' : (inst.params && inst.params.wave === 'noise' ? '📻' : '🎹');
    row.appendChild(el('div', 'st-tname', `<span>${icon}</span><b>${esc(inst.name)}</b>`));
    const ctrls = el('div', 'st-tctrls');
    const mute = el('button', 'st-mini' + (inst._mute ? ' on' : ''), 'M');
    mute.title = 'Mute'; mute.onclick = e => { e.stopPropagation(); inst._mute = !inst._mute; renderTracks(); };
    ctrls.appendChild(mute);
    row.appendChild(ctrls);
    host.appendChild(row);
  });
  const add = el('button', 'st-addtrack', '＋ Add Track');
  add.onclick = showAddTrackMenu;
  host.appendChild(add);
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
    lanes.appendChild(lane);
  });
  const ph = el('div', '', ''); ph.id = 'st-playhead'; ph.className = 'st-playhead'; lanes.appendChild(ph);
}

function buildClip(inst, clip) {
  const pat = E.getPattern(project, clip.patternId);
  const lenBars = clip.lenBars || (pat ? pat.bars : 1);
  const c = el('div', 'st-clip' + (inst.id === _selInstId ? ' sel' : ''));
  c.style.left = (clip.startBar * _pxPerBar) + 'px';
  c.style.width = (lenBars * _pxPerBar - 2) + 'px';
  c.style.background = instColor(inst.id);
  c.innerHTML = `<span class="st-clip-name">${esc(pat ? pat.name : '?')}</span><i class="st-clip-resize"></i>`;
  c.onclick = e => { e.stopPropagation(); _selInstId = inst.id; renderAll(); };
  // drag to move / resize
  c.addEventListener('pointerdown', e => startClipDrag(e, inst, clip, c));
  return c;
}

let _clipDrag = null;
function startClipDrag(e, inst, clip, node) {
  e.preventDefault(); e.stopPropagation();
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
  renderTimeline();
  if (_playing) { _events = E.expandArrangement(project); }
}

function addClipAt(inst, bar) {
  // reuse the instrument's first pattern, or make one
  let pat = project.patterns.find(p => (E.getTrack(project, inst.id)?.clips || []).some(c => c.patternId === p.id));
  if (!pat) { pat = E.makePattern(inst.name, 1); project.patterns.push(pat); }
  E.ensureTrack(project, inst.id).clips.push(E.makeClip(pat.id, Math.max(0, bar), pat.bars));
  renderTimeline();
}

/* ---- pattern editor (step grid for drums, piano-roll for melodic) ------ */
function selectedPattern() {
  if (!_selInstId) return null;
  const t = E.getTrack(project, _selInstId);
  if (!t || !t.clips.length) return null;
  return E.getPattern(project, t.clips[0].patternId);
}
function renderEditor() {
  const host = document.getElementById('st-editor'); if (!host) return;
  host.innerHTML = '';
  const inst = project.instruments.find(i => i.id === _selInstId);
  const pat = selectedPattern();
  if (!inst || !pat) { host.appendChild(el('div', 'st-editor-empty', 'Select a track to edit its pattern')); return; }
  const head = el('div', 'st-editor-head');
  head.innerHTML = `<b style="color:${instColor(inst.id)}">${esc(inst.name)}</b> · <span class="st-dim">${esc(pat.name)} · ${pat.bars} bar${pat.bars > 1 ? 's' : ''}</span>`;
  if (inst.type !== 'drum') {
    const sel = el('select', 'st-wave');
    CHIP_WAVES.forEach(w => { const o = document.createElement('option'); o.value = w; o.textContent = w; if ((inst.params.wave || 'pulse') === w) o.selected = true; sel.appendChild(o); });
    sel.onchange = () => { inst.params.wave = sel.value; };
    head.appendChild(sel);
  }
  host.appendChild(head);
  host.appendChild(inst.type === 'drum' ? buildStepGrid(inst, pat) : buildPianoRoll(inst, pat));
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

function buildPianoRoll(inst, pat) {
  const rows = 25; // ~2 octaves
  const steps = pat.bars * E.STEPS_PER_BAR;
  const wrap = el('div', 'st-roll');
  const keys = el('div', 'st-roll-keys');
  const grid = el('div', 'st-roll-grid');
  grid.style.gridTemplateColumns = `repeat(${steps}, 22px)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 14px)`;
  for (let r = 0; r < rows; r++) {
    const midi = EDITOR_LO + (rows - 1 - r);
    const isBlack = [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
    const k = el('div', 'st-roll-key' + (isBlack ? ' black' : ''), E.midiToName(midi));
    k.onclick = () => chipVoice(actx(), master(), midi, actx().currentTime, 0.25, 0.9, inst.params);
    keys.appendChild(k);
    for (let s = 0; s < steps; s++) {
      const has = pat.notes.find(n => n.midi === midi && n.start === s);
      const cell = el('div', 'st-roll-cell' + (isBlack ? ' black' : '') + (s % 4 === 0 ? ' beat' : '') + (has ? ' on' : ''));
      cell.style.setProperty('--c', instColor(inst.id));
      cell.onclick = () => {
        const i = pat.notes.findIndex(n => n.midi === midi && n.start === s);
        if (i >= 0) { pat.notes.splice(i, 1); cell.classList.remove('on'); }
        else { pat.notes.push({ midi, start: s, len: 2, vel: 0.85 }); cell.classList.add('on'); chipVoice(actx(), master(), midi, actx().currentTime, 0.25, 0.9, inst.params); }
        if (_playing) _events = E.expandArrangement(project);
      };
      grid.appendChild(cell);
    }
  }
  wrap.appendChild(keys); wrap.appendChild(grid);
  return wrap;
}

/* ---- add-track menu ----------------------------------------------------- */
function showAddTrackMenu() {
  const existing = document.getElementById('st-addmenu'); if (existing) { existing.remove(); return; }
  const menu = el('div', '', '');
  menu.id = 'st-addmenu'; menu.className = 'st-addmenu';
  const opts = [
    ['🎹 Chip Lead', () => addInstrument('chip', 'Chip Lead', { wave: 'pulse', vibrato: true })],
    ['🔊 Chip Bass', () => addInstrument('chip', 'Chip Bass', { wave: 'triangle' })],
    ['📻 Noise', () => addInstrument('chip', 'Noise', { wave: 'noise' })],
    ...DRUM_VOICES.map(v => [`🥁 ${v}`, () => addInstrument('drum', v[0].toUpperCase() + v.slice(1), { voice: v, drumMidi: 36 })]),
  ];
  opts.forEach(([label, fn]) => { const b = el('button', 'st-addmenu-opt', label); b.onclick = () => { fn(); menu.remove(); }; menu.appendChild(b); });
  document.getElementById('studio-win').appendChild(menu);
  setTimeout(() => document.addEventListener('pointerdown', function h(ev) { if (!ev.target.closest('#st-addmenu') && !ev.target.closest('.st-addtrack')) { menu.remove(); document.removeEventListener('pointerdown', h); } }), 0);
}
function addInstrument(type, name, params) {
  const inst = E.makeInstrument(type, name, params);
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
}
function setBpm(v) { project.bpm = Math.max(40, Math.min(240, Math.round(v))); syncTransportUI(); if (_playing) _events = E.expandArrangement(project); }

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
  bind('st-save', saveProject); bind('st-open', loadProject);
  bind('st-export-midi', exportMIDIFile); bind('st-import-midi', importMIDIFile);
  bind('st-render-wav', renderWAV);

  // keyboard: space = play/stop while window focused
  root.addEventListener('keydown', e => { if (e.key === ' ' && !e.target.closest('input,select,textarea')) { e.preventDefault(); togglePlay(); } });

  _selInstId = project.instruments[0] ? project.instruments[0].id : null;
  renderAll();
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

function saveProject() {
  const clean = JSON.parse(JSON.stringify(project, (k, v) => k === '_mute' ? undefined : v));
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
  for (const ev of E.expandArrangement(project)) {
    const inst = project.instruments.find(i => i.id === ev.instId); if (!inst || inst._mute) continue;
    if (inst.type === 'drum') offlineDrum(oc, m, (inst.params && inst.params.voice) || 'kick', ev.timeSec);
    else chipVoice(oc, m, ev.midi, ev.timeSec, ev.durSec, ev.vel, inst.params || {});
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
};
window.Studio = {
  play, stop, togglePlay, setBpm, saveProject, loadProject, exportMIDIFile, importMIDIFile, renderWAV,
  get project() { return project; },
  load(p) { stop(); project = p; _selInstId = project.instruments[0] ? project.instruments[0].id : null; if (_master) _master.gain.value = project.master ?? 0.9; renderAll(); },
};

// minimal HTML escaper (the app's global esc may not be visible to modules)
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
