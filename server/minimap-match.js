// Where on a dungeon's plan does the minimap on the screen fit?
//
// Inside a dungeon the game does not say where you are. Its minimap shows it: the picture there
// is centred on you, and what it shows is the floor of the rooms round you, lit, on black. The
// map build makes a plan of every dungeon that is one building from the game's own pictures of
// its rooms (extractor/jobs/minimap.js); here the minimap's picture, cut out of the picture of
// the game window, is looked for on that plan. Where it fits is where you are.
//
// Plain arithmetic on pictures, and nothing else: no file is read here but what is handed in,
// and nothing is done to the game. Run in a thread of its own (minimap-worker.js): a look
// through a whole plan takes half a second, following you from the last place a fiftieth.
//
// How it looks:
//   - both pictures are boiled down to "is this floor": 1 where the minimap is lit, 0 where it
//     is black. A fit is scored by how much of the lit part they share (the Tanimoto measure:
//     1 the same, 0 nothing in common);
//   - the plan is brought to the screen's scale (so many screen pixels a yard, which is why the
//     minimap's place and size on the screen have to be known well), once fine and a few times
//     coarser; a search goes through the coarsest at every place and every turn, takes the best
//     few down the finer ones, and settles the best of them to a fraction of a pixel;
//   - the game leaves rooms out of its minimap: every room that lies wholly above the ceiling
//     of the room you are in. So the plan is put together once for every set of rooms that can
//     be showing, and each is looked for only where you would have to be for it;
//   - a place is only believed where it fits well AND no other place fits nearly as well. A
//     poor fit or two places alike are refused: nothing is said rather than something wrong.
//
// Conventions
//   world: X north, Y west (yards).   plan: north up, col = (originY - y) * 2, row = (originX - x) * 2.
//   screen: x right, y down, a pixel's centre at its whole coordinates.
//   rotation: how far the map is turned CLOCKWISE on the screen, radians, 0 = north up. With the
//     game's "rotate minimap" on this IS the way you face (0 north, counter-clockwise positive,
//     as the game counts it); with it off the rotation is 0 and the arrow says how you face.
//   a picture: { data (bytes, row by row), w, h, ch (bytes a pixel: 3 = R G B, 4 = R G B A) }
import { readMinimapRef } from '../extractor/jobs/minimap.js';

const D2R = Math.PI / 180;
export const norm = (a) => { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; };
export const angDiff = (a, b) => { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; };

// ------------------------------------------------------------------ the plan

/**
 * A dungeon's plan as the map build wrote it (maps/<id>/minimap.bin), made ready to be searched:
 * { meta, width, height, pxPerYard, originX, originY,
 *   groups: every room - { index, name, flags, world: { xMin, xMax, yMin, yMax, zMin, zMax }, mask: { col, row, w, h } | null, data (its floor, a byte a pixel) | null },
 *   pictured: the rooms that have a picture, count: how many rooms' floors cover each pixel }
 */
export function loadReference(buf) {
  const { meta, masks } = readMinimapRef(buf);
  const groups = meta.groups.map((g) => ({
    index: g.i, name: g.n, flags: g.f,
    world: { xMin: g.b[0], xMax: g.b[1], yMin: g.b[2], yMax: g.b[3], zMin: g.b[4], zMax: g.b[5] },
    mask: g.m ? { col: g.m[0], row: g.m[1], w: g.m[2], h: g.m[3] } : null,
    data: masks.get(g.i) ?? null,
  }));
  const ref = { meta, width: meta.width, height: meta.height, pxPerYard: meta.pxPerYard, originX: meta.originX, originY: meta.originY, groups, pictured: groups.filter((g) => g.data) };
  ref.count = new Uint8Array(ref.width * ref.height);
  for (const g of ref.pictured) { const { col, row, w, h } = g.mask; for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (g.data[j * w + i]) ref.count[(row + j) * ref.width + col + i]++; }
  ref.scratch = new Uint8Array(ref.width * ref.height); // (the floor of one set of rooms, put together: used again for every set)
  return ref;
}

/** The floor (a byte a pixel, 0 or 1) of every room but the hidden ones (a Set of room numbers), in ref.scratch. */
function composeFloor(ref, hidden) {
  const a = ref.scratch.fill(0);
  for (const g of ref.pictured) {
    if (hidden?.has(g.index)) continue;
    const { col, row, w, h } = g.mask;
    for (let j = 0; j < h; j++) { const o = (row + j) * ref.width + col, m = j * w; for (let i = 0; i < w; i++) if (g.data[m + i]) a[o + i] = 1; }
  }
  return a;
}

/**
 * The floor of a set of rooms brought to the screen's scale: level k has cells of k screen
 * pixels, each the share of it that is floor (exact: a plan pixel that straddles two cells is
 * shared out between them). Every level has a border of empty cells, so that a disc centred
 * anywhere on the building never reads outside it.
 */
