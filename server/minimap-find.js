// Picture after picture of the game's minimap in, where you are out.
//
// What minimap-match.js does once - find a minimap on a dungeon's plan - is done here over and
// over as the pictures come, a few a second, keeping what was learned from the ones before:
//
//   where the minimap is  Its middle has to be known to a pixel (a pixel off is a yard and a
//   on the screen         half off, at the widest view) and its size to a hundredth. The addon
//                         says where the game has its minimap (the strip: strip.js, minimap).
//                         Nobody could try that in the game itself, so it is not taken on
//                         trust: the gold rim the game draws round its minimap is looked for on
//                         the picture, and where it is found the picture has the last word (and
//                         what the addon said is kept beside it, for a report of a problem).
//                         With no word from the addon the rim is looked for in the top right
//                         corner of the game's picture, where the game puts its minimap.
//   how far it shows      The game's minimap has six steps of zoom indoors: 300, 240, 180, 120,
//                         80 and 50 yards across. The addon says which; without it they are
//                         tried in turn, and the one that fits is kept.
//   whether it turns      The game can keep north up or turn the minimap with you. The addon
//                         says which; without it every turn is tried. Told "north up" and
//                         finding nothing for a while, every turn is tried all the same.
//   where you were        From one picture to the next you have gone a yard or two: the place
//                         is followed (a fiftieth of a second) and only looked for afresh
//                         (half a second, more in a big dungeon) when it is lost.
//
// A fit that is poor, or two places that fit alike, give nothing: { ok: false, reason }.
import { Locator, loadReference, readArrow, fitRim, findRim, insideRim, rimOf, angDiff, norm } from './minimap-match.js';

export const VIEWS = [300, 240, 180, 120, 80, 50]; // yards across, at each step of the game's zoom indoors
// How much of the minimap is looked at, as a share of its half width. Where the game's own rim
// is on the picture, the minimap is the game's own, and what reaches into it is known: the two
// buttons on its rim (the time of day, top right; what is tracked, right), which are left out.
// That is the disc the matcher was measured with: partly covered, it found the right place or
// refused. With another look - no rim, only the addon's word - there is no telling what sits on
// the edge: less of it is looked at.
const DISC = 96 / 102.5, DISC_PLAIN = 0.8;
const BUTTONS = [[0.561, -0.862, 0.195], [1.054, -0.045, 0.156]]; // (across, down and radius, in half widths from the map's middle)
const LEAP = 20, LEAP_SPEED = 12, LEAP_FIT = 0.9; // yards, yards a second: further than this from where you were a moment ago is only believed of a fit this good
const ARROW = 11 / 102.5; // ...and the share at its middle that is not (your arrow)
const ARROW_READ = 13 / 102.5;
const FOLLOW_FOR = 3000; // ms: a place this old is still followed; an older one is only where to look first
const NEAR_FOR = 30000;  // ms: ...and for this long
const SETTLE = 12;       // pictures over which the rim's place is averaged
const SETTLE_TURNING = 150; // ...where the minimap turns with you (see #where)
const D2R = Math.PI / 180;

/** The square of the game's picture to be sent: the minimap and its rim, with a little to spare. [x, y, w, h] */
export function squareFor(geo, client) {
  const r = Math.ceil(geo.half * 1.12) + 4;
  return clip([Math.round(geo.cx) - r, Math.round(geo.cy) - r, 2 * r + 1, 2 * r + 1], client);
}
/** With nothing known of where the minimap is: the top right corner of the game's picture, where the game puts it. */
export function cornerFor(client) {
  const side = Math.round(Math.max(260, Math.min(560, client[1] * 0.36, client[0], client[1])));
  return clip([client[0] - side, 0, side, side], client);
}
function clip([x, y, w, h], client) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(client[0], x + w), y1 = Math.min(client[1], y + h);
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

/** What the addon said of the minimap, where it can be used: { cx, cy, half } - or null. */
function usable(said, client) {
  if (!said || !said.known) return null;
  const { cx, cy, half } = said;
  if (![cx, cy, half].every(Number.isFinite) || half < 30 || half > 1200) return null;
  if (client && (cx < 0 || cy < 0 || cx > client[0] || cy > client[1])) return null;
  return { cx, cy, half };
}

export class Finder {
  /** @param read  (map) => the plan of a map as the map build wrote it (a Buffer), or null where it has none */
  constructor({ read }) {
    this.read = read;
    this.map = null; this.ref = null; this.refError = null;
    this.reset();
  }

