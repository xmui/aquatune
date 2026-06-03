// Aquatune Buddy Shoot — a Duck-Hunt-style shooting gallery.
//
// Flying AquaBuddies (reusing the real buddy SVG + the existing hats) drift across
// a stage; color sets how hard each is to hit and how many points it's worth.
// Duck-Hunt waves: limited shots, hit a quota each wave to advance; escapes or
// empty ammo end the run. Pays credits + Combat XP. Three difficulties.

const DIFF = {
  easy:   { label: 'Easy',   waveSize: 6,  speed: 0.9,  quota: 0.5,  reward: 1.0, rareBias: 0.0,  concurrent: 2 },
  medium: { label: 'Medium', waveSize: 8,  speed: 1.15, quota: 0.6,  reward: 1.7, rareBias: 0.5,  concurrent: 2 },
  hard:   { label: 'Hard',   waveSize: 10, speed: 1.5,  quota: 0.7,  reward: 2.6, rareBias: 1.1,  concurrent: 3 },
};
// color → difficulty/points. cyan easy & common; gold tiny/fast & rare & rich.
const TYPES = [
  { name: 'cyan',   filter: '',                                              points: 1,  size: 78, speedMul: 0.85, weight: 40 },
  { name: 'green',  filter: 'hue-rotate(85deg) saturate(1.2)',               points: 2,  size: 70, speedMul: 1.0,  weight: 26 },
  { name: 'purple', filter: 'hue-rotate(205deg) saturate(1.35)',             points: 3,  size: 62, speedMul: 1.2,  weight: 16 },
  { name: 'red',    filter: 'hue-rotate(300deg) saturate(1.7)',              points: 5,  size: 54, speedMul: 1.45, weight: 10 },
  { name: 'gold',   filter: 'sepia(1) saturate(3.2) brightness(1.12) hue-rotate(-12deg)', points: 10, size: 46, speedMul: 1.75, weight: 4 },
];

let _built = false, raf = null;
let stage = null, hud = null, overlay = null;
let state = 'start';      // start | wave | clear | over
let diff = DIFF.medium;
let buddies = [];         // live sprites
let wave = 0, score = 0, ammo = 0, spawned = 0, resolved = 0, hits = 0, wavesCleared = 0;
let spawnAt = 0, _lastT = 0;
let waveTarget = 0, waveQuota = 0;

function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function sfx(n) { try { window.buddySfx && window.buddySfx(n); } catch (e) {} }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function pickType() {
  // harder difficulty biases toward rarer high-point types
  let total = 0; const w = TYPES.map(t => { const x = t.weight * (t.points >= 3 ? (1 + diff.rareBias * (t.points / 3)) : 1); total += x; return x; });
  let r = Math.random() * total;
  for (let i = 0; i < TYPES.length; i++) { r -= w[i]; if (r <= 0) return TYPES[i]; }
  return TYPES[0];
}

// ── flow ─────────────────────────────────────────────────────────────────────
function startGame(d) {
  diff = DIFF[d] || DIFF.medium;
  wave = 0; score = 0; wavesCleared = 0;
  clearOverlay();
  nextWave();
}
function nextWave() {
  wave++;
  waveTarget = diff.waveSize + Math.floor((wave - 1) / 2);     // grows slowly
  waveQuota = Math.ceil(waveTarget * diff.quota);
  ammo = waveTarget * 3;
  spawned = 0; resolved = 0; hits = 0;
  clearBuddies();
  state = 'wave';
  spawnAt = performance.now() + 400;
  flash(`Wave ${wave} — hit ${waveQuota} of ${waveTarget}`);
}
function endWave() {
  clearBuddies();
  if (hits >= waveQuota) {
    wavesCleared++;
    state = 'clear';
    sfx('clear'); try { window.playFanfare && window.playFanfare('small'); } catch (e) {}
    showOverlay(`Wave ${wave} cleared!`, `${hits}/${waveTarget} hit · score ${score}`, 'Next wave ▶', () => nextWave());
  } else {
    gameOver();
  }
}
function gameOver() {
  state = 'over';
  clearBuddies();
  const reward = Math.round(score * diff.reward * 0.5);
  try { window.playFanfare && window.playFanfare(wavesCleared >= 3 ? 'win' : 'small'); } catch (e) {}
  if (reward > 0 && typeof window.aqAddCredits === 'function') window.aqAddCredits(reward);  // also feeds Finance XP
  if (typeof window.aqGameXp === 'function') window.aqGameXp('combat', { played: true, won: wavesCleared >= 1, mult: Math.max(1, Math.min(8, 1 + score / 200 + wavesCleared * 0.5)) });
  if (typeof window.recordScore === 'function') window.recordScore('buddyshoot', score, 'wave ' + wave + ' · ' + diff.label);
  showOverlay('Game Over', `Score ${score} · reached wave ${wave}<br>+${reward} 💰`, 'Play again', () => showStart());
}

