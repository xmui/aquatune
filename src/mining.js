// Aquatune Mining — "Aquatune Depths", a PS1/N64-style first-person mine.
//
// Walk a procedurally-carved cave (Wolfenstein-style raycaster, same engine
// family as Buddy Shoot 3D), find glowing ore veins in the walls and swing your
// pickaxe at them. Broken ore goes into your sack; haul it back to the mine
// cart at the entrance to sell it for credits (RuneScape-style banking loop).
// Cave creatures stalk the deeper zones and will maul you — fight them off with
// your pick or run. Die and you drop half your sack. Zones unlock with Mining
// level; pickaxes are bought with credits (tier persists via aq_mining_pick,
// so upgrades from the old mining game carry over). All art is procedural.

// ── render / world constants ─────────────────────────────────────────────────
const RW_BASE = 220, RH = 140;          // internal backing-store resolution
let RW = RW_BASE;                       // dropped on touch devices for perf
const TEX = 32;                         // wall texture size
const FOV_PLANE = 0.66;
const TWOPI = Math.PI * 2;
const MW = 26, MH = 26;                 // cave grid

const _touch = (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches);
if (_touch) RW = 170;

// ── progression data (economy carried over from the old mining game) ─────────
const PICKS = [
  { name: 'Wooden',   power: 1,  cost: 0,     color: '#9a6a3a' },
  { name: 'Stone',    power: 2,  cost: 150,   color: '#9aa0a8' },
  { name: 'Iron',     power: 4,  cost: 600,   color: '#cfd6de' },
  { name: 'Gold',     power: 7,  cost: 2000,  color: '#ffd84a' },
  { name: 'Diamond',  power: 12, cost: 7000,  color: '#aef2ff' },
  { name: 'Aquatune', power: 20, cost: 25000, color: '#4ad9ff' },
];

// Zones unlock with Mining level — deeper = richer ore, nastier creatures.
// pal: wall base/dark/mortar + floor/ceiling + fog tint for the PS1 depth haze.
const ZONES = [
  { name: 'Surface',      lvl: 1,  mons: 0, veins: 14, pal: { wall: '#8a7a64', dark: '#5a4e3e', mortar: '#3e352a', floor: '#4a4136', ceil: '#2e2a24', fog: [20, 16, 12] } },
  { name: 'Caverns',      lvl: 8,  mons: 2, veins: 15, pal: { wall: '#6a7480', dark: '#454e58', mortar: '#2c3138', floor: '#363c44', ceil: '#22262c', fog: [10, 14, 20] } },
  { name: 'Deep Mine',    lvl: 20, mons: 3, veins: 16, pal: { wall: '#705c46', dark: '#4a3c2c', mortar: '#2e2418', floor: '#382e20', ceil: '#201a10', fog: [16, 10, 4] } },
  { name: 'Magma Vein',   lvl: 38, mons: 4, veins: 16, pal: { wall: '#5c4040', dark: '#3a2424', mortar: '#241212', floor: '#48201a', ceil: '#1e1010', fog: [40, 12, 4] } },
  { name: 'Crystal Core', lvl: 60, mons: 5, veins: 17, pal: { wall: '#4c4468', dark: '#302a46', mortar: '#1e1a30', floor: '#2a2440', ceil: '#161226', fog: [14, 8, 30] } },
];

// Ore that spawns as wall veins in each zone (hp tuned for swing-rate mining,
// values match the old game so the credit economy is unchanged).
const ORES = [
  { name: 'Stone',    zone: 0, hp: 16,  value: 2,   rarity: 0, color: '#aaa49a', glow: false, weight: 60 },
  { name: 'Copper',   zone: 0, hp: 32,  value: 5,   rarity: 1, color: '#e08a4a', glow: false, weight: 40 },
  { name: 'Coal',     zone: 1, hp: 44,  value: 8,   rarity: 1, color: '#23232b', glow: false, weight: 58 },
  { name: 'Iron',     zone: 1, hp: 64,  value: 13,  rarity: 1, color: '#d8c8b8', glow: false, weight: 42 },
  { name: 'Gold',     zone: 2, hp: 110, value: 26,  rarity: 2, color: '#ffd84a', glow: true,  weight: 58 },
  { name: 'Emerald',  zone: 2, hp: 170, value: 48,  rarity: 3, color: '#3fe07a', glow: true,  weight: 42 },
  { name: 'Ruby',     zone: 3, hp: 250, value: 90,  rarity: 3, color: '#ff4a5e', glow: true,  weight: 56 },
  { name: 'Obsidian', zone: 3, hp: 330, value: 120, rarity: 4, color: '#7a5ad0', glow: false, weight: 44 },
  { name: 'Diamond',  zone: 4, hp: 430, value: 200, rarity: 4, color: '#bef2ff', glow: true,  weight: 58 },
  { name: 'Aquatune', zone: 4, hp: 660, value: 340, rarity: 4, color: '#4ad9ff', glow: true,  weight: 42 },
];

// tile ids: 0 floor · 1 rock · 2 border rock · 5 depleted vein · 10+i ore i
const T_ORE = 10;

// ── spice dials ──────────────────────────────────────────────────────────────
const SWING_BASE_MS = 380;            // pickaxe cooldown (a touch faster per tier)
const REACH = 2.1;                    // how close you must be to mine / melee
const MELEE_ARC = 0.78;               // dot(facing, toMonster) needed to land a hit
const SACK_BASE = 8;                  // sack capacity = SACK_BASE + tier*2
const VEIN_RESPAWN_MIN = 14000, VEIN_RESPAWN_RAND = 10000;
const MON_RESPAWN_MS = 18000;
const MAX_HP = 100;
const REGEN_DELAY = 4000, REGEN_PER_S = 3;
const DEPTH_MAX = 600;                // ore "depth" points to fill the bar (then prestige)
const XP_CAP = 12;                    // cap on any single mining XP grant's mult

// ── tiny helpers ─────────────────────────────────────────────────────────────
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function sfx(n) { try { window.miningSfx && window.miningSfx(n); } catch (e) {} }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function pickTier() {
  if (typeof window.aqToolTier === 'function') return Math.min(PICKS.length - 1, window.aqToolTier('pick'));
  return Math.max(0, Math.min(PICKS.length - 1, parseInt(localStorage.getItem('aq_mining_pick') || '0', 10) || 0));
}
function pickPower() { return PICKS[pickTier()].power; }
function sackCap() { return SACK_BASE + pickTier() * 2; }
function mineLvl() { return (typeof window.aqSkillLevel === 'function' && window.aqSkillLevel('mining')) || 1; }
function maxZone() { let m = 0; const lvl = mineLvl(); for (let i = 0; i < ZONES.length; i++) if (lvl >= ZONES[i].lvl) m = i; return m; }
// XP-only depth curve (~1.8× per zone) so deeper digging pays clearly more,
// outpacing tankier rocks + travel time. Same curve as the old game.
function xpZoneMult() { return Math.pow(1.8, curZone); }
function prestigeMult() { return 1 + prestige * 0.05; }   // +5% per Delve Deeper rank

// ── state ────────────────────────────────────────────────────────────────────
let cv = null, ctx = null, raf = null, _built = false, _lastT = 0;
let area = null, hudEl = null, vignetteEl = null, overlayEl = null, touchEl = null, hintEl = null;
let infoEl = null, zoneEl = null, shopEl = null;
let zbuffer = null;
let state = 'start';                  // 'start' | 'playing'
let paused = false;

let map = null;                       // Uint8Array(MW*MH)
let veins = new Map();                // tileKey -> { def, hp, max, flashT, respawnAt }
let curZone = 0;
let spawn = { x: 0, y: 0 };
let cart = null;                      // sell point sprite at the entrance
let minimapBuf = null;

let px = 2, py = 2, pa = 0, dirX = 1, dirY = 0, planeX = 0, planeY = FOV_PLANE;
let pitch = 0;                        // vertical look, in screen pixels of horizon offset
const PITCH_MAX = 52;
let hp = MAX_HP, lastHurtAt = -1e9, invulnUntil = 0;
let sack = [];                        // [{ name, value, color }]
let swingT = 0, lastSwingAt = 0, swinging = false, walkPhase = 0;
let mons = [], monRespawnQ = [];      // respawn timestamps
let particles = [], floaters = [];    // screen-space FX
let keys = {};
let touchMove = { x: 0, y: 0 };
let sellFlashT = 0;

