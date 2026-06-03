// Aquatune Fishing — a tiny Game Boy Color–styled fishing game.
//
// Cast, wait for a bite, then play a Stardew-Valley-style reeling minigame: keep
// a moving "catch zone" over the darting fish to fill the progress meter before
// it drains. Rewards credits + Fishing XP. Everything is drawn on a small canvas
// scaled up with nearest-neighbor for chunky pixels.

const W = 160, H = 144;                 // GBC native-ish resolution
// 4-tone GBC-style teal palette (dark -> light)
const PAL = ['#0f380f', '#306850', '#7ba672', '#cfe8a0'];
const SKY = '#9bbc0f', WATER = '#306850';

const FISH = [
  { name: 'Minnow',    rarity: 0, value: 4,   color: 1 },
  { name: 'Bass',      rarity: 1, value: 9,   color: 2 },
  { name: 'Pike',      rarity: 1, value: 14,  color: 2 },
  { name: 'Catfish',   rarity: 2, value: 22,  color: 1 },
  { name: 'Pufferfish',rarity: 2, value: 30,  color: 3 },
  { name: 'Eel',       rarity: 3, value: 45,  color: 0 },
  { name: 'Legendary', rarity: 4, value: 120, color: 3 },
];

let cv = null, cx = null, raf = null;
let state = 'idle';   // idle | casting | bite | reel | caught | miss
let _built = false;
let msg = 'Tap CAST to fish';
let toastT = 0;

// reel minigame state
let R = null;
let biteAt = 0;

function lvl() { return (typeof window.aqSkillLevel === 'function' && window.aqSkillLevel('fishing')) || 1; }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }

function pickFish() {
  // higher level nudges toward rarer fish
  const luck = Math.random() + lvl() / 300;
  let pool;
  if (luck > 1.15) pool = FISH.filter(f => f.rarity >= 3);
  else if (luck > 0.8) pool = FISH.filter(f => f.rarity >= 1 && f.rarity <= 3);
  else pool = FISH.filter(f => f.rarity <= 1);
  return pool[(Math.random() * pool.length) | 0] || FISH[0];
}

function startCast() {
  if (state === 'reel' || state === 'casting') return;
  state = 'casting'; msg = 'Casting…';
  const wait = 900 + Math.random() * 2600;
  biteAt = performance.now() + wait;
}

function startReel() {
  const fish = pickFish();
  // catch zone size grows with level (easier), shrinks with rarity (harder).
  // Generous by default so it feels fair; track is 0..120.
  const zone = Math.max(34, 74 - fish.rarity * 5 + lvl() * 0.3);
  state = 'reel';
  msg = 'Reel it in!';
  R = {
    fish,
    zoneH: zone,            // px height of the green catch bar
    zoneY: 120 - zone,      // top of catch zone (player-controlled)
    vel: 0,
    fishY: 60,              // fish position on track
    fishV: 0,
    fishTarget: 60,
    progress: 55,           // 0..100, lose at 0, win at 100 (start with a head start)
    holding: false,
  };
}

function landFish() {
  const f = R.fish;
  state = 'caught';
  msg = `Caught a ${f.name}!  +${f.value}💰`;
  toastT = performance.now();
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(f.value);
  if (typeof window.aqGameXp === 'function') window.aqGameXp('fishing', { played: true, won: true, mult: 1 + f.rarity * 0.6 });
  if (typeof window.recordScore === 'function') window.recordScore('fishing', f.value, f.name);
  try {
    const log = JSON.parse(localStorage.getItem('aq_fishing_log') || '[]');
    log.unshift({ name: f.name, value: f.value, ts: Date.now() });
    localStorage.setItem('aq_fishing_log', JSON.stringify(log.slice(0, 50)));
  } catch {}
  R = null;
}

function loseFish() {
  state = 'miss';
  msg = 'It got away…';
  // small consolation XP for the attempt
  if (typeof window.aqGameXp === 'function') window.aqGameXp('fishing', { played: true, won: false });
  R = null;
}

function setHold(on) {
  if (state === 'reel' && R) R.holding = on;
  else if ((state === 'idle' || state === 'caught' || state === 'miss')) startCast();
}

