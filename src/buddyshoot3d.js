// Aquatune Buddy Shoot 3D — a Doom/Wolfenstein-style raycaster roguelite.
//
// A 90s "boomer shooter": pixelated textured-wall raycasting, billboarded
// demonic-buddy enemies, multiple guns. Post-Void-style structure — clear a
// simple randomly-generated stage, then pick 1 of 3 random perks (guns can
// appear as unlock cards). Permadeath: die and you restart from level 1; only a
// meta "best level reached" persists. Conventional health (enemies hurt you,
// pickups heal). All art is procedural — no external assets.
//
// Reuses the buddy-mascot palettes (skewed dark/red) for the demon look, and the
// global aqAddXp/aqAddCredits/recordScore/aqGamePersist/buddyShoot3dSfx hooks.

// ── render / world constants ──────────────────────────────────────────────────
const RW_BASE = 220, RH = 165;        // internal backing-store resolution (4:3-ish)
let RW = RW_BASE;                       // dropped on touch devices for perf
const TEX = 32;                         // wall texture size
const MAXVIS = 15;                      // fog distance for wall shading
const FOV_PLANE = 0.70;                 // camera-plane half-length (~70° FOV)
const TWOPI = Math.PI * 2;

const _touch = (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches);
if (_touch) RW = 160;

// ── tiny helpers ───────────────────────────────────────────────────────────────
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sfx(n) { try { window.buddyShoot3dSfx && window.buddyShoot3dSfx(n); } catch (e) {} }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function rint(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
function choice(arr) { return arr[(Math.random() * arr.length) | 0]; }

// ── procedural art (baked once at module load) ──────────────────────────────────
let wallTex = [];            // array of 32×32 canvases, indexed by tileId-1
let demonSprites = {};       // type -> { normal, hurt }
let pickupSprites = {};      // 'health' | 'ammo'
let portalSprite = null, spitSprite = null;

function bakeWall(base, mortar, accent) {
  const c = mkCanvas(TEX, TEX), g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, TEX, TEX);
  const bh = 8;
  for (let by = 0; by < TEX; by += bh) {
    const off = ((by / bh) & 1) ? 8 : 0;
    g.fillStyle = mortar; g.fillRect(0, by, TEX, 1);                 // mortar row
    for (let bx = off; bx < TEX + 8; bx += 16) { g.fillRect(((bx % TEX) + TEX) % TEX, by, 1, bh); }  // verticals
  }
  // grime / highlight noise
  for (let i = 0; i < 90; i++) {
    g.fillStyle = (Math.random() < 0.5 ? 'rgba(0,0,0,0.18)' : accent);
    g.globalAlpha = 0.4 + Math.random() * 0.4;
    g.fillRect((Math.random() * TEX) | 0, (Math.random() * TEX) | 0, 1, 1);
  }
  g.globalAlpha = 1;
  return c;
}

// Draw an edgy demonic buddy: round blob body + head, horns, angry slit eyes, fangs.
function bakeDemon(body, horn, eye) {
  const W = 36, H = 42, c = mkCanvas(W, H), g = c.getContext('2d');
  const cx = W / 2;
  // horns (behind head)
  g.fillStyle = horn;
  g.beginPath(); g.moveTo(cx - 9, 13); g.lineTo(cx - 15, 1); g.lineTo(cx - 4, 9); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(cx + 9, 13); g.lineTo(cx + 15, 1); g.lineTo(cx + 4, 9); g.closePath(); g.fill();
  // body blob
  const bg = g.createRadialGradient(cx - 5, 18, 3, cx, 26, 22);
  bg.addColorStop(0, body[0]); bg.addColorStop(0.55, body[1]); bg.addColorStop(1, body[2]);
  g.fillStyle = bg;
  g.beginPath(); g.ellipse(cx, 30, 13, 11, 0, 0, TWOPI); g.fill();      // body
  g.beginPath(); g.arc(cx, 16, 12, 0, TWOPI); g.fill();                 // head
  // little clawed feet
  g.fillStyle = body[2];
  g.fillRect(cx - 9, 39, 5, 3); g.fillRect(cx + 4, 39, 5, 3);
  // angry brows
  g.strokeStyle = body[2]; g.lineWidth = 2.4;
  g.beginPath(); g.moveTo(cx - 10, 11); g.lineTo(cx - 2, 14); g.stroke();
  g.beginPath(); g.moveTo(cx + 10, 11); g.lineTo(cx + 2, 14); g.stroke();
  // glowing eyes + slit pupils
  g.fillStyle = eye;
  g.beginPath(); g.ellipse(cx - 5, 17, 3.1, 2.3, -0.3, 0, TWOPI); g.fill();
  g.beginPath(); g.ellipse(cx + 5, 17, 3.1, 2.3, 0.3, 0, TWOPI); g.fill();
  g.fillStyle = '#100006';
  g.fillRect(cx - 5.5, 15, 1.2, 4.4); g.fillRect(cx + 4.3, 15, 1.2, 4.4);
  // fanged frown
  g.strokeStyle = '#180008'; g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(cx - 5, 25); g.quadraticCurveTo(cx, 22, cx + 5, 25); g.stroke();
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(cx - 3, 24); g.lineTo(cx - 1.5, 27); g.lineTo(cx - 4.5, 27); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(cx + 3, 24); g.lineTo(cx + 4.5, 27); g.lineTo(cx + 1.5, 27); g.closePath(); g.fill();
  return c;
}
function makeHurt(src) {
  const c = mkCanvas(src.width, src.height), g = c.getContext('2d');
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = 'rgba(255,255,255,0.92)'; g.fillRect(0, 0, c.width, c.height);
  return c;
}
function bakeHealth() {
  const c = mkCanvas(18, 18), g = c.getContext('2d');
  g.fillStyle = '#0b1a10'; g.fillRect(1, 1, 16, 16);
  g.fillStyle = '#37e06a'; g.fillRect(2, 2, 14, 14);
  g.fillStyle = '#0b1a10'; g.fillRect(7, 4, 4, 10); g.fillRect(4, 7, 10, 4);
  g.fillStyle = '#9bffc0'; g.fillRect(8, 4, 2, 10); g.fillRect(4, 8, 10, 2);
  return c;
}
function bakeAmmo() {
  const c = mkCanvas(18, 18), g = c.getContext('2d');
  g.fillStyle = '#2a1c08'; g.fillRect(1, 5, 16, 11);
  g.fillStyle = '#caa23a'; g.fillRect(2, 6, 14, 9);
  g.fillStyle = '#fff0b0'; g.fillRect(3, 2, 2, 5); g.fillRect(7, 2, 2, 5); g.fillRect(11, 2, 2, 5);
  g.fillStyle = '#7a5e1c'; g.fillRect(2, 10, 14, 1);
  return c;
}
function bakePortal() {
  const c = mkCanvas(30, 40), g = c.getContext('2d');
  for (let i = 6; i >= 0; i--) {
    const t = i / 6;
    g.fillStyle = `rgba(${180 - t * 120 | 0},${20 + t * 30 | 0},${200 - t * 40 | 0},${0.55 + (1 - t) * 0.45})`;
    g.beginPath(); g.ellipse(15, 20, 4 + t * 11, 6 + t * 16, 0, 0, TWOPI); g.fill();
  }
  g.fillStyle = '#fff'; g.beginPath(); g.ellipse(15, 20, 3, 5, 0, 0, TWOPI); g.fill();
  return c;
}
function bakeSpit() {
  const c = mkCanvas(12, 12), g = c.getContext('2d');
  g.fillStyle = 'rgba(160,40,220,0.85)'; g.beginPath(); g.arc(6, 6, 5.5, 0, TWOPI); g.fill();
  g.fillStyle = '#e8a0ff'; g.beginPath(); g.arc(6, 6, 2.4, 0, TWOPI); g.fill();
  return c;
}
function bakeArt() {
  if (wallTex.length) return;
  wallTex = [
    bakeWall('#7a1414', '#350606', 'rgba(255,120,80,0.5)'),   // hell brick
    bakeWall('#3a3340', '#16121c', 'rgba(180,180,210,0.5)'),  // dark stone
    bakeWall('#5a2230', '#1c0810', 'rgba(255,90,140,0.45)'),  // flesh wall
  ];
  // demon archetypes (reuse buddy red/dark families, skewed demonic)
  demonSprites.imp     = { normal: bakeDemon(['#ff9a78', '#e0341a', '#5a0808'], '#2a0404', '#ffd23a') };
  demonSprites.brute   = { normal: bakeDemon(['#b06a5a', '#7a1414', '#2a0606'], '#1a0202', '#ff6a2a') };
  demonSprites.spitter = { normal: bakeDemon(['#c79aff', '#7a2fc0', '#2e0a64'], '#160430', '#9bff5a') };
  demonSprites.boss    = { normal: bakeDemon(['#ff5a3a', '#8a0000', '#1a0000'], '#000', '#fff23a') };
  demonSprites.charger  = { normal: bakeDemon(['#ffb24a', '#e05a14', '#5a2400'], '#2a1000', '#fff04a') };
  demonSprites.bomber   = { normal: bakeDemon(['#6a6a6a', '#2a2a2a', '#0a0a0a'], '#000', '#ff3a2a') };
  demonSprites.summoner = { normal: bakeDemon(['#9bff9b', '#2f9a4b', '#0a3a18'], '#06200c', '#ff5af0') };
  demonSprites.wraith   = { normal: bakeDemon(['#dff0ff', '#9ab8d8', '#46607a'], '#243646', '#bfffff') };
  for (const k in demonSprites) demonSprites[k].hurt = makeHurt(demonSprites[k].normal);
  pickupSprites.health = bakeHealth();
  pickupSprites.ammo = bakeAmmo();
  portalSprite = bakePortal();
  spitSprite = bakeSpit();
}