let depthPts = parseFloat(localStorage.getItem('aq_mining_depth') || '0') || 0;
let prestige = parseInt(localStorage.getItem('aq_mining_prestige') || '0', 10) || 0;

function idx(x, y) { return y * MW + x; }
// Smooth heightfield: the cave floor (and ceiling with it) rolls up and down.
// Continuous, so the camera glides as you walk instead of stepping.
let _hSeed = 0;
function caveH(x, y) {
  return 0.20 * Math.sin(x * 0.55 + _hSeed) * Math.cos(y * 0.48 + _hSeed * 0.7) +
         0.13 * Math.sin((x + y) * 0.85 + _hSeed * 1.3) +
         0.07 * Math.sin(x * 1.7 - y * 1.1 + _hSeed * 2.1);
}
function eyeZ() { return caveH(px, py) + 0.5; }
function tileAt(x, y) { const mx = x | 0, my = y | 0; if (mx < 0 || my < 0 || mx >= MW || my >= MH) return 2; return map[idx(mx, my)]; }
function isWall(x, y) { return tileAt(x, y) > 0; }
function addDepth(n) {
  depthPts = Math.min(DEPTH_MAX, depthPts + n);
  try { localStorage.setItem('aq_mining_depth', String(Math.round(depthPts))); window.aqGamePersist && window.aqGamePersist('aq_mining_depth'); } catch (e) {}
}

// ── procedural art ───────────────────────────────────────────────────────────
let texRock = null, texEdge = null, texDepleted = null, texOre = {}, texCrack = null;
let monSprites = {}, cartSprite = null, stalactiteSprite = null, stalagmiteSprite = null;
let stalactites = [];
let _bakedZone = -1;

// chunky 2×2 "texel" noise so walls read as low-poly PS1 surfaces
function noisy(g, w, h, dark, light, n) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = Math.random() < 0.5 ? dark : light;
    g.globalAlpha = 0.25 + Math.random() * 0.45;
    g.fillRect(((Math.random() * w) | 0) & ~1, ((Math.random() * h) | 0) & ~1, 2, 2);
  }
  g.globalAlpha = 1;
}
function bakeRock(pal) {
  const c = mkCanvas(TEX, TEX), g = c.getContext('2d');
  g.fillStyle = pal.wall; g.fillRect(0, 0, TEX, TEX);
  // big faceted slabs (irregular mortar lines)
  g.strokeStyle = pal.mortar; g.lineWidth = 1.5;
  for (const yy of [9, 21]) { g.beginPath(); g.moveTo(0, yy + Math.random() * 3); g.lineTo(TEX, yy + Math.random() * 3 - 1); g.stroke(); }
  for (const xx of [7, 17, 26]) { g.beginPath(); g.moveTo(xx, Math.random() * 8); g.lineTo(xx + 2, TEX); g.stroke(); }
  g.fillStyle = pal.dark; g.globalAlpha = 0.5; g.fillRect(0, TEX - 5, TEX, 5); g.globalAlpha = 1;  // rubble shadow
  noisy(g, TEX, TEX, pal.dark, '#ffffff', 70);
  return c;
}
function bakeEdge(pal) {
  const c = mkCanvas(TEX, TEX), g = c.getContext('2d');
  g.drawImage(texRock, 0, 0);
  g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(0, 0, TEX, TEX);
  // timber brace so the cave boundary reads as "shored up — no digging here"
  g.fillStyle = '#4a3520'; g.fillRect(2, 0, 5, TEX); g.fillRect(TEX - 7, 0, 5, TEX); g.fillRect(0, 2, TEX, 5);
  g.fillStyle = '#2e2012'; g.fillRect(2, 0, 1, TEX); g.fillRect(TEX - 3, 0, 1, TEX);
  return c;
}
function bakeDepleted(pal) {
  const c = mkCanvas(TEX, TEX), g = c.getContext('2d');
  g.drawImage(texRock, 0, 0);
  g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, 0, TEX, TEX);
  // gouged-out cavity where the vein was
  g.fillStyle = '#0a0a0c';
  g.beginPath(); g.ellipse(16, 17, 9, 7, 0.3, 0, TWOPI); g.fill();
  g.fillStyle = pal.dark; g.globalAlpha = 0.8;
  g.beginPath(); g.ellipse(14, 15, 8, 6, 0.3, 0, TWOPI); g.fill(); g.globalAlpha = 1;
  g.fillStyle = '#000'; g.beginPath(); g.ellipse(16, 17, 6, 4.5, 0.3, 0, TWOPI); g.fill();
  return c;
}
function bakeOre(pal, ore) {
  const c = mkCanvas(TEX, TEX), g = c.getContext('2d');
  g.drawImage(texRock, 0, 0);
  if (ore.glow) { g.fillStyle = ore.color; g.globalAlpha = 0.14; g.fillRect(0, 0, TEX, TEX); g.globalAlpha = 1; }
  // crystal clusters: chunky faceted lumps with a bright facet + dark base
  for (let i = 0; i < 6; i++) {
    const cx0 = 5 + Math.random() * (TEX - 10), cy0 = 6 + Math.random() * (TEX - 12), r = 2.5 + Math.random() * 3;
    g.fillStyle = ore.color;
    g.beginPath();
    g.moveTo(cx0, cy0 - r);
    g.lineTo(cx0 + r, cy0 + r * 0.4); g.lineTo(cx0 + r * 0.3, cy0 + r); g.lineTo(cx0 - r * 0.8, cy0 + r * 0.6);
    g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.beginPath(); g.moveTo(cx0, cy0 - r); g.lineTo(cx0 + r * 0.5, cy0); g.lineTo(cx0 - r * 0.3, cy0 + r * 0.2); g.closePath(); g.fill();
    g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(cx0 - r, cy0 + r * 0.8, r * 2, 1.5);
  }
  return c;
}
function bakeCrack() {
  const c = mkCanvas(TEX, TEX), g = c.getContext('2d');
  g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 1.4;
  for (let b = 0; b < 5; b++) {
    let x = 16 + (Math.random() * 8 - 4), y = 16 + (Math.random() * 8 - 4);
    const ang = (b / 5) * TWOPI + Math.random();
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < 4; s++) { x += Math.cos(ang) * 4 + (Math.random() * 4 - 2); y += Math.sin(ang) * 4 + (Math.random() * 4 - 2); g.lineTo(x, y); }
    g.stroke();
  }
  return c;
}
// Cave gremlin: hunched blob, horns, glowing eyes, claws — tinted per zone.
function bakeGremlin(body, eye, hurt) {
  const W = 34, H = 38, c = mkCanvas(W, H), g = c.getContext('2d');
  const b = hurt ? '#ffffff' : body;
  g.fillStyle = b;
  g.beginPath(); g.ellipse(17, 24, 12, 12, 0, 0, TWOPI); g.fill();          // body
  g.beginPath(); g.ellipse(17, 11, 9, 8, 0, 0, TWOPI); g.fill();           // head
  g.beginPath(); g.moveTo(9, 8); g.lineTo(3, 0); g.lineTo(11, 4); g.fill();   // horns
  g.beginPath(); g.moveTo(25, 8); g.lineTo(31, 0); g.lineTo(23, 4); g.fill();
  g.fillRect(2, 22, 5, 9); g.fillRect(27, 22, 5, 9);                        // claw arms
  if (!hurt) {
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(17, 28, 9, 7, 0, 0, TWOPI); g.fill();   // belly shadow
    g.fillStyle = eye; g.fillRect(11, 9, 4, 3) ; g.fillRect(19, 9, 4, 3);   // glowing slit eyes
    g.fillStyle = '#fff'; g.fillRect(12, 9, 1, 1); g.fillRect(20, 9, 1, 1);
    g.fillStyle = '#e8e0d0'; g.fillRect(13, 15, 2, 3); g.fillRect(19, 15, 2, 3);   // fangs
  }
  return c;
}
// Cave bat: wide jagged wings + tiny fanged body.
function bakeBat(body, eye, hurt) {
  const W = 40, H = 24, c = mkCanvas(W, H), g = c.getContext('2d');
  const b = hurt ? '#ffffff' : body;
  g.fillStyle = b;
  g.beginPath(); g.moveTo(20, 10); g.lineTo(2, 2); g.lineTo(8, 12); g.lineTo(3, 18); g.lineTo(16, 16); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(20, 10); g.lineTo(38, 2); g.lineTo(32, 12); g.lineTo(37, 18); g.lineTo(24, 16); g.closePath(); g.fill();
  g.beginPath(); g.ellipse(20, 13, 6, 7, 0, 0, TWOPI); g.fill();
  if (!hurt) {
    g.fillStyle = eye; g.fillRect(17, 10, 2, 2); g.fillRect(21, 10, 2, 2);
    g.fillStyle = '#e8e0d0'; g.fillRect(18, 16, 1, 2); g.fillRect(21, 16, 1, 2);
  }
  return c;
}
function bakeStalactite(pal) {
  const c = mkCanvas(14, 26), g = c.getContext('2d');
  g.fillStyle = pal.dark;
  g.beginPath(); g.moveTo(1, 0); g.lineTo(13, 0); g.lineTo(8, 26); g.closePath(); g.fill();
  g.fillStyle = pal.wall; g.globalAlpha = 0.6;
  g.beginPath(); g.moveTo(3, 0); g.lineTo(8, 0); g.lineTo(7, 18); g.closePath(); g.fill();
  g.globalAlpha = 1;
  return c;
}
function bakeCart() {
  const W = 42, H = 34, c = mkCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#5a3a1c'; g.fillRect(4, 10, 34, 16);                       // box
  g.fillStyle = '#7a5228'; g.fillRect(4, 10, 34, 3); g.fillRect(4, 10, 3, 16); g.fillRect(35, 10, 3, 16);
  g.fillStyle = '#3a2410'; g.fillRect(4, 24, 34, 2);
  g.fillStyle = '#2a2a30';                                                  // wheels
  g.beginPath(); g.arc(12, 29, 4.5, 0, TWOPI); g.fill();
  g.beginPath(); g.arc(30, 29, 4.5, 0, TWOPI); g.fill();
  g.fillStyle = '#caa84a';                                                  // ore mound
  g.beginPath(); g.ellipse(21, 10, 14, 5, 0, Math.PI, TWOPI); g.fill();
  g.fillStyle = '#ffd84a'; g.fillRect(13, 6, 3, 3); g.fillRect(24, 5, 3, 3); g.fillRect(19, 7, 3, 3);
  return c;
}
function bakeArt() {
  if (_bakedZone === curZone) return;
  _bakedZone = curZone;
  const pal = ZONES[curZone].pal;
  texRock = bakeRock(pal);
  texEdge = bakeEdge(pal);
  texDepleted = bakeDepleted(pal);
  texOre = {};
  ORES.forEach((o, i) => { if (o.zone === curZone) texOre[i] = bakeOre(pal, o); });
  if (!texCrack) texCrack = bakeCrack();
  const tints = [['#6a8a4a', '#ffe04a'], ['#4a6a8a', '#5ae0ff'], ['#7a6a3a', '#ffd84a'], ['#8a3a2a', '#ff7a2a'], ['#5a3a8a', '#c08aff']];
  const [body, eye] = tints[curZone];
  stalactiteSprite = bakeStalactite(pal);
  { const c = mkCanvas(14, 26), g = c.getContext('2d');     // flipped: floor spike
    g.translate(0, 26); g.scale(1, -1); g.drawImage(stalactiteSprite, 0, 0); stalagmiteSprite = c; }
  monSprites.gremlin = { normal: bakeGremlin(body, eye, false), hurt: bakeGremlin(body, eye, true) };
  monSprites.bat = { normal: bakeBat(body, eye, false), hurt: bakeBat(body, eye, true) };
  if (!cartSprite) cartSprite = bakeCart();
}
function texFor(tile) {
  if (tile >= T_ORE) return texOre[tile - T_ORE] || texRock;
  if (tile === 2) return texEdge;
  if (tile === 5) return texDepleted;
  return texRock;
}

