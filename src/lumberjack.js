// Aquatune Lumberjack — a PS1/N64-style first-person woodcutting game.
//
// You're dropped in an endless forest (chunk-streamed, deterministically
// generated as you wander) rendered with the same software-3D family as
// Mining/Buddy Shoot 3D — open ground plane, billboard trees, fog, full
// mouse-look INCLUDING up/down. Walk to a tree and swing on the rhythm
// meter: hit the sweet spot for solid chops (the bright centre is a PERFECT
// chop), glance off if you mistime. When a tree gives, it creaks, leans and
// CRASHES in a random direction — stand in its path and it flattens you.
// Felled logs pay credits, feed the shared inventory (window.aqInvAdd) and
// grant Woodcutting XP (small, capped, deeper-forest curve like Mining).
// Forests unlock with Woodcutting level; better axes are bought with credits.

// ── render constants ─────────────────────────────────────────────────────────
const RW_BASE = 220, RH = 140;
let RW = RW_BASE;
const TWOPI = Math.PI * 2;
const _touch = (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches);
if (_touch) RW = 170;
const PITCH_MAX = 52;

// ── progression data ─────────────────────────────────────────────────────────
const AXES = [
  { name: 'Rusty',    power: 1,  cost: 0,     color: '#9a8a7a' },
  { name: 'Bronze',   power: 2,  cost: 250,   color: '#c08850' },
  { name: 'Steel',    power: 4,  cost: 900,   color: '#cfd6de' },
  { name: 'Sapphire', power: 7,  cost: 3200,  color: '#4a90e0' },
  { name: 'Mythic',   power: 12, cost: 12000, color: '#4ad9ff' },
];
// One forest per level gate; each has its own palette + tree species.
const ZONES = [
  { name: 'Birch Meadow',     lvl: 1,  tree: { id: 'birch',   name: 'Birch',   hp: 14,  logs: [2, 3], logValue: 3 },
    pal: { sky: '#9ce0f8', skyHi: '#d8f4ff', ground: '#4a8a3a', groundFar: '#6aa84a', fog: [150, 200, 230], trunk: '#e8e0d0', bark: '#6a6258', leaf: '#58b048', leafHi: '#88d068' } },
  { name: 'Oak Grove',        lvl: 10, tree: { id: 'oak',     name: 'Oak',     hp: 26,  logs: [2, 4], logValue: 7 },
    pal: { sky: '#88c8e8', skyHi: '#c8ecf8', ground: '#3a6a2a', groundFar: '#548a3a', fog: [130, 180, 200], trunk: '#7a5a36', bark: '#4a3620', leaf: '#3a7a2a', leafHi: '#5aa040' } },
  { name: 'Pine Highlands',   lvl: 25, tree: { id: 'pine',    name: 'Pine',    hp: 44,  logs: [3, 5], logValue: 14 },
    pal: { sky: '#a8c0d8', skyHi: '#e0ecf4', ground: '#56684a', groundFar: '#788a64', fog: [180, 196, 210], trunk: '#5a4430', bark: '#3a2c1c', leaf: '#2a5a44', leafHi: '#3a7858' } },
  { name: 'Ancient Redwoods', lvl: 45, tree: { id: 'redwood', name: 'Redwood', hp: 80,  logs: [4, 6], logValue: 28 },
    pal: { sky: '#d8a868', skyHi: '#f0d0a0', ground: '#5a4630', groundFar: '#7a6244', fog: [200, 150, 90], trunk: '#8a4630', bark: '#5a2c1c', leaf: '#3a5a2a', leafHi: '#54783a' } },
  { name: 'Spirit Forest',    lvl: 70, tree: { id: 'spirit',  name: 'Spirit',  hp: 130, logs: [4, 7], logValue: 55 },
    pal: { sky: '#241838', skyHi: '#4a3068', ground: '#202838', groundFar: '#303c50', fog: [60, 40, 100], trunk: '#cfd8e8', bark: '#8a98b0', leaf: '#7a4ad0', leafHi: '#a878f0' } },
];

// ── dials ────────────────────────────────────────────────────────────────────
const CHUNK = 12;                     // world units per chunk
const VIEW_CH = 2;                    // chunks rendered around the player (5×5)
const REACH = 2.3;                    // chop reach
const FACE_DOT = 0.78;                // facing cone for chopping
const SWING_MS = 420;                 // swing animation/cooldown
const FALL_MS = 1050;                 // creak+fall duration after the last chop
const FALL_LEN = 3.4;                 // squish corridor length (world units)
const FALL_HALF_W = 1.0;              // squish corridor half-width
const SQUISH_DMG = 45;
const RESPAWN_MS = 75000;             // felled trees regrow after ~75s
const RARE_CHANCE = 0.12;             // thick tree: 2× hp, 2.5× logs, bonus XP
const MAX_HP = 100, REGEN_DELAY = 4000, REGEN_PER_S = 4;
const XP_CAP = 12;                    // mining-style cap on any single grant's mult
function xpZoneMult() { return Math.pow(1.7, curZone); }

// ── tiny helpers ─────────────────────────────────────────────────────────────
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sfx(n) { try { window.lumberSfx && window.lumberSfx(n); } catch (e) {} }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function axeTier() { return Math.max(0, Math.min(AXES.length - 1, parseInt(localStorage.getItem('aq_lumber_axe') || '0', 10) || 0)); }
function axePower() { return AXES[axeTier()].power; }
function wcLvl() { return (typeof window.aqSkillLevel === 'function' && window.aqSkillLevel('woodcutting')) || 1; }
function maxZone() { let m = 0; const l = wcLvl(); for (let i = 0; i < ZONES.length; i++) if (l >= ZONES[i].lvl) m = i; return m; }
// deterministic per-chunk RNG so the forest "exists" as you wander back
function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function chunkSeed(cx, cy) { return (Math.imul(cx, 374761393) + Math.imul(cy, 668265263) + curZone * 974711) | 0; }

