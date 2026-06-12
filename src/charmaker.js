// Aquatard Creator — a character creator for your Aqua Buddy (aka your Aquatard).
//
// Edits the unified buddy config (color · expression · hat · clothes) exposed by
// src/buddy.js. Saving commits via window.aqSetBuddyConfig, which instantly
// updates the floating mascot, your Messenger presence avatar, and every
// chat/stats/profile avatar across the app.

let _built = false;
let draft = null;          // working copy, committed on Save
let tab = 'color';         // color | face | hat | clothes

function cfg() { return (window.aqBuddyConfig && window.aqBuddyConfig()) || { color: 'aqua', expression: 'smile', outfit: 'none', clothes: 'none', tattoo: 'none' }; }
function svg(c, size) { return (window.aqBuildBuddySvg && window.aqBuildBuddySvg(c, { size })) || ''; }

const TABS = [
  { id: 'color',   label: '🎨 Color',   field: 'color',      keys: () => window.aqBuddyPaletteKeys || [],    names: () => window.aqBuddyPalettes || {} },
  { id: 'face',    label: '😀 Face',    field: 'expression', keys: () => window.aqBuddyExpressionKeys || [], names: () => window.aqBuddyExpressions || {} },
  { id: 'hat',     label: '🎩 Hat',     field: 'outfit',     keys: () => window.aqBuddyOutfitKeys || [],     names: () => null },
  { id: 'clothes', label: '👕 Clothes', field: 'clothes',    keys: () => window.aqBuddyClothesKeys || [],    names: () => window.aqBuddyClothes || {} },
  { id: 'tattoo',  label: '🐉 Ink',     field: 'tattoo',     keys: () => window.aqBuddyTattooKeys || [],     names: () => window.aqBuddyTattoos || {} },
];

function build() {
  const area = document.getElementById('charmaker-area');
  if (!area) return;
  area.innerHTML = `
    <div class="cm-stage">
      <div class="cm-preview" id="cm-preview"></div>
      <div class="cm-note" id="cm-note"></div>
    </div>
    <div class="cm-panel">
      <div class="cm-tabs" id="cm-tabs"></div>
      <div class="cm-grid" id="cm-grid"></div>
      <div class="cm-actions">
        <button class="cm-btn cm-rand" id="cm-rand">🎲 Randomize</button>
        <button class="cm-btn cm-save" id="cm-save">Save</button>
      </div>
    </div>`;
  const tabsEl = area.querySelector('#cm-tabs');
  TABS.forEach(t => {
    const b = document.createElement('button');
    b.className = 'cm-tab'; b.dataset.tab = t.id; b.textContent = t.label;
    b.onclick = () => { tab = t.id; render(); };
    tabsEl.appendChild(b);
  });
  area.querySelector('#cm-rand').onclick = randomize;
  area.querySelector('#cm-save').onclick = save;
  _built = true;
}

function render() {
  const preview = document.getElementById('cm-preview');
  if (preview) preview.innerHTML = svg(draft, 190);
  const note = document.getElementById('cm-note');
  if (note) note.textContent = window._aqAccountId ? '' : 'Tip: sign in so your look syncs and shows to others.';
  document.querySelectorAll('#cm-tabs .cm-tab').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const grid = document.getElementById('cm-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const t = TABS.find(x => x.id === tab);
  const names = t.names();
  t.keys().forEach(key => {
    const cell = document.createElement('button');
    // Pawn Shop exclusives are visible but locked until bought there.
    const shopItem = window.aqShopAccessories && window.aqShopAccessories[key];
    const locked = !!(shopItem && !(window.aqAccOwned && window.aqAccOwned(key)));
    cell.className = 'cm-cell' + (draft[t.field] === key ? ' on' : '') + (locked ? ' cm-locked' : '');
    // preview this option applied on top of the current draft
    const optCfg = { ...draft, [t.field]: key };
    const label = (names && names[key] && names[key].name) || (shopItem && shopItem.name) || key;
    cell.innerHTML = `<div class="cm-cell-av">${svg(optCfg, 54)}</div><div class="cm-cell-lab">${esc(label)}</div>` +
      (locked ? `<div class="cm-lock">🔒 ${shopItem.price.toLocaleString()} at the Pawn Shop</div>` : '');
    cell.onclick = () => {
      if (locked) {
        try { window.toast && window.toast(`🔒 ${label} is in the Pawn Shop display case — 💰${shopItem.price.toLocaleString()}`); } catch (e) {}
        if (window.OS && window.OS.open) window.OS.open('pawn');
        return;
      }
      draft[t.field] = key; render();
    };
    grid.appendChild(cell);
  });
}

function unlockedKeys(keys) {
  return keys.filter(k => !(window.aqShopAccessories && window.aqShopAccessories[k]) || (window.aqAccOwned && window.aqAccOwned(k)));
}
function randomize() {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  draft = {
    color: pick(window.aqBuddyPaletteKeys || ['aqua']),
    expression: pick(window.aqBuddyExpressionKeys || ['smile']),
    outfit: pick(unlockedKeys(window.aqBuddyOutfitKeys || ['none'])),
    clothes: pick(unlockedKeys(window.aqBuddyClothesKeys || ['none'])),
    tattoo: pick(unlockedKeys(window.aqBuddyTattooKeys || ['none'])),
  };
  render();
}

function save() {
  // belt & braces: never save a locked exclusive (UI blocks selecting them anyway)
  for (const f of ['outfit', 'clothes', 'tattoo']) {
    const k = draft[f];
    if (window.aqShopAccessories && window.aqShopAccessories[k] && !(window.aqAccOwned && window.aqAccOwned(k))) draft[f] = 'none';
  }
  if (window.aqSetBuddyConfig) window.aqSetBuddyConfig(draft);
  const btn = document.getElementById('cm-save');
  if (btn) { btn.textContent = 'Saved ✓'; setTimeout(() => { if (btn) btn.textContent = 'Save'; }, 1400); }
  try { window.aqRefreshStats && window.aqRefreshStats(); } catch (e) {}
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function openCharMaker(show = true) {
  const w = document.getElementById('charmaker-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; return; }
  w.classList.add('open'); w.style.display = 'flex';
  if (window.OS && window.OS.register) { window.OS.register('charmaker'); window.OS.focus('charmaker'); }
  draft = { ...cfg() };
  if (!_built) build();
  render();
}

if (typeof window !== 'undefined') {
  window.openCharMaker = openCharMaker;
}

export { openCharMaker };
