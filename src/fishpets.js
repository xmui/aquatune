// Aquatune desktop fish pets — release fish you've caught onto the desktop, where
// they flop around and sing (Big-Mouth-Billy-Bass style). Unlocked from the Fishing
// game's Fish-o-pedia; the set + positions persist per account. They only come alive
// (flop + sing) while a video/song is actually playing.

const KEY = 'aq_fish_pets';
const MAX_PETS = 12, SC = 5;
let pets = [];               // [{ name, x, y }]  x,y are viewport fractions (0..1)
let layer = null, raf = null, _last = 0;

function load() { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(pets.map(p => ({ name: p.name, x: p.x, y: p.y })))); } catch {}
  if (typeof window.aqGamePersist === 'function') window.aqGamePersist(KEY);
}
function playing() { return !!window._aqMediaPlaying; }
function sing(p, now) {
  if (!p.el || !playing() || now < (p.singUntil || 0)) return;   // only sing while music plays
  p.singUntil = now + 2600;
  p.el.classList.add('singing');
  try { window.fishSing && window.fishSing(); } catch (e) {}
  // float a couple of music notes up off the fish
  for (let i = 0; i < 3; i++) setTimeout(() => {
    if (!p.el) return;
    const note = document.createElement('div'); note.className = 'aqfp-note'; note.textContent = '🎵';
    note.style.left = (10 + Math.random() * 30) + 'px'; note.style.top = '-6px';
    p.el.appendChild(note); setTimeout(() => note.remove(), 1100);
  }, i * 280);
}

function ensureLayer() {
  if (layer) return layer;
  layer = document.createElement('div'); layer.id = 'aq-fishpets';
  document.body.appendChild(layer);
  return layer;
}
function place(p, vw, vh) {
  if (!p.el) return;
  p.el.style.left = ((p.x * vw) | 0) + 'px';
  p.el.style.top = ((p.y * vh) | 0) + 'px';
  if (p._cvs) p._cvs.style.transform = 'scaleX(' + (p.dir < 0 ? -1 : 1) + ')';
}
function makeEl(p) {
  const def = (window.aqFishDef && window.aqFishDef(p.name)) || { shape: 'classic', col: '#6fae5a' };
  const dims = (window.aqFishSpriteDims && window.aqFishSpriteDims(def.shape)) || { w: 15, h: 9 };
  const el = document.createElement('div'); el.className = 'aq-fishpet'; el.title = p.name + ' — click me to sing';
  const flop = document.createElement('div'); flop.className = 'aqfp-flop';
  const cvs = document.createElement('canvas'); cvs.className = 'aqfp-cvs';
  cvs.width = dims.w * SC; cvs.height = dims.h * SC;
  const ctx = cvs.getContext('2d'); ctx.imageSmoothingEnabled = false;
  if (window.aqDrawFishSprite) window.aqDrawFishSprite(ctx, def.shape, def.col, 0, 0, SC);
  flop.appendChild(cvs);
  const x = document.createElement('button'); x.className = 'aqfp-x'; x.textContent = '✕';
  x.onclick = (e) => { e.stopPropagation(); removePet(p.name); };
  el.appendChild(flop); el.appendChild(x);
  p.el = el; p._cvs = cvs;
  // drag to move, click (no drag) to sing
  let dx = 0, dy = 0, moved = false, down = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.target === x) return;
    e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (_) {}
    dx = e.clientX; dy = e.clientY; moved = false; down = true; p.dragging = true;
  });
  el.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (Math.abs(e.clientX - dx) + Math.abs(e.clientY - dy) > 5) moved = true;
    if (moved) {
      p.x = Math.min(0.95, Math.max(0, e.clientX / innerWidth - 0.04));
      p.y = Math.min(0.92, Math.max(0.04, e.clientY / innerHeight - 0.04));
      place(p, innerWidth, innerHeight);
    }
  });
  const up = () => { if (!down) return; down = false; p.dragging = false; if (!moved) sing(p, performance.now()); else save(); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  return el;
}

function render() {
  ensureLayer(); layer.innerHTML = '';
  const vw = innerWidth, vh = innerHeight;
  pets.forEach(p => {
    p.dir = p.dir || (Math.random() < 0.5 ? -1 : 1);
    p.vx = 0.025 + Math.random() * 0.03;   // fraction/sec
    p.singUntil = 0;
    layer.appendChild(makeEl(p));
    place(p, vw, vh);
  });
  if (pets.length && !raf) { _last = 0; raf = requestAnimationFrame(loop); }
  if (!pets.length && raf) { cancelAnimationFrame(raf); raf = null; }
}

function loop(t) {
  if (!raf) return;
  const dt = Math.min(60, t - (_last || t)); _last = t;
  const live = playing(), vw = innerWidth, vh = innerHeight;
  for (const p of pets) {
    if (!p.el) continue;
    // freeze the flop animation when nothing is playing
    p.el.classList.toggle('aqfp-frozen', !live);
    if (live && !p.dragging) {
      p.x += p.dir * p.vx * dt / 1000;
      if (p.x < 0.02) { p.x = 0.02; p.dir = 1; } else if (p.x > 0.9) { p.x = 0.9; p.dir = -1; }
      else if (Math.random() < 0.004) p.dir *= -1;
      place(p, vw, vh);
      if (t >= (p.singUntil || 0) && Math.random() < 0.02 * dt / 1000) sing(p, t);   // occasional auto-sing
    }
    if (p.el.classList.contains('singing') && t >= (p.singUntil || 0)) p.el.classList.remove('singing');
  }
  raf = requestAnimationFrame(loop);
}

// ── public API (used by the Fish-o-pedia toggle in fishing.js) ───────────────
function has(name) { return pets.some(p => p.name === name); }
function removePet(name) { pets = pets.filter(p => p.name !== name); save(); render(); }
function addPet(name) {
  if (pets.length >= MAX_PETS) { if (window.toast) window.toast('🐟 Desktop tank is full (' + MAX_PETS + ').'); return; }
  pets.push({ name, x: 0.1 + Math.random() * 0.7, y: 0.78 + Math.random() * 0.08 });
  save(); render();
}
function toggle(name) { has(name) ? removePet(name) : addPet(name); }

if (typeof window !== 'undefined') {
  window.aqFishpetToggle = toggle;
  window.aqFishpetHas = has;
  addEventListener('resize', () => { const vw = innerWidth, vh = innerHeight; pets.forEach(p => place(p, vw, vh)); });
  // cloud game-save can land after load — re-read the saved tank
  addEventListener('aq-gamedata-synced', () => { pets = load(); render(); });
  pets = load(); render();
}
