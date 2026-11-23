// The walking ground of a whole map, in the large: which stretches of ground lead on to which.
// → maps/<id>/nav/coarse.bin
//
// The ground itself is kept a yard at a time, a tile to a file (nav.js), and the route search
// (viewer/js/navworker.js) goes over it floor by floor. That finds any way of a few hundred
// yards in no time - and no way at all across a zone or two: with a mountain range between you
// and where you are heading it looks at two million floors on the near side and gives up, "too
// far to work out on foot" (from Astranaar to Felwood, from Auberdine round by Ashenvale: a
// report of 22 November 2026 - "Router doesnt always track the currently selected and followed
// quest": a quest whose place was a zone away got no route at all).
//
// So the same ground is written once more, small enough to be searched from one end of a
// continent to the other in a blink. Every tile is cut into squares of 64 by 64 cells (some 67
// yards); within a square, the floors that can be walked between, there and back, are one
// "stretch" (so the two banks of a ravine, the street and the roofs over it, the hall and its
// cellar are a stretch each). A stretch is written as one place - a floor of it, near its
// middle - and the stretches you can step on to from it, in the next square or its own: every
// step the yard-by-yard data has, taken once (a short drop that cannot be climbed back leads one
// way only, as it does there). Ground too steep to stand on is no stretch: what is slid or
// fallen down is left to the search over the real ground.
//
// The route search uses it for the way in the large - through which stretches a long walk goes -
// and then works the walk out over the real ground a piece at a time, from one of those places
// to the next (navworker.js: coarse; route.js: the long walk).
//
//   container "WFNC", version 1, sections:
//     1  meta      JSON: { cells (squares to a tile's side), tiles, stretches, links }
//     2  tiles     for each tile: u16 col, u16 row, u32 the number of its first stretch (the
//                  stretches of a tile follow each other; a last entry closes the list)
//     3  places    f32 x, y, z of each stretch's place (a floor of it: the one nearest its middle)
//     4  squares   u8 for each stretch: which square of its tile (row * cells + column)
//     5  kinds     u8 for each stretch: 1 = swum (most of it is water too deep to stand in), 2 = lava
//     6  sizes     u16 for each stretch: how many floors it has (65535: that many or more)
//     7  offsets   u32 for each stretch, and one more: where its links begin in...
//     8  links     u32 each: the stretch stepped on to
//   (sections 3 to 8 are deflated, as the tiles' are)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { unpackContainer, packContainer, writeFileAtomic } from '../container.js';
import { NSEC, NAV_N, NAV_CELL, FLOOR, LINK_EDGE, STEP_UP, STEP_DOWN } from './nav.js';
import { TILE_SIZE } from '../formats/chunked.js';

export const NAVCOARSE_VERSION = 1;
export const COARSE_CELLS = 8;                 // squares to a tile's side
export const COARSE_FILE = 'coarse.bin';
export const CSEC = { META: 1, TILES: 2, PLACES: 3, SQUARES: 4, KINDS: 5, SIZES: 6, OFFSETS: 7, LINKS: 8 };
const N = NAV_N, SPAN = N / COARSE_CELLS;      // cells to a square's side
const OPEN = [FLOOR.EAST, FLOOR.WEST, FLOOR.SOUTH, FLOOR.NORTH];
const DI = [1, -1, 0, 0], DJ = [0, 0, 1, -1];  // (east and west along a row of cells, south and north from row to row: as navworker.js has it)