export function buildPyramid(ref, hidden, screenPxPerYard, levels, discRadiusPx) {
  const floor = composeFloor(ref, hidden);
  const W = ref.width, H = ref.height, q = ref.pxPerYard / screenPxPerYard; // plan pixels to a cell of the finest level
  const out = { ref, s: screenPxPerYard, levels: [] };
  // the finest level, unpadded: every floor pixel's square laid over the cells it reaches into
  const w0 = Math.ceil(W / q), h0 = Math.ceil(H / q);
  let cur = new Float32Array(w0 * h0), cw = w0, chh = h0;
  const inv = 1 / q, norm2 = 1 / (q * q);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const v0 = Math.floor(y * inv), v1 = Math.min(h0 - 1, Math.floor((y + 1) * inv - 1e-9));
    for (let x = 0; x < W; x++) {
      if (!floor[row + x]) continue;
      const u0 = Math.floor(x * inv), u1 = Math.min(w0 - 1, Math.floor((x + 1) * inv - 1e-9));
      for (let v = v0; v <= v1; v++) {
        const hy = Math.min(y + 1, (v + 1) * q) - Math.max(y, v * q);
        for (let u = u0; u <= u1; u++) cur[v * w0 + u] += hy * (Math.min(x + 1, (u + 1) * q) - Math.max(x, u * q)) * norm2;
      }
    }
  }
  let k = 1;
  for (const want of levels) {
    // (each coarser level is the one before it, four cells to one)
    while (k < want) {
      const nw = Math.ceil(cw / 2), nh = Math.ceil(chh / 2), nx = new Float32Array(nw * nh);
      for (let v = 0; v < chh; v++) for (let u = 0; u < cw; u++) nx[(v >> 1) * nw + (u >> 1)] += cur[v * cw + u] * 0.25;
      cur = nx; cw = nw; chh = nh; k *= 2;
    }
    const pad = Math.ceil(discRadiusPx / k) + 3, PW = cw + 2 * pad, PH = chh + 2 * pad, f = new Float32Array(PW * PH);
    for (let v = 0; v < chh; v++) f.set(cur.subarray(v * cw, (v + 1) * cw), (v + pad) * PW + pad);
    out.levels.push({ k, q: q * k, w: cw, h: chh, pad, W: PW, H: PH, f });
  }
  return out;
}

/** Cell coordinates (counted from cell centres, without the border) of a level -> world yards, and back. */
function cellToWorld(pyr, lv, u, v) {
  const r = pyr.ref;
  return { x: r.originX - (v + 0.5) * lv.q / r.pxPerYard, y: r.originY - (u + 0.5) * lv.q / r.pxPerYard };
}
function worldToCell(pyr, lv, x, y) {
  const r = pyr.ref;
  return { u: (r.originY - y) * r.pxPerYard / lv.q - 0.5, v: (r.originX - x) * r.pxPerYard / lv.q - 0.5 };
}

// ------------------------------------------------------------------ the minimap

/** Is this screen pixel floor? 0..1 from how bright it is (floor is grey-brown, what is not there is black). */
export function floorValue(r, g, b, lo = 22, hi = 46) {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  return l <= lo ? 0 : l >= hi ? 1 : (l - lo) / (hi - lo);
}

/**
 * Cut the minimap out of a picture.
 * geom: { cx, cy (the minimap's middle = you, in the picture's pixels, fractions and all),
 *         rMax (px: the disc inside this radius is used), rArrow (px: this close to the middle is left out - your arrow is there),
 *         exclude: [{ x, y, r }] (circles covered by buttons) }
 */
export function extractMinimap(pic, geom, levels = [1, 2, 4], lo = 22, hi = 46) {
  const { data, w: imgW, h: imgH, ch } = pic;
  const { cx, cy, rMax, rArrow = 11, exclude = [] } = geom;
  const R = Math.ceil(rMax), x0 = Math.round(cx) - R, y0 = Math.round(cy) - R, n = 2 * R + 1;
  const m = new Float32Array(n * n), w = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const X = x0 + i, Y = y0 + j;
    if (X < 0 || Y < 0 || X >= imgW || Y >= imgH) continue;
    const dx = X - cx, dy = Y - cy, rr = dx * dx + dy * dy;
    if (rr > rMax * rMax || rr < rArrow * rArrow) continue;
    let ok = true;
    for (const e of exclude) if ((X - e.x) ** 2 + (Y - e.y) ** 2 < e.r * e.r) { ok = false; break; }
    if (!ok) continue;
    const p = (Y * imgW + X) * ch;
    m[j * n + i] = floorValue(data[p], data[p + 1], data[p + 2], lo, hi);
    w[j * n + i] = 1;
  }
  const out = { geom, n, x0, y0, m, w, levels: [] };
  for (const k of levels) {
    const dx = [], dy = [], mv = [], wv = [];
    for (let bj = 0; bj * k < n; bj++) for (let bi = 0; bi * k < n; bi++) {
      let sw = 0, sm = 0;
      for (let j = bj * k; j < Math.min(n, bj * k + k); j++) for (let i = bi * k; i < Math.min(n, bi * k + k); i++) { if (w[j * n + i]) { sw++; sm += m[j * n + i]; } }
      if (!sw) continue;
      dx.push(x0 + bi * k + (k - 1) / 2 - cx); dy.push(y0 + bj * k + (k - 1) / 2 - cy);
      mv.push(sm / sw); wv.push(sw / (k * k));
    }
    let mm = 0, area = 0, floor = 0;
    for (let i = 0; i < mv.length; i++) { mm += wv[i] * mv[i] * mv[i]; area += wv[i]; floor += wv[i] * mv[i]; }
    out.levels.push({ k, dx: Float32Array.from(dx), dy: Float32Array.from(dy), m: Float32Array.from(mv), w: Float32Array.from(wv), mm, area, floorFraction: area ? floor / area : 0 });
  }
  out.floorFraction = out.levels[0].floorFraction;
  return out;
}

