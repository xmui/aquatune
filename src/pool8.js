// Aquatune 8-Ball — GamePigeon-style pool with a Windows-2000s window dressing.
//
// Top-down felt table, slingshot aiming (drag back from the cue ball to set
// direction + power, release to strike), equal-mass ball physics, six pockets and
// full 8-ball rules (open table → group assignment, scratch = ball-in-hand, sink
// the 8 last to win). You play solids/stripes vs a simple AI. Winning grants
// Intellect XP; your best run posts to the leaderboard.

const W = 700, H = 380;                 // logical canvas (CSS-scaled)
const M = 30;                           // cushion margin
const R = 10.5;                         // ball radius
const PR = 17;                          // pocket capture radius
const LX = M, RXn = W - M, TY = M, BY = H - M;   // playfield bounds
const MAXPULL = 150, MAXSPEED = 1150;   // slingshot pull → launch speed
const DECEL = 430, REST = 0.92;         // rolling friction (px/s²), cushion restitution
const STOP = 6;                         // speed below which a ball is "stopped"

const POCKETS = [
  { x: LX, y: TY }, { x: W / 2, y: TY - 3 }, { x: RXn, y: TY },
  { x: LX, y: BY }, { x: W / 2, y: BY + 3 }, { x: RXn, y: BY },
];
// ball tints (1..7 solids; 9..15 are the striped versions of 1..7; 8 black; 0 cue)
const TINT = { 1: '#f4c20d', 2: '#1f57d6', 3: '#d62828', 4: '#7b2fb5', 5: '#e87a17', 6: '#1f8a4c', 7: '#7a1f2b', 8: '#1a1a1a' };
function tintFor(n) { return n === 0 ? '#f7f7f2' : (n <= 8 ? TINT[n] : TINT[n - 8]); }
function groupOf(n) { return n === 0 ? 'cue' : n === 8 ? 'eight' : (n <= 7 ? 'solid' : 'stripe'); }

let cv = null, cx = null, raf = null, _built = false, _lastT = 0;
let balls = [], state = 'start';        // start | aim | shoot | place | ai | over
let aiming = null, placing = false;
let turn = 'you', groups = { you: null, ai: null }, open = true, broke = false;
let pottedThisShot = [], firstHit = null, cueStruck = false;
let msgEl = null, hudEl = null, traysEl = null, overlayEl = null, _aiTimer = null;

function sfx(n) { try { window.poolSfx && window.poolSfx(n); } catch (e) {} }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }

