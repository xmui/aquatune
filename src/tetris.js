// Aquatune Tetris — NES-style falling blocks.
//
// Faithful-ish to NES Tetris: a 10×20 well, 7-bag spawns, gravity that speeds up
// every 10 lines on a frame-based table, simple clockwise rotation with a small
// wall kick, soft drop (+1/cell) and a hard drop for convenience. Line clears
// score 40/100/300/1200 ×(level+1) and grant Speed XP; the run posts to the
// leaderboard. Keyboard drives it on desktop; an on-screen pad appears on mobile.

const COLS = 10, ROWS = 20, CELL = 24;     // logical board 240×480 (CSS-scaled)
const PREV = 4;                            // next-preview box (cells)

// NES-ish block tones with light/dark bevels (index 1..7).
const COLORS = [
  null,
  { c: '#16d7d7', hi: '#b6ffff', lo: '#0a8a8a' }, // 1 I cyan
  { c: '#ffd21e', hi: '#fff3a8', lo: '#b08c00' }, // 2 O yellow
  { c: '#b34ee6', hi: '#ecc0ff', lo: '#6e2a92' }, // 3 T purple
  { c: '#3cd83f', hi: '#bcffbd', lo: '#1d8a20' }, // 4 S green
  { c: '#ff3d3d', hi: '#ffbdbd', lo: '#a01f1f' }, // 5 Z red
  { c: '#3f73ff', hi: '#c0d2ff', lo: '#1f3aa8' }, // 6 J blue
  { c: '#ff9a2b', hi: '#ffd8ab', lo: '#b06317' }, // 7 L orange
];

