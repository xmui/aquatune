// Aquatune dailies — a login-streak credit bonus + a rotating set of daily
// challenges. Both give players a reason to come back each day.
//
// • Login streak: granted automatically on the first visit of a new calendar day.
//   Enforced on the ACCOUNT via a Firebase transaction (like aqTryClaimDaily) so it
//   can't be farmed across devices; anonymous users fall back to localStorage.
//   Reward is CREDITS, scaling with the streak length.
// • Daily challenges: 3 tasks chosen by a DATE-SEEDED RNG, so everyone gets the
//   same set each day. Progress is fed by window.aqDailyProgress(type, value, meta)
//   from central hooks (XP gains, credits earned, games opened) — no per-game edits.
//   Completing one grants XP + credits. State lives in the BLOB key
//   'aq_daily_challenge' (synced via aqGamePersist), and is rendered into the Stats
//   window by window.aqRenderDailyInto(area).

import { ref, runTransaction } from 'firebase/database';
import { db } from './firebase.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(t) { if (typeof window.toast === 'function') window.toast(t); }
// Local-day index (so "yesterday" is a simple −1 regardless of timezone).
function dayNum(ts) { const off = new Date(ts).getTimezoneOffset() * 60000; return Math.floor((ts - off) / 86400000); }
function todayStr() { return new Date().toDateString(); }
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------------------
// Challenge pool. `kind` decides how aqDailyProgress events accumulate:
//   credits      → +value on a 'credits' event (credits earned)
//   xpAny        → +value on any 'xp' event
//   xpSkill      → +value on an 'xp' event whose skill === skill
//   openDistinct → +1 per distinct game id seen via an 'open' event
// Each grants `xp` (in xpSkill) + `credits` on completion. Rewards are small and
// one-shot, so they never approach the anti-cheat XP ceilings.
// ---------------------------------------------------------------------------
const POOL = [
  { id: 'earn500', kind: 'credits', goal: 500, label: 'Earn 500 credits', xpSkill: 'finance', xp: 40, credits: 70 },
  { id: 'earn1200', kind: 'credits', goal: 1200, label: 'Earn 1,200 credits', xpSkill: 'finance', xp: 70, credits: 130 },
  { id: 'xp300', kind: 'xpAny', goal: 300, label: 'Gain 300 XP across any skills', xpSkill: 'intellect', xp: 50, credits: 80 },
  { id: 'xp700', kind: 'xpAny', goal: 700, label: 'Gain 700 XP today', xpSkill: 'speed', xp: 90, credits: 130 },
  { id: 'open4', kind: 'openDistinct', goal: 4, label: 'Play 4 different games', xpSkill: 'speed', xp: 60, credits: 110 },
  { id: 'gamble150', kind: 'xpSkill', skill: 'gambling', goal: 150, label: 'Train Gambling (150 XP)', xpSkill: 'gambling', xp: 50, credits: 80 },
  { id: 'intellect150', kind: 'xpSkill', skill: 'intellect', goal: 150, label: 'Train Intellect (150 XP)', xpSkill: 'intellect', xp: 50, credits: 80 },
  { id: 'combat120', kind: 'xpSkill', skill: 'combat', goal: 120, label: 'Train Combat (120 XP)', xpSkill: 'combat', xp: 50, credits: 80 },
  { id: 'speed120', kind: 'xpSkill', skill: 'speed', goal: 120, label: 'Train Speed (120 XP)', xpSkill: 'speed', xp: 50, credits: 80 },
  { id: 'mining150', kind: 'xpSkill', skill: 'mining', goal: 150, label: 'Train Mining (150 XP)', xpSkill: 'mining', xp: 50, credits: 80 },
  { id: 'fishing120', kind: 'xpSkill', skill: 'fishing', goal: 120, label: 'Train Fishing (120 XP)', xpSkill: 'fishing', xp: 50, credits: 80 },
];
// Games that count toward "play N different games" / get an 'open' event.
const GAME_IDS = new Set(['slots', 'blackjack', 'holdem', 'picross', 'mines', 'solitaire', 'pool', 'tetris', 'rhythm', 'fishing', 'mining', 'buddyshoot', 'rogue', 'stocks']);