/** How well one place fits at one level: you at cell (u, v), the map turned by rot. */
function scoreAt(mmLv, lv, u, v, rot, bilinear = false) {
  const c = Math.cos(rot), s = Math.sin(rot), k = lv.k, W = lv.W, H = lv.H, f = lv.f, pad = lv.pad;
  const { dx, dy, m, w } = mmLv, n = m.length;
  let dot = 0, ff = 0;
  const U = u + pad, V = v + pad, ck = c / k, sk = s / k;
  if (bilinear) {
    for (let i = 0; i < n; i++) {
      // where this pixel of the screen is on the plan (turned back, in cells)
      const ex = dx[i] * ck + dy[i] * sk + U, ey = -dx[i] * sk + dy[i] * ck + V;
      const ix = Math.floor(ex), iy = Math.floor(ey);
      if (ix < 0 || iy < 0 || ix >= W - 1 || iy >= H - 1) continue;
      const fx = ex - ix, fy = ey - iy, p = iy * W + ix;
      const top = f[p] + (f[p + 1] - f[p]) * fx, bot = f[p + W] + (f[p + W + 1] - f[p + W]) * fx;
      const fv = top + (bot - top) * fy;
      dot += w[i] * m[i] * fv; ff += w[i] * fv * fv;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const ix = Math.round(dx[i] * ck + dy[i] * sk + U), iy = Math.round(-dx[i] * sk + dy[i] * ck + V);
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
      const fv = f[iy * W + ix];
      dot += w[i] * m[i] * fv; ff += w[i] * fv * fv;
    }
  }
  const den = mmLv.mm + ff - dot;
  return den > 1e-9 ? dot / den : 0;
}

/** Climb to the best place nearby at one level: a step either way across, down and in the turn, the steps halved when none of them is better. */
function climb(mmLv, lv, start, stepP, stepR, minP, minR, bilinear) {
  let best = { ...start, score: scoreAt(mmLv, lv, start.u, start.v, start.rot, bilinear) };
  for (let it = 0; it < 60 && (stepP > minP || stepR > minR); it++) {
    let moved = false;
    for (const [du, dv, dr] of [[stepP, 0, 0], [-stepP, 0, 0], [0, stepP, 0], [0, -stepP, 0], [0, 0, stepR], [0, 0, -stepR]]) {
      if (!du && !dv && !dr) continue;
      const sc = scoreAt(mmLv, lv, best.u + du, best.v + dv, best.rot + dr, bilinear);
      if (sc > best.score + 1e-6) { best = { u: best.u + du, v: best.v + dv, rot: best.rot + dr, score: sc }; moved = true; }
    }
    if (!moved) { stepP /= 2; stepR /= 2; }
  }
  return best;
}

/**
 * Look through the whole plan (or round a place) for the minimap.
 * opts: rotation (radians, where the turn is known: 0 for a minimap that keeps north up), rotationWindow (this far
 *       either side of it is tried too), near { x, y, radius } (world yards), coarseStepDeg (6), keep (12), finalists (4),
 *       cells (a byte for each cell of the coarsest level, row by row: only cells marked 1 are tried)
 * @returns the places it could be, the best first: [{ x, y, rotation, score }]
 */
