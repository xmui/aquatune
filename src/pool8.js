// Aquatune 8-Ball — GamePigeon-style pool with a Windows-2000s window dressing.
//
// Top-down felt table, slingshot aiming (drag back from the cue ball to set
// direction + power, release to strike), equal-mass ball physics, six pockets and
// full 8-ball rules (open table → group assignment, scratch / wrong-ball-first =
// ball-in-hand, sink the 8 last to win).
//
// Two ways to play, chosen on the start screen:
//   • Play a bot   — solid offline AI (seat B).
//   • Play someone in the room — host-authoritative online match. The room HOST
//     runs the physics engine and streams ball/turn state; the GUEST renders that
//     state and sends its shots (direction + power) which the host applies on the
//     guest's turn. Seats are absolute: host = A, guest = B; each client just maps
//     its own seat to "you". Winning grants Intellect XP; best runs post to the LB.

const W = 700, H = 380;                 // logical canvas (CSS-scaled)
const M = 30;                           // cushion margin
const R = 10.5;                         // ball radius
const PR = 17;                          // pocket capture radius
const LX = M, RXn = W - M, TY = M, BY = H - M;   // playfield bounds
const MAXPULL = 150, MAXSPEED = 1020;   // slingshot pull → launch speed
const DECEL = 520, REST = 0.62;         // rolling friction (px/s²), cushion restitution
const BALL_REST = 0.95;                 // ball-ball energy retained (real ivory ~0.95)
const STOP = 7;                         // speed below which a ball is "stopped"
const STREAM_MS = 90;                   // host → guest state stream throttle

const POCKETS = [
  { x: LX, y: TY }, { x: W / 2, y: TY - 3 }, { x: RXn, y: TY },
  { x: LX, y: BY }, { x: W / 2, y: BY + 3 }, { x: RXn, y: BY },
];
// ball tints (1..7 solids; 9..15 are the striped versions of 1..7; 8 black; 0 cue)
const TINT = { 1: '#f4c20d', 2: '#1f57d6', 3: '#d62828', 4: '#7b2fb5', 5: '#e87a17', 6: '#1f8a4c', 7: '#7a1f2b', 8: '#1a1a1a' };
function tintFor(n) { return n === 0 ? '#f7f7f2' : (n <= 8 ? TINT[n] : TINT[n - 8]); }
function groupOf(n) { return n === 0 ? 'cue' : n === 8 ? 'eight' : (n <= 7 ? 'solid' : 'stripe'); }
function other(seat) { return seat === 'A' ? 'B' : 'A'; }

let cv = null, cx = null, raf = null, _built = false, _lastT = 0;
let balls = [], state = 'start';        // start | aim | shoot | place | ai | remote | watch | over
let aiming = null, placing = false;
let turn = 'A', groups = { A: null, B: null }, open = true, broke = false;
let pottedThisShot = [], firstHit = null, cueStruck = false, pendingInhand = false;
let msgEl = null, hudEl = null, traysEl = null, overlayEl = null, _aiTimer = null;

// mode / seating
let mode = 'bot';                       // 'bot' | 'room'
let mySeat = 'A';                       // which seat the local player controls
let opponentPresent = false;            // (room host) has a guest joined?
let guestInhand = false;                // (room guest) did I get ball-in-hand this turn?
let _overInfo = null;                   // {winner, text} once a game ends
let _finished = false;                  // guard so rewards are granted once per game
let _lastBroadcast = 0, _guestAnnounced = false;

function sfx(n) { try { window.poolSfx && window.poolSfx(n); } catch (e) {} }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function inRoom() { return mode === 'room' && !!window._currentRoomId; }
function iAmEngine() { return mode === 'bot' || (mode === 'room' && !!window._isRoomHost); }
function engineSeat() { return 'A'; }   // the engine-side human always sits A (host / bot-you)

