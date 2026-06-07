// Aquatune game-save sync — persists per-account game progress (bought items and
// the like) to Firebase so it survives site updates, cache clears and new devices.
//
// Background: things like the mining pickaxe tier, fishing rod tier, current
// stage/zone and the Fish-o-pedia were only ever written to localStorage. That
// vanishes when a user clears their browser, switches device, or (for some setups)
// when the app updates — so paid-for upgrades appeared to "reset". This module
// mirrors a small set of localStorage keys up to `user-games/<uid>` and merges
// them back on load, taking the MAX for numeric tiers so a purchase is never lost.
//
// Games keep writing localStorage exactly as before and simply call
// `window.aqGamePersist(key)` afterwards to push the change to the cloud.

import { ref, get, set } from 'firebase/database';
import { db } from './firebase.js';

function userId() { return (typeof window.effectiveUserId === 'function' && window.effectiveUserId()) || localStorage.getItem('aq_user_id') || 'anon'; }
function hasAccount() { return typeof window !== 'undefined' && !!window._aqAccountId; }
function gamesRef() { return ref(db, `user-games/${userId()}`); }

// Numeric "progress" keys — never downgrade (a higher value is more progress).
const TIER_KEYS = ['aq_mining_pick', 'aq_fishing_rod', 'aq_mining_stage', 'aq_fishing_zone', 'aq_rogue_depth', 'aq_mining_prestige'];
// Per-name counters (JSON {name:count}) — merge by max so neither side loses a catch.
const COUNT_KEYS = ['aq_fishing_caught'];
// Free-form JSON/string blobs — newest writer wins (kept for completeness).
const BLOB_KEYS = ['aq_fishing_log', 'aq_slots', 'aq_rogue_unlocks', 'aq_daily_challenge'];
const ALL_KEYS = [...TIER_KEYS, ...COUNT_KEYS, ...BLOB_KEYS];

let _loaded = false, _saveTimer = null;

function _bundle() {
  const data = {};
  for (const k of ALL_KEYS) { const v = localStorage.getItem(k); if (v != null) data[k] = v; }
  return data;
}
function _saveRemote() {
  if (!hasAccount()) return;            // anonymous play stays local-only
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    set(gamesRef(), { data: _bundle(), updatedAt: Date.now() }).catch(() => {});
  }, 800);
}

function _mergeCounts(localStr, remoteStr) {
  let a = {}, b = {};
  try { a = JSON.parse(localStr || '{}') || {}; } catch {}
  try { b = JSON.parse(remoteStr || '{}') || {}; } catch {}
  const out = { ...a };
  let changed = false;
  for (const k of Object.keys(b)) {
    const rv = b[k] | 0, lv = out[k] | 0;
    if (rv > lv) { out[k] = rv; changed = true; }
  }
  return { merged: JSON.stringify(out), changed };
}

async function loadGameSave() {
  if (!hasAccount()) { _loaded = true; return; }
  try {
    const snap = await get(gamesRef());
    const remote = (snap.exists() && snap.val() && snap.val().data) || {};
    let changed = false;
    for (const k of TIER_KEYS) {
      if (remote[k] == null) continue;
      const rv = parseInt(remote[k], 10) || 0, lv = parseInt(localStorage.getItem(k) || '0', 10) || 0;
      if (rv > lv) { localStorage.setItem(k, String(rv)); changed = true; }
    }
    for (const k of COUNT_KEYS) {
      if (remote[k] == null) continue;
      const r = _mergeCounts(localStorage.getItem(k), remote[k]);
      if (r.changed) { localStorage.setItem(k, r.merged); changed = true; }
    }
    for (const k of BLOB_KEYS) {
      if (remote[k] != null && localStorage.getItem(k) == null) { localStorage.setItem(k, remote[k]); changed = true; }
    }
    _loaded = true;
    // Push our merged view back up (covers the case where local was ahead).
    _saveRemote();
    // Let any already-open game re-read its now-updated state.
    if (changed && typeof window !== 'undefined') { try { window.dispatchEvent(new CustomEvent('aq-gamedata-synced')); } catch {} }
  } catch { _loaded = true; }
}

if (typeof window !== 'undefined') {
  // Called by games after they write one of the tracked localStorage keys.
  window.aqGamePersist = function (key) {
    if (!_loaded) return;             // don't echo writes before the initial merge
    if (ALL_KEYS.includes(key)) _saveRemote();
  };
  // Login reloads the page, so loading once at init covers both reload and fresh
  // login (the account id is already set before this module runs).
  loadGameSave();
}
