// Aquatune Buddy — your Aqua Buddy is your identity across the app.
//
// One synced config (color · expression · clothes · hat) drives THREE things:
//   1. the floating on-screen mascot (#aqua-buddy, a static SVG in index.html),
//   2. every chat/stats/profile avatar (built fresh via aqBuildBuddySvg),
//   3. the Aquatard Creator preview.
//
// The mascot is mutated in place by applyToMascot() (so the speech/idle
// animations that reference #ab-mouth / #ab-outfit keep working). Avatars are
// self-contained <svg> strings with unique gradient ids (duplicate element ids
// would break the mascot's getElementById lookups, so avatars carry none).
//
// Hats reuse the existing OUTFIT_DEFS exposed by index.html as
// window.aqBuddyOutfits / window.aqBuddyOutfitKeys.

// ── colour palettes ──────────────────────────────────────────────────────────────
// Each palette is a light→dark anchor pair; makeRamp() fills the gradient stops.
// 'aqua' reproduces the original Frutiger-Aero blue buddy exactly.
const PALETTES = {
  aqua:   { name: 'Aqua',    light: '#c8f2ff', mid: '#2cbae8', dark: '#003d6a' },
  jade:   { name: 'Jade',    light: '#c8ffe6', mid: '#26d08a', dark: '#0a4d33' },
  grape:  { name: 'Grape',   light: '#ecd6ff', mid: '#9a5cff', dark: '#33125e' },
  ember:  { name: 'Ember',   light: '#ffd9cf', mid: '#ff5a4d', dark: '#5e1209' },
  gold:   { name: 'Gold',    light: '#fff2c8', mid: '#f0b929', dark: '#6e4a08' },
  bubble: { name: 'Bubble',  light: '#ffd6ef', mid: '#ff6bc4', dark: '#6a1248' },
  slate:  { name: 'Slate',   light: '#e6edf5', mid: '#8a9bb0', dark: '#222b38' },
  sunset: { name: 'Sunset',  light: '#ffe2c0', mid: '#ff8a3a', dark: '#7a2a12' },
};
const PALETTE_KEYS = Object.keys(PALETTES);

function hexLerp(a, b, t) {
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}
// n-stop ramp from light → mid → dark
function makeRamp(pal, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push(t <= 0.5 ? hexLerp(pal.light, pal.mid, t / 0.5) : hexLerp(pal.mid, pal.dark, (t - 0.5) / 0.5));
  }
  return out;
}

// ── expressions (eyes markup + mouth path) ───────────────────────────────────────
const EYES_OPEN = `
  <circle cx="43" cy="35" r="5" fill="#001e38"/><circle cx="57" cy="35" r="5" fill="#001e38"/>
  <circle cx="43.3" cy="35.3" r="2.7" fill="rgba(0,188,230,0.58)"/><circle cx="57.3" cy="35.3" r="2.7" fill="rgba(0,188,230,0.58)"/>
  <circle cx="41.5" cy="33.5" r="1.9" fill="rgba(255,255,255,0.95)"/><circle cx="55.5" cy="33.5" r="1.9" fill="rgba(255,255,255,0.95)"/>
  <circle cx="44" cy="36.2" r="1.4" fill="#000d1e"/><circle cx="58" cy="36.2" r="1.4" fill="#000d1e"/>`;
const EYES_WIDE = `
  <circle cx="43" cy="34.5" r="6.2" fill="#001e38"/><circle cx="57" cy="34.5" r="6.2" fill="#001e38"/>
  <circle cx="43" cy="35" r="2.4" fill="#000d1e"/><circle cx="57" cy="35" r="2.4" fill="#000d1e"/>
  <circle cx="41" cy="32.5" r="2.1" fill="rgba(255,255,255,0.95)"/><circle cx="55" cy="32.5" r="2.1" fill="rgba(255,255,255,0.95)"/>`;
const BROWS_ANGRY = `
  <path d="M 37 28 L 47 32" stroke="#001e38" stroke-width="2.6" stroke-linecap="round"/>
  <path d="M 63 28 L 53 32" stroke="#001e38" stroke-width="2.6" stroke-linecap="round"/>`;
