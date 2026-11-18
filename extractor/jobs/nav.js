// Navigation data for one map tile: where a character can stand, on a grid of about one yard.
//
// Every solid triangle of the tile is laid into the grid: the terrain, and the collision meshes
// of the buildings and objects placed on it. Per grid cell that gives a stack of solid spans
// (bottom, top, and whether the top is level enough to walk on). A place to stand ("floor") is
// the top of a walkable span with a character's height of free space above it. So a cell can
// have several floors (under and on a bridge, the storeys of a building), walls and tree trunks
// leave none, and a low branch closes the ground under it.
// Water too deep to stand in becomes a floor at the surface, marked as one you swim on.
//
// Ground too steep to walk on is kept too, marked as such: nobody stands on it or climbs it,
// but the game lets you slide and fall down it, and a way down a mountainside is a way.
//
// The route planner connects neighbouring cells whose floors are within a step of each other,
// and, one way only, the places you can drop from to whatever lies under them.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { unpackContainer, packContainer, writeFileAtomic, f32View } from '../container.js';
import { MAP_HALF, TILE_SIZE } from '../formats/chunked.js';
import { SEC, parseLiquidSection } from './tile.js';
import { MSEC } from './model.js';

export const NAV_VERSION = 6;
// LINKS: per surface, four bits for each of east, west, south, north (in that order from the
// lowest): 0 it leads nowhere that way; 1-14 it leads on to that surface of the next cell
// (counted from 1, lowest first); LINK_EDGE the next cell is on the next tile, and this surface
// is open on that side.
// EDGES: the room over each surface of the cells along the tile's four edges (see the end of buildNav).
export const NSEC = { META: 1, COUNTS: 2, HEIGHTS: 3, FLAGS: 4, LINKS: 5, EDGES: 6 };
export const LINK_EDGE = 15;
export const NAV_N = 512;                 // cells per tile side
export const NAV_CELL = TILE_SIZE / NAV_N; // 1.0417 yd
// surface flags; STEEP = ground too steep to stand on (slid and fallen down, never walked);
// EAST..NORTH = a floor you can walk on from to the neighbouring cell on that side
export const FLOOR = { SWIM: 1, LAVA: 2, TERRAIN: 4, STEEP: 8, EAST: 16, WEST: 32, SOUTH: 64, NORTH: 128 };
// Yards you can step up from one cell to the next. Ground at 50 degrees, the steepest the
// game lets you walk, rises 1.24 a cell; heights are kept to an eighth of a yard, which can
// make that 1.375 between two of them. (It was 1.3: the search, which sees only the heights
// as kept, lost some of the steps the builder had found.) It is also about the ledge you
// can hop up on to.
export const STEP_UP = 1.375;
export const STEP_DOWN = 3;   // yards you will drop from one cell to the next and call it walking
const HEIGHT = 1.7;                       // free space a character needs above a floor
const SWIM_ROOM = 1.0;                    // free space needed above water to swim there
const WADE = 1.5;                         // water deeper than this over the ground: swim
const SLOPE = Math.cos((50 * Math.PI) / 180); // steeper than 50 degrees cannot be walked
const MAX_FLOORS = 7;
const MAX_STEEP = 7;                      // (seven floors and seven stretches of steep ground a cell: fourteen surfaces, the most a link can name)
const FLOOR_JOIN = 0.8;                   // yards between the floors of two sub-cells of a cell, one after the other in height, for them to be one floor
const STEEP_JOIN = 2;                     // ...and between two pieces of steep ground
const EDGE = 0.3;                         // yards over the floor you step off that what you step on to may be
const SLIDE = 0.3;                        // yards steep ground has to fall, half a yard on, for you to slide that way (a slide goes downhill, not along the face)
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

  // ---- what there is to be on ----
  // Worked out per half-yard sub-cell first, from its stack of solid spans. The top of a span
  // with a character's height of free space over it is somewhere to be: a floor where it is
  // level enough to walk on, steep ground where it is not - nowhere to stand and no way up, but
  // you slide or fall down it. The spans themselves are kept until the end: whether you can step
  // off an edge depends on what is in the way over there, not only on what there is to land on.
  const SUBS = N * N;
  const lo = [], hi = [], fl = [];
  const subOff = new Uint32Array(SUBS + 1);
  let spCap = 1 << 21, spN = 0;
  let spLo = new Float32Array(spCap), spHi = new Float32Array(spCap), spKind = new Uint8Array(spCap), spSurf = new Int8Array(spCap);
  const subSwim = new Uint8Array(SUBS);            // water to swim on in this sub-cell: 1, or 2 for lava
  const subSwimSurf = new Int8Array(SUBS).fill(-1); // ...and which of its cell's surfaces that is
  const waterOf = (sub) => water[(((sub / N) | 0) >> 3) * 128 + ((sub % N) >> 3)];
  for (let sub = 0; sub < SUBS; sub++) {
    subOff[sub] = spN;
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
    if (spN + n > spCap) {
      spCap *= 2;
      const g = (old, T) => { const a = new T(spCap); a.set(old); return a; };
      spLo = g(spLo, Float32Array); spHi = g(spHi, Float32Array); spKind = g(spKind, Uint8Array); spSurf = g(spSurf, Int8Array);
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
      // kind: 1 a floor, 2 steep ground, 0 neither (no room over it, or under deep water: nowhere to be); 4: it is the terrain
      const kind = (wet && top < w - WADE) || room < HEIGHT ? 0 : (fl[k] & 1 ? 1 : 2) | (fl[k] & 2 ? 4 : 0);
      spLo[spN] = lo[k]; spHi[spN] = top; spKind[spN] = kind; spSurf[spN] = -1; spN++;
    }
    if (wet && n > 0 && under < w - WADE && over - w >= SWIM_ROOM) subSwim[sub] = waterKind[q] === 3 ? 2 : 1;
  }
  subOff[SUBS] = spN;

  // A cell has a surface wherever any of its four sub-cells has one. Those of its sub-cells
  // that follow on from each other in height are one surface of the cell: sorted by height,
  // each within a step of the one before. (Not: each within a step of the lowest. On ground
  // that climbs cornerwise at 48 to 50 degrees - the steepest the game lets you walk - the
  // highest quarter of a cell is more than that above the lowest, the cell fell into two
  // floors, and neither led on uphill: whole hillsides the game has you run straight up were
  // cut off from the valley below them.) Floors and steep ground are kept apart.
  const C = NAV_N;
  const counts = new Uint8Array(C * C);
  const cellZ = [], cellF = [], cellM = [], cellTop = []; // per surface: height, flags, the sub-cells it is made of, its height in each of the four (NaN where it is not)
  const ez = [], ef = [], ew = [], es = [], order = [], groups = [];
  const subAt = (cj, ci, k) => (cj * 2 + (k >> 1)) * N + ci * 2 + (k & 1);
  let total = 0, swim = 0, steep = 0;
  for (let cj = 0; cj < C; cj++) for (let ci = 0; ci < C; ci++) {
    ez.length = 0; ef.length = 0; ew.length = 0; es.length = 0;
    // sub-cells: 1 north-west, 2 north-east, 4 south-west, 8 south-east
    for (let k = 0; k < 4; k++) {
      const sub = subAt(cj, ci, k);
      for (let s = subOff[sub]; s < subOff[sub + 1]; s++) {
        const kind = spKind[s];
        if (!(kind & 3)) continue;
        ez.push(spHi[s]); ef.push((kind & 2 ? FLOOR.STEEP : 0) | (kind & 4 ? FLOOR.TERRAIN : 0)); ew.push(k); es.push(s);
      }
      if (subSwim[sub]) { ez.push(waterOf(sub)); ef.push(FLOOR.SWIM | (subSwim[sub] === 2 ? FLOOR.LAVA : 0)); ew.push(k); es.push(-1 - sub); }
    }
    if (!ez.length) continue;
    groups.length = 0;
    for (const want of [0, FLOOR.STEEP]) {
      order.length = 0;
      for (let k = 0; k < ez.length; k++) if ((ef[k] & FLOOR.STEEP) === want) order.push(k);
      order.sort((a, b) => ez[a] - ez[b]);
      const join = want ? STEEP_JOIN : FLOOR_JOIN, most = want ? MAX_STEEP : MAX_FLOORS;
      let kept = 0;
      for (let a = 0; a < order.length && kept < most; ) {
        let b = a, mask = 0, top = -Infinity, flags = FLOOR.SWIM | FLOOR.TERRAIN, lava = 0;
        // (one height a sub-cell: a second surface of the same sub-cell begins the next one)
        while (b < order.length && (b === a || ez[order[b]] - ez[order[b - 1]] <= join) && !(mask & (1 << ew[order[b]]))) {
          const k = order[b];
          mask |= 1 << ew[k]; if (ez[k] > top) top = ez[k];
          flags &= ef[k]; lava |= ef[k] & FLOOR.LAVA;
          b++;
        }
        // (two sub-cells that only meet at a corner are not one place to be)
        if (mask !== 9 && mask !== 6) { groups.push({ top, flags: flags | lava | want, mask, order: order.slice(a, b) }); kept++; }
        a = b;
      }
    }
    groups.sort((p, q) => p.top - q.top);
    for (let g = 0; g < groups.length; g++) {
      const G = groups[g], at = cellZ.length;
      cellZ.push(G.top); cellF.push(G.flags); cellM.push(G.mask);
      cellTop.push(NaN, NaN, NaN, NaN);
      for (const k of G.order) {
        cellTop[at * 4 + ew[k]] = ez[k];
        if (es[k] >= 0) spSurf[es[k]] = g; else subSwimSurf[-1 - es[k]] = g;
      }
      if (G.flags & FLOOR.STEEP) steep++; else if (G.flags & FLOOR.SWIM) swim++;
    }
    counts[cj * C + ci] = groups.length;
    total += groups.length;
  }

  // Heights are kept to an eighth of a yard, and which surface leads on to which is worked out
  // on the heights as they are kept: the route search then sees the very numbers this did.
  const outZ = cellZ.map((v) => Math.max(0, Math.min(65535, Math.round((v + 2048) * 8))));
  const UPQ = Math.round(STEP_UP * 8), DOWNQ = Math.round(STEP_DOWN * 8);
  const offs = new Uint32Array(C * C + 1);
  for (let c = 0; c < C * C; c++) offs[c + 1] = offs[c] + counts[c];

  // Where you come down in a sub-cell you move into at height h: the highest solid top at or
  // under it (`slack` over it still counts; under 0, it has to be that much lower) - the number
  // of that surface in its cell, with landT its height - or -1: something solid stands in the
  // way of a body at that height, or there is nothing under it to come down on, or what there
  // is is no place to fall on to.
  let landT = 0;
  const landing = (sub, h, slack) => {
    const a = subOff[sub], b = subOff[sub + 1];
    let m = -1;
    for (let s = a; s < b && spHi[s] <= h + slack; s++) m = s;
    const next = m < 0 ? a : m + 1; // (the span over that one: it reaches above h)
    if (next < b && spLo[next] < h + HEIGHT) return -1;
    if (subSwim[sub]) {
      const w = waterOf(sub);
      if (w <= h + slack && (m < 0 || spHi[m] < w)) { landT = w; return subSwimSurf[sub]; }
    }
    if (m < 0 || !(spKind[m] & 3)) return -1;
    // Not on to ground that has something built over it. The game leaves the earth in place
    // under a town, forty yards under Stormwind's streets, and the buildings nobody goes into
    // are hollow shells standing over it: past any low wall of theirs there is a clear drop to
    // that earth, which is nowhere anyone gets to and has no way back up. Ground you can fall
    // on to has the sky over it. (Walking on to ground under a roof is another matter.)
    if ((spKind[m] & 7) === 5 && m + 1 < b) return -1;
    landT = spHi[m];
    return spSurf[m];
  };

  // What each surface leads on to, east, west, south and north. A floor leads on to the floor
  // of the next cell within a step up or a short drop down, where a free sub-cell of this one
  // touches a free sub-cell of that one: so a wall thinner than a cell still separates the
  // cells on either side of it, while a stairway or doorway only a yard wide stays open, which
  // sampling whole cells would have closed. (The highest such floor that it touches. It used
  // to be the highest such floor, if it touched: a ledge in the far half of the next cell shut
  // the way on to the ground in its near half.) Where it leads on to no floor, it may still be
  // left that way by dropping: on to whatever lies under the edge, a floor further down or
  // steep ground. Steep ground leads only downhill.
  const links = new Uint16Array(total);
  // per direction: [dx, dy, bit, my sub-cells on that side with the neighbour's sub-cells they touch (by number: 0 north-west, 1 north-east, 2 south-west, 3 south-east)]
  const SIDES = [[1, 0, FLOOR.EAST, [[1, 0], [3, 2]]], [-1, 0, FLOOR.WEST, [[0, 1], [2, 3]]], [0, 1, FLOOR.SOUTH, [[2, 0], [3, 1]]], [0, -1, FLOOR.NORTH, [[0, 2], [1, 3]]]];
  for (let cj = 0; cj < C; cj++) for (let ci = 0; ci < C; ci++) {
    const cell = cj * C + ci;
    for (let k = offs[cell]; k < offs[cell + 1]; k++) {
      const mask = cellM[k], isSteep = cellF[k] & FLOOR.STEEP;
      for (let d = 0; d < 4; d++) {
        const [dx, dy, bit, pairs] = SIDES[d];
        const ni = ci + dx, nj = cj + dy;
        if (ni < 0 || nj < 0 || ni >= C || nj >= C) {
          // the neighbour is on the next tile: open on this side; that tile says the same for its side
          if (pairs.some(([mine]) => mask & (1 << mine))) { links[k] |= LINK_EDGE << (d * 4); if (!isSteep) cellF[k] |= bit; }
          continue;
        }
        const nc = nj * C + ni;
        let to = -1;
        if (!isSteep) {
          for (let q = offs[nc]; q < offs[nc + 1]; q++) {
            if (cellF[q] & FLOOR.STEEP) continue;
            const dz = outZ[q] - outZ[k];
            if (dz <= UPQ && dz >= -DOWNQ && pairs.some(([mine, theirs]) => (mask & (1 << mine)) && (cellM[q] & (1 << theirs)))) to = q;
          }
          if (to >= 0) cellF[k] |= bit;
        }
        if (to < 0) {
          // (a floor to land on before steep ground to slide on down; of two alike, the higher)
          let best = -Infinity;
          for (const [mine, theirs] of pairs) {
            if (!(mask & (1 << mine))) continue;
            const li = landing(subAt(nj, ni, theirs), cellTop[k * 4 + mine], isSteep ? -SLIDE : EDGE);
            if (li < 0) continue;
            const q = offs[nc] + li, rank = landT + (cellF[q] & FLOOR.STEEP ? 0 : 1e6);
            // (never up, by the heights as they are kept)
            if (rank <= best || outZ[q] > outZ[k]) continue;
            best = rank; to = q;
          }
        }
        if (to >= 0) links[k] |= (to - offs[nc] + 1) << (d * 4);
      }
    }
  }
  // Within a cell. Where ground you can stand on meets ground you cannot, the line between
  // them runs through cells: half of such a cell is floor and half is steep, and each half
  // touches the next cell only on its own side. Going down across that line - off the floor on
  // to the steep half, off the steep half on to the floor - is a move inside the cell, which
  // links (cell to cell) cannot say. So a surface that leads nowhere on one side, but from
  // which you come down on to another surface of its own cell, leads where that one leads:
  // without this every slide ended half a yard short of the floor at the foot of the bank.
  const INSIDE = [[0, 1], [1, 0], [0, 2], [2, 0], [1, 3], [3, 1], [2, 3], [3, 2]]; // sub-cells of a cell that share a side: from, to
  const direct = links.slice();
  for (let cj = 0; cj < C; cj++) for (let ci = 0; ci < C; ci++) {
    const cell = cj * C + ci;
    if (offs[cell + 1] - offs[cell] < 2) continue;
    for (let k = offs[cell]; k < offs[cell + 1]; k++) {
      const mask = cellM[k], isSteep = cellF[k] & FLOOR.STEEP;
      for (let d = 0; d < 4; d++) {
        if ((direct[k] >> (d * 4)) & 15) continue;
        const nc = cell + SIDES[d][0] + SIDES[d][1] * C;
        let best = -1, value = 0;
        for (const [a, b] of INSIDE) {
          if (!(mask & (1 << a)) || mask & (1 << b)) continue;
          const li = landing(subAt(cj, ci, b), cellTop[k * 4 + a], isSteep ? -SLIDE : EDGE);
          if (li < 0) continue;
          const x = offs[cell] + li, v = (direct[x] >> (d * 4)) & 15;
          if (x === k || outZ[x] >= outZ[k] || !v || outZ[x] <= best) continue;
          if (v !== LINK_EDGE && outZ[offs[nc] + v - 1] > outZ[k]) continue; // (never up)
          best = outZ[x]; value = v;
        }
        if (value) links[k] |= value << (d * 4);
      }
    }
  }

  // Steep ground is worth keeping only where it is part of a way down: somewhere a floor leads
  // on to (straight off its edge, or by way of more steep ground) that in turn leads down to a
  // floor. The rest - most of it, in a town or a dungeon: the outside of every roof and wall
  // from above - is nowhere anyone gets to or comes back from, and is left out. (The edge of
  // the tile counts as both: what lies beyond it is the next tile's to say.)
  const DC = [1, -1, C, -C]; // the cell east, west, south, north of a cell
  const cellOfSurf = new Int32Array(total);
  for (let c = 0; c < C * C; c++) for (let k = offs[c]; k < offs[c + 1]; k++) cellOfSurf[k] = c;
  const target = (k, d) => { const v = (links[k] >> (d * 4)) & 15; return v === 0 || v === LINK_EDGE ? -1 : offs[cellOfSurf[k] + DC[d]] + v - 1; };
  const atEdge = (k) => { for (let d = 0; d < 4; d++) if (((links[k] >> (d * 4)) & 15) === LINK_EDGE) return true; return false; };
  const reached = new Uint8Array(total), leads = new Uint8Array(total), queue = new Int32Array(total);
  let qn = 0;
  for (let k = 0; k < total; k++) if (!(cellF[k] & FLOOR.STEEP) || atEdge(k)) { reached[k] = 1; queue[qn++] = k; }
  for (let q = 0; q < qn; q++) for (let d = 0; d < 4; d++) { const t = target(queue[q], d); if (t >= 0 && !reached[t]) { reached[t] = 1; queue[qn++] = t; } }
  // (backwards: who leads on to each surface)
  const inN = new Uint32Array(total + 1);
  for (let k = 0; k < total; k++) for (let d = 0; d < 4; d++) { const t = target(k, d); if (t >= 0) inN[t + 1]++; }
  for (let k = 0; k < total; k++) inN[k + 1] += inN[k];
  const inOf = new Int32Array(inN[total]), fill = new Uint32Array(total);
  for (let k = 0; k < total; k++) for (let d = 0; d < 4; d++) { const t = target(k, d); if (t >= 0) inOf[inN[t] + fill[t]++] = k; }
  qn = 0;
  for (let k = 0; k < total; k++) if (!(cellF[k] & FLOOR.STEEP) || atEdge(k)) { leads[k] = 1; queue[qn++] = k; }
  for (let q = 0; q < qn; q++) { const t = queue[q]; for (let e = inN[t]; e < inN[t + 1]; e++) { const k = inOf[e]; if (!leads[k]) { leads[k] = 1; queue[qn++] = k; } } }
  const keep = (k) => reached[k] && leads[k];
  const newAt = new Int32Array(total).fill(-1); // where each surface that is kept comes in its cell
  let kept = 0;
  for (let c = 0; c < C * C; c++) { let n = 0; for (let k = offs[c]; k < offs[c + 1]; k++) if (keep(k)) newAt[k] = n++; counts[c] = n; kept += n; }
  const outZ2 = new Uint16Array(kept), outF = new Uint8Array(kept), outL = new Uint16Array(kept);
  for (let k = 0, at = 0; k < total; k++) {
    if (newAt[k] < 0) continue;
    let l = 0;
    for (let d = 0; d < 4; d++) {
      const v = (links[k] >> (d * 4)) & 15, t = target(k, d);
      if (v === LINK_EDGE) l |= LINK_EDGE << (d * 4);
      else if (t >= 0 && newAt[t] >= 0) l |= (newAt[t] + 1) << (d * 4);
    }
    outZ2[at] = outZ[k]; outF[at] = cellF[k]; outL[at] = l; at++;
  }
  steep -= total - kept;

  // At the tile's four edges: how much free space there is over each surface on that side.
  // What a surface leads on to across the edge is in the next tile, which is built without
  // this one: each tile can only say how its own side of the edge stands. For a step that is
  // enough - both sides say they are open, at heights a step apart. For a fall it is not: the
  // search has to know that nothing solid lies between the surface it would land on and the
  // height it comes in at. (Without this, wherever the seam of two tiles ran through a town,
  // the street was something to fall through, on to the earth the town was built over.)
  // Per edge (east, west, south, north), per cell along it, per surface of that cell: the
  // room over it in eighths of a yard (65535: open sky), 0 where it does not touch that edge.
  const roomOver = (sub, top) => {
    for (let s = subOff[sub]; s < subOff[sub + 1]; s++) if (spHi[s] > top + 1e-3) return spLo[s] - top;
    return Infinity;
  };
  const SIDE_SUBS = [[1, 3], [0, 2], [2, 3], [0, 1]]; // the sub-cells of a cell on its east, west, south, north side
  const edgeRoom = [];
  for (let d = 0; d < 4; d++) for (let a = 0; a < C; a++) {
    const ci = d === 0 ? C - 1 : d === 1 ? 0 : a, cj = d === 2 ? C - 1 : d === 3 ? 0 : a, cell = cj * C + ci;
    for (let k = offs[cell]; k < offs[cell + 1]; k++) {
      if (newAt[k] < 0) continue;
      let room = 0;
      for (const m of SIDE_SUBS[d]) if (cellM[k] & (1 << m)) room = Math.max(room, roomOver(subAt(cj, ci, m), cellTop[k * 4 + m]));
      edgeRoom.push(room === Infinity ? 65535 : Math.max(0, Math.min(65534, Math.floor(room * 8))));
    }
  }

  // Heights are stored as the difference from the surface before (in cell order): neighbouring
  // ground is nearly level, so the differences are tiny and compress far better.
  const z = new Uint16Array(kept), f = outF;
  for (let i = 0, prev = 0; i < kept; i++) { z[i] = (outZ2[i] - prev) & 0xffff; prev = outZ2[i]; }
  const pack = (a) => zlib.deflateRawSync(Buffer.from(a.buffer, a.byteOffset, a.byteLength), { level: 6 });
  const meta = { n: C, floors: kept - steep, swim, steep, placed };
  writeFileAtomic(job.out, packContainer('WFN1', NAV_VERSION, [
    { id: NSEC.META, data: Buffer.from(JSON.stringify(meta)) },
    { id: NSEC.COUNTS, data: pack(counts) },
    { id: NSEC.HEIGHTS, data: pack(z) },
    { id: NSEC.FLAGS, data: pack(f) },
    { id: NSEC.LINKS, data: pack(outL) },
    { id: NSEC.EDGES, data: pack(new Uint16Array(edgeRoom)) },
  ]));
  return meta;
}
