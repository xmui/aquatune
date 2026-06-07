// Aquatune "Neon Runner" — an off-brand, procedurally-generated, real-time action
// roguelike (Zelda-like) with a cyberpunk NES-pixel look. Move with the D-pad/keys,
// A swings a cyber-blade in your facing direction, B is a short dash (i-frames).
// Room-at-a-time floors: clear/explore rooms, find the elevator, descend forever.
// Permadeath. On run end: Combat XP + credits by depth (both capped), leaderboard,
// and persisted best depth + milestone unlocks. Mobile gets an on-screen multi-touch
// pad; desktop uses a focus-gated keyboard.

const W = 176, H = 160, TS = 16, COLS = 11, ROWS = 10;
const BG = '#0a0e1f', WALL = '#1b2350', WALL_EDGE = '#2de0ff', FLOOR = '#10162e', GRID = '#1a2348';
const CYAN = '#2de0ff', MAGENTA = '#ff3df0', LIME = '#7CFF3D', AMBER = '#ffb02e', RED = '#ff4d5e';
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

let cv = null, cx = null, raf = null, _built = false, _pad = null, _keyHandler = null;
let state = 'start';                 // start | play | descend | over
let rooms = {}, curRoomId = 0, depth = 1;
let player = null, projectiles = [], floaters = [];
let held = { up: false, down: false, left: false, right: false };
let pointers = new Map();
let _finished = false, runKills = 0, runScore = 0, runPayout = 0;
let lastT = 0, descendT = 0, _seed = 1, _shake = 0;

function sfx(n) { try { window.rogueSfx && window.rogueSfx(n); } catch (e) {} }
function bestDepth() { return parseInt(localStorage.getItem('aq_rogue_depth') || '0', 10) || 0; }

// ── deterministic RNG (per run) ──────────────────────────────────────────────
function srand(s) { _seed = (s >>> 0) || 1; }
function rng() { let x = _seed; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; _seed = x >>> 0; return _seed / 4294967296; }
function ri(n) { return (rng() * n) | 0; }

// ── floor generation (room-at-a-time graph) ──────────────────────────────────
function newRoom(id, gx, gy) { return { id, gx, gy, tiles: null, doors: {}, locked: {}, enemies: [], pickups: [], kind: 'normal', cleared: false, spawned: false }; }
function connect(a, b, d) { a.doors[d] = b.id; b.doors[OPP[d]] = a.id; }

function genFloor(d) {
  // ids start at 1 — door values store neighbour ids, and `if (room.doors.dir)`
  // truthiness checks would treat a door leading to room 0 as "no door".
  rooms = {}; const grid = {}; let id = 1; const order = [];
  let gx = 0, gy = 0; const startId = id++;
  rooms[startId] = newRoom(startId, gx, gy); grid['0,0'] = startId; order.push(startId);
  const target = clamp(6 + (d / 2 | 0), 6, 9);
  let cgx = 0, cgy = 0, cur = startId, guard = 0;
  while (order.length < target && guard++ < 300) {
    const ds = ['up', 'down', 'left', 'right']; for (let i = ds.length - 1; i > 0; i--) { const j = ri(i + 1);[ds[i], ds[j]] = [ds[j], ds[i]]; }
    let moved = false;
    for (const dd of ds) {
      const nx = cgx + DIRS[dd][0], ny = cgy + DIRS[dd][1];
      if (Math.abs(nx) > 2 || Math.abs(ny) > 2) continue;
      const key = nx + ',' + ny;
      if (grid[key] == null) {
        const nid = id++; rooms[nid] = newRoom(nid, nx, ny); grid[key] = nid; order.push(nid);
        connect(rooms[cur], rooms[nid], dd); cgx = nx; cgy = ny; cur = nid; moved = true; break;
      }
    }
    if (!moved) { const rid = order[ri(order.length)]; cgx = rooms[rid].gx; cgy = rooms[rid].gy; cur = rid; }
  }
  rooms[startId].kind = 'start';
  const exitId = order[order.length - 1];
  rooms[exitId].kind = (d % 3 === 0) ? 'boss' : 'exit';
  for (const k in rooms) buildTiles(rooms[k], d);
  // keycard lock on some non-boss floors
  if (d % 3 !== 0 && order.length > 3 && rng() < 0.6) {
    const ex = rooms[exitId];
    for (const dd in ex.doors) { ex.locked[dd] = true; const nb = rooms[ex.doors[dd]]; if (nb) nb.locked[OPP[dd]] = true; }
    const cand = order.filter(i => i !== startId && i !== exitId);
    if (cand.length) { const kr = rooms[cand[ri(cand.length)]]; const p = randFloorTile(kr); if (p) kr.pickups.push({ type: 'key', x: p.x, y: p.y }); }
  }
  curRoomId = startId; rooms[startId].spawned = true;   // start room: no enemies
  spawnPickups(rooms[startId], d, true);
}

