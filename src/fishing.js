// Aquatune Fishing — a Game Boy Color–styled patience/timing fishing game.
//
// Loop: CAST → wait (patiently, while a lo-fi bitcrushed water ambient plays) →
// a fish bites with a "DING!" and the bobber plunges → you have a SMALL window to
// hit reel → then a short multi-tap "struggle" (tap the sweeping marker in the
// green) lands the fish. Reeling early (mashing) scares the fish. Audio cues live
// in index.html as window.fishingSfx; visuals are a chunky pixel canvas.

const W = 160, H = 144;                 // GBC native-ish resolution
// Game Boy COLOR look: per-zone palette swaps (the most GBC thing there is),
// plus a shared cream/navy UI palette for meters, text and chrome.
const ZPAL = [
  { sky: '#9ce8f8', cloud: '#f0fbff', water: '#2868c8', waterHi: '#4890e0', wave: '#90d0f0', dock: '#a06a3a', dockHi: '#c08850', shadow: '#1c4890' },   // River — bright day
  { sky: '#68b0e8', cloud: '#e8f4fc', water: '#1848a0', waterHi: '#2868c8', wave: '#68a8e0', dock: '#c8a060', dockHi: '#e0c080', shadow: '#103078' },   // Ocean — deep blue
  { sky: '#687848', cloud: '#90a060', water: '#28403a', waterHi: '#3a5848', wave: '#688868', dock: '#604830', dockHi: '#786040', shadow: '#182820' },   // Swamp — murk
  { sky: '#281018', cloud: '#502028', water: '#601810', waterHi: '#882818', wave: '#d85820', dock: '#382028', dockHi: '#503038', shadow: '#400c08' },   // Hell — magma
];
const UI = { ink: '#182030', paper: '#f8f0e0', gold: '#f0c030', white: '#f8f8f8',
  track: '#243048', zone: '#38c860', zoneHi: '#88f0a8', red: '#e04838', trail: '#f0d860' };
function zp() { return ZPAL[curZone] || ZPAL[0]; }
const WATER_Y = 58;

// Zones unlock as your Fishing level climbs — deeper waters, rarer fish.
const ZONES = [
  { name: '🏞️ River', lvl: 1 },
  { name: '🌊 Ocean', lvl: 12 },
  { name: '🥬 Swamp', lvl: 30 },
  { name: '🔥 Hell',  lvl: 55 },
];
// Rods are bought with credits. A better rod = more bites, rarer fish on the
// line, and slightly easier fights — it no longer hard-gates which fish exist.
const RODS = [
  { name: 'Bamboo', tier: 0, cost: 0 },
  { name: 'Fiber',  tier: 1, cost: 400 },
  { name: 'Carbon', tier: 2, cost: 2200 },
  { name: 'Mythic', tier: 3, cost: 9500 },
];

// Pixel-art shapes: chars → o outline · b body · l belly · e eye · . transparent.
const SHAPES = {
  classic: [
    'o.....oooo.....',
    'oo..ooobbbboo..',
    'obo.obbbbbbbbo.',
    'obboobbbbbbbboo',
    'obbbbbbbbbbbebo',
    'obboobbbbbbbboo',
    'obo.obbbbbbbbo.',
    'oo..ooobbbboo..',
    'o.....oooo.....',
  ],
  long: [
    '..ooooooooooo...',
    '.obbbbbbbbbbboo.',
    'obbbbbbbbbbbbbeo',
    'obbbbbbbbbbbbbbo',
    '.obbbbbbbbbbboo.',
    '..ooooooooooo...',
  ],
  round: [
    '...ooooo...',
    '..obbbbbo..',
    '.obbbbbbbo.',
    'obbbbbbbbbo',
    'obbbbbbbebo',
    'obbbbbbbbbo',
    '.obbbbbbbo.',
    '..obbbbbo..',
    '...ooooo...',
  ],
};

// zone: which water it lives in · rod: tier the fish PREFERS (catchable on any
// rod, just rare below that tier) ·
// shape/col: its pixel sprite. Catch it and it joins your Fish-o-pedia.
const FISH = [
  // River (zone 0)
  { name: 'Minnow',        zone: 0, rarity: 0, value: 4,   rod: 0, shape: 'classic', col: '#bcd0c0', img: 'river/minnow' },
  { name: 'Bass',          zone: 0, rarity: 1, value: 10,  rod: 0, shape: 'classic', col: '#6fae5a', img: 'river/bass' },
  { name: 'Pike',          zone: 0, rarity: 1, value: 18,  rod: 1, shape: 'long',    col: '#5a8a3a', img: 'river/pike' },
  { name: 'Rainbow Trout', zone: 0, rarity: 2, value: 30,  rod: 2, shape: 'classic', col: '#d98f5a', img: 'river/rainbow-trout' },
  { name: 'Golden Carp',   zone: 0, rarity: 3, value: 75,  rod: 3, shape: 'round',   col: '#e8c000', img: 'river/golden-carp' },
  // Ocean (zone 1)
  { name: 'Sardine',       zone: 1, rarity: 0, value: 8,   rod: 0, shape: 'classic', col: '#9fb8c8' },
  { name: 'Mackerel',      zone: 1, rarity: 1, value: 18,  rod: 0, shape: 'classic', col: '#4a7fa0' },
  { name: 'Pufferfish',    zone: 1, rarity: 2, value: 36,  rod: 1, shape: 'round',   col: '#d6c25a' },
  { name: 'Swordfish',     zone: 1, rarity: 3, value: 85,  rod: 2, shape: 'long',    col: '#3a5f8a' },
  { name: 'Anglerfish',    zone: 1, rarity: 3, value: 130, rod: 3, shape: 'round',   col: '#5a3a6a' },
  // Swamp (zone 2)
  { name: 'Mudfish',       zone: 2, rarity: 1, value: 20,  rod: 0, shape: 'classic', col: '#7a6a3a' },
  { name: 'Catfish',       zone: 2, rarity: 2, value: 42,  rod: 1, shape: 'long',    col: '#6a5a4a' },
  { name: 'Eel',           zone: 2, rarity: 3, value: 78,  rod: 1, shape: 'long',    col: '#3a4a2a' },
  { name: 'Snapping Turtle',zone: 2,rarity: 3, value: 115, rod: 2, shape: 'round',   col: '#4a6a3a' },
  { name: 'Bog Serpent',   zone: 2, rarity: 4, value: 190, rod: 3, shape: 'long',    col: '#2a4a3a' },
  // Hell (zone 3)
  { name: 'Lavafish',      zone: 3, rarity: 2, value: 60,  rod: 0, shape: 'classic', col: '#e0662a' },
  { name: 'Cinder Eel',    zone: 3, rarity: 3, value: 125, rod: 1, shape: 'long',    col: '#8a2a1a' },
  { name: 'Magma Ray',     zone: 3, rarity: 4, value: 230, rod: 2, shape: 'round',   col: '#c8401a' },
  { name: 'Demon Koi',     zone: 3, rarity: 4, value: 320, rod: 3, shape: 'classic', col: '#b01a2a' },
  { name: 'Hellfish',      zone: 3, rarity: 4, value: 420, rod: 3, shape: 'round',   col: '#ff8a2a' },
];