// ── setup ──────────────────────────────────────────────────────────────────
function rack() {
  balls = [];
  balls.push({ n: 0, x: W * 0.26, y: H / 2, vx: 0, vy: 0, potted: false });   // cue
  // triangle at the foot spot; 8 fixed in the centre, corners a solid + a stripe.
  const order = [1, 9, 2, 10, 8, 11, 3, 12, 4, 13, 5, 14, 6, 15, 7];
  const rest = [9, 10, 11, 12, 13, 14, 1, 2, 3, 4, 5, 6, 7];
  for (let i = rest.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[rest[i], rest[j]] = [rest[j], rest[i]]; }
  const apexX = W * 0.72, dx = R * 1.74, dy = R * 1.02;
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
    // pockets
    for (const b of balls) {
      if (b.potted) continue;
      for (const p of POCKETS) { if (Math.hypot(b.x - p.x, b.y - p.y) < PR) { potBall(b); break; } }
    }
    // cushions
    for (const b of balls) {
      if (b.potted) continue;
      if (b.x < LX + R) { b.x = LX + R; b.vx = Math.abs(b.vx) * REST; cushion(b); }
      else if (b.x > RXn - R) { b.x = RXn - R; b.vx = -Math.abs(b.vx) * REST; cushion(b); }
      if (b.y < TY + R) { b.y = TY + R; b.vy = Math.abs(b.vy) * REST; cushion(b); }
      else if (b.y > BY - R) { b.y = BY - R; b.vy = -Math.abs(b.vy) * REST; cushion(b); }
    }
    // ball-ball
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i]; if (a.potted) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const c = balls[j]; if (c.potted) continue;
        const dx = c.x - a.x, dy = c.y - a.y; let d = Math.hypot(dx, dy);
        if (d > 0 && d < R * 2) {
          const nx = dx / d, ny = dy / d, overlap = R * 2 - d;
          a.x -= nx * overlap / 2; a.y -= ny * overlap / 2; c.x += nx * overlap / 2; c.y += ny * overlap / 2;
          const av = a.vx * nx + a.vy * ny, cvv = c.vx * nx + c.vy * ny, p = av - cvv;
          if (p > 0) {
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

// ── shooting + turn flow ─────────────────────────────────────────────────────
function shoot(dirx, diry, speed) {
  const cue = cueBall(); if (!cue) return;
  cue.vx = dirx * speed; cue.vy = diry * speed;
  pottedThisShot = []; firstHit = null; cueStruck = true;
  state = 'shoot'; setMsg('');
}
function resolveShot() {
  const cue = cueBall();
  const scratch = cue.potted;
  const shooter = turn;
  const opp = shooter === 'you' ? 'ai' : 'you';
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

  // 8-ball outcomes: you only win by sinking the 8 cleanly AFTER clearing your
  // group (and not scratching). Anything else loses.
  if (eight) {
    const clearedGroup = myGroup && liveOf(myGroup).length === 0;   // post-shot state
    if (myGroup && clearedGroup && !scratch) endGame(shooter, 'You sank the 8 — you win!');
    else endGame(opp, scratch ? 'Scratch on the 8 — you lose!' : 'Sank the 8 too early!');
    return;
  }

  // Fouls (ball-in-hand to the opponent): scratch, no contact, or hitting the
  // wrong ball first (opponent's group / the 8 before you're on it).
  let foul = false, reason = '';
  if (scratch) { foul = true; reason = 'Scratch! Ball in hand.'; }
  else if (firstHit == null) { foul = true; reason = 'No ball hit — ball in hand.'; }
  else if (!open && myGroup) {
    const onEight = liveOf(myGroup).length === 0;
    const legalFirst = onEight ? (firstHit === 8) : (groupOf(firstHit) === myGroup);
    if (!legalFirst) { foul = true; reason = (firstHit === 8 ? 'Hit the 8 too early' : 'Hit the wrong group') + ' — ball in hand.'; }
  } else if (open && firstHit === 8) { foul = true; reason = 'Hit the 8 first — ball in hand.'; }

  const legalOwn = !foul && myGroup && potted.some(n => groupOf(n) === myGroup);

  if (foul) { if (scratch) respotCue(); switchTurn(true, reason); }
  else if (legalOwn) keepTurn();
  else switchTurn(false);
}
function respotCue() {
  const cue = cueBall();
  cue.potted = false; cue.vx = cue.vy = 0; cue.x = W * 0.26; cue.y = H / 2;
  // nudge out of any overlap
  for (let k = 0; k < 40; k++) { let hit = false; for (const b of balls) { if (b === cue || b.potted) continue; if (Math.hypot(b.x - cue.x, b.y - cue.y) < R * 2 + 1) { cue.x -= 6; hit = true; } } if (!hit) break; }
}
function keepTurn() {
  broke = true;
  if (turn === 'ai') { state = 'ai'; scheduleAi(); } else { state = 'aim'; }
  updateHud();
  setMsg(turn === 'you' ? 'Nice — go again.' : 'Opponent pots and continues…');
}
function switchTurn(foul, reason) {
  broke = true;
  turn = turn === 'you' ? 'ai' : 'you';
  updateHud();
  if (turn === 'ai') { state = 'ai'; scheduleAi(); setMsg(reason ? (reason.replace('Ball in hand', 'Opponent gets ball in hand')) : 'Opponent shooting…'); }
  else { state = foul ? 'place' : 'aim'; placing = foul; setMsg(foul ? (reason || 'Ball in hand') + ' Drag the cue ball to place it.' : 'Your shot.'); }
}
function endGame(winner, text) {
  state = 'over';
  const youWon = winner === 'you';
  if (youWon) { if (window.aqAddCredits) window.aqAddCredits(40); }
  if (window.aqGameXp) window.aqGameXp('intellect', { played: true, won: youWon, mult: youWon ? 1.6 : 0.5 });
  if (window.recordScore) window.recordScore('pool8', youWon ? 1 : 0, youWon ? 'win' : 'loss');
  sfx(youWon ? 'win' : 'lose');
  showOverlay(youWon ? '🎱 You win!' : '🎱 You lose', text + (youWon ? '  +40💰' : ''), 'Rack again', startGame);
}

// ── AI ───────────────────────────────────────────────────────────────────────
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
  const cue = cueBall(); if (!cue) return;
  let targets;
  if (groups.ai) targets = liveOf(groups.ai);
  else targets = balls.filter(b => !b.potted && b.n !== 0 && b.n !== 8);
  if (groups.ai && targets.length === 0) targets = balls.filter(b => !b.potted && b.n === 8);
  if (!targets.length) targets = balls.filter(b => !b.potted && b.n !== 0);

  let best = null;
  for (const ball of targets) {
    for (const p of POCKETS) {
      const bp = Math.hypot(p.x - ball.x, p.y - ball.y);
      const toP = { x: (p.x - ball.x) / bp, y: (p.y - ball.y) / bp };
      const ghost = { x: ball.x - toP.x * R * 2, y: ball.y - toP.y * R * 2 };
      const cg = Math.hypot(ghost.x - cue.x, ghost.y - cue.y);
      const aim = { x: (ghost.x - cue.x) / cg, y: (ghost.y - cue.y) / cg };
      const cut = aim.x * toP.x + aim.y * toP.y;               // how square the hit is
      if (cut < 0.25) continue;                                 // too thin to make
      if (!pathClear(cue.x, cue.y, ghost.x, ghost.y, [ball]) || !pathClear(ball.x, ball.y, p.x, p.y, [])) continue;
      const score = cut * 2 - (cg + bp) / 900;
      if (!best || score > best.score) best = { score, aim, dist: cg + bp };
    }
  }
  if (!best) {                                                   // safety: nudge toward nearest target
    const t = targets[0]; const d = Math.hypot(t.x - cue.x, t.y - cue.y);
    best = { aim: { x: (t.x - cue.x) / d, y: (t.y - cue.y) / d }, dist: d };
  }
  // miss model: a little angular error
  const err = (Math.random() - 0.5) * 0.09;
  const ca = Math.cos(err), sa = Math.sin(err);
  const ax = best.aim.x * ca - best.aim.y * sa, ay = best.aim.x * sa + best.aim.y * ca;
  const speed = Math.min(MAXSPEED, 360 + best.dist * 1.15);
  shoot(ax, ay, speed);
}

// ── input (slingshot + ball-in-hand) ─────────────────────────────────────────
function evpos(e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) }; }
function onDown(e) {
  e.preventDefault();
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
  if (state === 'place' && placing === 'drag') { placing = false; state = 'aim'; setMsg('Your shot.'); return; }
  if (state !== 'aim' || !aiming) return;
  const cur = evpos(e), cue = cueBall();
  const pull = Math.hypot(cur.x - cue.x, cur.y - cue.y);
  const pwr = Math.min(MAXPULL, pull);
  aiming = null;
  if (pwr < 8) return;                                          // too gentle / a tap
  const dx = cue.x - cur.x, dy = cue.y - cur.y, d = Math.hypot(dx, dy) || 1;
  shoot(dx / d, dy / d, (pwr / MAXPULL) * MAXSPEED);
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
  // wood rail
  cx.fillStyle = '#5a3a1a'; cx.fillRect(0, 0, W, H);
  // felt
  cx.fillStyle = '#1f8a4c'; cx.fillRect(LX, TY, RXn - LX, BY - TY);
  cx.fillStyle = 'rgba(0,0,0,0.10)'; cx.fillRect(LX, TY, RXn - LX, 5);
  // head string + spot
  cx.strokeStyle = 'rgba(255,255,255,0.18)'; cx.beginPath(); cx.moveTo(W * 0.26, TY); cx.lineTo(W * 0.26, BY); cx.stroke();
  // pockets
  for (const p of POCKETS) { cx.fillStyle = '#0a0a0a'; cx.beginPath(); cx.arc(p.x, p.y, PR - 2, 0, 7); cx.fill(); }
  // aim guide
  if (state === 'aim' && aiming && aiming.cur) {
    const cue = cueBall();
    const dx = cue.x - aiming.cur.x, dy = cue.y - aiming.cur.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    const pwr = Math.min(MAXPULL, d) / MAXPULL;
    // dashed projection
    cx.save(); cx.setLineDash([6, 6]); cx.strokeStyle = 'rgba(255,255,255,0.85)'; cx.lineWidth = 2;
    cx.beginPath(); cx.moveTo(cue.x, cue.y); cx.lineTo(cue.x + ux * 240, cue.y + uy * 240); cx.stroke(); cx.restore();
    // pull-back stick
    cx.strokeStyle = '#d9b06a'; cx.lineWidth = 5; cx.beginPath();
    cx.moveTo(cue.x - ux * 16, cue.y - uy * 16); cx.lineTo(cue.x - ux * (16 + 60 + pwr * 90), cue.y - uy * (16 + 60 + pwr * 90)); cx.stroke();
    // power bar
    cx.fillStyle = '#0008'; cx.fillRect(LX + 6, BY - 16, 120, 8);
    cx.fillStyle = pwr > 0.8 ? '#ff5050' : '#ffd21e'; cx.fillRect(LX + 6, BY - 16, 120 * pwr, 8);
  }
  // balls
  for (const b of balls) {
    if (b.potted) continue;
    cx.fillStyle = 'rgba(0,0,0,0.28)'; cx.beginPath(); cx.arc(b.x + 1.5, b.y + 2, R, 0, 7); cx.fill();
    cx.fillStyle = tintFor(b.n); cx.beginPath(); cx.arc(b.x, b.y, R, 0, 7); cx.fill();
    if (b.n > 8) { cx.fillStyle = '#f7f7f2'; cx.fillRect(b.x - R, b.y - R * 0.42, R * 2, R * 0.84); cx.fillStyle = tintFor(b.n); cx.beginPath(); cx.arc(b.x, b.y, R, 0, 7); cx.save(); cx.clip(); cx.fillRect(b.x - R, b.y - R * 0.42, R * 2, R * 0.84); cx.restore(); }
    if (b.n !== 0) { // number disc
      cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(b.x, b.y, R * 0.5, 0, 7); cx.fill();
      cx.fillStyle = '#111'; cx.font = 'bold 8px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(String(b.n), b.x, b.y + 0.5);
    }
    // gloss
    cx.fillStyle = 'rgba(255,255,255,0.5)'; cx.beginPath(); cx.arc(b.x - R * 0.32, b.y - R * 0.34, R * 0.22, 0, 7); cx.fill();
  }
}

