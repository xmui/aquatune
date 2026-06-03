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
// XP curve. xpForLevel(L) = cumulative XP needed to *reach* L. A STEADY
// quadratic grind (cost per level grows linearly) rather than OSRS's hyper
// front-loaded exponential — so early levels aren't free and the climb to 100
// is a consistent grind of tens of hours. Combined with the small XP rates
// below: ~30–70h to max a skill, and a handful of actions only nets a level or
// two (not a dozen). Tune GROWTH (and the rates) together.
// ---------------------------------------------------------------------------
const GROWTH = 15;  // xp(L) = GROWTH*(L-1)^2  ⇒ L100 ≈ 147k XP
const _xpTable = (() => {
  const t = [0, 0];
  for (let lvl = 2; lvl <= MAX_LEVEL; lvl++) t[lvl] = Math.round(GROWTH * (lvl - 1) * (lvl - 1));
  return t;
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
  applyResets();
  _loaded = true;
  if (_open) renderSkillsPanel();
}

// One-time, per-user data resets. The XP economy was badly over-tuned (huge
// per-action XP on a front-loaded curve → instant levels), so wipe ALL skills
// once for the rebalanced curve + rates. Bump the flag key to run a future reset.
function applyResets() {
  try {
    if (!localStorage.getItem('aq_skills_reset_all_v2')) {
      localStorage.setItem('aq_skills_reset_all_v2', '1');
      for (const s of SKILLS) _xp[s.id] = 0;
      _writeLocal();
      _saveRemote();
    }
  } catch {}
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
  // Always pop: a "+N XP" chip on every gain, plus a level-up chip when it ticks.
  showXpPopup(skillId, amount, after > before ? after : 0);
  if (_open) renderSkillsPanel();
}

// Floating popup chips for XP gains / level-ups (always shown).
function showXpPopup(skillId, amount, leveledTo) {
  if (typeof document === 'undefined') return;
  const s = SKILL_BY_ID[skillId]; if (!s) return;
  let host = document.getElementById('aq-xp-popups');
  if (!host) { host = document.createElement('div'); host.id = 'aq-xp-popups'; document.body.appendChild(host); }
  const add = (html, cls) => {
    const chip = document.createElement('div');
    chip.className = 'aq-xp-pop' + (cls ? ' ' + cls : '');
    chip.innerHTML = html;
    host.appendChild(chip);
    setTimeout(() => chip.remove(), 1750);
  };
  add(`+${Math.round(amount).toLocaleString()} XP <span>${s.icon} ${esc(s.name)}</span>`);
  if (leveledTo) add(`${s.icon} ${esc(s.name)} — Level ${leveledTo}!`, 'lvl');
  while (host.children.length > 7) host.firstChild.remove();
}

// Single call games use: grants a "played" amount + a "won" bonus. `mult`
// optionally scales the whole grant (e.g. by score / difficulty). Tuned so the
// system stays GRINDY but reachable: against the authentic OSRS curve (~14.4M XP
// to level 100), these rates put maxing a single skill at roughly 20–40 hours of
// engaged play (≈one grant every 12–20s). The rare LUCKY bonus adds variance.
const PLAYED_XP = 2;   // base for showing up
const WON_XP = 8;      // base bonus for a win
const LUCKY_CHANCE = 0.05;  // ~1 in 20 grants rolls a jackpot multiplier
function gameXp(skillId, opts) {
  opts = opts || {};
  const mult = opts.mult != null && isFinite(opts.mult) ? Math.max(0, opts.mult) : 1;
  let amt = 0;
  if (opts.played !== false) amt += PLAYED_XP;
  if (opts.won) amt += WON_XP;
  amt = Math.round(amt * mult);
  if (amt <= 0) return;
  // Rare random bonus: a big multiplier that makes the grind feel alive.
  if (Math.random() < LUCKY_CHANCE) {
    amt *= 3 + Math.floor(Math.random() * 6); // x3..x8
    if (typeof window.toast === 'function') window.toast(`🍀 Lucky ${SKILL_BY_ID[skillId].name}! +${amt} XP`);
  }
  addXp(skillId, amt);
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