function buildTiles(room, d) {
  const mc = COLS >> 1, mr = ROWS >> 1; let T;
  let tries = 0;
  do {
    T = [];
    for (let y = 0; y < ROWS; y++) { const row = []; for (let x = 0; x < COLS; x++) row.push((x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1) ? 1 : 0); T.push(row); }
    if (room.doors.up) T[0][mc] = 2;
    if (room.doors.down) T[ROWS - 1][mc] = 2;
    if (room.doors.left) T[mr][0] = 2;
    if (room.doors.right) T[mr][COLS - 1] = 2;
    const nb = room.kind === 'boss' ? 0 : ri(3);
    for (let i = 0; i < nb; i++) {
      const bx = 1 + ri(COLS - 2), by = 1 + ri(ROWS - 2);
      if (bx === mc || by === mr) continue;            // keep door corridors clear
      T[by][bx] = 1;
      if (rng() < 0.5 && bx + 1 < COLS - 1 && bx + 1 !== mc) T[by][bx + 1] = 1;
    }
  } while (!doorsConnected(T, room) && ++tries < 6);
  if (!doorsConnected(T, room)) for (let y = 1; y < ROWS - 1; y++) for (let x = 1; x < COLS - 1; x++) T[y][x] = 0;
  if (room.kind === 'exit' || room.kind === 'boss') T[mr][mc] = 4;   // elevator
  room.tiles = T;
}
function doorsConnected(T, room) {
  const seen = new Set(), stack = [[COLS >> 1, ROWS >> 1]];
  const solid = (x, y) => x < 0 || y < 0 || x >= COLS || y >= ROWS || T[y][x] === 1 || T[y][x] === 3;
  while (stack.length) { const [x, y] = stack.pop(); const k = x + ',' + y; if (seen.has(k) || solid(x, y)) continue; seen.add(k); stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]); }
  const mc = COLS >> 1, mr = ROWS >> 1;
  for (const dd in room.doors) { let dx = mc, dy = mr; if (dd === 'up') dy = 0; else if (dd === 'down') dy = ROWS - 1; else if (dd === 'left') dx = 0; else dx = COLS - 1; if (!seen.has(dx + ',' + dy)) return false; }
  return true;
}
function randFloorTile(room) {
  for (let i = 0; i < 40; i++) { const tx = 1 + ri(COLS - 2), ty = 1 + ri(ROWS - 2); if (room.tiles[ty][tx] === 0) return { x: tx * TS + TS / 2, y: ty * TS + TS / 2 }; }
  return null;
}

// ── entities ─────────────────────────────────────────────────────────────────
function makePlayer() {
  return { x: W / 2, y: H / 2, hp: 6, maxHp: 6, facing: 'down', speed: 60, iframes: 0, attackT: 0, attackCd: 0,
    dashT: 0, dashCd: 0, dashCdMax: 1.2, keycards: 0, swingId: 0,
    pow: { dmg: 1, speedMul: 1, fireRate: 1, dmgT: 0, speedT: 0 } };
}
function applyUnlocks(p) {
  let u = {}; try { u = JSON.parse(localStorage.getItem('aq_rogue_unlocks') || '{}'); } catch (e) {}
  if (u.perk_heart) { p.maxHp += 2; p.hp += 2; }
  if (u.perk_dashcd) p.dashCdMax = 0.9;
  if (u.perk_dmg) p.pow.dmg = 1.25;
}
const ETYPES = {
  drone:    { hp: 3, speed: 38, dmg: 1, r: 6, ai: 'chase', col: CYAN },
  enforcer: { hp: 4, speed: 50, dmg: 1, r: 7, ai: 'chase', col: MAGENTA },
  hound:    { hp: 3, speed: 46, dmg: 1, r: 6, ai: 'hound', col: AMBER },
  turret:   { hp: 5, speed: 0,  dmg: 1, r: 7, ai: 'turret', col: RED },
};
function makeEnemy(type, x, y) { const t = ETYPES[type]; return { type, x, y, vx: 0, vy: 0, hp: t.hp, maxHp: t.hp, speed: t.speed, contact: t.dmg, r: t.r, ai: t.ai, col: t.col, fireCd: 1 + rng(), knockT: 0, flash: 0, lunge: 0, lungeCd: 1 + rng(), lastSwing: -1 }; }
function makeBoss(d, x, y) { const hp = 30 + d * 4; return { type: 'boss', x, y, vx: 0, vy: 0, hp, maxHp: hp, speed: 30, contact: 2, r: 11, ai: 'boss', col: MAGENTA, fireCd: 2, knockT: 0, flash: 0, lastSwing: -1 }; }
function pickType(d) { const r = rng(); if (d >= 4 && r < 0.22) return 'turret'; if (r < 0.3) return 'hound'; if (d >= 2 && r < 0.55) return 'enforcer'; return 'drone'; }