// ---------------------------------------------------------------------------
// Challenge state
// ---------------------------------------------------------------------------
let _state = null;   // { date, list:[{...,prog,done,seen?}] }

function pickDaily(dateStr) {
  const rnd = mulberry32(hashStr('aq-daily-' + dateStr));
  const idx = POOL.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, 3).map(i => {
    const t = POOL[i];
    return { id: t.id, kind: t.kind, skill: t.skill || null, goal: t.goal, label: t.label, xpSkill: t.xpSkill, xp: t.xp, credits: t.credits, prog: 0, done: false, seen: t.kind === 'openDistinct' ? [] : undefined };
  });
}
function loadState() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem('aq_daily_challenge') || 'null'); } catch {}
  const today = todayStr();
  if (!s || s.date !== today || !Array.isArray(s.list)) { s = { date: today, list: pickDaily(today) }; saveState(s); }
  _state = s;
  return s;
}
function saveState(s) {
  try { localStorage.setItem('aq_daily_challenge', JSON.stringify(s || _state)); } catch {}
  if (typeof window.aqGamePersist === 'function') window.aqGamePersist('aq_daily_challenge');
}
function ensureState() { if (!_state || _state.date !== todayStr()) loadState(); return _state; }

function progress(type, value, meta) {
  const s = ensureState(); if (!s) return;
  let changed = false, completed = null;
  for (const c of s.list) {
    if (c.done) continue;
    let add = 0;
    if (c.kind === 'credits' && type === 'credits') add = value;
    else if (c.kind === 'xpAny' && type === 'xp') add = value;
    else if (c.kind === 'xpSkill' && type === 'xp' && meta === c.skill) add = value;
    else if (c.kind === 'openDistinct' && type === 'open' && meta) {
      if (!c.seen) c.seen = [];
      if (!c.seen.includes(meta)) { c.seen.push(meta); add = 1; }
    }
    if (add <= 0) continue;
    c.prog = Math.min(c.goal, (c.prog || 0) + add);
    changed = true;
    if (c.prog >= c.goal && !c.done) { c.done = true; completed = c; }   // mark done BEFORE granting (no re-entry / double grant)
  }
  if (changed) saveState(s);
  if (completed) grantReward(completed);
}

function grantReward(c) {
  toast(`✅ Daily done: ${c.label} — +${c.xp} XP, +${c.credits}💰`);
  if (typeof window.aqAddCredits === 'function' && c.credits > 0) window.aqAddCredits(c.credits);
  if (typeof window.aqAddXp === 'function' && c.xp > 0) window.aqAddXp(c.xpSkill, c.xp);   // gated to accounts inside aqAddXp
  if (typeof window.aqRefreshStats === 'function') window.aqRefreshStats();
}

// ---------------------------------------------------------------------------
// Login streak (credits)
// ---------------------------------------------------------------------------
function streakReward(streak) { return Math.min(250, 50 + (Math.max(1, streak) - 1) * 25); }
function setStreakDisplay(n, ts) { try { localStorage.setItem('aq_streak_display', JSON.stringify({ n, ts })); } catch {} }
function currentStreakDisplay() {
  let v = null; try { v = JSON.parse(localStorage.getItem('aq_streak_display') || 'null'); } catch {}
  if (!v || !v.ts) return 0;
  const last = dayNum(v.ts), today = dayNum(Date.now());
  return (last === today || last === today - 1) ? (v.n | 0) : 0;   // streak still alive only if claimed today/yesterday
}
function applyStreak(streak) {
  const now = Date.now();
  setStreakDisplay(streak, now);
  const reward = streakReward(streak);
  if (typeof window.aqAddCredits === 'function') window.aqAddCredits(reward);
  toast(`🔥 Day ${streak} login streak! +${reward}💰`);
  if (typeof window.aqRefreshStats === 'function') window.aqRefreshStats();
}
async function claimLoginStreak() {
  const now = Date.now(), today = dayNum(now);
  if (window._aqAccountId) {
    try {
      const res = await runTransaction(ref(db, 'accounts/' + window._aqAccountId + '/loginStreak'), cur => {
        const prev = (cur && typeof cur === 'object') ? cur : { n: 0, ts: 0 };
        const last = dayNum(prev.ts || 0);
        if (prev.ts && last === today) return;                       // already counted today → abort
        const streak = (prev.ts && last === today - 1) ? (prev.n || 0) + 1 : 1;
        return { n: streak, ts: now };
      });
      if (res && res.committed && res.snapshot) { const v = res.snapshot.val() || {}; applyStreak(v.n || 1); }
      else if (res && res.snapshot) { const v = res.snapshot.val() || {}; setStreakDisplay(v.n || 0, v.ts || 0); }   // already claimed: just mirror for display
    } catch {}
    return;
  }
  // Anonymous fallback (local-only; their credits don't sync anyway).
  let raw = null; try { raw = JSON.parse(localStorage.getItem('aq_login_streak') || 'null'); } catch {}
  raw = raw && typeof raw === 'object' ? raw : { n: 0, ts: 0 };
  const last = dayNum(raw.ts || 0);
  if (raw.ts && last === today) { setStreakDisplay(raw.n || 0, raw.ts); return; }   // already today
  const streak = (raw.ts && last === today - 1) ? (raw.n || 0) + 1 : 1;
  try { localStorage.setItem('aq_login_streak', JSON.stringify({ n: streak, ts: now })); } catch {}
  applyStreak(streak);
}

