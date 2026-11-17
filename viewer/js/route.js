// The route to where you are heading: asks the route worker (navworker.js) for the way over
// the map's walkable ground, keeps it current as you move, and draws it in the world.
import { note, changed } from './log.js';
import { GLOBALS_WGSL, targets, depthState, ALPHA_BLEND } from './gpu.js';
import { wayOf, nearestOn } from './transit.js';

const REPLAN_OFF = 10;      // yards off the route before a new one is worked out
const REPLAN_EVERY = 20000; // ms: refresh while travelling even if nothing seems to have changed
const REPLAN_GAP = 2500;    // ms: never search more often than this
const SETTLE_FOR = 20000;   // ms: a journey being worked out is given this long before a question from where you are by then takes its place
const LEVEL_WEIGH = 4;      // a yard above or below the route counts as this many beside it: a floor up or down is off it
const LIFT = 0.7;           // yards the line floats above the ground
const FLIGHT_SPEED = 30.4;  // yards per second on a flight path, until one of yours has been timed (see #timeFlight)
const SPEED_OVER = 20;      // seconds of one flight path a flight's speed is measured over, at least
const SPEED_SKIP = 150;     // yards at the start of a flight path left out of that (taking off)
const TAKE_OFF = 4;         // seconds lost talking to a flight master and taking off
const HEARTH_CAST = 10;     // seconds to use a hearthstone
const WORTH = 0.9;          // another way has to be this much quicker than walking to be offered
const HEARTH_WORTH = 90;    // seconds a hearthstone must save to be worth its cooldown
const CHANGE_WORTH = 60;    // seconds each thing a journey takes after its first (the tram to get to a flight) must save to be worth the change
const RIDES = new Set(['board', 'boat', 'zeppelin', 'tram', 'hearth']); // what counts as one: getting on a flight (however many hops), a boat, a zeppelin, the tram; your hearthstone
const HOSTILE_REACH = 1000; // yards: a flight master within this says whose town a dock or doorway is in
const TRUST = 150;          // yards: a walk this short on a map with no walking data (the tram's platform) is taken on trust
const ROUGH = 3;            // a walk too long to work out is counted at this many times the straight line (it was looked for and not found within reach: it is no short way round)
const GAP = 60;             // yards: drawn stretches further apart than this are not joined by a line
const BREAK = 8;            // kind bit: this point starts a new stretch (no line from the one before)
const RIDE = 32;            // kind bit: this piece is a crossing by boat or zeppelin (you are carried along it)
const REMEMBER = 300;       // walks already worked out that are kept (the far legs of a journey do not change as you move)
const FAIL_CELL = 32;       // yards: a long search that found no way is not repeated from within this far of where it began...
const FAIL_FOR = 60000;     // ms: ...for this long
const FAIL_COST = 200000;   // floors a failed search looked at before it counts as a long one
const SPEED_KEY = 'wfmap.flightSpeed';
const whole = (v) => (Number.isFinite(v) ? Math.round(v) : null);

export class RoutePlanner {
  /**
   * @param shared  another planner, whose route worker this one is to ask as well (and whose
   *                worked-out walks and measured flight speed it shares): there is a route to
   *                each place you could be heading for (trips.js), and one worker for them all
   */
  constructor(app, shared = null) {
    this.app = app;
    this.hub = shared?.hub ?? null;
    if (!this.hub) {
      // walks: the walks already worked out, most recently used last (see #walk); flightSpeed: yards a second on a flight path
      const hub = (this.hub = { worker: new Worker(new URL('./navworker.js', import.meta.url), { type: 'module' }), waiters: new Map(), walks: new Map(), seq: 0, flightSpeed: FLIGHT_SPEED });
      hub.worker.onmessage = (e) => { const done = hub.waiters.get(e.data.id); if (done) { hub.waiters.delete(e.data.id); done(e.data); } };
      try {
        const v = +localStorage.getItem(SPEED_KEY);
        if (v > 20 && v < 60) hub.flightSpeed = v;
        // (nothing measured this way yet: what the map measured before, more roughly, is still
        // enough to tell flights with the Frequent Flier talent from flights without)
        else if (+localStorage.getItem('wfmap.taxiSpeed') >= FLIGHT_SPEED * 1.04) hub.flightSpeed = FLIGHT_SPEED * 1.2;
      } catch { /* use the default */ }
    }
    this.own = !shared;      // (the one that times your flights: the others go by what it finds)
    this.label = shared ? 'another' : 'lead'; // which route this is, in the page's notes (log.js): the one that leads, or - trips.js - quest, waypoint, death, ally1...
    this.walkOnly = false;   // on foot all the way (the run back to your body: a ghost takes no flight)
    this.fixed = false;      // from a place, not from you (a quest's route, plotted): nothing is carrying it, and it uses no hearthstone
    this.enabled = true;
    this.route = null;     // { points, kinds, length, seconds, target, cum } or null
    this.status = '';      // why there is no route, for the panel
    this.rev = 0;          // changes whenever the drawn route does
    this.off = Infinity;   // yards you are off the route shown (height counted: see #progress)
    this.me = null;        // where you are, as last told
    this.asked = null;     // what the search in flight (or last finished) was for
    this.mapId = null;
    this.onChange = () => {};
    this.flying = null;    // the stretch of a flight path being timed (see #timeFlight)
    this.flightPlan = null; // on a flight the route had you take: { paths, dest } (see #flight)
    this.infos = new Map(); // what the worker needs to search each map (see #mapInfo)
    this.info = null;
  }

  /** Yards a second on a flight path: measured as you fly (see #timeFlight), and the same for every route. */
  get flightSpeed() { return this.hub.flightSpeed; }
  set flightSpeed(v) { this.hub.flightSpeed = v; }
  get walks() { return this.hub.walks; }

  /** Tell the worker which map the searches are on. */
  setMap(map) {
    this.mapId = map.id;
    this.navigable = !!map.nav;
    this.info = map.nav ? { map: map.id, rev: map.nav.rev, tiles: map.tiles.map((t) => `${t[0]}_${t[1]}`) } : null;
    this.infos.set(map.id, this.info);
    this.#clear('');
  }

  #clear(status) {
    if (this.route || this.status !== status) { this.route = null; this.status = status; this.rev++; this.onChange(); this.asked = null; changed(`to.${this.label}`, null); this.#said(); }
    this.asked = null;
  }