function search(mm, pyr, opts = {}) {
  const coarse = pyr.levels[pyr.levels.length - 1], mmC = mm.levels[mm.levels.length - 1];
  const knownRot = typeof opts.rotation === 'number', fixedRot = knownRot && !(opts.rotationWindow > 0);
  const stepDeg = opts.coarseStepDeg ?? 6;
  const rots = [];
  if (knownRot) { const win = opts.rotationWindow ?? 0; for (let a = -win; a <= win + 1e-9; a += stepDeg * D2R) rots.push(opts.rotation + a); } else for (let a = 0; a < 360; a += stepDeg) rots.push(a * D2R);
  let u0 = 0, u1 = coarse.w - 1, v0 = 0, v1 = coarse.h - 1;
  if (opts.near) {
    const c = worldToCell(pyr, coarse, opts.near.x, opts.near.y), r = opts.near.radius * pyr.s / coarse.k + 1;
    u0 = Math.max(u0, Math.floor(c.u - r)); u1 = Math.min(u1, Math.ceil(c.u + r)); v0 = Math.max(v0, Math.floor(c.v - r)); v1 = Math.min(v1, Math.ceil(c.v + r));
  }
  if (u0 > u1 || v0 > v1) return [];
  // ---- coarse: every turn at every cell. Only what is lit on the minimap enters the product;
  // how much of the plan is lit under the disc is taken once for each cell (the disc being
  // round, it hardly depends on the turn).
  const { dx, dy, m, w } = mmC, n = m.length, W = coarse.W, f = coarse.f, pad = coarse.pad, k = coarse.k;
  const cells = opts.cells ?? null, cw = coarse.w;
  const ffMap = new Float32Array(coarse.W * coarse.H);
  {
    const off = new Int32Array(n);
    for (let i = 0; i < n; i++) off[i] = Math.round(dy[i] / k) * W + Math.round(dx[i] / k);
    for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) {
      if (cells && !cells[v * cw + u]) continue;
      const base = (v + pad) * W + u + pad; let s = 0;
      for (let i = 0; i < n; i++) { const fv = f[base + off[i]]; s += w[i] * fv * fv; }
      ffMap[base] = s;
    }
  }
  const lit = []; for (let i = 0; i < n; i++) if (m[i] * w[i] > 0.02) lit.push(i);
  const nl = lit.length, off = new Int32Array(nl), wm = new Float32Array(nl);
  for (let j = 0; j < nl; j++) wm[j] = w[lit[j]] * m[lit[j]];
  // the best score of every cell, kept apart for each quarter of the turns (so that a place that
  // fits at two turns - a room that is the same from two sides - gives two places to choose between)
  const BINS = 4, cellsN = coarse.W * coarse.H;
  const bestS = new Float32Array(BINS * cellsN), bestR = new Float32Array(BINS * cellsN);
  const mmE = mmC.mm;
  for (let ri = 0; ri < rots.length; ri++) {
    const rot = rots[ri], c = Math.cos(rot), s = Math.sin(rot);
    const bin = Math.min(BINS - 1, Math.floor(norm(rot) / (2 * Math.PI) * BINS)) * cellsN;
    for (let j = 0; j < nl; j++) { const i = lit[j]; off[j] = Math.round((-dx[i] * s + dy[i] * c) / k) * W + Math.round((dx[i] * c + dy[i] * s) / k); }
    for (let v = v0; v <= v1; v++) {
      const rowBase = (v + pad) * W + pad;
      for (let u = u0; u <= u1; u++) {
        if (cells && !cells[v * cw + u]) continue;
        const base = rowBase + u;
        let dot = 0;
        for (let j = 0; j < nl; j++) dot += wm[j] * f[base + off[j]];
        const den = mmE + ffMap[base] - dot;
        const sc = den > 1e-9 ? dot / den : 0;
        if (sc > bestS[bin + base]) { bestS[bin + base] = sc; bestR[bin + base] = rot; }
      }
    }
  }
  const cands = [];
  for (let bi = 0; bi < BINS; bi++) for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) {
    const base = (v + pad) * W + u + pad, sc = bestS[bi * cellsN + base];
    if (sc > 0.1) cands.push({ u, v, rot: bestR[bi * cellsN + base], score: sc });
  }
  if (!cands.length) return [];
  cands.sort((a, b) => b.score - a.score);
  // the best few that are not the neighbours of a better one
  let keep = [];
  for (const cnd of cands) {
    if (keep.some((kp) => Math.hypot(kp.u - cnd.u, kp.v - cnd.v) <= 2.5 && Math.abs(angDiff(kp.rot, cnd.rot)) <= 2.5 * stepDeg * D2R)) continue;
    keep.push(cnd);
    if (keep.length >= (opts.keep ?? 12)) break;
  }
  // ---- down the levels in between: every one kept, a small neighbourhood each
  let lvPrev = coarse, rotStep = stepDeg * D2R;
  for (let li = pyr.levels.length - 2; li >= 1; li--) {
    const lv = pyr.levels[li], mmLv = mm.levels[li], ratio = lvPrev.k / lv.k;
    rotStep /= 2;
    keep = keep.map((cur) => {
      const cu = Math.round((cur.u + 0.5) * ratio - 0.5), cv = Math.round((cur.v + 0.5) * ratio - 0.5);
      let best = { score: -1 };
      for (let a = -1; a <= 1; a++) {
        const rot = fixedRot ? opts.rotation : cur.rot + a * rotStep;
        for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) {
          const sc = scoreAt(mmLv, lv, cu + du, cv + dv, rot);
          if (sc > best.score) best = { u: cu + du, v: cv + dv, rot, score: sc };
        }
        if (fixedRot) break;
      }
      return best;
    });
    lvPrev = lv;
  }
  keep.sort((a, b) => b.score - a.score);
  // ---- the best of them, to a fraction of a pixel at the finest level
  const lv = pyr.levels[0], mmLv = mm.levels[0], ratio = lvPrev.k / lv.k;
  const out = [];
  const nFinal = Math.max(1, keep.slice(0, opts.finalists ?? 4).filter((c) => c.score >= keep[0].score - 0.12).length);
  for (const cur of keep.slice(0, nFinal)) {
    const start = { u: (cur.u + 0.5) * ratio - 0.5, v: (cur.v + 0.5) * ratio - 0.5, rot: cur.rot };
    const b = climb(mmLv, lv, start, ratio / 2, fixedRot ? 0 : rotStep / 2, 0.06, 0.06 * D2R, true);
    const wpos = cellToWorld(pyr, lv, b.u, b.v);
    out.push({ x: wpos.x, y: wpos.y, rotation: norm(b.rot), score: b.score });
  }
  // (the rest keep the score they had a level up, a little lower than a settled one would be: they only ever serve as the runner-up)
  for (const cur of keep.slice(nFinal)) { const wpos = cellToWorld(pyr, lvPrev, cur.u, cur.v); out.push({ x: wpos.x, y: wpos.y, rotation: norm(cur.rot), score: cur.score, coarse: true }); }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Follow a place that is known: climb from it a level or two up, then at the finest. { x, y, rotation } -> { x, y, rotation, score } */
function refine(mm, pyr, pose, { fixedRotation = false, reachYards = 6 } = {}) {
  // begin at the level whose cells are about half the reach, so that two steps cover it
  let start = 0;
  for (let li = 0; li < pyr.levels.length; li++) if (pyr.levels[li].k <= Math.max(2, reachYards * pyr.s / 2)) start = li;
  let cur = { x: pose.x, y: pose.y, rotation: pose.rotation };
  for (let li = start; li >= 0; li--) {
    const lv = pyr.levels[li], mmLv = mm.levels[li], first = li === start, last = li === 0;
    const c = worldToCell(pyr, lv, cur.x, cur.y);
    const b = climb(mmLv, lv, { u: c.u, v: c.v, rot: cur.rotation }, first ? 2 : 0.5, fixedRotation ? 0 : (first ? 3 : 0.75) * D2R, last ? 0.06 : 0.4, (last ? 0.06 : 0.7) * D2R, true);
    const wpos = cellToWorld(pyr, lv, b.u, b.v);
    cur = { x: wpos.x, y: wpos.y, rotation: norm(b.rot), score: b.score };
  }
  return cur;
}

/** The levels for a scale: cells of 1, 2, 4 ... screen pixels, the coarsest 4 to 8 yards but at most 16 px (the disc has to stay several cells wide). */
export function levelsFor(screenPxPerYard) {
  const out = [1, 2, 4];
  while (out[out.length - 1] * 2 <= 8 * screenPxPerYard && out[out.length - 1] * 2 <= 16) out.push(out[out.length - 1] * 2);
  return out;
}

// ------------------------------------------------------------------ putting it together

const SPARSE = 0.1, SPARSE_FIT = 0.8; // a minimap less than a tenth lit is only believed, at a fresh look, of a fit this good
const KEEP_BYTES = 96e6; // of the sets of rooms kept at the screen's scale (a big dungeon's take megabytes each, and it has twenty)