const LIDS_COOL = `
  <path d="M 38 33 L 48 33" stroke="#001e38" stroke-width="2.4" stroke-linecap="round" opacity="0.85"/>
  <path d="M 52 33 L 62 33" stroke="#001e38" stroke-width="2.4" stroke-linecap="round" opacity="0.85"/>`;

const EXPRESSIONS = {
  smile:     { name: 'Smile',     eyes: EYES_OPEN, mouth: 'M 43.5 43.5 Q 50 50.5 56.5 43.5', fill: 'none' },
  grin:      { name: 'Grin',      eyes: EYES_OPEN, mouth: 'M 42 43 Q 50 53 58 43 Q 50 46.5 42 43 Z', fill: '#5c1822' },
  cool:      { name: 'Cool',      eyes: EYES_OPEN + LIDS_COOL, mouth: 'M 44 44.5 Q 50 47.5 57 43', fill: 'none' },
  angry:     { name: 'Angry',     eyes: EYES_OPEN + BROWS_ANGRY, mouth: 'M 43 47 Q 50 42 57 47', fill: 'none' },
  surprised: { name: 'Surprised', eyes: EYES_WIDE, mouth: 'M 47 45.5 A 3.2 3.2 0 1 0 53 45.5 A 3.2 3.2 0 1 0 47 45.5 Z', fill: '#2a0d14' },
  sad:       { name: 'Sad',       eyes: EYES_OPEN, mouth: 'M 44 47.5 Q 50 42.5 56 47.5', fill: 'none' },
  wink:      { name: 'Wink',
    eyes: `<circle cx="43" cy="35" r="5" fill="#001e38"/><circle cx="43.3" cy="35.3" r="2.7" fill="rgba(0,188,230,0.58)"/><circle cx="41.5" cy="33.5" r="1.9" fill="rgba(255,255,255,0.95)"/><circle cx="44" cy="36.2" r="1.4" fill="#000d1e"/><path d="M 52 35.5 Q 57 32.5 62 35.5" stroke="#001e38" stroke-width="2.4" fill="none" stroke-linecap="round"/>`,
    mouth: 'M 43.5 43.5 Q 50 50.5 56.5 43.5', fill: 'none' },
  dead:      { name: 'X-eyes',
    eyes: `<path d="M 40 32 L 46 38 M 46 32 L 40 38" stroke="#001e38" stroke-width="2.4" stroke-linecap="round"/><path d="M 54 32 L 60 38 M 60 32 L 54 38" stroke="#001e38" stroke-width="2.4" stroke-linecap="round"/>`,
    mouth: 'M 44 45 Q 47 42 50 45 Q 53 48 56 45', fill: 'none' },
};
const EXPRESSION_KEYS = Object.keys(EXPRESSIONS);

