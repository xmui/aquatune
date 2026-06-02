/* ============================================================================
 * AquaSynth engine core (Phase 1, increment 1)
 *
 * Pure, framework-free music model + timing math + arrangement expansion.
 * This is the backbone the live scheduler, the WAV (OfflineAudioContext)
 * renderer, and the MIDI exporter all build on. Everything here is
 * deterministic and unit-testable in Node (no Web Audio dependency).
 *
 * Concepts
 *  - project: the whole saveable document (bpm, instruments, patterns, arrangement).
 *  - pattern: per-instrument lane data — either a step grid (drums) or a list of
 *    notes (melodic). A pattern has a length in bars.
 *  - arrangement: tracks (one per instrument) holding clips placed on the song
 *    timeline; each clip references a pattern and a start bar + length in bars.
 *  - event: a flattened, absolutely-timed note {instId, midi, timeSec, durSec, vel}
 *    produced by expanding the arrangement — consumed by the scheduler/render/MIDI.
 * ========================================================================== */

export const PPQ = 96;            // ticks per quarter-note (MIDI export resolution)
export const STEPS_PER_BAR = 16;  // 16th-note grid, 4/4
export const STEPS_PER_BEAT = 4;
export const BEATS_PER_BAR = 4;

let _idSeq = 0;
export function aqsUid(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}_${(_idSeq++).toString(36)}`; }

/* ---- timing math -------------------------------------------------------- */
export function secPerBeat(bpm) { return 60 / bpm; }
export function secPerStep(bpm) { return 60 / bpm / STEPS_PER_BEAT; }
export function secPerBar(bpm)  { return (60 / bpm) * BEATS_PER_BAR; }
// absolute seconds for a position given in bars (float) from song start
export function barToSec(bpm, bar) { return bar * secPerBar(bpm); }
// step index (within a bar-relative grid) → seconds offset
export function stepToSec(bpm, step) { return step * secPerStep(bpm); }

/* ---- note helpers ------------------------------------------------------- */
// MIDI note number → frequency (A4=69=440Hz)
export function midiToFreq(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiToName(midi) { return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }

/* ---- factories ---------------------------------------------------------- */
// Per-type default synth params. cut>=11000 means "filter bypassed" so defaults
// sound exactly like before (the per-voice lowpass is only inserted when lowered).
export function defaultParams(type) {
  if (type === 'chip')    return { wave: 'pulse', a: 0.006, d: 0.04, s: 0.65, r: 0.1, cut: 12000, res: 1, fenv: 0 };
  if (type === 'keys')    return { preset: 'toypiano', a: 0.006, d: 0.05, s: 0.6, r: 0.2, cut: 12000, res: 1, fenv: 0 };
  if (type === 'sampler') return { baseNote: 60, oneShot: true, a: 0.002, d: 0, s: 1, r: 0.1, cut: 12000, res: 1, fenv: 0 };
  return {}; // drum
}
export function defaultFx() { return { drive: 0, pan: 0, level: 0.9, reverb: 0, delay: 0, chorus: 0 }; }

export function makeInstrument(type, name, params = {}) {
  return {
    id: aqsUid('inst'), type, name: name || type, sampleRef: null,
    params: Object.assign(defaultParams(type), params),
    fx: defaultFx(),
  };
}

// A pattern stores BOTH a step grid (for drum-style lanes) and a notes array
// (for melodic lanes); an instrument uses whichever its type calls for. This is
// what lets the same pattern be arranged as a clip and edited inline (hybrid).
export function makePattern(name, bars = 1) {
  return {
    id: aqsUid('pat'),
    name: name || 'Pattern',
    bars,
    steps: new Array(bars * STEPS_PER_BAR).fill(0), // 0/1 (+ optional velocity later)
    notes: [],                                       // {midi,start,len,vel} in steps
  };
}

// A clip places a pattern on the timeline for one instrument's track.
export function makeClip(patternId, startBar, lenBars) {
  return { id: aqsUid('clip'), patternId, startBar, lenBars };
}

export function makeProject(name = 'Untitled') {
  return {
    v: 1,
    name,
    bpm: 120,
    swing: 0,
    master: 0.9,
    instruments: [],
    patterns: [],
    arrangement: [],   // [{ instId, clips:[clip] }]
    samples: {},       // ref -> base64 (filled by the sampler)
  };
}

/* ---- lookup helpers ----------------------------------------------------- */
export function getPattern(project, id) { return project.patterns.find(p => p.id === id) || null; }
export function getTrack(project, instId) { return project.arrangement.find(t => t.instId === instId) || null; }

export function ensureTrack(project, instId) {
  let t = getTrack(project, instId);
  if (!t) { t = { instId, clips: [] }; project.arrangement.push(t); }
  return t;
}

/* ---- arrangement expansion --------------------------------------------- */
// Expand one pattern into note events (in STEP units relative to the pattern start).
// Drum/step lanes become 1-step hits at their grid positions; melodic lanes use notes.
// `drumMidi` lets a step-grid lane map to a fixed MIDI note (e.g. a drum voice).
function patternEvents(pattern, isStepLane, drumMidi = 36) {
  const out = [];
  if (isStepLane) {
    for (let s = 0; s < pattern.steps.length; s++) {
      const v = pattern.steps[s];
      if (v) out.push({ midi: drumMidi, startStep: s, lenStep: 1, vel: typeof v === 'number' && v > 1 ? v / 127 : 0.9 });
    }
  } else {
    for (const n of pattern.notes) {
      out.push({ midi: n.midi, startStep: n.start, lenStep: Math.max(1, n.len || 1), vel: n.vel != null ? n.vel : 0.9 });
    }
  }
  return out;
}

/**
 * Flatten the whole arrangement into absolutely-timed events.
 * Returns events sorted by time: {instId, midi, timeSec, durSec, vel, startBar}.
 * Optionally clip to [fromBar, toBar) for windowed scheduling.
 */
export function expandArrangement(project, opts = {}) {
  const { fromBar = 0, toBar = Infinity, stepLaneTypes = ['drum'] } = opts;
  const bpm = project.bpm;
  const sStep = secPerStep(bpm);
  const sBar = secPerBar(bpm);
  const events = [];
  for (const track of project.arrangement) {
    const inst = project.instruments.find(i => i.id === track.instId);
    if (!inst) continue;
    const isStep = stepLaneTypes.includes(inst.type);
    const drumMidi = inst.params && inst.params.drumMidi != null ? inst.params.drumMidi : 36;
    for (const clip of track.clips) {
      const pat = getPattern(project, clip.patternId);
      if (!pat) continue;
      const lenBars = clip.lenBars || pat.bars;
      // a clip may loop the pattern to fill its length
      const reps = Math.max(1, Math.round(lenBars / pat.bars));
      const evs = patternEvents(pat, isStep, drumMidi);
      for (let r = 0; r < reps; r++) {
        const repStartBar = clip.startBar + r * pat.bars;
        if (repStartBar >= toBar) break;
        const baseSec = repStartBar * sBar;
        for (const e of evs) {
          const tSec = baseSec + e.startStep * sStep;
          const bar = repStartBar + e.startStep / STEPS_PER_BAR;
          if (bar < fromBar || bar >= toBar) continue;
          events.push({
            instId: track.instId,
            midi: e.midi,
            timeSec: tSec,
            durSec: e.lenStep * sStep,
            vel: e.vel,
            startBar: bar,
          });
        }
      }
    }
  }
  events.sort((a, b) => a.timeSec - b.timeSec);
  return events;
}

// total song length in bars (max clip end across all tracks)
export function songLengthBars(project) {
  let end = 0;
  for (const track of project.arrangement) {
    for (const clip of track.clips) {
      const pat = getPattern(project, clip.patternId);
      const len = clip.lenBars || (pat ? pat.bars : 1);
      end = Math.max(end, clip.startBar + len);
    }
  }
  return end;
}
export function songLengthSec(project) { return songLengthBars(project) * secPerBar(project.bpm); }

/* ============================================================================
 * IO: MIDI (Standard MIDI File, type 1) export/import + WAV (PCM16) encode.
 * Hand-rolled, no dependencies (single-file build constraint).
 * ========================================================================== */
const TICKS_PER_STEP = PPQ / STEPS_PER_BEAT; // 96/4 = 24 ticks per 16th step

function _vlq(n) { // variable-length quantity
  const bytes = [n & 0x7f]; n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7f) | 0x80); n >>= 7; }
  return bytes;
}
function _str(s) { return [...s].map(c => c.charCodeAt(0)); }
function _u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function _u16(n) { return [(n >>> 8) & 255, n & 255]; }
function _chunk(id, data) { return [..._str(id), ..._u32(data.length), ...data]; }

// Build the absolute-tick note list for one instrument across the arrangement.
function instNoteTicks(project, inst) {
  const isStep = inst.type === 'drum';
  const drumMidi = inst.params && inst.params.drumMidi != null ? inst.params.drumMidi : 36;
  const out = [];
  const track = getTrack(project, inst.id);
  if (!track) return out;
  for (const clip of track.clips) {
    const pat = getPattern(project, clip.patternId);
    if (!pat) continue;
    const reps = Math.max(1, Math.round((clip.lenBars || pat.bars) / pat.bars));
    for (let r = 0; r < reps; r++) {
      const baseStep = (clip.startBar + r * pat.bars) * STEPS_PER_BAR;
      if (isStep) {
        for (let s = 0; s < pat.steps.length; s++) if (pat.steps[s]) out.push({ midi: drumMidi, startTick: (baseStep + s) * TICKS_PER_STEP, durTick: TICKS_PER_STEP, vel: 100 });
      } else {
        for (const n of pat.notes) out.push({ midi: n.midi, startTick: (baseStep + n.start) * TICKS_PER_STEP, durTick: Math.max(1, n.len) * TICKS_PER_STEP, vel: Math.round((n.vel ?? 0.85) * 127) });
      }
    }
  }
  return out;
}

export function exportMIDI(project) {
  const tracks = [];
  // track 0: tempo map
  const usPerQuarter = Math.round(60000000 / project.bpm);
  const tempoTrack = [0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255, 0x00, 0xff, 0x2f, 0x00];
  tracks.push(_chunk('MTrk', tempoTrack));
  // one track per instrument
  project.instruments.forEach((inst, ch0) => {
    const ch = ch0 % 16;
    const notes = instNoteTicks(project, inst);
    const evs = [];
    for (const n of notes) { evs.push({ tick: n.startTick, on: true, midi: n.midi, vel: n.vel }); evs.push({ tick: n.startTick + n.durTick, on: false, midi: n.midi, vel: 0 }); }
    evs.sort((a, b) => a.tick - b.tick || (a.on ? 1 : 0) - (b.on ? 1 : 0));
    const data = [];
    // track name meta
    const nm = _str(inst.name).slice(0, 127);
    data.push(0x00, 0xff, 0x03, nm.length, ...nm);
    let last = 0;
    for (const e of evs) {
      data.push(..._vlq(e.tick - last)); last = e.tick;
      data.push((e.on ? 0x90 : 0x80) | ch, e.midi & 127, e.vel & 127);
    }
    data.push(0x00, 0xff, 0x2f, 0x00); // end of track
    tracks.push(_chunk('MTrk', data));
  });
  const header = _chunk('MThd', [..._u16(1), ..._u16(tracks.length), ..._u16(PPQ)]);
  return new Uint8Array([...header, ...tracks.flat()]);
}

export function importMIDI(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let pos = 0;
  const u32 = () => { const v = (b[pos] << 24) | (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]; pos += 4; return v >>> 0; };
  const u16 = () => { const v = (b[pos] << 8) | b[pos + 1]; pos += 2; return v; };
  const id = () => { const s = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]); pos += 4; return s; };
  if (id() !== 'MThd') throw new Error('Not a MIDI file');
  u32(); u16(); const ntrks = u16(); const division = u16() || PPQ;
  const project = makeProject('Imported'); project.instruments = []; project.patterns = []; project.arrangement = [];
  let bpm = 120;
  for (let t = 0; t < ntrks; t++) {
    if (id() !== 'MTrk') break;
    const len = u32(); const end = pos + len;
    let tick = 0, running = 0, name = '';
    const open = {}; const notes = [];
    while (pos < end) {
      // delta
      let d = 0, byte; do { byte = b[pos++]; d = (d << 7) | (byte & 0x7f); } while (byte & 0x80);
      tick += d;
      let status = b[pos];
      if (status & 0x80) pos++; else status = running; // running status
      running = status;
      const hi = status & 0xf0;
      if (status === 0xff) { const meta = b[pos++]; let l = 0, by; do { by = b[pos++]; l = (l << 7) | (by & 0x7f); } while (by & 0x80); const data = b.slice(pos, pos + l); pos += l; if (meta === 0x51 && l === 3) { const us = (data[0] << 16) | (data[1] << 8) | data[2]; bpm = Math.round(60000000 / us); } else if (meta === 0x03) { name = String.fromCharCode(...data); } }
      else if (status === 0xf0 || status === 0xf7) { let l = 0, by; do { by = b[pos++]; l = (l << 7) | (by & 0x7f); } while (by & 0x80); pos += l; }
      else if (hi === 0x90 || hi === 0x80) { const midi = b[pos++], vel = b[pos++]; if (hi === 0x90 && vel > 0) { (open[midi] ||= []).push({ start: tick, vel }); } else { const arr = open[midi]; if (arr && arr.length) { const o = arr.shift(); notes.push({ midi, start: o.start, dur: Math.max(1, tick - o.start), vel: o.vel }); } } }
      else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) { pos += 2; }
      else if (hi === 0xc0 || hi === 0xd0) { pos += 1; }
      else pos++;
    }
    pos = end;
    if (!notes.length) continue;
    // build an instrument + one pattern spanning the track
    const inst = makeInstrument('chip', name || `Track ${t}`, { wave: 'pulse' });
    project.instruments.push(inst);
    const maxStep = Math.max(...notes.map(n => Math.ceil((n.start + n.dur) / (division / STEPS_PER_BEAT))));
    const bars = Math.max(1, Math.ceil(maxStep / STEPS_PER_BAR));
    const pat = makePattern(inst.name, bars);
    for (const n of notes) {
      const startStep = Math.round(n.start / (division / STEPS_PER_BEAT));
      const lenStep = Math.max(1, Math.round(n.dur / (division / STEPS_PER_BEAT)));
      pat.notes.push({ midi: n.midi, start: startStep, len: lenStep, vel: (n.vel || 100) / 127 });
    }
    project.patterns.push(pat);
    ensureTrack(project, inst.id).clips.push(makeClip(pat.id, 0, bars));
  }
  project.bpm = bpm;
  return project;
}

// Encode an AudioBuffer (or {sampleRate, channels:[Float32Array,...]}) to a 16-bit PCM WAV.
export function encodeWAV(buf) {
  const sr = buf.sampleRate;
  const nch = buf.numberOfChannels || buf.channels.length;
  const chans = []; for (let c = 0; c < nch; c++) chans.push(buf.getChannelData ? buf.getChannelData(c) : buf.channels[c]);
  const frames = chans[0].length;
  const blockAlign = nch * 2, dataLen = frames * blockAlign;
  const out = new DataView(new ArrayBuffer(44 + dataLen));
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); out.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, nch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * blockAlign, true); out.setUint16(32, blockAlign, true); out.setUint16(34, 16, true);
  wstr(36, 'data'); out.setUint32(40, dataLen, true);
  let o = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++) { let s = Math.max(-1, Math.min(1, chans[c][i])); out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Uint8Array(out.buffer);
}

/* ============================================================================
 * Randomizers (pure) — scale-aware melodies + genre drum patterns.
 * Ported from the legacy AquaSynth; deterministic when passed an `rng`.
 * ========================================================================== */
const SCALES = {
  pentatonic: [0, 2, 4, 7, 9], major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
  blues: [0, 3, 5, 6, 7, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
};
const KEY_OFFSET = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

export function randomMelody({ scale = 'pentatonic', key = 'C', bars = 1, density = 0.6, lo = 50, hi = 74, rng = Math.random } = {}) {
  const steps = bars * STEPS_PER_BAR;
  const ivals = SCALES[scale] || SCALES.pentatonic;
  const root = KEY_OFFSET[key] ?? 0;
  const pool = [];
  for (let m = lo; m <= hi; m++) if (ivals.includes((((m - root) % 12) + 12) % 12)) pool.push(m);
  if (!pool.length) return [];
  const notes = [];
  let idx = Math.floor(pool.length / 2);
  let busyUntil = -1;
  for (let s = 0; s < steps; s++) {
    if (s < busyUntil) continue;                 // don't overlap a held note
    const onBeat = s % 4 === 0;
    const p = onBeat ? Math.min(1, density + 0.25) : density * 0.4;
    if (rng() < p) {
      idx = Math.max(0, Math.min(pool.length - 1, idx + Math.round((rng() - 0.5) * 5)));
      const len = rng() < 0.3 ? 2 : 1;
      notes.push({ midi: pool[idx], start: s, len, vel: onBeat ? 0.9 : 0.72 });
      busyUntil = s + len;
    }
  }
  return notes;
}

const DRUM_ROLE = { kick: 'kick', tom: 'kick', snare: 'snare', clap: 'snare', hihat: 'hihat', openhh: 'hihat', crash: 'hihat', cowbell: 'hihat' };
const DRUM_PATTERNS = {
  straight: { kick: [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0] },
  house:    { kick: [1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0] },
  hiphop:   { kick: [1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] },
  trap:     { kick: [1,0,0,0,0,0,0,1,0,0,1,0,0,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] },
  dnb:      { kick: [1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0], snare: [0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hihat: [1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0] },
  jazz:     { kick: [1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], snare: [0,0,0,1,0,0,1,0,0,0,1,0,0,1,0,0], hihat: [1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1] },
};
export function randomDrumPattern({ voice = 'kick', genre = 'straight', bars = 1, rng = Math.random } = {}) {
  const g = DRUM_PATTERNS[genre] || DRUM_PATTERNS.straight;
  const base = g[DRUM_ROLE[voice] || 'hihat'] || g.kick;
  const out = [];
  for (let b = 0; b < bars; b++) for (let s = 0; s < STEPS_PER_BAR; s++) {
    let v = base[s] ? 1 : 0;
    if (!v && rng() < 0.08) v = 1;       // ghost hits
    if (v && rng() < 0.06) v = 0;        // occasional drop
    out.push(v);
  }
  return out;
}
export const RND_SCALES = Object.keys(SCALES);
export const RND_GENRES = Object.keys(DRUM_PATTERNS);
