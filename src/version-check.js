// Update notifier — polls /version.json (written at build time) and, when the
// deployed build id differs from the one this page loaded, shows a "refresh to
// update" banner. The service worker is network-only, so version.json is always
// fresh on refresh.

const LOADED = (typeof __BUILD_ID__ !== 'undefined') ? String(__BUILD_ID__) : null;
let _shown = false, _checking = false;

async function check() {
  if (_shown || _checking || !LOADED) return;
  _checking = true;
  try {
    const r = await fetch('/version.json?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) {
      const v = await r.json();
      if (v && v.build && String(v.build) !== LOADED) showBanner();
    }
  } catch (e) { /* offline / dev — ignore */ } finally { _checking = false; }
}

function showBanner() {
  if (_shown) return; _shown = true;
  const bar = document.createElement('div');
  bar.id = 'aq-update-banner';
  bar.innerHTML = '<span>🔄 A new version of Aquatune is available.</span><button id="aq-update-refresh">Refresh</button>';
  document.body.appendChild(bar);
  const btn = document.getElementById('aq-update-refresh');
  if (btn) btn.onclick = () => { try { location.reload(); } catch (e) {} };
}

if (typeof window !== 'undefined' && LOADED) {
  setTimeout(check, 10000);                 // first check ~10s after load
  setInterval(check, 5 * 60 * 1000);        // then every 5 minutes
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
}
