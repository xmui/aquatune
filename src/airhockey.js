// Aquatune Air Hockey — a Wii-Play-style table. You're the bottom paddle (drag to
// move, on mouse or touch); the AI defends the top. Puck bounces off the rails;
// knock it into the far goal. First to GOALS_TO_WIN wins. Grants Speed XP.

const TW = 300, TH = 460;
const GOAL_W = TW * 0.44;
const GOALS_TO_WIN = 7;
const PADDLE_R = 26, PUCK_R = 13;
const PUCK_MAX = 11;          // px per step cap
const PADDLE_MAX = 12;        // AI move speed cap (lower = easier to beat)

let cv = null, cx = null, raf = null, _built = false;
let state = 'start';         // start | play | over
let scoreYou = 0, scoreAI = 0, msg = '';
let paddle, ai, puck, target;
let _last = 0, _flashGoal = 0;

function sfx(n) { try { window.airhockeySfx && window.airhockeySfx(n); } catch (e) {} }
function reset(toYou) {
  paddle = { x: TW / 2, y: TH - 60, px: TW / 2, py: TH - 60, r: PADDLE_R };
  ai = { x: TW / 2, y: 60, r: PADDLE_R };
  // serve toward whoever was just scored on
  puck = { x: TW / 2, y: TH / 2, vx: (Math.random() - 0.5) * 4, vy: toYou ? 5 : -5, r: PUCK_R };
  target = { x: paddle.x, y: paddle.y };
}
function newGame() { scoreYou = 0; scoreAI = 0; state = 'play'; msg = ''; reset(Math.random() < 0.5); sfx('start'); }

function clampPaddle(p, topHalf) {
  const minY = topHalf ? p.r + 2 : TH / 2 + p.r;
  const maxY = topHalf ? TH / 2 - p.r : TH - p.r - 2;
  p.x = Math.max(p.r + 2, Math.min(TW - p.r - 2, p.x));
  p.y = Math.max(minY, Math.min(maxY, p.y));
}

function collide(p, pvx, pvy) {
  const dx = puck.x - p.x, dy = puck.y - p.y;
  const d = Math.hypot(dx, dy), min = p.r + puck.r;
  if (d >= min || d === 0) return;
  const nx = dx / d, ny = dy / d;
  // push puck out of the paddle, then reflect + add the paddle's own velocity
  puck.x = p.x + nx * (min + 0.5); puck.y = p.y + ny * (min + 0.5);
  const dot = puck.vx * nx + puck.vy * ny;
  puck.vx += (-2 * dot) * nx + (pvx || 0) * 0.6;
  puck.vy += (-2 * dot) * ny + (pvy || 0) * 0.6;
  // ensure it travels away with some pace
  const sp = Math.hypot(puck.vx, puck.vy);
  if (sp < 5) { puck.vx = nx * 6; puck.vy = ny * 6; }
  sfx('hitpaddle');
}

function step() {
  if (state !== 'play') return;
  // your paddle follows the pointer target (record velocity for puck impulse)
  const oldx = paddle.x, oldy = paddle.y;
  paddle.x = target.x; paddle.y = target.y;
  clampPaddle(paddle, false);
  const pvx = paddle.x - oldx, pvy = paddle.y - oldy;

  // AI: only commits to a hit when the puck is in its half and coming toward it;
  // otherwise it sits back near the goal. Eases toward the target (laggy → beatable).
  let tx, ty;
  if (puck.y < TH / 2 && puck.vy < 0.5) { tx = puck.x + puck.vx * 2; ty = Math.max(54, puck.y - 6); }
  else { tx = TW / 2 + (puck.x - TW / 2) * 0.3; ty = 60; }
  const adx = tx - ai.x, ady = ty - ai.y, ad = Math.hypot(adx, ady) || 1;
  const aspd = Math.min(PADDLE_MAX, ad * 0.5);
  const aox = ai.x, aoy = ai.y;
  ai.x += adx / ad * aspd; ai.y += ady / ad * aspd;
  clampPaddle(ai, true);

  // puck physics
  puck.vx *= 0.995; puck.vy *= 0.995;
  const sp = Math.hypot(puck.vx, puck.vy);
  if (sp > PUCK_MAX) { puck.vx = puck.vx / sp * PUCK_MAX; puck.vy = puck.vy / sp * PUCK_MAX; }
  puck.x += puck.vx; puck.y += puck.vy;

  // side rails
  if (puck.x < puck.r) { puck.x = puck.r; puck.vx = Math.abs(puck.vx); sfx('wall'); }
  if (puck.x > TW - puck.r) { puck.x = TW - puck.r; puck.vx = -Math.abs(puck.vx); sfx('wall'); }
  // top/bottom rails — unless inside the goal mouth
  const inGoalX = Math.abs(puck.x - TW / 2) < GOAL_W / 2;
  if (puck.y < puck.r) {
    if (inGoalX) { scoreYou++; goal(true); return; }
    puck.y = puck.r; puck.vy = Math.abs(puck.vy); sfx('wall');
  }
  if (puck.y > TH - puck.r) {
    if (inGoalX) { scoreAI++; goal(false); return; }
    puck.y = TH - puck.r; puck.vy = -Math.abs(puck.vy); sfx('wall');
  }

  collide(paddle, pvx, pvy);
  collide(ai, ai.x - aox, ai.y - aoy);
}

function goal(youScored) {
  _flashGoal = youScored ? 1 : -1;
  sfx(youScored ? 'goal' : 'goalagainst');
  if (scoreYou >= GOALS_TO_WIN || scoreAI >= GOALS_TO_WIN) { endGame(); return; }
  reset(!youScored);
}

