// When the boats, zeppelins and tram run.
//
// transit.json holds each line's timetable as measured in the game: how long its round takes,
// each leg and each stop, and where the craft is every couple of seconds of a leg. A craft
// sails that round to the second until the server restarts, so one moment at which it was seen
// to leave a stop says where it is at any time. Those moments come from the game, by way of the
// addon (addon/AzerothAtlas/Transit.lua): your own rides, and other players' sightings as
// DockWatch, ForeverTransport and Nauticus pass them on, cross-checked there.
//
// Here that becomes: when a craft next leaves a stop (for the journeys route.js plans), and
// where every craft is right now (for showing them on the map).

import { curve } from './travel.js';

const TRAM_Z = -4.3;   // the height of the tram's track (its map has no path to read it from)
const STEP = 6;        // yards between the points a line's path is laid out in
const JUMP = 1500;     // yards: a step of the path longer than this is not sailed (the craft is moved)
const SURE = 20;       // seconds from a dock for which a craft crossing the sea is shown just where the game has it
const CROSS_STEP = 0.5; // seconds between the points a crossing is laid out in
const ZERO = [0, 0];
const mod = (v, m) => ((v % m) + m) % m;

/**
 * A craft `into` seconds into a leg across the sea (see Transit.place): it leaves the stretch
 * by the first dock at the speed it had there, and comes into the stretch by the other at the
 * speed it has there, covering the sea between evenly.
 */
function sailing(c, into) {
  const d = c.t1 - c.t0, u = (into - c.t0) / d, u2 = u * u, u3 = u2 * u;
  const s = (2 * u3 - 3 * u2 + 1) * c.l0 + (u3 - 2 * u2 + u) * d * c.v0 + (3 * u2 - 2 * u3) * c.l1 + (u3 - u2) * d * c.v1;
  const { cum, pts, n } = c;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const len = cum[hi] - cum[lo], f = len > 0 ? Math.max(0, Math.min(1, (s - cum[lo]) / len)) : 0;
  const a = lo * 3, b = hi * 3;
  // (which way it points: along the way just here, or just after where the points fall together)
  let j = hi;
  while (j < n - 1 && cum[j] - cum[lo] < 0.5) j++;
  return { group: c.group, x: pts[a] + (pts[b] - pts[a]) * f, y: pts[a + 1] + (pts[b + 1] - pts[a + 1]) * f, z: pts[a + 2] + (pts[b + 2] - pts[a + 2]) * f, heading: mod((Math.atan2(-(pts[j * 3 + 1] - pts[a + 1]), pts[j * 3] - pts[a]) * 180) / Math.PI, 360) };
}

/**
 * A line's path all the way round, as a close row of points: [{ map, x, y, z, cut (true: the
 * craft is moved from here to the next point, not sailed there) }]. The game sails a smooth
 * curve through the points of its path.
 */
export function wayOf(path) {
  const pts = path.points, mapOf = (i) => (path.pointMaps ? path.pointMaps[i] : path.map);
  const way = [];
  let run = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i++) {
      const p0 = run[Math.max(0, i - 1)], p1 = run[i], p2 = run[i + 1], p3 = run[Math.min(run.length - 1, i + 2)];
      const n = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]) / STEP));
      for (let s = 0; s < n; s++) way.push({ map: p1[3], x: curve(p0, p1, p2, p3, s / n, 0), y: curve(p0, p1, p2, p3, s / n, 1), z: curve(p0, p1, p2, p3, s / n, 2), cut: false });
    }
    if (run.length) { const last = run[run.length - 1]; way.push({ map: last[3], x: last[0], y: last[1], z: last[2], cut: true }); }
    run = [];
  };
  for (let i = 0; i < pts.length; i++) {
    const p = [pts[i][0], pts[i][1], pts[i][2], mapOf(i)], last = run[run.length - 1];
    if (last && (last[3] !== p[3] || Math.hypot(p[0] - last[0], p[1] - last[1]) > JUMP)) flush();
    run.push(p);
  }
  flush();
  // (the round closes on itself where its last point is its first again)
  const a = way[0], b = way[way.length - 1];
  if (a && b && a.map === b.map && Math.hypot(a.x - b.x, a.y - b.y) < 30) b.cut = false;
  return way;
}
/** How far round a way (a whole number and a fraction of the step after it) the point nearest a spot is, looking `span` points on from `from`; -1 if none is within `reach` yards. */
export function nearestOn(way, map, x, y, from, span, reach) {
  const n = way.length;
  let best = -1, bestD = reach;
  for (let k = 0; k < Math.min(span, n); k++) {
    const i = (from + k) % n, a = way[i], b = way[(i + 1) % n];
    if (a.map !== map) continue;
    let t = 0;
    if (!a.cut && b.map === map) {
      const vx = b.x - a.x, vy = b.y - a.y, l2 = vx * vx + vy * vy;
      t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / l2)) : 0;
    }
    const px = a.cut ? a.x : a.x + (b.x - a.x) * t, py = a.cut ? a.y : a.y + (b.y - a.y) * t;
    const dd = Math.hypot(px - x, py - y);
    if (dd < bestD) { bestD = dd; best = i + t; }
  }
  return best;
}
/** The spot so far round a way, and which way the way runs there: [x, y, z, dx, dy]. */
function pointOn(way, u) {
  const n = way.length, i = Math.floor(u) % n, t = u - Math.floor(u);
  const a = way[i], b = a.cut ? a : way[(i + 1) % n];
  // (where the way stops or leaps, it runs as it did just before)
  const c = a.cut ? way[(i + n - 1) % n] : a, e = a.cut ? a : b;
  return [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, e.x - c.x, e.y - c.y];
}
function heightOn(way, map, x, y) {
  const u = nearestOn(way, map, x, y, 0, way.length, Infinity);
  return u < 0 ? 0 : pointOn(way, u)[2];
}

