// Aquatune Buddy Shoot — a Duck-Hunt-style shooting gallery.
//
// Rounds of 10 flying AquaBuddies (reusing the real hats), 3 shots per duck, hit
// a rising quota to advance; buddies fly fast & erratically and flee off the top
// if you're slow. Color = species (harder to hit = more points). Pays credits +
// Combat XP. Self-contained SVG sprites so they always render in color + hat.

const BASE_SPEED = 2.4;       // px/frame baseline (scaled by difficulty/type/round)
const DUCKS_PER_ROUND = 10;

const DIFF = {
  easy:   { label: 'Easy',   flush: 1, speed: 0.9,  quotaBase: 5, flightMs: 3000, reward: 1.0, rareBias: 0.0 },
  medium: { label: 'Medium', flush: 1, speed: 1.2,  quotaBase: 6, flightMs: 2500, reward: 1.7, rareBias: 0.5 },
  hard:   { label: 'Hard',   flush: 2, speed: 1.55, quotaBase: 7, flightMs: 2100, reward: 2.6, rareBias: 1.1 },
};

// color/species: easy = big/slow/common/low pts; gold = tiny/fast/rare/high pts.
const TYPES = [
  { name: 'blue',   points: 1,  size: 80, speedMul: 0.8,  erratic: 0.6, weight: 40, pal: { h: ['#c8f2ff', '#38c4f0', '#003d6a'], b: ['#b8ecff', '#0082bc', '#003058'] } },
  { name: 'green',  points: 2,  size: 72, speedMul: 1.0,  erratic: 0.9, weight: 26, pal: { h: ['#e0ffd6', '#3fbf3f', '#0c5a18'], b: ['#c8f5b8', '#2a9e34', '#0a4a18'] } },
  { name: 'purple', points: 3,  size: 64, speedMul: 1.2,  erratic: 1.2, weight: 16, pal: { h: ['#efd9ff', '#9a4be0', '#3a0d72'], b: ['#ddc0ff', '#7a2fc0', '#2e0a64'] } },
  { name: 'red',    points: 5,  size: 56, speedMul: 1.45, erratic: 1.5, weight: 10, pal: { h: ['#ffdcd2', '#e84b2f', '#6a0d0d'], b: ['#ffc2b2', '#c83020', '#5a0808'] } },
  { name: 'gold',   points: 8,  size: 48, speedMul: 1.7,  erratic: 1.8, weight: 5,  pal: { h: ['#fff6cc', '#e8b800', '#7a5600'], b: ['#ffe9a0', '#d09e00', '#6a4a00'] } },
];

let _uid = 0;
function buddySvg(type, outfitKey) {
  const id = 'bsg' + (_uid++) + '_', p = type.pal;
  const hat = (window.aqBuddyOutfits && window.aqBuddyOutfits[outfitKey]) || '';
  return `<svg viewBox="0 0 100 112" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;display:block">
    <defs>
      <radialGradient id="${id}h" cx="36%" cy="30%" r="65%"><stop offset="0%" stop-color="${p.h[0]}"/><stop offset="55%" stop-color="${p.h[1]}"/><stop offset="100%" stop-color="${p.h[2]}"/></radialGradient>
      <radialGradient id="${id}b" cx="30%" cy="22%" r="74%"><stop offset="0%" stop-color="${p.b[0]}"/><stop offset="55%" stop-color="${p.b[1]}"/><stop offset="100%" stop-color="${p.b[2]}"/></radialGradient>
    </defs>
    <ellipse cx="50" cy="109" rx="23" ry="3.5" fill="rgba(0,0,0,0.16)"/>
    <path d="M 17 103 Q 13 73 50 65 Q 87 73 83 103 Q 80 110 50 110 Q 20 110 17 103 Z" fill="url(#${id}b)"/>
    <ellipse cx="9" cy="82" rx="12" ry="8.5" fill="url(#${id}b)" transform="rotate(-30 9 82)"/>
    <ellipse cx="91" cy="82" rx="12" ry="8.5" fill="url(#${id}b)" transform="rotate(30 91 82)"/>
    <ellipse cx="34" cy="74" rx="15" ry="9" fill="rgba(255,255,255,0.40)" transform="rotate(-18 34 74)"/>
    <ellipse cx="50" cy="64" rx="14" ry="5.5" fill="url(#${id}b)"/>
    <circle cx="50" cy="33" r="27" fill="url(#${id}h)"/>
    <ellipse cx="38" cy="22" rx="12" ry="8" fill="rgba(255,255,255,0.66)" transform="rotate(-28 38 22)"/>
    <circle cx="43" cy="35" r="5" fill="#001e38"/><circle cx="57" cy="35" r="5" fill="#001e38"/>
    <circle cx="41.5" cy="33.5" r="1.9" fill="#fff"/><circle cx="55.5" cy="33.5" r="1.9" fill="#fff"/>
    <path d="M 43.5 43.5 Q 50 50.5 56.5 43.5" stroke="#001e38" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-opacity="0.82"/>
    ${hat}
  </svg>`;
}

