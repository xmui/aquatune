import { ref, set, push, onValue, onChildAdded, onDisconnect } from 'firebase/database';
import { db } from './firebase.js';

// Constants
const GLOBAL_CHAT_PATH = 'globalChat';
window._isRoomHost = false;
window._applyingRemote = false;
window._currentRoomId = null;

// Generate UUIDs for user/host identity
function genId(len=8) { return Array.from({length:len},()=>'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join(''); }
const myUserId = localStorage.getItem('aq_user_id') || (() => { const id=genId(12); localStorage.setItem('aq_user_id',id); return id; })();

window.initRoom = function(roomId, isHost) {
  window._currentRoomId = roomId;
  window._isRoomHost = isHost;

  // Presence
  const presRef = ref(db, `rooms/${roomId}/presence/${myUserId}`);
  const username = localStorage.getItem('aq_username') || 'Guest';
  set(presRef, { username, joinedAt: Date.now(), lastSeen: Date.now() });
  onDisconnect(presRef).remove();
  setInterval(() => set(presRef, { username, joinedAt: Date.now(), lastSeen: Date.now() }), 30000);

  // Member count
  onValue(ref(db, `rooms/${roomId}/presence`), snap => {
    const count = snap.exists() ? Object.keys(snap.val()).length : 0;
    const el = document.getElementById('room-badge-members');
    if (el) el.textContent = `👤 ${count}`;
  });

  if (isHost) {
    // Host: listen for guest queue additions
    onChildAdded(ref(db, `rooms/${roomId}/guestQueue`), snap => {
      const v = snap.val();
      if (v && window.addToQueue) { window.addToQueue(v); }
      // remove from guestQueue after processing
      set(snap.ref, null);
    });
  } else {
    // Guest: listen to room state from host
    onValue(ref(db, `rooms/${roomId}/state`), snap => {
      const state = snap.val();
      if (!state || state.updatedBy === myUserId) return;
      window._applyingRemote = true;
      applyRoomState(state);
      setTimeout(() => { window._applyingRemote = false; }, 600);
    });
  }

  // Room chat
  onChildAdded(ref(db, `rooms/${roomId}/messages`), snap => {
    const p = snap.val();
    if (!p) return;
    if (window.appendRoomChatMsg) window.appendRoomChatMsg(p);
  });

  // Update header badge
  const badge = document.getElementById('room-badge');
  const codeEl = document.getElementById('room-badge-code');
  if (badge) badge.style.display = 'flex';
  if (codeEl) codeEl.textContent = `#${roomId}${isHost ? ' 👑' : ''}`;

  // Update player lock for guests
  updatePlayerLock();
};

function applyRoomState(state) {
  if (!state.videoId) return;
  if (state.videoId !== (window.current?.id)) {
    // Different video — play it
    const v = { id: state.videoId, title: state.videoTitle || state.videoId, channelTitle: state.videoChannelTitle || '', thumbnail: state.videoThumbnail || `https://i.ytimg.com/vi/${state.videoId}/mqdefault.jpg`, source: 'youtube' };
    if (window.playVideo) window.playVideo(v);
    setTimeout(() => {
      if (window.player && state.currentTime > 2) window.player.seekTo(state.currentTime, true);
      if (!state.playing && window.player) window.player.pauseVideo();
    }, 1500);
  } else {
    // Same video — sync position and play/pause
    if (window.player && typeof window.player.getCurrentTime === 'function') {
      const delta = Math.abs(window.player.getCurrentTime() - state.currentTime);
      if (delta > 2.5) window.player.seekTo(state.currentTime, true);
    }
    if (state.playing && window.player && !window.playing) window.player.playVideo();
    if (!state.playing && window.player && window.playing) window.player.pauseVideo();
  }
  // Sync queue display
  if (state.queue && window.renderQueue) {
    window.queue = state.queue;
    window.renderQueue();
  }
}

function updatePlayerLock() {
  // Grey out and disable player controls for guests
  const overlay = document.getElementById('guest-player-lock');
  if (!overlay) return;
  overlay.style.display = window._isRoomHost || !window._currentRoomId ? 'none' : 'flex';
}

window.broadcastRoomState = function() {
  if (!window._currentRoomId || !window._isRoomHost || window._applyingRemote) return;
  const stateRef = ref(db, `rooms/${window._currentRoomId}/state`);
  const cur = window.current;
  set(stateRef, {
    videoId: cur?.id || null,
    videoTitle: cur?.title || '',
    videoChannelTitle: cur?.channelTitle || '',
    videoThumbnail: cur?.thumbnail || '',
    currentTime: (window.player && typeof window.player.getCurrentTime === 'function') ? Math.floor(window.player.getCurrentTime()) : 0,
    playing: !!window.playing,
    queue: window.queue || [],
    hostId: localStorage.getItem('aq_host_id') || '',
    updatedBy: myUserId,
    updatedAt: Date.now(),
  });
};

window.guestAddToRoomQueue = function(v) {
  // Guest pushes to guestQueue, host picks it up
  if (!window._currentRoomId) return;
  push(ref(db, `rooms/${window._currentRoomId}/guestQueue`), v);
  if (window.toast) window.toast('Added to room queue');
};

window.sendRoomMessage = function(msg, imageData) {
  if (!window._currentRoomId) return;
  const username = localStorage.getItem('aq_username') || 'Guest';
  push(ref(db, `rooms/${window._currentRoomId}/messages`), {
    username, message: msg, imageData: imageData || null, timestamp: Date.now()
  });
};

window.leaveRoom = function() {
  // Clear hash, reload to go to splash
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
    username, message: msg, imageData: imageData || null, timestamp: Date.now()
  });
};
