// Aquatune Mining — a Game Boy Color–styled click-the-rock miner.
//
// Whack the rock with your pickaxe; each hit deals damage = current pick power.
// Break it to earn ore (credits + Mining XP), then a fresh rock (sometimes a
// rarer, richer one) spawns. Spend credits to upgrade your pickaxe through tiers.

const W = 160, H = 144;
const PAL = ['#0f380f', '#306850', '#7ba672', '#cfe8a0'];

const PICKS = [
  { name: 'Wooden',   power: 1,  cost: 0 },
  { name: 'Stone',    power: 2,  cost: 150 },
  { name: 'Iron',     power: 4,  cost: 600 },
  { name: 'Gold',     power: 7,  cost: 2000 },
  { name: 'Diamond',  power: 12, cost: 7000 },
  { name: 'Aquatune', power: 20, cost: 25000 },
];

// Stages unlock with Mining level — deeper = harder rocks & richer resources.
const STAGES = [
  { name: 'Surface',      lvl: 1 },
  { name: 'Caverns',      lvl: 8 },
  { name: 'Deep Mine',    lvl: 20 },
  { name: 'Magma Vein',   lvl: 38 },
  { name: 'Crystal Core', lvl: 60 },
];

// base = body tone (PAL index), ore = embedded-speck tone, gem = sparkles,
// stage = which stage it spawns in, weight = pick weight within that stage.
const ROCKS = [
  // Surface
  { name: 'Stone',    stage: 0, hp: 24,   value: 2,   rarity: 0, base: 1, ore: 0, gem: false, weight: 60 },
  { name: 'Copper',   stage: 0, hp: 55,   value: 5,   rarity: 1, base: 1, ore: 2, gem: false, weight: 40 },
  // Caverns
  { name: 'Coal',     stage: 1, hp: 80,   value: 8,   rarity: 1, base: 0, ore: 0, gem: false, weight: 58 },
  { name: 'Iron',     stage: 1, hp: 120,  value: 13,  rarity: 1, base: 2, ore: 0, gem: false, weight: 42 },
  // Deep Mine
  { name: 'Gold',     stage: 2, hp: 200,  value: 26,  rarity: 2, base: 1, ore: 3, gem: true,  weight: 58 },
  { name: 'Emerald',  stage: 2, hp: 320,  value: 48,  rarity: 3, base: 2, ore: 3, gem: true,  weight: 42 },
  // Magma Vein
  { name: 'Ruby',     stage: 3, hp: 480,  value: 90,  rarity: 3, base: 2, ore: 3, gem: true,  weight: 56 },
  { name: 'Obsidian', stage: 3, hp: 620,  value: 120, rarity: 4, base: 0, ore: 2, gem: false, weight: 44 },
  // Crystal Core
  { name: 'Diamond',  stage: 4, hp: 820,  value: 200, rarity: 4, base: 2, ore: 3, gem: true,  weight: 58 },
  { name: 'Aquatune', stage: 4, hp: 1300, value: 340, rarity: 4, base: 3, ore: 3, gem: true,  weight: 42 },
];

// rock geometry
const CXR = 80, CYR = 72, RW = 30, RH = 24;

// ── spice dials ──────────────────────────────────────────────────────────────
// Crits are a rare CHAIN: a tap-point appears on an (invisible) circle around the
// rock; tap it and the next appears further around the circle, and so on. The chain
// length is random (it doesn't always complete the circle) — the more points you
// tap, the more damage AND the more Mining XP you get at the end of the chain.
const CRIT_POINT_MULT = 2.5;         // damage per tap-point hit (× pick power)
const POINT_MS = 1100;               // time to tap each point before the chain breaks
const SEQ_MIN = 2, SEQ_RAND = 6;     // chain length 2..8 points
// Weak-points now appear OFTEN and at random spots across the rock face. Most of your
// XP/credits come from chaining them — so skilled, aimed tapping vastly out-earns
// mindless spamming (and a fixed-position auto-clicker can't catch a roaming target).
const CRIT_GAP_MIN = 650, CRIT_GAP_RAND = 850;     // short random delay between chains
const MOTHERLODE_CHANCE = 0.03;      // per rock break (when not already active)
const MOTHERLODE_MS = 10000;         // frenzy duration
const MOTHERLODE_ORE = 2, MOTHERLODE_POWER = 2;
// Ore-vein event: chained weak-point hits fill a meter; when full a ~7s frenzy of
// rapid random targets pays out big. Depth meter fills from skill (not raw clicks);
// fill it to Delve Deeper (prestige) for a permanent bonus.
const VEIN_NEED = 14;                // weak-point hits to charge a vein
const VEIN_MS = 7000;                // vein frenzy duration
const VEIN_POINT_MS = 620;           // faster targets during a vein
const DEPTH_MAX = 600;               // skill points to fill the depth bar (then prestige)
const XP_CAP = 2.5;                  // cap on any single mining XP grant's mult
// ── auto-clicker guard ───────────────────────────────────────────────────────
// Auto-clickers fire at a machine-regular cadence no human can match: fast AND
// with almost no timing jitter. If the last several clicks look robotic, lock the
// player out of mining for 10 minutes (persisted, so a reload doesn't dodge it).
const LOCK_MS = 10 * 60 * 1000;      // 10-minute lockout
const LOCK_KEY = 'aq_mining_lock_until';
const CLK_WINDOW = 40;               // clicks examined for cadence
const CLK_MIN = 24;                  // need a long sustained run before judging (fast human bursts are short)
const CLK_MIN_TOUCH = 36;            // touch taps are rhythmic — require an even longer run before judging
// ────────────────────────────────────────────────────────────────────────────

