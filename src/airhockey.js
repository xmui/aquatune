// Aquatune Air Hockey — a Wii-Play-style table. Solo vs an AI, or a real-time
// match against a roommate (host-authoritative, mirroring the pool/poker pattern):
// the host runs the physics and streams the table; the guest renders it (rotated so
// it sits at the bottom too) and streams back its paddle position. Grants Speed XP.

const TW = 300, TH = 460;
const GOAL_W = TW * 0.44;
const GOALS_TO_WIN = 7;
const PADDLE_R = 26, PUCK_R = 13;
const PUCK_MAX = 14;          // top puck speed (px/step)
const MALLET_MAX = 20;        // your/host mallet max speed — bounded so hits are consistent & it can't tunnel past the puck
const FRICTION = 0.998;       // near-frictionless air table
// AI difficulty profiles (solo only). maxSpeed < player's 20 so every level stays
// beatable on raw speed; reactMs is the decision lag (lower = snappier); predict is
// how well it reads incoming shots; aimError is shot spread; aggression = how readily
// it goes on offense.
const AI_LEVELS = {
  easy: { maxSpeed: 7,  reactMs: 180, predict: 'none',     aimError: 34, aggression: 0.35, label: 'Easy' },
  med:  { maxSpeed: 11, reactMs: 90,  predict: 'straight', aimError: 16, aggression: 0.60, label: 'Medium' },
  hard: { maxSpeed: 16, reactMs: 40,  predict: 'bounce',   aimError: 6,  aggression: 0.85, label: 'Hard' },
};
let aiDiff = (() => { try { const d = localStorage.getItem('aq_ah_diff'); return AI_LEVELS[d] ? d : 'med'; } catch { return 'med'; } })();
let _aiDecideAt = 0, _aiAim = { x: 0, y: 0 }, _aiSpd = 9;
const REST = 0.9;             // puck restitution off a mallet
const BROADCAST_MS = 50;      // host state stream interval
const INPUT_MS = 45;          // guest paddle input interval

let cv = null, cx = null, raf = null, _built = false, overlayEl = null;
let state = 'start';          // start | play | over
let mode = null;             // 'solo' | 'room'
let scoreYou = 0, scoreAI = 0, msg = '';
let paddle, ai, puck, target, guestTarget;
let _last = 0, _flashGoal = 0, _bcAt = 0, _inAt = 0, _lastInX = 0, _lastInY = 0, _guestGranted = false;

function sfx(n) { try { window.airhockeySfx && window.airhockeySfx(n); } catch (e) {} }
function inRoom() { return mode === 'room' && !!window._currentRoomId; }
function iAmHost() { return inRoom() && !!window._isRoomHost; }
function isGuest() { return inRoom() && !window._isRoomHost; }

function reset(toYou) {
  paddle = { x: TW / 2, y: TH - 60, r: PADDLE_R };
  ai = { x: TW / 2, y: 60, r: PADDLE_R };
  puck = { x: TW / 2, y: TH / 2, vx: (Math.random() - 0.5) * 4, vy: toYou ? 5 : -5, r: PUCK_R };
  target = { x: paddle.x, y: paddle.y };
  guestTarget = { x: TW / 2, y: 60 };
  _aiDecideAt = 0; _aiAim = { x: ai.x, y: ai.y };
}
function newGame(m) {
  mode = m; scoreYou = 0; scoreAI = 0; state = 'play'; msg = ''; _guestGranted = false;
  reset(Math.random() < 0.5); hideOverlay(); sfx('start');
  if (iAmHost()) broadcast();
}

