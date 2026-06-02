// Aquatune Exchange — a Cruelty-Squad-style satirical stock market.
//
// Design: ONE global market shared by every client, with NO server. Prices are a
// pure deterministic function of (seed, stockId, tickIndex), so every device
// reconstructs the identical price path, crashes and rallies included. The seed +
// genesis time live in Firebase (write-once) so the market survives app updates.
// Periodic snapshots keep per-frame compute bounded.
//
// Volatility is a *fluctuating mix* of calm and chaotic: a global "regime" value
// drifts slowly between 0 (calm) and 1 (chaotic), driving step size and the
// frequency of marketwide crashes/pumps.

import { ref, get, set, runTransaction, serverTimestamp } from 'firebase/database';
import { db } from './firebase.js';

// ---------------------------------------------------------------------------
// Fictional, parody "stocks" — Cruelty-Squad-flavoured joke companies. Edit
// freely: { id, ticker, name, basePrice, beta, vol }. beta = sensitivity to the
// marketwide move; vol = idiosyncratic jitter multiplier.
// ---------------------------------------------------------------------------
const STOCKS = [
  { id:'blz', ticker:'BLZ',  name:'Blaze Cannabis Holdings',     basePrice:42,   beta:1.2, vol:1.4 },
  { id:'snow',ticker:'SNOW', name:'Nose Candy Logistics Inc.',   basePrice:88,   beta:1.6, vol:2.2 },
  { id:'crnk',ticker:'CRNK', name:'Crankhouse Chemical Co.',     basePrice:13,   beta:1.8, vol:2.6 },
  { id:'huff',ticker:'HUFF', name:'HuffCo Vapor & Nicotine',     basePrice:27,   beta:0.9, vol:1.1 },
  { id:'orgn',ticker:'ORGN', name:'Organ Liquidity Partners',    basePrice:155,  beta:1.4, vol:1.7 },
  { id:'gun', ticker:'GUNZ', name:'Freedom Hardware Group',      basePrice:64,   beta:1.1, vol:1.3 },
  { id:'cult',ticker:'CULT', name:'Ascension Wellness Cult',     basePrice:9,    beta:1.5, vol:2.4 },
  { id:'spam',ticker:'SPAM', name:'Unsolicited Comms LLC',       basePrice:3.5,  beta:0.7, vol:1.0 },
  { id:'bone',ticker:'BONE', name:'Skeleton Futures Trust',      basePrice:120,  beta:1.3, vol:1.6 },
  { id:'gulp',ticker:'GULP', name:'Gulpco Beverage Sludge',      basePrice:18,   beta:0.8, vol:1.2 },
  { id:'tox', ticker:'TOXX', name:'Toxic Runoff Reclamation',    basePrice:31,   beta:1.7, vol:2.1 },
  { id:'fame',ticker:'FAME', name:'Influencer Capital Holdings', basePrice:200,  beta:2.0, vol:2.8 },
  { id:'rent',ticker:'RENT', name:'Slumlord Equity REIT',        basePrice:240,  beta:1.0, vol:1.1 },
  { id:'meds',ticker:'MEDS', name:'Painless Pharma Group',       basePrice:76,   beta:1.2, vol:1.5 },
  { id:'lure',ticker:'LURE', name:'Gambling Reflex Systems',     basePrice:49,   beta:1.6, vol:2.0 },
  { id:'goop',ticker:'GOOP', name:'Artisanal Goop Collective',   basePrice:6.5,  beta:0.9, vol:1.3 },
  { id:'doom',ticker:'DOOM', name:'Doomsday Bunker Brands',      basePrice:310,  beta:0.6, vol:1.0 },
  { id:'meat',ticker:'MEAT', name:'Mystery Meat Industries',     basePrice:22,   beta:1.1, vol:1.4 },
];

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const TICK_MS        = 4000;   // one price tick every 4s
const DRIFT          = 0.0008; // slight upward bias per tick
const CALM_VOL       = 0.006;  // marketwide step size when regime = 0
const CHAOS_VOL      = 0.055;  // marketwide step size when regime = 1
const REGIME_PERIOD  = 45;     // ticks per regime segment (~3 min) — calm<->chaotic drift
const SNAPSHOT_EVERY = 20;     // write a Firebase snapshot every N ticks
const CHART_WINDOW   = 160;    // max points kept for the live chart
const PRICE_FLOOR    = 0.01;
const MEAN_REVERT    = 0.012;  // gentle pull back toward base price (keeps stocks alive)

