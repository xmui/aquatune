import { ref, set, push, query, orderByChild, limitToLast, get, onValue, onChildAdded, onDisconnect, remove, serverTimestamp } from 'firebase/database';
import { db } from './firebase.js';
// Expose Firebase functions for leaderboard / lobby / reactions access from index.html
window._fbFns = { push, ref, query, orderByChild, limitToLast, get, set, remove, onValue, onChildAdded, onDisconnect, serverTimestamp };

// Lightweight non-cryptographic hash for password obfuscation (client-only model; not real security)
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < String(str).length; i++) h = ((h << 5) + h + String(str).charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
window._djb2 = djb2;

const GLOBAL_CHAT_PATH = 'globalChat';
const SEEK_TOLERANCE_BASE = 0.75; // seconds — tight lock for music once playing
const SEEK_TOLERANCE_LOAD = 1.5;  // wider while a video is still buffering/cued
const BROADCAST_DEBOUNCE = 350;   // ms debounce for rapid state changes (seeking)
const HOST_HEARTBEAT_MS  = 10000; // host writes a heartbeat this often
const HOST_STALE_MS      = 40000; // a host whose heartbeat is older than this is considered gone

window._isRoomHost    = false;
window._canControl    = false; // true if host OR granted permission by host
window._applyingRemote = false;
window._currentRoomId  = null;

// One-time estimate of (localClock - serverClock) so cross-device elapsed math is accurate
let _clockOffset = 0;
function sampleClockOffset() {
  // Write server time to a scratch path, read it back, compare to local Date.now()
  try {
    const r = ref(db, `clockSync/${myUserId}`);
    set(r, serverTimestamp()).then(() => get(r)).then(snap => {
      const serverNow = snap.val();
      if (typeof serverNow === 'number') _clockOffset = Date.now() - serverNow;
      remove(r);
    }).catch(() => {});
  } catch {}
}
// Server-aligned "now" used for elapsed-time calculations
function syncedNow() { return Date.now() - _clockOffset; }

function genId(len = 8) {
  return Array.from({length: len}, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
}
const myUserId = localStorage.getItem('aq_user_id') || (() => {
  const id = genId(12); localStorage.setItem('aq_user_id', id); return id;
})();
window._myUserId = myUserId;

// YouTube IFrame player states
const YT_UNSTARTED = -1, YT_ENDED = 0, YT_PLAYING = 1, YT_PAUSED = 2, YT_BUFFERING = 3, YT_CUED = 5;

// Adaptive seek tolerance — looser while the player is still loading, tight once it's PLAYING
function currentTolerance() {
  try {
    const st = window.player?.getPlayerState?.();
    if (st === YT_BUFFERING || st === YT_CUED || st === YT_UNSTARTED) return SEEK_TOLERANCE_LOAD;
  } catch {}
  return SEEK_TOLERANCE_BASE;
}

// Poll-based seek/play lock: drives the YT player toward a live target time using the player's
// own state machine instead of a fixed timeout, so slow/mobile buffering still lands in sync.
// getTarget() recomputes the desired time each tick (so it keeps advancing while we wait to load).
window._seekLockTimer = null;
function seekLockLoop(getTarget, wantPlaying) {
  clearInterval(window._seekLockTimer);
  let tries = 0;
  window._seekLockTimer = setInterval(() => {
    const p = window.player;
    if (!p || typeof p.getPlayerState !== 'function') { if (++tries > 80) clearInterval(window._seekLockTimer); return; }
    const st = p.getPlayerState();
    // Wait until the player is initialised enough that seekTo is reliable
    if (st === YT_UNSTARTED || st === undefined) { if (++tries > 80) clearInterval(window._seekLockTimer); return; }
    const target = getTarget();
    const cur = (typeof p.getCurrentTime === 'function' ? p.getCurrentTime() : 0) || 0;
    const tol = currentTolerance();
    // Briefly flag programmatic control so our own onState handler doesn't echo-broadcast
    window._applyingRemote = true;
    if (Math.abs(cur - target) > tol) { try { p.seekTo(target, true); } catch {} }
    if (wantPlaying && st !== YT_PLAYING) { try { p.playVideo(); } catch {} }
    if (!wantPlaying && st === YT_PLAYING) { try { p.pauseVideo(); } catch {} }
    // Consider it locked once play/pause matches AND we're within tolerance of the live target
    const nowCur = (typeof p.getCurrentTime === 'function' ? p.getCurrentTime() : 0) || 0;
    const stateOk = wantPlaying ? st === YT_PLAYING : (st === YT_PAUSED || st === YT_CUED);
    const locked = stateOk && Math.abs(nowCur - getTarget()) <= tol;
    if (locked || ++tries > 80) {
      clearInterval(window._seekLockTimer);
      setTimeout(() => { window._applyingRemote = false; }, 120);
    }
  }, 150);
}

// Debounced broadcast — callers pass delay=0 for immediate (play/pause/track change)
// or delay=BROADCAST_DEBOUNCE for seeking
let _broadcastTimer = null;
window.broadcastRoomState = function(delay = 0) {
  if (!window._currentRoomId || !window._canControl || window._applyingRemote) return;
  clearTimeout(_broadcastTimer);
  _broadcastTimer = setTimeout(() => {
    const cur = window.current;
    set(ref(db, `rooms/${window._currentRoomId}/state`), {
      videoId:           cur?.id || null,
      videoTitle:        cur?.title || '',
      videoChannelTitle: cur?.channelTitle || '',
      videoThumbnail:    cur?.thumbnail || '',
      // Sub-second precision so guests can lock tightly instead of being off by up to a second
      currentTime: (window.player && typeof window.player.getCurrentTime === 'function')
        ? window.player.getCurrentTime() : 0,
      playing:    !!window.playing,
      queue:      window.queue || [],
      updatedBy:  myUserId,
      // serverTimestamp lets guests measure true elapsed time regardless of device clock skew
      updatedAt:  serverTimestamp(),
    });
    // Host keeps the lobby metadata fresh (now-playing + heartbeat)
    if (window._isRoomHost) {
      set(ref(db, `rooms/${window._currentRoomId}/meta/nowPlaying`), window.current?.title || '');
      set(ref(db, `rooms/${window._currentRoomId}/meta/updatedAt`), Date.now());
    }
  }, delay);
};

// Skip re-applying an identical snapshot (cheap idempotency guard)
let _lastAppliedSig = '';
const _isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function applyRoomState(state) {
  if (!state || !state.videoId) return;

  const sig = `${state.videoId}|${Math.round((state.currentTime || 0) * 2)}|${state.playing ? 1 : 0}`;
  // updatedAt can briefly be null between the local set and the server echo — guard that
  const updatedAt = typeof state.updatedAt === 'number' ? state.updatedAt : syncedNow();

  // Live target: recompute elapsed at the moment of each seek attempt (server-clock aligned)
  const getTarget = () => {
    const elapsed = Math.min(Math.max((syncedNow() - updatedAt) / 1000, 0), 20);
    return (state.currentTime || 0) + (state.playing ? elapsed : 0);
  };

  const switching = state.videoId !== (window.current?.id);
  // Suppress echo: while we apply a remote state, a controlling client (DJ/host) must not
  // re-broadcast the change that playVideo()/seek would otherwise trigger. seekLockLoop keeps
  // this flag set while it runs; clear it here for paths that don't start a loop.
  window._applyingRemote = true;
  let startedLoop = false;

  if (switching) {
    const v = {
      id:           state.videoId,
      title:        state.videoTitle || state.videoId,
      channelTitle: state.videoChannelTitle || '',
      thumbnail:    state.videoThumbnail || `https://i.ytimg.com/vi/${state.videoId}/mqdefault.jpg`,
      source:       'youtube',
    };
    // On mobile, autoplay-with-sound is blocked. Mute before loading so the video can start,
    // then offer a one-tap unmute. Desktop just plays normally.
    if (_isMobile && state.playing) { try { window.player?.mute?.(); } catch {} _showTapToSync(); }
    if (window.playVideo) window.playVideo(v);
    // Drive to the right spot using the player's state machine (no fixed 1.5s guess)
    seekLockLoop(getTarget, !!state.playing);
    startedLoop = true;
  } else {
    // Same video — correct drift if we've fallen outside the adaptive tolerance
    if (window.player && typeof window.player.getCurrentTime === 'function') {
      const drift = Math.abs(window.player.getCurrentTime() - getTarget());
      const playMismatch = (!!state.playing) !== (!!window.playing);
      if (drift > currentTolerance() || playMismatch) {
        seekLockLoop(getTarget, !!state.playing);
        startedLoop = true;
      }
    }
  }
  // No loop running to manage the guard — release it shortly after the synchronous apply
  if (!startedLoop) setTimeout(() => { window._applyingRemote = false; }, 250);

  _lastAppliedSig = sig;

  // Sync queue display
  if (state.queue && window.renderQueue) {
    window.queue = state.queue;
    window.renderQueue();
  }
}

// One-tap "sync audio" affordance for mobile (autoplay policy requires a user gesture to unmute)
function _showTapToSync() {
  if (document.getElementById('aq-tap-to-sync')) return;
  const b = document.createElement('button');
  b.id = 'aq-tap-to-sync';
  b.textContent = '🔊 Tap to sync audio';
  b.style.cssText = 'position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:99999;'
    + 'background:rgba(0,0,0,.82);color:#fff;border:0;border-radius:22px;padding:12px 22px;'
    + 'font-size:14px;font-weight:600;box-shadow:0 4px 18px rgba(0,0,0,.4);cursor:pointer';
  b.onclick = () => {
    try { window.player?.unMute?.(); window.player?.playVideo?.(); } catch {}
    b.remove();
  };
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 12000);
}

// Presence + members panel state
let _presenceMap   = {}; // userId → {username, ...}
let _permissionMap = {}; // userId → {canControl, ...}

function renderMembersPanel() {
  const list = document.getElementById('room-members-list');
  if (!list) return;
  list.innerHTML = '';
  // Offer takeover when we're a guest and the host appears to have left
  if (window._currentRoomId && !window._isRoomHost && window._hostStale) {
    const row = document.createElement('div');
    row.className = 'room-member-row';
    row.innerHTML = `<span class="room-member-name" style="opacity:.7">Host appears offline</span>`
      + `<button class="room-member-btn" onclick="window.claimHost()">Become host 👑</button>`;
    list.appendChild(row);
  }
  // Filter out stale presence entries (no heartbeat for >90s)
  const now = Date.now();
  const activePresence = Object.fromEntries(
    Object.entries(_presenceMap).filter(([, info]) => !info.lastSeen || (now - info.lastSeen) < 90000)
  );
  // Update badge count with active members only
  const countEl = document.getElementById('room-badge-members');
  if (countEl) countEl.textContent = `👤 ${Object.keys(activePresence).length}`;

  Object.entries(activePresence).forEach(([uid, info]) => {
    const isSelf     = uid === myUserId;
    const isHost     = uid === _roomHostUserId;
    const hasControl = !!_permissionMap[uid]?.canControl || isHost;
    const row = document.createElement('div');
    row.className = 'room-member-row';
    const badge = isHost ? '👑' : hasControl ? '🎮' : '';
    let actionHtml = '';
    if (window._isRoomHost && !isSelf && !isHost) {
      if (hasControl) {
        actionHtml = `<button class="room-member-btn revoke" onclick="window.revokeControl('${uid}')">Revoke</button><button class="room-member-btn revoke" onclick="window.kickUser('${uid}')">Kick</button>`;
      } else {
        actionHtml = `<button class="room-member-btn" onclick="window.grantControl('${uid}')">DJ 🎮</button><button class="room-member-btn revoke" onclick="window.kickUser('${uid}')">Kick</button>`;
      }
    }
    row.innerHTML = `
      <span class="room-member-badge">${badge}</span>
      <span class="room-member-name">${esc(info.username || 'Guest')}${isSelf ? ' <em style="opacity:.55;font-weight:400">(you)</em>' : ''}</span>
      ${actionHtml}`;
    list.appendChild(row);
  });
}

let _roomHostUserId = null;

// Resolve true host status against Firebase rather than trusting the caller's flag.
// Returns a boolean: am I the host of this room? Handles: fresh room, reloading host
// (hostUserId already === me), and takeover of a room whose host's heartbeat is stale.
async function resolveHostStatus(roomId, requestedHost) {
  try {
    const hostRef = ref(db, `rooms/${roomId}/hostUserId`);
    const snap = await get(hostRef);
    if (!snap.exists()) {
      // No host on record — claim it only if we actually asked to host (don't hijack as a guest)
      if (requestedHost) { await set(hostRef, myUserId); return true; }
      return false;
    }
    const current = snap.val();
    if (current === myUserId) return true; // reloading host: identity verified, restore control
    // Someone else holds it — only take over if they look gone AND we asked to be host
    if (requestedHost) {
      const hb = await get(ref(db, `rooms/${roomId}/hostHeartbeat`));
      const ts = hb.exists() ? (hb.val()?.ts || 0) : 0;
      if (syncedNow() - ts > HOST_STALE_MS) {
        await set(hostRef, myUserId); // guarded by staleness check above
        return true;
      }
    }
    return false;
  } catch {
    // On error, fall back to the requested role so the user isn't stranded
    return !!requestedHost;
  }
}

// Promote a guest to host when the previous host has gone (heartbeat stale).
window.claimHost = async function() {
  const roomId = window._currentRoomId;
  if (!roomId || window._isRoomHost) return;
  const ok = await resolveHostStatus(roomId, true);
  if (!ok) { window.toast?.('Host is still active'); return; }
  window._isRoomHost = true;
  window._canControl = true;
  _roomHostUserId = myUserId;
  document.body.classList.remove('room-guest');
  try { localStorage.setItem('aq_session_room', JSON.stringify({ roomId, wasHost: true })); } catch {}
  _registerHostListeners(roomId);
  renderMembersPanel();
  window.toast?.('👑 You are now the host');
};

// Host-only Firebase listeners + heartbeat. Idempotent so claimHost() can call it after promotion.
let _hostListenersOn = false;
let _hostHeartbeatInt = null;
function _registerHostListeners(roomId) {
  if (_hostListenersOn) return;
  _hostListenersOn = true;

  // Claim/refresh the host record and keep a heartbeat so guests know we're alive
  set(ref(db, `rooms/${roomId}/hostUserId`), myUserId);
  onDisconnect(ref(db, `rooms/${roomId}/hostUserId`)).remove();
  onDisconnect(ref(db, `rooms/${roomId}/hostHeartbeat`)).remove();
  clearInterval(_hostHeartbeatInt);
  _hostHeartbeatInt = setInterval(() => {
    if (!window._isRoomHost || window._currentRoomId !== roomId) return;
    set(ref(db, `rooms/${roomId}/hostHeartbeat`), { ts: Date.now() });
    // Backstop re-broadcast so late joiners / drift get corrected even with no user action
    if (window._canControl) window.broadcastRoomState?.();
  }, HOST_HEARTBEAT_MS);

  // Pick up guest queue additions
  onChildAdded(ref(db, `rooms/${roomId}/guestQueue`), snap => {
    const v = snap.val();
    if (v && window.addToQueue) window.addToQueue(v);
    remove(snap.ref);
  });

  // Pick up gated song requests from permission-less guests
  onChildAdded(ref(db, `rooms/${roomId}/requests`), snap => {
    const req = snap.val();
    if (req) window.onSongRequest?.({ ...req, _id: snap.key });
  });

  window.renderRequestsPanel?.();
}

window.initRoom = async function(roomId, isHost, opts) {
  opts = opts || {};
  _hostListenersOn = false;
  sampleClockOffset();
  // Verify host status against Firebase — fixes "lost host on reload" and prevents two hosts
  isHost = await resolveHostStatus(roomId, isHost);
  window._currentRoomId = roomId;
  window._isRoomHost    = isHost;
  window._canControl    = isHost;
  if (isHost) _roomHostUserId = myUserId;
  // Keep the persisted session role in sync with the resolved role
  try { localStorage.setItem('aq_session_room', JSON.stringify({ roomId, wasHost: isHost })); } catch {}
  // Immediately dim controls for guests
  document.body.classList.toggle('room-guest', !isHost);
  document.body.classList.add('in-room'); // reveals reaction bar + request affordances

  // Write own presence
  const username  = localStorage.getItem('aq_username') || 'Guest';

  // Host: publish room metadata for the public lobby + store optional password hash
  if (isHost) {
    const isPrivate = !!opts.isPrivate;
    const password  = opts.password || '';
    set(ref(db, `rooms/${roomId}/meta`), {
      hostName: username, title: `${username}'s room`, nowPlaying: '',
      isPrivate, hasPassword: !!password, memberCount: 1,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    onDisconnect(ref(db, `rooms/${roomId}/meta`)).remove();
    // Free the host slot on a clean disconnect so a guest can take over without waiting for staleness
    onDisconnect(ref(db, `rooms/${roomId}/hostUserId`)).remove();
    onDisconnect(ref(db, `rooms/${roomId}/hostHeartbeat`)).remove();
    set(ref(db, `rooms/${roomId}/hostHeartbeat`), { ts: Date.now() });
    if (password) set(ref(db, `rooms/${roomId}/auth`), djb2(password));
  }
  const presRef   = ref(db, `rooms/${roomId}/presence/${myUserId}`);
  const presData  = () => ({ username, joinedAt: Date.now(), lastSeen: Date.now() });
  set(presRef, presData());
  onDisconnect(presRef).remove();
  setInterval(() => set(presRef, presData()), 25000);

  // Watch presence for member count + panel
  let _prevPresenceKeys = new Set();
  onValue(ref(db, `rooms/${roomId}/presence`), snap => {
    const newMap = snap.exists() ? snap.val() : {};
    const newKeys = new Set(Object.keys(newMap));
    // Play join chime for newly arrived users (not on first load, not for self)
    if (_prevPresenceKeys.size > 0) {
      for (const uid of newKeys) {
        if (!_prevPresenceKeys.has(uid) && uid !== myUserId) {
          window.playJoinChime?.();
          // Post a join message to room chat
          const username = newMap[uid]?.username || 'Someone';
          window.appendRoomChatMsg?.({ username: '🔔 System', text: `${username} joined the room`, ts: Date.now(), system: true });
          break;
        }
      }
    }
    _prevPresenceKeys = newKeys;
    _presenceMap = newMap;
    renderMembersPanel(); // count update happens inside renderMembersPanel now
    // Host keeps lobby member count fresh
    if (window._isRoomHost) {
      set(ref(db, `rooms/${roomId}/meta/memberCount`), newKeys.size);
      set(ref(db, `rooms/${roomId}/meta/updatedAt`), Date.now());
    }
  });

  // Watch permissions
  onValue(ref(db, `rooms/${roomId}/permissions`), snap => {
    _permissionMap = snap.exists() ? snap.val() : {};
    // Update own control flag
    const myPerm = _permissionMap[myUserId];
    if (!window._isRoomHost) {
      window._canControl = !!(myPerm?.canControl);
      // Update badge code to show DJ status
      const codeEl = document.getElementById('room-badge-code');
      if (codeEl) codeEl.textContent = `#${roomId}${window._canControl ? ' 🎮' : ''}`;
    }
    // Dim controls for guests who can't control
    document.body.classList.toggle('room-guest', !!window._currentRoomId && !window._canControl);
    renderMembersPanel();
  });

  // All users listen to room state (filter own broadcasts via updatedBy).
  // The seek-lock loop manages the _applyingRemote echo-guard itself, so we no longer freeze
  // for a flat 700ms — we just skip our own echoes and identical re-applies.
  onValue(ref(db, `rooms/${roomId}/state`), snap => {
    const state = snap.val();
    if (!state || state.updatedBy === myUserId) return;
    applyRoomState(state);
  });

  // Instant sync on join: read the current state immediately and apply it, so a guest who joins
  // mid-song snaps to the right position without waiting for the host's next heartbeat.
  if (!isHost) {
    get(ref(db, `rooms/${roomId}/state`)).then(snap => {
      const state = snap.val();
      if (state && state.updatedBy !== myUserId) applyRoomState(state);
    }).catch(() => {});
  }

  // Host identity: guests watch it (label panel + detect a vanished host for takeover)
  if (!isHost) {
    onValue(ref(db, `rooms/${roomId}/hostUserId`), snap => {
      _roomHostUserId = snap.exists() ? snap.val() : null;
      renderMembersPanel();
    });
    // Detect a stale/absent host so we can surface a "Become host" affordance
    onValue(ref(db, `rooms/${roomId}/hostHeartbeat`), snap => {
      const ts = snap.exists() ? (snap.val()?.ts || 0) : 0;
      window._hostStale = (!_roomHostUserId) || (syncedNow() - ts > HOST_STALE_MS);
      renderMembersPanel();
    });
  }

  // Host-only listeners (also invoked when a guest is promoted via claimHost)
  if (isHost) _registerHostListeners(roomId);

  // Everyone: floating reaction emotes (ignore stale entries on join)
  const _reactJoinTs = Date.now();
  onChildAdded(ref(db, `rooms/${roomId}/reactions`), snap => {
    const r = snap.val();
    if (!r) return;
    if (r.ts && Date.now() - r.ts < 6000 && r.byId !== myUserId) {
      window.spawnReaction?.(r.emoji, r.byName);
    }
    // self-clean old nodes opportunistically
    if (r.ts && Date.now() - r.ts > 8000) remove(snap.ref);
  });

  // Room chat
  onChildAdded(ref(db, `rooms/${roomId}/messages`), snap => {
    const p = snap.val();
    if (p && window.appendRoomChatMsg) window.appendRoomChatMsg(p);
  });

  // Guests listen for being kicked
  if (!isHost) {
    onValue(ref(db, `rooms/${roomId}/kicked/${myUserId}`), snap => {
      if (snap.exists()) {
        if (window.toast) window.toast('You were removed from the room by the host.');
        setTimeout(() => window.leaveRoom(), 1500);
      }
    });
  }

  // Update header badge
  const badge  = document.getElementById('room-badge');
  const codeEl = document.getElementById('room-badge-code');
  if (badge)  badge.style.display = 'flex';
  if (codeEl) codeEl.textContent  = `#${roomId}${isHost ? ' 👑' : ''}`;

  // Host: reveal the (empty) song-requests badge
  if (isHost) window.renderRequestsPanel?.();
};

// Host grants/revokes DJ control to a guest
window.grantControl = function(userId) {
  if (!window._isRoomHost || !window._currentRoomId) return;
  set(ref(db, `rooms/${window._currentRoomId}/permissions/${userId}`), {
    canControl: true, grantedAt: Date.now(),
  });
};

window.revokeControl = function(userId) {
  if (!window._isRoomHost || !window._currentRoomId) return;
  remove(ref(db, `rooms/${window._currentRoomId}/permissions/${userId}`));
};

window.kickUser = function(userId) {
  if (!window._isRoomHost || !window._currentRoomId) return;
  set(ref(db, `rooms/${window._currentRoomId}/kicked/${userId}`), { kickedAt: Date.now() });
  remove(ref(db, `rooms/${window._currentRoomId}/presence/${userId}`));
  remove(ref(db, `rooms/${window._currentRoomId}/permissions/${userId}`));
};

window.guestAddToRoomQueue = function(v) {
  if (!window._currentRoomId) return;
  push(ref(db, `rooms/${window._currentRoomId}/guestQueue`), v);
  if (window.toast) window.toast('Added to room queue');
};

// ── Gated song requests (permission-less guests → host approval) ──
window.requestSong = function(v) {
  if (!window._currentRoomId || !v) return;
  const byName = localStorage.getItem('aq_username') || 'Guest';
  push(ref(db, `rooms/${window._currentRoomId}/requests`), {
    videoId: v.id || v.videoId || null,
    title: v.title || '', thumbnail: v.thumbnail || '',
    channelTitle: v.channelTitle || '',
    byName, byId: myUserId, ts: Date.now(),
  });
  if (window.toast) window.toast('🎵 Request sent to host');
};
window.approveRequest = function(reqId, video) {
  if (!window._isRoomHost || !window._currentRoomId) return;
  if (video && window.addToQueue) window.addToQueue(video);
  remove(ref(db, `rooms/${window._currentRoomId}/requests/${reqId}`));
};
window.declineRequest = function(reqId) {
  if (!window._isRoomHost || !window._currentRoomId) return;
  remove(ref(db, `rooms/${window._currentRoomId}/requests/${reqId}`));
};

// ── Floating reaction emotes ──
window.sendReaction = function(emoji) {
  if (!window._currentRoomId || !emoji) return;
  const byName = localStorage.getItem('aq_username') || 'Guest';
  push(ref(db, `rooms/${window._currentRoomId}/reactions`), { emoji, byName, byId: myUserId, ts: Date.now() });
  window.spawnReaction?.(emoji, byName); // show locally immediately
};

// ── Public room lobby ──
window.listPublicRooms = function(callback) {
  // Returns active rooms (fresh heartbeat, ≥1 member). Private rooms included but flagged locked.
  return onValue(ref(db, 'rooms'), snap => {
    const rooms = [];
    const all = snap.exists() ? snap.val() : {};
    const now = Date.now();
    for (const [id, room] of Object.entries(all)) {
      const m = room && room.meta;
      if (!m) continue;
      if ((m.memberCount || 0) < 1) continue;
      if (m.updatedAt && now - m.updatedAt > 120000) continue; // stale (>2min)
      rooms.push({ id, hostName: m.hostName || 'Guest', title: m.title || id,
        nowPlaying: m.nowPlaying || '', memberCount: m.memberCount || 1,
        isPrivate: !!m.isPrivate, hasPassword: !!m.hasPassword, updatedAt: m.updatedAt || 0 });
    }
    rooms.sort((a, b) => b.updatedAt - a.updatedAt);
    callback(rooms);
  });
};
window.checkRoomPassword = function(roomId, pw) {
  return get(ref(db, `rooms/${roomId}/auth`)).then(snap => {
    if (!snap.exists()) return true; // no password set
    return snap.val() === djb2(pw || '');
  }).catch(() => false);
};

window.sendRoomMessage = function(msg, imageData) {
  if (!window._currentRoomId) return;
  const username = localStorage.getItem('aq_username') || 'Guest';
  push(ref(db, `rooms/${window._currentRoomId}/messages`), {
    username, message: msg, imageData: imageData || null, timestamp: Date.now(),
  });
};

window.leaveRoom = function() {
  window.location.hash = '';
  window.location.reload();
};

// Global chat
window.listenGlobalChat = function(callback) {
  onChildAdded(ref(db, GLOBAL_CHAT_PATH), snap => {
    const p = snap.val();
    if (p) callback(p);
  });
};

window.sendGlobalMessage = function(msg, imageData) {
  const username = localStorage.getItem('aq_username') || 'Guest';
  push(ref(db, GLOBAL_CHAT_PATH), {
    username, message: msg, imageData: imageData || null, timestamp: Date.now(),
  });
};
