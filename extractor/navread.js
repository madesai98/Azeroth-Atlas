// Reads the "where can you stand" data the nav job wrote (maps/<id>/nav/<col>_<row>.bin; see
// jobs/nav.js) back in, for answering: what is there to stand on at this spot, and how high?
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { unpackContainer } from './container.js';
import { FLOOR } from './jobs/nav.js';

const TILE = 1600 / 3, N = 512, CELL = TILE / N;
const STEP = 1.3;    // yards you can step up or down between neighbouring cells and back again
const OPEN_GROUND = 4000; // floors joined together into a stretch this big are open ground (a roof or a ledge is smaller)

/**
 * Which stretch of walkable ground each floor of a tile belongs to: floors you can walk between
 * in both directions are one stretch (a drop you cannot climb back up does not join them, so
 * a roof you could only jump off is not part of the street below).
 * @returns { id: Int32Array (stretch of each floor), open: Uint8Array (1 = the stretch is open ground: big, or it runs on into the next tile) }
 */
function stretches(t) {
  const n = t.z.length, parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const edge = new Uint8Array(n); // leads off the tile
  const DI = [1, -1, 0, 0], DJ = [0, 0, 1, -1], BIT = [FLOOR.EAST, FLOOR.WEST, FLOOR.SOUTH, FLOOR.NORTH], BACK = [FLOOR.WEST, FLOOR.EAST, FLOOR.NORTH, FLOOR.SOUTH];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const cell = j * N + i;
    for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) {
      for (let d = 0; d < 4; d++) {
        if (!(t.flags[k] & BIT[d])) continue;
        const ni = i + DI[d], nj = j + DJ[d];
        if (ni < 0 || ni >= N || nj < 0 || nj >= N) { edge[k] = 1; continue; }
        if (d === 1 || d === 3) continue; // each pair once
        const nc = nj * N + ni;
        for (let q = t.offs[nc]; q < t.offs[nc + 1]; q++) {
          if (Math.abs(t.z[q] - t.z[k]) <= STEP && t.flags[q] & BACK[d]) { const a = find(k), b = find(q); if (a !== b) parent[a] = b; break; }
        }
      }
    }
  }
  const size = new Int32Array(n), out = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const r = find(i); size[r]++; if (edge[i]) out[r] = 1; }
  const id = new Int32Array(n), open = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const r = find(i); id[i] = r; open[i] = out[r] || size[r] >= OPEN_GROUND ? 1 : 0; }
  return { id, open };
}

export class NavReader {
  /** @param dir  the map's nav folder  @param keep  how many tiles to hold in memory */
  constructor(dir, keep = 24) {
    this.dir = dir;
    this.keep = keep;
    this.tiles = new Map(); // "col_row" -> { offs, z, flags } | null, most recently used last
  }

  #tile(col, row) {
    const key = `${col}_${row}`;
    if (this.tiles.has(key)) { const t = this.tiles.get(key); this.tiles.delete(key); this.tiles.set(key, t); return t; }
    let tile = null;
    try {
      const { sections } = unpackContainer(fs.readFileSync(path.join(this.dir, `${key}.bin`)), 'WFN1');
      const counts = zlib.inflateRawSync(sections.get(2)), zb = zlib.inflateRawSync(sections.get(3)), flags = zlib.inflateRawSync(sections.get(4));
      const q = new Uint16Array(zb.buffer, zb.byteOffset, zb.byteLength >> 1);
      const z = new Float32Array(q.length);
      for (let i = 0, acc = 0; i < q.length; i++) { acc = (acc + q[i]) & 0xffff; z[i] = acc / 8 - 2048; } // stored as differences
      const offs = new Uint32Array(N * N + 1);
      for (let c = 0; c < N * N; c++) offs[c + 1] = offs[c] + counts[c];
      tile = { key, offs, z, flags, xN: (32 - row) * TILE, yW: (32 - col) * TILE, parts: null };
    } catch { tile = null; }
    this.tiles.set(key, tile);
    while (this.tiles.size > this.keep) this.tiles.delete(this.tiles.keys().next().value);
    return tile;
  }

  /**
   * Everything there is to stand on at a spot, lowest first.
   * @param reach  cells to look around the spot's own cell (0 = that cell only)
   * @returns [{ z, terrain, swim, built (a floor of a building or an object), open (part of the open ground
   *            you can walk about on, not a roof, a ledge or the earth shut in under a floor), part (which stretch of
   *            walkable ground it belongs to: the same for every floor you can walk between, within a tile), d (yards from the spot) }]
   */
  floorsAt(x, y, reach = 0) {
    const out = [];
    for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
      const px = x - dj * CELL, py = y - di * CELL;
      const t = this.#tile(Math.floor(32 - py / TILE), Math.floor(32 - px / TILE));
      if (!t) continue;
      const i = Math.min(N - 1, Math.max(0, Math.floor((t.yW - py) / CELL))), j = Math.min(N - 1, Math.max(0, Math.floor((t.xN - px) / CELL)));
      const cell = j * N + i;
      if (t.offs[cell + 1] > t.offs[cell] && !t.parts) t.parts = stretches(t);
      for (let k = t.offs[cell]; k < t.offs[cell + 1]; k++) {
        const f = t.flags[k];
        out.push({ z: t.z[k], terrain: !!(f & FLOOR.TERRAIN), swim: !!(f & FLOOR.SWIM), built: !(f & (FLOOR.TERRAIN | FLOOR.SWIM)), open: !!t.parts.open[k], part: `${t.key}:${t.parts.id[k]}`, d: Math.hypot(di, dj) * CELL });
      }
    }
    return out.sort((a, b) => a.z - b.z || a.d - b.d);
  }
}