// ── Difficulty dials (tune freely) ──────────────────────────────────────────
const WAIT_MIN = 4200, WAIT_RAND = 8500;     // ms before the real bite (patience)
const CAST_MS = 550;                         // toss animation before waiting
const BITE_WINDOW_BASE = 600, BITE_WINDOW_PER = 55;   // reaction window (ms), −per rarity (compressed curve)
const STRUGGLE_MS_BASE = 5200, STRUGGLE_MS_PER = 560; // struggle time limit (ms), −per rarity
const MONSTER_CHANCE = 0.04;                          // base chance per bite (×condition)
const CONDITION_EVERY = 5;                            // re-roll water condition every N casts
// Session water condition — shifts bite frequency AND fight difficulty.
const CONDITIONS = {
  calm:   { name: '🌅 Calm',   waitMult: 0.8, nibbleBias: -1, windowMult: 1.25, speedMult: 0.85, zoneMult: 1.20, monsterMult: 0.6 },
  choppy: { name: '🌊 Choppy', waitMult: 1.0, nibbleBias: 0,  windowMult: 1.00, speedMult: 1.00, zoneMult: 1.00, monsterMult: 1.0 },
  stormy: { name: '⛈️ Stormy', waitMult: 1.3, nibbleBias: 1,  windowMult: 0.78, speedMult: 1.25, zoneMult: 0.82, monsterMult: 1.8 },
};
// One legendary monster per zone (rare, brutal fight, huge payout).
const MONSTERS = [
  { name: 'River King',    zone: 0, rarity: 5, value: 300, rod: 0, shape: 'long',  col: '#8fd0a0', monster: true },
  { name: 'Leviathan',     zone: 1, rarity: 5, value: 500, rod: 0, shape: 'long',  col: '#2a4a6a', monster: true },
  { name: 'Bog Horror',    zone: 2, rarity: 5, value: 680, rod: 0, shape: 'long',  col: '#2a3a1a', monster: true },
  { name: 'Cerberus Fish', zone: 3, rarity: 5, value: 950, rod: 0, shape: 'round', col: '#c01a0a', monster: true },
];
const STYLE_LABEL = { steady: '', darter: 'darter!', lunger: 'lunger!', drifter: 'drifter!', thrasher: 'thrasher!', monster: 'MONSTER' };
// ────────────────────────────────────────────────────────────────────────────

let cv = null, cx = null, raf = null, _built = false, _fishInfo = null;
let zoneEl = null, rodEl = null, dexEl = null;
let state = 'idle';   // idle | casting | waiting | bite | struggle | caught | miss | scared
let msg = 'Press CAST to fish';
let fish = null;      // the fish currently on the line / being fought
let lastCatch = null; // {shape, col, name, monster} — drawn on the caught screen
let curZone = 0, dexOpen = false;

// timing (absolute performance.now() ms)
let castUntil = 0, biteAt = 0, biteWindowEnd = 0;
let nibbles = [];           // [{at, done}]
let nibbleFlashUntil = 0;   // visual twitch

// struggle state
let S = null;
let streak = 0;                  // consecutive landed fish this session
let goldFlashUntil = 0;          // flawless-catch golden flash
let particles = [], floaters = [];
function sparkle(x, y, color, n) {
  for (let i = 0; i < n; i++) particles.push({
    x, y, vx: (Math.random() - 0.5) * 2.2, vy: -Math.random() * 2 - 0.4,
    life: 26 + Math.random() * 14, c: color, s: 1 + (Math.random() < 0.4 ? 1 : 0), g: 0.08,
  });
}
function splashRing() {
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    particles.push({ x: 103, y: WATER_Y + 2, vx: Math.cos(a) * 1.6, vy: Math.sin(a) * 0.8 - 0.8, life: 20, c: UI.white, s: 1, g: 0.12 });
  }
}
function addFloater(text, color) { floaters.push({ text, color, x: W / 2, y: 58, life: 36 }); }
// per-zone ambient props (clouds / fish shadows / fireflies / embers)
let ambients = [];
function seedAmbients() {
  ambients = [];
  if (curZone <= 1) for (let i = 0; i < 2; i++) ambients.push({ kind: 'cloud', x: Math.random() * W, y: 8 + i * 14, v: 0.06 + Math.random() * 0.05 });
  if (curZone <= 1) ambients.push({ kind: 'shadow', x: -20, y: WATER_Y + 30 + Math.random() * 30, v: 0.25 + Math.random() * 0.2 });
  if (curZone === 2) for (let i = 0; i < 4; i++) ambients.push({ kind: 'firefly', x: Math.random() * W, y: 10 + Math.random() * 40, ph: Math.random() * 6.28 });
  if (curZone === 3) for (let i = 0; i < 5; i++) ambients.push({ kind: 'ember', x: Math.random() * W, y: H - Math.random() * 60, v: 0.2 + Math.random() * 0.3 });
}
let condition = CONDITIONS.choppy, _castCount = 0;
function rollCondition() { condition = CONDITIONS[['calm', 'choppy', 'choppy', 'stormy'][(Math.random() * 4) | 0]]; }
function pickStyle(rarity) {
  const hard = ['darter', 'lunger', 'drifter', 'thrasher'];
  const steadyChance = rarity <= 0 ? 0.6 : rarity >= 3 ? 0 : 0.35;
  return Math.random() < steadyChance ? 'steady' : hard[(Math.random() * hard.length) | 0];
}

function lvl() { return (typeof window.aqSkillLevel === 'function' && window.aqSkillLevel('fishing')) || 1; }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function sfx(n) { try { if (typeof window !== 'undefined' && window.fishingSfx) window.fishingSfx(n); } catch (e) {} }