// ── cave generation ──────────────────────────────────────────────────────────
function genZone() {
  map = new Uint8Array(MW * MH).fill(1);
  for (let x = 0; x < MW; x++) { map[idx(x, 0)] = 2; map[idx(x, MH - 1)] = 2; }
  for (let y = 0; y < MH; y++) { map[idx(0, y)] = 2; map[idx(MW - 1, y)] = 2; }
  // CAVE SYSTEM, not an arena: meandering tunnels (heading + gentle turns)
  // strung between small ROUND chambers carved with circular masks.
  const carve = (x, y) => { x |= 0; y |= 0; if (x > 0 && y > 0 && x < MW - 1 && y < MH - 1 && map[idx(x, y)] === 1) map[idx(x, y)] = 0; };
  const chamber = (cx, cy, r) => {
    for (let y = Math.floor(cy - r); y <= cy + r; y++)
      for (let x = Math.floor(cx - r); x <= cx + r; x++)
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) carve(x, y);
  };
  const cx0 = MW >> 1, cy0 = MH >> 1;
  chamber(cx0, cy0, 2.6);                                        // round spawn chamber
  const hubs = [[cx0, cy0]];
  // 3 main tunnels wander out from the spawn, each ending in a round chamber,
  // with a smaller side-chamber partway — narrow, winding, occasionally forking
  const nTunnels = 3 + (Math.random() < 0.5 ? 1 : 0);
  for (let tn = 0; tn < nTunnels; tn++) {
    let wx = cx0, wy = cy0;
    let heading = (tn / nTunnels) * 6.283 + Math.random() * 1.2;
    const steps = 16 + (Math.random() * 12) | 0;
    for (let s = 0; s < steps; s++) {
      heading += (Math.random() - 0.5) * 0.9;                    // gentle meander
      wx = clamp(wx + Math.cos(heading), 2, MW - 3);
      wy = clamp(wy + Math.sin(heading), 2, MH - 3);
      carve(wx, wy);
      carve(wx + (Math.abs(Math.cos(heading)) > 0.5 ? 0 : 1), wy + (Math.abs(Math.cos(heading)) > 0.5 ? 1 : 0));  // ~1.5 wide
      if (s === (steps >> 1)) { chamber(wx, wy, 1.8 + Math.random()); hubs.push([wx, wy]); }
    }
    chamber(wx, wy, 2.2 + Math.random() * 1.2);                  // round end chamber
    hubs.push([wx, wy]);
  }
  // smooth lone wall nubs so chamber edges read rounded, not crenellated
  for (let pass = 0; pass < 2; pass++)
    for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW - 1; x++) {
      if (map[idx(x, y)] !== 1) continue;
      let openN = 0;
      if (map[idx(x + 1, y)] === 0) openN++;
      if (map[idx(x - 1, y)] === 0) openN++;
      if (map[idx(x, y + 1)] === 0) openN++;
      if (map[idx(x, y - 1)] === 0) openN++;
      if (openN >= 3) map[idx(x, y)] = 0;
    }
  spawn = { x: cx0 + 0.5, y: cy0 + 0.5 };
  _hSeed = curZone * 7.3 + Math.random() * 6.28;
  cart = { x: cx0 + 0.5, y: cy0 - 0.45, size: 0.62, float: 0, canvas: null };
  // ore veins: wall tiles touching open floor, weighted by the zone's ore table
  veins.clear();
  const pool = ORES.map((o, i) => ({ ...o, i })).filter(o => o.zone === curZone);
  const cand = [];
  for (let y = 1; y < MH - 1; y++) for (let x = 1; x < MW - 1; x++) {
    if (map[idx(x, y)] !== 1) continue;
    if (map[idx(x + 1, y)] === 0 || map[idx(x - 1, y)] === 0 || map[idx(x, y + 1)] === 0 || map[idx(x, y - 1)] === 0) cand.push({ x, y });
  }
  for (let i = cand.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = cand[i]; cand[i] = cand[j]; cand[j] = t; }
  const n = Math.min(ZONES[curZone].veins, cand.length);
  let total = 0; pool.forEach(o => total += o.weight);
  for (let k = 0; k < n; k++) {
    let r = Math.random() * total, def = pool[0];
    for (const o of pool) { r -= o.weight; if (r <= 0) { def = o; break; } }
    const { x, y } = cand[k];
    map[idx(x, y)] = T_ORE + def.i;
    veins.set(idx(x, y), { def, hp: def.hp, max: def.hp, flashT: 0, respawnAt: 0 });
  }
  // hanging stalactites on open floor cells (cave dressing)
  stalactites = [];
  for (let i = 0; i < 26; i++) {
    const p = randFloor(2);
    if (!p) continue;
    const up = Math.random() < 0.35;        // some grow UP from the floor (stalagmites)
    stalactites.push({ x: p.x, y: p.y, size: (up ? 0.22 : 0.3) + Math.random() * 0.25, hang: up ? 0 : 0.92 + Math.random() * 0.06, up });
  }
  // player + creatures
  px = spawn.x; py = spawn.y + 0.9; pa = -Math.PI / 2; pitch = 0;
  mons = []; monRespawnQ = [];
  for (let i = 0; i < ZONES[curZone].mons; i++) spawnMonster(true);
  bakeArt();
  cart.canvas = cartSprite;
  buildMinimap();
}
function randFloor(minDist) {
  for (let t = 0; t < 200; t++) {
    const x = 1 + Math.random() * (MW - 2), y = 1 + Math.random() * (MH - 2);
    if (!isWall(x, y) && Math.hypot(x - spawn.x, y - spawn.y) > minDist) return { x, y };
  }
  return null;
}