const COMPARE_COLORS = ['#36c9ff','#ff5d8f','#ffd23f','#7be36a','#c79bff','#ff9f43','#5ad1c4','#ff6b6b'];

// ---------------------------------------------------------------------------
// Deterministic PRNG helpers
// ---------------------------------------------------------------------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261 >>> 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rngFor(parts) { return mulberry32(hashStr(parts.join('|'))); }
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Market state
// ---------------------------------------------------------------------------
let SEED = 1;            // global market seed (from Firebase)
let GENESIS = Date.now();// genesis timestamp (from Firebase)
let _configReady = false;

// Clock alignment so every device agrees on tickIndex
let _clockOffset = 0;
function syncedNow() { return Date.now() - _clockOffset; }
function tickIndex() { return Math.floor((syncedNow() - GENESIS) / TICK_MS); }

// regime ∈ [0,1] — smooth deterministic drift between calm (0) and chaotic (1)
function regimeAnchor(seg) { return rngFor([SEED, 'rgm', seg])(); }
function regimeAt(tick) {
  const seg = Math.floor(tick / REGIME_PERIOD);
  const f = (tick % REGIME_PERIOD) / REGIME_PERIOD;
  const a = regimeAnchor(seg), b = regimeAnchor(seg + 1);
  const s = f * f * (3 - 2 * f); // smoothstep
  return a + (b - a) * s;
}

// Marketwide return for a tick (shared by all stocks via their beta)
function marketReturn(tick, regime) {
  const rng = rngFor([SEED, 'mkt', tick]);
  const vol = lerp(CALM_VOL, CHAOS_VOL, regime);
  let r = DRIFT + (rng() * 2 - 1) * vol;
  if (rng() < 0.012 * regime)      r -= (0.05 + rng() * 0.28); // marketwide crash
  else if (rng() < 0.012 * regime) r += (0.04 + rng() * 0.20); // marketwide melt-up
  return r;
}

// Per-stock return for a tick
function stockReturn(stock, tick, regime, mktR) {
  const rng = rngFor([SEED, stock.id, tick]);
  const idioVol = lerp(CALM_VOL, CHAOS_VOL, regime) * stock.vol;
  let r = stock.beta * mktR + (rng() * 2 - 1) * idioVol;
  if (rng() < 0.008 + 0.04 * regime) r += (rng() * 2 - 1) * (0.10 + 0.45 * regime); // idiosyncratic shock
  return r;
}

// ---------------------------------------------------------------------------
// Price computation from a starting snapshot up to a target tick.
// Returns { prices:{id:price}, regime } and appends points to history buffers.
// ---------------------------------------------------------------------------
const history = {};        // id -> [{tick, price}]
let basePrices = {};       // id -> price at startTick (the snapshot)
let startTick = 0;
let lastComputedTick = -1;
let lastRegime = 0;

function seedHistory(snapTick, snapPrices) {
  startTick = snapTick;
  basePrices = {};
  for (const s of STOCKS) basePrices[s.id] = (snapPrices && snapPrices[s.id]) || s.basePrice;
  for (const s of STOCKS) history[s.id] = [{ tick: snapTick, price: basePrices[s.id] }];
  lastComputedTick = snapTick;
}

// Advance the deterministic simulation up to `target`, appending each tick.
function advanceTo(target) {
  if (target <= lastComputedTick) return;
  for (let t = lastComputedTick + 1; t <= target; t++) {
    const regime = regimeAt(t);
    const mktR = marketReturn(t, regime);
    for (const s of STOCKS) {
      const buf = history[s.id];
      const prev = buf[buf.length - 1].price;
      // Mean-reversion toward base price in log space — deterministic (prev is shared).
      const revert = MEAN_REVERT * Math.log(s.basePrice / prev);
      let next = prev * (1 + stockReturn(s, t, regime, mktR) + revert);
      if (!isFinite(next) || next < PRICE_FLOOR) next = PRICE_FLOOR;
      buf.push({ tick: t, price: next });
      if (buf.length > CHART_WINDOW) buf.shift();
    }
    lastRegime = regime;
  }
  lastComputedTick = target;
}

