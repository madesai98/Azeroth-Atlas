// The route, handed to the game: the same route this map draws, seen from above, for the
// AzerothAtlas addon to draw on the game's world map and minimap.
//
// Whenever the route or the waypoint changes, what is shown here is sent to the local server
// (as a flat track: stretches of x, y points), which leaves it where the addon can pick it up
// (server/mail.js explains how something gets into a running game at all).

const TOLERANCE = 0.6;   // yards a point may lie off the line through its neighbours and be left out
const POINT_BUDGET = 1800; // points in one delivery; past that the track is thinned further
const BREAK = 8;         // (route.js) kind bit: this point starts a new stretch
const RIDE = 32;         // (route.js) kind bit: a crossing by boat or zeppelin
const ALSO_TOLERANCE = 4; // yards: the lines that are only shown (on other continents, across the sea) are seen from far off
const ALSO_BUDGET = 1200; // points of them in one delivery
const OTHER_TOLERANCE = 1.5; // yards: the other routes (shown, not followed) are lines on a map
const OTHER_BUDGET = 900;    // points of them in one delivery
const OTHER_EVERY = 4000;    // ms: the other routes change as you move, and are sent on no more often than this
const STACKED = 16;      // (navworker.js) kind bit: another level lies over or under this point
const Z_TOLERANCE = 1;   // yards a point's height may differ from the line through its neighbours and be left out
const THERE = 10;        // yards from the waypoint within which you are at it (as the addon's ARRIVE)...
const LEVEL = 2.5;       // ...when you are also within this of its height

/** What kind of going a piece of route is, as the addon colours it: 0 on foot, 1 swimming, 2 no longer used (it was "through a danger zone"), 3 in the air, 4 carried by a boat or zeppelin. */
const going = (k) => (k & RIDE ? 4 : k & 4 ? 3 : k & 2 ? 2 : k & 1 ? 1 : 0);

/**
 * Which points to keep: those a straight line through their neighbours would not pass within
 * `tol` yards of on the ground (Douglas-Peucker), nor within `ztol` yards of in height - so
 * that a stair in a straight corridor is still a stair. Returns the numbers of the points kept.
 */