let cv = null, cx = null, raf = null, _built = false;
let rock = null, swing = 0, shake = 0, particles = [];
let breakUntil = 0;
let floaters = [], sweet = null, sweetNextAt = 0, motherlodeUntil = 0;
let seq = null, seqHits = 0;         // active crit chain + how many points tapped so far
let veinPts = 0, veinUntil = 0;      // vein meter / active-vein timer
let depthPts = parseFloat(localStorage.getItem('aq_mining_depth') || '0') || 0;
let prestige = parseInt(localStorage.getItem('aq_mining_prestige') || '0', 10) || 0;
let infoEl = null, shopEl = null, stageEl = null;
let curStage = 0;
// Deeper zones reward more — but the low end is deliberately small so you WORK for early
// XP, and the big multipliers only arrive at the deep stages (which are level-gated:
// Caverns L8 … Crystal Core L60). Combined with prestige, that's the "huge" payoff.
function stageMult() { return 0.6 + curStage * 0.12; }
function prestigeMult() { return 1 + prestige * 0.05; }  // +5% per Delve Deeper rank
function veinActive() { return performance.now() < veinUntil; }
function addDepth(n) { depthPts = Math.min(DEPTH_MAX, depthPts + n); try { localStorage.setItem('aq_mining_depth', String(Math.round(depthPts))); } catch (e) {} }
let stageWrap = null, lockEl = null, _clkT = [], _lockUpdAt = 0, _lastTouch = false;
// One-time: the auto-clicker check used to be too sensitive (it could flag fast
// manual / rhythmic touch tapping). Clear any lockout it left behind so those
// players are freed. (Bumped to v2 to also free mobile users the touch tweak frees.)
try { if (!localStorage.getItem('aq_mining_lock_reset_v2')) { localStorage.setItem('aq_mining_lock_reset_v2', '1'); localStorage.removeItem(LOCK_KEY); } } catch (e) {}

function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function pickTier() { return Math.max(0, Math.min(PICKS.length - 1, parseInt(localStorage.getItem('aq_mining_pick') || '0', 10) || 0)); }
function pickPower() { return PICKS[pickTier()].power; }
function mineLvl() { return (typeof window.aqSkillLevel === 'function' && window.aqSkillLevel('mining')) || 1; }
function sfx(n) { try { if (typeof window !== 'undefined' && window.miningSfx) window.miningSfx(n); } catch (e) {} }