export class Locator {
  /**
   * ref: loadReference(...);  screenPxPerYard: the minimap's scale on the screen (its frame's width in pixels over the yards it shows across).
   * opts: minScore (0.6), minMargin (0.05), discRadiusPx (the largest rMax that will be used: 110)
   */
  constructor(ref, screenPxPerYard, opts = {}) {
    this.ref = ref; this.s = screenPxPerYard; this.opts = opts; this.pyramids = new Map();
    this.levels = opts.levels ?? levelsFor(screenPxPerYard);
    this.disc = opts.discRadiusPx ?? 110;
    this.sets = null;
  }

  /**
   * The sets of rooms the game may be drawing: one for each kind of room you can be in.
   * [{ key, hidden: Set of the rooms not drawn, rooms: [the rooms you are in when this set is drawn],
   *    cells: where those rooms are, at the coarsest level }]
   */
  roomSets() {
    if (this.sets) return this.sets;
    const ref = this.ref, byKey = new Map();
    // (the coarsest level's grid, without building anything)
    let q = ref.pxPerYard / this.s, cw = Math.ceil(ref.width / q), chh = Math.ceil(ref.height / q);
    for (let k = 1; k < this.levels[this.levels.length - 1]; k *= 2) { cw = Math.ceil(cw / 2); chh = Math.ceil(chh / 2); q *= 2; }
    for (const g of ref.groups) {   // every room you can be in, pictured or not
      const hidden = ref.pictured.filter((p) => p.world.zMin > g.world.zMax).map((p) => p.index);
      const key = hidden.join(',');
      if (!byKey.has(key)) byKey.set(key, { key, hidden: new Set(hidden), rooms: [], cells: new Uint8Array(cw * chh) });
      byKey.get(key).rooms.push(g.index);
    }
    const mark = (cells, col, row) => { // a pixel of the plan, and the cells round it
      const u = Math.floor(col / q), v = Math.floor(row / q);
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const U = u + i, V = v + j; if (U >= 0 && V >= 0 && U < cw && V < chh) cells[V * cw + U] = 1; }
    };
    for (const set of byKey.values()) for (const gi of set.rooms) {
      const g = ref.groups[gi];
      if (g.data) { const { col, row, w, h } = g.mask; for (let j = 0; j < h; j += 2) for (let i = 0; i < w; i += 2) if (g.data[j * w + i]) mark(set.cells, col + i, row + j); }
      else { // a room without a picture: its box
        const b = g.world, c0 = (ref.originY - b.yMax) * ref.pxPerYard, c1 = (ref.originY - b.yMin) * ref.pxPerYard, r0 = (ref.originX - b.xMax) * ref.pxPerYard, r1 = (ref.originX - b.xMin) * ref.pxPerYard;
        for (let r = r0; r <= r1; r += 2) for (let c = c0; c <= c1; c += 2) mark(set.cells, c, r);
      }
    }
    this.sets = [...byKey.values()];
    return this.sets;
  }

  /** The sets of rooms you could be in within so many yards of a spot (a set's own rooms, where they are: its cells). */
  setsNear(x, y, radius) {
    const ref = this.ref, sets = this.roomSets();
    let q = ref.pxPerYard / this.s, cw = Math.ceil(ref.width / q), chh = Math.ceil(ref.height / q);
    for (let k = 1; k < this.levels[this.levels.length - 1]; k *= 2) { cw = Math.ceil(cw / 2); chh = Math.ceil(chh / 2); q *= 2; }
    const u = (ref.originY - y) * ref.pxPerYard / q, v = (ref.originX - x) * ref.pxPerYard / q, r = radius * ref.pxPerYard / q + 1;
    const u0 = Math.max(0, Math.floor(u - r)), u1 = Math.min(cw - 1, Math.ceil(u + r)), v0 = Math.max(0, Math.floor(v - r)), v1 = Math.min(chh - 1, Math.ceil(v + r));
    return sets.filter((st) => { for (let j = v0; j <= v1; j++) for (let i = u0; i <= u1; i++) if (st.cells[j * cw + i]) return true; return false; });
  }

  /** The rooms whose picture (or, for want of one, whose box) holds a spot, to within a yard. */
  roomsAt(x, y) {
    const ref = this.ref, col = (ref.originY - y) * ref.pxPerYard, row = (ref.originX - x) * ref.pxPerYard, out = [];
    for (const g of ref.groups) {
      if (x < g.world.xMin - 1.5 || x > g.world.xMax + 1.5 || y < g.world.yMin - 1.5 || y > g.world.yMax + 1.5) { if (!g.data) continue; }
      if (g.data) {
        let hit = false;
        for (let j = -2; j <= 2 && !hit; j++) for (let i = -2; i <= 2; i++) { const X = Math.floor(col) + i - g.mask.col, Y = Math.floor(row) + j - g.mask.row; if (X >= 0 && Y >= 0 && X < g.mask.w && Y < g.mask.h && g.data[Y * g.mask.w + X]) { hit = true; break; } }
        if (hit) out.push(g.index);
      } else if (x >= g.world.xMin - 1 && x <= g.world.xMax + 1 && y >= g.world.yMin - 1 && y <= g.world.yMax + 1) out.push(g.index);
    }
    return out;
  }

  /** Cut the minimap out of a picture, at this locator's levels (see extractMinimap). */
  cut(pic, geom) { return extractMinimap(pic, geom, this.levels); }

  pyramid(hidden = null) {
    const key = hidden && hidden.size ? [...hidden].sort((a, b) => a - b).join(',') : '';
    let p = this.pyramids.get(key);
    if (p) { this.pyramids.delete(key); this.pyramids.set(key, p); return p; } // (lately used: kept longest)
    p = buildPyramid(this.ref, hidden, this.s, this.levels, this.disc);
    p.bytes = p.levels.reduce((n, lv) => n + lv.f.byteLength, 0);
    this.pyramids.set(key, p);
    let held = 0;
    for (const q of this.pyramids.values()) held += q.bytes;
    while (held > KEEP_BYTES && this.pyramids.size > 2) { const oldest = this.pyramids.keys().next().value; held -= this.pyramids.get(oldest).bytes; this.pyramids.delete(oldest); }
    return p;
  }

  /**
   * Which rooms does the minimap show, at this place? For every room that has pixels of its own
   * in view (pixels no other room's picture covers): how many, and the share of them that is lit.
   */
  presence(mm, pose) {
    const { ref } = this, g0 = mm.geom, cs = Math.cos(pose.rotation), sn = Math.sin(pose.rotation), s = this.s, out = [];
    const reach = g0.rMax / s + 2; // yards the disc reaches
    for (const g of ref.pictured) {
      // (a room wholly outside the disc is not looked at)
      const nx = Math.max(g.world.xMin, Math.min(pose.x, g.world.xMax)), ny = Math.max(g.world.yMin, Math.min(pose.y, g.world.yMax));
      if (Math.hypot(nx - pose.x, ny - pose.y) > reach) continue;
      const { col, row, w, h } = g.mask; let tot = 0, lit = 0;
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        if (!g.data[j * w + i] || ref.count[(row + j) * ref.width + col + i] !== 1) continue;
        const wy = ref.originY - (col + i + 0.5) / ref.pxPerYard, wx = ref.originX - (row + j + 0.5) / ref.pxPerYard;
        const e = (pose.y - wy) * s, so = (pose.x - wx) * s;                    // screen px east and south of you, before the turn
        const X = Math.round(g0.cx + e * cs - so * sn) - mm.x0, Y = Math.round(g0.cy + e * sn + so * cs) - mm.y0;
        if (X < 0 || Y < 0 || X >= mm.n || Y >= mm.n || !mm.w[Y * mm.n + X]) continue;
        tot++; lit += mm.m[Y * mm.n + X];
      }
      out.push({ index: g.index, inView: tot, share: tot ? lit / tot : null });
    }
    return out;
  }

  /**
   * Where are you?
   * opts: rotation / rotationWindow (the turn, where known), near { x, y, radius },
   *       previous { x, y, rotation, set } (the last answer: followed instead of searched for; a search follows when the
   *       fit has become poor - under minFollow, 0.8 - or the spot has jumped further than maxStepYards, 12;
   *       followOnly: no search then, nothing is the answer)
   * @returns { ok, reason, x, y, rotation, score, margin, runnerUp,
   *            set (the set of rooms that fitted), hidden: [the rooms that set leaves out],
   *            rooms: [the rooms you may be in: those at the spot, of every set of rooms the picture does not rule out],
   *            band: [lowest, highest] (yards: the heights those rooms span; null where no room is at the spot),
   *            odd: [rooms lit though the set leaves them out, or dark though it draws them: something covers the
   *                  minimap, or the rule for what is drawn is not the whole truth], floorFraction, ms, mode: 'search' | 'follow' }
   */
  locate(mm, opts = {}) {
    const t0 = performance.now();
    const minScore = opts.minScore ?? this.opts.minScore ?? 0.6, minMargin = opts.minMargin ?? this.opts.minMargin ?? 0.05;
    const fixedRot = typeof opts.rotation === 'number' && !(opts.rotationWindow > 0);
    const fail = (reason, extra = {}) => ({ ok: false, reason, score: 0, margin: 0, floorFraction: mm.floorFraction, ms: performance.now() - t0, mode: 'search', ...extra });
    if (mm.floorFraction < 0.004) return fail('the minimap shows no floor at all', { empty: true });
    const sets = this.roomSets();
    let top = null, other = null, mode = 'search';
    if (opts.previous) {
      // the same set of rooms first; where that no longer fits well, the other sets, where the spot is in one of their rooms
      const first = sets.find((st) => st.key === opts.previous.set) ?? sets[0];
      let r = { ...refine(mm, this.pyramid(first.hidden), opts.previous, { fixedRotation: fixedRot }), set: first };
      // (only the sets with a room of their own hereabouts: a big dungeon has twenty, and each is megabytes to lay out)
      if (r.score < 0.9) for (const st of this.setsNear(opts.previous.x, opts.previous.y, 12)) {
        if (st === first) continue;
        const r2 = refine(mm, this.pyramid(st.hidden), opts.previous, { fixedRotation: fixedRot });
        if (r2.score > r.score && this.roomsAt(r2.x, r2.y).some((gi) => st.rooms.includes(gi))) r = { ...r2, set: st };
      }
      if (r.score >= (opts.minFollow ?? Math.max(minScore, 0.8)) && Math.hypot(r.x - opts.previous.x, r.y - opts.previous.y) <= (opts.maxStepYards ?? 12)) { top = r; mode = 'follow'; }
    }
    if (!top) {
      if (opts.followOnly) return fail('lost: the place followed no longer fits');
      // every set of rooms the game may draw, each looked for only where you would have to be for it
      const pool = [];
      for (const st of opts.near ? this.setsNear(opts.near.x, opts.near.y, opts.near.radius) : sets) for (const c of search(mm, this.pyramid(st.hidden), { ...opts, cells: st.cells })) pool.push({ ...c, set: st });
      if (!pool.length) return fail('nothing on the plan resembles the minimap');
      pool.sort((a, b) => b.score - a.score);
      top = pool[0];
      other = pool.find((r) => r !== top && (Math.hypot(r.x - top.x, r.y - top.y) > 5 || Math.abs(angDiff(r.rotation, top.rotation)) > 10 * D2R)) ?? null;
    }
    const margin = other ? top.score - other.score : top.score;
    // The rooms the picture shows and does not show, held against every set of rooms: a set is
    // ruled out by a room in view that it draws and the picture has dark, or leaves out and the
    // picture has lit. Where the rooms that tell two sets apart are out of view, you may be in
    // a room of either.
    const seen = this.presence(mm, top), odd = [];
    for (const p of seen) {
      if (p.inView < 40) continue;
      if (top.set.hidden.has(p.index) ? p.share > 0.6 : p.share < 0.25) odd.push(p.index);
    }
    const at = this.roomsAt(top.x, top.y), rooms = [];
    for (const st of sets) {
      const out = st !== top.set && seen.some((p) => p.inView >= 40 && (st.hidden.has(p.index) ? p.share > 0.6 : p.share < 0.25));
      if (!out) for (const gi of at) if (st.rooms.includes(gi) && !rooms.includes(gi)) rooms.push(gi);
    }
    let band = null;
    for (const gi of rooms) { const b = this.ref.groups[gi].world; band = band ? [Math.min(band[0], b.zMin), Math.max(band[1], b.zMax)] : [b.zMin, b.zMax]; }
    let ok = true, reason = '';
    if (top.score < minScore) { ok = false; reason = `a poor fit (${top.score.toFixed(2)}, and ${minScore} is asked)`; }
    // (little of the minimap lit, and what is lit fits only middling: something dark over most of it looks like many a corner of the plan)
    else if (mode === 'search' && mm.floorFraction < SPARSE && top.score < SPARSE_FIT) { ok = false; reason = `too little of the minimap is lit to go by (${(mm.floorFraction * 100).toFixed(0)} %) for a fit of ${top.score.toFixed(2)}`; }
    else if (mode === 'search' && margin < minMargin) { ok = false; reason = `two places fit about as well (the other: ${other.x.toFixed(0)}, ${other.y.toFixed(0)}, turned ${(other.rotation / D2R).toFixed(0)} degrees, ${other.score.toFixed(2)})`; }
    return {
      ok, reason, x: top.x, y: top.y, rotation: top.rotation, score: top.score, margin,
      runnerUp: other ? { x: other.x, y: other.y, rotation: other.rotation, score: other.score } : null,
      set: top.set.key, hidden: [...top.set.hidden].sort((a, b) => a - b), rooms, band, odd, floorFraction: mm.floorFraction, mode, ms: performance.now() - t0,
    };
  }
}

