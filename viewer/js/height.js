// How high your character is. The game tells addons where you are on the map but not your
// height (if a future version does, it is simply used), so it is worked out here from what the
// game does report and what the map knows:
//
//   riding    On a flight path (the game says so) or carried by a zeppelin or boat (you move
//             faster than you could yourself, along its route): the route's own 3D points give
//             the height. Where it sets you down, you are on the ground at the flight master's
//             height, or at the route's height where the map has no ground to offer. A zeppelin
//             slows down long before its tower: you are on its deck, at its height, for as long
//             as you are on its line - until you step onto something the map does have.
//   walking   The way from your previous position is retraced in small steps over the surfaces
//             you could be standing on (terrain, the floors, stairs and bridges in the buildings'
//             collision data, and the surface of deep water), staying on the ground as it rises
//             and falls. A drop bigger than a step is only believed once the game has reported
//             you falling for long enough to cover it; until then you are taken to be on
//             something the map does not have (a rope bridge that is a prop, a ship's deck).
//   swimming  You are at the water surface.
//   stepping  Through a portal that puts you on another floor of the same building (the Mage
//   through   Tower in Stormwind and the Wizard's Sanctum under it): a few yards across the map
//             and a long way up or down, in no time. The map knows those portals and where they
//             lead (teleports.json): at one's doorstep on its level, then all at once where it
//             puts you down, you have gone through.
//   arriving  After a jump with no way in between (teleport, hearthstone, login, new map): the
//             height remembered for that spot from an earlier visit, else a flight master's
//             there, else the topmost surface outdoors and the lowest sensible floor indoors.

const HEADROOM = 1.6;    // yards of clear space a character needs above a surface to stand on it
const SAME_UP = 0.6;     // over one traced step the ground you are on rises at most this much...
const SAME_DOWN = 0.8;   // ...or falls at most this much (stairs, the steepest walkable slopes)
const DROP_AFTER = 0.75; // yards you must travel with no ground at your height before it counts as a drop
const TRACE_STEP = 0.25; // yards between the points checked along the way from the last reading
const TRACE_MAX = 30;    // yards: after a longer gap the way in between is not retraced
const CLIMB = 1.2;       // yards of rise or fall per yard travelled on the steepest walkable ground
const WADE = 1.5;        // water deeper than this: you swim instead of walking on the bottom
const AFLOAT = 2.5;      // water at least this deep and you are not swimming: something is carrying you
const FLOAT_REACH = 8;   // stepping off a boat: the pier is at most this far above the water
const GRAVITY = 19.3;    // yards per second squared, the game's
const FREE_DROP = 2;     // a drop this small needs no sign of falling
const HOLD_MAX = 20;     // yards travelled with nothing known under you before giving up and taking the surface below
const RISE_MAX = 4;      // yards: further up than this in one step is not something you did on foot
const RIDE_SPEED = 17;   // yards per second: faster than anything you ride or run yourself
const RIDE_KEEP = 9;     // once carried, you still are while moving at least this fast along the route
const RIDE_NEAR = 40;    // yards from the route for that to count
const RIDE_AFTER = 1200; // milliseconds of it before it is believed
const LAND_REACH = 6;    // set down by a ride: the ground is within this much of the expected height
const ABOARD = 16;       // yards from a boat's or zeppelin's line within which you are still on its deck, once it has slowed for its stop
const DOORSTEP = 5;      // a portal to another floor: you were last seen within this many yards of where it takes hold...
const DOOR_LEVEL = 9;    // ...and within this much of its height;
const HOP_REACH = 10;    // you are now within this many yards of where it puts you down,
const HOP_SPEED = 20;    // having got there faster than anything carries you on the ground (yards a second),
const HOP_STEP = 3;      // by at least this many yards in one go - or this many,
const HOP_STEP_SAME = 6; // where the floor you were on carries on under where you are now
const HOP_FLOOR = 4;     // the floor it puts you on is within this much of the height it is said to
const SAME_SPOT = 4;     // yards: the height saved for your last position applies if you are still there
const SPOT = 3;          // yards: size of the cells that visited places are remembered in
const SPOTS_MAX = 3000;
const HEIGHT_KEY = 'wfmap.height', SPOTS_KEY = 'wfmap.heights';

