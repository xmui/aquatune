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
  (`PLAYED_XP`/`WON_XP` ≈ 2/8 in `skills.js`, music tick ~20/min in `index.html`),
  so a handful of actions nets only a level or two and maxing a skill is ~30–70h
  (music is the slowest/most passive at ~120h).
  If you change rewards OR the curve, re-check both: early levels shouldn't be
  instant, and max should stay tens of hours. Cap any score-scaled `mult`.
- **Always pop up on XP.** Every XP gain shows a floating "+N XP" popup chip, and a
  level-up shows an extra gold "Level N!" chip (`showXpPopup` in `skills.js`,
  `.aq-xp-pop` CSS + `#aq-xp-popups` in `index.html`). Keep XP gains visible.
- A rare (~5%) **lucky bonus** multiplies a grant for variance.
- Skills are data-driven (the `SKILLS` array) so more can be added later. Games grant
  XP via the global `window.aqGameXp(skill, {played, won, mult})` / `window.aqAddXp`.
  Current skills: fishing, mining, gambling, intellect, speed, music, finance, combat,
  woodcutting (Lumberjack, `src/lumberjack.js`).
- XP is account-gated: no account ⇒ no XP/leaderboard (see `hasAccount()`).
- **Music** accrues from watching videos (`startProg` tick in `index.html`) AND making
  beats in the Studio (`playheadTick` in `aquasynth-studio.js`). **Finance** accrues
  from trading (`doBuy`/`doSell`) AND from earning credits generally (`hookEarnXp`
  wraps `aqAddCredits`, small + capped). **Combat** comes from Buddy Shoot.
- XP is cached in localStorage and synced per-user to Firebase (`user-skills/<uid>`),
  mirroring the stocks/portfolio pattern.

## Conventions
- Credits: `window.aqGetCredits/aqSetCredits/aqAddCredits`; any `.aq-credits-display`
  element auto-updates via `aqRefreshCreditDisplays()`.
- New apps/games: add to `APPS`, `DOCK_META`, the Arcade window, the mobile apps grid
  and `#mob-tools-bar`; open via `OS.open(id)` with an `openX()` that calls
  `OS.register`/`OS.focus`.
- **Keyboard focus:** games that use the keyboard set `keys:true` on their `APPS`
  entry — the global video shortcuts (Space/N/P/arrows/M) stand down while such a
  window is focused (`aqGameKeysActive()`), and each game gates its own keydown on
  `window.aqIsActiveApp('<id>')` (keyup stays ungated so held keys release).
- **Window chrome is theme-driven.** Every theme has a unique `data-era` on `<html>`;
  frames use `var(--panel)` + `--win-border`/`--win-shadow`/`--chrome-radius`
  (defined per era as `html[data-era=X]` vars), and legacy titlebars carry the
  `.aq-tb` marker class which gets per-era skins (plus `.sol-titlebtn`/`.xp-titlebtn`
  button skins) near the "LEGACY-WINDOW TITLEBARS" CSS section. Titlebar text colour
  comes from `--titlebar-text` (computed in `applyTheme` from the theme's header).
  Game window INTERIORS keep their own art (GBC shell, DAW, casino felt…) on their
  `-area`/body element — never hardcode frame colours on a `*-wrap` again.
- Fishing uses per-zone Game Boy Color palettes on a small nearest-neighbor
  canvas. Mining (`src/mining.js`) is a PS1/N64-style first-person raycaster
  (same engine family as `buddyshoot3d.js`): walkable procedural caves, ore
  veins mined in-world, a sack→sell-at-cart loop, hostile cave creatures, and
  pitch (look up/down via horizon offset). Lumberjack (`src/lumberjack.js`)
  uses the same camera math on an open plane: chunk-streamed deterministic
  forest, billboard trees, rhythm-meter chopping, falling-tree danger.
  Game SFX are synthesized via `window.*Sfx` defined near `pokerSfx` in
  `index.html` (uses `initActx()` + `_gameVol`).
- **Gathered resources also land in the shared inventory** (`src/inventory.js`):
  call `window.aqInvAdd('<ns>_<id>', n)` (e.g. `ore_copper`, `log_oak`) and
  register the item's display info in its `ITEMS` map. Counts live in
  `aq_inventory` (COUNT_KEYS, per-item max-merge) for the future trading post.
- **Persist bought game items to the cloud.** Anything a user buys/unlocks (pickaxe,
  rod, stage/zone, dex…) must sync per-account or it "resets" on update/new device.
  Write the localStorage key as before, then call `window.aqGamePersist('<key>')`;
  register the key in `src/gamesave.js` (`TIER_KEYS` = max-merge, `COUNT_KEYS` =
  per-name max, `BLOB_KEYS` = newest-wins). It mirrors to `user-games/<uid>`.
- **Credits = the account is the single source of truth.** `accounts/<id>/credits`
  is authoritative; `portfolios/<id>.credits` is only a mirror. Never write holdings
  before `loadPortfolio()` finishes (the `_portfolioLoaded` guard) or you wipe stocks.
- Room multiplayer is host-authoritative (poker/pool): the host runs the engine and
  streams state via `window.{poker,pool}Broadcast`; guests render it and queue shots
  via `window.{poker,pool}SendAction` that only the host drains. Pool uses absolute
  A/B seats (host=A, guest=B); solo bot play is the same engine with the AI on seat B.
- Development branch for this work: `claude/music-games-features-FhhAz`.
