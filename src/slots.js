// Aquatune Slots — a customizable, feature-rich slot machine.
//
// Themed symbol packs, low/med/high volatility, 3×3 or 5×3 grids, adjustable
// bet/lines + autospin, upgraded free spins (expanding+sticky wilds, rising
// multiplier), a gamble/double-up, a pick-a-chest bonus, and a Firebase-synced
// progressive jackpot. Logic lives here; the window chrome + CSS are in
// index.html. Entry points stay global (window.toggleSlots / window.spinSlots).

import { ref, onValue, runTransaction } from 'firebase/database';
import { db } from './firebase.js';

// ── Themed machines ──────────────────────────────────────────────────────────
// roles: wild substitutes; scatter→free spins; bonus→pick-a-chest; jackpot full
// line→progressive. Pool weights/pays are the base (volatility transforms them).
const MACHINES = [
  {
    id: 'music', name: 'Aquatune', cost: 0, skin: 'skin-music',
    wild: '🃏', scatter: '💫', bonus: '🎁', jackpot: '💎',
    pool: [
      { sym: '🃏', cls: 'sym-wild',    weight: 2,  pay: 0 },
      { sym: '💫', cls: 'sym-scatter', weight: 3,  pay: 0 },
      { sym: '🎁', cls: 'sym-bonus',   weight: 3,  pay: 0 },
      { sym: '💎', cls: 'sym-diamond', weight: 2,  pay: 60 },
      { sym: '👑', cls: '',            weight: 6,  pay: 30 },
      { sym: '🎵', cls: '',            weight: 8,  pay: 15 },
      { sym: '⭐', cls: '',            weight: 12, pay: 8 },
      { sym: '🍒', cls: '',            weight: 18, pay: 4 },
      { sym: '🍋', cls: '',            weight: 24, pay: 2 },
      { sym: '🔔', cls: '',            weight: 22, pay: 1.5 },
    ],
  },
  {
    id: 'fruit', name: 'Classic Fruit', cost: 500, skin: 'skin-fruit',
    wild: '🃏', scatter: '🎰', bonus: '🎁', jackpot: '7️⃣',
    pool: [
      { sym: '🃏', cls: 'sym-wild',    weight: 2,  pay: 0 },
      { sym: '🎰', cls: 'sym-scatter', weight: 3,  pay: 0 },
      { sym: '🎁', cls: 'sym-bonus',   weight: 3,  pay: 0 },
      { sym: '7️⃣', cls: 'sym-diamond', weight: 2,  pay: 60 },
      { sym: '🔔', cls: '',            weight: 6,  pay: 25 },
      { sym: '🍉', cls: '',            weight: 8,  pay: 14 },
      { sym: '🍇', cls: '',            weight: 12, pay: 8 },
      { sym: '🍊', cls: '',            weight: 18, pay: 4 },
      { sym: '🍒', cls: '',            weight: 22, pay: 2 },
      { sym: '🍋', cls: '',            weight: 24, pay: 1.5 },
    ],
  },
  {
    id: 'spooky', name: 'Spooky', cost: 2500, skin: 'skin-spooky',
    wild: '🌙', scatter: '🔮', bonus: '🎁', jackpot: '💀',
    pool: [
      { sym: '🌙', cls: 'sym-wild',    weight: 2,  pay: 0 },
      { sym: '🔮', cls: 'sym-scatter', weight: 3,  pay: 0 },
      { sym: '🎁', cls: 'sym-bonus',   weight: 3,  pay: 0 },
      { sym: '💀', cls: 'sym-diamond', weight: 2,  pay: 66 },
      { sym: '👻', cls: '',            weight: 6,  pay: 30 },
      { sym: '🎃', cls: '',            weight: 8,  pay: 15 },
      { sym: '🦇', cls: '',            weight: 12, pay: 8 },
      { sym: '🕷️', cls: '',           weight: 18, pay: 4 },
      { sym: '🕸️', cls: '',           weight: 22, pay: 2 },
      { sym: '🍬', cls: '',            weight: 24, pay: 1.5 },
    ],
  },
  {
    id: 'space', name: 'Deep Space', cost: 10000, skin: 'skin-space',
    wild: '🌟', scatter: '🛸', bonus: '🎁', jackpot: '🪐',
    pool: [
      { sym: '🌟', cls: 'sym-wild',    weight: 2,  pay: 0 },
      { sym: '🛸', cls: 'sym-scatter', weight: 3,  pay: 0 },
      { sym: '🎁', cls: 'sym-bonus',   weight: 3,  pay: 0 },
      { sym: '🪐', cls: 'sym-diamond', weight: 2,  pay: 70 },
      { sym: '👽', cls: '',            weight: 6,  pay: 30 },
      { sym: '🚀', cls: '',            weight: 8,  pay: 15 },
      { sym: '☄️', cls: '',           weight: 12, pay: 8 },
      { sym: '⭐', cls: '',            weight: 18, pay: 4 },
      { sym: '🌕', cls: '',            weight: 22, pay: 2 },
      { sym: '✨', cls: '',            weight: 24, pay: 1.5 },
    ],
  },
];
const MACHINE_BY_ID = Object.fromEntries(MACHINES.map(m => [m.id, m]));

