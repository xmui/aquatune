import { ref, set, push, onValue, onChildAdded, onDisconnect, remove } from 'firebase/database';
import { db } from './firebase.js';

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

window.initRoom = function(roomId, isHost) {
  window._currentRoomId = roomId;
  window._isRoomHost    = isHost;
  window._canControl    = isHost;
  if (isHost) _roomHostUserId = myUserId;
  // Immediately dim controls for guests
  document.body.classList.toggle('room-guest', !isHost);

  // Write own presence
  const username  = localStorage.getItem('aq_username') || 'Guest';
  const presRef   = ref(db, `rooms/${roomId}/presence/${myUserId}`);
  const presData  = () => ({ username, joinedAt: Date.now(), lastSeen: Date.now() });
  set(presRef, presData());
  onDisconnect(presRef).remove();
  setInterval(() => set(presRef, presData()), 25000);

  // Watch presence for member count + panel
  let _prevPresenceSize = 0;
  onValue(ref(db, `rooms/${roomId}/presence`), snap => {
    const newMap = snap.exists() ? snap.val() : {};
    const newSize = Object.keys(newMap).length;
    // Play join chime when someone new appears (skip first load and own join)
    if (_prevPresenceSize > 0 && newSize > _prevPresenceSize) {
      if (window.playTone) window.playTone(528, 0.14, 'sine', 0.12);
    }
    _prevPresenceSize = newSize;
    _presenceMap = newMap;
    renderMembersPanel(); // count update happens inside renderMembersPanel now
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

window.sendRoomMessage = function(msg, imageData) {
  if (!window._currentRoomId) return;
  const username = localStorage.getItem('aq_username') || 'Guest';
  push(ref(db, `rooms/${window._currentRoomId}/messages`), {
    username, message: msg, imageData: imageData || null, timestamp: Date.now(),
  });
};

window.leaveRoom = function() {
  sessionStorage.removeItem('aq_sess_room');
  sessionStorage.removeItem('aq_sess_host');
  sessionStorage.removeItem('aq_sess_ts');
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