/** The surfaces of a sorted list that have room for a character above them. */
function standable(all) {
  const out = [];
  for (let i = 0; i < all.length; i++) if (i + 1 >= all.length || all[i + 1] - all[i] >= HEADROOM) out.push(all[i]);
  return out;
}

export class HeightTracker {
  /** @param app { scene, floors, objects, routes } (read when needed, so they may be set later) */
  constructor(app) {
    this.app = app;
    this.pending = false;   // a building here is still loading: ask again shortly
    this.how = '';          // what decided the last height (for the read-out and tests)
    this.saved = undefined; // last position and height, kept across page reloads (loaded on first use)
    this.savedAt = 0;
    this.spots = null;      // heights of places walked through before (Map: cell -> height)
    this.spotsDirty = false;
    this.spotsSavedAt = 0;
    this.track = [];        // recent positions, for speed and course
    this.speed = 0;
    this.course = null;
    this.fallStart = null;  // when the fall in progress began
    this.fallLen = 0;       // how long the last finished one lasted (ms)
    this.fallEnd = -1e9;
    this.knowsFalling = false;
    this.fastSince = null;
    this.heard = 0;         // the time of the newest reading that has been taken into account (see #leap)
    this.reset();
  }

  /** Forget where you were: the next position is a fresh start (teleport, new map). */
  reset() {
    this.z = null;
    this.at = null;        // [x, y] the height was worked out for
    this.gap = 0;          // yards travelled since there was last ground at your height
    this.lost = 0;         // yards travelled with nothing at your height or below it at all
    this.unsure = false;   // the first guess was made while a building was still loading
    this.sure = false;     // the height has been followed from somewhere unambiguous
    this.ride = null;      // the route carrying you, if any
    this.loose = false;    // set down where the map has no surface: waiting for one to come within reach
    this.aboard = null;    // ...by a boat or zeppelin that has only slowed down: its route, for as long as you are still on its line
    this.airborne = false;
    this.track.length = 0;
    this.speed = 0;
    this.course = null;
    this.fastSince = null;
    this.fallStart = null;
    this.fallLen = 0;
    this.fallEnd = -1e9;
  }