function spawnRoom(room, d) {
  if (room.spawned) return; room.spawned = true;
  if (room.kind === 'boss') { room.enemies.push(makeBoss(d, W / 2, H / 2 - TS)); sfx('boss'); spawnPickups(room, d, false); return; }
  const n = clamp(Math.round(1 + d * 0.6 + rng()), 0, 5);
  for (let i = 0; i < n; i++) { const p = randFloorTile(room); if (!p) break; room.enemies.push(makeEnemy(pickType(d), p.x, p.y)); }
  spawnPickups(room, d, false);
}
function spawnPickups(room, d, isStart) {
  if (isStart) return;
  if (rng() < 0.35) { const p = randFloorTile(room); if (p) room.pickups.push({ type: rng() < 0.5 ? 'hp' : 'chip', x: p.x, y: p.y }); }
  if (rng() < 0.33) { const p = randFloorTile(room); if (p) room.pickups.push({ type: 'pow', kind: ['dmg', 'speed', 'fire'][ri(3)], x: p.x, y: p.y }); }
}

// ── tile collision ───────────────────────────────────────────────────────────
function tileAt(room, px, py) { const tx = px / TS | 0, ty = py / TS | 0; if (tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS) return 1; return room.tiles[ty][tx]; }
function solidAt(room, px, py) { const t = tileAt(room, px, py); return t === 1 || t === 3; }
function moveEnt(ent, dx, dy, room, rad) {
  // per-axis AABB-vs-tile resolution (smooth wall slide)
  if (dx) { const nx = ent.x + dx, s = Math.sign(dx); if (!solidAt(room, nx + s * rad, ent.y - rad) && !solidAt(room, nx + s * rad, ent.y + rad - 1)) ent.x = nx; }
  if (dy) { const ny = ent.y + dy, s = Math.sign(dy); if (!solidAt(room, ent.x - rad, ny + s * rad) && !solidAt(room, ent.x + rad - 1, ny + s * rad)) ent.y = ny; }
}

// ── input actions ────────────────────────────────────────────────────────────
function doAttack() { if (state !== 'play' || !player || player.attackCd > 0) return; player.attackT = 0.12; player.attackCd = 0.32; player.swingId++; sfx('attack'); }
function doDash() { if (state !== 'play' || !player || player.dashCd > 0) return; player.dashT = 0.16; player.dashCd = player.dashCdMax; player.iframes = Math.max(player.iframes, 0.18); sfx('powerup'); }