// ── auto-clicker detection + lockout ─────────────────────────────────────────
function lockedUntil() { return parseInt(localStorage.getItem(LOCK_KEY) || '0', 10) || 0; }
function isLocked() { return Date.now() < lockedUntil(); }
// Record a click time and decide if the recent cadence is robotic (auto-clicker).
function registerClick(now) {
  // Touch is far harder to trip: a finger taps more rhythmically than a mouse, so
  // mobile mashers were getting flagged. Require a longer run, a faster rate, and an
  // even more machine-perfect cadence before locking a touch user out — while still
  // catching an actual mobile auto-tapper. Desktop thresholds are unchanged.
  const touch = _lastTouch;
  _clkT.push(now);
  if (_clkT.length > CLK_WINDOW) _clkT.shift();
  if (_clkT.length < (touch ? CLK_MIN_TOUCH : CLK_MIN)) return false;
  const iv = [];
  for (let i = 1; i < _clkT.length; i++) iv.push(_clkT[i] - _clkT[i - 1]);
  const mean = iv.reduce((a, b) => a + b, 0) / iv.length;
  // Truly superhuman sustained rate: no human hits this by hand (mouse ~>30 cps,
  // finger ~>50 cps). Fast manual mashing tops out far below.
  if (mean < (touch ? 20 : 33)) return true;
  // Machine-regular cadence is the real tell: an auto-clicker's intervals are nearly
  // identical (coefficient of variation ≈ 0), while even very fast human input has
  // plenty of jitter. Require an extremely low CV over a long run so fast input is safe.
  let v = 0; for (const x of iv) v += (x - mean) * (x - mean);
  const cv2 = Math.sqrt(v / iv.length) / mean;
  if (cv2 < (touch ? 0.022 : 0.045) && mean < (touch ? 150 : 240)) return true;
  return false;
}
function lockOut() {
  try { localStorage.setItem(LOCK_KEY, String(Date.now() + LOCK_MS)); } catch (e) {}
  _clkT = [];
  sfx('break');
  showLock();
}
function showLock() {
  if (!stageWrap) return;
  if (!lockEl) { lockEl = document.createElement('div'); lockEl.className = 'gbc-lock'; stageWrap.appendChild(lockEl); }
  lockEl.style.display = 'flex';
  _lockUpdAt = 0;
  updateLock();
}
function hideLock() { if (lockEl) lockEl.style.display = 'none'; }
function updateLock() {
  if (!lockEl) return;
  const left = lockedUntil() - Date.now();
  if (left <= 0) { hideLock(); return; }
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  lockEl.innerHTML = '<div><div class="gbc-lock-t">⛔ Auto-clicker detected</div>' +
    '<div class="gbc-lock-sub">Mining locked for cheating.<br>Mine by hand to keep playing.</div>' +
    '<div class="gbc-lock-time">' + m + ':' + String(s).padStart(2, '0') + '</div></div>';
}

function maxStage() { let m = 0; for (let i = 0; i < STAGES.length; i++) if (mineLvl() >= STAGES[i].lvl) m = i; return m; }
function spawnRock() {
  if (curStage > maxStage()) curStage = maxStage();
  const pool = ROCKS.filter(r => r.stage === curStage);
  let total = 0; const w = pool.map(r => { total += r.weight; return r.weight; });
  let rnd = Math.random() * total, def = pool[0];
  for (let i = 0; i < pool.length; i++) { rnd -= w[i]; if (rnd <= 0) { def = pool[i]; break; } }
  rock = { def, hp: def.hp, max: def.hp, flash: 0, shape: [], specks: [], cracks: [] };

  // stable irregular boulder outline (half-width per row)
  const seed = Math.random() * 6.28;
  for (let i = 0; i <= RH * 2; i++) {
    const yy = (i - RH) / RH;                       // -1..1
    let hw = Math.sqrt(Math.max(0, 1 - yy * yy)) * RW;
    hw *= 0.86 + 0.12 * Math.sin(seed + i * 0.6) + 0.05 * Math.sin(seed * 1.7 + i * 1.7);
    rock.shape.push(Math.max(0, hw));
  }
  // embedded ore specks (stable positions inside the shape)
  const count = 5 + def.rarity * 4;
  let guard = 0;
  while (rock.specks.length < count && guard++ < 400) {
    const row = (Math.random() * (RH * 2)) | 0;
    const hw = rock.shape[row] || 0;
    if (hw < 5) continue;
    const dx = Math.round((Math.random() * 2 - 1) * (hw - 4));
    rock.specks.push({ dx, dy: row - RH, tw: Math.random() * 6.28 });
  }
  // crack branches radiating from the center, revealed as HP drops
  for (let b = 0; b < 4; b++) {
    const ang = (b / 4) * 6.28 + Math.random() * 0.8;
    const pts = []; let x = 0, y = 0;
    for (let s = 0; s < 5; s++) { x += Math.cos(ang) * 5 + (Math.random() * 4 - 2); y += Math.sin(ang) * 5 + (Math.random() * 4 - 2); pts.push({ x: Math.round(x), y: Math.round(y) }); }
    rock.cracks.push(pts);
  }
  scheduleSweet(performance.now());   // first weak-point will flash in after a delay
}
// Crit chains: schedule → start → tap a point → spawn the next around the circle.
function scheduleSweet(now) { sweet = null; seq = null; seqHits = 0; sweetNextAt = now + CRIT_GAP_MIN + Math.random() * CRIT_GAP_RAND; }
// Grant the chain's Mining XP (scaled by points tapped) — paid at the END of a chain.
function awardChainXp() {
  if (seqHits > 0) {
    // The main XP source — scales with how many points you chained AND the zone/prestige.
    if (typeof window.aqGameXp === 'function') window.aqGameXp('mining', { played: false, won: true, mult: Math.min(XP_CAP, (0.05 + seqHits * 0.05) * stageMult() * prestigeMult()) });
    addFloater('+chain XP ×' + seqHits, 3);
  }
  seqHits = 0;
}
function endSeq(now) { awardChainXp(); scheduleSweet(now); }
function startSeq(now) {
  if (!rock) { scheduleSweet(now); return; }
  const total = SEQ_MIN + ((Math.random() * (SEQ_RAND + 1)) | 0);   // 2..8 points
  seq = { remaining: total, total };
  seqHits = 0;
  spawnNextPoint(now);
}
// Spawn the next weak-point at a RANDOM spot on the rock face (not a fixed ring), so a
// stationary tapper/auto-clicker can't farm crits — you have to aim each one.
function spawnNextPoint(now) {
  if (!seq || (!veinActive() && seq.remaining <= 0) || !rock) { endSeq(now); return; }
  const r = Math.max(5, 8 - rock.def.rarity);
  const x = (r + 4) + Math.random() * (W - 2 * (r + 4));
  const y = 20 + Math.random() * (H - 50);        // avoid the top + bottom banners
  const life = veinActive() ? VEIN_POINT_MS : POINT_MS;
  sweet = { x, y, r, born: now, expireAt: now + life };
  if (!veinActive()) seq.remaining--;
}
function startVein(now) {
  veinUntil = now + VEIN_MS; veinPts = 0;
  seq = { remaining: 999, total: 999 }; seqHits = 0;
  addFloater('⚡ ORE VEIN! ⚡', 3); try { window.playFanfare?.('jackpot'); } catch (e) {} sfx('upgrade');
  spawnNextPoint(now);
}
function addFloater(text, c) { floaters.push({ x: CXR, y: CYR - 26, text, c, life: 34 }); }
function spark(big) { particles.push({ x: CXR + (Math.random() - 0.5) * 34, y: CYR - 8 + (Math.random() - 0.5) * 26, vx: (Math.random() - 0.5) * (big ? 6 : 3), vy: -Math.random() * (big ? 5 : 3) - 1, life: big ? 24 : 16, c: 3, s: big ? 3 : 2 }); }

