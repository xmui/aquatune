// Aquatune Exchange — a satirical stock market of brand/meme tickers.
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
// Parody/brand "stocks". Edit freely: { id, ticker, name, basePrice, beta, vol }.
// beta = sensitivity to the marketwide move; vol = idiosyncratic jitter multiplier.
// Keep ids stable so existing holdings carry over across list changes.
// ---------------------------------------------------------------------------
// `profile` drives each ticker's personality (see PROFILES below): flat names
// hug their base price; meme names take huge slow multi-day swings. `beta` =
// sensitivity to the marketwide (economy) move; `vol` = idiosyncratic jitter.
const STOCKS = [
  // survivors keep their id so existing holdings carry over (blz is now WEED)
  { id:'blz',     ticker:'WEED',  name:'Weed Inc.',          basePrice:42,  beta:1.2, vol:1.6, profile:'steady' },
  { id:'snow',    ticker:'SNOW',  name:'Snow',               basePrice:88,  beta:1.6, vol:2.2, profile:'swingy' },
  { id:'gun',     ticker:'GUNZ',  name:'Gunz',               basePrice:64,  beta:1.1, vol:1.4, profile:'steady' },
  { id:'cult',    ticker:'CULT',  name:'Cult',               basePrice:9,   beta:1.5, vol:2.4, profile:'meme' },
  { id:'fame',    ticker:'FAME',  name:'Fame',               basePrice:200, beta:2.0, vol:2.8, profile:'swingy' },
  { id:'goop',    ticker:'GOOP',  name:'Goop',               basePrice:6.5, beta:0.9, vol:1.3, profile:'meme' },
  // new tickers
  { id:'geek',    ticker:'GEEK',  name:'Geekbar',            basePrice:18,  beta:1.3, vol:1.7, profile:'swingy' },
  { id:'valve',   ticker:'VALVE', name:'Valve Software',     basePrice:330, beta:0.8, vol:1.1, profile:'flat' },
  { id:'dc',      ticker:'DC',    name:'DC Shoes',           basePrice:54,  beta:1.0, vol:1.3, profile:'steady' },
  { id:'osiris',  ticker:'OSIR',  name:'Osiris Shoes',       basePrice:37,  beta:1.1, vol:1.5, profile:'steady' },
  { id:'monster', ticker:'MNST',  name:'Monster Energy',     basePrice:96,  beta:1.2, vol:1.4, profile:'steady' },
  { id:'gfuel',   ticker:'GFUEL', name:'G Fuel',             basePrice:29,  beta:1.3, vol:1.8, profile:'swingy' },
  { id:'marlboro',ticker:'MARL',  name:'Marlboro',           basePrice:140, beta:0.7, vol:1.0, profile:'flat' },
  { id:'camel',   ticker:'CAML',  name:'Camel',              basePrice:72,  beta:0.8, vol:1.1, profile:'flat' },
  { id:'lucky',   ticker:'LUCK',  name:'Lucky Strike',       basePrice:58,  beta:0.9, vol:1.2, profile:'flat' },
  { id:'miku',    ticker:'MIKU',  name:'Hatsune Miku',       basePrice:160, beta:1.7, vol:2.3, profile:'swingy' },
  { id:'hottopic',ticker:'HOT',   name:'Hot Topic',          basePrice:25,  beta:1.2, vol:1.6, profile:'swingy' },
  { id:'swag',    ticker:'SWAG',  name:'Swag',               basePrice:4.2, beta:1.8, vol:2.6, profile:'meme' },
  { id:'michael', ticker:'MIKE',  name:'Michael Camera',     basePrice:80,  beta:1.0, vol:1.4, profile:'steady' },
  { id:'slop',    ticker:'SLOP',  name:'AI Slop',            basePrice:11,  beta:1.9, vol:2.7, profile:'meme' },
  { id:'buddy',   ticker:'BUDDY', name:'AquaBuddy',          basePrice:50,  beta:1.0, vol:1.5, profile:'steady' },
];
// Per-stock personality. The main variance is the slow fair-value swing
// (trendAmp, in log space: ~e^±amp around base over its multi-day cycle).
// meanRevert is how tightly price tracks that fair value; `noise` is the
// per-tick jitter std (kept small enough that reversion contains it so the
// trend stays visible and prices never explode); spike scales rare big shocks.
const PROFILES = {
  flat:   { meanRevert: 0.060, trendAmp: 0.10, noise: 0.015, spike: 0.2 },
  steady: { meanRevert: 0.035, trendAmp: 0.32, noise: 0.035, spike: 0.5 },
  swingy: { meanRevert: 0.020, trendAmp: 0.65, noise: 0.070, spike: 1.0 },
  meme:   { meanRevert: 0.013, trendAmp: 1.05, noise: 0.110, spike: 1.5 },
};
const STOCK_BY_ID = Object.fromEntries(STOCKS.map(s => [s.id, s]));
const STOCK_IDX = Object.fromEntries(STOCKS.map((s, i) => [s.id, i])); // stable per-stock discriminator

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const TICK_MS        = 4000;   // one price tick every 4s
const DRIFT          = 0.0008; // slight upward bias per tick
const CALM_VOL       = 0.006;  // marketwide step size when regime = 0
const CHAOS_VOL      = 0.040;  // marketwide step size when regime = 1
const REGIME_PERIOD  = 600;    // ticks per regime segment (~40 min) — slow calm<->chaotic macro drift
const SNAPSHOT_EVERY = 20;     // write a Firebase snapshot every N ticks
const CHART_WINDOW   = 160;    // max points kept for the live chart
const PRICE_FLOOR    = 0.01;
const MEAN_REVERT    = 0.012;  // gentle pull back toward base price (keeps stocks alive)

