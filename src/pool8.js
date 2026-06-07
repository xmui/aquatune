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
const POCKET_R = 16;                    // pocket geometric/capture radius
const CAPTURE_R = 23;                   // a ball whose CENTRE is within this of a pocket drops
const MOUTH_R = POCKET_R + R + 4;       // near a pocket mouth the rail shouldn't deflect a ball
const LX = M, RXn = W - M, TY = M, BY = H - M;   // playfield bounds
const MAXSPEED = 1550;   // full-power launch speed (power slider scales 0..1 of this)
// Two-phase felt friction (px/s²): a struck ball SLIDES (kinetic) until its roll
// speed catches up (v = r·ω), then ROLLS to a stop. Real pool balls roll FAR (low
// rolling friction) — the old "ice" was the overshoot bug, not low friction, so the
// earlier over-corrected values (1500/250) killed the break. These give a powerful
// break (cue reaches the rack at ~86% of launch) and lively shots while still
// settling in a few seconds (verified by sim: full shot ~6.6 table-widths).
const SLIDE_DECEL = 900;                // kinetic (sliding) friction
const ROLL_DECEL = 170;                 // rolling resistance
const SPINUP = 2.5;                     // a solid sphere spins up at 2.5× the linear decel
const CUSHION_REST = 0.68;              // cushion coefficient of restitution (<1, lossy)
const BALL_REST = 0.96;                 // ball-ball restitution
const STOP = 9;                         // speed below which a ball is "stopped"
const STREAM_MS = 90;                   // host → guest state stream throttle

const POCKETS = [
  { x: LX, y: TY }, { x: W / 2, y: TY - 3, mid: 'top' }, { x: RXn, y: TY },
  { x: LX, y: BY }, { x: W / 2, y: BY + 3, mid: 'bot' }, { x: RXn, y: BY },
];
// ball tints (1..7 solids; 9..15 are the striped versions of 1..7; 8 black; 0 cue)
const TINT = { 1: '#f4c20d', 2: '#1f57d6', 3: '#d62828', 4: '#7b2fb5', 5: '#e87a17', 6: '#1f8a4c', 7: '#7a1f2b', 8: '#1a1a1a' };
function tintFor(n) { return n === 0 ? '#f7f7f2' : (n <= 8 ? TINT[n] : TINT[n - 8]); }
// darken (amt<0) / lighten (amt>0) a #rrggbb hex by a fraction
function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex); if (!m) return hex;
  const v = parseInt(m[1], 16); let r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + (amt < 0 ? c : 255 - c) * amt)));
  r = f(r); g = f(g); b = f(b);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function groupOf(n) { return n === 0 ? 'cue' : n === 8 ? 'eight' : (n <= 7 ? 'solid' : 'stripe'); }
function other(seat) { return seat === 'A' ? 'B' : 'A'; }

let cv = null, cx = null, raf = null, _built = false, _lastT = 0, _rotated = false;
let balls = [], state = 'start';        // start | aim | shoot | place | ai | remote | watch | over
let aiming = null, placing = false;
let aimDir = { x: 1, y: 0 };            // current aim direction (the cue ball will travel this way)
let power = 0.5;                        // 0..1 shot power, set by the side slider
let powerEl = null, _powerDragging = false;
let _strikeT = 0, _pendingFire = null, striking = false;   // cue-stick strike animation → fire
const STRIKE_MS = 130;
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
  balls.push({ n: 0, x: W * 0.26, y: H / 2, vx: 0, vy: 0, rvx: 0, rvy: 0, potted: false });   // cue
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
      balls.push({ n, x, y, vx: 0, vy: 0, rvx: 0, rvy: 0, potted: false });
    }
  }
}
function cueBall() { return balls.find(b => b.n === 0); }
function liveOf(group) { return balls.filter(b => !b.potted && groupOf(b.n) === group); }

// ── physics ────────────────────────────────────────────────────────────────
// A ball is "in play and moving" if it has speed OR is mid-drop into a pocket.
function anyMoving() {
  return balls.some(b => !b.potted && (b.sink !== undefined || (b.vx * b.vx + b.vy * b.vy) > STOP * STOP || (b.rvx * b.rvx + b.rvy * b.rvy) > STOP * STOP));
}
// True when a ball is in a pocket's mouth — used to suppress the rail bounce there.
function nearPocketMouth(b) {
  for (const p of POCKETS) if (Math.hypot(b.x - p.x, b.y - p.y) < MOUTH_R) return true;
  return false;
}

