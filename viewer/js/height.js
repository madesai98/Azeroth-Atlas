// How high your character is. The game tells addons where you are on the map but not your
// height (if a future version does, it is simply used), so it is worked out here from what the
// game does report and what the map knows - and every few seconds held against a measurement:
//
//   measured  The game's own marker, pointed at a flight master or a landmark of its map, says
//             how far off that is, and that distance counts height. The addon points it at a
//             few of them for a frame each (Height.lua) and sends what is left of each distance
//             once the way across the map is taken off: how far above or below that place you
//             are. Of the places to stand at your spot, the one at that height is where you
//             are, whatever was worked out before; where the map has nothing there, you are on
//             something it does not have, at that height; under water it is your depth. All
//             the rest is how your height is followed between two such measurements, and where
//             there are none (an older addon, a map with no such places):
//
//   riding    On a flight path (the game says so) or carried by a zeppelin or boat: the route's
//             own 3D points give the height. That something carries you shows in two ways: the
//             game says you are not moving while the map sees you move (it counts your speed
//             from the deck you stand on), or you move faster than you could yourself, along
//             its route. Where it sets you down, you are on the ground at the flight master's
//             height, or at the route's height where the map has no ground to offer. A zeppelin
//             slows down long before its tower: you are on its deck, at its height, for as long
//             as you are on its line - until you step onto something the map does have.
//   walking   The way from your previous position is retraced in small steps over the surfaces
//             you could be standing on (terrain, the floors, stairs and bridges in the buildings'
//             collision data, the surface of deep water, and - from the map's walkable-ground
//             data - what the game places as objects: docks, rope bridges, scaffolds), staying
//             on the ground as it rises and falls. Where the ground carries on under such an
//             object with no room to stand between the two, you are on the object. Where the
//             ground ends and the game has not said you fell, you are taken to be on something
//             the map does not have, for a while.
//   in the    The game says when you are in the air (a jump, a fall) and when that ends, and the
//   air       addon whether it began with a jump. Nothing is decided while you are up there. Where
//             you come down, how long you were in the air says how far you fell, and the surface
//             at that height there is the one you landed on: a jump over a gap lands on the far
//             side, not at the bottom of the gap.
//   swimming  At the surface while the game says your head is above it. Under it, how fast the
//             game says you move, less how fast you move across the map, is how fast you sink or
//             rise - which of the two by the key you hold, else by where you are: down from the
//             surface, up from the bottom. Never above the surface, never under the bottom.
//   a lift    Carries you a long way up or down with no step across the map, and nothing the game
//             reports says so. The map knows where the lifts are and how far each goes
//             (world.json: lifts): having stood still on one, where you step off decides which
//             end you are at - the end that has a floor there.
//   stepping  Through a portal that puts you on another floor of the same building (the Mage
//   through   Tower in Stormwind and the Wizard's Sanctum under it): a few yards across the map
//             and a long way up or down, in no time. The map knows those portals and where they
//             lead (teleports.json): at one's doorstep on its level, then all at once where it
//             puts you down, you have gone through.
//   arriving  After a jump with no way in between (teleport, hearthstone, login, new map): the
//             height remembered for that spot from an earlier visit, else a flight master's
//             there, else the topmost surface outdoors and the lowest sensible floor indoors.
//
// More than one answer. Where the height is a guess (arriving somewhere with several floors,
// stepping off a lift, giving up on ground that was not there) the other floors at that spot
// are followed alongside, each as if it were the one you are on, and what the game goes on to
// say is held against every one of them: a floor that ends under you where another carries on, a
// wall between two spots you were at one after the other (the walkable-ground data knows the
// walls of each floor), a room the game counts as indoors while it says you are outdoors, a
// room of another name than the one the game shows over its minimap. The floor that fits best
// is where you are; when another comes to fit clearly better, you are moved to it.
//
// That is done only from a moment at which the height really was a guess, and for forty yards
// of walking from it: if nothing has told the floors apart by then, the guess stands. A floor
// you walked to step by step is never put in doubt by any of this - the walkable-ground data's
// walls are a yard coarse, and the map's idea of which rooms the game counts as indoors is right
// on Stormwind's streets and wrong in some of its shops (whose floor is a piece of the
// street's). For the same reason the game's word on indoors is only ever taken the one way
// round that holds: it says outdoors, so you are not on the floor of an indoor room.

const HEADROOM = 1.6;    // yards of clear space a character needs above a surface to stand on it
const SAME_UP = 0.6;     // over one traced step the ground you are on rises at most this much...
const SAME_DOWN = 0.8;   // ...or falls at most this much (stairs, the steepest walkable slopes)
const DROP_AFTER = 0.75; // yards you must travel with no ground at your height before it counts as a drop
const TRACE_STEP = 0.25; // yards between the points checked along the way from the last reading
const TRACE_MAX = 30;    // yards: after a longer gap the way in between is not retraced
const LEAP = 120;        // yards between two readings that nothing explains: a fresh start (teleport, hearthstone)
const CLIMB = 1.2;       // yards of rise or fall per yard travelled on the steepest walkable ground
const WADE = 1.5;        // water deeper than this: you swim instead of walking on the bottom
const AFLOAT = 2.5;      // water at least this deep and you are not swimming: something is carrying you
const FLOAT_REACH = 8;   // stepping off a boat: the pier is at most this far above the water
const GRAVITY = 19.3;    // yards per second squared, the game's
const JUMP_UP = 7.96;    // yards a second: how fast a jump leaves the ground
const TERMINAL = 60.15;  // yards a second: nothing falls faster
const JUMP_TOP = 1.7;    // yards above where it began that a jump can come down
const LAND_NEAR = 1.2;   // yards between where a fall should have ended and a surface, for that to be where it ended...
const LAND_SLACK = 0.09; // ...and seconds by which the fall's length may be out (the game is read 18 times a second)
const FREE_DROP = 2;     // a drop this small needs no sign of falling
const HOLD_MAX = 20;     // yards travelled with nothing known under you before giving up and taking the surface below
const RISE_MAX = 4;      // yards: further up than this in one step is not something you did on foot
const RIDE_SPEED = 17;   // yards per second: faster than anything you ride or run yourself
const RIDE_KEEP = 9;     // once carried, you still are while moving at least this fast along the route
const RIDE_NEAR = 40;    // yards from the route for that to count
const RIDE_AFTER = 1200; // milliseconds of it before it is believed
const CARRY_SPEED = 2.5; // yards a second across the map, at least...
const CARRY_SHARE = 0.35; // ...of which the game owns up to less than this share: something else is moving you
const CARRY_AFTER = 700; // milliseconds of that before it is believed
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
const PROP_APART = 1.2;  // yards from every floor and the terrain for something in the ground data to be a thing of its own (a dock, a bridge)
const PROP_REACH = 0.4;  // ...and how much further than a tread such a thing may be from your height (it is known to an eighth of a yard, a yard across)
const PROP_SAMPLES = 4;  // the cell of the ground data it is in is looked over at this many spots each way...
const PROP_EDGE = 0.25;  // ...from this far outside its edges
const PROP_KEEP = 0.4;   // on such a thing, you still are while it carries on within this much of your height
const COVER_MIN = 1;     // the ground data has nowhere to stand within this much of the ground's height: something covers it...
const COVER_NEAR = 0.5;  // ...(within this much, once you are on what covers it)
const COVER_SLACK = 0.5; // ...and that is what lies up to a character's height and this much over it
const DIVE_MIN = 0.6;    // yards: under water at all, you are at least this far under
const LEVEL_SWIM = 0.3;  // rising or sinking slower than this share of your speed is swimming level
const SETTLED = 120;     // milliseconds with no new reading: you are not moving across the map (the game speaks when something changes)
const WEIGH_EVERY = 250; // milliseconds between two weighings of the other floors while nothing new is said
const LIFT_STILL = 2500; // milliseconds you must have stood on a lift for it to have carried you
const LIFT_NEAR = 3.5;   // yards from the height a lift stops at within which a floor is its landing
const LIFT_WATCH = 14;   // yards from a lift you stood on within which stepping off it is looked for
// The other floors at a spot, followed alongside (see the top of this file)
const ALT_MAX = 5;       // of them, at most
const ALT_APART = 1.5;   // yards between two heights for them to be two floors
const ALT_PRIOR = 2.5;   // how much worse than the floor you are taken to be on another starts out
const SWITCH = 4;        // how much better than it another must come to fit before you are moved there
const PRUNE = 12;        // how much worse another may fit before it is dropped
const FADE = 60;         // seconds over which what was held against a floor is forgotten
const ALT_WALK = 40;     // yards walked since the guess with nothing telling the floors apart: the guess stands
const W_GAP = 1;         // held against a floor: for each yard walked with nothing of it underfoot
const W_WALL = 2;        // ...each wall or edge of it walked through
const W_INSIDE = 3;      // ...each second in a room the game counts as indoors while it says you are outdoors (where other floors are followed)
const W_NAME = 3;        // ...each second in a room of another name than the game shows, where a room of that name is here (likewise)
// Your height as the game measured it (#fixed)
const FIX_EPS = 0.07;    // yards by which the game's distance to a place may differ from the map's own reckoning (measured: up to 0.057 -
                         // the game rounds where you are to a tenth of a yard, and that is the way across the map being out)