function clampPaddle(p, topHalf) {
  const minY = topHalf ? p.r + 2 : TH / 2 + p.r;
  const maxY = topHalf ? TH / 2 - p.r : TH - p.r - 2;
  p.x = Math.max(p.r + 2, Math.min(TW - p.r - 2, p.x));
  p.y = Math.max(minY, Math.min(maxY, p.y));
}
// Move a mallet toward its target with a CAPPED speed (a real, bounded velocity
// instead of a teleport) and return that velocity for the collision impulse.
function moveMallet(p, tx, ty, topHalf, maxStep) {
  const ox = p.x, oy = p.y;
  let dx = tx - p.x, dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d > maxStep) { dx = dx / d * maxStep; dy = dy / d * maxStep; }
  p.x += dx; p.y += dy; clampPaddle(p, topHalf);
  return { vx: p.x - ox, vy: p.y - oy };
}
// Puck vs an infinite-mass moving mallet: reflect the puck's velocity RELATIVE to
// the mallet along the contact normal, with restitution — this naturally imparts
// the mallet's motion (a hard swing launches the puck; a still mallet just bounces
// it). Positional correction + the "only when closing (vn<0)" guard kill sticking
// and double-hits. (Standard model — ericleong / air-hockey sim references.)
function collide(p, pv) {
  const dx = puck.x - p.x, dy = puck.y - p.y;
  let d = Math.hypot(dx, dy); const min = p.r + puck.r;
  if (d >= min) return;
  if (d < 0.01) d = 0.01;
  const nx = dx / d, ny = dy / d;
  puck.x = p.x + nx * min; puck.y = p.y + ny * min;     // lift puck onto the mallet surface
  const vn = (puck.vx - pv.vx) * nx + (puck.vy - pv.vy) * ny;
  if (vn < 0) {
    puck.vx -= (1 + REST) * vn * nx;
    puck.vy -= (1 + REST) * vn * ny;
    const sp = Math.hypot(puck.vx, puck.vy);
    if (sp > PUCK_MAX) { puck.vx = puck.vx / sp * PUCK_MAX; puck.vy = puck.vy / sp * PUCK_MAX; }
    sfx('hitpaddle');
  }
}

// ── AI (solo) ───────────────────────────────────────────────────────────────
// Predict the puck's x when it reaches `targetY`, optionally reflecting off the
// side rails so a smart bot reads bank shots.
function predictX(px, vx, py, vy, targetY, mode) {
  if (mode === 'none' || vy >= -0.05) return px;
  const t = (targetY - py) / vy;
  if (t <= 0) return px;
  let x = px + vx * t;
  const lo = PUCK_R, hi = TW - PUCK_R;
  if (mode === 'straight') return Math.max(lo, Math.min(hi, x));
  const span = hi - lo;                       // triangle-wave reflection into [lo,hi]
  let m = (x - lo) % (2 * span); if (m < 0) m += 2 * span;
  return m < span ? lo + m : hi - (m - span);
}
function aiDecide(cfg) {
  const defY = PADDLE_R + 24;
  const threat = puck.vy < -0.2 && puck.y < TH * 0.62;     // puck heading up at the AI goal
  const inAIHalf = puck.y < TH / 2 - PUCK_R;
  if (threat) {                                            // DEFEND — intercept on the goal line
    let x = predictX(puck.x, puck.vx, puck.y, puck.vy, defY, cfg.predict);
    x = x * 0.82 + (TW / 2) * 0.18;                        // bias toward the goal mouth when wide
    _aiAim = { x, y: defY }; _aiSpd = cfg.maxSpeed; return;
  }
  if (inAIHalf && Math.random() < cfg.aggression) {        // ATTACK — line up behind, drive through toward the player's goal
    if (ai.y > puck.y + 2) {                               // mallet is BELOW the puck — slip around it (never shove it up into our own goal)
      const side = ai.x < puck.x ? -1 : 1;
      _aiAim = { x: Math.max(PUCK_R, Math.min(TW - PUCK_R, puck.x + side * (PADDLE_R + PUCK_R + 6))), y: TH / 2 - PADDLE_R };
      _aiSpd = cfg.maxSpeed; return;
    }
    const gx = TW / 2 + (Math.random() * 2 - 1) * cfg.aimError, gy = TH + 10;
    let dx = gx - puck.x, dy = gy - puck.y; const dd = Math.hypot(dx, dy) || 1; dx /= dd; dy /= dd;
    const behindX = puck.x - dx * (PADDLE_R + PUCK_R), behindY = puck.y - dy * (PADDLE_R + PUCK_R);
    const rel = (ai.x - puck.x) * dx + (ai.y - puck.y) * dy;          // <0 ⇒ mallet is behind the puck
    const offLine = Math.abs((ai.x - puck.x) * dy - (ai.y - puck.y) * dx);
    if (rel < -2 && offLine < PADDLE_R * 0.8 && behindY >= PADDLE_R) _aiAim = { x: puck.x + dx * 60, y: puck.y + dy * 60 };
    else if (behindY >= PADDLE_R) _aiAim = { x: behindX, y: behindY };
    else _aiAim = { x: puck.x, y: defY };                  // too close to the centre line → just clear it
    _aiSpd = cfg.maxSpeed; return;
  }
  _aiAim = { x: TW / 2 + (puck.x - TW / 2) * 0.45, y: 64 }; // RETURN — pre-position near home
  _aiSpd = cfg.maxSpeed * 0.8;
}
function aiThink() {
  const cfg = AI_LEVELS[aiDiff] || AI_LEVELS.med;
  const now = performance.now();
  if (now >= _aiDecideAt) { aiDecide(cfg); _aiDecideAt = now + cfg.reactMs; }   // decision lag = reactMs
  return { x: _aiAim.x, y: _aiAim.y, spd: _aiSpd };
}