// ── weapons ──────────────────────────────────────────────────────────────────
const WEAPONS = {
  pistol:  { name: 'Pistol',   dmg: 20, fireRate: 300, spread: 0.02, pellets: 1, auto: false, ammo: Infinity, color: '#cfd3da', sfx: 'shoot_pistol', recoil: 5 },
  shotgun: { name: 'Shotgun',  dmg: 11, fireRate: 720, spread: 0.20, pellets: 7, auto: false, startAmmo: 28, color: '#8a5a2a', sfx: 'shoot_shotgun', recoil: 11 },
  smg:     { name: 'SMG',      dmg: 9,  fireRate: 85,  spread: 0.07, pellets: 1, auto: true,  startAmmo: 150, color: '#5a5e66', sfx: 'shoot_smg', recoil: 3 },
  rocket:  { name: 'Rocket',   dmg: 70, fireRate: 950, spread: 0.0,  pellets: 1, auto: false, startAmmo: 16, color: '#3a6a3a', sfx: 'shoot_rocket', recoil: 14, splash: 2.4 },
};

// ── perks ──────────────────────────────────────────────────────────────────────
const PERKS = [
  { id: 'glasscannon', name: 'Glass Cannon', icon: '💀', desc: '+55% damage, −25% max HP', weight: 8, apply: s => { s.dmgMul *= 1.55; s.maxHp *= 0.75; } },
  { id: 'adrenaline',  name: 'Adrenaline',   icon: '⚡', desc: '+20% move speed',            weight: 10, apply: s => { s.moveSpeed *= 1.2; } },
  { id: 'rapidfire',   name: 'Rapid Fire',   icon: '🔥', desc: '−20% fire interval',          weight: 10, apply: s => { s.fireRateMul *= 0.8; } },
  { id: 'vampirism',   name: 'Vampirism',    icon: '🩸', desc: '+5 HP per kill',              weight: 9,  apply: s => { s.lifesteal += 5; } },
  { id: 'bulk',        name: 'Bulk Up',      icon: '🛡️', desc: '+40 max HP (and heal)',       weight: 9,  apply: s => { s.maxHp += 40; } },
  { id: 'steady',      name: 'Steady Hands', icon: '🎯', desc: '−45% spread',                 weight: 8,  apply: s => { s.spreadMul *= 0.55; } },
  { id: 'doubletap',   name: 'Double Tap',   icon: '✌️', desc: '+1 pellet per shot',          weight: 6,  apply: s => { s.pelletBonus += 1; } },
  { id: 'berserker',   name: 'Berserker',    icon: '😤', desc: 'More damage the lower your HP', weight: 7, apply: s => { s.berserk += 1; } },
  { id: 'quickfeet',   name: 'Quick Feet',   icon: '🏃', desc: 'Speed burst after each kill',  weight: 7, apply: s => { s.killBurst += 1; } },
  { id: 'longshot',    name: 'Long Shot',    icon: '🔭', desc: '+damage at range',            weight: 6,  apply: s => { s.rangeDmg += 0.05; } },
  { id: 'lifeline',    name: 'Lifeline',     icon: '💞', desc: 'Cheat death once per run',    weight: 5, maxStack: 1, apply: s => { s.revive += 1; } },
  { id: 'thickskin',   name: 'Thick Skin',   icon: '🦏', desc: '−20% damage taken',           weight: 8,  apply: s => { s.dmgTaken *= 0.8; } },
  // weapon-unlock cards (offered only when not yet owned)
  { id: 'gun_shotgun', name: 'Shotgun',  icon: '🔫', desc: 'Unlock the Shotgun',  weight: 7, gun: 'shotgun', apply: () => {} },
  { id: 'gun_smg',     name: 'SMG',      icon: '🔫', desc: 'Unlock the SMG',      weight: 6, gun: 'smg', apply: () => {} },
  { id: 'gun_rocket',  name: 'Rocket',   icon: '🚀', desc: 'Unlock the Launcher', weight: 4, gun: 'rocket', apply: () => {} },
];

// ── enemy archetypes ───────────────────────────────────────────────────────────
const ETYPE = {
  imp:      { hp: 30,  speed: 2.7, radius: 0.42, dmg: 8,  size: 0.85, pts: 10, ranged: false, color: 'imp' },
  brute:    { hp: 95,  speed: 1.4, radius: 0.5,  dmg: 18, size: 1.15, pts: 30, ranged: false, color: 'brute' },
  spitter:  { hp: 42,  speed: 1.5, radius: 0.42, dmg: 12, size: 0.9,  pts: 20, ranged: true,  color: 'spitter' },
  charger:  { hp: 60,  speed: 2.3, radius: 0.45, dmg: 15, size: 0.95, pts: 28, ranged: false, color: 'charger' },  // periodically lunges
  bomber:   { hp: 26,  speed: 3.0, radius: 0.4,  dmg: 34, size: 0.9,  pts: 26, ranged: false, color: 'bomber' },   // kamikaze — explodes on contact
  summoner: { hp: 80,  speed: 1.2, radius: 0.5,  dmg: 0,  size: 1.05, pts: 45, ranged: false, color: 'summoner' }, // spawns imps
  wraith:   { hp: 22,  speed: 3.5, radius: 0.38, dmg: 11, size: 0.82, pts: 22, ranged: false, color: 'wraith' },   // fast, ghostly
  boss:     { hp: 420, speed: 1.5, radius: 0.7,  dmg: 30, size: 1.75, pts: 220, ranged: false, color: 'boss' },
};
const ENEMY_HARDCAP = 38;   // total alive incl. summoned (perf + fairness ceiling)

// ── per-level modifiers (Post-Void-style affixes) ───────────────────────────────
const MODS = [
  { id: 'swarm',   name: 'Swarm',      icon: '🐝', apply: m => { m.count = Math.round(m.count * 1.6); m.hpMul *= 0.7; } },
  { id: 'berserk', name: 'Berserk',    icon: '😡', apply: m => { m.spMul *= 1.25; m.dmgMul *= 1.3; } },
  { id: 'fog',     name: 'Fog',        icon: '🌫️', apply: m => { m.vis = 0.5; } },
  { id: 'elite',   name: 'Elite Pack', icon: '⭐', apply: m => { m.elite = true; } },
  { id: 'glass',   name: 'Glass',      icon: '🔪', apply: m => { m.glass = true; } },
  { id: 'frenzy',  name: 'Frenzy',     icon: '⚡', apply: m => { m.coolMul = 0.6; } },
];

// ── module state ────────────────────────────────────────────────────────────────
let _built = false, raf = null, _lastT = 0;
let cv = null, ctx = null, area = null, hudEl = null, overlayEl = null, vignetteEl = null, touchEl = null;
let zbuffer = null;
let state = 'start';        // start | playing | levelclear | gameover
let paused = false;

// world
let MW = 24, MH = 24, map = null;
let px = 1.5, py = 1.5, pa = 0, dirX = 1, dirY = 0, planeX = 0, planeY = FOV_PLANE;
let enemies = [], pickups = [], eproj = [], portal = null;