// ── clothes (overlays drawn on the neck / upper body) ─────────────────────────────
const CLOTHES = {
  none:    { name: 'None', svg: '' },
  bowtie:  { name: 'Bow tie', svg: `
    <polygon points="50,64 40,59 40,69" fill="#d52a3a"/><polygon points="50,64 60,59 60,69" fill="#d52a3a"/>
    <circle cx="50" cy="64" r="3" fill="#a01624"/>` },
  necktie: { name: 'Necktie', svg: `
    <polygon points="50,62 46,67 50,71 54,67" fill="#2c5fb0"/>
    <polygon points="48,71 52,71 53,86 50,90 47,86" fill="#2c5fb0"/>
    <polygon points="48,71 52,71 52.5,79 50,80 47.5,79" fill="rgba(255,255,255,0.18)"/>` },
  scarf:   { name: 'Scarf', svg: `
    <path d="M 36 62 Q 50 70 64 62 L 64 67 Q 50 75 36 67 Z" fill="#e07a2a"/>
    <path d="M 58 66 L 66 64 L 68 80 L 60 82 Z" fill="#c8651c"/>` },
  chain:   { name: 'Chain', svg: `
    <path d="M 38 64 Q 50 80 62 64" fill="none" stroke="#ffd24a" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="50" cy="78" r="3.4" fill="#ffd24a" stroke="#c8960a" stroke-width="0.8"/>` },
  collar:  { name: 'Collar', svg: `
    <polygon points="44,63 50,70 50,64" fill="#f4f4f4" stroke="#cfcfcf" stroke-width="0.6"/>
    <polygon points="56,63 50,70 50,64" fill="#e8e8e8" stroke="#cfcfcf" stroke-width="0.6"/>
    <rect x="44" y="61" width="12" height="3" rx="1.5" fill="#3a6ea5"/>` },
  /* ── Pawn Shop exclusives (locked until bought — see src/pawnshop.js) ── */
  cuban: { name: 'XXL Cuban Chain', svg: `
    <path d="M 35 62 Q 50 84 65 62" fill="none" stroke="#ffd24a" stroke-width="5" stroke-linecap="round"/>
    <path d="M 35 62 Q 50 84 65 62" fill="none" stroke="#c8960a" stroke-width="5" stroke-dasharray="3,3" stroke-linecap="round"/>
    <rect x="44" y="76" width="12" height="10" rx="2" fill="#ffd24a" stroke="#c8960a" stroke-width="1"/>
    <text x="46.5" y="84" font-size="8" font-weight="900" fill="#7a4d08" font-family="Arial">$</text>` },
  champbelt: { name: 'Championship Belt', svg: `
    <rect x="34" y="76" width="32" height="9" rx="3" fill="#181820"/>
    <ellipse cx="50" cy="80" rx="11" ry="7.5" fill="#ffd24a" stroke="#c8960a" stroke-width="1.4"/>
    <ellipse cx="50" cy="80" rx="6.5" ry="4.5" fill="#fff2b0"/>
    <text x="46" y="83" font-size="7" font-weight="900" fill="#a86a0a" font-family="Arial">#1</text>
    <circle cx="38" cy="80" r="2" fill="#ffd24a"/><circle cx="62" cy="80" r="2" fill="#ffd24a"/>` },
  furcollar: { name: 'Fur Collar', svg: `
    <path d="M 33 60 Q 38 70 50 71 Q 62 70 67 60 Q 64 68 58 71 Q 66 72 68 67 L 66 74 Q 58 78 50 77 Q 42 78 34 74 L 32 67 Q 34 72 42 71 Q 36 68 33 60 Z" fill="#8a5a30"/>
    <path d="M 36 62 Q 43 70 50 70 Q 57 70 64 62" fill="none" stroke="#b8854e" stroke-width="3" stroke-linecap="round" stroke-dasharray="2,2.6"/>` },
  dollartie: { name: 'Money Tie', svg: `
    <polygon points="50,62 46,67 50,71 54,67" fill="#2a8a3a"/>
    <polygon points="48,71 52,71 53,87 50,91 47,87" fill="#2a8a3a"/>
    <text x="47.4" y="83" font-size="8" font-weight="900" fill="#ffd24a" font-family="Arial">$</text>` },
  medallion: { name: 'Iced Medallion', svg: `
    <path d="M 38 63 Q 50 76 62 63" fill="none" stroke="#cfd6de" stroke-width="2.2" stroke-linecap="round"/>
    <circle cx="50" cy="77" r="6.5" fill="#cfd6de" stroke="#8a96a4" stroke-width="1"/>
    <circle cx="50" cy="77" r="4" fill="#aee8ff"/>
    <path d="M 47 77 L 50 73.4 L 53 77 L 50 80.6 Z" fill="#fff"/>` },
  blingbow: { name: 'Diamond Bow', svg: `
    <polygon points="50,64 40,59 40,69" fill="#aee8ff" stroke="#5ab8e0" stroke-width="0.8"/>
    <polygon points="50,64 60,59 60,69" fill="#aee8ff" stroke="#5ab8e0" stroke-width="0.8"/>
    <circle cx="50" cy="64" r="3" fill="#fff"/>
    <circle cx="43" cy="62" r="0.9" fill="#fff"/><circle cx="57" cy="66" r="0.9" fill="#fff"/>` },
};
const CLOTHES_KEYS = Object.keys(CLOTHES);