// ── Bitcrushed "fish on the line" wave loop ──────────────────────────────────
// A lo-fi ocean wash that plays ONLY while a fish is hooked (bite + struggle),
// then stops on every exit path. Reuses the shared AudioContext (window.actx)
// if one is already running, else lazily makes its own on first gesture.
let _hookAC = null;        // our own AudioContext (only if no shared one exists)
let _hookWave = null;      // { src, gain, lfo, lfoG } while playing
function hookAudioCtx() {
  // Prefer the app's shared context so we don't fight the autoplay policy.
  if (typeof window !== 'undefined' && window.actx) return window.actx;
  try {
    if (!_hookAC) _hookAC = new (window.AudioContext || window.webkitAudioContext)();
    if (_hookAC.state === 'suspended') _hookAC.resume();
    return _hookAC;
  } catch (e) { return null; }
}
// Respect the game volume control (a module-local in index.html, mirrored to localStorage).
function gameVol() {
  let v = 1;
  try { v = parseFloat(localStorage.getItem('aq_game_vol') ?? '1'); } catch (e) {}
  return isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}
// Quantize a noise buffer to a few levels in-place for a bitcrushed (lo-fi) timbre.
function _crushedNoise(ac, levels = 6) {
  const len = Math.floor(ac.sampleRate * 1.7);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0), step = 2 / levels;
  for (let i = 0; i < len; i++) {
    const x = Math.random() * 2 - 1;
    d[i] = Math.round(x / step) * step;   // crush to `levels` discrete steps
  }
  return buf;
}
function startHookWave(intensity = 0) {
  const V = gameVol();
  if (V <= 0 || _hookWave) return;        // muted, or already running
  const ac = hookAudioCtx();
  if (!ac) return;
  try {
    const t = ac.currentTime;
    const src = ac.createBufferSource(); src.buffer = _crushedNoise(ac); src.loop = true;
    // lowpass = ocean wash; rarer fish churn a touch brighter/harder
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.value = 480 + intensity * 90; lp.Q.value = 0.7;
    const g = ac.createGain(); g.gain.value = 0.0001;
    // slow swell LFO on the gain to mimic wave sets
    const lfo = ac.createOscillator(); lfo.type = 'sine';
    lfo.frequency.value = 0.45 + intensity * 0.05;
    const lfoG = ac.createGain(); lfoG.gain.value = 0.018 * V;
    lfo.connect(lfoG); lfoG.connect(g.gain);
    src.connect(lp); lp.connect(g); g.connect(ac.destination);
    const bed = (0.045 + Math.min(0.025, intensity * 0.005)) * V;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(bed, t + 0.5);
    src.start(t); lfo.start(t);
    _hookWave = { ac, src, gain: g, lfo, lfoG };
  } catch (e) {}
}
function stopHookWave() {
  if (!_hookWave) return;
  const w = _hookWave; _hookWave = null;
  try {
    const ac = w.ac, t = ac.currentTime;
    w.gain.gain.cancelScheduledValues(t);
    w.gain.gain.setValueAtTime(Math.max(0.0002, w.gain.gain.value || 0.02), t);
    w.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    w.src.stop(t + 0.3); w.lfo.stop(t + 0.3);
    setTimeout(() => { try { w.lfoG.disconnect(); } catch (e) {} }, 400);
  } catch (e) {
    try { w.src.stop(); w.lfo.stop(); } catch (e2) {}
  }
}
function rodTier() { return Math.max(0, Math.min(RODS.length - 1, parseInt(localStorage.getItem('aq_fishing_rod') || '0', 10) || 0)); }
function maxZone() { let m = 0; for (let i = 0; i < ZONES.length; i++) if (lvl() >= ZONES[i].lvl) m = i; return m; }

// Caught-counts collection (the Fish-o-pedia). { fishName: count }
function readCaught() { try { return JSON.parse(localStorage.getItem('aq_fishing_caught') || '{}') || {}; } catch { return {}; } }
function recordCaught(name) { try { const c = readCaught(); c[name] = (c[name] | 0) + 1; localStorage.setItem('aq_fishing_caught', JSON.stringify(c)); window.aqGamePersist && window.aqGamePersist('aq_fishing_caught'); } catch (e) {} }

function pickFish() {
  // Every fish in the zone is hookable on any rod; fish above your rod tier are
  // just rare bites. Rod tier + level both push the odds toward rarer fish.
  const pool = FISH.filter(f => f.zone === curZone);
  if (!pool.length) return FISH[0];
  const tier = rodTier();
  const luck = Math.random() + lvl() / 300;
  let total = 0;
  const w = pool.map(f => {
    let x = Math.max(0.15, 1 - f.rarity * 0.16) * (1 + luck * f.rarity * 0.45);
    x *= (f.rod <= tier ? 1 : 0.15);                    // soft preference, not a gate
    x *= 1 + tier * 0.45 * f.rarity / 5;                // better rod → rarer fish
    total += x; return x;
  });
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return pool[i]; }
  return pool[0];
}

// ── State transitions ───────────────────────────────────────────────────────
function startCast() {
  state = 'casting';
  stopHookWave();   // defensive: nothing should be on the line yet
  msg = 'Casting…';
  fish = null; S = null;
  if (_castCount++ % CONDITION_EVERY === 0) rollCondition();
  castUntil = performance.now() + CAST_MS;
  sfx('wave-start');
}

function enterWaiting(now) {
  state = 'waiting';
  msg = 'Waiting for a bite…';
  // better rods get bites noticeably faster (−12% wait per tier)
  const wait = (WAIT_MIN + Math.random() * WAIT_RAND - Math.min(2500, lvl() * 25)) * condition.waitMult * (1 - 0.12 * rodTier());
  biteAt = now + Math.max(2200, wait);
  // schedule fake nibbles strictly before the real bite (more when stormy)
  nibbles = [];
  const n = Math.max(0, Math.min(4, Math.floor(Math.random() * 4) + condition.nibbleBias));
  for (let i = 0; i < n; i++) {
    const at = now + 1000 + Math.random() * (biteAt - now - 1400);
    if (at > now + 600 && at < biteAt - 500) nibbles.push({ at, done: false });
  }
  nibbles.sort((a, b) => a.at - b.at);
}

function enterBite(now) {
  const monster = Math.random() < MONSTER_CHANCE * condition.monsterMult * (1 + lvl() / 200);
  fish = monster ? (MONSTERS[curZone] || MONSTERS[0]) : pickFish();
  state = 'bite';
  // per-cast reaction-window jitter × water condition
  const jitter = 0.85 + Math.random() * 0.3;
  // Compressed curve (600→325ms instead of 640→220) + slight rod ease per tier.
  let win = (BITE_WINDOW_BASE - fish.rarity * BITE_WINDOW_PER) * condition.windowMult * jitter * (1 + 0.06 * rodTier());
  if (monster) win *= 0.9;
  biteWindowEnd = now + Math.max(300, win);
  msg = monster ? '🐋 MONSTER! REEL!' : '! DING — REEL NOW !';
  sfx(monster ? 'monster' : 'ding');
  splashRing();                       // unmistakable visual telegraph
  // Fish is now on the line → start the bitcrushed wave loop.
  startHookWave(fish ? fish.rarity : 0);
}