// ── monsters ─────────────────────────────────────────────────────────────────
function spawnMonster(initial) {
  const p = randFloor(initial ? 5 : 7);
  if (!p) return;
  const z = curZone, pow = pickPower();
  const bat = z >= 2 && Math.random() < 0.4;
  // HP scales with YOUR pick so kills stay a handful of swings; damage with depth.
  mons.push({
    kind: bat ? 'bat' : 'gremlin',
    x: p.x, y: p.y,
    hp: Math.max(4, Math.round(pow * (bat ? 2 + z * 0.7 : 3 + z))),
    max: 0, radius: 0.3,
    speed: bat ? 2.2 : 1.4 + z * 0.12,
    dmg: bat ? 4 + z * 3 : 7 + z * 4,
    size: bat ? 0.4 : 0.58, float: bat ? 0.32 : 0,
    cool: 0, hurtT: 0, wanderT: 0, wa: Math.random() * TWOPI, losT: 0, los: false, aggro: false,
    phase: Math.random() * TWOPI,
  });
  mons[mons.length - 1].max = mons[mons.length - 1].hp;
}
function losClear(ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy), steps = Math.ceil(d / 0.25);
  for (let i = 1; i < steps; i++) { if (isWall(ax + dx * i / steps, ay + dy * i / steps)) return false; }
  return true;
}
function moveMob(e, nx, ny, dt) {
  const sp = e.speed * dt;
  if (!isWall(e.x + nx * (sp + e.radius), e.y)) e.x += nx * sp;
  if (!isWall(e.x, e.y + ny * (sp + e.radius))) e.y += ny * sp;
}
function updateMonsters(dt, now) {
  for (const e of mons) {
    if (e.hurtT > 0) e.hurtT -= dt;
    e.cool -= dt; e.losT -= dt;
    const dx = px - e.x, dy = py - e.y, dist = Math.hypot(dx, dy) || 1e-3;
    if (e.losT <= 0) { e.los = losClear(e.x, e.y, px, py); e.losT = 0.18; }
    const see = e.los && dist < (e.kind === 'bat' ? 8 : 6.5);
    if (see && !e.aggro) { e.aggro = true; sfx('growl'); addFloater('something stirs…', '#ff8a6a'); }
    if (!see && dist > 10) e.aggro = false;
    if (e.aggro && (see || dist < 3)) {
      const nx = dx / dist, ny = dy / dist;
      // bats weave; gremlins beeline
      const j = e.kind === 'bat' ? Math.sin(now / 160 + e.phase) * 0.7 : 0;
      moveMob(e, nx - ny * j, ny + nx * j, dt);
      if (dist < e.radius + 0.55 && e.cool <= 0) { e.cool = e.kind === 'bat' ? 0.8 : 1.1; hurtPlayer(e.dmg); }
    } else {
      e.wanderT -= dt;
      if (e.wanderT <= 0) { e.wanderT = 0.8 + Math.random() * 1.6; e.wa = Math.random() * TWOPI; }
      moveMob(e, Math.cos(e.wa) * 0.4, Math.sin(e.wa) * 0.4, dt);
    }
  }
  // respawn queue
  while (monRespawnQ.length && now >= monRespawnQ[0]) { monRespawnQ.shift(); if (mons.length < ZONES[curZone].mons) spawnMonster(false); }
}
function hurtPlayer(dmg) {
  const now = performance.now();
  if (now < invulnUntil) return;
  hp -= dmg; lastHurtAt = now;
  sfx('hurt'); flashHurt();
  addFloater('-' + dmg + ' HP', '#ff5a5a');
  if (hp <= 0) die();
}
function die() {
  // drop half the sack, wake up back at the cart
  const lost = sack.splice(0, Math.ceil(sack.length / 2)).length;
  hp = MAX_HP; invulnUntil = performance.now() + 2500;
  px = spawn.x; py = spawn.y + 0.9; pa = -Math.PI / 2;
  for (const e of mons) e.aggro = false;
  sfx('break');
  addFloater(lost > 0 ? `☠ knocked out! dropped ${lost} ore` : '☠ knocked out!', '#ff5a5a');
  refreshInfo();
}

// ── mining / combat ──────────────────────────────────────────────────────────
function castRay(ox, oy, ang) {
  const rdx = Math.cos(ang), rdy = Math.sin(ang);
  let mapX = ox | 0, mapY = oy | 0;
  const ddx = Math.abs(1 / rdx), ddy = Math.abs(1 / rdy);
  let stepX, stepY, sideX, sideY, side = 0;
  if (rdx < 0) { stepX = -1; sideX = (ox - mapX) * ddx; } else { stepX = 1; sideX = (mapX + 1 - ox) * ddx; }
  if (rdy < 0) { stepY = -1; sideY = (oy - mapY) * ddy; } else { stepY = 1; sideY = (mapY + 1 - oy) * ddy; }
  for (let i = 0; i < 64; i++) {
    if (sideX < sideY) { sideX += ddx; mapX += stepX; side = 0; } else { sideY += ddy; mapY += stepY; side = 1; }
    const t = tileAt(mapX, mapY);
    if (t > 0) return { dist: side === 0 ? sideX - ddx : sideY - ddy, mapX, mapY, tile: t };
  }
  return { dist: 64, mapX: -1, mapY: -1, tile: 0 };
}
function facingTarget() {
  // monster in melee range & arc takes priority over the wall behind it
  let best = null, bestD = REACH;
  for (const e of mons) {
    const dx = e.x - px, dy = e.y - py, d = Math.hypot(dx, dy);
    if (d < bestD && (dx * dirX + dy * dirY) / (d || 1e-3) > MELEE_ARC && losClear(px, py, e.x, e.y)) { best = e; bestD = d; }
  }
  if (best) return { mon: best };
  const r = castRay(px, py, pa);
  if (r.dist < REACH) return { wall: r };
  return null;
}
function swing() {
  const now = performance.now();
  const cool = SWING_BASE_MS - pickTier() * 15;
  if (now - lastSwingAt < cool) return;
  lastSwingAt = now; swingT = 1; walkPhase += 0.3;
  const tgt = facingTarget();
  if (!tgt) { sfx('hit'); return; }
  if (tgt.mon) {
    const e = tgt.mon;
    e.hp -= pickPower(); e.hurtT = 0.13; e.aggro = true;
    sfx('crit'); burst('#ff7a5a', 7);
    if (e.hp <= 0) {
      mons.splice(mons.indexOf(e), 1);
      monRespawnQ.push(now + MON_RESPAWN_MS);
      const reward = Math.round((8 + curZone * 10) * prestigeMult());
      if (typeof window.aqAddCredits === 'function') window.aqAddCredits(reward);
      // small, capped kill XP (the mines' own combat) — same grant as the old game
      if (typeof window.aqAddXp === 'function') window.aqAddXp('mining', Math.round(Math.min(120, 8 + curZone * 9)));
      sfx('slay'); burst('#ffd84a', 14);
      addFloater('SLAIN! +' + reward + ' 💰', '#ffd84a');
      refreshInfo();
    }
    return;
  }
  const { mapX, mapY, tile } = tgt.wall;
  if (tile < T_ORE) { sfx('hit'); burst('rgba(200,200,200,0.7)', 3); return; }   // bare rock: clink, no ore
  const vein = veins.get(idx(mapX, mapY));
  if (!vein) { sfx('hit'); return; }
  if (sack.length >= sackCap()) { sfx('hit'); addFloater('Sack full! Sell at the cart ⬆', '#ffd84a'); return; }
  vein.hp -= pickPower(); vein.flashT = 0.12;
  if (typeof window.aqToolWear === 'function' && window.aqToolWear('pick', 1)) {
    sfx('break'); addFloater('⛏️ Your pick BROKE! Repair it at the Pawn Shop', '#ff5a5a');
  }
  sfx('hit'); burst(vein.def.color, 6);
  if (vein.hp <= 0) breakVein(vein, mapX, mapY, now);
}
function breakVein(vein, mapX, mapY, now) {
  const def = vein.def;
  sack.push({ name: def.name, value: Math.round(def.value * prestigeMult()), color: def.color });
  // The grind: XP per ore, scaled by rarity + zone depth + prestige, hard-capped.
  if (typeof window.aqGameXp === 'function') window.aqGameXp('mining', { played: true, won: true, mult: Math.min(XP_CAP, (0.3 + def.rarity * 0.15) * xpZoneMult() * prestigeMult()) });
  addDepth(5 + def.rarity * 2.5);
  map[idx(mapX, mapY)] = 5;            // gouged-out rock until it regrows
  vein.respawnAt = now + VEIN_RESPAWN_MIN + Math.random() * VEIN_RESPAWN_RAND;
  sfx('break'); burst(def.color, 16);
  addFloater('+1 ' + def.name + ' (' + sack.length + '/' + sackCap() + ')', def.color);
  buildMinimap();
  refreshInfo();
}
function updateVeins(now) {
  let dirty = false;
  for (const [k, v] of veins) {
    if (v.flashT > 0) v.flashT -= 0.016;
    if (v.respawnAt && now >= v.respawnAt) { v.respawnAt = 0; v.hp = v.max; map[k] = T_ORE + v.def.i; dirty = true; }
  }
  if (dirty) buildMinimap();
}
function trySell() {
  if (!sack.length) return;
  if (Math.hypot(cart.x - px, cart.y - py) > 1.25) return;
  // The cart BANKS your haul into the shared inventory — cash it out at the
  // Pawn Shop, where the live ORE/GEMS rate sets the price.
  let total = 0;
  for (const o of sack) {
    total += o.value;
    if (typeof window.aqInvAdd === 'function') window.aqInvAdd('ore_' + o.name.toLowerCase(), 1);
  }
  const n = sack.length;
  if (typeof window.recordScore === 'function') window.recordScore('mining', total, ZONES[curZone].name);
  // small haul bonus on top of the per-ore grants
  if (typeof window.aqGameXp === 'function') window.aqGameXp('mining', { played: true, won: true, mult: Math.min(3, n * 0.04 * xpZoneMult()) });
  sack = [];
  sellFlashT = 1;
  sfx('upgrade');
  addFloater('BANKED ' + n + ' ore → 🎒 (sell at the Pawn Shop)', '#ffd84a');
  refreshInfo();
}

