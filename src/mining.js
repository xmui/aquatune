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

// base = body tone (PAL index), ore = embedded-speck tone, gem = sparkles
const ROCKS = [
  { name: 'Stone',    hp: 24,  value: 3,   rarity: 0, base: 1, ore: 0, gem: false },
  { name: 'Copper',   hp: 48,  value: 7,   rarity: 1, base: 1, ore: 2, gem: false },
  { name: 'Iron',     hp: 90,  value: 14,  rarity: 1, base: 2, ore: 0, gem: false },
  { name: 'Gold',     hp: 160, value: 30,  rarity: 2, base: 1, ore: 3, gem: true },
  { name: 'Emerald',  hp: 260, value: 60,  rarity: 3, base: 2, ore: 3, gem: true },
  { name: 'Diamond',  hp: 440, value: 140, rarity: 4, base: 2, ore: 3, gem: true },
];

// rock geometry
const CXR = 80, CYR = 72, RW = 30, RH = 24;

// ── spice dials ──────────────────────────────────────────────────────────────
const CRIT_MULT = 4;                 // damage × on a crit
const CRIT_CHANCE = 0.05;            // flat random crit chance on a deliberate (non-spam) hit
const SPAM_MS = 150;                 // clicks faster than this = mashing → NO crits (timing only)
const MOTHERLODE_CHANCE = 0.03;      // per rock break (when not already active)
const MOTHERLODE_MS = 10000;         // frenzy duration
const MOTHERLODE_ORE = 3, MOTHERLODE_POWER = 2;
// ────────────────────────────────────────────────────────────────────────────

let cv = null, cx = null, raf = null, _built = false;
let rock = null, swing = 0, shake = 0, particles = [];
let combo = 0, lastHit = 0, breakUntil = 0;
let floaters = [], sweet = null, motherlodeUntil = 0;
let infoEl = null, shopEl = null;

function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function pickTier() { return Math.max(0, Math.min(PICKS.length - 1, parseInt(localStorage.getItem('aq_mining_pick') || '0', 10) || 0)); }
function pickPower() { return PICKS[pickTier()].power; }
function mineLvl() { return (typeof window.aqSkillLevel === 'function' && window.aqSkillLevel('mining')) || 1; }
function sfx(n) { try { if (typeof window !== 'undefined' && window.miningSfx) window.miningSfx(n); } catch (e) {} }

function spawnRock() {
  const luck = Math.random() + mineLvl() / 250;
  let pool;
  if (luck > 1.2) pool = ROCKS.filter(r => r.rarity >= 3);
  else if (luck > 0.75) pool = ROCKS.filter(r => r.rarity >= 1 && r.rarity <= 3);
  else pool = ROCKS.filter(r => r.rarity <= 1);
  const def = pool[(Math.random() * pool.length) | 0] || ROCKS[0];
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
  // sweet-spot meter: tougher rocks get a narrower, faster zone (more reward for timing)
  sweet = { x: Math.random() * 100, dir: Math.random() < 0.5 ? -1 : 1, v: 1.2 + def.rarity * 0.25, w: Math.max(14, 26 - def.rarity * 2), zoneX: 0 };
  rerollSweet();
}
function rerollSweet() { if (sweet) sweet.zoneX = Math.random() * Math.max(0, 100 - sweet.w); }
function addFloater(text, c) { floaters.push({ x: CXR, y: CYR - 26, text, c, life: 34 }); }
function spark(big) { particles.push({ x: CXR + (Math.random() - 0.5) * 34, y: CYR - 8 + (Math.random() - 0.5) * 26, vx: (Math.random() - 0.5) * (big ? 6 : 3), vy: -Math.random() * (big ? 5 : 3) - 1, life: big ? 24 : 16, c: 3, s: big ? 3 : 2 }); }

function breakRock() {
  const r = rock.def, now = performance.now();
  const ml = motherlodeUntil > now;
  const bonus = (1 + Math.min(combo, 10) * 0.05) * (ml ? MOTHERLODE_ORE : 1);
  const ore = Math.round(r.value * bonus);
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(ore);
  // Mining gives less XP than other skills: only the "won" trickle, scaled down.
  // (Motherlode boosts ore credits + speed, NOT the XP mult — keeps the economy sane.)
  if (typeof window.aqGameXp === 'function') window.aqGameXp('mining', { played: false, won: true, mult: 0.4 + r.rarity * 0.25 });
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
  rock = null;
  breakUntil = now + 280;  // brief empty crater before respawn
  refreshInfo();
}