function enterStruggle(now) {
  const monster = !!(fish && fish.monster);
  sfx(monster ? 'monster' : 'hook');
  const r = fish.rarity, c = condition, tier = rodTier();
  // mild per-cast jitter only (the old 0.8–1.25× swings made fights feel random)
  const jv = 0.9 + Math.random() * 0.2;
  const jz = 0.9 + Math.random() * 0.2;
  // Compressed difficulty curve: commons a touch tougher, rares a lot fairer.
  let need = monster ? 5 : 2 + Math.floor(r * 0.55);                // 2..4, monsters 5
  let markerV = (1.6 + r * 0.28) * c.speedMult * jv * (1 - 0.04 * tier);
  let zoneW = Math.max(14, (26 - r * 2.2) * c.zoneMult * jz * (1 + 0.05 * tier));
  let totalMs = Math.max(2800, (STRUGGLE_MS_BASE - r * STRUGGLE_MS_PER) * (0.9 + Math.random() * 0.25));
  let maxMiss = monster ? 0 : 1;                                    // everyone gets one slip; monsters don't
  let style = monster ? 'monster' : pickStyle(r);
  if (monster) { markerV *= 1.1; totalMs *= 1.7; }
  markerV = Math.min(4.2, markerV);                                 // hard cap (per-16ms units)
  S = {
    need, hits: 0, misses: 0, perfects: 0, maxMiss, style, monster,
    markerX: 0, prevX: 0, markerV, dir: 1,
    zoneW, zoneW0: zoneW, zoneX: 0, zoneC: 0,
    drift: (style === 'drifter' || style === 'monster'),            // smooth sine glide
    nextFlipAt: now + 700 + Math.random() * 900, flashUntil: 0, flipArmed: false,
    hitFlashUntil: 0, missFlashUntil: 0,
    totalMs, endAt: now + totalMs, t0: now,
  };
  rerollZone();
  state = 'struggle';
  msg = (monster ? '🐋 ' : '') + 'Reel! ' + (STYLE_LABEL[style] || 'tap on green');
}
function rerollZone() {
  if (!S) return;
  // pick a centre with room for the drift sine, then glide around it
  const amp = S.drift ? 8 + Math.random() * 6 : 0;
  S.zoneAmp = amp;
  S.zoneC = amp + Math.random() * Math.max(0, 100 - S.zoneW - amp * 2);
  S.zoneX = S.zoneC;
}

function landFish(now) {
  const f = fish, noMiss = S && S.misses === 0;
  const perfects = S ? S.perfects : 0;
  streak++;
  // Sale value: clean fight bonus + per-PERFECT-tap bonus + catch streak, capped.
  const valueMult = Math.min(1.5, (noMiss ? 1.15 : 1) + perfects * 0.05) * (1 + Math.min(0.16, (streak - 1) * 0.02));
  const value = Math.round(f.value * valueMult);
  const allPerfect = noMiss && S && perfects >= S.need;
  state = 'caught';
  stopHookWave();
  goldFlashUntil = allPerfect ? now + 900 : 0;
  msg = (f.monster ? '🐋 LANDED THE LEVIATHAN! ' : `Caught a ${f.name}! `) + `+${value}💰` + (allPerfect ? ' ✨FLAWLESS' : noMiss ? ' ✨clean' : '');
  sfx('wave-stop');
  if (typeof window.playFanfare === 'function') window.playFanfare(f.monster ? 'jackpot' : 'small');
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(value);
  // XP comes ONLY from landing a fish (never from playing/missing). Moderate
  // boost over the old (1.1 + rarity*0.6) curve: a bigger base plus steeper —
  // but CAPPED — rarity scaling so monsters reward proportionally more than
  // tiddlers without making the grind trivial. (Common ≈ 13 XP, monster ≈ 50.)
  if (typeof window.aqGameXp === 'function') {
    // Balanced to ~55/min given the slow cast→bite→struggle cadence. Capped rarity curve so
    // monsters still pay proportionally more without trivialising the grind.
    const rarityMult = Math.min(15, 4 + f.rarity * 2.2);   // cap the score-scaled mult
    // clean fight = ×1.3 (overall mult ≤ 19.5, still far under the anti-cheat ceiling)
    window.aqGameXp('fishing', { played: false, won: true, mult: rarityMult * (noMiss ? 1.3 : 1) });
  }
  // ── Rare money catch: occasionally you reel up something valuable ──────────
  // Chance rises a little with rarity; monsters always cough up loot. Amount
  // scales modestly with rarity so it's a fun bonus, not game-breaking.
  const moneyChance = f.monster ? 1 : Math.min(0.09, 0.035 + f.rarity * 0.012);
  if (Math.random() < moneyChance) {
    const base = 25 + f.rarity * 22 + (f.monster ? 220 : 0);
    const bonus = Math.round(base * (0.7 + Math.random() * 0.8));   // ±variance
    if (typeof window.aqAddCredits === 'function') window.aqAddCredits(bonus);
    const lootMsg = f.monster
      ? `💰 The ${f.name} swallowed a treasure chest! +${bonus} credits`
      : `💰 You reeled up a waterlogged wallet! +${bonus} credits`;
    if (typeof window.toast === 'function') window.toast(lootMsg);
    msg += ` 💰+${bonus}`;
  }
  if (typeof window.recordScore === 'function') window.recordScore('fishing', value, f.name);
  // Shout monster / very-rare landings to the global lobby chat.
  if ((f.monster || f.rarity >= 4) && typeof window.aqGameAnnounce === 'function') {
    window.aqGameAnnounce(f.monster ? `landed the LEVIATHAN 🐋 (+${value}💰)!` : `reeled in a rare ${f.name} 🎣 (+${value}💰)`);
  }
  lastCatch = { shape: f.shape, col: f.col, name: f.name, monster: !!f.monster, img: f.img,
                isNew: !(readCaught()[f.name] | 0), value };
  recordCaught(f.name);
  sparkle(W / 2, 36, f.rarity >= 3 ? UI.gold : UI.white, 8 + f.rarity * 3);
  if (dexOpen) renderDex();
  try {
    const log = JSON.parse(localStorage.getItem('aq_fishing_log') || '[]');
    log.unshift({ name: f.name, value, ts: Date.now() });
    localStorage.setItem('aq_fishing_log', JSON.stringify(log.slice(0, 50)));
    window.aqGamePersist && window.aqGamePersist('aq_fishing_log');
  } catch (e) {}
  fish = null; S = null;
}