// ── UI scaffolding ───────────────────────────────────────────────────────────
function setMsg(t) { if (msgEl) msgEl.textContent = t; }
function isPotted(n) { const b = balls.find(x => x.n === n); return !!(b && b.potted); }
function chip(n) {
  const stripe = n > 8;
  const bg = isPotted(n)
    ? (stripe ? `#fff` : tintFor(n))
    : 'transparent';
  const fg = isPotted(n) ? (stripe ? '#111' : '#fff') : 'rgba(255,255,255,0.35)';
  const ring = isPotted(n) ? tintFor(n) : 'rgba(255,255,255,0.25)';
  const inner = stripe && isPotted(n) ? `<i style="background:${tintFor(n)}"></i>` : '';
  return `<span class="p8-chip${isPotted(n) ? ' sunk' : ''}" style="background:${bg};color:${fg};border-color:${ring}">${inner}<b>${n}</b></span>`;
}
function tray(group, nums) {
  const owner = groups.you === group ? 'You' : groups.ai === group ? 'Opp' : '';
  const made = nums.filter(isPotted).length;
  const lab = (group === 'solid' ? 'Solids' : 'Stripes') + (owner ? ` · ${owner}` : '');
  return `<div class="p8-tray${owner === 'You' ? ' mine' : ''}"><span class="p8-tray-lab">${lab} ${made}/7</span><span class="p8-tray-balls">${nums.map(chip).join('')}</span></div>`;
}
function updateHud() {
  if (hudEl) {
    const g = groups.you ? (groups.you === 'solid' ? 'Solids ●' : 'Stripes ◍') : 'Open table';
    hudEl.innerHTML = `<span class="p8-turn ${turn === 'you' ? 'on' : ''}">${turn === 'you' ? '🟢 Your turn' : '🔴 Opponent'}</span><span class="p8-grp">${g}</span><span class="aq-credits-display">💰 ${credits()}</span>`;
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
function hideOverlay() { if (overlayEl) overlayEl.style.display = 'none'; }

function tick(t) {
  const dt = Math.min(0.05, (t - (_lastT || t)) / 1000); _lastT = t;
  if (state === 'shoot') {
    if (dt > 0) step(dt);
    if (!anyMoving()) resolveShot();
  }
  draw();
  raf = requestAnimationFrame(tick);
}

function startGame() {
  rack(); turn = 'you'; groups = { you: null, ai: null }; open = true; broke = false;
  pottedThisShot = []; firstHit = null; placing = false; aiming = null;
  state = 'aim'; hideOverlay(); updateHud();
  setMsg('Break! Drag back from the cue ball and release.');
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
  if (state === 'start' || state === 'over') { rack(); state = 'start'; showOverlay('🎱 8-Ball', 'Drag back from the cue ball to aim, release to shoot. Pot your solids/stripes, then the 8 to win.', 'Break', startGame); }
  updateHud();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') { window.openPool = openPool; }