// ------------------------------------------------------------------ your arrow

/**
 * Your arrow in the middle of the minimap: which way it points. It is a white wedge with a blue
 * dot at its tail; the way is from the dot to the wedge's far end.
 * @returns { facing (radians, 0 = up = north, counter-clockwise positive), whitePx, bluePx } or null (not seen)
 */
export function readArrow(pic, cx, cy, radius = 13) {
  const { data, w: imgW, h: imgH, ch } = pic;
  let bx = 0, by = 0, bn = 0;
  const white = [];
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
    if (x < 0 || y < 0 || x >= imgW || y >= imgH || (x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
    const p = (y * imgW + x) * ch, R = data[p], G = data[p + 1], B = data[p + 2];
    if (B > 80 && B - R > 35 && B - G > 25) { bx += x; by += y; bn++; }
    else if (Math.min(R, G, B) > 150 && Math.max(R, G, B) - Math.min(R, G, B) < 60) white.push([x, y]);
  }
  if (bn < 2 || white.length < 6) return null;
  bx /= bn; by /= bn;
  // the tip: the white pixels furthest from the dot (the middle of the furthest fifth)
  white.sort((a, b) => Math.hypot(b[0] - bx, b[1] - by) - Math.hypot(a[0] - bx, a[1] - by));
  const far = white.slice(0, Math.max(3, Math.round(white.length / 5)));
  const tx = far.reduce((s, p) => s + p[0], 0) / far.length, ty = far.reduce((s, p) => s + p[1], 0) / far.length;
  if (Math.hypot(tx - bx, ty - by) < radius * 0.25) return null; // (a blob, not a wedge)
  // up on the screen is north; left of it is a quarter turn counter-clockwise
  return { facing: norm(Math.atan2(-(tx - bx), -(ty - by))), whitePx: white.length, bluePx: bn };
}

// ------------------------------------------------------------------ the rim

// The gold of the minimap's rim, as the game's own interface draws it.
const isGold = (r, g, b) => r > 105 && r - b > 45 && g - b > 15 && r >= g;

function fitCircle(pts) { // (least squares, after Kasa)
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
  const n = pts.length;
  for (const [x, y] of pts) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z; }
  const A = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, n, sz]];
  for (let i = 0; i < 3; i++) {
    let p = i; for (let j = i + 1; j < 3; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-9) return null;
    for (let j = i + 1; j < 3; j++) { const f = A[j][i] / A[i][i]; for (let k = i; k < 4; k++) A[j][k] -= f * A[i][k]; }
  }
  const s = [0, 0, 0];
  for (let i = 2; i >= 0; i--) { let v = A[i][3]; for (let k = i + 1; k < 3; k++) v -= A[i][k] * s[k]; s[i] = v / A[i][i]; }
  const cx = s[0] / 2, cy = s[1] / 2, rr = s[2] + cx * cx + cy * cy;
  return rr > 0 ? { cx, cy, r: Math.sqrt(rr) } : null;
}