function step() {
  if (state !== 'play') return;
  // mallets move toward their targets at a capped speed (real bounded velocity,
  // no teleport) → consistent hits and no jumping past the puck.
  const pv = moveMallet(paddle, target.x, target.y, false, MALLET_MAX);
  let av;
  if (mode === 'room') av = moveMallet(ai, guestTarget.x, guestTarget.y, true, MALLET_MAX);
  else { const a = aiThink(); av = moveMallet(ai, a.x, a.y, true, a.spd); }
  // puck: near-frictionless glide, capped top speed
  puck.vx *= FRICTION; puck.vy *= FRICTION;
  const sp = Math.hypot(puck.vx, puck.vy);
  if (sp > PUCK_MAX) { puck.vx = puck.vx / sp * PUCK_MAX; puck.vy = puck.vy / sp * PUCK_MAX; }
  puck.x += puck.vx; puck.y += puck.vy;

  if (puck.x < puck.r) { puck.x = puck.r; puck.vx = Math.abs(puck.vx); sfx('wall'); }
  if (puck.x > TW - puck.r) { puck.x = TW - puck.r; puck.vx = -Math.abs(puck.vx); sfx('wall'); }
  const inGoalX = Math.abs(puck.x - TW / 2) < GOAL_W / 2;
  if (puck.y < puck.r) { if (inGoalX) { scoreYou++; goal(true); return; } puck.y = puck.r; puck.vy = Math.abs(puck.vy); sfx('wall'); }
  if (puck.y > TH - puck.r) { if (inGoalX) { scoreAI++; goal(false); return; } puck.y = TH - puck.r; puck.vy = -Math.abs(puck.vy); sfx('wall'); }

  collide(paddle, pv);
  collide(ai, av);
}

function goal(youScored) {
  _flashGoal = youScored ? 1 : -1;
  sfx(youScored ? 'goal' : 'goalagainst');
  if (scoreYou >= GOALS_TO_WIN || scoreAI >= GOALS_TO_WIN) { endGame(); if (iAmHost()) broadcast(); return; }
  reset(!youScored);
  if (iAmHost()) broadcast();
}
function grantResult(won, myScore) {
  if (typeof window.aqAddXp === 'function') window.aqAddXp('speed', Math.round(Math.min(300, 60 + myScore * 20 + (won ? 120 : 0))));
  if (won && typeof window.aqAddCredits === 'function') window.aqAddCredits(40 + myScore * 6);
  if (typeof window.recordScore === 'function') window.recordScore('airhockey', myScore, myScore + ' goals');
}
function endGame() {
  state = 'over';
  const won = scoreYou > scoreAI;
  msg = won ? 'YOU WIN!' : 'YOU LOSE';
  sfx(won ? 'win' : 'lose');
  grantResult(won, scoreYou);   // host (or solo) grants for itself; the guest grants from the broadcast
  if (inRoom() && won && typeof window.aqGameAnnounce === 'function') window.aqGameAnnounce('won an Air Hockey match in the room! 🏒');
  showOverlay();
}

