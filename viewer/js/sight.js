// What stands on a straight line between two points: the buildings and the objects on the way.
// Used to tell whether the camera can see your character (cutaway.js), and how much room there
// is over their head.
//
// A building is gone by the triangles it is DRAWN with (the see-through ones left out), not by
// the game's collision triangles: three quarters of what Stormwind is drawn with has none - most
// of its roofs, for one: nobody can get up there to walk through them - and what is drawn hides
// you whether you could walk through it or not. An object, by its collision shape (models.js).
//
// Each model gets a small lookup grid of its triangles, once, in its own coordinates; a line is
// taken into those coordinates for every place the model stands, so a house that stands in a
// hundred places is prepared once.

const CELL = 6;         // yards per grid cell (in the model's own coordinates)
const EPS = 1e-7;

/** The lookup grid of a model's triangles (made on first use, kept on the model). */
function gridOf(m) {
  if (m.sight !== undefined) return m.sight;
  const c = m.solid;
  const stride = c?.stride ?? 9, V = c?.verts, I = c?.indices;
  // (the stretches of the list of corners that count: all of it, if none are named)
  const ranges = c?.ranges ?? (I ? [[0, I.length]] : []);
  let nT = 0;
  for (const [, count] of ranges) nT += Math.floor(count / 3);
  if (!nT) return (m.sight = null);
  // where each triangle's three corners are in that list
  const at = new Uint32Array(nT);
  let n = 0;
  for (const [first, count] of ranges) for (let k = first; k + 2 < first + count; k += 3) at[n++] = k;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let t = 0; t < nT; t++) {
    for (let j = 0; j < 3; j++) {
      const o = I[at[t] + j] * stride, x = V[o], y = V[o + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (!(x1 >= x0) || !(y1 >= y0)) return (m.sight = null);
  x0 -= 0.01; y0 -= 0.01;
  const nx = Math.max(1, Math.ceil((x1 - x0 + 0.02) / CELL)), ny = Math.max(1, Math.ceil((y1 - y0 + 0.02) / CELL));
  const cell = (v, lo, n) => Math.min(n - 1, Math.max(0, Math.floor((v - lo) / CELL)));
  // the cells each triangle lies over (worked out once: a city is close to a million triangles)
  const span = new Uint32Array(nT * 4);
  const starts = new Uint32Array(nx * ny + 1);
  for (let t = 0; t < nT; t++) {
    const a = I[at[t]] * stride, b = I[at[t] + 1] * stride, d = I[at[t] + 2] * stride;
    const cx0 = cell(Math.min(V[a], V[b], V[d]), x0, nx), cx1 = cell(Math.max(V[a], V[b], V[d]), x0, nx);
    const cy0 = cell(Math.min(V[a + 1], V[b + 1], V[d + 1]), y0, ny), cy1 = cell(Math.max(V[a + 1], V[b + 1], V[d + 1]), y0, ny);
    span[t * 4] = cx0; span[t * 4 + 1] = cx1; span[t * 4 + 2] = cy0; span[t * 4 + 3] = cy1;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) starts[cy * nx + cx + 1]++;
  }
  for (let i = 1; i < starts.length; i++) starts[i] += starts[i - 1];
  const fill = starts.slice(0, nx * ny);
  const cells = new Uint32Array(starts[nx * ny]);
  for (let t = 0; t < nT; t++) {
    const cx0 = span[t * 4], cx1 = span[t * 4 + 1], cy0 = span[t * 4 + 2], cy1 = span[t * 4 + 3];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cells[fill[cy * nx + cx]++] = t;
  }
  return (m.sight = { x0, y0, nx, ny, starts, cells, at, seen: new Uint32Array(nT), tick: 0, V, I, stride });
}

/** The reverse of a placement (3x4, see math.js): takes a point of the world into the model's own coordinates. */
function reverse(M) {
  const a = M[0], b = M[1], c = M[2], d = M[4], e = M[5], f = M[6], g = M[8], h = M[9], i = M[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const r = [A / det, (c * h - b * i) / det, (b * f - c * e) / det, 0, B / det, (a * i - c * g) / det, (c * d - a * f) / det, 0, C / det, (b * g - a * h) / det, (a * e - b * d) / det, 0];
  r[3] = -(r[0] * M[3] + r[1] * M[7] + r[2] * M[11]);
  r[7] = -(r[4] * M[3] + r[5] * M[7] + r[6] * M[11]);
  r[11] = -(r[8] * M[3] + r[9] * M[7] + r[10] * M[11]);
  return r;
}
const into = (R, p) => [R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + R[3], R[4] * p[0] + R[5] * p[1] + R[6] * p[2] + R[7], R[8] * p[0] + R[9] * p[1] + R[10] * p[2] + R[11]];

/**
 * Where the line from a to b (the model's own coordinates) first meets one of the model's
 * triangles: how far along it, 0..1, or -1.
 * @param any   true: the first triangle found will do (is anything in the way at all?)
 * @param skip  if given: (how far along) => true for a meeting that is not to count
 */
function cast(g, a, b, any, skip) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  // the stretch of the line that is over the grid
  let t0 = 0, t1 = 1;
  const X1 = g.x0 + g.nx * CELL, Y1 = g.y0 + g.ny * CELL;
  if (Math.abs(dx) < 1e-12) { if (a[0] < g.x0 || a[0] > X1) return -1; } else {
    let u = (g.x0 - a[0]) / dx, v = (X1 - a[0]) / dx;
    if (u > v) { const s = u; u = v; v = s; }
    if (u > t0) t0 = u; if (v < t1) t1 = v;
  }
  if (Math.abs(dy) < 1e-12) { if (a[1] < g.y0 || a[1] > Y1) return -1; } else {
    let u = (g.y0 - a[1]) / dy, v = (Y1 - a[1]) / dy;
    if (u > v) { const s = u; u = v; v = s; }
    if (u > t0) t0 = u; if (v < t1) t1 = v;
  }
  if (t0 > t1) return -1;
  let cx = Math.min(g.nx - 1, Math.max(0, Math.floor((a[0] + dx * t0 - g.x0) / CELL)));
  let cy = Math.min(g.ny - 1, Math.max(0, Math.floor((a[1] + dy * t0 - g.y0) / CELL)));
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
  const stepX = Math.abs(dx) < 1e-12 ? Infinity : CELL / Math.abs(dx), stepY = Math.abs(dy) < 1e-12 ? Infinity : CELL / Math.abs(dy);
  let nextX = stepX === Infinity ? Infinity : (g.x0 + (cx + (dx > 0 ? 1 : 0)) * CELL - a[0]) / dx;
  let nextY = stepY === Infinity ? Infinity : (g.y0 + (cy + (dy > 0 ? 1 : 0)) * CELL - a[1]) / dy;
  const { V, I, stride, seen, starts, cells, at: corners } = g;
  const tick = ++g.tick;
  let best = -1;
  for (let guard = 0; guard < 100000; guard++) {
    const at = cy * g.nx + cx;
    for (let k = starts[at], end = starts[at + 1]; k < end; k++) {
      const t = cells[k];
      if (seen[t] === tick) continue;
      seen[t] = tick;
      // (Moller-Trumbore, either side of the triangle)
      const o = corners[t], p = I[o] * stride, q = I[o + 1] * stride, r = I[o + 2] * stride;
      const e1x = V[q] - V[p], e1y = V[q + 1] - V[p + 1], e1z = V[q + 2] - V[p + 2];
      const e2x = V[r] - V[p], e2y = V[r + 1] - V[p + 1], e2z = V[r + 2] - V[p + 2];
      const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
      const det = e1x * hx + e1y * hy + e1z * hz;
      if (det > -EPS && det < EPS) continue;
      const inv = 1 / det;
      const sX = a[0] - V[p], sY = a[1] - V[p + 1], sZ = a[2] - V[p + 2];
      const u = (sX * hx + sY * hy + sZ * hz) * inv;
      if (u < -1e-5 || u > 1.00001) continue;
      const qx = sY * e1z - sZ * e1y, qy = sZ * e1x - sX * e1z, qz = sX * e1y - sY * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < -1e-5 || u + v > 1.00001) continue;
      const w = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (w <= 0 || w >= 1 || (skip && skip(w))) continue;
      if (best < 0 || w < best) { best = w; if (any) return best; }
    }
    const next = Math.min(nextX, nextY);
    if (best >= 0 && best <= next) return best; // (nothing in a cell further on can be nearer)
    if (next > t1) break;
    if (nextX < nextY) { cx += sx; nextX += stepX; if (cx < 0 || cx >= g.nx) break; } else { cy += sy; nextY += stepY; if (cy < 0 || cy >= g.ny) break; }
  }
  return best;
}