// ── setup ──────────────────────────────────────────────────────────────────
function rack() {
  balls = [];
  balls.push({ n: 0, x: W * 0.26, y: H / 2, vx: 0, vy: 0, potted: false });   // cue
  const rest = [9, 10, 11, 12, 13, 14, 1, 2, 3, 4, 5, 6, 7];
  for (let i = rest.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[rest[i], rest[j]] = [rest[j], rest[i]]; }
  const apexX = W * 0.72, dx = R * 1.74;
  let idx = 0;
  for (let col = 0; col < 5; col++) {
    for (let row = 0; row <= col; row++) {
      const x = apexX + col * dx;
      const y = H / 2 + (row - col / 2) * (R * 2.06);
      let n;
      if (col === 2 && row === 1) n = 8;                          // centre
      else if (col === 4 && row === 0) n = 9;                     // a stripe corner
      else if (col === 4 && row === 4) n = 1;                     // a solid corner
      else n = rest[idx++];
      balls.push({ n, x, y, vx: 0, vy: 0, potted: false });
    }
  }
}
function cueBall() { return balls.find(b => b.n === 0); }
function liveOf(group) { return balls.filter(b => !b.potted && groupOf(b.n) === group); }

// ── physics ────────────────────────────────────────────────────────────────
function anyMoving() { return balls.some(b => !b.potted && (b.vx * b.vx + b.vy * b.vy) > STOP * STOP); }
function step(dt) {
  // Substep count scales with the fastest ball so a hard break never tunnels a
  // ball straight through another (continuous-ish collision on a cheap budget).
  let vmax = 0; for (const b of balls) { if (!b.potted) { const v = Math.hypot(b.vx, b.vy); if (v > vmax) vmax = v; } }
  const SUB = Math.max(4, Math.min(16, Math.ceil(vmax * dt / (R * 0.6)))), sdt = dt / SUB;
  for (let s = 0; s < SUB; s++) {
    for (const b of balls) {
      if (b.potted) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 0) { const ns = Math.max(0, sp - DECEL * sdt); b.vx = b.vx / sp * ns; b.vy = b.vy / sp * ns; if (ns < STOP) { b.vx = b.vy = 0; } }
      b.x += b.vx * sdt; b.y += b.vy * sdt;
    }
    for (const b of balls) {
      if (b.potted) continue;
      for (const p of POCKETS) { if (Math.hypot(b.x - p.x, b.y - p.y) < PR) { potBall(b); break; } }
    }
    for (const b of balls) {
      if (b.potted) continue;
      if (b.x < LX + R) { b.x = LX + R; b.vx = Math.abs(b.vx) * REST; cushion(b); }
      else if (b.x > RXn - R) { b.x = RXn - R; b.vx = -Math.abs(b.vx) * REST; cushion(b); }
      if (b.y < TY + R) { b.y = TY + R; b.vy = Math.abs(b.vy) * REST; cushion(b); }
      else if (b.y > BY - R) { b.y = BY - R; b.vy = -Math.abs(b.vy) * REST; cushion(b); }
    }
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i]; if (a.potted) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const c = balls[j]; if (c.potted) continue;
        const dx = c.x - a.x, dy = c.y - a.y; let d = Math.hypot(dx, dy);
        if (d > 0 && d < R * 2) {
          const nx = dx / d, ny = dy / d, overlap = R * 2 - d;
          a.x -= nx * overlap / 2; a.y -= ny * overlap / 2; c.x += nx * overlap / 2; c.y += ny * overlap / 2;
          const av = a.vx * nx + a.vy * ny, cvv = c.vx * nx + c.vy * ny, rel = av - cvv;
          if (rel > 0) {
            // equal masses, restitution e: exchanged normal impulse = (1+e)/2 · rel
            const p = rel * (1 + BALL_REST) / 2;
            a.vx -= p * nx; a.vy -= p * ny; c.vx += p * nx; c.vy += p * ny;
            if (!firstHit && (a.n === 0 || c.n === 0)) firstHit = (a.n === 0 ? c.n : a.n);
            if (p > 60) sfx(p > 400 ? 'break' : 'hit');
          }
        }
      }
    }
  }
}
let _cushAt = 0;
function cushion(b) { const now = performance.now(); if (now - _cushAt > 40) { _cushAt = now; sfx('wall'); } }
function potBall(b) {
  b.potted = true; b.vx = b.vy = 0; pottedThisShot.push(b.n); sfx('pocket');
  updateHud();   // refresh the sunk-balls trays the moment a ball drops
}

