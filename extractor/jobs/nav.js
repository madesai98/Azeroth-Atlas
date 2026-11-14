// Navigation data for one map tile: where a character can stand, on a grid of about one yard.
//
// Every solid triangle of the tile is laid into the grid: the terrain, and the collision meshes
// of the buildings and objects placed on it. Per grid cell that gives a stack of solid spans
// (bottom, top, and whether the top is level enough to walk on). A place to stand ("floor") is
// the top of a walkable span with a character's height of free space above it. So a cell can
// have several floors (under and on a bridge, the storeys of a building), walls, tree trunks
// and steep ground leave none, and a low branch closes the ground under it.
// Water too deep to stand in becomes a floor at the surface, marked as one you swim on.
//
// The route planner connects neighbouring cells whose floors are within a step of each other.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { unpackContainer, packContainer, writeFileAtomic, f32View } from '../container.js';
import { MAP_HALF, TILE_SIZE } from '../formats/chunked.js';
import { SEC, parseLiquidSection } from './tile.js';
import { MSEC } from './model.js';

export const NAV_VERSION = 4;
export const NSEC = { META: 1, COUNTS: 2, HEIGHTS: 3, FLAGS: 4 };
export const NAV_N = 512;                 // cells per tile side
export const NAV_CELL = TILE_SIZE / NAV_N; // 1.0417 yd
// floor flags; EAST..NORTH = you can walk on to the neighbouring cell on that side
export const FLOOR = { SWIM: 1, LAVA: 2, TERRAIN: 4, EAST: 16, WEST: 32, SOUTH: 64, NORTH: 128 };
export const STEP_UP = 1.3;   // yards you can step up from one cell to the next (a 50 degree slope, a kerb)
export const STEP_DOWN = 3;   // yards you will drop from one cell to the next
const HEIGHT = 1.7;                       // free space a character needs above a floor
const SWIM_ROOM = 1.0;                    // free space needed above water to swim there
const WADE = 1.5;                         // water deeper than this over the ground: swim
const SLOPE = Math.cos((50 * Math.PI) / 180); // steeper than 50 degrees cannot be walked
const MAX_FLOORS = 7;
const DEG = Math.PI / 180;

// ---- placement transform (same convention as the viewer, verified against the game's bounds) ----
function placementMatrix(pos, rot, scale) {
  const a = (rot[1] + 180) * DEG, b = rot[0] * DEG, g = rot[2] * DEG;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  return [
    ca * cb * scale, (-sa * cg + ca * sb * sg) * scale, (sa * sg + ca * sb * cg) * scale, pos[0],
    sa * cb * scale, (ca * cg + sa * sb * sg) * scale, (-ca * sg + sa * sb * cg) * scale, pos[1],
    -sb * scale, cb * sg * scale, cb * cg * scale, pos[2],
  ];
}

// ---- collision meshes of models, cached across the tiles a worker builds ----
const meshes = new Map();
function mesh(dir, kind, fdid) {
  const key = `${kind}/${fdid}`;
  let m = meshes.get(key);
  if (m !== undefined) return m;
  m = null;
  try {
    const { sections } = unpackContainer(fs.readFileSync(path.join(dir, kind, `${fdid}.bin`)), 'WFM1');
    const idx = sections.get(MSEC.COLLISION_INDICES);
    if (idx && idx.length >= 12) {
      const indices = new Uint32Array(idx.buffer.slice(idx.byteOffset, idx.byteOffset + (idx.length & ~3)));
      let positions, wind = 0;
      if (kind === 'wmo') {
        const v = sections.get(MSEC.VERTICES);
        const n = Math.floor(v.length / 36);
        positions = new Float32Array(n * 3);
        const normals = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { positions[i * 3 + k] = v.readFloatLE(i * 36 + k * 4); normals[i * 3 + k] = v.readFloatLE(i * 36 + 12 + k * 4); }
        // Which way round are triangles wound? Decide by agreement with the stored vertex normals.
        const nT = indices.length / 3, step = Math.max(1, Math.floor(nT / 20000));
        let vote = 0;
        for (let t = 0; t < nT; t += step) {
          const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
          const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
          const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
          const dot = (uy * vz - uz * vy) * (normals[a] + normals[b] + normals[c]) + (uz * vx - ux * vz) * (normals[a + 1] + normals[b + 1] + normals[c + 1]) + (ux * vy - uy * vx) * (normals[a + 2] + normals[b + 2] + normals[c + 2]);
          vote += Math.sign(dot);
        }
        wind = vote >= 0 ? 1 : -1;
      } else {
        const v = sections.get(MSEC.COLLISION_VERTS);
        positions = v ? new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + (v.length & ~3))) : null;
      }
      if (positions) m = { indices, positions, wind };
    }
  } catch { /* a model that was not converted (missing or encrypted) simply has no collision */ }
  if (meshes.size > 600) meshes.delete(meshes.keys().next().value);
  meshes.set(key, m);
  return m;
}

