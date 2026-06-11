// Generate the PWA's flat square icon assets from the Aquatune design.
//
// Source of truth is the Apple Icon Composer doc under design/*.icon (cyan gradient
// + centered AQUATUNE wordmark). A `.icon` bundle is a NATIVE format that browsers
// can't use, so we render that design into the flat PNG/SVG assets a PWA needs and
// let iOS 26 apply its Liquid Glass treatment to the resulting apple-touch-icon.
//
// Run with: npm run icons

import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = resolve(root, 'public/icons');
mkdirSync(ICONS, { recursive: true });

// The wordmark art (1000x200), embedded so the SVG is self-contained.
const wordmark = readFileSync(resolve(ICONS, 'aquatune-wordmark.png'));
const WORDMARK_DATA = 'data:image/png;base64,' + wordmark.toString('base64');
const WM_W = 1000, WM_H = 200;

// Brand cyan gradient (sRGB approximations of the icon.json display-p3 stops).
const LIGHT = { top: '#48d8f8', bot: '#0898bc' };
const DARK = { top: '#0e7fa6', bot: '#063243' };

// Build a square SVG at a 1024 grid. `scale` = wordmark width as a fraction of the
// canvas (smaller for maskable so it stays inside the circular safe zone). The
// gradient is full-bleed + opaque (required for apple-touch-icon; safe for
// maskable). No baked rounded corners / gloss — iOS 26 adds the squircle + glass.
function buildSvg({ scale = 0.80, dark = false, withDarkMedia = false } = {}) {
  const G = 1024;
  const pal = dark ? DARK : LIGHT;
  const w = G * scale;
  const h = w * (WM_H / WM_W);
  const x = (G - w) / 2;
  const y = (G - h) / 2 - 21;            // their −21pt upward nudge
  const darkMedia = withDarkMedia ? `
    <style>
      @media (prefers-color-scheme: dark) {
        .bg-top { stop-color: ${DARK.top}; }
        .bg-bot { stop-color: ${DARK.bot}; }
      }
    </style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${G}" height="${G}" viewBox="0 0 ${G} ${G}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="bg-top" stop-color="${pal.top}"/>
        <stop offset="1" class="bg-bot" stop-color="${pal.bot}"/>
      </linearGradient>${darkMedia}
    </defs>
    <rect width="${G}" height="${G}" fill="url(#bg)"/>
    <image href="${WORDMARK_DATA}" x="${x}" y="${y.toFixed(1)}" width="${w}" height="${h.toFixed(1)}"/>
  </svg>`;
}

function png(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' })
    .render().asPng();
}

// PNG-in-ICO wrapper (Vista+; all modern browsers read it).
function ico(pngBuf, size) {
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt8(size >= 256 ? 0 : size, 6); head.writeUInt8(size >= 256 ? 0 : size, 7);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(pngBuf.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, pngBuf]);
}

const out = (name, buf) => { writeFileSync(resolve(ICONS, name), buf); console.log('  ✓', 'icons/' + name, `(${buf.length} bytes)`); };

console.log('Generating Aquatune PWA icons…');
// Canonical SVG (favicon + manifest "any"), carries its own dark-mode styling.
const svgFavicon = buildSvg({ scale: 0.90, withDarkMedia: true });
out('icon.svg', Buffer.from(svgFavicon));

const svgLight = buildSvg({ scale: 0.90 });          // big, with a tiny margin from the edges
const svgDark = buildSvg({ scale: 0.90, dark: true });
const svgMask = buildSvg({ scale: 0.70 });          // tighter so it stays inside the maskable circle
const svgMaskDark = buildSvg({ scale: 0.70, dark: true });

out('apple-touch-icon.png', png(svgLight, 180));     // iOS home screen (opaque)
out('apple-touch-icon-dark.png', png(svgDark, 180));
out('icon-192.png', png(svgLight, 192));
out('icon-512.png', png(svgLight, 512));
out('icon-192-maskable.png', png(svgMask, 192));
out('icon-512-maskable.png', png(svgMask, 512));
out('icon-512-maskable-dark.png', png(svgMaskDark, 512));
out('favicon.ico', ico(png(svgLight, 32), 32));
out('favicon-32.png', png(svgLight, 32));
out('favicon-16.png', png(svgLight, 16));
console.log('Done.');