// ── shooting + turn flow (engine side) ───────────────────────────────────────
function doShoot(dirx, diry, speed) {
  const cue = cueBall(); if (!cue) return;
  cue.vx = dirx * speed; cue.vy = diry * speed;
  pottedThisShot = []; firstHit = null; cueStruck = true; pendingInhand = false;
  state = 'shoot'; setMsg('');
  broadcastState(true);
}
function resolveShot() {
  const cue = cueBall();
  const scratch = cue.potted;
  const shooter = turn;
  const opp = other(shooter);
  const potted = pottedThisShot.slice();
  const eight = potted.includes(8);

  // Open table: the first legally pocketed solid/stripe assigns the groups.
  const nonCue = potted.filter(n => n !== 0 && n !== 8);
  if (!scratch && open && nonCue.length && !eight) {
    const g = groupOf(nonCue[0]);
    groups[shooter] = g; groups[opp] = g === 'solid' ? 'stripe' : 'solid';
    open = false;
  }
  const myGroup = groups[shooter];

  // 8-ball outcomes: you only win by sinking the 8 cleanly AFTER clearing your group.
  if (eight) {
    const clearedGroup = myGroup && liveOf(myGroup).length === 0;   // post-shot state
    if (myGroup && clearedGroup && !scratch) endGame(shooter, 'Sank the 8 — game!');
    else endGame(opp, scratch ? 'Scratch on the 8.' : 'Sank the 8 too early.');
    return;
  }

  // Fouls (ball-in-hand to the opponent): scratch, no contact, wrong ball first.
  let foul = false;
  if (scratch) foul = true;
  else if (firstHit == null) foul = true;
  else if (!open && myGroup) {
    const onEight = liveOf(myGroup).length === 0;
    const legalFirst = onEight ? (firstHit === 8) : (groupOf(firstHit) === myGroup);
    if (!legalFirst) foul = true;
  } else if (open && firstHit === 8) foul = true;

  const legalOwn = !foul && myGroup && potted.some(n => groupOf(n) === myGroup);

  if (foul) { if (scratch) respotCue(); broke = true; turn = opp; updateHud(); beginTurn(true); }
  else if (legalOwn) { broke = true; updateHud(); beginTurn(false); }
  else { broke = true; turn = opp; updateHud(); beginTurn(false); }
}
function respotCue() {
  const cue = cueBall();
  cue.potted = false; cue.vx = cue.vy = 0; cue.x = W * 0.26; cue.y = H / 2;
  for (let k = 0; k < 40; k++) { let hit = false; for (const b of balls) { if (b === cue || b.potted) continue; if (Math.hypot(b.x - cue.x, b.y - cue.y) < R * 2 + 1) { cue.x -= 6; hit = true; } } if (!hit) break; }
}
// Configure the next turn on the ENGINE side and tell the guest about it.
function beginTurn(inhand) {
  pendingInhand = !!inhand;
  if (turn === engineSeat()) {                       // the engine-side human (host / bot-you)
    state = inhand ? 'place' : 'aim'; placing = inhand;
    setMsg(inhand ? 'Ball in hand — drag the cue ball to place it.' : 'Your shot.');
  } else if (mode === 'bot') {                        // the AI sits B
    state = 'ai'; placing = false; setMsg('Opponent is lining up…'); scheduleAi();
  } else {                                            // room: waiting for the guest's shot
    state = 'remote'; placing = false; setMsg(opponentPresent ? "Opponent's turn…" : 'Waiting for an opponent…');
  }
  broadcastState(true);
}
function endGame(winnerSeat, text) {
  state = 'over';
  _overInfo = { winner: winnerSeat, text };
  broadcastState(true);
  grantOutcome(winnerSeat, text);
}
// Local rewards + overlay (runs on each client for its own perspective).
function grantOutcome(winnerSeat, text) {
  if (_finished) return; _finished = true;
  const youWon = winnerSeat === mySeat;
  if (youWon && window.aqAddCredits) window.aqAddCredits(40);
  if (window.aqGameXp) window.aqGameXp('intellect', { played: true, won: youWon, mult: youWon ? 1.6 : 0.5 });
  if (window.recordScore) window.recordScore('pool8', youWon ? 1 : 0, youWon ? 'win' : 'loss');
  sfx(youWon ? 'win' : 'lose');
  showOverlay(youWon ? '🎱 You win!' : '🎱 You lose', text + (youWon ? '  +40💰' : ''), 'Rematch', showStart);
}

