// Aquatune Tetris — NES-style falling blocks with mouse controls.
//
// A 10×20 well, 7-bag spawns, NES gravity that speeds up every 10 lines, simple
// clockwise rotation with a small wall kick. Line clears score 40/100/300/1200
// ×(level+1) and grant Speed XP; the run posts to the leaderboard.
//
// Controls (desktop): MOVE THE MOUSE left/right over the board to slide the piece,
// LEFT-CLICK to hard-drop, RIGHT-CLICK or SCROLL to rotate. Keyboard still works
// when the window is focused. Mobile gets the on-screen pad.

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

// NES gravity: frames-per-cell by level (60fps) → ms per drop.
const GRAVITY_FRAMES = [48, 43, 38, 33, 28, 23, 18, 13, 8, 6, 5, 5, 5, 4, 4, 4, 3, 3, 3, 2];
function dropMsFor(lvl) { const f = lvl < GRAVITY_FRAMES.length ? GRAVITY_FRAMES[lvl] : (lvl < 29 ? 2 : 1); return f * (1000 / 60); }

let cv = null, cx = null, nextCv = null, nextCx = null, raf = null, _built = false;
let board = [], cur = null, nextType = null, bag = [];
let score = 0, lines = 0, level = 0, dropMs = dropMsFor(0);
let lastGravity = 0;                        // absolute rAF timestamp of the last gravity step
let state = 'start';                        // start | play | over
let infoEl = null, overlayEl = null;
let _keyHandler = null;

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
// Occupied-column bounds within the matrix (for mouse centering).
function colBounds(m) { let lo = m.length, hi = -1; for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) { if (x < lo) lo = x; if (x > hi) hi = x; } return { lo, hi }; }

function spawn() {
  const type = nextType || bagNext();
  nextType = bagNext();
  const m = makeMatrix(type);
  cur = { type, m, x: ((COLS - m.length) / 2) | 0, y: type === 'I' ? -1 : 0 };
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
  if (!collides(cur.m, cur.x, cur.y + 1)) { cur.y++; lastGravity = performance.now(); }   // no score (no farming)
  else lockPiece();
}
function hardDrop() {
  if (state !== 'play' || !cur) return;
  let d = 0; while (!collides(cur.m, cur.x, cur.y + 1)) { cur.y++; d++; }
  score += d * 2; sfx('drop'); updateInfo(); lockPiece();
}
// Slide the piece so its occupied centre lands on a target board column, stepping
// one cell at a time so it can't pass through walls or the stack.
function moveToColumn(targetCol) {
  if (state !== 'play' || !cur) return;
  const { lo, hi } = colBounds(cur.m);
  const width = hi - lo + 1;
  let desiredX = Math.round(targetCol - width / 2) - lo;     // matrix x so centre ≈ targetCol
  desiredX = Math.max(-lo, Math.min(COLS - 1 - hi, desiredX));
  let moved = false;
  while (cur.x < desiredX && !collides(cur.m, cur.x + 1, cur.y)) { cur.x++; moved = true; }
  while (cur.x > desiredX && !collides(cur.m, cur.x - 1, cur.y)) { cur.x--; moved = true; }
  if (moved) sfx('move');
}
function ghostY() { let gy = cur.y; while (!collides(cur.m, cur.x, gy + 1)) gy++; return gy; }

function gameOver() {
  state = 'over';
  if (window.recordScore) window.recordScore('tetris', score, 'Lv' + (level + 1) + ' · ' + lines + ' lines');
  if (window.aqGameXp) window.aqGameXp('speed', { played: true, won: lines >= 10, mult: Math.min(4, 1 + lines * 0.12) });
  if (lines >= 20 && window.aqGameAnnounce) window.aqGameAnnounce(`cleared ${lines} lines in Tetris (${score.toLocaleString()} pts, Lv ${level + 1}) 🧱`);
  sfx('over');
  showOverlay('Game Over', 'Score ' + score.toLocaleString() + ' · ' + lines + ' lines · Lv ' + (level + 1), 'Play again', startGame);
}