// ── really cursed neotribal tattoos (Pawn Shop exclusives) ──────────────────────
// body = inked under the clothes layer · face = inked over the mug, under the hat
const INK = 'rgba(12,22,34,0.78)';
const TATTOOS = {
  none: { name: 'None', body: '', face: '' },
  trampstamp: { name: 'Lower-Back Tribal', body: `
    <g fill="${INK}"><path d="M 50 96 q -10 -7 -19 -1 q 6 -5 12 -4 q -8 -4 -14 1 q 4 -7 13 -4 q 5 2 8 6 q 3 -4 8 -6 q 9 -3 13 4 q -6 -5 -14 -1 q 6 -1 12 4 q -9 -6 -19 1 Z"/>
    <path d="M 50 92 l -3 -4 l 3 -2 l 3 2 Z"/></g>` },
  barbedring: { name: 'Barbed Wire Band', body: `
    <g stroke="${INK}" stroke-width="2.6" fill="none"><path d="M 20 84 Q 50 96 80 84"/>
    <path d="M 30 87.5 l -3 -4 M 30 87.5 l 4 -3 M 50 90.5 l -3.6 -3.4 M 50 90.5 l 3.6 -3.4 M 70 87.5 l 3 -4 M 70 87.5 l -4 -3" stroke-width="2"/></g>` },
  tribalflames: { name: 'Tribal Flames', body: `
    <g fill="${INK}"><path d="M 24 104 q 3 -12 -1 -18 q 7 6 5 13 q 5 -9 2 -16 q 8 8 4 21 Z"/>
    <path d="M 42 107 q 3 -13 -2 -20 q 8 6 6 14 q 5 -9 1 -17 q 9 9 5 23 Z"/>
    <path d="M 62 106 q 4 -12 0 -19 q 7 6 5 13 q 4 -8 1 -15 q 9 9 4 21 Z"/></g>` },
  scorpking: { name: 'Belly Scorpion', body: `
    <g fill="${INK}"><ellipse cx="50" cy="86" rx="6" ry="8"/>
    <path d="M 50 78 q -1 -7 5 -10 q -3 5 -1 8 l 3 -2 l -1 5 Z"/>
    <path d="M 44 82 q -8 -2 -9 -8 l 3 3 q 3 2 6 2 Z M 44 88 q -9 1 -11 -5 l 4 2 q 4 2 7 1 Z M 56 82 q 8 -2 9 -8 l -3 3 q -3 2 -6 2 Z M 56 88 q 9 1 11 -5 l -4 2 q -4 2 -7 1 Z"/></g>` },
  facetribal: { name: 'Face Tribal', face: `
    <g fill="${INK}"><path d="M 28 22 q 10 -3 14 4 q -7 -2 -10 1 q 6 0 8 5 q -8 -3 -12 0 q 3 2 3 6 q -6 -5 -7 -10 q -1 -4 4 -6 Z"/>
    <path d="M 67 44 q 7 2 8 8 q -4 -3 -8 -3 q 3 3 2 7 q -4 -6 -8 -7 q 4 -3 6 -5 Z"/></g>` },
  noragrets: { name: '"NO RAGRETS"', body: `
    <g transform="rotate(-4 50 90)"><rect x="30" y="85" width="40" height="11" rx="2" fill="none" stroke="${INK}" stroke-width="1.6"/>
    <text x="50" y="93.5" text-anchor="middle" font-size="7.6" font-weight="900" font-family="Georgia,serif" fill="${INK}" letter-spacing="0.5">NO RAGRETS</text>
    <path d="M 27 90 l -5 -3 l 5 -3 M 73 90 l 5 -3 l -5 -3" fill="none" stroke="${INK}" stroke-width="1.6"/></g>` },
};
const TATTOO_KEYS = Object.keys(TATTOOS);

// ── defaults & config ─────────────────────────────────────────────────────────────
function legacyOutfitKey() {
  const keys = (typeof window !== 'undefined' && window.aqBuddyOutfitKeys) || ['none'];
  let i = parseInt(localStorage.getItem('yt_buddy_outfit') || '0', 10);
  if (!(i >= 0 && i < keys.length)) i = 0;
  return keys[i];
}
function defaults() {
  return { color: 'aqua', expression: 'smile', outfit: legacyOutfitKey(), clothes: 'none' };
}
function normalize(cfg) {
  const d = defaults();
  cfg = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    color:      PALETTES[cfg.color] ? cfg.color : d.color,
    expression: EXPRESSIONS[cfg.expression] ? cfg.expression : d.expression,
    outfit:     (window.aqBuddyOutfits && window.aqBuddyOutfits[cfg.outfit] != null) ? cfg.outfit : d.outfit,
    clothes:    CLOTHES[cfg.clothes] ? cfg.clothes : d.clothes,
    tattoo:     TATTOOS[cfg.tattoo] ? cfg.tattoo : 'none',
  };
}
function buddyConfig() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem('aq_buddy_config') || 'null'); } catch (e) {}
  return normalize(raw);
}

