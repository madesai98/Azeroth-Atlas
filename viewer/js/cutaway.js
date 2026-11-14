// The cutaway: what is taken off the picture so that your character can be seen.
//
// Nothing is taken away that is not in the way. Out in the streets of a city nothing is, most of
// the time; step behind a building and a hole opens in it, along the line from the camera to
// you, and closes again when you come out. What is taken away, and when:
//
//   the line of sight   A building or an object stands between the camera and you (found by
//                       casting that line through the triangles a building is drawn with, and
//                       an object's collision shape: sight.js), or the ground does - a hill, a
//                       bank, the side of a valley (found by following that line over the
//                       terrain's heights):
//                       a hole along the line, narrow at you and widening toward the camera - as
//                       wide as what is in the way is far from you. The ground is only cut where
//                       it is the ground that is in the way; what stands on the part of it that
//                       goes, goes with it.
//   the room            You are in a room of a building (the game's own division of buildings
//                       into rooms, and its flag for the indoor ones: floors.js): the ceiling and
//                       everything over it go - of the whole building where that is a house, an
//                       inn, a tower; within the room's own outline where the building is a whole
//                       city. A small room is opened just over your head; a hall under its
//                       ceiling, up to a height that leaves its walls standing.
//   the city            You are in a city or a cave system under the ground (Ironforge, the
//                       Undercity, a dungeon: a building whose big rooms lie under the terrain):
//                       the ground over all of it goes, and everything of it higher than the
//                       roofs of its shops - the whole city lies open. Step into one of its shops
//                       and that room is opened too.
//   the circle          Tree tops within a few yards of you, as before, and along the line of
//                       sight always: a canopy has no collision to find it by. (And everything
//                       over your head in that circle, where you are indoors or under the ground
//                       and no room can be made out.)
//
// The shaders do the cutting (gpu.js: cutAway); this works out what they are to cut, a few times
// a second, and eases it in and out.
import { Sight } from './sight.js';
import { CUT_NARROW as NARROW, CUT_WIDEN as WIDEN } from './gpu.js'; // the hole along the line of sight is drawn in close to you: this wide at you (yards), widening this fast toward the camera
import { SMALL_ROOM } from './places.js';

const UP_ROOM = 3;        // yards over your feet: a small room is opened here (and the circle cuts from here up)
const UP_HALL = 18;       // a hall, and a city under the ground: here (over the roofs of its shops)
const UP_AWAY = 60;       // a box comes down from here when it opens, and goes back up to close
const CEILING = 1.5;      // a hall with a ceiling lower than that is opened this far under it
const REACH = 70;         // how far up a ceiling is looked for
const UNDER = 4;          // yards of ground over you before you count as under it
const MARGIN = 1.5;       // a room's box reaches this far beyond the room (its walls, the roof on them)
const LOOK_MS = 120;      // how often the place and the line of sight are looked at
const SETTLE_MS = 250;    // a room has to be left this long before it closes (a doorway, a jump)
const HOLD_MS = 500;      // the line of sight stays open this long after the way is clear again
const WIDE = 0.2;         // the hole along the line of sight: no wider than this, as a share of the distance from the camera to you (half the hole, that is: its radius)
const WIDE_MIN = 6, WIDE_MAX = 80;
const SPAN_AT = 4, SPAN_PER = 1.4; // ...and as wide as what is in the way is far from you: this (yards), and this much more for every yard
const BUILDING = 4 * SMALL_ROOM; // square yards: a building no bigger than this on the ground is opened as a whole, not room by room
const FAR = 900;          // from further off, no line of sight is kept (you are a dot on the map by then)
const CHEST = 1.2, HEAD = 2;
const STEP = 2;           // yards between the spots of the line of sight tried against the ground
const GRAZE = 0.3;        // the line has to go this far under the ground before the ground counts as in the way

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const shut = () => ({ on: false, want: false, up: UP_AWAY, to: UP_AWAY, x: 0, y: 0, hx: 0, hy: 0, cos: 1, sin: 0, left: 0 });
// A hole along the line of sight: 0 shut .. 1 open; how wide it is to be (yards: by how far off what is in the way is), and is just now; and until when it stays open.
const hole = () => ({ open: 0, span: 0, spanNow: 0, until: 0 });