// ── FX (screen-space) ────────────────────────────────────────────────────────
function burst(color, n) {
  for (let i = 0; i < n; i++) particles.push({
    x: RW / 2 + (Math.random() - 0.5) * 24, y: RH / 2 + (Math.random() - 0.5) * 16,
    vx: (Math.random() - 0.5) * 90, vy: -Math.random() * 70 - 15, life: 0.55, color,
    s: 1 + ((Math.random() * 2) | 0),
  });
}
function addFloater(text, color) { floaters.push({ text, color, y: RH * 0.42, life: 1.6 }); }
function flashHurt() { if (vignetteEl) { vignetteEl.classList.remove('m3-hit'); void vignetteEl.offsetWidth; vignetteEl.classList.add('m3-hit'); } }

// ── player movement ──────────────────────────────────────────────────────────
function updatePlayer(dt) {
  let fwd = 0, strafe = 0;
  if (keys['KeyW'] || keys['ArrowUp']) fwd += 1;
  if (keys['KeyS'] || keys['ArrowDown']) fwd -= 1;
  if (keys['KeyD']) strafe += 1;
  if (keys['KeyA']) strafe -= 1;
  if (keys['ArrowLeft']) pa -= 2.6 * dt;
  if (keys['ArrowRight']) pa += 2.6 * dt;
  if (_touch) { fwd += -touchMove.y; strafe += touchMove.x; }
  const sp = 2.7;
  const rx = -dirY, ry = dirX;
  const mx = dirX * fwd + rx * strafe, my = dirY * fwd + ry * strafe;
  const ml = Math.hypot(mx, my) || 1;
  if (fwd || strafe) {
    const vx = mx / ml * sp * dt, vy = my / ml * sp * dt;
    if (!isWall(px + Math.sign(vx) * 0.22 + vx, py)) px += vx;
    if (!isWall(px, py + Math.sign(vy) * 0.22 + vy)) py += vy;
    walkPhase += dt * 8;
  }
  dirX = Math.cos(pa); dirY = Math.sin(pa);
  planeX = -dirY * FOV_PLANE; planeY = dirX * FOV_PLANE;
  trySell();
  // slow regen out of combat
  const now = performance.now();
  if (hp < MAX_HP && now - lastHurtAt > REGEN_DELAY) hp = Math.min(MAX_HP, hp + REGEN_PER_S * dt);
}

