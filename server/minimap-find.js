// Picture after picture of the game's minimap in, where you are out.
//
// What minimap-match.js does once - find a minimap on a dungeon's plan - is done here over and
// over as the pictures come, a few a second, keeping what was learned from the ones before:
//
//   where the minimap is  Its middle has to be known to a pixel (a pixel off is a yard and a
//   on the screen         half off, at the widest view) and its size to a hundredth. The addon
//                         says where the game has its minimap (the strip: strip.js, minimap).
//                         The gold rim the game draws round its minimap is looked for on the
//                         picture too. Where north stays up the rim stands still and is
//                         measured to half a pixel: there the picture has the last word.
//                         Where the minimap turns with you the rim turns too, and what is read
//                         off it wanders by pixels (an evening in Gnomeregan, 19 November 2026:
//                         six pixels and three hundredths of its size, and with it the place
//                         found, by as many yards) while the addon's word stood still and put
//                         you on the game's own spot for the door to within a yard: there the
//                         addon's word is taken, as long as the rim is anywhere near it.
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
//   how you move          You get from one place to the next on your feet, and the game says
//                         how fast you are going (the strip; summed up in minimap.js to the
//                         yards you have gone). So a picture is not asked "where on the plan is
//                         this" but "where, of the places you can have got to": no further from
//                         where you were than you have gone, on a floor (minimap-ground.js),
//                         and one you could walk to from the floor you were on - not through a
//                         wall, not on the storey above. While you stand, you are where you
//                         stood, whatever a picture with something over it looks like. Where
//                         the picture does not say where you are (a long straight corridor, a
//                         hall so wide that the whole minimap is floor), you are where you
//                         would have got to going on as you were. And the door: coming in from
//                         outside you are at it (world.json: entrances), so that is where the
//                         trail begins, with no look through the whole plan.
//                         A place that fits well where you cannot have walked to is not thrown
//                         away - the floors may have a gap the map does not know of, a spell
//                         may have moved you - but it has to hold for three pictures running,
//                         moving as you move, before it is believed.
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
// The trail (see #trail)
const NOISE = 2.5;        // yards two readings of one place may lie apart
const GOOD = 0.8;         // a fit this good is a place found (before anything is known of how this game's pictures fit this plan)...
const LEAST = 0.6;        // ...and nothing under this ever is, as a look through the whole plan has it too
const FAIR = 0.5;         // a fit this good still has a say in where exactly, while the trail is carried on (something is over part of the minimap)
const POOR_QUICK = 10;    // pictures in a row that fit worse than usual, after which that is taken for the new usual, quickly...
const DEEP = 0.25;        // ...where it is no further under the usual than this: further is something over the minimap, not how the pictures fit here
const POOR_MOST = 40;     // pictures in a row that fit only fairly, after which the trail is not gone by any longer
const STRETCH = 1.12;     // a way counted from cell to cell is up to this much longer than the way itself
const AIR = 9;            // yards a second you may be carried while in the air (thrown, or a leap)
const LAG = 0.25;         // seconds the picture may be ahead of what was last said of your speed
const FLAT = 0.015;       // a fit only this much worse three yards off does not say where you are
const DIP = 0.04;         // a fit this much under what the trail's places usually fit is looked into: is there a better place you can have got to? (Twice this under: a poor picture.)
const SLACK_MOST = 40;    // yards: the most a place on the trail is taken to be off by, going on where the picture does not say
const FLOOR_REACH = 2.5;  // yards from a place found to the floor it is taken to be on
const FALL = 70;          // yards you may have come down while in the air (as far as anybody falls and walks on: minimap-ground.js)
const CONFIRM = 3;        // pictures that have to agree before a place you cannot have walked to is believed
const LOST_AFTER = 1500;  // ms with no picture that fits the trail, after which further off is looked at
const WIDER = 30;         // yards further than you can have gone, looked through then
const WHOLE_EVERY = 8000; // ms from one look through the whole plan with a trail in hand to the next (doubled each time it finds nothing, up to a minute)
const WHOLE_SLICE = 150;  // ms of such a look done with each picture (all of it takes seconds: the trail is not kept waiting for it)...
const WHOLE_STOOD = 500;  // ...and while you stand, where nothing is missed meanwhile
const WHOLE_REACH = 90;   // yards gone since the picture such a look was begun with, beyond which what it finds is not looked for any more
const DOOR_SLACK = 8;     // yards from the game's spot for a door within which you are looked for, having just come in
const DOOR_FOR = 2500;    // ms after coming in for which only the door is looked at
const TRAIL_MOST = 80;    // yards you may have gone since the trail's last place, beyond which it is no trail any more
const STILL_MOST = 9;     // readings of the place you stand at that are averaged

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
  /**
   * @param read    (map) => the plan of a map as the map build wrote it (a Buffer), or null where it has none
   * @param ground  (map) => what there is to walk on in it (minimap-ground.js: a Ground), or null: not known
   */
  constructor({ read, ground = null }) {
    this.read = read;
    this.groundOf = ground;
    this.map = null; this.ref = null; this.refError = null; this.ground = null;
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
    // The trail: the place last believed, with how far you had gone by then - { x, y, rotation, set,
    // at, odo, air, floors (the floors you may be standing on, or null), slack (yards it may be off
    // besides NOISE), still (readings of this place while you stood), poor (pictures in a row that
    // fitted only fairly), way (which way you go, counted from the way you face), heading, band }
    this.track = null;
    this.rival = null;      // a place that fits well where the trail cannot have led: a trail of its own, with n pictures that agreed
    this.wholeAt = 0; this.wholeGap = WHOLE_EVERY; // when the whole plan was last looked through with a trail in hand
    this.whole = null;      // ...and such a look under way: { loc, look, odo, air } (see #whole)
    this.widerAt = 0;
  }

  #plan(map) {
    if (map === this.map) return this.ref;
    this.map = map; this.ref = null; this.refError = null; this.loc = null; this.pose = null; this.view = null; this.round = 0; this.misses = 0; this.wide = false; this.turnFree = false;
    this.track = null; this.rival = null; this.ground = null; this.spreadOf = null; this.whole = null;
    try { const buf = this.read(map); this.ref = buf ? loadReference(buf) : null; } catch (err) { this.refError = err.message; }
    try { this.ground = this.ref && this.groundOf ? this.groundOf(map) ?? null : null; } catch { this.ground = null; }
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
    // (Anywhere near: within a twentieth of its width and of its size. An addon that
    // had the wrong minimap, or the wrong scale of the screen, would be out by far more.)
    const p = this.seen;
    let geo = null;
    if (p && said && this.turns && Math.hypot(said.cx - p.cx, said.cy - p.cy) <= Math.max(5, said.half * 0.1) && Math.abs(said.half - p.half) <= p.half * 0.06) geo = { ...said, from: 'addon, the picture agreeing' };
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
   *            nudge: [right, down] (pixels the minimap's middle is to be moved by: what the combat log has taught - minimap.js),
   *            motion: { odo (yards you have gone in this dungeon, as the game's word of your speed sums up), air (seconds of
   *            that in the air), speed (yards a second, now), falling } - or left out: the addon does not say (then every
   *            picture is taken on its own, as before there was a trail),
   *            door: { at (when you came in), odo, air (what motion had then), spots: [{ x, y, z (or null), facing (or null) }] }
   *            - you have come in from outside and nothing has been found since: where the door is (or the doors) }
   * @returns { ok, reason, map, at, x, y, facing, rotation, score, margin, mode, ms, view, band, rooms, hidden, odd, floor,
   *            geo (where the minimap was taken to be: #where), want: [x, y, w, h] (the square to send from now on),
   *            how (with a trail: 'followed', 'stood', 'held' - you stand, and the picture does not show the place -,
   *            'looked round', 'carried on' - a picture with something over it: where you would have got to -, 'door', 'leap'), held, went (yards since the place before), sharp, slack, floors: [lowest,
   *            highest] (the floors you may be on), spare (false: nothing found, and it cost next to nothing to look) }
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
    // With the game's word of how you move: the trail (see #trail). Where it has nothing to say -
    // there is no trail yet, and no door to begin it at - the plan is looked through as ever, below.
    if (f.motion && Number.isFinite(f.motion.odo)) {
      const t = this.#trail(f, { loc, mm, geo, view, turn: opts, told });
      if (t) {
        const out = { ...base, ok: !!t.ok, reason: t.reason ?? null, mode: t.mode ?? 'follow', score: t.score ?? 0, margin: t.margin ?? 0, view, floor: mm.floorFraction, geo, want, scale: s, how: t.how ?? null, spare: t.spare };
        if (t.ok) {
          const tr = this.track;
          this.pose = { x: tr.x, y: tr.y, rotation: tr.rotation, set: tr.set, at: f.at };
          this.view = view; this.round = 0; this.misses = 0; this.wide = false;
          if (Math.abs(angDiff(tr.rotation, 0)) > 3 * D2R) this.turned = true;
          const turns = this.turned || told === true;
          let facing = turns ? norm(tr.rotation) : null;
          if (!turns) { const a = readArrow(f.pic, geo.cx - f.origin[0], geo.cy - f.origin[1], geo.half * ARROW_READ); if (a) facing = a.facing; }
          tr.heading = facing ?? tr.heading ?? null;
          Object.assign(out, { x: tr.x, y: tr.y, rotation: tr.rotation, turns, facing, band: t.band ?? null, rooms: t.rooms ?? null, hidden: t.hidden ?? null, odd: t.odd ?? null, runnerUp: null, held: !!t.held, went: t.went, sharp: t.sharp ?? null, slack: tr.slack, floors: t.floors ?? null });
        } else { this.misses++; out.empty = !!t.empty; if (t.tried) out.tried = t.tried; }
        out.ms = performance.now() - t0;
        return out;
      }
    }
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
      // (found afresh, with the game's word of how you move: where the trail begins)
      if (f.motion && Number.isFinite(f.motion.odo)) { this.track = this.#begin(r, f, r.band); this.rival = null; out.how = 'found'; if (this.track.floors) out.floors = spanOf(this.track.floors); }
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

  // ------------------------------------------------------------------ the trail

  /** How far you may have gone since a place on the trail: the game's word of your speed since, summed. */
  #gone(tr, f) {
    const m = f.motion;
    const went = Math.max(0, m.odo - tr.odo), aired = Math.max(0, m.air - tr.air);
    const still = went < 0.05 && aired < 0.05 && !m.falling && !(m.speed > 0);
    return { went, aired, still, falling: !!m.falling, reach: still ? 0 : went * STRETCH + aired * AIR + LAG * Math.max(0, m.speed ?? 0) };
  }

  /**
   * The floors you may be standing on at a place: of the floors within a step of it, those you
   * can have walked to from the floors you were on (`from`) in `reach` yards - { floors, on: true };
   * none of them: { floors: null, on: false } (there is no floor there, or no way to it). With
   * no floors to come from, the floors there at the heights of the rooms the picture shows:
   * { floors (or null), on: null } - nothing is said of whether you can be there.
   */
  #floors(pose, from, reach, band) {
    const G = this.ground;
    if (!G) return { floors: null, on: null };
    if (from?.length) {
      const c = this.#spread(from, reach + FLOOR_REACH).floors(pose.x, pose.y, FLOOR_REACH);
      return c.length ? { floors: few(c), on: true } : { floors: null, on: false };
    }
    const c = band ? G.floorsNear(pose.x, pose.y, FLOOR_REACH, band[0] - 2, band[1] + 2) : [];
    return { floors: c.length ? few(c) : null, on: null };
  }

  /** Everything you can have walked to from some floors in so many yards (asked for several times a picture: worked out once). */
  #spread(from, budget) {
    const k = this.spreadOf;
    if (k && k.from === from && k.budget === budget) return k.sp;
    const sp = this.ground.spread(from, budget);
    this.spreadOf = { from, budget, sp };
    return sp;
  }

  /**
   * The heights you can be at, `reach` yards on from a place on the trail: [lowest, highest], or
   * null where nothing is known of them. Two things say it, and either is enough: the floors you
   * can have walked to (a drop and a lift are ways: they take you a long way up or down in no
   * yards at all), and that nobody climbs or goes down a stair further than they have walked -
   * that second one holds where the map's floors have a gap, too, so a storey the floors do not
   * lead to is not ruled out by it. In the air you may be coming down as far as anybody falls.
   */
  #heights(tr, g, reach) {
    if (!this.ground || !tr.floors?.length) return null;
    const sp = this.#spread(tr.floors, reach + FLOOR_REACH).span;
    if (!sp) return null;
    const own = spanOf(tr.floors), down = reach + (g.aired > 0 || g.falling ? FALL : 0);
    return [Math.min(sp[0], own[0] - down), Math.max(sp[1], own[1] + reach)];
  }

  /**
   * Where you can be at all: within as many yards of the last place the picture told for sure as
   * the game says you have gone since - { x, y, radius }, or null where there is no such place.
   * The trail's own place may have become unsure since (a corridor that looks the same all along,
   * something over the minimap), and it is looked for the wider for that; but how far you can BE
   * is not a matter of how unsure the trail is. Without this, a minimap half covered by something
   * lit - which fits "well enough" in many a place - took the trail a hundred yards in three
   * pictures, each no further than the trail was unsure by.
   */
  #sure(tr, f) {
    const an = tr.anchor;
    if (!an) return null;
    const m = f.motion;
    return { x: an.x, y: an.y, radius: Math.max(0, m.odo - an.odo) * STRETCH + Math.max(0, m.air - an.air) * AIR + LAG * Math.max(0, m.speed ?? 0) + NOISE };
  }

  /** A trail begun at a place found afresh. */
  #begin(r, f, band, floors = undefined) {
    return {
      x: r.x, y: r.y, rotation: r.rotation, set: r.set, at: f.at, odo: f.motion.odo, air: f.motion.air,
      floors: floors !== undefined ? floors : this.#floors(r, null, 0, band).floors,
      // (the last place the picture told for sure, and what the game had said of your way by then: see #sure)
      anchor: { x: r.x, y: r.y, odo: f.motion.odo, air: f.motion.air },
      slack: 0, still: 0, poor: 0, way: null, heading: null, band: band ?? null, score: r.score, usual: r.score, n: 1, seen: f.at,
    };
  }

  /** The trail a step on: the place `c` ({ r, floors }) taken, having gone `g` since `tr`. */
  #step(tr, c, f, g) {
    const r = c.r, good = r.score >= wellOf(tr), told = good && r.sharp !== null && r.sharp >= FLAT;
    let x = r.x, y = r.y, still = 0;
    if (g.still) {
      // you stand: every reading is one of the same place, and the place is their middle
      still = Math.min(STILL_MOST, tr.still + 1);
      x = tr.x + (r.x - tr.x) / (still + 1); y = tr.y + (r.y - tr.y) / (still + 1);
    }
    // which way you go, counted from the way you face: kept while it cannot be seen (forward, where it never was)
    let way = tr.way;
    const far = Math.hypot(r.x - tr.x, r.y - tr.y);
    if (told && !g.still && g.went >= 1.2 && far >= 1 && tr.slack < 1) way = angDiff(Math.atan2(r.y - tr.y, r.x - tr.x), tr.heading ?? tr.rotation);
    const slack = told ? 0 : Math.min(SLACK_MOST, tr.slack + (g.still ? 0 : g.went * 0.5 + 0.3));
    // The floors you may be standing on: those you can have walked to (c.floors); where that is not
    // known, the floors here at the heights of the rooms the picture shows you may be in. (The rooms
    // are not held against floors you can have walked to: a room's box is its walls', and a floor at
    // its edge may lie a little outside it - tried, and it cost a right height.)
    const floors = c.floors ?? (c.on === false ? null : tr.floors && g.still ? tr.floors : this.#floors({ x, y }, null, 0, c.band ?? tr.band).floors);
    return {
      x, y, rotation: r.rotation, set: r.set, at: f.at, odo: f.motion.odo, air: f.motion.air,
      floors,
      anchor: told ? { x, y, odo: f.motion.odo, air: f.motion.air } : tr.anchor ?? null,
      slack, still, poor: good ? 0 : tr.poor + 1, way, heading: tr.heading, band: c.band ?? tr.band, score: r.score, n: (tr.n ?? 1) + 1, seen: f.at,
      // (how well the trail's places usually fit - this game's picture against this plan. A worse fit
      // that stays - a part of the dungeon whose pictures fit less well, something that stays over the
      // minimap - becomes usual too: slowly at first, quickly once it has lasted two seconds.)
      usual: usualOf(tr.usual, c.best ?? r.score, good ? 0 : tr.poor + 1),
    };
  }

  /**
   * One picture, with a trail in hand (or a door to begin one at).
   * c: { loc, mm, geo, view, turn (what is known of the minimap's turn: Locator.locate's rotation, rotationWindow), told }
   * @returns what the picture gave - { ok, x.. (the trail's place), how, band, ... } or { ok: false, reason } - or null:
   *          there is no trail and nothing to begin one at (the plan is looked through as ever, and a trail begun at what is found)
   */
  #trail(f, c) {
    const { loc, mm } = c, fixed = typeof c.turn.rotation === 'number' && !(c.turn.rotationWindow > 0);
    const everyTurn = fixed ? { rotation: c.turn.rotation } : {};
    const empty = mm.floorFraction < 0.004;
    // ---- coming in from outside you are at the door: a trail begins there, to be borne out by the picture
    if (!this.track && f.door && Array.isArray(f.door.spots) && f.door.spots.length) {
      let best = null, tried = false;
      for (const d of f.door.spots) {
        const went = Math.max(0, f.motion.odo - (f.door.odo ?? 0)), radius = DOOR_SLACK + went * STRETCH + Math.max(0, f.motion.air - (f.door.air ?? 0)) * AIR;
        if (radius > 60 || empty) continue; // (you have been in a good while: the door is no longer where to look)
        tried = true;
        const p = loc.around(mm, { x: d.x, y: d.y, radius }, everyTurn).find((q) => !q.coarse);
        if (p && p.score >= (LEAST + GOOD) / 2 && (!best || p.score > best.p.score)) best = { p, d, radius };
      }
      if (best) {
        const { p, d, radius } = best, G = this.ground;
        const info = loc.describe(mm, p);
        // the floors: those you can have walked to from the door's own floor; failing that, by the rooms' heights
        let floors = null;
        if (G && Number.isFinite(d.z)) { const seed = G.floorsNear(d.x, d.y, FLOOR_REACH, d.z - 3, d.z + 3); if (seed.length) floors = this.#floors(p, few(seed), radius + NOISE, null).floors; }
        this.track = this.#begin(p, f, info.band, floors ?? undefined);
        this.rival = null;
        return this.#say(f, c, this.track, { how: 'door', mode: 'search', info, went: 0, sharp: null });
      }
      // (not there yet: the game is still drawing its first picture of the place. A moment more before the whole plan is gone through.)
      if ((tried || empty) && f.at - f.door.at < DOOR_FOR) return { ok: false, spare: false, empty, reason: 'you have just come in: looked for at the door, and not found there yet' };
    }
    const tr = this.track;
    if (!tr) return null;
    const g = this.#gone(tr, f);
    // (so far gone since - the game was not heard from for a while - that the trail says nothing any more)
    if (g.reach + tr.slack > TRAIL_MOST) { this.track = null; this.rival = null; this.whole = null; return null; }
    if (empty) {
      // nothing on the minimap at all (it is hidden, or a loading screen is up): standing, you are where you stood
      if (g.still) return this.#say(f, c, tr, { how: 'held', held: true, went: 0, sharp: null, score: 0 });
      return { ok: false, empty: true, reason: 'the minimap shows no floor at all', spare: false };
    }
    // ---- 1. on from where you were: no further than you have gone
    const reach = g.still ? NOISE : g.reach + NOISE + tr.slack;
    // (what a place has to fit to take the trail somewhere else: as well as the trail's places usually do)
    const sure = sureOf(tr), well = wellOf(tr);
    const head = (tr.heading ?? tr.rotation) + (tr.way ?? 0);
    let expect = g.still ? tr : { x: tr.x + Math.cos(head) * g.went, y: tr.y + Math.sin(head) * g.went };
    // (nowhere further from the last place known for sure than you have gone since - where you would have got to going on as you were, too)
    const within = this.#sure(tr, f);
    if (within && expect !== tr) { const d = Math.hypot(expect.x - within.x, expect.y - within.y), most = Math.max(0, within.radius - 0.5); if (d > most) expect = { x: within.x + (expect.x - within.x) * most / d, y: within.y + (expect.y - within.y) * most / d }; }
    const inside = (p) => !within || Math.hypot(p.x - within.x, p.y - within.y) <= within.radius;
    // (the storeys you can have got to: the sets of rooms of the others are not looked at. Where
    // rooms lie one over the other that is most of them - and a picture that fits nowhere, which
    // has every set near tried, took seconds there.)
    const heights = this.#heights(tr, g, reach);
    const a = loc.follow(mm, { from: tr, expect, sigma: 1 + 0.5 * g.went + tr.slack, reach, fixedRotation: fixed, heights, within });
    let best = { r: a, kind: g.still ? 'stood' : 'followed', ...this.#floors(a, tr.floors, reach, null) };
    // ---- 2. not found well there: everything you can have got to is looked through, at every turn
    // (a flick of the mouse turns you further than the climb looks; a stair takes you into another set of rooms)
    if (a.score < sure || best.on === false) {
      // (a rough look, and the two best places it gives besides the one in hand settled to the pixel)
      const look = (turn) => {
        let n = 0;
        for (const p of loc.around(mm, { x: tr.x, y: tr.y, radius: reach, heights }, { ...turn, rough: true, keep: 6 })) {
          if (p.score < FAIR - 0.1 || n >= 2) break;
          if (Math.hypot(p.x - best.r.x, p.y - best.r.y) <= 2.5 && Math.abs(angDiff(p.rotation, best.r.rotation)) <= 10 * D2R) continue;
          n++;
          const s = loc.follow(mm, { from: p, reach: 3, sigma: 1, weight: 0, fixedRotation: fixed, heights });
          if (Math.hypot(s.x - tr.x, s.y - tr.y) > reach || !inside(s)) continue;
          const cand = { r: s, kind: 'looked round', ...this.#floors(s, tr.floors, reach, null) };
          // (one on a floor you can have walked to before one that is not; then the better fit - by enough to leave the place the climb came to)
          const rank = (q) => (q.on === false ? 0 : 1);
          if (cand.r.score < sure) continue;
          if (rank(cand) > rank(best) || (rank(cand) === rank(best) && cand.r.score > best.r.score + 0.03)) best = cand;
        }
      };
      // with the turn about as it was first (between two pictures you turn a little); at every turn where that is not it
      look(fixed ? everyTurn : { rotation: tr.rotation, rotationWindow: 48 * D2R });
      if (!fixed && (best.r.score < well || best.on === false)) look({});
    }
    // (well: as the trail's places usually do, or nearly. A picture that falls well short of that
    // has something over it, and where it fits best is not to be gone by - fit "good" or not.)
    const good = best.on !== false && best.r.score >= well;
    // A picture that fits nowhere well - something is over part of the minimap - does not lead the
    // trail: for a while it is carried on as you were going, as far as the game says you have
    // gone, and the picture only has a say in where exactly, and in how you have turned.
    // (Standing, such a picture moves nothing: see below.)
    let carried = null;
    if (!good && !g.still && tr.poor < POOR_MOST && tr.slack < SLACK_MOST) {
      const d = loc.follow(mm, { from: tr, expect, sigma: 1 + 0.25 * g.went, reach, weight: 0.05, most: 1, fixedRotation: fixed, heights, within });
      const on = this.#floors(d, tr.floors, reach, null);
      if (d.score >= FAIR && on.on !== false) carried = { r: { ...d, sharp: null }, kind: 'carried on', ...on, best: best.on !== false ? best.r.score : d.score };
    }
    if (good) {
      const info = loc.describe(mm, best.r);
      this.track = this.#step(tr, { ...best, band: info.band }, f, g);
      this.rival = null; this.wholeGap = WHOLE_EVERY; this.whole = null;
      return this.#say(f, c, this.track, { how: best.kind, info, went: g.went, sharp: best.r.sharp });
    }
    // ---- 3. a place that fits well where the trail cannot have led: followed on its own, and believed once it has held
    let rv = this.rival;
    if (rv) {
      const g2 = this.#gone(rv, f), reach2 = g2.still ? NOISE : g2.reach + NOISE + rv.slack;
      const head2 = (rv.heading ?? rv.rotation) + (rv.way ?? 0);
      const a2 = loc.follow(mm, { from: rv, expect: g2.still ? rv : { x: rv.x + Math.cos(head2) * g2.went, y: rv.y + Math.sin(head2) * g2.went }, sigma: 1 + 0.5 * g2.went + rv.slack, reach: reach2, fixedRotation: fixed });
      rv = a2.score >= wellOf(rv) ? this.#step(rv, { r: a2, ...this.#floors(a2, rv.floors, reach2, null), on: null }, f, g2) : null;
    }
    if (!rv && best.on === false && best.r.score >= sure) rv = this.#begin(best.r, f, loc.describe(mm, best.r).band); // (right there, with no floor to it that the map knows)
    const lost = f.at - (tr.seen ?? tr.at);
    if (!rv && f.at - this.widerAt >= 1000 && (lost >= LOST_AFTER || tr.poor >= 5)) {
      // further off than you can have gone, on any storey: this is where a trail that has gone wrong is put right
      this.widerAt = f.at;
      let far = null, tried = 0;
      for (const p of loc.around(mm, { x: tr.x, y: tr.y, radius: reach + WIDER }, { ...everyTurn, rough: true, keep: 6 })) {
        if (tried >= 3 || p.score < sure - 0.15) break;
        // (as near as you can have got was looked at above - but not on a storey you cannot have got to: a
        // lift the map does not know takes you there standing, and the floors may lack a way up that there is)
        if (Math.hypot(p.x - tr.x, p.y - tr.y) <= reach && loc.setAtKey(p.set, heights)) continue;
        tried++;
        const q = loc.follow(mm, { from: p, reach: 3, sigma: 1, weight: 0, fixedRotation: fixed, heights: 'own' });
        if (q.score >= sure && (!far || q.score > far.score)) far = q;
      }
      if (far) rv = this.#begin(far, f, loc.describe(mm, far).band);
    }
    // ---- the whole plan: sooner on the move than standing, where a picture that does not fit is most likely one with something over it
    if (!rv) rv = this.#whole(f, c, g, lost, sure, fixed);
    this.rival = rv;
    if (rv && rv.n >= CONFIRM) {
      const leapt = Math.hypot(rv.x - tr.x, rv.y - tr.y);
      this.track = rv; this.rival = null; this.wholeGap = WHOLE_EVERY; this.whole = null;
      return this.#say(f, c, rv, { how: 'leap', mode: 'search', info: loc.describe(mm, rv), went: g.went, sharp: null, leapt });
    }
    if (g.still) {
      // You stand, and the picture does not show the place you stand at: something is over the
      // minimap. You are where you stood (and have turned as the picture says, where it fits at all).
      // (A picture that goes on fitting worse while you stand is how the pictures fit here, as on the move: see usualOf.)
      const stale = (tr.stale ?? 0) + 1, some = best.r.score >= FAIR;
      this.track = { ...tr, at: f.at, rotation: some ? best.r.rotation : tr.rotation, stale, usual: some ? usualOf(tr.usual, best.r.score, stale) : tr.usual };
      return this.#say(f, c, this.track, { how: 'held', held: true, went: 0, sharp: null, score: best.r.score });
    }
    if (carried) {
      const info = loc.describe(mm, carried.r);
      this.track = this.#step(tr, { ...carried, band: info.band }, f, g);
      return this.#say(f, c, this.track, { how: carried.kind, info, went: g.went, sharp: null });
    }
    return {
      ok: false, spare: false, tried: { x: best.r.x, y: best.r.y, rotation: best.r.rotation }, score: best.r.score,
      reason: best.on === false && best.r.score >= sure
        ? `a place that fits (${best.r.score.toFixed(2)}) where you cannot have walked to in the ${g.went.toFixed(0)} yards you have gone: believed once ${CONFIRM} pictures agree`
        : `nothing fits where you can have got to in the ${g.went.toFixed(0)} yards you have gone (the best: ${best.r.score.toFixed(2)})`,
    };
  }

  /**
   * The whole plan, looked through a little with each picture: for when the trail's place has not
   * fitted for a while - you were moved all at once (a summons, a way the map does not know), or
   * the trail has gone wrong. All of it takes seconds, at every turn the minimap may have. Done in
   * one go, the trail saw nothing for as long: a minimap that only had something over it for a
   * few seconds while you ran cost eight more, and the trail with them. So such a look is begun
   * with one picture and gone on with by the next ones; and what it finds - where you were when
   * that picture was taken - is looked for in the picture of now, as far from there as the game
   * says you have gone since.
   * @returns a trail begun where you are found (to be borne out by the next pictures, as any place you cannot have walked to), or null
   */
  #whole(f, c, g, lost, sure, fixed) {
    const { loc, mm } = c;
    let w = this.whole;
    if (w && w.loc !== loc) w = this.whole = null; // (the minimap shows another stretch now: what was begun is of no use)
    if (!w) {
      if (lost < (g.still ? 4 : 2) * LOST_AFTER || f.at - this.wholeAt < this.wholeGap || mm.floorFraction < 0.1) return null;
      this.wholeAt = f.at; this.wholeGap = Math.min(60000, this.wholeGap * 2);
      w = this.whole = { loc, look: loc.wholeBegin(mm, { ...c.turn }), odo: f.motion.odo, air: f.motion.air };
    }
    if (!loc.wholeStep(w.look, g.still ? WHOLE_STOOD : WHOLE_SLICE)) return null;
    this.whole = null;
    const p = loc.wholeEnd(w.look, { fixedRotation: fixed });
    if (!p.ok || p.score < sure) return null;
    const went = Math.max(0, f.motion.odo - w.odo), aired = Math.max(0, f.motion.air - w.air);
    if (went < 0.5 && aired < 0.05) return this.#begin(p, f, loc.describe(w.look.mm, p).band);
    const radius = went * STRETCH + aired * AIR + NOISE;
    if (radius > WHOLE_REACH) return null;
    let best = null, tried = 0;
    for (const q of loc.around(mm, { x: p.x, y: p.y, radius }, { ...(fixed ? { rotation: c.turn.rotation } : {}), rough: true, keep: 6 })) {
      if (tried++ >= 3 || q.score < sure - 0.15) break;
      const s = loc.follow(mm, { from: q, reach: 3, sigma: 1, weight: 0, fixedRotation: fixed, heights: 'own' });
      if (s.score >= sure && (!best || s.score > best.score)) best = s;
    }
    return best ? this.#begin(best, f, loc.describe(mm, best).band) : null;
  }

  /** What is said of a picture that gave the trail's place. */
  #say(f, c, tr, o) {
    const info = o.info ?? null;
    let span = tr.floors ? spanOf(tr.floors) : null;
    // (on a lift you are on its platform, which is no floor of the building: anywhere between the heights it travels)
    const lift = span ? (this.ground?.lifts ?? []).find((L) => Math.hypot(tr.x - L.x, tr.y - L.y) <= (L.r ?? 7) + 1.5) : null;
    if (lift) span = [Math.min(span[0], lift.lo), Math.max(span[1], lift.hi)];
    return {
      ok: true, mode: o.mode ?? 'follow', how: o.how, held: !!o.held, score: o.score ?? tr.score, margin: tr.score, went: o.went, sharp: o.sharp, leapt: o.leapt,
      // the heights you may be at: the floors you may stand on where the map has them, else the rooms the picture shows you may be in
      band: span ? [span[0] - 0.5, span[1] + 0.5] : info?.band ?? tr.band ?? null, floors: span,
      rooms: info?.rooms ?? null, hidden: info?.hidden ?? null, odd: info?.odd ?? null,
    };
  }
}

