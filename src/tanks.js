// Aquatune Tank Battle — a Wii-Play-style top-down tank arena. Drive your tank
// (joystick on mobile, WASD/arrows on desktop), aim with the mouse or auto-lock to
// the nearest foe, and fire shells that BANK off the walls. Clear waves of enemy
// tanks; you get 3 lives. Grants Combat XP.

const AW = 360, AH = 360;
const TANK_R = 11, BULLET_R = 3.2;
const BULLET_SPEED = 3.4, BULLET_BOUNCES = 2, BULLET_LIFE = 4000;
const FIRE_CD = 360, MAX_SHOTS = 5;
const LIVES = 3, INVULN_MS = 1600;

let cv = null, cx = null, raf = null, _built = false, _pad = null;
let state = 'start';        // start | play | over
let walls = [], player = null, enemies = [], bullets = [];
let wave = 0, score = 0, lives = 0;
let held = { up: false, down: false, left: false, right: false };
let pointers = new Map();
let mouseAim = null, _waveAt = 0, _last = 0;
let _keyHandler = null;

function sfx(n) { try { window.tanksSfx && window.tanksSfx(n); } catch (e) {} }
function rnd(a, b) { return a + Math.random() * (b - a); }

// ── arena ───────────────────────────────────────────────────────────────────
function buildArena() {
  // a fixed set of interior blocks the shells bank off of
  walls = [
    { x: 70, y: 80, w: 50, h: 16 }, { x: 240, y: 80, w: 50, h: 16 },
    { x: 168, y: 60, w: 16, h: 70 },
    { x: 70, y: 264, w: 50, h: 16 }, { x: 240, y: 264, w: 50, h: 16 },
    { x: 168, y: 230, w: 16, h: 70 },
    { x: 40, y: 168, w: 70, h: 16 }, { x: 250, y: 168, w: 70, h: 16 },
  ];
}
// circle-vs-rect: push the circle out; optionally reflect its velocity (for shells)
function circleRect(o, r, bounce) {
  const cxp = Math.max(r.x, Math.min(o.x, r.x + r.w));
  const cyp = Math.max(r.y, Math.min(o.y, r.y + r.h));
  let dx = o.x - cxp, dy = o.y - cyp, d = Math.hypot(dx, dy);
  if (d >= o.r) return false;
  if (d === 0) { dx = 0; dy = -1; d = 1; }   // dead-centre fallback
  const nx = dx / d, ny = dy / d;
  o.x = cxp + nx * o.r; o.y = cyp + ny * o.r;
  if (bounce) { const dot = o.vx * nx + o.vy * ny; o.vx -= 2 * dot * nx; o.vy -= 2 * dot * ny; }
  return true;
}
function blocked(x, y, r) {
  if (x < r || x > AW - r || y < r || y > AH - r) return true;
  for (const w of walls) { const cxp = Math.max(w.x, Math.min(x, w.x + w.w)), cyp = Math.max(w.y, Math.min(y, w.y + w.h)); if (Math.hypot(x - cxp, y - cyp) < r) return true; }
  return false;
}
function freeSpot(awayFrom, minDist) {
  for (let i = 0; i < 80; i++) {
    const x = rnd(TANK_R + 6, AW - TANK_R - 6), y = rnd(TANK_R + 6, AH - TANK_R - 6);
    if (blocked(x, y, TANK_R + 3)) continue;
    if (awayFrom && Math.hypot(x - awayFrom.x, y - awayFrom.y) < minDist) continue;
    return { x, y };
  }
  return { x: AW / 2, y: AH / 2 };
}

// ── entities ────────────────────────────────────────────────────────────────
function makeEnemy(kind) {
  const s = freeSpot(player, 130);
  const spd = kind === 'fast' ? 0.9 : 0.5;
  return { x: s.x, y: s.y, r: TANK_R, aim: rnd(0, 6.28), vx: 0, vy: 0, kind, speed: spd,
    fireCd: rnd(700, 1500), wanderCd: 0, wx: 0, wy: 0, flash: 0 };
}
function nextWave() {
  wave++;
  const n = Math.min(7, 1 + wave);
  enemies = [];
  for (let i = 0; i < n; i++) enemies.push(makeEnemy(wave >= 3 && i % 2 === 0 ? 'fast' : 'slow'));
  _waveAt = 0;
}
function startGame() {
  buildArena();
  player = { x: AW / 2, y: AH - 40, r: TANK_R, aim: -Math.PI / 2, vx: 0, vy: 0, fireCd: 0, invuln: 0, flash: 0 };
  bullets = []; wave = 0; score = 0; lives = LIVES; state = 'play'; mouseAim = null;
  nextWave(); sfx('start');
}