// run / progression
let run = null;
const keys = {};
let firing = false, lastFireT = 0, recoilT = 0, walkPhase = 0, muzzleT = 0;
let bestLevel = 0;
// per-level modifier state (set in genLevel)
let levelMods = [], visDist = MAXVIS, glassMod = false, frenzyMul = 1;
let lvlHpMul = 1, lvlSpMul = 1, lvlDmgMul = 1, bannerT = null;

const BASE_STATS = () => ({ dmgMul: 1, moveSpeed: 3.4, fireRateMul: 1, maxHp: 100, spreadMul: 1, pelletBonus: 0, lifesteal: 0, rangeDmg: 0, berserk: 0, killBurst: 0, revive: 0, dmgTaken: 1 });

function freshRun() {
  return { level: 0, score: 0, kills: 0, hp: 100, maxHp: 100, weapons: ['pistol'], curWeapon: 0, ammo: {}, perks: [], stats: BASE_STATS(), speedBurstUntil: 0, reviveUsed: false };
}
function curWeaponId() { return run.weapons[run.curWeapon]; }
function recomputeStats() {
  const s = BASE_STATS();
  for (const id of run.perks) { const p = PERKS.find(x => x.id === id); if (p) p.apply(s); }
  const oldMax = run.maxHp;
  run.stats = s; run.maxHp = Math.round(s.maxHp);
  if (run.maxHp > oldMax) run.hp = Math.min(run.maxHp, run.hp + (run.maxHp - oldMax));   // bulk-style heal
  run.hp = clamp(run.hp, 1, run.maxHp);
}

// ── map / level generation ──────────────────────────────────────────────────────
function idx(x, y) { return y * MW + x; }
function isWall(x, y) { const mx = x | 0, my = y | 0; if (mx < 0 || my < 0 || mx >= MW || my >= MH) return true; return map[idx(mx, my)] > 0; }
function carveRect(r) { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x > 0 && y > 0 && x < MW - 1 && y < MH - 1) map[idx(x, y)] = 0; }
function carveCorridor(x1, y1, x2, y2) {
  for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) { map[idx(x, y1)] = 0; if (y1 + 1 < MH - 1) map[idx(x, y1 + 1)] = 0; }
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) { map[idx(x2, y)] = 0; if (x2 + 1 < MW - 1) map[idx(x2 + 1, y)] = 0; }
}

function genLevel(level) {
  MW = MH = Math.min(34, 22 + Math.floor(level * 0.7));
  map = new Uint8Array(MW * MH);
  // start solid; assign varied wall tile ids for texture variety
  for (let i = 0; i < map.length; i++) map[i] = 1 + ((Math.random() < 0.7) ? 0 : rint(1, 2));
  const rooms = [], nRooms = Math.min(12, 4 + level);
  let tries = 0;
  while (rooms.length < nRooms && tries++ < 200) {
    const w = rint(4, 7), h = rint(4, 7);
    const r = { x: rint(1, MW - w - 2), y: rint(1, MH - h - 2), w, h };
    if (rooms.some(o => r.x < o.x + o.w + 1 && r.x + r.w + 1 > o.x && r.y < o.y + o.h + 1 && r.y + r.h + 1 > o.y)) continue;
    rooms.push(r); carveRect(r);
  }
  const ctr = r => ({ x: (r.x + r.w / 2) | 0, y: (r.y + r.h / 2) | 0 });
  for (let i = 1; i < rooms.length; i++) { const a = ctr(rooms[i - 1]), b = ctr(rooms[i]); carveCorridor(a.x, a.y, b.x, b.y); }
  for (let k = 0; k < 2; k++) { const a = ctr(choice(rooms)), b = ctr(choice(rooms)); carveCorridor(a.x, a.y, b.x, b.y); }

  // player spawn = first room center
  const s = ctr(rooms[0]); px = s.x + 0.5; py = s.y + 0.5; pa = Math.random() * TWOPI;
  // exit = farthest room from spawn
  let far = rooms[0], fd = -1;
  for (const r of rooms) { const c = ctr(r); const d = (c.x - s.x) ** 2 + (c.y - s.y) ** 2; if (d > fd) { fd = d; far = r; } }
  const fc = ctr(far); portal = { x: fc.x + 0.5, y: fc.y + 0.5, kind: 'portal', size: 0.85, float: 0.04, canvas: portalSprite };

  // enemies — steeper scaling + per-level modifiers
  enemies = []; eproj = [];
  const boss = level % 5 === 0;
  const m = {
    count: Math.min(26, 5 + Math.floor(level * 2.1)),
    hpMul: 1 + 0.14 * (level - 1) + 0.004 * (level - 1) ** 2,   // slightly super-linear so deep levels bite
    spMul: Math.min(2.3, 1 + 0.04 * (level - 1)),
    dmgMul: 1 + 0.07 * (level - 1),
    vis: 1, elite: false, glass: false, coolMul: 1,
  };
  // roll 0–2 modifiers (more likely the deeper you are)
  levelMods = [];
  let nMods = level < 2 ? 0 : level < 6 ? (Math.random() < 0.6 ? 1 : 0) : (Math.random() < 0.5 ? 2 : 1);
  const pool = MODS.slice();
  while (nMods-- > 0 && pool.length) { const mod = pool.splice((Math.random() * pool.length) | 0, 1)[0]; mod.apply(m); levelMods.push(mod); }
  lvlHpMul = m.hpMul; lvlSpMul = m.spMul; lvlDmgMul = m.dmgMul;
  visDist = MAXVIS * m.vis; glassMod = m.glass; frenzyMul = m.coolMul;

  const otherRooms = () => (rooms.slice(1).length ? rooms.slice(1) : rooms);
  if (boss) { spawnEnemy('boss', far, m.hpMul, m.spMul, m.dmgMul); m.count = Math.max(4, m.count - 5); }
  for (let i = 0; i < m.count; i++) spawnEnemy(pickKind(level), choice(otherRooms()), m.hpMul, m.spMul, m.dmgMul);
  if (m.elite) spawnEnemy(level >= 4 ? 'charger' : 'brute', choice(otherRooms()), m.hpMul, m.spMul, m.dmgMul * 1.2, { elite: true });
  // pickups (a few more when the level is nasty)
  pickups = [];
  const pls = Math.max(2, 3 + (boss ? 2 : 0) + levelMods.length);
  for (let i = 0; i < pls; i++) scatterPickup(Math.random() < 0.6 ? 'health' : 'ammo', rooms);
}
// weighted enemy pick — new archetypes phase in by depth, imps thin out
function pickKind(level) {
  const opts = [['imp', Math.max(0.3, 1 - level * 0.04)]];
  if (level >= 2) opts.push(['spitter', 0.5]);
  if (level >= 3) opts.push(['brute', 0.32]);
  if (level >= 4) opts.push(['charger', 0.4]);
  if (level >= 6) opts.push(['bomber', 0.3]);
  if (level >= 8) opts.push(['summoner', 0.16]);
  if (level >= 10) opts.push(['wraith', 0.45]);
  let tot = 0; for (const o of opts) tot += o[1];
  let x = Math.random() * tot;
  for (const [k, w] of opts) { x -= w; if (x <= 0) return k; }
  return 'imp';
}
function spawnEnemy(kind, room, hpMul, spMul, dmgMul, opts) {
  const x = room.x + 0.5 + Math.random() * (room.w - 1), y = room.y + 0.5 + Math.random() * (room.h - 1);
  makeEnemy(kind, x, y, hpMul, spMul, dmgMul, opts);
}
function makeEnemy(kind, x, y, hpMul, spMul, dmgMul, opts) {
  if (enemies.length >= ENEMY_HARDCAP) return;
  const base = ETYPE[kind]; opts = opts || {};
  const eliteM = opts.elite ? 3 : 1, hp = Math.round(base.hp * hpMul * eliteM);
  enemies.push({
    kind, x, y, hp, maxHp: hp, speed: base.speed * spMul, radius: base.radius * (opts.elite ? 1.3 : 1),
    dmg: base.dmg * dmgMul, size: base.size * (opts.elite ? 1.5 : 1), pts: Math.round(base.pts * eliteM),
    ranged: base.ranged, elite: !!opts.elite, alpha: kind === 'wraith' ? 0.6 : 1,
    cool: Math.random() * 0.8, lunge: 0, fuse: 0, hurtT: 0, los: false, losT: 0, phase: Math.random() * TWOPI,
    canvas: demonSprites[base.color].normal, hurtCanvas: demonSprites[base.color].hurt,
  });
}
function scatterPickup(kind, rooms) {
  for (let t = 0; t < 30; t++) {
    const r = choice(rooms), x = r.x + 1 + Math.random() * Math.max(1, r.w - 2), y = r.y + 1 + Math.random() * Math.max(1, r.h - 2);
    if (!isWall(x, y)) { pickups.push({ kind, x, y, size: 0.32, float: 0.32, canvas: pickupSprites[kind] }); return; }
  }
}