const PAYLINES = {
  3: [[0, 0, 0], [1, 1, 1], [2, 2, 2], [0, 1, 2], [2, 1, 0]],
  5: [[0,0,0,0,0],[1,1,1,1,1],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],[0,0,1,2,2],[2,2,1,0,0],[1,0,1,2,1],[1,2,1,0,1]],
};
// 3-reel: a line is always 3 long → 1×. 5-reel: 3/4/5-of-a-kind (sim-tuned RTP).
function lenMult(n) { return cfg.reels === 3 ? 1 : (n >= 5 ? 3.8 : n === 4 ? 1.1 : 0.5); }
// The per-line multiplier a player actually receives for `n`-of-a-kind of a
// symbol with working pay `pay` (win = betLevel × this). Single source of truth
// shared by the win math AND the paytable, so the advertised number is paid.
function payMult(pay, n) { return Math.round(pay * lenMult(n) * 10) / 10; }

// ── Persisted settings ───────────────────────────────────────────────────────
const DEFAULTS = { machineId: 'music', volatility: 'med', betLevel: 5, lines: 5, reels: 3, unlocked: ['music'] };
let cfg = load();
function load() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('aq_slots') || '{}')); }
  catch { return { ...DEFAULTS }; }
}
function save() { try { localStorage.setItem('aq_slots', JSON.stringify(cfg)); } catch {} }

function machine() { return MACHINE_BY_ID[cfg.machineId] || MACHINES[0]; }
function maxLines() { return PAYLINES[cfg.reels].length; }
function activeLines() { return Math.max(1, Math.min(maxLines(), cfg.lines)); }
function betTotal() { return cfg.betLevel * activeLines(); }

