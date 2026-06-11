// Roulette — an American (0 + 00) roulette table dressed in retro blue "Luna"
// chrome. Bet credits on the felt, spin the wheel, earn Gambling XP.
//
// Reuses the shared economy (window.aqGetCredits/aqSetCredits/aqAddCredits) and XP
// hook (window.aqGameXp('gambling', …)). Best win persists via gamesave
// (aq_roulette_best_win, registered in src/gamesave.js TIER_KEYS).

const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
// American wheel pocket sequence (visual order, clockwise from the top 0).
const WHEEL = ['0', '28', '9', '26', '30', '11', '7', '20', '32', '17', '5', '22', '34', '15', '3', '24', '36', '13', '1',
  '00', '27', '10', '25', '29', '12', '8', '19', '31', '18', '6', '21', '33', '16', '4', '23', '35', '14', '2'];
const SEG = 360 / WHEEL.length;
const CHIPS = [5, 25, 100, 500];

let _built = false, _spinning = false;
let bets = {};            // betKey -> amount
let chip = 25;
let rot = 0;              // accumulated wheel rotation
let history = [];         // recent results (strings)

function sfx(n) { try { window.rouletteSfx && window.rouletteSfx(n); } catch (e) {} }
function credits() { return (window.aqGetCredits && window.aqGetCredits()) || 0; }
function setCredits(n) { window.aqSetCredits && window.aqSetCredits(Math.max(0, Math.round(n))); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function colorOf(n) { if (n === '0' || n === '00') return 'green'; return RED.has(parseInt(n, 10)) ? 'red' : 'black'; }
function totalBet() { let t = 0; for (const k in bets) t += bets[k]; return t; }

// ── wheel svg ──────────────────────────────────────────────────────────────────────
function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; }
function wedge(cx, cy, r, a0, a1) {
  const p0 = polar(cx, cy, r, a0), p1 = polar(cx, cy, r, a1);
  return `M ${cx} ${cy} L ${p0.x.toFixed(2)} ${p0.y.toFixed(2)} A ${r} ${r} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} Z`;
}
function wheelSvg() {
  const cx = 130, cy = 130, r = 124;
  let segs = '', labels = '';
  WHEEL.forEach((n, i) => {
    const a0 = i * SEG, a1 = (i + 1) * SEG, mid = a0 + SEG / 2;
    const col = colorOf(n) === 'red' ? '#c8102e' : colorOf(n) === 'green' ? '#0a8a3a' : '#1b1b1b';
    segs += `<path d="${wedge(cx, cy, r, a0, a1)}" fill="${col}" stroke="#d9b441" stroke-width="0.6"/>`;
    const lp = polar(cx, cy, r - 13, mid);
    labels += `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" font-size="8.5" fill="#fff" font-weight="700" text-anchor="middle" dominant-baseline="middle" transform="rotate(${mid} ${lp.x.toFixed(1)} ${lp.y.toFixed(1)})">${n}</text>`;
  });
  return `
    <svg viewBox="0 0 260 260" class="rl-wheel-svg">
      <circle cx="${cx}" cy="${cy}" r="128" fill="#3a2a10" stroke="#d9b441" stroke-width="3"/>
      <g id="rl-wheel-rot" style="transform-origin:${cx}px ${cy}px;">${segs}${labels}</g>
      <circle cx="${cx}" cy="${cy}" r="34" fill="#caa23c" stroke="#8a6a18" stroke-width="2"/>
      <circle cx="${cx}" cy="${cy}" r="14" fill="#7a5c12"/>
    </svg>
    <div class="rl-pointer">▼</div>`;
}