  // ---- what the map knows about a spot -------------------------------------------------------
  #ground(x, y) {
    const scene = this.app.scene;
    return scene.heightAt(x, y) ?? scene.planeZ ?? (scene.map.ocean ? scene.map.seaLevel : 0);
  }

  /**
   * Every surface on the vertical line through a spot, lowest first: building floors, the
   * terrain, and the surface of water too deep to stand in (the bottom under it is left out:
   * you swim there, or something carries you). `water` is that level when it is in the list.
   * Where the game cuts a hole in the ground (over a cellar, at the mouth of a cave or a mine)
   * there is no terrain to stand on, though the map can still say how high it would have been:
   * that is `level`, and `terrain` is null.
   */
  #surfaces(x, y, me) {
    const scene = this.app.scene;
    const level = scene.heightAt(x, y);
    const terrain = level !== null && scene.holeAt(x, y) ? null : level;
    const { zs, pending } = this.app.floors && this.app.objects ? this.app.floors.at(this.app.objects.wmos, x, y) : { zs: [], pending: false };
    let all = terrain === null ? zs.slice() : [...zs, terrain];
    // Open water only; indoors (a flooded cave) it counts when the game says you are swimming.
    let water = !me.indoors || me.swimming ? scene.waterAt(x, y) : null;
    let depth = 0;
    if (water !== null) {
      const shallow = all.some((v) => v >= water - WADE && v <= water + 0.3);
      if (shallow) water = null; // you can stand here
      else {
        const bottom = all.filter((v) => v < water);
        depth = bottom.length ? water - Math.max(...bottom) : Infinity;
        all = all.filter((v) => v > water);
        all.push(water);
      }
    }
    all.sort((p, q) => p - q);
    return { all, zs, terrain, level, water, depth, pending };
  }

  /** The heights someone could be standing at on a spot (floors and ground with headroom), lowest first. */
  standableAt(x, y) {
    if (!this.app.scene) return [];
    return standable(this.#surfaces(x, y, { indoors: false, swimming: false }).all);
  }

  // ---- how you are moving --------------------------------------------------------------------
  /**
   * A reading from the game has arrived. Called at that moment rather than when the next
   * picture is drawn, so that how long you fell and how fast you move are timed by the game's
   * readings and not by how often the map happens to redraw.
   */
  reading(me, now = performance.now()) {
    if (me.falling === true || me.falling === false) {
      this.knowsFalling = true;
      if (me.falling) { if (this.fallStart === null) this.fallStart = now; }
      else if (this.fallStart !== null) { this.fallLen = now - this.fallStart; this.fallEnd = now; this.fallStart = null; }
    } else this.knowsFalling = false; // an older addon that does not say
    const t = this.track;
    const last = t[t.length - 1];
    if (!last || last.x !== me.x || last.y !== me.y) t.push({ t: now, x: me.x, y: me.y });
    while (t.length > 2 && now - t[0].t > 1500) t.shift();
  }

  /** Speed and course over the last second and a half of readings. */
  #pace(now) {
    const t = this.track;
    const a = t[0], b = t[t.length - 1];
    if (t.length >= 2 && now - b.t < 500 && b.t - a.t >= 400) {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      this.speed = d / ((b.t - a.t) / 1000);
      this.course = d > 0.5 ? [(b.x - a.x) / d, (b.y - a.y) / d] : null;
    } else { this.speed = 0; this.course = null; }
  }

  /**
   * How far the falling the game has just reported could have taken you, in yards (0 = it has
   * reported none), or null when this addon does not report falling at all.
   */
  #fallen(now) {
    if (!this.knowsFalling) return null;
    const t = this.fallStart !== null ? (now - this.fallStart) / 1000 + 0.1 : now - this.fallEnd < 1200 ? this.fallLen / 1000 + 0.1 : 0;
    return 0.5 * GRAVITY * t * t;
  }

  // ---- through a portal ----------------------------------------------------------------------
  /**
   * The furthest you have got between two readings in a row since the last look: { from: [x, y],
   * yards, speed (yards a second) } - or null where there has been none, or no reading before it.
   * @param since  the time of the newest reading the last look had
   */
  #leap(since) {
    const t = this.track;
    let best = null;
    for (let i = 1; i < t.length; i++) {
      if (t[i].t <= since) continue;
      const d = Math.hypot(t[i].x - t[i - 1].x, t[i].y - t[i - 1].y), s = Math.max(0.02, (t[i].t - t[i - 1].t) / 1000);
      if (!best || d > best.yards) best = { from: [t[i - 1].x, t[i - 1].y], yards: d, speed: d / s };
    }
    return best;
  }

  /**
   * Have you just stepped through a portal to another floor (teleports.json)? The floor it put
   * you on: { z, loose (the map has no floor there: the height it is said to put you at) } - or null.
   */
  #hopped(me, since) {
    const list = this.app.world?.teleports;
    if (!list?.length || this.z === null || !this.at) return null;
    const leap = this.#leap(since);
    if (!leap || leap.speed < HOP_SPEED || leap.yards < HOP_STEP) return null;
    for (const t of list) {
      if (t.map !== me.map) continue;
      // at its doorstep, on its level, a moment ago...
      if (Math.hypot(leap.from[0] - t.from[0], leap.from[1] - t.from[1]) > (t.radius ?? 5) + DOORSTEP || Math.abs(this.z - t.from[2]) > DOOR_LEVEL) continue;
      // ...and now where it puts you down
      if (Math.hypot(me.x - t.to[0], me.y - t.to[1]) > HOP_REACH) continue;
      const can = standable(this.#surfaces(me.x, me.y, me).all);
      // (the floor you were on carries on under here: only a longer leap says you are not still on it)
      if (leap.yards < HOP_STEP_SAME && can.some((v) => v >= this.z - SAME_DOWN && v <= this.z + SAME_UP)) continue;
      const floor = can.reduce((b, v) => (Math.abs(v - t.to[2]) <= HOP_FLOOR && (b === null || Math.abs(v - t.to[2]) < Math.abs(b - t.to[2])) ? v : b), null);
      return { z: floor ?? t.to[2], loose: floor === null };
    }
    return null;
  }

  // ---- riding --------------------------------------------------------------------------------
  /** The route carrying you right now, or null. */
  #riding(me, now) {
    const routes = this.app.routes;
    if (!routes) return null;
    if (me.taxi) {
      // The game says you are on a flight path: you are on its route, whatever else looks likely.
      // (of paths that run together, the ones the journey in hand flies along: route.js)
      const m = routes.nearest(me.map, me.x, me.y, this.ride, 500, this.app.route?.flightPaths ?? null);
      if (m) { m.flight = true; return m; }
      return { flight: true, lost: true, z: Math.max(this.z ?? -Infinity, this.#ground(me.x, me.y)) };
    }
    // Zeppelins and boats: nothing says so, but you are moving along one of their routes faster
    // than you can travel by yourself (and keep being carried while it eases in to a stop).
    if (this.ride && !this.ride.flight) {
      if (this.speed < RIDE_KEEP) return null;
      return routes.nearest(me.map, me.x, me.y, this.ride, RIDE_NEAR * 1.5);
    }
    if (this.course && this.speed >= RIDE_SPEED) {
      const m = routes.nearest(me.map, me.x, me.y, null, RIDE_NEAR);
      if (m && Math.abs(m.dir[0] * this.course[0] + m.dir[1] * this.course[1]) > 0.7) {
        if (this.fastSince === null) this.fastSince = now;
        return now - this.fastSince >= RIDE_AFTER ? m : null;
      }
    }
    this.fastSince = null;
    return null;
  }

  /** The ride is over: put you on the ground where it set you down. */
  #land(me, ride) {
    const node = ride.flight ? this.app.routes.nodeNear(me.map, me.x, me.y, 30) : null;
    this.gap = 0;
    this.unsure = false;
    this.at = [me.x, me.y];
    if (ride.lost && !node) { this.z = null; return; } // no idea how high: start afresh
    // A flight master stands on the ground you land on; otherwise the route's own height.
    const expect = node ? node.pos[2] : ride.z;
    let near = null;
    for (const s of standable(this.#surfaces(me.x, me.y, me).all)) if (Math.abs(s - expect) <= LAND_REACH && (near === null || Math.abs(s - expect) < Math.abs(near - expect))) near = s;
    this.z = near ?? expect;
    this.loose = near === null; // nothing there (yet): hold this height until a surface comes within reach
    // (a boat or a zeppelin has not set you down at all: it has slowed for its stop, with you on its deck - see update)
    this.aboard = this.loose && !ride.flight && !ride.lost && ride.path ? ride : null;
    this.sure = near !== null;
    this.how = near !== null ? 'landed' : 'set down';
  }

  // ---- walking -------------------------------------------------------------------------------
  /**
   * Where you end up having moved one small step to a spot with these surfaces, from height
   * `from`. Only surfaces with headroom count: the floor under the first treads of a staircase,
   * or under a counter, is not somewhere you can be. In order of preference:
   *   1. the ground carries on at about the same height (a tread up or down): stay on it;
   *   2. something stands between your feet and your head: you have stepped up onto it;
   *   3. the ground has ended: you have dropped to the next surface below;
   *   4. there is nothing below either: the lowest surface above.
   * The storey above never qualifies for 1 or 2, so it stays over your head. 3 and 4 need the
   * ground to have been missing for `DROP_AFTER` yards of travel (`moved` is how far this step
   * went): floors have hairline gaps, at the riser of a step or where two pieces meet. And a
   * drop of more than a step needs the game to have reported you falling for long enough.
   *
   * 4 has a limit of its own. Something far overhead with nothing under you is one of two things.
   * A lift has carried you up: then wherever you walk now there is nothing at your old height.
   * Or you are inside a building on a part of it the map has no floor for (the foot of a pillar,
   * the side of a dais, a stretch of wall your position clipped), and what is overhead is its
   * roof, or the mountain it is dug into: Ironforge's streets are 330 yards under the terrain.
   * So a rise of more than `RISE_MAX` is never taken while the game says you are indoors and it
   * would put you under the open sky; and inside a building's bounds only after `HOLD_MAX` yards
   * of travel with nothing at your height or below (a lift), not at the first gap.
   * @param me    the reading (for whether the game says you are indoors)   @param x, y  the spot
   */
  #step(all, from, moved, now, me, x, y) {
    const can = standable(all);
    if (this.loose) {
      // Set down where the map had no surface: take the nearest real one once it is within reach.
      let near = null;
      for (const s of can) if (Math.abs(s - from) <= LAND_REACH && (near === null || Math.abs(s - from) < Math.abs(near - from))) near = s;
      if (near !== null) { this.loose = false; this.aboard = null; this.gap = 0; this.sure = true; this.how = 'landed'; return near; }
      // (still on the deck of what carried you: nothing has been walked on nothing yet)
      if (this.aboard) return from;
      this.gap += moved;
      if (this.gap < HOLD_MAX) return from;
      // Walked a long way on nothing: given up. What is nearest the height you were held at is
      // where you are - the tower's platform a little over the deck, not the ground far under it.
      this.loose = false;
      const nearest = can.reduce((b, v) => (b === null || Math.abs(v - from) < Math.abs(b - from) ? v : b), null);
      if (nearest !== null) { this.gap = 0; this.lost = 0; this.how = 'landed'; return nearest; }
    }
    let same = null, up = null, below = null, above = null;
    for (const z of can) {
      if (z < from - SAME_DOWN) below = z;
      else if (z <= from + SAME_UP) same = z;
      else if (z <= from + HEADROOM) { if (up === null) up = z; }
      else if (above === null) above = z;
    }
    if (same !== null || up !== null) { this.gap = 0; this.lost = 0; return same ?? up; }
    this.gap += moved;
    if (below !== null) this.lost = 0; else this.lost += moved;
    const fallen = this.#fallen(now);
    // The game has reported a fall that covers the drop: you are down there, however little of
    // the way past the edge has been seen (but more than a hairline gap's worth).
    if (below !== null && fallen !== null && this.gap >= 0.25 && fallen >= from - below - 0.5) { this.gap = 0; return below; }
    if (this.gap < DROP_AFTER) return from;
    const to = below ?? above;
    if (to === null) return from;
    // No sign of a fall that could cover it: you are on something the map does not have.
    if (below !== null && fallen !== null && this.gap < HOLD_MAX && from - below > FREE_DROP + fallen) return from;
    if (below === null && above - from > RISE_MAX) {
      // only something far overhead (see above): the open sky is not where you are while the game says indoors...
      if (me?.indoors && above === all[all.length - 1]) return from;
      // ...and inside a building it takes a good walk on nothing before a lift is believed
      if (this.lost < HOLD_MAX && this.#within(x, y, from)) return from;
    }
    this.gap = 0;
    this.lost = 0;
    return to;
  }

  /** True if a point is inside the box of a building placed on the map (its floors may not cover every spot of it). */
  #within(x, y, z) {
    for (const w of this.app.objects?.wmos ?? []) {
      const b = w.bounds;
      if (x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] - 3 && z <= b[5] + 3) return true;
    }
    return false;
  }

  /**
   * You are known to be at about this height here (you are talking to someone whose own height is
   * certain): the floor nearest it becomes your height, whatever was thought before.
   * @returns the height taken
   */
  anchor(x, y, z) {
    let best = null;
    for (const s of this.standableAt(x, y)) if (Math.abs(s - z) <= RISE_MAX && (best === null || Math.abs(s - z) < Math.abs(best - z))) best = s;
    this.z = best ?? z;
    this.at = [x, y];
    this.gap = 0; this.lost = 0;
    this.loose = false; this.aboard = null; this.unsure = false; this.airborne = false;
    this.sure = true;
    this.how = 'next to someone';
    return this.z;
  }

  // ---- arriving ------------------------------------------------------------------------------
  #loadSaved() {
    if (this.saved !== undefined) return;
    this.saved = null;
    this.spots = new Map();
    try {
      this.saved = JSON.parse(localStorage.getItem(HEIGHT_KEY));
      for (const [k, z] of JSON.parse(localStorage.getItem(SPOTS_KEY)) ?? []) this.spots.set(k, z);
    } catch { /* not available: start fresh */ }
  }

  /**
   * A height to start from at a spot reached with no way in between, or null: the one saved
   * for your last position if you are still there, the one from walking through this place
   * before, or a flight master's if you are standing next to one.
   */
  #recall(me, here) {
    this.#loadSaved();
    const s = this.saved;
    if (s && s.map === me.map && Number.isFinite(s.z) && Math.hypot(s.x - me.x, s.y - me.y) <= SAME_SPOT) return { z: s.z, sure: !!s.sure, how: 'same spot' };
    const can = standable(here.all);
    const onto = (z, reach) => can.reduce((best, v) => (Math.abs(v - z) <= reach && (best === null || Math.abs(v - z) < Math.abs(best - z)) ? v : best), null);
    let spot = null, spotD = SPOT * 1.6;
    const cx = Math.round(me.x / SPOT), cy = Math.round(me.y / SPOT);
    for (let j = cy - 1; j <= cy + 1; j++) for (let i = cx - 1; i <= cx + 1; i++) {
      const z = this.spots.get(`${me.map}:${i}:${j}`);
      const d = Math.hypot(i * SPOT - me.x, j * SPOT - me.y);
      if (z !== undefined && d < spotD && onto(z, 2) !== null) { spot = onto(z, 2); spotD = d; }
    }
    if (spot !== null) return { z: spot, sure: true, how: 'been here' };
    const node = this.app.routes?.nodeNear(me.map, me.x, me.y, 8);
    if (node && onto(node.pos[2], 4) !== null) return { z: onto(node.pos[2], 4), sure: true, how: 'flight master' };
    return null;
  }

  #remember(me, z, here, now) {
    this.#loadSaved();
    const s = this.saved;
    if (now - this.savedAt >= 1000 && !(s && s.map === me.map && Math.abs(s.x - me.x) < 0.3 && Math.abs(s.y - me.y) < 0.3 && Math.abs(s.z - z) < 0.3 && !!s.sure === this.sure)) {
      this.savedAt = now;
      this.saved = { map: me.map, x: me.x, y: me.y, z, sure: this.sure };
      try { localStorage.setItem(HEIGHT_KEY, JSON.stringify(this.saved)); } catch { /* private mode: just not remembered */ }
    }
    // Places with more than one possible height are worth remembering once yours is certain:
    // arriving there later by hearthstone or teleport, there is no way in to retrace.
    if (this.sure && z !== here.water && standable(here.all).length > 1) {
      const key = `${me.map}:${Math.round(me.x / SPOT)}:${Math.round(me.y / SPOT)}`;
      const old = this.spots.get(key);
      if (old === undefined || Math.abs(old - z) > 0.3) {
        this.spots.delete(key);
        this.spots.set(key, Math.round(z * 100) / 100);
        if (this.spots.size > SPOTS_MAX) this.spots.delete(this.spots.keys().next().value);
        this.spotsDirty = true;
      }
    }
    if (this.spotsDirty && now - this.spotsSavedAt >= 5000) {
      this.spotsDirty = false;
      this.spotsSavedAt = now;
      try { localStorage.setItem(SPOTS_KEY, JSON.stringify([...this.spots])); } catch { /* same */ }
    }
  }

  // ---- the answer ----------------------------------------------------------------------------
  /**
   * @param me  { map, x, y, z, indoors, taxi, swimming, falling, flying } (z = the game's own
   *            height when it reports one; swimming / falling / flying may be null = not known)
   * @returns your height in yards
   */
  update(me, now = performance.now()) {
    // (the readings that have come since the last look: for telling a leap through a portal - #hopped)
    const since = this.heard;
    if (this.track.length) this.heard = this.track[this.track.length - 1].t;
    if (me.z !== null && me.z !== undefined) { this.pending = false; this.z = me.z; this.at = [me.x, me.y]; this.how = 'game'; return me.z; }
    this.#pace(now);

    const ride = this.#riding(me, now);
    if (ride) {
      this.ride = ride;
      this.pending = false;
      this.loose = false;
      this.aboard = null;
      this.gap = 0;
      this.unsure = false;
      this.sure = false;
      this.z = ride.z;
      this.at = [me.x, me.y];
      this.how = ride.flight ? 'flight path' : 'carried';
      return this.z;
    }
    if (this.ride) { const r = this.ride; this.ride = null; this.#land(me, r); }
    // Slowed down for its stop, a boat or zeppelin has not put you anywhere yet: for as long as
    // you are on its line you are on its deck, at its height. (Where the map has something to
    // stand on within reach of that - its tower, its pier - you have stepped onto it: #step.)
    if (this.loose && this.aboard) {
      const m = this.app.routes?.nearest(me.map, me.x, me.y, this.aboard, ABOARD) ?? null;
      if (m && m.route === this.aboard.route) { this.aboard = m; this.z = m.z; this.gap = 0; this.how = 'aboard'; }
      else this.aboard = null; // off its line: from here on it is as with anything the map does not have
    }

    // Flying under your own control: nothing says how high. Keep the last height (never below
    // the ground) and start afresh where you land.
    if (me.flying) {
      this.airborne = true;
      this.pending = false;
      const g = this.#ground(me.x, me.y);
      this.z = Math.max(this.z ?? g, g);
      this.at = [me.x, me.y];
      this.how = 'flying';
      return this.z;
    }
    if (this.airborne) { this.airborne = false; this.aboard = null; this.z = null; }

    // Through a portal to another floor: there is no way in between to retrace.
    const hop = this.#hopped(me, since);
    if (hop) {
      this.pending = false;
      this.z = hop.z;
      this.at = [me.x, me.y];
      this.gap = 0; this.lost = 0;
      this.loose = hop.loose; this.aboard = null; this.unsure = false;
      this.sure = !hop.loose;
      this.how = 'through a portal';
      return this.z;
    }

    const here = this.#surfaces(me.x, me.y, me);
    this.pending = here.pending;
    if (!here.all.length) return this.z ?? this.#ground(me.x, me.y);
    const { all, zs, terrain } = here;
    const noHistory = this.z === null || this.unsure;
    const recalled = noHistory ? this.#recall(me, here) : null;
    const first = noHistory && recalled === null;
    let z;
    if (!first) {
      z = recalled ? recalled.z : this.z;
      if (recalled) { this.sure = recalled.sure; this.how = recalled.how; }
      const from = recalled ? null : this.at;
      const moved = from ? Math.hypot(me.x - from[0], me.y - from[1]) : 0;
      if (recalled || moved > TRACE_MAX) this.gap = HOLD_MAX; // no way in between to go by: take this spot as it is
      const n = moved > TRACE_STEP && moved <= TRACE_MAX ? Math.ceil(moved / TRACE_STEP) : 1;
      const start = z;
      for (let k = 1; k < n; k++) {
        const t = k / n;
        const px = from[0] + (me.x - from[0]) * t, py = from[1] + (me.y - from[1]) * t;
        z = this.#step(this.#surfaces(px, py, me).all, z, moved / n, now, me, px, py);
      }
      z = this.#step(all, z, moved <= TRACE_MAX ? moved / n : 0, now, me, me.x, me.y);
      if (moved > 0 && moved <= TRACE_MAX && !this.loose) {
        // The straight line retraced above is not exactly the way you went, least of all when
        // readings were lost: it can cut a corner (off the side of a winding ramp, say) and
        // "fall". If walking this far could not have changed your height that much, and there
        // is ground here at a height it could have, you are on that.
        const lo = start - SAME_DOWN - CLIMB * moved, hi = start + SAME_UP + CLIMB * moved;
        if (z < lo || z > hi) {
          const best = standable(all).reduce((b, v) => (v >= lo && v <= hi && (b === null || Math.abs(v - start) < Math.abs(b - start)) ? v : b), null);
          if (best !== null) { z = best; this.gap = 0; }
        }
      }
      if (!recalled && moved > 0) this.how = 'walking';
    } else if (!me.indoors) {
      z = Math.max(...all); // under open sky you are on the topmost surface
      this.how = 'open sky';
    } else {
      // Indoors with no history: the lowest floor that is not buried under the terrain, or, in a
      // cave under the terrain, the cave floor. (Over a cellar the ground level is where the
      // terrain would have been: the floor at street level is likelier than the cellar.)
      const ground = here.level ?? -Infinity;
      const above = zs.filter((v) => v >= ground - 2);
      z = above.length ? Math.min(...above) : zs.length ? Math.max(...zs) : all[0];
      this.how = 'indoors';
    }
    if (first) { this.gap = 0; this.sure = false; }

    if (here.water !== null && !this.loose) {
      if (me.swimming) {
        // The game says you are swimming: you are at the surface, whatever the tracing made of it.
        if (z !== here.water) { z = here.water; this.gap = 0; }
        this.how = 'swimming';
      } else if (me.swimming === false && z === here.water && here.depth >= AFLOAT) {
        // On deep water without swimming: something the map does not have is carrying you (a
        // boat). The pier you step onto from it is a little above the water.
        const pier = standable(all).find((v) => v > here.water + SAME_UP && v <= here.water + FLOAT_REACH);
        if (pier !== undefined) { z = pier; this.gap = 0; this.how = 'stepped ashore'; }
        else this.how = 'afloat';
      }
    }

    // Only one place you can be here: from now on the height is certain until a guess is needed.
    if (standable(all).length === 1 && !this.loose) this.sure = true;
    // While a building here is still loading the first guess may be wrong: decide again after.
    this.unsure = noHistory && here.pending;
    this.z = z;
    this.at = [me.x, me.y];
    if (!this.unsure && !this.loose) this.#remember(me, z, here, now);
    return z;
  }
}