export class Cutaway {
  constructor(app) {
    this.app = app;
    this.on = false;
    this.radius = 30;          // of the circle, yards
    this.sight = new Sight(app.models);
    this.room = shut();        // the room you are in
    this.city = shut();        // the city under the ground you are in
    this.cityOf = null;        // (which building that is)
    this.all = false;          // the circle takes everything, not the trees alone
    this.under = false;        // you are under the ground: it is cut as well
    this.line = hole();        // the line of sight: the hole along it through whatever stands in the way...
    this.land = hole();        // ...and through the ground, where that is in the way
    this.at = null;            // where you are, while there is anything to cut
    this.why = '';             // what is being cut, in a few words (for whoever asks)
    this.looked = 0;
  }

  /** The hole along the line of sight, for whoever asks: how far open it is, and how wide it is to be. */
  get open() { return this.line.open; }
  get span() { return this.line.span; }
  get spanNow() { return this.line.spanNow; }

  /** Is this object one of the trees? (All objects are, to the circle, while the map has not been told which are: as it used to be.) */
  #tree(fdid) {
    const trees = this.app.models.trees;
    return trees ? trees.has(fdid) : true;
  }

  /**
   * Is this building a city (or a cave system) under the ground: do most of its big indoor
   * rooms lie under the terrain? (On a map with no terrain - a dungeon - any with a big room.)
   */
  #deep(w) {
    if (w.deep !== undefined) return w.deep;
    const m = this.app.models.models.get('wmo' + w.fdid);
    if (!m?.loaded) return false;
    const scene = this.app.scene, M = w.mat, s2 = (w.scale ?? 1) ** 2;
    const bare = !scene.roots.length;
    let big = 0, low = 0, unknown = 0;
    for (const g of m.meta?.groups ?? []) {
      if (!(g.flags & 0x2000) || g.flags & 0x48 || !g.vertexCount) continue; // (indoor rooms: see floors.js)
      const b = g.bbox.flat(), area = Math.abs(b[3] - b[0]) * Math.abs(b[4] - b[1]) * s2;
      if (area < SMALL_ROOM) continue;
      big += area;
      if (bare) { low += area; continue; }
      // (the middle of its floor)
      const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = Math.min(b[2], b[5]);
      const h = scene.heightAt(M[0] * cx + M[1] * cy + M[2] * cz + M[3], M[4] * cx + M[5] * cy + M[6] * cz + M[7]);
      if (h === null) unknown += area;
      else if (h > M[8] * cx + M[9] * cy + M[10] * cz + M[11] + UNDER) low += area;
    }
    if (!big) return (w.deep = false);
    if (unknown > big / 2) return low > 0; // (the ground over it is not all loaded: by what is, for now)
    return (w.deep = low >= big / 2);
  }

  /** Is a spot inside what a box takes away? */
  #inBox(b, x, y, z) {
    if (!b.on || z < this.at[2] + b.up) return false;
    const dx = x - b.x, dy = y - b.y;
    return Math.abs(dx * b.cos + dy * b.sin) < b.hx && Math.abs(dy * b.cos - dx * b.sin) < b.hy;
  }

  #inCircle(x, y, z) {
    const at = this.at;
    return z > at[2] + UP_ROOM && (x - at[0]) ** 2 + (y - at[1]) ** 2 < this.radius ** 2;
  }

  /** Is a spot inside what the boxes (and the circle, where it takes everything) take away? */
  #boxed(x, y, z) {
    return this.#inBox(this.room, x, y, z) || this.#inBox(this.city, x, y, z) || (this.all && this.#inCircle(x, y, z));
  }

  /**
   * How far from a spot (your chest, your head), toward the camera, the ground is in the way:
   * yards, or -1. Under the ground with you, that is where the line comes up through it (where
   * it has not been cut away already). On the ground, where the line first goes under it: a
   * hill, a bank, the side of a valley between the camera and you.
   */
  #ground(a, cam) {
    const scene = this.app.scene, under = this.under;
    const len = Math.hypot(cam[0] - a[0], cam[1] - a[1], cam[2] - a[2]), n = Math.min(450, Math.ceil(len / STEP));
    // (on the ground, the line sets out over it; under it, wherever the first spot tried finds it)
    let below = under ? null : false;
    for (let i = 1; i <= n; i++) {
      const t = i / n, x = a[0] + (cam[0] - a[0]) * t, y = a[1] + (cam[1] - a[1]) * t, z = a[2] + (cam[2] - a[2]) * t;
      const h = scene.heightAt(x, y);
      if (h === null) { below = null; continue; }
      // (grazing the ground is not being hidden by it)
      const now = z < h - (under ? 0 : GRAZE);
      // (the line comes up through the ground here - or goes down into it; the boxes take the ground only while you are under it)
      if (below !== null && now !== below && !scene.holeAt(x, y) && !(under && this.#boxed(x, y, h))) return t * len;
      below = now;
    }
    return -1;
  }

  /** What there is to cut, as things stand: the room, the city, the line of sight. */
  #look(at, me, now) {
    const app = this.app, scene = app.scene, layer = app.objects;
    const [x, y, z] = at;
    const over = scene.heightAt(x, y);
    const bare = !scene.roots.length;
    const under = over !== null && z < over - UNDER;
    const { room, pending } = app.floors.room(layer.wmos, x, y, z);
    let changed = under !== this.under;
    this.under = under;

    // ---- the room you are in
    // (the game has to say "indoors" as well - it knows where you really are, the map only how
    // high you seem to be; under the ground the room alone is gone by: there the game's word
    // cannot tell a shop from the hall it opens on)
    const R = this.room;
    let want = !!room?.inside && (!!me?.indoors || under || bare), why = '';
    if (want) {
      let to = UP_ROOM;
      if (room.area >= SMALL_ROOM) {
        // a hall: under its ceiling, and no higher than leaves its walls standing
        const c = this.sight.hit(layer, [x, y, z + HEAD], [x, y, z + REACH], false, false);
        to = c.t >= 0 ? clamp(HEAD + c.t * (REACH - HEAD) - CEILING, UP_ROOM, UP_HALL) : UP_HALL;
        why = 'a hall';
      } else why = 'a room';
      // (a house, an inn, a tower: all of it is opened at that height - the whole roof comes off,
      // not a square of it; a city that is one building: the room's own outline)
      const b = room.building && room.building.area <= BUILDING ? room.building : room.box;
      if (!R.on) { R.on = true; R.up = UP_AWAY * 0.7; changed = true; }
      if (R.x !== b.x || R.y !== b.y || R.to !== to || !R.want) changed = true;
      R.x = b.x; R.y = b.y; R.hx = b.hx + MARGIN; R.hy = b.hy + MARGIN; R.cos = b.cos; R.sin = b.sin; R.to = to;
      R.want = true; R.left = 0;
    } else if (R.want && !pending) {
      // (out of it: for good, once that has lasted a moment)
      if (!R.left) R.left = now;
      if (now - R.left >= SETTLE_MS) { R.want = false; changed = true; }
    }

    // ---- the city under the ground you are in
    const C = this.city;
    let w = null;
    if (under || bare) {
      const inside = (q) => x >= q.bounds[0] && x <= q.bounds[3] && y >= q.bounds[1] && y <= q.bounds[4] && z >= q.bounds[2] - 2 && z <= q.bounds[5] + 2;
      if (room && this.#deep(room.of)) w = room.of;
      else if (this.cityOf && inside(this.cityOf) && layer.wmos.includes(this.cityOf)) w = this.cityOf;
      else if (!room) w = layer.wmos.find((q) => inside(q) && this.#deep(q)) ?? null;
    }
    if (w) {
      const b = w.bounds;
      if (!C.on) { C.on = true; C.up = UP_AWAY; changed = true; }
      if (this.cityOf !== w || !C.want) changed = true;
      C.x = (b[0] + b[3]) / 2; C.y = (b[1] + b[4]) / 2; C.hx = (b[3] - b[0]) / 2 + MARGIN; C.hy = (b[4] - b[1]) / 2 + MARGIN; C.cos = 1; C.sin = 0; C.to = UP_HALL;
      C.want = true; C.left = 0;
      this.cityOf = w;
      why = why ? `${why} of a city under the ground` : 'a city under the ground';
    } else if (C.want && !pending) {
      if (!C.left) C.left = now;
      if (now - C.left >= SETTLE_MS) { C.want = false; this.cityOf = null; changed = true; }
    }

    // ---- indoors by the game's word, or under the ground, and no room to go by (a tent, a boat's
    // hold, a floor the map has you on that is no indoor room's): everything over your head, in the circle
    if (!pending) {
      const all = !R.want && !C.want && (!!me?.indoors || (under && !room));
      if (all !== this.all) { this.all = all; changed = true; }
      if (all) why = under ? 'under the ground' : 'indoors';
    }

    // ---- the line of sight: is anything left standing between the camera and you?
    const cam = app.camera.pos;
    const dist = Math.hypot(cam[0] - x, cam[1] - y, cam[2] - z - CHEST);
    if (dist > 4 && dist < FAR) {
      // (how far from you the nearest thing in the way is, and the nearest of the ground)
      let near = Infinity, land = Infinity;
      for (const up of [CHEST, HEAD]) {
        const a = [x, y, z + up];
        // (what is taken away already is not in the way: what the boxes and the circle take, and
        // the trees - along this line they are cut whatever else is)
        const skip = (t, o) => {
          if (o && this.#tree(o.fdid)) return true;
          return this.#boxed(a[0] + (cam[0] - a[0]) * t, a[1] + (cam[1] - a[1]) * t, a[2] + (cam[2] - a[2]) * t);
        };
        const t = this.sight.hit(layer, a, cam, false, true, skip).t;
        if (t >= 0) near = Math.min(near, t * dist);
        const g = this.#ground(a, cam);
        if (g >= 0) land = Math.min(land, g);
      }
      // The hole is as wide as what is in the way is far from you: an eave you stand under
      // loses a bite, a house you have walked behind a window you can see the street through.
      const block = (h, far) => {
        const span = clamp(SPAN_AT + far * SPAN_PER, WIDE_MIN, WIDE_MAX);
        if (now >= h.until || Math.abs(span - h.span) > 0.2) changed = true;
        if (now >= h.until && h.open < 0.02) h.spanNow = span; // (opening from shut: at that width from the start)
        h.span = span;
        h.until = now + HOLD_MS;
      };
      // (the ground in the way: a hole through the ground, and through whatever stands on that
      // part of it - a house left in the air where a hill has gone would hide you as well as the hill did)
      if (land < Infinity) { block(this.land, land); near = Math.min(near, land); }
      if (near < Infinity) {
        block(this.line, near);
        const what = land < Infinity ? 'the ground in the way' : 'something in the way';
        why = why ? `${why}; ${what}` : what;
      }
    }
    this.why = why;
    return changed;
  }

  /** Advance. True while the picture has to be drawn again (something is opening or closing). */
  update(dt, now) {
    const P = this.app.player, at = this.on && P?.shown && P.onThisMap && this.app.scene && this.app.objects && this.app.floors ? P.shown : null;
    if (!at) {
      const was = !!this.at;
      this.at = null; this.room = shut(); this.city = shut(); this.cityOf = null; this.all = false; this.under = false; this.line = hole(); this.land = hole(); this.why = '';
      return was;
    }
    this.at = at;
    let moving = false;
    if (now - this.looked >= LOOK_MS) { this.looked = now; if (this.#look(at, P.me, now)) moving = true; }
    for (const b of [this.room, this.city]) {
      if (!b.on) continue;
      const to = b.want ? b.to : UP_AWAY;
      if (Math.abs(to - b.up) > 0.02) { b.up += (to - b.up) * (1 - Math.exp(-dt * 7)); moving = true; } else b.up = to;
      if (!b.want && b.up > UP_AWAY - 6) { b.on = false; b.up = UP_AWAY; moving = true; }
    }
    for (const h of [this.line, this.land]) {
      const want = now < h.until ? 1 : 0;
      if (Math.abs(want - h.open) > 0.004) { h.open += (want - h.open) * (1 - Math.exp(-dt * 10)); moving = true; } else h.open = want;
      if (Math.abs(h.span - h.spanNow) > 0.02) { h.spanNow += (h.span - h.spanNow) * (1 - Math.exp(-dt * 6)); if (h.open > 0) moving = true; } else h.spanNow = h.span;
    }
    return moving;
  }

  /** How wide the hole along the line of sight is at its widest (yards): what the trees are cut by, along it. */
  #widest(cam) {
    const at = this.at;
    const dist = Math.hypot(cam[0] - at[0], cam[1] - at[1], cam[2] - at[2] - CHEST);
    return dist < FAR ? clamp(dist * WIDE, WIDE_MIN, WIDE_MAX) : 0;
  }

  /** ...and how wide one of its holes is just now (0: shut): for everything else (the line), for the ground (the land). */
  #wide(h, cam) { return h.open * Math.min(h.spanNow, this.#widest(cam)); }

  /**
   * What the shaders need (see gpu.js: cut, cutOpts, cutLine, cutRoom, cutCity, cutLand), written into
   * the block of numbers every shader is given, from `o` on. Places are counted from the camera.
   */
  fill(g, o, cam) {
    const at = this.at;
    if (!this.on || !at) { g.fill(0, o, o + 32); return; }
    g[o] = at[0] - cam[0]; g[o + 1] = at[1] - cam[1]; g[o + 2] = at[2] + UP_ROOM - cam[2]; g[o + 3] = this.radius;
    g[o + 4] = this.all ? 1 : 0; g[o + 5] = this.under ? 1 : 0; g[o + 6] = at[2] + 0.3 - cam[2]; g[o + 7] = this.#widest(cam);
    g[o + 8] = at[0] - cam[0]; g[o + 9] = at[1] - cam[1]; g[o + 10] = at[2] + CHEST - cam[2]; g[o + 11] = this.#wide(this.line, cam);
    let p = o + 12;
    for (const b of [this.room, this.city]) {
      g[p] = b.x - cam[0]; g[p + 1] = b.y - cam[1]; g[p + 2] = b.hx; g[p + 3] = b.hy;
      g[p + 4] = b.cos; g[p + 5] = b.sin; g[p + 6] = at[2] + b.up - cam[2]; g[p + 7] = b.on ? 1 : 0;
      p += 8;
    }
    g[p] = this.#wide(this.land, cam); g[p + 1] = 0; g[p + 2] = 0; g[p + 3] = 0;
  }

  /** Is a spot (of a building: a floor, a roof) taken away just now? What is not drawn is not there to be clicked. */
  hides(x, y, z) {
    const at = this.at;
    if (!this.on || !at) return false;
    return this.#boxed(x, y, z) || this.#holed(this.line, x, y, z);
  }

  /** The same of a spot of the ground: is it in the hole through a hill that was in the way? */
  hidesGround(x, y, z) {
    return this.on && !!this.at && this.#holed(this.land, x, y, z);
  }

  /** Is a spot inside one of the holes along the line of sight? */
  #holed(h, x, y, z) {
    const at = this.at;
    const cam = this.app.camera.pos, wide = this.#wide(h, cam);
    if (wide <= 0 || z < at[2] + 0.3) return false;
    // (the same hole as the shaders cut: gpu.js, cutSight)
    const qx = at[0] - cam[0], qy = at[1] - cam[1], qz = at[2] + CHEST - cam[2], far = Math.hypot(qx, qy, qz);
    const vx = x - cam[0] - qx, vy = y - cam[1] - qy, vz = z - cam[2] - qz;
    const s = -(vx * qx + vy * qy + vz * qz) / far;
    if (s <= 0 || s >= far) return false;
    const ox = vx + (qx * s) / far, oy = vy + (qy * s) / far, oz = vz + (qz * s) / far;
    return ox * ox + oy * oy + oz * oz < Math.min(wide, NARROW + s * WIDEN) ** 2;
  }
}
