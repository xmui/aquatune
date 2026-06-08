// Aquatune Skills — a RuneScape-flavored stats system.
//
// Each "skill" is an XP pool that levels 1..100 on the classic OSRS curve. XP is
// granted by games via the global helpers (window.aqGameXp / window.aqAddXp), so
// adding a new skill is as simple as appending to SKILLS below and granting XP
// from wherever makes sense. State is cached in localStorage and synced per-user
// to Firebase (mirroring the stocks/portfolio pattern) so stats follow an account
// across devices.

import { ref, get, set, update, query, orderByChild, equalTo } from 'firebase/database';
import { db } from './firebase.js';

// ---------------------------------------------------------------------------
// Skill registry — append here to add more skills later.
// ---------------------------------------------------------------------------
const SKILLS = [
  { id: 'fishing',  name: 'Fishing',   icon: '🎣', color: '#39b7ff', blurb: 'Reel them in' },
  { id: 'mining',   name: 'Mining',    icon: '⛏️', color: '#d59a4a', blurb: 'Crack the rocks' },
  { id: 'gambling', name: 'Gambling',  icon: '🎲', color: '#ff5a6a', blurb: 'Slots, Blackjack & Hold’em' },
  { id: 'intellect',name: 'Intellect', icon: '🧠', color: '#b07cff', blurb: 'Picross, Mines & Solitaire' },
  { id: 'speed',    name: 'Speed',     icon: '⚡', color: '#ffe14d', blurb: 'Beat Tap & Tetris' },
  { id: 'music',    name: 'Music',     icon: '🎵', color: '#ff6bd6', blurb: 'Watching & making music' },
  { id: 'finance',  name: 'Finance',   icon: '💹', color: '#46d07a', blurb: 'Earning & trading' },
  { id: 'combat',   name: 'Combat',    icon: '⚔️', color: '#ff7a3a', blurb: 'Buddy Shoot' },
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
// Admin level-sets land here (separate from the user-skills node, which _saveRemote
// fully overwrites). Each is { xp, ts }; the client applies it once, authoritatively
// (so an admin can LOWER a level, not just raise it), keyed by a per-skill ts marker.
function overridesRef() { return ref(db, `user-skill-overrides/${userId()}`); }
function _applyOverrides(overrides) {
  let changed = false;
  for (const s of SKILLS) {
    const ov = overrides && overrides[s.id];
    if (!ov || typeof ov.xp !== 'number' || !ov.ts) continue;
    const key = 'aq_skill_ovr_' + s.id;
    const lastTs = +(localStorage.getItem(key) || 0);
    if (ov.ts > lastTs) {
      _xp[s.id] = Math.max(0, ov.xp | 0);   // authoritative — overrides the max-merge
      try { localStorage.setItem(key, String(ov.ts)); } catch {}
      changed = true;
    }
  }
  return changed;
}
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
    // update() (not set()) so a sibling `banned` flag written by the ban flow isn't
    // wiped when the user's own client next saves.
    update(skillsRef(), { xp: _xp, name, credits, updatedAt: Date.now() }).catch(() => {});
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
    // Authoritative admin level-sets (applied once, can raise OR lower).
    try {
      const ovSnap = await get(overridesRef());
      if (ovSnap.exists() && _applyOverrides(ovSnap.val() || {})) { _writeLocal(); _saveRemote(); }
    } catch {}
  } catch {}
  applyResets();
  _loaded = true;
  if (_open) renderSkillsPanel();
  try { updateHud(); } catch {}
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
// Anti-cheat: flag implausibly fast XP and auto-ban
// ---------------------------------------------------------------------------
// The curve is quadratic FROM ZERO, so "5 levels" is cheap early (L1→L5 = 240 XP)
// and a fair new player blows through it in minutes — a raw level delta would
// false-positive them. Instead we cap the XP RATE. Fair play tops out at a few
// hundred XP/min for one skill (music ~20/min passive; the densest games grant tens
// per action, rarely ×lucky). These ceilings sit ~10× above that, so a real player
// never trips them, but an exploit or console-injected dump of thousands does. A
// trip auto-(site-)bans the account.
const _xpLog = [];                       // { ts, skill, amt } within the last RATE_LONG
const RATE_SHORT = 60 * 1000, RATE_LONG = 5 * 60 * 1000;
const SHORT_SKILL = 3500, LONG_SKILL = 9000;    // per-skill ceilings (1 min / 5 min)
const SHORT_TOTAL = 6000, LONG_TOTAL = 15000;   // all-skills ceilings (1 min / 5 min)
let _cheatFlagged = false;
function _antiCheat(skillId, amount) {
  const now = Date.now();
  _xpLog.push({ ts: now, skill: skillId, amt: amount });
  while (_xpLog.length && now - _xpLog[0].ts > RATE_LONG) _xpLog.shift();
  if (_cheatFlagged) return;
  let sShort = 0, sLong = 0, tShort = 0, tLong = 0;
  for (const e of _xpLog) {
    const recent = now - e.ts <= RATE_SHORT;
    tLong += e.amt; if (recent) tShort += e.amt;
    if (e.skill === skillId) { sLong += e.amt; if (recent) sShort += e.amt; }
  }
  const name = SKILL_BY_ID[skillId] ? SKILL_BY_ID[skillId].name : skillId;
  let reason = '';
  if (sShort > SHORT_SKILL) reason = `${name} +${sShort} XP in under a minute`;
  else if (sLong > LONG_SKILL) reason = `${name} +${sLong} XP in 5 minutes`;
  else if (tShort > SHORT_TOTAL) reason = `+${tShort} XP across skills in under a minute`;
  else if (tLong > LONG_TOTAL) reason = `+${tLong} XP across skills in 5 minutes`;
  if (reason) {
    _cheatFlagged = true;
    if (typeof window.aqAutoBan === 'function') window.aqAutoBan('Auto-banned for an impossible XP rate (' + reason + ').');
  }
}

