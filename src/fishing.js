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

const FISH = [
  { name: 'Minnow',    rarity: 0, value: 4,   color: 1 },
  { name: 'Bass',      rarity: 1, value: 9,   color: 2 },
  { name: 'Pike',      rarity: 1, value: 14,  color: 2 },
  { name: 'Catfish',   rarity: 2, value: 22,  color: 1 },
  { name: 'Pufferfish',rarity: 2, value: 30,  color: 3 },
  { name: 'Eel',       rarity: 3, value: 45,  color: 0 },
  { name: 'Legendary', rarity: 4, value: 120, color: 3 },
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
const MONSTER = { name: 'Leviathan', rarity: 5, value: 400, color: 0, monster: true };
const STYLE_LABEL = { steady: '', darter: 'darter!', lunger: 'lunger!', drifter: 'drifter!', thrasher: 'thrasher!', monster: 'LEVIATHAN' };
// ────────────────────────────────────────────────────────────────────────────

let cv = null, cx = null, raf = null, _built = false, _fishInfo = null;
let state = 'idle';   // idle | casting | waiting | bite | struggle | caught | miss | scared
let msg = 'Press CAST to fish';
let fish = null;      // the fish currently on the line / being fought

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

function pickFish() {
  const luck = Math.random() + lvl() / 300;  // higher level nudges toward rarer fish
  let pool;
  if (luck > 1.15) pool = FISH.filter(f => f.rarity >= 3);
  else if (luck > 0.8) pool = FISH.filter(f => f.rarity >= 1 && f.rarity <= 3);
  else pool = FISH.filter(f => f.rarity <= 1);
  return pool[(Math.random() * pool.length) | 0] || FISH[0];
}

// ── State transitions ───────────────────────────────────────────────────────
function startCast() {
  state = 'casting';
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
  fish = monster ? MONSTER : pickFish();
  state = 'bite';
  // per-cast reaction-window jitter × water condition
  const jitter = 0.8 + Math.random() * 0.4;
  let win = (BITE_WINDOW_BASE - fish.rarity * BITE_WINDOW_PER) * condition.windowMult * jitter;
  if (monster) win *= 0.9;
  biteWindowEnd = now + Math.max(260, win);
  msg = monster ? '🐋 MONSTER! REEL!' : '! DING — REEL NOW !';
  sfx(monster ? 'monster' : 'ding');
}

function enterStruggle(now) {
  const monster = !!(fish && fish.monster);
  sfx(monster ? 'monster' : 'hook');
  const r = fish.rarity, c = condition;
  // per-cast jitter so even the same fish varies cast-to-cast
  const jv = 0.8 + Math.random() * 0.45;   // marker speed
  const jz = 0.8 + Math.random() * 0.4;    // zone width
  let need = Math.max(2, Math.min(4, 2 + r + (Math.random() < 0.35 ? 1 : 0) - (Math.random() < 0.25 ? 1 : 0)));
  let markerV = (1.5 + r * 0.55) * c.speedMult * jv;
  let zoneW = Math.max(9, (30 - r * 4) * c.zoneMult * jz);
  let totalMs = Math.max(2600, (STRUGGLE_MS_BASE - r * STRUGGLE_MS_PER) * (0.85 + Math.random() * 0.4));
  let maxMiss = r >= 3 ? 0 : 1;
  let style = monster ? 'monster' : pickStyle(r);
  if (monster) { markerV *= 1.45; zoneW = Math.max(10, zoneW * 0.85); need = Math.min(6, need + 2); totalMs *= 1.5; maxMiss = 0; }
  markerV = Math.min(6.2, markerV);   // keep the marker from skipping past the zone between frames
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
  msg = (f.monster ? '🐋 LANDED THE LEVIATHAN! ' : `Caught a ${f.name}! `) + `+${value}💰` + (perfect ? ' ✨perfect' : '');
  sfx('wave-stop');
  if (typeof window.playFanfare === 'function') window.playFanfare(f.monster ? 'jackpot' : 'small');
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(value);
  // XP comes ONLY from landing a fish (never from playing/missing).
  if (typeof window.aqGameXp === 'function') window.aqGameXp('fishing', { played: false, won: true, mult: (0.7 + f.rarity * 0.5) * (perfect ? 1.2 : 1) });
  if (typeof window.recordScore === 'function') window.recordScore('fishing', value, f.name);
  try {
    const log = JSON.parse(localStorage.getItem('aq_fishing_log') || '[]');
    log.unshift({ name: f.name, value, ts: Date.now() });
    localStorage.setItem('aq_fishing_log', JSON.stringify(log.slice(0, 50)));
  } catch (e) {}
  fish = null; S = null;
}

function missFish(reason) {
  state = 'miss';
  msg = reason || 'It got away…';
  sfx('fail'); sfx('wave-stop');
  // no XP for misses — only catches count
  fish = null; S = null;
}

function scareFish() {
  state = 'scared';
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
    S.markerV = Math.min(6.5, S.markerV * 1.12);   // speed up each hit (capped)
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
      if (Math.random() < 0.05 * f) S.dir *= (Math.random() < 0.35 ? -1 : 1);
      v *= 0.65 + Math.random() * 0.95;
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
      S.zoneW = Math.max(9, S.zoneW0 * (1 - Math.min(0.55, elapsed / S.totalMs)));
      if (S.zoneX > 100 - S.zoneW) S.zoneX = Math.max(0, 100 - S.zoneW);
    }
    if (now > S.endAt) missFish('It wore you out…');
  }

  draw(now);
  raf = requestAnimationFrame(tick);
}