  /** Noted (log.js) when the way is another than the one before: not for every yard walked along the same one. */
  #said() {
    const r = this.route, a = this.asked;
    const legs = (r?.legs ?? []).map((l) => `${l.mode}${l.from && l.mode !== 'walk' ? ` ${l.from} >` : ''}${l.to ? ` ${l.to}` : ''}${l.name ? ` ${l.name}` : ''}`);
    // (someone in your party is somewhere new with every look: the way to them is noted when its kind changes)
    const to = a && !/^ally/.test(this.label) ? [a.toMap, whole(a.to[0]), whole(a.to[1]), whole(a.to[2])] : null;
    if (!changed(`way.${this.label}`, { to, way: r ? legs : null, none: r ? null : this.status || '-', first: !!r?.provisional })) return;
    const more = { to, from: a ? a.from.map(whole) : null, onMap: a?.map, hearthstoneLeadsNobodyKnowsWhere: this.noBind || undefined };
    if (r) note('route', `${this.label}: ${r.provisional ? 'a first answer, on foot (quicker ways are still looked for)' : legs.length > 1 ? legs.join(', then ') : 'on foot'}`, { ...more, seconds: whole(r.seconds), yards: whole(r.length), onFootAllTheWay: whole(r.walking) ?? undefined, detached: r.detached || undefined, tookMs: a ? whole(performance.now() - a.time) : null });
    else note('route', `${this.label}: ${a ? `no way${this.status ? ` (${this.status})` : ''}` : `heading nowhere${this.status ? ` (${this.status})` : ''}`}`, more);
  }

  /** One search, for callers that want the answer itself (tests, the travel planner). */
  plan(from, to, opts = {}) {
    return new Promise((resolve) => {
      const id = ++this.hub.seq;
      this.hub.waiters.set(id, resolve);
      this.hub.worker.postMessage({ type: 'route', id, from, to, run: opts.run, swim: opts.swim, nav: opts.nav ?? this.info, landFrom: !!opts.landFrom, landTo: !!opts.landTo, levels: !!opts.levels });
    });
  }

  /**
   * The levels there are at a spot that can be walked to from `from`, highest first:
   * { ok, levels: [{ x, y, z, seconds, terrain, swim, buried }] } (see navworker.js).
   * @param info what the worker needs to search that map (this.info, or infoFor(map))
   */
  levels(info, from, to, opts = {}) {
    if (!info) return Promise.resolve({ ok: false, levels: [], reason: 'no walking data for this map' });
    return this.plan(from, [to[0], to[1], null], { run: this.speeds?.run, swim: this.speeds?.swim, ...opts, nav: info, levels: true });
  }

  /** What the worker needs to search a map (null if it has no walking data). */
  infoFor(map) { return this.#mapInfo(map); }

  /**
   * One walk, remembered. Searching is quick when there is a way and slow when there is none (it
   * looks everywhere first), so what was found is kept: the same walk is asked for again every
   * time the journey is re-planned, and one that could not be found is not looked for again
   * from the same neighbourhood for a while.
   */
  async #walk(info, from, to, opts) {
    if (!info) return { ok: false, reason: 'no walking data for this map' };
    const q = (v, step = 1) => (v === null || v === undefined ? 'n' : Math.round(v / step));
    const tail = `${q(to[0])},${q(to[1])},${q(to[2])},${+!!opts.landFrom}${+!!opts.landTo},${Math.round((opts.run ?? 7) * 10)},${Math.round((opts.swim ?? 0) * 10)}`;
    const key = `${info.map},${info.rev},${q(from[0])},${q(from[1])},${q(from[2])},${tail}`;
    const near = `!${info.map},${info.rev},${q(from[0], FAIL_CELL)},${q(from[1], FAIL_CELL)},${tail}`;
    const now = performance.now();
    const failed = this.walks.get(near);
    if (failed && now - failed.at < FAIL_FOR) return failed.result;
    const kept = this.walks.get(key);
    if (kept) { this.walks.delete(key); this.walks.set(key, kept); return kept.result; }
    const result = await this.plan(from, to, { ...opts, nav: info });
    this.walks.set(key, { result, at: now });
    if (!result.ok && result.expanded > FAIL_COST) this.walks.set(near, { result, at: now });
    while (this.walks.size > REMEMBER) this.walks.delete(this.walks.keys().next().value);
    return result;
  }

  /** The walking search for a question has answered (m.ok false: there is no walking it). */
  #answer(asked, m) {
    if (this.asked !== asked) return; // overtaken by a newer question
    asked.done = true;
    const planned = (this.route?.legs?.length ?? 0) > 1; // a journey by other means is showing
    const elsewhere = asked.map !== asked.toMap;
    let direct = null;
    if (!m.ok) { if (!planned) this.route = null; this.status = elsewhere ? '' : m.reason; }
    else {
      const n = m.points.length / 3, cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(m.points[i * 3] - m.points[i * 3 - 3], m.points[i * 3 + 1] - m.points[i * 3 - 2], m.points[i * 3 + 2] - m.points[i * 3 - 1]);
      direct = {
        points: m.points, kinds: m.kinds, length: m.length, seconds: m.seconds, cum, time: this.#times(m.points, m.kinds), target: asked.to, at: 0, ms: m.ms, expanded: m.expanded,
        // (end: the last point of the line that belongs to this part; lastWalk: where the walk to the waypoint itself begins)
        legs: [{ mode: 'walk', yards: m.length, seconds: m.seconds, end: n - 1 }], lastWalk: { map: asked.map, from: asked.from, land: false },
      };
      if (!planned) {
        // Shown at once, while quicker ways than walking are still being looked for: a first
        // answer, not yet the answer. The game is not handed it (ingame.js): its addon fetches a
        // route once and keeps it, and would have you walk and swim to where you could fly. (Not
        // so where the route to this very waypoint was showing already: that has been looked into.)
        const was = this.route;
        direct.provisional = !(was && !was.provisional && was.target && Math.hypot(was.target[0] - asked.to[0], was.target[1] - asked.to[1]) <= 2 && Math.abs((was.target[2] ?? -1e6) - (asked.to[2] ?? -1e6)) <= 1);
        this.route = direct;
      }
      this.status = '';
    }
    this.rev++;
    this.onChange();
    this.#said();
    (this.walkOnly ? Promise.resolve(false) : this.#journey(asked, m)).catch((err) => { console.warn('travel planning failed', err); return false; }).then((adopted) => {
      asked.settled = true;
      // (looked into now - unless a newer question took over before that was done)
      if (direct && this.asked === asked) direct.provisional = false;
      if (adopted || this.asked !== asked || (m.ok && !planned)) return;
      // nothing quicker than walking after all: show the walking route, or say that there is no way
      this.route = direct;
      if (!direct) {
        const there = this.app.manifest.maps.find((x) => x.id === asked.toMap)?.name ?? 'another map';
        this.status = !elsewhere ? m.reason : this.app.player?.height?.ride ? `your waypoint is in ${there}: the way there is worked out when you land` : `no way found to your waypoint in ${there}`;
      }
      this.rev++;
      this.onChange();
    }).then(() => { if (this.asked === asked) this.#said(); });
  }

  /**
   * The flight path you are on, for the route: { path (the flight path's number), paths (that
   * one, and the ones the flight goes on along), dest (the flight point it comes down at), speed
   * (what flights are counted at just now) } - or null when you are on none the map can place. The game does not say where a flight is
   * going. If the route in hand has this flight in it (you took the flight it told you to), it
   * goes where that says. Any other flight is taken to come down at the end of the path it is
   * on: should it fly on from there, the route is worked out again, from the end of that path.
   */
  #flight(ride) {
    if (!ride?.flight) this.flightPlan = null;
    if (!ride?.flight || ride.lost || !ride.path || !Number.isFinite(ride.along)) return null;
    const id = ride.path.id;
    // (where the flight goes is kept while you are in the air: the route in hand may for a moment
    // be one worked out from a path you were wrongly taken to be on)
    const leg = (this.route?.legs ?? []).find((l) => l.mode === 'fly' && l.paths?.includes(id));
    if (leg && !(this.flightPlan?.paths.includes(id))) this.flightPlan = { paths: leg.paths, dest: leg.dest };
    const plan = this.flightPlan?.paths.includes(id) ? this.flightPlan : null;
    const paths = plan ? plan.paths.slice(plan.paths.indexOf(id)) : [id];
    const dest = plan ? plan.dest : ride.path.to;
    return { path: id, paths, dest, speed: this.flightSpeed };
  }

  /**
   * The flight paths the journey in hand flies along - the flight you are on, or the first one
   * the route has you take - or null. For telling which of several paths that run together
   * you are on (height.js).
   */
  get flightPaths() {
    return this.flightPlan?.paths ?? this.route?.legs?.find((l) => l.mode === 'fly' && l.paths?.length)?.paths ?? null;
  }

  /**
   * A question asked on a flight path: there is no walking from the air, so it goes straight to
   * the journey (#journey), which begins with what is left of the flight.
   */
  #aloft(asked) {
    asked.done = true;
    this.#journey(asked, { ok: false }).catch((err) => { console.warn('travel planning failed', err); return false; }).then((adopted) => {
      asked.settled = true;
      if (adopted || this.asked !== asked) return;
      this.route = null;
      this.status = 'no way found from where your flight lands';
      this.rev++;
      this.onChange();
    }).then(() => { if (this.asked === asked) this.#said(); });
  }

  /** Seconds from the start to each point of a route (walking, swimming and flying at their speeds). */
  #times(points, kinds) {
    const run = this.speeds?.run || 7, swim = this.speeds?.swim || run * 0.67;
    const t = new Float32Array(points.length / 3);
    for (let i = 1; i < t.length; i++) {
      const d = Math.hypot(points[i * 3] - points[i * 3 - 3], points[i * 3 + 1] - points[i * 3 - 2], points[i * 3 + 2] - points[i * 3 - 1]);
      t[i] = t[i - 1] + d / (kinds[i] & 4 ? this.flightSpeed : kinds[i] & 1 ? swim : run);
    }
    return t;
  }

  /** What the route worker needs to search a map: { map, rev, tiles } (null if it has no walking data). */
  async #mapInfo(id) {
    if (this.infos.has(id)) return this.infos.get(id);
    let info = null;
    try {
      const entry = this.app.manifest.maps.find((m) => m.id === id);
      if (entry) {
        const map = await (await fetch(`/data/maps/${id}/map.json?v=${entry.rev}`)).json();
        if (map.nav) info = { map: id, rev: map.nav.rev, tiles: map.tiles.map((t) => `${t[0]}_${t[1]}`) };
      }
    } catch { /* treated as a map with no walking data */ }
    this.infos.set(id, info);
    return info;
  }

  /** Where your hearthstone takes you: { map, pos } or null if that is not known. */
  #bind(hearth) {
    if (hearth.x !== null && hearth.map !== null) return { map: hearth.map, pos: [hearth.x, hearth.y, null] };
    if (!hearth.name) return null;
    // The game only gives the name of the place ("Deepwater Tavern", "Darkshire", "Valanaar"): the
    // zone that place is in, then the inn of that zone whose keeper is not on the other side. With
    // more than one such inn, the one whose keeper stands in the place of that name (the game's own
    // area under their feet), else the one beside a flight master or a landmark of that name; if
    // that does not settle it, it is not known (until you set your hearthstone again, when the
    // addon notes the very spot).
    const W = this.app.world, areas = W.areas, side = this.app.danger?.settings.faction === 'horde' ? 'h' : 'a';
    const key = `${hearth.name}|${side}`;
    if (this.bound?.key === key) return this.bound.at;
    const want = hearth.name.toLowerCase();
    // The area an innkeeper stands in: said by the map data (inns built since it was), else looked
    // up on the map itself where that map is open here. undefined: not to be had just now.
    const areaOf = (i) => {
      if (i.area > 0) return i.area;
      const scene = this.app.open?.get(i.map)?.scene;
      return scene?.areas ? scene.areaAt(i.pos[0], i.pos[1]) : undefined;
    };
    const within = (area, id) => { for (let n = 0; n < 6 && area; n++) { if (area === id) return true; area = areas[area]?.p; } return false; };
    let at = null, found = 0, unsure = false;
    for (const id of Object.keys(areas)) {
      if ((areas[id].n ?? '').toLowerCase() !== want) continue;
      let zone = +id;
      for (let n = 0; n < 6 && areas[zone].p && areas[areas[zone].p]; n++) zone = areas[zone].p;
      const inns = [];
      for (const i of W.inns ?? []) {
        if (i.map !== areas[id].m || i.zone !== zone || i[side] >= 2) continue;
        // (two keepers in one building are one inn)
        if (!inns.some((o) => Math.hypot(o.pos[0] - i.pos[0], o.pos[1] - i.pos[1]) < 80)) inns.push(i);
      }
      let inn = inns.length === 1 ? inns[0] : null;
      if (inns.length > 1) {
        const stood = inns.map(areaOf);
        const inside = inns.filter((i, k) => stood[k] !== undefined && within(stood[k], +id));
        if (inside.length === 1) inn = inside[0];
        else {
          if (stood.includes(undefined)) unsure = true;
          const spot = [...(W.pois ?? []), ...W.taxiNodes].find((p) => p.map === areas[id].m && (p.name ?? '').split(',')[0].toLowerCase() === want);
          const near = spot && inns.map((i) => [Math.hypot(i.pos[0] - spot.pos[0], i.pos[1] - spot.pos[1]), i]).sort((p, q) => p[0] - q[0])[0];
          if (near && near[0] < 400) inn = near[1];
        }
      }
      if (inn) { found++; at = { map: inn.map, pos: [inn.pos[0], inn.pos[1], null] }; }
    }
    if (found !== 1) at = null; // (the same name on two maps, each with an inn: not known which)
    // (not known only for want of a map that is not open here: asked again next time, when it may be)
    this.bound = at || !unsure ? { key, at } : null;
    return at;
  }

  /**
   * A name for where a boat or zeppelin stops ("Menethil Harbor"): the town whose flight master
   * is beside it, else the nearest named place, else the map it is on.
   */
  #place(map, pos) {
    const W = this.app.world;
    const nearest = (list, reach, ok, name) => {
      let best = null, bestD = reach;
      for (const n of list) {
        if (n.map !== map || !n.pos || (!n.pos[0] && !n.pos[1]) || !ok(n)) continue;
        const d = Math.hypot(n.pos[0] - pos[0], n.pos[1] - pos[1]);
        if (d < bestD) { bestD = d; best = name(n); }
      }
      return best;
    };
    const town = (n) => n.name.split(',')[0];
    return nearest(W.taxiNodes, 600, (n) => n.flags & 3, town)
      ?? nearest(W.pois ?? [], 600, (p) => !!p.name, (p) => p.name)
      ?? nearest(W.taxiNodes, HOSTILE_REACH, (n) => n.flags & 3, town)
      ?? nearest(W.taxiNodes, 600, (n) => !/^(Transport|Quest|Generic)/.test(n.name), town)
      ?? this.app.manifest.maps.find((m) => m.id === map)?.name ?? 'another map';
  }

  /**
   * True if a place belongs to the other side (a zeppelin tower in Orgrimmar, for the Alliance):
   * the flight masters there serve only them. Nothing nearby that says either way: not hostile.
   */
  #hostile(map, pos) {
    const mine = this.app.danger?.settings.faction === 'horde' ? 2 : 1;
    let nearest = HOSTILE_REACH;
    const near = [];
    for (const n of this.app.world.taxiNodes) {
      if (n.map !== map || !(n.flags & 3) || (!n.pos[0] && !n.pos[1])) continue;
      const d = Math.hypot(n.pos[0] - pos[0], n.pos[1] - pos[1]);
      if (d >= HOSTILE_REACH) continue;
      near.push([d, n.flags]);
      if (d < nearest) nearest = d;
    }
    // (a neutral town has a flight master for each side, a few steps apart)
    return near.length > 0 && !near.some(([d, flags]) => d < nearest + 200 && flags & mine);
  }

  /**
   * The quickest journey there by any means: on foot, flying between flight points you know,
   * boats and zeppelins, the doorways between maps (the tram, portals) and your hearthstone.
   * Everything you can travel between is a stop in a network; the quickest chain through it is
   * found by estimate first, then the walks it uses are worked out exactly (over the real
   * ground of whichever map they are on) and the chain is looked for again, until it holds.
   * @param direct  the plain walking route's search result ({ ok: false } if there is none)
   * @returns true if a journey quicker than walking was found and is now the route
   */
  async #journey(asked, direct) {
    const P = this.app.player, T = P?.travel ?? null, W = this.app.world, routes = this.app.routes;
    // Carried by a boat, a zeppelin or the tram: the way on is worked out when it has put you
    // down. On a flight path it is known where that will be (asked.flight: see #flight), and the
    // journey begins with what is left of the flight.
    const ride = P?.height?.ride ?? null, fl = asked.flight ?? null;
    if (!routes || (ride && !fl) || (fl && !(ride?.flight && ride.path?.id === fl.path))) return false;
    const run = this.speeds?.run || 7, slack = 1.3;
    const nodes = [], edges = [];
    const add = (n) => { n.i = nodes.length; nodes.push(n); edges.push([]); return n; };
    const link = (a, b, e) => edges[a.i].push({ from: a.i, to: b.i, ...e });
    const S = add({ kind: 'start', map: asked.map, pos: asked.from }), G = add({ kind: 'goal', map: asked.toMap, pos: asked.to });
    // flight points you know: a place on the ground, and the same place "in the air" (so the time
    // to talk to the flight master is paid once, however many hops the flight has)
    const known = new Set(T?.flights ?? []), air = new Map(), ground = new Map();
    for (const n of W.taxiNodes) {
      if (!known.has(n.id) || (!n.pos[0] && !n.pos[1])) continue;
      const name = n.name.split(',')[0];
      const g = add({ kind: 'flight', map: n.map, pos: n.pos, name, id: n.id }), a = add({ kind: 'air', map: n.map, pos: n.pos, name, id: n.id });
      air.set(n.id, a);
      ground.set(n.id, g);
      link(g, a, { seconds: TAKE_OFF, mode: 'board' });
      link(a, g, { seconds: 0, mode: 'land' });
    }
    for (const p of W.taxiPaths) {
      if (!air.has(p.from) || !air.has(p.to) || p.pointMaps) continue;
      const c = routes.curve(p.map, p.id);
      if (c) link(air.get(p.from), air.get(p.to), { seconds: c.length / this.flightSpeed, mode: 'fly', path: p.id, map: p.map });
    }
    // On a flight path: what is left of the flight is the first thing the journey takes - to
    // the end of the path you are on, and along the ones the flight goes on by - and everything
    // else begins where it comes down. Nothing can be done from the air.
    if (fl) {
      const node = W.taxiNodes.find((n) => n.id === fl.dest);
      if (!node || (!node.pos[0] && !node.pos[1])) return false;
      const landing = ground.get(fl.dest) ?? add({ kind: 'flight', map: node.map, pos: node.pos, name: node.name.split(',')[0], id: node.id });
      const pieces = [];
      let yards = 0;
      fl.paths.forEach((id, k) => {
        const p = W.taxiPaths.find((q) => q.id === id), c = p ? routes.curve(p.map, id) : null;
        if (!c) return;
        const from = k === 0 ? Math.min(Math.max(0, ride.along), c.length) : 0;
        pieces.push({ map: p.map, points: c.points, from });
        yards += c.length - from;
      });
      if (!pieces.length) return false;
      link(S, landing, { seconds: yards / this.flightSpeed, mode: 'flight', pieces });
    }
    // boats and zeppelins: from each place they stop to the next. A line that has been timed
    // (transit.js) is taken at the moment its craft really leaves, for when you would get to
    // its dock; one that has not, at its measured trip and half a round's wait, on average.
    const transit = this.app.transit ?? null, serverNow = transit?.now() ?? null;
    const when = (t) => (serverNow === null ? null : serverNow + t);
    for (const line of W.transports ?? []) {
      if (transit?.retired.has(line.id)) continue;                        // the game's tables still have it; it no longer sails
      if (line.stops.some((s) => this.#hostile(s.map, s.pos))) continue; // the other side's
      const stops = line.stops.map((s) => add({ kind: 'dock', map: s.map, pos: s.pos, land: true, name: this.#place(s.map, s.pos) }));
      const timed = transit?.byId.get(line.id) ?? null;
      // (which stop of the timetable each of the game's stops is)
      const at = timed ? line.stops.map((s) => timed.stops.findIndex((q) => q.map === s.map && Math.hypot(q.x - s.pos[0], q.y - s.pos[1]) < 400)) : null;
      stops.forEach((s, k) => {
        const next = (k + 1) % stops.length, i = at ? at[k] : -1;
        if (i >= 0 && at[next] === (i + 1) % timed.stops.length) link(s, stops[next], { mode: line.kind, line: timed.n, stop: i + 1, ride: timed.legs[i].trip, path: line.id, at: (t) => transit.board(timed, i, when(t)) });
        else link(s, stops[next], { seconds: line.period / 2 + line.stops[k].next + 10, mode: line.kind, wait: line.period / 2, path: line.id });
      });
    }
    // doorways between maps, and the tram between the two ends of its tunnel
    const tunnel = [];
    // (only between maps this game has: the list is another addon's, and it has Northrend's
    // Dalaran in it - whose two portals, to Stormwind and back, stand on the same spot of a map
    // that is not here, and so made a free way from the Mage Tower to the middle of Stormwind)
    const maps = new Set((this.app.manifest?.maps ?? []).map((m) => m.id));
    for (const p of W.portals ?? []) {
      if (maps.size && !(maps.has(p.from.map) && maps.has(p.to.map))) continue;
      if (this.#hostile(p.from.map, p.from.pos) || this.#hostile(p.to.map, p.to.pos)) continue;
      const a = add({ kind: 'door', map: p.from.map, pos: p.from.pos, name: p.name }), b = add({ kind: 'door', map: p.to.map, pos: p.to.pos, name: p.name });
      link(a, b, { seconds: p.seconds + 3, mode: 'door', name: p.name });
      if (p.from.map === 369) tunnel.push(a);
      if (p.to.map === 369) tunnel.push(b);
    }
    // ...and the portals that put you somewhere else on the same map (teleports.json, the ones
    // with a name for a route's steps: the Mage Tower's, into the Wizard's Sanctum under it and
    // back out - the only way out of the Sanctum - and the Skyborne Portal from Dalaran to it)
    for (const t of W.teleports ?? []) {
      if (!t.door || (maps.size && !maps.has(t.map)) || this.#hostile(t.map, t.from) || this.#hostile(t.map, t.to)) continue;
      // (walked to on the floor you stand on to go through it: a trigger's own height is its middle)
      const a = add({ kind: 'door', map: t.map, pos: t.stand ?? t.from, name: t.door }), b = add({ kind: 'door', map: t.map, pos: t.to, name: t.door });
      link(a, b, { seconds: (t.seconds ?? 2) + 3, mode: 'door', name: t.door });
    }
    const tram = transit?.lines.find((l) => l.kind === 'tram') ?? null;
    for (const a of tunnel) for (const b of tunnel) {
      const d = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
      if (a === b || d <= 500) continue;
      if (tram) {
        // (the end of the tunnel this doorway is at; a dozen seconds on foot between doorway and platform at each end)
        const i = Math.abs(a.pos[1] - tram.stops[0].y) < Math.abs(a.pos[1] - tram.stops[1].y) ? 0 : 1;
        link(a, b, { mode: 'tram', line: tram.n, stop: i + 1, ride: tram.legs[i].trip, at: (t) => transit.board(tram, i, when(t), 12) });
      } else link(a, b, { seconds: d / 33 + 40, mode: 'tram' });
    }
    // (avoid: you have said in the game that routes are to leave your hearthstone out)
    if (!fl && !this.fixed && T?.hearth?.has && !T.hearth.avoid && T.hearth.cooldown !== null) {
      const bind = this.#bind(T.hearth);
      // (said on the page while it is so: main.js)
      this.noBind = bind ? null : T.hearth.name ?? '';
      if (bind) link(S, add({ kind: 'inn', map: bind.map, pos: bind.pos, name: T.hearth.name }), { seconds: T.hearth.cooldown + HEARTH_CAST, mode: 'hearth', wait: T.hearth.cooldown });
    }
    // On foot between any two of them on the same map: by estimate until worked out exactly.
    const exact = new Map();
    // the walk straight there has been looked for already (it is what `direct` is)
    if (asked.map === asked.toMap) exact.set(`${S.i}>${G.i}`, direct);
    const feet = nodes.filter((n) => n.kind !== 'air');
    let noHearth = false, strict = false;
    const walk = (a, b) => {
      const r = exact.get(`${a.i}>${b.i}`);
      if (r) return r.ok ? r.seconds : Infinity;
      if (strict) return Infinity;
      return (Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) * slack) / run;
    };
    // Every place counts twice: as reached before anything has carried you, and after. The first
    // thing a journey takes (a flight, a boat, the tram) costs the time it takes; each one after
    // it has to save CHANGE_WORTH on top, or the simpler journey stands. What is weighed is `cost`
    // (the time plus that); what the journey is said to take, and when you would get to a dock,
    // is `real`.
    const N = nodes.length;
    const solve = () => {
      const cost = new Float64Array(2 * N).fill(Infinity), real = new Float64Array(2 * N).fill(Infinity), via = new Array(2 * N).fill(null), done = new Uint8Array(2 * N);
      cost[S.i] = real[S.i] = 0;
      let goal = -1;
      for (;;) {
        let u = -1;
        for (let i = 0; i < 2 * N; i++) if (!done[i] && cost[i] < Infinity && (u < 0 || cost[i] < cost[u])) u = i;
        if (u < 0) break;
        const at = u % N, carried = u >= N;
        if (at === G.i) { goal = u; break; }
        done[u] = 1;
        // (a boat or tram costs what it costs at the moment you would get to it: e.at says, for that moment)
        const relax = (e) => {
          const d = e.at ? e.at(real[u]) : e;
          const ride = RIDES.has(e.mode);
          const v = e.to + (carried || ride ? N : 0);
          const c = cost[u] + d.seconds + (ride && carried ? CHANGE_WORTH : 0);
          if (c < cost[v]) { cost[v] = c; real[v] = real[u] + d.seconds; via[v] = { edge: e.at ? { ...e, ...d } : e, from: u }; }
        };
        for (const e of edges[at]) if (!(noHearth && e.mode === 'hearth')) relax(e);
        const a = nodes[at];
        // (on foot from here to every other place on this map - not from the air)
        if (a.kind !== 'air' && !(fl && at === S.i)) for (const b of feet) if (b !== a && b.map === a.map && b.kind !== 'start') relax({ from: at, to: b.i, seconds: walk(a, b), mode: 'walk', map: a.map });
      }
      if (goal < 0) return null;
      const chain = [];
      for (let s = via[goal]; s; s = via[s.from]) chain.unshift(s.edge);
      return { seconds: real[goal], chain };
    };
    const opts = { run: this.speeds?.run, swim: this.speeds?.swim };
    // Work out one walk for real (over the ground of whichever map it is on).
    const work = async (e) => {
      const a = nodes[e.from], b = nodes[e.to], key = `${e.from}>${e.to}`;
      const info = await this.#mapInfo(e.map);
      const yards = Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]);
      const guess = { seconds: (yards * slack) / run, length: yards * slack, points: null, rough: true };
      // a map with no walking data (the tram's tunnel): a short hop is taken on trust
      if (!info) { exact.set(key, { ok: yards < TRUST, ...guess }); return; }
      const r = await this.#walk(info, a.pos, b.pos, { ...opts, landFrom: a.land, landTo: b.land });
      // Too long a walk to work out step by step (a far corner of another continent): an
      // estimate stands, and the real way is found once you are close enough to it. A careful
      // one: the search gave up with the place not yet reached, so the way is a long way round
      // (from Dun Morogh to Menethil Harbor, three times the straight line), and a guess must
      // not beat the flight that was worked out for real.
      const far = { seconds: (yards * ROUGH) / run, length: yards * ROUGH, points: null, rough: true };
      exact.set(key, !r.ok && /too far/.test(r.reason ?? '') ? { ok: true, ...far } : r);
    };
    // The quickest chain whose walks have all been worked out.
    const settle = async () => {
      for (let round = 0; round < 8; round++) {
        const found = solve();
        if (!found) return null;
        const todo = found.chain.filter((e) => e.mode === 'walk' && !exact.has(`${e.from}>${e.to}`));
        if (!todo.length) return found;
        await Promise.all(todo.map(work));
        if (this.asked !== asked) return null; // overtaken by a newer question
      }
      // still shifting after all that: the best of what has been worked out
      strict = true;
      const found = solve();
      strict = false;
      return found;
    };
    let plan = await settle();
    if (plan?.chain.some((e) => e.mode === 'hearth')) {
      // a hearthstone has to save real time over the next best way to be worth its cooldown
      noHearth = true;
      const other = await settle();
      if (other && other.seconds - plan.seconds < HEARTH_WORTH) plan = other;
    }
    if (!plan || this.asked !== asked) return false;
    // walking it is (walks from stop to stop are no journey: the walk straight there is the quickest of those, and it was worked out)
    if (plan.chain.every((e) => e.mode === 'walk')) return false;
    if (direct.ok && plan.seconds > direct.seconds * WORTH) return false;       // not quicker after all

    // ---- the journey as parts to read out, and the pieces on this map to draw ----
    // (also: the lines of the journey that are shown but not followed - its parts on other maps,
    // and its crossings by boat and zeppelin: { map, points, kinds (one for each point, or one
    // for all), joins (it goes on from the line before, over the sea between two maps) })
    const legs = [], points = [], kinds = [], time = [], also = [];
    const shown = (map, pts, k, joins = false) => { if (pts && pts.length >= 6) also.push({ map, points: pts, kinds: k, joins }); };
    let clock = 0, lastWalk = null;
    const draw = (p, k, seconds) => {
      // times along a drawn piece, spread by distance
      let total = 0;
      const n = p.length / 3, d = new Float32Array(n);
      for (let i = 1; i < n; i++) { total += Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2], p[i * 3 + 2] - p[i * 3 - 1]); d[i] = total; }
      // a stretch that starts somewhere else than the last one ended (the far end of the tram) is not joined to it
      const m = points.length;
      const apart = m > 0 && Math.hypot(p[0] - points[m - 3], p[1] - points[m - 2]) > GAP;
      for (let i = 0; i < n; i++) { points.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); kinds.push((typeof k === 'number' ? k : k[i]) | (apart && i === 0 ? BREAK : 0)); time.push(clock + (total > 0 ? (seconds * d[i]) / total : 0)); }
    };
    for (const e of plan.chain) {
      const a = nodes[e.from], b = nodes[e.to];
      if (e.mode === 'walk') {
        const r = exact.get(`${e.from}>${e.to}`);
        const to = b.kind === 'flight' ? `${b.name}'s flight master` : b.kind === 'dock' ? `the ${plan.chain[plan.chain.indexOf(e) + 1]?.mode ?? 'boat'} at ${b.name}` : b.kind === 'door' ? `the ${b.name.replace(/^(Passage|Portal) to /, '')} ${/^Portal/.test(b.name) ? 'portal' : 'entrance'}` : null;
        // (two walks on end are one walk: the way happened to pass a stop it had no use for)
        const before = legs[legs.length - 1];
        if (before?.mode === 'walk' && before.map === e.map) { before.yards += r.length; before.seconds += r.seconds; before.rough = before.rough || !!r.rough; before.to = to; }
        else legs.push({ mode: 'walk', yards: r.length, seconds: r.seconds, rough: !!r.rough, map: e.map, to });
        if (e.map === this.mapId && r.points) { draw(r.points, r.kinds, r.seconds); legs[legs.length - 1].end = kinds.length - 1; }
        else shown(e.map, r.points, r.kinds);
        if (b === G) lastWalk = { map: e.map, from: a.pos, land: !!a.land };
      } else if (e.mode === 'flight') {
        // the flight you are on: its line from where you are, along the path you are on and the ones after it
        const leg = { mode: 'fly', to: b.name, seconds: e.seconds, hops: e.pieces.length, paths: fl.paths, dest: fl.dest, aloft: true };
        legs.push(leg);
        const line = [];
        for (const piece of e.pieces) {
          if (piece.map !== this.mapId) continue;
          const q = piece.points, n = q.length / 3;
          let gone = 0, i = 0;
          for (; piece.from > 0 && i + 1 < n; i++) {
            const d = Math.hypot(q[i * 3 + 3] - q[i * 3], q[i * 3 + 4] - q[i * 3 + 1], q[i * 3 + 5] - q[i * 3 + 2]);
            if (gone + d > piece.from) {
              // (the spot of the path you are at: between two of its points)
              const t = d > 0 ? (piece.from - gone) / d : 0;
              line.push(q[i * 3] + (q[i * 3 + 3] - q[i * 3]) * t, q[i * 3 + 1] + (q[i * 3 + 4] - q[i * 3 + 1]) * t, q[i * 3 + 2] + (q[i * 3 + 5] - q[i * 3 + 2]) * t);
              i++;
              break;
            }
            gone += d;
          }
          for (; i < n; i++) line.push(q[i * 3], q[i * 3 + 1], q[i * 3 + 2]);
        }
        if (line.length >= 6) { draw(new Float32Array(line), 4, e.seconds); leg.end = kinds.length - 1; }
      } else if (e.mode === 'board') legs.push({ mode: 'fly', from: a.name, to: a.name, seconds: e.seconds, hops: 0, paths: [], dest: a.id });
      else if (e.mode === 'fly') {
        // (paths, dest: which flight paths this flight goes along, and the flight point it comes down at - for when you are on it: #flight)
        const leg = legs[legs.length - 1];
        leg.to = b.name; leg.seconds += e.seconds; leg.hops++; leg.paths.push(e.path); leg.dest = b.id;
        if (e.map === this.mapId) { draw(routes.curve(e.map, e.path).points, 4, e.seconds); leg.end = kinds.length - 1; }
        else shown(e.map, routes.curve(e.map, e.path)?.points, 4);
      } else if (e.mode === 'boat' || e.mode === 'zeppelin') {
        legs.push({ mode: e.mode, from: a.name, to: b.name, seconds: e.seconds, wait: e.wait, line: e.line, stop: e.stop, ride: e.ride, known: !!e.known, leaves: e.leaves });
        // (its way across, on each map it sails or flies over: shown, on this map too - there is no following a boat's line on foot)
        this.#crossing(e.path, a, b).forEach((piece, k) => shown(piece.map, piece.points, RIDE, k > 0));
      }
      else if (e.mode === 'door') legs.push({ mode: 'door', name: e.name, seconds: e.seconds });
      else if (e.mode === 'tram') legs.push({ mode: 'tram', seconds: e.seconds, wait: e.wait, line: e.line, stop: e.stop, ride: e.ride, known: !!e.known, leaves: e.leaves });
      else if (e.mode === 'hearth') legs.push({ mode: 'hearth', wait: e.wait, seconds: e.seconds });
      clock += e.seconds;
    }
    const p = new Float32Array(points), cum = new Float32Array(kinds.length);
    for (let i = 1; i < cum.length; i++) cum[i] = cum[i - 1] + (kinds[i] & BREAK ? 0 : Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2], p[i * 3 + 2] - p[i * 3 - 1]));
    const first = plan.chain[0];
    this.route = {
      points: p, kinds: new Uint8Array(kinds), cum, time: new Float32Array(time), length: cum.length ? cum[cum.length - 1] : 0,
      seconds: plan.seconds, target: asked.to, at: 0, legs, lastWalk, walking: direct.ok ? direct.seconds : null, also,
      // a journey that does not begin with a walk from where you stand (or with one too long to
      // draw), nor with the flight you are on: being far from its line is expected
      detached: !((first.mode === 'walk' && first.map === this.mapId && !!exact.get(`${first.from}>${first.to}`)?.points) || (first.mode === 'flight' && legs[0].end !== undefined)),
    };
    this.status = '';
    this.rev++;
    this.onChange();
    return true;
  }

  /**
   * The way a boat or zeppelin goes from one of its stops to the next, as lines to show: one for
   * each map it crosses, [{ map, points }]. (Its path in the game's data goes all the way round;
   * this is the part of it between the two stops. Between two continents the path stops a
   * little way out to sea and begins again off the other coast - the craft is moved from one
   * map to the other - so there is a line for each, and whoever draws them joins the two.)
   */
  #crossing(id, a, b) {
    const path = id ? this.app.world.taxiPaths.find((p) => p.id === id) : null;
    if (!path) return [];
    this.ways ??= new Map();
    let way = this.ways.get(id);
    if (!way) this.ways.set(id, (way = wayOf(path)));
    const n = way.length;
    const from = nearestOn(way, a.map, a.pos[0], a.pos[1], 0, n, 600);
    const to = from < 0 ? -1 : nearestOn(way, b.map, b.pos[0], b.pos[1], Math.floor(from) + 1, n, 600);
    if (to < 0) return [];
    const out = [];
    let cur = null;
    for (let i = Math.ceil(from) % n, left = n; left > 0; i = (i + 1) % n, left--) {
      const w = way[i];
      if (!cur || cur.map !== w.map) out.push((cur = { map: w.map, pts: [] }));
      cur.pts.push(w.x, w.y, w.z);
      if (i === Math.floor(to) % n) break;
      if (w.cut) cur = null; // (from here it is moved to the next point, not sailed there)
    }
    return out.filter((q) => q.pts.length >= 6).map((q) => ({ map: q.map, points: new Float32Array(q.pts) }));
  }

  /**
   * How far along the route (index of the nearest point) a position is, and how far off it.
   * Height counts, and for more than distance does: under the gallery the route ends on, or
   * under a bridge it crosses, you are not on that part of it, however near it looks from above.
   * (Not along water, where you may be well below the surface the route runs on.)
   */
  #progress(x, y, z) {
    const r = this.route, p = r.points, kinds = r.kinds;
    const tall = Number.isFinite(z);
    let best = r.at, bestD = Infinity;
    for (let i = Math.max(0, r.at - 4); i < Math.min(p.length / 3, r.at + 60); i++) {
      const dz = tall && !(kinds[i] & 1) ? (p[i * 3 + 2] - z) * LEVEL_WEIGH : 0;
      const d = Math.hypot(p[i * 3] - x, p[i * 3 + 1] - y, dz);
      if (d < bestD) { bestD = d; best = i; }
    }
    return [best, bestD];
  }

  /**
   * Time the flight path you are on, so that flights are counted at the speed yours really go.
   * A flight path is flown at one speed from end to end, and how long the game's flight paths
   * take is their length over that speed, to within a second or so (30.4 yards a second fits
   * the measured times of 266 of them). What differs is your speed: a fifth more with the
   * Frequent Flier talent. So it is measured: how far along the path you have come (in yards of
   * the path itself, height counted, as its length is) over a good stretch of it. Not how fast
   * you are moving over the map at one moment: climbing out of a town or coming down to land,
   * that is far less than the speed you are flying at.
   * @param ride what is carrying you (height.js), or null
   */
  #timeFlight(ride, now) {
    const on = ride?.flight && !ride.lost && Number.isFinite(ride.along) ? ride : null;
    const f = this.flying;
    // (further along than any flight gets in the time, or back: the place was taken for another
    // part of a path that crosses itself)
    const same = !!on && !!f && f.path === on.path.id && on.along >= f.last - 30 && on.along - f.last <= ((now - f.seen) / 1000) * 60 + 40;
    if (!same) {
      this.flying = on && on.along > SPEED_SKIP ? { path: on.path.id, from: on.along, last: on.along, t: now, seen: now, told: 0 } : null;
      return;
    }
    f.last = on.along;
    f.seen = now;
    const seconds = (now - f.t) / 1000;
    if (seconds < SPEED_OVER || now - f.told < 2000) return;
    f.told = now;
    const v = (on.along - f.from) / seconds;
    if (!(v > 20 && v < 60) || Math.abs(v - this.flightSpeed) < 0.1) return;
    this.flightSpeed = v;
    try { localStorage.setItem(SPEED_KEY, v.toFixed(2)); } catch { /* not remembered */ }
  }

  /** True while you are on the route shown (as far as this map, which follows your height, can tell). */
  get onRoute() { return !!this.route && this.off <= REPLAN_OFF; }

  /**
   * Keep the route current. Called every frame.
   * @param me      [x, y, z] where you are (or null)
   * @param target  { map, x, y } where you are heading (or null)
   * @param speeds  { run, swim } in yards per second
   */
  update(me, target, speeds, now = performance.now()) {
    this.me = me ?? null;
    // (a flight is timed whether or not you are heading anywhere: the next journey is counted by it)
    const ride = me && !this.fixed ? this.app.player?.height?.ride ?? null : null;
    if (this.own) this.#timeFlight(ride, now);
    if (!this.enabled || !me || !target) { this.#clear(''); return; }
    const elsewhere = target.map !== this.mapId;
    // (a map with nowhere worked out to walk, like the tram's tunnel, can still be travelled from)
    if (!this.navigable && !elsewhere) { this.#clear('No walking data for this map yet: press Update map'); return; }
    this.speeds = speeds;
    const a = this.asked;
    // (go: where the route is to end, when that is not the waypoint's own spot - a pin on a roof
    // is walked to at the nearest place you can stand)
    const to = target.go ?? [target.x, target.y, target.z ?? null];
    // (a waypoint somewhere else, or on another level of the same spot: asked about at once, whatever is in hand)
    const moved = !!a && (a.toMap !== target.map || Math.hypot(a.to[0] - to[0], a.to[1] - to[1]) > 2 || Math.abs((a.to[2] ?? -1e6) - (to[2] ?? -1e6)) > 1);
    // (your hearthstone has been switched on or off in the game since this was asked: asked again)
    if (a && !this.fixed && a.avoid !== !!this.app.player?.travel?.hearth?.avoid) a.stale = true;
    let need = !a || a.stale || moved;
    // where you are on the route shown (also while a newer one is being worked out)
    if (this.route && a && !moved) {
      const [i, off] = this.#progress(me[0], me[1], me[2]);
      if (i !== this.route.at) { this.route.at = i; this.rev++; }
      this.off = off;
    } else this.off = Infinity;
    // On a flight path the route is what is left of the flight and the way on from where it
    // comes down (#journey). That does not change as you fly: it is asked about once, and again
    // when the flight turns out to go another way, or the speed flights go at has been measured
    // anew (what is left of the flight is timed by it) - not every few yards, and not as a walk
    // from the ground under you.
    const flight = this.#flight(ride);
    if (flight) {
      const same = !!a?.flight && a.flight.dest === flight.dest && a.flight.paths.includes(flight.path) && Math.abs(a.flight.speed - flight.speed) <= 1;
      if (!need) need = !same || (a.done && a.settled && !this.route && now - a.time > 5000);
      // (how long is left is read off the route as you go along it: the panel is told now and then)
      if (this.route && now - (this.toldAt ?? 0) > 5000) { this.toldAt = now; this.onChange(); }
    } else if (ride) {
      // Carried by a boat, a zeppelin or the tram (or on a flight path the map cannot place):
      // there is nowhere to plan from until it has put you down. The journey in hand stays as
      // it is - the crossing you are on and what lies beyond it are still the way. (A waypoint
      // set meanwhile is asked about, and answered with "worked out when you land".)
      if (!need) return;
    } else if (!need && a.flight) need = true; // landed: from where you stand now
    else if (!need && a.done && this.route) {
      if ((this.off > REPLAN_OFF && !this.route.detached) || now - a.time > REPLAN_EVERY) need = Math.hypot(a.from[0] - me[0], a.from[1] - me[1]) > 3;
    } else if (!need && a.done && !this.route) {
      // nothing found last time: try again once you have moved a bit
      need = Math.hypot(a.from[0] - me[0], a.from[1] - me[1]) > 15;
    }
    // (A journey still being worked out is left to finish: it takes a few seconds - the walks to
    // flight masters, a search or two that finds no way - and while you run, every few yards
    // would otherwise be a new question, and none of them ever answered. The game would wait
    // for its route in vain.)
    const working = !!a && a.done && !a.settled && now - a.time < SETTLE_FOR;
    if (need && (moved || (!working && !(a && !a.done && now - a.time < 4000) && !(a && !a.stale && now - a.time < REPLAN_GAP)))) {
      const id = ++this.hub.seq;
      // (avoid: whether your hearthstone was left out when this was asked - a route worked out before you changed that is not the answer any more)
      const asked = (this.asked = { id, map: this.mapId, toMap: target.map, from: [me[0], me[1], me[2]], to: [to[0], to[1], to[2] ?? null], time: now, done: false, flight, avoid: !!this.app.player?.travel?.hearth?.avoid });
      // (noted when it is another place than before - log.js; someone in your party is one with every look)
      if (!/^ally/.test(this.label) && changed(`to.${this.label}`, [target.map, whole(to[0]), whole(to[1]), whole(to[2])])) note('route', `${this.label}: heading for ${target.name ?? `a spot on map ${target.map}`}`, { to: [target.map, whole(to[0]), whole(to[1]), whole(to[2])], said: target.source, from: [whole(me[0]), whole(me[1]), whole(me[2])], onMap: this.mapId, onAFlight: !!flight || undefined, carried: (!!ride && !flight) || undefined, hearthstoneLeftOut: asked.avoid || undefined });
      if (flight) { this.#aloft(asked); return; }
      // (on another map there is no walking it: straight to the journey by other means; and
      // while something carries you there is no walking from where you are, either)
      const walk = elsewhere ? Promise.resolve({ ok: false }) : ride ? Promise.resolve({ ok: false, reason: 'the way there is worked out when you land' })
        : this.#walk(this.info, asked.from, asked.to, { run: speeds?.run, swim: speeds?.swim });
      walk.then((m) => this.#answer(asked, m));
    }
  }

  /** What is left of the route from where you are: { yards, seconds } or null. */
  remaining() {
    const r = this.route;
    if (!r) return null;
    const left = r.length - r.cum[r.at];
    return { yards: left, seconds: r.legs.length > 1 ? r.seconds - (r.at > 0 && r.time.length ? r.time[r.at] : 0) : r.time[r.time.length - 1] - r.time[r.at] };
  }
}

const SHADER = /* wgsl */ `
${GLOBALS_WGSL}
struct Route {
  origin: vec4f,   // the route's first point, camera-relative
  size: vec4f,     // x, y: half the line width in clip units; z: lift above the ground
  walk: vec4f, swim: vec4f, danger: vec4f, fly: vec4f, ride: vec4f,
};
@group(1) @binding(0) var<uniform> R: Route;
override GHOST: f32 = 0.0;

struct VSOut { @builtin(position) clip: vec4f, @location(0) color: vec3f, @location(1) across: f32 };
@vertex fn vs(@location(0) a: vec3f, @location(1) b: vec3f, @location(2) corner: vec2f, @location(3) kind: f32) -> VSOut {
  var out: VSOut;
  let up = vec3f(0.0, 0.0, R.size.z);
  var ca = G.viewProj * vec4f(a + R.origin.xyz + up, 1.0);
  var cb = G.viewProj * vec4f(b + R.origin.xyz + up, 1.0);
  // keep both ends in front of the camera
  let near = 0.3;
  if (ca.w < near && cb.w < near) { out.clip = vec4f(2.0, 2.0, 2.0, 1.0); return out; }
  if (ca.w < near) { ca = mix(ca, cb, (near - ca.w) / (cb.w - ca.w)); }
  if (cb.w < near) { cb = mix(cb, ca, (near - cb.w) / (ca.w - cb.w)); }
  let pa = ca.xy / ca.w;
  let pb = cb.xy / cb.w;
  var dir = pb - pa;
  let len = length(dir * vec2f(1.0 / R.size.x, 1.0 / R.size.y));
  dir = select(vec2f(1.0, 0.0), normalize(dir / R.size.xy), len > 1e-5);
  let normal = vec2f(-dir.y, dir.x) * R.size.xy;
  let along = dir * R.size.xy;
  var c = select(ca, cb, corner.x > 0.5);
  // widen the line by a fixed number of pixels, with square caps so joints are closed
  let offset = normal * corner.y + along * (corner.x * 2.0 - 1.0);
  c = vec4f(c.xy + offset * c.w, c.z, c.w);
  out.clip = c;
  out.color = select(select(select(select(R.walk.rgb, R.swim.rgb, kind > 0.5 && kind < 1.5), R.danger.rgb, kind > 1.5 && kind < 2.5), R.fly.rgb, kind > 2.5), R.ride.rgb, kind > 3.5);
  out.across = corner.y;
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  // a dark edge so the line reads on any ground
  let edge = smoothstep(0.55, 0.85, abs(in.across));
  let color = mix(in.color, in.color * 0.25, edge);
  if (GHOST > 0.0) { return vec4f(color, GHOST); }
  return vec4f(color, 1.0);
}
`;

const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255), 1]; };