export class Transit {
  constructor() {
    this.lines = [];
    this.byId = new Map();   // the game's own number for a line's path -> line
    this.retired = new Set();
    this.clock = null;       // the game server's time minus this computer's, in ms (null: not heard yet)
    this.live = {};          // line number -> what the addon says of it
    this.rev = 0;
    this.sig = '';
    this.layout = new Map(); // which maps lie together on one picture (setLayout)
    this.riding = null;      // the number of the line you are aboard, if any
  }

  /** @param world world.json (its paths give the height a craft sails or flies at) */
  async load(world) {
    try {
      const res = await fetch('/transit.json');
      if (res.ok) this.use(await res.json(), world);
    } catch { /* no timetables: boats are counted at their average, as before */ }
  }

  /** @param data transit.json */
  use(data, world) {
    this.retired = new Set(data.retired ?? []);
    this.models = data.models ?? {};
    for (const d of data.lines) {
      const count = d.stops.length, cars = d.cars ?? 1;
      // dep[s], arr[s]: how far into its round (seconds after leaving stop 0) a craft leaves stop s, and gets there
      const dep = [0], arr = new Array(count);
      let at = 0;
      for (let i = 0; i < count; i++) {
        const next = (i + 1) % count;
        at += d.legs[i].trip;
        arr[next] = at;
        if (next !== 0) { at += d.stops[next].wait; dep[next] = at; }
      }
      // The recorded tracks say when a craft is where, but they are where its riders stood: a few
      // yards off its own line, and without height. The game's own path for the line is that
      // line. So each recorded moment is laid onto the path (`way`: the path as a close row of
      // points, all the way round), going forward along it only, and a craft is then placed on
      // the path at the spot its timetable says.
      const path = d.id ? world?.taxiPaths?.find((p) => p.id === d.id) : null;
      const way = path ? wayOf(path) : null;
      let cursor = way ? nearestOn(way, d.stops[0].map, d.stops[0].x, d.stops[0].y, 0, way.length, 400) : -1;
      const tracks = (t) => t?.map(([s, map, x, y]) => {
        if (cursor >= 0) {
          const u = nearestOn(way, map, x, y, Math.floor(cursor), 500, 150);
          if (u >= 0) { cursor = u; const p = pointOn(way, u); return [s, map, p[0], p[1], p[2], u]; }
        }
        return [s, map, x, y, way ? heightOn(way, map, x, y) : TRAM_Z, -1];
      });
      const line = {
        ...d, cars, gap: d.period / cars, dep, arr, stay: dep.map((v, s) => mod(v - arr[s], d.period)), way,
        legs: d.legs.map((g) => ({ trip: g.trip, track: tracks(g.track), track2: g.track2 ? g.track2.map(([s, map, x, y]) => [s, map, x, y, TRAM_Z, -1]) : undefined })),
        title: d.stops.map((s) => s.name).join(' - '),
      };
      this.lines.push(line);
      if (d.id) this.byId.set(d.id, line);
    }
  }

  /** What the game says of the lines just now (the live state's `transit`), or null. */
  setLive(t) {
    if (!t) return;
    const sig = JSON.stringify(t);
    if (sig === this.sig) return;
    this.sig = sig;
    this.clock = t.clock;
    this.live = t.lines ?? {};
    this.rev++;
  }