// ---------------------------------------------------------------------------
// Stats-window card (called by skills.js renderSkillsPanel via window.aqRenderDailyInto)
// ---------------------------------------------------------------------------
function renderDailyInto(area) {
  const s = ensureState(); if (!s) return;
  const streak = currentStreakDisplay();
  const wrap = document.createElement('div'); wrap.className = 'sk-daily';
  let html = `<div class="sk-daily-head"><div class="sk-daily-title">🎯 Daily Challenges</div>`
    + `<div class="sk-streak">🔥 ${streak} day${streak === 1 ? '' : 's'}</div></div>`;
  for (const c of s.list) {
    const pct = Math.min(100, Math.round(((c.prog || 0) / c.goal) * 100));
    html += `<div class="sk-chal${c.done ? ' done' : ''}">`
      + `<div class="sk-chal-top"><span class="sk-chal-label">${c.done ? '✅ ' : ''}${esc(c.label)}</span>`
      + `<span class="sk-chal-reward">+${c.xp} XP · +${c.credits}💰</span></div>`
      + `<div class="sk-chal-bar"><div class="sk-chal-fill" style="width:${pct}%"></div></div>`
      + `<div class="sk-chal-reward" style="text-align:right">${Math.min(c.prog || 0, c.goal).toLocaleString()} / ${c.goal.toLocaleString()}</div>`
      + `</div>`;
  }
  html += `<div class="sk-daily-note">New challenges every day · login streak grants daily credits</div>`;
  wrap.innerHTML = html;
  area.appendChild(wrap);
}

// ---------------------------------------------------------------------------
// Central hooks: feed challenge progress without touching every game.
// ---------------------------------------------------------------------------
function installHooks() {
  // Credits earned → 'credits' events. aqAddCredits is the "earn" path (spending
  // goes through aqSetCredits), so this counts gains only.
  if (typeof window.aqAddCredits === 'function' && !window._aqDailyCreditsHooked) {
    window._aqDailyCreditsHooked = true;
    const orig = window.aqAddCredits;
    window.aqAddCredits = function (n) { orig(n); if (typeof n === 'number' && n > 0) progress('credits', n); };
  }
  // Opening a game window → 'open' events (for "play N different games").
  if (window.OS && typeof window.OS.open === 'function' && !window._aqDailyOpenHooked) {
    window._aqDailyOpenHooked = true;
    const orig = window.OS.open.bind(window.OS);
    window.OS.open = (id) => { orig(id); if (id && GAME_IDS.has(id)) { try { progress('open', 1, id); } catch {} } };
  }
}

if (typeof window !== 'undefined') {
  window.aqDailyProgress = progress;       // skills.js addXp calls this with ('xp', amount, skillId)
  window.aqRenderDailyInto = renderDailyInto;
  loadState();
  installHooks();
  // Give accounts.js a moment to attach the saved account (and credits) before the
  // streak claim, so the credits land on the right identity.
  setTimeout(() => { try { claimLoginStreak(); } catch {} }, 2600);
}