// ── rendering ────────────────────────────────────────────────────────────────
function cell(g, px, py, ci, sz) {
  const col = COLORS[ci]; sz = sz || CELL;
  g.fillStyle = col.c; g.fillRect(px, py, sz, sz);
  g.fillStyle = col.hi; g.fillRect(px, py, sz, 3); g.fillRect(px, py, 3, sz);
  g.fillStyle = col.lo; g.fillRect(px, py + sz - 3, sz, 3); g.fillRect(px + sz - 3, py, 3, sz);
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

// Bulletproof gravity: compare against the absolute rAF timestamp so a piece always
// falls on its own (no fragile per-frame delta accumulation).
function tick(t) {
  // Always re-queue FIRST so a throw inside gravity/draw can never kill the loop
  // (a dead loop is exactly what makes the piece freeze at the top and ignore input).
  raf = requestAnimationFrame(tick);
  try {
    if (!lastGravity) lastGravity = t;
    if (state === 'play' && cur) {
      if (t - lastGravity >= dropMs) {
        lastGravity = t;
        if (!collides(cur.m, cur.x, cur.y + 1)) cur.y++;
        else lockPiece();
      }
    }
    draw();
  } catch (e) { try { console && console.warn && console.warn('tetris tick', e); } catch (_) {} }
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
  score = 0; lines = 0; level = 0; dropMs = dropMsFor(0); lastGravity = 0;
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
  const hint = document.createElement('div'); hint.className = 'tt-hint'; hint.innerHTML = 'Move mouse to slide<br>Click: drop<br>Right-click / scroll: rotate';
  side.appendChild(nlabel); side.appendChild(nextCv); side.appendChild(infoEl); side.appendChild(hint);
  main.appendChild(side);
  area.appendChild(main);

  // On-screen controls — CSS hides these on desktop (mouse there); shown on mobile.
  const pad = document.createElement('div'); pad.className = 'tt-pad';
  const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'tt-key'; b.textContent = label; b.addEventListener('pointerdown', e => { e.preventDefault(); fn(); draw(); }); return b; };
  pad.appendChild(mk('◀', () => move(-1)));
  pad.appendChild(mk('⟳', rotate));
  pad.appendChild(mk('▶', () => move(1)));
  pad.appendChild(mk('▼', softDrop));
  pad.appendChild(mk('⬇', hardDrop));
  area.appendChild(pad);

  cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
  nextCx = nextCv.getContext('2d'); nextCx.imageSmoothingEnabled = false;

  // Mouse controls: hover slides the piece, left-click drops, right-click/scroll rotates.
  // Each handler repaints immediately so input is responsive even if the rAF loop hiccups.
  cv.addEventListener('mousemove', (e) => {
    if (state !== 'play' || !cur) return;
    const rect = cv.getBoundingClientRect();
    const col = Math.floor(((e.clientX - rect.left) / rect.width) * COLS);
    moveToColumn(Math.max(0, Math.min(COLS - 1, col)));
    draw();
  });
  cv.addEventListener('mousedown', (e) => {
    if (state !== 'play' || !cur) return;
    if (e.button === 2) { e.preventDefault(); rotate(); }   // right-click rotates
    else if (e.button === 0) hardDrop();                    // left-click drops
    draw();
  });
  cv.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  cv.addEventListener('wheel', (e) => { if (state === 'play' && cur) { e.preventDefault(); rotate(); draw(); } }, { passive: false });

  // Keyboard (secondary): only while Tetris is the focused window and not typing.
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
    let used = true;
    if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowUp' || e.key === 'x' || e.key === 'X') rotate();
    else if (e.key === 'ArrowDown') softDrop();
    else if (e.key === ' ' || e.key === 'Spacebar') hardDrop();
    else used = false;
    if (used) { e.preventDefault(); draw(); }
  };
  document.addEventListener('keydown', _keyHandler);
  _built = true;
}

function openTetris(show = true) {
  const w = document.getElementById('tetris-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('tetris'); window.OS.focus('tetris'); }
  if (!_built) build();
  if (state !== 'play') showOverlay('🧱 Tetris', 'Move the mouse to slide · click to drop · right-click or scroll to rotate.', 'Start', startGame);
  updateInfo();
  lastGravity = 0;
  if (!raf) { raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') { window.openTetris = openTetris; }