/**
 * How well the trail's places usually fit, with one more picture: quick to take a better fit for
 * usual; slow to take a worse one (a minute or so) - until it has stayed worse for POOR_QUICK
 * pictures running (`poor`), from when it is taken on in a second or two. That is for a part
 * of a dungeon whose pictures fit the plan a little less well, which must not leave you greyed
 * all the way through it. A fit far under the usual (DEEP) is not that: something is over the
 * minimap, and what fits "best" under it may be anywhere - half a minimap of something lit fits
 * many a hall. That stays a poor picture for as long as it lasts (half a minute of it, and it
 * has come down to where the quick way takes over).
 */
function usualOf(usual, score, poor = 0) {
  if (!Number.isFinite(usual)) return score;
  if (score > usual) return usual + (score - usual) * 0.2;
  return usual - (usual - score) * (poor >= POOR_QUICK && usual - score <= DEEP ? 0.12 : 0.004);
}
/** What a picture has to fit to count as one of the trail's own: about as well as its places usually do. */
const wellOf = (tr) => Math.max(LEAST, (tr.usual ?? GOOD) - 2 * DIP);
/** ...and what a place has to fit to take the trail somewhere else: nearly as well as they usually do. */
const sureOf = (tr) => Math.max(LEAST + 0.05, (tr.usual ?? GOOD) - DIP);
/** Of floors sorted the nearest first: those about as near as the nearest (a dozen at the most). */
function few(c) {
  const d0 = c[0].d ?? 0, out = [];
  for (const f of c) { if ((f.d ?? 0) > d0 + 1.2 || out.length >= 12) continue; out.push({ t: f.t, cell: f.cell, n: f.n, z: f.z, x: f.x, y: f.y }); }
  return out;
}
/** The heights some floors span: [lowest, highest]. */
function spanOf(floors) {
  let lo = Infinity, hi = -Infinity;
  for (const f of floors) { if (f.z < lo) lo = f.z; if (f.z > hi) hi = f.z; }
  return [lo, hi];
}