const FIX_EPS_FINE = 0.006; // ...where the addon had your spot off the game's map instead, which is not rounded (measured in the game,
                         // running: two places 136 and 4,480 yards off gave the same height to 0.035 yd, which is this way across out by 0.002)
const FIX_TOL = 0.8;     // yards more than that a floor may be from a measured height (you have moved since; you stand on something low)
const FIX_SURE = 1.5;    // a height measured to within this is taken as it is where the map has nothing there
const FIX_UNDER = 3;     // yards under the lowest thing the map has at a spot that a measured height may still be
const FIX_FRESH = 1500;  // milliseconds: a fix is held against the reading it came with, or one this soon after
const FIX_NEAR = 4;      // ...and this near to it, in yards
const BAND_SLACK = 1.5;  // yards a floor may lie outside the heights the minimap's rooms span and still be in them (a room's box is its walls' and floor's)
const HEIGHT_KEY = 'wfmap.height', SPOTS_KEY = 'wfmap.heights';

/** The surfaces of a sorted list that have room for a character above them. */
function standable(all) {
  const out = [];
  for (let i = 0; i < all.length; i++) if (i + 1 >= all.length || all[i + 1] - all[i] >= HEADROOM) out.push(all[i]);
  return out;
}

/** How far up (or, below zero, down) a time in the air takes you, and how fast you are going at the end of it. */
function flight(seconds, jumped) {
  const v0 = jumped ? JUMP_UP : 0, t1 = (v0 + TERMINAL) / GRAVITY;
  if (seconds <= t1) return { rise: v0 * seconds - 0.5 * GRAVITY * seconds * seconds, speed: v0 - GRAVITY * seconds };
  return { rise: v0 * t1 - 0.5 * GRAVITY * t1 * t1 - TERMINAL * (seconds - t1), speed: -TERMINAL };
}

/**
 * What the game calls a place, as the number the addon sends for it (server/strip.js,
 * placeNumber; AzerothAtlas.lua, Place): 1 to 32749, 0 for no words.
 */
export function placeNumber(name) {
  const bytes = new TextEncoder().encode(String(name ?? ''));
  if (!bytes.length) return 0;
  let h = 0;
  for (const b of bytes) h = (h * 31 + b) % 32749;
  return h + 1;
}

export class HeightTracker {
  /**
   * @param app   { scene, floors, objects, routes, world, nav, rooms } (read when needed, so they may be set later)
   * @param opts  note: (about, text, data) => void - where what the tracker decides is written down (the page's notes)
   */
  constructor(app, opts = {}) {
    this.app = app;
    this.noteTo = typeof opts.note === 'function' ? opts.note : null;
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
    this.knowsFalling = false;
    this.fastSince = null;
    this.heard = 0;         // the time of the newest reading that has been taken into account (see #leap)
    this.taken = null;      // the reading last taken into account
    this.trail = [];        // where you were taken to be over the last few seconds: [{ t, z }]
    this.noted = '';
    this.names = null;      // the rooms' names, as numbers (made from app.rooms when first asked)
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
    this.prop = false;     // on something the game places as an object, which only the walkable-ground data has
    this.loose = false;    // set down where the map has no surface: waiting for one to come within reach
    this.aboard = null;    // ...by a boat or zeppelin that has only slowed down: its route, for as long as you are still on its line
    this.airborne = false;
    this.score = 0;        // what has been held against the floor you are taken to be on (see the top of this file)
    this.alts = [];        // the other floors followed alongside: [{ z, gap, lost, score, walked (yards you have walked since it was taken up) }]
    this.fall = null;      // in the air: { from, t0, jumped (true, false, or null: not said) }
    this.dive = null;      // in water: { depth (yards under the surface), down (sinking rather than rising) }
    this.lift = null;      // on or just off a lift: { lift, still (ms stood on it), from (your height when you got on), stood }
    this.carried = null;   // since when the game has said you stand while the map sees you move
    this.clock = null;     // the time of the reading last taken into account
    this.track.length = 0;
    this.speed = 0;
    this.course = null;
    this.fastSince = null;
  }

