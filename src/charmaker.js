// Mii Studio — a Mii-style creator for your Aqua Buddy.
//
// Edits the unified buddy config (color · expression · hat · clothes) exposed by
// src/buddy.js. Saving commits via window.aqSetBuddyConfig, which instantly
// updates the floating mascot, your Messenger presence avatar, and every
// chat/stats/profile avatar across the app.

let _built = false;
let draft = null;          // working copy, committed on Save
let tab = 'color';         // color | face | hat | clothes

function cfg() { return (window.aqBuddyConfig && window.aqBuddyConfig()) || { color: 'aqua', expression: 'smile', outfit: 'none', clothes: 'none' }; }
function svg(c, size) { return (window.aqBuildBuddySvg && window.aqBuildBuddySvg(c, { size })) || ''; }

const TABS = [
  { id: 'color',   label: '🎨 Color',   field: 'color',      keys: () => window.aqBuddyPaletteKeys || [],    names: () => window.aqBuddyPalettes || {} },
  { id: 'face',    label: '😀 Face',    field: 'expression', keys: () => window.aqBuddyExpressionKeys || [], names: () => window.aqBuddyExpressions || {} },
  { id: 'hat',     label: '🎩 Hat',     field: 'outfit',     keys: () => window.aqBuddyOutfitKeys || [],     names: () => null },
  { id: 'clothes', label: '👕 Clothes', field: 'clothes',    keys: () => window.aqBuddyClothesKeys || [],    names: () => window.aqBuddyClothes || {} },
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
    cell.className = 'cm-cell' + (draft[t.field] === key ? ' on' : '');
    // preview this option applied on top of the current draft
    const optCfg = { ...draft, [t.field]: key };
    const label = (names && names[key] && names[key].name) || key;
    cell.innerHTML = `<div class="cm-cell-av">${svg(optCfg, 54)}</div><div class="cm-cell-lab">${esc(label)}</div>`;
    cell.onclick = () => { draft[t.field] = key; render(); };
    grid.appendChild(cell);
  });
}

function randomize() {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  draft = {
    color: pick(window.aqBuddyPaletteKeys || ['aqua']),
    expression: pick(window.aqBuddyExpressionKeys || ['smile']),
    outfit: pick(window.aqBuddyOutfitKeys || ['none']),
    clothes: pick(window.aqBuddyClothesKeys || ['none']),
  };
  render();
}

function save() {
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
