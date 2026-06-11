// Aquatune Scratch-Offs — a corny lottery-kiosk scratch-ticket game.
//
// A stack of gaudy scratch tickets sits on the kiosk counter: scroll (wheel /
// swipe / arrows) to riffle through the designs, hit BUY and you're handed the
// ticket and a lucky coin. Drag the coin across the foil to scratch it off,
// match 3 amounts in the 3×3 play area and win that amount — just like the gas
// station ones, fine print and all. Premium tier: the AquaBuddy Bonanza.
//
// House math: prize weights are derived from each ticket's prize list so every
// prize tier contributes equally to a fixed ~88% RTP (house keeps ~12%), with
// roughly a 1-in-3 ticket win rate. Gambling XP per ticket is small and capped.

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function sfx(n) { try { window.scratchSfx && window.scratchSfx(n); } catch (e) {} }
function fmt(n) { return n.toLocaleString('en-US'); }

const RTP = 0.88;                       // return-to-player per ticket (EV)
const XP_BASE = 0.4, XP_CAP = 3;        // gambling-XP mult dials (small + capped)

// Each design: cost, prize values (smallest ≈ cost), corny theme art bits.
const TICKETS = [
  { id: 'reef',  name: 'Treasure Reef',    cost: 25,
    vals: [25, 50, 75, 250, 1000, 2500],
    syms: ['🐠', '🐚', '🦀', '🐙', '⚓', '🧜‍♀️'],
    tag: 'DIVE FOR RICHES!', burst: 'WIN UP TO 💰2,500!',
    c1: '#0aa3c2', c2: '#045a72', foil: '#9fd8e8', ink: '#fff', accent: '#ffd84a' },
  { id: 'lucky7', name: 'Lucky 7s',        cost: 50,
    vals: [50, 100, 200, 777, 7777],
    syms: ['7️⃣', '🍀', '🔔', '🍒', '⭐', '🎰'],
    tag: 'SEVENS ALL THE WAY DOWN!', burst: 'WIN UP TO 💰7,777!',
    c1: '#c2161f', c2: '#6e0a10', foil: '#f2c3c6', ink: '#fff', accent: '#ffd84a' },
  { id: 'cashcow', name: 'Cash Cow',       cost: 100,
    vals: [100, 200, 500, 1500, 10000],
    syms: ['🐮', '🥛', '💵', '🌾', '🛎️', '🚜'],
    tag: 'UDDERLY LOADED!', burst: 'WIN UP TO 💰10,000!',
    c1: '#2e8a2e', c2: '#14501a', foil: '#bfe4b8', ink: '#fff', accent: '#ffe04a' },
  { id: 'goldrush', name: 'Gold Rush',     cost: 250,
    vals: [250, 500, 1000, 5000, 25000],
    syms: ['⛏️', '🪙', '💰', '🏜️', '🤠', '🐎'],
    tag: 'THERE\'S GOLD IN THEM HILLS!', burst: 'WIN UP TO 💰25,000!',
    c1: '#c2871a', c2: '#7a4d08', foil: '#ecd9a8', ink: '#fff', accent: '#fff2b0' },
  { id: 'buddy', name: 'AquaBuddy Bonanza', cost: 500,
    vals: [500, 1000, 2500, 7777, 77777],
    syms: ['🦆', '🫧', '🌊', '🎵', '🕶️', '👑'],
    tag: 'YOUR BUDDY. YOUR BUCKS.', burst: 'WIN UP TO 💰77,777!',
    c1: '#12b6e8', c2: '#0a4a78', foil: '#aee8f8', ink: '#fff', accent: '#ffe04a', buddy: true },
];