// ── state ────────────────────────────────────────────────────────────────────
let cv = null, ctx = null, raf = null, _built = false, _lastT = 0;
let area = null, hudEl = null, vignetteEl = null, overlayEl = null, touchEl = null;
let infoEl = null, zoneEl = null, shopEl = null;
let state = 'start', paused = false;
let curZone = 0;
let px = 0.5, py = 0.5, pa = 0, dirX = 1, dirY = 0, pitch = 0;
let hp = MAX_HP, lastHurtAt = -1e9, koUntil = 0;
let keys = {}, touchMove = { x: 0, y: 0 };
let swingT = 0, lastSwingAt = 0, chopping = false, walkPhase = 0;
let meter = null;                     // { x: 0..100, v, dir, zoneX, zoneW } while a tree is in reach
let particles = [], floaters = [];
let treesMod = new Map();             // treeKey -> { hp, state, fallDir, fallT0, respawnAt, rare }
let felled = 0, sessionLogs = 0;
let _birdAt = 0;

// ── procedural tree sprites ──────────────────────────────────────────────────
let treeSprites = [], stumpSprite = null, _bakedZone = -1;
function bakeTree(pal, variant, rare) {
  const W = rare ? 56 : 44, H = rare ? 96 : 80, c = mkCanvas(W, H), g = c.getContext('2d');
  const tw = (rare ? 10 : 7) + variant * 2;
  const tx = W / 2 - tw / 2;
  g.fillStyle = pal.trunk; g.fillRect(tx, H * 0.42, tw, H * 0.58);
  g.fillStyle = pal.bark;
  for (let i = 0; i < 6; i++) g.fillRect(tx + (i % 2) * (tw - 2), H * (0.48 + i * 0.08), 2, 6);   // bark nicks
  // canopy: stacked chunky blobs (pines get a cone)
  const cone = ZONES[curZone].tree.id === 'pine' || ZONES[curZone].tree.id === 'spirit';
  g.fillStyle = pal.leaf;
  if (cone) {
    for (let i = 0; i < 4; i++) {
      const w = W * (0.9 - i * 0.18), y = H * 0.46 - i * H * 0.13;
      g.beginPath(); g.moveTo(W / 2 - w / 2, y); g.lineTo(W / 2 + w / 2, y); g.lineTo(W / 2, y - H * 0.16); g.closePath(); g.fill();
    }
  } else {
    for (let i = 0; i < 3 + variant; i++) {
      const r = W * (0.26 - i * 0.03);
      g.beginPath(); g.ellipse(W / 2 + (i % 2 ? -1 : 1) * W * 0.12, H * 0.32 - i * H * 0.07, r * 1.25, r, 0, 0, TWOPI); g.fill();
    }
  }
  g.fillStyle = pal.leafHi; g.globalAlpha = 0.55;
  if (cone) { g.beginPath(); g.moveTo(W / 2 - W * 0.2, H * 0.2); g.lineTo(W / 2, H * 0.04); g.lineTo(W / 2 + W * 0.06, H * 0.2); g.closePath(); g.fill(); }
  else { g.beginPath(); g.ellipse(W / 2 - W * 0.08, H * 0.18, W * 0.2, W * 0.13, 0, 0, TWOPI); g.fill(); }
  g.globalAlpha = 1;
  return c;
}
function bakeStump(pal) {
  const c = mkCanvas(20, 14), g = c.getContext('2d');
  g.fillStyle = pal.trunk; g.fillRect(5, 4, 10, 10);
  g.fillStyle = pal.bark; g.fillRect(5, 4, 2, 10); g.fillRect(13, 4, 2, 10);
  g.fillStyle = '#e8d8b0'; g.beginPath(); g.ellipse(10, 4, 5, 2.4, 0, 0, TWOPI); g.fill();
  g.fillStyle = '#b09060'; g.beginPath(); g.ellipse(10, 4, 3, 1.4, 0, 0, TWOPI); g.fill();
  return c;
}
function bakeArt() {
  if (_bakedZone === curZone) return;
  _bakedZone = curZone;
  const pal = ZONES[curZone].pal;
  treeSprites = [bakeTree(pal, 0, false), bakeTree(pal, 1, false), bakeTree(pal, 0, true)];
  stumpSprite = bakeStump(pal);
}

// ── forest streaming ─────────────────────────────────────────────────────────
function chunkTrees(cx, cy) {
  const rnd = mulberry(chunkSeed(cx, cy));
  const n = 2 + (rnd() * 3 | 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const tx = cx * CHUNK + 1.2 + rnd() * (CHUNK - 2.4);
    const ty = cy * CHUNK + 1.2 + rnd() * (CHUNK - 2.4);
    const rare = rnd() < RARE_CHANCE;
    out.push({ key: cx + ',' + cy + ':' + i, x: tx, y: ty, variant: (rnd() * 2) | 0, rare });
  }
  return out;
}
function nearbyTrees() {
  const ccx = Math.floor(px / CHUNK), ccy = Math.floor(py / CHUNK);
  const out = [];
  for (let dy = -VIEW_CH; dy <= VIEW_CH; dy++) for (let dx = -VIEW_CH; dx <= VIEW_CH; dx++)
    for (const t of chunkTrees(ccx + dx, ccy + dy)) out.push(t);
  return out;
}
function treeState(t) {
  let m = treesMod.get(t.key);
  if (m && m.state === 'stump' && performance.now() >= m.respawnAt) { treesMod.delete(t.key); m = null; }
  if (!m) {
    const base = ZONES[curZone].tree.hp * (t.rare ? 2 : 1);
    m = { hp: base, max: base, state: 'alive', fallDir: 0, fallT0: 0, respawnAt: 0 };
    treesMod.set(t.key, m);
  }
  return m;
}
function treeSolid(t, m) { return m.state === 'alive' || m.state === 'falling'; }
function collide(nx, ny) {
  for (const t of nearbyTrees()) {
    const m = treesMod.get(t.key);
    if (m && m.state === 'stump') continue;
    if (Math.hypot(t.x - nx, t.y - ny) < 0.55) return true;
  }
  return false;
}