function missFish(reason) {
  state = 'miss';
  streak = 0;
  stopHookWave();
  msg = reason || 'It got away…';
  sfx('fail'); sfx('wave-stop');
  // no XP for misses — only catches count
  fish = null; S = null;
}

function scareFish() {
  state = 'scared';
  streak = 0;
  stopHookWave();
  msg = 'You scared it off! Patience…';
  sfx('fail'); sfx('wave-stop');
  fish = null; S = null; nibbles = [];
}

function tapStruggle() {
  if (!S) return;
  const now = performance.now();
  // Swept hit-test: the marker can't skip the zone between frames — a tap counts
  // if the path it travelled this frame (±1.5u grace) crossed the sweet spot.
  const lo = Math.min(S.prevX, S.markerX) - 1.5, hi = Math.max(S.prevX, S.markerX) + 1.5;
  const inZone = hi >= S.zoneX && lo <= S.zoneX + S.zoneW;
  if (inZone) {
    // PERFECT strip = the bright inner 40% of the zone
    const pLo = S.zoneX + S.zoneW * 0.3, pHi = S.zoneX + S.zoneW * 0.7;
    const perfect = S.markerX >= pLo && S.markerX <= pHi;
    S.hits++;
    if (perfect) { S.perfects++; addFloater('PERFECT!', UI.gold); sparkle(markerScreenX(), 76, UI.gold, 6); sfx('tick'); sfx('tick'); }
    else sfx('tick');
    S.hitFlashUntil = now + 130;
    if (S.hits >= S.need) { landFish(now); return; }
    rerollZone();
    S.markerV = Math.min(4.5, S.markerV * 1.08);   // speed up each hit (capped)
  } else {
    S.misses++; sfx('buzz');
    S.missFlashUntil = now + 180;
    if (S.misses > S.maxMiss) { missFish('Line snapped!'); return; }
  }
}
function markerScreenX() { return 14 + (S ? S.markerX / 100 : 0) * 132; }

// One press drives everything (cast / hook / struggle-tap); mashing while
// waiting scares the fish.
function press() {
  const now = performance.now();
  switch (state) {
    case 'idle': case 'caught': case 'miss': case 'scared': startCast(); break;
    case 'casting': break;                       // toss in progress — ignore
    case 'waiting': scareFish(); break;          // anti-mash: reeled with no fish
    case 'bite': if (now <= biteWindowEnd) enterStruggle(now); break;
    case 'struggle': tapStruggle(); break;
  }
}

// ── Main loop ────────────────────────────────────────────────────────────────
let _lastT = 0;
function tick(t) {
  const dt = Math.min(50, t - (_lastT || t)); _lastT = t;
  const f = dt / 16;
  const now = t;

  if (state === 'casting' && now >= castUntil) enterWaiting(now);
  if (state === 'waiting') {
    for (const nb of nibbles) {
      if (!nb.done && now >= nb.at) { nb.done = true; nibbleFlashUntil = now + 380; sfx('nibble'); }
    }
    if (now >= biteAt) enterBite(now);
  }
  if (state === 'bite' && now > biteWindowEnd) missFish('Too slow — it spat the hook!');
  if (state === 'struggle' && S) {
    const style = S.style, elapsed = now - S.t0;
    let v = S.markerV;
    // Darter/monster: direction flips are rate-limited AND telegraphed by a short
    // marker flash, instead of the old every-frame speed/direction dice rolls.
    if (style === 'darter' || style === 'monster') {
      if (!S.flipArmed && now >= S.nextFlipAt) { S.flipArmed = true; S.flashUntil = now + 130; }
      else if (S.flipArmed && now >= S.flashUntil) {
        S.dir *= -1; S.flipArmed = false;
        S.nextFlipAt = now + 700 + Math.random() * 900;
      }
    }
    if (style === 'lunger') v *= 0.6 + Math.max(0, Math.sin(elapsed / 300)) * 1.5;  // readable speed pulse
    S.prevX = S.markerX;
    S.markerX += v * S.dir * f;
    if (S.markerX <= 0) { S.markerX = 0; S.dir = 1; }
    if (S.markerX >= 100) { S.markerX = 100; S.dir = -1; }
    if (S.drift) {                                               // zone glides on a smooth sine
      S.zoneX = Math.max(0, Math.min(100 - S.zoneW, S.zoneC + Math.sin(elapsed / 650) * S.zoneAmp));
    }
    if (style === 'thrasher' || style === 'monster') {           // shrinking zone (gentle, floored)
      S.zoneW = Math.max(12, S.zoneW0 * (1 - Math.min(0.40, elapsed / S.totalMs)));
      if (S.zoneX > 100 - S.zoneW) S.zoneX = Math.max(0, 100 - S.zoneW);
    }
    if (now > S.endAt) missFish('It wore you out…');
  }

  draw(now);
  raf = requestAnimationFrame(tick);
}

// ── Drawing ───────────────────────────────────────────────────────────────────
function px(x, y, w, h, color) { cx.fillStyle = color; cx.fillRect(x | 0, y | 0, w | 0, h | 0); }

// Draw a fish pixel-sprite (centered horizontally is the caller's job). `silhouette`
// renders it as an all-dark unknown for not-yet-caught Fish-o-pedia entries.
function drawSprite(ctx, shape, col, ox, oy, scale, silhouette) {
  const rows = SHAPES[shape] || SHAPES.classic;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') continue;
      let c;
      if (silhouette) c = (ch === 'o') ? '#1a2030' : '#36405a';
      else if (ch === 'o') c = '#1a1c2c';
      else if (ch === 'l') c = '#f8f0d8';
      else if (ch === 'e') c = '#1a1c2c';
      else c = col;
      ctx.fillStyle = c;
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }
}
function spriteW(shape) { return (SHAPES[shape] || SHAPES.classic)[0].length; }