// ── betting table ────────────────────────────────────────────────────────────────────
function numCell(n) {
  const c = colorOf(n);
  return `<button class="rl-num rl-${c}" data-bet="n:${n}">${n}<span class="rl-chip-amt" data-amt="n:${n}"></span></button>`;
}
function tableHtml() {
  // 3 rows x 12 cols, standard layout (top row 3,6,…; bottom row 1,4,…) + column bets.
  let rows = '';
  for (let row = 0; row < 3; row++) {
    let cells = '';
    for (let col = 0; col < 12; col++) {
      const n = String(col * 3 + (3 - row));   // row0→+3 (top), row2→+1 (bottom)
      cells += numCell(n);
    }
    const colIdx = 3 - row;   // top row is column 3, bottom is column 1
    cells += `<button class="rl-out rl-colbet" data-bet="col:${colIdx}">2:1<span class="rl-chip-amt" data-amt="col:${colIdx}"></span></button>`;
    rows += `<div class="rl-row">${cells}</div>`;
  }
  const dozens = `<div class="rl-row rl-dozens">
    <button class="rl-out" data-bet="doz:1">1st 12<span class="rl-chip-amt" data-amt="doz:1"></span></button>
    <button class="rl-out" data-bet="doz:2">2nd 12<span class="rl-chip-amt" data-amt="doz:2"></span></button>
    <button class="rl-out" data-bet="doz:3">3rd 12<span class="rl-chip-amt" data-amt="doz:3"></span></button></div>`;
  const outside = `<div class="rl-row rl-evens">
    <button class="rl-out" data-bet="low">1-18<span class="rl-chip-amt" data-amt="low"></span></button>
    <button class="rl-out" data-bet="even">EVEN<span class="rl-chip-amt" data-amt="even"></span></button>
    <button class="rl-out rl-red" data-bet="red">RED<span class="rl-chip-amt" data-amt="red"></span></button>
    <button class="rl-out rl-black" data-bet="black">BLACK<span class="rl-chip-amt" data-amt="black"></span></button>
    <button class="rl-out" data-bet="odd">ODD<span class="rl-chip-amt" data-amt="odd"></span></button>
    <button class="rl-out" data-bet="high">19-36<span class="rl-chip-amt" data-amt="high"></span></button></div>`;
  const zeros = `<div class="rl-row rl-zeros">
    <button class="rl-num rl-green" data-bet="n:0">0<span class="rl-chip-amt" data-amt="n:0"></span></button>
    <button class="rl-num rl-green" data-bet="n:00">00<span class="rl-chip-amt" data-amt="n:00"></span></button></div>`;
  return `<div class="rl-table">${zeros}${rows}${dozens}${outside}</div>`;
}

function build() {
  const area = document.getElementById('roulette-area');
  if (!area) return;
  area.innerHTML = `
    <div class="rl-top">
      <div class="rl-wheel">${wheelSvg()}</div>
      <div class="rl-info">
        <div class="rl-result" id="rl-result">Place your bets</div>
        <div class="rl-history" id="rl-history"></div>
        <div class="rl-stat">Balance <span class="aq-credits-display" id="rl-bal">💰 ${credits().toLocaleString()}</span></div>
        <div class="rl-stat">On table <b id="rl-onbet">0</b></div>
      </div>
    </div>
    ${tableHtml()}
    <div class="rl-controls">
      <div class="rl-chips" id="rl-chips"></div>
      <button class="rl-cbtn rl-clear" id="rl-clear">Clear</button>
      <button class="rl-cbtn rl-spin" id="rl-spin">SPIN</button>
    </div>`;
  // chip selector
  const chipsEl = area.querySelector('#rl-chips');
  CHIPS.forEach(v => {
    const b = document.createElement('button');
    b.className = 'rl-chipbtn'; b.dataset.chip = v; b.textContent = v;
    b.onclick = () => { chip = v; syncChips(); };
    chipsEl.appendChild(b);
  });
  // bet cells
  area.querySelectorAll('[data-bet]').forEach(btn => btn.addEventListener('click', () => placeBet(btn.dataset.bet)));
  area.querySelector('#rl-clear').onclick = clearBets;
  area.querySelector('#rl-spin').onclick = spin;
  _built = true;
  syncChips();
}

function syncChips() {
  document.querySelectorAll('.rl-chipbtn').forEach(b => b.classList.toggle('on', parseInt(b.dataset.chip, 10) === chip));
}

function placeBet(key) {
  if (_spinning) return;
  if (credits() < chip) { flash('Not enough credits'); return; }
  setCredits(credits() - chip);          // escrow the stake immediately
  bets[key] = (bets[key] || 0) + chip;
  sfx('chip');
  refreshBets();
}
function clearBets() {
  if (_spinning) return;
  const refund = totalBet();
  if (refund > 0) setCredits(credits() + refund);
  bets = {};
  refreshBets();
}
function refreshBets() {
  document.querySelectorAll('.rl-chip-amt').forEach(s => {
    const v = bets[s.dataset.amt];
    s.textContent = v ? v : '';
    s.classList.toggle('on', !!v);
  });
  const onbet = document.getElementById('rl-onbet'); if (onbet) onbet.textContent = totalBet().toLocaleString();
  const bal = document.getElementById('rl-bal'); if (bal) bal.textContent = '💰 ' + credits().toLocaleString();
}

function flash(msg) {
  const r = document.getElementById('rl-result');
  if (!r) return;
  const prev = r.textContent; r.textContent = msg;
  setTimeout(() => { if (r.textContent === msg) r.textContent = prev; }, 1200);
}