// ── chopping ─────────────────────────────────────────────────────────────────
function facingTree() {
  let best = null, bestD = REACH;
  for (const t of nearbyTrees()) {
    const m = treeState(t);
    if (m.state !== 'alive') continue;
    const dx = t.x - px, dy = t.y - py, d = Math.hypot(dx, dy);
    if (d < bestD && (dx * dirX + dy * dirY) / (d || 1e-3) > FACE_DOT) { best = t; bestD = d; }
  }
  return best;
}
function newMeter() {
  const zoneW = clamp(26 - curZone * 1.6 + axeTier() * 2, 14, 30);
  return {
    x: 0, dir: 1,
    v: 1.5 + curZone * 0.22,                     // per-16ms units, time-normalized in tick
    zoneW, zoneX: 10 + Math.random() * (80 - zoneW),
  };
}
function swing() {
  const now = performance.now();
  if (now - lastSwingAt < SWING_MS || now < koUntil || state !== 'playing') return;
  lastSwingAt = now; swingT = 1; walkPhase += 0.3;
  const t = facingTree();
  if (!t || !meter) { sfx('whiff'); return; }
  const m = treeState(t);
  const inZone = meter.x >= meter.zoneX && meter.x <= meter.zoneX + meter.zoneW;
  const pLo = meter.zoneX + meter.zoneW * 0.32, pHi = meter.zoneX + meter.zoneW * 0.68;
  const perfect = meter.x >= pLo && meter.x <= pHi;
  let dmg;
  if (perfect) { dmg = axePower() * 1.6; addFloater('PERFECT!', '#ffd84a'); burst('#ffd84a', 8); sfx('perfect'); }
  else if (inZone) { dmg = axePower(); burst('#e8d8b0', 6); sfx('chop'); }
  else { dmg = axePower() * 0.25; addFloater('glance…', '#c8c8c8'); sfx('weak'); }
  m.hp -= dmg;
  meter.zoneX = 10 + Math.random() * (80 - meter.zoneW);    // sweet spot moves each swing
  meter.v = Math.min(4.2, meter.v * (inZone ? 1.05 : 1));
  if (m.hp <= 0) fellTree(t, m, now);
}
function fellTree(t, m, now) {
  m.state = 'falling';
  m.fallT0 = now;
  m.fallDir = Math.random() * TWOPI;             // TIMBER — could be right at you
  sfx('creak');
  addFloater('🌲 TIMBER!', '#ff8a4a');
  meter = null;
}
function resolveFall(t, m, now) {
  m.state = 'stump';
  m.respawnAt = now + RESPAWN_MS + Math.random() * 20000;
  sfx('fall');
  shakeT = 1;
  // squish check: a corridor along the fall direction
  const fx = Math.cos(m.fallDir), fy = Math.sin(m.fallDir);
  const rx = px - t.x, ry = py - t.y;
  const along = rx * fx + ry * fy;
  const perp = Math.abs(rx * fy - ry * fx);
  let squished = false;
  if (along > 0.2 && along < FALL_LEN && perp < FALL_HALF_W) {
    squished = true;
    hurtPlayer(SQUISH_DMG);
    addFloater('💥 CRUSHED!', '#ff5a5a');
  }
  // payout: logs → credits + shared inventory + Woodcutting XP
  const def = ZONES[curZone].tree;
  let logs = def.logs[0] + (Math.random() * (def.logs[1] - def.logs[0] + 1) | 0);
  if (t.rare) logs = Math.round(logs * 2.5);
  if (squished) logs = Math.max(1, logs >> 1);             // dropped half of them on your head
  const pay = logs * def.logValue;
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(pay);
  if (typeof window.aqInvAdd === 'function') window.aqInvAdd('log_' + def.id, logs);
  if (typeof window.recordScore === 'function') window.recordScore('lumber', pay, def.name + (t.rare ? ' (giant)' : ''));
  if (typeof window.aqGameXp === 'function')
    window.aqGameXp('woodcutting', { played: true, won: true, mult: Math.min(XP_CAP, (0.5 + (t.rare ? 0.5 : 0)) * xpZoneMult()) });
  felled++; sessionLogs += logs;
  sfx('collect');
  addFloater(`+${logs} ${def.name} logs (+${pay} 💰)`, '#a8e078');
  if (t.rare && typeof window.aqGameAnnounce === 'function' && curZone >= 2)
    window.aqGameAnnounce(`felled a giant ${def.name} 🪓 (+${pay}💰)`);
  refreshInfo();
}
function hurtPlayer(dmg) {
  const now = performance.now();
  hp -= dmg; lastHurtAt = now;
  sfx('hurt'); flashHurt();
  if (hp <= 0) {
    hp = MAX_HP; koUntil = now + 2000;
    const loss = Math.min(40 + curZone * 20, credits());
    if (loss > 0 && typeof window.aqSetCredits === 'function') { window.aqSetCredits(credits() - loss); addFloater(`☠ KO'd! -${loss} 💰`, '#ff5a5a'); }
    else addFloater('☠ KO\'d!', '#ff5a5a');
  }
}