// ── AI (bot mode, seat B) ─────────────────────────────────────────────────────
function scheduleAi() { clearTimeout(_aiTimer); _aiTimer = setTimeout(aiShoot, 800); }
function pathClear(x0, y0, x1, y1, ignore) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1, nx = dx / len, ny = dy / len;
  for (const b of balls) {
    if (b.potted || ignore.includes(b)) continue;
    const t = (b.x - x0) * nx + (b.y - y0) * ny;
    if (t <= 0 || t >= len) continue;
    const px = x0 + nx * t, py = y0 + ny * t;
    if (Math.hypot(b.x - px, b.y - py) < R * 2 - 1) return false;
  }
  return true;
}
function aiShoot() {
  if (state !== 'ai') return;
  const cue = cueBall(); if (!cue) return;
  let targets;
  if (groups.B) targets = liveOf(groups.B);
  else targets = balls.filter(b => !b.potted && b.n !== 0 && b.n !== 8);
  if (groups.B && targets.length === 0) targets = balls.filter(b => !b.potted && b.n === 8);
  if (!targets.length) targets = balls.filter(b => !b.potted && b.n !== 0);

  let best = null;
  for (const ball of targets) {
    for (const p of POCKETS) {
      const bp = Math.hypot(p.x - ball.x, p.y - ball.y);
      const toP = { x: (p.x - ball.x) / bp, y: (p.y - ball.y) / bp };
      const ghost = { x: ball.x - toP.x * R * 2, y: ball.y - toP.y * R * 2 };
      const cg = Math.hypot(ghost.x - cue.x, ghost.y - cue.y);
      const aim = { x: (ghost.x - cue.x) / cg, y: (ghost.y - cue.y) / cg };
      const cut = aim.x * toP.x + aim.y * toP.y;
      if (cut < 0.25) continue;
      if (!pathClear(cue.x, cue.y, ghost.x, ghost.y, [ball]) || !pathClear(ball.x, ball.y, p.x, p.y, [])) continue;
      const score = cut * 2 - (cg + bp) / 900;
      if (!best || score > best.score) best = { score, aim, dist: cg + bp };
    }
  }
  if (!best) {
    const t = targets[0]; const d = Math.hypot(t.x - cue.x, t.y - cue.y);
    best = { aim: { x: (t.x - cue.x) / d, y: (t.y - cue.y) / d }, dist: d };
  }
  const err = (Math.random() - 0.5) * 0.09;
  const ca = Math.cos(err), sa = Math.sin(err);
  const ax = best.aim.x * ca - best.aim.y * sa, ay = best.aim.x * sa + best.aim.y * ca;
  const speed = Math.min(MAXSPEED, 360 + best.dist * 1.15);
  doShoot(ax, ay, speed);
}