function breakRock() {
  const r = rock.def, now = performance.now();
  const ml = motherlodeUntil > now;
  const ore = Math.round(r.value * (ml ? MOTHERLODE_ORE : 1) * prestigeMult());
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(ore);
  // The break itself is a SMALL trickle now (most XP comes from chaining weak-points),
  // but it scales with the zone + prestige so deeper digging is clearly worth more.
  if (typeof window.aqGameXp === 'function') window.aqGameXp('mining', { played: false, won: true, mult: Math.min(XP_CAP, (0.05 + r.rarity * 0.05) * stageMult() * prestigeMult()) });
  addDepth(4 + r.rarity * 2);
  if (typeof window.recordScore === 'function') window.recordScore('mining', ore, r.name);
  addFloater('+' + ore, 2);
  // shatter burst: chunky fragments in the rock's tones
  for (let i = 0; i < 20; i++) {
    const c = Math.random() < 0.5 ? r.base : r.ore;
    particles.push({ x: CXR, y: CYR, vx: (Math.random() - 0.5) * 6, vy: -Math.random() * 5 - 1, life: 28, c, s: 2 + (Math.random() * 2 | 0) });
  }
  shake = 9;
  sfx('break');
  // rare Motherlode! frenzy (not while one is already running)
  if (!ml && Math.random() < MOTHERLODE_CHANCE) {
    motherlodeUntil = now + MOTHERLODE_MS;
    addFloater('★ MOTHERLODE! ★', 3);
    try { window.playFanfare?.('jackpot'); } catch (e) {}
  }
  rock = null; sweet = null; seq = null; seqHits = 0; veinUntil = 0;
  breakUntil = now + 280;  // brief empty crater before respawn
  refreshInfo();
}