// ── movement / sim ───────────────────────────────────────────────────────────
function updatePlayer(dt, now) {
  if (now < koUntil) return;
  let fwd = 0, strafe = 0;
  if (keys['KeyW'] || keys['ArrowUp']) fwd += 1;
  if (keys['KeyS'] || keys['ArrowDown']) fwd -= 1;
  if (keys['KeyD']) strafe += 1;
  if (keys['KeyA']) strafe -= 1;
  if (keys['ArrowLeft']) pa -= 2.6 * dt;
  if (keys['ArrowRight']) pa += 2.6 * dt;
  if (_touch) { fwd += -touchMove.y; strafe += touchMove.x; }
  dirX = Math.cos(pa); dirY = Math.sin(pa);
  const sp = 3.0, rx = -dirY, ry = dirX;
  const mx = dirX * fwd + rx * strafe, my = dirY * fwd + ry * strafe;
  const ml = Math.hypot(mx, my) || 1;
  if (fwd || strafe) {
    const vx = mx / ml * sp * dt, vy = my / ml * sp * dt;
    if (!collide(px + vx, py)) px += vx;
    if (!collide(px, py + vy)) py += vy;
    walkPhase += dt * 8;
  }
  if (hp < MAX_HP && now - lastHurtAt > REGEN_DELAY) hp = Math.min(MAX_HP, hp + REGEN_PER_S * dt);
  // meter appears while a live tree is in reach
  const t = facingTree();
  if (t && !meter) meter = newMeter();
  if (!t) meter = null;
}
function updateWorld(dt, now) {
  if (meter) {
    meter.x += meter.v * meter.dir * (dt * 1000 / 16);
    if (meter.x <= 0) { meter.x = 0; meter.dir = 1; }
    if (meter.x >= 100) { meter.x = 100; meter.dir = -1; }
  }
  for (const [key, m] of treesMod) {
    if (m.state === 'falling' && now - m.fallT0 >= FALL_MS) {
      const t = findTreeByKey(key);
      if (t) resolveFall(t, m, now); else { m.state = 'stump'; m.respawnAt = now + RESPAWN_MS; }
    }
  }
  // prune far-away tree state so the map stays small (stumps keep their timer)
  if (treesMod.size > 400) {
    for (const [key, m] of treesMod) {
      if (m.state !== 'alive') continue;
      if (m.hp >= m.max) treesMod.delete(key);
      if (treesMod.size <= 300) break;
    }
  }
  // forest ambience
  if (now > _birdAt) { _birdAt = now + 6000 + Math.random() * 14000; if (curZone < 4) sfx('bird'); else sfx('spirit'); }
}
function findTreeByKey(key) {
  const [ck] = key.split(':');
  const [cx, cy] = ck.split(',').map(Number);
  for (const t of chunkTrees(cx, cy)) if (t.key === key) return t;
  return null;
}

