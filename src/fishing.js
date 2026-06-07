// Aquatune Fishing — a Game Boy Color–styled patience/timing fishing game.
//
// Loop: CAST → wait (patiently, while a lo-fi bitcrushed water ambient plays) →
// a fish bites with a "DING!" and the bobber plunges → you have a SMALL window to
// hit reel → then a short multi-tap "struggle" (tap the sweeping marker in the
// green) lands the fish. Reeling early (mashing) scares the fish. Audio cues live
// in index.html as window.fishingSfx; visuals are a chunky pixel canvas.

const W = 160, H = 144;                 // GBC native-ish resolution
const PAL = ['#0f380f', '#306850', '#7ba672', '#cfe8a0']; // dark → light
const SKY = '#9bbc0f', WATER = '#306850';
const WATER_Y = 58;

// Zones unlock as your Fishing level climbs — deeper waters, rarer fish.
const ZONES = [
  { name: '🏞️ River', lvl: 1 },
  { name: '🌊 Ocean', lvl: 12 },
  { name: '🥬 Swamp', lvl: 30 },
  { name: '🔥 Hell',  lvl: 55 },
];
// Rods are bought with credits; a better rod hooks the rarer fish in each zone.
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

// zone: which water it lives in · rod: minimum rod tier needed to hook it ·
// shape/col: its pixel sprite. Catch it and it joins your Fish-o-pedia.
const FISH = [
  // River (zone 0)
  { name: 'Minnow',        zone: 0, rarity: 0, value: 4,   rod: 0, shape: 'classic', col: '#bcd0c0' },
  { name: 'Bass',          zone: 0, rarity: 1, value: 10,  rod: 0, shape: 'classic', col: '#6fae5a' },
  { name: 'Pike',          zone: 0, rarity: 1, value: 18,  rod: 1, shape: 'long',    col: '#5a8a3a' },
  { name: 'Rainbow Trout', zone: 0, rarity: 2, value: 30,  rod: 2, shape: 'classic', col: '#d98f5a' },
  { name: 'Golden Carp',   zone: 0, rarity: 3, value: 75,  rod: 3, shape: 'round',   col: '#e8c000' },
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
const BITE_WINDOW_BASE = 640, BITE_WINDOW_PER = 78;   // reaction window (ms), −per rarity
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
  // Only fish in the current zone you can hook with your rod tier.
  const pool = FISH.filter(f => f.zone === curZone && f.rod <= rodTier());
  if (!pool.length) return FISH[0];
  const luck = Math.random() + lvl() / 300;   // higher level nudges toward rarer fish
  let total = 0;
  const w = pool.map(f => { const x = Math.max(0.15, 1 - f.rarity * 0.16) * (1 + luck * f.rarity * 0.45); total += x; return x; });
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
  const wait = (WAIT_MIN + Math.random() * WAIT_RAND - Math.min(2500, lvl() * 25)) * condition.waitMult;
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
  const jitter = 0.8 + Math.random() * 0.4;
  let win = (BITE_WINDOW_BASE - fish.rarity * BITE_WINDOW_PER) * condition.windowMult * jitter;
  if (monster) win *= 0.9;
  biteWindowEnd = now + Math.max(260, win);
  msg = monster ? '🐋 MONSTER! REEL!' : '! DING — REEL NOW !';
  sfx(monster ? 'monster' : 'ding');
  // Fish is now on the line → start the bitcrushed wave loop.
  startHookWave(fish ? fish.rarity : 0);
}

