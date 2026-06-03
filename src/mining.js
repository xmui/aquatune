// Aquatune Mining — a Game Boy Color–styled click-the-rock miner.
//
// Whack the rock with your pickaxe; each hit deals damage = current pick power.
// Break it to earn ore (credits + Mining XP), then a fresh rock (sometimes a
// rarer, richer one) spawns. Spend credits to upgrade your pickaxe through tiers.

const W = 160, H = 144;
const PAL = ['#0f380f', '#306850', '#7ba672', '#cfe8a0'];

const PICKS = [
  { name: 'Wooden',   power: 1,  cost: 0 },
  { name: 'Stone',    power: 2,  cost: 150 },
  { name: 'Iron',     power: 4,  cost: 600 },
  { name: 'Gold',     power: 7,  cost: 2000 },
  { name: 'Diamond',  power: 12, cost: 7000 },
  { name: 'Aquatune', power: 20, cost: 25000 },
];

const ROCKS = [
  { name: 'Stone',    hp: 24,  value: 3,   rarity: 0, color: 1 },
  { name: 'Copper',   hp: 48,  value: 7,   rarity: 1, color: 2 },
  { name: 'Iron',     hp: 90,  value: 14,  rarity: 1, color: 1 },
  { name: 'Gold',     hp: 160, value: 30,  rarity: 2, color: 3 },
  { name: 'Emerald',  hp: 260, value: 60,  rarity: 3, color: 2 },
  { name: 'Diamond',  hp: 440, value: 140, rarity: 4, color: 3 },
];

let cv = null, cx = null, raf = null, _built = false;
let rock = null, swing = 0, shake = 0, particles = [];
let combo = 0, lastHit = 0;
let infoEl = null, shopEl = null;

function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function pickTier() { return Math.max(0, Math.min(PICKS.length - 1, parseInt(localStorage.getItem('aq_mining_pick') || '0', 10) || 0)); }
function pickPower() { return PICKS[pickTier()].power; }
function mineLvl() { return (typeof window.aqSkillLevel === 'function' && window.aqSkillLevel('mining')) || 1; }

function spawnRock() {
  const luck = Math.random() + mineLvl() / 250;
  let pool;
  if (luck > 1.2) pool = ROCKS.filter(r => r.rarity >= 3);
  else if (luck > 0.75) pool = ROCKS.filter(r => r.rarity >= 1 && r.rarity <= 3);
  else pool = ROCKS.filter(r => r.rarity <= 1);
  const def = pool[(Math.random() * pool.length) | 0] || ROCKS[0];
  rock = { def, hp: def.hp, max: def.hp };
}

function breakRock() {
  const r = rock.def;
  const bonus = 1 + Math.min(combo, 10) * 0.05;
  const ore = Math.round(r.value * bonus);
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(ore);
  // Mining gives less XP than other skills: only the "won" trickle, scaled down.
  if (typeof window.aqGameXp === 'function') window.aqGameXp('mining', { played: false, won: true, mult: 0.4 + r.rarity * 0.25 });
  if (typeof window.recordScore === 'function') window.recordScore('mining', ore, r.name);
  // burst of ore particles
  for (let i = 0; i < 14; i++) particles.push({ x: 80, y: 74, vx: (Math.random() - 0.5) * 4, vy: -Math.random() * 4 - 1, life: 30, c: r.color });
  refreshInfo();
  spawnRock();
}

function hit() {
  if (!rock) return;
  const now = performance.now();
  combo = (now - lastHit < 900) ? combo + 1 : 0;
  lastHit = now;
  swing = 1; shake = 6;
  rock.hp -= pickPower();
  for (let i = 0; i < 4; i++) particles.push({ x: 80 + (Math.random() - 0.5) * 30, y: 70 + (Math.random() - 0.5) * 24, vx: (Math.random() - 0.5) * 3, vy: -Math.random() * 3, life: 18, c: rock.def.color });
  if (rock.hp <= 0) breakRock();
}

function px(x, y, w, h, c) { cx.fillStyle = PAL[c] || c; cx.fillRect(x | 0, y | 0, w | 0, h | 0); }