// ── rendering ────────────────────────────────────────────────────────────────
let shakeT = 0;
function render(now) {
  if (!ctx) return;
  const pal = ZONES[curZone].pal;
  const bob = Math.abs(Math.sin(walkPhase)) * 2;
  const shake = shakeT > 0 ? (Math.random() - 0.5) * shakeT * 8 : 0;
  const hor = RH / 2 + pitch + bob + shake;
  // sky with a high band, ground with distance shading
  ctx.fillStyle = pal.skyHi; ctx.fillRect(0, 0, RW, Math.max(0, hor - 34));
  ctx.fillStyle = pal.sky; ctx.fillRect(0, Math.max(0, hor - 34), RW, 34);
  ctx.fillStyle = pal.groundFar; ctx.fillRect(0, Math.max(0, hor), RW, 26);
  ctx.fillStyle = pal.ground; ctx.fillRect(0, Math.max(0, hor + 26), RW, RH);
  const [fr, fg, fb] = pal.fog;
  for (let b = 0; b < 4; b++) {
    ctx.fillStyle = `rgba(${fr},${fg},${fb},${0.06 + 0.05 * (3 - b)})`;
    ctx.fillRect(0, hor - (b + 1) * 5, RW, (b + 1) * 10);
  }
  // trees: painter-sort far → near
  const list = [];
  for (const t of nearbyTrees()) {
    const m = treeState(t);
    const dx = t.x - px, dy = t.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > 26 * 26) continue;
    list.push({ t, m, d2 });
  }
  list.sort((a, b) => b.d2 - a.d2);
  for (const e of list) drawTree(e.t, e.m, hor, now);
  drawMeter(now);
  drawAxe(now, bob);
  for (const p of particles) { ctx.fillStyle = p.color; ctx.globalAlpha = Math.min(1, p.life * 2); ctx.fillRect(p.x, p.y, p.s, p.s); }
  ctx.globalAlpha = 1;
  if (floaters.length) {
    ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const f of floaters) {
      ctx.globalAlpha = Math.min(1, f.life * 1.6);
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillText(f.text, RW / 2 + 1, f.y + 1);
      ctx.fillStyle = f.color; ctx.fillText(f.text, RW / 2, f.y);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
  }
  if (now < koUntil) { ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(0, 0, RW, RH);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
    ctx.fillText('☠ flattened…', RW / 2, RH / 2); ctx.textAlign = 'left'; }
}
function drawTree(t, m, hor, now) {
  const dx = t.x - px, dy = t.y - py;
  // camera transform (same math as the raycaster sprites)
  const planeX = -dirY * 0.66, planeY = dirX * 0.66;
  const inv = 1 / (planeX * dirY - dirX * planeY);
  const tY = inv * (-planeY * dx + planeX * dy);
  if (tY <= 0.15) return;
  const tX = inv * (dirY * dx - dirX * dy);
  const screenX = (RW / 2) * (1 + tX / tY);
  const fullH = RH / tY;
  const sprite = m.state === 'stump' ? stumpSprite : treeSprites[t.rare ? 2 : t.variant];
  const scale = m.state === 'stump' ? 0.35 : (t.rare ? 3.0 : 2.3);
  const h = fullH * scale;
  const w = h * (sprite.width / sprite.height);
  const baseY = hor + fullH / 2;
  const fog = clamp(1 - tY / 24, 0.18, 1);
  ctx.save();
  ctx.globalAlpha = fog;
  if (m.state === 'falling') {
    // lean toward the fall direction: left/right rotation + toward/away squash
    const k = Math.min(1, (now - m.fallT0) / FALL_MS);
    const ease = k * k;
    const rel = m.fallDir - Math.atan2(dy, dx);
    const lean = Math.sin(rel) * ease * 1.45;
    const squash = 1 - 0.62 * ease * Math.abs(Math.cos(rel));
    ctx.translate(screenX, baseY);
    ctx.rotate(lean);
    ctx.scale(1, Math.max(0.2, squash));
    ctx.drawImage(sprite, -w / 2, -h, w, h);
  } else {
    ctx.drawImage(sprite, screenX - w / 2, baseY - h, w, h);
  }
  ctx.restore();
  // HP bar over a damaged target
  if (m.state === 'alive' && m.hp < m.max && tY < 6) {
    const bw = Math.max(14, w * 0.5);
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(screenX - bw / 2, baseY - h - 5, bw, 3);
    ctx.fillStyle = '#a8e078'; ctx.fillRect(screenX - bw / 2, baseY - h - 5, bw * (m.hp / m.max), 3);
  }
}
function drawMeter(now) {
  // crosshair
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(RW / 2 - 3, RH / 2, 2, 1); ctx.fillRect(RW / 2 + 2, RH / 2, 2, 1);
  ctx.fillRect(RW / 2, RH / 2 - 3, 1, 2); ctx.fillRect(RW / 2, RH / 2 + 2, 1, 2);
  if (!meter) return;
  const mx = 24, mw = RW - 48, my = RH - 26, mh = 11;
  ctx.fillStyle = '#182030'; ctx.fillRect(mx - 2, my - 2, mw + 4, mh + 4);
  ctx.fillStyle = '#243048'; ctx.fillRect(mx, my, mw, mh);
  const zx = mx + meter.zoneX / 100 * mw, zw = meter.zoneW / 100 * mw;
  ctx.fillStyle = '#38c860'; ctx.fillRect(zx, my, zw, mh);
  ctx.fillStyle = '#88f0a8'; ctx.fillRect(zx + zw * 0.32, my, zw * 0.36, mh);
  const markPx = mx + meter.x / 100 * mw;
  ctx.fillStyle = '#182030'; ctx.fillRect(markPx - 2, my - 3, 5, mh + 6);
  ctx.fillStyle = '#f8f8f8'; ctx.fillRect(markPx - 1, my - 2, 3, mh + 4);
  ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillText('SWING ON THE GREEN', RW / 2, my - 4);
  ctx.textAlign = 'left';
}
function drawAxe(now, bob) {
  const t = swingT;
  const arc = t > 0 ? Math.sin((1 - t) * Math.PI) : 0;
  const baseX = RW * 0.72 - arc * RW * 0.3 + Math.sin(walkPhase * 0.5) * 3;
  const baseY = RH * 0.99 - arc * RH * 0.3 + bob * 2;
  ctx.save();
  ctx.translate(baseX, baseY);
  ctx.rotate(-0.45 - arc * 1.6);
  ctx.fillStyle = '#6a4a26'; ctx.fillRect(-2.5, -36, 5, 42);
  ctx.fillStyle = '#4a3216'; ctx.fillRect(-2.5, -36, 2, 42);
  ctx.fillStyle = AXES[axeTier()].color;
  ctx.beginPath(); ctx.moveTo(2, -38); ctx.quadraticCurveTo(16, -40, 18, -26);
  ctx.quadraticCurveTo(8, -30, 2, -28); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(5, -36, 8, 2);
  ctx.restore();
}
function burst(color, n) {
  for (let i = 0; i < n; i++) particles.push({
    x: RW / 2 + (Math.random() - 0.5) * 26, y: RH / 2 + (Math.random() - 0.5) * 18,
    vx: (Math.random() - 0.5) * 80, vy: -Math.random() * 60 - 10, life: 0.55, color, s: 1 + ((Math.random() * 2) | 0),
  });
}
function addFloater(text, color) { floaters.push({ text, color, y: RH * 0.4, life: 1.7 }); }
function flashHurt() { if (vignetteEl) { vignetteEl.classList.remove('lj-hit'); void vignetteEl.offsetWidth; vignetteEl.classList.add('lj-hit'); } }