// ── rendering ────────────────────────────────────────────────────────────────
function render(now) {
  if (!ctx) return;
  const pal = ZONES[curZone].pal;
  const bob = Math.abs(Math.sin(walkPhase)) * 2;
  const hor = RH / 2 + pitch + bob;        // pitch shifts the horizon (look up/down)
  const E = eyeZ();                        // eye rides the rolling cave floor
  ctx.fillStyle = pal.ceil; ctx.fillRect(0, 0, RW, RH);   // base (per-column fills carve it up)
  const [fr, fg, fb] = pal.fog;
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
      if (mapX < 0 || mapY < 0 || mapX >= MW || mapY >= MH) { tile = 2; break; }
      tile = map[idx(mapX, mapY)]; if (tile > 0) break;
    }
    const perp = side === 0 ? (sideX - ddx) : (sideY - ddy);
    zbuffer[x] = perp;
    const lineH = RH / perp;
    // wall sits on the rolling floor: project its base/top from world height
    const fB = caveH(mapX + 0.5, mapY + 0.5);
    const drawStart = hor + (E - fB - 1) * lineH;
    const wallBot = drawStart + lineH;
    // per-column ceiling + floor so the cave visibly rises and dips
    ctx.fillStyle = pal.ceil; if (drawStart > 0) ctx.fillRect(x, 0, 1, drawStart);
    ctx.fillStyle = pal.floor; if (wallBot < RH) ctx.fillRect(x, wallBot, 1, RH - wallBot);
    const tex = texFor(tile);
    let wallX = side === 0 ? py + perp * rdy : px + perp * rdx; wallX -= Math.floor(wallX);
    let texX = (wallX * TEX) | 0;
    if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) texX = TEX - texX - 1;
    ctx.drawImage(tex, texX, 0, 1, TEX, x, drawStart, 1, lineH);
    const y0 = Math.max(0, drawStart), y1 = Math.min(RH, drawStart + lineH);
    // damage cracks + hit flash on ore columns
    if (tile >= T_ORE) {
      const v = veins.get(idx(mapX, mapY));
      if (v) {
        if (v.hp < v.max) { ctx.globalAlpha = 0.25 + 0.7 * (1 - v.hp / v.max); ctx.drawImage(texCrack, texX, 0, 1, TEX, x, drawStart, 1, lineH); ctx.globalAlpha = 1; }
        if (v.flashT > 0) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(x, y0, 1, y1 - y0); }
      }
    }
    // distance fog (tinted) + side shading
    const sh = clamp(perp / 11, 0, 0.82) + (side === 1 ? 0.14 : 0);
    if (sh > 0.02) { ctx.fillStyle = `rgba(${fr >> 1},${fg >> 1},${fb >> 1},${Math.min(0.88, sh)})`; ctx.fillRect(x, y0, 1, y1 - y0); }
  }
  // fog bands on the horizon + overhead/underfoot rock shading (over the columns)
  for (let b = 0; b < 4; b++) {
    ctx.fillStyle = `rgba(${fr},${fg},${fb},${0.05 + 0.05 * (3 - b)})`;
    ctx.fillRect(0, hor - (b + 1) * 6, RW, (b + 1) * 12);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(0, 0, RW, Math.max(0, hor - 46));
  ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fillRect(0, 0, RW, Math.max(0, hor - 26));
  ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(0, Math.min(RH, hor + 50), RW, RH);
  // sprites far-first
  const sprites = [];
  if (cart && cart.canvas) sprites.push(cart);
  if (stalactiteSprite) for (const st of stalactites)
    sprites.push({ x: st.x, y: st.y, size: st.size, float: st.hang, canvas: st.up ? stalagmiteSprite : stalactiteSprite });
  for (const e of mons) sprites.push({
    x: e.x, y: e.y, size: e.size,
    float: e.float ? e.float + Math.sin(now / 240 + e.phase) * 0.08 : 0,
    bob: e.float ? 0 : Math.sin(walkPhase * 0.6 + e.phase) * (RH * 0.01),
    canvas: e.hurtT > 0 ? monSprites[e.kind].hurt : monSprites[e.kind].normal,
  });
  sprites.sort((a, b) => ((b.x - px) ** 2 + (b.y - py) ** 2) - ((a.x - px) ** 2 + (a.y - py) ** 2));
  for (const sp of sprites) drawSprite(sp, hor);
  drawTargetLabel();
  drawPickaxe(now, bob);
  drawParticles();
  drawFloaters();
  drawMinimap();
  if (sellFlashT > 0) { ctx.fillStyle = `rgba(255,216,74,${sellFlashT * 0.25})`; ctx.fillRect(0, 0, RW, RH); }
  if (performance.now() < invulnUntil) { ctx.fillStyle = `rgba(255,255,255,${0.1 + 0.08 * Math.sin(now / 60)})`; ctx.fillRect(0, 0, RW, RH); }
}
function drawSprite(sp, hor) {
  const dx = sp.x - px, dy = sp.y - py;
  const inv = 1 / (planeX * dirY - dirX * planeY);
  const tY = inv * (-planeY * dx + planeX * dy);
  if (tY <= 0.1) return;
  const tX = inv * (dirY * dx - dirX * dy);
  const screenX = (RW / 2) * (1 + tX / tY);
  const fullH = RH / tY;
  const h = fullH * (sp.size || 1);
  const w = h * (sp.canvas.width / sp.canvas.height);
  const bottomY = hor + (eyeZ() - caveH(sp.x, sp.y)) * fullH - (sp.float || 0) * fullH;
  const drawY = bottomY - h - (sp.bob || 0);
  const startX = screenX - w / 2;
  const x0 = Math.max(0, Math.ceil(startX)), x1 = Math.min(RW - 1, Math.floor(startX + w));
  const fog = clamp(1 - tY / 14, 0.35, 1);
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
// crosshair label: what you're about to hit (ore name + HP, or the creature)
function drawTargetLabel() {
  const tgt = facingTarget();
  let txt = null, col = '#fff';
  if (tgt && tgt.mon) { txt = (tgt.mon.kind === 'bat' ? '🦇' : '👹') + ' ' + Math.ceil(tgt.mon.hp) + ' HP'; col = '#ff8a6a'; }
  else if (tgt && tgt.wall && tgt.wall.tile >= T_ORE) {
    const v = veins.get(idx(tgt.wall.mapX, tgt.wall.mapY));
    if (v) { txt = v.def.name + ' vein · ' + Math.ceil(v.hp) + '/' + v.max; col = v.def.color; }
  } else if (tgt && tgt.wall && tgt.wall.tile === 5) { txt = 'depleted…'; col = '#9aa'; }
  if (!cart) return drawCross(txt, col);
  if (Math.hypot(cart.x - px, cart.y - py) < 1.6 && sack.length) { txt = '🛒 step up to BANK your ore'; col = '#ffd84a'; }
  drawCross(txt, col);
}
function drawCross(txt, col) {
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(RW / 2 - 3, RH / 2, 2, 1); ctx.fillRect(RW / 2 + 2, RH / 2, 2, 1);
  ctx.fillRect(RW / 2, RH / 2 - 3, 1, 2); ctx.fillRect(RW / 2, RH / 2 + 2, 1, 2);
  if (txt) {
    ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(txt, RW / 2 + 1, RH / 2 + 8);
    ctx.fillStyle = col; ctx.fillText(txt, RW / 2, RH / 2 + 7);
    ctx.textAlign = 'left';
  }
}
// first-person pickaxe viewmodel: rests bottom-right, arcs across on a swing
function drawPickaxe(now, bob) {
  const t = swingT;                                     // 1 = just swung → 0 = rest
  const arc = t > 0 ? Math.sin((1 - t) * Math.PI) : 0;  // up-and-through arc
  const baseX = RW * 0.72 - arc * RW * 0.26 + Math.sin(walkPhase * 0.5) * 3;
  const baseY = RH * 0.98 - arc * RH * 0.34 + bob * 2;
  const ang = -0.5 - arc * 1.5;
  ctx.save();
  ctx.translate(baseX, baseY);
  ctx.rotate(ang);
  ctx.fillStyle = '#6a4a26'; ctx.fillRect(-2.5, -34, 5, 40);              // handle
  ctx.fillStyle = '#4a3216'; ctx.fillRect(-2.5, -34, 2, 40);
  const head = PICKS[pickTier()].color;
  ctx.fillStyle = head;
  ctx.beginPath(); ctx.moveTo(-16, -34); ctx.quadraticCurveTo(0, -46, 16, -34);   // curved head
  ctx.quadraticCurveTo(0, -38, -16, -34); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-10, -39, 8, 2);  // glint
  ctx.restore();
  if (t > 0.55 && arc > 0.8) {                                            // impact spark at apex
    ctx.fillStyle = '#fff';
    ctx.fillRect(RW / 2 - 2 + Math.random() * 4, RH / 2 - 2 + Math.random() * 4, 2, 2);
  }
}
function drawParticles() {
  for (const p of particles) { ctx.fillStyle = p.color; ctx.globalAlpha = Math.min(1, p.life * 2.2); ctx.fillRect(p.x, p.y, p.s, p.s); }
  ctx.globalAlpha = 1;
}
function drawFloaters() {
  if (!floaters.length) return;
  ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of floaters) {
    ctx.globalAlpha = Math.min(1, f.life * 1.6);
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillText(f.text, RW / 2 + 1, f.y + 1);
    ctx.fillStyle = f.color; ctx.fillText(f.text, RW / 2, f.y);
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
}
// corner minimap: explored layout + ore pips + the cart, so you can find your way back
function buildMinimap() {
  if (!minimapBuf) minimapBuf = mkCanvas(MW * 2, MH * 2);
  const g = minimapBuf.getContext('2d');
  g.clearRect(0, 0, MW * 2, MH * 2);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const t = map[idx(x, y)];
    if (t === 0) { g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(x * 2, y * 2, 2, 2); }
    else if (t >= T_ORE) { g.fillStyle = ORES[t - T_ORE].color; g.fillRect(x * 2, y * 2, 2, 2); }
  }
  g.fillStyle = '#ffd84a'; g.fillRect((cart.x | 0) * 2, (cart.y | 0) * 2, 2, 2);
}
function drawMinimap() {
  if (!minimapBuf) return;
  const mw = MW * 2, x0 = RW - mw - 3, y0 = 3;
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x0 - 1, y0 - 1, mw + 2, MH * 2 + 2);
  ctx.drawImage(minimapBuf, x0, y0);
  // creature blips need the Pawn Shop ENEMY RADAR gadget
  if (window.aqAccOwned && window.aqAccOwned('radar')) {
    const blink = ((performance.now() / 400) | 0) % 2 === 0;
    for (const e of mons) { ctx.fillStyle = blink ? '#ff4a4a' : '#ff9a9a'; ctx.fillRect(x0 + ((e.x * 2) | 0) - 1, y0 + ((e.y * 2) | 0) - 1, 2, 2); }
  }
  ctx.fillStyle = '#fff'; ctx.fillRect(x0 + ((px * 2) | 0) - 1, y0 + ((py * 2) | 0) - 1, 2, 2);
  ctx.fillRect(x0 + ((px + dirX * 0.9) * 2 | 0), y0 + (((py + dirY * 0.9) * 2) | 0), 1, 1);
  ctx.globalAlpha = 1;
}

