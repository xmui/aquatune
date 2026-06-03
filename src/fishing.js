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

// Stardew-style reel tuning. The green "catch bar" is raised by CLICKING (each
// click is an upward impulse); gravity constantly pulls it down. The bar is
// heavy/weighted (momentum via damping) so control is slow and deliberate.
const TRACK_H = 120;       // playable height of the vertical reel track (px)
const F_GRAV = 0.018;      // downward acceleration per ~16ms frame
const F_IMPULSE = 1.05;    // upward velocity added per click
const F_DAMP = 0.94;       // momentum retained per frame (weighted feel)
// Fish behaviors, mirroring Stardew's motion types (erraticness ∝ difficulty).
const MOTIONS = ['smooth', 'sinker', 'floater', 'dart', 'mixed'];


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
  // Stardew maps difficulty 1..100 → bar size & fish erraticness. We derive a
  // difficulty from rarity. Bar is LONG by default (forgiving), shrinking a
  // little with rarity and growing with Fishing level.
  const difficulty = 8 + fish.rarity * 16;
  const zone = Math.max(48, 94 - fish.rarity * 5 + lvl() * 0.4);
  const motion = fish.rarity >= 3 ? 'dart' : MOTIONS[(Math.random() * 4) | 0];
  state = 'reel';
  msg = 'Click to reel it in!';
  R = {
    fish, difficulty, motion,
    zoneH: zone,                  // px height of the green catch bar (long)
    zoneY: TRACK_H - zone,        // top of catch zone (player-controlled)
    vel: 0,                       // bar velocity (weighted momentum)
    fishY: 60,                    // fish position on track
    fishV: 0,
    fishTarget: 60,
    progress: 55,                 // 0..100, lose at 0, win at 100 (head start)
  };
}

// One click = one upward pump. Spam clicks to rise; stop to let it sink.
function pump() { if (state === 'reel' && R) R.vel -= F_IMPULSE; }

// Move the fish according to its Stardew-style motion type.
function moveFish(R, f, dt) {
  const d = R.difficulty;
  let chance, lo = 2, hi = 118;
  switch (R.motion) {
    case 'smooth':  chance = 0.010; break;
    case 'sinker':  chance = 0.018; lo = 55; break;   // tends to sink (lower on track)
    case 'floater': chance = 0.018; hi = 65; break;   // tends to rise
    case 'dart':    chance = 0.045 + d / 100 * 0.04; break; // jumpy; amplitude ∝ difficulty
    default:        chance = 0.022; break;            // mixed
  }
  if (Math.random() < chance * f) {
    if (R.motion === 'dart') {
      const amp = 30 * (1 + d / 50);                  // [2×difficulty]%-ish bigger jumps
      R.fishTarget = Math.max(2, Math.min(118, R.fishY + (Math.random() * 2 - 1) * amp));
    } else {
      R.fishTarget = lo + Math.random() * (hi - lo);
    }
  }
  const seek = (R.motion === 'dart' ? 0.0055 : 0.0032);
  R.fishV += (R.fishTarget - R.fishY) * seek * dt;
  R.fishV *= 0.88;
  R.fishY += R.fishV;
  R.fishY = Math.max(2, Math.min(118, R.fishY));
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

// A press either starts a cast (when idle) or pumps the bar (during reel).
function press() {
  if (state === 'bite') { startReel(); pump(); }
  else if (state === 'reel') pump();
  else if (state === 'idle' || state === 'caught' || state === 'miss') startCast();
}

let _lastT = 0;
function tick(t) {
  const dt = Math.min(50, t - (_lastT || t)); _lastT = t;
  const f = dt / 16;
  if (state === 'casting' && t >= biteAt) { state = 'bite'; msg = '! BITE ! Click to reel!'; biteAt = t; }
  if (state === 'bite' && t - biteAt > 2600) { loseFish(); } // generous bite window
  if (state === 'reel' && R) {
    // weighted bar physics: gravity pulls down, clicks pump up, momentum lingers
    R.vel += F_GRAV * f;
    R.vel *= Math.pow(F_DAMP, f);
    R.zoneY += R.vel * f;
    const maxY = TRACK_H - R.zoneH;
    if (R.zoneY < 0) { R.zoneY = 0; if (R.vel < 0) R.vel *= -0.3; }   // soft bounce
    if (R.zoneY > maxY) { R.zoneY = maxY; if (R.vel > 0) R.vel *= -0.2; }
    moveFish(R, f, dt);
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
  cast.textContent = '🎣 CAST / PUMP';
  bar.appendChild(cast);
  const info = document.createElement('div');
  info.className = 'gbc-info';
  bar.appendChild(info);
  area.appendChild(bar);
  _fishInfo = info;

  cx = cv.getContext('2d');
  cx.imageSmoothingEnabled = false;

  // input: each press is a "pump" (cast when idle, raise the bar during reel)
  const down = (e) => { e.preventDefault(); press(); };
  cv.addEventListener('pointerdown', down);
  cast.addEventListener('pointerdown', down);
  // keyboard: space pumps too
  if (!window._fishKeyBound) {
    window._fishKeyBound = true;
    window.addEventListener('keydown', (e) => {
      const w = document.getElementById('fishing-wrap');
      if (e.code === 'Space' && w && w.classList.contains('open')) { e.preventDefault(); press(); }
    });
  }

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