/** Does the line a..b pass through (or within `pad` of) the box [x0, y0, z0, x1, y1, z1]? */
function crosses(a, b, box, pad) {
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const lo = box[i] - pad, hi = box[i + 3] + pad, d = b[i] - a[i];
    if (Math.abs(d) < 1e-12) { if (a[i] < lo || a[i] > hi) return false; continue; }
    let u = (lo - a[i]) / d, v = (hi - a[i]) / d;
    if (u > v) { const s = u; u = v; v = s; }
    if (u > t0) t0 = u; if (v < t1) t1 = v;
    if (t0 > t1) return false;
  }
  return true;
}

/** How near the line a..b comes to a point (squared). */
function nearSq(a, b, x, y, z) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = dx * dx + dy * dy + dz * dz;
  let t = len > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = a[0] + dx * t - x, py = a[1] + dy * t - y, pz = a[2] + dz * t - z;
  return px * px + py * py + pz * pz;
}

export class Sight {
  /** @param renderer ModelRenderer (the loaded models, with what of each can stand in the way: models.js) */
  constructor(renderer) {
    this.renderer = renderer;
  }

  /** One placed model against the line a..b: how far along it is met (0..1), or -1. */
  #one(place, m, a, b, any, skip) {
    const g = gridOf(m);
    if (!g) return -1;
    if (place.back === undefined) place.back = reverse(place.mat);
    if (!place.back) return -1;
    return cast(g, into(place.back, a), into(place.back, b), any, skip);
  }

  /**
   * The first thing the straight line from a to b meets.
   * @param layer  the placed things of the map (ObjectLayer: its buildings, and the objects of
   *               the tiles loaded and of the buildings drawn)
   * @param any    true: only whether anything is in the way (quicker)
   * @param objects  false: buildings only
   * @param skip     if given: (how far along the line, the object met - null for a building) =>
   *                 true for a meeting that is not to count
   * @returns {{ t: number, pending: boolean }}  t = how far along the line (0..1; -1: nothing),
   *          pending = a building on the way is still loading
   */
  hit(layer, a, b, any = false, objects = true, skip = null) {
    const R = this.renderer;
    let best = -1, pending = false;
    const take = (t) => { if (t >= 0 && (best < 0 || t < best)) best = t; };
    const built = skip ? (t) => skip(t, null) : null;
    const thing = (o) => {
      // (an object: a ball around where it stands holds all of it)
      if (nearSq(a, b, o.mat[3], o.mat[7], o.mat[11]) > o.r * o.r) return;
      const m = R.models.get('m2' + o.fdid);
      if (m?.loaded && m.solid) take(this.#one(o, m, a, b, any, skip ? (t) => skip(t, o) : null));
    };
    for (const w of layer.wmos) {
      if (!crosses(a, b, w.bounds, 1)) continue;
      const m = R.model('wmo', w.fdid, 0);
      if (!m.loaded) { if (!m.failed) pending = true; continue; }
      if (m.solid) take(this.#one(w, m, a, b, any, built));
      if (any && best >= 0) return { t: best, pending };
      if (objects && w.doodads) for (const o of w.doodads) { thing(o); if (any && best >= 0) return { t: best, pending }; }
    }
    if (objects) {
      const reach = 40; // (no object placed on the ground is bigger than this around)
      const x0 = Math.min(a[0], b[0]) - reach, x1 = Math.max(a[0], b[0]) + reach, y0 = Math.min(a[1], b[1]) - reach, y1 = Math.max(a[1], b[1]) + reach;
      for (const [node, list] of layer.tiles) {
        if (node.xN < x0 || node.xN - node.size > x1 || node.yW < y0 || node.yW - node.size > y1) continue;
        for (const o of list) { thing(o); if (any && best >= 0) return { t: best, pending }; }
      }
    }
    return { t: best, pending };
  }
}