// ── HUD / DOM ────────────────────────────────────────────────────────────────
function updateHud() {
  if (!hudEl) return;
  const hpPct = clamp(hp / MAX_HP, 0, 1);
  hudEl.innerHTML =
    `<div class="lj-hp"><div class="lj-hp-fill" style="width:${(hpPct * 100).toFixed(0)}%"></div><span>❤ ${Math.max(0, Math.ceil(hp))}</span></div>` +
    `<div class="lj-stat">🪓 Lv ${wcLvl()}</div>` +
    `<div class="lj-stat">🌲 ${felled} felled</div>` +
    `<div class="lj-stat">${ZONES[curZone].name}</div>` +
    `<span class="lj-stat aq-credits-display">💰 ${credits()}</span>`;
  if (vignetteEl) vignetteEl.style.opacity = (0.1 + (1 - hpPct) * 0.6).toFixed(2);
}
function refreshInfo() {
  if (infoEl) infoEl.textContent = `${AXES[axeTier()].name} axe (🪓${axePower()}) · ${sessionLogs} logs to the 🎒 inventory`;
  renderZones(); renderShop(); updateHud();
}
function renderZones() {
  if (!zoneEl) return;
  const l = wcLvl();
  zoneEl.innerHTML = '';
  ZONES.forEach((z, i) => {
    const unlocked = l >= z.lvl;
    const b = el('button', 'lj-btn' + (i === curZone ? ' lj-btn-on' : ''));
    b.disabled = !unlocked;
    b.textContent = unlocked ? z.name : `🔒 ${z.name} · Lv${z.lvl}`;
    b.addEventListener('click', () => {
      if (!unlocked || i === curZone) return;
      curZone = i;
      try { localStorage.setItem('aq_lumber_zone', String(i)); window.aqGamePersist && window.aqGamePersist('aq_lumber_zone'); } catch (e) {}
      enterZone(); refreshInfo();
    });
    zoneEl.appendChild(b);
  });
}
function renderShop() {
  if (!shopEl) return;
  const tier = axeTier();
  shopEl.innerHTML = '';
  if (tier >= AXES.length - 1) { shopEl.appendChild(el('div', 'lj-info', 'Best axe! 🪓 ' + axePower())); return; }
  const next = AXES[tier + 1];
  const btn = el('button', 'lj-btn lj-btn-buy');
  btn.disabled = credits() < next.cost;
  btn.textContent = `Upgrade → ${next.name} axe (🪓${next.power}, wider sweet spot)  💰${next.cost}`;
  btn.addEventListener('click', () => {
    if (credits() < next.cost) return;
    if (typeof window.aqSetCredits === 'function') window.aqSetCredits(credits() - next.cost);
    localStorage.setItem('aq_lumber_axe', String(tier + 1));
    if (window.aqGamePersist) window.aqGamePersist('aq_lumber_axe');
    sfx('collect');
    addFloater(next.name.toUpperCase() + ' AXE!', next.color);
    refreshInfo();
  });
  shopEl.appendChild(btn);
}
function enterZone() {
  treesMod.clear(); meter = null;
  bakeArt();
  px = 6.5; py = 6.5; pa = 0.6; pitch = 0;
  if (collide(px, py)) px += 1.4;
}

function clearOverlay() { if (overlayEl) { overlayEl.remove(); overlayEl = null; } }
function showStart() {
  state = 'start';
  const o = el('div', 'lj-overlay'); overlayEl = o;
  o.appendChild(el('div', 'lj-title', '🪓 LUMBERJACK'));
  o.appendChild(el('div', 'lj-sub', 'An endless forest rolls out as you wander. Walk up to a tree and <b>swing on the green</b> — the bright centre is a PERFECT chop. When it creaks… <b>GET OUT OF THE WAY.</b> Logs pay credits and stack in your 🎒 inventory.'));
  o.appendChild(el('div', 'lj-sub lj-hint', _touch
    ? 'Left pad to move · drag to look (up & down!) · CHOP button to swing'
    : 'WASD moves · mouse looks (up & down!) · click or Space swings · Esc frees the mouse'));
  const b = el('button', 'lj-bigbtn', '▶ Into the woods');
  b.onclick = () => { state = 'playing'; clearOverlay(); requestLock(); updateHud(); };
  o.appendChild(b);
  const view = area && area.querySelector('.lj-view');
  if (view) view.appendChild(o);
}
function showResume() {
  if (overlayEl || _touch) return;
  const o = el('div', 'lj-overlay'); overlayEl = o;
  o.appendChild(el('div', 'lj-title', '⏸ Paused'));
  const b = el('button', 'lj-bigbtn', '▶ Back to the woods');
  b.onclick = () => requestLock();
  o.appendChild(b);
  const view = area && area.querySelector('.lj-view');
  if (view) view.appendChild(o);
}