// ── flow ─────────────────────────────────────────────────────────────────────
function startRun() {
  run = freshRun(); recomputeStats();
  run.hp = run.maxHp = Math.round(run.stats.maxHp);
  nextLevel();
}
function nextLevel() {
  run.level++; genLevel(run.level);
  state = 'playing'; paused = false; clearOverlay();
  lastFireT = 0; firing = false;
  setHudVisible(true);
  updateHud();
  showLevelBanner(run.level);
}
// transient, non-blocking banner announcing the level + its active modifiers
function showLevelBanner(level) {
  if (!area) return;
  const old = area.querySelector('.b3-banner'); if (old) old.remove();
  const b = el('div', 'b3-banner');
  let html = `<div class="b3-banner-lv">LEVEL ${level}${level % 5 === 0 ? ' · BOSS' : ''}</div>`;
  if (levelMods.length) html += '<div class="b3-banner-mods">' + levelMods.map(mm => `<span>${mm.icon} ${mm.name}</span>`).join('') + '</div>';
  b.innerHTML = html;
  area.appendChild(b);
  clearTimeout(bannerT); bannerT = setTimeout(() => { if (b.parentNode) b.remove(); }, 2800);
}
function clearLevel() {
  state = 'levelclear';
  exitPointerLock();
  sfx('levelclear');
  showPerkSelect();
}
function applyPerk(p) {
  sfx(p.gun ? 'newweapon' : 'perkpick');
  if (p.gun) {
    if (!run.weapons.includes(p.gun)) { run.weapons.push(p.gun); run.ammo[p.gun] = WEAPONS[p.gun].startAmmo; run.curWeapon = run.weapons.length - 1; }
  } else {
    run.perks.push(p.id); recomputeStats();
  }
  nextLevel();
  requestLock();
}
function gameOver() {
  // lifeline revive?
  if (run.stats.revive > 0 && !run.reviveUsed) {
    run.reviveUsed = true; run.hp = Math.round(run.maxHp * 0.35);
    sfx('pickup'); flashHurt(); return;
  }
  state = 'gameover';
  exitPointerLock();
  sfx('gameover');
  const level = run.level, kills = run.kills;
  const score = level * 1000 + kills * 50 + run.score;
  // meta best level (max-merge persisted to cloud)
  const prev = parseInt(localStorage.getItem('aq_bs3d_best') || '0', 10) || 0;
  if (level > prev) { try { localStorage.setItem('aq_bs3d_best', String(level)); window.aqGamePersist && window.aqGamePersist('aq_bs3d_best'); } catch (e) {} }
  bestLevel = Math.max(bestLevel, level);
  // credits (modest, capped) — also auto-feeds Finance XP
  const reward = Math.min(300, Math.round(score * 0.02));
  if (reward > 0 && typeof window.aqAddCredits === 'function') window.aqAddCredits(reward);
  // combat XP — capped & grindy (mirrors Buddy Shoot's end-grant)
  if (typeof window.aqAddXp === 'function') window.aqAddXp('combat', Math.round(Math.min(600, 40 + level * 60 + score * 0.02)));
  if (typeof window.recordScore === 'function') window.recordScore('buddyshoot3d', score, 'level ' + level);
  if (level >= 5 && typeof window.aqGameAnnounce === 'function') window.aqGameAnnounce(`survived to level ${level} of Buddy Shoot 3D 😈`);
  showGameOver(level, kills, score, reward);
}

// ── combat ──────────────────────────────────────────────────────────────────
function castWallDist(ox, oy, ang) {
  const rdx = Math.cos(ang), rdy = Math.sin(ang);
  let mapX = ox | 0, mapY = oy | 0;
  const ddx = Math.abs(1 / rdx), ddy = Math.abs(1 / rdy);
  let stepX, stepY, sideX, sideY;
  if (rdx < 0) { stepX = -1; sideX = (ox - mapX) * ddx; } else { stepX = 1; sideX = (mapX + 1 - ox) * ddx; }
  if (rdy < 0) { stepY = -1; sideY = (oy - mapY) * ddy; } else { stepY = 1; sideY = (mapY + 1 - oy) * ddy; }
  for (let i = 0; i < 64; i++) {
    let dist;
    if (sideX < sideY) { dist = sideX; sideX += ddx; mapX += stepX; } else { dist = sideY; sideY += ddy; mapY += stepY; }
    if (mapX < 0 || mapY < 0 || mapX >= MW || mapY >= MH || map[idx(mapX, mapY)] > 0) return dist;
  }
  return 64;
}
function fireWeapon() {
  const id = curWeaponId(), w = WEAPONS[id];
  const now = performance.now();
  if (now - lastFireT < w.fireRate * run.stats.fireRateMul) return;
  if (id !== 'pistol') {
    if ((run.ammo[id] | 0) <= 0) { sfx('empty'); run.curWeapon = 0; updateHud(); return; }
    run.ammo[id]--;
  }
  lastFireT = now; recoilT = 1; muzzleT = 1; sfx(w.sfx);
  const pellets = w.pellets + (w.pellets === 1 ? run.stats.pelletBonus : 0);
  const berserkMul = (1 + run.stats.berserk * 0.5 * (1 - run.hp / run.maxHp)) * (glassMod ? 1.5 : 1);
  for (let p = 0; p < pellets; p++) {
    const ang = pa + (Math.random() - 0.5) * w.spread * run.stats.spreadMul * 2;
    const rdx = Math.cos(ang), rdy = Math.sin(ang);
    const wallD = castWallDist(px, py, ang);
    let best = null, bestT = wallD;
    const splashAt = w.splash ? { x: px + rdx * wallD, y: py + rdy * wallD } : null;
    for (const e of enemies) {
      const rx = e.x - px, ry = e.y - py;
      const along = rx * rdx + ry * rdy;
      if (along <= 0 || along >= wallD) continue;
      const perp = Math.abs(rx * rdy - ry * rdx);
      if (perp < e.radius) {
        if (w.splash) { splashAt.x = e.x; splashAt.y = e.y; bestT = along; best = e; break; }
        if (along < bestT) { bestT = along; best = e; }
      }
    }
    if (w.splash) {
      const cxp = splashAt.x, cyp = splashAt.y;
      for (const e of enemies) {
        const d = Math.hypot(e.x - cxp, e.y - cyp);
        if (d < w.splash) damageEnemy(e, w.dmg * run.stats.dmgMul * berserkMul * (1 - d / w.splash) * (1 + run.stats.rangeDmg * bestT));
      }
    } else if (best) {
      damageEnemy(best, w.dmg * run.stats.dmgMul * berserkMul * (1 + run.stats.rangeDmg * bestT));
    }
  }
  updateHud();
}
function damageEnemy(e, dmg) {
  if (e.hp <= 0) return;
  e.hp -= dmg; e.hurtT = 0.12; sfx('hit');
  if (e.hp <= 0) {
    run.kills++; run.score += e.pts; sfx('enemydie');
    if (e.kind === 'bomber' && !e._boomed) { e._boomed = true; if (Math.hypot(e.x - px, e.y - py) < 1.6) hurtPlayer(e.dmg * 0.6); }
    if (run.stats.lifesteal) run.hp = Math.min(run.maxHp, run.hp + run.stats.lifesteal);
    if (run.stats.killBurst) run.speedBurstUntil = performance.now() + 1400;
    updateHud();
  }
}
function hurtPlayer(dmg) {
  run.hp -= dmg * run.stats.dmgTaken * (glassMod ? 1.5 : 1); sfx('hurt'); flashHurt();
  if (run.hp <= 0) gameOver(); else updateHud();
}