// Global pay scale so line RTP lands ~85–95% (sim-tuned; bet is per-line×lines).
const PAY_SCALE = 4.2;
// volatility-adjusted working pool (cached per machine+vol)
let _poolCache = {};
function pool() {
  const key = cfg.machineId + '|' + cfg.volatility;
  if (_poolCache[key]) return _poolCache[key];
  const v = cfg.volatility;
  const out = machine().pool.map(s => {
    let w = s.weight, pay = s.pay;
    if (pay > 0) {
      // volatility changes hit-frequency (variance), not really EV: high vol
      // makes big symbols rarer & small ones commoner, low vol the reverse.
      if (v === 'high') { w *= s.pay >= 15 ? 0.75 : (s.pay <= 4 ? 1.12 : 1); }
      else if (v === 'low') { w *= s.pay >= 15 ? 1.3 : (s.pay <= 4 ? 0.92 : 1); pay *= 0.9; }
      pay *= PAY_SCALE;
    }
    return { ...s, weight: w, pay: Math.round(pay * 10) / 10 };
  });
  out._total = out.reduce((a, s) => a + s.weight, 0);
  return (_poolCache[key] = out);
}
function pick() { const p = pool(); let r = Math.random() * p._total; for (const s of p) { r -= s.weight; if (r <= 0) return s; } return p[p.length - 1]; }
function isWild(s) { return s && s.sym === machine().wild; }
// Highest-paying *regular* symbol in the working pool (used when a line is
// entirely wild). Excludes the jackpot symbol so all-wild pays the top line
// combo, not the progressive jackpot.
function bestPaySymbol() {
  const j = machine().jackpot;
  return pool().reduce((a, s) => (s.sym !== j && s.pay > (a ? a.pay : 0) ? s : a), null) || pool()[0];
}
// A mid-tier regular symbol (excludes wild/scatter/bonus + the jackpot symbol). Used
// to score all-wild lines DURING FREE SPINS: sticky/expanding wilds make lines go
// all-wild routinely, so paying the absolute top symbol × free multiplier on every
// line at once is wildly overpowered — a mid symbol keeps it rewarding but bounded.
function midPaySymbol() {
  const j = machine().jackpot;
  const paying = pool().filter(s => s.pay > 0 && s.sym !== j).sort((a, b) => a.pay - b.pay);
  return paying.length ? paying[Math.floor(paying.length / 2)] : bestPaySymbol();
}

// ── Runtime state ────────────────────────────────────────────────────────────
let _built = false, spinning = false;
let grid = [];            // grid[reel][row]
let free = 0, freeMulti = 1, sticky = new Set(), cascade = 1, wonThisSpin = false, spinWin = 0;
let autospin = false, autoTimer = null;
let jackpot = 5000, _jackpotBound = false;
let els = {};

function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

// ── Build UI ─────────────────────────────────────────────────────────────────
function build() {
  const body = document.getElementById('slots-body');
  if (!body) return;
  body.innerHTML = '';

  els.jackpot = el('div', 'slots-jackpot', '');
  body.appendChild(els.jackpot);
  els.free = el('div'); els.free.id = 'slots-free-spins-banner'; body.appendChild(els.free);
  els.reels = el('div'); els.reels.id = 'slots-reels'; body.appendChild(els.reels);
  els.win = el('div'); els.win.id = 'slots-win-line'; body.appendChild(els.win);
  els.msg = el('div'); els.msg.id = 'slots-msg'; body.appendChild(els.msg);

  // bet / lines row
  const betRow = el('div'); betRow.id = 'slots-bet-row';
  const betMinus = el('button', 'slots-btn', '−'); betMinus.onclick = () => adjustBet(-1);
  const betPlus = el('button', 'slots-btn', '+'); betPlus.onclick = () => adjustBet(1);
  els.bet = el('span', 'slots-stat', '');
  const lineMinus = el('button', 'slots-btn', '−'); lineMinus.onclick = () => adjustLines(-1);
  const linePlus = el('button', 'slots-btn', '+'); linePlus.onclick = () => adjustLines(1);
  els.lines = el('span', 'slots-stat', '');
  betRow.append(el('span', 'slots-lbl', 'Bet'), betMinus, els.bet, betPlus,
    el('span', 'slots-lbl', 'Lines'), lineMinus, els.lines, linePlus);
  body.appendChild(betRow);

  // controls
  const controls = el('div'); controls.id = 'slots-controls';
  els.spin = el('button', 'slots-btn slots-spin', 'SPIN 🎰'); els.spin.onclick = () => spin();
  els.auto = el('button', 'slots-btn', '↻ Auto'); els.auto.onclick = toggleAuto;
  const gear = el('button', 'slots-btn', '⚙'); gear.onclick = toggleSettings;
  controls.append(els.spin, els.auto, gear);
  body.appendChild(controls);

  els.paytable = el('div'); els.paytable.id = 'slots-paytable'; body.appendChild(els.paytable);

  // settings panel (hidden)
  els.settings = el('div', 'slots-settings'); els.settings.style.display = 'none';
  body.appendChild(els.settings);

  // overlay host (gamble / chest) — covers the reels
  els.overlay = el('div', 'slots-overlay'); els.overlay.style.display = 'none';
  body.appendChild(els.overlay);

  renderReels();
  renderPaytable();
  bindJackpot();
  _built = true;
}

