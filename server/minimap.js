// Where you are inside a dungeon, read off the game's minimap.
//
// Inside a dungeon or a raid the game tells an addon which one you are in and nothing of where.
// But its minimap is on the screen, and the picture on it is centred on you. The helper that
// reads the strip already has the picture of the game window (strip-reader.cs): while you are
// in a dungeon the map has a plan of (extractor/jobs/minimap.js: every dungeon that is one
// building), it is asked to hand over the small square of that picture the minimap is in, a
// few times a second. That square is looked for on the plan (minimap-match.js, in a thread of
// its own: minimap-worker.js), and where it fits is where you are: handed on with
// tracker.placed(), as the place the game's combat log gives is (combatlog.js) - which stays
// the fallback, and is what this is checked against whenever it has something to say.
//
// A picture is not looked at on its own. You get from one place to the next on your feet, and
// the strip says how fast you are going: summed up here, reading by reading, that is how many
// yards you have gone - handed over with every picture, so that the place is looked for where
// you can have got to, and held while you stand (minimap-find.js: the trail). And coming in
// from outside you are at the door: the game's own spot for it (world.json: entrances) is where
// the trail begins. A door the map's data does not have is noted the first time you come in by
// it (<dataDir>/user/dungeon-doors.json) and known from then on.
//
// What following you teaches of the dungeon itself is kept (minimap-places.js), and goes to the
// Atlas database with the rest of what this copy learns, as every other copy's comes back from
// it: the doors; the ways the map's floors do not have (a lift it does not know, a portal) - a
// place you cannot have walked to that then held, noted with where you were last sure to be;
// and how far the minimap's place was from the combat log's, by the part of the dungeon.
//
// Only the picture of the game's own window is read, the same picture the strip is read off;
// nothing is sent into the game, and nothing of the picture is kept or leaves this computer
// (the last square is held in memory, for a report of a problem you make yourself).
//
// What it cannot do: a dungeon that stands on ground of its own (the Deadmines, Shadowfang
// Keep: the map build makes no plan of those - see extract.js); a minimap that is hidden,
// covered by another window's overlay, or reskinned so that neither the addon's word nor the
// gold rim says where it is; a room the game has no picture of; a place in the open air inside
// a dungeon, where the game's minimap shows nothing. Then nothing is said, and the page keeps
// the last place for a little while (viewer/js/player.js).
//
// ("minimap": false in config.json switches it off.)
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { note, changed } from './log.js';
import { encodePng } from './png.js';
import { squareFor, cornerFor } from './minimap-find.js';
import { Places } from './minimap-places.js';

const EVERY = 200;        // ms between two pictures of the minimap
const FRESH = 2500;       // ms: a place this new is where you are, whatever the combat log says of a moment ago
const TRACK_FOR = 30000;  // ms of your way kept, to hold the combat log's places against
const STILL = 0.7;        // yards: moved less than this round the moment of a blow, you stood still
const NUDGE_MOST = 2.5;   // pixels: the most the minimap's middle is moved by what the combat log says
const NUDGE_SAMPLES = 9;
const SPARE_AFTER = 6;    // looks in a row that found nothing, after which they are spaced out...
const SPARE_EVERY = 1000; // ...to one in this many ms (and three times as far apart after thirty of them)
const GAP = 1000;         // ms: the strip not read for longer than this, and how you moved meanwhile is not known...
const UNSEEN = 9;         // ...yards a second you may have gone then
const CAME_WITHIN = 120000; // ms: seen outside this lately and now inside, you have come in by a door
const DOOR_FOR = 60000;   // ms after coming in for which the door is handed over as where to begin
const DOOR_STOOD = 3;     // yards: found having gone less than this since you came in, you are found at the door
const TRAIL_KEPT = 1500;  // pictures whose outcome is kept, for a report of a problem (five minutes of them)
const WAY_HOLD = 12;      // pictures that have to bear out the place a way took you to, before the way is noted...
const WAY_WITHIN = 30000; // ...within this many ms
const WAY_LEAST = 1.5;    // yards: a "way" shorter than this, and to the same height, is no way
const LEVEL_WIDE = 4;     // yards: floors spanning more than this are not one height