// ── networking ───────────────────────────────────────────────────────────────
function broadcastState(force) {
  if (mode !== 'room' || !window._isRoomHost || typeof window.poolBroadcast !== 'function') return;
  const now = performance.now();
  if (!force && now - _lastBroadcast < STREAM_MS) return;
  _lastBroadcast = now;
  window.poolBroadcast({
    balls: balls.map(b => ({ n: b.n, x: Math.round(b.x * 10) / 10, y: Math.round(b.y * 10) / 10, p: b.potted ? 1 : 0 })),
    turn, groups, open, broke,
    moving: anyMoving() || state === 'shoot' ? 1 : 0,
    inhand: pendingInhand ? 1 : 0,
    over: _overInfo,
  });
}
// Guest adopts the host's authoritative state and lerps balls toward it.
function adoptState(s) {
  if (!s || !Array.isArray(s.balls)) return;
  for (const ib of s.balls) {
    let b = balls.find(x => x.n === ib.n);
    if (!b) { b = { n: ib.n, x: ib.x, y: ib.y, vx: 0, vy: 0, potted: !!ib.p }; balls.push(b); }
    b.tx = ib.x; b.ty = ib.y; b.potted = !!ib.p;
  }
  turn = s.turn; groups = s.groups || { A: null, B: null }; open = !!s.open; broke = !!s.broke;
  const moving = !!s.moving, inhand = !!s.inhand;
  guestInhand = inhand && turn === mySeat;
  updateHud();
  // Make sure the host knows we're here (covers the guest-joined-before-host case).
  if (!_guestAnnounced) { _guestAnnounced = true; if (typeof window.poolSendAction === 'function') window.poolSendAction({ type: 'join' }); }
  if (s.over) { grantOutcome(s.over.winner, s.over.text); return; }
  // A fresh (non-over) state after a finished game = host started a rematch; clear our end card.
  if (_finished) { _finished = false; hideOverlay(); }
  if (moving) { state = 'watch'; setMsg('Balls rolling…'); }
  else if (turn === mySeat) { state = inhand ? 'place' : 'aim'; placing = inhand; setMsg(inhand ? 'Ball in hand — drag the cue ball to place it.' : 'Your shot.'); }
  else { state = 'watch'; setMsg("Opponent's turn…"); }
}
// Host handles a guest's queued action.
function onPoolActionLocal(a) {
  if (!a || mode !== 'room' || !window._isRoomHost || !_built) return;
  if (a.type === 'join') { opponentPresent = true; if (state === 'remote') setMsg("Opponent's turn…"); broadcastState(true); return; }
  if (a.type === 'request') { broadcastState(true); return; }
  if (a.type === 'shot') {
    if (state !== 'remote' || turn !== 'B') return;          // not the guest's turn
    if (a.cuePos) placeCue(a.cuePos.x, a.cuePos.y);
    doShoot(a.dirx, a.diry, a.speed);
  }
}

// ── input (slingshot + ball-in-hand) ─────────────────────────────────────────
function evpos(e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) }; }
function myActiveTurn() { return turn === mySeat; }
function onDown(e) {
  e.preventDefault();
  if (!myActiveTurn()) return;
  if (state === 'place') { const p = evpos(e); placeCue(p.x, p.y); placing = 'drag'; return; }
  if (state !== 'aim') return;
  aiming = { ...evpos(e) };
}
function onMove(e) {
  if (state === 'place' && placing === 'drag') { const p = evpos(e); placeCue(p.x, p.y); return; }
  if (state !== 'aim' || !aiming) return;
  aiming.cx = e.clientX; aiming.cy = e.clientY; aiming.cur = evpos(e);
}
function onUp(e) {
  if (state === 'place' && placing === 'drag') { placing = false; state = 'aim'; setMsg('Drag back from the cue ball to shoot.'); return; }
  if (state !== 'aim' || !aiming) return;
  const cur = evpos(e), cue = cueBall();
  const pull = Math.hypot(cur.x - cue.x, cur.y - cue.y);
  const pwr = Math.min(MAXPULL, pull);
  aiming = null;
  if (pwr < 8) return;
  const dx = cue.x - cur.x, dy = cue.y - cur.y, d = Math.hypot(dx, dy) || 1;
  fireShot(dx / d, dy / d, (pwr / MAXPULL) * MAXSPEED);
}
function fireShot(dirx, diry, speed) {
  if (iAmEngine()) { doShoot(dirx, diry, speed); return; }
  // Guest: hand the shot to the host and wait for streamed frames.
  const cue = cueBall();
  if (typeof window.poolSendAction === 'function') {
    window.poolSendAction({ type: 'shot', dirx, diry, speed, cuePos: guestInhand ? { x: cue.x, y: cue.y } : null });
  }
  guestInhand = false; state = 'watch'; setMsg('Shot sent — waiting…');
}
function placeCue(x, y) {
  const cue = cueBall();
  x = Math.max(LX + R, Math.min(RXn - R, x)); y = Math.max(TY + R, Math.min(BY - R, y));
  for (const b of balls) { if (b === cue || b.potted) continue; if (Math.hypot(b.x - x, b.y - y) < R * 2) return; }
  cue.x = x; cue.y = y;
}