function renderReels() {
  const host = els.reels; if (!host) return;
  host.innerHTML = '';
  const w = document.getElementById('slots-wrap');
  if (w) w.classList.toggle('reels-5', cfg.reels === 5);
  for (let r = 0; r < cfg.reels; r++) {
    const reel = el('div', 'slot-reel'); reel.id = 'slot-reel-' + r;
    reel.appendChild(el('div', 'slot-reel-win-line'));
    const strip = el('div', 'slot-strip'); strip.id = 'slot-strip-' + r;
    reel.appendChild(strip);
    host.appendChild(reel);
  }
  if (!grid.length || grid.length !== cfg.reels) {
    grid = Array.from({ length: cfg.reels }, () => Array.from({ length: 3 }, pick));
  }
  for (let r = 0; r < cfg.reels; r++) drawReel(r);
}

function drawReel(r, highlight = []) {
  const strip = document.getElementById('slot-strip-' + r); if (!strip) return;
  strip.innerHTML = '';
  grid[r].forEach((s, row) => {
    const d = el('div', 'slot-sym' + (s.cls ? ' ' + s.cls : '') + (highlight.includes(row) ? ' sym-win' : ''));
    d.textContent = s.sym; strip.appendChild(d);
  });
}

function renderPaytable() {
  const m = machine(), p = pool();
  const tops = p.filter(s => s.pay > 0).sort((a, b) => b.pay - a.pay).slice(0, 5);
  els.paytable.innerHTML = '';
  els.paytable.appendChild(el('span', null, `${m.wild} Wild`));
  els.paytable.appendChild(el('span', null, `${m.scatter}×3 Free`));
  els.paytable.appendChild(el('span', null, `${m.bonus}×3 Bonus`));
  // Show the exact per-line multiplier the win math pays (payMult). On 5-reel the
  // win depends on run length, so advertise the 3-of-a-kind → 5-of-a-kind range.
  tops.forEach(s => {
    const label = cfg.reels === 5
      ? `${s.sym} ${payMult(s.pay, 3)}–${payMult(s.pay, 5)}×`
      : `${s.sym} ${payMult(s.pay, 3)}×`;
    els.paytable.appendChild(el('span', null, label));
  });
  els.paytable.appendChild(el('span', null, `${cfg.volatility} vol`));
}

function updateUI() {
  if (typeof window.aqRefreshCreditDisplays === 'function') window.aqRefreshCreditDisplays();
  const cr = document.getElementById('slots-credits'); if (cr) cr.textContent = credits();
  if (els.bet) els.bet.textContent = cfg.betLevel;
  if (els.lines) els.lines.textContent = activeLines() + '/' + maxLines();
  if (els.free) {
    els.free.style.display = free > 0 ? '' : 'none';
    if (free > 0) els.free.textContent = `🎰 FREE SPINS: ${free} left (${freeMulti}× multiplier)`;
  }
  if (els.auto) els.auto.classList.toggle('on', autospin);
  if (els.jackpot) els.jackpot.innerHTML = `🏆 JACKPOT <b>${Math.round(jackpot).toLocaleString()}</b>`;
}

function adjustBet(d) { if (spinning) return; cfg.betLevel = Math.max(1, Math.min(500, cfg.betLevel + d * (cfg.betLevel >= 20 ? 5 : 1))); save(); updateUI(); }
function adjustLines(d) { if (spinning) return; cfg.lines = Math.max(1, Math.min(maxLines(), activeLines() + d)); save(); updateUI(); }