// Photo art replaces the pixel sprites where present (River so far). Each fish's
// `img` is a path under /fish (e.g. 'river/bass' → /fish/river/bass.png). Images
// preload lazily; until one is ready, callers fall back to the pixel sprite.
const FISH_IMG = {};
function fishImg(key) {
  if (!key || typeof window === 'undefined') return null;
  let im = FISH_IMG[key];
  if (!im) {
    im = FISH_IMG[key] = new Image();
    im.src = `/fish/${key}.png`;
    im.onload = () => { try { if (dexEl && dexEl.style.display !== 'none') renderDex(); } catch (e) {} };
  }
  return (im.complete && im.naturalWidth) ? im : null;
}
// Draw a fish photo aspect-fit into the box (bx,by,bw,bh). Source art faces left;
// `silhouette` tints it dark for unseen Fish-o-pedia entries (the caller passes a
// dedicated canvas so source-atop only touches the fish).
function drawFishImg(ctx, im, bx, by, bw, bh, silhouette) {
  const s = Math.min(bw / im.naturalWidth, bh / im.naturalHeight);
  const dw = im.naturalWidth * s, dh = im.naturalHeight * s;
  const dx = bx + (bw - dw) / 2, dy = by + (bh - dh) / 2;
  const prevSmooth = ctx.imageSmoothingEnabled;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(im, dx, dy, dw, dh);
  if (silhouette) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = '#222a3c';
    ctx.fillRect(dx, dy, dw, dh);
  }
  ctx.restore();
  ctx.imageSmoothingEnabled = prevSmooth;
}

function draw(t) {
  if (!cx) return;
  const P = zp();
  // golden flawless flash / sky
  cx.fillStyle = (t < goldFlashUntil && ((t / 90) | 0) % 2 === 0) ? UI.gold : P.sky;
  cx.fillRect(0, 0, W, WATER_Y);
  cx.fillStyle = P.water; cx.fillRect(0, WATER_Y, W, H - WATER_Y);
  px(0, WATER_Y, W, 3, P.waterHi);                       // shoreline highlight band

  // ambient props (clouds drift, shadows cruise, fireflies blink, embers rise)
  for (const a of ambients) {
    if (a.kind === 'cloud') {
      a.x += a.v; if (a.x > W + 22) a.x = -22;
      px(a.x, a.y, 16, 4, P.cloud); px(a.x + 3, a.y - 2, 9, 2, P.cloud); px(a.x + 4, a.y + 4, 8, 2, P.cloud);
    } else if (a.kind === 'shadow') {
      a.x += a.v; if (a.x > W + 24) { a.x = -24; a.y = WATER_Y + 26 + Math.random() * 38; }
      px(a.x, a.y, 14, 3, P.shadow); px(a.x + 14, a.y + 1, 3, 1, P.shadow);
    } else if (a.kind === 'firefly') {
      if (Math.sin(t / 400 + a.ph) > 0.2) px(a.x + Math.sin(t / 900 + a.ph) * 6, a.y + Math.sin(t / 700 + a.ph * 2) * 3, 2, 2, '#d8f060');
    } else if (a.kind === 'ember') {
      a.y -= a.v; if (a.y < WATER_Y - 30) { a.y = H - Math.random() * 20; a.x = Math.random() * W; }
      px(a.x + Math.sin(t / 300 + a.y) * 2, a.y, 2, 2, Math.random() < 0.5 ? '#f8a030' : '#d85820');
    }
  }

  // water-condition label (top-right) + streak chip (top-left)
  cx.fillStyle = UI.ink; cx.font = '8px monospace'; cx.textBaseline = 'top'; cx.textAlign = 'right';
  cx.fillText(condition.name, W - 3, 3); cx.textAlign = 'left';
  if (streak >= 2) {
    px(2, 2, 38, 11, UI.ink);
    cx.fillStyle = UI.gold; cx.fillText('x' + streak + ' 🔥', 5, 4);
  }

  // animated wave lines
  cx.fillStyle = P.wave;
  for (let y = WATER_Y + 8; y < H - 16; y += 12) {
    const off = ((t / 70) + y) % 12 | 0;
    for (let x = -12 + off; x < W; x += 12) cx.fillRect(x, y, 5, 1);
  }
  // dock + rod (rod bends toward the fight)
  px(0, WATER_Y - 14, 40, 14, P.dock);
  px(0, WATER_Y - 14, 40, 2, P.dockHi);
  const fighting = state === 'struggle' && S;
  const bend = fighting ? 4 + Math.sin(t / 90) * 2 : 0;
  px(34, WATER_Y - 40 + bend, 3, 30 - bend, UI.ink);     // rod
  const rodTip = { x: 37 + bend, y: WATER_Y - 38 + bend };

  // bobber position depends on state
  const bx = 100;
  let by = WATER_Y - 2;
  if (state === 'waiting') {
    by = WATER_Y - 1 + Math.sin(t / 320) * 2;
    if (t < nibbleFlashUntil) by += (Math.random() * 2 - 1) * 3;  // twitch
  } else if (state === 'bite') by = WATER_Y + 10;                 // yanked under
  else if (fighting) by = WATER_Y + 6 + Math.sin(t / 80) * 3;     // thrashing

  // line (jitters while fighting)
  cx.strokeStyle = UI.paper; cx.beginPath(); cx.moveTo(rodTip.x, rodTip.y);
  cx.lineTo(bx + 2 + (fighting ? Math.sin(t / 60) * 2 : 0), by); cx.stroke();
  // bobber (red-cap cream float, classic)
  px(bx, by, 6, 6, UI.red); px(bx + 1, by + 3, 4, 2, UI.paper);
  if (t < nibbleFlashUntil && state === 'waiting') { px(bx - 3, by - 4, 2, 2, UI.white); px(bx + 7, by - 3, 2, 2, UI.white); }

  // BITE: big "!" speech bubble + urgency meter — unmistakable
  if (state === 'bite') {
    px(bx - 4, by - 30, 14, 16, UI.paper); px(bx - 3, by - 31, 12, 1, UI.paper);
    px(bx + 1, by - 14, 4, 4, UI.paper);                          // bubble tail
    cx.fillStyle = UI.red; cx.font = 'bold 12px monospace'; cx.textBaseline = 'top';
    cx.fillText('!', bx + 1, by - 28);
    const total = Math.max(300, BITE_WINDOW_BASE - (fish ? fish.rarity : 0) * BITE_WINDOW_PER);
    const left = Math.max(0, (biteWindowEnd - t) / total);
    px(29, 29, 102, 10, UI.ink); px(31, 31, 98 * left, 6, left < 0.35 ? UI.red : UI.gold);
    cx.fillStyle = UI.ink; cx.font = 'bold 8px monospace'; cx.fillText('REEL!', 64, 20);
  }

  // struggle UI — high-contrast meter with an outlined sweet spot + PERFECT strip
  if (fighting) {
    const mx = 14, mw = 132, my = 70, mh = 16;
    const shake = (t < S.missFlashUntil) ? ((Math.random() * 4 - 2) | 0) : 0;
    px(mx - 3 + shake, my - 3, mw + 6, mh + 6, (t < S.missFlashUntil) ? UI.red : UI.ink);   // frame (flashes red on miss)
    px(mx + shake, my, mw, mh, UI.track);                                                   // navy track
    const zx = mx + (S.zoneX / 100) * mw + shake, zw = (S.zoneW / 100) * mw;
    const hitFlash = t < S.hitFlashUntil;
    px(zx - 1, my, 1, mh, UI.ink); px(zx + zw, my, 1, mh, UI.ink);                          // zone outline
    px(zx, my, zw, mh, hitFlash ? UI.white : UI.zone);                                      // sweet spot
    px(zx + zw * 0.3, my, zw * 0.4, mh, hitFlash ? UI.white : UI.zoneHi);                   // PERFECT strip
    // pulsing edge ticks so the zone reads at a glance
    if (((t / 240) | 0) % 2 === 0) { px(zx, my - 2, zw, 1, UI.zoneHi); px(zx, my + mh + 1, zw, 1, UI.zoneHi); }
    // marker: ghost trail + white head with ink outline (flashes when a darter is about to flip)
    const markPx = mx + (S.markerX / 100) * mw + shake;
    const prevPx = mx + (S.prevX / 100) * mw + shake;
    px(prevPx - 1, my + 2, 2, mh - 4, UI.trail);
    px(markPx - 2, my - 4, 5, mh + 8, UI.ink);
    px(markPx - 1, my - 3, 3, mh + 6, (S.flipArmed && ((t / 60) | 0) % 2 === 0) ? UI.red : UI.white);
    // hit pips (gold = perfect)
    for (let i = 0; i < S.need; i++) {
      px(mx + i * 10, my + mh + 7, 8, 6, UI.ink);
      if (i < S.hits) px(mx + i * 10 + 1, my + mh + 8, 6, 4, i < S.perfects ? UI.gold : UI.zoneHi);
    }
    // time bar
    px(mx, my - 12, mw, 4, UI.ink);
    const tl = Math.max(0, Math.min(1, (S.endAt - t) / S.totalMs));
    px(mx + 1, my - 11, (mw - 2) * tl, 2, tl < 0.3 ? UI.red : UI.paper);
  }

  // caught! — fish leaps above the water (photo art, pixel fallback) + NEW badge
  if (state === 'caught' && lastCatch) {
    const oy = 14 + Math.sin(t / 160) * 2;
    const im = fishImg(lastCatch.img);
    if (im) drawFishImg(cx, im, 12, oy, W - 24, lastCatch.monster ? 64 : 56, false);
    else {
      const sc = lastCatch.monster ? 6 : 5;
      const sw = spriteW(lastCatch.shape) * sc;
      drawSprite(cx, lastCatch.shape, lastCatch.col, (W - sw) / 2, oy + 6, sc, false);
    }
    if (lastCatch.isNew) {
      px(W / 2 - 17, 4, 34, 11, UI.gold);
      cx.fillStyle = UI.ink; cx.font = 'bold 8px monospace'; cx.textBaseline = 'top'; cx.textAlign = 'center';
      cx.fillText('NEW!', W / 2, 6); cx.textAlign = 'left';
    }
  }

  // particles + floaters (cosmetic, frame-stepped)
  for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life--; px(p.x, p.y, p.s, p.s, p.c); }
  particles = particles.filter(p => p.life > 0);
  if (floaters.length) {
    cx.font = 'bold 8px monospace'; cx.textBaseline = 'middle'; cx.textAlign = 'center';
    for (const fl of floaters) {
      fl.y -= 0.5; fl.life--;
      cx.fillStyle = UI.ink; cx.fillText(fl.text, fl.x + 1, fl.y + 1);
      cx.fillStyle = fl.color; cx.fillText(fl.text, fl.x, fl.y);
    }
    cx.textAlign = 'left';
    floaters = floaters.filter(f2 => f2.life > 0);
  }

  // message banner
  cx.fillStyle = UI.ink; cx.fillRect(0, H - 16, W, 16);
  cx.fillStyle = UI.paper; cx.font = '8px monospace'; cx.textBaseline = 'middle'; cx.textAlign = 'left';
  cx.fillText(msg, 4, H - 8);
}