// ── rendering ──────────────────────────────────────────────────────────────
function draw() {
  if (!cx) return;
  cx.fillStyle = '#5a3a1a'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = '#1f8a4c'; cx.fillRect(LX, TY, RXn - LX, BY - TY);
  cx.fillStyle = 'rgba(0,0,0,0.10)'; cx.fillRect(LX, TY, RXn - LX, 5);
  cx.strokeStyle = 'rgba(255,255,255,0.18)'; cx.beginPath(); cx.moveTo(W * 0.26, TY); cx.lineTo(W * 0.26, BY); cx.stroke();
  for (const p of POCKETS) { cx.fillStyle = '#0a0a0a'; cx.beginPath(); cx.arc(p.x, p.y, PR - 2, 0, 7); cx.fill(); }
  if (state === 'aim' && aiming && aiming.cur) {
    const cue = cueBall();
    const dx = cue.x - aiming.cur.x, dy = cue.y - aiming.cur.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const pwr = Math.min(MAXPULL, d) / MAXPULL;
    cx.save(); cx.setLineDash([6, 6]); cx.strokeStyle = 'rgba(255,255,255,0.85)'; cx.lineWidth = 2;
    cx.beginPath(); cx.moveTo(cue.x, cue.y); cx.lineTo(cue.x + ux * 240, cue.y + uy * 240); cx.stroke(); cx.restore();
    cx.strokeStyle = '#d9b06a'; cx.lineWidth = 5; cx.beginPath();
    cx.moveTo(cue.x - ux * 16, cue.y - uy * 16); cx.lineTo(cue.x - ux * (16 + 60 + pwr * 90), cue.y - uy * (16 + 60 + pwr * 90)); cx.stroke();
    cx.fillStyle = '#0008'; cx.fillRect(LX + 6, BY - 16, 120, 8);
    cx.fillStyle = pwr > 0.8 ? '#ff5050' : '#ffd21e'; cx.fillRect(LX + 6, BY - 16, 120 * pwr, 8);
  }
  for (const b of balls) {
    if (b.potted) continue;
    cx.fillStyle = 'rgba(0,0,0,0.28)'; cx.beginPath(); cx.arc(b.x + 1.5, b.y + 2, R, 0, 7); cx.fill();
    cx.fillStyle = tintFor(b.n); cx.beginPath(); cx.arc(b.x, b.y, R, 0, 7); cx.fill();
    if (b.n > 8) { cx.fillStyle = '#f7f7f2'; cx.save(); cx.beginPath(); cx.arc(b.x, b.y, R, 0, 7); cx.clip(); cx.fillRect(b.x - R, b.y - R * 0.42, R * 2, R * 0.84); cx.restore(); }
    if (b.n !== 0) {
      cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(b.x, b.y, R * 0.5, 0, 7); cx.fill();
      cx.fillStyle = '#111'; cx.font = 'bold 8px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(String(b.n), b.x, b.y + 0.5);
    }
    cx.fillStyle = 'rgba(255,255,255,0.5)'; cx.beginPath(); cx.arc(b.x - R * 0.32, b.y - R * 0.34, R * 0.22, 0, 7); cx.fill();
  }
}