function thin(pts, zs, tol, ztol) {
  const n = pts.length / 2;
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a * 2], ay = pts[a * 2 + 1], dx = pts[b * 2] - ax, dy = pts[b * 2 + 1] - ay;
    const len = Math.hypot(dx, dy);
    let worst = -1, far = 1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      const d = len > 0 ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py);
      const t = len > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / (len * len))) : 0;
      const score = Math.max(d / tol, Math.abs(zs[i] - (zs[a] + (zs[b] - zs[a]) * t)) / ztol);
      if (score > far) { far = score; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * A route's line as stretches of one kind of going each, and where each part of the journey
 * ends on it: { stretches: [{ kind, points: [x, y, ...], heights: [z, ...], stack: '0110...' }],
 * ends: [for each of route.legs, the number (from 1) of the last stretch that belongs to it, or 0
 * if none of it is drawn here] }. A new stretch begins wherever a part of the journey ends, so
 * the two always line up.
 *
 * The game tells its addon no height, so the line it follows is flat. heights says how high each
 * point is all the same, and stack marks ('1') the points where another level lies over or under
 * the line: with those the addon can tell the end of a route from the floor below it.
 */
export function trackOf(route, tolerance = TOLERANCE) {
  const p = route.points, kinds = route.kinds, n = kinds.length;
  const legs = route.legs ?? [];
  const cuts = new Set(legs.map((l) => l.end).filter((v) => v !== undefined));
  const raw = [];
  let cur = null;
  for (let i = 0; i + 1 < n; i++) {
    const k = kinds[i + 1];
    if (k & BREAK) { cur = null; continue; } // the next point starts somewhere else
    const kind = going(k);
    if (!cur || cur.kind !== kind || cuts.has(i)) { cur = { kind, points: [p[i * 3], p[i * 3 + 1]], zs: [p[i * 3 + 2]], marks: [kinds[i] & STACKED ? 1 : 0], first: i, last: i }; raw.push(cur); }
    cur.points.push(p[i * 3 + 3], p[i * 3 + 4]);
    cur.zs.push(p[i * 3 + 5]);
    cur.marks.push(k & STACKED ? 1 : 0);
    cur.last = i + 1;
  }
  const ends = legs.map((l) => {
    if (l.end === undefined) return 0;
    let found = 0;
    for (let j = 0; j < raw.length; j++) if (raw[j].last <= l.end) found = j + 1;
    return found;
  });
  let tol = tolerance, out;
  for (;;) {
    // (a flight's curve is long and smooth: it needs far fewer points than a path between trees)
    // (the heights are kept true to a yard or so; only a line far too long for one delivery gives that up)
    const ztol = tol > 6 ? Infinity : Math.min(LEVEL, Math.max(Z_TOLERANCE, tol));
    out = raw.map((s) => {
      const kept = thin(s.points, s.zs, s.kind >= 3 ? tol * 4 : tol, s.kind >= 3 ? Infinity : ztol);
      const round = (v) => Math.round(v * 10) / 10;
      // a point left out hands its mark to the two kept on either side of it
      const stack = kept.map((at, m) => {
        for (let i = m > 0 ? kept[m - 1] + 1 : at; i <= (m + 1 < kept.length ? kept[m + 1] - 1 : at); i++) if (s.marks[i]) return '1';
        return '0';
      }).join('');
      return { kind: s.kind, points: kept.flatMap((i) => [round(s.points[i * 2]), round(s.points[i * 2 + 1])]), heights: kept.map((i) => round(s.zs[i])), stack };
    });
    if (out.reduce((sum, s) => sum + s.points.length / 2, 0) <= POINT_BUDGET || tol > 20) return { stretches: out, ends };
    tol *= 1.6;
  }
}

/**
 * The lines of a journey that are shown but not followed: its parts on other maps, and its
 * crossings by boat and zeppelin. [{ map, kind, points: [x, y, ...], joins }], thinned for a map
 * seen from far off, and further if there is a great deal of it. (joins: it goes on from the
 * line before it, over the sea between two maps.)
 */
export function alsoOf(route) {
  const pieces = (route.also ?? []).map((q) => ({ map: q.map, joins: !!q.joins, points: q.points, kinds: typeof q.kinds === 'number' ? new Uint8Array(q.points.length / 3).fill(q.kinds) : q.kinds }));
  for (let tol = ALSO_TOLERANCE; ; tol *= 1.6) {
    const out = [];
    for (const q of pieces) trackOf({ points: q.points, kinds: q.kinds, legs: [] }, tol).stretches.forEach((s, k) => out.push({ map: q.map, kind: s.kind, points: s.points, joins: q.joins && k === 0 }));
    if (out.reduce((sum, s) => sum + s.points.length / 2, 0) <= ALSO_BUDGET || tol > 60) return out;
  }
}

/** A route's line as stretches of one kind of going each: [{ kind, points: [x, y, ...] }]. */
export function stretchesOf(route, tolerance = TOLERANCE) { return trackOf(route, tolerance).stretches; }

const mmss = (s) => { const t = Math.max(0, Math.round(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

/**
 * The journey as a list of things to do, in the game's words: [{ text, seconds, note, stretch }]
 * ("Walk to Sentinel Hill's flight master", "Fly to Stormwind", "Walk to your map pin").
 * @param ends  from trackOf: where each part ends on the line
 * @param goal  what the waypoint is called ("your map pin")
 */
export function stepsOf(route, ends, goal) {
  return (route.legs ?? []).map((l, i) => {
    const through = (name) => (/^Portal/.test(name) ? `Portal to ${name.replace(/^Portal to /, '')}` : `Go through to ${name.replace(/^Passage to /, '')}`);
    const text = l.mode === 'walk' ? `Walk to ${l.to ?? goal}`
      : l.mode === 'fly' ? `Fly to ${l.to}`
      : l.mode === 'boat' ? `Boat to ${l.to}`
      : l.mode === 'zeppelin' ? `Zeppelin to ${l.to}`
      : l.mode === 'tram' ? 'Ride the tram'
      : l.mode === 'door' ? through(l.name ?? '')
      : 'Use your hearthstone';
    // (a boat or tram that has been timed leaves at a known moment; the addon counts down to it
    // itself from then on: line and stop say which, ride how long the crossing takes)
    const note = !(l.wait > 0) ? '' : l.mode === 'hearth' ? `ready in ${mmss(l.wait)}` : `leaves in ${l.known ? '' : 'about '}${mmss(l.wait)}`;
    const step = { text, seconds: Math.round(l.seconds ?? 0), note, stretch: ends[i] ?? 0 };
    if (l.line) { step.line = l.line; step.stop = l.stop; step.ride = Math.round(l.ride ?? 0); }
    return step;
  });
}

/**
 * The other routes there are just now - to your guide's step while a waypoint of yours leads,
 * to the quest you track, to your party - for the game to draw beside the one it follows:
 * [{ kind, color: '#rrggbb', pieces: [{ map, kind, points: [x, y, ...] }] }], thinned to fit.
 */
export function othersOf(app) {
  const routes = (app.trips?.active() ?? []).filter((x) => !x.lead && x.planner.route);
  for (let tol = OTHER_TOLERANCE; ; tol *= 1.6) {
    const out = routes.map((x) => {
      const r = x.planner.route, pieces = [];
      for (const s of trackOf(r, tol).stretches) pieces.push({ map: x.planner.mapId ?? 0, kind: s.kind, points: s.points });
      for (const a of alsoOf(r)) pieces.push({ map: a.map, kind: a.kind, points: a.points });
      return { kind: x.kind, color: x.color, pieces };
    });
    if (out.reduce((sum, o) => sum + o.pieces.reduce((n, p) => n + p.points.length / 2, 0), 0) <= OTHER_BUDGET || tol > 40) return out;
  }
}

export class InGameRoute {
  constructor(app) {
    this.app = app;
    this.others = '';     // which other routes were last sent on, and when
    this.othersAt = 0;
    this.plan = 0;        // goes up with every new route (not as you walk along one)
    this.seen = null;
    this.sig = '';
    this.timer = 0;
    this.status = null;   // what the server last said of the route's way into the game
  }

  /**
   * What this map, which follows how high you are, knows and the game cannot: whether you are at
   * the waypoint (at its spot and on its level - not on the floor below it), whether you are on
   * the route shown, and where the route ends. { there, sure, end: [x, y] }
   */
  #where(t) {
    const r = this.app.route;
    if (!t || !r?.enabled) return {};
    const to = t.go ?? [t.x, t.y, t.z ?? null], me = r.me;
    const there = !!me && t.map === r.mapId && Math.hypot(me[0] - to[0], me[1] - to[1]) <= THERE
      && (to[2] === null || to[2] === undefined || !Number.isFinite(me[2]) || Math.abs(me[2] - to[2]) <= LEVEL);
    return { there, sure: !!r.onRoute, end: [to[0], to[1]], endMap: t.map };
  }

  /** What this map shows now, as the server wants it. */
  #payload() {
    const app = this.app, r = app.route, t = app.routeTarget ?? null;
    const target = t ? { map: t.map, x: t.x, y: t.y, source: t.source ?? 'marker', name: t.name ?? null } : null;
    // (marker: the marker dropped on this map, for the game to take up as its waypoint - or word
    // that it has been taken off: main.js. It goes with whatever else is said.)
    const base = { target, plan: this.plan, map: r.mapId ?? 0, text: '', state: 'none', detached: false, stretches: [], marker: app.markerForGame ?? null, ...this.#where(t) };
    if (!r.enabled) return { ...base, text: 'Routes are switched off on the 3D map.' };
    if (!t) return { ...base, text: 'No waypoint.' };
    // (which level of the spot the waypoint is on comes first: a route to another level is not the route)
    if (app.levels?.busy()) return { ...base, state: 'pending' };
    // (the route shown is the one to this waypoint, on the level chosen: see levels.js for `go`)
    const to = r.route?.target, want = t.go ?? [t.x, t.y, t.z ?? null];
    // (...and not a first answer shown while quicker ways are still being looked for - route.js:
    // the game fetches a route once and keeps it, so it is told to wait for the one that stands)
    if (r.route && !r.route.provisional && to && Math.hypot(to[0] - want[0], to[1] - want[1]) <= 2 && Math.abs((to[2] ?? -1e6) - (want[2] ?? -1e6)) <= 1) {
      const goal = t.name ?? (t.source === 'guide' ? "your guide's step" : t.source === 'pin' ? 'your map pin' : t.source === 'marker' ? 'the marker' : 'your waypoint');
      const track = trackOf(r.route);
      const out = {
        ...base, state: 'route', text: app.routeText ?? '', detached: !!r.route.detached, stretches: track.stretches,
        // the rest of the journey, for the game's world map: its lines on other continents and across the sea
        also: alsoOf(r.route),
        // the colour this route has here, and the other routes there are, each in its own: drawn in the game as they are here
        color: app.trips?.color(app.trips.leadKind) ?? null, others: othersOf(app),
        // the same journey as a list of things to do, for the arrow and the step list in the game
        title: `Journey to ${t.name ?? app.placeAt?.(t) ?? goal}`, seconds: Math.round(app.route.remaining()?.seconds ?? r.route.seconds ?? 0),
        steps: stepsOf(r.route, track.ends, goal),
      };
      // the levels there are to choose between at this spot (ask: the game should put the question)
      const lv = app.levels?.choices;
      if (lv) out.levels = { id: lv.id, at: lv.choice + 1, ask: !!lv.prompt && t.source === 'pin', list: app.levels.describe().map((d) => d.label) };
      return out;
    }
    const a = r.asked;
    const asked = a && a.toMap === t.map && Math.hypot(a.to[0] - want[0], a.to[1] - want[1]) <= 2;
    // (asked and answered, journey included, with nothing found: there is no way; anything else is still being worked out)
    if (asked && a.done && a.settled && !r.route) return { ...base, text: r.status ? `No route: ${r.status}` : 'No route found.' };
    if (!a && r.status) return { ...base, text: `No route: ${r.status}` };
    return { ...base, state: 'pending' };
  }

  /** Called every frame: sends the route on when something about it has changed. */
  update() {
    const app = this.app, r = app.route;
    if (!r) return;
    if (r.route !== this.seen) { this.seen = r.route; this.plan = (this.plan % 60000) + 1; }
    const t = app.routeTarget;
    const a = r.asked;
    const w = this.#where(t);
    // (the other routes: which there are, in what colour, and how each stands - looked at now and then, as they change with every step you take)
    const now = performance.now();
    const others = (app.trips?.active() ?? []).filter((x) => !x.lead).map((x) => `${x.slot}${x.color}${x.planner.route ? x.planner.rev : '-'}`).join(',');
    const which = others.replace(/\d+(,|$)/g, '$1');
    if (which !== this.othersWhich || now - this.othersAt > OTHER_EVERY) { this.others = others; this.othersWhich = which; this.othersAt = now; }
    const m = app.markerForGame;
    const sig = `${this.plan}|${r.enabled}|${t ? `${t.map},${t.x},${t.y},${t.z ?? ''},${t.source},${t.name ?? ''}` : '-'}|${a ? `${a.id},${+!!a.done},${+!!a.settled}` : '-'}|${r.status}|${app.levels?.rev ?? 0}|${+!!w.there}${+!!w.sure}|${this.others}|${app.trips?.color(app.trips.leadKind) ?? ''}|${m ? `${m.stamp}${m.off ? 'x' : ''}` : ''}`;
    if (sig === this.sig) return;
    this.sig = sig;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#send(), 60);
  }

  async #send() {
    try {
      const res = await fetch('/api/ingame/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.#payload()) });
      if (res.ok) { this.status = await res.json(); this.app.onInGame?.(); }
    } catch { /* the server is gone: the page says so elsewhere */ }
  }

  /** A line for the panel about the route in the game ('' when there is nothing worth saying). */
  describe(live) {
    const m = live ?? this.status;
    if (!m) return '';
    if (!m.installed) return 'In the game: the route is not shown there yet. Press Update addon, then restart the game.';
    if (m.error) return `In the game: could not write the route (${m.error}).`;
    if (m.seen === null) return 'In the game: update the addon (Update addon, then /reload) to see the route there too.';
    if (m.seen === 0) return 'In the game: restart the game once, so that it finds the route mailboxes.';
    if (m.left === 0) return 'In the game: type /reload to go on seeing the route (its deliveries for this login are used up).';
    if (m.stale) return 'In the game: the game is reading old copies of the route files, so the route cannot be shown there (it seems to read them only when it starts).';
    // (taken away here, and the game still has it: it cannot be told unasked)
    if (this.app.markerForGame?.off) return 'In the game: your waypoint is still there until the game next asks for its route. Type /atlas route in the game to clear it there now.';
    const left = m.left < 40 ? ` ${m.left} deliveries left before a /reload is needed.` : '';
    if (m.showing && m.read) return `In the game: showing this route.${left}`;
    if (m.showing) return `In the game: showing the route it last fetched.${left}`;
    if (m.waiting) return `In the game: fetching the route.${left}`;
    return m.state === 'route' ? `In the game: ready (shown when your waypoint changes, or /atlas route).${left}` : '';
  }
}