// ── Drawing ───────────────────────────────────────────────────────────────────
function px(x, y, w, h, color) { cx.fillStyle = PAL[color] || color; cx.fillRect(x | 0, y | 0, w | 0, h | 0); }

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

  // message banner
  cx.fillStyle = PAL[0]; cx.fillRect(0, H - 16, W, 16);
  cx.fillStyle = PAL[3]; cx.font = '8px monospace'; cx.textBaseline = 'middle';
  cx.fillText(msg, 4, H - 8);
}

// ── Boot / window plumbing ────────────────────────────────────────────────────
function build() {
  const area = document.getElementById('fishing-area');
  if (!area) return;
  area.innerHTML = '';
  const stage = document.createElement('div'); stage.className = 'gbc-stage';
  cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.className = 'gbc-canvas';
  stage.appendChild(cv); area.appendChild(stage);

  const bar = document.createElement('div'); bar.className = 'gbc-bar';
  const btn = document.createElement('button'); btn.className = 'gbc-btn'; btn.textContent = '🎣 CAST / REEL';
  bar.appendChild(btn);
  _fishInfo = document.createElement('div'); _fishInfo.className = 'gbc-info'; bar.appendChild(_fishInfo);
  area.appendChild(bar);

  cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
  const down = (e) => { e.preventDefault(); press(); };
  cv.addEventListener('pointerdown', down);
  btn.addEventListener('pointerdown', down);
  if (!window._fishKeyBound) {
    window._fishKeyBound = true;
    window.addEventListener('keydown', (e) => {
      const w = document.getElementById('fishing-wrap');
      if (e.code === 'Space' && w && w.classList.contains('open')) { e.preventDefault(); press(); }
    });
  }
  _built = true;
}

function refreshInfo() { if (_fishInfo) _fishInfo.textContent = `Lv ${lvl()} · 💰 ${credits()}`; }

function openFishing(show = true) {
  const w = document.getElementById('fishing-wrap');
  if (!w) return;
  if (show === false) {
    w.classList.remove('open'); w.style.display = 'none';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    clearInterval(window._fishInfoT);
    sfx('wave-stop');
    return;
  }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('fishing'); window.OS.focus('fishing'); }
  if (!_built) build();
  state = 'idle'; msg = 'Press CAST to fish'; fish = null; S = null; nibbles = [];
  rollCondition(); _castCount = 0;
  refreshInfo();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
  clearInterval(window._fishInfoT);
  window._fishInfoT = setInterval(refreshInfo, 1000);
}

if (typeof window !== 'undefined') { window.openFishing = openFishing; }
