// What the game's minimap shows as dots, as places on the 3D map: what you track, your target,
// your pet.
//
// The game puts a dot on its minimap for each creature or thing your tracking finds (Track
// Beasts, Find Herbs, Track Hidden...), for your target and for your pet - and tells an addon
// nothing of where any of them is. The minimap is on the screen, though, and the helper that
// reads the strip has the game's picture: while a map page asks for it, the small square of
// that picture the minimap is in is handed over a few times a second (tracker.js: look), the
// dots are found on it (minimap-dots.js), and each is where it is on the minimap: so many
// pixels from its middle are so many yards from you, turned as the minimap is turned. For that
// the addon's word of the minimap is gone by - where it is on the screen, how many yards it
// shows, whether it turns with you (AzerothAtlas.lua: MinimapReport) - and where you are: out
// of doors the game says; inside a dungeon the place found on the minimap itself (minimap.js).
//
// A dot is a colour and a ring, and no name. What can be said of it:
//   red, yellow, green   hostile, neutral, friendly to you: what your tracking found
//   a gold ring          the one you have targeted
//   blue                 yours, or one of your party. Your party is shown already (the game
//                        says where they are), so a blue dot where one of them stands is left
//                        out. Of the others, one is your pet: the one where the addon says
//                        your pet is (Yours.lua) or - the game not saying where - the one that
//                        has been there longest. The rest, whatever else of yours the game
//                        puts on its minimap (a hunter's hawks), are not shown.
// Where the game does say where your pet is, it is shown there with no dot to go by as well:
// beyond the minimap's edge, or under your own arrow.
//
// Only the picture of the game's own window is read; nothing is sent into the game, and
// nothing of the picture is kept or leaves this computer.
//
// What it cannot do: name what a dot is; see a dot under your own arrow, or one wholly under
// another; read a minimap that is hidden, covered by another window's overlay, or whose dots
// an addon has given another look. ("dots": false in config.json switches it off.)
import { findDots, placeDots, Tracks } from './minimap-dots.js';
import { squareFor } from './minimap-find.js';
import { encodePng } from './png.js';
import { note, changed } from './log.js';

const EVERY = 250;       // ms between two pictures of the minimap
const PARTY_NEAR = 10;   // yards: a blue dot this near a member of your party is that member
const PET_NEAR = 15;     // ...this near where the game says your pet is, your pet (what the addon says is a second old)
const SIZES = 15;        // measures of a dot's size kept (the middle one is gone by)
const round = (v) => Math.round(v * 10) / 10;

export class Dots {
  /**
   * @param tracker  the live link (tracker.js): asked for the pictures (look)
   * @param inside   (map) => where you are inside that dungeon and how its minimap lies (minimap.js: where) - or null
   */
  constructor({ tracker, inside = null } = {}) {
    this.tracker = tracker;
    this.inside = inside;
    this.on = true;          // a map page wants them (it says so: want)
    this.view = null;        // where you are and how the minimap lies, as last heard
    this.square = null;
    this.tracks = new Tracks();
    this.sizes = [];         // how big a dot is on this screen, as measured
    this.size = null;
    this.yours = null;       // what the addon says of your pet and of your tracking
    this.party = [];
    this.map = null;
    this.count = { pictures: 0, withDots: 0, cut: 0, dots: 0 };
    this.state = 'idle'; this.why = null;
    this.last = null;        // what the last picture gave, for a report of a problem...
    this.kept = null;        // ...and that picture itself (in memory only)
  }

  /** A map page says whether it shows any of this (none does: the minimap is not looked at for it). */
  want(on) {
    this.on = !!on;
    if (!this.on) { this.tracks.clear(); this.#look(null); this.#set('off', 'no map page shows them'); }
  }

  #set(state, why = null) {
    if (state === this.state && why === this.why) return;
    this.state = state; this.why = why;
    if (changed('dots', [state, why])) note('dots', `${state}${why ? `: ${why}` : ''}`);
  }