// ── spawning / sprites ─────────────────────────────────────────────────────────
function spawnBuddy() {
  if (!stage) return;
  const t = pickType();
  const sprite = (typeof window.aqMakeBuddySprite === 'function') ? window.aqMakeBuddySprite(window.aqBuddyOutfitKeys ? window.aqBuddyOutfitKeys[(Math.random() * window.aqBuddyOutfitKeys.length) | 0] : '') : null;
  const node = el('div', 'bs-buddy');
  const w = t.size, h = w * 1.12;
  node.style.width = w + 'px';
  node.style.filter = (t.filter ? t.filter + ' ' : '') + 'drop-shadow(0 3px 5px rgba(0,40,90,0.35))';
  if (sprite) node.appendChild(sprite); else node.textContent = '🐤';
  const sw = stage.clientWidth || 360, sh = stage.clientHeight || 300;
  const x = 20 + Math.random() * (sw - 40 - w);
  const sp = (1.6 + Math.random() * 0.7) * diff.speed * t.speedMul;     // px/frame baseline
  const b = {
    node, type: t, w, h, x, y: sh,                                       // start at the bottom
    vx: (Math.random() < 0.5 ? -1 : 1) * sp * 0.6,
    vy: -sp,
    t0: performance.now(), flightMs: 4200 / diff.speed, fleeing: false, resolved: false,
    wob: Math.random() * 6.28,
  };
  node.style.transform = `translate(${x}px,${b.y}px)`;
  stage.appendChild(node);
  buddies.push(b);
  spawned++;
}
function resolveBuddy(b, hit) {
  if (b.resolved) return;
  b.resolved = true; resolved++;
  if (b.node && b.node.parentNode) {
    if (hit) { b.node.classList.add('bs-hit'); setTimeout(() => b.node.remove(), 260); }
    else b.node.remove();
  }
  checkWaveEnd();
}
// Wave ends once no buddies are left flying and we've either released them all or run dry.
function checkWaveEnd() {
  if (state !== 'wave') return;
  const live = buddies.some(b => !b.resolved);
  if (!live && (spawned >= waveTarget || ammo <= 0)) setTimeout(() => { if (state === 'wave') endWave(); }, 280);
}
function clearBuddies() { buddies.forEach(b => b.node && b.node.remove()); buddies = []; }

// ── input ──────────────────────────────────────────────────────────────────────
function fire(e) {
  if (state !== 'wave') return;
  e.preventDefault();
  if (ammo <= 0) { sfx('empty'); return; }
  ammo--;
  sfx('shot');   // bang on every trigger pull
  const r = stage.getBoundingClientRect();
  const px = (e.clientX ?? 0) - r.left, py = (e.clientY ?? 0) - r.top;
  // topmost live buddy under the shot
  let target = null;
  for (let i = buddies.length - 1; i >= 0; i--) {
    const b = buddies[i];
    if (b.resolved) continue;
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) { target = b; break; }
  }
  if (target) {
    score += target.type.points; hits++;
    sfx('hit'); popPoints(target);
    resolveBuddy(target, true);
  }
  if (ammo <= 0) { buddies.forEach(b => { if (!b.resolved) b.fleeing = true; }); checkWaveEnd(); }  // out of ammo → flee
  updateHud();
}
function popPoints(b) {
  const p = el('div', 'bs-pop', '+' + b.type.points);
  p.style.left = (b.x + b.w / 2) + 'px'; p.style.top = b.y + 'px';
  stage.appendChild(p);
  setTimeout(() => p.remove(), 700);
}

// ── loop ─────────────────────────────────────────────────────────────────────
function tick(t) {
  const dt = Math.min(50, t - (_lastT || t)); _lastT = t; const f = dt / 16;
  if (state === 'wave') {
    // spawn up to waveTarget, a few at a time
    const live = buddies.filter(b => !b.resolved).length;
    if (ammo > 0 && spawned < waveTarget && live < diff.concurrent && t >= spawnAt) { spawnBuddy(); spawnAt = t + (600 + Math.random() * 700) / diff.speed; }
    const sh = stage ? (stage.clientHeight || 300) : 300, sw = stage ? (stage.clientWidth || 360) : 360;
    for (const b of buddies) {
      if (b.resolved) continue;
      const age = t - b.t0;
      if (!b.fleeing && age > b.flightMs) b.fleeing = true;
      if (b.fleeing) b.vy = Math.min(b.vy, -2.2 * diff.speed) - 0.05 * f;   // flee upward
      b.x += b.vx * f; b.y += b.vy * f + Math.sin(t / 260 + b.wob) * 0.25;
      if (b.x <= 4 || b.x >= sw - b.w - 4) b.vx *= -1;                       // bounce off sides
      b.x = Math.max(4, Math.min(sw - b.w - 4, b.x));
      b.node.style.transform = `translate(${b.x}px,${b.y}px)`;
      if (b.y < -b.h - 4) resolveBuddy(b, false);                           // escaped off the top
    }
  }
  raf = requestAnimationFrame(tick);
}

// ── UI ────────────────────────────────────────────────────────────────────────
function updateHud() {
  if (!hud) return;
  hud.innerHTML = `<span>🌊 W${wave}</span><span>⭐ ${score}</span><span>🎯 ${hits}/${waveQuota}</span><span>🔫 ${ammo}</span><span class="aq-credits-display">💰 ${credits()}</span>`;
}
function flash(msg) { if (hud) updateHud(); showToast(msg); }
let _toastT = null;
function showToast(msg) {
  if (!stage) return;
  let tEl = stage.querySelector('.bs-toast');
  if (!tEl) { tEl = el('div', 'bs-toast'); stage.appendChild(tEl); }
  tEl.textContent = msg; tEl.style.opacity = '1';
  clearTimeout(_toastT); _toastT = setTimeout(() => { if (tEl) tEl.style.opacity = '0'; }, 1600);
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
  state = 'start'; score = 0; wave = 0; clearBuddies();
  clearOverlay();
  overlay = el('div', 'bs-overlay');
  overlay.appendChild(el('div', 'bs-ov-title', '🦆 Buddy Shoot'));
  overlay.appendChild(el('div', 'bs-ov-sub', 'Shoot the flying buddies. Rarer colors = more points. Hit the quota each wave!'));
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
  stage.addEventListener('pointerdown', fire);
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