// Equal-EV-per-tier weights: w(v) = RTP*cost / (n*v). Win odds land ~1 in 3.
function prizeTable(t) {
  const n = t.vals.length;
  return t.vals.map(v => ({ v, w: (RTP * t.cost) / (n * v) }));
}
function pickPrize(t) {
  const tbl = prizeTable(t);
  let r = Math.random();
  for (const p of tbl) { r -= p.w; if (r < 0) return p.v; }
  return 0;
}
// Lay out the 3×3 play grid for a predetermined outcome: a win places the prize
// amount exactly 3 times; a loser never lets any amount appear 3 times.
function layoutCells(t, prize) {
  const cells = [];
  const pool = t.vals.filter(v => v !== prize);
  for (let i = pool.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const x = pool[i]; pool[i] = pool[j]; pool[j] = x; }
  if (prize > 0) {
    for (let i = 0; i < 3; i++) cells.push(prize);
    for (let i = 0; i < 6; i++) cells.push(pool[i >> 1]);          // 3 decoy values ×2
  } else {
    for (let i = 0; i < 9; i++) cells.push(pool[i % pool.length]); // ≤2 of anything
    if (pool.length < 5) cells[8] = pool[0];                       // safety (never true: vals≥5)
  }
  for (let i = cells.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const x = cells[i]; cells[i] = cells[j]; cells[j] = x; }
  return cells.map(v => ({ v, sym: t.syms[(Math.random() * t.syms.length) | 0] }));
}

// ── state ────────────────────────────────────────────────────────────────────
let _built = false, area = null, stackEl = null, playEl = null, coinEl = null;
let idx = 0, cur = null;               // cur = { t, prize, cells, done }
let cv = null, ctx = null, scratching = false, _lastSfxAt = 0, _checkT = 0;

function best() { return parseInt(localStorage.getItem('aq_scratch_best') || '0', 10) || 0; }
function setBest(v) {
  if (v <= best()) return;
  try { localStorage.setItem('aq_scratch_best', String(v)); window.aqGamePersist && window.aqGamePersist('aq_scratch_best'); } catch (e) {}
}

// ── ticket face (DOM) ────────────────────────────────────────────────────────
function ticketFace(t, cells) {
  const f = el('div', 'scr-ticket');
  f.style.setProperty('--t1', t.c1); f.style.setProperty('--t2', t.c2);
  f.style.setProperty('--tink', t.ink); f.style.setProperty('--tacc', t.accent);
  const odds = (1 / prizeTable(t).reduce((s, p) => s + p.w, 0)).toFixed(1);
  f.innerHTML =
    `<div class="scr-tkt-head">
       <div class="scr-tkt-name">${t.buddy ? '🦆 ' : ''}${t.name.toUpperCase()}${t.buddy ? ' 🦆' : ''}</div>
       <div class="scr-tkt-burst">${t.burst}</div>
       <div class="scr-tkt-tag">★ ${t.tag} ★</div>
     </div>
     <div class="scr-tkt-grid">${(cells || Array.from({ length: 9 }, () => null)).map(c =>
        `<div class="scr-cell">${c ? `<span class="scr-cell-sym">${c.sym}</span><span class="scr-cell-amt">💰${fmt(c.v)}</span>` : '<span class="scr-cell-q">?</span>'}</div>`).join('')}
     </div>
     <div class="scr-tkt-rule">MATCH 3 AMOUNTS, WIN THAT AMOUNT!</div>
     <div class="scr-tkt-foot">
       <div class="scr-barcode">${'▮▯▮▮▯▮▯▮▮▯▮▮▮▯▮▯▮▮▯▮▮▯▮▯▮'.split('').map(b => `<i class="${b === '▮' ? 'k' : ''}"></i>`).join('')}</div>
       <div class="scr-fine">No. ${String((Math.random() * 9e6) | 0).padStart(7, '0')} · Odds of winning approx. 1 in ${odds}. Overall RTP ${(RTP * 100) | 0}%. Aquatune Lottery Commission. Must be a registered Aquatuner. Please scratch responsibly.</div>
     </div>`;
  return f;
}