/** Draws the route as a line of constant width lying over the ground (faint where hidden). */
export class RouteRenderer {
  constructor(gpu) {
    this.gpu = gpu;
    const { device } = gpu;
    this.uniform = device.createBuffer({ label: 'route-uniform', size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(28);
    this.data.set(rgb('#e8f6ff'), 20);
    this.data.set(rgb('#c39bff'), 24); // a crossing by boat or zeppelin
    this.hex = null;
    this.data.set(rgb('#ffd23a'), 8); this.data.set(rgb('#5cc8ff'), 12); this.data.set(rgb('#ff5a3c'), 16);
    const layout = device.createBindGroupLayout({ label: 'route', entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }] });
    this.group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }] });
    const module = device.createShaderModule({ label: 'route', code: SHADER });
    const buffers = [{ arrayStride: 36, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32x2' }, { shaderLocation: 3, offset: 32, format: 'float32' }] }];
    const common = { layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.globalsLayout, layout] }), vertex: { module, entryPoint: 'vs', buffers }, primitive: { topology: 'triangle-list', cullMode: 'none' }, multisample: { count: gpu.sampleCount } };
    this.solid = device.createRenderPipeline({ label: 'route', ...common, fragment: { module, entryPoint: 'fs', targets: targets(gpu) }, depthStencil: depthState(gpu, false) });
    // (cover: the line's depth and no colour - see cover())
    this.coverPipeline = device.createRenderPipeline({ label: 'route-cover', ...common, fragment: { module, entryPoint: 'fs', targets: [{ format: gpu.colorFormat, writeMask: 0 }] }, depthStencil: depthState(gpu, true) });
    this.ghost = device.createRenderPipeline({ label: 'route-ghost', ...common, fragment: { module, entryPoint: 'fs', targets: targets(gpu, ALPHA_BLEND), constants: { GHOST: 0.3 } }, depthStencil: { format: gpu.depthFormat, depthWriteEnabled: false, depthCompare: 'less' } });
    // the line you follow (made again as you go along it), and the rest of the journey (made once)
    this.vertices = null;
    this.count = 0;
    this.rev = -1;
    this.origin = [0, 0, 0];
    this.uniformRest = device.createBuffer({ label: 'route-rest-uniform', size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.groupRest = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniformRest } }] });
    this.rest = null;
    this.more = 0;
    this.seen = null;
    this.key = '';
    this.originRest = [0, 0, 0];
  }

  /**
   * The colour of this route ('#rrggbb'). What is walked is that colour; what is flown, a light
   * tint of it; what is swum leans toward the blue of water, and a crossing by boat or zeppelin
   * toward lilac - so each kind of going can still be told, and each route from the others.
   */
  setColor(hex) {
    if (hex === this.hex) return;
    this.hex = hex;
    const base = rgb(hex), mix = (to, t) => base.map((v, i) => v + (to[i] - v) * t);
    this.data.set(base, 8);
    this.data.set(mix(rgb('#5cc8ff'), 0.55), 12);
    this.data.set(base, 16);
    this.data.set(mix(rgb('#ffffff'), 0.62), 20);
    this.data.set(mix(rgb('#c39bff'), 0.5), 24);
  }

  /** Pieces of line (from, to, kind: seven numbers each) as vertices in a buffer, counted from the first of them: { buffer, count, origin }. */
  #fill(segs, buffer, label) {
    if (!segs.length) return { buffer, count: 0, origin: [0, 0, 0] };
    const o = [segs[0], segs[1], segs[2]];
    const v = new Float32Array((segs.length / 7) * 6 * 9);
    let w = 0;
    for (let g = 0; g < segs.length; g += 7) {
      const ax = segs[g] - o[0], ay = segs[g + 1] - o[1], az = segs[g + 2] - o[2], bx = segs[g + 3] - o[0], by = segs[g + 4] - o[1], bz = segs[g + 5] - o[2], kind = segs[g + 6];
      for (const [t, e] of [[0, -1], [1, -1], [1, 1], [0, -1], [1, 1], [0, 1]]) { v[w++] = ax; v[w++] = ay; v[w++] = az; v[w++] = bx; v[w++] = by; v[w++] = bz; v[w++] = t; v[w++] = e; v[w++] = kind; }
    }
    if (!buffer || buffer.size < v.byteLength) {
      buffer?.destroy();
      buffer = this.gpu.device.createBuffer({ label, size: Math.max(v.byteLength, 1 << 16), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.gpu.device.queue.writeBuffer(buffer, 0, v, 0, w);
    return { buffer, count: w / 9, origin: o };
  }

  /** One piece of line, from point i of a row of points to the next (BREAK: there is none - the next stretch starts somewhere else). */
  static #piece(segs, q, i, k, off) {
    if (!(k & BREAK)) segs.push(q[i * 3] + off[0], q[i * 3 + 1] + off[1], q[i * 3 + 2], q[i * 3 + 3] + off[0], q[i * 3 + 4] + off[1], q[i * 3 + 5], k & RIDE ? 4 : k & 4 ? 3 : k & 2 ? 2 : k & 1);
  }

  /** The line you follow, from where you are on it (the part behind you is not drawn). */
  #build(route) {
    const segs = [], p = route.points;
    for (let i = route.at; i + 1 < p.length / 3; i++) RouteRenderer.#piece(segs, p, i, route.kinds[i + 1], [0, 0]);
    const made = this.#fill(segs, this.vertices, 'route');
    this.vertices = made.buffer; this.count = made.count; this.origin = made.origin;
  }

  /**
   * The rest of the journey: its lines on the map beside this one, and across the sea.
   * @param offsetOf  (map id) => where that map lies on the picture, counted from the map in hand
   *                  ([x, y]), or null if it is not on the picture
   */
  #buildRest(route, offsetOf) {
    const segs = [];
    let before = null; // where the line before this one ended on the picture (null: it is not on the picture)
    for (const piece of route.also ?? []) {
      const off = offsetOf ? offsetOf(piece.map) : null;
      const q = piece.points, n = q.length / 3;
      // (a crossing goes on over the open sea from where its line on the other map left off)
      if (off && piece.joins && before) segs.push(before[0], before[1], before[2], q[0] + off[0], q[1] + off[1], q[2], 4);
      before = off ? [q[n * 3 - 3] + off[0], q[n * 3 - 2] + off[1], q[n * 3 - 1]] : null;
      if (!off) continue;
      for (let i = 0; i + 1 < n; i++) RouteRenderer.#piece(segs, q, i, typeof piece.kinds === 'number' ? piece.kinds : piece.kinds[i + 1], off);
    }
    const made = this.#fill(segs, this.rest, 'route-rest');
    this.rest = made.buffer; this.more = made.count; this.originRest = made.origin;
  }

  #lines(pass, group, buffer, count) {
    pass.setBindGroup(0, this.gpu.globalsGroup);
    pass.setBindGroup(1, group);
    pass.setVertexBuffer(0, buffer);
    pass.setPipeline(this.ghost);
    pass.draw(count);
    pass.setPipeline(this.solid);
    pass.draw(count);
  }

  /**
   * The line you follow. (The rest of the journey is drawn by drawRest, later in the picture.)
   * @param planner RoutePlanner  @param camera Camera
   * @param offsetOf  where each map lies on the picture (see #buildRest)   @param key  changes when that does
   */
  draw(pass, planner, camera, offsetOf = null, key = '') {
    const route = planner.route;
    if (!route) { this.count = 0; this.more = 0; this.seen = null; this.rev = planner.rev; return; }
    if (planner.rev !== this.rev) { this.rev = planner.rev; this.#build(route); }
    if (route !== this.seen || key !== this.key) { this.seen = route; this.key = key; this.#buildRest(route, offsetOf); }
    const gpu = this.gpu, d = this.data, px = 3.2 * (gpu.pixelRatio || 1);
    d[4] = px / gpu.width * 2; d[5] = px / gpu.height * 2; d[6] = LIFT;
    if (this.more) {
      d[0] = this.originRest[0] - camera.pos[0]; d[1] = this.originRest[1] - camera.pos[1]; d[2] = this.originRest[2] - camera.pos[2];
      gpu.device.queue.writeBuffer(this.uniformRest, 0, d);
    }
    if (!this.count) return;
    d[0] = this.origin[0] - camera.pos[0]; d[1] = this.origin[1] - camera.pos[1]; d[2] = this.origin[2] - camera.pos[2];
    gpu.device.queue.writeBuffer(this.uniform, 0, d);
    this.#lines(pass, this.group, this.vertices, this.count);
  }

  /**
   * The rest of the journey: drawn after the water, which is drawn over whatever came before
   * it - and a crossing lies on the sea. (Call after draw, in the same picture.)
   */
  drawRest(pass) {
    if (this.more) this.#lines(pass, this.groupRest, this.rest, this.more);
  }

  /**
   * The line, as something for the water to be behind: its depth is written and nothing is
   * painted. Water is see-through, and is drawn after everything solid; a line writes no depth
   * when it is drawn (your figure, drawn after it, is to show in front of the line at its
   * feet), so without this the water was painted over a line that is in front of it - a flight
   * high over a river looked as if it ran under the water.
   * (Call after draw, and after what is to show in front of the line whatever; before the water.)
   */
  cover(pass) {
    if (!this.count) return;
    pass.setBindGroup(0, this.gpu.globalsGroup);
    pass.setBindGroup(1, this.group);
    pass.setVertexBuffer(0, this.vertices);
    pass.setPipeline(this.coverPipeline);
    pass.draw(this.count);
  }
}