// ── update ───────────────────────────────────────────────────────────────────
function update(dt) {
  const room = rooms[curRoomId]; if (!room || !player) return;
  const p = player;
  // timers
  p.iframes = Math.max(0, p.iframes - dt); p.attackT = Math.max(0, p.attackT - dt); p.attackCd = Math.max(0, p.attackCd - dt);
  p.dashT = Math.max(0, p.dashT - dt); p.dashCd = Math.max(0, p.dashCd - dt);
  p.pow.dmgT = Math.max(0, p.pow.dmgT - dt); p.pow.speedT = Math.max(0, p.pow.speedT - dt);
  if (p.pow.dmgT <= 0 && !unlockDmg()) p.pow.dmg = 1; if (p.pow.speedT <= 0) p.pow.speedMul = 1;
  _shake = Math.max(0, _shake - dt);

  // movement
  let mx = (held.right ? 1 : 0) - (held.left ? 1 : 0), my = (held.down ? 1 : 0) - (held.up ? 1 : 0);
  if (mx || my) {
    const m = Math.hypot(mx, my) || 1; mx /= m; my /= m;
    if (Math.abs(mx) > Math.abs(my)) p.facing = mx > 0 ? 'right' : 'left'; else p.facing = my > 0 ? 'down' : 'up';
    const sp = p.speed * p.pow.speedMul * (p.dashT > 0 ? 3 : 1) * dt;
    moveEnt(p, mx * sp, 0, room, 5); moveEnt(p, 0, my * sp, room, 5);
  } else if (p.dashT > 0) { const dv = DIRS[p.facing]; const sp = p.speed * 3 * dt; moveEnt(p, dv[0] * sp, 0, room, 5); moveEnt(p, 0, dv[1] * sp, room, 5); }

  // room transition through doorways
  if (room.doors.left && p.x < TS * 0.6 && held.left) tryGo('left');
  else if (room.doors.right && p.x > W - TS * 0.6 && held.right) tryGo('right');
  else if (room.doors.up && p.y < TS * 0.6 && held.up) tryGo('up');
  else if (room.doors.down && p.y > H - TS * 0.6 && held.down) tryGo('down');

  // melee hitbox
  if (p.attackT > 0) {
    const dv = DIRS[p.facing]; const hx = p.x + dv[0] * 14, hy = p.y + dv[1] * 14;
    for (const en of room.enemies) {
      if (en.lastSwing === p.swingId) continue;
      if (Math.abs(en.x - hx) < 12 + en.r && Math.abs(en.y - hy) < 12 + en.r) {
        en.lastSwing = p.swingId; en.hp -= p.pow.dmg; en.flash = 0.12; en.knockT = 0.18;
        en.vx = dv[0] * 150; en.vy = dv[1] * 150; sfx('hit');
        if (en.hp <= 0) killEnemy(room, en);
      }
    }
  }

  // enemies
  for (const en of room.enemies) {
    en.flash = Math.max(0, en.flash - dt);
    if (en.knockT > 0) { en.knockT -= dt; moveEnt(en, en.vx * dt, 0, room, en.r - 1); moveEnt(en, 0, en.vy * dt, room, en.r - 1); }
    else {
      const ddx = p.x - en.x, ddy = p.y - en.y, dist = Math.hypot(ddx, ddy) || 1, ux = ddx / dist, uy = ddy / dist;
      if (en.ai === 'chase' || en.ai === 'boss') { const sp = en.speed * dt; moveEnt(en, ux * sp, 0, room, en.r - 1); moveEnt(en, 0, uy * sp, room, en.r - 1); }
      else if (en.ai === 'hound') { en.lungeCd -= dt; if (en.lungeCd <= 0) { en.lunge = 0.25; en.lungeCd = 1.4 + rng(); } en.lunge = Math.max(0, en.lunge - dt); const sp = en.speed * (en.lunge > 0 ? 2 : 1) * dt; moveEnt(en, ux * sp, 0, room, en.r - 1); moveEnt(en, 0, uy * sp, room, en.r - 1); }
      if (en.ai === 'turret' || en.ai === 'boss') {
        en.fireCd -= dt;
        if (en.fireCd <= 0 && dist < 140) {
          en.fireCd = en.ai === 'boss' ? 2 : 1.6;
          if (en.ai === 'boss') { for (const a of [-0.3, 0, 0.3]) { const c = Math.cos(a), s = Math.sin(a); projectiles.push({ x: en.x, y: en.y, vx: (ux * c - uy * s) * 60, vy: (ux * s + uy * c) * 60, dmg: 1, life: 4, r: 3 }); } }
          else projectiles.push({ x: en.x, y: en.y, vx: ux * 60, vy: uy * 60, dmg: 1, life: 4, r: 3 });
          sfx('attack');
        }
      }
    }
    // contact damage
    if (p.iframes <= 0 && Math.abs(en.x - p.x) < en.r + 5 && Math.abs(en.y - p.y) < en.r + 5) hurtPlayer(en.contact, en.x, en.y);
  }

  // projectiles
  for (const pr of projectiles) {
    pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.life -= dt;
    if (pr.life <= 0 || solidAt(room, pr.x, pr.y)) { pr.dead = true; continue; }
    if (p.iframes <= 0 && Math.abs(pr.x - p.x) < pr.r + 5 && Math.abs(pr.y - p.y) < pr.r + 5) { hurtPlayer(pr.dmg, pr.x, pr.y); pr.dead = true; }
  }
  projectiles = projectiles.filter(pr => !pr.dead);

  // pickups
  room.pickups = room.pickups.filter(pk => {
    if (Math.abs(pk.x - p.x) < 9 && Math.abs(pk.y - p.y) < 9) { grabPickup(pk); return false; }
    return true;
  });

  // floaters
  for (const f of floaters) { f.y -= 14 * dt; f.t -= dt; } floaters = floaters.filter(f => f.t > 0);

  // room cleared?
  if (!room.cleared && room.enemies.length === 0 && (room.kind === 'boss' || room.kind === 'normal' || room.kind === 'key' || room.kind === 'exit')) {
    room.cleared = true; if (room.kind === 'boss') { sfx('descend'); const pt = randFloorTile(room); if (pt) room.pickups.push({ type: 'hp', x: W / 2, y: H / 2 + TS }); }
  }

  // descend on the elevator
  if (tileAt(room, p.x, p.y) === 4 && exitActive(room)) descend();
}
function exitActive(room) { return room.kind === 'exit' || (room.kind === 'boss' && room.cleared); }
function unlockDmg() { try { return !!JSON.parse(localStorage.getItem('aq_rogue_unlocks') || '{}').perk_dmg; } catch (e) { return false; } }