// ── room netcode ────────────────────────────────────────────────────────────
function broadcast() {
  if (typeof window.airhockeyBroadcast !== 'function') return;
  window.airhockeyBroadcast({ puck: { x: puck.x, y: puck.y }, ph: { x: paddle.x, y: paddle.y },
    pg: { x: ai.x, y: ai.y }, sh: scoreYou, sg: scoreAI, st: state });
}
// Guest applies host state, rotated 180° so the guest also sits at the bottom. Its
// OWN paddle is predicted locally (from its pointer) for responsiveness; only the
// opponent + puck come from the host.
function onState(s) {
  if (!isGuest()) return;
  if (!puck) reset(true);
  puck.x = TW - s.puck.x; puck.y = TH - s.puck.y;
  ai.x = TW - s.ph.x; ai.y = TH - s.ph.y;           // host paddle = opponent at the top
  scoreYou = s.sg; scoreAI = s.sh;
  if (s.st === 'play') { if (state !== 'play') { state = 'play'; _guestGranted = false; hideOverlay(); } }
  else if (s.st === 'over') {
    state = 'over'; msg = s.sg > s.sh ? 'YOU WIN!' : 'YOU LOSE';
    if (!_guestGranted) { _guestGranted = true; grantResult(s.sg > s.sh, s.sg); }
    showOverlay();
  }
}
function onInput(p) { if (iAmHost()) guestTarget = { x: TW - p.x, y: TH - p.y }; }   // rotate guest paddle into the host's top half
function sendGuestInput() {
  const now = performance.now();
  if (now - _inAt < INPUT_MS) return;
  if (Math.abs(target.x - _lastInX) < 0.5 && Math.abs(target.y - _lastInY) < 0.5) return;
  _inAt = now; _lastInX = target.x; _lastInY = target.y;
  if (typeof window.airhockeySendInput === 'function') window.airhockeySendInput({ x: target.x, y: target.y });
}

// ── render ──────────────────────────────────────────────────────────────────
function disc(x, y, r, col, ring) {
  cx.beginPath(); cx.arc(x, y, r, 0, 6.2832); cx.fillStyle = col; cx.fill();
  if (ring) { cx.lineWidth = 3; cx.strokeStyle = ring; cx.stroke(); }
}
function draw() {
  if (!cx) return;
  cx.clearRect(0, 0, TW, TH);
  cx.strokeStyle = 'rgba(67,198,232,0.45)'; cx.lineWidth = 2;
  cx.beginPath(); cx.moveTo(0, TH / 2); cx.lineTo(TW, TH / 2); cx.stroke();
  cx.beginPath(); cx.arc(TW / 2, TH / 2, 46, 0, 6.2832); cx.stroke();
  cx.fillStyle = _flashGoal > 0 ? 'rgba(120,255,150,0.5)' : 'rgba(67,198,232,0.3)';
  cx.fillRect(TW / 2 - GOAL_W / 2, 0, GOAL_W, 6);
  cx.fillStyle = _flashGoal < 0 ? 'rgba(255,120,120,0.5)' : 'rgba(67,198,232,0.3)';
  cx.fillRect(TW / 2 - GOAL_W / 2, TH - 6, GOAL_W, 6);
  if (puck) {
    disc(puck.x, puck.y, puck.r, '#ffe27a', '#7a5a00');
    disc(ai.x, ai.y, ai.r, '#ff6b6b', '#7a1010');
    disc(paddle.x, paddle.y, paddle.r, '#5ad1ff', '#0a4a6a');
    disc(paddle.x, paddle.y, paddle.r * 0.45, '#bfeeff');
  }
  cx.fillStyle = '#e8f4ff'; cx.font = 'bold 26px system-ui,Arial'; cx.textAlign = 'center'; cx.globalAlpha = 0.5;
  cx.fillText(String(scoreAI), TW - 26, TH / 2 - 16);
  cx.fillText(String(scoreYou), TW - 26, TH / 2 + 38); cx.globalAlpha = 1; cx.textAlign = 'left';
}

function tick(t) {
  if (!raf) return;
  const dt = Math.min(40, t - (_last || t)); _last = t;
  if (_flashGoal) { _flashGoal *= 0.86; if (Math.abs(_flashGoal) < 0.05) _flashGoal = 0; }
  if (isGuest()) {
    if (puck) moveMallet(paddle, target.x, target.y, false, MALLET_MAX);   // smooth client-side prediction of own paddle
    if (state === 'play') sendGuestInput();
  } else if (state === 'play') {
    const steps = Math.max(1, Math.round(dt / 16)); for (let i = 0; i < steps; i++) step();
    if (iAmHost() && t - _bcAt >= BROADCAST_MS) { _bcAt = t; broadcast(); }
  }
  draw();
  raf = requestAnimationFrame(tick);
}