// ---------------------------------------------------------------------------
// Public API (on window so inline games + modules can grant XP)
// ---------------------------------------------------------------------------
// Global down-scale on every XP grant. Leveling was far too fast (a level per game,
// combat worst), so all grants — both gameXp() and raw aqAddXp() — are multiplied by
// this single factor, making the climb ~2.5× grindier without touching the curve or
// any per-game formula. Music is exempt (it's already the slow, intentional outlier).
const XP_SCALE = 0.4;
function addXp(skillId, amount) {
  if (!hasAccount()) return;   // no account → no XP
  if (!SKILL_BY_ID[skillId]) return;
  amount = Math.round(amount);
  if (!isFinite(amount) || amount <= 0) return;
  if (skillId !== 'music') amount = Math.max(1, Math.round(amount * XP_SCALE));   // grindier; keep ≥1 so the popup still shows
  const before = levelForXp(_xp[skillId] | 0);
  _xp[skillId] = Math.min(xpForLevel(MAX_LEVEL), (_xp[skillId] | 0) + amount);
  const after = levelForXp(_xp[skillId]);
  _writeLocal();
  _saveRemote();
  _antiCheat(skillId, amount);   // flag + auto-ban implausibly fast XP
  // Always pop: a "+N XP" chip on every gain, plus a level-up chip when it ticks.
  showXpPopup(skillId, amount, after > before ? after : 0);
  refreshHudFills();
  // Feed daily challenges that track XP gained (skill-specific + any-skill).
  if (typeof window.aqDailyProgress === 'function') window.aqDailyProgress('xp', amount, skillId);
  if (_open) renderSkillsPanel();
}

// Two visual styles: the default big skill-colored "+N XP 🎣" rising from the
// bottom-right, or the original boxed toast (opt-in via Settings → 'aq_xp_classic').
function xpClassic() { try { return localStorage.getItem('aq_xp_classic') === '1'; } catch { return false; } }
// Floating popup chips for XP gains / level-ups (always shown).
const _xpAgg = {};   // skillId -> { chip, total, expire } — coalesces rapid same-skill gains into one chip
function showXpPopup(skillId, amount, leveledTo) {
  if (typeof document === 'undefined') return;
  const s = SKILL_BY_ID[skillId]; if (!s) return;
  let host = document.getElementById('aq-xp-popups');
  if (!host) { host = document.createElement('div'); host.id = 'aq-xp-popups'; document.body.appendChild(host); }
  const classic = xpClassic();
  host.classList.toggle('classic', classic);
  const life = classic ? 1750 : 3200;
  const COALESCE_MS = 750;     // gains for the same skill within this window merge into the live chip
  const numHtml = (total) => {
    const n = '+' + Math.round(total).toLocaleString() + ' XP';
    return classic ? `${n} <span>${s.icon} ${esc(s.name)}</span>` : `<span class="aq-xp-ico">${s.icon}</span>${n}`;
  };
  const place = (chip, cls) => {
    chip.className = 'aq-xp-pop' + (cls ? ' ' + cls : '');
    if (!classic) {
      if (!cls) chip.style.color = s.color || '#7fd4ff';   // number tinted to the skill (glow follows via currentColor)
      // ladder each new chip above the ones already floating so they never overlap,
      // then let them flutter (small amplitude) while staying anchored to the right edge.
      const stack = host.children.length;
      chip.style.right = (18 + Math.random() * 14) + 'px';   // tight right-side column
      chip.style.bottom = (80 + stack * 32 + Math.random() * 14) + 'px';
      chip.style.setProperty('--sway', ((Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 7)) + 'px');
    }
  };
  // number chip — coalesce a burst of same-skill grants (e.g. mining grants XP twice per dig) into one
  const now = Date.now(), agg = _xpAgg[skillId];
  if (agg && agg.chip.isConnected && now < agg.expire) {
    agg.total += amount; agg.expire = now + COALESCE_MS;
    agg.chip.innerHTML = numHtml(agg.total);
  } else {
    const chip = document.createElement('div');
    place(chip, ''); chip.innerHTML = numHtml(amount); host.appendChild(chip);
    const rec = { chip, total: amount, expire: now + COALESCE_MS };
    _xpAgg[skillId] = rec;
    setTimeout(() => { chip.remove(); if (_xpAgg[skillId] === rec) delete _xpAgg[skillId]; }, life);
  }
  // level-up chip — always its own (a milestone, never coalesced)
  if (leveledTo) {
    const chip = document.createElement('div');
    place(chip, 'lvl');
    chip.innerHTML = classic ? `${s.icon} ${esc(s.name)} — Level ${leveledTo}!` : `<span class="aq-xp-ico">${s.icon}</span>Level ${leveledTo}!`;
    host.appendChild(chip);
    setTimeout(() => chip.remove(), life);
  }
  // hard-cap the stack so chips never pile up / overlap
  while (host.children.length > 6) host.firstChild.remove();
}