/** One tile as nav.js wrote it: { col, row, offs, z, flags, links } - or null (no such file, or one from before links were kept). */
function readTile(dir, col, row) {
  let buf;
  try { buf = fs.readFileSync(path.join(dir, `${col}_${row}.bin`)); } catch { return null; }
  const { sections } = unpackContainer(buf, 'WFN1');
  if (!sections.has(NSEC.LINKS)) return null;
  const counts = zlib.inflateRawSync(sections.get(NSEC.COUNTS)), zb = zlib.inflateRawSync(sections.get(NSEC.HEIGHTS)), flags = zlib.inflateRawSync(sections.get(NSEC.FLAGS)), lb = zlib.inflateRawSync(sections.get(NSEC.LINKS));
  const q = new Uint16Array(zb.buffer.slice(zb.byteOffset, zb.byteOffset + zb.byteLength));
  const z = new Float32Array(q.length);
  for (let i = 0, acc = 0; i < q.length; i++) { acc = (acc + q[i]) & 0xffff; z[i] = acc / 8 - 2048; } // stored as differences
  if (lb.byteLength >> 1 !== z.length) return null;
  const links = new Uint16Array(lb.buffer.slice(lb.byteOffset, lb.byteOffset + lb.byteLength));
  const offs = new Uint32Array(N * N + 1);
  for (let c = 0; c < N * N; c++) offs[c + 1] = offs[c] + counts[c];
  return { col, row, offs, z, flags, links, xN: (32 - row) * TILE_SIZE, yW: (32 - col) * TILE_SIZE };
}

/**
 * The floor stepped on to going one cell that way from a floor, within the tile: its number, or
 * -1 (closed that way, or the next cell is on the next tile).
 */
function hop(t, cell, k, d) {
  if (!(t.flags[k] & OPEN[d])) return -1;
  const v = (t.links[k] >> (d * 4)) & 15;
  if (!v || v === LINK_EDGE) return -1;
  const i = (cell % N) + DI[d], j = ((cell / N) | 0) + DJ[d];
  if (i < 0 || i >= N || j < 0 || j >= N) return -1;
  const q = t.offs[j * N + i] + v - 1;
  return q < t.offs[j * N + i + 1] ? q : -1;
}

/**
 * The stretches of one tile: { label (the stretch of each floor, counted from 0 within the tile,
 * -1 for none), n, x, y, z (each stretch's place), square, kind, size, links (pairs: from, to -
 * within the tile), edge (for each of its four sides, what the next tile needs to step across:
 * for each cell along it its floors' heights, flags and stretches) }
 */
function stretchesOf(t) {
  const floors = t.z.length;
  const label = new Int32Array(floors).fill(-1), cellOf = new Int32Array(floors);
  for (let c = 0; c < N * N; c++) for (let k = t.offs[c]; k < t.offs[c + 1]; k++) cellOf[k] = c;
  const squareOf = (cell) => (((cell / N) | 0) / SPAN | 0) * COARSE_CELLS + (((cell % N) / SPAN) | 0);
  let n = 0;
  const stack = [];
  const sx = [], sy = [], sz = [], swum = [], lava = [], size = [], square = [];
  for (let k0 = 0; k0 < floors; k0++) {
    if (label[k0] >= 0 || t.flags[k0] & FLOOR.STEEP) continue;
    const id = n++, sq = squareOf(cellOf[k0]);
    let ax = 0, ay = 0, az = 0, count = 0, wet = 0, hot = 0;
    label[k0] = id;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop(), cell = cellOf[k];
      ax += (cell / N) | 0; ay += cell % N; az += t.z[k]; count++;
      if (t.flags[k] & FLOOR.SWIM) wet++;
      if (t.flags[k] & FLOOR.LAVA) hot++;
      for (let d = 0; d < 4; d++) {
        const q = hop(t, cell, k, d);
        if (q < 0 || label[q] >= 0 || t.flags[q] & FLOOR.STEEP) continue;
        const qc = cellOf[q];
        // (one stretch only where you can step back: and only within the square)
        if (squareOf(qc) !== sq || hop(t, qc, q, d ^ 1) !== k) continue;
        label[q] = id;
        stack.push(q);
      }
    }
    sx.push(ax / count); sy.push(ay / count); sz.push(az / count);
    swum.push(wet * 2 > count ? 1 : 0); lava.push(hot * 2 > count ? 1 : 0); size.push(count); square.push(sq);
  }
  // each stretch's place: the floor of it nearest its middle (a real place to stand, not the middle of a ring)
  const best = new Float64Array(n).fill(Infinity), at = new Int32Array(n).fill(-1);
  for (let k = 0; k < floors; k++) {
    const id = label[k];
    if (id < 0) continue;
    const cell = cellOf[k], dj = ((cell / N) | 0) - sx[id], di = (cell % N) - sy[id], dz = (t.z[k] - sz[id]) * 2;
    // (a floor you swim on is no place to send anyone where the stretch has ground too)
    const far = dj * dj + di * di + dz * dz + (t.flags[k] & FLOOR.SWIM && !swum[id] ? 1e6 : 0);
    if (far < best[id]) { best[id] = far; at[id] = k; }
  }
  const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n);
  for (let id = 0; id < n; id++) {
    const cell = cellOf[at[id]];
    x[id] = t.xN - (((cell / N) | 0) + 0.5) * NAV_CELL; y[id] = t.yW - ((cell % N) + 0.5) * NAV_CELL; z[id] = t.z[at[id]];
  }
  // the steps from one stretch on to another, within the tile
  const seen = new Set(), links = [];
  for (let k = 0; k < floors; k++) {
    const a = label[k];
    if (a < 0) continue;
    const cell = cellOf[k];
    for (let d = 0; d < 4; d++) {
      const q = hop(t, cell, k, d);
      if (q < 0) continue;
      const b = label[q];
      if (b < 0 || b === a) continue;
      const key = a * n + b;
      if (!seen.has(key)) { seen.add(key); links.push(a, b); }
    }
  }
  // what the next tile needs, along each side: east (the last column), west (the first), south (the last row), north (the first)
  const edge = [];
  for (let d = 0; d < 4; d++) {
    const offs = new Uint32Array(N + 1);
    const zs = [], fs_ = [], ids = [];
    for (let a = 0; a < N; a++) {
      const cell = (d === 2 ? N - 1 : d === 3 ? 0 : a) * N + (d === 0 ? N - 1 : d === 1 ? 0 : a);
      for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) { zs.push(t.z[k]); fs_.push(t.flags[k]); ids.push(label[k]); }
      offs[a + 1] = zs.length;
    }
    edge.push({ offs, z: Float32Array.from(zs), flags: Uint8Array.from(fs_), id: Int32Array.from(ids) });
  }
  return { n, x, y, z, square: Uint8Array.from(square), kind: Uint8Array.from(swum.map((w, i) => (w ? 1 : 0) | (lava[i] ? 2 : 0))), size: Uint16Array.from(size.map((v) => Math.min(v, 65535))), links, edge };
}

