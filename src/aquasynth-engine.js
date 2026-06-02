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
export function makeInstrument(type, name, params = {}) {
  return { id: aqsUid('inst'), type, name: name || type, params, sampleRef: null };
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