// ── Settings panel ───────────────────────────────────────────────────────────
function toggleSettings() {
  const s = els.settings; if (!s) return;
  const showing = s.style.display !== 'none';
  s.style.display = showing ? 'none' : '';
  if (!showing) renderSettings();
}
function renderSettings() {
  const s = els.settings; s.innerHTML = '';
  // machines
  s.appendChild(el('div', 'slots-set-h', 'Machine'));
  const mrow = el('div', 'slots-set-row');
  MACHINES.forEach(m => {
    const owned = cfg.unlocked.includes(m.id) || m.cost === 0;
    const b = el('button', 'slots-chip' + (cfg.machineId === m.id ? ' on' : ''),
      owned ? m.name : `${m.name} 🔒${m.cost}`);
    b.onclick = () => {
      if (owned) { cfg.machineId = m.id; _poolCache = {}; }
      else if (credits() >= m.cost && typeof window.aqSetCredits === 'function') {
        window.aqSetCredits(credits() - m.cost); cfg.unlocked.push(m.id); cfg.machineId = m.id; _poolCache = {};
      } else { flash('Not enough credits to unlock'); return; }
      save(); renderReels(); renderPaytable(); renderSettings(); updateUI();
      const w = document.getElementById('slots-wrap'); if (w) { MACHINES.forEach(mm => w.classList.remove(mm.skin)); w.classList.add(machine().skin); }
    };
    mrow.appendChild(b);
  });
  s.appendChild(mrow);
  // volatility
  s.appendChild(el('div', 'slots-set-h', 'Volatility'));
  const vrow = el('div', 'slots-set-row');
  ['low', 'med', 'high'].forEach(v => {
    const b = el('button', 'slots-chip' + (cfg.volatility === v ? ' on' : ''), v);
    b.onclick = () => { cfg.volatility = v; _poolCache = {}; save(); renderPaytable(); renderSettings(); };
    vrow.appendChild(b);
  });
  s.appendChild(vrow);
  // grid
  s.appendChild(el('div', 'slots-set-h', 'Grid'));
  const grow = el('div', 'slots-set-row');
  [3, 5].forEach(n => {
    const b = el('button', 'slots-chip' + (cfg.reels === n ? ' on' : ''), n + '×3');
    b.onclick = () => { if (spinning) return; cfg.reels = n; cfg.lines = Math.min(cfg.lines, PAYLINES[n].length); grid = []; save(); renderReels(); renderPaytable(); renderSettings(); updateUI(); };
    grow.appendChild(b);
  });
  s.appendChild(grow);
}

function flash(t) { if (els.msg) els.msg.textContent = t; }

// ── Spin ─────────────────────────────────────────────────────────────────────
function toggleAuto() {
  autospin = !autospin; updateUI();
  if (autospin && !spinning) spin();
}
function stopAuto() { autospin = false; if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } updateUI(); }

function spin() {
  if (spinning || overlayOpen()) return;
  const isFree = free > 0;
  if (!isFree) {
    const bet = betTotal();
    if (bet > credits()) { flash('Not enough credits — lower your bet.'); stopAuto(); return; }
    if (typeof window.aqSetCredits === 'function') window.aqSetCredits(credits() - bet);
    addJackpot(bet * 0.005);
  } else { free--; freeMulti = Math.min(10, freeMulti + 1); }
  // spinWin accumulates a whole free-spin session (finish() defers banking until
  // free runs out), so only zero it on a PAID spin — resetting it every free spin
  // would wipe all but the last free spin's winnings.
  spinning = true; cascade = 1; wonThisSpin = false; if (!isFree) spinWin = 0;
  els.spin.disabled = true; flash(''); if (els.win) els.win.textContent = '';
  updateUI(); tone(400, 0.08, 'square', 0.1);

  // new result grid (sticky wild reels forced during free spins)
  for (let r = 0; r < cfg.reels; r++) {
    if (isFree && sticky.has(r)) grid[r] = Array.from({ length: 3 }, () => poolWild());
    else grid[r] = Array.from({ length: 3 }, pick);
  }

  const SPIN_H = 84, SPIN_ROWS = 18; let done = 0;
  for (let r = 0; r < cfg.reels; r++) {
    const strip = document.getElementById('slot-strip-' + r); if (!strip) { done++; continue; }
    const syms = [...grid[r]]; for (let j = 0; j < SPIN_ROWS; j++) syms.push(pick());
    strip.innerHTML = '';
    syms.forEach(s => { const d = el('div', 'slot-sym' + (s.cls ? ' ' + s.cls : '')); d.textContent = s.sym; strip.appendChild(d); });
    const startY = -(SPIN_ROWS * SPIN_H);
    strip.style.transition = 'none'; strip.style.transform = `translateY(${startY}px)`; strip.style.filter = 'blur(5px)';
    const delay = r * 160, dur = 1100 + r * 240;
    setTimeout(() => {
      let t0 = null; const easeOut = t => 1 - Math.pow(1 - t, 3);
      function tick(now) {
        if (!t0) t0 = now; const t = Math.min((now - t0) / dur, 1);
        strip.style.transform = `translateY(${(startY * (1 - easeOut(t))).toFixed(1)}px)`;
        const bl = Math.max(0, (0.45 - t) / 0.45 * 5);
        strip.style.filter = bl > 0.2 ? `blur(${bl.toFixed(1)}px)` : '';
        if (t < 1) requestAnimationFrame(tick);
        else { strip.style.transform = 'translateY(0)'; strip.style.filter = ''; drawReel(r); if (++done === cfg.reels) setTimeout(() => afterSpin(isFree), 80); }
      }
      requestAnimationFrame(tick);
    }, delay);
  }
}
function poolWild() { return machine().pool.find(s => s.sym === machine().wild) || machine().pool[0]; }