function hit(px, py) {
  const now = performance.now();
  if (isLocked()) { showLock(); return; }
  if (registerClick(now)) { lockOut(); return; }
  if (!rock) return;
  swing = 1; shake = 6; rock.flash = 1;
  // Crit if a chain point is showing and you tap it: deal a big hit and chain to the
  // next point around the circle. (XP for the chain is paid when the chain ends.)
  const crit = sweet && px != null && Math.hypot(px - sweet.x, py - sweet.y) <= sweet.r + 3;
  let dmg = pickPower();
  if (motherlodeUntil > now) dmg *= MOTHERLODE_POWER;
  if (crit) dmg *= CRIT_POINT_MULT;
  sfx(crit ? 'crit' : 'hit');
  rock.hp -= dmg;
  if (crit) {
    shake = 12; seqHits++;
    const vein = veinActive();
    // each hit pays a little credit + depth immediately; chain XP is paid at the end
    const chip = Math.round((1 + curStage * 1.2) * prestigeMult() * (vein ? 2.5 : 1));
    if (typeof window.aqAddCredits === 'function') window.aqAddCredits(chip);
    addDepth(vein ? 3 : 1);
    addFloater(vein ? '+' + chip + '⚡' : 'CRIT!', 3);
    for (let i = 0; i < 12; i++) spark(true);
    // charge the vein meter from normal (non-vein) crit hits
    if (!vein) { veinPts++; if (veinPts >= VEIN_NEED) { startVein(now); if (rock.hp <= 0) { awardChainXp(); breakRock(); } return; } }
    if (rock.hp <= 0) { awardChainXp(); breakRock(); return; }
    spawnNextPoint(now);   // chain to the next point
    return;
  }
  for (let i = 0; i < 5; i++) particles.push({ x: CXR + (Math.random() - 0.5) * 30, y: CYR - 6 + (Math.random() - 0.5) * 22, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 3, life: 16, c: rock.def.ore, s: 2 });
  if (rock.hp <= 0) breakRock();
}

function px(x, y, w, h, c) { cx.fillStyle = PAL[c] || c; cx.fillRect(x | 0, y | 0, w | 0, h | 0); }
// 2-bit checker dither fill (classic GBC shading texture)
function dither(x, y, w, h, c, phase) {
  cx.fillStyle = PAL[c];
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (((xx + yy + (phase || 0)) & 1) === 0) cx.fillRect(x + xx, y + yy, 1, 1);
}

// The cave background is static, so render it once to an offscreen buffer and
// blit it each frame (avoids a full-screen per-pixel dither every frame).
let caveBuf = null;
function buildCave() {
  const c = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
  if (!c) return;
  c.width = W; c.height = H;
  const prev = cx; cx = c.getContext('2d'); cx.imageSmoothingEnabled = false;
  // far wall + rough rock texture
  cx.fillStyle = PAL[2]; cx.fillRect(0, 0, W, H);
  dither(0, 0, W, H, 1, 0);
  // ceiling band + stalactites
  px(0, 0, W, 10, 1);
  cx.fillStyle = PAL[0];
  for (const sx of [20, 52, 96, 132]) { cx.beginPath(); cx.moveTo(sx, 10); cx.lineTo(sx + 5, 10); cx.lineTo(sx + 2, 10 + 8 + (sx % 7)); cx.closePath(); cx.fill(); }
  // floor ledge with shadow lip
  px(0, 112, W, H - 112, 1);
  dither(0, 112, W, 6, 0, 1);
  px(0, 110, W, 2, 0);
  // side vignette
  dither(0, 0, 10, H, 0, 0); dither(W - 10, 0, 10, H, 0, 0);
  cx = prev;
  caveBuf = c;
}

// boulder with diagonal shading + ore specks + cracks
function drawRock(t, sx) {
  const cxp = (CXR + sx) | 0, cyp = CYR;
  const def = rock.def, base = def.base;
  const hi = Math.min(3, base + 2), sh = Math.max(0, base - 1);
  const dmg = 1 - rock.hp / rock.max;
  const flash = rock.flash > 0.45;
  // drop shadow on the ledge
  cx.fillStyle = PAL[0]; cx.globalAlpha = 0.5; cx.fillRect(cxp - RW + 4, cyp + RH - 2, RW * 2 - 8, 4); cx.globalAlpha = 1;
  // body, shaded by a diagonal light from the upper-left
  for (let i = 0; i < rock.shape.length; i++) {
    const hw = rock.shape[i] | 0; if (hw <= 0) continue;
    const y = cyp - RH + i;
    px(cxp - hw - 1, y, 1, 1, 0); px(cxp + hw, y, 1, 1, 0);   // outline edges
    for (let x = -hw; x < hw; x++) {
      let tone;
      if (flash) tone = 3;
      else { const d = (x / RW) * 0.8 + ((i - RH) / RH) * 0.8; tone = d < -0.55 ? hi : (d > 0.5 ? sh : base); }
      cx.fillStyle = PAL[tone]; cx.fillRect(cxp + x, y, 1, 1);
    }
  }
  // ore specks (gems twinkle)
  if (!flash) for (const s of rock.specks) {
    let tone = def.ore;
    if (def.gem && Math.sin(t / 220 + s.tw) > 0.55) tone = 3;
    px(cxp + s.dx, cyp + s.dy, 2, 2, tone);
    if (def.gem && tone === 3) px(cxp + s.dx, cyp + s.dy - 1, 1, 1, 3);
  }
  // cracks revealed as it weakens
  if (!flash) {
    cx.fillStyle = PAL[0];
    const branchesShown = Math.ceil(dmg * 4);
    rock.cracks.forEach((pts, bi) => {
      if (bi >= branchesShown) return;
      const segs = Math.max(1, Math.floor(pts.length * Math.min(1, dmg * 1.4)));
      for (let i = 0; i < Math.min(segs, pts.length); i++) cx.fillRect(cxp + pts[i].x, cyp + pts[i].y, 2, 2);
    });
  }
  // HP bar above
  px(cxp - RW, cyp - RH - 9, RW * 2, 5, 0);
  px(cxp - RW + 1, cyp - RH - 8, Math.max(0, (rock.hp / rock.max) * (RW * 2 - 2)), 3, 2);
}