function fire(tank, ang, fromEnemy) {
  bullets.push({ x: tank.x + Math.cos(ang) * (tank.r + 5), y: tank.y + Math.sin(ang) * (tank.r + 5),
    vx: Math.cos(ang) * BULLET_SPEED, vy: Math.sin(ang) * BULLET_SPEED, r: BULLET_R,
    bounces: BULLET_BOUNCES, life: BULLET_LIFE, enemy: !!fromEnemy });
  sfx('fire');
}
function nearestEnemy() {
  let best = null, bd = 1e9;
  for (const e of enemies) { const d = Math.hypot(e.x - player.x, e.y - player.y); if (d < bd) { bd = d; best = e; } }
  return best;
}

function hurtPlayer() {
  if (player.invuln > 0) return;
  lives--; player.flash = 1; player.invuln = INVULN_MS; sfx('boom');
  const s = freeSpot(null, 0); player.x = s.x; player.y = s.y; player.vx = player.vy = 0;
  if (lives <= 0) endGame();
}
function killEnemy(e) {
  e.dead = true; score += 100; e.flash = 1; sfx('boom');
  if (enemies.filter(x => !x.dead).length === 0 && state === 'play') _waveAt = performance.now() + 1200;
}

function endGame() {
  state = 'over';
  sfx('lose');
  if (typeof window.aqAddXp === 'function') window.aqAddXp('combat', Math.round(Math.min(600, 40 + wave * 45 + score * 0.04)));
  if (typeof window.aqAddCredits === 'function') { const c = Math.round(Math.min(160, wave * 12 + score * 0.03)); if (c > 0) window.aqAddCredits(c); }
  if (typeof window.recordScore === 'function') window.recordScore('tanks', score, 'wave ' + wave);
}

// ── update ──────────────────────────────────────────────────────────────────
function moveTank(t, dx, dy) {
  if (dx) { if (!blocked(t.x + dx, t.y, t.r)) t.x += dx; }
  if (dy) { if (!blocked(t.x, t.y + dy, t.r)) t.y += dy; }
}
function update(dt) {
  const now = performance.now();
  if (_waveAt && now >= _waveAt) { nextWave(); }
  // player movement
  let mx = (held.right ? 1 : 0) - (held.left ? 1 : 0), my = (held.down ? 1 : 0) - (held.up ? 1 : 0);
  if (mx || my) { const m = Math.hypot(mx, my); mx /= m; my /= m; moveTank(player, mx * 2.1, my * 2.1); if (!mouseAim) player.aim = Math.atan2(my, mx); }
  // aim: mouse if present, else auto-lock the nearest enemy
  if (mouseAim) player.aim = Math.atan2(mouseAim.y - player.y, mouseAim.x - player.x);
  else { const ne = nearestEnemy(); if (ne) player.aim = Math.atan2(ne.y - player.y, ne.x - player.x); }
  player.fireCd = Math.max(0, player.fireCd - dt);
  player.invuln = Math.max(0, player.invuln - dt);
  player.flash = Math.max(0, player.flash - dt / 200);

  // enemies
  for (const e of enemies) {
    if (e.dead) continue;
    e.flash = Math.max(0, e.flash - dt / 200);
    e.wanderCd -= dt;
    if (e.wanderCd <= 0) { const a = Math.atan2(player.y - e.y, player.x - e.x) + rnd(-1, 1); e.wx = Math.cos(a); e.wy = Math.sin(a); e.wanderCd = rnd(500, 1200); }
    moveTank(e, e.wx * e.speed * dt / 16, e.wy * e.speed * dt / 16);
    e.aim = Math.atan2(player.y - e.y, player.x - e.x);
    e.fireCd -= dt;
    if (e.fireCd <= 0) { e.fireCd = rnd(1100, 2200); fire(e, e.aim + rnd(-0.12, 0.12), true); }
  }
  enemies = enemies.filter(e => !e.dead);

  // bullets
  for (const b of bullets) {
    b.life -= dt;
    let nx = b.x + b.vx * dt / 8, ny = b.y + b.vy * dt / 8;
    b.x = nx; b.y = ny;
    // arena walls
    if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); b.bounces--; sfx('bounce'); }
    if (b.x > AW - b.r) { b.x = AW - b.r; b.vx = -Math.abs(b.vx); b.bounces--; sfx('bounce'); }
    if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); b.bounces--; sfx('bounce'); }
    if (b.y > AH - b.r) { b.y = AH - b.r; b.vy = -Math.abs(b.vy); b.bounces--; sfx('bounce'); }
    for (const w of walls) if (circleRect(b, w, true)) { b.bounces--; sfx('bounce'); break; }
    if (b.bounces < 0 || b.life <= 0) { b.dead = true; continue; }
    // hits
    if (b.enemy) { if (player.invuln <= 0 && Math.hypot(b.x - player.x, b.y - player.y) < player.r + b.r) { b.dead = true; hurtPlayer(); } }
    else { for (const e of enemies) { if (Math.hypot(b.x - e.x, b.y - e.y) < e.r + b.r) { b.dead = true; killEnemy(e); break; } } }
  }
  bullets = bullets.filter(b => !b.dead);
}