const round = (v, k = 100) => (Number.isFinite(v) ? Math.round(v * k) / k : v ?? null);
/** The one height some floors are at ([lowest, highest]) - or null: not known, or more than one storey. */
const levelOf = (span) => (Array.isArray(span) && span.every(Number.isFinite) && span[1] - span[0] <= LEVEL_WIDE ? (span[0] + span[1]) / 2 : null);

export class Minimap {
  /**
   * @param tracker  the live link (tracker.js): asked for the pictures (look), told what was found (placed, minimapState)
   * @param Thread   (for tests) what the matcher's thread is made with
   * @param onLearned  () => called when something of a dungeon was learned that is worth sending on
   */
  constructor(cfg, { tracker, Thread = Worker, onLearned = null } = {}) {
    this.dataDir = cfg.dataDir;
    this.tracker = tracker;
    this.Thread = Thread;
    this.worker = null;
    this.busy = false;        // a picture is with the matcher
    this.waiting = null;      // the newest picture that came meanwhile (an older one waiting is dropped for it)
    this.sent = 0;
    this.now = null;          // what the strip last said that matters here: { map, said, facing, client }
    this.wanted = false;      // you are in a dungeon the map has a plan of, and the game hides where
    this.square = null;       // the square of the game's picture asked for
    this.plans = new Map();   // map -> whether it has a plan (looked up once a minute at most)
    this.fix = null;          // the last place found: { map, x, y, at, ... }
    this.track = [];          // the places found of late: [{ at, x, y, rotation, scale }]
    this.hint = null;         // where the combat log last had you
    this.check = null;        // the combat log's places held against the minimap's (see logged)
    this.nudge = [0, 0];      // pixels the minimap's middle is moved by, as that check says
    this.nudges = [];
    this.kept = null;         // the last picture and what it gave, for a report of a problem
    this.count = { pictures: 0, found: 0, followed: 0, searched: 0, refused: 0, dropped: 0, why: {} };
    this.state = 'idle';
    this.since = Date.now();
    this.fruitless = 0;       // looks in a row that found nothing (see crop)
    this.sentAt = 0;
    // how far you have gone, as the game's word of your speed sums up (yards), and how long of that in the air (seconds)
    this.odo = 0; this.air = 0;
    this.moved = null;        // the strip's last word of how you move: { at, speed, falling, said }
    this.was = null;          // where the reading before had you: { map, inside, at }
    this.came = null;         // you came in from outside: { map, at, odo, air, found }
    this.flying = null;       // the picture that is with the matcher: { at, odo }
    this.places = new Places(cfg.dataDir, { onNew: onLearned }); // the doors, the ways and the checks: this copy's and everybody's
    this.proving = null;      // a way just gone, until the place it took you to has held: { map, way, n, at }
    this.trail = [];          // what the last pictures gave (see trailKept)
    this.count.how = {};
  }

  start() { /* (nothing runs until you are in a dungeon: see heard) */ }

  stop() {
    this.places.save(true);
    this.#look(null);
    try { this.worker?.terminate(); } catch { /* gone */ }
    this.worker = null; this.busy = false; this.waiting = null;
  }