// Piece cell layouts within their rotation box, and box size.
const PIECES = {
  I: { color: 1, box: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { color: 2, box: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { color: 3, box: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { color: 4, box: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { color: 5, box: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { color: 6, box: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { color: 7, box: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};
const TYPES = Object.keys(PIECES);
const LINE_PTS = [0, 40, 100, 300, 1200];  // ×(level+1) — classic scoring

// NES gravity: frames-per-cell by level (60fps). We convert to ms per drop.
const GRAVITY_FRAMES = [48, 43, 38, 33, 28, 23, 18, 13, 8, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 2];
function dropMsFor(lvl) { const f = lvl < GRAVITY_FRAMES.length ? GRAVITY_FRAMES[lvl] : (lvl < 29 ? 2 : 1); return f * (1000 / 60); }

let cv = null, cx = null, nextCv = null, nextCx = null, raf = null, _built = false;
let board = [], cur = null, nextType = null, bag = [];
let score = 0, lines = 0, level = 0, dropMs = dropMsFor(0), dropAcc = 0, _lastT = 0;
let state = 'start';                        // start | play | over
let infoEl = null, overlayEl = null, padEl = null;
let _keyHandler = null;
// DAS (delayed auto-shift) for held left/right.
let dasDir = 0, dasTimer = 0;
const DAS_DELAY = 160, DAS_REPEAT = 50;

function sfx(n) { try { window.tetrisSfx && window.tetrisSfx(n); } catch (e) {} }

function newBoard() { board = Array.from({ length: ROWS }, () => Array(COLS).fill(0)); }
function bagNext() {
  if (!bag.length) { bag = TYPES.slice(); for (let i = bag.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[bag[i], bag[j]] = [bag[j], bag[i]]; } }
  return bag.pop();
}
function makeMatrix(type) {
  const p = PIECES[type], n = p.box, m = Array.from({ length: n }, () => Array(n).fill(0));
  for (const [x, y] of p.cells) m[y][x] = p.color;
  return m;
}
function rotateCW(m) { const n = m.length, r = Array.from({ length: n }, () => Array(n).fill(0)); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) r[x][n - 1 - y] = m[y][x]; return r; }

function spawn() {
  const type = nextType || bagNext();
  nextType = bagNext();
  const m = makeMatrix(type);
  cur = { type, m, x: ((COLS - m.length) / 2) | 0, y: type === 'I' ? -1 : 0 };
  dropAcc = 0; dasDir = 0;
  if (collides(cur.m, cur.x, cur.y)) { cur = null; gameOver(); return; }
  drawNext();
}
function collides(m, ox, oy) {
  for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) {
    if (!m[y][x]) continue;
    const bx = ox + x, by = oy + y;
    if (bx < 0 || bx >= COLS || by >= ROWS) return true;
    if (by >= 0 && board[by][bx]) return true;
  }
  return false;
}
function lockPiece() {
  for (let y = 0; y < cur.m.length; y++) for (let x = 0; x < cur.m.length; x++) {
    if (cur.m[y][x] && cur.y + y >= 0) board[cur.y + y][cur.x + x] = cur.m[y][x];
  }
  sfx('lock');
  clearLines();
  if (state === 'play') spawn();
}
function clearLines() {
  let cleared = 0;
  for (let y = ROWS - 1; y >= 0; y--) {
    if (board[y].every(v => v)) { board.splice(y, 1); board.unshift(Array(COLS).fill(0)); cleared++; y++; }
  }
  if (!cleared) return;
  score += LINE_PTS[cleared] * (level + 1);
  lines += cleared;
  const newLevel = Math.floor(lines / 10);
  if (newLevel > level) { level = newLevel; dropMs = dropMsFor(level); sfx('level'); }
  sfx(cleared >= 4 ? 'tetris' : 'clear');
  // Speed XP per clear (a small grindy trickle, bigger for multi-line clears).
  if (window.aqGameXp) window.aqGameXp('speed', { played: false, won: true, mult: 0.3 * cleared * cleared });
  updateInfo();
}

function move(dx) { if (state !== 'play' || !cur) return false; if (!collides(cur.m, cur.x + dx, cur.y)) { cur.x += dx; sfx('move'); return true; } return false; }
function rotate() {
  if (state !== 'play' || !cur) return;
  const r = rotateCW(cur.m);
  for (const k of [0, -1, 1, -2, 2]) { if (!collides(r, cur.x + k, cur.y)) { cur.m = r; cur.x += k; sfx('rotate'); return; } }
}
function softDrop() {
  if (state !== 'play' || !cur) return;
  if (!collides(cur.m, cur.x, cur.y + 1)) { cur.y++; score += 1; updateInfo(); }
  else lockPiece();
  dropAcc = 0;
}
function hardDrop() {
  if (state !== 'play' || !cur) return;
  let d = 0; while (!collides(cur.m, cur.x, cur.y + 1)) { cur.y++; d++; }
  score += d * 2; sfx('drop'); updateInfo(); lockPiece(); dropAcc = 0;
}
function ghostY() { let gy = cur.y; while (!collides(cur.m, cur.x, gy + 1)) gy++; return gy; }

function gameOver() {
  state = 'over';
  if (window.recordScore) window.recordScore('tetris', score, 'Lv' + (level + 1) + ' · ' + lines + ' lines');
  if (window.aqGameXp) window.aqGameXp('speed', { played: true, won: lines >= 10, mult: Math.min(4, 1 + lines * 0.12) });
  sfx('over');
  showOverlay('Game Over', 'Score ' + score.toLocaleString() + ' · ' + lines + ' lines · Lv ' + (level + 1), 'Play again', startGame);
}

// ── rendering ────────────────────────────────────────────────────────────────
function cell(g, px, py, ci, sz) {
  const col = COLORS[ci]; sz = sz || CELL;
  g.fillStyle = col.c; g.fillRect(px, py, sz, sz);
  g.fillStyle = col.hi; g.fillRect(px, py, sz, 3); g.fillRect(px, py, 3, sz);        // top/left bevel
  g.fillStyle = col.lo; g.fillRect(px, py + sz - 3, sz, 3); g.fillRect(px + sz - 3, py, 3, sz); // bottom/right
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1; g.strokeRect(px + 0.5, py + 0.5, sz - 1, sz - 1);
}
function draw() {
  if (!cx) return;
  cx.fillStyle = '#0a1230'; cx.fillRect(0, 0, COLS * CELL, ROWS * CELL);
  cx.strokeStyle = 'rgba(120,150,255,0.08)';
  for (let x = 0; x <= COLS; x++) { cx.beginPath(); cx.moveTo(x * CELL, 0); cx.lineTo(x * CELL, ROWS * CELL); cx.stroke(); }
  for (let y = 0; y <= ROWS; y++) { cx.beginPath(); cx.moveTo(0, y * CELL); cx.lineTo(COLS * CELL, y * CELL); cx.stroke(); }
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (board[y][x]) cell(cx, x * CELL, y * CELL, board[y][x]);
  if (cur && state === 'play') {
    const gy = ghostY();
    cx.globalAlpha = 0.22;
    for (let y = 0; y < cur.m.length; y++) for (let x = 0; x < cur.m.length; x++) if (cur.m[y][x] && gy + y >= 0) cell(cx, (cur.x + x) * CELL, (gy + y) * CELL, cur.m[y][x]);
    cx.globalAlpha = 1;
    for (let y = 0; y < cur.m.length; y++) for (let x = 0; x < cur.m.length; x++) if (cur.m[y][x] && cur.y + y >= 0) cell(cx, (cur.x + x) * CELL, (cur.y + y) * CELL, cur.m[y][x]);
  }
}
function drawNext() {
  if (!nextCx) return;
  nextCx.fillStyle = '#0a1230'; nextCx.fillRect(0, 0, PREV * CELL, PREV * CELL);
  if (!nextType) return;
  const m = makeMatrix(nextType), n = m.length, sz = CELL * 0.8;
  const ox = (PREV * CELL - n * sz) / 2, oy = (PREV * CELL - n * sz) / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) cell(nextCx, ox + x * sz, oy + y * sz, m[y][x], sz);
}
function updateInfo() { if (infoEl) infoEl.innerHTML = `<div class="tt-stat"><span>SCORE</span><b>${score.toLocaleString()}</b></div><div class="tt-stat"><span>LINES</span><b>${lines}</b></div><div class="tt-stat"><span>LEVEL</span><b>${level + 1}</b></div>`; }

function tick(t) {
  const dt = Math.min(100, t - (_lastT || t)); _lastT = t;
  if (state === 'play' && cur) {
    // DAS auto-shift for a held direction.
    if (dasDir) { dasTimer -= dt; if (dasTimer <= 0) { if (!move(dasDir)) dasDir = 0; dasTimer = DAS_REPEAT; } }
    // gravity
    dropAcc += dt;
    if (dropAcc >= dropMs) { dropAcc -= dropMs; if (!collides(cur.m, cur.x, cur.y + 1)) cur.y++; else lockPiece(); }
  }
  draw();
  raf = requestAnimationFrame(tick);
}

function showOverlay(title, sub, btn, fn) {
  if (!overlayEl) return;
  overlayEl.innerHTML = `<div class="tt-ov-title">${title}</div><div class="tt-ov-sub">${sub}</div><button class="tt-btn">${btn}</button>`;
  overlayEl.querySelector('.tt-btn').onclick = fn;
  overlayEl.style.display = 'flex';
}
function hideOverlay() { if (overlayEl) overlayEl.style.display = 'none'; }

function startGame() {
  newBoard(); bag = []; nextType = null; cur = null;
  score = 0; lines = 0; level = 0; dropMs = dropMsFor(0); dropAcc = 0; dasDir = 0;
  state = 'play'; hideOverlay(); updateInfo(); spawn(); draw();
}

function build() {
  const area = document.getElementById('tetris-area');
  if (!area) return;
  area.innerHTML = '';
  const main = document.createElement('div'); main.className = 'tt-main';

  const boardWrap = document.createElement('div'); boardWrap.className = 'tt-board-wrap';
  cv = document.createElement('canvas'); cv.width = COLS * CELL; cv.height = ROWS * CELL; cv.className = 'tt-board';
  boardWrap.appendChild(cv);
  overlayEl = document.createElement('div'); overlayEl.className = 'tt-overlay'; boardWrap.appendChild(overlayEl);
  main.appendChild(boardWrap);

  const side = document.createElement('div'); side.className = 'tt-side';
  const nlabel = document.createElement('div'); nlabel.className = 'tt-nlabel'; nlabel.textContent = 'NEXT';
  nextCv = document.createElement('canvas'); nextCv.width = PREV * CELL; nextCv.height = PREV * CELL; nextCv.className = 'tt-next';
  infoEl = document.createElement('div'); infoEl.className = 'tt-info';
  side.appendChild(nlabel); side.appendChild(nextCv); side.appendChild(infoEl);
  main.appendChild(side);
  area.appendChild(main);

  // On-screen controls — CSS hides these on desktop (keyboard there); shown on mobile.
  padEl = document.createElement('div'); padEl.className = 'tt-pad';
  const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'tt-key'; b.textContent = label; b.addEventListener('pointerdown', e => { e.preventDefault(); fn(); }); return b; };
  padEl.appendChild(mk('◀', () => move(-1)));
  padEl.appendChild(mk('⟳', rotate));
  padEl.appendChild(mk('▶', () => move(1)));
  padEl.appendChild(mk('▼', softDrop));
  padEl.appendChild(mk('⬇', hardDrop));
  area.appendChild(padEl);

  cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
  nextCx = nextCv.getContext('2d'); nextCx.imageSmoothingEnabled = false;

  // Only steal the keyboard while Tetris is the OPEN, FOCUSED window and the user
  // isn't typing in a field — otherwise keys would leak into other apps (e.g. the
  // spacebar pausing a song) while Tetris sits open in the background.
  const tetrisHasKeys = () => {
    const w = document.getElementById('tetris-wrap');
    if (!w || !w.classList.contains('open')) return false;
    if (!(window.OS && window.OS._activeId === 'tetris')) return false;
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return false;
    return true;
  };
  _keyHandler = (e) => {
    if (!tetrisHasKeys()) return;
    if (e.repeat && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); return; } // DAS handles repeat
    let used = true;
    if (e.key === 'ArrowLeft') { if (move(-1)) { dasDir = -1; dasTimer = DAS_DELAY; } }
    else if (e.key === 'ArrowRight') { if (move(1)) { dasDir = 1; dasTimer = DAS_DELAY; } }
    else if (e.key === 'ArrowUp' || e.key === 'x' || e.key === 'X') rotate();
    else if (e.key === 'ArrowDown') softDrop();
    else if (e.key === ' ' || e.key === 'Spacebar') hardDrop();
    else used = false;
    if (used) e.preventDefault();
  };
  const _keyUp = (e) => {
    if (!tetrisHasKeys()) { dasDir = 0; return; }
    if ((e.key === 'ArrowLeft' && dasDir === -1) || (e.key === 'ArrowRight' && dasDir === 1)) dasDir = 0;
  };
  document.addEventListener('keydown', _keyHandler);
  document.addEventListener('keyup', _keyUp);
  _built = true;
}

function openTetris(show = true) {
  const w = document.getElementById('tetris-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; dasDir = 0; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('tetris'); window.OS.focus('tetris'); }
  if (!_built) build();
  if (state !== 'play') showOverlay('🧱 Tetris', 'Clear lines to score. Faster every 10 lines.', 'Start', startGame);
  updateInfo();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') { window.openTetris = openTetris; }
