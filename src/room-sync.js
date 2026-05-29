import { ref, set, push, query, orderByChild, limitToLast, get, onValue, onChildAdded, onDisconnect, remove } from 'firebase/database';
import { db } from './firebase.js';
// Expose Firebase functions for leaderboard / lobby / reactions access from index.html
window._fbFns = { push, ref, query, orderByChild, limitToLast, get, set, remove, onValue, onChildAdded, onDisconnect };

// Lightweight non-cryptographic hash for password obfuscation (client-only model; not real security)
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < String(str).length; i++) h = ((h << 5) + h + String(str).charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
window._djb2 = djb2;

const GLOBAL_CHAT_PATH = 'globalChat';
const SEEK_TOLERANCE   = 3.0; // seconds before forcing a seek correction
const BROADCAST_DEBOUNCE = 350; // ms debounce for rapid state changes (seeking)

window._isRoomHost    = false;
window._canControl    = false; // true if host OR granted permission by host
window._applyingRemote = false;
window._currentRoomId  = null;

function genId(len = 8) {
  return Array.from({length: len}, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
}
const myUserId = localStorage.getItem('aq_user_id') || (() => {
  const id = genId(12); localStorage.setItem('aq_user_id', id); return id;
})();

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
      currentTime: (window.player && typeof window.player.getCurrentTime === 'function')
        ? Math.floor(window.player.getCurrentTime()) : 0,
      playing:    !!window.playing,
      queue:      window.queue || [],
      updatedBy:  myUserId,
      updatedAt:  Date.now(),
    });
    // Host keeps the lobby metadata fresh (now-playing + heartbeat)
    if (window._isRoomHost) {
      set(ref(db, `rooms/${window._currentRoomId}/meta/nowPlaying`), window.current?.title || '');
      set(ref(db, `rooms/${window._currentRoomId}/meta/updatedAt`), Date.now());
    }
  }, delay);
};

function applyRoomState(state) {
  if (!state.videoId) return;

  // Compensate for network/processing latency
  const elapsed = Math.min((Date.now() - (state.updatedAt || Date.now())) / 1000, 8);
  const targetTime = state.currentTime + (state.playing ? elapsed : 0);

  if (state.videoId !== (window.current?.id)) {
    // Different video — switch to it
    const v = {
      id:           state.videoId,
      title:        state.videoTitle || state.videoId,
      channelTitle: state.videoChannelTitle || '',
      thumbnail:    state.videoThumbnail || `https://i.ytimg.com/vi/${state.videoId}/mqdefault.jpg`,
      source:       'youtube',
    };
    if (window.playVideo) window.playVideo(v);
    setTimeout(() => {
      if (window.player && targetTime > 2) window.player.seekTo(targetTime, true);
      if (!state.playing && window.player) window.player.pauseVideo();
    }, 1500);
  } else {
    // Same video — correct drift
    if (window.player && typeof window.player.getCurrentTime === 'function') {
      const drift = Math.abs(window.player.getCurrentTime() - targetTime);
      if (drift > SEEK_TOLERANCE) window.player.seekTo(targetTime, true);
    }
    if (state.playing  && window.player && !window.playing) window.player.playVideo();
    if (!state.playing && window.player &&  window.playing) window.player.pauseVideo();
  }

  // Sync queue display
  if (state.queue && window.renderQueue) {
    window.queue = state.queue;
    window.renderQueue();
  }
}

// Presence + members panel state
let _presenceMap   = {}; // userId → {username, ...}
let _permissionMap = {}; // userId → {canControl, ...}

function renderMembersPanel() {
  const list = document.getElementById('room-members-list');
  if (!list) return;
  list.innerHTML = '';
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

window.initRoom = function(roomId, isHost, opts) {
  opts = opts || {};
  window._currentRoomId = roomId;
  window._isRoomHost    = isHost;
  window._canControl    = isHost;
  if (isHost) _roomHostUserId = myUserId;
  // Immediately dim controls for guests
  document.body.classList.toggle('room-guest', !isHost);

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

  // All users listen to room state (filter own broadcasts via updatedBy)
  onValue(ref(db, `rooms/${roomId}/state`), snap => {
    const state = snap.val();
    if (!state || state.updatedBy === myUserId) return;
    if (window._applyingRemote) return;
    window._applyingRemote = true;
    applyRoomState(state);
    setTimeout(() => { window._applyingRemote = false; }, 700);
  });

  // Host: listen for host identity record so members panel can label correctly
  if (isHost) {
    set(ref(db, `rooms/${roomId}/hostUserId`), myUserId);
  } else {
    onValue(ref(db, `rooms/${roomId}/hostUserId`), snap => {
      if (snap.exists()) _roomHostUserId = snap.val();
      renderMembersPanel();
    });
  }

  // Host: pick up guest queue additions
  if (isHost) {
    onChildAdded(ref(db, `rooms/${roomId}/guestQueue`), snap => {
      const v = snap.val();
      if (v && window.addToQueue) window.addToQueue(v);
      remove(snap.ref);
    });
  }

  // Host: pick up gated song requests from permission-less guests
  if (isHost) {
    onChildAdded(ref(db, `rooms/${roomId}/requests`), snap => {
      const req = snap.val();
      if (req) window.onSongRequest?.({ ...req, _id: snap.key });
    });
  }

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

  // Host: periodic heartbeat broadcast for late-joiners and drift correction
  if (isHost) {
    setInterval(function() {
      if (window._canControl && window._currentRoomId && !window._applyingRemote) {
        window.broadcastRoomState?.();
      }
    }, 15000);
  }

  // Update header badge
  const badge  = document.getElementById('room-badge');
  const codeEl = document.getElementById('room-badge-code');
  if (badge)  badge.style.display = 'flex';
  if (codeEl) codeEl.textContent  = `#${roomId}${isHost ? ' 👑' : ''}`;
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