  #note(key, text, data) {
    if (!this.noteTo || key === this.noted) return;
    this.noted = key;
    try { this.noteTo('height', text, data); } catch { /* the notes are not the tracker's business */ }
  }

  // ---- what the map knows about a spot -------------------------------------------------------
  #ground(x, y) {
    const scene = this.app.scene;
    return scene.heightAt(x, y) ?? scene.planeZ ?? (scene.map.ocean ? scene.map.seaLevel : 0);
  }

  /**
   * Every surface on the vertical line through a spot, lowest first: building floors, the
   * terrain, and the surface of water too deep to stand in (the bottom under it is left out:
   * you swim there, or something carries you). `water` is that level when it is in the list,
   * `bottom` what lies highest under it (null: nothing the map has), `depth` how far under.
   * Where the game cuts a hole in the ground (over a cellar, at the mouth of a cave or a mine)
   * there is no terrain to stand on, though the map can still say how high it would have been:
   * that is `level`, and `terrain` is null. `rooms` says of each building floor which room it
   * is the floor of ([{ z, room }]; null where the floor lookup does not say).
   */
  #surfaces(x, y, me) {
    const scene = this.app.scene;
    const level = scene.heightAt(x, y);
    const terrain = level !== null && scene.holeAt(x, y) ? null : level;
    const F = this.app.floors, O = this.app.objects;
    let zs = [], rooms = null, pending = false;
    if (F && O) {
      if (typeof F.levels === 'function') { const r = F.levels(O.wmos, x, y); rooms = r.levels; zs = rooms.map((l) => l.z); pending = r.pending; }
      else { const r = F.at(O.wmos, x, y); zs = r.zs; pending = r.pending; }
    }
    let all = terrain === null ? zs.slice() : [...zs, terrain];
    // Open water only; indoors (a flooded cave) it counts when the game says you are swimming.
    let water = !me.indoors || me.swimming ? scene.waterAt(x, y) : null;
    let depth = 0, bottom = null;
    if (water !== null) {
      const shallow = all.some((v) => v >= water - WADE && v <= water + 0.3);
      if (shallow && !me.swimming) water = null; // you can stand here
      else {
        const under = all.filter((v) => v < water);
        bottom = under.length ? Math.max(...under) : null;
        depth = bottom === null ? Infinity : water - bottom;
        all = all.filter((v) => v > water);
        all.push(water);
      }
    }
    all.sort((p, q) => p - q);
    return { x, y, all, zs, rooms, terrain, level, water, depth, bottom, pending };
  }

  /**
   * What the walkable-ground data has to stand on at a spot that is neither the terrain nor a
   * building's floor: something the game places as an object (a dock, a rope bridge, a ramp).
   * Heights, lowest first; none where the data is not there (yet).
   */
  #props(sf) {
    if (sf.props) return sf.props;
    let out = this.#objects(sf).filter((z) => !sf.all.some((v) => Math.abs(v - z) < PROP_APART) && (sf.level === null || Math.abs(sf.level - z) >= PROP_APART));
    // The ground data is a yard coarse: what it has in a cell is whatever reaches into that
    // cell anywhere. So a floor of it is only a thing of its own if no floor of a building and
    // no ground comes near its height anywhere in the cell - else it is the edge of a roof over
    // the street beside it, the porch a step further on, the bank of a slope.
    if (out.length) {
      const around = this.#cellSolid(sf.x, sf.y);
      if (around) out = out.filter((z) => around.every((s) => !s.zs.some((v) => Math.abs(v - z) < PROP_APART) && (s.level === null || Math.abs(s.level - z) >= PROP_APART)));
    }
    return (sf.props = out);
  }

  /** What the walkable-ground data has in the cell a spot is in: [{ z, terrain, swim }], or null where it does not say. */
  #navFloors(sf) {
    if (sf.nav === undefined) sf.nav = this.app.nav?.floorsAt?.(sf.x, sf.y) ?? null;
    return sf.nav;
  }

  /**
   * Every place to stand in that cell that is not the terrain's and not water: heights, lowest
   * first. Many of them are the building floors the map has anyway, seen a yard coarse (#props
   * are the ones that are not); taken as they are only for carrying on at the height you are at
   * when the map's own surfaces have ended there - the first plank of a dock at the shore.
   */
  #objects(sf) {
    if (sf.objects) return sf.objects;
    const out = [];
    for (const f of this.#navFloors(sf) ?? []) {
      if (f.terrain || f.swim) continue;
      if (sf.water !== null && f.z < sf.water) continue;
      out.push(f.z);
    }
    return (sf.objects = out);
  }

  /**
   * The ground carries on at height `on` here - but are you on it? Not where something the game
   * places as an object lies over it with no room for you between the two (the beach under the
   * planks of a dock, the bank under the end of a bridge): the top of that, or null. The
   * walkable-ground data says so: it has nowhere to stand at the ground's height anywhere in
   * its cell, and has the object's top just over it. And having walked onto such an object,
   * you are still on it for as long as it carries on at your height and the ground data has
   * nowhere to stand on what is under it.
   */
  #over(S, sf, on, from) {
    const floors = this.#navFloors(sf);
    if (!floors?.length) return null;
    const reach = S.prop ? COVER_NEAR : COVER_MIN;
    if (floors.some((f) => !f.swim && Math.abs(f.z - on) < reach)) return null; // (the ground data stands there too)
    if (S.prop) {
      let best = null;
      for (const z of this.#objects(sf)) if (Math.abs(z - from) <= PROP_KEEP && (best === null || Math.abs(z - from) < Math.abs(best - from))) best = z;
      if (best !== null) return best;
    }
    let over = null;
    for (const z of this.#props(sf)) if (z > on && z <= on + HEADROOM + COVER_SLACK && (over === null || z < over)) over = z;
    return over;
  }

  /**
   * The floors of buildings and the height of the ground at a handful of spots across the cell
   * of the ground data that a spot is in, and a little beyond its edges: [{ zs, level }] - or
   * null where the ground data does not say which cell that is.
   */
  #cellSolid(x, y) {
    const box = this.app.nav?.cellBox?.(x, y);
    if (!box) return null;
    const scene = this.app.scene, F = this.app.floors, O = this.app.objects;
    const key = `${scene.map?.id}:${box[0]}:${box[1]}`, now = performance.now();
    // (asked of the same cell many times in a row while you stand in it: kept for a second)
    if (this.cellSeen && this.cellSeen.key === key && now - this.cellSeen.at < 1000) return this.cellSeen.list;
    const list = [];
    let pending = false;
    const w = box[2] - box[0] + 2 * PROP_EDGE, h = box[3] - box[1] + 2 * PROP_EDGE;
    for (let i = 0; i < PROP_SAMPLES; i++) for (let j = 0; j < PROP_SAMPLES; j++) {
      const px = box[0] - PROP_EDGE + (w * i) / (PROP_SAMPLES - 1), py = box[1] - PROP_EDGE + (h * j) / (PROP_SAMPLES - 1);
      const r = F && O ? F.at(O.wmos, px, py) : null;
      if (r?.pending) pending = true;
      list.push({ zs: r?.zs ?? [], level: scene.heightAt(px, py) });
    }
    this.cellSeen = pending ? null : { key, at: now, list };
    return list;
  }

  /** The heights someone could be standing at on a spot (floors and ground with headroom), lowest first. */
  standableAt(x, y) {
    if (!this.app.scene) return [];
    return standable(this.#surfaces(x, y, { indoors: false, swimming: false }).all);
  }

  /** The room a height at a spot is in ({ inside, wmo, set, id, ... }: floors.js), or null: on the terrain, on an object, or not said. */
  #roomAt(sf, z) {
    let best = null, d = 1.5;
    for (const l of sf.rooms ?? []) { const dz = Math.abs(l.z - z); if (dz <= d) { d = dz; best = l.room; } }
    return best;
  }

  /** The number of a room's name (see placeNumber), or 0: it has none of its own that the map knows. */
  #placeOf(room) {
    const R = this.app.rooms;
    if (!room || !R?.wmo || !room.wmo) return 0;
    if (!this.names || this.names.of !== R) this.names = { of: R, numbers: R.names.map(placeNumber), byWmo: new Map() };
    let table = this.names.byWmo.get(room.wmo);
    if (table === undefined) {
      const list = R.wmo[room.wmo];
      table = null;
      if (list) { table = new Map(); for (let i = 0; i + 2 < list.length; i += 3) table.set(`${list[i]}:${list[i + 1]}`, this.names.numbers[list[i + 2]] ?? 0); }
      this.names.byWmo.set(room.wmo, table);
    }
    if (!table) return 0;
    return table.get(`${room.set}:${room.id}`) ?? table.get(`${room.set}:-1`) ?? 0;
  }

  // ---- how you are moving --------------------------------------------------------------------
  /**
   * A reading from the game has arrived: it is taken into account here and now, so that your
   * height is followed whether or not the map is being drawn, and how long you fell and how fast
   * you move are timed by the game's readings rather than by how often the picture is made.
   * @param me   { map, x, y, z, indoors, taxi, swimming, falling, flying, and - from the current
   *             addon - submerged, jumped, ascend, descend, speed, place, t (when it was read, ms) }
   */
  reading(me, now = performance.now()) {
    const clock = Number.isFinite(me.t) ? me.t : now;
    const t = this.track;
    const last = t[t.length - 1];
    // (stirred: this reading has you somewhere new - the game also speaks when only what it says of how you move has changed)
    this.stirred = !last || last.x !== me.x || last.y !== me.y;
    if (this.stirred) t.push({ t: clock, x: me.x, y: me.y });
    while (t.length > 2 && clock - t[0].t > 1500) t.shift();
    this.heardAt = now;
    this.heardClock = clock;
    this.knowsFalling = me.falling === true || me.falling === false; // (an older addon does not say)
    this.taken = me;
    if (this.app.scene && this.app.scene.map?.id === me.map) {
      this.#advance(me, clock);
      // (where you were taken to be, of late: a measurement is held against the moment it was taken)
      if (this.z !== null) { this.trail.push({ t: clock, z: this.z }); if (this.trail.length > 60) this.trail.shift(); }
      // The game has measured your height (see #fixed): held, once, against where you were when
      // that came - not against somewhere you have got to since.
      if (me.band) this.#banded(me);
      // Not one that came while you are dead. The game then keeps its marker on your body
      // whatever the addon points it at, and its distance is the way to that: taken for the
      // distance to a flight master it had a ghost, running back along the ground, hundreds
      // of yards up - by about as much as the body was far off, and the camera went up there
      // after it and came down again with every measurement (a report of 20 November 2026,
      // in Stranglethorn: 660 yards up at the graveyard, 236 a minute on). The addon measures
      // nothing while you are dead as of its version 28; an older one still sends what it made
      // of the distance, and that is passed over here.
      const fix = me.fix;
      if (fix && fix.n !== this.fixN) {
        this.fixN = fix.n;
        if (me.dead) this.#note('fix:dead', 'a height the game "measured" while you are dead is passed over: its marker is on your body then, and the distance is the way to that', { at: [Math.round(me.x), Math.round(me.y)], places: (fix.refs ?? []).map((r) => `${r.kind} ${r.id}: ${Math.round(r.h * 10) / 10} of ${r.d}`) });
        else if (fix.map === me.map && Math.abs(clock - (fix.t ?? clock)) <= FIX_FRESH && Math.hypot(me.x - fix.x, me.y - fix.y) <= FIX_NEAR) this.#fixed(me, fix, clock);
      }
    }
  }

  // ---- measured -------------------------------------------------------------------------------
  /** Where the game's data has a flight master ('taxi') or a landmark ('poi') of this map: [x, y, z] - or null. */
  #refPos(kind, id, map) {
    const W = this.app.world;
    if (!W) return null;
    if (!this.refs || this.refs.of !== W) this.refs = { of: W, taxi: new Map((W.taxiNodes ?? []).map((n) => [n.id, n])), poi: new Map((W.pois ?? []).map((p) => [p.id, p])) };
    const r = this.refs[kind]?.get(id);
    return r && (r.map ?? 0) === map && Array.isArray(r.pos) ? r.pos : null;
  }

  /**
   * The heights a fix allows: [{ lo, hi }] - none where its places do not agree with each
   * other, null where the map's data has none of its places. Each place says how far above or
   * below it you are, not which: two heights, each known as well as the distance is - which is
   * to about `FIX_EPS` yards, so that a place far off and at about your own height says little
   * (the two run together into one wide stretch), and one near by or far over or under you says
   * a lot. What both places allow is what is left.
   */
  #bands(fix, map, widen = 1) {
    let bands = null;
    for (const ref of fix.refs ?? []) {
      const pos = this.#refPos(ref.kind, ref.id, map);
      if (!pos || !Number.isFinite(ref.h) || !Number.isFinite(ref.d)) continue;
      // (the way across the map is as good as the spot the addon had for you: the game's own, rounded
      // to a tenth of a yard, or the finer one off its map; h comes in 16ths of a yard and d in 8 yards)
      const eps = (ref.fine ? FIX_EPS_FINE : FIX_EPS) * widen;
      const h2 = ref.h * ref.h, more = 2 * (ref.d + 8) * eps + ref.h / 8 + 0.02;
      const top = Math.sqrt(h2 + more), low = h2 > more ? Math.sqrt(h2 - more) : 0;
      const own = low > 0 ? [{ lo: pos[2] - top, hi: pos[2] - low }, { lo: pos[2] + low, hi: pos[2] + top }] : [{ lo: pos[2] - top, hi: pos[2] + top }];
      if (!bands) { bands = own; continue; }
      const both = [];
      for (const a of bands) for (const b of own) { const lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi); if (lo <= hi) both.push({ lo, hi }); }
      bands = both;
    }
    return bands;
  }

  /**
   * The game has measured your height. It does not say it outright - but when its marker is
   * pointed at a flight master or a landmark of its map, the distance it shows counts height,
   * and the addon points it at two of them for a frame each (AzerothAtlas.lua: the fix). That
   * is something measured, where everything else here is worked out: so of the places to stand
   * at this spot, the one at that height is where you are, whatever was thought before. Where
   * the map has nothing at that height, you are on something it does not have - a lift on its
   * way, a ship's deck - at the height measured, if that is known closely enough. Under water
   * it says how deep you are. And where it is not known closely (the places are far off and at
   * about your own height), it still rules out: a floor it does not allow is not followed.
   */
  #fixed(me, fix, clock) {
    let bands = this.#bands(fix, me.map);
    if (bands && !bands.length) bands = this.#bands(fix, me.map, 2.5); // (a little more leeway before two places are said to disagree)
    if (!bands) return;
    const r1 = (v) => Math.round(v * 10) / 10;
    if (!bands.length) { this.#note(`fix:odd:${fix.refs.map((r) => r.id).join()}`, 'the game\'s distances to two places do not agree on your height: left aside', { places: fix.refs.map((r) => `${r.kind} ${r.id}: ${r1(r.h)} of ${r.d}`) }); return; }
    // (the spot it was taken at, and where you were taken to be then: you may have gone on a few yards, and up or down, since)
    const fx = Number.isFinite(fix.x) ? fix.x : me.x, fy = Number.isFinite(fix.y) ? fix.y : me.y;
    let then = this.z, off0 = Infinity;
    if (Number.isFinite(fix.t)) for (const p of this.trail) { const o = Math.abs(p.t - fix.t); if (o < off0 && o <= 400) { off0 = o; then = p.z; } }
    const here = this.#surfaces(fx, fy, me);
    // (A place says how far over or under it you are, not which. Under everything the map has
    // at this spot you are not: that answer is dropped, where it leaves another.)
    if (bands.length > 1) {
      const floor = Math.min(...here.all, here.bottom ?? Infinity, here.level ?? Infinity);
      const over = Number.isFinite(floor) ? bands.filter((b) => b.hi >= floor - FIX_UNDER) : bands;
      if (over.length) bands = over;
    }
    const within = (z) => bands.some((b) => z >= b.lo - FIX_TOL && z <= b.hi + FIX_TOL);
    const off = (z) => Math.min(...bands.map((b) => (z < b.lo ? b.lo - z : z > b.hi ? z - b.hi : 0)));
    // (one height, known closely: the middle of it)
    const one = bands.length === 1 && bands[0].hi - bands[0].lo <= 2 * FIX_SURE ? (bands[0].lo + bands[0].hi) / 2 : null;
    this.fix = { bands, one, at: clock };
    // (on a route, its own heights are better; in the air, where you come down is settled when you do)
    if (this.ride || me.taxi || (this.fall && me.falling) || this.z === null) return;
    if (me.flying) { if (one !== null) { this.z = one; this.how = 'flying, measured'; } return; }
    if (me.swimming && here.water !== null) {
      // in water: how deep (under it at all, you are at least a little under)
      if (this.dive && one !== null && me.submerged) {
        const deep = Number.isFinite(here.depth) ? Math.max(0, here.depth) : Infinity;
        this.dive.depth = Math.min(deep, Math.max(Math.min(DIVE_MIN, deep), here.water - one));
        this.dive.at = clock;
        this.z = here.water - this.dive.depth;
        this.how = 'under water, measured';
        this.#note(`fix:dive:${Math.round(this.dive.depth)}`, 'under water, the game measured how deep you are', { depth: r1(this.dive.depth), surface: r1(here.water) });
      }
      return;
    }
    const props = this.#props(here);
    const fits = [...standable(here.all).filter((z) => this.#over({ prop: false }, here, z, z) === null), ...props].filter(within);
    this.alts = this.alts.filter((a) => within(a.z));
    if (within(then)) {
      // where you were taken to be is what the game measured: with nothing else here that it could be, that is certain
      if (!this.loose && !here.pending && !fits.some((z) => Math.abs(z - then) >= ALT_APART)) { this.sure = true; this.alts = []; this.score = 0; }
      return;
    }
    const was = then;
    if (fits.length) {
      fits.sort((a, b) => off(a) - off(b) || Math.abs(a - was) - Math.abs(b - was));
      this.z = fits[0];
      this.prop = props.includes(fits[0]);
      this.alts = fits.slice(1).filter((z) => Math.abs(z - fits[0]) >= ALT_APART).slice(0, ALT_MAX).map((z) => ({ z, gap: 0, lost: 0, score: ALT_PRIOR, loose: false, aboard: null, walked: 0 }));
      this.sure = !this.alts.length && !here.pending;
    } else if (one !== null) {
      this.z = one;
      this.prop = false;
      this.alts = [];
      this.sure = false;
    } else return; // (it only rules out, and rules out everything the map has here: left as it was)
    this.score = 0;
    this.gap = 0; this.lost = 0; this.loose = false; this.aboard = null; this.unsure = false;
    this.lift = null; this.dive = null;
    // (you are followed on from the spot it was taken at: the way from there to where you are now is retraced with the next reading)
    this.at = [fx, fy];
    this.trail.length = 0;
    this.how = 'measured';
    this.#note(`fix:${Math.round(was)}:${Math.round(this.z)}`, fits.length ? 'the game measured your height: you are on the floor at that height, not where you were taken to be' : 'the game measured your height, and the map has nothing to stand on there: you are on something it does not have', { from: r1(was), to: r1(this.z), allowed: bands.map((b) => `${r1(b.lo)} to ${r1(b.hi)}`), alsoFollowed: this.alts.map((a) => r1(a.z)) });
  }

  /** Speed and course over the last second and a half of readings. */
  #pace(clock) {
    const t = this.track;
    const a = t[0], b = t[t.length - 1];
    if (t.length >= 2 && clock - b.t < 500 && b.t - a.t >= 400) {
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      this.speed = d / ((b.t - a.t) / 1000);
      this.course = d > 0.5 ? [(b.x - a.x) / d, (b.y - a.y) / d] : null;
    } else { this.speed = 0; this.course = null; }
  }

  /**
   * How fast you are moving across the map as of the reading in hand, yards a second: 0 where it
   * has you on the spot the last one had you on (every step across the map is a reading of its
   * own), else over the last third of a second - or null where that cannot be told yet (the
   * first step after standing).
   */
  #across() {
    if (!this.stirred) return 0;
    const t = this.track;
    const b = t[t.length - 1];
    let a = b;
    for (let i = t.length - 2; i >= 0 && b.t - t[i].t <= 350; i--) a = t[i];
    return a === b || b.t - a.t < 40 ? null : Math.hypot(b.x - a.x, b.y - a.y) / ((b.t - a.t) / 1000);
  }

  /**
   * In water, time has passed: you have sunk or risen by so much. (The game speaks when
   * something changes. Between two readings nothing has: you went on as the last one had you
   * going - and, once a moment has passed with no new one, straight up or down, for a step
   * across the map would have been a reading.)
   */
  #sink(clock) {
    const d = this.dive;
    if (!d || clock <= d.at) return;
    const settled = d.heard + SETTLED;
    const slant = Math.max(0, Math.min(clock, settled) - d.at) / 1000, plumb = Math.max(0, clock - Math.max(d.at, settled)) / 1000;
    d.depth = Math.min(d.deep, Math.max(d.under ? Math.min(DIVE_MIN, d.deep) : 0, d.depth + d.rate * slant + d.plumb * plumb));
    d.at = clock;
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
  #riding(me, clock) {
    const routes = this.app.routes;
    if (!routes) return null;
    if (me.taxi) {
      // The game says you are on a flight path: you are on its route, whatever else looks likely.
      // (of paths that run together, the ones the journey in hand flies along: route.js)
      const m = routes.nearest(me.map, me.x, me.y, this.ride, 500, this.app.route?.flightPaths ?? null);
      if (m) { m.flight = true; return m; }
      return { flight: true, lost: true, z: Math.max(this.z ?? -Infinity, this.#ground(me.x, me.y)) };
    }
    // Zeppelins and boats. The game counts how fast you move from the deck you stand on: it says
    // you are standing (or strolling) while the map sees you cross the water. That says so at
    // any speed, and from the first second.
    const own = Number.isFinite(me.speed) ? me.speed : null;
    const moved = own !== null && this.speed >= CARRY_SPEED && own < this.speed * CARRY_SHARE && !me.falling && !me.swimming;
    if (moved) { if (this.carried === null) this.carried = clock; } else this.carried = null;
    const carried = this.carried !== null && clock - this.carried >= CARRY_AFTER;
    if (this.ride && !this.ride.flight) {
      // (once carried: for as long as you still are, or - where the game does not say - while you keep up a speed along the route)
      if (!(carried || moved) && this.speed < RIDE_KEEP) return null;
      return routes.nearest(me.map, me.x, me.y, this.ride, RIDE_NEAR * 1.5);
    }
    if (carried && this.course) {
      const m = routes.nearest(me.map, me.x, me.y, null, RIDE_NEAR);
      if (m && Math.abs(m.dir[0] * this.course[0] + m.dir[1] * this.course[1]) > 0.7) return m;
    }
    // Nothing says so, but you are moving along one of their routes faster than you can travel
    // by yourself (and keep being carried while it eases in to a stop).
    if (this.course && this.speed >= RIDE_SPEED) {
      const m = routes.nearest(me.map, me.x, me.y, null, RIDE_NEAR);
      if (m && Math.abs(m.dir[0] * this.course[0] + m.dir[1] * this.course[1]) > 0.7) {
        if (this.fastSince === null) this.fastSince = clock;
        return clock - this.fastSince >= RIDE_AFTER ? m : null;
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
    // (a boat or a zeppelin has not set you down at all: it has slowed for its stop, with you on its deck - see #advance)
    this.aboard = this.loose && !ride.flight && !ride.lost && ride.path ? ride : null;
    this.sure = near !== null;
    this.how = near !== null ? 'landed' : 'set down';
  }

  // ---- walking -------------------------------------------------------------------------------
  /**
   * Where a floor being followed (S: the one you are taken to be on, or another followed
   * alongside) ends up having moved one small step to a spot with these surfaces, from height
   * `from`. Only surfaces with headroom count: the floor under the first treads of a staircase,
   * or under a counter, is not somewhere you can be. In order of preference:
   *   1. the ground carries on at about the same height (a tread up or down): stay on it;
   *   2. something stands between your feet and your head: you have stepped up onto it;
   *   3. the walkable-ground data has something at about this height that is neither terrain
   *      nor a building's floor (a dock, a bridge the game places as an object): you are on that;
   *   4. the ground has ended: you have dropped to the next surface below;
   *   5. there is nothing below either: the lowest surface above.
   * The storey above never qualifies for 1 or 2, so it stays over your head. 4 and 5 need the
   * ground to have been missing for `DROP_AFTER` yards of travel (`moved` is how far this step
   * went): floors have hairline gaps, at the riser of a step or where two pieces meet. And a
   * drop of more than a step with no fall reported is not one: you are taken to be on something
   * the map does not have, for up to `HOLD_MAX` yards. (A fall the game did report is settled
   * where it ends: #landed.)
   *
   * 5 has a limit of its own. Something far overhead with nothing under you is one of two things.
   * A lift has carried you up: then wherever you walk now there is nothing at your old height.
   * Or you are inside a building on a part of it the map has no floor for (the foot of a pillar,
   * the side of a dais, a stretch of wall your position clipped), and what is overhead is its
   * roof, or the mountain it is dug into: Ironforge's streets are 330 yards under the terrain.
   * So a rise of more than `RISE_MAX` is never taken while the game says you are indoors and it
   * would put you under the open sky; and inside a building's bounds only after `HOLD_MAX` yards
   * of travel with nothing at your height or below (a lift), not at the first gap.
   * @param sf    the surfaces at the spot (#surfaces)   @param me  the reading (for whether the game says you are indoors)
   */
  #step(S, sf, from, moved, me) {
    const all = sf.all, can = standable(all), mine = S === this;
    if (S.loose) {
      // Set down where the map had no surface: take the nearest real one once it is within reach.
      let near = null;
      for (const s of can) if (Math.abs(s - from) <= LAND_REACH && (near === null || Math.abs(s - from) < Math.abs(near - from))) near = s;
      if (near !== null) { S.loose = false; S.aboard = null; S.gap = 0; if (mine) { this.sure = true; this.how = 'landed'; } return near; }
      // (still on the deck of what carried you: nothing has been walked on nothing yet)
      if (S.aboard) return from;
      S.gap += moved;
      if (S.gap < HOLD_MAX) return from;
      // Walked a long way on nothing: given up. What is nearest the height you were held at is
      // where you are - the tower's platform a little over the deck, not the ground far under it.
      S.loose = false;
      const nearest = can.reduce((b, v) => (b === null || Math.abs(v - from) < Math.abs(b - from) ? v : b), null);
      if (nearest !== null) { S.gap = 0; S.lost = 0; if (mine) { this.how = 'landed'; this.guessed = true; } return nearest; }
    }
    let same = null, up = null, below = null, above = null;
    for (const z of can) {
      if (z < from - SAME_DOWN) below = z;
      else if (z <= from + SAME_UP) same = z;
      else if (z <= from + HEADROOM) { if (up === null) up = z; }
      else if (above === null) above = z;
    }
    if (same !== null || up !== null) {
      S.gap = 0; S.lost = 0;
      // (unless something placed there lies over it, with no room for you under it: #over)
      const over = this.#over(S, sf, same ?? up, from);
      // (onto it from the ground under it, all at once: not a height you walked up - see #advance)
      if (over !== null && mine && !S.prop) this.lifted = true;
      S.prop = over !== null;
      return over ?? same ?? up;
    }
    // Nothing of the terrain or of a building at this height. A dock, a bridge, a ramp the game
    // places as an object? The walkable-ground data has those: whatever it has to stand on in
    // this cell at about your height, you have walked on onto - where the other thing to think
    // would be that you are on the water, or have dropped further than a step with no fall
    // said, or are on nothing at all. (Not where there is a step down to take: what the ground
    // data has at your height a yard past the edge of a floor is that floor, seen coarsely. And
    // only once the ground has been missing for a step or two: a hairline gap is not its end.)
    let prop = null;
    for (const z of this.#objects(sf)) if (z >= from - SAME_DOWN - PROP_REACH && z <= from + SAME_UP + PROP_REACH && (prop === null || Math.abs(z - from) < Math.abs(prop - from))) prop = z;
    // (what you could drop onto: the things of their own among them as well)
    for (const z of this.#props(sf)) if (z < from - SAME_DOWN - PROP_REACH && (below === null || z > below)) below = z;
    if (prop !== null) {
      const far = below === null || (sf.water !== null && below === sf.water) || from - below > FREE_DROP;
      if (S.prop || (far && S.gap + moved >= DROP_AFTER)) { S.gap = 0; S.lost = 0; S.prop = true; return prop; }
    }
    S.gap += moved;
    if (below !== null) S.lost = 0; else S.lost += moved;
    if (S.gap < DROP_AFTER) return from;
    const to = below ?? above;
    if (to === null) return from;
    // No fall reported that could cover it: you are on something the map does not have.
    if (below !== null && this.knowsFalling && S.gap < HOLD_MAX && from - below > FREE_DROP) return from;
    if (below === null && above - from > RISE_MAX) {
      // only something far overhead (see above): the open sky is not where you are while the game says indoors...
      if (me?.indoors && above === all[all.length - 1]) return from;
      // ...and inside a building it takes a good walk on nothing before a lift is believed
      if (S.lost < HOLD_MAX && this.#within(sf.x, sf.y, from)) return from;
    }
    // (given up on ground that was not there, or carried up by something: a guess, and the other floors here may be
    // the answer - after a drop, those you could have dropped to: nothing over where you were)
    if (mine && Math.abs(to - from) > FREE_DROP) { this.guessed = true; this.guessUnder = to < from ? from : null; }
    S.gap = 0;
    S.lost = 0;
    S.prop = false;
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
    this.fall = null; this.dive = null; this.lift = null;
    this.alts = []; this.score = 0;
    this.sure = true;
    this.how = 'next to someone';
    this.#note(`anchor:${Math.round(this.z)}`, 'you are next to someone whose height is known: yours is theirs', { z: Math.round(this.z * 10) / 10 });
    return this.z;
  }

  // ---- by the rooms on the minimap --------------------------------------------------------------
  /**
   * Inside a dungeon your place is read off the game's minimap (server/minimap.js), and the
   * minimap says more than where: the game leaves the rooms above yours off it, so which rooms
   * it shows says which rooms you can be in - and those lie between two heights (me.band:
   * [lowest, highest]). Where the height worked out here is not between them and there is
   * somewhere to stand that is, you are on that: the nearest such place to where you were taken
   * to be. Where two floors lie within the heights, nothing is said, and walking decides as ever.
   */
  #banded(me) {
    const [lo, hi] = me.band;
    if (this.z === null || this.fall || this.dive || this.ride || this.loose) return;
    const inside = (z) => z >= lo - BAND_SLACK && z <= hi + BAND_SLACK;
    // (the other floors followed alongside that the minimap rules out are followed no longer)
    if (this.alts.length) this.alts = this.alts.filter((a) => inside(a.z));
    if (inside(this.z)) return;
    const here = this.#surfaces(me.x, me.y, me);
    if (here.pending) return;
    let best = null;
    for (const z of [...standable(here.all), ...this.#props(here)]) if (inside(z) && (best === null || Math.abs(z - this.z) < Math.abs(best - this.z))) best = z;
    if (best === null) return;
    const was = this.z;
    this.z = best; this.at = [me.x, me.y];
    this.gap = 0; this.lost = 0; this.unsure = false; this.score = 0;
    this.how = 'the rooms on the minimap';
    this.#note(`band:${Math.round(was)}:${Math.round(best)}`, 'the rooms the minimap shows say which floor you are on: you are taken to be on that', { from: Math.round(was * 10) / 10, to: Math.round(best * 10) / 10, between: [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10] });
  }

  // ---- in the air ----------------------------------------------------------------------------
  /**
   * You have come down. How long you were in the air says how far you fell (and a jump first
   * takes you up): of the surfaces here, the one at that height is where you are. Where the
   * addon does not say whether it began with a jump, either may be so.
   * @param S  a floor being followed: S.z is where it was when you left the ground
   * @returns { z, fits (how well: under 1 is a fit), others: [heights that fit about as well] }
   */
  #landing(S, sf, seconds, jumped) {
    const from = S.z, top = from + JUMP_TOP;
    // (not onto ground that something placed there lies over with no room for you: onto that thing - #over)
    const cands = [...standable(sf.all).filter((z) => this.#over({ prop: false }, sf, z, z) === null), ...this.#props(sf)].filter((z) => z <= top);
    if (!cands.length) return { z: from, fits: Infinity, others: [] };
    const ways = jumped === true ? [true] : jumped === false ? [false] : [false, true];
    const cost = (z) => Math.min(...ways.map((j) => { const f = flight(seconds, j); return Math.abs(z - (from + f.rise)) / (LAND_NEAR + Math.abs(f.speed) * LAND_SLACK); }));
    const ranked = cands.map((z) => ({ z, c: cost(z) })).sort((a, b) => a.c - b.c || Math.abs(a.z - from) - Math.abs(b.z - from));
    // (only one place to come down on here: that is it, however long the fall seemed)
    if (ranked.length === 1) return { z: ranked[0].z, fits: Math.min(ranked[0].c, 0.99), others: [] };
    return { z: ranked[0].z, fits: ranked[0].c, others: ranked.slice(1).filter((r) => r.c < Math.max(1, ranked[0].c * 2.5) && Math.abs(r.z - ranked[0].z) > ALT_APART).map((r) => r.z) };
  }

  #landed(me, sf, clock) {
    const f = this.fall;
    this.fall = null;
    const seconds = Math.max(0.03, (clock - f.t0) / 1000);
    const was = this.z;
    const mine = this.#landing(this, sf, seconds, f.jumped);
    // the other floors followed alongside come down too, each from where it was
    for (const a of this.alts) {
      const l = this.#landing(a, sf, seconds, f.jumped);
      a.z = l.z; a.gap = 0; a.lost = 0;
      if (l.fits > 1) a.score += Math.min(6, l.fits * 2);
    }
    this.z = mine.z;
    this.gap = 0; this.lost = 0; this.loose = false; this.aboard = null;
    if (mine.fits > 1) this.score += Math.min(6, mine.fits * 2);
    if (Math.abs(mine.z - was) > FREE_DROP) {
      this.how = 'landed';
      this.#note(`fall:${Math.round(mine.z)}`, 'a fall, settled where it ended', { from: Math.round(was * 10) / 10, to: Math.round(mine.z * 10) / 10, seconds: Math.round(seconds * 100) / 100, jumped: f.jumped, fits: Math.round(mine.fits * 100) / 100, others: mine.others.map((z) => Math.round(z * 10) / 10) });
    }
    // (a fall that fits more than one surface, or none well: the others you could have come down on are followed alongside)
    if (mine.others.length || mine.fits > 1) this.#doubt(sf, 'a fall that could have ended on more than one surface', mine.others.length ? mine.others : [...standable(sf.all), ...this.#props(sf)].filter((v) => v <= f.from + JUMP_TOP), 1.5);
  }

  // ---- the other floors, followed alongside --------------------------------------------------
  /**
   * The height is a guess: the other places to stand at this spot are followed alongside from
   * here on (see the top of this file).
   * @param only  these heights alone (else every other place to stand here)
   */
  #doubt(sf, why, only = null, prior = ALT_PRIOR) {
    if (this.z === null) return;
    const here = only ?? [...standable(sf.all), ...this.#props(sf)];
    let added = 0;
    for (const z of here) {
      if (sf.water !== null && z === sf.water) continue;
      if (Math.abs(z - this.z) < ALT_APART || this.alts.some((a) => Math.abs(a.z - z) < ALT_APART)) continue;
      this.alts.push({ z, gap: 0, lost: 0, score: this.score + prior, loose: false, aboard: null, walked: 0 });
      added++;
    }
    if (this.alts.length > ALT_MAX) { this.alts.sort((a, b) => a.score - b.score || Math.abs(a.z - this.z) - Math.abs(b.z - this.z)); this.alts.length = ALT_MAX; }
    if (added) { this.sure = false; this.#note(`doubt:${why}:${Math.round(this.z)}`, `${why}: the other floors here are followed too`, { z: Math.round(this.z * 10) / 10, others: this.alts.map((a) => Math.round(a.z * 10) / 10) }); }
  }

  /**
   * What the game says is held against every floor being followed, and the one that fits best
   * is where you are.
   * @param seconds  since the last reading   @param walls  how many walls each walked through on the way here (Map: floor -> count)
   */
  #judge(me, sf, seconds, moved, walls) {
    this.weighed = this.clock;
    const fade = Math.exp(-seconds / FADE);
    const rooms = sf.rooms ?? [];
    const place = Number.isFinite(me.place) && me.place > 0 ? me.place : 0;
    const named = place ? rooms.some((l) => this.#placeOf(l.room) === place) : false;
    // (a floor you walked to, with no other followed: nothing is held against it - see the top of this file)
    if (!this.alts.length) { this.score = 0; return; }
    for (const S of [this, ...this.alts]) {
      // what is solid: nothing of this floor underfoot, a wall of it walked through
      let pen = 0;
      if (S.gap > 0 && !S.loose) pen += moved * W_GAP;
      pen += (walls?.get(S) ?? 0) * W_WALL;
      // and what the game says of the room
      const room = this.#roomAt(sf, S.z);
      if (me.indoors === false && room?.inside) pen += seconds * W_INSIDE;
      if (named && this.#placeOf(room) !== place) pen += seconds * W_NAME;
      S.score = S.score * fade + pen;
      if (S !== this) S.walked = (S.walked ?? 0) + moved;
    }
    // floors that have come to the same height are one; ones that fit far worse are dropped, and
    // so are ones that nothing has told from yours for a good walk: the guess stands
    this.alts = this.alts.filter((a) => {
      if (Math.abs(a.z - this.z) < 0.7 && !a.loose) { if (a.score < this.score) this.score = a.score; return false; }
      if (a.walked >= ALT_WALK && a.score >= this.score - 1) return false;
      return a.score <= this.score + PRUNE;
    });
    for (let i = 0; i < this.alts.length; i++) for (let j = this.alts.length - 1; j > i; j--) {
      if (Math.abs(this.alts[i].z - this.alts[j].z) < 0.7) { this.alts[i].score = Math.min(this.alts[i].score, this.alts[j].score); this.alts.splice(j, 1); }
    }
    let best = null;
    for (const a of this.alts) if (a.score + SWITCH < this.score && !(a.gap > 0) && (!best || a.score < best.score)) best = a;
    if (best) {
      const was = { z: this.z, gap: this.gap, lost: this.lost, score: this.score, loose: this.loose, aboard: this.aboard, walked: 0 };
      this.z = best.z; this.gap = best.gap; this.lost = best.lost; this.score = best.score; this.loose = false; this.aboard = null;
      this.alts = this.alts.filter((a) => a !== best);
      this.alts.push(was);
      this.how = 'fits better';
      this.#note(`switch:${Math.round(was.z)}:${Math.round(this.z)}`, 'another floor here fits what the game says better: you are taken to be on that', { from: Math.round(was.z * 10) / 10, to: Math.round(this.z * 10) / 10, against: Math.round(was.score * 10) / 10, now: Math.round(this.score * 10) / 10 });
    }
    if (!this.alts.length) this.score = 0;
  }

  // ---- lifts ---------------------------------------------------------------------------------
  /** The lift whose platform you may be standing on, or null. */
  #liftAt(me) {
    if (this.z === null) return null;
    for (const l of this.app.world?.lifts ?? []) {
      if (l.map !== me.map || Math.hypot(me.x - l.x, me.y - l.y) > (l.r ?? 7) + 1) continue;
      if (this.z >= l.lo - 6 && this.z <= l.hi + 6) return l;
    }
    return null;
  }

  /**
   * On a lift: have you stood on it? (By the clock: while you stand the game says nothing new.
   * So it is the time between two steps across the map, both on the lift, that counts - or
   * between the last step onto it and the first off it.)
   */
  #onLift(me, clock) {
    const l = this.lift?.lift ?? this.#liftAt(me);
    if (!l) return;
    if (!this.lift) this.lift = { lift: l, from: this.z, stood: false, moved: null };
    const L = this.lift;
    if (!this.stirred) return;
    const on = Math.hypot(me.x - l.x, me.y - l.y) <= (l.r ?? 7);
    if (L.moved !== null && clock - L.moved >= LIFT_STILL) L.stood = true;
    L.moved = on ? clock : null;
  }

  /**
   * Stepping off a lift you stood on: which of its two ends you are at is the one that has a
   * floor here. Both have one: the other end is followed alongside (it starts out the likelier:
   * you stood on a lift, and lifts go somewhere).
   */
  #offLift(me, sf) {
    const L = this.lift;
    if (!L) return;
    const d = Math.hypot(me.x - L.lift.x, me.y - L.lift.y);
    if (d > (L.lift.r ?? 7) + LIFT_WATCH) { this.lift = null; return; }
    if (!L.stood || d <= (L.lift.r ?? 7) - 2) return;
    const can = [...standable(sf.all), ...this.#props(sf)];
    // the stops you did not get on at (two ends - or more: the scaffold cars of the Searing Gorge call at four heights)
    const stops = Array.isArray(L.lift.stops) && L.lift.stops.length >= 2 ? L.lift.stops : [L.lift.lo, L.lift.hi];
    const on = stops.reduce((b, v) => (Math.abs(v - L.from) < Math.abs(b - L.from) ? v : b));
    const off = (v) => stops.reduce((b, s) => (s === on ? b : Math.min(b, Math.abs(v - s))), Infinity);
    const there = can.reduce((b, v) => (off(v) <= LIFT_NEAR && (b === null || off(v) < off(b)) ? v : b), null);
    if (there === null || Math.abs(there - this.z) < ALT_APART) return;
    const here = can.some((v) => v >= this.z - SAME_DOWN && v <= this.z + SAME_UP);
    const was = this.z;
    if (here) this.alts.push({ z: was, gap: this.gap, lost: this.lost, score: this.score + 1, loose: false, aboard: null, walked: 0 });
    this.z = there; this.gap = 0; this.lost = 0; this.loose = false; this.aboard = null;
    this.alts = this.alts.filter((a) => Math.abs(a.z - there) >= ALT_APART);
    this.sure = !here && !this.alts.length;
    this.how = 'lift';
    this.lift = null;
    this.#note(`lift:${Math.round(was)}:${Math.round(there)}`, 'you stood on a lift and stepped off where its other end has a floor: it carried you', { lift: L.lift.name, from: Math.round(was * 10) / 10, to: Math.round(there * 10) / 10, alsoFollowed: here ? Math.round(was * 10) / 10 : null });
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
   * Where a portal puts you down, if that is within reach of where you are: its height (or null).
   * The portals of teleports.json, and the doorways between maps (world.json) of maps this game has.
   */
  #portal(me) {
    const W = this.app.world, maps = new Set((this.app.manifest?.maps ?? []).map((m) => m.id));
    let best = null, bestD = HOP_REACH;
    const near = (x, y, z) => { const d = Math.hypot(me.x - x, me.y - y); if (d < bestD && Number.isFinite(z)) { bestD = d; best = z; } };
    for (const t of W?.teleports ?? []) if (t.map === me.map) near(t.to[0], t.to[1], t.to[2]);
    for (const p of W?.portals ?? []) if (p.to.map === me.map && (!maps.size || maps.has(p.from.map))) near(p.to.pos[0], p.to.pos[1], p.to.pos[2]);
    return best;
  }

  /**
   * A height to start from at a spot reached with no way in between, or null: the one saved
   * for your last position if you are still there; where a portal puts you down, if you are
   * there (through the Skyborne Portal from Dalaran you are in the Wizard's Sanctum, under
   * Stormwind's streets: the street over it is the floor the map would take otherwise); the one
   * from walking through this place before; or a flight master's if you are standing next to one.
   */
  #recall(me, here) {
    this.#loadSaved();
    const s = this.saved;
    if (s && s.map === me.map && Number.isFinite(s.z) && Math.hypot(s.x - me.x, s.y - me.y) <= SAME_SPOT) return { z: s.z, sure: !!s.sure, how: 'same spot' };
    const can = standable(here.all);
    const onto = (z, reach) => can.reduce((best, v) => (Math.abs(v - z) <= reach && (best === null || Math.abs(v - z) < Math.abs(best - z)) ? v : best), null);
    const landing = this.#portal(me), floor = landing === null ? null : onto(landing, HOP_FLOOR);
    if (floor !== null) return { z: floor, sure: true, how: 'where a portal puts you down' };
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
    if (this.sure && z !== here.water && !this.dive && standable(here.all).length > 1) {
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
   * Your height now, in yards. (It is worked out as the readings come - reading() - so this only
   * hands it over; a reading that has not been taken into account yet, or one whose first guess
   * was made while a building was still loading, is worked out here.)
   * @param me  the reading: { map, x, y, z, indoors, taxi, swimming, falling, flying, ... } (z = the
   *            game's own height when it reports one; swimming / falling / flying may be null = not known)
   */
  update(me, now = performance.now()) {
    if (me !== this.taken) this.reading(me, now);
    else if (this.pending || this.unsure || this.z === null) { if (this.app.scene?.map?.id === me.map) this.#advance(me, this.clock ?? (Number.isFinite(me.t) ? me.t : now)); }
    else this.#idle(me, (this.heardClock ?? now) + (now - (this.heardAt ?? now)));
    // (no word from the game for half a second: you are not moving)
    if (this.heardAt !== undefined && now - this.heardAt > 500 && this.speed) { this.speed = 0; this.course = null; }
    return this.z ?? (this.app.scene ? this.#ground(me.x, me.y) : 0);
  }

  /**
   * Time has passed and the game has said nothing new: what goes on by the clock goes on. Under
   * water you sink or rise as you were; in the air you are shown where the fall has got to; and
   * the other floors at this spot go on being weighed against what the game last said.
   */
  #idle(me, clock) {
    if (this.app.scene?.map?.id !== me.map || this.z === null) return;
    if (this.dive && me.swimming) { this.#sink(clock); this.z = this.dive.water - this.dive.depth; this.how = this.dive.depth > 0.3 ? 'under water' : 'swimming'; return; }
    if (this.fall && me.falling) {
      const f = flight((clock - this.fall.t0) / 1000, this.fall.jumped === true);
      this.z = Math.max(this.fall.from + f.rise, this.fall.floor ?? -Infinity);
      return;
    }
    if (this.alts.length && clock - (this.weighed ?? 0) >= WEIGH_EVERY) {
      const seconds = Math.min(1, Math.max(0, (clock - (this.weighed ?? clock)) / 1000));
      const here = this.#surfaces(me.x, me.y, me);
      if (!here.pending && here.all.length) { this.#judge(me, here, seconds, 0, null); this.weighed = clock; if (!this.alts.length && !this.loose) this.#remember(me, this.z, here, clock); }
    }
  }

  /** A reading taken into account: the height it leaves you at is this.z. */
  #advance(me, clock) {
    // (the readings that have come since the last look: for telling a leap through a portal - #hopped)
    const since = this.heard;
    if (this.track.length) this.heard = this.track[this.track.length - 1].t;
    const seconds = this.clock === null ? 0 : Math.min(1, Math.max(0, (clock - this.clock) / 1000));
    this.clock = clock;
    if (me.z !== null && me.z !== undefined) { this.pending = false; this.z = me.z; this.at = [me.x, me.y]; this.how = 'game'; this.alts = []; this.fall = null; this.dive = null; return; }
    this.#pace(clock);
    // Somewhere else all at once: nothing of where you were says anything about here.
    if (this.at && Math.hypot(me.x - this.at[0], me.y - this.at[1]) > LEAP && !me.taxi && !this.ride) {
      const track = this.track.slice(-1), knows = this.knowsFalling;
      this.reset();
      this.track.push(...track); this.knowsFalling = knows; this.clock = clock;
    }

    const ride = this.#riding(me, clock);
    if (ride) {
      if (!this.ride) this.#note(`ride:${ride.flight ? 'flight' : ride.path?.id ?? 'boat'}`, ride.flight ? 'on a flight path: its route gives your height' : 'something is carrying you along its route: that gives your height', { flight: !!ride.flight, path: ride.path?.id ?? null, game: Number.isFinite(me.speed) ? me.speed : null, map: Math.round(this.speed * 10) / 10 });
      this.ride = ride;
      this.pending = false;
      this.loose = false;
      this.aboard = null;
      this.gap = 0;
      this.unsure = false;
      this.sure = false;
      this.alts = []; this.fall = null; this.dive = null; this.lift = null;
      this.z = ride.z;
      this.at = [me.x, me.y];
      this.how = ride.flight ? 'flight path' : 'carried';
      return;
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
      this.alts = []; this.fall = null; this.dive = null;
      this.how = 'flying';
      return;
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
      this.alts = []; this.fall = null; this.dive = null; this.lift = null; this.score = 0;
      this.sure = !hop.loose;
      this.how = 'through a portal';
      this.#note(`portal:${Math.round(hop.z)}`, 'through a portal to another floor', { z: Math.round(hop.z * 10) / 10, onAFloor: !hop.loose });
      return;
    }

    const here = this.#surfaces(me.x, me.y, me);
    this.pending = here.pending;
    if (!here.all.length) {
      // (nothing of the map here at all - a lift's shaft: you are held where you were)
      if (this.z === null) this.z = this.#ground(me.x, me.y);
      else if (!this.fall) this.#onLift(me, clock);
      this.at = this.at ?? [me.x, me.y];
      return;
    }
    const { all, zs } = here;
    const noHistory = this.z === null || this.unsure;
    const recalled = noHistory ? this.#recall(me, here) : null;
    const first = noHistory && recalled === null;

    // In the air (the game says so): nothing is decided up there. Where you come down, how long
    // you were up says how far you fell (#landed).
    if (!noHistory && this.knowsFalling && !this.loose) {
      if (me.falling && !me.swimming) {
        // (seen a moment after it began, as its end will be seen a moment after it ends: the two cancel out)
        if (!this.fall) this.fall = { from: this.z, t0: clock, jumped: me.jumped === true ? true : me.jumped === false ? false : null };
        else if (me.jumped === true) this.fall.jumped = true;
        // (shown where the fall has got to, and never under everything there is here)
        const f = flight((clock - this.fall.t0) / 1000, this.fall.jumped === true);
        this.fall.floor = Math.min(...all, this.fall.from);
        this.z = Math.max(this.fall.from + f.rise, this.fall.floor);
        this.at = [me.x, me.y];
        this.how = 'in the air';
        return;
      }
      if (this.fall) {
        const from = this.fall.from;
        this.z = from; // (each floor followed comes down from where it left the ground)
        this.#landed(me, here, clock);
        this.at = [me.x, me.y];
        if (!me.swimming) { this.#after(me, here, clock, seconds, 0, null, false); return; }
      }
    } else if (this.fall && !me.falling) this.fall = null;

    let z, moved = 0, walls = null;
    this.guessed = false;
    this.guessUnder = null;
    this.lifted = false;
    if (!first) {
      z = recalled ? recalled.z : this.z;
      if (recalled) { this.sure = recalled.sure; this.how = recalled.how; this.alts = []; this.score = 0; }
      const from = recalled ? null : this.at;
      moved = from ? Math.hypot(me.x - from[0], me.y - from[1]) : 0;
      if (recalled || moved > TRACE_MAX) { this.gap = HOLD_MAX; for (const a of this.alts) a.gap = HOLD_MAX; } // no way in between to go by: take this spot as it is
      const n = moved > TRACE_STEP && moved <= TRACE_MAX ? Math.ceil(moved / TRACE_STEP) : 1;
      const start = z;
      const nav = this.alts.length && moved > 0 && moved <= 4 ? this.app.nav : null; // (walls are only looked for while other floors are followed, and where the way walked is known step by step)
      let px = from ? from[0] : me.x, py = from ? from[1] : me.y;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const qx = k === n ? me.x : from[0] + (me.x - from[0]) * t, qy = k === n ? me.y : from[1] + (me.y - from[1]) * t;
        const sf = k === n ? here : this.#surfaces(qx, qy, me);
        const step = moved <= TRACE_MAX ? moved / n : 0;
        if (nav?.open) {
          for (const S of [this, ...this.alts]) {
            const zS = S === this ? z : S.z;
            if (nav.open(px, py, qx, qy, zS) === false && !S.loose) { (walls ??= new Map()).set(S, (walls.get(S) ?? 0) + 1); }
          }
        }
        z = this.#step(this, sf, z, step, me);
        for (const a of this.alts) a.z = this.#step(a, sf, a.z, step, me);
        px = qx; py = qy;
      }
      if (moved > 0 && moved <= TRACE_MAX && !this.loose) {
        // The straight line retraced above is not exactly the way you went, least of all when
        // readings were lost: it can cut a corner (off the side of a winding ramp, say) and
        // "fall". If walking this far could not have changed your height that much, and there
        // is ground here at a height it could have, you are on that.
        const lo = start - SAME_DOWN - CLIMB * moved, hi = start + SAME_UP + CLIMB * moved;
        if ((z < lo || z > hi) && !this.lifted) {
          const best = standable(all).reduce((b, v) => (v >= lo && v <= hi && (b === null || Math.abs(v - start) < Math.abs(b - start)) ? v : b), null);
          if (best !== null) { z = best; this.gap = 0; this.guessed = false; }
        }
      }
      if (!recalled && moved > 0) this.how = this.prop ? 'on something placed there' : 'walking';
      if (recalled && !recalled.sure) this.guessed = true;
    } else if (!me.indoors) {
      z = Math.max(...all); // under open sky you are on the topmost surface
      this.how = 'open sky';
      this.guessed = standable(all).length > 1;
    } else {
      // Indoors with no history: the lowest floor that is not buried under the terrain, or, in a
      // cave under the terrain, the cave floor. (Over a cellar the ground level is where the
      // terrain would have been: the floor at street level is likelier than the cellar.)
      const ground = here.level ?? -Infinity;
      const above = zs.filter((v) => v >= ground - 2);
      z = above.length ? Math.min(...above) : zs.length ? Math.max(...zs) : all[0];
      this.how = 'indoors';
      this.guessed = standable(all).length > 1;
    }
    if (first) { this.gap = 0; this.sure = false; this.alts = []; this.score = 0; }
    this.z = z;
    this.at = [me.x, me.y];
    this.#after(me, here, clock, seconds, moved, walls, first);
  }

  /** What follows every step: the water, the lifts, the other floors, and what is remembered. */
  #after(me, here, clock, seconds, moved, walls, first) {
    let z = this.z;
    const all = here.all;
    const noHistory = first;
    if (here.water !== null && !this.loose) {
      if (me.swimming) {
        // The game says you are swimming. At the surface while your head is above it; under it,
        // how fast the game says you move, less how fast you cross the map, is how fast you
        // sink or rise (see the top of this file).
        const deep = Number.isFinite(here.depth) ? Math.max(0, here.depth) : Infinity;
        const dive = this.dive ?? (this.dive = { depth: 0, rate: 0, plumb: 0, at: clock, heard: clock, deep, under: false, water: here.water });
        dive.deep = deep; dive.water = here.water;
        this.#sink(clock); // (as the reading before this one had you going, up to now)
        dive.under = me.submerged === true;
        dive.rate = 0; dive.plumb = 0;
        if (!dive.under) dive.depth = 0;
        else {
          const own = Number.isFinite(me.speed) ? me.speed : null;
          if (own !== null && own > 0.5) {
            // Sinking, unless the key that takes you up is held: under water there is no telling
            // a slant down from a slant up, and you went under to get down there. (So coming up
            // without that key you are shown where you were deepest until your head is out.)
            const way = me.ascend === true ? -1 : 1;
            const across = this.#across();
            let up = across === null ? 0 : Math.sqrt(Math.max(0, own * own - Math.min(own, across) ** 2));
            if (up < own * LEVEL_SWIM) up = 0;
            dive.rate = way * up;
            dive.plumb = way * own;
          }
          dive.depth = Math.min(deep, Math.max(Math.min(DIVE_MIN, deep), dive.depth));
        }
        dive.at = clock; dive.heard = clock;
        z = here.water - dive.depth;
        this.gap = 0; this.lost = 0;
        this.alts = [];
        this.how = dive.depth > 0.3 ? 'under water' : 'swimming';
        if (dive.depth > 0.3) this.#note(`dive:${Math.round(here.water)}`, 'under water: how fast you sink and rise is worked out from your speed', { surface: Math.round(here.water * 10) / 10, bottom: here.bottom === null ? null : Math.round(here.bottom * 10) / 10 });
      } else {
        // out of the water: on whatever you came up onto, from where you were in it
        if (this.dive) { this.dive = null; if (z < here.water && here.bottom !== null && Math.abs(z - here.bottom) < HEADROOM) z = here.bottom; }
        if (me.swimming === false && z === here.water) {
          // On water too deep to stand in, and not swimming. Where the ground data has something
          // placed over the water here - a dock - you are on that. Else, on deep water, something
          // the map does not have is carrying you (a boat), and the pier you step onto from it
          // is a little above the water.
          const within = (v) => v > here.water + SAME_UP && v <= here.water + FLOAT_REACH;
          const dock = this.#props(here).find(within);
          const pier = here.depth >= AFLOAT ? standable(all).find(within) : undefined;
          if (pier !== undefined) { z = pier; this.gap = 0; this.how = 'stepped ashore'; }
          else if (dock !== undefined) { z = dock; this.gap = 0; this.prop = true; this.how = 'on something placed there'; }
          else if (here.depth >= AFLOAT) this.how = 'afloat';
        }
      }
    } else if (this.dive) this.dive = null;
    this.z = z;

    // A lift: stood on, it may have carried you to its other end (#offLift)
    if (!this.dive && !this.loose) {
      this.#onLift(me, clock);
      if (this.lift) this.#offLift(me, here);
    }

    // The other floors at this spot: followed alongside where the height is a guess
    if (!this.dive && !this.fall) {
      if (this.guessed && !this.alts.length) {
        const under = this.guessUnder ?? null;
        this.#doubt(here, first ? 'arriving with no way in between' : 'a guess', under === null ? null : [...standable(here.all), ...this.#props(here)].filter((v) => v <= under));
      }
      this.#judge(me, here, seconds, moved, walls);
    }
    this.guessed = false;
    this.guessUnder = null;

    // Only one place you can be here: from now on the height is certain until a guess is needed.
    if (standable(all).length === 1 && !this.loose && !this.dive && !this.#props(here).length) { this.sure = true; this.alts = []; this.score = 0; }
    else if (this.alts.length) this.sure = false;
    // While a building here is still loading the first guess may be wrong: decide again after.
    this.unsure = noHistory && here.pending;
    if (!this.unsure && !this.loose) this.#remember(me, this.z, here, clock);
  }
}