// ── input ────────────────────────────────────────────────────────────────────
function requestLock() {
  clearOverlay(); paused = false;
  if (_touch) return;
  if (cv && cv.requestPointerLock) { try { cv.requestPointerLock(); } catch (e) {} }
}
function exitPointerLock() { if (document.exitPointerLock && document.pointerLockElement === cv) { try { document.exitPointerLock(); } catch (e) {} } }
function onKey(e) {
  const w = document.getElementById('lumber-wrap');
  if (!w || !w.classList.contains('open')) return;
  if (e.type === 'keydown') {
    if (window.aqIsActiveApp && !window.aqIsActiveApp('lumber')) return;
    keys[e.code] = true;
    if (state === 'playing' && e.code === 'Space') { e.preventDefault(); chopping = true; swing(); }
  } else {
    keys[e.code] = false;
    if (e.code === 'Space') chopping = false;
  }
}
function onMouseMove(e) {
  if (state !== 'playing' || document.pointerLockElement !== cv) return;
  pa += e.movementX * 0.0026;
  pitch = clamp(pitch - e.movementY * 0.22, -PITCH_MAX, PITCH_MAX);
}
function onMouseDown() {
  if (state !== 'playing') return;
  if (document.pointerLockElement !== cv && !_touch) { requestLock(); return; }
  chopping = true; swing();
}
function onLockChange() {
  if (_touch) return;
  if (document.pointerLockElement === cv) { paused = false; clearOverlay(); }
  else if (state === 'playing') { paused = true; chopping = false; showResume(); }
}
function buildTouch(view) {
  touchEl = el('div', 'lj-touch');
  const stick = el('div', 'lj-stick', '<div class="lj-stick-knob"></div>');
  const chop = el('div', 'lj-chop', '🪓');
  touchEl.append(stick, chop);
  view.appendChild(touchEl);
  let sid = null, ox = 0, oy = 0;
  const knob = stick.querySelector('.lj-stick-knob');
  stick.addEventListener('touchstart', e => { const t = e.changedTouches[0]; sid = t.identifier; ox = t.clientX; oy = t.clientY; e.preventDefault(); }, { passive: false });
  stick.addEventListener('touchmove', e => { for (const t of e.changedTouches) if (t.identifier === sid) { const dx = clamp((t.clientX - ox) / 40, -1, 1), dy = clamp((t.clientY - oy) / 40, -1, 1); touchMove.x = dx; touchMove.y = dy; knob.style.transform = `translate(${dx * 22}px,${dy * 22}px)`; } e.preventDefault(); }, { passive: false });
  const endStick = e => { for (const t of e.changedTouches) if (t.identifier === sid) { sid = null; touchMove.x = touchMove.y = 0; knob.style.transform = ''; } };
  stick.addEventListener('touchend', endStick); stick.addEventListener('touchcancel', endStick);
  let lid = null, lx = 0, ly = 0;
  cv.addEventListener('touchstart', e => { if (state !== 'playing') return; const t = e.changedTouches[0]; lid = t.identifier; lx = t.clientX; ly = t.clientY; }, { passive: true });
  cv.addEventListener('touchmove', e => { for (const t of e.changedTouches) if (t.identifier === lid) {
    pa += (t.clientX - lx) * 0.006; lx = t.clientX;
    pitch = clamp(pitch - (t.clientY - ly) * 0.4, -PITCH_MAX, PITCH_MAX); ly = t.clientY;
  } }, { passive: true });
  const endLook = e => { for (const t of e.changedTouches) if (t.identifier === lid) lid = null; };
  cv.addEventListener('touchend', endLook); cv.addEventListener('touchcancel', endLook);
  chop.addEventListener('touchstart', e => { chopping = true; if (state === 'playing') swing(); e.preventDefault(); }, { passive: false });
  chop.addEventListener('touchend', e => { chopping = false; e.preventDefault(); }, { passive: false });
}

// ── main loop ────────────────────────────────────────────────────────────────
function tick(t) {
  const dt = Math.min(0.05, (t - (_lastT || t)) / 1000); _lastT = t;
  if (swingT > 0) swingT = Math.max(0, swingT - dt * 4);
  if (shakeT > 0) shakeT = Math.max(0, shakeT - dt * 2.2);
  for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 200 * dt; p.life -= dt; }
  if (particles.length) particles = particles.filter(p => p.life > 0);
  for (const f of floaters) { f.y -= 11 * dt; f.life -= dt; }
  if (floaters.length) floaters = floaters.filter(f => f.life > 0);
  if (state === 'playing' && !paused) {
    updatePlayer(dt, performance.now());
    updateWorld(dt, performance.now());
    if (chopping) swing();
    updateHud();
  }
  render(t);
  raf = requestAnimationFrame(tick);
}