function priceOf(id) {
  const buf = history[id];
  return buf && buf.length ? buf[buf.length - 1].price : (STOCKS.find(s => s.id === id)?.basePrice || 0);
}
// % change across the visible window
function pctChange(id) {
  const buf = history[id];
  if (!buf || buf.length < 2) return 0;
  const a = buf[0].price, b = buf[buf.length - 1].price;
  return a > 0 ? (b - a) / a * 100 : 0;
}
function regimeLabel(r) {
  if (r >= 0.66) return { t: 'CRASHING', c: '#ff5d5d' };
  if (r >= 0.4)  return { t: 'VOLATILE', c: '#ffb43f' };
  return { t: 'CALM', c: '#5ad17a' };
}

// ---------------------------------------------------------------------------
// Firebase: config (write-once), snapshots, clock sync
// ---------------------------------------------------------------------------
async function sampleClock() {
  try {
    const uid = window._myUserId || localStorage.getItem('aq_user_id') || 'anon';
    const r = ref(db, `clockSync/${uid}`);
    await set(r, serverTimestamp());
    const snap = await get(r);
    const serverNow = snap.val();
    if (typeof serverNow === 'number') _clockOffset = Date.now() - serverNow;
  } catch {}
}

async function initConfig() {
  const cRef = ref(db, 'market/config');
  try {
    const res = await runTransaction(cRef, cur => {
      if (cur && cur.seed) return cur; // already initialised
      return { seed: Math.floor(Math.random() * 2147483647) + 1, genesisMs: Date.now(), tickMs: TICK_MS };
    });
    const cfg = res.snapshot.val();
    SEED = cfg.seed; GENESIS = cfg.genesisMs;
  } catch {
    // offline fallback: deterministic-but-local market
    const snap = await get(cRef).catch(() => null);
    const cfg = snap && snap.exists() ? snap.val() : null;
    if (cfg) { SEED = cfg.seed; GENESIS = cfg.genesisMs; }
  }
  _configReady = true;
}

async function loadSnapshotAndSeed() {
  let snapTick = tickIndex();
  let snapPrices = null;
  try {
    const snap = await get(ref(db, 'market/snapshot'));
    if (snap.exists()) {
      const v = snap.val();
      if (typeof v.tick === 'number' && v.tick <= tickIndex()) { snapTick = v.tick; snapPrices = v.prices; }
    }
  } catch {}
  // Bound the catch-up loop: never iterate more than a few windows of history.
  const now = tickIndex();
  if (now - snapTick > CHART_WINDOW) snapTick = now - CHART_WINDOW;
  seedHistory(snapTick, snapPrices);
  advanceTo(now);
}

