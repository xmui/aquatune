import { db } from './firebase.js';
import { ref, push, remove, onChildAdded, onChildRemoved } from 'firebase/database';

const MESSAGES_PATH = 'messages';

// Local mirror of all posts keyed by Firebase push ID
const allPosts = new Map();

// Map Firebase field names → what boardRenderPosts() expects
function normalizePost(key, data) {
  return {
    _key:  key,
    no:    key,
    name:  data.username  || data.name || 'Anonymous',
    com:   data.content   || data.com  || '',
    sub:   data.sub       || '',
    ts:    data.timestamp || data.ts   || Date.now(),
  };
}

function sortedPosts() {
  return [...allPosts.values()].sort((a, b) => a.ts - b.ts);
}

function renderAndScroll(forceScroll = false) {
  if (typeof boardRenderPosts !== 'function') return;
  const log = document.getElementById('board-log');
  const wasAtBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  boardRenderPosts(sortedPosts());
  if (log && (forceScroll || wasAtBottom)) log.scrollTop = log.scrollHeight;
}

// ── Real-time listeners ──────────────────────────────────────
const messagesRef = ref(db, MESSAGES_PATH);

onChildAdded(messagesRef, (snapshot) => {
  allPosts.set(snapshot.key, normalizePost(snapshot.key, snapshot.val()));
  renderAndScroll();
  if (typeof updateChatBadge === 'function') updateChatBadge(allPosts.size);
});

onChildRemoved(messagesRef, (snapshot) => {
  allPosts.delete(snapshot.key);
  renderAndScroll();
  if (typeof updateChatBadge === 'function') updateChatBadge(allPosts.size);
});

// ── Override global chat functions ───────────────────────────

window.boardFbEnabled = () => true;

window.boardLoadAndRender = async function () {
  renderAndScroll();
  if (typeof boardUpdateBadge === 'function') boardUpdateBadge();
};

window.boardStartSse = function () {};
window.boardStopSse  = function () {};

window.boardPost = async function (e) {
  e?.preventDefault();
  const nameEl = document.getElementById('bf-name');
  const msgEl  = document.getElementById('bf-msg');
  const subEl  = document.getElementById('bf-subject');
  const username = nameEl?.value.trim() || 'Anonymous';
  const content  = msgEl?.value.trim();
  const sub      = subEl?.value.trim() || '';
  if (!content) return;

  const btn = document.getElementById('board-send-btn');
  if (btn) btn.disabled = true;
  try {
    await push(messagesRef, { username, content, sub, timestamp: Date.now() });
    if (nameEl) nameEl.value = '';
    if (msgEl)  msgEl.value  = '';
    if (subEl)  subEl.value  = '';
    const log = document.getElementById('board-log');
    if (log) log.scrollTop = log.scrollHeight;
  } catch (err) {
    console.error('[AquaChat] send failed:', err);
    if (typeof toast === 'function') toast('Send failed — check console');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.boardDelete = async function (keyOrNo) {
  const key = typeof keyOrNo === 'string' ? keyOrNo : String(keyOrNo);
  try {
    await remove(ref(db, `${MESSAGES_PATH}/${key}`));
    // onChildRemoved will update allPosts + re-render
  } catch (err) {
    console.error('[AquaChat] delete failed:', err);
  }
};

window.boardClearAll = async function () {
  if (!confirm('Delete ALL messages? This cannot be undone.')) return;
  const keys = [...allPosts.keys()];
  await Promise.all(keys.map(k => remove(ref(db, `${MESSAGES_PATH}/${k}`)).catch(() => {})));
  // onChildRemoved fires will clear allPosts incrementally
};

window.boardSaveFirebase = function () {
  if (typeof toast === 'function') toast('Firebase is auto-configured via environment variables ✓');
};

// ── DOM tweaks once the page is ready ───────────────────────
(function applyDomTweaks() {
  // Hide the manual Firebase URL bar — no longer needed
  const fbBar = document.querySelector('.board-fb-bar');
  if (fbBar) {
    fbBar.style.display = 'none';
  } else {
    // If the bar isn't in DOM yet (shouldn't happen with deferred modules, but be safe)
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelector('.board-fb-bar')?.style.setProperty('display', 'none');
    });
  }

  // Flip badge to Live immediately
  const badge = document.getElementById('board-fb-badge');
  if (badge) { badge.textContent = '● Live'; badge.className = 'board-fb-badge'; }
})();