// ── overlay (mode select / rematch / waiting) ────────────────────────────────
function hideOverlay() { if (overlayEl) overlayEl.style.display = 'none'; }
function showOverlay() {
  if (!overlayEl) return;
  const haveRoom = !!window._currentRoomId;
  const title = state === 'over' ? (msg || 'Game Over') : '🏒 Air Hockey';
  let body;
  if (isGuest() && state !== 'over') {
    body = `<div class="ah-ov-note">Waiting for the host to start the match…</div>`;
  } else {
    const roomLbl = state === 'over' ? '👥 Rematch in room' : '👥 Play someone in the room';
    const diffRow = `<div class="ah-diff-row">` + Object.keys(AI_LEVELS).map(k =>
      `<button class="ah-diff${k === aiDiff ? ' on' : ''}" data-diff="${k}">${AI_LEVELS[k].label}</button>`).join('') + `</div>`;
    body = diffRow
      + `<div class="ah-ov-btns">`
      + `<button class="ah-btn" id="ah-solo">🤖 ${state === 'over' ? 'Play again' : 'Play the computer'}</button>`
      + `<button class="ah-btn" id="ah-room"${haveRoom ? '' : ' disabled'}>${roomLbl}</button></div>`
      + `<div class="ah-ov-note">${haveRoom ? (window._isRoomHost ? "You'll host — a roommate can join by opening Air Hockey." : "Join the host's table (open it while they host).") : 'Join or create a room first to play someone.'}</div>`;
  }
  overlayEl.innerHTML = `<div class="ah-ov-title">${title}</div><div class="ah-ov-sub">First to ${GOALS_TO_WIN} · drag your paddle</div>${body}`;
  overlayEl.style.display = 'flex';
  overlayEl.querySelectorAll('.ah-diff').forEach(b => b.onclick = () => {
    aiDiff = b.dataset.diff; try { localStorage.setItem('aq_ah_diff', aiDiff); } catch {}
    overlayEl.querySelectorAll('.ah-diff').forEach(x => x.classList.toggle('on', x.dataset.diff === aiDiff));
  });
  const sb = overlayEl.querySelector('#ah-solo'); if (sb) sb.onclick = () => newGame('solo');
  const rb = overlayEl.querySelector('#ah-room'); if (rb && haveRoom) rb.onclick = startRoom;
}
function startRoom() {
  mode = 'room'; _guestGranted = false;
  if (window._isRoomHost) { newGame('room'); }
  else { reset(true); scoreYou = 0; scoreAI = 0; state = 'start'; showOverlay(); }   // guest waits for host's stream
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
  const stage = document.createElement('div'); stage.style.cssText = 'position:relative;width:100%;display:flex;justify-content:center;flex:1;min-height:0;';
  cv = document.createElement('canvas'); cv.width = TW; cv.height = TH; cv.className = 'arc-canvas';
  stage.appendChild(cv);
  overlayEl = document.createElement('div'); overlayEl.className = 'ah-overlay'; stage.appendChild(overlayEl);
  area.appendChild(stage);
  const hint = document.createElement('div'); hint.className = 'arc-hint'; hint.textContent = 'Drag your paddle to block and strike the puck';
  area.appendChild(hint);
  cx = cv.getContext('2d');
  reset(true);
  const onMove = (e) => { if (state === 'play' || isGuest()) { e.preventDefault(); pointTo(e); } };
  cv.addEventListener('pointerdown', (e) => { e.preventDefault(); pointTo(e); }, { passive: false });
  cv.addEventListener('pointermove', onMove, { passive: false });
  _built = true;
}

function openAirHockey(show = true) {
  const w = document.getElementById('airhockey-wrap'); if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('airhockey'); window.OS.focus('airhockey'); }
  if (!_built) build();
  if (state === 'play') { state = 'start'; }   // show the menu on (re)open
  showOverlay();
  if (!raf) { _last = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') {
  window.openAirHockey = openAirHockey;
  window.onAirHockeyState = onState;
  window.onAirHockeyInput = onInput;
}