function setBuddyConfig(patch) {
  const cfg = normalize({ ...buddyConfig(), ...(patch || {}) });
  try { localStorage.setItem('aq_buddy_config', JSON.stringify(cfg)); } catch (e) {}
  // Keep the legacy single-outfit index in sync (messenger presence + Buddy Shoot
  // still read yt_buddy_outfit).
  try {
    const keys = window.aqBuddyOutfitKeys || [];
    const idx = keys.indexOf(cfg.outfit);
    if (idx >= 0) localStorage.setItem('yt_buddy_outfit', String(idx));
  } catch (e) {}
  try { window.aqGamePersist && window.aqGamePersist('aq_buddy_config'); } catch (e) {}
  // Mirror to the user's skills node so others can render their avatar in
  // stats / profile cards (only meaningful for logged-in accounts).
  try {
    const uid = window.effectiveUserId && window.effectiveUserId();
    if (uid && window._aqAccountId && window._fbFns && window._aqDb) {
      const F = window._fbFns;
      F.set(F.ref(window._aqDb, 'user-skills/' + uid + '/buddyCfg'), cfg).catch(() => {});
    }
  } catch (e) {}
  applyToMascot(cfg);
  try { window.aqRefreshPresence && window.aqRefreshPresence(); } catch (e) {}
  try { window.dispatchEvent(new CustomEvent('aq-buddy-changed', { detail: cfg })); } catch (e) {}
  return cfg;
}

// ── avatar renderer (self-contained, unique ids) ──────────────────────────────────
let _avSeq = 0;
function buildBuddySvg(cfg, opts) {
  cfg = normalize(cfg);
  const size = (opts && opts.size) || 40;
  const id = 'bd' + (_avSeq++) + '_';
  const pal = PALETTES[cfg.color] || PALETTES.aqua;
  const ramp = makeRamp(pal, 3);
  const ex = EXPRESSIONS[cfg.expression] || EXPRESSIONS.smile;
  const clothes = (CLOTHES[cfg.clothes] || CLOTHES.none).svg;
  const tat = TATTOOS[cfg.tattoo] || TATTOOS.none;
  const hat = (window.aqBuddyOutfits && window.aqBuddyOutfits[cfg.outfit]) || '';
  return `<svg viewBox="0 0 100 112" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg" style="display:block">
    <defs>
      <radialGradient id="${id}h" cx="36%" cy="30%" r="65%"><stop offset="0%" stop-color="${ramp[0]}"/><stop offset="55%" stop-color="${ramp[1]}"/><stop offset="100%" stop-color="${ramp[2]}"/></radialGradient>
      <radialGradient id="${id}b" cx="30%" cy="22%" r="74%"><stop offset="0%" stop-color="${ramp[0]}"/><stop offset="55%" stop-color="${ramp[1]}"/><stop offset="100%" stop-color="${ramp[2]}"/></radialGradient>
    </defs>
    <ellipse cx="50" cy="109" rx="23" ry="3.5" fill="rgba(0,0,0,0.16)"/>
    <path d="M 17 103 Q 13 73 50 65 Q 87 73 83 103 Q 80 110 50 110 Q 20 110 17 103 Z" fill="url(#${id}b)"/>
    <ellipse cx="9" cy="82" rx="12" ry="8.5" fill="url(#${id}b)" transform="rotate(-30 9 82)"/>
    <ellipse cx="91" cy="82" rx="12" ry="8.5" fill="url(#${id}b)" transform="rotate(30 91 82)"/>
    <ellipse cx="34" cy="74" rx="16" ry="9" fill="rgba(255,255,255,0.38)" transform="rotate(-18 34 74)"/>
    <ellipse cx="50" cy="64" rx="14" ry="5.5" fill="url(#${id}b)"/>
    <g>${tat.body || ''}</g>
    <g>${clothes}</g>
    <circle cx="50" cy="33" r="27" fill="url(#${id}h)"/>
    <ellipse cx="38" cy="22" rx="12" ry="8" fill="rgba(255,255,255,0.66)" transform="rotate(-28 38 22)"/>
    <g>${ex.eyes}</g>
    <path d="${ex.mouth}" stroke="#001e38" stroke-width="2.3" fill="${ex.fill || 'none'}" stroke-linecap="round" stroke-opacity="0.82"/>
    <g>${tat.face || ''}</g>
    ${hat}
  </svg>`;
}

