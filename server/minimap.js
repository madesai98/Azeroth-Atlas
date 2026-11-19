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

const EVERY = 200;        // ms between two pictures of the minimap
const FRESH = 2500;       // ms: a place this new is where you are, whatever the combat log says of a moment ago
const TRACK_FOR = 30000;  // ms of your way kept, to hold the combat log's places against
const STILL = 0.7;        // yards: moved less than this round the moment of a blow, you stood still
const NUDGE_MOST = 2.5;   // pixels: the most the minimap's middle is moved by what the combat log says
const NUDGE_SAMPLES = 9;
const SPARE_AFTER = 6;    // looks in a row that found nothing, after which they are spaced out...
const SPARE_EVERY = 1000; // ...to one in this many ms (and three times as far apart after thirty of them)

const round = (v, k = 100) => (Number.isFinite(v) ? Math.round(v * k) / k : v ?? null);

export class Minimap {
  /**
   * @param tracker  the live link (tracker.js): asked for the pictures (look), told what was found (placed, minimapState)
   * @param Thread   (for tests) what the matcher's thread is made with
   */
  constructor(cfg, { tracker, Thread = Worker } = {}) {
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
  }

  start() { /* (nothing runs until you are in a dungeon: see heard) */ }

  stop() {
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
    if (r.ok) this.fruitless = 0; else if (!r.empty && !r.noPlan) this.fruitless++;
    if (r.want) this.want = r.want;
    const here = this.wanted && this.now?.map === r.map;
    if (here && r.ok) {
      const first = !this.fix || r.at - this.fix.at > FRESH;
      this.fix = { map: r.map, x: r.x, y: r.y, facing: r.facing ?? null, at: r.at, band: r.band ?? null, score: r.score };
      this.track.push({ at: r.at, x: r.x, y: r.y, rotation: r.rotation, scale: r.scale });
      while (this.track.length && r.at - this.track[0].at > TRACK_FOR) this.track.shift();
      this.tracker?.placed?.({ map: r.map, x: r.x, y: r.y, facing: r.facing ?? null, at: r.at, from: 'minimap', band: r.band ?? null });
      if (first) note('minimap', 'you are found on the minimap', { map: r.map, x: round(r.x, 10), y: round(r.y, 10), fit: round(r.score), ahead: round(r.margin), view: r.view, turned: round((r.rotation * 180) / Math.PI, 10), took: Math.round(r.ms), minimap: this.#geoNote(r.geo) });
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

  status() {
    const k = this.kept?.result, c = this.count;
    return {
      state: this.state, why: this.why ?? null, since: this.since, wanted: this.wanted, map: this.now?.map ?? null,
      square: this.square, every: this.every ?? EVERY, client: this.now?.client ?? null,
      spared: this.fruitless >= SPARE_AFTER, pictures: c.pictures, found: c.found, followed: c.followed, searched: c.searched, refused: c.refused, dropped: c.dropped, why_refused: c.why,
      fix: this.fix ? { ...this.fix, x: round(this.fix.x), y: round(this.fix.y), age: Date.now() - this.fix.at } : null,
      nudge: this.nudge.map((v) => round(v)), check: this.check ? { checks: this.check.n, mean: round(this.check.sum / this.check.n), worst: round(this.check.worst), last: this.check.last } : null,
      last: k ? {
        at: k.at, ok: k.ok, reason: k.reason ?? null, mode: k.mode ?? null, fit: round(k.score, 1000), ahead: round(k.margin, 1000), took: round(k.ms, 10), view: k.view ?? null, scale: round(k.scale, 10000),
        x: round(k.x), y: round(k.y), turned: Number.isFinite(k.rotation) ? round((k.rotation * 180) / Math.PI, 10) : null, turns: k.turns ?? null, facing: Number.isFinite(k.facing) ? round((k.facing * 180) / Math.PI, 10) : null,
        band: k.band ? k.band.map((v) => round(v, 10)) : null, rooms: k.rooms ?? null, leftOut: k.hidden ?? null, odd: k.odd ?? null, floor: round(k.floor, 1000),
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