// ── Boot / window plumbing ────────────────────────────────────────────────────
// Zone selector — deeper zones unlock with Fishing level.
function renderZones() {
  if (!zoneEl) return;
  const l = lvl();
  zoneEl.innerHTML = '';
  ZONES.forEach((z, i) => {
    const unlocked = l >= z.lvl;
    const b = document.createElement('button');
    b.className = 'gbc-btn';
    b.disabled = !unlocked;
    b.textContent = unlocked ? z.name : `🔒 ${z.name} · Lv${z.lvl}`;
    if (i === curZone) { b.style.fontWeight = 'bold'; b.style.outline = '2px solid ' + UI.gold; }
    b.addEventListener('click', () => {
      if (!unlocked || i === curZone) return;
      curZone = i; try { localStorage.setItem('aq_fishing_zone', String(i)); window.aqGamePersist && window.aqGamePersist('aq_fishing_zone'); } catch (e) {}
      seedAmbients();
      stopHookWave();
      state = 'idle'; msg = 'Press CAST to fish'; fish = null; S = null; nibbles = [];
      renderZones(); refreshInfo();
    });
    zoneEl.appendChild(b);
  });
}

// Rod shop — buy the next rod to hook rarer fish.
function renderRodShop() {
  if (!rodEl) return;
  const tier = rodTier();
  rodEl.innerHTML = '';
  if (tier >= RODS.length - 1) {
    const d = document.createElement('div'); d.className = 'gbc-info'; d.textContent = 'Best rod: ' + RODS[tier].name + ' 🎣';
    rodEl.appendChild(d); return;
  }
  const next = RODS[tier + 1];
  const btn = document.createElement('button'); btn.className = 'gbc-btn';
  btn.disabled = credits() < next.cost;
  btn.textContent = `Buy ${next.name} rod 💰${next.cost} — more bites · rarer fish · easier fights`;
  btn.addEventListener('click', () => {
    if (credits() < next.cost) return;
    if (typeof window.aqSetCredits === 'function') window.aqSetCredits(credits() - next.cost);
    localStorage.setItem('aq_fishing_rod', String(tier + 1));
    if (window.aqGamePersist) window.aqGamePersist('aq_fishing_rod');
    sfx('tick'); refreshInfo();
  });
  rodEl.appendChild(btn);
}