function killEnemy(room, en) { en.dead = true; room.enemies = room.enemies.filter(e => e !== en); runKills++; floaters.push({ x: en.x, y: en.y, t: 0.5, txt: '', col: en.col }); if (en.type === 'boss') { room.cleared = true; sfx('boss'); } }
function hurtPlayer(dmg, sx, sy) {
  const p = player; p.hp -= dmg; p.iframes = 0.8; _shake = 0.25; sfx('hurt');
  const dx = p.x - sx, dy = p.y - sy, d = Math.hypot(dx, dy) || 1; const room = rooms[curRoomId];
  moveEnt(p, dx / d * 10, 0, room, 5); moveEnt(p, 0, dy / d * 10, room, 5);
  if (p.hp <= 0) die();
}
function grabPickup(pk) {
  if (pk.type === 'hp') { player.hp = Math.min(player.maxHp, player.hp + 2); sfx('pickup'); }
  else if (pk.type === 'chip') { runScore += 0; sfx('coin'); floaters.push({ x: pk.x, y: pk.y, t: 0.6, txt: '+', col: AMBER }); }
  else if (pk.type === 'key') { player.keycards++; sfx('pickup'); }
  else if (pk.type === 'pow') {
    if (pk.kind === 'dmg') { player.pow.dmg = 1.6; player.pow.dmgT = 12; }
    else if (pk.kind === 'speed') { player.pow.speedMul = 1.4; player.pow.speedT = 12; }
    else { player.pow.fireRate = 1.4; }
    sfx('powerup'); floaters.push({ x: pk.x, y: pk.y, t: 0.7, txt: '', col: LIME });
  }
}
function tryGo(dir) {
  const room = rooms[curRoomId];
  if (room.locked[dir]) { if (player.keycards > 0) { player.keycards--; room.locked[dir] = false; const nb = rooms[room.doors[dir]]; if (nb) nb.locked[OPP[dir]] = false; sfx('door'); } else { sfx('door'); return; } }
  const nid = room.doors[dir]; if (nid == null) return;
  curRoomId = nid; projectiles = [];
  const dv = DIRS[dir];
  // enter from the opposite door of the new room
  if (dir === 'left') player.x = W - TS * 1.2; else if (dir === 'right') player.x = TS * 1.2;
  if (dir === 'up') player.y = H - TS * 1.2; else if (dir === 'down') player.y = TS * 1.2;
  if (dir === 'left' || dir === 'right') player.y = H / 2; if (dir === 'up' || dir === 'down') player.x = W / 2;
  spawnRoom(rooms[nid], depth);
}

// ── run lifecycle ────────────────────────────────────────────────────────────
function startRun() {
  _finished = false; depth = 1; runKills = 0; runScore = 0;
  player = makePlayer(); applyUnlocks(player);
  srand((Date.now() >>> 0) ^ 0x9e3779b9);
  genFloor(1); projectiles = []; floaters = []; state = 'play'; sfx('start');
}
function descend() {
  if (state !== 'play') return; state = 'descend'; descendT = 0.6; sfx('descend');
}
function nextFloor() { depth++; genFloor(depth); projectiles = []; floaters = []; player.x = W / 2; player.y = H / 2; state = 'play'; }
function die() { if (state === 'over') return; sfx('die'); state = 'over'; endRun(false); }