const COMPARE_COLORS = ['#36c9ff','#ff5d8f','#ffd23f','#7be36a','#c79bff','#ff9f43','#5ad1c4','#ff6b6b'];

// Chart timeframes → how many ticks of history the chart spans (TICK_MS=4s).
const TIMEFRAMES = { '1h': 900, '1d': 21600, '1w': 151200 };
const SERIES_POINTS = 160; // downsampled points drawn per series

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

// Marketwide return for a tick (the "economy" — shared by all stocks via beta).
// Big market-wide crashes/melt-ups are deliberately RARE.
function marketReturn(tick, regime) {
  const rng = rngFor([SEED, 'mkt', tick]);
  const vol = lerp(CALM_VOL, CHAOS_VOL, regime);
  let r = DRIFT + (rng() * 2 - 1) * vol;
  if (rng() < 0.004 * regime)      r -= (0.05 + rng() * 0.28); // rare marketwide crash
  else if (rng() < 0.004 * regime) r += (0.04 + rng() * 0.20); // rare marketwide melt-up
  return r;
}

// ── Per-stock personality: a slowly-moving "fair value" each stock reverts to.
// Built from a couple of sine waves whose periods are randomized in [1 hour,
// 2 weeks] (deterministic per seed+id) so every ticker has its own long bull/
// bear cycles — some wild, some flat — independent of the others.
const MINT = 900;        // 1 hour in ticks (TICK_MS = 4s)
const MAXT = 302400;     // 2 weeks in ticks
let _persCache = {}, _persSeed = null;
function persFor(s) {
  if (_persSeed !== SEED) { _persCache = {}; _persSeed = SEED; }
  if (_persCache[s.id]) return _persCache[s.id];
  const r = rngFor([SEED, s.id, 'pers']);
  const prof = PROFILES[s.profile] || PROFILES.steady;
  const pers = {
    ...prof,
    waves: [
      { period: Math.round(lerp(MAXT * 0.3, MAXT, r())),         phase: r() * 6.2832, w: 0.5 },   // medium: ~4 days–2 weeks
      { period: Math.round(lerp(MAXT * 0.04, MAXT * 0.18, r())), phase: r() * 6.2832, w: 0.32 },  // daily: ~13h–2.5 days
      { period: Math.round(lerp(MINT, MAXT * 0.03, r())),        phase: r() * 6.2832, w: 0.26 },  // short: 1h–~10h
    ],
    // A SECULAR trend (multi-week bull/bear cycle) with its OWN amplitude so the fair
    // value actually drifts up or down over days/weeks instead of oscillating around
    // basePrice — that's what lets a stock "stay" trending. Deterministic per seed+id, so
    // every ticker trends independently (some winners, some losers) and reverses only over
    // weeks. Amplitude scales with the stock's personality; bounded by exp(sine).
    secular: { period: Math.round(lerp(MAXT * 1.5, MAXT * 4, r())), phase: r() * 6.2832, amp: lerp(0.30, 0.85, r()) * (0.5 + prof.trendAmp) },
  };
  return (_persCache[s.id] = pers);
}
function trendLog(s, tick) {
  const p = persFor(s); let v = 0;
  for (const w of p.waves) v += w.w * Math.sin((tick / w.period) * 6.2832 + w.phase);
  const sec = p.secular;
  return p.trendAmp * v + sec.amp * Math.sin((tick / sec.period) * 6.2832 + sec.phase);
}
function fairValue(s, tick) { return s.basePrice * Math.exp(trendLog(s, tick)); }

