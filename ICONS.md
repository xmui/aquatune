# Aquatune app icons (PWA + iOS 26 "Liquid Glass")

How the home-screen / favicon assets are produced, and the spec to follow if you
redesign them.

## How it works

- **Design source:** `design/Liquid Glass PWA Icons.icon/` — an Apple **Icon
  Composer** document (cyan gradient + the AQUATUNE wordmark).
- **Important:** a `.icon` bundle is a *native-app* format. **Browsers and the iOS
  home screen cannot use it.** A PWA must ship a flat **PNG** `apple-touch-icon`;
  iOS 26 then applies the Liquid Glass squircle, specular highlight and depth to
  that flat PNG **automatically**. So we render the design into flat assets.
- **Generator:** `npm run icons` (`scripts/gen-icons.mjs`, uses `@resvg/resvg-js`).
  It reads `public/icons/aquatune-wordmark.png`, composites it on the brand cyan
  gradient, and writes every size below into `public/icons/`. `public/` is copied
  verbatim into `dist/` by Vite, so the files ship as-is.

### Generated files (`public/icons/`)
| File | Size | Use |
|---|---|---|
| `icon.svg` | vector | SVG favicon + manifest "any" (self-tints for dark mode) |
| `apple-touch-icon.png` | 180 | iOS/iPadOS home screen (gets Liquid Glass) |
| `apple-touch-icon-dark.png` | 180 | dark-mode variant (best-effort, see below) |
| `icon-192.png` / `icon-512.png` | 192 / 512 | manifest `purpose:any` |
| `icon-192-maskable.png` / `icon-512-maskable.png` | 192 / 512 | manifest `purpose:maskable` |
| `favicon.ico`, `favicon-32.png`, `favicon-16.png` | 16–32 | browser tab |

## Wiring (already in the repo)
- `index.html <head>`: `apple-touch-icon`, SVG/PNG/ICO favicons, light+dark
  `theme-color` (media variants), `application-name`, `mobile-web-app-capable`, and
  a small `matchMedia` script that selects the dark apple-touch-icon at load.
- `public/manifest.json`: `id`/`scope`/`display_override`/`categories` + the icon
  array above (the old single 1000×200 "maskable" banner was removed).

## Design spec — if you replace the art
Drop a new square master at `public/icons/aquatune-wordmark.png` (or edit the
`.icon` and re-export the wordmark) and run `npm run icons`. Follow Apple's iOS 26
guidance so the automatic glass treatment looks right:

- **Master:** 1024×1024, sRGB, **opaque, full-bleed square**.
- **Do NOT bake in** rounded corners, gloss, specular highlights or drop shadows —
  iOS 26 adds the squircle mask, highlights and depth itself; pre-baking
  double-applies them.
- **Safe area:** keep key elements within the central **~80% (≈820 px)**; avoid
  fine detail or text near the edges. For `maskable`, content must sit inside the
  inner **80% circle** (the generator already scales the wordmark down for these).
- A wide **wordmark reads poorly at small sizes** — a single bold glyph/monogram is
  stronger if you ever want better legibility.

## Caveats (PWA vs native)
- PWAs supply a **single** image; native apps use multi-layer Icon Composer. In
  iOS 26's **Clear / Tinted** home-screen styles a single-image PWA icon renders
  poorly — there is no web fix for this.
- iOS reads the `apple-touch-icon` at **add-to-home-screen time** and won't swap it
  live when the system theme changes, so the dark-icon script is an enhancement,
  not a guarantee.
