// Multi-resolution terrain pyramid. A level-L page covers 2^L x 2^L tiles with the same
// 128x128-cell grid and 512px colour texture as a single tile, so the viewer can draw any
// altitude at full sharpness. Pages are assembled from their four children:
//   * heights/normals: exact subsampling (every 2nd vertex) - vertices stay on the true surface
//   * colour: BC1 blocks copied verbatim from the children's next-smaller mips (no re-encode)
//   * water: a coarse level/kind grid for distant lakes, rivers and sea
import fs from 'node:fs';
import { parseBLP } from '../formats/blp.js';
import { OUTER } from '../formats/adt.js';
import { packContainer, unpackContainer, writeFileAtomic, f32View } from '../container.js';
import { SEC, parseLiquidSection } from './tile.js';

export const PAGE_VERSION = 1;
export const TOP_LEVEL = 3;
export const PSEC = { HEIGHTS: 1, NORMALS: 2, COLOR: 3, COVERAGE: 4, WATER_LEVEL: 5, WATER_KIND: 6, META: 7 };
const NO_WATER = -1e9;
const N = 129;

function flatBlock(r, g, b) {
  const c = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  const blk = Buffer.alloc(8);
  blk.writeUInt16LE(c, 0);
  blk.writeUInt16LE(c, 2);
  return blk;
}
const FALLBACK = flatBlock(62, 70, 58);

function writeBLP(mips) {
  // mips: [{ size(px), data(Buffer of BC1 blocks) }]
  const header = Buffer.alloc(148 + 1024);
  header.write('BLP2', 0, 'latin1');
  header.writeUInt32LE(1, 4);
  header[8] = 2; header[9] = 0; header[10] = 0; header[11] = 1;
  header.writeUInt32LE(mips[0].size, 12);
  header.writeUInt32LE(mips[0].size, 16);
  let off = header.length;
  mips.forEach((m, i) => {
    header.writeUInt32LE(off, 20 + i * 4);
    header.writeUInt32LE(m.data.length, 84 + i * 4);
    off += m.data.length;
  });
  return Buffer.concat([header, ...mips.map((m) => m.data)]);
}

/**
 * @param job { level, children:[{dx,dy,file,color}|null x4], out, ocean, seaLevel, kinds:{typeId:kindIndex} }
 *   children of a level-1 page are tiles (file = tile .bin, color = .blp path or null);
 *   children of higher levels are pages.
 */