/**
 * The steps across the side between two tiles: from each floor along `a`'s side that is open
 * that way on to the floor of `b` it leads to - the highest within a step that is open on its
 * own side, as the route search has it across a tile's edge (navworker.js: hop) - as pairs of
 * stretches (each counted within its own tile).
 * @param d  the side of `a`: 0 east, 2 south (the other way round is asked with a and b swapped: 1, 3)
 */
function across(a, b, d, out) {
  const from = a.edge[d], to = b.edge[d ^ 1], back = OPEN[d ^ 1];
  for (let c = 0; c < N; c++) {
    for (let k = from.offs[c]; k < from.offs[c + 1]; k++) {
      if (from.id[k] < 0 || !(from.flags[k] & OPEN[d])) continue;
      let best = -1;
      for (let q = to.offs[c]; q < to.offs[c + 1]; q++) { const dz = to.z[q] - from.z[k]; if (dz <= STEP_UP && dz >= -STEP_DOWN && to.flags[q] & back) best = q; }
      if (best >= 0 && to.id[best] >= 0) out.push(from.id[k], to.id[best]);
    }
  }
}

/**
 * @param job { dir (the map's nav folder), tiles: [[col, row], ...], out }
 * @returns { tiles, stretches, links, bytes } - or { stretches: 0 } where there is nothing to write
 *          (no tile with its links: ground built before they were kept)
 */
