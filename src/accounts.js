// Aquatune accounts — custom username/password accounts in the Realtime DB,
// with optional Google linking. Anonymous by default (the existing aq_user_id
// flow keeps working); creating/logging into an account makes that account the
// identity and syncs credits + holdings across devices.
//
// SECURITY NOTE: this is a client-trust model. Password hashes (SHA-256 + salt)
// live in the DB and are readable, so they're brute-forceable offline — this is
// NOT a substitute for real auth. Mitigations: claim-once rules on the username
// / google indices (see plan), and an honest in-app note. Don't store anything
// sensitive behind these accounts.

import { ref, get, set, update, runTransaction, onValue, serverTimestamp } from 'firebase/database';
import { db, app } from './firebase.js';

// ---------------------------------------------------------------------------
// Identity (synchronous so room-sync / stocks see it at module load)
// ---------------------------------------------------------------------------
window._aqAccountId = localStorage.getItem('aq_account_id') || null;
window.effectiveUserId = () => window._aqAccountId || localStorage.getItem('aq_user_id') || 'anon';

const USERNAME_RE = /^[A-Za-z0-9 _-]{3,24}$/;
const lower = u => String(u || '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------
function genAccountId() {
  const a = new Uint8Array(15); crypto.getRandomValues(a);
  return 'acct_' + [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
}
function genSalt() {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, saltHex) {
  const enc = new TextEncoder().encode(saltHex + ':' + password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function genTempPassword() {
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return [...a].map(b => b.toString(36)).join('').slice(0, 8);
}

// ---------------------------------------------------------------------------
// DB paths
// ---------------------------------------------------------------------------
const accRef = id => ref(db, 'accounts/' + id);
const userIdxRef = lo => ref(db, 'usernames/' + lo);
// Owner usernames (lowercase) that are always flagged admin on login — lets the
// first admin exist without Firebase-console access. Edit this list to add owners.
const OWNERS = ['jake'];
const googleIdxRef = uid => ref(db, 'googleUsers/' + uid);
const resetRef = lo => ref(db, 'passwordResets/' + lo);

let _account = null; // cached current account record
function aqCurrentAccount() { return _account ? { accountId: window._aqAccountId, ..._account } : null; }
window.aqCurrentAccount = aqCurrentAccount;
// Single source of truth for "is the signed-in user an admin?" — used by the
// account panel, AquaChat moderation, and any other admin-gated feature.
function aqIsAdmin() { return !!(_account && _account.admin); }
window.aqIsAdmin = aqIsAdmin;

// ---------------------------------------------------------------------------
// Daily bonus cooldown — enforced on the ACCOUNT (Firebase), not localStorage,
// so it can't be farmed by claiming on multiple devices / clearing site data.
// Anonymous users fall back to localStorage (their credits don't sync anyway).
// ---------------------------------------------------------------------------
const DAILY_MS = 86400000;
window.aqAccountLastDaily = () => (_account && typeof _account.lastDaily === 'number') ? _account.lastDaily : 0;
window.aqTryClaimDaily = async function () {
  // → true if the bonus is granted (caller then adds the credits)
  if (!window._aqAccountId) {
    const last = parseInt(localStorage.getItem('aq_last_claim') || '0', 10);
    if (Date.now() - last < DAILY_MS) return false;
    localStorage.setItem('aq_last_claim', String(Date.now()));
    return true;
  }
  try {
    const res = await runTransaction(ref(db, 'accounts/' + window._aqAccountId + '/lastDaily'), cur => {
      const last = (typeof cur === 'number') ? cur : 0;
      if (Date.now() - last < DAILY_MS) return;   // undefined → abort (already claimed)
      return Date.now();
    });
    if (res && res.committed) {
      const now = Date.now();
      if (_account) _account.lastDaily = now;
      localStorage.setItem('aq_last_claim', String(now));
      return true;
    }
    return false;
  } catch { return false; }
};

// ---------------------------------------------------------------------------
// Credits: local cache <-> account, live cross-device sync
// ---------------------------------------------------------------------------
let _creditUnsub = null, _acctCreditTimer = null, _applyingRemote = false;

function hookAccountCredits() {
  if (window._aqAcctCreditsHooked) return;
  window._aqAcctCreditsHooked = true;
  const orig = window.aqSetCredits;
  if (typeof orig !== 'function') return;
  window.aqSetCredits = function (n) {
    orig(n);
    if (!window._aqAccountId || _applyingRemote) return;
    clearTimeout(_acctCreditTimer);
    _acctCreditTimer = setTimeout(() => {
      const at = Date.now();
      localStorage.setItem('aq_credits_synced_at', String(at));
      update(accRef(window._aqAccountId), { credits: window.aqGetCredits(), updatedAt: at }).catch(() => {});
    }, 800);
  };
}

function watchCredits(id) {
  if (_creditUnsub) { _creditUnsub(); _creditUnsub = null; }
  // Listen to the account's credits child for live cross-device sync.
  _creditUnsub = onValue(ref(db, 'accounts/' + id + '/credits'), snap => {
    const remote = snap.val();
    if (typeof remote !== 'number') return;
    if (typeof window.aqGetCredits === 'function' && remote !== window.aqGetCredits()) {
      _applyingRemote = true;
      try { window.aqSetCredits(remote); } finally { _applyingRemote = false; }
    }
  });
}

// ---------------------------------------------------------------------------
// Attach an account to this session (silent on reload, no merge)
// ---------------------------------------------------------------------------
async function attachAccount(id, { adoptCredits = true } = {}) {
  window._aqAccountId = id;
  localStorage.setItem('aq_account_id', id);
  try {
    const snap = await get(accRef(id));
    _account = snap.exists() ? snap.val() : null;
  } catch { _account = null; }
  if (_account) {
    if (_account.username) localStorage.setItem('aq_username', _account.username);
    if (adoptCredits && typeof _account.credits === 'number' && typeof window.aqSetCredits === 'function') {
      _applyingRemote = true;
      try { window.aqSetCredits(_account.credits); } finally { _applyingRemote = false; }
      localStorage.setItem('aq_credits_synced_at', String(Date.now()));
    }
    // Owner bootstrap: always-admin usernames get the flag (persisted).
    if (OWNERS.includes(lower(_account.username || '')) && !_account.admin) {
      _account.admin = true;
      update(accRef(id), { admin: true, updatedAt: Date.now() }).catch(() => {});
    }
  }
  hookAccountCredits();
  watchCredits(id);
  if (typeof window.aqRefreshCreditDisplays === 'function') window.aqRefreshCreditDisplays();
  aqRenderAccountPanel();
}

// ---------------------------------------------------------------------------
// One-time merge of anonymous progress into the account (per device/account)
// ---------------------------------------------------------------------------
function unionHoldings(a, b) {
  const out = {};
  for (const src of [a || {}, b || {}]) {
    for (const id of Object.keys(src)) {
      const h = src[id]; if (!h || !h.shares) continue;
      if (!out[id]) out[id] = { shares: 0, avgCost: 0 };
      const tot = out[id].shares + h.shares;
      out[id].avgCost = tot ? (out[id].avgCost * out[id].shares + (h.avgCost || 0) * h.shares) / tot : 0;
      out[id].shares = tot;
    }
  }
  return out;
}
async function mergeLocalIntoAccount(id) {
  if (localStorage.getItem('aq_credits_migrated_' + id) === '1') return;
  const localCredits = typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 0;
  const anonId = localStorage.getItem('aq_user_id');
  let acct = {};
  try { acct = (await get(accRef(id))).val() || {}; } catch {}
  let localHoldings = {};
  if (anonId) { try { const ps = await get(ref(db, 'portfolios/' + anonId)); if (ps.exists()) localHoldings = ps.val().holdings || {}; } catch {} }
  const mergedCredits = Math.max(localCredits, acct.credits || 0);
  const mergedHoldings = unionHoldings(localHoldings, acct.holdings || {});
  const at = Date.now();
  await update(accRef(id), { credits: mergedCredits, holdings: mergedHoldings, updatedAt: at }).catch(() => {});
  await set(ref(db, 'portfolios/' + id), { holdings: mergedHoldings, credits: mergedCredits, updatedAt: at }).catch(() => {});
  localStorage.setItem('aq_credits_migrated_' + id, '1');
}

// ---------------------------------------------------------------------------
// Signup / login / logout
// ---------------------------------------------------------------------------
async function aqSignup(username, password) {
  username = String(username || '').trim();
  if (!USERNAME_RE.test(username)) return { ok: false, error: 'Username must be 3–24 chars (letters, numbers, space, _ or -).' };
  if (String(password || '').length < 4) return { ok: false, error: 'Password must be at least 4 characters.' };
  const lo = lower(username);
  try {
    if ((await get(userIdxRef(lo))).exists()) return { ok: false, error: 'That username is taken.' };
    const accountId = genAccountId();
    // claim the username atomically (race-safe)
    const claim = await runTransaction(userIdxRef(lo), cur => (cur == null ? accountId : undefined));
    if (!claim.committed || claim.snapshot.val() !== accountId) return { ok: false, error: 'That username was just taken.' };
    const salt = genSalt();
    const passwordHash = await hashPassword(password, salt);
    const credits = typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 100;
    await set(accRef(accountId), {
      username, usernameLower: lo, salt, passwordHash, googleUid: null,
      credits, holdings: {}, createdAt: serverTimestamp(), updatedAt: Date.now(),
    });
    await mergeLocalIntoAccount(accountId);
    localStorage.setItem('aq_account_id', accountId);
    localStorage.setItem('aq_username', username);
    location.reload();
    return { ok: true, accountId };
  } catch (e) { return { ok: false, error: 'Signup failed (network?).' }; }
}

async function aqLogin(username, password) {
  const lo = lower(username);
  try {
    const idSnap = await get(userIdxRef(lo));
    if (!idSnap.exists()) return { ok: false, error: 'No account with that username.' };
    const accountId = idSnap.val();
    const acct = (await get(accRef(accountId))).val();
    if (!acct) return { ok: false, error: 'Account not found.' };
    if (!acct.passwordHash) return { ok: false, error: 'This account uses Google sign-in.' };
    const h = await hashPassword(password, acct.salt);
    if (h !== acct.passwordHash) return { ok: false, error: 'Wrong password.' };
    // forced reset (admin set a temp password)
    if (acct.mustChangePassword) {
      const np = prompt('Your password was reset. Choose a new password:');
      if (!np || np.length < 4) return { ok: false, error: 'Password change cancelled.' };
      const salt = genSalt();
      await update(accRef(accountId), { salt, passwordHash: await hashPassword(np, salt), mustChangePassword: null, updatedAt: Date.now() });
    }
    await mergeLocalIntoAccount(accountId);
    localStorage.setItem('aq_account_id', accountId);
    localStorage.setItem('aq_username', acct.username);
    location.reload();
    return { ok: true, accountId };
  } catch (e) { return { ok: false, error: 'Login failed (network?).' }; }
}

function aqLogout() {
  if (_creditUnsub) { _creditUnsub(); _creditUnsub = null; }
  localStorage.removeItem('aq_account_id');
  window._aqAccountId = null; _account = null;
  location.reload();
}

async function aqChangePassword(newPassword) {
  if (!window._aqAccountId) return { ok: false, error: 'Not logged in.' };
  if (String(newPassword || '').length < 4) return { ok: false, error: 'Password must be at least 4 characters.' };
  const salt = genSalt();
  await update(accRef(window._aqAccountId), { salt, passwordHash: await hashPassword(newPassword, salt), mustChangePassword: null, updatedAt: Date.now() });
  return { ok: true };
}

// Rename works for any account, including Google-only ones (whose name was
// auto-derived from the Google display name).
async function aqChangeUsername(newName) {
  if (!window._aqAccountId) return { ok: false, error: 'Not logged in.' };
  newName = String(newName || '').trim();
  if (!USERNAME_RE.test(newName)) return { ok: false, error: 'Username must be 3–24 chars (letters, numbers, space, _ or -).' };
  const id = window._aqAccountId, lo = lower(newName);
  try {
    if (lo !== (_account && _account.usernameLower)) {
      const existing = await get(userIdxRef(lo));
      if (existing.exists() && existing.val() !== id) return { ok: false, error: 'That username is taken.' };
      const claim = await runTransaction(userIdxRef(lo), cur => (cur == null || cur === id ? id : undefined));
      if (!claim.committed || claim.snapshot.val() !== id) return { ok: false, error: 'That username was just taken.' };
      // (the old username index is left pointing at this account, so you can
      // still log in with it; releasing it would need server-side auth.)
    }
    await update(accRef(id), { username: newName, usernameLower: lo, updatedAt: Date.now() });
    if (_account) { _account.username = newName; _account.usernameLower = lo; }
    localStorage.setItem('aq_username', newName);
    const chip = document.getElementById('aq-username-chip'); if (chip) chip.textContent = newName;
    aqRenderAccountPanel();
    return { ok: true };
  } catch { return { ok: false, error: 'Could not change username (network?).' }; }
}

// ---------------------------------------------------------------------------
// Forgot password — user requests, admin resets
// ---------------------------------------------------------------------------
async function aqRequestReset(username) {
  const lo = lower(username);
  if (!lo) return { ok: false, error: 'Enter your username.' };
  try {
    if (!(await get(userIdxRef(lo))).exists()) return { ok: false, error: 'No account with that username.' };
    await set(resetRef(lo), { username: String(username).trim(), requestedAt: Date.now(), status: 'pending' });
    return { ok: true };
  } catch { return { ok: false, error: 'Could not send request (network?).' }; }
}

// ---------------------------------------------------------------------------
// Google linking / login (auth loaded lazily — only when used)
// ---------------------------------------------------------------------------
async function googleSignIn() {
  const { getAuth, GoogleAuthProvider, signInWithPopup } = await import('firebase/auth');
  const res = await signInWithPopup(getAuth(app), new GoogleAuthProvider());
  return res.user;
}
async function aqLinkGoogle() {
  if (!window._aqAccountId) return { ok: false, error: 'Log in first.' };
  try {
    const user = await googleSignIn();
    const existing = await get(googleIdxRef(user.uid));
    if (existing.exists() && existing.val() !== window._aqAccountId) return { ok: false, error: 'That Google account is linked elsewhere.' };
    await runTransaction(googleIdxRef(user.uid), cur => (cur == null || cur === window._aqAccountId ? window._aqAccountId : undefined));
    await update(accRef(window._aqAccountId), { googleUid: user.uid, updatedAt: Date.now() });
    _account = (await get(accRef(window._aqAccountId))).val();
    aqRenderAccountPanel();
    return { ok: true };
  } catch (e) { return { ok: false, error: 'Google link failed.' }; }
}
async function aqLoginWithGoogle() {
  try {
    const user = await googleSignIn();
    const idx = await get(googleIdxRef(user.uid));
    if (idx.exists()) {
      const accountId = idx.val();
      await mergeLocalIntoAccount(accountId);
      localStorage.setItem('aq_account_id', accountId);
      location.reload();
      return { ok: true, accountId };
    }
    // No account yet — auto-create a Google-only one.
    const accountId = genAccountId();
    let base = (user.displayName || 'player').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20) || 'player';
    let uname = base, n = 1;
    while ((await get(userIdxRef(lower(uname)))).exists()) uname = (base + n++).slice(0, 24);
    await runTransaction(userIdxRef(lower(uname)), cur => (cur == null ? accountId : undefined));
    const credits = typeof window.aqGetCredits === 'function' ? window.aqGetCredits() : 100;
    await set(accRef(accountId), { username: uname, usernameLower: lower(uname), salt: null, passwordHash: null, googleUid: user.uid, credits, holdings: {}, createdAt: serverTimestamp(), updatedAt: Date.now() });
    await set(googleIdxRef(user.uid), accountId);
    await mergeLocalIntoAccount(accountId);
    localStorage.setItem('aq_account_id', accountId);
    localStorage.setItem('aq_username', uname);
    location.reload();
    return { ok: true, accountId };
  } catch (e) { return { ok: false, error: 'Google sign-in failed.' }; }
}

// ---------------------------------------------------------------------------
// Admin (only for accounts flagged admin:true in the DB)
// ---------------------------------------------------------------------------
async function aqAdminListResets() {
  try { const snap = await get(ref(db, 'passwordResets')); return snap.exists() ? snap.val() : {}; } catch { return {}; }
}
async function aqAdminResetPassword(username, tempPassword) {
  if (!_account || !_account.admin) return { ok: false, error: 'Not an admin.' };
  const lo = lower(username);
  const idSnap = await get(userIdxRef(lo));
  if (!idSnap.exists()) return { ok: false, error: 'No such username.' };
  const accountId = idSnap.val();
  const temp = tempPassword && tempPassword.length >= 4 ? tempPassword : genTempPassword();
  const salt = genSalt();
  await update(accRef(accountId), { salt, passwordHash: await hashPassword(temp, salt), mustChangePassword: true, updatedAt: Date.now() });
  await set(resetRef(lo), null).catch(() => {});
  return { ok: true, tempPassword: temp };
}
// Admin: add/remove credits from any account by username (delta may be negative).
async function aqAdminAdjustCredits(username, delta) {
  if (!_account || !_account.admin) return { ok: false, error: 'Not an admin.' };
  delta = Math.round(Number(delta));
  if (!isFinite(delta) || delta === 0) return { ok: false, error: 'Enter a nonzero amount.' };
  const lo = lower(username);
  const idSnap = await get(userIdxRef(lo));
  if (!idSnap.exists()) return { ok: false, error: 'No such username.' };
  const accountId = idSnap.val();
  let after = null;
  try {
    const res = await runTransaction(ref(db, 'accounts/' + accountId + '/credits'), cur => {
      const c = (typeof cur === 'number') ? cur : 0;
      after = Math.max(0, c + delta);
      return after;
    });
    if (!res || !res.committed) return { ok: false, error: 'Update failed.' };
  } catch (e) { return { ok: false, error: 'Update failed.' }; }
  await update(accRef(accountId), { updatedAt: Date.now() }).catch(() => {});
  return { ok: true, credits: after };
}
// Admin: set a user's skill to a given level (writes the XP for that level into
// their synced skills node, user-skills/<id>/xp/<skill>). Skills merge by max on
// load, so this raises a skill up to the target level (it won't lower a higher one).
async function aqAdminSetSkill(username, skillId, level) {
  if (!_account || !_account.admin) return { ok: false, error: 'Not an admin.' };
  skillId = String(skillId || '').trim().toLowerCase();
  level = Math.max(1, Math.min(100, Math.round(Number(level))));
  if (!skillId || !isFinite(level)) return { ok: false, error: 'Pick a skill and level.' };
  const xp = (typeof window.aqXpForLevel === 'function') ? window.aqXpForLevel(level) : Math.round(15 * (level - 1) * (level - 1));
  const lo = lower(username);
  const idSnap = await get(userIdxRef(lo));
  if (!idSnap.exists()) return { ok: false, error: 'No such username.' };
  const accountId = idSnap.val();
  try {
    await update(ref(db, 'user-skills/' + accountId + '/xp'), { [skillId]: xp });
    await update(ref(db, 'user-skills/' + accountId), { updatedAt: Date.now() });
  } catch (e) { return { ok: false, error: 'Update failed.' }; }
  return { ok: true, level, xp };
}

// ---------------------------------------------------------------------------
// UI — rendered into every .aq-account-panel mount (Settings + splash).
// Uses container-scoped queries so the same markup can appear twice. A
// data-variant="splash" mount renders a compact form.
// ---------------------------------------------------------------------------
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function aqRenderAccountPanel() {
  document.querySelectorAll('.aq-account-panel').forEach(renderAccountInto);
  // Splash "continue as guest" affordance only shows when logged out.
  const guestRow = document.getElementById('sp-guest-row');
  if (guestRow) guestRow.style.display = aqCurrentAccount() ? 'none' : '';
}

function renderAccountInto(box) {
  const splash = box.dataset.variant === 'splash';
  const acct = aqCurrentAccount();
  const $ = sel => box.querySelector(sel);
  const msg = (t, ok) => { const m = $('.aq-acct-msg'); if (m) { m.textContent = t; m.style.color = ok ? '#5ad17a' : '#ff8f8f'; } };

  if (!acct) {
    box.innerHTML = `
      <div class="aq-acct-row"><input class="aq-acct-user" placeholder="username" autocomplete="username"></div>
      <div class="aq-acct-row"><input class="aq-acct-pass" type="password" placeholder="password" autocomplete="current-password"></div>
      <div class="aq-acct-row">
        <button class="win95-btn aq-acct-login">Log in</button>
        <button class="win95-btn aq-acct-signup">Create account</button>
      </div>
      <div class="aq-acct-row">
        <button class="aq-link aq-acct-forgot">Forgot password?</button>
      </div>
      <div class="aq-acct-msg"></div>
      ${splash ? '' : '<div class="aq-acct-note">You can keep playing without an account — signing in just syncs your credits across devices. (Passwords are stored with basic protection; don\'t reuse an important one.)</div>'}`;
    const u = () => $('.aq-acct-user').value, p = () => $('.aq-acct-pass').value;
    $('.aq-acct-login').onclick = async () => { msg('Logging in…', true); const r = await aqLogin(u(), p()); if (!r.ok) msg(r.error, false); };
    $('.aq-acct-signup').onclick = async () => { msg('Creating…', true); const r = await aqSignup(u(), p()); if (!r.ok) msg(r.error, false); };
    // Aquatune-account Google sign-in temporarily disabled (button removed above).
    // The YouTube/Google sign-in for video features is separate and unaffected.
    $('.aq-acct-forgot').onclick = async () => {
      const name = prompt('Enter your username to request a password reset:'); if (!name) return;
      const r = await aqRequestReset(name); msg(r.ok ? 'Reset request sent to the admin.' : r.error, r.ok);
    };
    return;
  }
  // logged in
  const linked = !!acct.googleUid;
  box.innerHTML = `
    <div class="aq-acct-who">Signed in as <b>${esc(acct.username)}</b></div>
    <div class="aq-acct-row">
      <button class="win95-btn aq-acct-logout">Log out</button>
      <button class="win95-btn aq-acct-rename">Change username</button>
      ${splash ? '' : `<button class="win95-btn aq-acct-changepw">Change password</button>`}
    </div>
    <div class="aq-acct-msg"></div>
    ${(!splash && acct.admin) ? '<div class="aq-acct-row"><button class="win95-btn aq-acct-admin">Admin: password resets</button></div><div class="aq-admin-box"></div>' : ''}`;
  $('.aq-acct-logout').onclick = () => aqLogout();
  $('.aq-acct-rename').onclick = async () => { const nn = prompt('New username:', acct.username); if (!nn) return; msg('Renaming…', true); const r = await aqChangeUsername(nn); msg(r.ok ? 'Username changed.' : r.error, r.ok); };
  if (!splash) {
    $('.aq-acct-changepw').onclick = async () => { const np = prompt('New password:'); if (!np) return; const r = await aqChangePassword(np); msg(r.ok ? 'Password changed.' : r.error, r.ok); };
    // "Connect Google" temporarily removed; aqLinkGoogle remains for re-enabling later.
    if (acct.admin) $('.aq-acct-admin').onclick = () => renderAdminBox(box.querySelector('.aq-admin-box'));
  }
}

async function renderAdminBox(box) {
  if (!box) return;
  box.innerHTML = '<div class="aq-acct-note">Loading reset requests…</div>';
  const resets = await aqAdminListResets();
  const keys = Object.keys(resets);
  const list = keys.length
    ? keys.map(k => `<div class="aq-admin-req"><span>${esc(resets[k].username || k)}</span><button class="win95-btn aq-admin-reset" data-u="${esc(resets[k].username || k)}">Reset</button></div>`).join('')
    : '<div class="aq-acct-note">No pending requests.</div>';
  box.innerHTML = `${list}
    <div class="aq-acct-row"><input class="aq-admin-user" placeholder="username to reset"><button class="win95-btn aq-admin-go">Reset password</button></div>
    <div class="aq-acct-row"><input class="aq-admin-cuser" placeholder="username"><input class="aq-admin-camt" type="number" placeholder="±credits" style="width:84px"><button class="win95-btn aq-admin-cgo">Adjust credits</button></div>
    <div class="aq-acct-row"><input class="aq-admin-suser" placeholder="username"><input class="aq-admin-sskill" placeholder="skill (e.g. music)" style="width:120px"><input class="aq-admin-slvl" type="number" placeholder="lvl" style="width:60px"><button class="win95-btn aq-admin-sgo">Set skill level</button></div>
    <div class="aq-acct-msg aq-admin-msg"></div>`;
  const msg = (t, ok) => { const m = box.querySelector('.aq-admin-msg'); if (m) { m.textContent = t; m.style.color = ok ? '#5ad17a' : '#ff8f8f'; } };
  const doReset = async (name) => {
    const r = await aqAdminResetPassword(name);
    if (r.ok) { msg(`Temp password for ${name}: ${r.tempPassword} — share it; they'll be asked to change it.`, true); renderAdminBox(box); }
    else msg(r.error, false);
  };
  box.querySelectorAll('.aq-admin-reset').forEach(b => b.onclick = () => doReset(b.dataset.u));
  box.querySelector('.aq-admin-go').onclick = () => { const v = box.querySelector('.aq-admin-user').value.trim(); if (v) doReset(v); };
  box.querySelector('.aq-admin-cgo').onclick = async () => {
    const u = box.querySelector('.aq-admin-cuser').value.trim();
    const amt = box.querySelector('.aq-admin-camt').value;
    if (!u) return;
    const r = await aqAdminAdjustCredits(u, amt);
    msg(r.ok ? `${u} now has ${r.credits} credits.` : r.error, r.ok);
  };
  box.querySelector('.aq-admin-sgo').onclick = async () => {
    const u = box.querySelector('.aq-admin-suser').value.trim();
    const skill = box.querySelector('.aq-admin-sskill').value.trim();
    const lvl = box.querySelector('.aq-admin-slvl').value;
    if (!u || !skill) return;
    const r = await aqAdminSetSkill(u, skill, lvl);
    msg(r.ok ? `${u} ${skill} set to level ${r.level}.` : r.error, r.ok);
  };
}

// expose
Object.assign(window, {
  aqSignup, aqLogin, aqLogout, aqChangePassword, aqChangeUsername, aqRequestReset,
  aqLinkGoogle, aqLoginWithGoogle, aqRenderAccountPanel, aqAdminAdjustCredits, aqAdminSetSkill,
});

// ---------------------------------------------------------------------------
// Bootstrap: silently re-attach a saved account on load
// ---------------------------------------------------------------------------
if (window._aqAccountId) {
  attachAccount(window._aqAccountId);
} else {
  // still render the (logged-out) panel once the DOM is ready
  if (document.readyState !== 'loading') aqRenderAccountPanel();
  else document.addEventListener('DOMContentLoaded', aqRenderAccountPanel);
}