/**
 * The inner edge of the rim, fitted with a circle, from about where it should be: going outward
 * from the middle along 720 spokes, the first gold pixel of each. What does not lie on a circle
 * with the rest (a button on the rim, a gold dot on the map) is left out.
 * near: { cx, cy, r } (about where the inner edge is), slack: how far off r may be (a share of it)
 * @returns { cx, cy, r, n (spokes that took part), rms (px off the circle) } or null: no rim there
 */
export function fitRim(pic, near, slack = 0.14) {
  const { data, w, h, ch } = pic, pts = [];
  const from = near.r * (1 - slack), to = near.r * (1 + slack) + 2;
  for (let a = 0; a < 720; a++) {
    const th = (a / 720) * 2 * Math.PI, dx = Math.sin(th), dy = -Math.cos(th);
    for (let r = from; r < to; r += 0.25) {
      const x = near.cx + dx * r, y = near.cy + dy * r, X = Math.round(x), Y = Math.round(y);
      if (X < 0 || Y < 0 || X >= w || Y >= h) break;
      const p = (Y * w + X) * ch;
      if (isGold(data[p], data[p + 1], data[p + 2])) { if (r > from) pts.push([x, y]); break; } // (gold from the first step on: not an edge)
    }
  }
  if (pts.length < 200) return null;
  let fit = fitCircle(pts), keep = pts;
  for (let it = 0; it < 5 && fit; it++) {
    const res = keep.map(([x, y]) => Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.r));
    const med = [...res].sort((p, q) => p - q)[res.length >> 1];
    keep = keep.filter((_, i) => res[i] <= Math.max(0.8, 2.5 * med));
    if (keep.length < 150) return null;
    fit = fitCircle(keep);
  }
  if (!fit) return null;
  const rms = Math.sqrt(keep.reduce((s, [x, y]) => s + (Math.hypot(x - fit.cx, y - fit.cy) - fit.r) ** 2, 0) / keep.length);
  if (rms > 1.2 || keep.length < 240) return null;
  return { cx: fit.cx, cy: fit.cy, r: fit.r, n: keep.length, rms };
}