function maybeWriteSnapshot(tick) {
  if (tick % SNAPSHOT_EVERY !== 0) return;
  const prices = {};
  for (const s of STOCKS) prices[s.id] = priceOf(s.id);
  // Deterministic value ⇒ last-writer-wins is safe.
  set(ref(db, 'market/snapshot'), { tick, prices, regime: lastRegime, at: serverTimestamp() }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Portfolio + credits (Firebase per account, localStorage as fast cache)
// ---------------------------------------------------------------------------
function userId() { return window._myUserId || localStorage.getItem('aq_user_id') || 'anon'; }
let holdings = {};        // id -> { shares, avgCost }
let _creditSyncTimer = null;

function portfolioRef() { return ref(db, `portfolios/${userId()}`); }

async function loadPortfolio() {
  try {
    const snap = await get(portfolioRef());
    if (snap.exists()) {
      const v = snap.val();
      holdings = v.holdings || {};
      // Adopt remote credits if they are newer than our last local sync.
      const localAt = parseInt(localStorage.getItem('aq_credits_synced_at') || '0', 10);
      if (typeof v.credits === 'number' && (v.updatedAt || 0) >= localAt) {
        if (typeof window.aqSetCredits === 'function') window.aqSetCredits(v.credits);
      }
    }
  } catch {}
}

function savePortfolio() {
  const credits = typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 0;
  const at = Date.now();
  localStorage.setItem('aq_credits_synced_at', String(at));
  set(portfolioRef(), { holdings, credits, updatedAt: at }).catch(() => {});
}

// Mirror every credit change (from any game) up to Firebase, debounced.
function hookCreditSync() {
  if (typeof window.aqSetCredits !== 'function' || window._aqCreditsHooked) return;
  window._aqCreditsHooked = true;
  const orig = window.aqSetCredits;
  window.aqSetCredits = function (n) {
    orig(n);
    clearTimeout(_creditSyncTimer);
    _creditSyncTimer = setTimeout(savePortfolio, 800);
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
let _selected = STOCKS[0].id;
let _compareMode = false;
let _compareSet = new Set([STOCKS[0].id, STOCKS[1].id, STOCKS[2].id]);
let _tickTimer = null;
let _rafId = null;
let _built = false;
let _open = false;

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
const fmt = n => n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(2) : n.toFixed(3);

function buildUI() {
  const area = document.getElementById('stocks-area');
  if (!area) return;
  area.innerHTML = `
    <div id="stk-root">
      <div id="stk-left">
        <div id="stk-regime"></div>
        <div id="stk-list"></div>
      </div>
      <div id="stk-main">
        <div id="stk-chart-head">
          <div id="stk-chart-title"></div>
          <button id="stk-compare-btn" class="stk-btn">Compare</button>
        </div>
        <canvas id="stk-chart"></canvas>
        <div id="stk-compare-legend"></div>
        <div id="stk-trade"></div>
      </div>
    </div>
    <div id="stk-portfolio"></div>`;
  document.getElementById('stk-compare-btn').onclick = () => { _compareMode = !_compareMode; renderAll(); };
  _built = true;
}

function renderList() {
  const list = document.getElementById('stk-list');
  if (!list) return;
  list.innerHTML = '';
  for (const s of STOCKS) {
    const pct = pctChange(s.id);
    const up = pct >= 0;
    const row = el('div', 'stk-row' + (s.id === _selected ? ' sel' : ''));
    const inCompare = _compareMode && _compareSet.has(s.id);
    row.innerHTML = `
      <span class="stk-tk">${s.ticker}</span>
      <span class="stk-px">${fmt(priceOf(s.id))}</span>
      <span class="stk-ch" style="color:${up ? '#5ad17a' : '#ff5d5d'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%</span>`;
    if (inCompare) row.style.outline = '1px solid #36c9ff';
    row.onclick = () => {
      if (_compareMode) { _compareSet.has(s.id) ? _compareSet.delete(s.id) : _compareSet.add(s.id); }
      else { _selected = s.id; }
      renderAll();
    };
    list.appendChild(row);
  }
}

function renderRegime() {
  const box = document.getElementById('stk-regime');
  if (!box) return;
  const r = regimeLabel(lastRegime);
  box.innerHTML = `<span class="stk-rg-dot" style="background:${r.c}"></span>MARKET: <b style="color:${r.c}">${r.t}</b>`;
}

function renderChartHead() {
  const title = document.getElementById('stk-chart-title');
  const legend = document.getElementById('stk-compare-legend');
  const btn = document.getElementById('stk-compare-btn');
  if (btn) btn.classList.toggle('on', _compareMode);
  if (_compareMode) {
    if (title) title.textContent = 'Compare (normalized %)';
    if (legend) {
      legend.innerHTML = '';
      [...STOCKS].filter(s => _compareSet.has(s.id)).forEach((s, i) => {
        const c = COMPARE_COLORS[i % COMPARE_COLORS.length];
        const tag = el('span', 'stk-leg');
        tag.innerHTML = `<i style="background:${c}"></i>${s.ticker} ${pctChange(s.id).toFixed(1)}%`;
        legend.appendChild(tag);
      });
    }
  } else {
    const s = STOCKS.find(x => x.id === _selected);
    const pct = pctChange(_selected);
    if (title) title.innerHTML = `<b>${s.ticker}</b> ${s.name} &nbsp; <span style="color:${pct >= 0 ? '#5ad17a' : '#ff5d5d'}">${fmt(priceOf(_selected))} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
    if (legend) legend.innerHTML = '';
  }
}

function drawChart() {
  const cv = document.getElementById('stk-chart');
  if (!cv || !_open) return;
  const wrap = cv.parentElement;
  const W = cv.width = wrap.clientWidth || 480;
  const H = cv.height = 240;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(8,16,28,0.6)';
  ctx.fillRect(0, 0, W, H);
  // grid
  ctx.strokeStyle = 'rgba(120,160,200,0.12)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const y = H * i / 5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const series = _compareMode
    ? STOCKS.filter(s => _compareSet.has(s.id)).map(s => ({ s, buf: history[s.id] }))
    : [{ s: STOCKS.find(x => x.id === _selected), buf: history[_selected] }];

  if (_compareMode) {
    // normalized to % change from window start
    let lo = Infinity, hi = -Infinity;
    const norm = series.map(({ buf }) => buf.map(p => (p.price / buf[0].price - 1) * 100));
    norm.forEach(arr => arr.forEach(v => { lo = Math.min(lo, v); hi = Math.max(hi, v); }));
    if (!isFinite(lo)) { lo = -1; hi = 1; }
    const pad = (hi - lo) * 0.1 || 1; lo -= pad; hi += pad;
    const yOf = v => H - (v - lo) / (hi - lo) * H;
    // zero line
    ctx.strokeStyle = 'rgba(200,210,230,0.25)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(0, yOf(0)); ctx.lineTo(W, yOf(0)); ctx.stroke(); ctx.setLineDash([]);
    series.forEach(({ buf }, i) => {
      const arr = norm[i], c = COMPARE_COLORS[i % COMPARE_COLORS.length];
      ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.beginPath();
      arr.forEach((v, k) => { const x = k / (arr.length - 1 || 1) * W; k ? ctx.lineTo(x, yOf(v)) : ctx.moveTo(x, yOf(v)); });
      ctx.stroke();
    });
  } else {
    const buf = series[0].buf || [];
    if (buf.length < 2) return;
    let lo = Infinity, hi = -Infinity;
    buf.forEach(p => { lo = Math.min(lo, p.price); hi = Math.max(hi, p.price); });
    const pad = (hi - lo) * 0.1 || hi * 0.05 || 1; lo -= pad; hi += pad;
    const yOf = v => H - (v - lo) / (hi - lo) * H;
    const up = buf[buf.length - 1].price >= buf[0].price;
    const col = up ? '#5ad17a' : '#ff5d5d';
    // fill
    ctx.beginPath();
    buf.forEach((p, k) => { const x = k / (buf.length - 1) * W; k ? ctx.lineTo(x, yOf(p.price)) : ctx.moveTo(x, yOf(p.price)); });
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, up ? 'rgba(90,209,122,0.30)' : 'rgba(255,93,93,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fill();
    // line
    ctx.beginPath();
    buf.forEach((p, k) => { const x = k / (buf.length - 1) * W; k ? ctx.lineTo(x, yOf(p.price)) : ctx.moveTo(x, yOf(p.price)); });
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
    // last marker + labels
    const lx = W, ly = yOf(buf[buf.length - 1].price);
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(lx - 2, ly, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(200,215,235,0.7)'; ctx.font = '10px monospace';
    ctx.fillText(fmt(hi), 4, 12); ctx.fillText(fmt(lo), 4, H - 4);
  }
}

function renderTrade() {
  const box = document.getElementById('stk-trade');
  if (!box || _compareMode) { if (box) box.innerHTML = _compareMode ? '<div class="stk-hint">Tap stocks on the left to add/remove from the comparison.</div>' : ''; return; }
  const s = STOCKS.find(x => x.id === _selected);
  const px = priceOf(s.id);
  const h = holdings[s.id] || { shares: 0, avgCost: 0 };
  const credits = typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 0;
  const posVal = h.shares * px;
  const posPL = h.shares ? (px - h.avgCost) * h.shares : 0;
  box.innerHTML = `
    <div class="stk-trade-row">
      <input id="stk-qty" type="number" min="1" value="1" />
      <button class="stk-btn buy" id="stk-buy">Buy</button>
      <button class="stk-btn sell" id="stk-sell">Sell</button>
      <button class="stk-btn" id="stk-max">Max</button>
    </div>
    <div class="stk-pos">
      Holding: <b>${h.shares}</b> @ ${fmt(h.avgCost)} &nbsp;·&nbsp; Value: <b>${Math.round(posVal)}</b> 🪙
      &nbsp;·&nbsp; P/L: <b style="color:${posPL >= 0 ? '#5ad17a' : '#ff5d5d'}">${posPL >= 0 ? '+' : ''}${Math.round(posPL)}</b>
    </div>
    <div id="stk-trade-msg" class="stk-hint"></div>`;
  const qty = () => Math.max(1, Math.floor(+document.getElementById('stk-qty').value || 1));
  document.getElementById('stk-buy').onclick = () => doBuy(s.id, qty());
  document.getElementById('stk-sell').onclick = () => doSell(s.id, qty());
  document.getElementById('stk-max').onclick = () => { document.getElementById('stk-qty').value = Math.max(1, Math.floor(credits / px)); };
}

function renderPortfolio() {
  const box = document.getElementById('stk-portfolio');
  if (!box) return;
  const credits = typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 0;
  let total = 0, basis = 0, rows = '';
  for (const s of STOCKS) {
    const h = holdings[s.id];
    if (!h || h.shares <= 0) continue;
    const px = priceOf(s.id), val = h.shares * px, pl = (px - h.avgCost) * h.shares;
    total += val; basis += h.avgCost * h.shares;
    rows += `<tr><td>${s.ticker}</td><td>${h.shares}</td><td>${fmt(px)}</td><td>${Math.round(val)}</td>
      <td style="color:${pl >= 0 ? '#5ad17a' : '#ff5d5d'}">${pl >= 0 ? '+' : ''}${Math.round(pl)}</td></tr>`;
  }
  const totalPL = total - basis;
  box.innerHTML = `
    <div class="stk-pf-head">
      <span>💰 Credits: <b>${credits}</b></span>
      <span>Portfolio: <b>${Math.round(total)}</b> 🪙</span>
      <span>Net worth: <b>${Math.round(credits + total)}</b></span>
      <span>Open P/L: <b style="color:${totalPL >= 0 ? '#5ad17a' : '#ff5d5d'}">${totalPL >= 0 ? '+' : ''}${Math.round(totalPL)}</b></span>
    </div>
    ${rows ? `<table class="stk-pf-tbl"><thead><tr><th>Stock</th><th>Shares</th><th>Price</th><th>Value</th><th>P/L</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="stk-hint">No positions yet — buy something risky.</div>'}`;
}

function tradeMsg(t, ok) {
  const m = document.getElementById('stk-trade-msg');
  if (m) { m.textContent = t; m.style.color = ok ? '#5ad17a' : '#ff8f8f'; }
}

function doBuy(id, qty) {
  const px = priceOf(id);
  const cost = Math.round(px * qty);
  const credits = window.aqGetCredits();
  if (cost > credits) { tradeMsg(`Not enough credits (need ${cost}).`, false); return; }
  window.aqSetCredits(credits - cost);
  const h = holdings[id] || { shares: 0, avgCost: 0 };
  const newShares = h.shares + qty;
  h.avgCost = (h.avgCost * h.shares + px * qty) / newShares;
  h.shares = newShares;
  holdings[id] = h;
  savePortfolio();
  tradeMsg(`Bought ${qty} @ ${fmt(px)} (−${cost} 🪙).`, true);
  renderAll();
}

function doSell(id, qty) {
  const h = holdings[id];
  if (!h || h.shares <= 0) { tradeMsg('You hold none of this.', false); return; }
  qty = Math.min(qty, h.shares);
  const px = priceOf(id);
  const proceeds = Math.round(px * qty);
  window.aqSetCredits(window.aqGetCredits() + proceeds);
  h.shares -= qty;
  if (h.shares <= 0) delete holdings[id];
  savePortfolio();
  tradeMsg(`Sold ${qty} @ ${fmt(px)} (+${proceeds} 🪙).`, true);
  renderAll();
}

function renderAll() {
  if (!_built) return;
  renderRegime();
  renderList();
  renderChartHead();
  renderTrade();
  renderPortfolio();
  drawChart();
}

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------
function onTick() {
  const now = tickIndex();
  if (now > lastComputedTick) {
    advanceTo(now);
    maybeWriteSnapshot(now);
    renderAll();
  }
}
function rafLoop() {
  if (!_open) { _rafId = null; return; }
  _rafId = requestAnimationFrame(rafLoop);
  drawChart();
}

let _initStarted = false;
async function ensureInit() {
  if (_initStarted) return;
  _initStarted = true;
  await sampleClock();
  await initConfig();
  await loadSnapshotAndSeed();
  hookCreditSync();
  await loadPortfolio();
}

// ---------------------------------------------------------------------------
// Public entry — wired into the APPS registry in index.html
// ---------------------------------------------------------------------------
async function openStocks(show = true) {
  const w = document.getElementById('stocks-wrap');
  if (!w) return;
  const opening = show && !w.classList.contains('open');
  w.classList.toggle('open', !!show);
  w.style.display = show ? 'flex' : 'none';
  if (!show) {
    _open = false;
    clearInterval(_tickTimer); _tickTimer = null;
    if (_rafId) cancelAnimationFrame(_rafId), _rafId = null;
    return;
  }
  _open = true;
  if (typeof window.aqRefreshCreditDisplays === 'function') window.aqRefreshCreditDisplays();
  if (!_built) buildUI();
  if (opening || !_initStarted) {
    renderAll();
    await ensureInit();
    advanceTo(tickIndex());
    renderAll();
  }
  if (!_tickTimer) _tickTimer = setInterval(onTick, 1000);
  if (!_rafId) rafLoop();
}

window.openStocks = openStocks;
