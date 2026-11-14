// Flight paths and boat / zeppelin routes, as the game data defines them (world.json: every
// route is a list of 3D points the game flies or sails a smooth curve through). Used to know
// how high you are while something is carrying you, which no map position can tell.

const STEP = 6;     // yards between the points a route is sampled at
const CELL = 96;    // yards per lookup cell
const STICKY = 20;  // yards: how much closer another route must be before leaving the one you are on
const WANTED = 30;  // yards: how much closer a route must be than one of those you are expected to be on
const JUMP = 1500;  // yards: a step between two points longer than this is not travelled (see below)

// Uniform Catmull-Rom through p1..p2 (p0 and p3 shape the curve), as the game's splines are.
export function curve(p0, p1, p2, p3, t, k) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3);
}

export class TravelRoutes {
  /** @param world world.json ({ taxiNodes, taxiPaths }) */
  constructor(world) {
    this.world = world;
    this.maps = new Map(); // map id -> sampled routes
  }

  #build(mapId) {
    const xs = [], owner = [], routes = [];
    for (const path of this.world.taxiPaths) {
      // the stretch of the route that is on this map (a ship can sail on to another continent)
      const onMap = (i) => (path.pointMaps ? path.pointMaps[i] : path.map) === mapId;
      let run = [];
      const flush = () => {
        if (run.length >= 2) {
          const first = xs.length / 3, id = routes.length;
          for (let i = 0; i + 1 < run.length; i++) {
            const p0 = run[Math.max(0, i - 1)], p1 = run[i], p2 = run[i + 1], p3 = run[Math.min(run.length - 1, i + 2)];
            const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) / STEP));
            for (let s = 0; s < n; s++) { xs.push(curve(p0, p1, p2, p3, s / n, 0), curve(p0, p1, p2, p3, s / n, 1), curve(p0, p1, p2, p3, s / n, 2)); owner.push(id); }
          }
          const last = run[run.length - 1];
          xs.push(last[0], last[1], last[2]); owner.push(id);
          routes.push({ path, first, count: xs.length / 3 - first });
        }
        run = [];
      };
      for (let i = 0; i < path.points.length; i++) {
        const p = path.points[i];
        if (!onMap(i)) { flush(); continue; }
        // a step no real stretch is as long as: the transport is moved there, it does not travel it
        const last = run[run.length - 1];
        if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) > JUMP) flush();
        run.push(p);
      }
      flush();
    }
    const pts = new Float32Array(xs), own = new Uint16Array(owner);
    // how far along its route each sampled point is: yards travelled, height counted
    const cum = new Float32Array(own.length);
    for (let i = 1; i < own.length; i++) cum[i] = own[i] === own[i - 1] ? cum[i - 1] + Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]) : 0;
    const cells = new Map();
    for (let i = 0; i < own.length; i++) {
      const key = `${Math.floor(pts[i * 3] / CELL)},${Math.floor(pts[i * 3 + 1] / CELL)}`;
      let list = cells.get(key);
      if (!list) cells.set(key, (list = []));
      list.push(i);
    }
    return { pts, own, routes, cells, cum };
  }

  #map(mapId) {
    let m = this.maps.get(mapId);
    if (!m) this.maps.set(mapId, (m = this.#build(mapId)));
    return m;
  }

  /**
   * The point of a route nearest to a position (measured on the map, not in height).
   * @param prefer  the previous result: its route is kept unless another is clearly closer, so
   *                two routes running side by side do not make the height flicker
   * @param wanted  the numbers of the paths you are expected to be on (the flight the journey in
   *                hand has you take), or null: out of a flight point every path runs the same
   *                way for a while, and these are then the ones taken
   * @returns {{ route, path, i, x, y, z, along, dist, dir: [dx, dy], rise, end: boolean } | null}
   *          (along: yards travelled from the start of the route to that point, height counted;
   *          rise: yards it climbs there for each yard over the map)
   */
  nearest(mapId, x, y, prefer = null, maxDist = 400, wanted = null) {
    const m = this.#map(mapId);
    if (!m.own.length) return null;
    const { pts, own } = m;
    let best = -1, bestScore = Infinity;
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), reach = Math.ceil(maxDist / CELL);
    for (let j = cy - reach; j <= cy + reach; j++) for (let i = cx - reach; i <= cx + reach; i++) {
      const list = m.cells.get(`${i},${j}`);
      if (!list) continue;
      for (const s of list) {
        let d = Math.hypot(pts[s * 3] - x, pts[s * 3 + 1] - y);
        if (d > maxDist) continue;
        // stay on the route you are on, and do not jump backwards along it
        if (prefer && own[s] === prefer.route && s >= prefer.i - 3) d -= STICKY;
        if (wanted && wanted.includes(m.routes[own[s]].path.id)) d -= WANTED;
        if (d < bestScore) { bestScore = d; best = s; }
      }
    }
    if (best < 0) return null;
    // Refine between the nearest sampled point and its neighbours on the same route.
    const r = m.routes[own[best]];
    let out = null;
    for (const a of [best - 1, best]) {
      const b = a + 1;
      if (a < r.first || b >= r.first + r.count) continue;
      const ax = pts[a * 3], ay = pts[a * 3 + 1], bx = pts[b * 3], by = pts[b * 3 + 1];
      const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
      const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
      const px = ax + vx * t, py = ay + vy * t, d = Math.hypot(px - x, py - y);
      if (!out || d < out.dist) {
        const len = Math.sqrt(l2) || 1;
        out = { route: own[best], path: r.path, i: best, x: px, y: py, z: pts[a * 3 + 2] + (pts[b * 3 + 2] - pts[a * 3 + 2]) * t, along: m.cum[a] + (m.cum[b] - m.cum[a]) * t, dist: d, dir: [vx / len, vy / len], rise: (pts[b * 3 + 2] - pts[a * 3 + 2]) / len, end: b === r.first + r.count - 1 && t > 0.6 };
      }
    }
    return out;
  }

  /** One route's curve on a map, as sampled points: { points: Float32Array (x, y, z ...), length } or null. */
  curve(mapId, pathId) {
    const m = this.#map(mapId);
    if (!m.curves) {
      // worked out once per map: the planner asks for every flight you know each time it plans
      m.curves = new Map();
      for (const r of m.routes) {
        if (m.curves.has(r.path.id)) continue;
        const points = m.pts.subarray(r.first * 3, (r.first + r.count) * 3);
        let length = 0;
        for (let i = 3; i < points.length; i += 3) length += Math.hypot(points[i] - points[i - 3], points[i + 1] - points[i - 2], points[i + 2] - points[i - 1]);
        m.curves.set(r.path.id, { points, length });
      }
    }
    return m.curves.get(pathId) ?? null;
  }

  /** The flight master (or dock) of this map nearest to a position, within `radius` yards on the map. */
  nodeNear(mapId, x, y, radius) {
    let best = null, bestD = radius;
    for (const n of this.world.taxiNodes) {
      if (n.map !== mapId || (!n.pos[0] && !n.pos[1])) continue; // (some entries are placeholders at the origin)
      const d = Math.hypot(n.pos[0] - x, n.pos[1] - y);
      if (d <= bestD) { bestD = d; best = n; }
    }
    return best;
  }
}