function afterSpin(isFree) {
  // free-spins wild expansion (fill reel + make sticky)
  if (isFree) {
    for (let r = 0; r < cfg.reels; r++) {
      if (grid[r].some(isWild) || sticky.has(r)) { grid[r] = Array.from({ length: 3 }, () => poolWild()); sticky.add(r); drawReel(r); }
    }
  }
  // count specials across the whole grid
  let scatter = 0, bonus = 0;
  const m = machine();
  for (let r = 0; r < cfg.reels; r++) for (let row = 0; row < 3; row++) {
    if (grid[r][row].sym === m.scatter) scatter++;
    if (grid[r][row].sym === m.bonus) bonus++;
  }
  if (bonus >= 3) { return chestBonus(); }
  if (scatter >= 3 && free === 0) { free = 8; freeMulti = 1; sticky = new Set(); flash('💫 FREE SPINS! 8 awarded'); fanfare('win'); }
  else if (scatter >= 3) { free += 5; flash('💫 +5 free spins!'); }
  evaluate();
}

function evaluate() {
  const m = machine();
  let total = 0; const winCells = {}; const descs = []; let jackpotHit = false;
  const lines = PAYLINES[cfg.reels].slice(0, activeLines());
  for (const line of lines) {
    const cells = line.map((row, reel) => grid[reel][row]);
    let base = null; for (const c of cells) { if (!isWild(c)) { base = c; break; } }
    // All-wild line: pays the top symbol on a (rare) paid spin, but only a mid-tier
    // symbol during free spins where stacked sticky wilds make all-wild routine.
    if (!base) base = free > 0 ? midPaySymbol() : bestPaySymbol();
    if (base.pay <= 0 && base.sym !== m.jackpot) continue;
    let count = 0; for (const c of cells) { if (c.sym === base.sym || isWild(c)) count++; else break; }
    if (count < 3) continue;
    if (base.sym === m.jackpot && count === cfg.reels) { jackpotHit = true; }
    const mult = free > 0 ? freeMulti : 1;
    // Pay exactly betLevel × the advertised per-line multiplier (payMult), then
    // apply cascade/free-spin multipliers. Keeps awarded credits == paytable.
    const win = Math.round(cfg.betLevel * payMult(base.pay, count) * cascade * mult);
    if (win > 0) {
      total += win; descs.push(`${base.sym}×${count} +${win}`);
      line.forEach((row, reel) => { if (count > reel) { (winCells[reel] = winCells[reel] || new Set()).add(row); } });
    }
  }

  if (jackpotHit) { return winJackpot(); }

  if (total > 0) {
    spinWin += total; wonThisSpin = true;
    if (typeof window.recordScore === 'function') window.recordScore('slots', spinWin, descs[0] || '');
    for (let r = 0; r < cfg.reels; r++) if (winCells[r]) { document.getElementById('slot-reel-' + r)?.classList.add('winning'); drawReel(r, [...winCells[r]]); }
    if (els.win) els.win.textContent = descs.join('  ');
    const big = descs.some(d => new RegExp(m.jackpot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(d)) || total >= cfg.betLevel * 40;
    if (big) { flash(`💰 BIG WIN! +${total}`); fanfare('win'); window.abSaySlots?.('jackpot', '+' + total); if (window.sendGlobalMessage) { const u = localStorage.getItem('aq_username') || 'Someone'; window.sendGlobalMessage(`🎰 ${u} hit a big win (${total}) on AquaSlots!`); } window.unlockTheme?.('neon'); }
    else { tone(880, 0.15, 'sine', 0.12); setTimeout(() => tone(1100, 0.15, 'sine', 0.12), 110); window.abSaySlots?.('win'); }
    cascade++;
    setTimeout(() => {
      for (let r = 0; r < cfg.reels; r++) document.getElementById('slot-reel-' + r)?.classList.remove('winning');
      if (cascade <= 3) {
        for (let r = 0; r < cfg.reels; r++) if (winCells[r]) winCells[r].forEach(row => { grid[r][row] = pick(); });
        for (let r = 0; r < cfg.reels; r++) drawReel(r);
        setTimeout(evaluate, 260); return;
      }
      finish();
    }, 650);
  } else {
    tone(120, 0.3, 'sawtooth', 0.12); window.abSaySlots?.('lose'); finish();
  }
}

function finish() {
  spinning = false; els.spin.disabled = false;
  // Balanced toward ~50/min: a winning spin's XP scales modestly with how big the win was
  // relative to the bet (capped); losing spins stay at the small played trickle.
  if (window.aqGameXp) {
    const betT = (typeof betTotal === 'function' ? betTotal() : 0);
    const mult = wonThisSpin && betT > 0 ? Math.min(2.5, 1 + (spinWin / betT) * 0.1) : 1;
    window.aqGameXp('gambling', { played: true, won: wonThisSpin, luck: 0.4, mult });
  }
  // free spins continue automatically
  if (free > 0) { updateUI(); setTimeout(() => { if (!spinning) spin(); }, 700); return; }
  // offer gamble on a real win (skipped during autospin / when broke handled)
  if (spinWin > 0 && !autospin) { updateUI(); return openGamble(spinWin); }
  if (spinWin > 0) bank(spinWin);
  updateUI();
  if (autospin) autoTimer = setTimeout(() => { if (autospin && !spinning) spin(); }, 700);
}
function bank(amt) { if (amt > 0 && typeof window.aqAddCredits === 'function') window.aqAddCredits(amt); spinWin = 0; updateUI(); }

// ── Gamble / double-up ───────────────────────────────────────────────────────
function overlayOpen() { return els.overlay && els.overlay.style.display !== 'none'; }
function closeOverlay() { if (els.overlay) { els.overlay.style.display = 'none'; els.overlay.innerHTML = ''; } }

function openGamble(amount) {
  let rounds = 0;
  const o = els.overlay; o.innerHTML = ''; o.style.display = '';
  const paint = () => {
    o.innerHTML = '';
    o.appendChild(el('div', 'slots-ov-title', 'GAMBLE — double or nothing'));
    o.appendChild(el('div', 'slots-ov-amt', `${amount} 💰`));
    const row = el('div', 'slots-ov-row');
    const red = el('button', 'slots-btn slots-gamble-red', '🔴 Red');
    const black = el('button', 'slots-btn slots-gamble-black', '⚫ Black');
    const guess = (choice) => {
      if (rounds >= 6) return;
      rounds++;
      const win = Math.random() < 0.5; const result = win ? choice : (choice === 'red' ? 'black' : 'red');
      tone(win ? 880 : 160, 0.18, win ? 'triangle' : 'sawtooth', 0.14);
      if (win) { amount *= 2; if (rounds >= 6) { flash('Max gamble!'); bank(amount); closeOverlay(); afterGamble(); } else paint(); }
      else { flash('Gambled it away!'); spinWin = 0; closeOverlay(); afterGamble(); }
    };
    red.onclick = () => guess('red'); black.onclick = () => guess('black');
    row.append(red, black); o.appendChild(row);
    const collect = el('button', 'slots-btn slots-collect', `Collect ${amount} 💰`);
    collect.onclick = () => { bank(amount); closeOverlay(); afterGamble(); };
    o.appendChild(collect);
  };
  paint();
}
function afterGamble() { updateUI(); if (autospin) autoTimer = setTimeout(() => { if (autospin && !spinning) spin(); }, 500); }

// ── Pick-a-chest bonus ───────────────────────────────────────────────────────
function chestBonus() {
  const o = els.overlay; o.innerHTML = ''; o.style.display = '';
  o.appendChild(el('div', 'slots-ov-title', '🎁 BONUS — pick a chest!'));
  fanfare('win');
  const row = el('div', 'slots-ov-row');
  const prizes = [2, 4, 6, 8, 12, 20].sort(() => Math.random() - 0.5).slice(0, 4);
  prizes.forEach((mult, i) => {
    const b = el('button', 'slots-chest', '🎁');
    b.onclick = () => {
      if (b.disabled) return;
      [...row.children].forEach(c => c.disabled = true);
      const prize = betTotal() * mult;
      b.textContent = '💰'; b.classList.add('open');
      flash(`Bonus: +${prize}!`); spinWin += prize; tone(1200, 0.2, 'triangle', 0.14);
      setTimeout(() => { closeOverlay(); evaluate(); }, 900);
    };
    row.appendChild(b);
  });
  o.appendChild(row);
}

// ── Progressive jackpot (Firebase-synced, local fallback) ────────────────────
function bindJackpot() {
  if (_jackpotBound) return; _jackpotBound = true;
  try {
    onValue(ref(db, 'slots/jackpot'), snap => { const v = snap.val(); if (typeof v === 'number' && isFinite(v)) { jackpot = v; updateUI(); } });
  } catch {}
}
function addJackpot(amt) {
  if (!isFinite(amt) || amt <= 0) return;
  jackpot += amt;
  try { runTransaction(ref(db, 'slots/jackpot'), cur => (typeof cur === 'number' && isFinite(cur) ? cur : 5000) + amt); } catch {}
}
function winJackpot() {
  const pot = Math.round(jackpot);
  flash(`🏆 JACKPOT!! +${pot.toLocaleString()}`); fanfare('jackpot');
  spinWin += pot;
  if (window.sendGlobalMessage) { const u = localStorage.getItem('aq_username') || 'Someone'; window.sendGlobalMessage(`🏆 ${u} WON THE SLOTS JACKPOT (${pot})!`); }
  try { runTransaction(ref(db, 'slots/jackpot'), () => 5000); } catch {}
  jackpot = 5000;
  cascade = 99; // end cascades
  setTimeout(finish, 400);
}

// ── audio helpers ────────────────────────────────────────────────────────────
function tone(f, d, t, v) { try { window.playTone?.(f, d, t, v); } catch {} }
function fanfare(l) { try { window.playFanfare?.(l); } catch {} }

// ── open/close + globals ─────────────────────────────────────────────────────
function toggleSlots(force) {
  const w = document.getElementById('slots-wrap'); if (!w) return;
  const opening = force != null ? !!force : !w.classList.contains('open');
  w.classList.toggle('open', opening);   // CSS `.open{display:flex}` (matches the original)
  if (opening) {
    if (!_built) build();
    MACHINES.forEach(m => w.classList.remove(m.skin)); w.classList.add(machine().skin);
    updateUI(); window.abSaySlots?.('open');
  } else { stopAuto(); closeOverlay(); }
}

if (typeof window !== 'undefined') {
  window.toggleSlots = toggleSlots;
  window.spinSlots = () => spin();
  window.slotsAdjustBet = (d) => adjustBet(d > 0 ? 1 : -1);
}