function draw(t) {
  if (!cx) return;
  cx.fillStyle = PAL[3]; cx.fillRect(0, 0, W, H);
  // cave floor / walls
  px(0, 110, W, 34, 1);
  px(0, 0, W, 16, 1);
  const sx = (shake > 0 ? (Math.random() - 0.5) * shake : 0);

  if (rock) {
    const cxp = 80 + sx, cyp = 70;
    const dmg = 1 - rock.hp / rock.max;
    // rock body (pixel blob)
    const c = rock.def.color;
    px(cxp - 26, cyp - 20, 52, 44, 0);
    px(cxp - 22, cyp - 24, 44, 52, c);
    px(cxp - 14, cyp - 18, 12, 10, 3);   // shine
    // cracks deepen with damage
    cx.fillStyle = PAL[0];
    if (dmg > 0.25) cx.fillRect(cxp - 2, cyp - 20, 2, 40);
    if (dmg > 0.5) cx.fillRect(cxp - 18, cyp - 4, 36, 2);
    if (dmg > 0.75) { cx.fillRect(cxp - 12, cyp - 16, 2, 30); cx.fillRect(cxp + 10, cyp - 10, 2, 26); }
    // hp bar
    px(cxp - 26, cyp - 30, 52, 5, 0);
    px(cxp - 25, cyp - 29, Math.max(0, (rock.hp / rock.max) * 50), 3, 2);

    // pickaxe
    const sa = swing > 0 ? (1 - swing) : 1;       // 0=raised .. 1=struck
    const px0 = cxp + 18, py0 = cyp - 34 + sa * 30;
    px(px0, py0, 4, 20, 0);                         // handle
    px(px0 - 8, py0, 20, 5, 2);                     // head
  }

  // particles
  for (const p of particles) px(p.x, p.y, 3, 3, p.c);

  // combo
  if (combo > 1) {
    cx.fillStyle = PAL[0]; cx.font = '8px monospace'; cx.textBaseline = 'top';
    cx.fillText('x' + (combo + 1) + ' combo', 6, 4);
  }
  // rock name banner
  cx.fillStyle = PAL[0]; cx.fillRect(0, H - 14, W, 14);
  cx.fillStyle = PAL[3]; cx.font = '8px monospace'; cx.textBaseline = 'middle';
  cx.fillText(rock ? `${rock.def.name} rock` : '', 4, H - 7);
}

let _lastT = 0;
function tick(t) {
  const dt = Math.min(50, t - (_lastT || t)); _lastT = t;
  if (swing > 0) swing = Math.max(0, swing - dt / 120);
  if (shake > 0) shake = Math.max(0, shake - dt / 30);
  for (const p of particles) { p.x += p.vx; p.y += p.vy; p.vy += 0.25; p.life -= dt / 16; }
  particles = particles.filter(p => p.life > 0);
  draw(t);
  raf = requestAnimationFrame(tick);
}

function refreshInfo() {
  if (infoEl) infoEl.textContent = `${PICKS[pickTier()].name} pick (⛏${pickPower()}) · Lv ${mineLvl()} · 💰 ${credits()}`;
  renderShop();
}

function renderShop() {
  if (!shopEl) return;
  const tier = pickTier();
  shopEl.innerHTML = '';
  if (tier >= PICKS.length - 1) {
    const d = document.createElement('div'); d.className = 'gbc-info'; d.textContent = 'Max pickaxe! ⛏ ' + pickPower();
    shopEl.appendChild(d);
    return;
  }
  const next = PICKS[tier + 1];
  const btn = document.createElement('button');
  btn.className = 'gbc-btn';
  const afford = credits() >= next.cost;
  btn.disabled = !afford;
  btn.textContent = `Upgrade → ${next.name} (⛏${next.power})  💰${next.cost}`;
  btn.addEventListener('click', () => {
    if (credits() < next.cost) return;
    if (typeof window.aqSetCredits === 'function') window.aqSetCredits(credits() - next.cost);
    localStorage.setItem('aq_mining_pick', String(tier + 1));
    refreshInfo();
  });
  shopEl.appendChild(btn);
}

function build() {
  const area = document.getElementById('mining-area');
  if (!area) return;
  area.innerHTML = '';
  const stage = document.createElement('div');
  stage.className = 'gbc-stage';
  cv = document.createElement('canvas'); cv.width = W; cv.height = H; cv.className = 'gbc-canvas';
  stage.appendChild(cv);
  area.appendChild(stage);

  const bar = document.createElement('div'); bar.className = 'gbc-bar';
  const mine = document.createElement('button'); mine.className = 'gbc-btn'; mine.textContent = '⛏️ MINE';
  bar.appendChild(mine);
  infoEl = document.createElement('div'); infoEl.className = 'gbc-info'; bar.appendChild(infoEl);
  area.appendChild(bar);

  shopEl = document.createElement('div'); shopEl.className = 'gbc-bar'; area.appendChild(shopEl);

  cx = cv.getContext('2d'); cx.imageSmoothingEnabled = false;
  const doHit = (e) => { e.preventDefault(); hit(); };
  cv.addEventListener('pointerdown', doHit);
  mine.addEventListener('pointerdown', doHit);
  _built = true;
}

function openMining(show = true) {
  const w = document.getElementById('mining-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; if (raf) { cancelAnimationFrame(raf); raf = null; } return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('mining'); window.OS.focus('mining'); }
  if (!_built) build();
  if (!rock) spawnRock();
  refreshInfo();
  if (!raf) { _lastT = 0; raf = requestAnimationFrame(tick); }
}

if (typeof window !== 'undefined') { window.openMining = openMining; }