// ── UI scaffolding ───────────────────────────────────────────────────────────
function setMsg(t) { if (msgEl) msgEl.textContent = t; }
function isPotted(n) { const b = balls.find(x => x.n === n); return !!(b && b.potted); }
function chip(n) {
  const stripe = n > 8;
  const bg = isPotted(n) ? (stripe ? `#fff` : tintFor(n)) : 'transparent';
  const fg = isPotted(n) ? (stripe ? '#111' : '#fff') : 'rgba(255,255,255,0.35)';
  const ring = isPotted(n) ? tintFor(n) : 'rgba(255,255,255,0.25)';
  const inner = stripe && isPotted(n) ? `<i style="background:${tintFor(n)}"></i>` : '';
  return `<span class="p8-chip${isPotted(n) ? ' sunk' : ''}" style="background:${bg};color:${fg};border-color:${ring}">${inner}<b>${n}</b></span>`;
}
function tray(group, nums) {
  const owner = groups[mySeat] === group ? 'You' : groups[other(mySeat)] === group ? 'Opp' : '';
  const made = nums.filter(isPotted).length;
  const lab = (group === 'solid' ? 'Solids' : 'Stripes') + (owner ? ` · ${owner}` : '');
  return `<div class="p8-tray${owner === 'You' ? ' mine' : ''}"><span class="p8-tray-lab">${lab} ${made}/7</span><span class="p8-tray-balls">${nums.map(chip).join('')}</span></div>`;
}
function updateHud() {
  if (hudEl) {
    const myTurn = turn === mySeat;
    const oppName = mode === 'bot' ? 'Bot' : 'Opponent';
    const g = groups[mySeat] ? (groups[mySeat] === 'solid' ? 'Solids ●' : 'Stripes ◍') : 'Open table';
    hudEl.innerHTML = `<span class="p8-turn ${myTurn ? 'on' : ''}">${myTurn ? '🟢 Your turn' : '🔴 ' + oppName}</span><span class="p8-grp">${g}</span><span class="aq-credits-display">💰 ${credits()}</span>`;
  }
  if (traysEl) {
    const eightChip = `<span class="p8-chip p8-eight${isPotted(8) ? ' sunk' : ''}" style="background:${isPotted(8) ? '#1a1a1a' : 'transparent'};color:${isPotted(8) ? '#fff' : 'rgba(255,255,255,0.35)'};border-color:${isPotted(8) ? '#1a1a1a' : 'rgba(255,255,255,0.25)'}"><b>8</b></span>`;
    traysEl.innerHTML = tray('solid', [1, 2, 3, 4, 5, 6, 7]) + `<span class="p8-trays-mid">${eightChip}</span>` + tray('stripe', [9, 10, 11, 12, 13, 14, 15]);
  }
}
function showOverlay(title, sub, btn, fn) {
  if (!overlayEl) return;
  overlayEl.innerHTML = `<div class="p8-ov-title">${title}</div><div class="p8-ov-sub">${sub}</div><button class="p8-btn">${btn}</button>`;
  overlayEl.querySelector('.p8-btn').onclick = fn;
  overlayEl.style.display = 'flex';
}
// Start screen: choose bot or a room match.
function showStart() {
  state = 'start'; _overInfo = null; _finished = false;
  rack(); turn = 'A'; groups = { A: null, B: null }; open = true; broke = false; mySeat = 'A';
  updateHud();
  if (!overlayEl) return;
  const haveRoom = !!window._currentRoomId;
  const roomNote = haveRoom
    ? (window._isRoomHost ? "You'll host the match — a roommate can join from their table."
      : 'Joins the room host’s table.')
    : 'Join or create a music room first to play someone.';
  overlayEl.innerHTML = `<div class="p8-ov-title">🎱 8-Ball</div>`
    + `<div class="p8-ov-sub">Drag back from the cue ball to aim, release to shoot. Pot your group, then the 8 to win.</div>`
    + `<div class="p8-startbtns"><button class="p8-btn" id="p8-bot">🤖 Play a bot</button>`
    + `<button class="p8-btn" id="p8-room"${haveRoom ? '' : ' disabled'}>👥 Play someone in the room</button></div>`
    + `<div class="p8-ov-note">${roomNote}</div>`;
  overlayEl.style.display = 'flex';
  overlayEl.querySelector('#p8-bot').onclick = startBot;
  const rb = overlayEl.querySelector('#p8-room'); if (rb && haveRoom) rb.onclick = startRoom;
}
function resetCommon() { pottedThisShot = []; firstHit = null; placing = false; aiming = null; _overInfo = null; _finished = false; opponentPresent = false; guestInhand = false; _guestAnnounced = false; }