function enterStruggle(now) {
  const monster = !!(fish && fish.monster);
  sfx(monster ? 'monster' : 'hook');
  const r = fish.rarity, c = condition;
  // per-cast jitter so even the same fish varies cast-to-cast
  const jv = 0.8 + Math.random() * 0.45;   // marker speed
  const jz = 0.8 + Math.random() * 0.4;    // zone width
  let need = Math.max(2, Math.min(4, 2 + r + (Math.random() < 0.35 ? 1 : 0) - (Math.random() < 0.25 ? 1 : 0)));
  // Marker speed scales gentler with rarity than before (was 1.5 + r*0.55) so
  // the hardest fish stay challenging but actually trackable frame-to-frame.
  let markerV = (1.5 + r * 0.42) * c.speedMult * jv;
  let zoneW = Math.max(11, (30 - r * 3.4) * c.zoneMult * jz);   // slightly wider green for rare fish
  let totalMs = Math.max(2600, (STRUGGLE_MS_BASE - r * STRUGGLE_MS_PER) * (0.85 + Math.random() * 0.4));
  let maxMiss = r >= 4 ? 0 : 1;        // only the very rarest are sudden-death
  let style = monster ? 'monster' : pickStyle(r);
  // Monsters: still the toughest fight, but landable. Was a brutal 1.45× speed +
  // shrinking 0.85 zone + sudden-death; now a milder speed bump, kept zone, and
  // one allowed miss with more time.
  if (monster) { markerV *= 1.15; zoneW = Math.max(13, zoneW * 0.95); need = Math.min(5, need + 1); totalMs *= 1.6; maxMiss = 1; }
  // Cap so the marker can't skip past the zone between frames (lowered 6.2→5.2).
  markerV = Math.min(5.2, markerV);
  S = {
    need, hits: 0, misses: 0, maxMiss, style, monster,
    markerX: 0, markerV, dir: 1,
    zoneW, zoneW0: zoneW, zoneX: 0,
    zoneVX: (style === 'drifter' || style === 'monster') ? (Math.random() < 0.5 ? -1 : 1) * (0.4 + Math.random() * 0.45) : 0,
    totalMs, endAt: now + totalMs, t0: now,
  };
  rerollZone();
  state = 'struggle';
  msg = (monster ? '🐋 ' : '') + 'Reel! ' + (STYLE_LABEL[style] || 'tap on green');
}
function rerollZone() { if (S) S.zoneX = Math.random() * Math.max(0, 100 - S.zoneW); }

function landFish(now) {
  const f = fish, perfect = S && S.misses === 0;
  const value = Math.round(f.value * (perfect ? 1.25 : 1));
  state = 'caught';
  stopHookWave();
  msg = (f.monster ? '🐋 LANDED THE LEVIATHAN! ' : `Caught a ${f.name}! `) + `+${value}💰` + (perfect ? ' ✨perfect' : '');
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
    window.aqGameXp('fishing', { played: false, won: true, mult: rarityMult * (perfect ? 1.25 : 1) });
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
  lastCatch = { shape: f.shape, col: f.col, name: f.name, monster: !!f.monster };
  recordCaught(f.name);
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
  stopHookWave();
  msg = reason || 'It got away…';
  sfx('fail'); sfx('wave-stop');
  // no XP for misses — only catches count
  fish = null; S = null;
}

function scareFish() {
  state = 'scared';
  stopHookWave();
  msg = 'You scared it off! Patience…';
  sfx('fail'); sfx('wave-stop');
  fish = null; S = null; nibbles = [];
}