// ── enemy AI ───────────────────────────────────────────────────────────────────
function losClear(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy), steps = Math.ceil(d / 0.25);
  for (let i = 1; i < steps; i++) { if (isWall(ax + dx * i / steps, ay + dy * i / steps)) return false; }
  return true;
}
function updateEnemies(dt) {
  for (const e of enemies) {
    if (e.hp <= 0) continue;
    if (e.hurtT > 0) e.hurtT -= dt;
    e.cool -= dt; e.losT -= dt;
    const dx = px - e.x, dy = py - e.y, dist = Math.hypot(dx, dy) || 1e-3;
    if (e.losT <= 0) { e.los = losClear(e.x, e.y, px, py); e.losT = 0.15; }
    if (!(e.los || dist < 4.5)) continue;
    const nx = dx / dist, ny = dy / dist;
    if (e.kind === 'spitter') {
      if (dist > 3.5) moveEnemy(e, nx, ny, dt); else if (dist < 2.4) moveEnemy(e, -nx, -ny, dt);
      if (e.los && e.cool <= 0 && dist < 11) { eproj.push({ x: e.x, y: e.y, dx: nx * 5, dy: ny * 5, dmg: e.dmg }); e.cool = 1.6 * frenzyMul; }
    } else if (e.kind === 'summoner') {
      if (dist > 5) moveEnemy(e, nx, ny, dt); else if (dist < 3.5) moveEnemy(e, -nx, -ny, dt);
      if (e.los && e.cool <= 0 && enemies.length < ENEMY_HARDCAP) { summon(e); e.cool = 3.6 * frenzyMul; }
    } else if (e.kind === 'bomber') {
      moveEnemy(e, nx, ny, dt);
      if (dist < 1.7) { e.fuse += dt; if (e.fuse > 0.35) bomberBoom(e); } else e.fuse = Math.max(0, e.fuse - dt);
    } else {
      let mul = 1;
      if (e.kind === 'charger') {
        if (e.lunge > 0) { e.lunge -= dt; mul = 2.6; }
        else if (e.los && e.cool <= 0 && dist > 1.4 && dist < 8) { e.lunge = 0.45; e.cool = 2.2 * frenzyMul; }
      }
      if (dist > e.radius + 0.45) moveEnemy(e, nx, ny, dt, mul);
      else if (e.cool <= 0) { hurtPlayer(e.dmg); e.cool = (e.kind === 'wraith' ? 0.8 : 1.0) * frenzyMul; }
    }
  }
  // light separation so demons don't fully stack (wraiths phase through)
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i]; if (a.hp <= 0 || a.kind === 'wraith') continue;
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j]; if (b.hp <= 0 || b.kind === 'wraith') continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < 0.55) { const push = (0.55 - d) / 2, ux = dx / d, uy = dy / d; if (!isWall(a.x - ux * push, a.y - uy * push)) { a.x -= ux * push; a.y -= uy * push; } if (!isWall(b.x + ux * push, b.y + uy * push)) { b.x += ux * push; b.y += uy * push; } }
    }
  }
  // remove dead
  if (enemies.some(e => e.hp <= 0)) enemies = enemies.filter(e => e.hp > 0);
}
function summon(e) {
  const n = 1 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TWOPI, sx = e.x + Math.cos(a) * 0.9, sy = e.y + Math.sin(a) * 0.9;
    if (!isWall(sx, sy)) makeEnemy('imp', sx, sy, lvlHpMul, lvlSpMul, lvlDmgMul);
  }
  sfx('hit');
}
function bomberBoom(e) {
  if (e._boomed) return; e._boomed = true; e.hp = 0;
  if (Math.hypot(e.x - px, e.y - py) < 2.0) hurtPlayer(e.dmg);
  sfx('enemydie');
}
function moveEnemy(e, nx, ny, dt, mul) {
  const sp = e.speed * dt * (mul || 1);
  if (!isWall(e.x + nx * (sp + e.radius), e.y)) e.x += nx * sp;
  if (!isWall(e.x, e.y + ny * (sp + e.radius))) e.y += ny * sp;
}
function updateProjectiles(dt) {
  for (const p of eproj) {
    p.x += p.dx * dt; p.y += p.dy * dt;
    if (isWall(p.x, p.y)) { p.dead = true; continue; }
    if (Math.hypot(p.x - px, p.y - py) < 0.4) { p.dead = true; hurtPlayer(p.dmg); }
  }
  if (eproj.some(p => p.dead)) eproj = eproj.filter(p => !p.dead);
}
function updatePickups() {
  for (const p of pickups) {
    if (Math.hypot(p.x - px, p.y - py) < 0.5) {
      p.dead = true; sfx('pickup');
      if (p.kind === 'health') run.hp = Math.min(run.maxHp, run.hp + 28);
      else for (const id of run.weapons) if (id !== 'pistol') run.ammo[id] = (run.ammo[id] | 0) + Math.round(WEAPONS[id].startAmmo * 0.35);
      updateHud();
    }
  }
  if (pickups.some(p => p.dead)) pickups = pickups.filter(p => !p.dead);
}

// ── player movement ───────────────────────────────────────────────────────────
let touchMove = { x: 0, y: 0 };
function updatePlayer(dt) {
  let fwd = 0, strafe = 0;
  if (keys['KeyW'] || keys['ArrowUp']) fwd += 1;
  if (keys['KeyS'] || keys['ArrowDown']) fwd -= 1;
  if (keys['KeyD']) strafe += 1;
  if (keys['KeyA']) strafe -= 1;
  if (keys['ArrowLeft']) pa -= 2.4 * dt;
  if (keys['ArrowRight']) pa += 2.4 * dt;
  if (_touch) { fwd += -touchMove.y; strafe += touchMove.x; }
  let sp = run.stats.moveSpeed;
  if (performance.now() < run.speedBurstUntil) sp *= 1.4;
  const rx = -dirY, ry = dirX;                 // "right" strafe vector (= +camera plane)
  const mx = dirX * fwd + rx * strafe;
  const my = dirY * fwd + ry * strafe;
  const ml = Math.hypot(mx, my) || 1;
  const vx = mx / ml * sp * dt, vy = my / ml * sp * dt;
  if (fwd || strafe) {
    if (!isWall(px + Math.sign(vx) * 0.2 + vx, py)) px += vx;
    if (!isWall(px, py + Math.sign(vy) * 0.2 + vy)) py += vy;
    walkPhase += dt * 9;
  }
  // direction/plane from angle
  dirX = Math.cos(pa); dirY = Math.sin(pa);
  planeX = -dirY * FOV_PLANE; planeY = dirX * FOV_PLANE;
  // reach the exit (all demons cleared)
  if (enemies.length === 0 && Math.hypot(portal.x - px, portal.y - py) < 0.7) clearLevel();
}

