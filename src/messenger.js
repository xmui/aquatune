// Aquatune Messenger — a Windows Live Messenger / Vista-era chat.
//
// A main "contacts" window shows who's online (your buddy avatars, aka "Aquatards"),
// your DMs, and pinned Room + Global chats at the top. Clicking any entry opens a
// separate, draggable conversation window (multiple at once). Status + personal
// message, emoticons, a Nudge that shakes the window, and sounds. Full 1:1 DMs +
// global presence over Firebase. Account-gated (no account ⇒ no presence/DMs).
//
// Transport reuses room-sync's window.sendGlobalMessage / listenGlobalChat /
// sendRoomMessage; presence + DMs go through window._fbFns on window._aqDb.

// ── firebase helpers ────────────────────────────────────────────────────────────
const F = () => window._fbFns || {};
const DB = () => window._aqDb;
function fref(p) { return F().ref(DB(), p); }
function fbReady() { return !!(window._fbFns && window._aqDb); }
function uid() { return (window.effectiveUserId && window.effectiveUserId()) || localStorage.getItem('aq_user_id') || 'anon'; }
function myName() { return (window.currentDisplayName && window.currentDisplayName()) || localStorage.getItem('aq_username') || 'Guest'; }
function hasAcct() { return !!window._aqAccountId; }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function sfx(n) { try { window.msnSfx && window.msnSfx(n); } catch (e) {} }
function clean(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/data:[^\s"'<>)]+/gi, '').slice(0, 500); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function isMobile() { return typeof matchMedia === 'function' && matchMedia('(max-width:768px)').matches; }
function pairKey(a, b) { return [a, b].sort().join('__'); }

function myOutfitKey() {
  const keys = window.aqBuddyOutfitKeys || ['none'];
  let i = parseInt(localStorage.getItem('yt_buddy_outfit') || '0', 10);
  if (!(i >= 0 && i < keys.length)) i = 0;
  return keys[i];
}

// ── Aquatard avatar — delegates to the unified buddy renderer when available ──────
// Accepts either a full buddy config object or a legacy outfit-key string.
let _avid = 0;
function buddyAvatarSvg(cfgOrKey, size) {
  const cfg = (cfgOrKey && typeof cfgOrKey === 'object') ? cfgOrKey : { outfit: cfgOrKey };
  if (typeof window.aqBuildBuddySvg === 'function') return window.aqBuildBuddySvg(cfg, { size });
  const id = 'mav' + (_avid++) + '_';
  const outfitKey = cfg.outfit;
  const hat = (window.aqBuddyOutfits && window.aqBuddyOutfits[outfitKey]) || '';
  const h = ['#c8f2ff', '#38c4f0', '#003d6a'], b = ['#b8ecff', '#0082bc', '#003058'];
  return `<svg viewBox="0 0 100 112" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" style="display:block">
    <defs>
      <radialGradient id="${id}h" cx="36%" cy="30%" r="65%"><stop offset="0%" stop-color="${h[0]}"/><stop offset="55%" stop-color="${h[1]}"/><stop offset="100%" stop-color="${h[2]}"/></radialGradient>
      <radialGradient id="${id}b" cx="30%" cy="22%" r="74%"><stop offset="0%" stop-color="${b[0]}"/><stop offset="55%" stop-color="${b[1]}"/><stop offset="100%" stop-color="${b[2]}"/></radialGradient>
    </defs>
    <ellipse cx="50" cy="109" rx="23" ry="3.5" fill="rgba(0,0,0,0.16)"/>
    <path d="M 17 103 Q 13 73 50 65 Q 87 73 83 103 Q 80 110 50 110 Q 20 110 17 103 Z" fill="url(#${id}b)"/>
    <ellipse cx="9" cy="82" rx="12" ry="8.5" fill="url(#${id}b)" transform="rotate(-30 9 82)"/>
    <ellipse cx="91" cy="82" rx="12" ry="8.5" fill="url(#${id}b)" transform="rotate(30 91 82)"/>
    <ellipse cx="50" cy="64" rx="14" ry="5.5" fill="url(#${id}b)"/>
    <circle cx="50" cy="33" r="27" fill="url(#${id}h)"/>
    <ellipse cx="38" cy="22" rx="12" ry="8" fill="rgba(255,255,255,0.66)" transform="rotate(-28 38 22)"/>
    <circle cx="43" cy="35" r="5" fill="#001e38"/><circle cx="57" cy="35" r="5" fill="#001e38"/>
    <circle cx="41.5" cy="33.5" r="1.9" fill="#fff"/><circle cx="55.5" cy="33.5" r="1.9" fill="#fff"/>
    <path d="M 43.5 43.5 Q 50 50.5 56.5 43.5" stroke="#001e38" stroke-width="2.3" fill="none" stroke-linecap="round" stroke-opacity="0.82"/>
    ${hat}
  </svg>`;
}

// ── module state ─────────────────────────────────────────────────────────────────
const STATUS = { online: { dot: '#3fc04a', label: 'Online' }, away: { dot: '#e8b53a', label: 'Away' }, busy: { dot: '#e0463a', label: 'Busy' }, invisible: { dot: '#8a8f98', label: 'Appear offline' } };
let _built = false, _styleInjected = false, _presStarted = false, _presTimer = null;
let _myStatus = 'online', _myMsg = '';
let _lastActive = Date.now();
let _users = {};                 // uid -> presence record
const _convs = {};               // key -> { win, log, unsub, focused }
const _unread = {};              // otherUid -> count
const _seenTs = {};              // otherUid -> last DM index ts we've accounted for
let _dmIndex = {};               // dm-index/<me>

function effStatus() {
  if (_myStatus === 'online' && Date.now() - _lastActive > 5 * 60 * 1000) return 'away';   // idle auto-away
  return _myStatus;
}

// ── presence ─────────────────────────────────────────────────────────────────────
function myBuddyCfg() { try { return (window.aqBuddyConfig && window.aqBuddyConfig()) || null; } catch (e) { return null; } }
function writePresence() {
  if (!hasAcct() || !fbReady()) return;
  F().set(fref('users/' + uid()), { username: myName(), status: effStatus(), statusMsg: _myMsg.slice(0, 80), buddyOutfit: myOutfitKey(), buddyCfg: myBuddyCfg(), lastSeen: Date.now() }).catch(() => {});
}
function startPresence() {
  if (_presStarted || !hasAcct() || !fbReady()) return;
  _presStarted = true;
  _myStatus = localStorage.getItem('aq_msn_status') || 'online';
  _myMsg = localStorage.getItem('aq_msn_statusmsg') || '';
  try { F().onDisconnect(fref('users/' + uid())).remove(); } catch (e) {}
  writePresence();
  _presTimer = setInterval(writePresence, 30000);
  ['mousemove', 'keydown', 'pointerdown', 'touchstart'].forEach(ev => window.addEventListener(ev, () => { _lastActive = Date.now(); }, { passive: true }));
  // live contact list + DM activity
  F().onValue(fref('users'), snap => { _users = snap.val() || {}; renderContacts(); });
  F().onValue(fref('dm-index/' + uid()), snap => { _dmIndex = snap.val() || {}; onDmIndex(); });
  sfx('signin');
}
function setStatus(s) { _myStatus = s; try { localStorage.setItem('aq_msn_status', s); window.aqGamePersist && window.aqGamePersist('aq_msn_status'); } catch (e) {} writePresence(); renderContacts(); }
function setStatusMsg(t) { _myMsg = clean(t).slice(0, 80); try { localStorage.setItem('aq_msn_statusmsg', _myMsg); window.aqGamePersist && window.aqGamePersist('aq_msn_statusmsg'); } catch (e) {} writePresence(); }

// New-DM detection from the dm-index: bump unread + notify for incoming messages.
function onDmIndex() {
  for (const other in _dmIndex) {
    const e = _dmIndex[other]; if (!e) continue;
    if ((e.lastTs || 0) > (_seenTs[other] || 0)) {
      const incoming = e.from && e.from !== uid();
      const conv = _convs['dm:' + other];
      const openFocused = conv && conv.focused && !conv.win.classList.contains('msn-min');
      if (incoming && !openFocused) {
        _unread[other] = (_unread[other] || 0) + 1;
        sfx('msg');
        const oid = other, oname = e.withName || 'Aquatard';
        try { window.aqNotify && window.aqNotify({ name: oname, text: e.lastMsg || 'sent a message', onClick: () => openConversation('dm:' + oid, oname, oid) }); } catch (er) {}
      }
      _seenTs[other] = e.lastTs || 0;
    }
  }
  renderContacts();
}

// ── DM transport ─────────────────────────────────────────────────────────────────
function sendDm(toUid, toName, text, type) {
  if (!fbReady() || !hasAcct()) return;
  const k = pairKey(uid(), toUid), now = Date.now();
  const message = type === 'nudge' ? '' : clean(text);
  if (type !== 'nudge' && !message) return;
  F().push(fref('dms/' + k + '/messages'), { fromId: uid(), username: myName(), message, type: type || 'msg', timestamp: now }).catch(() => {});
  const preview = type === 'nudge' ? '👋 Nudge!' : message;
  F().set(fref('dm-index/' + uid() + '/' + toUid), { lastMsg: preview, lastTs: now, from: uid(), withName: toName }).catch(() => {});
  F().set(fref('dm-index/' + toUid + '/' + uid()), { lastMsg: preview, lastTs: now, from: uid(), withName: myName() }).catch(() => {});
}

// ── conversation windows ─────────────────────────────────────────────────────────
let _z = 820;
function focusWin(w) { w.style.zIndex = ++_z; }
function makeDrag(win, handle) {
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  handle.addEventListener('pointerdown', e => {
    if (isMobile() || e.target.closest('button,select,input,textarea')) return;
    dragging = true; sx = e.clientX; sy = e.clientY;
    const r = win.getBoundingClientRect(); ox = r.left; oy = r.top;
    win.style.left = ox + 'px'; win.style.top = oy + 'px'; win.style.right = 'auto'; win.style.bottom = 'auto';
    focusWin(win); e.preventDefault();
    const mv = ev => { if (!dragging) return; win.style.left = (ox + ev.clientX - sx) + 'px'; win.style.top = Math.max(0, oy + ev.clientY - sy) + 'px'; };
    const up = () => { dragging = false; window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });
}

function convTitle(key, name) {
  if (key === 'global') return '🌐 Global Chat';
  if (key === 'room') return '🚪 Room Chat';
  if (key === 'system') return '🛡️ System Log';
  return '😎 ' + esc(name || 'Aquatard');
}
function isAdmin() { try { return !!(window.aqCurrentAccount && window.aqCurrentAccount() && window.aqCurrentAccount().admin); } catch (e) { return false; } }
function appendMsg(log, p) {
  if (p && p.type === 'nudge') { const d = el('div', 'msn-sys', `👋 ${esc(p.username || 'Someone')} sent a nudge!`); log.appendChild(d); log.scrollTop = 99999; return; }
  if (typeof window.renderChatMsg === 'function') window.renderChatMsg(log, p);
  else { const d = el('div', 'bmsg', `<b>${esc(p.username || 'Anon')}:</b> ${esc(p.message || '')}`); log.appendChild(d); log.scrollTop = 99999; }
}

const EMOTES = ['😀', '😂', '😉', '😎', '😍', '😭', '😡', '👍', '👎', '❤️', '🔥', '🎉', '😈', '💀', '🙄', '😴'];

// On phones, show a single messenger window at a time (avoids full-screen windows
// stacking on top of and blocking each other).
function mobileSolo(key) {
  if (!isMobile()) return;
  if (_contactsWin) _contactsWin.style.display = 'none';
  for (const k in _convs) if (k !== key) _convs[k].win.style.display = 'none';
}
function showContacts() { if (_contactsWin) { _contactsWin.style.display = 'flex'; focusWin(_contactsWin); } }

function openConversation(key, name, otherUid) {
  // A conversation can be opened "cold" straight from a notification tap before
  // the Messenger has ever been opened this session — make sure the stylesheet and
  // presence are live, otherwise the (mobile) window renders unstyled and the
  // user gets stuck with no working back/close button.
  injectStyle();
  startPresence();
  let c = _convs[key];
  if (c) { c.win.classList.remove('msn-min'); c.win.style.display = 'flex'; mobileSolo(key); focusWin(c.win); markRead(key, otherUid); c.input && c.input.focus(); return; }

  const win = el('div', 'msn-win msn-conv' + (isMobile() ? ' msn-mobile' : ''));
  const bar = el('div', 'msn-titlebar');
  bar.innerHTML = `<span class="msn-tt">${convTitle(key, name)}</span>`;
  const closeBtn = el('button', 'msn-x', '✕'); closeBtn.onclick = () => closeConversation(key);
  if (isMobile()) { const back = el('button', 'msn-back', '‹ Contacts'); back.onclick = () => closeConversation(key); bar.prepend(back); bar.append(closeBtn); }
  else { const minBtn = el('button', 'msn-min-btn', '—'); minBtn.onclick = () => { win.classList.add('msn-min'); win.style.display = 'none'; }; bar.append(minBtn, closeBtn); }
  const log = el('div', 'msn-log');
  let ta = null;            // null for read-only channels (system)
  win.append(bar, log);
  if (key !== 'system') {   // System is a read-only admin feed — no composer
    const tools = el('div', 'msn-tools');
    const emoBtn = el('button', 'msn-tool-btn', '☺'); emoBtn.title = 'Emoticons';
    const emoBar = el('div', 'msn-emobar'); emoBar.style.display = 'none';
    EMOTES.forEach(em => { const b = el('button', 'msn-emo', em); b.onclick = () => { ta.value += em; ta.focus(); }; emoBar.appendChild(b); });
    emoBtn.onclick = () => { emoBar.style.display = emoBar.style.display === 'none' ? 'flex' : 'none'; };
    tools.appendChild(emoBtn);
    if (key.startsWith('dm:')) { const nudge = el('button', 'msn-tool-btn', '👋 Nudge'); nudge.onclick = () => doNudge(key, otherUid, name); tools.appendChild(nudge); }
    const inputRow = el('div', 'msn-input-row');
    ta = el('textarea', 'msn-input'); ta.maxLength = 500; ta.placeholder = 'Type a message…';
    const sendBtn = el('button', 'msn-send', 'Send');
    const doSend = () => {
      const v = ta.value.trim(); if (!v) return;
      if (key === 'global') window.sendGlobalMessage && window.sendGlobalMessage(v);
      else if (key === 'room') { if (window._currentRoomId) window.sendRoomMessage && window.sendRoomMessage(v); }
      else sendDm(otherUid, name, v);
      ta.value = ''; sfx('send');
    };
    sendBtn.onclick = doSend;
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    inputRow.append(ta, sendBtn);
    win.append(emoBar, tools, inputRow);
  }
  if (!isMobile()) { const n = Object.keys(_convs).length; win.style.left = (90 + n * 26) + 'px'; win.style.top = (70 + n * 26) + 'px'; }
  document.body.appendChild(win);
  makeDrag(win, bar);
  win.addEventListener('pointerdown', () => { focusWin(win); markRead(key, otherUid); c.focused = true; }, true);
  mobileSolo(key);
  focusWin(win);

  c = _convs[key] = { win, log, input: ta, focused: true, unsub: null };
  attachListener(key, otherUid, log);
  if (key === 'room' && !window._currentRoomId) { log.appendChild(el('div', 'msn-sys', 'Join or create a public room to chat here.')); }
  markRead(key, otherUid);
  if (ta) ta.focus();
}
function closeConversation(key) {
  const c = _convs[key]; if (!c) return;
  if (c.unsub) { try { c.unsub(); } catch (e) {} }
  c.win.remove(); delete _convs[key];
  if (isMobile()) { const other = Object.keys(_convs)[0]; if (other) { _convs[other].win.style.display = 'flex'; focusWin(_convs[other].win); } else showContacts(); }
}
function attachListener(key, otherUid, log) {
  const c = _convs[key]; if (!c || !fbReady()) return;
  log.innerHTML = '';
  if (key === 'system') { if (window.listenSystemLog) c.unsub = window.listenSystemLog(e => { const d = el('div', 'msn-sys', `${esc(e.text || '')}`); log.appendChild(d); log.scrollTop = 99999; }); return; }
  if (key === 'global') { window.listenGlobalChat && window.listenGlobalChat(p => appendMsg(log, p)); return; }
  if (key === 'room') {
    if (!window._currentRoomId) return;
    c.unsub = F().onChildAdded(fref('rooms/' + window._currentRoomId + '/messages'), snap => { const p = snap.val(); if (p) appendMsg(log, p); });
    return;
  }
  // dm
  const k = pairKey(uid(), otherUid);
  c.unsub = F().onChildAdded(fref('dms/' + k + '/messages'), snap => {
    const p = snap.val(); if (!p) return;
    if (p.type === 'nudge') { if (p.fromId !== uid()) nudgeShake(c.win); appendMsg(log, { type: 'nudge', username: p.username }); return; }
    appendMsg(log, p);
    if (p.fromId !== uid() && c.focused && !c.win.classList.contains('msn-min')) markRead(key, otherUid);
  });
}
function markRead(key, otherUid) {
  if (key.startsWith('dm:') && otherUid) { _unread[otherUid] = 0; renderContacts(); }
}
function doNudge(key, otherUid, name) {
  const c = _convs[key]; if (!c) return;
  const now = Date.now(); if (now - (c._lastNudge || 0) < 5000) return; c._lastNudge = now;   // 1 / 5s
  sendDm(otherUid, name, '', 'nudge'); nudgeShake(c.win); sfx('nudge');
}
function nudgeShake(win) { win.classList.remove('msn-nudge'); void win.offsetWidth; win.classList.add('msn-nudge'); }

// re-point the room conversation when the room changes (joined / left / switched)
window.msnOnRoomChange = function () {
  const c = _convs['room'];
  if (c) { if (c.unsub) { try { c.unsub(); } catch (e) {} } attachListener('room', null, c.log); if (!window._currentRoomId) c.log.appendChild(el('div', 'msn-sys', 'Join or create a public room to chat here.')); }
  renderContacts();
};

// ── contacts window ──────────────────────────────────────────────────────────────
let _contactsWin = null, _searchTerm = '';

// ── customizable banner (MSN-style top strip) ────────────────────────────────────
const BANNER_THEMES = [
  'linear-gradient(135deg,#1e6fd0,#7db8f0)',
  'linear-gradient(135deg,#7a2fc0,#e08adf)',
  'linear-gradient(135deg,#0f9d58,#7be0a0)',
  'linear-gradient(135deg,#e0463a,#ffae8a)',
  'linear-gradient(135deg,#16213a,#3a5a8a)',
  'linear-gradient(135deg,#ff8a00,#ffd23a)',
];
let _banner = null;
function loadBanner() {
  if (_banner) return _banner;
  try { _banner = JSON.parse(localStorage.getItem('aq_msn_banner') || 'null'); } catch (e) { _banner = null; }
  if (!_banner || typeof _banner !== 'object') _banner = { text: '♪ Aquatune Messenger ♪', theme: 0 };
  return _banner;
}
function saveBanner() {
  try { localStorage.setItem('aq_msn_banner', JSON.stringify(_banner)); window.aqGamePersist && window.aqGamePersist('aq_msn_banner'); } catch (e) {}
}
function renderBanner() {
  const box = _contactsWin && _contactsWin.querySelector('.msn-banner'); if (!box) return;
  const b = loadBanner();
  box.style.background = BANNER_THEMES[b.theme % BANNER_THEMES.length];
  box.innerHTML = `<span class="msn-banner-txt" title="Click to edit your banner">${esc(b.text)}</span><button class="msn-banner-theme" title="Change theme">🎨</button>`;
  box.querySelector('.msn-banner-txt').onclick = () => {
    const v = prompt('Your banner:', b.text); if (v == null) return;
    b.text = String(v).slice(0, 60); saveBanner(); renderBanner();
  };
  box.querySelector('.msn-banner-theme').onclick = e => { e.stopPropagation(); b.theme = (b.theme + 1) % BANNER_THEMES.length; saveBanner(); renderBanner(); };
}
function buildContactsWin() {
  const win = el('div', 'msn-win msn-contacts' + (isMobile() ? ' msn-mobile' : ''));
  win.innerHTML = `
    <div class="msn-titlebar msn-cbar"><span class="msn-tt">💬 Aquatune Messenger</span><button class="msn-x" data-act="close">✕</button></div>
    <div class="msn-banner" data-act="banner"></div>
    <div class="msn-me"></div>
    <input class="msn-search" placeholder="Search Aquatards…">
    <div class="msn-list"></div>`;
  document.body.appendChild(win);
  win.querySelector('[data-act="close"]').onclick = () => { win.style.display = 'none'; document.querySelector('.dock-item[data-dock="chat"]')?.classList.remove('active'); };
  const bar = win.querySelector('.msn-titlebar');
  makeDrag(win, bar);
  win.addEventListener('pointerdown', () => focusWin(win), true);
  const search = win.querySelector('.msn-search');
  search.addEventListener('input', () => { _searchTerm = search.value.toLowerCase(); renderList(); });
  if (!isMobile()) { win.style.right = '24px'; win.style.top = '54px'; }
  _contactsWin = win;
  renderContacts();
}

function renderContacts() { if (_contactsWin) { renderBanner(); renderMe(); renderList(); } }
function renderMe() {
  const box = _contactsWin && _contactsWin.querySelector('.msn-me'); if (!box) return;
  if (!hasAcct()) { box.innerHTML = `<div class="msn-signin">Sign in to chat with people, send DMs and show up online.</div>`; return; }
  const st = STATUS[effStatus()] || STATUS.online;
  box.innerHTML = `
    <div class="msn-me-av" style="--dot:${st.dot}">${buddyAvatarSvg(myBuddyCfg() || myOutfitKey(), 46)}</div>
    <div class="msn-me-info">
      <div class="msn-me-top"><span class="msn-me-name">${esc(myName())}</span>
        <select class="msn-status-sel">${Object.keys(STATUS).map(k => `<option value="${k}"${k === _myStatus ? ' selected' : ''}>${STATUS[k].label}</option>`).join('')}</select>
      </div>
      <input class="msn-me-msg" maxlength="80" placeholder="&lt;Type a personal message&gt;" value="${esc(_myMsg)}">
    </div>`;
  box.querySelector('.msn-status-sel').onchange = e => setStatus(e.target.value);
  const mi = box.querySelector('.msn-me-msg');
  mi.onblur = () => setStatusMsg(mi.value);
  mi.onkeydown = e => { if (e.key === 'Enter') { mi.blur(); } };
}
function contactRow(name, sub, dotColor, avatarOutfit, onClick, unread) {
  const row = el('div', 'msn-row');
  const badge = unread ? `<span class="msn-unread">${unread}</span>` : '';
  row.innerHTML = `<div class="msn-row-av"${dotColor ? ` style="--dot:${dotColor}"` : ''}>${avatarOutfit != null ? buddyAvatarSvg(avatarOutfit, 30) : '<span class="msn-pin-ico">' + sub.ico + '</span>'}</div>
    <div class="msn-row-body"><div class="msn-row-name">${esc(name)}${badge}</div><div class="msn-row-sub">${esc(sub.text != null ? sub.text : sub)}</div></div>`;
  row.onclick = onClick;
  return row;
}
function renderList() {
  const list = _contactsWin && _contactsWin.querySelector('.msn-list'); if (!list) return;
  list.innerHTML = '';
  // pinned chats
  const pinned = el('div', 'msn-section');
  pinned.appendChild(contactRow('Room Chat', { ico: '🚪', text: window._currentRoomId ? ('Room ' + window._currentRoomId) : 'Not in a room' }, null, null, () => openConversation('room', 'Room Chat')));
  pinned.appendChild(contactRow('Global Chat', { ico: '🌐', text: 'Everyone on Aquatune' }, null, null, () => openConversation('global', 'Global Chat')));
  if (isAdmin()) pinned.appendChild(contactRow('System Log', { ico: '🛡️', text: 'Admin · site events' }, null, null, () => openConversation('system', 'System Log')));
  list.appendChild(pinned);
  if (!hasAcct()) return;
  // partition online / offline
  const me = uid(), now = Date.now(), online = [], offline = [];
  for (const id in _users) {
    if (id === me) continue;
    const u = _users[id]; if (!u) continue;
    if (_searchTerm && !(u.username || '').toLowerCase().includes(_searchTerm)) continue;
    const fresh = now - (u.lastSeen || 0) < 90000;
    (fresh && u.status !== 'invisible' ? online : offline).push([id, u]);
  }
  const sortByName = (a, b) => (a[1].username || '').localeCompare(b[1].username || '');
  online.sort(sortByName); offline.sort(sortByName);
  const addSection = (title, arr, dim) => {
    if (!arr.length) return;
    const sec = el('div', 'msn-section');
    sec.appendChild(el('div', 'msn-sec-hd', `${title} (${arr.length})`));
    for (const [id, u] of arr) {
      const st = STATUS[u.status] || STATUS.online;
      const row = contactRow(u.username || 'Aquatard', u.statusMsg || '', dim ? '#8a8f98' : st.dot, u.buddyCfg || u.buddyOutfit || 'none', () => openConversation('dm:' + id, u.username, id), _unread[id]);
      if (dim) row.classList.add('msn-off');
      sec.appendChild(row);
    }
    list.appendChild(sec);
  };
  addSection('Online', online, false);
  addSection('Offline', offline, true);
}

// ── styles ───────────────────────────────────────────────────────────────────────
function injectStyle() {
  if (_styleInjected) return; _styleInjected = true;
  const s = el('style'); s.id = 'msn-style';
  s.textContent = `
  .msn-win{position:fixed;display:flex;flex-direction:column;background:linear-gradient(180deg,#eaf4ff,#dbecfb);border:1px solid #6f9fd0;border-radius:9px;box-shadow:0 12px 34px rgba(0,40,90,.4),inset 0 1px 0 rgba(255,255,255,.9);font-family:'Segoe UI',system-ui,sans-serif;color:#0a2a4a;overflow:hidden;z-index:820}
  .msn-contacts{width:300px;height:520px;max-width:94vw;max-height:88vh}
  .msn-conv{width:380px;height:440px;max-width:94vw}
  .msn-titlebar{display:flex;align-items:center;gap:6px;padding:6px 8px;cursor:move;background:linear-gradient(180deg,#eaf4ff 0%,#bcd9f5 48%,#9cc4ec 100%);border-bottom:1px solid #6f9fd0;box-shadow:inset 0 1px 0 rgba(255,255,255,.85);user-select:none}
  .msn-tt{flex:1;font-weight:700;font-size:13px;color:#103a66;text-shadow:0 1px 0 rgba(255,255,255,.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .msn-x,.msn-min-btn{width:20px;height:18px;border:1px solid #7fa6cf;border-radius:4px;background:linear-gradient(180deg,#fff,#cfe0f4);cursor:pointer;font-size:11px;line-height:1;color:#0a2a4a}
  .msn-back{margin-right:6px;border:1px solid #7fa6cf;border-radius:5px;background:linear-gradient(180deg,#fff,#cfe0f4);cursor:pointer;font-size:13px;font-weight:700;color:#0a3a66;padding:3px 9px}
  .msn-x:hover{background:linear-gradient(180deg,#ffd0d0,#f08a8a)}
  .msn-banner{position:relative;min-height:46px;display:flex;align-items:center;justify-content:center;padding:8px 34px;color:#fff;font-weight:800;text-align:center;text-shadow:0 1px 3px rgba(0,0,0,.45);border-bottom:1px solid #6f9fd0;cursor:pointer;overflow:hidden}
  .msn-banner-txt{cursor:text}
  .msn-banner-theme{position:absolute;right:6px;top:6px;border:none;background:rgba(255,255,255,.25);border-radius:6px;cursor:pointer;font-size:13px;padding:2px 5px}
  .msn-me{display:flex;gap:10px;align-items:center;padding:9px 10px;background:linear-gradient(180deg,#fdfdff,#e7f1fc);border-bottom:1px solid #c4d8ef}
  .msn-me-av,.msn-row-av{position:relative;flex-shrink:0;border-radius:8px;background:#fff;border:1px solid #b9d2ec;padding:2px}
  .msn-me-av{width:50px;height:50px}.msn-row-av{width:34px;height:34px;display:flex;align-items:center;justify-content:center}
  .msn-me-av:after,.msn-row-av:after{content:'';position:absolute;right:-3px;bottom:-3px;width:11px;height:11px;border-radius:50%;background:var(--dot,#3fc04a);border:2px solid #fff;box-shadow:0 0 4px var(--dot,#3fc04a)}
  .msn-row-av .msn-pin-ico{font-size:20px}
  .msn-me-info{flex:1;min-width:0}
  .msn-me-top{display:flex;align-items:center;gap:6px}
  .msn-me-name{font-weight:800;font-size:14px;color:#0a3a66;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .msn-status-sel{font-size:11px;border:1px solid #9cbbdc;border-radius:4px;background:#fff;color:#0a2a4a}
  .msn-me-msg{width:100%;margin-top:3px;border:1px solid #cfe0f4;border-radius:4px;background:#fff;font-size:11px;font-style:italic;color:#557;padding:2px 5px}
  .msn-signin{padding:14px;font-size:12px;color:#456;text-align:center}
  .msn-search{margin:7px 9px 4px;padding:4px 8px;border:1px solid #a9c6e6;border-radius:14px;background:#fff;font-size:12px}
  .msn-list{flex:1;overflow-y:auto;padding:2px 6px 8px}
  .msn-sec-hd{font-size:11px;font-weight:800;color:#2f6aa8;padding:6px 4px 2px;border-bottom:1px solid #cfe0f4;margin-bottom:2px}
  .msn-row{display:flex;gap:8px;align-items:center;padding:4px 6px;border-radius:6px;cursor:pointer}
  .msn-row:hover{background:rgba(120,180,240,.28)}
  .msn-row.msn-off{opacity:.5}
  .msn-row-body{flex:1;min-width:0}
  .msn-row-name{font-weight:700;font-size:12.5px;color:#0a3358;display:flex;align-items:center;gap:6px}
  .msn-row-sub{font-size:11px;color:#6a7a8a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-style:italic}
  .msn-unread{background:#e0463a;color:#fff;border-radius:9px;font-size:10px;font-weight:800;padding:0 6px;min-width:16px;text-align:center}
  .msn-log{flex:1;overflow-y:auto;background:#fff;border-top:1px solid #c4d8ef;border-bottom:1px solid #c4d8ef;padding:6px 8px}
  .msn-sys{font-size:11px;color:#8a6a2a;text-align:center;padding:4px;font-style:italic}
  .msn-tools{display:flex;gap:6px;padding:4px 8px;align-items:center;flex-wrap:wrap}
  .msn-tool-btn{font-size:12px;border:1px solid #9cbbdc;border-radius:5px;background:linear-gradient(180deg,#fff,#dcebfb);cursor:pointer;padding:2px 8px;color:#0a2a4a}
  .msn-emobar{display:flex;flex-wrap:wrap;gap:2px;padding:4px 8px;background:#eef5fd;border-top:1px solid #c4d8ef}
  .msn-emo{font-size:16px;border:none;background:none;cursor:pointer;padding:1px 3px;border-radius:4px}
  .msn-emo:hover{background:rgba(120,180,240,.4)}
  .msn-input-row{display:flex;gap:6px;padding:6px 8px;background:linear-gradient(180deg,#f2f8ff,#e2eefb)}
  .msn-input{flex:1;resize:none;height:38px;border:1px solid #a9c6e6;border-radius:5px;padding:5px 7px;font-family:inherit;font-size:12.5px}
  .msn-send{align-self:stretch;padding:0 14px;border:1px solid #5a8fc8;border-radius:6px;background:linear-gradient(180deg,#bfe0ff,#5aa0e8);color:#06223f;font-weight:800;cursor:pointer}
  .msn-send:hover{filter:brightness(1.06)}
  .msn-min{display:none!important}
  .msn-nudge{animation:msnShake .55s linear}
  @keyframes msnShake{0%,100%{transform:translate(0,0)}10%{transform:translate(-6px,3px)}25%{transform:translate(7px,-4px)}40%{transform:translate(-7px,-2px)}55%{transform:translate(6px,4px)}70%{transform:translate(-4px,-3px)}85%{transform:translate(3px,2px)}}
  @media (max-width:768px){.msn-mobile{left:0!important;top:0!important;right:0!important;bottom:0!important;width:100vw!important;height:100dvh!important;max-width:none;max-height:none;border-radius:0;z-index:900!important}.msn-conv.msn-mobile{z-index:902!important}.msn-titlebar{cursor:default}.msn-back{font-size:15px;padding:6px 12px}.msn-input{height:44px}.msn-send{padding:0 18px}}
  `;
  document.head.appendChild(s);
}

// ── entry point ──────────────────────────────────────────────────────────────────
function openMessenger() {
  injectStyle();
  startPresence();
  if (!_contactsWin) buildContactsWin();
  _contactsWin.style.display = 'flex';
  focusWin(_contactsWin);
  renderContacts();
  document.querySelector('.dock-item[data-dock="chat"]')?.classList.add('running', 'active');
  _built = true;
}

if (typeof window !== 'undefined') {
  window.openMessenger = openMessenger;
  window.messengerOpenConversation = openConversation;
  // Re-push presence whenever the buddy look changes, so contacts see the new avatar.
  window.aqRefreshPresence = () => { try { writePresence(); renderContacts(); } catch (e) {} };
  // Roster for @-mention autocomplete: live presence + anyone we've seen chat.
  window.aqUserRoster = () => {
    const out = new Map();
    for (const id in _users) {
      const u = _users[id]; if (!u || !u.username) continue;
      out.set(u.username.toLowerCase(), { uid: id, name: u.username, cfg: u.buddyCfg || (u.buddyOutfit ? { outfit: u.buddyOutfit } : null) });
    }
    if (window._aqChatSenders) for (const [k, v] of window._aqChatSenders) if (!out.has(k)) out.set(k, v);
    return Array.from(out.values());
  };
  // begin presence once accounts/firebase are ready (so you show online without opening chat)
  const tryStart = () => { if (hasAcct() && fbReady()) { startPresence(); } else { setTimeout(tryStart, 1500); } };
  setTimeout(tryStart, 2500);
}