function doFire() {
  if (state !== 'play' || player.fireCd > 0) return;
  if (bullets.filter(b => !b.enemy).length >= MAX_SHOTS) return;
  player.fireCd = FIRE_CD; fire(player, player.aim, false);
}

// ── render ──────────────────────────────────────────────────────────────────
function tankSprite(t, body, tread, barrel) {
  cx.save(); cx.translate(t.x, t.y);
  cx.fillStyle = tread; cx.fillRect(-t.r, -t.r, t.r * 2, t.r * 2);     // tread block
  cx.fillStyle = t.flash > 0.4 ? '#fff' : body;
  cx.beginPath(); cx.arc(0, 0, t.r - 2, 0, 6.2832); cx.fill();          // turret
  cx.rotate(t.aim);
  cx.fillStyle = barrel; cx.fillRect(0, -2.5, t.r + 8, 5);              // barrel
  cx.restore();
}
function draw() {
  if (!cx) return;
  cx.clearRect(0, 0, AW, AH);
  cx.fillStyle = 'rgba(255,255,255,0.05)'; cx.fillRect(0, 0, AW, AH);
  for (const w of walls) { cx.fillStyle = '#6b7a3a'; cx.fillRect(w.x, w.y, w.w, w.h); cx.fillStyle = 'rgba(0,0,0,0.25)'; cx.fillRect(w.x, w.y + w.h - 3, w.w, 3); }
  for (const b of bullets) { cx.beginPath(); cx.arc(b.x, b.y, b.r, 0, 6.2832); cx.fillStyle = b.enemy ? '#ff8a5a' : '#ffe27a'; cx.fill(); }
  for (const e of enemies) tankSprite(e, e.kind === 'fast' ? '#e85a5a' : '#c98a3a', '#5a2a2a', '#3a1010');
  if (player && (player.invuln <= 0 || Math.floor(performance.now() / 120) % 2 === 0)) tankSprite(player, '#5ad17a', '#2a5a3a', '#0a3a1a');
  // HUD
  cx.fillStyle = '#e8f4ff'; cx.font = 'bold 13px system-ui,Arial'; cx.textAlign = 'left';
  cx.fillText('Wave ' + Math.max(1, wave) + '   ' + '❤'.repeat(Math.max(0, lives)), 8, 16);
  cx.textAlign = 'right'; cx.fillText('Score ' + score, AW - 8, 16); cx.textAlign = 'left';
  if (state !== 'play') {
    cx.fillStyle = 'rgba(8,12,6,0.74)'; cx.fillRect(0, 0, AW, AH);
    cx.fillStyle = '#fff'; cx.textAlign = 'center'; cx.font = 'bold 28px system-ui,Arial';
    cx.fillText(state === 'over' ? 'GAME OVER' : '🐢 Tank Battle', AW / 2, AH / 2 - 16);
    cx.font = '15px system-ui,Arial'; cx.fillStyle = '#cfe8a0';
    cx.fillText(state === 'over' ? 'Score ' + score + ' · tap to retry' : 'Tap / Space to start', AW / 2, AH / 2 + 14);
    cx.font = '12px system-ui,Arial'; cx.fillStyle = 'rgba(255,255,255,0.6)';
    cx.fillText('Move + auto-aim · shells bank off walls', AW / 2, AH / 2 + 40);
    cx.textAlign = 'left';
  }
}