// ── rendering ───────────────────────────────────────────────────────────────────
function render() {
  if (!ctx) return;
  // ceiling / floor
  ctx.fillStyle = '#15121c'; ctx.fillRect(0, 0, RW, RH / 2);
  ctx.fillStyle = '#241014'; ctx.fillRect(0, RH / 2, RW, RH / 2);
  // walls (DDA)
  for (let x = 0; x < RW; x++) {
    const cameraX = 2 * x / RW - 1;
    const rdx = dirX + planeX * cameraX, rdy = dirY + planeY * cameraX;
    let mapX = px | 0, mapY = py | 0;
    const ddx = Math.abs(1 / rdx), ddy = Math.abs(1 / rdy);
    let stepX, stepY, sideX, sideY, side = 0;
    if (rdx < 0) { stepX = -1; sideX = (px - mapX) * ddx; } else { stepX = 1; sideX = (mapX + 1 - px) * ddx; }
    if (rdy < 0) { stepY = -1; sideY = (py - mapY) * ddy; } else { stepY = 1; sideY = (mapY + 1 - py) * ddy; }
    let tile = 0;
    for (let i = 0; i < 80; i++) {
      if (sideX < sideY) { sideX += ddx; mapX += stepX; side = 0; } else { sideY += ddy; mapY += stepY; side = 1; }
      if (mapX < 0 || mapY < 0 || mapX >= MW || mapY >= MH) { tile = 1; break; }
      tile = map[idx(mapX, mapY)]; if (tile > 0) break;
    }
    const perp = side === 0 ? (sideX - ddx) : (sideY - ddy);
    zbuffer[x] = perp;
    const lineH = RH / perp;
    const drawStart = -lineH / 2 + RH / 2;
    const tex = wallTex[(tile - 1) % wallTex.length] || wallTex[0];
    let wallX = side === 0 ? py + perp * rdy : px + perp * rdx; wallX -= Math.floor(wallX);
    let texX = (wallX * TEX) | 0;
    if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) texX = TEX - texX - 1;
    ctx.drawImage(tex, texX, 0, 1, TEX, x, drawStart, 1, lineH);
    // distance + side shading (clamped overlay rect)
    const sh = clamp(perp / visDist, 0, 0.78) + (side === 1 ? 0.16 : 0);
    if (sh > 0.02) {
      ctx.fillStyle = 'rgba(0,0,0,' + Math.min(0.85, sh) + ')';
      const y0 = Math.max(0, drawStart), y1 = Math.min(RH, drawStart + lineH);
      ctx.fillRect(x, y0, 1, y1 - y0);
    }
  }
  // sprites (enemies + pickups + portal + projectiles), far-first
  const sprites = [];
  if (portal && enemies.length === 0) sprites.push(portal);
  for (const p of pickups) sprites.push(p);
  for (const e of enemies) sprites.push({ x: e.x, y: e.y, size: e.size * (e.kind === 'bomber' && e.fuse > 0 ? 1.25 : 1), float: 0, bob: Math.sin(walkPhase * 0.6 + e.phase) * (RH * 0.012), alpha: e.alpha, canvas: e.hurtT > 0 ? e.hurtCanvas : e.canvas });
  for (const p of eproj) sprites.push({ x: p.x, y: p.y, size: 0.3, float: 0.4, canvas: spitSprite });
  sprites.sort((a, b) => ((b.x - px) ** 2 + (b.y - py) ** 2) - ((a.x - px) ** 2 + (a.y - py) ** 2));
  for (const sp of sprites) drawSprite(sp);
  // weapon viewmodel
  drawWeapon();
}
function drawSprite(sp) {
  const dx = sp.x - px, dy = sp.y - py;
  const inv = 1 / (planeX * dirY - dirX * planeY);
  const tX = inv * (dirY * dx - dirX * dy);
  const tY = inv * (-planeY * dx + planeX * dy);
  if (tY <= 0.1) return;
  const screenX = (RW / 2) * (1 + tX / tY);
  const fullH = RH / tY;
  const h = fullH * (sp.size || 1);
  const w = h * (sp.canvas.width / sp.canvas.height);
  const bottomY = RH / 2 + fullH / 2 - (sp.float || 0) * fullH;
  const drawY = bottomY - h - (sp.bob || 0);
  const startX = screenX - w / 2;
  const x0 = Math.max(0, Math.ceil(startX)), x1 = Math.min(RW - 1, Math.floor(startX + w));
  const fog = clamp(1 - tY / (visDist * 1.4), 0.4, 1) * (sp.alpha == null ? 1 : sp.alpha);
  let runStart = -1;
  for (let x = x0; x <= x1 + 1; x++) {
    const vis = x <= x1 && tY < zbuffer[x];
    if (vis && runStart < 0) runStart = x;
    if ((!vis || x > x1) && runStart >= 0) {
      const runEnd = x - 1;
      const srcX = (runStart - startX) / w * sp.canvas.width;
      const srcW = Math.max(0.5, (runEnd - runStart + 1) / w * sp.canvas.width);
      ctx.globalAlpha = fog;
      ctx.drawImage(sp.canvas, srcX, 0, srcW, sp.canvas.height, runStart, drawY, runEnd - runStart + 1, h);
      ctx.globalAlpha = 1;
      runStart = -1;
    }
  }
}
function drawWeapon() {
  const w = WEAPONS[curWeaponId()];
  const kick = recoilT * w.recoil;
  const bobY = Math.abs(Math.sin(walkPhase)) * 3, bobX = Math.sin(walkPhase * 0.5) * 3;
  const cxp = RW / 2 + bobX, baseY = RH + kick + bobY;
  ctx.save();
  ctx.fillStyle = w.color;
  // simple boomer-shooter viewmodel
  if (curWeaponId() === 'shotgun') {
    ctx.fillRect(cxp - 20, baseY - 34, 40, 30);             // body
    ctx.fillStyle = '#2a1a0c'; ctx.fillRect(cxp - 10, baseY - 60, 8, 30); ctx.fillRect(cxp + 2, baseY - 60, 8, 30);  // barrels
    var mx = cxp, my = baseY - 60;
  } else if (curWeaponId() === 'smg') {
    ctx.fillRect(cxp - 14, baseY - 30, 28, 26);
    ctx.fillStyle = '#3a3e46'; ctx.fillRect(cxp - 4, baseY - 56, 8, 30);
    ctx.fillStyle = '#222'; ctx.fillRect(cxp - 8, baseY - 18, 16, 10);  // mag
    var mx = cxp, my = baseY - 56;
  } else if (curWeaponId() === 'rocket') {
    ctx.fillRect(cxp - 22, baseY - 30, 44, 26);
    ctx.fillStyle = '#244a24'; ctx.fillRect(cxp - 8, baseY - 64, 16, 38);
    var mx = cxp, my = baseY - 64;
  } else { // pistol
    ctx.fillRect(cxp - 12, baseY - 26, 24, 24);
    ctx.fillStyle = '#9aa0a8'; ctx.fillRect(cxp - 6, baseY - 50, 10, 28);
    var mx = cxp, my = baseY - 50;
  }
  // muzzle flash
  if (muzzleT > 0) {
    ctx.fillStyle = 'rgba(255,230,120,' + muzzleT + ')';
    ctx.beginPath(); ctx.arc(mx, my, 6 + muzzleT * 6, 0, TWOPI); ctx.fill();
    ctx.fillStyle = 'rgba(255,160,40,' + muzzleT * 0.8 + ')';
    ctx.beginPath(); ctx.arc(mx, my, 3 + muzzleT * 3, 0, TWOPI); ctx.fill();
  }
  ctx.restore();
}

// ── HUD / overlays ──────────────────────────────────────────────────────────────
function setHudVisible(v) { if (hudEl) hudEl.style.display = v ? 'flex' : 'none'; }
function updateHud() {
  if (!hudEl || !run) return;
  const id = curWeaponId(), ammo = id === 'pistol' ? '∞' : (run.ammo[id] | 0);
  const hpPct = clamp(run.hp / run.maxHp, 0, 1);
  hudEl.innerHTML =
    `<div class="b3-hp"><div class="b3-hp-fill" style="width:${(hpPct * 100).toFixed(0)}%"></div><span>${Math.max(0, Math.ceil(run.hp))} / ${run.maxHp}</span></div>` +
    `<div class="b3-stat">LV ${run.level}</div>` +
    `<div class="b3-stat">😈 ${enemies.length}</div>` +
    `<div class="b3-stat">⭐ ${run.level * 1000 + run.kills * 50 + run.score}</div>` +
    `<div class="b3-wpn">${WEAPONS[id].name} <b>${ammo}</b></div>` +
    `<span class="aq-credits-display">💰 ${credits()}</span>`;
  if (vignetteEl) vignetteEl.style.opacity = (0.15 + (1 - hpPct) * 0.55).toFixed(2);
}
function flashHurt() { if (vignetteEl) { vignetteEl.classList.remove('b3-hit'); void vignetteEl.offsetWidth; vignetteEl.classList.add('b3-hit'); } }