// ── HUD / DOM ────────────────────────────────────────────────────────────────
function updateHud() {
  if (!hudEl) return;
  const hpPct = clamp(hp / MAX_HP, 0, 1);
  let sackVal = 0; for (const o of sack) sackVal += o.value;
  hudEl.innerHTML =
    `<div class="m3-hp"><div class="m3-hp-fill" style="width:${(hpPct * 100).toFixed(0)}%"></div><span>❤ ${Math.max(0, Math.ceil(hp))}</span></div>` +
    `<div class="m3-stat">⛏ Lv ${mineLvl()}</div>` +
    `<div class="m3-stat" title="haul it to the cart">🎒 ${sack.length}/${sackCap()}${sackVal ? ' (' + sackVal + ')' : ''}</div>` +
    `<div class="m3-stat">${ZONES[curZone].name}</div>` +
    `<span class="m3-stat aq-credits-display">💰 ${credits()}</span>`;
  if (vignetteEl) vignetteEl.style.opacity = (0.1 + (1 - hpPct) * 0.6).toFixed(2);
}
function refreshInfo() {
  if (infoEl) infoEl.textContent = `${PICKS[pickTier()].name} pick (⛏${pickPower()})${prestige ? ' ◆' + prestige : ''} · sack ${sack.length}/${sackCap()} · bank at 🛒, sell at the Pawn Shop`;
  renderZones(); renderShop(); updateHud();
}
function renderZones() {
  if (!zoneEl) return;
  const lvl = mineLvl();
  zoneEl.innerHTML = '';
  ZONES.forEach((z, i) => {
    const unlocked = lvl >= z.lvl;
    const b = el('button', 'm3-btn' + (i === curZone ? ' m3-btn-on' : ''));
    b.disabled = !unlocked;
    b.textContent = unlocked ? z.name : `🔒 ${z.name} · Lv${z.lvl}`;
    b.addEventListener('click', () => {
      if (!unlocked || i === curZone) return;
      curZone = i;
      try { localStorage.setItem('aq_mining_stage', String(i)); window.aqGamePersist && window.aqGamePersist('aq_mining_stage'); } catch (e) {}
      genZone(); refreshInfo();
    });
    zoneEl.appendChild(b);
  });
  // Delve Deeper (prestige): fill the depth bar by mining, then cash it for +5%
  const pb = el('button', 'm3-btn');
  const ready = depthPts >= DEPTH_MAX;
  pb.disabled = !ready;
  pb.textContent = ready ? '⛏️🔥 Delve Deeper' : `Depth ${Math.floor(depthPts / DEPTH_MAX * 100)}%`;
  if (prestige) pb.title = 'Rank ' + prestige + ' · +' + (prestige * 5) + '% mining';
  pb.addEventListener('click', () => {
    if (depthPts < DEPTH_MAX) return;
    prestige++; depthPts = 0;
    try { localStorage.setItem('aq_mining_prestige', String(prestige)); localStorage.setItem('aq_mining_depth', '0'); } catch (e) {}
    if (window.aqGamePersist) window.aqGamePersist('aq_mining_prestige');
    addFloater('◆ DELVED DEEPER! Rank ' + prestige, '#ffd84a');
    try { window.playFanfare?.('jackpot'); } catch (e) {} sfx('upgrade');
    refreshInfo();
  });
  zoneEl.appendChild(pb);
}
function renderShop() {
  // Tools are bought + repaired at the Pawn Shop now; this row just shows wear.
  if (!shopEl) return;
  shopEl.innerHTML = '';
  const ti = typeof window.aqToolInfo === 'function' ? window.aqToolInfo('pick') : null;
  const d = el('div', 'm3-info');
  if (ti && ti.max !== -1) {
    const pct = Math.round(ti.dur / ti.max * 100);
    d.textContent = `${PICKS[ti.tier].name} pick · ${ti.broken ? '💔 BROKEN (using Wooden)' : 'durability ' + pct + '%'}`;
    if (ti.broken || pct < 25) d.style.color = '#ff8a6a';
  } else d.textContent = `${PICKS[pickTier()].name} pick`;
  shopEl.appendChild(d);
  const b = el('button', 'm3-btn m3-btn-buy', '🏪 Pawn Shop (tools & repairs)');
  b.addEventListener('click', () => { window.OS && window.OS.open && window.OS.open('pawn'); });
  shopEl.appendChild(b);
}

function clearOverlay() { if (overlayEl) { overlayEl.remove(); overlayEl = null; } }
function showStart() {
  state = 'start';
  const o = el('div', 'm3-overlay'); overlayEl = o;
  o.appendChild(el('div', 'm3-title', '⛏️ AQUATUNE DEPTHS'));
  o.appendChild(el('div', 'm3-sub', 'Explore the cave, swing your pick at glowing <b>ore veins</b>, and haul your sack back to the <b>🛒 cart</b> to sell. Creatures prowl the deeper zones — fight or flee. <b>Get knocked out and you drop half your ore.</b>'));
  o.appendChild(el('div', 'm3-sub m3-hint', _touch
    ? 'Left pad to move · drag the view to look · hold ⛏ MINE to swing'
    : 'WASD / arrows move · mouse looks · click or hold Space to swing · Esc frees the mouse'));
  o.appendChild(el('div', 'm3-sub m3-hint', 'Sign in to earn Mining XP & keep your pickaxe.'));
  const b = el('button', 'm3-bigbtn', '▶ Enter the mine');
  b.onclick = () => { state = 'playing'; clearOverlay(); requestLock(); updateHud(); };
  o.appendChild(b);
  const view = area && area.querySelector('.m3-view');
  if (view) view.appendChild(o);
}
function showResume() {
  if (overlayEl || _touch) return;
  const o = el('div', 'm3-overlay'); overlayEl = o;
  o.appendChild(el('div', 'm3-title', '⏸ Paused'));
  const b = el('button', 'm3-bigbtn', '▶ Back to the mine');
  b.onclick = () => requestLock();
  o.appendChild(b);
  const view = area && area.querySelector('.m3-view');
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
  const w = document.getElementById('mining-wrap');
  if (!w || !w.classList.contains('open')) return;
  if (e.type === 'keydown') {
    if (window.aqIsActiveApp && !window.aqIsActiveApp('mining')) return;   // another window owns the keys
    keys[e.code] = true;
    if (state === 'playing' && e.code === 'Space') { e.preventDefault(); swinging = true; swing(); }
  } else {
    keys[e.code] = false;
    if (e.code === 'Space') swinging = false;
  }
}
function onMouseMove(e) {
  if (state !== 'playing' || document.pointerLockElement !== cv) return;
  pa += e.movementX * 0.0026;
  pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch - e.movementY * 0.22));
}
function onMouseDown() {
  if (state !== 'playing') return;
  if (document.pointerLockElement !== cv && !_touch) { requestLock(); return; }
  swinging = true; swing();
}
function onLockChange() {
  if (_touch) return;
  if (document.pointerLockElement === cv) { paused = false; clearOverlay(); }
  else if (state === 'playing') { paused = true; swinging = false; showResume(); }
}
function buildTouch(view) {
  touchEl = el('div', 'm3-touch');
  const stick = el('div', 'm3-stick', '<div class="m3-stick-knob"></div>');
  const mine = el('div', 'm3-mine', '⛏');
  touchEl.append(stick, mine);
  view.appendChild(touchEl);
  let sid = null, ox = 0, oy = 0;
  const knob = stick.querySelector('.m3-stick-knob');
  stick.addEventListener('touchstart', e => { const t = e.changedTouches[0]; sid = t.identifier; ox = t.clientX; oy = t.clientY; e.preventDefault(); }, { passive: false });
  stick.addEventListener('touchmove', e => { for (const t of e.changedTouches) if (t.identifier === sid) { const dx = clamp((t.clientX - ox) / 40, -1, 1), dy = clamp((t.clientY - oy) / 40, -1, 1); touchMove.x = dx; touchMove.y = dy; knob.style.transform = `translate(${dx * 22}px,${dy * 22}px)`; } e.preventDefault(); }, { passive: false });
  const endStick = e => { for (const t of e.changedTouches) if (t.identifier === sid) { sid = null; touchMove.x = touchMove.y = 0; knob.style.transform = ''; } };
  stick.addEventListener('touchend', endStick); stick.addEventListener('touchcancel', endStick);
  // drag anywhere on the view to look
  let lid = null, lx = 0, ly = 0;
  cv.addEventListener('touchstart', e => { if (state !== 'playing') return; const t = e.changedTouches[0]; lid = t.identifier; lx = t.clientX; ly = t.clientY; }, { passive: true });
  cv.addEventListener('touchmove', e => { for (const t of e.changedTouches) if (t.identifier === lid) {
    pa += (t.clientX - lx) * 0.006; lx = t.clientX;
    pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, pitch - (t.clientY - ly) * 0.4)); ly = t.clientY;
  } }, { passive: true });
  const endLook = e => { for (const t of e.changedTouches) if (t.identifier === lid) lid = null; };
  cv.addEventListener('touchend', endLook); cv.addEventListener('touchcancel', endLook);
  mine.addEventListener('touchstart', e => { swinging = true; if (state === 'playing') swing(); e.preventDefault(); }, { passive: false });
  mine.addEventListener('touchend', e => { swinging = false; e.preventDefault(); }, { passive: false });
}

