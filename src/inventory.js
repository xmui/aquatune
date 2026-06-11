// Aquatune Inventory — a shared satchel of gathered materials (ores, logs, …).
//
// Games deposit raw resources here as you gather them (mining veins, felled
// trees); a future shop will spend them. Counts live in localStorage and merge
// to the cloud per-account via gamesave (COUNT_KEYS, per-item max).
//
// API for games:  window.aqInvAdd(id, n)  ·  window.aqInvCount(id)
// Item ids are namespaced: 'ore_copper', 'log_oak', …  Register display info in
// ITEMS below when adding a new resource type.

const ITEMS = {
  // mining ores (match src/mining.js ORES names, lowercased)
  ore_stone:    { name: 'Stone',        icon: '🪨' },
  ore_copper:   { name: 'Copper Ore',   icon: '🟠' },
  ore_coal:     { name: 'Coal',         icon: '⚫' },
  ore_iron:     { name: 'Iron Ore',     icon: '⚙️' },
  ore_gold:     { name: 'Gold Ore',     icon: '🟡' },
  ore_emerald:  { name: 'Emerald',      icon: '🟢' },
  ore_ruby:     { name: 'Ruby',         icon: '🔴' },
  ore_obsidian: { name: 'Obsidian',     icon: '🟣' },
  ore_diamond:  { name: 'Diamond',      icon: '💎' },
  ore_aquatune: { name: 'Aquatune Ore', icon: '🔷' },
  // woodcutting logs (match src/lumberjack.js TREES)
  log_birch:    { name: 'Birch Logs',   icon: '🪵' },
  log_oak:      { name: 'Oak Logs',     icon: '🪵' },
  log_pine:     { name: 'Pine Logs',    icon: '🌲' },
  log_redwood:  { name: 'Redwood Logs', icon: '🪵' },
  log_spirit:   { name: 'Spirit Logs',  icon: '✨' },
};

const KEY = 'aq_inventory';
function read() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } }
function write(inv) {
  try { localStorage.setItem(KEY, JSON.stringify(inv)); window.aqGamePersist && window.aqGamePersist(KEY); } catch (e) {}
}

function invAdd(id, n = 1) {
  if (!id || !(n > 0)) return;
  const inv = read();
  inv[id] = (inv[id] | 0) + Math.round(n);
  write(inv);
  const w = document.getElementById('inventory-wrap');
  if (w && w.classList.contains('open')) render();
}
function invCount(id) { return read()[id] | 0; }

// ── window ───────────────────────────────────────────────────────────────────
let _built = false, gridEl = null;
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

function render() {
  if (!gridEl) return;
  const inv = read();
  const ids = Object.keys(ITEMS).filter(id => (inv[id] | 0) > 0);
  gridEl.innerHTML = '';
  if (!ids.length) {
    gridEl.appendChild(el('div', 'inv-empty', 'Nothing gathered yet.<br>Mine some ore ⛏️ or chop some trees 🪓!'));
    return;
  }
  for (const id of ids) {
    const it = ITEMS[id] || { name: id, icon: '❓' };
    gridEl.appendChild(el('div', 'inv-cell',
      `<span class="inv-ico">${it.icon}</span><span class="inv-name">${it.name}</span><span class="inv-n">×${inv[id]}</span>`));
  }
}

function injectStyle() {
  if (document.getElementById('inv-style')) return;
  const s = el('style'); s.id = 'inv-style';
  s.textContent = `
  #inventory-wrap{position:fixed;top:70px;left:50%;transform:translateX(-50%);width:380px;max-width:96vw;
    max-height:calc(100vh - 90px);border-radius:var(--chrome-radius,10px);z-index:540;flex-direction:column;
    background:var(--panel);border:1.5px solid var(--win-border,var(--border));
    box-shadow:var(--win-shadow,0 18px 50px rgba(0,0,0,.45));font-family:var(--font-ui);overflow:hidden}
  #inventory-wrap.open{display:flex}
  #inventory-area{flex:1;min-height:0;overflow:auto;padding:10px}
  .inv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px}
  .inv-cell{display:flex;flex-direction:column;align-items:center;gap:2px;padding:9px 4px;border-radius:9px;
    background:rgba(127,127,127,0.1);border:1px solid var(--border);color:var(--text)}
  .inv-ico{font-size:24px}
  .inv-name{font-size:10.5px;font-weight:700;text-align:center}
  .inv-n{font-size:11px;font-weight:800;color:var(--accent)}
  .inv-empty{grid-column:1/-1;text-align:center;font-size:12px;color:var(--text2);padding:26px 8px;line-height:1.6}
  .inv-hint{font-size:10px;color:var(--text2);text-align:center;padding:6px 10px 10px}
  @media (max-width:768px){#inventory-wrap{width:100vw;top:0;left:0;transform:none;height:100%;max-height:none;border-radius:0}}`;
  document.head.appendChild(s);
}

function build() {
  const area = document.getElementById('inventory-area');
  if (!area) return;
  injectStyle();
  area.innerHTML = '';
  gridEl = el('div', 'inv-grid');
  area.appendChild(gridEl);
  area.appendChild(el('div', 'inv-hint', 'Raw materials you\'ve gathered. A trading post is coming soon…'));
  _built = true;
}

function openInventory(show = true) {
  const w = document.getElementById('inventory-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('inventory'); window.OS.focus('inventory'); }
  if (!_built) build();
  render();
}

if (typeof window !== 'undefined') {
  window.aqInvAdd = invAdd;
  window.aqInvCount = invCount;
  window.aqInvAll = read;
  window.openInventory = openInventory;
  window.addEventListener('aq-gamedata-synced', () => {
    const w = document.getElementById('inventory-wrap');
    if (w && w.classList.contains('open')) render();
  });
}