let _lastT = 0;
function tick(t) {
  const dt = Math.min(50, t - (_lastT || t)); _lastT = t;
  if (state === 'casting' && t >= biteAt) { state = 'bite'; msg = '! BITE ! Tap to reel!'; biteAt = t; }
  if (state === 'bite' && t - biteAt > 2600) { loseFish(); } // generous bite window
  if (state === 'reel' && R) {
    // player bar physics (hold = up) — gentle so it's easy to steer
    R.vel += (R.holding ? -0.15 : 0.13) * dt;
    R.vel *= 0.9;
    R.zoneY += R.vel;
    if (R.zoneY < 0) { R.zoneY = 0; R.vel = 0; }
    if (R.zoneY > 120 - R.zoneH) { R.zoneY = 120 - R.zoneH; R.vel = 0; }
    // fish wandering — calmer, especially for common fish
    if (Math.random() < 0.018 + R.fish.rarity * 0.008) R.fishTarget = 10 + Math.random() * 100;
    R.fishV += (R.fishTarget - R.fishY) * 0.0028 * dt;
    R.fishV *= 0.9;
    R.fishY += R.fishV;
    R.fishY = Math.max(2, Math.min(118, R.fishY));
    // in-zone? fill fast, drain slow → forgiving
    const inZone = R.fishY >= R.zoneY && R.fishY <= R.zoneY + R.zoneH;
    R.progress += (inZone ? 0.085 : -0.04) * dt;
    if (R.progress >= 100) { landFish(); }
    else if (R.progress <= 0) { loseFish(); }
  }
  draw(t);
  raf = requestAnimationFrame(tick);
}

function px(x, y, w, h, color) { cx.fillStyle = PAL[color] || color; cx.fillRect(x | 0, y | 0, w | 0, h | 0); }

function draw(t) {
  if (!cx) return;
  // sky / water
  cx.fillStyle = SKY; cx.fillRect(0, 0, W, 54);
  cx.fillStyle = WATER; cx.fillRect(0, 54, W, H - 54);
  // wave lines
  cx.fillStyle = PAL[2];
  for (let y = 64; y < H; y += 12) for (let x = ((t / 60) % 12) | 0; x < W; x += 12) cx.fillRect(x, y, 5, 1);
  // dock + rod
  px(0, 44, 40, 12, 0);
  px(36, 18, 3, 30, 0);            // rod
  // line + bobber
  const bx = 96;
  cx.strokeStyle = PAL[3]; cx.beginPath(); cx.moveTo(38, 20); cx.lineTo(bx + 3, state === 'reel' ? 60 : 60); cx.stroke();

  if (state === 'reel' && R) {
    // reel track on the right
    const tx = 132, tw = 18, ty = 14, th = 120;
    px(tx - 2, ty - 2, tw + 4, th + 4, 0);
    px(tx, ty, tw, th, 1);
    // catch zone
    px(tx, ty + R.zoneY, tw, R.zoneH, 2);
    // fish marker
    px(tx + 3, ty + R.fishY - 3, tw - 6, 6, R.fish.color === 2 ? 3 : 0);
    // progress bar (left)
    px(6, 64, 10, 70, 0);
    const pb = (R.progress / 100) * 66;
    px(8, 64 + 2 + (66 - pb), 6, pb, 3);
  } else {
    // bobber
    px(bx, 58, 6, 6, state === 'bite' ? 3 : 0);
    if (state === 'bite') { px(bx - 2, 50, 2, 6, 3); px(bx + 6, 50, 2, 6, 3); }
  }

  // message banner
  cx.fillStyle = PAL[0]; cx.fillRect(0, H - 16, W, 16);
  cx.fillStyle = PAL[3];
  cx.font = '8px monospace';
  cx.textBaseline = 'middle';
  cx.fillText(msg, 4, H - 8);
}

function build() {
  const area = document.getElementById('fishing-area');
  if (!area) return;
  area.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'gbc-stage';
  cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.className = 'gbc-canvas';
  stage.appendChild(cv);
  area.appendChild(stage);

  const bar = document.createElement('div');
  bar.className = 'gbc-bar';
  const cast = document.createElement('button');
  cast.className = 'gbc-btn';
  cast.textContent = '🎣 CAST / REEL';
  bar.appendChild(cast);
  const info = document.createElement('div');
  info.className = 'gbc-info';
  bar.appendChild(info);
  area.appendChild(bar);
  _fishInfo = info;

  cx = cv.getContext('2d');
  cx.imageSmoothingEnabled = false;

  // input: a press triggers cast/reel-grab; hold raises the bar during reel
  const down = (e) => { e.preventDefault(); if (state === 'bite') { startReel(); if (R) R.holding = true; } else setHold(true); };
  const up = (e) => { e.preventDefault(); if (state === 'reel' && R) R.holding = false; };
  cv.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  cast.addEventListener('pointerdown', down);
  cast.addEventListener('pointerup', up);

  _built = true;
}

let _fishInfo = null;
function refreshInfo() {
  if (_fishInfo) _fishInfo.textContent = `Lv ${lvl()} · 💰 ${credits()}`;
}

function openFishing(show = true) {
  const w = document.getElementById('fishing-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('fishing'); window.OS.focus('fishing'); }
  if (!_built) build();
  state = 'idle'; msg = 'Tap CAST to fish'; R = null;
  refreshInfo();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
  // keep info fresh
  clearInterval(window._fishInfoT);
  window._fishInfoT = setInterval(refreshInfo, 1000);
}

if (typeof window !== 'undefined') { window.openFishing = openFishing; }