// ── state ──────────────────────────────────────────────────────────────────────
let _built = false, raf = null;
let stage = null, hud = null, overlay = null;
let state = 'start';   // start | round | over
let diff = DIFF.medium;
let buddies = [];
let round = 0, score = 0, roundsCleared = 0;
let released = 0, roundHits = 0, roundResolved = 0;
let ammo = 0, quota = 0, speedScale = 1, pointMul = 1, roundFlightMs = 2500;
let flushing = false, _lastT = 0;

function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function sfx(n) { try { window.buddySfx && window.buddySfx(n); } catch (e) {} }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function stageW() { return (stage && stage.clientWidth) || 360; }
function stageH() { return (stage && stage.clientHeight) || 320; }
function liveCount() { return buddies.reduce((a, b) => a + (b.resolved ? 0 : 1), 0); }

function pickType() {
  let total = 0; const w = TYPES.map(t => { const x = t.weight * (t.points >= 3 ? (1 + diff.rareBias * (t.points / 3)) : 1); total += x; return x; });
  let r = Math.random() * total;
  for (let i = 0; i < TYPES.length; i++) { r -= w[i]; if (r <= 0) return TYPES[i]; }
  return TYPES[0];
}
function randomHat() {
  const keys = (window.aqBuddyOutfitKeys || []).filter(k => k !== 'none');
  return keys.length ? keys[(Math.random() * keys.length) | 0] : '';
}

// ── flow ─────────────────────────────────────────────────────────────────────
function startGame(d) { diff = DIFF[d] || DIFF.medium; round = 0; score = 0; roundsCleared = 0; clearOverlay(); nextRound(); }
function nextRound() {
  round++;
  const tier = Math.floor((round - 1) / 5);
  speedScale = Math.pow(1.15, tier);
  pointMul = 1 + 0.25 * tier;
  quota = Math.min(DUCKS_PER_ROUND, diff.quotaBase + Math.floor((round - 1) / 2));
  roundFlightMs = Math.max(1300, diff.flightMs - (round - 1) * 70);
  released = 0; roundHits = 0; roundResolved = 0; flushing = false;
  clearOverlay(); clearBuddies();
  state = 'round';
  showToast(`Round ${round} — hit ${quota} of ${DUCKS_PER_ROUND}`);
  flushing = true; setTimeout(() => { flushing = false; flush(); }, 600);
}
function flush() {
  if (state !== 'round' || released >= DUCKS_PER_ROUND) return;
  const n = Math.min(diff.flush, DUCKS_PER_ROUND - released);
  ammo = 3;
  for (let i = 0; i < n; i++) spawnBuddy();
  released += n;
  sfx('reload'); updateHud();
}
function endRound() {
  state = 'between'; clearBuddies();
  const perfect = roundHits >= DUCKS_PER_ROUND;
  if (roundHits >= quota) {
    roundsCleared++;
    if (perfect) { score += Math.round(100 * pointMul); sfx('perfect'); try { window.playFanfare && window.playFanfare('win'); } catch (e) {} }
    else { sfx('clear'); try { window.playFanfare && window.playFanfare('small'); } catch (e) {} }
    showOverlay(perfect ? '✨ PERFECT! ✨' : `Round ${round} cleared!`, `${roundHits}/${DUCKS_PER_ROUND} hit · score ${score}`, 'Next round ▶', () => nextRound());
  } else {
    gameOver();
  }
}
function gameOver() {
  state = 'over'; clearBuddies();
  const reward = Math.round(score * diff.reward * 0.4);
  sfx('fail'); try { window.playFanfare && window.playFanfare(roundsCleared >= 3 ? 'win' : 'small'); } catch (e) {}
  if (reward > 0 && typeof window.aqAddCredits === 'function') window.aqAddCredits(reward);   // also feeds Finance XP
  if (typeof window.aqGameXp === 'function') window.aqGameXp('combat', { played: true, won: roundsCleared >= 1, mult: Math.max(1, Math.min(8, 1 + roundsCleared * 0.6 + score / 500)) });
  if (typeof window.recordScore === 'function') window.recordScore('buddyshoot', score, 'round ' + round + ' · ' + diff.label);
  if (roundsCleared >= 4 && typeof window.aqGameAnnounce === 'function') window.aqGameAnnounce(`survived ${roundsCleared} rounds of Buddy Shoot (${score} pts) 🦆🔫`);
  showOverlay('Game Over', `Score ${score} · reached round ${round}<br>+${reward} 💰`, 'Play again', () => showStart());
}