// ── kiosk: the stack view ────────────────────────────────────────────────────
function renderStack() {
  if (!stackEl) return;
  const t = TICKETS[idx];
  stackEl.innerHTML = '';
  const pile = el('div', 'scr-pile');
  // edges of the rest of the stack peeking out underneath
  for (let i = Math.min(3, TICKETS.length - 1); i >= 1; i--) {
    const back = el('div', 'scr-pile-back');
    const bt = TICKETS[(idx + i) % TICKETS.length];
    back.style.background = `linear-gradient(135deg, ${bt.c1}, ${bt.c2})`;
    back.style.transform = `translate(${i * 5}px, ${i * 7}px) rotate(${i * 1.3}deg)`;
    back.style.zIndex = 4 - i;
    pile.appendChild(back);
  }
  const face = ticketFace(t);
  face.classList.add('scr-pile-top');
  pile.appendChild(face);
  stackEl.appendChild(pile);

  const nav = el('div', 'scr-nav');
  const left = el('button', 'scr-btn', '◀');
  const dots = el('div', 'scr-dots', TICKETS.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join(''));
  const right = el('button', 'scr-btn', '▶');
  left.onclick = () => cycle(-1); right.onclick = () => cycle(1);
  nav.append(left, dots, right);
  stackEl.appendChild(nav);

  const info = el('div', 'scr-info',
    `<div class="scr-info-name">${t.name}</div>
     <div class="scr-info-sub">🎟️ ${t.cost} credits · top prize 💰${fmt(t.vals[t.vals.length - 1])}${best() ? ` · your best: 💰${fmt(best())}` : ''}</div>`);
  stackEl.appendChild(info);

  const buy = el('button', 'scr-buy', `BUY TICKET — 💰${t.cost}`);
  buy.disabled = credits() < t.cost;
  if (buy.disabled) buy.textContent = `NEED 💰${t.cost} (you have ${fmt(credits())})`;
  buy.onclick = buyTicket;
  stackEl.appendChild(buy);
}
let _cycling = false;
function cycle(dir) {
  if (_cycling || cur) return;
  _cycling = true;
  idx = (idx + dir + TICKETS.length) % TICKETS.length;
  sfx('flip');
  renderStack();
  const top = stackEl.querySelector('.scr-pile-top');
  if (top) { top.classList.add(dir > 0 ? 'scr-in-up' : 'scr-in-down'); }
  setTimeout(() => { _cycling = false; }, 180);
}