function endRun(won) {
  if (_finished) return; _finished = true;
  runScore = depth * 100 + runKills * 5;
  const mult = Math.min(4, 0.6 + depth * 0.25 + runKills * 0.02);
  if (window.aqGameXp) window.aqGameXp('combat', { played: true, won: depth >= 3, mult });
  runPayout = Math.round(Math.min(150, depth * 12 + runKills * 1.5));
  if (runPayout > 0 && window.aqAddCredits) window.aqAddCredits(runPayout);
  if (window.recordScore) window.recordScore('rogue', runScore, 'Reached F' + depth + ' · ' + runKills + ' kills');
  if (depth >= 6 && window.aqGameAnnounce) window.aqGameAnnounce('reached Floor ' + depth + ' in Neon Runner 🤖');
  persistProgress();
}
function persistProgress() {
  const best = bestDepth();
  if (depth > best) { try { localStorage.setItem('aq_rogue_depth', String(depth)); } catch (e) {} window.aqGamePersist && window.aqGamePersist('aq_rogue_depth'); }
  let u = {}; try { u = JSON.parse(localStorage.getItem('aq_rogue_unlocks') || '{}'); } catch (e) {}
  let ch = false;
  if (depth >= 3 && !u.perk_heart) { u.perk_heart = true; ch = true; }
  if (depth >= 6 && !u.perk_dashcd) { u.perk_dashcd = true; ch = true; }
  if (depth >= 9 && !u.perk_dmg) { u.perk_dmg = true; ch = true; }
  if (ch) { try { localStorage.setItem('aq_rogue_unlocks', JSON.stringify(u)); } catch (e) {} window.aqGamePersist && window.aqGamePersist('aq_rogue_unlocks'); }
}
function updateDescend(dt) { descendT -= dt; if (descendT <= 0) nextFloor(); }

