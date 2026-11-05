// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-blue gradient, a
// door lock (a round knob on a rounded plate, its LED ring lit) and a bridge
// with its waves on the right. Plain Node (zlib), no dependency.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [18, 26, 40];
const BLUE = [30, 110, 190];
const WHITE = [255, 255, 255];
const ACCENT = [255, 196, 64];
const GREEN = [90, 210, 120];

const inBox = (x, y, x0, y0, x1, y1, r) => {
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return smooth(r, Math.hypot(dx, dy));
};

/** The colour of one pixel. */
function pixel(x, y) {
  let color = mix(DARK, BLUE, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // The lock: a tall rounded plate.
  color = mix(color, [210, 214, 222], inBox(x, y, 250, 70, 430, 470, 40));
  // The knob and its LED ring (accent: locked at night).
  const knob = Math.hypot(x - 340, y - 230);
  color = mix(color, WHITE, smooth(70, knob));
  color = mix(color, ACCENT, smooth(5, Math.abs(knob - 58)));
  // The cylinder below the knob.
  color = mix(color, DARK, inBox(x, y, 325, 360, 355, 420, 12));
  // The bridge: a small box with a green light.
  color = mix(color, WHITE, inBox(x, y, 540, 300, 640, 380, 16));
  color = mix(color, GREEN, smooth(8, Math.hypot(x - 590, y - 340)));
  // Its waves toward the lock.
  for (const r of [60, 90, 120]) {
    const d = Math.hypot(x - 590, y - 300);
    const arc = y < 300 && x > 520 && x < 660 ? 1 : 0;
    color = mix(color, WHITE, smooth(3, Math.abs(d - r)) * arc * 0.8);
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