export function buildNavCoarse(job) {
  const tiles = [];
  for (const [col, row] of job.tiles) {
    const t = readTile(job.dir, col, row);
    if (!t) continue;
    const s = stretchesOf(t);
    if (s.n) tiles.push({ col, row, ...s, first: 0 });
  }
  if (!tiles.length) { try { fs.rmSync(job.out, { force: true }); } catch { /* none there */ } return { tiles: 0, stretches: 0, links: 0, bytes: 0 }; }
  tiles.sort((p, q) => p.col - q.col || p.row - q.row);
  let total = 0;
  const at = new Map();
  for (const t of tiles) { t.first = total; total += t.n; at.set(t.col * 128 + t.row, t); }
  // every step from one stretch on to another, as numbers of the whole map: within a tile, and across its sides
  const sets = Array.from({ length: total }, () => null);
  const add = (a, b) => { if (a === b) return; (sets[a] ??= new Set()).add(b); };
  for (const t of tiles) {
    for (let i = 0; i < t.links.length; i += 2) add(t.first + t.links[i], t.first + t.links[i + 1]);
    for (const [d, dc, dr] of [[0, 1, 0], [2, 0, 1]]) {
      const o = at.get((t.col + dc) * 128 + t.row + dr);
      if (!o) continue;
      const there = [], back = [];
      across(t, o, d, there);
      across(o, t, d ^ 1, back);
      for (let i = 0; i < there.length; i += 2) add(t.first + there[i], o.first + there[i + 1]);
      for (let i = 0; i < back.length; i += 2) add(o.first + back[i], t.first + back[i + 1]);
    }
  }
  // A stretch nothing leads on to and that leads on to nothing is left out: a roof, a tree top, a
  // ledge, the inside of a rock - three in four of them, and no way goes through one. (Where you
  // stand on one, or are heading for one, the way begins or ends at the stretch beside it, and
  // the search over the real ground does the rest: navworker.js.)
  const kept = new Uint8Array(total);
  for (let i = 0; i < total; i++) if (sets[i]) { kept[i] = 1; for (const b of sets[i]) kept[b] = 1; }
  const renumber = new Int32Array(total).fill(-1);
  let count = 0;
  for (let i = 0; i < total; i++) if (kept[i]) renumber[i] = count++;
  const offsets = new Uint32Array(count + 1);
  let links = 0;
  for (let i = 0; i < total; i++) if (kept[i]) { offsets[renumber[i]] = links; links += sets[i]?.size ?? 0; }
  offsets[count] = links;
  const to = new Uint32Array(links);
  for (let i = 0, p = 0; i < total; i++) if (sets[i]) for (const b of [...sets[i]].sort((u, v) => u - v)) to[p++] = renumber[b];
  const places = new Float32Array(count * 3), squares = new Uint8Array(count), kinds = new Uint8Array(count), sizes = new Uint16Array(count);
  const table = Buffer.alloc((tiles.length + 1) * 8);
  let first = 0;
  tiles.forEach((t, i) => {
    table.writeUInt16LE(t.col, i * 8); table.writeUInt16LE(t.row, i * 8 + 2); table.writeUInt32LE(first, i * 8 + 4);
    for (let k = 0; k < t.n; k++) {
      const g = renumber[t.first + k];
      if (g < 0) continue;
      places[g * 3] = t.x[k]; places[g * 3 + 1] = t.y[k]; places[g * 3 + 2] = t.z[k];
      squares[g] = t.square[k]; kinds[g] = t.kind[k]; sizes[g] = t.size[k];
      first = g + 1;
    }
  });
  table.writeUInt16LE(0xffff, tiles.length * 8); table.writeUInt16LE(0xffff, tiles.length * 8 + 2); table.writeUInt32LE(count, tiles.length * 8 + 4);
  const pack = (a) => zlib.deflateRawSync(Buffer.from(a.buffer, a.byteOffset, a.byteLength), { level: 6 });
  const meta = { cells: COARSE_CELLS, tiles: tiles.length, stretches: count, links, leftOut: total - count };
  const out = packContainer('WFNC', NAVCOARSE_VERSION, [
    { id: CSEC.META, data: Buffer.from(JSON.stringify(meta)) }, { id: CSEC.TILES, data: table },
    { id: CSEC.PLACES, data: pack(places) }, { id: CSEC.SQUARES, data: pack(squares) }, { id: CSEC.KINDS, data: pack(kinds) }, { id: CSEC.SIZES, data: pack(sizes) },
    { id: CSEC.OFFSETS, data: pack(offsets) }, { id: CSEC.LINKS, data: pack(to) },
  ]);
  writeFileAtomic(job.out, out);
  return { ...meta, bytes: out.length };
}
