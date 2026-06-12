// Aquatune Tools — shared tool ownership + DURABILITY for pick / rod / axe.
//
// Tools are bought (and repaired) at the Pawn Shop, not inside the games.
// Each tier has a durability pool that wears down as you use it; at zero the
// tool is BROKEN and behaves like the free starter tier until repaired.
// Starter tools never break. State lives in `aq_tools` (BLOB, newest-wins);
// the owned TIER also mirrors to the legacy per-game keys (TIER_KEYS,
// max-merge) so a bought tier can never be lost to a sync race.
//
// API (window):
//   aqToolTier(kind)        -> EFFECTIVE tier (0 while broken)
//   aqToolInfo(kind)        -> { tier, dur, max, broken, def }
//   aqToolWear(kind, n=1)   -> true if the tool just broke
//   aqToolBuy(kind)         -> buy next tier (Pawn Shop)
//   aqToolRepair(kind)      -> restore durability for ~25% of price

const TOOLS = {
  pick: { name: 'Pickaxe', icon: '⛏️', legacy: 'aq_mining_pick',
    tiers: [
      { name: 'Wooden',   cost: 0,     dur: Infinity },
      { name: 'Stone',    cost: 150,   dur: 420 },
      { name: 'Iron',     cost: 600,   dur: 750 },
      { name: 'Gold',     cost: 2000,  dur: 1150 },
      { name: 'Diamond',  cost: 7000,  dur: 1700 },
      { name: 'Aquatune', cost: 25000, dur: 2600 },
    ] },
  rod: { name: 'Fishing Rod', icon: '🎣', legacy: 'aq_fishing_rod',
    tiers: [
      { name: 'Bamboo', cost: 0,    dur: Infinity },
      { name: 'Fiber',  cost: 400,  dur: 130 },
      { name: 'Carbon', cost: 2200, dur: 260 },
      { name: 'Mythic', cost: 9500, dur: 460 },
    ] },
  axe: { name: 'Axe', icon: '🪓', legacy: 'aq_lumber_axe',
    tiers: [
      { name: 'Rusty',    cost: 0,     dur: Infinity },
      { name: 'Bronze',   cost: 250,   dur: 380 },
      { name: 'Steel',    cost: 900,   dur: 700 },
      { name: 'Sapphire', cost: 3200,  dur: 1100 },
      { name: 'Mythic',   cost: 12000, dur: 1700 },
    ] },
};
const KEY = 'aq_tools';
const REPAIR_FRAC = 0.25;

function read() {
  let t = null;
  try { t = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (!t) {
    // first run: adopt tiers already bought through the old in-game shops
    t = {};
    for (const kind of Object.keys(TOOLS)) {
      const lg = parseInt(localStorage.getItem(TOOLS[kind].legacy) || '0', 10) || 0;
      const tier = Math.max(0, Math.min(TOOLS[kind].tiers.length - 1, lg));
      t[kind] = { tier, dur: durOf(kind, tier) };
    }
    write(t);
  }
  return t;
}
function write(t) { try { localStorage.setItem(KEY, JSON.stringify(t)); window.aqGamePersist && window.aqGamePersist(KEY); } catch (e) {} }
function durOf(kind, tier) { const d = TOOLS[kind].tiers[tier].dur; return d === Infinity ? -1 : d; }   // -1 = infinite (starter)
function entry(kind) {
  const t = read();
  const e = t[kind] || { tier: 0, dur: -1 };
  e.tier = Math.max(0, Math.min(TOOLS[kind].tiers.length - 1, e.tier | 0));
  return e;
}
function info(kind) {
  const e = entry(kind);
  const max = durOf(kind, e.tier);
  const broken = max !== -1 && e.dur <= 0;
  return { tier: e.tier, dur: e.dur, max, broken, def: TOOLS[kind] };
}
function effectiveTier(kind) {
  const i = info(kind);
  return i.broken ? 0 : i.tier;
}
function wear(kind, n = 1) {
  const t = read();
  const e = t[kind]; if (!e) return false;
  const max = durOf(kind, e.tier);
  if (max === -1 || e.dur <= 0) return false;        // starter or already broken
  e.dur = Math.max(0, e.dur - n);
  write(t);
  return e.dur <= 0;                                  // true: it JUST broke
}
function buy(kind) {
  const i = info(kind);
  const next = i.tier + 1;
  if (next >= TOOLS[kind].tiers.length) return false;
  const cost = TOOLS[kind].tiers[next].cost;
  const credits = (window.aqGetCredits && window.aqGetCredits()) || 0;
  if (credits < cost) return false;
  window.aqSetCredits(credits - cost);
  const t = read();
  t[kind] = { tier: next, dur: durOf(kind, next) };
  write(t);
  // mirror the owned tier to the legacy max-merge key so it can never be lost
  try { localStorage.setItem(TOOLS[kind].legacy, String(next)); window.aqGamePersist && window.aqGamePersist(TOOLS[kind].legacy); } catch (e) {}
  return true;
}
function repairCost(kind) { return Math.max(10, Math.round(TOOLS[kind].tiers[info(kind).tier].cost * REPAIR_FRAC)); }
function repair(kind) {
  const i = info(kind);
  if (i.max === -1 || i.dur >= i.max) return false;
  const cost = repairCost(kind);
  const credits = (window.aqGetCredits && window.aqGetCredits()) || 0;
  if (credits < cost) return false;
  window.aqSetCredits(credits - cost);
  const t = read();
  t[kind].dur = i.max;
  write(t);
  return true;
}

if (typeof window !== 'undefined') {
  window.aqToolDefs = TOOLS;
  window.aqToolTier = effectiveTier;
  window.aqToolInfo = info;
  window.aqToolWear = wear;
  window.aqToolBuy = buy;
  window.aqToolRepair = repair;
  window.aqToolRepairCost = repairCost;
}