// tier-tinted pickaxe swinging on an arc into the rock
function drawPick(sa, sx) {
  const headTone = [1, 1, 2, 3, 3, 3][pickTier()] || 2;
  const ang = -1.15 + sa * 1.35;             // raised → struck
  cx.save();
  cx.translate(CXR + 22 + sx, CYR - 30);
  cx.rotate(ang);
  cx.fillStyle = PAL[0]; cx.fillRect(-1, 0, 3, 24);          // handle
  cx.fillStyle = PAL[headTone];
  cx.fillRect(-11, -1, 24, 5);                                // head bar
  cx.fillRect(-12, -2, 5, 7); cx.fillRect(8, -2, 5, 7);       // head tips
  cx.fillStyle = PAL[3]; cx.fillRect(-10, 0, 6, 1);           // glint
  cx.restore();
}

function draw(t) {
  if (!cx) return;
  if (!caveBuf) buildCave();
  if (caveBuf) cx.drawImage(caveBuf, 0, 0); else { cx.fillStyle = PAL[2]; cx.fillRect(0, 0, W, H); }
  const ml = motherlodeUntil > t;
  if (ml) { cx.fillStyle = PAL[3]; cx.globalAlpha = 0.12 + 0.06 * Math.sin(t / 120); cx.fillRect(0, 0, W, H); cx.globalAlpha = 1; }
  const sx = (shake > 0 ? (Math.random() - 0.5) * shake : 0);

  if (rock) {
    drawRock(t, sx);
    const sa = swing > 0 ? (1 - swing) : 1;   // 0=raised .. 1=struck
    drawPick(sa, sx);
    // impact spark at the moment of contact
    if (swing > 0.72) { px(CXR - 4 + sx, CYR - 18, 3, 3, 3); px(CXR + sx, CYR - 22, 2, 2, 3); px(CXR + 5 + sx, CYR - 16, 2, 2, 3); }
  } else {
    // brief empty crater after a break
    cx.fillStyle = PAL[0]; cx.globalAlpha = 0.5; cx.fillRect(CXR - 20, CYR + 14, 40, 5); cx.globalAlpha = 1;
  }

  // particles (sized chunks)
  for (const p of particles) px(p.x, p.y, p.s || 3, p.s || 3, p.c);

  // weak-point reticle — roams the whole window; click it for a guaranteed crit
  if (rock && sweet) {
    const rr = Math.max(3, Math.round(sweet.r * (0.7 + 0.3 * Math.sin(t / 140))));
    const wx = sweet.x | 0, wy = sweet.y | 0;
    px(wx - 1, wy - rr, 2, 2, 3); px(wx - 1, wy + rr - 1, 2, 2, 3);
    px(wx - rr, wy - 1, 2, 2, 3); px(wx + rr - 1, wy - 1, 2, 2, 3);
    px(wx - rr - 1, wy - rr - 1, 2, 2, 3); px(wx + rr - 1, wy + rr - 1, 2, 2, 3);
    px(wx + rr - 1, wy - rr - 1, 2, 2, 3); px(wx - rr - 1, wy + rr - 1, 2, 2, 3);
    px(wx - 1, wy - 1, 2, 2, 0);
  }

  // floaters (CRIT! / PERFECT! / +ore)
  if (floaters.length) {
    cx.font = '8px monospace'; cx.textBaseline = 'middle'; cx.textAlign = 'center';
    for (const fl of floaters) { cx.fillStyle = PAL[0]; cx.fillText(fl.text, CXR + 1, fl.y + 1); cx.fillStyle = PAL[fl.c]; cx.fillText(fl.text, CXR, fl.y); }
    cx.textAlign = 'left';
  }

  // top banner: vein / motherlode / tap hint
  cx.font = '8px monospace'; cx.textBaseline = 'top';
  if (veinActive()) { cx.fillStyle = PAL[0]; cx.textAlign = 'center'; cx.fillText('⚡ ORE VEIN ' + Math.ceil((veinUntil - t) / 1000) + 's ⚡', W / 2, 2); cx.textAlign = 'left'; }
  else if (ml) { cx.fillStyle = PAL[0]; cx.textAlign = 'center'; cx.fillText('★ MOTHERLODE ' + Math.ceil((motherlodeUntil - t) / 1000) + 's ★', W / 2, 2); cx.textAlign = 'left'; }
  else if (sweet) { cx.fillStyle = PAL[0]; cx.fillText('★ tap! ×' + seqHits, 6, 2); }
  // depth bar (skill progress → Delve Deeper) on the left of the bottom banner; rank on the right
  cx.fillStyle = PAL[0]; cx.fillRect(0, H - 14, W, 14);
  cx.fillStyle = PAL[3]; cx.font = '8px monospace'; cx.textBaseline = 'middle';
  cx.fillText(rock ? `${rock.def.name} rock` : 'Mining…', 4, H - 7);
  // depth meter (thin, above the name banner)
  const full = depthPts >= DEPTH_MAX;
  px(2, H - 18, W - 4, 3, 0); px(3, H - 17, (W - 6) * Math.min(1, depthPts / DEPTH_MAX), 1, full ? 3 : 2);
  cx.fillStyle = PAL[3]; cx.font = '8px monospace'; cx.textBaseline = 'middle'; cx.textAlign = 'right';
  cx.fillText((prestige ? '◆' + prestige + ' ' : '') + (full ? 'DELVE!' : 'depth'), W - 4, H - 7);
  cx.textAlign = 'left';
}