// ---------------------------------------------------------------------------
// Opt-in OSRS-style HUD — tiny level bars pinned to the bottom of the screen,
// showing only the skills tied to the game you're currently looking at.
// ---------------------------------------------------------------------------
const GAME_SKILLS = {
  slots: ['gambling'], blackjack: ['gambling'], holdem: ['gambling'],
  picross: ['intellect'], mines: ['intellect'], solitaire: ['intellect'], pool: ['intellect'],
  tetris: ['speed'], rhythm: ['speed'],
  fishing: ['fishing'], mining: ['mining'],
  buddyshoot: ['combat'], rogue: ['combat'], tanks: ['combat'], airhockey: ['speed'],
  stocks: ['finance'], player: ['music'], studio: ['music'], synth: ['music'],
};
function hudEnabled() { try { return localStorage.getItem('aq_hud_on') === '1'; } catch { return false; } }
function setHud(on) {
  try { localStorage.setItem('aq_hud_on', on ? '1' : '0'); } catch {}
  updateHud();
}
let _hudSkills = [];   // skill ids currently shown (so XP gains can refresh fills)
function updateHud(forId) {
  if (typeof document === 'undefined') return;
  let hud = document.getElementById('aq-skill-hud');
  const id = forId || (window.OS && window.OS._activeId);
  const ids = (hudEnabled() && hasAccount() && id && GAME_SKILLS[id]) ? GAME_SKILLS[id] : [];
  _hudSkills = ids;
  if (!ids.length) { if (hud) hud.classList.remove('on'); return; }
  if (!hud) { hud = document.createElement('div'); hud.id = 'aq-skill-hud'; document.body.appendChild(hud); }
  hud.innerHTML = '';
  for (const sid of ids) {
    const s = SKILL_BY_ID[sid]; if (!s) continue;
    const p = levelProgress(_xp[sid] | 0);
    const pill = el('div', 'aq-hud-pill');
    pill.appendChild(el('span', 'aq-hud-ico', s.icon));
    pill.appendChild(el('span', 'aq-hud-lvl', String(p.level)));
    const bar = el('div', 'aq-hud-bar');
    const fill = el('div', 'aq-hud-fill'); fill.style.width = (p.level >= MAX_LEVEL ? 100 : p.pct) + '%';
    fill.dataset.skill = sid; bar.appendChild(fill); pill.appendChild(bar);
    hud.appendChild(pill);
  }
  hud.classList.add('on');
}
// Cheap refresh of just the bar fills (called on every XP gain so the HUD fills live).
function refreshHudFills() {
  if (!_hudSkills.length) return;
  const hud = document.getElementById('aq-skill-hud'); if (!hud || !hud.classList.contains('on')) return;
  hud.querySelectorAll('.aq-hud-fill').forEach(fill => {
    const sid = fill.dataset.skill; if (!sid) return;
    const p = levelProgress(_xp[sid] | 0);
    fill.style.width = (p.level >= MAX_LEVEL ? 100 : p.pct) + '%';
    const lvlEl = fill.closest('.aq-hud-pill')?.querySelector('.aq-hud-lvl');
    if (lvlEl) lvlEl.textContent = String(p.level);
  });
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
    // Daily streak + challenges (rendered by daily.js if loaded).
    if (typeof window.aqRenderDailyInto === 'function') { try { window.aqRenderDailyInto(area); } catch {} }
    area.appendChild(skillGrid(_xp));
    // Opt-in on-screen HUD toggle.
    const hudRow = el('label', 'sk-hud-toggle');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = hudEnabled();
    cb.onchange = () => setHud(cb.checked);
    hudRow.appendChild(cb); hudRow.appendChild(el('span', null, 'Show skill HUD on screen while playing'));
    area.appendChild(hudRow);
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
    // Authoritative ban list: pull the accounts whose siteBanned === true (returns
    // only banned accounts, so the payload stays small) and skip them — this catches
    // users banned BEFORE the per-skills `banned` flag existed, not just new ones.
    Promise.all([
      get(ref(db, 'user-skills')),
      get(query(ref(db, 'accounts'), orderByChild('siteBanned'), equalTo(true))).catch(() => null),
    ]).then(([snap, banSnap]) => {
      const banned = new Set();
      if (banSnap && banSnap.exists()) for (const id of Object.keys(banSnap.val() || {})) banned.add(id);
      const v = snap.exists() ? snap.val() : {};
      const arr = [];
      for (const uid of Object.keys(v || {})) {
        const node = v[uid]; if (!node || typeof node !== 'object') continue;
        if (node.banned || banned.has(uid)) continue;   // site-banned users don't appear in rankings
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
  window.aqSkillList = SKILLS.map(s => ({ id: s.id, name: s.name, icon: s.icon }));   // for admin dropdowns
  // Admin: force-set one of the CURRENT user's skills to a level (used when an admin
  // edits their own account so the change shows live, including lowering a skill).
  window.aqForceOwnSkill = (skillId, level, ts) => {
    if (!SKILL_BY_ID[skillId]) return false;
    level = Math.max(1, Math.min(MAX_LEVEL, Math.round(Number(level)) || 1));
    _xp[skillId] = xpForLevel(level);
    // Record the override marker so this same set isn't re-applied on our next load
    // (which would otherwise clobber XP earned afterwards).
    if (ts) { try { localStorage.setItem('aq_skill_ovr_' + skillId, String(ts)); } catch {} }
    _writeLocal();
    _saveRemote();
    if (_open) renderSkillsPanel();
    return true;
  };
  window.openStats = openStats;
  window._aqStatsClosed = () => { _open = false; };
  window.aqHudEnabled = hudEnabled;
  window.aqHudToggle = setHud;
  window.aqRefreshStats = () => { if (_open) renderSkillsPanel(); };
  // XP popup style toggle (Settings). 'classic' = the original boxed toast.
  window.aqSetXpStyle = (style) => { try { localStorage.setItem('aq_xp_classic', style === 'classic' ? '1' : '0'); } catch {} };
  const _xpcb = document.getElementById('xp-classic-chk'); if (_xpcb) _xpcb.checked = xpClassic();
  // Mirror the OSRS-style HUD to whatever game window is focused / closed.
  if (window.OS && typeof window.OS.focus === 'function') {
    const _focus = window.OS.focus.bind(window.OS);
    window.OS.focus = (id) => { _focus(id); try { updateHud(id); } catch {} };
  }
  if (window.OS && typeof window.OS.close === 'function') {
    const _close = window.OS.close.bind(window.OS);
    // Closing a tracked game hides the HUD (focus doesn't auto-move to another
    // window); '__none__' has no GAME_SKILLS entry, so updateHud just hides it.
    window.OS.close = (id) => { _close(id); try { if (GAME_SKILLS[id]) updateHud('__none__'); } catch {} };
  }
  // Some games (Slots, Blackjack, …) open via direct calls that bypass OS.focus, so
  // the focus hook above never fires. Catch interaction with ANY game window and map
  // it back to its skill, so the HUD always tracks the game you're actually using.
  const WIN_TO_ID = { 'win-player': 'player', 'studio-win': 'studio', 'synth-flyout': 'synth' };
  document.addEventListener('pointerdown', (e) => {
    if (!hudEnabled() || !hasAccount() || !e.target || !e.target.closest) return;
    const wrap = e.target.closest('[id$="-wrap"], #win-player, #studio-win, #synth-flyout');
    if (!wrap) return;
    const id = WIN_TO_ID[wrap.id] || wrap.id.replace(/-wrap$/, '');
    if (GAME_SKILLS[id]) updateHud(id);
  }, true);
  hookEarnXp();
  // Load early so XP grants during the session persist + sync.
  loadSkills();
}