// ── build / open ─────────────────────────────────────────────────────────────
function injectStyle() {
  if (document.getElementById('lj-style')) return;
  const s = el('style'); s.id = 'lj-style';
  s.textContent = `
  #lumber-wrap{position:fixed;top:48px;left:50%;transform:translateX(-50%);width:560px;max-width:96vw;
    border-radius:var(--chrome-radius,10px);z-index:540;flex-direction:column;background:var(--panel);
    border:1.5px solid var(--win-border,var(--border));box-shadow:var(--win-shadow,0 18px 50px rgba(0,0,0,.45));
    font-family:var(--font-ui);overflow:hidden}
  #lumber-wrap.open{display:flex}
  #lumber-area{position:relative;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;background:#101810;padding:0}
  .lj-view{position:relative;background:#000;line-height:0}
  .lj-view canvas{width:100%;height:auto;display:block;image-rendering:pixelated;image-rendering:crisp-edges;cursor:crosshair;touch-action:none}
  .lj-vignette{position:absolute;inset:0;pointer-events:none;z-index:5;opacity:0;transition:opacity .25s;box-shadow:inset 0 0 60px 10px rgba(150,0,0,.85)}
  .lj-vignette.lj-hit{animation:ljhit .25s ease-out}
  @keyframes ljhit{0%{box-shadow:inset 0 0 90px 30px rgba(220,0,0,1)}100%{box-shadow:inset 0 0 60px 10px rgba(150,0,0,.85)}}
  .lj-hud{display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:11px;font-weight:800;color:#fff;background:linear-gradient(180deg,#1c2818,#0e160c);flex-wrap:wrap}
  .lj-hp{position:relative;flex:1;min-width:90px;height:15px;border-radius:8px;background:#3a0c0c;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
  .lj-hp-fill{height:100%;background:linear-gradient(90deg,#ff3b3b,#ff8a4a);transition:width .15s}
  .lj-hp span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;text-shadow:0 1px 2px #000}
  .lj-stat{background:rgba(255,255,255,.08);padding:3px 7px;border-radius:7px;white-space:nowrap}
  .lj-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:5px 8px;background:#162012}
  .lj-btn{font-family:var(--font-ui,sans-serif);font-weight:800;font-size:11px;color:#e8f0e0;background:#26321e;border:1px solid #45603a;border-radius:7px;padding:6px 10px;cursor:pointer}
  .lj-btn:hover:not(:disabled){border-color:#8ad06a}
  .lj-btn:disabled{opacity:.45;cursor:default}
  .lj-btn-on{outline:2px solid #ffd84a;color:#ffd84a}
  .lj-btn-buy{background:linear-gradient(180deg,#3a5a2a,#22381a);border-color:#5a8a3a;color:#d8ffb8}
  .lj-info{font-size:11px;font-weight:700;color:#b8d8a8}
  .lj-overlay{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;text-align:center;background:rgba(8,14,6,.92);color:#fff;line-height:1.45}
  .lj-title{font-size:21px;font-weight:900;letter-spacing:1px;color:#8ad06a;text-shadow:0 2px 0 #1c3812}
  .lj-sub{font-size:12px;opacity:.92;max-width:400px;line-height:1.5}
  .lj-hint{opacity:.7;font-size:11px}
  .lj-bigbtn{font-size:14px;font-weight:800;padding:11px 24px;border-radius:10px;cursor:pointer;color:#0c1c06;background:linear-gradient(180deg,#a8e078,#5a9a3a);border:none}
  .lj-bigbtn:hover{filter:brightness(1.08)}
  .lj-touch{display:none;position:absolute;inset:0;z-index:8;pointer-events:none}
  .lj-touch>*{pointer-events:auto}
  .lj-stick{position:absolute;left:14px;bottom:14px;width:84px;height:84px;border-radius:50%;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 2px rgba(255,255,255,.18)}
  .lj-stick-knob{position:absolute;left:26px;top:26px;width:32px;height:32px;border-radius:50%;background:rgba(168,224,120,.65)}
  .lj-chop{position:absolute;right:14px;bottom:20px;width:74px;height:74px;border-radius:50%;background:rgba(168,224,120,.45);display:flex;align-items:center;justify-content:center;font-size:30px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.25)}
  @media (max-width:768px){
    #lumber-wrap{width:100vw;top:0;left:0;transform:none;height:100%;max-height:none;border-radius:0}
    #lumber-area{overflow:hidden}
    .lj-view{flex:1;min-height:0;display:flex}
    .lj-view canvas{flex:1;height:100%;object-fit:contain;background:#000}
  }`;
  document.head.appendChild(s);
}
function build() {
  area = document.getElementById('lumber-area');
  if (!area) return;
  injectStyle();
  area.innerHTML = '';
  hudEl = el('div', 'lj-hud'); area.appendChild(hudEl);
  const view = el('div', 'lj-view');
  cv = mkCanvas(RW, RH); ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  view.appendChild(cv);
  vignetteEl = el('div', 'lj-vignette'); view.appendChild(vignetteEl);
  buildTouch(view);
  area.appendChild(view);
  const info = el('div', 'lj-bar'); infoEl = el('div', 'lj-info'); info.appendChild(infoEl); area.appendChild(info);
  zoneEl = el('div', 'lj-bar'); area.appendChild(zoneEl);
  shopEl = el('div', 'lj-bar'); area.appendChild(shopEl);
  if (!window._ljBound) {
    window._ljBound = true;
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', () => { chopping = false; });
    document.addEventListener('pointerlockchange', onLockChange);
  }
  cv.addEventListener('mousedown', onMouseDown);
  _built = true;
}
function openLumberjack(show = true) {
  const w = document.getElementById('lumber-wrap');
  if (!w) return;
  if (show === false) {
    w.classList.remove('open'); w.style.display = 'none';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    exitPointerLock(); chopping = false; for (const k in keys) keys[k] = false;
    return;
  }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('lumber'); window.OS.focus('lumber'); }
  if (!_built) build();
  const saved = Math.min(maxZone(), parseInt(localStorage.getItem('aq_lumber_zone') || '0', 10) || 0);
  if (saved !== curZone || _bakedZone !== curZone) { curZone = saved; enterZone(); }
  refreshInfo();
  if (touchEl) touchEl.style.display = _touch ? 'block' : 'none';
  if (state !== 'playing') showStart();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') {
  window.openLumberjack = openLumberjack;
  window.addEventListener('aq-gamedata-synced', () => {
    const w = document.getElementById('lumber-wrap');
    if (!w || !w.classList.contains('open')) return;
    const saved = Math.min(maxZone(), parseInt(localStorage.getItem('aq_lumber_zone') || '0', 10) || 0);
    if (saved !== curZone) { curZone = saved; enterZone(); }
    refreshInfo();
  });
  // test hook (headless harness drives the sim without exports)
  if (window.__ljTestHook) window.__ljTestHook({
    snap: () => ({ state, px, py, pa, pitch, hp, meter, felled, sessionLogs, curZone, treesMod }),
    set: o => { if (o.px != null) px = o.px; if (o.py != null) py = o.py; if (o.pa != null) pa = o.pa; if (o.state) state = o.state; dirX = Math.cos(pa); dirY = Math.sin(pa); },
    swing, facingTree, treeState, nearbyTrees, fellTree, resolveFall, ZONES, AXES,
  });
}