function startBot() {
  mode = 'bot'; mySeat = 'A'; resetCommon();
  rack(); turn = 'A'; groups = { A: null, B: null }; open = true; broke = false;
  state = 'aim'; hideOverlay(); updateHud();
  setMsg('Break! Drag back from the cue ball and release.');
}
function startRoom() {
  if (!window._currentRoomId) { showStart(); return; }
  mode = 'room'; resetCommon();
  if (window._isRoomHost) {
    mySeat = 'A';
    rack(); turn = 'A'; groups = { A: null, B: null }; open = true; broke = false;
    state = 'aim'; hideOverlay(); updateHud();
    setMsg('Your break — waiting room is open for an opponent.');
    broadcastState(true);
  } else {
    mySeat = 'B'; state = 'watch'; hideOverlay(); updateHud();
    setMsg('Joining the host’s table…');
    if (typeof window.poolSendAction === 'function') { window.poolSendAction({ type: 'join' }); window.poolSendAction({ type: 'request' }); }
  }
}
function hideOverlay() { if (overlayEl) overlayEl.style.display = 'none'; }

function tick(t) {
  const dt = Math.min(0.05, (t - (_lastT || t)) / 1000); _lastT = t;
  if (iAmEngine()) {
    if (state === 'shoot') {
      if (dt > 0) step(dt);
      broadcastState(false);                 // stream rolling balls to the guest
      if (!anyMoving()) resolveShot();
    }
  } else if (state === 'watch') {
    // Guest watching the opponent: smoothly interpolate balls toward the host's
    // last broadcast. (Skip during our own aim/place so cue placement isn't fought.)
    const k = Math.min(1, dt * 12);
    for (const b of balls) { if (b.tx !== undefined) { b.x += (b.tx - b.x) * k; b.y += (b.ty - b.y) * k; } }
  }
  draw();
  raf = requestAnimationFrame(tick);
}

function build() {
  const area = document.getElementById('pool-area');
  if (!area) return;
  area.innerHTML = '';
  hudEl = document.createElement('div'); hudEl.className = 'p8-hud'; area.appendChild(hudEl);
  traysEl = document.createElement('div'); traysEl.className = 'p8-trays'; area.appendChild(traysEl);
  const wrap = document.createElement('div'); wrap.className = 'p8-stage';
  cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.className = 'p8-canvas';
  wrap.appendChild(cv);
  overlayEl = document.createElement('div'); overlayEl.className = 'p8-overlay'; wrap.appendChild(overlayEl);
  area.appendChild(wrap);
  msgEl = document.createElement('div'); msgEl.className = 'p8-status'; area.appendChild(msgEl);

  cx = cv.getContext('2d');
  cv.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  _built = true;
}

function openPool(show = true) {
  const w = document.getElementById('pool-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } clearTimeout(_aiTimer); return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('pool'); window.OS.focus('pool'); }
  if (!_built) build();
  if (state === 'start' || state === 'over') showStart();
  updateHud();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') {
  window.openPool = openPool;
  // Host-authoritative room bridges (no-ops unless a room game is active).
  window.onPoolState = function (s) { if (mode === 'room' && !window._isRoomHost && _built) adoptState(s); };
  window.onPoolAction = function (a) { onPoolActionLocal(a); };
}