// Fish-o-pedia — every fish, its sprite, and how many you've caught.
function renderDex() {
  if (!dexEl) return;
  const caught = readCaught();
  const total = FISH.length;
  const got = FISH.filter(f => (caught[f.name] | 0) > 0).length;
  dexEl.innerHTML = `<div class="fish-dex-head">📖 Fish-o-pedia — ${got}/${total} species</div>`;
  ZONES.forEach((z, zi) => {
    const zfish = FISH.filter(f => f.zone === zi);
    const sec = document.createElement('div'); sec.className = 'fish-dex-zone';
    sec.innerHTML = `<div class="fish-dex-zname">${z.name}</div>`;
    const grid = document.createElement('div'); grid.className = 'fish-dex-grid';
    zfish.forEach(f => {
      const n = caught[f.name] | 0, seen = n > 0;
      const cell = document.createElement('div'); cell.className = 'fish-dex-cell';
      const c = document.createElement('canvas'); c.width = 60; c.height = 38; c.className = 'fish-dex-spr';
      const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false;
      const im = fishImg(f.img);
      if (im) {
        drawFishImg(ctx, im, 2, 2, 56, 34, !seen);
      } else {
        const sc = 3, sw = spriteW(f.shape) * sc;
        drawSprite(ctx, f.shape, f.col, (60 - sw) / 2, 4, sc, !seen);
      }
      cell.appendChild(c);
      const lab = document.createElement('div'); lab.className = 'fish-dex-lab';
      lab.innerHTML = seen ? `${f.name}<span>×${n}</span>` : `???<span>—</span>`;
      cell.appendChild(lab);
      // Caught fish can be released onto the desktop as a singing, flopping pet.
      if (seen && typeof window.aqFishpetToggle === 'function') {
        const out = !!(window.aqFishpetHas && window.aqFishpetHas(f.name));
        const btn = document.createElement('button');
        btn.className = 'fish-dex-pet' + (out ? ' on' : '');
        btn.textContent = out ? '🖥️ on desktop' : '🐟 to desktop';
        btn.onclick = () => { window.aqFishpetToggle(f.name); renderDex(); };
        cell.appendChild(btn);
      }
      grid.appendChild(cell);
    });
    sec.appendChild(grid); dexEl.appendChild(sec);
  });
}

function build() {
  const area = document.getElementById('fishing-area');
  if (!area) return;
  area.innerHTML = '';
  const stage = document.createElement('div'); stage.className = 'gbc-stage';
  cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.className = 'gbc-canvas';
  stage.appendChild(cv); area.appendChild(stage);

  dexEl = document.createElement('div'); dexEl.className = 'fish-dex'; dexEl.style.display = 'none';
  area.appendChild(dexEl);

  const bar = document.createElement('div'); bar.className = 'gbc-bar';
  const btn = document.createElement('button'); btn.className = 'gbc-btn'; btn.textContent = '🎣 CAST / REEL';
  bar.appendChild(btn);
  const dexBtn = document.createElement('button'); dexBtn.className = 'gbc-btn'; dexBtn.textContent = '📖 Fish';
  bar.appendChild(dexBtn);
  _fishInfo = document.createElement('div'); _fishInfo.className = 'gbc-info'; bar.appendChild(_fishInfo);
  area.appendChild(bar);

  zoneEl = document.createElement('div'); zoneEl.className = 'gbc-bar'; area.appendChild(zoneEl);
  rodEl = document.createElement('div'); rodEl.className = 'gbc-bar'; area.appendChild(rodEl);

  cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
  const down = (e) => { e.preventDefault(); press(); };
  cv.addEventListener('pointerdown', down, { passive: false });
  btn.addEventListener('pointerdown', down, { passive: false });
  dexBtn.addEventListener('click', () => {
    dexOpen = !dexOpen;
    dexEl.style.display = dexOpen ? 'block' : 'none';
    stage.style.display = dexOpen ? 'none' : '';
    dexBtn.textContent = dexOpen ? '🎣 Back' : '📖 Fish';
    if (dexOpen) renderDex();
  });
  if (!window._fishKeyBound) {
    window._fishKeyBound = true;
    window.addEventListener('keydown', (e) => {
      const w = document.getElementById('fishing-wrap');
      if (e.code === 'Space' && w && w.classList.contains('open') &&
          (!window.aqIsActiveApp || window.aqIsActiveApp('fishing'))) { e.preventDefault(); press(); }
    });
  }
  _built = true;
}

function refreshInfo() {
  if (_fishInfo) _fishInfo.textContent = `Lv ${lvl()} · ${RODS[rodTier()].name} rod · 💰 ${credits()}`;
  renderZones();
  renderRodShop();
}

function openFishing(show = true) {
  const w = document.getElementById('fishing-wrap');
  if (!w) return;
  if (show === false) {
    w.classList.remove('open'); w.style.display = 'none';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    clearInterval(window._fishInfoT);
    stopHookWave();
    sfx('wave-stop');
    return;
  }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('fishing'); window.OS.focus('fishing'); }
  if (!_built) build();
  curZone = Math.min(maxZone(), parseInt(localStorage.getItem('aq_fishing_zone') || '0', 10) || 0);
  dexOpen = false; if (dexEl) dexEl.style.display = 'none';
  stopHookWave();
  state = 'idle'; msg = 'Press CAST to fish'; fish = null; S = null; nibbles = [];
  rollCondition(); _castCount = 0;
  seedAmbients();
  refreshInfo();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
  clearInterval(window._fishInfoT);
  window._fishInfoT = setInterval(refreshInfo, 1000);
}

if (typeof window !== 'undefined') {
  window.openFishing = openFishing;
  // test hook: lets the headless harness drive the state machine without exports
  if (window.__fishTestHook) window.__fishTestHook({
    snap: () => ({ state, S, fish, msg, streak, curZone }),
    press, setFish: f => { fish = f; }, setZone: z => { curZone = z; },
    enterStruggle, tapStruggle, FISH, MONSTERS, pickFish,
  });
  // Desktop fish-pets bridge: look up any caught fish's sprite + draw it the same way.
  const _allFish = FISH.concat(MONSTERS);
  window.aqFishDef = (name) => _allFish.find(f => f.name === name) || null;
  window.aqFishCaught = readCaught;
  window.aqDrawFishSprite = (ctx, shape, col, ox, oy, scale) => drawSprite(ctx, shape, col, ox, oy, scale, false);
  window.aqFishSpriteDims = (shape) => { const r = SHAPES[shape] || SHAPES.classic; return { w: r[0].length, h: r.length }; };
  // Cloud game-save may resolve after the window is open — re-read restored rod/zone.
  window.addEventListener('aq-gamedata-synced', () => {
    const w = document.getElementById('fishing-wrap');
    if (!w || !w.classList.contains('open')) return;
    curZone = Math.min(maxZone(), parseInt(localStorage.getItem('aq_fishing_zone') || '0', 10) || 0);
    refreshInfo();
  });
}
