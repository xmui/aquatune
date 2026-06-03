// Aquatune Skills — a RuneScape-flavored stats system.
//
// Each "skill" is an XP pool that levels 1..100 on the classic OSRS curve. XP is
// granted by games via the global helpers (window.aqGameXp / window.aqAddXp), so
// adding a new skill is as simple as appending to SKILLS below and granting XP
// from wherever makes sense. State is cached in localStorage and synced per-user
// to Firebase (mirroring the stocks/portfolio pattern) so stats follow an account
// across devices.

import { ref, get, set } from 'firebase/database';
import { db } from './firebase.js';

// ---------------------------------------------------------------------------
// Skill registry — append here to add more skills later.
// ---------------------------------------------------------------------------
const SKILLS = [
  { id: 'fishing',  name: 'Fishing',   icon: '🎣', blurb: 'Reel them in' },
  { id: 'mining',   name: 'Mining',    icon: '⛏️', blurb: 'Crack the rocks' },
  { id: 'gambling', name: 'Gambling',  icon: '🎲', blurb: 'Slots, Blackjack & Hold’em' },
  { id: 'intellect',name: 'Intellect', icon: '🧠', blurb: 'Picross, Mines & Solitaire' },
  { id: 'speed',    name: 'Speed',     icon: '⚡', blurb: 'Beat Tap & Pinball' },
  { id: 'music',    name: 'Music',     icon: '🎵', blurb: 'Time spent watching' },
  { id: 'finance',  name: 'Finance',   icon: '💹', blurb: 'Working the Exchange' },
];
const SKILL_BY_ID = Object.fromEntries(SKILLS.map(s => [s.id, s]));
const MAX_LEVEL = 100;

// ---------------------------------------------------------------------------
// OSRS-style XP curve. xpForLevel(L) is the cumulative XP needed to *reach* L.
// Faithfully grindy: 99 is ~13M XP. Capped at level 100.
// ---------------------------------------------------------------------------
const _xpTable = (() => {
  const t = [0, 0]; // index by level; level 1 = 0xp
  let points = 0;
  for (let lvl = 1; lvl < MAX_LEVEL; lvl++) {
    points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    t[lvl + 1] = Math.floor(points / 4);
  }
  return t; // t[100] is the xp needed to hit level 100
})();

function xpForLevel(lvl) {
  if (lvl <= 1) return 0;
  if (lvl > MAX_LEVEL) lvl = MAX_LEVEL;
  return _xpTable[lvl];
}
function levelForXp(xp) {
  xp = Math.max(0, xp | 0);
  let lvl = 1;
  while (lvl < MAX_LEVEL && xp >= _xpTable[lvl + 1]) lvl++;
  return lvl;
}
// { level, cur, need, pct } — cur/need are XP into the current level.
function levelProgress(xp) {
  xp = Math.max(0, xp | 0);
  const level = levelForXp(xp);
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, cur: 0, need: 0, pct: 100 };
  const base = xpForLevel(level), next = xpForLevel(level + 1);
  const cur = xp - base, need = next - base;
  return { level, cur, need, pct: need > 0 ? Math.min(100, (cur / need) * 100) : 0 };
}

// ---------------------------------------------------------------------------
// State + persistence
// ---------------------------------------------------------------------------
function userId() { return (typeof window.effectiveUserId === 'function' && window.effectiveUserId()) || window._myUserId || localStorage.getItem('aq_user_id') || 'anon'; }
function skillsRef() { return ref(db, `user-skills/${userId()}`); }

let _xp = {};            // skillId -> xp (number)
let _saveTimer = null;
let _loaded = false;

function _readLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem('aq_skills') || '{}');
    const out = {};
    for (const s of SKILLS) out[s.id] = Math.max(0, (raw[s.id] | 0) || 0);
    return out;
  } catch { return Object.fromEntries(SKILLS.map(s => [s.id, 0])); }
}
function _writeLocal() {
  try { localStorage.setItem('aq_skills', JSON.stringify(_xp)); } catch {}
}
function _saveRemote() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    set(skillsRef(), { xp: _xp, updatedAt: Date.now() }).catch(() => {});
  }, 800);
}

async function loadSkills() {
  _xp = _readLocal();
  try {
    const snap = await get(skillsRef());
    if (snap.exists()) {
      const v = snap.val() || {};
      const remote = v.xp || {};
      // Merge: take the max per skill so we never lose progress on either side.
      let changed = false;
      for (const s of SKILLS) {
        const r = Math.max(0, (remote[s.id] | 0) || 0);
        if (r > (_xp[s.id] | 0)) { _xp[s.id] = r; changed = true; }
      }
      if (changed) { _writeLocal(); }
      // If local was ahead of remote, push it back up.
      _saveRemote();
    } else {
      _saveRemote();
    }
  } catch {}
  _loaded = true;
  if (_open) renderSkillsPanel();
}