// ── buying + scratching ──────────────────────────────────────────────────────
function buyTicket() {
  const t = TICKETS[idx];
  if (cur || credits() < t.cost) return;
  if (typeof window.aqSetCredits === 'function') window.aqSetCredits(credits() - t.cost);
  sfx('buy');
  const prize = pickPrize(t);
  cur = { t, prize, cells: layoutCells(t, prize), done: false, scratched: false };
  renderPlay();
}
function renderPlay() {
  stackEl.style.display = 'none';
  playEl.style.display = 'flex';
  playEl.innerHTML = '';
  const face = ticketFace(cur.t, cur.cells);
  playEl.appendChild(face);
  // foil coating over the play grid only
  const grid = face.querySelector('.scr-tkt-grid');
  grid.style.position = 'relative';
  cv = document.createElement('canvas');
  cv.className = 'scr-foil';
  grid.appendChild(cv);
  requestAnimationFrame(() => paintFoil(grid));
  bindScratch(grid);
  const bar = el('div', 'scr-playbar');
  const reveal = el('button', 'scr-btn scr-reveal', '✨ Reveal all');
  reveal.onclick = () => finishTicket(true);
  const backB = el('button', 'scr-btn', '↩ Back to the stack');
  backB.onclick = backToStack;
  bar.append(reveal, backB);
  playEl.appendChild(bar);
  const hint = el('div', 'scr-hint', '🪙 Here\'s a lucky coin — scratch the silver!');
  playEl.appendChild(hint);
}
function paintFoil(grid) {
  const r = grid.getBoundingClientRect();
  if (!r.width) return;
  cv.width = Math.round(r.width); cv.height = Math.round(r.height);
  cv.style.width = '100%'; cv.style.height = '100%';
  ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, cv.width, cv.height);
  g.addColorStop(0, '#cfd4da'); g.addColorStop(0.25, '#f2f4f6'); g.addColorStop(0.5, '#aeb6be');
  g.addColorStop(0.75, '#e6eaee'); g.addColorStop(1, '#b8bfc8');
  ctx.fillStyle = g; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalAlpha = 0.18; ctx.fillStyle = '#5a6470';
  for (let i = 0; i < cv.width * cv.height / 110; i++) ctx.fillRect(Math.random() * cv.width, Math.random() * cv.height, 1.5, 1.5);
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(cv.width / 2, cv.height / 2); ctx.rotate(-0.22);
  ctx.font = 'bold 13px Verdana,sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(90,100,112,0.5)';
  for (let y = -cv.height; y < cv.height; y += 26)
    ctx.fillText('🍀 AQUATUNE LOTTO 🍀 SCRATCH HERE 🍀', ((y / 26) % 2) * 60, y);
  ctx.restore();
}
function bindScratch(grid) {
  cv.style.touchAction = 'none';
  const scratchAt = (e) => {
    const r = cv.getBoundingClientRect();
    const x = (e.clientX - r.left) * (cv.width / r.width), y = (e.clientY - r.top) * (cv.height / r.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    const now = performance.now();
    if (now - _lastSfxAt > 90) { _lastSfxAt = now; sfx('scratch'); }
    if (now - _checkT > 350) { _checkT = now; if (scratchedFrac() > 0.7) finishTicket(false); }
  };
  cv.addEventListener('pointerdown', e => { e.preventDefault(); scratching = true; try { cv.setPointerCapture(e.pointerId); } catch (_) {} moveCoin(e); scratchAt(e); });
  cv.addEventListener('pointermove', e => { moveCoin(e); if (scratching) scratchAt(e); });
  const up = () => { scratching = false; if (cur && !cur.done && scratchedFrac() > 0.7) finishTicket(false); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerenter', () => { if (coinEl) coinEl.style.display = 'block'; });
  cv.addEventListener('pointerleave', () => { if (coinEl) coinEl.style.display = 'none'; });
}
function scratchedFrac() {
  if (!ctx) return 0;
  try {
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let clear = 0, total = 0;
    for (let i = 3; i < d.length; i += 4 * 16) { total++; if (d[i] < 40) clear++; }   // sample every 16th px
    return total ? clear / total : 0;
  } catch (e) { return 0; }
}
function moveCoin(e) {
  if (!coinEl) return;
  const r = area.getBoundingClientRect();
  coinEl.style.left = (e.clientX - r.left - 17) + 'px';
  coinEl.style.top = (e.clientY - r.top - 17) + 'px';
  coinEl.style.transform = `rotate(${(e.clientX * 0.8) % 360}deg)`;
}

function finishTicket(revealAll) {
  if (!cur || cur.done) return;
  cur.done = true;
  if (cv && ctx) { cv.style.transition = 'opacity .45s'; cv.style.opacity = '0'; setTimeout(() => cv && cv.remove(), 480); }
  if (revealAll) sfx('reveal');
  const t = cur.t, win = cur.prize;
  // highlight the matching trio
  playEl.querySelectorAll('.scr-cell').forEach((c, i) => { if (win > 0 && cur.cells[i].v === win) c.classList.add('scr-cell-win'); });
  // payout + XP + records
  if (win > 0) {
    if (typeof window.aqAddCredits === 'function') window.aqAddCredits(win);
    if (typeof window.recordScore === 'function') window.recordScore('scratch', win, t.name);
    setBest(win);
    const huge = win >= t.cost * 25;
    sfx(huge ? 'jackpot' : 'win');
    if (huge) { try { window.playFanfare?.('jackpot'); } catch (e) {} }
    if (win >= t.cost * 50 && typeof window.aqGameAnnounce === 'function') window.aqGameAnnounce(`scratched a 💰${fmt(win)} winner on a ${t.name} ticket 🎟️`);
    confetti(huge ? 60 : 24);
  } else sfx('lose');
  if (typeof window.aqGameXp === 'function')
    window.aqGameXp('gambling', { played: true, won: win > 0, mult: Math.min(XP_CAP, XP_BASE + Math.log2(t.cost / 25) * 0.35 + (win > 0 ? 0.4 : 0)) });
  // result banner
  const res = el('div', 'scr-result ' + (win > 0 ? 'scr-won' : 'scr-lost'),
    win > 0
      ? `🎉 WINNER! <b>+💰${fmt(win)}</b>${cur.t.buddy && win >= 7777 ? ' — AquaBuddy approves 🦆' : ''}`
      : `Not a winner. <span class="scr-sad">This ticket is not redeemable for hugs.</span>`);
  playEl.insertBefore(res, playEl.querySelector('.scr-playbar'));
  const again = el('button', 'scr-buy', `🎟️ Buy another ${t.name} — 💰${t.cost}`);
  again.disabled = credits() < t.cost;
  again.onclick = () => { cur = null; buyTicket(); };
  playEl.insertBefore(again, playEl.querySelector('.scr-playbar'));
  const hint = playEl.querySelector('.scr-hint'); if (hint) hint.remove();
  if (coinEl) coinEl.style.display = 'none';
}
function backToStack() {
  cur = null; cv = null; ctx = null;
  playEl.style.display = 'none'; playEl.innerHTML = '';
  stackEl.style.display = 'flex';
  if (coinEl) coinEl.style.display = 'none';
  renderStack();
}
function confetti(n) {
  for (let i = 0; i < n; i++) {
    const p = el('i', 'scr-confetti');
    p.style.left = (10 + Math.random() * 80) + '%';
    p.style.background = ['#ffd84a', '#ff5d8f', '#4ad9ff', '#7bff9e', '#ff8a3a'][i % 5];
    p.style.animationDelay = (Math.random() * 0.5) + 's';
    p.style.animationDuration = (1.1 + Math.random() * 0.9) + 's';
    area.appendChild(p);
    setTimeout(() => p.remove(), 2400);
  }
}

// ── build / open ─────────────────────────────────────────────────────────────
function injectStyle() {
  if (document.getElementById('scr-style')) return;
  const s = el('style'); s.id = 'scr-style';
  s.textContent = `
  #scratch-wrap{position:fixed;top:48px;left:50%;transform:translateX(-50%);width:430px;max-width:96vw;
    max-height:calc(100vh - 60px);border-radius:var(--chrome-radius,10px);z-index:540;flex-direction:column;
    background:var(--panel);border:1.5px solid var(--win-border,var(--border));
    box-shadow:var(--win-shadow,0 18px 50px rgba(0,0,0,.45));font-family:var(--font-ui);overflow:hidden}
  #scratch-wrap.open{display:flex}
  #scratch-area{position:relative;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;
    background:linear-gradient(180deg,#5a3520 0%,#46281a 24%,#2e1a10 100%);padding:14px 14px 18px}
  .scr-marquee{flex-shrink:0;text-align:center;font-weight:900;letter-spacing:2px;font-size:13px;color:#ffe9a0;
    text-shadow:0 0 8px rgba(255,200,60,.8),0 1px 0 #000;padding:4px 0 10px;font-family:Georgia,serif}
  .scr-stack,.scr-play{display:flex;flex-direction:column;align-items:center;gap:10px}
  .scr-pile{position:relative;width:300px;height:392px;flex-shrink:0;cursor:ns-resize}
  .scr-pile-back{position:absolute;inset:0;border-radius:10px;border:2px solid rgba(255,255,255,.35);
    box-shadow:0 8px 22px rgba(0,0,0,.5)}
  .scr-ticket{position:relative;width:300px;display:flex;flex-direction:column;border-radius:10px;overflow:hidden;
    background:linear-gradient(160deg,var(--t1),var(--t2));border:2px solid rgba(255,255,255,.6);
    box-shadow:0 10px 26px rgba(0,0,0,.55), inset 0 0 0 4px rgba(255,255,255,.14);color:var(--tink);
    font-family:Verdana,Tahoma,sans-serif;user-select:none}
  .scr-pile-top{position:absolute;inset:0;z-index:5}
  .scr-in-up{animation:scrInUp .18s ease-out}.scr-in-down{animation:scrInDown .18s ease-out}
  @keyframes scrInUp{from{transform:translateY(14px) rotate(2deg);opacity:.4}to{transform:none;opacity:1}}
  @keyframes scrInDown{from{transform:translateY(-14px) rotate(-2deg);opacity:.4}to{transform:none;opacity:1}}
  .scr-tkt-head{text-align:center;padding:10px 8px 6px;background:
    repeating-linear-gradient(135deg,rgba(255,255,255,.08) 0 8px,rgba(0,0,0,.06) 8px 16px)}
  .scr-tkt-name{font-size:19px;font-weight:900;letter-spacing:1px;text-shadow:2px 2px 0 rgba(0,0,0,.45);
    font-family:'Arial Black',Verdana,sans-serif;-webkit-text-stroke:.5px rgba(0,0,0,.3)}
  .scr-tkt-burst{display:inline-block;margin-top:5px;background:radial-gradient(circle,#fff6c8,var(--tacc));
    color:#7a2a08;font-weight:900;font-size:12px;padding:4px 14px;border-radius:50% / 110%;
    border:2px dashed #b8651a;transform:rotate(-2deg);box-shadow:0 2px 6px rgba(0,0,0,.4)}
  .scr-tkt-tag{margin-top:5px;font-size:9.5px;font-weight:700;letter-spacing:1.5px;opacity:.92}
  .scr-tkt-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin:8px;padding:7px;
    background:rgba(255,255,255,.92);border-radius:8px;border:2px solid rgba(0,0,0,.25)}
  .scr-cell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;
    min-height:62px;background:#fdf8ea;border:1.5px dashed #b8a87a;border-radius:6px;color:#3a2a10}
  .scr-cell-sym{font-size:19px;line-height:1.15}
  .scr-cell-amt{font-size:10.5px;font-weight:900;font-variant-numeric:tabular-nums}
  .scr-cell-q{font-size:22px;font-weight:900;color:#b8a87a}
  .scr-cell-win{background:#fff3b8;border:2px solid #e0a020;box-shadow:0 0 10px rgba(255,200,40,.8);animation:scrPulse .7s ease-in-out infinite alternate}
  @keyframes scrPulse{from{transform:scale(1)}to{transform:scale(1.05)}}
  .scr-foil{position:absolute;inset:0;border-radius:6px;cursor:none;z-index:3}
  .scr-tkt-rule{text-align:center;font-size:9px;font-weight:900;letter-spacing:1px;padding:0 8px 4px;color:var(--tacc);text-shadow:1px 1px 0 rgba(0,0,0,.5)}
  .scr-tkt-foot{background:rgba(255,255,255,.92);color:#444;padding:5px 8px 7px}
  .scr-barcode{display:flex;gap:1px;height:14px;align-items:stretch;margin-bottom:3px}
  .scr-barcode i{flex:1;background:#ddd}.scr-barcode i.k{background:#111}
  .scr-fine{font-size:6.6px;line-height:1.35;color:#666}
  .scr-nav{display:flex;align-items:center;gap:10px}
  .scr-dots{display:flex;gap:5px}
  .scr-dots i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.3)}
  .scr-dots i.on{background:#ffd84a}
  .scr-btn{font-family:var(--font-ui);font-weight:800;font-size:12px;color:#3a2410;cursor:pointer;
    background:linear-gradient(180deg,#f5e2b8,#d8b878);border:1.5px solid #8a6a3a;border-radius:8px;padding:6px 12px}
  .scr-btn:hover{filter:brightness(1.07)}
  .scr-buy{font-family:'Arial Black',Verdana,sans-serif;font-weight:900;font-size:14px;letter-spacing:.5px;color:#401a04;
    cursor:pointer;background:linear-gradient(180deg,#ffe04a,#e09a1a);border:2px solid #8a5a10;border-radius:10px;
    padding:10px 22px;box-shadow:0 4px 0 #8a5a10, 0 8px 18px rgba(0,0,0,.4);text-shadow:0 1px 0 rgba(255,255,255,.45)}
  .scr-buy:active:not(:disabled){transform:translateY(3px);box-shadow:0 1px 0 #8a5a10}
  .scr-buy:disabled{filter:grayscale(.7);opacity:.6;cursor:default}
  .scr-info{text-align:center;color:#f2e2c2}
  .scr-info-name{font-weight:900;font-size:14px}
  .scr-info-sub{font-size:11px;opacity:.85;margin-top:2px}
  .scr-playbar{display:flex;gap:8px}
  .scr-hint{font-size:11.5px;color:#ffe9a0;font-weight:700}
  .scr-result{font-size:14px;font-weight:800;color:#fff;text-align:center;padding:7px 14px;border-radius:9px}
  .scr-result b{font-size:17px}
  .scr-won{background:linear-gradient(180deg,#2e8a2e,#14501a);border:2px solid #7bff9e;box-shadow:0 0 18px rgba(120,255,150,.4)}
  .scr-lost{background:rgba(0,0,0,.4);border:1.5px solid rgba(255,255,255,.25)}
  .scr-sad{display:block;font-size:9.5px;font-weight:600;opacity:.7;margin-top:2px}
  .scr-coin{position:absolute;width:34px;height:34px;border-radius:50%;z-index:50;pointer-events:none;display:none;
    background:radial-gradient(circle at 35% 30%,#fff2b0,#f2c12e 45%,#b8821a 90%);
    border:2px solid #8a5a10;box-shadow:0 3px 8px rgba(0,0,0,.5), inset 0 0 0 3px rgba(255,255,255,.35)}
  .scr-coin::after{content:'₳';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
    font-weight:900;font-size:16px;color:#7a4d08;text-shadow:0 1px 0 rgba(255,255,255,.5)}
  .scr-confetti{position:absolute;top:-12px;width:8px;height:13px;z-index:60;pointer-events:none;
    animation:scrFall linear forwards}
  @keyframes scrFall{to{transform:translateY(110vh) rotate(720deg)}}
  @media (max-width:768px){
    #scratch-wrap{width:100vw;top:0;left:0;transform:none;height:100%;max-height:none;border-radius:0}
  }`;
  document.head.appendChild(s);
}

function build() {
  area = document.getElementById('scratch-area');
  if (!area) return;
  injectStyle();
  area.innerHTML = '';
  area.appendChild(el('div', 'scr-marquee', '✨ 🎰 AQUATUNE LOTTO KIOSK 🎰 ✨'));
  stackEl = el('div', 'scr-stack'); area.appendChild(stackEl);
  playEl = el('div', 'scr-play'); playEl.style.display = 'none'; area.appendChild(playEl);
  coinEl = el('div', 'scr-coin'); area.appendChild(coinEl);
  // riffle through the stack: wheel + vertical swipe on the pile
  area.addEventListener('wheel', e => {
    if (cur || !e.target.closest('.scr-pile')) return;
    e.preventDefault();
    cycle(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  let ty = null;
  area.addEventListener('touchstart', e => { if (!cur && e.target.closest('.scr-pile')) ty = e.touches[0].clientY; }, { passive: true });
  area.addEventListener('touchmove', e => {
    if (ty == null) return;
    const dy = e.touches[0].clientY - ty;
    if (Math.abs(dy) > 34) { cycle(dy > 0 ? -1 : 1); ty = e.touches[0].clientY; }
  }, { passive: true });
  area.addEventListener('touchend', () => { ty = null; });
  // keep the BUY button's affordability fresh as credits change elsewhere
  if (!window._scrCreditHook && typeof window.aqAddCredits === 'function') {
    window._scrCreditHook = true;
    const orig = window.aqAddCredits;
    window.aqAddCredits = function (n) { const r = orig.apply(this, arguments); try { refreshAfford(); } catch (e) {} return r; };
  }
  _built = true;
}
function refreshAfford() {
  const w = document.getElementById('scratch-wrap');
  if (!w || !w.classList.contains('open') || cur) return;
  const b = stackEl && stackEl.querySelector('.scr-buy');
  const t = TICKETS[idx];
  if (b) { b.disabled = credits() < t.cost; b.textContent = b.disabled ? `NEED 💰${t.cost} (you have ${fmt(credits())})` : `BUY TICKET — 💰${t.cost}`; }
}

function openScratchers(show = true) {
  const w = document.getElementById('scratch-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('scratch'); window.OS.focus('scratch'); }
  if (!_built) build();
  if (!cur) { playEl.style.display = 'none'; stackEl.style.display = 'flex'; renderStack(); }
}

if (typeof window !== 'undefined') {
  window.openScratchers = openScratchers;
  // test hook: lets the headless harness audit the odds without exporting internals
  if (window.__scrTestHook) window.__scrTestHook({ TICKETS, prizeTable, pickPrize, layoutCells, RTP });
}