function tick(t) {
  if (!raf) return;
  const dt = Math.min(40, t - (_last || t)); _last = t;
  if (state === 'play') update(dt);
  draw();
  raf = requestAnimationFrame(tick);
}

// ── input ───────────────────────────────────────────────────────────────────
function tanksHasKeys() {
  const w = document.getElementById('tanks-wrap');
  if (!w || !w.classList.contains('open')) return false;
  if (!(window.OS && window.OS._activeId === 'tanks')) return false;
  const a = document.activeElement; if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return false;
  return true;
}
function bindKeys() {
  if (_keyHandler) return;
  _keyHandler = e => {
    if (!tanksHasKeys()) return; const k = e.key;
    if (e.type === 'keydown') {
      if (state !== 'play') { if (k === ' ' || k === 'Enter') { startGame(); e.preventDefault(); } return; }
      let used = true;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = true;
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = true;
      else if (k === 'ArrowUp' || k === 'w' || k === 'W') held.up = true;
      else if (k === 'ArrowDown' || k === 's' || k === 'S') held.down = true;
      else if (k === ' ') doFire();
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
function wirePad() {
  const stick = _pad.querySelector('[data-stick]'), knob = stick && stick.querySelector('.arc-knob');
  const setVec = (dx, dy) => {
    const R = (stick ? stick.clientWidth : 96) / 2, mag = Math.hypot(dx, dy);
    if (mag > R) { dx = dx / mag * R; dy = dy / mag * R; }
    if (knob) knob.style.transform = `translate(${dx}px,${dy}px)`;
    const dead = R * 0.34;
    held.left = dx < -dead; held.right = dx > dead; held.up = dy < -dead; held.down = dy > dead;
  };
  const recenter = () => { if (knob) knob.style.transform = 'translate(0,0)'; held.up = held.down = held.left = held.right = false; };
  const onDown = e => {
    const st = e.target.closest('[data-stick]'), fb = e.target.closest('[data-fire]');
    if (!st && !fb) return; e.preventDefault();
    if (st) { const r = st.getBoundingClientRect(); try { st.setPointerCapture(e.pointerId); } catch (_) {} pointers.set(e.pointerId, { stick: true, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }); if (state === 'play') setVec(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)); return; }
    try { fb.setPointerCapture(e.pointerId); } catch (_) {}
    if (state !== 'play') startGame(); else doFire();
    pointers.set(e.pointerId, {});
  };
  const onMove = e => { const p = pointers.get(e.pointerId); if (!p || !p.stick) return; e.preventDefault(); setVec(e.clientX - p.cx, e.clientY - p.cy); };
  const onUp = e => { const p = pointers.get(e.pointerId); if (!p) return; if (p.stick) recenter(); pointers.delete(e.pointerId); };
  _pad.addEventListener('pointerdown', onDown, { passive: false });
  _pad.addEventListener('pointermove', onMove, { passive: false });
  _pad.addEventListener('pointerup', onUp); _pad.addEventListener('pointercancel', onUp); _pad.addEventListener('lostpointercapture', onUp);
  _pad.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  _pad.addEventListener('contextmenu', e => e.preventDefault());
}
function build() {
  const area = document.getElementById('tanks-area'); if (!area) return;
  area.innerHTML = '';
  cv = document.createElement('canvas'); cv.width = AW; cv.height = AH; cv.className = 'arc-canvas';
  area.appendChild(cv); cx = cv.getContext('2d');
  _pad = document.createElement('div'); _pad.className = 'arc-pad';
  _pad.innerHTML = '<div class="arc-stick" data-stick><div class="arc-knob"></div></div><button class="arc-fire" data-fire>FIRE</button>';
  area.appendChild(_pad); wirePad();
  // desktop: mouse aims the turret, click fires; tap also starts/retries
  cv.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && state === 'play') { const r = cv.getBoundingClientRect(); mouseAim = { x: (e.clientX - r.left) * (AW / r.width), y: (e.clientY - r.top) * (AH / r.height) }; } });
  cv.addEventListener('pointerdown', e => { e.preventDefault(); if (state !== 'play') { startGame(); return; } if (e.pointerType === 'mouse') doFire(); }, { passive: false });
  bindKeys(); _built = true;
}

function openTanks(show = true) {
  const w = document.getElementById('tanks-wrap'); if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; held = { up: false, down: false, left: false, right: false }; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('tanks'); window.OS.focus('tanks'); }
  if (!_built) build();
  if (state === 'play') state = 'start';
  if (!raf) { _last = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') window.openTanks = openTanks;