  /** The game's own model of a line's craft ({ kind, id, turn }), or null where it has one of a kind not listed. */
  model(line) { return line.craft ? null : this.models?.[line.kind] ?? null; }

  /** The game server's time now, in seconds (null until the game has said how far its clock is from this computer's). */
  now() { return this.clock === null ? null : (Date.now() + this.clock) / 1000; }

  /** How many lines are timed just now. */
  get known() { return this.lines.filter((l) => this.live[l.n]).length; }

  /**
   * When a craft next leaves stop `s` (from 0) of a line at or after server time `t`:
   * { leaves, gets (when it gets in before that), unsure (seconds), lane (the tram's track: 1, 2
   * or null), src, age } - or null while the line is not timed.
   */
  next(line, s, t) {
    const rec = this.live[line.n];
    if (!rec || t === null) return null;
    const gap = line.gap + rec.gap;
    const base = rec.leaves + line.dep[s];
    const k = Math.ceil((t - base) / gap);
    const leaves = base + k * gap;
    return { leaves, gets: leaves - line.stay[s], unsure: rec.unsure, lane: rec.lane ? mod(rec.lane - 1 + k, line.cars) + 1 : null, src: rec.src, age: rec.age };
  }

  /**
   * Boarding at stop `s` of a line when you get there at server time `t` (null: no telling
   * when): { seconds (until you step off at the next stop), wait, known, leaves }. A craft you
   * would reach with less to spare than its time is unsure by is not counted on: the one after.
   *
   * A line timed too loosely to name the moment (past a sixth of its round: the tram, whose cars
   * are little over a minute apart, is there with a time a quarter of a minute unsure) still
   * says a good deal about the wait, and that much is counted: what the wait comes to on
   * average, with the craft's real time anywhere within what it is unsure by. Getting there
   * well before a car is due is a short wait, just after it a long one. Only a line whose time
   * could be anywhere in its round is taken at half a round.
   * @param walk seconds on foot at each end that belong to the ride (the tram's platforms)
   */
  board(line, s, t, walk = 0) {
    const ride = line.legs[s].trip;
    const n = t === null ? null : this.next(line, s, t + walk);
    const gap = line.gap + (this.live[line.n]?.gap ?? 0);
    if (!n || n.unsure >= gap / 2) return { seconds: line.gap / 2 + ride + 10 + 2 * walk, wait: line.gap / 2, known: false };
    if (n.unsure > line.gap / 6) {
      // (spare: seconds between getting there, with a moment to step aboard, and when it is due)
      const u = n.unsure, spare = n.leaves - (t + walk) - 4;
      const part = (v) => Math.max(0, Math.min(1, v));
      const gone = part((u - spare) / (2 * u));           // how likely it has left before you are there
      const before = part((spare - gap + u) / (2 * u));   // how likely the one before it is still in
      const wait = n.leaves - t + gap * (gone - before);
      return { seconds: wait + ride + 5 + walk, wait, known: false };
    }
    let leaves = n.leaves;
    if (leaves - (t + walk) < Math.max(4, 2 * n.unsure)) leaves += gap;
    return { seconds: leaves - t + ride + 5 + walk, wait: leaves - t, known: true, leaves };
  }

  /**
   * Where every craft of a line is at server time `t`: [{ car, lane, leg (on its way from that
   * stop), into (seconds since leaving it), at (docked at that stop; then leg is the one it came
   * in on), leaves (docked: seconds until it does) }]. Empty while the line is not timed.
   */
  crafts(line, t) {
    const rec = this.live[line.n];
    if (!rec || t === null) return [];
    const gap = line.gap + rec.gap, round = gap * line.cars, count = line.stops.length;
    const out = [];
    for (let car = 0; car < line.cars; car++) {
      const phase = mod(t - rec.leaves - car * gap, round);
      const lane = rec.lane ? mod(rec.lane - 1 + car, line.cars) + 1 : null;
      let found = null;
      for (let i = 0; i < count && !found; i++) {
        const next = (i + 1) % count;
        const end = line.arr[next];
        if (phase >= line.dep[i] && phase < end) found = { car, lane, leg: i, into: phase - line.dep[i], at: null };
        // (at the stop after it, until it leaves there: the first stop's stay runs to the end of the round)
        else if (phase >= end && phase < (next === 0 ? round : line.dep[next])) found = { car, lane, leg: i, into: line.legs[i].trip, at: next, leaves: (next === 0 ? round : line.dep[next]) - phase };
      }
      if (found) out.push(found);
    }
    return out;
  }