  #look(square) {
    const same = (a, b) => (!a && !b) || (a && b && a.every((v, i) => Math.abs(v - b[i]) <= 2));
    if (same(square, this.square)) return;
    this.square = square;
    this.tracker?.look?.(square, EVERY, 'dots');
  }

  /**
   * The strip was read (tracker.js, many times a second).
   * @param d       what it said (strip.js)   @param said  what the addon says of the minimap (NameCache.minimap), or null
   * @param window  the game's picture: { w, h }   @param yours  what the addon says of your pet and your tracking (NameCache.yours), or null
   */
  heard(d, said, window, yours) {
    const client = window && window.w > 0 && window.h > 0 ? [window.w, window.h] : null;
    this.yours = yours ?? null;
    this.party = d.party ?? [];
    if (yours) {
      // (noted where it is another state of things - and with it whether the game says where your pet is, which nobody could try beforehand)
      const told = { pet: yours.pet ? { name: yours.pet.name, dead: yours.pet.dead, gameSaysWhere: !!yours.pet.spot } : null, tracking: yours.tracking.map((t) => t.name ?? t.spell) };
      if (changed('yours', told)) note('dots', 'what the addon says of your pet, and what you track', told);
    }
    const inside = !!d.inInstance && d.mode !== 'world';
    if (this.map !== d.map) { this.map = d.map; this.tracks.clear(); }
    let view = null, why = null;
    if (!said) why = 'the addon does not say where the minimap is (an older addon)';
    else if (!said.known || !(said.half >= 30)) why = 'the game does not say where its minimap is';
    else if (said.shown === false) why = 'the minimap is hidden';
    else if (!client) why = 'the size of the game\'s picture is not known';
    else if (inside) {
      // (in a dungeon the game does not say where you are: the place found on its minimap is gone by, with the turn and the scale it was found at)
      const w = this.inside?.(d.map) ?? null;
      if (w) view = { map: d.map, x: w.x, y: w.y, rotation: w.rotation, radius: w.radius, cx: w.cx, cy: w.cy, half: w.half, round: said.round !== false };
      else why = 'where you are in this dungeon is not known';
    } else if (d.mode !== 'world' || !Number.isFinite(d.x)) why = 'the game does not say where you are';
    else if (!(said.radius > 0)) why = 'the game does not say how far its minimap shows';
    else if (said.rotates && !Number.isFinite(d.facing)) why = 'the minimap turns with you, and the game does not say which way you face';
    else view = { map: d.map, x: d.x, y: d.y, rotation: said.rotates ? d.facing : 0, radius: said.radius, cx: said.cx, cy: said.cy, half: said.half, round: said.round !== false };
    this.view = view;
    if (!this.on) return;
    if (!view) { this.#look(null); this.tracks.clear(); this.#set('idle', why); return; }
    if (this.state === 'idle' || this.state === 'off') this.#set('looking', null);
    this.#look(squareFor(view, client));
  }

  /** Nothing is heard from the game any more. */
  quiet() {
    this.view = null; this.yours = null; this.party = [];
    this.tracks.clear();
    this.#look(null);
    if (this.on) this.#set('idle', null);
  }

  /** A picture of the minimap has come (tracker.js): { x, y, w, h (where it is in the game's picture), data (R G B, row by row) } */
  crop(c) {
    const v = this.view;
    if (!this.on || !v) return;
    const geo = { cx: v.cx - c.x, cy: v.cy - c.y, half: v.half, round: v.round };
    // (a picture that has not all of the minimap on it - it was asked for before the minimap was moved - says nothing)
    if (geo.cx - geo.half < -3 || geo.cy - geo.half < -3 || geo.cx + geo.half > c.w + 3 || geo.cy + geo.half > c.h + 3) { this.count.cut++; return; }
    const t0 = performance.now();
    const found = findDots({ data: c.data, w: c.w, h: c.h }, geo, { size: this.size });
    if (found.size) {
      this.sizes.push(found.size);
      if (this.sizes.length > SIZES) this.sizes.shift();
      const s = [...this.sizes].sort((a, b) => a - b);
      this.size = s[s.length >> 1];
    }
    const at = Date.now();
    this.kept = { data: Buffer.from(c.data), w: c.w, h: c.h, at, origin: [c.x, c.y] };
    const placed = placeDots(found.dots, { ...geo, radius: v.radius, rotation: v.rotation, x: v.x, y: v.y });
    this.tracks.add(placed, { map: v.map, x: v.x, y: v.y, radius: v.radius, at });
    const n = this.count;
    n.pictures++; n.dots += found.dots.length;
    if (found.dots.length) n.withDots++;
    this.last = { at, took: Math.round((performance.now() - t0) * 10) / 10, dots: placed.map((p) => ({ kind: p.kind, ring: p.ring, part: !!p.part, px: round(p.px), py: round(p.py), x: round(p.x), y: round(p.y), far: round(p.far), fit: Math.round(p.fit * 100) / 100 })), size: found.size ? round(found.size) : null };
    if (found.dots.length && n.withDots === 1) note('dots', 'the first dots are read off the minimap', { dots: this.last.dots, size: this.last.size, minimap: { middle: [round(v.cx), round(v.cy)], half: round(v.half), yards: round(v.radius), turned: round((v.rotation * 180) / Math.PI) } });
    this.#set('seen', null);
  }

  /**
   * What is to be shown, with what each is: [{ id, role ('tracked', 'target', 'pet'), kind (of what is tracked, and
   * of your target: 'red', 'yellow', 'green', or 'hidden' - its colour is under another dot), ring ('silver', 'gold'),
   * x, y (yards north and west), name, dead (of your pet, where the addon says), dot (false: not seen on the
   * minimap, placed by the game's word alone) }]
   */
  list(now = Date.now()) {
    if (!this.on) return [];
    const map = this.map, yours = this.yours, out = [];
    const shown = this.view ? this.tracks.shown(now) : [];
    const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    // (your party is shown already, where the game says they are)
    const party = (this.party ?? []).filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y));
    const blue = shown.filter((t) => t.kind === 'blue' && !party.some((m) => far(m, t) <= PARTY_NEAR));
    // Your pet: where the game says it is - better, the blue dot there, which is of this moment.
    // The game not saying where: the blue dot that has been there longest (what else of yours is
    // on the minimap - a hunter's hawks, for their eighteen seconds - comes and goes). An addon
    // from before says nothing of pets at all: then a blue dot is taken for one, without a name.
    const pet = yours ? yours.pet : { name: null, dead: false, spot: null };
    if (pet) {
      const said = pet.spot && pet.spot.map === map ? pet.spot : null;
      let dot = null;
      for (const b of blue) {
        if (said ? far(b, said) <= PET_NEAR && (!dot || far(b, said) < far(dot, said)) : !dot || b.since < dot.since) dot = b;
      }
      const at = dot ?? said;
      if (at) out.push({ id: 'pet', role: 'pet', name: pet.name ?? null, dead: !!pet.dead, x: round(at.x), y: round(at.y), dot: !!dot });
    }
    for (const t of shown) {
      if (t.kind === 'blue') continue;
      out.push({ id: `d${t.id}`, role: t.ring === 'gold' ? 'target' : 'tracked', kind: t.kind, ring: t.ring, x: round(t.x), y: round(t.y), dot: true });
    }
    return out;
  }

  /** What your minimap is set to track, as the addon names it: ['Track Beasts'] - or null: it does not say. */
  tracking() { return this.yours ? this.yours.tracking.map((t) => t.name ?? `spell ${t.spell}`) : null; }

  /** For a report of a problem: the last picture of the minimap that was looked at for its dots, as a PNG file (or null). */
  picture() {
    const k = this.kept;
    if (!k?.data?.length) return null;
    try { return { png: encodePng({ data: k.data, w: k.w, h: k.h, ch: 3 }), at: k.at, w: k.w, h: k.h, origin: k.origin }; } catch { return null; }
  }

  status() {
    const v = this.view;
    return {
      on: this.on, state: this.state, why: this.why, square: this.square, every: EVERY, ...this.count,
      size: this.size ? round(this.size) : null,
      view: v ? { map: v.map, middle: [round(v.cx), round(v.cy)], half: round(v.half), yards: round(v.radius), turned: round((v.rotation * 180) / Math.PI), round: v.round } : null,
      followed: this.tracks.list.length, last: this.last,
      yours: this.yours,
    };
  }
}