// Per-stock return for a tick: economy (beta·market) + personality jitter + a
// rare idiosyncratic spike/crash (rarer for calm profiles).
function stockReturn(stock, tick, regime, mktR) {
  const p = persFor(stock);
  const rng = rngFor([SEED, stock.id, tick]);
  // small per-tick jitter (quieter in calm regimes), nudged by the ticker's vol
  const idioVol = lerp(p.noise * 0.3, p.noise, regime) * (0.7 + 0.3 * stock.vol);
  let r = stock.beta * mktR + (rng() * 2 - 1) * idioVol;
  // rare idiosyncratic shock — rarer AND smaller for calm profiles
  if (rng() < (0.0010 + 0.008 * regime) * p.spike) r += (rng() * 2 - 1) * (0.15 + 0.45 * regime) * Math.min(1, p.spike);
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
      // Revert toward the stock's slowly-moving fair value (its personality
      // cycle) rather than a fixed base — this is what breaks the equilibrium.
      const revert = persFor(s).meanRevert * Math.log(fairValue(s, t) / prev);
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
// % change across the selected timeframe
function pctChange(id) {
  const buf = seriesOf(id);
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
// Timeframe series — deterministic price history spanning 1h / 1d / 1w.
// We walk the same deterministic engine forward from a basePrice anchor at
// (now - frameTicks), downsample to ~SERIES_POINTS, then rescale so the last
// point equals the live current price (priceOf). This gives instant, shared
// history for any timeframe without keeping huge buffers; mean-reversion makes
// the early values converge so the anchor choice doesn't matter.
// ---------------------------------------------------------------------------
let _timeframe = '1h';
const _series = {}; // id -> [{tick, price}] for the current timeframe

// Fast numeric PRNG used only for the timeframe series. It needn't match the
// live engine (the series is rescaled to end at the live price), so we avoid
// the string/closure allocations of rngFor — a 1w span over all stocks would
// otherwise take ~1.3s. Deterministic from SEED + STOCK_IDX ⇒ shared by all clients.
function _u(k) { k |= 0; k = Math.imul(k ^ (k >>> 16), 0x7feb352d); k = Math.imul(k ^ (k >>> 15), 0x846ca68b); return ((k ^ (k >>> 16)) >>> 0) / 4294967296; }
function _mix(a, b) { return (Math.imul((a ^ 0x9E3779B1) | 0, 0x85EBCA77) ^ ((b + 0x165667B1) | 0)) | 0; }
function _seriesRegime(seg) { return _u(_mix(SEED ^ 0x5151, seg)); }
function _regimeFast(t) {
  const seg = Math.floor(t / REGIME_PERIOD), f = (t % REGIME_PERIOD) / REGIME_PERIOD;
  const a = _seriesRegime(seg), b = _seriesRegime(seg + 1), s = f * f * (3 - 2 * f);
  return a + (b - a) * s;
}

function rebuildSeries(ids) {
  const now = lastComputedTick;
  if (now < 1) { for (const id of ids) _series[id] = (history[id] || []).slice(); return; }
  const frameTicks = TIMEFRAMES[_timeframe] || 900;
  const start = Math.max(0, now - frameTicks);
  const span = now - start;
  const step = Math.max(1, Math.floor(span / SERIES_POINTS));
  const price = {}, pts = {};
  for (const id of ids) { const s = STOCK_BY_ID[id]; price[id] = s ? s.basePrice : 1; pts[id] = [{ tick: start, price: price[id] }]; }
  for (let t = start + 1; t <= now; t++) {
    const regime = _regimeFast(t);
    const vol = lerp(CALM_VOL, CHAOS_VOL, regime);
    const mk = _mix(SEED, t);
    let mktR = DRIFT + (_u(mk) * 2 - 1) * vol;
    if (_u(mk ^ 1) < 0.012 * regime) mktR -= (0.05 + _u(mk ^ 2) * 0.28);
    else if (_u(mk ^ 3) < 0.012 * regime) mktR += (0.04 + _u(mk ^ 4) * 0.20);
    const sample = ((t - start) % step === 0) || (t === now);
    for (const id of ids) {
      const s = STOCK_BY_ID[id]; let p = price[id];
      const sk = _mix(mk, STOCK_IDX[id] + 1);
      let r = s.beta * mktR + (_u(sk) * 2 - 1) * (vol * s.vol);
      if (_u(sk ^ 1) < 0.008 + 0.04 * regime) r += (_u(sk ^ 2) * 2 - 1) * (0.10 + 0.45 * regime);
      const revert = MEAN_REVERT * Math.log(fairValue(s, t) / p);   // revert toward the drifting anchor
      p = p * (1 + r + revert);
      if (!isFinite(p) || p < PRICE_FLOOR) p = PRICE_FLOOR;
      price[id] = p;
      if (sample) pts[id].push({ tick: t, price: p });
    }
  }
  for (const id of ids) {
    const arr = pts[id], live = priceOf(id), endP = arr[arr.length - 1].price;
    if (endP > 0 && live > 0 && isFinite(live)) { const k = live / endP; for (const pt of arr) pt.price *= k; }
    _series[id] = arr;
  }
}
function rebuildAllSeries() { rebuildSeries(STOCKS.map(s => s.id)); }
function visibleIds() { return _compareMode ? [..._compareSet] : [_selected]; }
function seriesOf(id) { return _series[id] && _series[id].length ? _series[id] : (history[id] || []); }

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
function userId() { return (typeof window.effectiveUserId === 'function' && window.effectiveUserId()) || window._myUserId || localStorage.getItem('aq_user_id') || 'anon'; }
let holdings = {};        // id -> { shares, avgCost }
let _creditSyncTimer = null;
// Guard against clobbering the cloud portfolio before we've loaded it. A credit
// change (e.g. the live cross-device watcher firing during load) would otherwise
// schedule a savePortfolio that writes the still-empty `holdings` over the real
// ones — silently wiping a user's stocks. Saves are no-ops until load completes.
let _portfolioLoaded = false;

function portfolioRef() { return ref(db, `portfolios/${userId()}`); }

async function loadPortfolio() {
  try {
    const snap = await get(portfolioRef());
    if (snap.exists()) {
      const v = snap.val();
      holdings = v.holdings || {};
      // Credits source of truth: for logged-in users the ACCOUNT owns credits
      // (accounts/<id>/credits, synced live by accounts.js). Only adopt the
      // portfolio's credits for anonymous users — otherwise a stale portfolios
      // node (e.g. after an admin credit change, which only writes the account)
      // could overwrite the real balance and "eat" money.
      const loggedIn = !!window._aqAccountId;
      if (!loggedIn) {
        const localAt = parseInt(localStorage.getItem('aq_credits_synced_at') || '0', 10);
        if (typeof v.credits === 'number' && (v.updatedAt || 0) >= localAt) {
          if (typeof window.aqSetCredits === 'function') window.aqSetCredits(v.credits);
        }
      }
      // Liquidate holdings of stocks that no longer exist (e.g. the old list)
      // back to credits at their cost basis, so credits aren't stranded. Done
      // after adopting remote credits so the refund isn't overwritten.
      let refund = 0, changed = false;
      for (const id of Object.keys(holdings)) {
        if (!STOCK_BY_ID[id]) {
          const h = holdings[id];
          if (h && h.shares > 0) refund += Math.round((h.avgCost || 0) * h.shares);
          delete holdings[id]; changed = true;
        }
      }
      if (refund > 0 && typeof window.aqAddCredits === 'function') window.aqAddCredits(refund);
      _portfolioLoaded = true;   // mark loaded BEFORE the refund-save so it isn't dropped
      if (changed) savePortfolio();
    }
    _portfolioLoaded = true;     // a successful read (even an empty/new portfolio) — safe to save now
  } catch {}                     // network error: stay un-loaded so we never overwrite holdings with {}
}

function savePortfolio() {
  if (!_portfolioLoaded) return;   // never write holdings before we've loaded them (anti-wipe)
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
let _qty = 1, _tradeBuiltFor = null;   // chosen trade quantity persists across price-tick re-renders
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
          <div class="stk-head-ctrls">
            <span id="stk-tf"></span>
            <button id="stk-compare-btn" class="stk-btn">Compare</button>
          </div>
        </div>
        <canvas id="stk-chart"></canvas>
        <div id="stk-compare-legend"></div>
        <div id="stk-trade"></div>
      </div>
    </div>
    <div id="stk-portfolio"></div>`;
  document.getElementById('stk-compare-btn').onclick = () => { _compareMode = !_compareMode; rebuildSeries(visibleIds()); renderAll(); };
  const tf = document.getElementById('stk-tf');
  Object.keys(TIMEFRAMES).forEach(k => {
    const b = el('button', 'stk-btn stk-tf-btn' + (k === _timeframe ? ' on' : ''), k.toUpperCase());
    b.onclick = () => { _timeframe = k; rebuildAllSeries(); renderAll(); };
    tf.appendChild(b);
  });
  _built = true;
}

function syncTfButtons() {
  const tf = document.getElementById('stk-tf'); if (!tf) return;
  [...tf.children].forEach(b => b.classList.toggle('on', b.textContent.toLowerCase() === _timeframe));
}

function renderList() {
  const list = document.getElementById('stk-list');
  if (!list) return;
  list.innerHTML = '';
  for (const s of STOCKS) {
    const pct = pctChange(s.id);
    const up = pct >= 0;
    const h = holdings[s.id];
    const held = !!(h && h.shares > 0);
    const row = el('div', 'stk-row' + (s.id === _selected ? ' sel' : '') + (held ? ' held' : ''));
    const inCompare = _compareMode && _compareSet.has(s.id);
    row.innerHTML = `
      <span class="stk-tk">${s.ticker}${held ? ` <span class="stk-hold-dot" title="You hold ${h.shares} share${h.shares === 1 ? '' : 's'}">●</span>` : ''}</span>
      <span class="stk-px">${fmt(priceOf(s.id))}</span>
      <span class="stk-ch" style="color:${up ? '#5ad17a' : '#ff5d5d'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%</span>`;
    if (inCompare) row.style.outline = '1px solid #36c9ff';
    row.onclick = () => {
      if (_compareMode) { _compareSet.has(s.id) ? _compareSet.delete(s.id) : _compareSet.add(s.id); }
      else { _selected = s.id; }
      rebuildSeries(visibleIds());
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
  const H = cv.height = Math.max(160, Math.round(cv.clientHeight) || 240);
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(8,16,28,0.6)';
  ctx.fillRect(0, 0, W, H);
  // grid
  ctx.strokeStyle = 'rgba(120,160,200,0.12)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const y = H * i / 5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const series = _compareMode
    ? STOCKS.filter(s => _compareSet.has(s.id)).map(s => ({ s, buf: seriesOf(s.id) }))
    : [{ s: STOCKS.find(x => x.id === _selected), buf: seriesOf(_selected) }];

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
  if (!box || _compareMode) { if (box) box.innerHTML = _compareMode ? '<div class="stk-hint">Tap stocks on the left to add/remove from the comparison.</div>' : ''; _tradeBuiltFor = null; return; }
  const s = STOCKS.find(x => x.id === _selected);
  const px = priceOf(s.id);
  const h = holdings[s.id] || { shares: 0, avgCost: 0 };
  const credits = typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 0;
  // Build the controls only when the SELECTED STOCK changes — never on a price tick —
  // so the qty input (and its focus) survives the ~4s re-renders. Switching stocks
  // resets the quantity to 1.
  if (_tradeBuiltFor !== s.id) {
    _qty = 1;
    box.innerHTML = `
      <div class="stk-trade-row">
        <input id="stk-qty" type="number" min="1" value="1" />
        <button class="stk-btn buy" id="stk-buy">Buy</button>
        <button class="stk-btn sell" id="stk-sell">Sell</button>
        <button class="stk-btn" id="stk-max">Max</button>
      </div>
      <div class="stk-pos" id="stk-pos"></div>
      <div id="stk-trade-msg" class="stk-hint"></div>`;
    const qtyEl = document.getElementById('stk-qty');
    qtyEl.value = _qty;
    qtyEl.oninput = () => { _qty = Math.max(1, Math.floor(+qtyEl.value || 1)); };
    document.getElementById('stk-buy').onclick = () => doBuy(s.id, _qty);
    document.getElementById('stk-sell').onclick = () => doSell(s.id, _qty);
    document.getElementById('stk-max').onclick = () => { _qty = Math.max(1, Math.floor((typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 0) / priceOf(s.id))); const q = document.getElementById('stk-qty'); if (q) q.value = _qty; };
    _tradeBuiltFor = s.id;
  }
  // Refresh only the dynamic numbers each call (price tick) — leave the input alone.
  const posVal = h.shares * px, posPL = h.shares ? (px - h.avgCost) * h.shares : 0;
  const pos = document.getElementById('stk-pos');
  if (pos) pos.innerHTML = `Holding: <b>${h.shares}</b> @ ${fmt(h.avgCost)} &nbsp;·&nbsp; Value: <b>${Math.round(posVal)}</b> 🪙 &nbsp;·&nbsp; P/L: <b style="color:${posPL >= 0 ? '#5ad17a' : '#ff5d5d'}">${posPL >= 0 ? '+' : ''}${Math.round(posPL)}</b>`;
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
  // No XP for buying — finance XP comes only from realized profit on a sell, so
  // spamming buy↔sell round-trips (no net gain) can't farm it.
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
  const profit = Math.round((px - (h.avgCost || px)) * qty);
  if (h.shares <= 0) delete holdings[id];
  savePortfolio();
  // Finance XP is granted ONLY on realized profit, scaled by how much you made (and
  // capped). A flat or losing sell — including a same-price buy→sell round-trip —
  // grants nothing, so XP can't be farmed without genuinely trading at a gain.
  if (profit > 0 && typeof window.aqGameXp === 'function') {
    window.aqGameXp('finance', { played: false, won: true, mult: Math.min(6, profit / 800) });
  }
  tradeMsg(`Sold ${qty} @ ${fmt(px)} (+${proceeds} 🪙).`, true);
  renderAll();
}

function renderAll() {
  if (!_built) return;
  renderRegime();
  syncTfButtons();
  renderList();
  renderChartHead();
  renderTrade();
  renderPortfolio();
  drawChart();
}

// ---------------------------------------------------------------------------
// Loops
// ---------------------------------------------------------------------------
let _sinceRebuild = 0;
function onTick() {
  const now = tickIndex();
  if (now > lastComputedTick) {
    advanceTo(now);
    maybeWriteSnapshot(now);
    // 1h/1d rebuild all stocks each tick (cheap, ~12-36ms) so the list % stays
    // live; 1w only refreshes the visible chart on a throttle (a tick is a
    // negligible slice of a week and a full 1w rebuild is ~250ms).
    if (_timeframe === '1w') { if (++_sinceRebuild >= 4) { rebuildSeries(visibleIds()); _sinceRebuild = 0; } }
    else rebuildAllSeries();
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
  rebuildAllSeries();
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
  // Register with the window manager so the titlebar drags and the resize grip
  // appears (the dock path does this too, but opening directly skips it).
  if (window.OS && window.OS.register) { window.OS.register('stocks'); window.OS.focus('stocks'); }
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