// ── sprites ─────────────────────────────────────────────────────────────────────
function spawnBuddy() {
  const t = pickType();
  const node = el('div', 'bs-buddy');
  const w = t.size;
  node.style.width = w + 'px';
  node.innerHTML = buddySvg(t, randomHat());
  const sw = stageW(), sh = stageH(), h = w * 1.12;
  const x = 16 + Math.random() * Math.max(1, sw - 32 - w);
  const s = BASE_SPEED * diff.speed * t.speedMul * speedScale;
  // Spawn down at the bottom (behind the foreground hill) and rise into the sky.
  const b = { node, type: t, w, h, x, y: sh - h * 0.5, s, vx: (Math.random() < 0.5 ? -1 : 1) * s * 0.8, vy: -s * 0.7, born: performance.now(), turnAt: 0, spooked: false, falling: false, resolved: false };
  node.style.transform = `translate(${x}px,${b.y}px)`;
  stage.appendChild(node);
  buddies.push(b);
}
function retarget(b) {
  const up = -0.55 + Math.random() * 0.5;                 // mostly up, sometimes level/down
  const horiz = (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.45);
  b.vx = horiz * b.s; b.vy = up * b.s;
}
function spook(b) {
  if (b.spooked || b.falling || b.resolved) return;
  b.spooked = true; b.node.classList.add('bs-spook');
  b.vx *= 0.35; b.vy = -Math.max(b.s, 3) * 1.5; sfx('escape');
}
function startFall(b) {
  if (b.resolved) return;
  b.resolved = true; roundResolved++;
  b.falling = true; b.vy = 1.6; b.vx *= 0.3;
  b.node.classList.remove('bs-spook'); b.node.classList.add('bs-fall');
  checkRound();
}
function resolveEscape(b) {
  if (b.resolved) return;
  b.resolved = true; roundResolved++;
  b.node.remove();
  checkRound();
}
function clearBuddies() { buddies.forEach(b => b.node && b.node.remove()); buddies = []; }
function checkRound() {
  if (state !== 'round' || flushing) return;
  if (liveCount() > 0) return;
  flushing = true;
  if (released >= DUCKS_PER_ROUND) setTimeout(() => endRound(), 500);
  else setTimeout(() => { flushing = false; flush(); }, 550);
}

// ── input ──────────────────────────────────────────────────────────────────────
function fire(e) {
  if (state !== 'round') return;
  e.preventDefault();
  if (ammo <= 0) { sfx('empty'); return; }
  ammo--; sfx('shot');
  const r = stage.getBoundingClientRect();
  const px = (e.clientX ?? 0) - r.left, py = (e.clientY ?? 0) - r.top;
  let target = null;
  for (let i = buddies.length - 1; i >= 0; i--) {
    const b = buddies[i];
    if (b.resolved || b.falling) continue;
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) { target = b; break; }
  }
  if (target) {
    const pts = Math.round(target.type.points * pointMul);
    score += pts; roundHits++;
    sfx('hit'); popPoints(target, pts);
    startFall(target);
  }
  if (ammo <= 0) buddies.forEach(b => spook(b));   // out of ammo → the rest flee (escape = miss)
  updateHud();
}
function popPoints(b, pts) {
  const p = el('div', 'bs-pop', '+' + pts);
  p.style.left = (b.x + b.w / 2) + 'px'; p.style.top = b.y + 'px';
  stage.appendChild(p); setTimeout(() => p.remove(), 700);
}