// Two-phase friction: kinetic while the ball SLIDES (contact point slips), then
// rolling once linear velocity matches the roll velocity rv (= r·ω). This is what
// gives a real "skid then grip" feel instead of a uniform `v *= 0.98` slide.
function applyFriction(b, dt) {
  const sp = Math.hypot(b.vx, b.vy);
  const sx = b.vx - b.rvx, sy = b.vy - b.rvy, slip = Math.hypot(sx, sy);
  // The slip closes by `reduce` each step; gate on THAT (not a tiny constant) so a
  // fast ball can't leap the threshold and oscillate in the slide phase forever —
  // that overshoot bug is what made the table feel like ice (balls never started
  // rolling, so they never decelerated).
  const reduce = SLIDE_DECEL * (1 + SPINUP) * dt;
  if (slip > reduce) {                  // SLIDING: kinetic friction opposes the slip
    const ux = sx / slip, uy = sy / slip;
    b.vx -= ux * SLIDE_DECEL * dt; b.vy -= uy * SLIDE_DECEL * dt;          // linear slows
    b.rvx += ux * SLIDE_DECEL * SPINUP * dt; b.rvy += uy * SLIDE_DECEL * SPINUP * dt; // roll spins up
  } else {                              // ROLLING: lock roll to linear, resistance only
    const ns = Math.max(0, sp - ROLL_DECEL * dt);
    if (sp > 0) { b.vx = b.vx / sp * ns; b.vy = b.vy / sp * ns; }
    b.rvx = b.vx; b.rvy = b.vy;
    if (ns < STOP) { b.vx = b.vy = b.rvx = b.rvy = 0; }
  }
}

// Soft-drop "gravity well": once a ball reaches a pocket mouth it gets sucked to
// the centre, shrinking (b.sink 1→0) as it falls in, then is marked potted.
function stepSink(b, dt) {
  const dx = b.sx - b.x, dy = b.sy - b.y, d = Math.hypot(dx, dy) || 1;
  b.vx += (dx / d) * 2000 * dt; b.vy += (dy / d) * 2000 * dt;   // pulled toward the hole
  b.vx *= 0.86; b.vy *= 0.86;                                   // decelerate rapidly
  b.x += b.vx * dt; b.y += b.vy * dt;
  b.sink -= dt * 3.4;                                           // scale down as it drops
  if (b.sink <= 0.12 || d < 2) potBall(b);
}

function step(dt) {
  // Substep count scales with the fastest ball so a hard break never tunnels a
  // ball straight through another (continuous-ish collision on a cheap budget).
  let vmax = 0; for (const b of balls) { if (!b.potted) { const v = Math.hypot(b.vx, b.vy); if (v > vmax) vmax = v; } }
  const SUB = Math.max(4, Math.min(20, Math.ceil(vmax * dt / (R * 0.55)))), sdt = dt / SUB;
  for (let s = 0; s < SUB; s++) {
    // movement + friction (sinking balls follow their own well dynamics)
    for (const b of balls) {
      if (b.potted) continue;
      if (b.sink !== undefined) { stepSink(b, sdt); continue; }
      applyFriction(b, sdt);
      b.x += b.vx * sdt; b.y += b.vy * sdt;
    }
    // pocket capture (gravity well begins at the mouth, before the cushion clamp)
    for (const b of balls) {
      if (b.potted || b.sink !== undefined) continue;
      for (const p of POCKETS) {
        const dxp = b.x - p.x, dyp = b.y - p.y;
        if (dxp * dxp + dyp * dyp >= CAPTURE_R * CAPTURE_R) continue;
        // Side pockets only swallow a ball that has crossed the rail line INTO the
        // throat — not one skimming straight along the rail edge past the pocket.
        if (p.mid === 'top' && b.y > TY) continue;
        if (p.mid === 'bot' && b.y < BY) continue;
        b.sink = 1; b.sx = p.x; b.sy = p.y; break;
      }
    }
    // cushions (restitution < 1 — balls bleed speed off the rails). A ball inside a
    // pocket's mouth is NOT clamped, so it rolls into the jaws and drops instead of
    // bouncing off the rail right next to the hole — that's what made pockets feel off.
    for (const b of balls) {
      if (b.potted || b.sink !== undefined || nearPocketMouth(b)) continue;
      if (b.x < LX + R) { b.x = LX + R; b.vx = Math.abs(b.vx) * CUSHION_REST; b.rvx *= CUSHION_REST; cushion(b); }
      else if (b.x > RXn - R) { b.x = RXn - R; b.vx = -Math.abs(b.vx) * CUSHION_REST; b.rvx *= CUSHION_REST; cushion(b); }
      if (b.y < TY + R) { b.y = TY + R; b.vy = Math.abs(b.vy) * CUSHION_REST; b.rvy *= CUSHION_REST; cushion(b); }
      else if (b.y > BY - R) { b.y = BY - R; b.vy = -Math.abs(b.vy) * CUSHION_REST; b.rvy *= CUSHION_REST; cushion(b); }
    }
    // ball-ball: static (position) resolution FIRST, then 2D elastic on normal/tangent
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i]; if (a.potted || a.sink !== undefined) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const c = balls[j]; if (c.potted || c.sink !== undefined) continue;
        const dx = c.x - a.x, dy = c.y - a.y; const d = Math.hypot(dx, dy);
        if (d > 0 && d < R * 2) {
          const nx = dx / d, ny = dy / d;       // collision normal
          const tx = -ny, ty = nx;              // collision tangent
          // (1) push the pair apart along the normal so they never clump/clip
          const overlap = R * 2 - d;
          a.x -= nx * overlap / 2; a.y -= ny * overlap / 2; c.x += nx * overlap / 2; c.y += ny * overlap / 2;
          // (2) decompose velocities, exchange the normal components (equal mass + restitution)
          const an = a.vx * nx + a.vy * ny, at = a.vx * tx + a.vy * ty;
          const cn = c.vx * nx + c.vy * ny, ct = c.vx * tx + c.vy * ty;
          if (an - cn > 0) {                    // only if actually approaching
            const e = BALL_REST;
            const an2 = ((1 - e) * an + (1 + e) * cn) / 2;
            const cn2 = ((1 + e) * an + (1 - e) * cn) / 2;
            a.vx = an2 * nx + at * tx; a.vy = an2 * ny + at * ty;
            c.vx = cn2 * nx + ct * tx; c.vy = cn2 * ny + ct * ty;
            // No-spin (GamePigeon) model: a collision kills the rolling contact, so
            // both balls skid-then-roll from their POST-impact velocity. The cue thus
            // stops on a full hit and deflects ~90° along the tangent on a cut, instead
            // of carrying its old forward roll into an unwanted follow.
            a.rvx = a.rvy = 0; c.rvx = c.rvy = 0;
            if (!firstHit && (a.n === 0 || c.n === 0)) firstHit = (a.n === 0 ? c.n : a.n);
            const impact = an - cn;
            if (impact > 60) sfx(impact > 420 ? 'break' : 'hit');
          }
        }
      }
    }
  }
}
let _cushAt = 0;
function cushion(b) { const now = performance.now(); if (now - _cushAt > 40) { _cushAt = now; sfx('wall'); } }
function potBall(b) {
  b.potted = true; b.vx = b.vy = b.rvx = b.rvy = 0; delete b.sink; pottedThisShot.push(b.n); sfx('pocket');
  updateHud();   // refresh the sunk-balls trays the moment a ball drops
}