function tapStruggle() {
  if (!S) return;
  const inZone = S.markerX >= S.zoneX && S.markerX <= S.zoneX + S.zoneW;
  if (inZone) {
    S.hits++; sfx('tick');
    if (S.hits >= S.need) { landFish(performance.now()); return; }
    rerollZone();
    S.markerV = Math.min(5.6, S.markerV * 1.10);   // speed up each hit (capped)
  } else {
    S.misses++; sfx('buzz');
    if (S.misses > S.maxMiss) { missFish('Line snapped!'); return; }
  }
}

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
    if (style === 'darter' || style === 'monster') {            // jittery: flicker speed, random flips
      // Softer than before (was 0.65 + rand*0.95 with 35% double-flips): the
      // marker still wavers but stays trackable instead of teleporting.
      if (Math.random() < 0.035 * f) S.dir *= (Math.random() < 0.25 ? -1 : 1);
      v *= 0.7 + Math.random() * 0.6;
    }
    if (style === 'lunger') v *= 0.6 + Math.max(0, Math.sin(elapsed / 300)) * 1.7;  // speed bursts
    S.markerX += v * S.dir * f;
    if (S.markerX <= 0) { S.markerX = 0; S.dir = 1; }
    if (S.markerX >= 100) { S.markerX = 100; S.dir = -1; }
    if (S.zoneVX) {                                              // drifter/monster: moving green zone
      S.zoneX += S.zoneVX * f;
      const maxX = Math.max(0, 100 - S.zoneW);
      if (S.zoneX <= 0) { S.zoneX = 0; S.zoneVX = Math.abs(S.zoneVX); }
      if (S.zoneX >= maxX) { S.zoneX = maxX; S.zoneVX = -Math.abs(S.zoneVX); }
    }
    if (style === 'thrasher' || style === 'monster') {          // shrinking green zone
      // Shrink less aggressively (cap 0.55→0.40, floor 9→12) so the target
      // never collapses to an untappable sliver near the end of the fight.
      S.zoneW = Math.max(12, S.zoneW0 * (1 - Math.min(0.40, elapsed / S.totalMs)));
      if (S.zoneX > 100 - S.zoneW) S.zoneX = Math.max(0, 100 - S.zoneW);
    }
    if (now > S.endAt) missFish('It wore you out…');
  }

  draw(now);
  raf = requestAnimationFrame(tick);
}

// ── Drawing ───────────────────────────────────────────────────────────────────
function px(x, y, w, h, color) { cx.fillStyle = PAL[color] || color; cx.fillRect(x | 0, y | 0, w | 0, h | 0); }

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
      if (silhouette) c = (ch === 'o') ? '#1a2a14' : '#2e4226';
      else if (ch === 'o') c = '#0f380f';
      else if (ch === 'l') c = '#eaffd0';
      else if (ch === 'e') c = '#0f380f';
      else c = col;
      ctx.fillStyle = c;
      ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
    }
  }
}
function spriteW(shape) { return (SHAPES[shape] || SHAPES.classic)[0].length; }