// ── loop ─────────────────────────────────────────────────────────────────────
function tick(t) {
  const dt = Math.min(50, t - (_lastT || t)); _lastT = t; const f = dt / 16;
  if (state === 'round') {
    const sw = stageW(), sh = stageH();
    for (const b of buddies) {
      if (b.falling) {
        b.vy += 0.45 * f; b.x += b.vx * f; b.y += b.vy * f;
        b.node.style.transform = `translate(${b.x}px,${b.y}px) rotate(${(b.vy * 18) | 0}deg)`;
        if (b.y > sh + b.h) b.node.remove();
        continue;
      }
      if (b.resolved) continue;
      if (b.spooked) {
        b.y += b.vy * f; b.x += b.vx * f;
        b.node.style.transform = `translate(${b.x}px,${b.y}px)`;
        if (b.y < -b.h - 4) resolveEscape(b);
        continue;
      }
      if (t >= b.turnAt) { retarget(b); b.turnAt = t + (360 + Math.random() * 460) / b.type.erratic; }
      b.x += b.vx * f; b.y += b.vy * f;
      if (b.x <= 4) { b.x = 4; b.vx = Math.abs(b.vx); }
      if (b.x >= sw - b.w - 4) { b.x = sw - b.w - 4; b.vx = -Math.abs(b.vx); }
      if (b.y <= 4) { b.y = 4; b.vy = Math.abs(b.vy) * 0.6; }
      // Floor near the bottom; the foreground hill hides them while they're this low.
      if (b.y >= sh - b.h * 0.5) { b.y = sh - b.h * 0.5; b.vy = -Math.abs(b.vy); }
      b.node.style.transform = `translate(${b.x}px,${b.y}px) scaleX(${b.vx < 0 ? -1 : 1})`;
      if (t - b.born > roundFlightMs) spook(b);
    }
  }
  raf = requestAnimationFrame(tick);
}

// ── UI ────────────────────────────────────────────────────────────────────────
function updateHud() {
  if (!hud) return;
  let dots = ''; for (let i = 0; i < 3; i++) dots += `<span class="bs-dot${i < ammo ? ' on' : ''}"></span>`;
  hud.innerHTML = `<span>R${round}</span><span>⭐ ${score}</span><span>🎯 ${roundHits}/${quota}</span>`
    + `<span>🐤 ${roundResolved}/${DUCKS_PER_ROUND}</span><span class="bs-shots">${dots}</span>`
    + `<span class="aq-credits-display">💰 ${credits()}</span>`;
}
let _toastT = null;
function showToast(msg) {
  if (!stage) return;
  let tEl = stage.querySelector('.bs-toast');
  if (!tEl) { tEl = el('div', 'bs-toast'); stage.appendChild(tEl); }
  tEl.textContent = msg; tEl.style.opacity = '1';
  clearTimeout(_toastT); _toastT = setTimeout(() => { if (tEl) tEl.style.opacity = '0'; }, 1700);
  updateHud();
}
function showOverlay(title, sub, btnLabel, onClick) {
  clearOverlay();
  overlay = el('div', 'bs-overlay');
  overlay.appendChild(el('div', 'bs-ov-title', title));
  overlay.appendChild(el('div', 'bs-ov-sub', sub));
  const b = el('button', 'bs-btn', btnLabel); b.onclick = onClick; overlay.appendChild(b);
  stage.appendChild(overlay);
}
function clearOverlay() { if (overlay) { overlay.remove(); overlay = null; } }
function showStart() {
  state = 'start'; score = 0; round = 0; clearBuddies(); clearOverlay();
  overlay = el('div', 'bs-overlay');
  overlay.appendChild(el('div', 'bs-ov-title', '🦆 Buddy Shoot'));
  overlay.appendChild(el('div', 'bs-ov-sub', 'Shoot the flying buddies — 3 shots each, hit the quota every round. Rarer colors fly faster and score more!'));
  const row = el('div', 'bs-diffrow');
  ['easy', 'medium', 'hard'].forEach(d => { const b = el('button', 'bs-btn', DIFF[d].label); b.onclick = () => startGame(d); row.appendChild(b); });
  overlay.appendChild(row);
  stage.appendChild(overlay);
  updateHud();
}

function build() {
  const area = document.getElementById('buddyshoot-area');
  if (!area) return;
  area.innerHTML = '';
  hud = el('div', 'bs-hud'); area.appendChild(hud);
  stage = el('div', 'bs-stage'); area.appendChild(stage);
  stage.appendChild(el('div', 'bs-hill'));   // foreground hill (occludes low buddies)
  stage.addEventListener('pointerdown', fire, { passive: false });
  _built = true;
}

function openBuddyShoot(show = true) {
  const w = document.getElementById('buddyshoot-wrap');
  if (!w) return;
  if (show === false) {
    w.classList.remove('open'); w.style.display = 'none';
    if (raf) { cancelAnimationFrame(raf); raf = null; }
    clearBuddies();
    return;
  }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('buddyshoot'); window.OS.focus('buddyshoot'); }
  if (!_built) build();
  showStart();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') { window.openBuddyShoot = openBuddyShoot; }