function endGame() {
  state = 'over';
  const won = scoreYou > scoreAI;
  msg = won ? 'YOU WIN!' : 'YOU LOSE';
  sfx(won ? 'win' : 'lose');
  // Speed XP (capped well under the anti-cheat ceiling) + a credit prize on a win.
  if (typeof window.aqAddXp === 'function') window.aqAddXp('speed', Math.round(Math.min(300, 60 + scoreYou * 20 + (won ? 120 : 0))));
  if (won && typeof window.aqAddCredits === 'function') window.aqAddCredits(40 + scoreYou * 6);
  if (typeof window.recordScore === 'function') window.recordScore('airhockey', scoreYou, scoreYou + '–' + scoreAI);
}

// ── render ──────────────────────────────────────────────────────────────────
function disc(x, y, r, col, ring) {
  cx.beginPath(); cx.arc(x, y, r, 0, 6.2832); cx.fillStyle = col; cx.fill();
  if (ring) { cx.lineWidth = 3; cx.strokeStyle = ring; cx.stroke(); }
}
function draw() {
  if (!cx) return;
  cx.clearRect(0, 0, TW, TH);
  // table markings
  cx.strokeStyle = 'rgba(67,198,232,0.45)'; cx.lineWidth = 2;
  cx.beginPath(); cx.moveTo(0, TH / 2); cx.lineTo(TW, TH / 2); cx.stroke();
  cx.beginPath(); cx.arc(TW / 2, TH / 2, 46, 0, 6.2832); cx.stroke();
  // goals
  cx.fillStyle = _flashGoal > 0 ? 'rgba(120,255,150,0.5)' : 'rgba(67,198,232,0.3)';
  cx.fillRect(TW / 2 - GOAL_W / 2, 0, GOAL_W, 6);
  cx.fillStyle = _flashGoal < 0 ? 'rgba(255,120,120,0.5)' : 'rgba(67,198,232,0.3)';
  cx.fillRect(TW / 2 - GOAL_W / 2, TH - 6, GOAL_W, 6);
  // puck + paddles
  disc(puck.x, puck.y, puck.r, '#ffe27a', '#7a5a00');
  disc(ai.x, ai.y, ai.r, '#ff6b6b', '#7a1010');
  disc(paddle.x, paddle.y, paddle.r, '#5ad1ff', '#0a4a6a');
  disc(paddle.x, paddle.y, paddle.r * 0.45, '#bfeeff');
  // score
  cx.fillStyle = '#e8f4ff'; cx.font = 'bold 26px system-ui,Arial'; cx.textAlign = 'center';
  cx.globalAlpha = 0.5; cx.fillText(String(scoreAI), TW - 26, TH / 2 - 16);
  cx.fillText(String(scoreYou), TW - 26, TH / 2 + 38); cx.globalAlpha = 1;
  if (state !== 'play') {
    cx.fillStyle = 'rgba(4,12,20,0.74)'; cx.fillRect(0, 0, TW, TH);
    cx.fillStyle = '#fff'; cx.textAlign = 'center';
    cx.font = 'bold 30px system-ui,Arial';
    cx.fillText(state === 'over' ? msg : '🏒 Air Hockey', TW / 2, TH / 2 - 18);
    cx.font = '15px system-ui,Arial'; cx.fillStyle = '#bfe6ff';
    cx.fillText(state === 'over' ? 'Tap to play again' : 'Tap to start', TW / 2, TH / 2 + 16);
    cx.font = '12px system-ui,Arial'; cx.fillStyle = 'rgba(255,255,255,0.6)';
    cx.fillText('Drag your paddle · first to ' + GOALS_TO_WIN, TW / 2, TH / 2 + 42);
  }
  cx.textAlign = 'left';
}

function tick(t) {
  if (!raf) return;
  const dt = Math.min(40, t - (_last || t)); _last = t;
  if (_flashGoal) _flashGoal *= 0.86, Math.abs(_flashGoal) < 0.05 && (_flashGoal = 0);
  if (state === 'play') { const steps = Math.max(1, Math.round(dt / 16)); for (let i = 0; i < steps; i++) step(); }
  draw();
  raf = requestAnimationFrame(tick);
}

// ── input ───────────────────────────────────────────────────────────────────
function pointTo(e) {
  const r = cv.getBoundingClientRect();
  target.x = (e.clientX - r.left) * (TW / r.width);
  target.y = (e.clientY - r.top) * (TH / r.height);
}
function build() {
  const area = document.getElementById('airhockey-area'); if (!area) return;
  area.innerHTML = '';
  const hud = document.createElement('div'); hud.className = 'arc-hint';
  hud.textContent = 'Drag your paddle to block and strike the puck';
  cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; cv.className = 'arc-canvas';
  area.appendChild(cv); area.appendChild(hud);
  cx = cv.getContext('2d');
  reset(true);
  const onDown = (e) => {
    e.preventDefault();
    if (state !== 'play') { newGame(); return; }
    pointTo(e);
  };
  const onMove = (e) => { if (state === 'play') { e.preventDefault(); pointTo(e); } };
  cv.addEventListener('pointerdown', onDown, { passive: false });
  cv.addEventListener('pointermove', onMove, { passive: false });
  _built = true;
}

function openAirHockey(show = true) {
  const w = document.getElementById('airhockey-wrap'); if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('airhockey'); window.OS.focus('airhockey'); }
  if (!_built) build();
  if (state === 'play') state = 'start';   // show the start overlay on (re)open
  if (!raf) { _last = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') window.openAirHockey = openAirHockey;
