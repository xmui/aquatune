// Aquatune Pawn Shop — "CR4ZY CARL'S CASH 4 STUFF", an obnoxious neon pawn shop.
//
// Two counters under one flickering sign:
//  · THE CASE — a glass display case of 12 exclusive Aquatard accessories
//    (hats + clothes). Locked until bought here; once owned they unlock in the
//    Aquatard Creator (and sync per-account via aq_owned_acc).
//  · CASH 4 STUFF — sell your gathered materials (ores, gems, logs) for
//    credits at the LIVE commodity rate: each item's payout = base value ×
//    its Exchange ticker ratio (ORE / GEMS / LUMBR, see src/stocks.js). Big
//    sell-offs push the rate down for everyone (shared market impact, capped,
//    decaying back to fair value) — dump wisely.

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function credits() { return (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0; }
function sfx(n) { try { window.pawnSfx && window.pawnSfx(n); } catch (e) {} }
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

// The 12 exclusives. type maps to the buddy-config field the Creator edits.
const ACCESSORIES = [
  { id: 'propeller',  type: 'outfit',  name: 'Propeller Cap',      price: 800,   pitch: 'GENTLY USED' },
  { id: 'snapback',   type: 'outfit',  name: 'Flat-Brim Snapback', price: 1200,  pitch: 'STILL HAS STICKER' },
  { id: 'dollartie',  type: 'clothes', name: 'Money Tie',          price: 1800,  pitch: 'DRESS 4 SUCCESS' },
  { id: 'blingbow',   type: 'clothes', name: 'Diamond Bow',        price: 2200,  pitch: 'FANCY!!' },
  { id: 'vikinghelm', type: 'outfit',  name: 'Viking Helm',        price: 4000,  pitch: 'AUTHENTIC-ISH' },
  { id: 'cuban',      type: 'clothes', name: 'XXL Cuban Chain',    price: 5000,  pitch: '99.9% GOLD*' },
  { id: 'cashtopper', type: 'outfit',  name: 'Cash Topper',        price: 6000,  pitch: 'OLD MONEY VIBES' },
  { id: 'champbelt',  type: 'clothes', name: 'Championship Belt',  price: 7500,  pitch: 'UNDEFEATED' },
  { id: 'halo',       type: 'outfit',  name: 'Halo',               price: 8000,  pitch: 'BARELY WORN' },
  { id: 'furcollar',  type: 'clothes', name: 'Fur Collar',         price: 9000,  pitch: '100% FAUX. PROBABLY' },
  { id: 'medallion',  type: 'clothes', name: 'Iced Medallion',     price: 15000, pitch: 'SO ICY' },
  { id: 'pawncrown',  type: 'outfit',  name: 'Pawn King Crown',    price: 45000, pitch: 'U THE KING NOW' },
  // really cursed neotribal ink (back room, no refunds)
  { id: 'trampstamp',   type: 'tattoo', name: 'Lower-Back Tribal',  price: 1500,  pitch: 'TASTEFUL.' },
  { id: 'barbedring',   type: 'tattoo', name: 'Barbed Wire Band',   price: 2000,  pitch: 'SO TOUGH' },
  { id: 'tribalflames', type: 'tattoo', name: 'Tribal Flames',      price: 3000,  pitch: 'FULLY SICK' },
  { id: 'noragrets',    type: 'tattoo', name: '"NO RAGRETS"',       price: 4200,  pitch: 'NOT EVEN ONE' },
  { id: 'scorpking',    type: 'tattoo', name: 'Belly Scorpion',     price: 5500,  pitch: 'VENOMOUS-ISH' },
  { id: 'facetribal',   type: 'tattoo', name: 'Face Tribal',        price: 11000, pitch: 'CAREER ENDER' },
];

// own-once gadgets (not wearable — they live on the tool wall)
const GADGETS = [
  { id: 'radar', name: 'ENEMY RADAR', price: 2800, icon: '📡', pitch: 'FELL OFF A TRUCK', desc: 'Creature blips on the Mining minimap' },
];

const OWN_KEY = 'aq_owned_acc';
function owned() { try { return JSON.parse(localStorage.getItem(OWN_KEY) || '{}') || {}; } catch { return {}; } }
function isOwned(id) { return !!owned()[id]; }
function setOwned(id) {
  try {
    const o = owned(); o[id] = 1;
    localStorage.setItem(OWN_KEY, JSON.stringify(o));
    window.aqGamePersist && window.aqGamePersist(OWN_KEY);
  } catch (e) {}
}

const COMMODITY_LABEL = { ore: ['⛏️', 'ORE'], gems: ['💎', 'GEMS'], lumbr: ['🪵', 'LUMBR'] };
function rate(commodity) {
  const r = (typeof window.aqResourceRate === 'function' && window.aqResourceRate(commodity)) || 1;
  return isFinite(r) && r > 0 ? r : 1;
}
function unitPrice(item) { return Math.max(1, Math.round(item.value * rate(item.commodity))); }

// ── state ────────────────────────────────────────────────────────────────────
let _built = false, area = null, caseEl = null, sellEl = null, toolsEl = null, tickerEl = null, tab = 'sell';
let _rateT = null;

// ── render: rate ticker (scrolling marquee) ──────────────────────────────────
function renderTicker() {
  if (!tickerEl) return;
  const parts = Object.entries(COMMODITY_LABEL).map(([id, [icon, tick]]) => {
    const r = rate(id), pct = (r - 1) * 100;
    const dir = pct >= 0.5 ? '▲' : pct <= -0.5 ? '▼' : '◆';
    const cls = pct >= 0.5 ? 'up' : pct <= -0.5 ? 'dn' : '';
    return `<span class="pw-tick ${cls}">${icon} ${tick} ${dir} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
  }).join('<span class="pw-tick-sep">★</span>');
  tickerEl.innerHTML = `<div class="pw-ticker-inner">${parts}<span class="pw-tick-sep">★</span>${parts}<span class="pw-tick-sep">★</span>${parts}</div>`;
}

// ── render: THE CASE (buy accessories) ───────────────────────────────────────
function buddyPreview(it) {
  const cfg = (window.aqBuddyConfig && window.aqBuddyConfig()) || { color: 'aqua', expression: 'smile', outfit: 'none', clothes: 'none' };
  const field = it.type === 'outfit' ? 'outfit' : it.type === 'tattoo' ? 'tattoo' : 'clothes';
  const merged = { ...cfg, [field]: it.id };
  return (window.aqBuildBuddySvg && window.aqBuildBuddySvg(merged, { size: 62 })) || '🦆';
}
function renderCase() {
  if (!caseEl) return;
  caseEl.innerHTML = '<div class="pw-case-shine"></div>';
  for (const it of ACCESSORIES) {
    const own = isOwned(it.id);
    const cell = el('div', 'pw-item' + (own ? ' pw-owned' : ''));
    cell.innerHTML =
      `<div class="pw-item-av">${buddyPreview(it)}</div>
       <div class="pw-item-name">${it.name}</div>
       <div class="pw-item-pitch">★ ${it.pitch} ★</div>`;
    if (own) {
      const b = el('button', 'pw-btn pw-btn-owned', 'OWNED ✓ wear it');
      b.onclick = () => { window.OS && window.OS.open && window.OS.open('charmaker'); };
      cell.appendChild(b);
    } else {
      const b = el('button', 'pw-btn pw-btn-buy', `💰${fmt(it.price)}`);
      b.disabled = credits() < it.price;
      b.onclick = () => buyAccessory(it, cell);
      cell.appendChild(b);
    }
    caseEl.appendChild(cell);
  }
}
function buyAccessory(it, cell) {
  if (isOwned(it.id) || credits() < it.price) { sfx('deny'); return; }
  if (typeof window.aqSetCredits === 'function') window.aqSetCredits(credits() - it.price);
  setOwned(it.id);
  sfx('buy');
  try { window.playFanfare?.('small'); } catch (e) {}
  if (cell) { cell.classList.add('pw-bought'); }
  try { window.toast && window.toast(`🛍️ ${it.name} is yours — equip it in the Aquatard Creator!`); } catch (e) {}
  renderCase();
  if (typeof window.aqGameAnnounce === 'function' && it.price >= 15000) window.aqGameAnnounce(`bought the ${it.name} at the Pawn Shop 🏪`);
}

// ── render: CASH 4 STUFF (sell materials) ────────────────────────────────────
function renderSell() {
  if (!sellEl) return;
  const inv = (typeof window.aqInvAll === 'function' && window.aqInvAll()) || {};
  const items = (window.aqInvItems || {});
  const ids = Object.keys(items).filter(id => (inv[id] | 0) > 0);
  sellEl.innerHTML = '';
  if (!ids.length) {
    sellEl.appendChild(el('div', 'pw-empty', 'NOTHING TO SELL?!<br><span>Go mine some ore ⛏️ or chop some trees 🪓 and come back.</span>'));
    return;
  }
  let grand = 0;
  for (const id of ids) {
    const it = items[id], n = inv[id] | 0;
    const r = rate(it.commodity), unit = unitPrice(it);
    grand += unit * n;
    const pct = (r - 1) * 100;
    const cls = pct >= 0.5 ? 'up' : pct <= -0.5 ? 'dn' : '';
    const row = el('div', 'pw-row');
    row.innerHTML =
      `<span class="pw-row-ico">${it.icon}</span>
       <span class="pw-row-name">${it.name}<i>×${n}</i></span>
       <span class="pw-row-rate ${cls}">${COMMODITY_LABEL[it.commodity][1]} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>
       <span class="pw-row-unit">💰${fmt(unit)}<i>/ea</i></span>`;
    const one = el('button', 'pw-btn pw-btn-sell', 'Sell 1');
    one.onclick = () => sellItems(id, 1);
    const all = el('button', 'pw-btn pw-btn-sell', `All (💰${fmt(unit * n)})`);
    all.onclick = () => sellItems(id, n);
    row.append(one, all);
    sellEl.appendChild(row);
  }
  const foot = el('div', 'pw-sellall');
  const b = el('button', 'pw-btn pw-btn-dump', `💸 SELL EVERYTHING — 💰${fmt(grand)}`);
  b.onclick = () => { for (const id of ids) sellItems(id, inv[id] | 0, true); sfx('chaching'); renderSell(); renderTicker(); };
  foot.appendChild(b);
  foot.appendChild(el('div', 'pw-fine', '* Rates move when people sell. Dump a mountain of ore and watch ORE tank — it recovers over ~25 min.'));
  sellEl.appendChild(foot);
}
function sellItems(id, n, quiet) {
  const items = window.aqInvItems || {};
  const it = items[id];
  if (!it || typeof window.aqInvTake !== 'function') return;
  const unit = unitPrice(it);
  const took = window.aqInvTake(id, n);
  if (!took) return;
  const pay = unit * took;
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(pay);
  // supply pressure: selling pushes the commodity's rate down (capped per event
  // inside stocks.js, hard-capped overall, decays back — spike then equalize)
  if (typeof window.aqResourceImpact === 'function') window.aqResourceImpact(it.commodity, -Math.min(0.08, (it.value * took) / 2500 * 0.05));
  if (typeof window.recordScore === 'function') window.recordScore('pawn', pay, it.name);
  if (!quiet) { sfx('chaching'); renderSell(); renderTicker(); }
}

// ── render: TOOL WALL (buy / repair tools, gadgets) ──────────────────────────
function renderTools() {
  if (!toolsEl) return;
  toolsEl.innerHTML = '';
  const defs = window.aqToolDefs || {};
  for (const kind of Object.keys(defs)) {
    const d = defs[kind];
    const ti = window.aqToolInfo(kind);
    const cur = d.tiers[ti.tier];
    const row = el('div', 'pw-row pw-row-tool');
    const wearPct = ti.max === -1 ? 100 : Math.round(ti.dur / ti.max * 100);
    row.innerHTML =
      `<span class="pw-row-ico">${d.icon}</span>
       <span class="pw-row-name">${cur.name} ${d.name}${ti.broken ? ' <b class="pw-broke">BROKEN</b>' : ''}
         <span class="pw-dur"><span class="pw-dur-fill${wearPct < 25 ? ' low' : ''}" style="width:${wearPct}%"></span></span>
       </span>`;
    if (ti.max !== -1 && ti.dur < ti.max) {
      const rc = window.aqToolRepairCost(kind);
      const fix = el('button', 'pw-btn pw-btn-sell', `🔧 Repair 💰${fmt(rc)}`);
      fix.disabled = credits() < rc;
      fix.onclick = () => { if (window.aqToolRepair(kind)) { sfx('chaching'); renderTools(); } else sfx('deny'); };
      row.appendChild(fix);
    }
    if (ti.tier < d.tiers.length - 1) {
      const next = d.tiers[ti.tier + 1];
      const b = el('button', 'pw-btn pw-btn-buy', `${next.name} 💰${fmt(next.cost)}`);
      b.disabled = credits() < next.cost;
      b.onclick = () => { if (window.aqToolBuy(kind)) { sfx('buy'); try { window.toast && window.toast(`${d.icon} ${next.name} ${d.name} — fresh off the wall!`); } catch (e) {} renderTools(); } else sfx('deny'); };
      row.appendChild(b);
    } else row.appendChild(el('span', 'pw-maxed', 'TOP SHELF ✓'));
    toolsEl.appendChild(row);
  }
  for (const g of GADGETS) {
    const own = isOwned(g.id);
    const row = el('div', 'pw-row pw-row-tool');
    row.innerHTML = `<span class="pw-row-ico">${g.icon}</span>
      <span class="pw-row-name">${g.name} <i>· ${g.desc}</i><div class="pw-item-pitch">★ ${g.pitch} ★</div></span>`;
    if (own) row.appendChild(el('span', 'pw-maxed', 'OWNED ✓'));
    else {
      const b = el('button', 'pw-btn pw-btn-buy', `💰${fmt(g.price)}`);
      b.disabled = credits() < g.price;
      b.onclick = () => {
        if (credits() < g.price) { sfx('deny'); return; }
        window.aqSetCredits(credits() - g.price);
        setOwned(g.id); sfx('buy');
        try { window.toast && window.toast(`${g.icon} ${g.name} installed!`); } catch (e) {}
        renderTools();
      };
      row.appendChild(b);
    }
    toolsEl.appendChild(row);
  }
}

// ── window plumbing ──────────────────────────────────────────────────────────
function setTab(t) {
  tab = t;
  if (!area) return;
  area.querySelectorAll('.pw-tab').forEach(b => b.classList.toggle('on', b.dataset.t === t));
  const c = area.querySelector('.pw-case-wrap'), s = area.querySelector('.pw-sell-wrap'), w = area.querySelector('.pw-tools-wrap');
  if (c) c.style.display = t === 'buy' ? 'block' : 'none';
  if (s) s.style.display = t === 'sell' ? 'block' : 'none';
  if (w) w.style.display = t === 'tools' ? 'block' : 'none';
  if (t === 'buy') renderCase(); else if (t === 'tools') renderTools(); else renderSell();
}
function injectStyle() {
  if (document.getElementById('pw-style')) return;
  const s = el('style'); s.id = 'pw-style';
  s.textContent = `
  #pawn-wrap{position:fixed;top:44px;left:50%;transform:translateX(-50%);width:470px;max-width:96vw;
    max-height:calc(100vh - 56px);border-radius:var(--chrome-radius,10px);z-index:540;flex-direction:column;
    background:var(--panel);border:1.5px solid var(--win-border,var(--border));
    box-shadow:var(--win-shadow,0 18px 50px rgba(0,0,0,.45));font-family:var(--font-ui);overflow:hidden}
  #pawn-wrap.open{display:flex}
  #pawn-area{position:relative;flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;
    background:repeating-linear-gradient(90deg,#3a2418 0 18px,#2e1c12 18px 36px);padding:0 0 12px}
  /* flashing bulb border */
  .pw-bulbs{height:8px;flex-shrink:0;background:repeating-linear-gradient(90deg,#ffe04a 0 8px,#3a2418 8px 16px);animation:pwBulbs .6s steps(2) infinite}
  @keyframes pwBulbs{50%{background-position:8px 0}}
  /* the neon sign */
  .pw-sign{flex-shrink:0;text-align:center;padding:10px 6px 4px;font-family:'Arial Black',Verdana,sans-serif}
  .pw-sign-main{font-size:21px;font-weight:900;letter-spacing:1.5px;animation:pwNeon 1.4s linear infinite}
  @keyframes pwNeon{
    0%,100%{color:#ff2e9a;text-shadow:0 0 6px #ff2e9a,0 0 18px #ff2e9a,0 2px 0 #000}
    33%{color:#16f0ff;text-shadow:0 0 6px #16f0ff,0 0 18px #16f0ff,0 2px 0 #000}
    66%{color:#ffe04a;text-shadow:0 0 6px #ffe04a,0 0 18px #ffe04a,0 2px 0 #000}
    71%{color:#3a2418;text-shadow:none}73%{color:#ffe04a;text-shadow:0 0 6px #ffe04a,0 0 18px #ffe04a,0 2px 0 #000}}
  .pw-sign-sub{font-size:10px;font-weight:900;color:#fff;letter-spacing:2px;margin-top:2px}
  .pw-sign-sub i{display:inline-block;font-style:normal;color:#58ff58;text-shadow:0 0 8px #58ff58;animation:pwBlink 1s steps(2) infinite}
  @keyframes pwBlink{50%{opacity:.15}}
  /* scrolling rate ticker */
  .pw-ticker{flex-shrink:0;overflow:hidden;background:#0c0c14;border-top:2px solid #ffd24a;border-bottom:2px solid #ffd24a;margin:6px 0}
  .pw-ticker-inner{display:inline-block;white-space:nowrap;padding:4px 0;animation:pwScroll 14s linear infinite}
  @keyframes pwScroll{from{transform:translateX(0)}to{transform:translateX(-33.4%)}}
  .pw-tick{font-family:monospace;font-weight:800;font-size:12px;color:#e8e8f0;padding:0 10px}
  .pw-tick.up{color:#58ff58}.pw-tick.dn{color:#ff5858}
  .pw-tick-sep{color:#ffd24a;animation:pwSpin 2.4s linear infinite;display:inline-block}
  @keyframes pwSpin{to{transform:rotate(360deg)}}
  /* tabs */
  .pw-tabs{display:flex;gap:8px;justify-content:center;padding:4px 10px 8px;flex-shrink:0}
  .pw-tab{font-family:'Arial Black',Verdana,sans-serif;font-weight:900;font-size:12px;padding:8px 16px;cursor:pointer;
    color:#ffe9a0;background:linear-gradient(180deg,#5a3520,#3a2014);border:2px solid #c8960a;border-radius:10px;
    text-shadow:0 1px 0 #000;transform:rotate(-1deg)}
  .pw-tab:nth-child(2){transform:rotate(1.2deg)}
  .pw-tab.on{color:#1a0e04;background:linear-gradient(180deg,#ffe04a,#e09a1a);box-shadow:0 0 14px rgba(255,200,40,.7);animation:pwWiggle 2.6s ease-in-out infinite}
  @keyframes pwWiggle{0%,100%{transform:rotate(-1.5deg) scale(1)}50%{transform:rotate(1.5deg) scale(1.04)}}
  /* display case */
  .pw-case-wrap,.pw-sell-wrap{padding:0 12px}
  .pw-case{position:relative;display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:10px;
    background:linear-gradient(180deg,rgba(90,140,180,0.25),rgba(40,70,100,0.3));border:3px solid #b8c4cc;
    border-radius:10px;padding:12px;box-shadow:inset 0 0 30px rgba(150,200,240,0.25), 0 4px 14px rgba(0,0,0,.4);overflow:hidden}
  .pw-case-shine{position:absolute;top:-50%;left:-60%;width:40%;height:200%;pointer-events:none;
    background:linear-gradient(100deg,transparent,rgba(255,255,255,0.22),transparent);transform:rotate(8deg);animation:pwShine 5s ease-in-out infinite}
  @keyframes pwShine{0%,60%,100%{left:-60%}30%{left:120%}}
  .pw-item{display:flex;flex-direction:column;align-items:center;gap:3px;padding:10px 6px 9px;border-radius:9px;
    background:linear-gradient(180deg,#6e1622,#4a0e16);border:2px solid #c8960a;box-shadow:inset 0 1px 0 rgba(255,255,255,.18)}
  .pw-item.pw-owned{border-color:#58c058;filter:saturate(.85)}
  .pw-item.pw-bought{animation:pwBought .6s ease-out}
  @keyframes pwBought{0%{transform:scale(1.15);box-shadow:0 0 30px #ffe04a}100%{transform:scale(1)}}
  .pw-item-av{background:radial-gradient(circle at 50% 35%,#fff5d8,#e8c87a);border-radius:50%;padding:4px;line-height:0;
    border:2px solid #c8960a}
  .pw-item-name{font-size:10.5px;font-weight:900;color:#ffe9a0;text-align:center;text-shadow:0 1px 0 #000}
  .pw-item-pitch{font-size:7.5px;font-weight:800;color:#ff9a6a;letter-spacing:.5px;animation:pwBlink 1.6s steps(2) infinite}
  .pw-btn{font-family:'Arial Black',Verdana,sans-serif;font-weight:900;font-size:10.5px;cursor:pointer;border-radius:7px;padding:5px 9px;
    color:#401a04;background:linear-gradient(180deg,#ffe04a,#e09a1a);border:1.5px solid #8a5a10;box-shadow:0 2px 0 #8a5a10}
  .pw-btn:active:not(:disabled){transform:translateY(2px);box-shadow:none}
  .pw-btn:disabled{filter:grayscale(.7);opacity:.6;cursor:default}
  .pw-btn-owned{background:linear-gradient(180deg,#8ae08a,#3a9a4a);color:#0c2c10;border-color:#1c5a24}
  .pw-btn-buy{margin-top:2px}
  /* sell counter */
  .pw-row{display:flex;align-items:center;gap:7px;padding:7px 9px;margin-bottom:7px;border-radius:9px;
    background:linear-gradient(180deg,#2c4a2c,#1a301c);border:2px solid #58c058;box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}
  .pw-row-ico{font-size:19px}
  .pw-row-name{flex:1;font-size:11px;font-weight:900;color:#e8ffe0;text-shadow:0 1px 0 #000}
  .pw-row-name i{font-style:normal;color:#a8d8a0;margin-left:5px}
  .pw-row-rate{font-family:monospace;font-size:10px;font-weight:800;color:#cfd8e0}
  .pw-row-rate.up{color:#58ff58}.pw-row-rate.dn{color:#ff5858}
  .pw-row-unit{font-size:11px;font-weight:900;color:#ffe04a}
  .pw-row-unit i{font-style:normal;font-size:8px;color:#caa84a}
  .pw-btn-sell{font-size:9.5px;padding:5px 7px}
  .pw-sellall{text-align:center;margin-top:9px}
  .pw-btn-dump{font-size:13px;padding:10px 18px;animation:pwWiggle 3.2s ease-in-out infinite}
  .pw-fine{font-size:8.5px;color:#caa888;margin-top:7px;line-height:1.45}
  .pw-empty{text-align:center;font-family:'Arial Black',Verdana,sans-serif;color:#ffe9a0;font-size:14px;padding:26px 10px;text-shadow:0 1px 0 #000}
  .pw-empty span{display:block;font-size:10px;color:#caa888;margin-top:6px;font-family:var(--font-ui)}
  .pw-tools-wrap{padding:0 12px}
  .pw-row-tool{background:linear-gradient(180deg,#3a3046,#241c30);border-color:#8a6ad0}
  .pw-dur{display:block;width:110px;height:6px;border-radius:3px;background:rgba(0,0,0,.5);margin-top:3px;overflow:hidden}
  .pw-dur-fill{display:block;height:100%;background:linear-gradient(90deg,#58c058,#a8e078)}
  .pw-dur-fill.low{background:linear-gradient(90deg,#e04838,#ff8a4a)}
  .pw-broke{color:#ff5858;animation:pwBlink .8s steps(2) infinite}
  .pw-maxed{font-size:9.5px;font-weight:900;color:#8ae08a}
  @media (max-width:768px){#pawn-wrap{width:100vw;top:0;left:0;transform:none;height:100%;max-height:none;border-radius:0}}`;
  document.head.appendChild(s);
}
function build() {
  area = document.getElementById('pawn-area');
  if (!area) return;
  injectStyle();
  area.innerHTML = '';
  area.appendChild(el('div', 'pw-bulbs'));
  area.appendChild(el('div', 'pw-sign',
    `<div class="pw-sign-main">💎 CR4ZY CARL'S 💎</div>
     <div class="pw-sign-sub">CASH 4 STUFF · WE BUY ANYTHING* · <i>● OPEN 24/7</i></div>`));
  tickerEl = el('div', 'pw-ticker'); area.appendChild(tickerEl);
  const tabs = el('div', 'pw-tabs');
  const tSell = el('button', 'pw-tab', '💸 CASH 4 STUFF'); tSell.dataset.t = 'sell'; tSell.onclick = () => setTab('sell');
  const tBuy = el('button', 'pw-tab', '🛍️ THE CASE'); tBuy.dataset.t = 'buy'; tBuy.onclick = () => setTab('buy');
  const tTools = el('button', 'pw-tab', '🧰 TOOL WALL'); tTools.dataset.t = 'tools'; tTools.onclick = () => setTab('tools');
  tabs.append(tSell, tBuy, tTools);
  area.appendChild(tabs);
  const sw = el('div', 'pw-sell-wrap'); sellEl = el('div'); sw.appendChild(sellEl); area.appendChild(sw);
  const cw = el('div', 'pw-case-wrap'); caseEl = el('div', 'pw-case'); cw.appendChild(caseEl); area.appendChild(cw);
  const tw = el('div', 'pw-tools-wrap'); toolsEl = el('div'); tw.appendChild(toolsEl); area.appendChild(tw);
  _built = true;
}
function openPawnShop(show = true) {
  const w = document.getElementById('pawn-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; clearInterval(_rateT); return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('pawn'); window.OS.focus('pawn'); }
  if (!_built) build();
  renderTicker(); setTab(tab);
  clearInterval(_rateT);
  _rateT = setInterval(() => {                      // rates drift live while open
    renderTicker();
    if (tab === 'sell') renderSell(); else if (tab === 'tools') renderTools(); else renderCase();
  }, 5000);
}

if (typeof window !== 'undefined') {
  window.openPawnShop = openPawnShop;
  // Creator integration: which keys are shop exclusives + ownership checks.
  window.aqShopAccessories = Object.fromEntries(ACCESSORIES.map(a => [a.id, a]));
  window.aqAccOwned = isOwned;
  window.addEventListener('aq-gamedata-synced', () => {
    const w = document.getElementById('pawn-wrap');
    if (w && w.classList.contains('open')) setTab(tab);
  });
  if (window.__pawnTestHook) window.__pawnTestHook({ ACCESSORIES, isOwned, setOwned, sellItems, unitPrice, rate, buyAccessory, openPawnShop, setTab });
}