export function buildPage(job) {
  const { level } = job;
  const heights = new Float32Array(N * N).fill(NaN);
  const normals = new Int8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) normals[i * 4 + 2] = 127;
  const covSide = 1 << level;
  const coverage = new Uint8Array(covSide * covSide);
  const waterLevel = new Float32Array(128 * 128).fill(NO_WATER);
  const waterKind = new Uint8Array(128 * 128);
  let anyWater = false;
  let minH = Infinity, maxH = -Infinity;

  const loaded = job.children.map((ch) => {
    if (!ch) return null;
    const buf = fs.readFileSync(ch.file);
    if (level === 1) {
      const c = unpackContainer(buf, 'WFT1');
      let blp = null;
      if (ch.color) { try { blp = parseBLP(fs.readFileSync(ch.color)); if (blp.format !== 'bc1') blp = null; } catch { blp = null; } }
      return { ...ch, tile: c, blp };
    }
    const c = unpackContainer(buf, 'WFP1');
    let blp = null;
    try { blp = parseBLP(c.sections.get(PSEC.COLOR)); } catch { blp = null; }
    return { ...ch, page: c, blp };
  });

  // Colour mip chain: quadrant q of page mip m comes from child mip m+1.
  let mipCount = 7;
  for (const ch of loaded) if (ch?.blp) mipCount = Math.min(mipCount, ch.blp.mips.filter((s) => s.width >= 4).length - 1);
  mipCount = Math.max(1, mipCount);
  const mips = [];
  for (let m = 0; m < mipCount; m++) {
    const size = 512 >> m, blocks = size / 4;
    const data = Buffer.alloc(blocks * blocks * 8);
    for (let i = 0; i < blocks * blocks; i++) FALLBACK.copy(data, i * 8);
    mips.push({ size, blocks, data });
  }

  for (const ch of loaded) {
    if (!ch) continue;
    const ox = ch.dx * 64, oy = ch.dy * 64;
    const secs = (ch.tile ?? ch.page).sections;
    // -- heights + normals
    const H = f32View(secs.get(ch.tile ? SEC.HEIGHTS : PSEC.HEIGHTS), OUTER * OUTER);
    const ns = secs.get(ch.tile ? SEC.NORMALS : PSEC.NORMALS);
    let cov = null;
    if (ch.page) cov = secs.get(PSEC.COVERAGE);
    const half = covSide >> 1;
    for (let b = 0; b <= 64; b++) for (let a = 0; a <= 64; a++) {
      const s = b * 2 * OUTER + a * 2;
      // Skip vertices that only belong to missing tiles inside a child page.
      if (cov) {
        const cellsPerTile = 128 / half; // child cells per tile
        const ta = Math.min(half - 1, Math.floor((a * 2) / cellsPerTile)), tb = Math.min(half - 1, Math.floor((b * 2) / cellsPerTile));
        const ta0 = Math.max(0, Math.ceil((a * 2) / cellsPerTile) - 1), tb0 = Math.max(0, Math.ceil((b * 2) / cellsPerTile) - 1);
        if (!cov[tb * half + ta] && !cov[tb0 * half + ta0] && !cov[tb * half + ta0] && !cov[tb0 * half + ta]) continue;
      }
      const o = (oy + b) * N + ox + a;
      const h = H[s];
      heights[o] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      normals[o * 4] = ns.readInt8(s * 4); normals[o * 4 + 1] = ns.readInt8(s * 4 + 1); normals[o * 4 + 2] = ns.readInt8(s * 4 + 2);
    }
    // -- coverage
    if (ch.tile) coverage[ch.dy * covSide + ch.dx] = 1;
    else for (let y = 0; y < half; y++) for (let x = 0; x < half; x++) coverage[(ch.dy * half + y) * covSide + ch.dx * half + x] = cov[y * half + x];
    // -- colour
    if (ch.blp) {
      for (let m = 0; m < mipCount; m++) {
        const mip = mips[m];
        const q = mip.blocks / 2; // blocks per quadrant side
        const src = ch.blp.mips.find((s) => s.width === q * 4 && s.height === q * 4);
        if (!src) continue;
        for (let by = 0; by < q; by++) {
          ch.blp.buf.copy(mip.data, ((ch.dy * q + by) * mip.blocks + ch.dx * q) * 8, src.offset + by * q * 8, src.offset + (by + 1) * q * 8);
        }
      }
    }
    // -- water
    if (ch.tile) {
      for (const L of parseLiquidSection(secs.get(SEC.LIQUID))) {
        const kind = job.kinds[L.type] ?? 1;
        const cr = L.chunk >> 4, cc = L.chunk & 15;
        for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
          const bit = y * L.w + x;
          if (L.exists && !((L.exists[bit >> 3] >> (bit & 7)) & 1)) continue;
          const lvl = L.heights ? L.heights[y * (L.w + 1) + x] : L.minH;
          const o = (oy + ((cr * 8 + L.y + y) >> 1)) * 128 + ox + ((cc * 8 + L.x + x) >> 1);
          if (lvl > waterLevel[o]) { waterLevel[o] = lvl; waterKind[o] = kind; anyWater = true; }
        }
      }
    } else {
      const wl = secs.get(PSEC.WATER_LEVEL), wk = secs.get(PSEC.WATER_KIND);
      if (wl) {
        const W = f32View(wl, 128 * 128);
        for (let b = 0; b < 64; b++) for (let a = 0; a < 64; a++) {
          let best = NO_WATER, kind = 0;
          for (let k = 0; k < 4; k++) {
            const s = (b * 2 + (k >> 1)) * 128 + a * 2 + (k & 1);
            if (W[s] > best) { best = W[s]; kind = wk[s]; }
          }
          if (kind) { const o = (oy + b) * 128 + ox + a; waterLevel[o] = best; waterKind[o] = kind; anyWater = true; }
        }
      }
    }
  }
  // Open sea: where the map has no tile at all the ocean simply continues.
  if (job.ocean) {
    const cellsPerTile = 128 / covSide;
    for (let ty = 0; ty < covSide; ty++) for (let tx = 0; tx < covSide; tx++) {
      if (coverage[ty * covSide + tx]) continue;
      for (let y = 0; y < cellsPerTile; y++) for (let x = 0; x < cellsPerTile; x++) {
        const o = (ty * cellsPerTile + y) * 128 + tx * cellsPerTile + x;
        waterLevel[o] = job.seaLevel; waterKind[o] = 2;
      }
      anyWater = true;
    }
  }
  if (minH === Infinity) { minH = 0; maxH = 0; }
  // Vertices nobody wrote (inside missing tiles) sit at the lowest real height so they never
  // poke out; the coverage mask discards them when drawing anyway.
  for (let i = 0; i < N * N; i++) if (Number.isNaN(heights[i])) heights[i] = minH;
  const meta = new Float32Array([minH, maxH]);
  const sections = [
    { id: PSEC.HEIGHTS, data: heights }, { id: PSEC.NORMALS, data: normals },
    { id: PSEC.COLOR, data: writeBLP(mips) }, { id: PSEC.COVERAGE, data: coverage }, { id: PSEC.META, data: meta },
  ];
  if (anyWater) sections.push({ id: PSEC.WATER_LEVEL, data: waterLevel }, { id: PSEC.WATER_KIND, data: waterKind });
  writeFileAtomic(job.out, packContainer('WFP1', PAGE_VERSION, sections));
  return { minH, maxH, water: anyWater };
}