  /** Forget where you were and what was learned of the minimap (another dungeon, or the game's window another size). */
  reset() {
    this.seen = null;       // the minimap on the screen as the rim has it, averaged: { cx, cy, half, n, mode } (pixels of the game's picture)
    this.rimMisses = 0;     // pictures in a row with no rim on them
    this.loc = null;        // the plan at the screen's scale, for one view
    this.pose = null;       // where you were last found: { x, y, rotation, set, at }
    this.view = null;       // yards across, once a view has fitted
    this.round = 0;         // looks through the whole plan in a row that found nothing: which view is tried goes by it
    this.saidViews = '';    // the views the addon last named
    this.misses = 0;        // pictures in a row that gave nothing
    this.wide = false;      // the look round where you were gave nothing: the whole plan is next
    this.turnFree = false;  // told "north up" and nothing found: every turn is tried
    this.turned = false;    // the minimap has been found turned: it turns with you, whatever was said
  }

  #plan(map) {
    if (map === this.map) return this.ref;
    this.map = map; this.ref = null; this.refError = null; this.loc = null; this.pose = null; this.view = null; this.round = 0; this.misses = 0; this.wide = false; this.turnFree = false;
    try { const buf = this.read(map); this.ref = buf ? loadReference(buf) : null; } catch (err) { this.refError = err.message; }
    return this.ref;
  }

  /**
   * Where the minimap is on this picture.
   * @returns { cx, cy, half (in the pixels of the game's picture), from (what says so: the picture, the addon, or the addon with the
   *            picture agreeing), rim: what was fitted on this picture (or null), seen: the rim's word averaged over the pictures
   *            (or null), said: the addon's (or null) } - or null: not found
   */
  #where(f) {
    const [ox, oy] = f.origin, said = usable(f.said, f.client);
    // the rim: about where it should be - by what was found before, else by what the addon says - or anywhere at all
    const about = this.seen ?? said;
    let rim = null;
    if (about) { const r = rimOf(about); rim = fitRim(f.pic, { cx: r.cx - ox, cy: r.cy - oy, r: r.r }); }
    else rim = findRim(f.pic);
    if (rim) {
      // The rim is not quite round about the map's middle, and where the map turns with you the
      // rim turns with it: its own middle goes round the map's, a pixel and a half away
      // (insideRim has it for north up). It also wanders a little as it turns, so what one
      // picture says is out by up to a pixel then: the pictures are averaged, over a few where
      // north stays up (the rim does not move), over many where it turns (you turn, and what
      // each is out by cancels).
      const plain = insideRim(rim), mode = !this.turns ? 'up' : this.pose ? 'turned' : 'turn not known';
      const turn = mode === 'turned' ? this.pose.rotation : 0;
      const dx = plain.cx - rim.cx, dy = plain.cy - rim.cy, c = Math.cos(turn), sn = Math.sin(turn);
      const now = { cx: rim.cx + dx * c - dy * sn + ox, cy: rim.cy + dx * sn + dy * c + oy, half: plain.half };
      const g = this.seen;
      if (g && g.mode === mode && Math.hypot(now.cx - g.cx, now.cy - g.cy) < 2.5 && Math.abs(now.half - g.half) < g.half * 0.03) {
        const n = Math.min(this.turns ? SETTLE_TURNING : SETTLE, g.n + 1);
        this.seen = { cx: g.cx + (now.cx - g.cx) / n, cy: g.cy + (now.cy - g.cy) / n, half: g.half + (now.half - g.half) / n, n, mode };
      } else this.seen = { ...now, n: 1, mode };
      this.rimMisses = 0;
    } else if (++this.rimMisses > 25) this.seen = null; // (it is no longer there: looked for anew, by the addon's word or anywhere)
    // Which to go by. The picture, where the rim is on it: that is measured, and the addon's
    // word could not be tried in the game. But where the minimap turns, the rim's word wobbles
    // and the addon's does not: there the addon's is taken, as long as the picture bears it out.
    const p = this.seen;
    let geo = null;
    if (p && said && this.turns && Math.hypot(said.cx - p.cx, said.cy - p.cy) <= 1.5 && Math.abs(said.half - p.half) <= p.half * 0.015) geo = { ...said, from: 'addon, the picture agreeing' };
    else if (p) geo = { cx: p.cx, cy: p.cy, half: p.half, from: 'picture' };
    else if (said) geo = { ...said, from: 'addon' };
    if (!geo) return null;
    return { ...geo, rim: rim ? { cx: rim.cx + ox, cy: rim.cy + oy, r: rim.r, n: rim.n, rms: rim.rms } : null, seen: p ? { cx: p.cx, cy: p.cy, half: p.half, n: p.n } : null, said: f.said ?? null };
  }

  /**
   * The views there are to try: { first: the one that fitted before, then those the addon names;
   * rest: the game's other steps; named: the addon names one }.
   */
  #views(f) {
    const first = [], rest = [];
    const add = (list, v) => { if (Number.isFinite(v) && v >= 20 && v <= 1200 && ![...first, ...rest].some((o) => Math.abs(o - v) < o * 0.02)) list.push(v); };
    // what the game itself gives as the yards from the minimap's middle to its edge (the figure the
    // addon draws its routes on the minimap by, in the game), and then the step of its zoom
    const named = [], said = f.said;
    if (said && Number.isFinite(said.radius) && said.radius > 0) named.push(said.radius * 2);
    if (said && Number.isInteger(said.zoom) && VIEWS[said.zoom]) named.push(VIEWS[said.zoom]);
    // (the addon names another view than it did: you have zoomed - the place is the same, and is followed on at the new scale)
    const key = named.map(Math.round).join();
    if (key !== this.saidViews) { this.saidViews = key; this.view = null; this.round = 0; }
    add(first, this.view);
    for (const v of named) add(first, v);
    for (const v of VIEWS) add(rest, v);
    return { first, rest, named: named.length > 0 };
  }

  /**
   * One picture.
   * @param f { map, pic: { data, w, h, ch }, origin: [x, y] (where the picture's corner is in the game's picture), client: [w, h]
   *            (the game's picture), at (ms), said (what the addon says of the minimap: strip.js - or null),
   *            facing (radians, where the strip says how you face - or null), hint: { x, y, at } (a place to look near first - or null),
   *            nudge: [right, down] (pixels the minimap's middle is to be moved by: what the combat log has taught - minimap.js) }
   * @returns { ok, reason, map, at, x, y, facing, rotation, score, margin, mode, ms, view, band, rooms, hidden, odd, floor,
   *            geo (where the minimap was taken to be: #where), want: [x, y, w, h] (the square to send from now on) }
   */
  frame(f) {
    const t0 = performance.now();
    const base = { ok: false, map: f.map, at: f.at, origin: f.origin, want: null };
    const ref = this.#plan(f.map);
    if (!ref) return { ...base, reason: this.refError ? `this dungeon's plan cannot be read (${this.refError})` : 'the map has no plan of this dungeon', noPlan: true, ms: performance.now() - t0 };
    // (the addon says whether the minimap turns with you; and a minimap found turned once does, whatever was said)
    const told = f.said && typeof f.said.rotates === 'boolean' ? f.said.rotates : null;
    this.turns = this.turned || told === true;
    const before = this.pose, hadPose = !!before; // (where you were found last, before this picture has its say)
    const geo = this.#where(f);
    if (!geo) return { ...base, reason: 'the minimap was not found on the picture of the game', geo: null, want: cornerFor(f.client), ms: performance.now() - t0 };
    if (f.nudge && (f.nudge[0] || f.nudge[1])) { geo.cx += f.nudge[0]; geo.cy += f.nudge[1]; geo.nudge = f.nudge; }
    const want = squareFor(geo, f.client);
    // The view: the one that fitted before, or the one the addon names. While nothing fits, the
    // others are tried too, one a look - but a view that has fitted, or that the addon names, is
    // come back to every other look (something over the minimap for a moment is no reason to
    // doubt it), and the addon's word is not doubted at all for the first eight.
    const { first, rest, named } = this.#views(f);
    const n = this.round;
    const view = !first.length ? rest[n % rest.length]
      : !rest.length || (named && n < 8) ? first[n % first.length]
        : n % 2 === 0 ? first[(n >> 1) % first.length] : rest[(n >> 1) % rest.length];
    const s = (2 * geo.half) / view;
    if (!this.loc || this.loc.ref !== ref || Math.abs(this.loc.s - s) > this.loc.s * 0.004) this.loc = new Locator(ref, s, { discRadiusPx: Math.ceil(geo.half * DISC) + 4 });
    const loc = this.loc;
    // (what of the picture is looked at: see DISC)
    const cutAt = (g) => {
      const own = !!g.seen, cx = g.cx - f.origin[0], cy = g.cy - f.origin[1];
      return loc.cut(f.pic, { cx, cy, rMax: g.half * (own ? DISC : DISC_PLAIN), rArrow: g.half * ARROW, exclude: own ? BUTTONS.map(([x, y, r]) => ({ x: cx + x * g.half, y: cy + y * g.half, r: r * g.half })) : [] });
    };
    const mm = cutAt(geo);

    const opts = {};
    if (told === false && !this.turnFree) opts.rotation = 0;
    else if (told === true && Number.isFinite(f.facing)) { opts.rotation = f.facing; opts.rotationWindow = 12 * D2R; opts.coarseStepDeg = 3; }
    const age = this.pose ? f.at - this.pose.at : Infinity;
    if (this.pose && age >= 0 && age <= FOLLOW_FOR) opts.previous = this.pose;
    if (!this.wide) {
      if (this.pose && age <= NEAR_FOR) opts.near = { x: this.pose.x, y: this.pose.y, radius: 25 + 9 * Math.max(0, age) / 1000 };
      else if (f.hint && f.at - f.hint.at <= NEAR_FOR) opts.near = { x: f.hint.x, y: f.hint.y, radius: 40 + 9 * Math.max(0, f.at - f.hint.at) / 1000 };
    }
    let r = loc.locate(mm, opts);
    // Found turned, and the minimap's middle was worked out as for north up (the turn was not
    // known): the rim's middle goes round the map's as it turns, so the place is out by a yard
    // or three. Worked out again with the turn, and the place settled again from where it was found.
    if (r.ok && Math.abs(angDiff(r.rotation, 0)) > 3 * D2R && !(this.turns && hadPose)) {
      this.turned = true; this.turns = true;
      this.pose = { x: r.x, y: r.y, rotation: r.rotation, set: r.set, at: f.at };
      const again = this.#where(f);
      if (again) {
        if (f.nudge && (f.nudge[0] || f.nudge[1])) { again.cx += f.nudge[0]; again.cy += f.nudge[1]; again.nudge = f.nudge; }
        const mm2 = cutAt(again);
        const r2 = loc.locate(mm2, { previous: this.pose, followOnly: true, minFollow: r.score - 0.05 });
        if (r2.ok) { r2.margin = r.margin; r2.runnerUp = r.runnerUp; r2.mode = r.mode; r2.ms += r.ms; r = r2; geo.cx = again.cx; geo.cy = again.cy; geo.half = again.half; geo.from = again.from; geo.seen = again.seen; }
      }
    }
    // A place far from where you were a moment ago - further than you could have run - is a leap.
    // There are few of those inside a dungeon, and many ways for a minimap with something dark
    // over most of it to look like some other corner of the plan: a leap is only believed of a fit
    // as good as an uncovered minimap gives. (Refused, it is looked for again; half a minute on,
    // where you were is no longer held against it.)
    if (r.ok && r.mode === 'search' && before && age <= NEAR_FOR) {
      const far = Math.hypot(r.x - before.x, r.y - before.y);
      if (far > LEAP + LEAP_SPEED * Math.max(0, age) / 1000 && r.score < LEAP_FIT) r = { ...r, ok: false, reason: `it would be a leap of ${far.toFixed(0)} yards from where you were ${(age / 1000).toFixed(0)} s ago, and fits only ${r.score.toFixed(2)}` };
    }
    const out = { ...base, ok: r.ok, reason: r.reason || null, mode: r.mode, score: r.score, margin: r.margin, view, floor: r.floorFraction, geo, want, scale: s };
    if (r.ok) {
      this.pose = { x: r.x, y: r.y, rotation: r.rotation, set: r.set, at: f.at };
      this.view = view; this.round = 0; this.misses = 0; this.wide = false;
      if (Math.abs(angDiff(r.rotation, 0)) > 3 * D2R) this.turned = true;
      const turns = this.turned || told === true;
      // which way you face: the map's turn where it turns with you, else your arrow in its middle
      let facing = turns ? norm(r.rotation) : null;
      if (!turns) { const a = readArrow(f.pic, geo.cx - f.origin[0], geo.cy - f.origin[1], geo.half * ARROW_READ); if (a) facing = a.facing; }
      Object.assign(out, { x: r.x, y: r.y, rotation: r.rotation, turns, facing, band: r.band, rooms: r.rooms, hidden: r.hidden, odd: r.odd, runnerUp: r.runnerUp });
    } else {
      this.misses++;
      if (r.x !== undefined) Object.assign(out, { tried: { x: r.x, y: r.y, rotation: r.rotation }, runnerUp: r.runnerUp ?? null });
      if (!r.empty) {
        // nothing round where you were: the whole plan next; nothing on the whole plan: the next view, and - told north is up - every turn
        if (opts.near) this.wide = true;
        else {
          this.wide = false;
          this.round++;
          if (opts.rotation === 0 && this.misses >= 6) this.turnFree = true;
        }
      }
      out.empty = !!r.empty;
    }
    out.ms = performance.now() - t0;
    return out;
  }
}