let _lastT = 0;
function tick(t) {
  const dt = Math.min(50, t - (_lastT || t)); _lastT = t;
  if (swing > 0) swing = Math.max(0, swing - dt / 120);
  if (shake > 0) shake = Math.max(0, shake - dt / 30);
  if (rock && rock.flash > 0) rock.flash = Math.max(0, rock.flash - dt / 90);
  if (!rock && breakUntil && t >= breakUntil) { breakUntil = 0; spawnRock(); }
  for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vy += 0.25; p.life -= dt / 16; }
  particles = particles.filter(p => p.life > 0);
  // Crit-chain lifecycle: start after a random delay; if a point isn't tapped in
  // time the chain breaks (and pays out XP for whatever was tapped).
  if (rock) {
    if (veinUntil && t >= veinUntil) { veinUntil = 0; endSeq(t); }   // vein ended → pay it out
    else if (sweet) { if (t >= sweet.expireAt) { if (veinActive()) spawnNextPoint(t); else endSeq(t); } }
    else if (t >= sweetNextAt) startSeq(t);
  }
  for (const fl of floaters) { fl.y -= dt / 22; fl.life -= dt / 16; }
  floaters = floaters.filter(f => f.life > 0);
  // lockout overlay: tick the countdown ~2×/s, auto-clear when it expires
  if (isLocked()) { if (!lockEl || lockEl.style.display === 'none') showLock(); else if (t - _lockUpdAt > 500) { _lockUpdAt = t; updateLock(); } }
  else if (lockEl && lockEl.style.display !== 'none') hideLock();
  draw(t);
  raf = requestAnimationFrame(tick);
}

function refreshInfo() {
  if (infoEl) infoEl.textContent = `${PICKS[pickTier()].name} pick (⛏${pickPower()})${prestige ? ' ◆' + prestige : ''} · Lv ${mineLvl()} · 💰 ${credits()}`;
  renderStages();
  renderShop();
}

