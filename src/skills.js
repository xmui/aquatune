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
  { id: 'music',    name: 'Music',     icon: '🎵', blurb: 'Watching & making music' },
  { id: 'finance',  name: 'Finance',   icon: '💹', blurb: 'Earning & trading' },
  { id: 'combat',   name: 'Combat',    icon: '⚔️', blurb: 'Buddy Shoot' },
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
// You must be logged into an account to earn XP / have skills (and to appear on
// the leaderboard). Anonymous play still works — it just doesn't accrue skills.
function hasAccount() { return typeof window !== 'undefined' && !!window._aqAccountId; }

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
  if (!hasAccount()) return;   // don't write skills for anonymous users
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    const name = (localStorage.getItem('aq_username') || '').trim() || 'Anonymous';
    const credits = (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0;
    // Store credits alongside skills so rankings can show how rich a player is.
    set(skillsRef(), { xp: _xp, name, credits, updatedAt: Date.now() }).catch(() => {});
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
    // Music was earned too fast (50 xp/min → ~50h to max); the rate is now
    // 20/min (~120h to max). Rescale existing music XP by 20/50 so each user's
    // music level reflects their actual listening time under the new rate.
    if (!localStorage.getItem('aq_skills_music_rescale_v1')) {
      localStorage.setItem('aq_skills_music_rescale_v1', '1');
      _xp.music = Math.round((_xp.music | 0) * 0.4);
      _writeLocal();
      _saveRemote();
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Public API (on window so inline games + modules can grant XP)
// ---------------------------------------------------------------------------
function addXp(skillId, amount) {
  if (!hasAccount()) return;   // no account → no XP
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
  if (!hasAccount()) return;   // no account → no XP
  opts = opts || {};
  const mult = opts.mult != null && isFinite(opts.mult) ? Math.max(0, opts.mult) : 1;
  let amt = 0;
  if (opts.played !== false) amt += PLAYED_XP;
  if (opts.won) amt += WON_XP;
  amt = Math.round(amt * mult);
  if (amt <= 0) return;
  // Rare random bonus: a big multiplier that makes the grind feel alive. `luck`
  // (default 1) scales how often/how big it is — gambling passes a small value so
  // its lucky bonus is rarer and gentler than skills you actually grind.
  const luck = opts.luck != null && isFinite(opts.luck) ? Math.max(0, opts.luck) : 1;
  if (Math.random() < LUCKY_CHANCE * luck) {
    amt *= luck < 1 ? (2 + Math.floor(Math.random() * 2)) : (3 + Math.floor(Math.random() * 6));
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

let _statsTab = 'me';     // 'me' | 'rank'
let _rankData = null;     // cached [{uid, name, xp, total}]
let _rankBusy = false;
let _rankQuery = '';
let _rankDetail = null;   // a selected entry to show in detail

// header: name + heart + total level
function statsHeader(name, total) {
  const head = el('div', 'sk-head');
  head.appendChild(el('div', 'sk-heart', '❤'));
  const ident = el('div', 'sk-ident');
  ident.appendChild(el('div', 'sk-name', esc(name)));
  ident.appendChild(el('div', 'sk-total', `Total level <b>${total}</b> / ${SKILLS.length * MAX_LEVEL}`));
  head.appendChild(ident);
  return head;
}
// the per-skill card grid for any xp map
function skillGrid(xpMap) {
  const grid = el('div', 'sk-grid');
  for (const s of SKILLS) {
    const xp = (xpMap && xpMap[s.id]) | 0;
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
  return grid;
}
function totalLevelOf(xpMap) { return SKILLS.reduce((a, s) => a + levelForXp((xpMap && xpMap[s.id]) | 0), 0); }

function renderSkillsPanel() {
  const area = document.getElementById('stats-area');
  if (!area) return;
  area.innerHTML = '';
  // tab bar
  const tabs = el('div', 'sk-tabs');
  const mk = (id, label) => { const b = el('button', 'sk-tab' + (_statsTab === id ? ' on' : ''), label); b.onclick = () => { _statsTab = id; _rankDetail = null; renderSkillsPanel(); }; return b; };
  tabs.append(mk('me', 'My Skills'), mk('rank', 'Rankings'));
  area.appendChild(tabs);
  area.appendChild(el('div', 'sk-wip', '🚧 Work in progress'));

  if (_statsTab === 'me') {
    if (!hasAccount()) {
      const note = el('div', 'sk-login-note');
      note.innerHTML = '🔒 <b>Create an account to earn skills.</b><br>Anonymous play still works, but XP, skill levels and the leaderboard need an account.';
      area.appendChild(note);
      const btn = el('button', 'sk-tab on', 'Open account settings');
      btn.style.alignSelf = 'flex-start';
      btn.onclick = () => { try { window.OS ? window.OS.open('settings') : window.toggleThemePanel?.(); } catch {} };
      area.appendChild(btn);
      return;
    }
    const name = (localStorage.getItem('aq_username') || '').trim() || 'Anonymous';
    area.appendChild(statsHeader(name, totalLevelOf(_xp)));
    const credits = (typeof window.aqGetCredits === 'function' && window.aqGetCredits()) || 0;
    const credLine = el('div', 'sk-credits', 'Credits ');
    // `.aq-credits-display` makes aqRefreshCreditDisplays() keep this live.
    credLine.appendChild(el('span', 'aq-credits-display sk-credits-val', `💰 ${credits.toLocaleString()}`));
    area.appendChild(credLine);
    area.appendChild(skillGrid(_xp));
  } else {
    renderRankings(area);
  }
}

function renderRankings(area) {
  // detail view for a selected user
  if (_rankDetail) {
    const back = el('button', 'sk-back', '← Rankings');
    back.onclick = () => { _rankDetail = null; renderSkillsPanel(); };
    area.appendChild(back);
    area.appendChild(statsHeader(_rankDetail.name, _rankDetail.total));
    const credLine = el('div', 'sk-credits', 'Credits ');
    const credVal = el('span', 'sk-credits-val', `💰 ${(_rankDetail.credits | 0).toLocaleString()}`);
    credLine.appendChild(credVal);
    area.appendChild(credLine);
    area.appendChild(skillGrid(_rankDetail.xp));
    // The synced skills node only carries credits after the user's next XP save, so
    // older entries read 0. Fetch the live balance straight from their account node.
    get(ref(db, `accounts/${_rankDetail.uid}/credits`)).then(snap => {
      if (snap.exists()) {
        const c = snap.val() | 0;
        _rankDetail.credits = c;
        credVal.textContent = `💰 ${c.toLocaleString()}`;
      }
    }).catch(() => {});
    return;
  }
  // search box
  const search = el('input', 'sk-search'); search.type = 'text';
  search.placeholder = 'Search username…'; search.value = _rankQuery;
  search.oninput = () => { _rankQuery = search.value; paintList(); };
  area.appendChild(search);

  const list = el('div', 'sk-ranklist'); area.appendChild(list);
  const me = userId();

  function paintList() {
    list.innerHTML = '';
    if (_rankBusy) { list.appendChild(el('div', 'sk-rank-note', 'Loading rankings…')); return; }
    if (!_rankData) { list.appendChild(el('div', 'sk-rank-note', 'No data yet.')); return; }
    const q = _rankQuery.trim().toLowerCase();
    const rows = _rankData.filter(r => !q || r.name.toLowerCase().includes(q)).slice(0, 50);
    if (!rows.length) { list.appendChild(el('div', 'sk-rank-note', 'No players found.')); return; }
    rows.forEach((r) => {
      const row = el('div', 'sk-rank-row' + (r.uid === me ? ' me' : ''));
      row.appendChild(el('span', 'sk-rank-pos', '#' + (r.rank)));
      row.appendChild(el('span', 'sk-rank-name', esc(r.name)));
      row.appendChild(el('span', 'sk-rank-lvl', String(r.total)));
      row.onclick = () => { _rankDetail = r; renderSkillsPanel(); };
      list.appendChild(row);
    });
  }
  paintList();

  // fetch once (cached); refresh on each Rankings open is fine
  if (!_rankData && !_rankBusy) {
    _rankBusy = true;
    get(ref(db, 'user-skills')).then(snap => {
      const v = snap.exists() ? snap.val() : {};
      const arr = [];
      for (const uid of Object.keys(v || {})) {
        const node = v[uid]; if (!node || typeof node !== 'object') continue;
        const name = (node.name || '').trim();
        // Skip anonymous / nameless entries — only real accounts show in global stats.
        if (!name || name.toLowerCase() === 'anonymous') continue;
        const xp = node.xp || {};
        arr.push({ uid, name, xp, credits: node.credits | 0, total: totalLevelOf(xp) });
      }
      arr.sort((a, b) => b.total - a.total);
      arr.forEach((r, i) => r.rank = i + 1);
      _rankData = arr;
    }).catch(() => { _rankData = []; }).finally(() => { _rankBusy = false; paintList(); });
  }
}

function openStats(show = true) {
  const w = document.getElementById('stats-wrap');
  if (!w) return;
  if (show === false) { w.classList.remove('open'); w.style.display = 'none'; return; }
  w.classList.add('open'); w.style.display = 'flex';
  _open = true;
  _rankData = null; _rankDetail = null;   // refresh rankings each open
  if (window.OS && window.OS.register) { window.OS.register('stats'); window.OS.focus('stats'); }
  if (!_loaded) loadSkills();
  renderSkillsPanel();
}

// ---------------------------------------------------------------------------
// Wire up globals + boot
// Earning money grants a little Finance XP. Wrap aqAddCredits (the "earn" path —
// spending and remote-sync go through aqSetCredits, so they don't trigger this,
// and stock sells keep their own grant). Small + capped to limit farming.
function hookEarnXp() {
  if (typeof window === 'undefined' || window._aqEarnXpHooked || typeof window.aqAddCredits !== 'function') return;
  window._aqEarnXpHooked = true;
  const orig = window.aqAddCredits;
  window.aqAddCredits = function (n) {
    orig(n);
    if (typeof n === 'number' && n > 0) addXp('finance', Math.max(1, Math.min(6, Math.round(n / 50))));
  };
}

// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.aqAddXp = addXp;
  window.aqGameXp = gameXp;
  window.aqGetSkills = getSkills;
  window.aqSkillLevel = skillLevel;
  window.aqXpForLevel = xpForLevel;   // admin tools compute XP for a target level
  window.openStats = openStats;
  window._aqStatsClosed = () => { _open = false; };
  hookEarnXp();
  // Load early so XP grants during the session persist + sync.
  loadSkills();
}