function clearOverlay() { if (overlayEl) { overlayEl.remove(); overlayEl = null; } }
function makeOverlay() { clearOverlay(); overlayEl = el('div', 'b3-overlay'); area.appendChild(overlayEl); return overlayEl; }
function showStart() {
  state = 'start'; setHudVisible(false); if (vignetteEl) vignetteEl.style.opacity = '0';
  bestLevel = Math.max(bestLevel, parseInt(localStorage.getItem('aq_bs3d_best') || '0', 10) || 0);
  const o = makeOverlay();
  o.appendChild(el('div', 'b3-title', '😈 BUDDY SHOOT 3D'));
  o.appendChild(el('div', 'b3-sub', 'The buddies have gone demonic. Blast through randomly-generated stages, grab a perk after each one, and see how deep you can get. <b>Die and it\'s back to level 1.</b>'));
  o.appendChild(el('div', 'b3-sub', `<b>Best level reached:</b> ${bestLevel || '—'}`));
  o.appendChild(el('div', 'b3-sub b3-hint', _touch ? 'Left pad to move · drag to look · FIRE button to shoot · 🔁 to switch guns' : 'WASD / arrows move · mouse to look · click / Space to fire · 1-4 or wheel to switch guns · Esc to release mouse'));
  o.appendChild(el('div', 'b3-sub b3-hint', 'Sign in to earn Combat XP & save your best.'));
  const b = el('button', 'b3-btn b3-btn-big', '▶ Start run'); b.onclick = () => { bakeArt(); startRun(); requestLock(); }; o.appendChild(b);
}
function showPerkSelect() {
  setHudVisible(true);
  const pool = PERKS.filter(p => p.gun ? !run.weapons.includes(p.gun) : (run.perks.filter(x => x === p.id).length < (p.maxStack || 99)));
  const picks = [];
  const cand = pool.slice();
  for (let i = 0; i < 3 && cand.length; i++) {
    let tot = 0; cand.forEach(p => tot += p.weight); let r = Math.random() * tot, k = 0;
    for (; k < cand.length; k++) { r -= cand[k].weight; if (r <= 0) break; }
    picks.push(cand.splice(Math.min(k, cand.length - 1), 1)[0]);
  }
  const o = makeOverlay();
  o.appendChild(el('div', 'b3-title', `LEVEL ${run.level} CLEARED`));
  o.appendChild(el('div', 'b3-sub', 'Choose a power-up:'));
  const row = el('div', 'b3-perkrow');
  picks.forEach((p, i) => {
    const card = el('button', 'b3-perk' + (p.gun ? ' b3-perk-gun' : ''));
    card.innerHTML = `<div class="b3-perk-ico">${p.icon}</div><div class="b3-perk-name">${p.name}</div><div class="b3-perk-desc">${p.desc}</div><div class="b3-perk-key">${i + 1}</div>`;
    card.onclick = () => applyPerk(p);
    row.appendChild(card);
  });
  o.appendChild(row);
  o._picks = picks;   // for number-key selection
}
function showGameOver(level, kills, score, reward) {
  setHudVisible(false); if (vignetteEl) vignetteEl.style.opacity = '0';
  const o = makeOverlay();
  o.appendChild(el('div', 'b3-title b3-dead', '☠ YOU DIED'));
  o.appendChild(el('div', 'b3-sub', `Reached <b>level ${level}</b> · ${kills} demons slain<br>Score <b>${score}</b> · +${reward} 💰 · Best level: ${bestLevel}`));
  const b = el('button', 'b3-btn b3-btn-big', '↻ Restart from level 1'); b.onclick = () => { startRun(); requestLock(); }; o.appendChild(b);
}
function showResume() {
  const o = makeOverlay();
  o.appendChild(el('div', 'b3-title', '⏸ Paused'));
  const b = el('button', 'b3-btn b3-btn-big', '▶ Resume'); b.onclick = () => requestLock(); o.appendChild(b);
}

// ── input / pointer-lock ─────────────────────────────────────────────────────────
function requestLock() {
  clearOverlay();
  if (_touch) { paused = false; if (state !== 'start') state = state === 'levelclear' ? 'playing' : state; return; }
  if (cv && cv.requestPointerLock) { try { cv.requestPointerLock(); } catch (e) {} }
  paused = false;
}
function exitPointerLock() { if (document.exitPointerLock && document.pointerLockElement === cv) { try { document.exitPointerLock(); } catch (e) {} } }

function onKey(e) {
  const w = document.getElementById('buddyshoot3d-wrap');
  if (!w || !w.classList.contains('open')) return;
  if (e.type === 'keydown') {
    keys[e.code] = true;
    // perk select via number keys
    if (state === 'levelclear' && overlayEl && overlayEl._picks && /^Digit[1-3]$/.test(e.code)) {
      const i = +e.code.slice(5) - 1; if (overlayEl._picks[i]) applyPerk(overlayEl._picks[i]); return;
    }
    if (state !== 'playing') return;
    if (e.code === 'Space') { e.preventDefault(); if (!WEAPONS[curWeaponId()].auto) fireWeapon(); }
    if (/^Digit[1-9]$/.test(e.code)) { const i = +e.code.slice(5) - 1; if (run.weapons[i]) { run.curWeapon = i; updateHud(); } }
  } else { keys[e.code] = false; }
}
function onMouseMove(e) { if (state === 'playing' && document.pointerLockElement === cv) { pa += e.movementX * 0.0026; } }
function onMouseDown(e) {
  if (state !== 'playing') return;
  if (document.pointerLockElement !== cv && !_touch) { requestLock(); return; }
  firing = true; if (!WEAPONS[curWeaponId()].auto) fireWeapon();
}
function onWheel(e) {
  if (state !== 'playing') return; e.preventDefault();
  run.curWeapon = (run.curWeapon + (e.deltaY > 0 ? 1 : -1) + run.weapons.length) % run.weapons.length; updateHud();
}
function onLockChange() {
  if (_touch) return;
  if (document.pointerLockElement === cv) { paused = false; clearOverlay(); }
  else if (state === 'playing') { paused = true; firing = false; showResume(); }
}

// ── touch controls ───────────────────────────────────────────────────────────────
function buildTouch() {
  touchEl = el('div', 'b3-touch');
  const stick = el('div', 'b3-stick', '<div class="b3-stick-knob"></div>');
  const fire = el('div', 'b3-fire', 'FIRE');
  const swap = el('div', 'b3-swap', '🔁');
  touchEl.append(stick, fire, swap);
  area.appendChild(touchEl);
  // move stick
  let sid = null, ox = 0, oy = 0;
  const knob = stick.querySelector('.b3-stick-knob');
  stick.addEventListener('touchstart', e => { const t = e.changedTouches[0]; sid = t.identifier; ox = t.clientX; oy = t.clientY; e.preventDefault(); }, { passive: false });
  stick.addEventListener('touchmove', e => { for (const t of e.changedTouches) if (t.identifier === sid) { const dx = clamp((t.clientX - ox) / 40, -1, 1), dy = clamp((t.clientY - oy) / 40, -1, 1); touchMove.x = dx; touchMove.y = dy; knob.style.transform = `translate(${dx * 22}px,${dy * 22}px)`; } e.preventDefault(); }, { passive: false });
  const endStick = e => { for (const t of e.changedTouches) if (t.identifier === sid) { sid = null; touchMove.x = touchMove.y = 0; knob.style.transform = ''; } };
  stick.addEventListener('touchend', endStick); stick.addEventListener('touchcancel', endStick);
  // look — drag anywhere on the right half (the canvas)
  let lid = null, lx = 0;
  cv.addEventListener('touchstart', e => { if (state !== 'playing') return; const t = e.changedTouches[0]; lid = t.identifier; lx = t.clientX; }, { passive: true });
  cv.addEventListener('touchmove', e => { for (const t of e.changedTouches) if (t.identifier === lid) { pa += (t.clientX - lx) * 0.006; lx = t.clientX; } }, { passive: true });
  const endLook = e => { for (const t of e.changedTouches) if (t.identifier === lid) lid = null; };
  cv.addEventListener('touchend', endLook); cv.addEventListener('touchcancel', endLook);
  // fire / swap
  fire.addEventListener('touchstart', e => { firing = true; if (state === 'playing' && !WEAPONS[curWeaponId()].auto) fireWeapon(); e.preventDefault(); }, { passive: false });
  fire.addEventListener('touchend', e => { firing = false; e.preventDefault(); }, { passive: false });
  swap.addEventListener('touchstart', e => { if (run) { run.curWeapon = (run.curWeapon + 1) % run.weapons.length; updateHud(); } e.preventDefault(); }, { passive: false });
}
function setTouchVisible(v) { if (touchEl) touchEl.style.display = (v && _touch) ? 'block' : 'none'; }

// ── main loop ───────────────────────────────────────────────────────────────────
function tick(t) {
  const dt = Math.min(0.05, (t - (_lastT || t)) / 1000); _lastT = t;
  if (recoilT > 0) recoilT = Math.max(0, recoilT - dt * 6);
  if (muzzleT > 0) muzzleT = Math.max(0, muzzleT - dt * 12);
  if (state === 'playing' && !paused) {
    updatePlayer(dt);
    if (state === 'playing') {   // updatePlayer may have triggered clearLevel
      updateEnemies(dt); updateProjectiles(dt); updatePickups();
      if (firing && WEAPONS[curWeaponId()].auto) fireWeapon();
      updateHud();
    }
  }
  if (state === 'playing' || state === 'levelclear' || state === 'gameover') render();
  raf = requestAnimationFrame(tick);
}