/**
 * @param job { col, row, tile, models (directory of converted models), out, kinds }
 */
export function buildNav(job) {
  // everything is laid into a grid of half cells first (see "floors" below)
  const N = NAV_N * 2, CELL = NAV_CELL / 2;
  const { sections } = unpackContainer(fs.readFileSync(job.tile), 'WFT1');
  const xN = (32 - job.row) * TILE_SIZE, yW = (32 - job.col) * TILE_SIZE;

  // spans: linked lists per cell
  const head = new Int32Array(N * N).fill(-1);
  let cap = 1 << 20, count = 0;
  let sMin = new Float32Array(cap), sMax = new Float32Array(cap), sNext = new Int32Array(cap), sFlag = new Uint8Array(cap);
  const grow = () => {
    cap *= 2;
    const g = (old, T) => { const a = new T(cap); a.set(old); return a; };
    sMin = g(sMin, Float32Array); sMax = g(sMax, Float32Array); sNext = g(sNext, Int32Array); sFlag = g(sFlag, Uint8Array);
  };
  const addSpan = (cell, lo, hi, flag) => {
    if (count === cap) grow();
    sMin[count] = lo; sMax[count] = hi; sFlag[count] = flag; sNext[count] = head[cell]; head[cell] = count++;
  };

  // Clip a convex polygon (flat x, y, z triples) to the half-plane  sign * (coord - at) >= 0.
  const clip = (inp, n, out, axis, at, sign) => {
    let m = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const dj = sign * (inp[j * 3 + axis] - at), di = sign * (inp[i * 3 + axis] - at);
      if ((dj < 0) !== (di < 0)) {
        const t = dj / (dj - di);
        out[m * 3] = inp[j * 3] + (inp[i * 3] - inp[j * 3]) * t;
        out[m * 3 + 1] = inp[j * 3 + 1] + (inp[i * 3 + 1] - inp[j * 3 + 1]) * t;
        out[m * 3 + 2] = inp[j * 3 + 2] + (inp[i * 3 + 2] - inp[j * 3 + 2]) * t;
        m++;
      }
      if (di >= 0) { out[m * 3] = inp[i * 3]; out[m * 3 + 1] = inp[i * 3 + 1]; out[m * 3 + 2] = inp[i * 3 + 2]; m++; }
    }
    return m;
  };
  const tri = new Float64Array(9), p1 = new Float64Array(36), p2 = new Float64Array(36), p3 = new Float64Array(36), p4 = new Float64Array(36);
  // Lay one triangle (grid units u, v and height z) into the cells it covers. flag: 1 walkable top, 2 terrain.
  const raster = (ax, ay, az, bx, by, bz, cx, cy, cz, flag) => {
    const j0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), j1 = Math.min(N - 1, Math.floor(Math.max(ay, by, cy)));
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), i1 = Math.min(N - 1, Math.floor(Math.max(ax, bx, cx)));
    if (j0 > j1 || i0 > i1) return;
    if (i0 === i1 && j0 === j1) { addSpan(j0 * N + i0, Math.min(az, bz, cz), Math.max(az, bz, cz), flag); return; }
    tri[0] = ax; tri[1] = ay; tri[2] = az; tri[3] = bx; tri[4] = by; tri[5] = bz; tri[6] = cx; tri[7] = cy; tri[8] = cz;
    for (let j = j0; j <= j1; j++) {
      let n = clip(tri, 3, p1, 1, j, 1);
      if (n < 3) continue;
      n = clip(p1, n, p2, 1, j + 1, -1);
      if (n < 3) continue;
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < n; k++) { const x = p2[k * 3]; if (x < lo) lo = x; if (x > hi) hi = x; }
      const a0 = Math.max(i0, Math.floor(lo)), a1 = Math.min(i1, Math.floor(hi));
      for (let i = a0; i <= a1; i++) {
        let m = clip(p2, n, p3, 0, i, 1);
        if (m < 3) continue;
        m = clip(p3, m, p4, 0, i + 1, -1);
        if (m < 3) continue;
        let zl = Infinity, zh = -Infinity;
        for (let k = 0; k < m; k++) { const z = p4[k * 3 + 2]; if (z < zl) zl = z; if (z > zh) zh = z; }
        addSpan(j * N + i, zl, zh, flag);
      }
    }
  };
  // A triangle given in world yards: is its top walkable, then into grid units.
  const solid = (ax, ay, az, bx, by, bz, cx, cy, cz, wind, extra) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    const up = wind ? (nz * wind) / len : Math.abs(nz) / len;
    raster((yW - ay) / CELL, (xN - ax) / CELL, az, (yW - by) / CELL, (xN - bx) / CELL, bz, (yW - cy) / CELL, (xN - cx) / CELL, cz, (up >= SLOPE ? 1 : 0) | extra);
  };

  // ---- terrain ----
  const H = f32View(sections.get(SEC.HEIGHTS));
  const holes = sections.get(SEC.HOLES);
  const chunks = sections.get(SEC.CHUNKS);
  const Q = TILE_SIZE / 128;
  for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) {
    const ci = (j >> 3) * 16 + (i >> 3);
    if (holes && (holes[ci * 8 + (j & 7)] >> (i & 7)) & 1) continue; // a hole in the ground (cave mouth)
    const blocked = chunks ? chunks.readUInt32LE(ci * 8) & 2 : 0;     // chunk the game marks impassable
    const x0 = xN - j * Q, x1 = x0 - Q, y0 = yW - i * Q, y1 = y0 - Q, xc = x0 - Q / 2, yc = y0 - Q / 2;
    const h00 = H[j * 129 + i], h10 = H[j * 129 + i + 1], h01 = H[(j + 1) * 129 + i], h11 = H[(j + 1) * 129 + i + 1], hc = H[129 * 129 + j * 128 + i];
    const t = (ax, ay, az, bx, by, bz) => {
      // the terrain faces up whichever way its triangles are wound
      const ux = ax - xc, uy = ay - yc, uz = az - hc, vx = bx - xc, vy = by - yc, vz = bz - hc;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const walk = !blocked && Math.abs(nz) / (Math.hypot(nx, ny, nz) || 1) >= SLOPE;
      raster((yW - yc) / CELL, (xN - xc) / CELL, hc, (yW - ay) / CELL, (xN - ax) / CELL, az, (yW - by) / CELL, (xN - bx) / CELL, bz, (walk ? 1 : 0) | 2);
    };
    t(x0, y0, h00, x0, y1, h10); t(x0, y1, h10, x1, y1, h11); t(x1, y1, h11, x1, y0, h01); t(x1, y0, h01, x0, y0, h00);
  }

  // ---- buildings and objects placed on the tile ----
  const obj = sections.get(SEC.OBJECTS);
  let placed = 0;
  if (obj && obj.length >= 8) {
    const nDoodads = obj.readUInt32LE(0), nWmos = obj.readUInt32LE(4);
    const place = (kind, p, scale) => {
      const m = mesh(job.models, kind, obj.readUInt32LE(p));
      if (!m) return;
      const M = placementMatrix([obj.readFloatLE(p + 8), obj.readFloatLE(p + 12), obj.readFloatLE(p + 16)], [obj.readFloatLE(p + 20), obj.readFloatLE(p + 24), obj.readFloatLE(p + 28)], scale);
      const P = m.positions, nV = P.length / 3;
      const w = new Float32Array(nV * 3);
      let lox = Infinity, hix = -Infinity, loy = Infinity, hiy = -Infinity;
      for (let i = 0; i < nV; i++) {
        const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const wx = M[0] * x + M[1] * y + M[2] * z + M[3], wy = M[4] * x + M[5] * y + M[6] * z + M[7];
        w[i * 3] = wx; w[i * 3 + 1] = wy; w[i * 3 + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
        if (wx < lox) lox = wx; if (wx > hix) hix = wx; if (wy < loy) loy = wy; if (wy > hiy) hiy = wy;
      }
      if (hix < xN - TILE_SIZE || lox > xN || hiy < yW - TILE_SIZE || loy > yW) return; // does not reach this tile
      placed++;
      const I = m.indices;
      // a mirrored placement (negative scale) would flip the winding; the game has none, so `wind` stands
      for (let t = 0; t + 2 < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        solid(w[a], w[a + 1], w[a + 2], w[b], w[b + 1], w[b + 2], w[c], w[c + 1], w[c + 2], m.wind, 0);
      }
    };
    for (let i = 0; i < nDoodads; i++) place('m2', 8 + i * 40, obj.readFloatLE(8 + i * 40 + 32));
    const base = 8 + nDoodads * 40;
    for (let i = 0; i < nWmos; i++) place('wmo', base + i * 68, obj.readFloatLE(base + i * 68 + 32) || 1);
  }

  // ---- water: level and kind per terrain quad ----
  const water = new Float32Array(128 * 128).fill(NaN);
  const waterKind = new Uint8Array(128 * 128);
  for (const L of parseLiquidSection(sections.get(SEC.LIQUID))) {
    const cr = L.chunk >> 4, cc = L.chunk & 15;
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const bit = y * L.w + x;
      if (L.exists && !((L.exists[bit >> 3] >> (bit & 7)) & 1)) continue;
      const w1 = L.w + 1;
      const level = L.heights ? (L.heights[y * w1 + x] + L.heights[y * w1 + x + 1] + L.heights[(y + 1) * w1 + x] + L.heights[(y + 1) * w1 + x + 1]) / 4 : L.minH;
      const q = (cr * 8 + L.y + y) * 128 + cc * 8 + L.x + x;
      if (!(water[q] >= level)) { water[q] = level; waterKind[q] = job.kinds?.[L.type] ?? 1; }
    }
  }

  // ---- floors ----
  // Worked out per half-yard sub-cell first. A cell has a floor wherever any of its four
  // sub-cells has one (those within a step of each other are the same floor), and for each floor
  // it is recorded which of the four neighbouring cells you can walk on to: only where a free
  // sub-cell of this one touches a free sub-cell of that one. So a wall thinner than a cell
  // still separates the cells on either side of it, while a stairway or doorway only a yard
  // wide stays open, which sampling whole cells would have closed.
  const lo = [], hi = [], fl = [];
  // Floors of one sub-cell, appended to fz / ff / fw (height, flags, which sub-cell).
  const subFloors = (sub, which, fz, ff, fw) => {
    lo.length = 0; hi.length = 0; fl.length = 0;
    for (let s = head[sub]; s >= 0; s = sNext[s]) {
      // insertion sort by bottom
      let k = lo.length;
      while (k > 0 && lo[k - 1] > sMin[s]) k--;
      lo.splice(k, 0, sMin[s]); hi.splice(k, 0, sMax[s]); fl.splice(k, 0, sFlag[s]);
    }
    // merge spans that touch; the top of the merged span keeps the walkability of whatever is on top
    let n = 0;
    for (let k = 0; k < lo.length; k++) {
      if (n > 0 && lo[k] <= hi[n - 1] + 0.05) {
        if (hi[k] > hi[n - 1] + 0.3) { hi[n - 1] = hi[k]; fl[n - 1] = fl[k]; }
        else if (hi[k] > hi[n - 1] - 0.3) { fl[n - 1] |= fl[k]; if (hi[k] > hi[n - 1]) hi[n - 1] = hi[k]; }
      } else { lo[n] = lo[k]; hi[n] = hi[k]; fl[n] = fl[k]; n++; }
    }
    const q = (((sub / N) | 0) >> 3) * 128 + ((sub % N) >> 3);
    const w = water[q], wet = !Number.isNaN(w);
    // Water: the highest solid top under the surface (how deep it is), and the lowest solid
    // bottom over it (the room to swim in). Something standing through the surface closes it.
    let under = -Infinity, over = Infinity;
    for (let k = 0; k < n; k++) {
      if (wet) {
        if (hi[k] <= w) under = Math.max(under, hi[k]);
        else if (lo[k] > w) over = Math.min(over, lo[k]);
        else under = Infinity;
      }
      const top = hi[k], room = (k + 1 < n ? lo[k + 1] : Infinity) - top;
      if (wet && top < w - WADE) continue;             // under deep water: nowhere to stand
      if ((fl[k] & 1) && room >= HEIGHT) { fz.push(top); ff.push(fl[k] & 2 ? FLOOR.TERRAIN : 0); fw.push(which); }
    }
    if (wet && n > 0 && under < w - WADE && over - w >= SWIM_ROOM) { fz.push(w); ff.push(FLOOR.SWIM | (waterKind[q] === 3 ? FLOOR.LAVA : 0)); fw.push(which); }
  };
  const C = NAV_N;
  const counts = new Uint8Array(C * C);
  const cellZ = [], cellF = [], cellM = []; // per floor: height, flags, which sub-cells it is made of
  const fz = [], ff = [], fw = [], order = [];
  let total = 0, swim = 0;
  for (let cj = 0; cj < C; cj++) for (let ci = 0; ci < C; ci++) {
    fz.length = 0; ff.length = 0; fw.length = 0;
    // sub-cells: 1 north-west, 2 north-east, 4 south-west, 8 south-east
    for (let k = 0; k < 4; k++) subFloors((cj * 2 + (k >> 1)) * N + ci * 2 + (k & 1), 1 << k, fz, ff, fw);
    if (!fz.length) continue;
    order.length = 0;
    for (let k = 0; k < fz.length; k++) order.push(k);
    order.sort((a, b) => fz[a] - fz[b]);
    let c = 0;
    for (let a = 0; a < order.length && c < MAX_FLOORS; ) {
      // floors of the sub-cells within a step of each other are one floor of the cell
      let b = a, mask = 0, top = -Infinity, flags = FLOOR.SWIM | FLOOR.TERRAIN, lava = 0;
      while (b < order.length && fz[order[b]] - fz[order[a]] <= 0.8) {
        const k = order[b];
        mask |= fw[k]; if (fz[k] > top) top = fz[k];
        flags &= ff[k]; lava |= ff[k] & FLOOR.LAVA;
        b++;
      }
      // (two sub-cells that only meet at a corner are not one place to stand)
      if (mask !== 9 && mask !== 6) { cellZ.push(top); cellF.push(flags | lava); cellM.push(mask); if (flags & FLOOR.SWIM) swim++; c++; }
      a = b;
    }
    counts[cj * C + ci] = c;
    total += c;
  }
  // Which neighbours each floor connects to (bits 16 east, 32 west, 64 south, 128 north).
  const offs = new Uint32Array(C * C + 1);
  for (let c = 0; c < C * C; c++) offs[c + 1] = offs[c] + counts[c];
  // per direction: [dx, dy, bit, my sub-cells on that side with the neighbour's sub-cells they touch]
  const SIDES = [[1, 0, 16, [[2, 1], [8, 4]]], [-1, 0, 32, [[1, 2], [4, 8]]], [0, 1, 64, [[4, 1], [8, 2]]], [0, -1, 128, [[1, 4], [2, 8]]]];
  for (let cj = 0; cj < C; cj++) for (let ci = 0; ci < C; ci++) {
    const cell = cj * C + ci;
    for (let k = offs[cell]; k < offs[cell + 1]; k++) {
      const z = cellZ[k], mask = cellM[k];
      for (const [dx, dy, bit, pairs] of SIDES) {
        const ni = ci + dx, nj = cj + dy;
        if (ni < 0 || nj < 0 || ni >= C || nj >= C) {
          // the neighbour is on the next tile: open on this side; that tile says the same for its side
          if (pairs.some(([mine]) => mask & mine)) cellF[k] |= bit;
          continue;
        }
        const nc = nj * C + ni;
        let best = -1;
        for (let q = offs[nc]; q < offs[nc + 1]; q++) { const dz = cellZ[q] - z; if (dz <= STEP_UP && dz >= -STEP_DOWN) best = q; }
        if (best >= 0 && pairs.some(([mine, theirs]) => (mask & mine) && (cellM[best] & theirs))) cellF[k] |= bit;
      }
    }
  }
  const outZ = cellZ.map((v) => Math.max(0, Math.min(65535, Math.round((v + 2048) * 8)))), outF = cellF;

  // Heights are stored as the difference from the floor before (in cell order): neighbouring
  // ground is nearly level, so the differences are tiny and compress far better.
  const z = new Uint16Array(outZ.length), f = new Uint8Array(outF);
  for (let i = 0, prev = 0; i < outZ.length; i++) { z[i] = (outZ[i] - prev) & 0xffff; prev = outZ[i]; }
  const pack = (a) => zlib.deflateRawSync(Buffer.from(a.buffer, a.byteOffset, a.byteLength), { level: 6 });
  const meta = { n: C, floors: total, swim, placed };
  writeFileAtomic(job.out, packContainer('WFN1', NAV_VERSION, [
    { id: NSEC.META, data: Buffer.from(JSON.stringify(meta)) },
    { id: NSEC.COUNTS, data: pack(counts) },
    { id: NSEC.HEIGHTS, data: pack(z) },
    { id: NSEC.FLAGS, data: pack(f) },
  ]));
  return meta;
}
