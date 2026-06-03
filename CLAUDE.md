# Aquatune — project notes for Claude

Aquatune is a single-page vanilla-JS music/arcade web app. UI + most game logic
live inline in `index.html` (large); newer features are ES modules in `src/*.js`
loaded via `<script type="module">` tags near the end of `index.html`. Firebase
Realtime Database for sync; Vite for the build (`npm run build` is the main check).

## Skills / XP system (design intent — keep this true)
The skills/stats system (`src/skills.js`) is intentionally **grindy**:

- **Tens of hours to max a single stat, with a steady climb.** Levels 1–100 use a
  **quadratic** curve (`xp(L)=GROWTH*(L-1)^2`, ~147k XP to L100) — NOT OSRS's
  front-loaded exponential, which made early levels free. Per-action XP is small
  (`PLAYED_XP`/`WON_XP` ≈ 2/8 in `skills.js`, music tick ~50/min in `index.html`),
  so a handful of actions nets only a level or two and maxing a skill is ~30–70h.
  If you change rewards OR the curve, re-check both: early levels shouldn't be
  instant, and max should stay tens of hours. Cap any score-scaled `mult`.
- **Always pop up on XP.** Every XP gain shows a floating "+N XP" popup chip, and a
  level-up shows an extra gold "Level N!" chip (`showXpPopup` in `skills.js`,
  `.aq-xp-pop` CSS + `#aq-xp-popups` in `index.html`). Keep XP gains visible.
- A rare (~5%) **lucky bonus** multiplies a grant for variance.
- Skills are data-driven (the `SKILLS` array) so more can be added later. Games grant
  XP via the global `window.aqGameXp(skill, {played, won, mult})` / `window.aqAddXp`.
- XP is cached in localStorage and synced per-user to Firebase (`user-skills/<uid>`),
  mirroring the stocks/portfolio pattern.

## Conventions
- Credits: `window.aqGetCredits/aqSetCredits/aqAddCredits`; any `.aq-credits-display`
  element auto-updates via `aqRefreshCreditDisplays()`.
- New apps/games: add to `APPS`, `DOCK_META`, the Arcade window, the mobile apps grid
  and `#mob-tools-bar`; open via `OS.open(id)` with an `openX()` that calls
  `OS.register`/`OS.focus`.
- Pixel games (Fishing/Mining) use the Game Boy Color 4-tone palette on a small
  nearest-neighbor canvas; SFX synthesized via `window.*Sfx` defined near `pokerSfx`
  in `index.html` (uses `initActx()` + `_gameVol`).
- Development branch for this work: `claude/music-games-features-FhhAz`.