// ── build / open ─────────────────────────────────────────────────────────────────
function injectStyle() {
  if (document.getElementById('b3-style')) return;
  const s = el('style'); s.id = 'b3-style';
  s.textContent = `
  #buddyshoot3d-wrap{position:fixed;top:50px;left:50%;transform:translateX(-50%);width:520px;max-width:96vw;border-radius:var(--chrome-radius,10px);z-index:540;flex-direction:column;background:#0a0608;border:1px solid var(--border,#333);box-shadow:0 18px 50px rgba(0,0,0,.5);font-family:var(--font-ui);overflow:hidden}
  #buddyshoot3d-wrap.open{display:flex}
  #buddyshoot3d-area{position:relative;display:flex;flex-direction:column;background:#000}
  #buddyshoot3d-area canvas{width:100%;height:auto;display:block;image-rendering:pixelated;image-rendering:crisp-edges;cursor:crosshair;touch-action:none;background:#000}
  .b3-cross{position:absolute;top:50%;left:50%;width:14px;height:14px;transform:translate(-50%,-50%);pointer-events:none;z-index:6}
  .b3-cross:before,.b3-cross:after{content:'';position:absolute;background:rgba(255,255,255,.7)}
  .b3-cross:before{left:6px;top:0;width:2px;height:14px}.b3-cross:after{top:6px;left:0;height:2px;width:14px}
  .b3-vignette{position:absolute;inset:0;pointer-events:none;z-index:5;opacity:0;transition:opacity .25s;box-shadow:inset 0 0 60px 10px rgba(150,0,0,.9)}
  .b3-vignette.b3-hit{animation:b3hit .25s ease-out}
  @keyframes b3hit{0%{box-shadow:inset 0 0 90px 30px rgba(220,0,0,1)}100%{box-shadow:inset 0 0 60px 10px rgba(150,0,0,.9)}}
  .b3-hud{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;font-weight:800;color:#fff;background:linear-gradient(180deg,#2a0808,#120304);flex-wrap:wrap;z-index:7}
  .b3-hp{position:relative;flex:1;min-width:120px;height:16px;border-radius:8px;background:#3a0c0c;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
  .b3-hp-fill{height:100%;background:linear-gradient(90deg,#ff3b3b,#ff8a4a);transition:width .15s}
  .b3-hp span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;text-shadow:0 1px 2px #000}
  .b3-stat,.b3-wpn{background:rgba(0,0,0,.35);padding:3px 8px;border-radius:7px;white-space:nowrap}
  .b3-wpn b{color:#ffcd50}
  .b3-banner{position:absolute;top:22%;left:50%;transform:translateX(-50%);z-index:9;pointer-events:none;text-align:center;animation:b3bannerIn .35s ease-out, b3bannerOut .5s ease-in 2.3s forwards}
  .b3-banner-lv{font-size:30px;font-weight:900;letter-spacing:2px;color:#ff7a3a;text-shadow:0 2px 0 #5a0808,0 0 14px rgba(255,90,40,.6)}
  .b3-banner-mods{margin-top:8px;display:flex;gap:7px;flex-wrap:wrap;justify-content:center}
  .b3-banner-mods span{background:rgba(40,8,12,.85);border:1px solid #ff6a2a;border-radius:20px;padding:3px 11px;font-size:12px;font-weight:800;color:#ffd0a0;box-shadow:0 2px 8px rgba(0,0,0,.4)}
  @keyframes b3bannerIn{0%{opacity:0;transform:translateX(-50%) scale(.7)}100%{opacity:1;transform:translateX(-50%) scale(1)}}
  @keyframes b3bannerOut{0%{opacity:1}100%{opacity:0}}
  .b3-overlay{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:18px;text-align:center;background:rgba(8,2,4,.9);color:#fff}
  .b3-title{font-size:24px;font-weight:900;letter-spacing:1px;color:#ff5a3a;text-shadow:0 2px 0 #5a0808}
  .b3-title.b3-dead{color:#ff2a2a}
  .b3-sub{font-size:12px;opacity:.92;max-width:380px;line-height:1.5}
  .b3-hint{opacity:.7;font-size:11px}
  .b3-btn{font-size:13px;font-weight:800;padding:9px 18px;border-radius:10px;cursor:pointer;color:#160202;background:linear-gradient(180deg,#ffb24a,#ff6a2a);border:none}
  .b3-btn:hover{filter:brightness(1.08)}
  .b3-btn-big{font-size:15px;padding:12px 26px}
  .b3-perkrow{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .b3-perk{position:relative;width:130px;min-height:120px;padding:12px 10px;border-radius:12px;cursor:pointer;background:linear-gradient(180deg,#2a1418,#140608);border:1px solid #6a1414;color:#fff;display:flex;flex-direction:column;align-items:center;gap:5px;text-align:center}
  .b3-perk:hover{border-color:#ff6a2a;transform:translateY(-3px);box-shadow:0 8px 20px rgba(255,60,20,.3)}
  .b3-perk-gun{background:linear-gradient(180deg,#142a16,#061206);border-color:#2a7a2a}
  .b3-perk-gun:hover{border-color:#5aff5a;box-shadow:0 8px 20px rgba(40,200,40,.3)}
  .b3-perk-ico{font-size:28px}.b3-perk-name{font-weight:900;font-size:13px}.b3-perk-desc{font-size:11px;opacity:.85;line-height:1.35}
  .b3-perk-key{position:absolute;top:5px;left:7px;font-size:10px;opacity:.5}
  .b3-touch{display:none;position:absolute;inset:0;z-index:8;pointer-events:none}
  .b3-touch>*{pointer-events:auto}
  .b3-stick{position:absolute;left:18px;bottom:18px;width:88px;height:88px;border-radius:50%;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 2px rgba(255,255,255,.18)}
  .b3-stick-knob{position:absolute;left:28px;top:28px;width:32px;height:32px;border-radius:50%;background:rgba(255,120,80,.7)}
  .b3-fire{position:absolute;right:18px;bottom:30px;width:78px;height:78px;border-radius:50%;background:rgba(255,60,40,.55);display:flex;align-items:center;justify-content:center;font-weight:900;color:#fff;font-size:14px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.25)}
  .b3-swap{position:absolute;right:106px;bottom:40px;width:48px;height:48px;border-radius:50%;background:rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center;font-size:20px}
  @media (max-width:768px){#buddyshoot3d-wrap{width:100vw;top:0;left:0;transform:none;height:calc(100dvh - 94px - env(safe-area-inset-bottom,0px));border-radius:0}#buddyshoot3d-area{flex:1;min-height:0}#buddyshoot3d-area canvas{flex:1;height:100%;object-fit:contain}}
  `;
  document.head.appendChild(s);
}
function build() {
  area = document.getElementById('buddyshoot3d-area');
  if (!area) return;
  injectStyle();
  area.innerHTML = '';
  cv = mkCanvas(RW, RH); ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  zbuffer = new Float32Array(RW);
  area.appendChild(cv);
  area.appendChild(el('div', 'b3-cross'));
  vignetteEl = el('div', 'b3-vignette'); area.appendChild(vignetteEl);
  hudEl = el('div', 'b3-hud'); area.insertBefore(hudEl, cv); setHudVisible(false);
  buildTouch();
  // global listeners (bound once)
  if (!window._b3Bound) {
    window._b3Bound = true;
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    document.addEventListener('mousemove', onMouseMove);
    cv.addEventListener('mousedown', onMouseDown);
    cv.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('mouseup', () => { firing = false; });
    document.addEventListener('pointerlockchange', onLockChange);
  } else {
    // rebuilt canvas needs its own mouse/wheel bindings
    cv.addEventListener('mousedown', onMouseDown);
    cv.addEventListener('wheel', onWheel, { passive: false });
  }
  _built = true;
}

function openBuddyShoot3D(show = true) {
  const w = document.getElementById('buddyshoot3d-wrap');
  if (!w) return;
  if (show === false) {
    w.classList.remove('open'); w.style.display = 'none';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    exitPointerLock(); firing = false; for (const k in keys) keys[k] = false;
    return;
  }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('buddyshoot3d'); window.OS.focus('buddyshoot3d'); }
  bakeArt();
  if (!_built) build();
  setTouchVisible(true);
  showStart();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') { window.openBuddyShoot3D = openBuddyShoot3D; }