// ── apply to the live floating mascot ─────────────────────────────────────────────
function applyToMascot(cfg) {
  cfg = normalize(cfg);
  const pal = PALETTES[cfg.color] || PALETTES.aqua;
  const setStops = (gradId) => {
    const g = document.getElementById(gradId);
    if (!g) return;
    const stops = g.querySelectorAll('stop');
    const ramp = makeRamp(pal, stops.length);
    stops.forEach((s, i) => s.setAttribute('stop-color', ramp[i]));
  };
  setStops('ab-h'); setStops('ab-b'); setStops('ab-a');
  const ex = EXPRESSIONS[cfg.expression] || EXPRESSIONS.smile;
  const eyes = document.getElementById('ab-eyes');
  if (eyes) eyes.innerHTML = ex.eyes;
  const mouth = document.getElementById('ab-mouth');
  if (mouth) { mouth.setAttribute('d', ex.mouth); mouth.setAttribute('fill', ex.fill || 'none'); }
  const clothes = document.getElementById('ab-clothes');
  if (clothes) clothes.innerHTML = (CLOTHES[cfg.clothes] || CLOTHES.none).svg;
  const outfit = document.getElementById('ab-outfit');
  if (outfit) outfit.innerHTML = (window.aqBuddyOutfits && window.aqBuddyOutfits[cfg.outfit]) || '';
  const tat = TATTOOS[cfg.tattoo] || TATTOOS.none;
  const tb = document.getElementById('ab-tattoo');
  if (tb) tb.innerHTML = tat.body || '';
  const tf = document.getElementById('ab-tattoo-face');
  if (tf) tf.innerHTML = tat.face || '';
}

// ── profile card popover (used from chat name/avatar clicks) ──────────────────────
let _cardEl = null;
function closeProfileCard() {
  if (_cardEl) { _cardEl.remove(); _cardEl = null; }
  window.removeEventListener('pointerdown', _onDocDown, true);
  window.removeEventListener('keydown', _onKey, true);
}
function _onDocDown(e) { if (_cardEl && !_cardEl.contains(e.target)) closeProfileCard(); }
function _onKey(e) { if (e.key === 'Escape') closeProfileCard(); }