// ---------------------------------------------------------------------------
// Public API (on window so inline games + modules can grant XP)
// ---------------------------------------------------------------------------
function addXp(skillId, amount) {
  if (!SKILL_BY_ID[skillId]) return;
  amount = Math.round(amount);
  if (!isFinite(amount) || amount <= 0) return;
  const before = levelForXp(_xp[skillId] | 0);
  _xp[skillId] = Math.min(xpForLevel(MAX_LEVEL), (_xp[skillId] | 0) + amount);
  const after = levelForXp(_xp[skillId]);
  _writeLocal();
  _saveRemote();
  if (after > before && typeof window.toast === 'function') {
    const s = SKILL_BY_ID[skillId];
    window.toast(`${s.icon} ${s.name} level ${after}!`);
  }
  if (_open) renderSkillsPanel();
}

// Single call games use: grants a "played" amount + a "won" bonus. `mult`
// optionally scales the whole grant (e.g. by score). Tuned so low levels move
// but the OSRS curve keeps 99 a long grind.
const PLAYED_XP = 8;   // base for showing up
const WON_XP = 30;     // base bonus for a win
function gameXp(skillId, opts) {
  opts = opts || {};
  const mult = opts.mult != null && isFinite(opts.mult) ? Math.max(0, opts.mult) : 1;
  let amt = 0;
  if (opts.played !== false) amt += PLAYED_XP;
  if (opts.won) amt += WON_XP;
  amt = Math.round(amt * mult);
  if (amt > 0) addXp(skillId, amt);
}

function getSkills() {
  const out = {};
  for (const s of SKILLS) { const xp = _xp[s.id] | 0; out[s.id] = { xp, level: levelForXp(xp) }; }
  return out;
}
function skillLevel(id) { return levelForXp(_xp[id] | 0); }

// ---------------------------------------------------------------------------
// Stats page UI
// ---------------------------------------------------------------------------
let _open = false;

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function renderSkillsPanel() {
  const area = document.getElementById('stats-area');
  if (!area) return;
  area.innerHTML = '';

  const name = (localStorage.getItem('aq_username') || '').trim() || 'Anonymous';
  const skills = getSkills();
  const total = SKILLS.reduce((a, s) => a + skills[s.id].level, 0);

  const head = el('div', 'sk-head');
  head.appendChild(el('div', 'sk-heart', '❤'));
  const ident = el('div', 'sk-ident');
  ident.appendChild(el('div', 'sk-name', esc(name)));
  ident.appendChild(el('div', 'sk-total', `Total level <b>${total}</b> / ${SKILLS.length * MAX_LEVEL}`));
  head.appendChild(ident);
  area.appendChild(head);

  const grid = el('div', 'sk-grid');
  for (const s of SKILLS) {
    const xp = skills[s.id].xp;
    const p = levelProgress(xp);
    const card = el('div', 'sk-card');
    const top = el('div', 'sk-card-top');
    top.appendChild(el('span', 'sk-icon', s.icon));
    const meta = el('div', 'sk-meta');
    meta.appendChild(el('div', 'sk-sname', esc(s.name)));
    meta.appendChild(el('div', 'sk-blurb', esc(s.blurb)));
    top.appendChild(meta);
    top.appendChild(el('div', 'sk-lvl', `<b>${p.level}</b><span>/${MAX_LEVEL}</span>`));
    card.appendChild(top);

    const bar = el('div', 'sk-bar');
    const fill = el('div', 'sk-bar-fill');
    fill.style.width = (p.level >= MAX_LEVEL ? 100 : p.pct) + '%';
    bar.appendChild(fill);
    card.appendChild(bar);

    card.appendChild(el('div', 'sk-xp', p.level >= MAX_LEVEL
      ? `${xp.toLocaleString()} XP · MAX`
      : `${p.cur.toLocaleString()} / ${p.need.toLocaleString()} XP to ${p.level + 1}`));
    grid.appendChild(card);
  }
  area.appendChild(grid);
}

function openStats(show = true) {
  const w = document.getElementById('stats-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; return; }
  w.classList.add('open'); w.style.display = 'flex';
  _open = true;
  if (window.OS && window.OS.register) { window.OS.register('stats'); window.OS.focus('stats'); }
  if (!_loaded) loadSkills();
  renderSkillsPanel();
}

// ---------------------------------------------------------------------------
// Wire up globals + boot
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.aqAddXp = addXp;
  window.aqGameXp = gameXp;
  window.aqGetSkills = getSkills;
  window.aqSkillLevel = skillLevel;
  window.openStats = openStats;
  window._aqStatsClosed = () => { _open = false; };
  // Load early so XP grants during the session persist + sync.
  loadSkills();
}