function hit() {
  if (!rock) return;
  const now = performance.now();
  const gap = now - lastHit;
  const spamming = gap < SPAM_MS;           // mashing too fast → no crits, just normal damage
  combo = (gap < 900) ? combo + 1 : 0;
  lastHit = now;
  swing = 1; shake = 6; rock.flash = 1;
  // Crits reward TIMING, not mashing: only land on deliberate (non-spam) hits —
  // a guaranteed crit when you tap inside the moving sweet-spot, else a small
  // flat chance. Spamming disqualifies both, so you can spam for normal damage.
  const inZone = sweet && sweet.x >= sweet.zoneX && sweet.x <= sweet.zoneX + sweet.w;
  const crit = !spamming && (inZone || Math.random() < CRIT_CHANCE);
  const perfect = crit && inZone;
  let dmg = pickPower();
  if (motherlodeUntil > now) dmg *= MOTHERLODE_POWER;
  if (crit) dmg *= CRIT_MULT;
  sfx(crit ? 'crit' : 'hit');
  rock.hp -= dmg;
  if (crit) {
    shake = 10;
    addFloater(perfect ? 'PERFECT!' : 'CRIT!', 3);
    if (perfect) rerollSweet();
    for (let i = 0; i < 10; i++) spark(true);
  } else {
    for (let i = 0; i < 5; i++) particles.push({ x: CXR + (Math.random() - 0.5) * 30, y: CYR - 6 + (Math.random() - 0.5) * 22, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 3, life: 16, c: rock.def.ore, s: 2 });
  }
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

  // sweet-spot timing meter (hit while the marker is in the green for a guaranteed crit)
  if (rock && sweet) {
    const mx = 18, mw = 124, my = H - 26, mh = 6;
    px(mx - 1, my - 1, mw + 2, mh + 2, 0);
    px(mx, my, mw, mh, 1);
    px(mx + (sweet.zoneX / 100) * mw, my, (sweet.w / 100) * mw, mh, 2);
    px(mx + (sweet.x / 100) * mw - 1, my - 2, 2, mh + 4, 3);
  }

  // floaters (CRIT! / PERFECT! / +ore)
  if (floaters.length) {
    cx.font = '8px monospace'; cx.textBaseline = 'middle'; cx.textAlign = 'center';
    for (const fl of floaters) { cx.fillStyle = PAL[0]; cx.fillText(fl.text, CXR + 1, fl.y + 1); cx.fillStyle = PAL[fl.c]; cx.fillText(fl.text, CXR, fl.y); }
    cx.textAlign = 'left';
  }

  // motherlode banner
  if (ml) {
    cx.fillStyle = PAL[0]; cx.font = '8px monospace'; cx.textBaseline = 'top'; cx.textAlign = 'center';
    cx.fillText('★ MOTHERLODE ' + Math.ceil((motherlodeUntil - t) / 1000) + 's ★', W / 2, 2); cx.textAlign = 'left';
  }
  // combo
  else if (combo > 1) { cx.fillStyle = PAL[0]; cx.font = '8px monospace'; cx.textBaseline = 'top'; cx.fillText('x' + (combo + 1) + ' combo', 6, 2); }
  // rock name banner
  cx.fillStyle = PAL[0]; cx.fillRect(0, H - 14, W, 14);
  cx.fillStyle = PAL[3]; cx.font = '8px monospace'; cx.textBaseline = 'middle';
  cx.fillText(rock ? `${rock.def.name} rock` : 'Mining…', 4, H - 7);
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
  if (sweet) { sweet.x += sweet.v * sweet.dir * (dt / 16); if (sweet.x <= 0) { sweet.x = 0; sweet.dir = 1; } if (sweet.x >= 100) { sweet.x = 100; sweet.dir = -1; } }
  for (const fl of floaters) { fl.y -= dt / 22; fl.life -= dt / 16; }
  floaters = floaters.filter(f => f.life > 0);
  draw(t);
  raf = requestAnimationFrame(tick);
}

function refreshInfo() {
  if (infoEl) infoEl.textContent = `${PICKS[pickTier()].name} pick (⛏${pickPower()}) · Lv ${mineLvl()} · 💰 ${credits()}`;
  renderShop();
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

  const bar = document.createElement('div'); bar.className = 'gbc-bar';
  const mine = document.createElement('button'); mine.className = 'gbc-btn'; mine.textContent = '⛏️ MINE';
  bar.appendChild(mine);
  infoEl = document.createElement('div'); infoEl.className = 'gbc-info'; bar.appendChild(infoEl);
  area.appendChild(bar);

  shopEl = document.createElement('div'); shopEl.className = 'gbc-bar'; area.appendChild(shopEl);

  cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
  const doHit = (e) => { e.preventDefault(); hit(); };
  cv.addEventListener('pointerdown', doHit);
  mine.addEventListener('pointerdown', doHit);
  _built = true;
}

function openMining(show = true) {
  const w = document.getElementById('mining-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('mining'); window.OS.focus('mining'); }
  if (!_built) build();
  if (!rock) spawnRock();
  refreshInfo();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') { window.openMining = openMining; }