function isWinner(key, n) {
  const num = parseInt(n, 10);
  const isNum = n !== '0' && n !== '00';
  if (key.startsWith('n:')) return key.slice(2) === n;
  if (!isNum) return false;                      // 0/00 lose all outside bets
  switch (key) {
    case 'red': return RED.has(num);
    case 'black': return !RED.has(num);
    case 'odd': return num % 2 === 1;
    case 'even': return num % 2 === 0;
    case 'low': return num >= 1 && num <= 18;
    case 'high': return num >= 19 && num <= 36;
    case 'doz:1': return num <= 12;
    case 'doz:2': return num >= 13 && num <= 24;
    case 'doz:3': return num >= 25;
    case 'col:1': return num % 3 === 1;
    case 'col:2': return num % 3 === 2;
    case 'col:3': return num % 3 === 0;
  }
  return false;
}
function payoutMult(key) {
  if (key.startsWith('n:')) return 35;
  if (key.startsWith('doz:') || key.startsWith('col:')) return 2;
  return 1;   // even-money
}

function spin() {
  if (_spinning) return;
  const staked = totalBet();
  if (staked <= 0) { flash('Place a bet first'); return; }
  _spinning = true;
  const spinBtn = document.getElementById('rl-spin'); if (spinBtn) spinBtn.disabled = true;
  const result = WHEEL[Math.floor(Math.random() * WHEEL.length)];
  const idx = WHEEL.indexOf(result);
  // spin several turns then settle with the result pocket under the top pointer
  rot += 360 * (5 + Math.floor(Math.random() * 4)) + (360 - (idx + 0.5) * SEG) - (rot % 360);
  const rotG = document.getElementById('rl-wheel-rot');
  if (rotG) { rotG.style.transition = 'transform 4.2s cubic-bezier(.17,.67,.18,1)'; rotG.style.transform = `rotate(${rot}deg)`; }
  sfx('spin');
  let ticks = 0;
  const tickTmr = setInterval(() => { sfx('tick'); if (++ticks > 16) clearInterval(tickTmr); }, 220);

  setTimeout(() => {
    clearInterval(tickTmr);
    resolve(result, staked);
    _spinning = false;
    if (spinBtn) spinBtn.disabled = false;
  }, 4300);
}

function resolve(result, staked) {
  let returned = 0, won = 0;
  for (const key in bets) {
    if (isWinner(key, result)) { const w = bets[key] * (payoutMult(key) + 1); returned += w; won += w - bets[key]; }
  }
  if (returned > 0) setCredits(credits() + returned);

  const col = colorOf(result);
  history.unshift(result); history = history.slice(0, 12);
  const hEl = document.getElementById('rl-history');
  if (hEl) hEl.innerHTML = history.map(h => `<span class="rl-hist rl-${colorOf(h)}">${h}</span>`).join('');
  const rEl = document.getElementById('rl-result');
  const net = returned - staked;
  if (rEl) {
    rEl.innerHTML = `<span class="rl-${col}-txt">${result}</span> · ` +
      (net > 0 ? `You won +${net.toLocaleString()} 🎉` : net === 0 ? `Push` : `No win`);
  }
  sfx(net > 0 ? 'win' : 'lose');

  // best-win persistence
  if (net > 0) {
    try {
      const best = parseInt(localStorage.getItem('aq_roulette_best_win') || '0', 10);
      if (net > best) { localStorage.setItem('aq_roulette_best_win', String(net)); window.aqGamePersist && window.aqGamePersist('aq_roulette_best_win'); }
    } catch (e) {}
    if (net >= 2000 && window.sendGlobalMessage) {
      const u = localStorage.getItem('aq_username') || 'Someone';
      window.sendGlobalMessage(`🎡 ${u} won ${net.toLocaleString()} on Roulette (${result})!`);
    }
  }

  // Gambling XP — scale with stake, capped so normal play can't trip anti-cheat.
  if (window.aqGameXp) {
    const betFactor = Math.min(4, 1 + Math.log10(1 + staked) * 0.8);
    const mult = Math.min(20, betFactor * (net > 0 ? (1 + Math.min(6, net / Math.max(1, staked)) * 0.1) : 0.6));
    window.aqGameXp('gambling', { played: true, won: net > 0, luck: 0.4, mult });
  }

  bets = {};
  refreshBets();
}

function openRoulette(show = true) {
  const w = document.getElementById('roulette-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('roulette'); window.OS.focus('roulette'); }
  if (!_built) build();
  refreshBets();
}

if (typeof window !== 'undefined') {
  window.openRoulette = openRoulette;
}

export { openRoulette, isWinner, payoutMult };