// ── main loop ────────────────────────────────────────────────────────────────
function tick(t) {
  const dt = Math.min(0.05, (t - (_lastT || t)) / 1000); _lastT = t;
  if (swingT > 0) swingT = Math.max(0, swingT - dt * 4.5);
  if (sellFlashT > 0) sellFlashT = Math.max(0, sellFlashT - dt * 2);
  for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 220 * dt; p.life -= dt; }
  if (particles.length) particles = particles.filter(p => p.life > 0);
  for (const f of floaters) { f.y -= 11 * dt; f.life -= dt; }
  if (floaters.length) floaters = floaters.filter(f => f.life > 0);
  if (state === 'playing' && !paused) {
    updatePlayer(dt);
    updateMonsters(dt, performance.now());
    updateVeins(performance.now());
    if (Math.random() < dt * 0.5) {                          // cave drips
      particles.push({ x: Math.random() * RW, y: 8 + Math.random() * 16, vx: 0, vy: 60, life: 0.8, color: 'rgba(140,190,230,0.7)', s: 1 });
      if (Math.random() < 0.3) sfx('hit');
    }
    if (swinging) swing();
    updateHud();
  }
  render(t);
  raf = requestAnimationFrame(tick);
}

// ── build / open ─────────────────────────────────────────────────────────────
function injectStyle() {
  if (document.getElementById('m3-style')) return;
  const s = el('style'); s.id = 'm3-style';
  s.textContent = `
  #mining-wrap{width:560px}
  #mining-area{background:#0b0a10;padding:0;gap:0}
  .m3-view{position:relative;background:#000;line-height:0}
  .m3-view canvas{width:100%;height:auto;display:block;image-rendering:pixelated;image-rendering:crisp-edges;cursor:crosshair;touch-action:none}
  .m3-vignette{position:absolute;inset:0;pointer-events:none;z-index:5;opacity:0;transition:opacity .25s;box-shadow:inset 0 0 60px 10px rgba(150,0,0,.85)}
  .m3-vignette.m3-hit{animation:m3hit .25s ease-out}
  @keyframes m3hit{0%{box-shadow:inset 0 0 90px 30px rgba(220,0,0,1)}100%{box-shadow:inset 0 0 60px 10px rgba(150,0,0,.85)}}
  .m3-hud{display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:11px;font-weight:800;color:#fff;background:linear-gradient(180deg,#1c1828,#0e0c16);flex-wrap:wrap}
  .m3-hp{position:relative;flex:1;min-width:90px;height:15px;border-radius:8px;background:#3a0c0c;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
  .m3-hp-fill{height:100%;background:linear-gradient(90deg,#ff3b3b,#ff8a4a);transition:width .15s}
  .m3-hp span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:10px;text-shadow:0 1px 2px #000}
  .m3-stat{background:rgba(255,255,255,.08);padding:3px 7px;border-radius:7px;white-space:nowrap}
  .m3-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:5px 8px;background:#12101c}
  .m3-btn{font-family:var(--font-ui,sans-serif);font-weight:800;font-size:11px;color:#e8e4f8;background:#262238;border:1px solid #45406a;border-radius:7px;padding:6px 10px;cursor:pointer}
  .m3-btn:hover:not(:disabled){border-color:#7a6ad0}
  .m3-btn:disabled{opacity:.45;cursor:default}
  .m3-btn-on{outline:2px solid #ffd84a;color:#ffd84a}
  .m3-btn-buy{background:linear-gradient(180deg,#3a5a2a,#22381a);border-color:#5a8a3a;color:#d8ffb8}
  .m3-info{font-size:11px;font-weight:700;color:#b8b2d8}
  .m3-overlay{position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px;text-align:center;background:rgba(8,6,14,.92);color:#fff;line-height:1.45}
  .m3-title{font-size:21px;font-weight:900;letter-spacing:1px;color:#ffd84a;text-shadow:0 2px 0 #5a4408}
  .m3-sub{font-size:12px;opacity:.92;max-width:380px;line-height:1.5}
  .m3-hint{opacity:.7;font-size:11px}
  .m3-bigbtn{font-size:14px;font-weight:800;padding:11px 24px;border-radius:10px;cursor:pointer;color:#1a1402;background:linear-gradient(180deg,#ffe04a,#e0a02a);border:none}
  .m3-bigbtn:hover{filter:brightness(1.08)}
  .m3-touch{display:none;position:absolute;inset:0;z-index:8;pointer-events:none}
  .m3-touch>*{pointer-events:auto}
  .m3-stick{position:absolute;left:14px;bottom:14px;width:84px;height:84px;border-radius:50%;background:rgba(255,255,255,.08);box-shadow:inset 0 0 0 2px rgba(255,255,255,.18)}
  .m3-stick-knob{position:absolute;left:26px;top:26px;width:32px;height:32px;border-radius:50%;background:rgba(255,216,74,.65)}
  .m3-mine{position:absolute;right:14px;bottom:20px;width:74px;height:74px;border-radius:50%;background:rgba(255,180,40,.5);display:flex;align-items:center;justify-content:center;font-size:30px;box-shadow:inset 0 0 0 2px rgba(255,255,255,.25)}
  @media (max-width:768px){
    #mining-wrap{width:100vw}
    #mining-area{overflow:hidden}
    .m3-view{flex:1;min-height:0;display:flex}
    .m3-view canvas{flex:1;height:100%;object-fit:contain;background:#000}
    .m3-bar{padding:4px 6px}
  }`;
  document.head.appendChild(s);
}
function build() {
  area = document.getElementById('mining-area');
  if (!area) return;
  injectStyle();
  area.innerHTML = '';
  hudEl = el('div', 'm3-hud'); area.appendChild(hudEl);
  const view = el('div', 'm3-view');
  cv = mkCanvas(RW, RH); ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = false;
  zbuffer = new Float32Array(RW);
  view.appendChild(cv);
  vignetteEl = el('div', 'm3-vignette'); view.appendChild(vignetteEl);
  buildTouch(view);
  area.appendChild(view);
  const info = el('div', 'm3-bar'); infoEl = el('div', 'm3-info'); info.appendChild(infoEl); area.appendChild(info);
  zoneEl = el('div', 'm3-bar'); area.appendChild(zoneEl);
  shopEl = el('div', 'm3-bar'); area.appendChild(shopEl);
  if (!window._m3Bound) {
    window._m3Bound = true;
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', () => { swinging = false; });
    document.addEventListener('pointerlockchange', onLockChange);
  }
  cv.addEventListener('mousedown', onMouseDown);
  _built = true;
}

function openMining(show = true) {
  const w = document.getElementById('mining-wrap');
  if (!w) return;
  if (show === false) {
    w.classList.remove('open'); w.style.display = 'none';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    exitPointerLock(); swinging = false; for (const k in keys) keys[k] = false;
    return;
  }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('mining'); window.OS.focus('mining'); }
  if (!_built) build();
  const saved = Math.min(maxZone(), parseInt(localStorage.getItem('aq_mining_stage') || '0', 10) || 0);
  if (!map || saved !== curZone) { curZone = saved; genZone(); }
  refreshInfo();
  if (touchEl) touchEl.style.display = _touch ? 'block' : 'none';
  if (state !== 'playing') showStart();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') {
  window.openMining = openMining;
  // test hook (headless harness audits cave topology without exports)
  if (window.__m3TestHook) window.__m3TestHook({
    getWorld: () => ({ map, MW, MH, veins, spawn }), caveH, genZone, setZone: z => { curZone = z; },
  });
  // Cloud game-save merge can land after the window is already open — re-read the
  // restored pickaxe/zone/prestige and refresh the shop so a synced upgrade shows.
  window.addEventListener('aq-gamedata-synced', () => {
    prestige = Math.max(prestige, parseInt(localStorage.getItem('aq_mining_prestige') || '0', 10) || 0);
    const w = document.getElementById('mining-wrap');
    if (!w || !w.classList.contains('open')) return;
    const saved = Math.min(maxZone(), parseInt(localStorage.getItem('aq_mining_stage') || '0', 10) || 0);
    if (saved !== curZone) { curZone = saved; genZone(); }
    refreshInfo();
  });
}
