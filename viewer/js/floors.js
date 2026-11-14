// Walkable surfaces inside and on top of buildings (floors, stairs, bridges, cave floors),
// taken from the game's own collision triangles. Used to work out how high the player is
// standing when the game only reports a map position.

const CELL = 4;        // yards per grid cell
const MAX_GRIDS = 8;   // buildings kept ready at once
const MIN_UP = 0.4;    // surfaces steeper than ~66 degrees are walls, not floors

/**
 * Build a lookup grid of one placed building's upward-facing collision triangles (world space).
 * @param rooms  the building's rooms as the game divides it (the model's `groups`: each owns a run
 *               of the vertices), so that a floor can say which room it is the floor of
 */
function build(placement, collision, rooms = []) {
  const { verts, indices } = collision; // verts: 9 floats per vertex (position, normal, uv, colour)
  const M = placement.mat, b = placement.bounds;
  const nV = Math.floor(verts.length / 9), nT = Math.floor(indices.length / 3);
  const wp = new Float32Array(nV * 3);
  for (let i = 0; i < nV; i++) {
    const x = verts[i * 9], y = verts[i * 9 + 1], z = verts[i * 9 + 2];
    wp[i * 3] = M[0] * x + M[1] * y + M[2] * z + M[3];
    wp[i * 3 + 1] = M[4] * x + M[5] * y + M[6] * z + M[7];
    wp[i * 3 + 2] = M[8] * x + M[9] * y + M[10] * z + M[11];
  }
  // Which way round are triangles wound? Decide by agreement with the stored vertex normals.
  let vote = 0;
  const stepT = Math.max(1, Math.floor(nT / 20000));
  for (let t = 0; t < nT; t += stepT) {
    const a = indices[t * 3] * 9, c = indices[t * 3 + 1] * 9, d = indices[t * 3 + 2] * 9;
    const ux = verts[c] - verts[a], uy = verts[c + 1] - verts[a + 1], uz = verts[c + 2] - verts[a + 2];
    const vx = verts[d] - verts[a], vy = verts[d + 1] - verts[a + 1], vz = verts[d + 2] - verts[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const nx = verts[a + 3] + verts[c + 3] + verts[d + 3], ny = verts[a + 4] + verts[c + 4] + verts[d + 4], nz = verts[a + 5] + verts[c + 5] + verts[d + 5];
    const dot = gx * nx + gy * ny + gz * nz;
    if (Math.abs(nx) + Math.abs(ny) + Math.abs(nz) > 0.3) vote += Math.sign(dot);
  }
  const wind = vote >= 0 ? 1 : -1;

  const nx = Math.max(1, Math.ceil((b[3] - b[0]) / CELL)), ny = Math.max(1, Math.ceil((b[4] - b[1]) / CELL));
  const cellOf = (v, lo, n) => Math.min(n - 1, Math.max(0, Math.floor((v - lo) / CELL)));
  const keep = [];
  const counts = new Uint32Array(nx * ny + 1);
  for (let t = 0; t < nT; t++) {
    const a = indices[t * 3] * 3, c = indices[t * 3 + 1] * 3, d = indices[t * 3 + 2] * 3;
    const ux = wp[c] - wp[a], uy = wp[c + 1] - wp[a + 1], uz = wp[c + 2] - wp[a + 2];
    const vx = wp[d] - wp[a], vy = wp[d + 1] - wp[a + 1], vz = wp[d + 2] - wp[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const len = Math.hypot(gx, gy, gz);
    if (len < 1e-9 || (gz * wind) / len < MIN_UP) continue; // degenerate, wall or ceiling
    keep.push(a, c, d);
    const x0 = cellOf(Math.min(wp[a], wp[c], wp[d]), b[0], nx), x1 = cellOf(Math.max(wp[a], wp[c], wp[d]), b[0], nx);
    const y0 = cellOf(Math.min(wp[a + 1], wp[c + 1], wp[d + 1]), b[1], ny), y1 = cellOf(Math.max(wp[a + 1], wp[c + 1], wp[d + 1]), b[1], ny);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) counts[cy * nx + cx + 1]++;
  }
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const fill = counts.slice(0, nx * ny);
  const cells = new Uint32Array(counts[nx * ny]);
  const tris = new Float32Array(keep.length * 3);
  // Which room each floor triangle belongs to: the last room whose vertices start at or before
  // its own (a room with nothing in it shares its start with the one after it).
  const room = new Uint16Array(keep.length / 3);
  const firsts = rooms.map((r) => r.firstVertex);
  const scale = placement.scale ?? 1;
  // (each room's own box is given as it lies on the map too: where its middle is, how far it
  // reaches along its two sides, and which way it is turned - the cutaway opens a room by it)
  const ul = Math.hypot(M[0], M[4]) || 1, vl = Math.hypot(M[1], M[5]) || 1;
  const boxOf = (b) => {
    const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2;
    return {
      x: M[0] * cx + M[1] * cy + M[2] * cz + M[3], y: M[4] * cx + M[5] * cy + M[6] * cz + M[7],
      hx: (Math.abs(b[3] - b[0]) / 2) * ul, hy: (Math.abs(b[4] - b[1]) / 2) * vl, cos: M[0] / ul, sin: M[4] / ul,
      area: Math.abs(b[3] - b[0]) * ul * Math.abs(b[4] - b[1]) * vl,
    };
  };
  // (and the box of the whole building: all its rooms together)
  const all = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const r of rooms) {
    if (!r.vertexCount) continue;
    const b = r.bbox.flat();
    for (let i = 0; i < 3; i++) { all[i] = Math.min(all[i], b[i], b[i + 3]); all[i + 3] = Math.max(all[i + 3], b[i], b[i + 3]); }
  }
  const building = all[0] <= all[3] ? boxOf(all) : null;
  const sizes = rooms.map((r, index) => {
    const b = r.bbox.flat();
    return {
      index, of: placement, building,
      // Indoors, by the game's own flags for the room: an indoor room, and not one lit by the sky.
      // (The streets and squares of Stormwind are "indoor" rooms to the game as well - it is how
      // the city is put together - but lit as the outdoors is: that is what tells them apart.)
      inside: !!(r.flags & 0x2000) && !(r.flags & 0x48),
      area: Math.abs(b[3] - b[0]) * Math.abs(b[4] - b[1]) * scale * scale, height: Math.abs(b[5] - b[2]) * scale,
      box: boxOf(b),
    };
  });
  for (let k = 0; k < keep.length; k += 3) {
    const a = keep[k], c = keep[k + 1], d = keep[k + 2];
    let lo = 0, hi = firsts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (firsts[mid] <= a / 3) lo = mid; else hi = mid - 1; }
    room[k / 3] = lo;
    tris.set([wp[a], wp[a + 1], wp[a + 2], wp[c], wp[c + 1], wp[c + 2], wp[d], wp[d + 1], wp[d + 2]], k * 3);
    const x0 = cellOf(Math.min(wp[a], wp[c], wp[d]), b[0], nx), x1 = cellOf(Math.max(wp[a], wp[c], wp[d]), b[0], nx);
    const y0 = cellOf(Math.min(wp[a + 1], wp[c + 1], wp[d + 1]), b[1], ny), y1 = cellOf(Math.max(wp[a + 1], wp[c + 1], wp[d + 1]), b[1], ny);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) cells[fill[cy * nx + cx]++] = k / 3;
  }
  return { nx, ny, x0: b[0], y0: b[1], starts: counts, cells, tris, room, sizes, used: 0 };
}