  /**
   * Which maps lie together on one picture of the world, and where (joined.js): Map of map id
   * -> { group, at: [x, y] }. With it, a craft crossing from one such map to the other has a
   * place all the way (see place).
   */
  setLayout(layout) {
    this.layout = layout ?? new Map();
    for (const line of this.lines) for (const leg of line.legs) leg.cross = undefined;
  }

  /**
   * A craft's place in the world: { map, x, y, z, heading (compass degrees) }.
   *
   * Between two maps there is no such place: the game moves the craft from one continent to
   * the other in a moment, out at sea, while its riders look at a loading screen. Where both
   * continents are on one picture (setLayout) the craft is shown sailing the sea between them
   * instead: { group, x, y, z, heading }, in the yards of that picture. It is where the game has
   * it for the first and last SURE seconds of the crossing, in sight of the docks; in between it
   * sails evenly from the one stretch to the other. The craft you are aboard (`riding`) is
   * always where the game has it, and crosses in the moment you do. Otherwise: null.
   */
  place(line, craft) {
    const cross = craft.at === null && line.n !== this.riding ? this.#crossing(line, craft.leg, craft.lane) : null;
    if (cross && craft.into > cross.t0 && craft.into < cross.t1) return sailing(cross, craft.into);
    const p = this.#at(line, craft.leg, craft.lane, craft.into);
    if (!p || !p.leap) return p;
    const [a, b, f] = p.leap, ga = this.layout?.get(a[1]), gb = this.layout?.get(b[1]);
    if (!ga || !gb || ga.group !== gb.group) return null;
    const ax = a[2] + ga.at[0], ay = a[3] + ga.at[1], bx = b[2] + gb.at[0], by = b[3] + gb.at[1];
    return { group: ga.group, x: ax + (bx - ax) * f, y: ay + (by - ay) * f, z: a[4] + (b[4] - a[4]) * f, heading: mod((Math.atan2(-(by - ay), bx - ax) * 180) / Math.PI, 360) };
  }