// ── shooting + turn flow (engine side) ───────────────────────────────────────
function doShoot(dirx, diry, speed) {
  const cue = cueBall(); if (!cue) return;
  cue.vx = dirx * speed; cue.vy = diry * speed;
  cue.rvx = cue.rvy = 0;                 // struck ball starts sliding (no roll yet)
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
  cue.potted = false; cue.vx = cue.vy = cue.rvx = cue.rvy = 0; delete cue.sink; cue.x = W * 0.26; cue.y = H / 2;
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
  if (youWon && window.aqGameAnnounce) window.aqGameAnnounce(mode === 'bot' ? 'beat the 8-Ball bot 🎱' : 'won an 8-Ball match in the room! 🎱');
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
  if (!targets.length) return;

  // Score EVERY ball→pocket attempt and take the best one — penalising thin cuts and
  // blocked paths rather than discarding them. This means the bot always aims a real
  // ball at a real pocket (its best available pot) instead of falling back to a
  // direction-less centre hit, which looked like a random shot.
  let best = null;
  for (const ball of targets) {
    for (const p of POCKETS) {
      const bp = Math.hypot(p.x - ball.x, p.y - ball.y) || 1;
      const toP = { x: (p.x - ball.x) / bp, y: (p.y - ball.y) / bp };
      const ghost = { x: ball.x - toP.x * R * 2, y: ball.y - toP.y * R * 2 };
      const cg = Math.hypot(ghost.x - cue.x, ghost.y - cue.y) || 1;
      const aim = { x: (ghost.x - cue.x) / cg, y: (ghost.y - cue.y) / cg };
      const cut = aim.x * toP.x + aim.y * toP.y;                 // 1 = dead straight, <0 = behind
      let score = cut * 2 - (cg + bp) / 900;
      if (cut < 0.2) score -= 6;                                 // near-impossible cut angle
      if (!pathClear(cue.x, cue.y, ghost.x, ghost.y, [ball])) score -= 4;   // cue path blocked
      if (!pathClear(ball.x, ball.y, p.x, p.y, [])) score -= 3;             // pocket path blocked
      if (!best || score > best.score) best = { score, aim, dist: cg + bp };
    }
  }
  if (!best) return;
  // a confident pot is aimed accurately; a desperate one wobbles a bit more
  const err = (Math.random() - 0.5) * (best.score > 0 ? 0.05 : 0.09);
  const ca = Math.cos(err), sa = Math.sin(err);
  const ax = best.aim.x * ca - best.aim.y * sa, ay = best.aim.x * sa + best.aim.y * ca;
  const speed = Math.min(MAXSPEED, 430 + best.dist * 1.5);
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
function evpos(e) {
  const r = cv.getBoundingClientRect();
  if (_rotated) {
    // Canvas is shown rotated 90° CW for portrait; invert the rotation to recover
    // logical table coords. A 90° CW screen rotation maps (dx,dy) → local (dy,-dx),
    // and the pre-rotation display box is (height × width) of the on-screen AABB.
    const cxp = r.left + r.width / 2, cyp = r.top + r.height / 2;
    const dx = e.clientX - cxp, dy = e.clientY - cyp;
    const lx = dy, ly = -dx, dispW = r.height, dispH = r.width;
    return { x: (lx / dispW + 0.5) * W, y: (ly / dispH + 0.5) * H };
  }
  return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
}
function myActiveTurn() { return turn === mySeat; }
// Aim by dragging the cue STICK around the ball (circle it to set the angle): the ball
// travels OPPOSITE your drag, like pulling the stick back behind it. Power is the slider.
function aimAt(p) {
  const cue = cueBall(); if (!cue) return;
  const dx = cue.x - p.x, dy = cue.y - p.y, d = Math.hypot(dx, dy);
  if (d > 4) { aimDir = { x: dx / d, y: dy / d }; }
}
function onDown(e) {
  e.preventDefault();
  if (!myActiveTurn() || striking) return;
  if (state === 'place') { const p = evpos(e); placeCue(p.x, p.y); placing = 'drag'; return; }
  if (state !== 'aim') return;
  aiming = true; aimAt(evpos(e));
}
function onMove(e) {
  if (state === 'place' && placing === 'drag') { const p = evpos(e); placeCue(p.x, p.y); return; }
  if (state !== 'aim' || !aiming) return;
  aimAt(evpos(e));
}
function onUp(e) {
  if (state === 'place' && placing === 'drag') { placing = false; state = 'aim'; setMsg('Drag the stick around the cue ball to aim, then drag the Power slider and release to shoot.'); return; }
  aiming = false;   // releasing the table just locks the aim — the slider fires the shot
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

// ── power slider → cue-stick strike → fire ───────────────────────────────────
function canShoot() { return myActiveTurn() && state === 'aim' && !striking; }
function setPowerFromClientY(clientY) {
  const track = powerEl && powerEl.querySelector('.p8-power-track'); if (!track) return;
  const r = track.getBoundingClientRect();
  power = Math.max(0, Math.min(1, (clientY - r.top) / (r.height || 1)));   // slide DOWN → more power
  updatePowerUI();
}
function updatePowerUI() {
  if (!powerEl) return;
  const on = canShoot() || _powerDragging || striking;   // only visible on your shot
  powerEl.classList.toggle('disabled', !on);
  const fill = powerEl.querySelector('.p8-power-fill'), knob = powerEl.querySelector('.p8-power-knob');
  if (fill) fill.style.height = (power * 100) + '%';     // fills from the top down as you charge
  if (knob) knob.style.top = (power * 100) + '%';
}
function onPowerDown(e) {
  if (!canShoot()) return;
  e.preventDefault(); _powerDragging = true; setPowerFromClientY(e.clientY);
}
function onPowerMove(e) { if (_powerDragging) setPowerFromClientY(e.clientY); }
function onPowerUp() {
  if (!_powerDragging) return;
  _powerDragging = false;
  if (canShoot() && power >= 0.06) triggerStrike();   // release the slider → strike the cue ball
  else updatePowerUI();
}
// Animate the cue stick lunging into the ball, then fire at the slider's power.
function triggerStrike() {
  striking = true; _strikeT = performance.now();
  _pendingFire = { x: aimDir.x, y: aimDir.y, speed: power * MAXSPEED };
  setMsg(''); updatePowerUI();
}

// ── rendering (2000s MSN-Zone skeuomorphism) ─────────────────────────────────
function drawTable() {
  // wooden rail surround (beveled walnut)
  const rail = cx.createLinearGradient(0, 0, 0, H);
  rail.addColorStop(0, '#6b3f1d'); rail.addColorStop(0.5, '#4d2c12'); rail.addColorStop(1, '#36200d');
  cx.fillStyle = rail; cx.fillRect(0, 0, W, H);
  cx.fillStyle = 'rgba(255,255,255,0.10)'; cx.fillRect(0, 0, W, 3);
  cx.fillStyle = 'rgba(0,0,0,0.35)'; cx.fillRect(0, H - 3, W, 3);
  // felt: radial gradient as if an overhead lamp lit the top-middle
  const felt = cx.createRadialGradient(W / 2, TY + 24, 30, W / 2, H / 2, Math.hypot(W, H) / 1.45);
  felt.addColorStop(0, '#0aa84a'); felt.addColorStop(0.45, '#008f39'); felt.addColorStop(1, '#003311');
  cx.fillStyle = felt; cx.fillRect(LX, TY, RXn - LX, BY - TY);
  // inner rail shadow (felt sits in a recess)
  cx.save(); cx.strokeStyle = 'rgba(0,0,0,0.40)'; cx.lineWidth = 6; cx.strokeRect(LX + 3, TY + 3, RXn - LX - 6, BY - TY - 6); cx.restore();
  // head string
  cx.strokeStyle = 'rgba(255,255,255,0.12)'; cx.lineWidth = 1; cx.beginPath(); cx.moveTo(W * 0.26, TY); cx.lineTo(W * 0.26, BY); cx.stroke();
  for (const p of POCKETS) drawPocket(p);
}
function drawPocket(p) {
  // Corner pockets are round; SIDE pockets are a wider, flatter mouth cut into the rail
  // (like a real table / GamePigeon) rather than a full circle.
  const rx = p.mid ? POCKET_R + 5 : POCKET_R, ry = p.mid ? POCKET_R - 4 : POCKET_R;
  const ring = cx.createLinearGradient(p.x - rx, p.y - ry, p.x + rx, p.y + ry);
  ring.addColorStop(0, '#f2f2f6'); ring.addColorStop(0.45, '#9fa0ad'); ring.addColorStop(0.7, '#6c6d7a'); ring.addColorStop(1, '#3a3b45');
  cx.fillStyle = ring; cx.beginPath(); cx.ellipse(p.x, p.y, rx + 4, ry + 4, 0, 0, 7); cx.fill();
  cx.fillStyle = '#26262d'; cx.beginPath(); cx.ellipse(p.x, p.y, rx + 1, ry + 1, 0, 0, 7); cx.fill();
  const hole = cx.createRadialGradient(p.x - 2, p.y - 2, 1, p.x, p.y, Math.max(rx, ry));
  hole.addColorStop(0, '#000'); hole.addColorStop(0.65, '#040405'); hole.addColorStop(1, '#1b1b22');
  cx.fillStyle = hole; cx.beginPath(); cx.ellipse(p.x, p.y, rx, ry, 0, 0, 7); cx.fill();
}
function drawBall(b) {
  const scale = (b.sink !== undefined ? Math.max(0.06, b.sink) : 1), r = R * scale;
  const stripe = b.n > 8, base = tintFor(b.n);
  // soft drop shadow on the felt (offset down-right)
  cx.fillStyle = 'rgba(0,0,0,0.40)';
  cx.beginPath(); cx.ellipse(b.x + 2.4, b.y + 3.4, r * 1.02, r * 0.9, 0, 0, 7); cx.fill();
  // glossy sphere — specular highlight offset to the top-left, dark on bottom-right
  cx.save();
  cx.beginPath(); cx.arc(b.x, b.y, r, 0, 7); cx.clip();
  const bodyCol = b.n === 0 ? '#fafaf2' : (stripe ? '#fbfbf5' : base);
  const g = cx.createRadialGradient(b.x - r * 0.36, b.y - r * 0.40, r * 0.05, b.x + r * 0.28, b.y + r * 0.34, r * 1.3);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.16, '#ffffff'); g.addColorStop(0.42, bodyCol); g.addColorStop(1, shade(bodyCol, -0.5));
  cx.fillStyle = g; cx.fillRect(b.x - r, b.y - r, 2 * r, 2 * r);
  if (stripe) {                      // colored equatorial band, then re-gloss it
    cx.fillStyle = base; cx.fillRect(b.x - r, b.y - r * 0.46, 2 * r, r * 0.92);
    const g2 = cx.createRadialGradient(b.x - r * 0.36, b.y - r * 0.40, r * 0.05, b.x + r * 0.28, b.y + r * 0.34, r * 1.3);
    g2.addColorStop(0, 'rgba(255,255,255,0.9)'); g2.addColorStop(0.22, 'rgba(255,255,255,0.18)');
    g2.addColorStop(0.55, 'rgba(255,255,255,0)'); g2.addColorStop(1, 'rgba(0,0,0,0.4)');
    cx.fillStyle = g2; cx.fillRect(b.x - r, b.y - r, 2 * r, 2 * r);
  }
  cx.restore();
  if (b.n !== 0 && scale > 0.5) {     // numbered disc
    cx.fillStyle = '#fff'; cx.beginPath(); cx.arc(b.x, b.y, r * 0.46, 0, 7); cx.fill();
    cx.fillStyle = '#111'; cx.font = 'bold ' + Math.max(6, Math.round(r * 0.82)) + 'px sans-serif';
    cx.textAlign = 'center'; cx.textBaseline = 'middle'; cx.fillText(String(b.n), b.x, b.y + 0.5);
  }
  // tight specular glint
  cx.fillStyle = 'rgba(255,255,255,0.9)'; cx.beginPath(); cx.arc(b.x - r * 0.34, b.y - r * 0.38, r * 0.16, 0, 7); cx.fill();
}
function drawCue(cue, ux, uy, pwr, lunge) {
  // stick sits behind the cue ball along -aim; wood-grain taper + metal joint + ferrule.
  // `lunge` (px) slides the whole stick toward the ball for the strike animation.
  lunge = lunge || 0;
  const gap = 17 - lunge;
  const back = 18 + 70 + pwr * 120 - lunge, tipX = cue.x - ux * gap, tipY = cue.y - uy * gap;
  const buttX = cue.x - ux * back, buttY = cue.y - uy * back, px = -uy, py = ux, w0 = 1.7, w1 = 4.4;
  cx.save();
  cx.beginPath();
  cx.moveTo(tipX + px * w0, tipY + py * w0); cx.lineTo(buttX + px * w1, buttY + py * w1);
  cx.lineTo(buttX - px * w1, buttY - py * w1); cx.lineTo(tipX - px * w0, tipY - py * w0); cx.closePath();
  const wood = cx.createLinearGradient(tipX, tipY, buttX, buttY);
  wood.addColorStop(0, '#e9cda0'); wood.addColorStop(0.18, '#b07b46'); wood.addColorStop(0.34, '#8a5a2e');
  wood.addColorStop(0.5, '#6f4422'); wood.addColorStop(0.7, '#5a3318'); wood.addColorStop(1, '#3f2410');
  cx.fillStyle = wood; cx.fill();
  cx.lineWidth = 1; cx.strokeStyle = 'rgba(0,0,0,0.35)'; cx.stroke();
  // metallic joint band ~30% down the shaft
  const jx = tipX - ux * (back * 0.26), jy = tipY - uy * (back * 0.26);
  cx.strokeStyle = '#d9dde6'; cx.lineWidth = w1 * 1.5; cx.lineCap = 'butt';
  cx.beginPath(); cx.moveTo(jx, jy); cx.lineTo(jx - ux * 4, jy - uy * 4); cx.stroke();
  // white ferrule + leather tip at the striking end
  cx.strokeStyle = '#f4f2e8'; cx.lineWidth = w0 * 2.2; cx.beginPath(); cx.moveTo(tipX, tipY); cx.lineTo(tipX - ux * 3, tipY - uy * 3); cx.stroke();
  cx.strokeStyle = '#2b4f86'; cx.lineWidth = w0 * 2.2; cx.beginPath(); cx.moveTo(tipX + ux * 1.5, tipY + uy * 1.5); cx.lineTo(tipX, tipY); cx.stroke();
  cx.restore();
}
// ── aim-preview ray helpers ──────────────────────────────────────────────────
// First ball the ray (from x0,y0 along u) would contact, via the ghost-ball method.
function rayFirstBall(x0, y0, ux, uy, ignore) {
  let best = null;
  for (const b of balls) {
    if (b.potted || b.sink !== undefined || b === ignore) continue;
    const fx = b.x - x0, fy = b.y - y0, proj = fx * ux + fy * uy;
    if (proj <= 0) continue;
    const disc = proj * proj - (fx * fx + fy * fy - 4 * R * R);
    if (disc < 0) continue;
    const t = proj - Math.sqrt(disc);
    if (t < 0) continue;
    if (!best || t < best.t) best = { t, obj: b };
  }
  return best;
}
// First pocket the ray's centre-path would drop into (closest approach < CAPTURE_R).
function rayFirstPocket(x0, y0, ux, uy) {
  let best = null;
  for (const p of POCKETS) {
    // Side pockets only accept a ball heading INTO the throat (across the rail), not
    // one skimming along the rail — matches the physics so the preview stays truthful.
    if (p.mid === 'top' && uy > -0.2) continue;
    if (p.mid === 'bot' && uy < 0.2) continue;
    const fx = p.x - x0, fy = p.y - y0, proj = fx * ux + fy * uy;
    if (proj <= 0) continue;
    const perp = Math.abs(fx * -uy + fy * ux);
    if (perp > CAPTURE_R) continue;
    const t = proj - Math.sqrt(Math.max(0, CAPTURE_R * CAPTURE_R - perp * perp));
    if (t < 0) continue;
    if (!best || t < best.t) best = { t, p };
  }
  return best;
}
// Distance along the ray to the first cushion the ball centre reaches.
function rayRail(x0, y0, ux, uy) {
  let t = Infinity, nx = 0, ny = 0;
  if (ux > 0) { const k = (RXn - R - x0) / ux; if (k < t) { t = k; nx = 1; ny = 0; } }
  else if (ux < 0) { const k = (LX + R - x0) / ux; if (k < t) { t = k; nx = 1; ny = 0; } }
  if (uy > 0) { const k = (BY - R - y0) / uy; if (k < t) { t = k; nx = 0; ny = 1; } }
  else if (uy < 0) { const k = (TY + R - y0) / uy; if (k < t) { t = k; nx = 0; ny = 1; } }
  return { t, nx, ny };
}
// GamePigeon-style aim preview: cue path → first ball/rail, then the OBJECT ball's
// line (line of centres) + the cue's deflection. Deliberately does NOT predict whether
// the shot pots — judging that is the skill — but still warns on a cue scratch.
function aimTrajectory(x0, y0, ux, uy) {
  const cue = cueBall();
  const ball = rayFirstBall(x0, y0, ux, uy, cue);
  const rail = rayRail(x0, y0, ux, uy);
  const pocket = rayFirstPocket(x0, y0, ux, uy);
  const tBall = ball ? ball.t : Infinity, tPocket = pocket ? pocket.t : Infinity;
  // cue reaches a pocket before any ball/rail → it would scratch
  if (tPocket < tBall && tPocket < rail.t) return { scratch: true, ex: pocket.p.x, ey: pocket.p.y };
  if (ball && tBall < rail.t) {
    const gx = x0 + ux * ball.t, gy = y0 + uy * ball.t;            // ghost-ball centre
    let ndx = ball.obj.x - gx, ndy = ball.obj.y - gy; const nd = Math.hypot(ndx, ndy) || 1; ndx /= nd; ndy /= nd;
    const dot = ux * ndx + uy * ndy;                               // object goes along the line of centres
    let cdx = ux - dot * ndx, cdy = uy - dot * ndy; const cl = Math.hypot(cdx, cdy) || 1; cdx /= cl; cdy /= cl;
    // object line stops at the next ball/rail (no pocket prediction)
    const oLen = Math.min((rayFirstBall(ball.obj.x, ball.obj.y, ndx, ndy, ball.obj) || { t: Infinity }).t, rayRail(ball.obj.x, ball.obj.y, ndx, ndy).t, 185);
    return { hit: true, ex: gx, ey: gy, obj: ball.obj, odx: ndx, ody: ndy, cdx, cdy, cut: dot, oLen };
  }
  const ex = x0 + ux * rail.t, ey = y0 + uy * rail.t;
  return { hit: false, ex, ey, rx: rail.nx ? -ux : ux, ry: rail.ny ? -uy : uy };
}
function draw() {
  if (!cx) return;
  drawTable();
  if ((state === 'aim' || striking) && myActiveTurn()) {
    const cue = cueBall();
    const ux = aimDir.x, uy = aimDir.y, pwr = power;
    const tr = aimTrajectory(cue.x, cue.y, ux, uy);
    cx.save();
    if (tr.scratch) {
      // cue would drop in a pocket — red scratch warning
      cx.setLineDash([6, 6]); cx.lineWidth = 2; cx.strokeStyle = 'rgba(255,85,85,0.95)';
      cx.beginPath(); cx.moveTo(cue.x, cue.y); cx.lineTo(tr.ex, tr.ey); cx.stroke();
      cx.setLineDash([]); cx.fillStyle = 'rgba(255,85,85,0.9)';
      cx.beginPath(); cx.arc(tr.ex, tr.ey, 4.5, 0, 7); cx.fill();
    } else {
      // cue path → contact / rail
      cx.setLineDash([6, 6]); cx.lineWidth = 2; cx.strokeStyle = 'rgba(255,255,255,0.9)';
      cx.beginPath(); cx.moveTo(cue.x, cue.y); cx.lineTo(tr.ex, tr.ey); cx.stroke();
      if (tr.hit) {
        // ghost-ball outline at the contact point
        cx.setLineDash([]); cx.lineWidth = 1.5; cx.strokeStyle = 'rgba(255,255,255,0.6)';
        cx.beginPath(); cx.arc(tr.ex, tr.ey, R, 0, 7); cx.stroke();
        // object-ball line (direction only — it's on you to judge whether it pots)
        cx.setLineDash([5, 5]); cx.lineWidth = 2.5; cx.strokeStyle = 'rgba(255,228,90,0.95)';
        cx.beginPath(); cx.moveTo(tr.obj.x, tr.obj.y); cx.lineTo(tr.obj.x + tr.odx * tr.oLen, tr.obj.y + tr.ody * tr.oLen); cx.stroke();
        // cue deflection (tangent) — fainter; only meaningful on a cut
        if (tr.cut < 0.985) {
          cx.setLineDash([5, 5]); cx.lineWidth = 1.5; cx.strokeStyle = 'rgba(150,205,255,0.8)';
          cx.beginPath(); cx.moveTo(tr.ex, tr.ey); cx.lineTo(tr.ex + tr.cdx * 95, tr.ey + tr.cdy * 95); cx.stroke();
        }
      } else {
        // rail reflection preview
        cx.lineWidth = 1.5; cx.strokeStyle = 'rgba(255,255,255,0.45)';
        cx.beginPath(); cx.moveTo(tr.ex, tr.ey); cx.lineTo(tr.ex + tr.rx * 130, tr.ey + tr.ry * 130); cx.stroke();
      }
    }
    cx.restore();
    // cue stick — lunges into the ball during the strike animation
    const lunge = striking ? Math.min(1, (performance.now() - _strikeT) / STRIKE_MS) * 24 : 0;
    drawCue(cue, ux, uy, pwr, lunge);
  }
  for (const b of balls) { if (!b.potted) drawBall(b); }
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
  updatePowerUI();
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
    + `<div class="p8-ov-sub">Drag the stick around the cue ball to aim, then drag the Power slider and release to strike. Pot your group, then the 8 to win.</div>`
    + `<div class="p8-startbtns"><button class="p8-btn" id="p8-bot">🤖 Play a bot</button>`
    + `<button class="p8-btn" id="p8-room"${haveRoom ? '' : ' disabled'}>👥 Play someone in the room</button></div>`
    + `<div class="p8-ov-note">${roomNote}</div>`;
  overlayEl.style.display = 'flex';
  overlayEl.querySelector('#p8-bot').onclick = startBot;
  const rb = overlayEl.querySelector('#p8-room'); if (rb && haveRoom) rb.onclick = startRoom;
}
function resetCommon() { pottedThisShot = []; firstHit = null; placing = false; aiming = false; striking = false; _pendingFire = null; _powerDragging = false; _overInfo = null; _finished = false; opponentPresent = false; guestInhand = false; _guestAnnounced = false; }

function startBot() {
  mode = 'bot'; mySeat = 'A'; resetCommon();
  rack(); turn = 'A'; groups = { A: null, B: null }; open = true; broke = false;
  state = 'aim'; hideOverlay(); updateHud();
  setMsg('Break! Drag the stick around the cue ball to aim, then drag the Power slider and release.');
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
  // cue-stick strike: once the lunge animation finishes, launch the shot
  if (_pendingFire && performance.now() - _strikeT >= STRIKE_MS) {
    const pf = _pendingFire; _pendingFire = null; striking = false;
    fireShot(pf.x, pf.y, pf.speed); updatePowerUI();
  }
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

// Portrait phones: rotate the (landscape) table 90° so it fills the screen.
function updateRotation() {
  const want = !!(window.matchMedia && window.matchMedia('(max-width: 820px) and (orientation: portrait)').matches);
  _rotated = want;
  if (cv) cv.classList.toggle('p8-rot', want);
  layoutCanvas();
}
function layoutCanvas() {
  if (!cv || !cv.parentElement) return;
  const stage = cv.parentElement;
  if (_rotated) {
    const sw = stage.clientWidth || W, sh = stage.clientHeight || H;
    // pre-rotation box (pw × ph), aspect W/H; after the 90° turn it occupies (ph × pw)
    // on screen, so fit ph ≤ stage width and pw ≤ stage height.
    let ph = sw, pw = ph * (W / H);
    if (pw > sh) { pw = sh; ph = pw * (H / W); }
    cv.style.width = pw + 'px'; cv.style.height = ph + 'px';
  } else { cv.style.width = ''; cv.style.height = ''; }
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
  // power bar — left-side vertical slider, anchored to #pool-area (outside the rotated
  // stage) so it stays tappable on mobile. Slide the knob down to charge, release to strike.
  powerEl = document.createElement('div'); powerEl.className = 'p8-power';
  powerEl.innerHTML = '<div class="p8-power-track"><div class="p8-power-fill"></div><div class="p8-power-knob"></div></div>';
  area.appendChild(powerEl);

  cx = cv.getContext('2d');
  cv.addEventListener('pointerdown', onDown, { passive: false });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  powerEl.querySelector('.p8-power-track').addEventListener('pointerdown', onPowerDown, { passive: false });
  window.addEventListener('pointermove', onPowerMove);
  window.addEventListener('pointerup', onPowerUp);
  window.addEventListener('resize', updateRotation);
  window.addEventListener('orientationchange', updateRotation);
  _built = true;
  updateRotation(); updatePowerUI();
}

function openPool(show = true) {
  const w = document.getElementById('pool-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } clearTimeout(_aiTimer); return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('pool'); window.OS.focus('pool'); }
  if (!_built) build();
  updateRotation();
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