/**
 * Look through a picture for the rim with nothing known of where it is: the circle whose inside
 * edge is gold all the way round and whose inside, a few pixels in, is not.
 * @returns { cx, cy, r, n, rms } (the inner edge, fitted: fitRim) or null
 */
export function findRim(pic, { rMin = 45, rMax = 260 } = {}) {
  const { data, w, h, ch } = pic;
  // the gold of the picture, at a quarter of its size: how many of each 4 x 4 pixels are gold
  const K = 4, gw = Math.ceil(w / K), gh = Math.ceil(h / K), gold = new Uint8Array(gw * gh);
  let any = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = (y * w + x) * ch; if (isGold(data[p], data[p + 1], data[p + 2])) { gold[(y >> 2) * gw + (x >> 2)]++; any++; } }
  if (any < 400) return null;
  // circles at that size: a centre, a radius, and 48 spokes - the edge gold, three cells further in not
  const N = 48, cs = new Float32Array(N), sn = new Float32Array(N);
  for (let a = 0; a < N; a++) { cs[a] = Math.sin((a / N) * 2 * Math.PI); sn[a] = -Math.cos((a / N) * 2 * Math.PI); }
  let best = null;
  const r0 = Math.max(6, Math.floor(rMin / K)), r1 = Math.min(Math.ceil(rMax / K), Math.floor(Math.min(gw, gh) / 2));
  for (let r = r0; r <= r1; r++) {
    for (let cy = r - 2; cy < gh - r + 2; cy++) for (let cx = r - 2; cx < gw - r + 2; cx++) {
      let hit = 0;
      for (let a = 0; a < N; a++) {
        const ex = Math.round(cx + cs[a] * (r + 0.6)), ey = Math.round(cy + sn[a] * (r + 0.6));
        if (ex < 0 || ey < 0 || ex >= gw || ey >= gh || gold[ey * gw + ex] < 5) continue;
        const ix = Math.round(cx + cs[a] * (r - 2.5)), iy = Math.round(cy + sn[a] * (r - 2.5));
        if (gold[iy * gw + ix] < 3) hit++;
        if (a === 11 && hit < 4) break; // (a quarter of the way round and next to nothing: not here)
      }
      if (hit >= 30 && (!best || hit > best.hit)) best = { hit, cx: (cx + 0.5) * K, cy: (cy + 0.5) * K, r: (r + 0.3) * K };
    }
  }
  if (!best) return null;
  return fitRim(pic, best, 0.2);
}

// How the game's own interface lays its minimap inside the rim it draws round it. Measured on
// seven screenshots of this game (2527 x 1240): the rim's inner edge is a circle of radius 100.5
// about (2395.26, 159.49) while north is up, and 300 yards across take 205 pixels, so the map's
// frame is 2.04 inner radii wide. The map's middle - you - is not the rim's: it was measured
// four ways (the point your arrow turns about, by the arrow's dot and by its wedge; the point
// the rim itself turns about when the minimap turns with you; and the middle that put the
// matcher's answer on the game's own figures of where you stood), which agree to within half a
// pixel on (2395.8, 160.9): 0.005 of a radius right of the rim's middle and 0.014 below it.
// (When the minimap turns, the rim turns with it and its middle goes round the map's: Finder.)
const RIM_HALF = 102.5 / 100.5, RIM_DX = 0.54 / 100.5, RIM_DY = 1.41 / 100.5;
/** The minimap inside a rim: { cx, cy, half (half the width of the map's frame) }, in the picture's pixels. */
export const insideRim = (rim) => ({ cx: rim.cx + RIM_DX * rim.r, cy: rim.cy + RIM_DY * rim.r, half: rim.r * RIM_HALF });
/** About where the rim's inner edge is, for a minimap whose frame is known. */
export const rimOf = (g) => ({ cx: g.cx - RIM_DX * g.half / RIM_HALF, cy: g.cy - RIM_DY * g.half / RIM_HALF, r: g.half / RIM_HALF });