  /**
   * The way a craft is shown across the sea on a leg that goes from one map to another on the
   * same picture, or null for any other leg: where the game has it every half second (the move
   * between the maps drawn out straight), as a row of points with the distance along them.
   */
  #crossing(line, legIndex, lane) {
    const leg = line.legs[legIndex];
    if (leg.cross !== undefined) return leg.cross;
    leg.cross = null;
    const track = leg.track, layout = this.layout;
    if (!layout?.size || (lane === 2 && leg.track2)) return null;
    const k = track.findIndex((p, i) => i > 0 && p[1] !== track[i - 1][1]);
    if (k < 0) return null;
    const ga = layout.get(track[k - 1][1]), gb = layout.get(track[k][1]);
    if (!ga || !gb || ga.group !== gb.group) return null;
    const T = track[track.length - 1][0], n = Math.max(2, Math.ceil(T / CROSS_STEP) + 1);
    const pts = new Float64Array(n * 3), cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.#at(line, legIndex, lane, Math.min(T, i * CROSS_STEP));
      if (!p) return null;
      let x, y, z;
      if (p.leap) {
        const [a, b, f] = p.leap, A = layout.get(a[1]).at, B = layout.get(b[1]).at;
        x = a[2] + A[0] + (b[2] + B[0] - a[2] - A[0]) * f; y = a[3] + A[1] + (b[3] + B[1] - a[3] - A[1]) * f; z = a[4] + (b[4] - a[4]) * f;
      } else { const g = layout.get(p.map)?.at; if (!g) return null; x = p.x + g[0]; y = p.y + g[1]; z = p.z; }
      pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = z;
      if (i) cum[i] = cum[i - 1] + Math.hypot(x - pts[i * 3 - 3], y - pts[i * 3 - 2]);
    }
    // how far along at a moment of the leg, and how fast just then
    const along = (t) => { const u = Math.max(0, Math.min(n - 1, t / CROSS_STEP)), i = Math.min(n - 2, Math.floor(u)); return cum[i] + (cum[i + 1] - cum[i]) * (u - i); };
    const speed = (t) => (along(t + 1) - along(t - 1)) / 2;
    // (as the game has it for the first and last SURE seconds; less where a side is short)
    const t0 = Math.min(SURE, track[k - 1][0] * 0.45), t1 = T - Math.min(SURE, (T - track[k][0]) * 0.45);
    if (!(t1 - t0 > 2)) return null;
    leg.cross = { group: ga.group, t0, t1, l0: along(t0), l1: along(t1), v0: speed(t0), v1: speed(t1), pts, cum, n };
    return leg.cross;
  }

  /**
   * Where the game has a craft `into` seconds after it left a stop: { map, x, y, z, heading } -
   * or, in the moment it is moved from one map to another, { leap: [the moment before, the
   * moment after (as in the leg's track), how far between them (0 to 1)] }.
   */
  #at(line, legIndex, lane, into) {
    const leg = line.legs[legIndex];
    const track = (lane === 2 && leg.track2) || leg.track;
    const tau = Math.min(into, track[track.length - 1][0]);
    for (let i = 1; i < track.length; i++) {
      const a = track[i - 1], b = track[i];
      if (tau > b[0] && i < track.length - 1) continue;
      const f = b[0] > a[0] ? Math.max(0, Math.min(1, (tau - a[0]) / (b[0] - a[0]))) : 1;
      if (a[1] !== b[1]) return { leap: [a, b, f] };
      // on the game's own path, where both moments could be laid onto it: so far along it between the two
      if (a[5] >= 0 && b[5] >= 0 && line.way) {
        const n = line.way.length;
        const u = (a[5] + mod(b[5] - a[5], n) * f) % n;
        const q = pointOn(line.way, u);
        return { map: b[1], x: q[0], y: q[1], z: q[2], heading: mod((Math.atan2(-q[4], q[3]) * 180) / Math.PI, 360) };
      }
      // (which way it points: along the track, and where it has stopped, as it came in)
      let dx = b[2] - a[2], dy = b[3] - a[3];
      for (let j = i - 1; Math.hypot(dx, dy) < 0.5 && j >= 1 && track[j - 1][1] === b[1]; j--) { dx = b[2] - track[j - 1][2]; dy = b[3] - track[j - 1][3]; }
      return { map: b[1], x: a[2] + (b[2] - a[2]) * f, y: a[3] + (b[3] - a[3]) * f, z: a[4] + (b[4] - a[4]) * f, heading: mod((Math.atan2(-dy, dx) * 180) / Math.PI, 360) };
    }
    return null;
  }

  /**
   * Everything of the lines that is on the picture just now, for showing it: { crafts: [{ line,
   * x, y, z, heading, docked, text }], docks: [{ line, x, y, z, text }] }.
   * @param where  the id of the map shown - or, with more than one on the picture, a function
   *               giving where a map's origin lies on it ([x, y]; null for a map not shown)
   */
  onMap(where, clock) {
    const alone = typeof where !== 'function';
    const at = alone ? (m) => (m === where ? ZERO : null) : where;
    const t = this.now();
    const crafts = [], docks = [];
    if (t === null) return { crafts, docks };
    // (a craft out between two maps is placed in the yards of their common picture: where that
    // lies on this one - with one map alone on it, such a craft is on neither)
    const pictureAt = (group) => {
      if (alone) return null;
      for (const [map, g] of this.layout) {
        const o = g.group === group ? at(map) : null;
        if (o) return [o[0] - g.at[0], o[1] - g.at[1]];
      }
      return null;
    };
    for (const line of this.lines) {
      if (!this.live[line.n]) continue;
      const about = this.live[line.n].unsure > 6 ? '~' : '';
      for (const c of this.crafts(line, t)) {
        const p = this.place(line, c);
        const off = !p ? null : p.group !== undefined ? pictureAt(p.group) : at(p.map);
        if (!off) continue;
        const to = line.stops[(c.leg + 1) % line.stops.length].name;
        const text = c.at === null ? `${about}${clock(line.legs[c.leg].trip - c.into)} to ${to}` : `leaves ${line.stops[c.at].name} in ${about}${clock(c.leaves)}`;
        crafts.push({ line, map: p.map ?? null, x: p.x + off[0], y: p.y + off[1], z: p.z, heading: p.heading, docked: c.at !== null, text });
      }
      line.stops.forEach((s, i) => {
        const off = at(s.map);
        if (!off) return;
        const n = this.next(line, i, t);
        if (!n) return;
        const to = line.stops[(i + 1) % line.stops.length].name;
        const lane = n.lane && line.lanes ? `, ${line.lanes[n.lane - 1].name.toLowerCase()}` : '';
        docks.push({ line, stop: i, x: s.x + off[0], y: s.y + off[1], z: line.legs[i].track[0][4], text: n.gets <= t ? `To ${to}: boarding, leaves in ${about}${clock(n.leaves - t)}${lane}` : `To ${to}: in ${about}${clock(n.gets - t)}${lane}` });
      });
    }
    return { crafts, docks };
  }
}