// ── rendering ────────────────────────────────────────────────────────────────
function px(x, y, w, h, c) { cx.fillStyle = c; cx.fillRect(x | 0, y | 0, w, h); }
function draw() {
  if (!cx) return;
  cx.save();
  if (_shake > 0) cx.translate((rng() * 2 - 1) * 2, (rng() * 2 - 1) * 2);
  px(0, 0, W, H, BG);
  if (state === 'start') { drawStart(); cx.restore(); return; }
  const room = rooms[curRoomId];
  if (room) drawRoom(room);
  if (room) { for (const pk of room.pickups) drawPickup(pk); for (const en of room.enemies) drawEnemy(en); }
  for (const pr of projectiles) px(pr.x - 2, pr.y - 2, 4, 4, RED);
  if (player) drawPlayer();
  for (const f of floaters) px(f.x - 1, f.y - 1, 2, 2, f.col);
  drawHUD();
  if (state === 'descend') { px(0, 0, W, H, 'rgba(5,8,20,' + (1 - descendT / 0.6).toFixed(2) + ')'); text('DESCENDING…', W / 2, H / 2, CYAN, 'center'); }
  if (state === 'over') drawOver();
  cx.restore();
}
function drawRoom(room) {
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const t = room.tiles[y][x], X = x * TS, Y = y * TS;
    if (t === 1) { px(X, Y, TS, TS, WALL); px(X, Y, TS, 1, WALL_EDGE); px(X, Y, 1, TS, 'rgba(45,224,255,0.35)'); }
    else {
      px(X, Y, TS, TS, FLOOR); px(X + 1, Y + 1, 1, 1, GRID); px(X + TS - 2, Y + TS - 2, 1, 1, GRID);
      if (t === 4) { const on = exitActive(room); const c = on ? LIME : '#2a3a5a'; px(X + 2, Y + 2, TS - 4, TS - 4, '#06203a'); px(X + 4, Y + 4, TS - 8, TS - 8, c); if (on) px(X + TS / 2 - 1, Y + 3, 2, TS - 6, BG); }
      if (t === 2 || t === 3) { /* doorway floor */ }
    }
  }
  // locked-door markers on edges
  for (const dd in room.locked) { if (!room.locked[dd]) continue; const mc = COLS >> 1, mr = ROWS >> 1; let X = mc * TS, Y = mr * TS; if (dd === 'up') Y = 0; else if (dd === 'down') Y = (ROWS - 1) * TS; else if (dd === 'left') X = 0; else X = (COLS - 1) * TS; px(X + 3, Y + 3, TS - 6, TS - 6, AMBER); }
}
function drawPickup(pk) {
  if (pk.type === 'hp') drawHeart(pk.x - 3, pk.y - 3, 1);
  else if (pk.type === 'chip') px(pk.x - 3, pk.y - 3, 6, 6, AMBER);
  else if (pk.type === 'key') { px(pk.x - 1, pk.y - 3, 2, 6, AMBER); px(pk.x - 3, pk.y + 1, 6, 2, AMBER); }
  else if (pk.type === 'pow') { const c = pk.kind === 'dmg' ? RED : pk.kind === 'speed' ? CYAN : LIME; px(pk.x - 3, pk.y - 3, 6, 6, c); px(pk.x - 1, pk.y - 1, 2, 2, '#fff'); }
}
function drawEnemy(en) {
  const c = en.flash > 0 ? '#fff' : en.col, r = en.r;
  px(en.x - r, en.y - r, r * 2, r * 2, c);
  if (en.type === 'turret') px(en.x - 2, en.y - 2, 4, 4, '#3a0a12');
  else { px(en.x - r + 1, en.y - r + 1, 2, 2, BG); px(en.x + r - 3, en.y - r + 1, 2, 2, BG); }   // eyes
  if (en.type === 'boss') { px(en.x - r, en.y - r - 3, (r * 2) * (en.hp / en.maxHp), 2, LIME); }
}
function drawPlayer() {
  const p = player; if (p.iframes > 0 && (performance.now() / 80 | 0) % 2) return;   // blink
  px(p.x - 5, p.y - 5, 10, 10, LIME);
  const dv = DIRS[p.facing]; px(p.x - 2 + dv[0] * 3, p.y - 2 + dv[1] * 3, 4, 4, CYAN);   // visor in facing dir
  if (p.attackT > 0) { const hx = p.x + dv[0] * 12, hy = p.y + dv[1] * 12; px(hx - 5, hy - 5, 10, 10, 'rgba(45,224,255,0.85)'); }
}
function drawHeart(x, y, frac) {
  const pat = ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'];
  for (let r = 0; r < pat.length; r++) for (let c = 0; c < 7; c++) if (pat[r][c] === '1') { const filled = frac >= 1 || (c / 7) < frac; px(x + c, y + r, 1, 1, filled ? MAGENTA : '#3a2050'); }
}
function text(s, x, y, c, align, size) { cx.fillStyle = c; cx.font = (size || 8) + 'px monospace'; cx.textAlign = align || 'left'; cx.textBaseline = 'middle'; cx.fillText(s, x, y); }
function drawHUD() {
  if (!player) return;
  for (let i = 0; i < player.maxHp / 2; i++) { const full = player.hp >= (i + 1) * 2; const half = !full && player.hp >= i * 2 + 1; drawHeart(4 + i * 9, 3, full ? 1 : half ? 0.5 : 0); }
  text('F' + depth, W / 2, 6, CYAN, 'center');
  text((player.keycards ? '🔑' + player.keycards + ' ' : '') + (depth * 100 + runKills * 5), W - 3, 6, AMBER, 'right');
  // dash cd bar
  px(4, H - 6, 40, 3, '#1a2348'); px(4, H - 6, 40 * (1 - player.dashCd / player.dashCdMax), 3, player.dashCd > 0 ? '#2a6a8a' : CYAN);
}
function drawStart() {
  text('NEON://', W / 2, 44, MAGENTA, 'center', 14); text('RUNNER', W / 2, 60, CYAN, 'center', 14);
  text('best  F' + bestDepth(), W / 2, 84, LIME, 'center');
  text('D-pad / WASD : move', W / 2, 108, '#9fb0d8', 'center');
  text('A / J : slash    B / K : dash', W / 2, 120, '#9fb0d8', 'center');
  if ((performance.now() / 500 | 0) % 2) text('TAP / PRESS A TO START', W / 2, 142, AMBER, 'center');
}
function drawOver() {
  px(0, 0, W, H, 'rgba(5,8,20,0.78)');
  text('FLATLINED', W / 2, 50, RED, 'center', 14);
  text('Reached  F' + depth, W / 2, 76, CYAN, 'center');
  text(runKills + ' kills · ' + (depth * 100 + runKills * 5) + ' pts', W / 2, 90, '#9fb0d8', 'center');
  text('+' + runPayout + ' credits', W / 2, 106, AMBER, 'center');
  if ((performance.now() / 500 | 0) % 2) text('TAP / PRESS A : RUN AGAIN', W / 2, 134, LIME, 'center');
}

// ── loop ─────────────────────────────────────────────────────────────────────
function tick(t) {
  raf = requestAnimationFrame(tick);
  try {
    const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0; lastT = t;
    if (state === 'play') update(dt); else if (state === 'descend') updateDescend(dt);
    draw();
  } catch (e) { try { console.warn && console.warn('rogue', e); } catch (_) {} }
}

