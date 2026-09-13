#!/usr/bin/env node
/**
 * Draws the admin's home-screen icons and writes them into `public/`.
 *
 * WHY A GENERATOR RATHER THAN THREE COMMITTED PNGS WITH NO SOURCE. The icon is
 * the shell's brand mark (`.shell__brand-mark` in styles/shell.css): a rounded
 * tile carrying a conic gradient through the brand hues with the monogram on
 * top, on the navy the app paints. When a token moves, this file is how the
 * icons move with it, instead of drifting until someone notices the home
 * screen is a different orange from the rail. The PNGs are committed too, so a
 * plain `npm run build` never has to run this.
 *
 * NO IMAGE DEPENDENCY, deliberately. This machine has no ImageMagick, no
 * librsvg and no `sharp`, and adding a native module to the workspace to draw
 * three squares would be a poor trade. Node ships zlib, which is the only part
 * of PNG that is not a dozen lines of arithmetic, so the encoder is below.
 *
 * Run: node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Brand values, copied from src/styles/tokens.css (dark scheme, the only one
//    the admin paints since the 2026-09-11 ruling). ────────────────────────────
const NAVY = [0x11, 0x13, 0x1f];
const CREAM = [0xfb, 0xfb, 0xf9];
const ACCENT = [0x1f, 0xa0, 0xb0]; // --color-accent
const TERTIARY = [0x8e, 0x6b, 0xa6]; // --color-tertiary
const PRIMARY = [0xf0, 0x94, 0x46]; // --color-primary

/**
 * How much of the canvas the tile takes.
 *
 * 0.55 for the manifest icons because they are declared `any maskable`, and a
 * maskable icon may be cropped to a circle of 80% of the canvas. A 0.55 square
 * has a diagonal of 0.78, so every corner of the tile survives that crop. The
 * Apple touch icon is never masked that way (iOS rounds the corners itself), so
 * it gets a larger mark and would look shrunken at 0.55.
 */
const TILE_FRACTION_MASKABLE = 0.55;
const TILE_FRACTION_APPLE = 0.68;

// ── Tiny geometry helpers. Everything is sampled, so they only answer
//    "is this point inside", never "draw a shape". ────────────────────────────

/** Signed distance to a rounded square centred on the origin. Negative inside. */
function roundedSquareDistance(x, y, half, radius) {
  const dx = Math.abs(x) - (half - radius);
  const dy = Math.abs(y) - (half - radius);
  const outsideX = Math.max(dx, 0);
  const outsideY = Math.max(dy, 0);
  return Math.hypot(outsideX, outsideY) + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / lengthSquared));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * The conic gradient the rail's mark carries: `from 200deg`, through accent,
 * tertiary, primary and back to accent. CSS measures the angle clockwise from
 * twelve o'clock, which is what `atan2(dx, -dy)` gives.
 */
function conicColor(dx, dy) {
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  const t = (((degrees - 200) % 360) + 360) / 360 - Math.floor((((degrees - 200) % 360) + 360) / 360);
  const stops = [ACCENT, TERTIARY, PRIMARY, ACCENT];
  const span = 1 / (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(t / span));
  const local = (t - index * span) / span;
  const from = stops[index];
  const to = stops[index + 1];
  return [0, 1, 2].map((c) => from[c] + (to[c] - from[c]) * local);
}

/** Blend `over` onto `under` at the given coverage (0 to 1). */
function blend(under, over, coverage) {
  return [0, 1, 2].map((c) => under[c] + (over[c] - under[c]) * coverage);
}

/**
 * The monogram, as three thick segments: two diagonals meeting at an apex and
 * a crossbar between them. Drawn from geometry rather than from a font so the
 * icons do not depend on a typeface being installed wherever this runs.
 */
function monogramCoverage(x, y, size) {
  const height = size * 0.62;
  const width = size * 0.52;
  const thickness = size * 0.115;
  const apexX = 0;
  const apexY = -height / 2;
  const leftFootX = -width / 2;
  const rightFootX = width / 2;
  const footY = height / 2;
  // The crossbar sits at 62% of the way down each diagonal, which is where the
  // rail's mark carries it.
  const barT = 0.62;
  const barLeftX = apexX + (leftFootX - apexX) * barT;
  const barRightX = apexX + (rightFootX - apexX) * barT;
  const barY = apexY + (footY - apexY) * barT;

  const distance = Math.min(
    distanceToSegment(x, y, apexX, apexY, leftFootX, footY),
    distanceToSegment(x, y, apexX, apexY, rightFootX, footY),
    distanceToSegment(x, y, barLeftX, barY, barRightX, barY),
  );
  return distance <= thickness / 2 ? 1 : 0;
}

/**
 * Renders one icon into an RGBA buffer.
 *
 * Supersampled 4x4 per pixel. Nothing here has a curve worth a real rasteriser,
 * and averaging sixteen samples is what keeps the tile's corners and the
 * monogram's diagonals from looking like stairs at 192 pixels.
 */
function renderIcon(size, tileFraction) {
  const samples = 4;
  const tileHalf = (size * tileFraction) / 2;
  // The rail uses --radius-card-lg on a 34px tile, which is a corner a little
  // under a third of the half-width. Kept proportional so every size matches.
  const tileRadius = tileHalf * 0.42;
  const pixels = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = px + (sx + 0.5) / samples - size / 2;
          const y = py + (sy + 0.5) / samples - size / 2;
          let color = NAVY;
          const tile = roundedSquareDistance(x, y, tileHalf, tileRadius);
          if (tile < 0) {
            color = blend(color, conicColor(x, y), 1);
            if (monogramCoverage(x, y, tileHalf * 2) === 1) color = CREAM;
          }
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const total = samples * samples;
      const offset = (py * size + px) * 4;
      pixels[offset] = Math.round(r / total);
      pixels[offset + 1] = Math.round(g / total);
      pixels[offset + 2] = Math.round(b / total);
      pixels[offset + 3] = 255; // Opaque. A maskable icon must fill its canvas.
    }
  }
  return pixels;
}

// ── PNG encoding ────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // One filter byte (0, "none") per scanline. These images are gradients and
  // flat fills; a smarter filter would save bytes the icons do not have.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write them ──────────────────────────────────────────────────────────────

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const icons = [
  { file: 'icon-192.png', size: 192, tile: TILE_FRACTION_MASKABLE },
  { file: 'icon-512.png', size: 512, tile: TILE_FRACTION_MASKABLE },
  { file: 'apple-touch-icon.png', size: 180, tile: TILE_FRACTION_APPLE },
];

for (const { file, size, tile } of icons) {
  const png = encodePng(size, renderIcon(size, tile));
  writeFileSync(join(publicDir, file), png);
  console.log(`wrote public/${file} (${String(size)}x${String(size)}, ${String(png.length)} bytes)`);
}