  /** Has this map a plan? (asked with every reading of the strip: the answer is kept for a minute) */
  #hasPlan(map) {
    const p = this.plans.get(map), t = Date.now();
    if (p && t - p.at < 60000) return p.has;
    let has = false;
    try { has = fs.existsSync(path.join(this.dataDir, 'maps', String(map), 'minimap.bin')); } catch { /* not there */ }
    this.plans.set(map, { has, at: t });
    return has;
  }

  #set(state, why = null) {
    if (state === this.state && why === this.why) return;
    this.state = state; this.why = why; this.since = Date.now();
    if (changed('minimap', [state, why, this.now?.map ?? null])) note('minimap', `${state}${why ? `: ${why}` : ''}`, { map: this.now?.map ?? null });
    this.tracker?.minimapState?.(this.brief());
  }

  /** What the page is told (it goes out with everything else the link says: kept small, and changed seldom). */
  brief() { return { state: this.state, why: this.why ?? null, map: this.wanted ? this.now?.map ?? null : null }; }

  #look(square) {
    const same = (a, b) => (!a && !b) || (a && b && a.every((v, i) => Math.abs(v - b[i]) <= 2));
    // (while looks find nothing they are spaced out - see crop - and the helper is asked for no more pictures than are looked at)
    const every = this.fruitless >= 30 ? 3 * SPARE_EVERY : this.fruitless >= SPARE_AFTER ? SPARE_EVERY : EVERY;
    if (same(square, this.square) && (!square || every === this.every)) return;
    this.square = square; this.every = every;
    this.tracker?.look?.(square, every);
  }

  /**
   * The strip was read (tracker.js, many times a second).
   * @param d       what it said (strip.js)   @param said  what the addon says of the minimap (NameCache.minimap), or null
   * @param window  the game's picture: { w, h }
   */
  heard(d, said, window) {
    const client = window && window.w > 0 && window.h > 0 ? [window.w, window.h] : null;
    const map = d.map;
    const wanted = !!client && !!d.inInstance && d.mode !== 'world' && this.#hasPlan(map);
    if (this.now && (this.now.map !== map || (client && this.now.client && (this.now.client[0] !== client[0] || this.now.client[1] !== client[1])))) {
      // another dungeon, or the game's window another size: nothing of before holds
      this.worker?.postMessage({ type: 'reset' });
      this.fix = null; this.track = []; this.hint = null; this.want = null; this.nudges = []; this.nudge = [0, 0]; this.fruitless = 0;
    }
    this.now = { map, said: said ?? null, facing: Number.isFinite(d.facing) ? d.facing : null, client };
    // How far you have gone: the speed the strip said last, for as long as it stood. (Not read
    // for a while - a loading screen, the game behind another window - you may have run all the time.)
    const t = Date.now(), prev = this.moved;
    if (prev) {
      const dt = t - prev.at;
      if (dt > GAP) this.odo += (Math.min(60000, dt) / 1000) * UNSEEN;
      else if (dt > 0) { if (Number.isFinite(prev.speed)) this.odo += (prev.speed * dt) / 1000; if (prev.falling) this.air += dt / 1000; }
    }
    this.moved = { at: t, speed: Number.isFinite(d.speed) ? d.speed : null, falling: !!d.falling, said: Number.isFinite(d.speed) };
    // Coming in: out of doors (or in another dungeon) a moment ago, and now in here.
    const inside = !!d.inInstance && d.mode !== 'world';
    if (inside && this.was && (this.was.map !== map || !this.was.inside) && t - this.was.at < CAME_WITHIN) this.came = { map, at: t, odo: this.odo, air: this.air, found: false };
    else if (this.came && (this.came.map !== map || !inside)) this.came = null;
    this.was = { map, inside, at: t };
    if (wanted !== this.wanted) {
      this.wanted = wanted;
      if (wanted) this.#set('looking', null);
      else this.waiting = null;
    }
    // (in a dungeon whose place the game hides, and the map has no plan of it: said, so that the page can say why you are not shown)
    if (!wanted) { this.#set(client && d.inInstance && d.mode !== 'world' ? 'no plan' : 'idle', null); this.#look(null); return; }
    // the square to be sent: where the matcher found the minimap; before it has, where the addon says it is; else the corner the game puts it in
    const g = said?.known && Number.isFinite(said.cx) && said.half >= 30 ? { cx: said.cx, cy: said.cy, half: said.half } : null;
    this.#look(this.want ?? (g ? squareFor(g, client) : cornerFor(client)));
  }

  /** Nothing is heard from the game any more (no signal, the game closed, nobody looking at the map). */
  quiet() {
    if (!this.wanted && !this.square) return;
    this.wanted = false; this.waiting = null;
    this.#look(null);
    this.#set('idle', null);
  }

  /** A picture of the minimap has come (tracker.js): { x, y, w, h (where it is in the game's picture), data (R G B, row by row) } */
  crop(c) {
    if (!this.wanted || !this.now?.client) return;
    this.count.pictures++;
    const frame = {
      map: this.now.map, at: Date.now(), origin: [c.x, c.y], client: this.now.client,
      pic: { data: c.data, w: c.w, h: c.h, ch: 3 },
      said: this.now.said, facing: this.now.facing, nudge: this.nudge,
      hint: this.hint && this.hint.map === this.now.map ? this.hint : null,
    };
    // (how far you have gone by this picture; and, just come in and not found yet, where the door is)
    const m = this.moved;
    if (m && m.said) {
      const dt = Math.min(GAP, Math.max(0, frame.at - m.at)) / 1000;
      frame.motion = { odo: this.odo + (m.speed ?? 0) * dt, air: this.air + (m.falling ? dt : 0), speed: m.speed, falling: m.falling };
    }
    const came = this.came;
    if (came && came.map === frame.map && !came.found && frame.at - came.at < DOOR_FOR && frame.motion) {
      const spots = this.#doors(frame.map);
      if (spots.length) frame.door = { at: came.at, odo: came.odo, air: came.air, spots };
    }
    // (the ways of this dungeon that its floors do not have: where to look when you are not where you can have walked to)
    const ways = this.places.ways(frame.map);
    if (ways.length) frame.ways = ways;
    // A look that finds nothing is a look through the whole plan, every time. Where they pile up -
    // a minimap with something over it, or made over by another addon - they are spaced out, so
    // that a core of the processor is not spent on looking for what is not there.
    if (this.fruitless >= SPARE_AFTER && frame.at - this.sentAt < (this.fruitless >= 30 ? 3 : 1) * SPARE_EVERY) { this.count.dropped++; return; }
    if (this.busy) { if (this.waiting) this.count.dropped++; this.waiting = frame; return; }
    this.#send(frame);
  }

  #send(frame) {
    if (!this.worker) {
      try {
        this.worker = new this.Thread(new URL('./minimap-worker.js', import.meta.url), { workerData: { dataDir: this.dataDir } });
        this.worker.on('message', (m) => { if (m.type === 'result') this.#result(m.result, m.pic); });
        this.worker.on('error', (err) => { note('minimap', 'the thread that looks for the minimap stopped', { error: err.message }); this.worker = null; this.busy = false; });
        this.worker.unref?.();
      } catch (err) { note('minimap', 'the thread that looks for the minimap could not be started', { error: err.message }); this.#set('off', err.message); return; }
    }
    this.busy = true;
    this.sentAt = frame.at;
    this.flying = { at: frame.at, odo: frame.motion?.odo ?? null };
    // (the picture's bytes go over as they are, with no copy: a block of their own)
    const bytes = new Uint8Array(frame.pic.data.length);
    bytes.set(frame.pic.data);
    frame.pic = { ...frame.pic, data: bytes };
    this.worker.postMessage({ type: 'frame', id: ++this.sent, frame }, [bytes.buffer]);
  }

  #result(r, pic) {
    this.busy = false;
    const c = this.count;
    if (r.ok) { c.found++; if (r.mode === 'follow') c.followed++; else c.searched++; } else { c.refused++; const k = r.empty ? 'nothing on the minimap' : r.noPlan ? 'no plan' : !r.geo ? 'minimap not found' : r.mode === 'search' ? 'no fit' : 'other'; c.why[k] = (c.why[k] ?? 0) + 1; }
    this.kept = { pic, result: r, at: r.at };
    // (a look along the trail that found nothing cost next to nothing, and the next may find you: those are not spaced out)
    if (r.ok) this.fruitless = 0; else if (!r.empty && !r.noPlan && r.spare !== false) this.fruitless++;
    if (r.how) c.how[r.how] = (c.how[r.how] ?? 0) + 1;
    this.#keep(r);
    if (r.want) this.want = r.want;
    const here = this.wanted && this.now?.map === r.map;
    if (here && r.ok) {
      const first = !this.fix || r.at - this.fix.at > FRESH;
      // (where a copy's checks say that the minimap's place is off one way in this part of the dungeon, that is taken off it)
      const off = this.places.shift(r.map, r.x, r.y);
      const x = off ? r.x - off[0] : r.x, y = off ? r.y - off[1] : r.y;
      this.fix = { map: r.map, x, y, facing: r.facing ?? null, at: r.at, band: r.band ?? null, score: r.score };
      // (found: the place as the picture gave it, which the checks are made of; sure: not a guess, nor held while the picture showed nothing)
      this.track.push({ at: r.at, x, y, found: [r.x, r.y], sure: r.how !== 'carried on' && !r.held, rotation: r.rotation, scale: r.scale });
      while (this.track.length && r.at - this.track[0].at > TRACK_FOR) this.track.shift();
      // (guess: something is over the minimap, and this is where you would have got to going on as you were)
      this.tracker?.placed?.({ map: r.map, x, y, facing: r.facing ?? null, at: r.at, from: 'minimap', band: r.band ?? null, guess: r.how === 'carried on' });
      if (first) note('minimap', 'you are found on the minimap', { map: r.map, x: round(r.x, 10), y: round(r.y, 10), fit: round(r.score), ahead: round(r.margin), view: r.view, turned: round((r.rotation * 180) / Math.PI, 10), took: Math.round(r.ms), how: r.how ?? null, minimap: this.#geoNote(r.geo) });
      if (r.how === 'leap') note('minimap', 'a place you cannot have walked to has held for three pictures running: you are taken to be there', { map: r.map, x: round(r.x, 10), y: round(r.y, 10), from: this.track.length > 1 ? [round(this.track[this.track.length - 2].x, 10), round(this.track[this.track.length - 2].y, 10)] : null, yards: round(r.leapt, 10), fit: round(r.score) });
      if (r.how === 'way') note('minimap', 'a way the map\'s floors do not have, known from those who went it before: you are taken to have gone it', { map: r.map, x: round(r.x, 10), y: round(r.y, 10), yards: round(r.leapt, 10), fit: round(r.score) });
      this.#proved(r);
      this.#cameIn(r);
      this.#set('found', null);
    } else if (here) {
      const lost = !this.fix || r.at - this.fix.at > FRESH;
      if (lost) this.#set(r.empty ? 'nothing' : !r.geo ? 'no minimap' : 'looking', r.reason ?? null);
    }
    if (r.geo && changed('minimap geo', [r.geo.from, Math.round(r.geo.cx), Math.round(r.geo.cy), Math.round(r.geo.half)])) note('minimap', 'where the minimap is on the screen', this.#geoNote(r.geo));
    const next = this.waiting;
    this.waiting = null;
    if (next && this.wanted) this.#send(next);
  }

  /** The doors of a dungeon: where you stand having come in - the game's own, those noted here, those other copies found (minimap-places.js). */
  #doors(map) { return this.places.doors(map); }

  /**
   * A picture gave a place. The first since you came in, and you had hardly moved by then:
   * that is where the door puts you. One the map's data does not have is noted, to begin at next
   * time - and counted each time you come in by it again.
   */
  #cameIn(r) {
    const came = this.came;
    if (!came || came.found || came.map !== r.map) return;
    came.found = true;
    const went = this.flying && Number.isFinite(this.flying.odo) && this.flying.at === r.at ? this.flying.odo - came.odo : Infinity;
    if (!(went < DOOR_STOOD)) return;
    const what = this.places.cameIn(r.map, { x: r.x, y: r.y, z: levelOf(r.floors), facing: Number.isFinite(r.facing) ? r.facing : null });
    if (what === 'new') note('minimap', 'a door the map did not know: noted, to begin at when you next come in by it', { map: r.map, x: round(r.x, 10), y: round(r.y, 10) });
  }

  /**
   * A way gone: a place you cannot have walked to that held for three pictures (the result says
   * from where - the last place the picture told for sure - to where it was first seen). That may
   * as well be the trail having gone wrong and been put right. So it is noted only once the
   * place it took you to has been borne out by a dozen pictures more; and one finding is not
   * gone by (minimap-places.js). A way that was known, taken, and borne out the same is counted
   * as gone once more: so each copy that goes a way other copies found adds its own word to theirs.
   */
  #proved(r) {
    const p = this.proving;
    if (p && (p.map !== r.map || r.at - p.at > WAY_WITHIN || ['leap', 'way', 'found', 'door'].includes(r.how))) this.proving = null;
    else if (p && ['followed', 'stood', 'looked round'].includes(r.how) && ++p.n >= WAY_HOLD) {
      this.proving = null;
      const times = this.places.went(p.map, p.way.from, p.way.to);
      note('minimap', p.way.known ? 'a way known from before, gone and borne out: counted' : times > 1 ? 'a way the map\'s floors do not have, gone again: counted' : 'a way the map\'s floors do not have: noted (gone by once it is seen again, here or by another copy)', { map: p.map, from: p.way.from.map((v) => round(v, 10)), to: p.way.to.map((v) => round(v, 10)), times });
    }
    // (a way known from before that was taken is to be borne out the same: then this copy has gone it too, and says so)
    const w = r.how === 'leap' || r.how === 'way' ? r.way : null;
    if (!w || !Array.isArray(w.from) || !Array.isArray(w.to)) return;
    // (a step of a yard to the same height is the floors having a hole a cell wide: no way)
    const across = Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1]), up = Number.isFinite(w.from[2]) && Number.isFinite(w.to[2]) ? Math.abs(w.to[2] - w.from[2]) : null;
    if (across < WAY_LEAST && !(up > LEVEL_WIDE)) return;
    this.proving = { map: r.map, way: w, n: 0, at: r.at };
  }

  /**
   * What each of the last pictures gave, kept in memory for a report of a problem (a line of
   * figures apiece - when, whether, how, where, how well it fitted, how far you had gone - and
   * nothing of the picture itself).
   */
  #keep(r) {
    const went = this.flying && this.flying.at === r.at && Number.isFinite(this.flying.odo) ? round(this.flying.odo, 10) : null;
    this.trail.push([r.at, r.ok ? 1 : 0, r.how ?? r.mode ?? null, round(r.ok ? r.x : r.tried?.x, 10) ?? null, round(r.ok ? r.y : r.tried?.y, 10) ?? null,
      Number.isFinite(r.rotation) ? round((r.rotation * 180) / Math.PI, 1) : null, round(r.score), Math.round(r.ms ?? 0), went, this.moved?.speed ?? null,
      r.floors ? r.floors.map((v) => round(v, 10)) : r.band ? r.band.map((v) => round(v, 10)) : null, round(r.sharp, 1000) ?? null, round(r.slack, 10) ?? null,
      r.geo ? (r.geo.from === 'picture' ? 'p' : r.geo.from === 'addon' ? 'a' : 'ap') : null, r.ok ? null : r.reason ?? null]);
    if (this.trail.length > TRAIL_KEPT) this.trail.splice(0, this.trail.length - TRAIL_KEPT);
  }

  /** For a report of a problem: what the last pictures gave, oldest first. */
  trailKept() {
    return {
      columns: ['at (ms)', 'found', 'how', 'x', 'y', 'turned (degrees)', 'fit', 'took (ms)', 'yards gone', 'speed', 'heights', 'sharp', 'slack', 'minimap by (a: the addon, p: the picture, ap: the addon, the picture agreeing)', 'why not'],
      rows: this.trail,
    };
  }

  #geoNote(g) {
    if (!g) return null;
    const s = g.said;
    return { by: g.from, middle: [round(g.cx), round(g.cy)], half: round(g.half), rim: g.rim ? { middle: [round(g.rim.cx), round(g.rim.cy)], radius: round(g.rim.r), spokes: g.rim.n, off: round(g.rim.rms) } : null,
      addon: s?.known ? { middle: [round(s.cx), round(s.cy)], half: round(s.half), zoom: s.zoom, radius: s.radius, turns: s.rotates, round: s.round, shown: s.shown, screen: s.screen } : s ? 'said nothing usable' : 'says nothing (an older addon)' };
  }

  /** True while the minimap has you: a place no older than a moment. */
  fresh(now = Date.now()) { return !!this.fix && this.wanted && now - this.fix.at <= FRESH; }

  /**
   * The combat log says where you were (combatlog.js): { map, x, y, facing, at }. It is exact,
   * and it is late - the game writes its log in bursts, and a blow is a moment that has passed.
   * So while the minimap has you it is not shown; it is where to look first when the minimap
   * has to be searched for afresh; and it is what the minimap's place is held against: where
   * you stood still round the moment of the blow, the two should be the same spot, and what
   * lies between them says how far off the minimap's middle is taken to be.
   * @returns true where the minimap has you now (the log's place is then not to be shown)
   */
  logged(fix, now = Date.now()) {
    if (!fix || !Number.isFinite(fix.x) || !Number.isFinite(fix.y)) return false;
    this.hint = { map: fix.map, x: fix.x, y: fix.y, at: fix.at };
    const t = this.track;
    if (this.now?.map === fix.map && t.length >= 2) {
      // your place just before and just after the blow
      let a = null, b = null;
      for (const p of t) { if (p.at <= fix.at) a = p; else if (!b) b = p; }
      if (a && b && fix.at - a.at <= 700 && b.at - fix.at <= 700 && Math.hypot(a.x - b.x, a.y - b.y) <= STILL) {
        const k = (fix.at - a.at) / Math.max(1, b.at - a.at), x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
        const off = Math.hypot(x - fix.x, y - fix.y);
        // (kept by the part of the dungeon, and sent on: the place as the picture gave it, where it was no guess)
        if (a.sure && b.sure && a.found && b.found) this.places.checked(fix.map, fix.x, fix.y, a.found[0] + (b.found[0] - a.found[0]) * k - fix.x, a.found[1] + (b.found[1] - a.found[1]) * k - fix.y);
        const c = (this.check ??= { n: 0, sum: 0, worst: 0, last: null });
        c.n++; c.sum += off; c.worst = Math.max(c.worst, off);
        c.last = { at: fix.at, minimap: [round(x), round(y)], log: [round(fix.x), round(fix.y)], off: round(off) };
        if (off <= 6) this.#nudged(x - fix.x, y - fix.y, a.rotation, a.scale);
        if (c.n === 1 || c.n % 20 === 0) note('minimap', 'held against the combat log: the place found on the minimap, and where the game says you stood', { ...c.last, checks: c.n, mean: round(c.sum / c.n), worst: round(c.worst), nudge: this.nudge.map((v) => round(v)) });
      }
    }
    return this.fresh(now);
  }

  /**
   * The minimap's place was (ex, ey) yards north and west of where the game says you stood. A
   * middle taken a pixel off is a place a yard or so off, always the same way on the screen: so
   * the middle is moved, by the middle one of the last few such figures, and never by much.
   */
  #nudged(eX, eY, rotation, scale) {
    if (!Number.isFinite(scale) || scale <= 0) return;
    // yards north and west -> pixels right and down on the screen (the map turned clockwise by `rotation`)
    const ux = -eY * scale, uy = -eX * scale, c = Math.cos(rotation), s = Math.sin(rotation);
    const ex = ux * c - uy * s, ey = ux * s + uy * c;
    // (what the middle should be moved by, counting what it is moved by already)
    this.nudges.push([this.nudge[0] - ex, this.nudge[1] - ey]);
    if (this.nudges.length > NUDGE_SAMPLES) this.nudges.shift();
    if (this.nudges.length < 4) return;
    const mid = (i) => { const v = this.nudges.map((n) => n[i]).sort((p, q) => p - q); return v[v.length >> 1]; };
    const spread = (i, m) => { const v = this.nudges.map((n) => Math.abs(n[i] - m)).sort((p, q) => p - q); return v[v.length >> 1]; };
    const mx = mid(0), my = mid(1);
    if (spread(0, mx) > 0.6 || spread(1, my) > 0.6) return; // (they do not agree: nothing is moved)
    const cap = (v) => Math.max(-NUDGE_MOST, Math.min(NUDGE_MOST, v));
    this.nudge = [cap(mx), cap(my)];
  }

  /**
   * For the dots on the minimap (dots.js): where you are in this dungeon and how its minimap lies,
   * as the last picture gave it - { x, y, rotation (radians the map is turned clockwise by), radius
   * (yards from the minimap's middle to its edge), cx, cy, half (the minimap in the game's picture) }
   * - or null: you are not found just now.
   */
  where(map, now = Date.now()) {
    const k = this.kept?.result;
    if (!k?.ok || k.map !== map || !this.fresh(now) || !k.geo || !(k.scale > 0) || !Number.isFinite(k.rotation)) return null;
    return { x: this.fix.x, y: this.fix.y, rotation: k.rotation, radius: k.geo.half / k.scale, cx: k.geo.cx, cy: k.geo.cy, half: k.geo.half };
  }

  status() {
    const k = this.kept?.result, c = this.count;
    return {
      state: this.state, why: this.why ?? null, since: this.since, wanted: this.wanted, map: this.now?.map ?? null,
      square: this.square, every: this.every ?? EVERY, client: this.now?.client ?? null,
      spared: this.fruitless >= SPARE_AFTER, pictures: c.pictures, found: c.found, followed: c.followed, searched: c.searched, refused: c.refused, dropped: c.dropped, why_refused: c.why,
      // (with the trail: how each picture's place was come by; how far you have gone; whether you came in by a door)
      how: c.how, gone: round(this.odo, 10), speedSaid: this.moved?.said ?? null, cameIn: this.came ? { at: this.came.at, found: this.came.found, doors: this.#doors(this.came.map).length } : null,
      // (what is known of this dungeon beyond the map's own data: doors, ways, checks - this copy's and the other copies')
      places: Number.isInteger(this.now?.map) && this.wanted ? this.places.status(this.now.map) : null,
      fix: this.fix ? { ...this.fix, x: round(this.fix.x), y: round(this.fix.y), age: Date.now() - this.fix.at } : null,
      nudge: this.nudge.map((v) => round(v)), check: this.check ? { checks: this.check.n, mean: round(this.check.sum / this.check.n), worst: round(this.check.worst), last: this.check.last } : null,
      last: k ? {
        at: k.at, ok: k.ok, reason: k.reason ?? null, mode: k.mode ?? null, fit: round(k.score, 1000), ahead: round(k.margin, 1000), took: round(k.ms, 10), view: k.view ?? null, scale: round(k.scale, 10000),
        x: round(k.x), y: round(k.y), turned: Number.isFinite(k.rotation) ? round((k.rotation * 180) / Math.PI, 10) : null, turns: k.turns ?? null, facing: Number.isFinite(k.facing) ? round((k.facing * 180) / Math.PI, 10) : null,
        band: k.band ? k.band.map((v) => round(v, 10)) : null, rooms: k.rooms ?? null, leftOut: k.hidden ?? null, odd: k.odd ?? null, floor: round(k.floor, 1000),
        how: k.how ?? null, went: round(k.went, 10) ?? null, sharp: round(k.sharp, 1000) ?? null, slack: round(k.slack, 10) ?? null, floors: k.floors ? k.floors.map((v) => round(v, 10)) : null,
        tried: k.tried ? { x: round(k.tried.x), y: round(k.tried.y) } : undefined, runnerUp: k.runnerUp ? { x: round(k.runnerUp.x), y: round(k.runnerUp.y), fit: round(k.runnerUp.score, 1000) } : null,
        minimap: this.#geoNote(k.geo),
      } : null,
    };
  }

  /** For a report of a problem: the last picture of the minimap as a PNG file (or null), and where in the game's picture it was. */
  picture() {
    const k = this.kept;
    if (!k?.pic?.data?.length) return null;
    try { return { png: encodePng(k.pic), at: k.at, w: k.pic.w, h: k.pic.h, origin: k.result?.origin ?? null }; } catch { return null; }
  }
}