// ── input wiring ─────────────────────────────────────────────────────────────
function rogueHasKeys() {
  const w = document.getElementById('rogue-wrap');
  if (!w || !w.classList.contains('open')) return false;
  if (!(window.OS && window.OS._activeId === 'rogue')) return false;
  const a = document.activeElement; if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return false;
  return true;
}
function clearInputs() { held.up = held.down = held.left = held.right = false; pointers.clear(); }
function wirePad() {
  const onDown = e => {
    const btn = e.target.closest('[data-dir],[data-act]'); if (!btn) return;
    e.preventDefault(); try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    if (state === 'start' || state === 'over') { if (btn.dataset.act === 'A') startRun(); pointers.set(e.pointerId, {}); return; }
    if (btn.dataset.dir) { held[btn.dataset.dir] = true; pointers.set(e.pointerId, { dir: btn.dataset.dir }); }
    else if (btn.dataset.act === 'A') { doAttack(); pointers.set(e.pointerId, {}); }
    else if (btn.dataset.act === 'B') { doDash(); pointers.set(e.pointerId, {}); }
  };
  const onUp = e => { const p = pointers.get(e.pointerId); if (!p) return; if (p.dir) held[p.dir] = false; pointers.delete(e.pointerId); };
  _pad.addEventListener('pointerdown', onDown, { passive: false });
  _pad.addEventListener('pointerup', onUp); _pad.addEventListener('pointercancel', onUp); _pad.addEventListener('lostpointercapture', onUp);
  // iOS fires its own long-press selection/magnify on touchstart regardless of pointer
  // events — preventing it here (plus the user-select CSS) kills the text-select box.
  _pad.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  _pad.addEventListener('contextmenu', e => e.preventDefault());
}
function bindKeys() {
  if (_keyHandler) return;
  _keyHandler = e => {
    if (!rogueHasKeys()) return; const k = e.key;
    if (e.type === 'keydown') {
      if (state === 'start' || state === 'over') { if (k === ' ' || k === 'Enter' || k === 'j' || k === 'J') { startRun(); e.preventDefault(); } return; }
      let used = true;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = true;
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = true;
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') held.up = true;
      else if (k === 'ArrowDown' || k === 's' || k === 'S') held.down = true;
      else if (k === 'j' || k === 'J' || k === ' ') doAttack();
      else if (k === 'k' || k === 'K') doDash();
      else used = false;
      if (used) e.preventDefault();
    } else {
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = false;
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = false;
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') held.up = false;
      else if (k === 'ArrowDown' || k === 's' || k === 'S') held.down = false;
    }
  };
  document.addEventListener('keydown', _keyHandler); document.addEventListener('keyup', _keyHandler);
}

function build() {
  const area = document.getElementById('rogue-area'); if (!area) return;
  area.innerHTML = '';
  cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.className = 'rogue-canvas';
  area.appendChild(cv); cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
  _pad = document.createElement('div'); _pad.className = 'rogue-pad';
  _pad.innerHTML =
    '<div class="rogue-dpad">'
    + '<button class="rogue-dbtn ru" data-dir="up">▲</button>'
    + '<button class="rogue-dbtn rl" data-dir="left">◀</button>'
    + '<button class="rogue-dbtn rr" data-dir="right">▶</button>'
    + '<button class="rogue-dbtn rd" data-dir="down">▼</button></div>'
    + '<div class="rogue-ab">'
    + '<button class="rogue-abtn b" data-act="B">B</button>'
    + '<button class="rogue-abtn a" data-act="A">A</button></div>';
  area.appendChild(_pad); wirePad();
  cv.addEventListener('pointerdown', e => { e.preventDefault(); if (state === 'start' || state === 'over') startRun(); }, { passive: false });
  bindKeys(); _built = true;
}

function openRogue(show = true) {
  const w = document.getElementById('rogue-wrap'); if (!w) return;
  if (show === false) {
    if (state === 'play' || state === 'descend') { state = 'over'; endRun(false); }
    w.classList.remove('open'); w.style.display = 'none';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    clearInputs(); return;
  }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('rogue'); window.OS.focus('rogue'); }
  if (!_built) build();
  if (state === 'over') state = 'start';
  clearInputs(); lastT = 0;
  if (!raf) raf = requestAnimationFrame(tick);
}

if (typeof window !== 'undefined') { window.openRogue = openRogue; }