function showProfileCard({ uid, name, avatarCfg, acct, anchorEl } = {}) {
  closeProfileCard();
  injectCardStyle();
  name = name || 'Anonymous';
  const me = (window.effectiveUserId && window.effectiveUserId()) || null;
  const isSelf = uid && me && uid === me;
  // Only real accounts have presence (DMs) and skills (stats). `acct` is sent with
  // each chat message; when it's missing (older messages) fall back to "has a uid".
  const isAccount = acct === undefined ? !!uid : !!acct;
  const canChat = isAccount && !isSelf;
  const canStats = isSelf || (isAccount && !isSelf);
  const card = document.createElement('div');
  card.className = 'aq-pcard';
  card.innerHTML =
    `<div class="aq-pcard-top">
       <div class="aq-pcard-av">${buildBuddySvg(avatarCfg, { size: 56 })}</div>
       <div class="aq-pcard-id">
         <div class="aq-pcard-name">${escapeHtml(name)}</div>
         <div class="aq-pcard-sub">${isSelf ? "That's you 🙂" : (isAccount ? 'Aquatune player' : 'Guest · no profile')}</div>
       </div>
     </div>
     <div class="aq-pcard-btns">
       <button class="aq-pcard-btn" data-act="chat"${canChat ? '' : ' disabled'}>💬 Start chat</button>
       <button class="aq-pcard-btn" data-act="stats"${canStats ? '' : ' disabled'}>📊 View stats</button>
     </div>`;
  document.body.appendChild(card);
  _cardEl = card;

  card.querySelector('[data-act="chat"]').onclick = () => {
    closeProfileCard();
    try {
      if (window.messengerOpenConversation) {
        if (window.openMessenger) window.openMessenger();
        window.messengerOpenConversation('dm:' + uid, name, uid);
      }
    } catch (e) {}
  };
  card.querySelector('[data-act="stats"]').onclick = () => {
    closeProfileCard();
    try {
      if (isSelf) { window.openStats && window.openStats(); }
      else if (window.openStatsForUser) window.openStatsForUser(uid, name);
    } catch (e) {}
  };

  // position near the anchor, clamped to the viewport
  const cw = 220, ch = card.offsetHeight || 150;
  let x = 60, y = 60;
  if (anchorEl && anchorEl.getBoundingClientRect) {
    const r = anchorEl.getBoundingClientRect();
    x = r.left; y = r.bottom + 6;
  }
  x = Math.max(8, Math.min(x, window.innerWidth - cw - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - ch - 8));
  card.style.left = x + 'px';
  card.style.top = y + 'px';

  setTimeout(() => {
    window.addEventListener('pointerdown', _onDocDown, true);
    window.addEventListener('keydown', _onKey, true);
  }, 0);
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let _cardStyled = false;
function injectCardStyle() {
  if (_cardStyled) return; _cardStyled = true;
  const s = document.createElement('style');
  s.textContent = `
  .aq-pcard{position:fixed;z-index:5200;width:220px;background:linear-gradient(180deg,#fbfdff,#e9f2fc);border:1px solid #6f9fd0;border-radius:11px;box-shadow:0 14px 38px rgba(0,40,90,.42),inset 0 1px 0 rgba(255,255,255,.9);font-family:'Segoe UI',system-ui,sans-serif;color:#0a2a4a;padding:11px;animation:aqPcardIn .12s ease-out}
  @keyframes aqPcardIn{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
  .aq-pcard-top{display:flex;gap:10px;align-items:center}
  .aq-pcard-av{width:56px;height:56px;flex-shrink:0;background:#fff;border:1px solid #b9d2ec;border-radius:10px;padding:2px}
  .aq-pcard-id{min-width:0}
  .aq-pcard-name{font-weight:800;font-size:14px;color:#0a3a66;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .aq-pcard-sub{font-size:11px;color:#5a7088;margin-top:1px}
  .aq-pcard-btns{display:flex;flex-direction:column;gap:6px;margin-top:11px}
  .aq-pcard-btn{padding:7px 10px;border:1px solid #5a8fc8;border-radius:7px;background:linear-gradient(180deg,#eaf4ff,#bfe0ff);color:#06223f;font-weight:700;font-size:12.5px;cursor:pointer;text-align:left}
  .aq-pcard-btn:hover:not([disabled]){filter:brightness(1.05)}
  .aq-pcard-btn[disabled]{opacity:.45;cursor:not-allowed}
  `;
  document.head.appendChild(s);
}

// ── boot ───────────────────────────────────────────────────────────────────────────
function boot() {
  applyToMascot(buddyConfig());
}
if (typeof window !== 'undefined') {
  window.aqBuildBuddySvg = buildBuddySvg;
  window.aqBuddyConfig = buddyConfig;
  window.aqSetBuddyConfig = setBuddyConfig;
  window.aqApplyBuddyToMascot = () => applyToMascot(buddyConfig());
  window.aqShowProfileCard = showProfileCard;
  // expose the catalogs for the Aquatard Creator
  window.aqBuddyPalettes = PALETTES;
  window.aqBuddyPaletteKeys = PALETTE_KEYS;
  window.aqBuddyExpressions = EXPRESSIONS;
  window.aqBuddyExpressionKeys = EXPRESSION_KEYS;
  window.aqBuddyClothes = CLOTHES;
  window.aqBuddyClothesKeys = CLOTHES_KEYS;
  window.aqBuddyTattoos = TATTOOS;
  window.aqBuddyTattooKeys = TATTOO_KEYS;

  // re-apply whenever any surface changes the config, and once on load
  window.addEventListener('aq-buddy-changed', e => applyToMascot(e.detail || buddyConfig()));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // re-apply after cloud game-save merges in (config may arrive from another device)
  window.addEventListener('aq-gamedata-synced', boot);
}

export { PALETTES, EXPRESSIONS, CLOTHES, buildBuddySvg, buddyConfig, setBuddyConfig };