/** @param owners  if given, the room of each surface found is added to it, in step with `out` */
function query(g, x, y, out, owners = null) {
  const cx = Math.floor((x - g.x0) / CELL), cy = Math.floor((y - g.y0) / CELL);
  if (cx < 0 || cy < 0 || cx >= g.nx || cy >= g.ny) return;
  const T = g.tris;
  for (let k = g.starts[cy * g.nx + cx], end = g.starts[cy * g.nx + cx + 1]; k < end; k++) {
    const o = g.cells[k] * 9;
    const ax = T[o], ay = T[o + 1], bx = T[o + 3], by = T[o + 4], cx2 = T[o + 6], cy2 = T[o + 7];
    const det = (by - cy2) * (ax - cx2) + (cx2 - bx) * (ay - cy2);
    if (Math.abs(det) < 1e-9) continue;
    const l1 = ((by - cy2) * (x - cx2) + (cx2 - bx) * (y - cy2)) / det;
    const l2 = ((cy2 - ay) * (x - cx2) + (ax - cx2) * (y - cy2)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
    out.push(l1 * T[o + 2] + l2 * T[o + 5] + l3 * T[o + 8]);
    owners?.push(g.sizes[g.room[g.cells[k]]] ?? null);
  }
}

export class FloorFinder {
  /** @param renderer ModelRenderer (provides loaded building models with their collision data) */
  constructor(renderer) {
    this.renderer = renderer;
    this.grids = new Map();
    this.tick = 0;
  }

  /**
   * Heights of every walkable building surface on the vertical line through (x, y).
   * @param wmos building placements of the current map ({ fdid, mat, bounds })
   * @returns {{ zs: number[], pending: boolean }} pending = a building here is still loading
   */
  at(wmos, x, y) {
    const zs = [];
    const pending = this.#over(wmos, x, y, (g) => query(g, x, y, zs));
    // merge near-duplicates (shared triangle edges)
    zs.sort((p, q) => p - q);
    const out = [];
    for (const z of zs) if (!out.length || z - out[out.length - 1] > 0.05) out.push(z);
    return { zs: out, pending };
  }

  /**
   * The room you are standing in, as the game divides its buildings into rooms: the room whose
   * floor is at your feet. A shop is a room of a few hundred square yards; a hall of Ironforge
   * is one of many thousand.
   * @param z      how high you are standing   @param reach  how far from that the floor may be
   * @returns {{ area: number, height: number } | null, pending: boolean}  as { room, pending };
   *          area = the square yards of ground the room spans (null where no building's floor
   *          is at your feet), pending = a building here is still loading. The room also says
   *          whether the game counts it as indoors (inside), which placed building it is a room
   *          of (of), where its box lies on the map (box: x, y, hx, hy, cos, sin) and where the
   *          box of the whole building does (building: the same, and its area).
   */
  room(wmos, x, y, z, reach = 4) {
    const zs = [], owners = [];
    const pending = this.#over(wmos, x, y, (g) => query(g, x, y, zs, owners));
    let best = -1;
    for (let i = 0; i < zs.length; i++) if (owners[i] && Math.abs(zs[i] - z) <= reach && (best < 0 || Math.abs(zs[i] - z) < Math.abs(zs[best] - z))) best = i;
    return { room: best < 0 ? null : owners[best], pending };
  }

  /** Hand each building over a spot, as its lookup grid, to `each`. True if one of them is still loading. */
  #over(wmos, x, y, each) {
    let pending = false;
    for (const w of wmos) {
      const b = w.bounds;
      if (x < b[0] || x > b[3] || y < b[1] || y > b[4]) continue;
      const m = this.renderer.model('wmo', w.fdid, 0);
      if (!m.loaded) { if (!m.failed) pending = true; continue; }
      if (!m.collision) continue;
      let g = this.grids.get(w);
      if (!g) {
        g = build(w, m.collision, m.meta?.groups ?? []);
        this.grids.set(w, g);
        if (this.grids.size > MAX_GRIDS) {
          let oldest = null;
          for (const [key, v] of this.grids) if (v !== g && (!oldest || v.used < oldest[1].used)) oldest = [key, v];
          if (oldest) this.grids.delete(oldest[0]);
        }
      }
      g.used = ++this.tick;
      each(g);
    }
    return pending;
  }
}