function draw(t) {
  if (!cx) return;
  cx.fillStyle = SKY; cx.fillRect(0, 0, W, WATER_Y);
  cx.fillStyle = WATER; cx.fillRect(0, WATER_Y, W, H - WATER_Y);
  // water-condition label (top-right)
  cx.fillStyle = PAL[0]; cx.font = '8px monospace'; cx.textBaseline = 'top'; cx.textAlign = 'right';
  cx.fillText(condition.name, W - 3, 3); cx.textAlign = 'left';
  // animated wave lines
  cx.fillStyle = PAL[2];
  for (let y = WATER_Y + 8; y < H - 16; y += 12) {
    const off = ((t / 70) + y) % 12 | 0;
    for (let x = -12 + off; x < W; x += 12) cx.fillRect(x, y, 5, 1);
  }
  // dock + rod
  px(0, WATER_Y - 14, 40, 14, 0);
  px(34, WATER_Y - 40, 3, 30, 0);                 // rod
  const rodTip = { x: 37, y: WATER_Y - 38 };

  // bobber position depends on state
  const bx = 100;
  let by = WATER_Y - 2;
  if (state === 'idle' || state === 'caught' || state === 'miss' || state === 'scared') by = WATER_Y - 2;
  else if (state === 'casting') { const p = 1 - Math.max(0, (castUntil - t) / CAST_MS); by = WATER_Y - 2; }
  else if (state === 'waiting') {
    by = WATER_Y - 1 + Math.sin(t / 320) * 2;
    if (t < nibbleFlashUntil) by += (Math.random() * 2 - 1) * 3;  // twitch
  } else if (state === 'bite') by = WATER_Y + 10;                 // yanked under

  // line
  cx.strokeStyle = PAL[3]; cx.beginPath(); cx.moveTo(rodTip.x, rodTip.y); cx.lineTo(bx + 2, by); cx.stroke();
  // bobber
  px(bx, by, 6, 6, 0); px(bx + 1, by + 1, 4, 2, 3);
  if (state === 'bite') { px(bx - 1, by - 9, 2, 6, 3); px(bx + 5, by - 9, 2, 6, 3); } // splash
  if (t < nibbleFlashUntil && state === 'waiting') { px(bx - 3, by - 4, 2, 2, 3); px(bx + 7, by - 3, 2, 2, 3); }

  // bite reaction window meter (urgency)
  if (state === 'bite') {
    const total = Math.max(280, BITE_WINDOW_BASE - (fish ? fish.rarity : 0) * BITE_WINDOW_PER);
    const left = Math.max(0, (biteWindowEnd - t) / total);
    px(30, 30, 100, 8, 0); px(31, 31, 98 * left, 6, 3);
    cx.fillStyle = PAL[0]; cx.font = '8px monospace'; cx.textBaseline = 'top'; cx.fillText('REEL!', 64, 21);
  }

  // struggle UI
  if (state === 'struggle' && S) {
    const mx = 14, mw = 132, my = 70, mh = 14;
    px(mx - 2, my - 2, mw + 4, mh + 4, 0);   // frame
    px(mx, my, mw, mh, 1);                    // track
    px(mx + (S.zoneX / 100) * mw, my, (S.zoneW / 100) * mw, mh, 2);  // green zone
    const markPx = mx + (S.markerX / 100) * mw;
    px(markPx - 1, my - 3, 3, mh + 6, 3);    // marker
    // hit pips
    for (let i = 0; i < S.need; i++) px(mx + i * 9, my + mh + 6, 7, 5, i < S.hits ? 3 : 1);
    // time bar
    px(mx, my - 12, mw, 4, 0);
    const tl = Math.max(0, Math.min(1, (S.endAt - t) / S.totalMs));
    px(mx, my - 11, mw * tl, 2, 3);
  }

  // caught! — show the fish's pixel sprite leaping above the water
  if (state === 'caught' && lastCatch) {
    const sc = lastCatch.monster ? 6 : 5;
    const sw = spriteW(lastCatch.shape) * sc;
    const ox = (W - sw) / 2, oy = 20 + Math.sin(t / 160) * 2;
    drawSprite(cx, lastCatch.shape, lastCatch.col, ox, oy, sc, false);
  }

  // message banner
  cx.fillStyle = PAL[0]; cx.fillRect(0, H - 16, W, 16);
  cx.fillStyle = PAL[3]; cx.font = '8px monospace'; cx.textBaseline = 'middle';
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
    if (i === curZone) { b.style.fontWeight = 'bold'; b.style.outline = '2px solid ' + PAL[3]; }
    b.addEventListener('click', () => {
      if (!unlocked || i === curZone) return;
      curZone = i; try { localStorage.setItem('aq_fishing_zone', String(i)); window.aqGamePersist && window.aqGamePersist('aq_fishing_zone'); } catch (e) {}
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
  btn.textContent = `Buy ${next.name} rod  💰${next.cost}`;
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
      const sc = 3, sw = spriteW(f.shape) * sc;
      drawSprite(ctx, f.shape, f.col, (60 - sw) / 2, 4, sc, !seen);
      cell.appendChild(c);
      const lab = document.createElement('div'); lab.className = 'fish-dex-lab';
      lab.innerHTML = seen ? `${f.name}<span>×${n}</span>` : `???<span>—</span>`;
      cell.appendChild(lab);
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
      if (e.code === 'Space' && w && w.classList.contains('open')) { e.preventDefault(); press(); }
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
  refreshInfo();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
  clearInterval(window._fishInfoT);
  window._fishInfoT = setInterval(refreshInfo, 1000);
}

if (typeof window !== 'undefined') {
  window.openFishing = openFishing;
  // Cloud game-save may resolve after the window is open — re-read restored rod/zone.
  window.addEventListener('aq-gamedata-synced', () => {
    const w = document.getElementById('fishing-wrap');
    if (!w || !w.classList.contains('open')) return;
    curZone = Math.min(maxZone(), parseInt(localStorage.getItem('aq_fishing_zone') || '0', 10) || 0);
    refreshInfo();
  });
}