function renderStages() {
  if (!stageEl) return;
  const lvl = mineLvl();
  stageEl.innerHTML = '';
  STAGES.forEach((s, i) => {
    const unlocked = lvl >= s.lvl;
    const b = document.createElement('button');
    b.className = 'gbc-btn';
    b.disabled = !unlocked;
    b.textContent = unlocked ? s.name : `🔒 ${s.name} · Lv${s.lvl}`;
    if (i === curStage) { b.style.fontWeight = 'bold'; b.style.outline = '2px solid ' + PAL[3]; }
    b.addEventListener('click', () => {
      if (!unlocked || i === curStage) return;
      curStage = i; try { localStorage.setItem('aq_mining_stage', String(i)); window.aqGamePersist && window.aqGamePersist('aq_mining_stage'); } catch (e) {}
      rock = null; breakUntil = 0; spawnRock(); refreshInfo();
    });
    stageEl.appendChild(b);
  });
  // Delve Deeper (prestige): enabled once the depth bar is full
  const pb = document.createElement('button');
  pb.className = 'gbc-btn';
  const ready = depthPts >= DEPTH_MAX;
  pb.disabled = !ready;
  pb.textContent = ready ? '⛏️🔥 Delve Deeper' : `Depth ${Math.floor(depthPts / DEPTH_MAX * 100)}%`;
  if (prestige) pb.title = 'Rank ' + prestige + ' · +' + (prestige * 5) + '% mining';
  pb.addEventListener('click', doPrestige);
  stageEl.appendChild(pb);
}
function doPrestige() {
  if (depthPts < DEPTH_MAX) return;
  prestige++; depthPts = 0;
  try { localStorage.setItem('aq_mining_prestige', String(prestige)); localStorage.setItem('aq_mining_depth', '0'); } catch (e) {}
  if (window.aqGamePersist) window.aqGamePersist('aq_mining_prestige');
  addFloater('◆ DELVED DEEPER! Rank ' + prestige, 3);
  try { window.playFanfare?.('jackpot'); } catch (e) {} sfx('upgrade');
  refreshInfo();
}

function renderShop() {
  if (!shopEl) return;
  const tier = pickTier();
  shopEl.innerHTML = '';
  if (tier >= PICKS.length - 1) {
    const d = document.createElement('div'); d.className = 'gbc-info'; d.textContent = 'Max pickaxe! ⛏ ' + pickPower();
    shopEl.appendChild(d);
    return;
  }
  const next = PICKS[tier + 1];
  const btn = document.createElement('button');
  btn.className = 'gbc-btn';
  const afford = credits() >= next.cost;
  btn.disabled = !afford;
  btn.textContent = `Upgrade → ${next.name} (⛏${next.power})  💰${next.cost}`;
  btn.addEventListener('click', () => {
    if (credits() < next.cost) return;
    if (typeof window.aqSetCredits === 'function') window.aqSetCredits(credits() - next.cost);
    localStorage.setItem('aq_mining_pick', String(tier + 1));
    if (window.aqGamePersist) window.aqGamePersist('aq_mining_pick');
    sfx('upgrade');
    refreshInfo();
  });
  shopEl.appendChild(btn);
}

function build() {
  const area = document.getElementById('mining-area');
  if (!area) return;
  area.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'gbc-stage';
  cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.className = 'gbc-canvas';
  stage.appendChild(cv);
  area.appendChild(stage);
  stageWrap = stage; lockEl = null;

  const bar = document.createElement('div'); bar.className = 'gbc-bar';
  const mine = document.createElement('button'); mine.className = 'gbc-btn'; mine.textContent = '⛏️ MINE';
  bar.appendChild(mine);
  infoEl = document.createElement('div'); infoEl.className = 'gbc-info'; bar.appendChild(infoEl);
  area.appendChild(bar);

  stageEl = document.createElement('div'); stageEl.className = 'gbc-bar'; area.appendChild(stageEl);
  shopEl = document.createElement('div'); shopEl.className = 'gbc-bar'; area.appendChild(shopEl);

  cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
  // click the canvas → mine at those coords (aim for the weak-point to crit);
  // the MINE button is a no-aim fallback (normal hits, can't crit).
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    _lastTouch = (e.pointerType === 'touch');
    const r = cv.getBoundingClientRect();
    hit((e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height));
  });
  mine.addEventListener('pointerdown', (e) => { e.preventDefault(); _lastTouch = (e.pointerType === 'touch'); hit(); });
  _built = true;
}

function openMining(show = true) {
  const w = document.getElementById('mining-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('mining'); window.OS.focus('mining'); }
  if (!_built) build();
  curStage = Math.min(maxStage(), parseInt(localStorage.getItem('aq_mining_stage') || '0', 10) || 0);
  if (!rock) spawnRock();
  refreshInfo();
  _clkT = [];
  if (isLocked()) showLock(); else hideLock();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') {
  window.openMining = openMining;
  // Cloud game-save merge can land after the window is already open — re-read the
  // restored pickaxe/stage and refresh the shop so a synced upgrade shows up.
  window.addEventListener('aq-gamedata-synced', () => {
    const w = document.getElementById('mining-wrap');
    if (!w || !w.classList.contains('open')) return;
    curStage = Math.min(maxStage(), parseInt(localStorage.getItem('aq_mining_stage') || '0', 10) || 0);
    prestige = Math.max(prestige, parseInt(localStorage.getItem('aq_mining_prestige') || '0', 10) || 0);
    refreshInfo();
  });
}
