// The route's way into the game.
//
// An addon cannot be sent anything while the game runs, but it can load another addon on demand,
// and the game reads that addon's file from the disk at that moment. So next to the AzerothAtlas
// addon sits a row of tiny load-on-demand addons, the "mailboxes" (AzerothAtlas_Mail001, 002,
// ...), each holding one Lua file. This module keeps the next few of them filled with the route
// as it is now; the addon opens one when it wants the route (each can be opened once per login or
// /reload) and says through the strip which one it will open next and which delivery it last read.
//
// Only folders named AzerothAtlas_Mail### in the game's AddOns folder are ever written.
import fs from 'node:fs';
import path from 'node:path';

export const MAIL_COUNT = 300;  // mailboxes installed: deliveries per login or /reload
const WINDOW = 6;               // mailboxes kept filled ahead of the one the addon opens next
const HEARTBEAT_MS = 10000;     // the time written in them is renewed this often, so the addon can tell the map is running
const GRACE_MS = 60000;         // ...and for this long after the game was last heard from: a loading screen hides the strip, and the game's first look after it must not find the mailboxes gone cold
const FIRST = 2;                // the first mailboxes are kept filled as well: after a /reload the game begins with them again, before it has said so
const POINT_LIMIT = 6000;       // numbers' worth of route points (x and y) in one delivery
const STEP_LIMIT = 12;          // steps of a journey listed in one delivery
const ALSO_LIMIT = 3200;        // numbers' worth of the lines that are only shown (on other continents, across the sea)
const ALSO_PIECES = 60;         // of those lines, at most
const OTHER_LIMIT = 2400;       // numbers' worth of the other routes (shown beside the one that is followed)
const OTHER_PIECES = 80;        // of their lines, at most
const WHOLE_ROUTES = 8;         // other routes sent whole (each with its line and its steps), at most
const WHOLE_LIMIT = 2600;       // numbers' worth of their points, all together
const SLOT = /^[a-z][a-z0-9]{0,15}$/; // what a route is known by: guide, quest, waypoint, death, ally1...
const rgb =(v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? parseInt(v.slice(1), 16) : null);
const LEVEL_LIMIT = 6;          // levels of one spot offered to choose between
export const NAME = 'AzerothAtlas'; // the addon the mailboxes belong to
/** A mailbox's folder. (prefix: the addon it belongs to - another only while a copy from before the addon's new name is still the one installed: see legacy.js) */
export const mailName = (i, prefix = NAME) => `${prefix}_Mail${String(i).padStart(3, '0')}`;

// (cut to length first, so that an escape is never cut in half)
const luaString = (s) => `"${String(s).slice(0, 900).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[\\"]/g, '\\$&')}"`;
const num = (v) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '0');
/** A waypoint as the strip names it: whole numbers the addon can compare with what it sent. */
const stripPoint = (map, x, y) => ({ tm: map, tx: Math.round((x + 32768) * 128), ty: Math.round((y + 32768) * 128) });

/** The files of one mailbox addon. */
export function mailFiles(i, interfaceVersion) {
  const no = String(i).padStart(3, '0');
  return {
    [`${mailName(i)}.toc`]: [
      `## Interface: ${interfaceVersion}`,
      `## Title: Azeroth Atlas |cff888888(route mailbox ${no})|r`,
      '## Notes: One delivery of the route from the 3D map. Azeroth Atlas opens it when it needs one; there is nothing to turn on or off here.',
      '## Group: AzerothAtlas',
      '## Dependencies: AzerothAtlas',
      '## LoadOnDemand: 1',
      '',
      'mail.lua',
      '',
    ].join('\r\n'),
    'mail.lua': `AzerothAtlasMail = { v = 1, box = ${i}, written = 0, at = 0, state = "idle" }\n`,
  };
}

export class RouteMail {
  /**
   * @param addonsDir the game's Interface/AddOns folder (or null when the game was not found)
   * @param prefix    the name of the addon whose mailboxes these are
   */
  constructor(addonsDir, prefix = NAME) {
    this.dir = addonsDir;
    this.prefix = prefix;
    this.size = 0;
    this.report = null;   // what the addon last said: { session, next, size, have, flags }
    this.target = null;   // the waypoint the game reports: { tk, tm, tx, ty } or null
    this.route = null;    // what the map page last sent (see setRoute)
    this.marker = null;   // the marker dropped on the 3D map, for the game to take up as its waypoint: { stamp, map, x, y, placed } or { stamp, off, placed }
    this.whole = null;    // the other routes there are, each whole (see setRoute: routes); null from a page that does not say them
    this.hearth = null;   // true: the routes were worked out with your hearthstone left out; false: with it; null: not said
    this.tracked = null;  // the quest the routes were worked out for, and how far it had got: { id, state, done } (see setRoute: quest); null: not said
    this.written = (Math.floor(Date.now() / 1000) % 60000) + 1; // number of the delivery now in the mailboxes
    this.text = '';
    this.filled = '';     // which mailboxes hold it
    this.last = 0;
    this.live = false;
    this.warm = false;    // the mailboxes are being kept filled: while the game is heard from, and for `grace` ms after
    this.grace = GRACE_MS;
    this.error = null;
    this.history = [];    // recent deliveries: { written, state }
    this.boxes = new Map(); // mailbox -> { first: when it was first filled, written: [the deliveries put in it] }
    this.stale = 0;       // mailboxes in a row that the game opened and read something older in
    this.count();
  }

  /** How many mailboxes are installed. */
  count() {
    let n = 0;
    if (this.dir) while (n < 999 && fs.existsSync(path.join(this.dir, mailName(n + 1, this.prefix), 'mail.lua'))) n++;
    this.size = n;
    return n;
  }

  /** The addon has been installed afresh (perhaps under its new name): its mailboxes are the ones written from now on. */
  use(prefix = NAME) {
    if (prefix !== this.prefix) { this.prefix = prefix; this.filled = ''; this.boxes.clear(); this.stale = 0; }
    return this.count();
  }

  /** From the strip: the addon's own account of its mailboxes. */
  setReport(r) {
    const was = this.report;
    this.report = r;
    // It has opened a mailbox: did it read what was put there? (If the game only ever sees the
    // files as they were when it started, it reads something older, and the route cannot get in.)
    if (!was || was.session !== r.session || r.next < was.next) {
      // a new login or /reload: every mailbox can be opened again, and what was put in them before does not count
      this.boxes.clear();
      this.stale = 0;
    } else if (r.next === was.next + 1) {
      const put = this.boxes.get(was.next);
      if (put && Date.now() - put.first > 1500) this.stale = put.written.includes(r.have) ? 0 : this.stale + 1;
    }
    if (!was || was.session !== r.session || was.next !== r.next) this.flush();
  }

  /** From the strip: where the game says you are heading ({ kind, map, x, y } or null). */
  setTarget(t) {
    const next = t ? { tk: t.kind, ...stripPoint(t.map, t.x, t.y) } : null;
    const same = (!next && !this.target) || (next && this.target && next.tm === this.target.tm && next.tx === this.target.tx && next.ty === this.target.ty && next.tk === this.target.tk);
    this.target = next;
    if (!same) this.flush();
  }

  /**
   * The strip is being read (or no longer is). While it is, the mailboxes are kept filled and
   * their time renewed; and for a minute after it was last read too (see GRACE_MS) - then no more.
   */
  setLive(live) {
    if (live === this.live) return;
    this.live = live;
    clearTimeout(this.cooling);
    if (live) {
      this.warm = true;
      clearInterval(this.timer);
      this.timer = setInterval(() => this.flush(true), HEARTBEAT_MS);
      this.timer.unref?.();
      this.flush(true);
    } else if (this.grace > 0) {
      this.cooling = setTimeout(() => { this.warm = false; clearInterval(this.timer); }, this.grace);
      this.cooling.unref?.();
    } else {
      this.warm = false;
      clearInterval(this.timer);
    }
  }

  /**
   * From the map page: the route it shows now.
   * { target: { map, x, y, source, name } | null, state: 'route' | 'pending' | 'none', plan, map,
   *   text, detached, stretches: [{ kind, points: [x, y, x, y, ...], heights: [z, ...], stack: '0110...' }],
   *   there, sure, end: [x, y],   (what the map, which follows your height, knows: you are at the waypoint; you are on the route; where it ends)
   *   also: [{ map, kind, points: [x, y, ...] }], endMap,             (the rest of the journey, shown on the game's world map and not followed: its lines on other continents and across the sea; the map the route ends on)
   *   title, seconds, steps: [{ text, seconds, note, stretch }],      (for the arrow and the step list)
   *   levels: { id, at, ask, list: [text] },                          (when the spot has more than one level)
   *   slot, head,                                                     (which route this is - 'guide', 'waypoint' - and what the game's list of routes calls it)
   *   hearth,                                                         (true: every route here was worked out with your hearthstone left out, as you asked in the game; false: with it)
   *   quest: { id, state, done },                                     (the quest you track as the page had heard of it when it worked these routes out: its number - 0: none -, how it stands,
   *                                                                    which of what it asks for is done. The game knows that at first hand, and so can tell a route from before from the one it waits for)
   *   routes: [{ slot, head, color, state, plan, map, text, seconds, stretches, steps, also }] }
   *                                                                   (the other routes there are, each whole: the game lists and follows them beside the one that leads - and with no waypoint in the game at all)
   */
  setRoute(r) {
    if (!r || typeof r !== 'object') throw new Error('no route given');
    const t = r.target && Number.isFinite(r.target.x) && Number.isFinite(r.target.y) ? r.target : null;
    // a route's line, as stretches; kept: for each stretch sent, its number among the ones written (0: left out)
    const track = (list, budget, tall) => {
      const stretches = [], kept = [];
      for (const s of Array.isArray(list) ? list : []) {
        const pts = Array.isArray(s?.points) ? s.points.filter((v) => Number.isFinite(v)) : [];
        if (pts.length < 4 || pts.length % 2 || budget.used + pts.length > budget.limit) { kept.push(0); continue; }
        budget.used += pts.length;
        // (how high each point is, and at which of them another level lies over or under the line: all of them or none)
        const count = pts.length / 2;
        const heights = tall && Array.isArray(s.heights) && s.heights.length === count && s.heights.every((v) => Number.isFinite(v)) ? s.heights : null;
        const stack = heights && typeof s.stack === 'string' && s.stack.length === count && /^[01]*$/.test(s.stack) ? s.stack : null;
        stretches.push({ kind: [0, 1, 2, 3].includes(s.kind) ? s.kind : 0, points: pts, heights, stack });
        kept.push(stretches.length);
      }
      return { stretches, kept };
    };
    // the lines that are only shown: each on its own map
    const shown = (list, budget, pieces) => {
      const also = [];
      for (const s of Array.isArray(list) ? list : []) {
        const pts = Array.isArray(s?.points) ? s.points.filter((v) => Number.isFinite(v)) : [];
        if (!Number.isInteger(s?.map) || s.map < 0 || s.map > 65535 || pts.length < 4 || pts.length % 2 || budget.used + pts.length > budget.limit || also.length >= pieces) continue;
        budget.used += pts.length;
        also.push({ map: s.map, kind: [0, 1, 2, 3, 4].includes(s.kind) ? s.kind : 0, points: pts, joins: s.joins === true });
      }
      return also;
    };
    // the journey as a list of things to do: what each says, how long it takes, and the stretch its line ends with
    const todo = (list, kept) => {
      const steps = [];
      for (const s of Array.isArray(list) ? list.slice(0, STEP_LIMIT) : []) {
        if (typeof s?.text !== 'string' || !s.text) continue;
        const step = { text: s.text.slice(0, 90), seconds: Number.isFinite(s.seconds) ? Math.max(0, Math.round(s.seconds)) : 0, stretch: kept[(s.stretch | 0) - 1] ?? 0, note: typeof s.note === 'string' ? s.note.slice(0, 50) : '' };
        // a step that waits for a boat, zeppelin or tram: which line (its number in transit.json), the stop you board at (from 1), and how long the crossing takes
        if (Number.isInteger(s.line) && s.line > 0 && s.line < 64 && Number.isInteger(s.stop) && s.stop > 0 && s.stop < 16) { step.line = s.line; step.stop = s.stop; step.ride = Number.isFinite(s.ride) ? Math.max(0, Math.round(s.ride)) : 0; }
        steps.push(step);
      }
      return steps;
    };
    const { stretches, kept } = track(r.stretches, { used: 0, limit: POINT_LIMIT }, true);
    const also = shown(r.also, { used: 0, limit: ALSO_LIMIT }, ALSO_PIECES);
    const steps = todo(r.steps, kept);
    // the other routes, each whole (one budget of points between them)
    const whole = [], budget = { used: 0, limit: WHOLE_LIMIT };
    for (const o of Array.isArray(r.routes) ? r.routes : []) {
      if (whole.length >= WHOLE_ROUTES || typeof o?.slot !== 'string' || !SLOT.test(o.slot) || whole.some((w) => w.slot === o.slot)) continue;
      const state = ['route', 'pending', 'none'].includes(o.state) ? o.state : 'none';
      const line = state === 'route' ? track(o.stretches, budget, false) : { stretches: [], kept: [] };
      whole.push({
        slot: o.slot, state, head: typeof o.head === 'string' ? o.head.slice(0, 90) : '', color: rgb(o.color),
        plan: Number.isFinite(o.plan) ? o.plan | 0 : 0, map: Number.isFinite(o.map) ? o.map | 0 : 0,
        text: typeof o.text === 'string' ? o.text.slice(0, 120) : '', seconds: Number.isFinite(o.seconds) ? Math.max(0, Math.round(o.seconds)) : 0,
        stretches: line.stretches, steps: state === 'route' ? todo(o.steps, line.kept) : [], also: state === 'route' ? shown(o.also, budget, ALSO_PIECES) : [],
      });
    }
    this.whole = Array.isArray(r.routes) ? whole : null; // (null: a page that does not say them - an older one)
    this.hearth = typeof r.hearth === 'boolean' ? r.hearth : null;
    const tq = r.quest, upTo = (v, most) => Number.isInteger(v) && v >= 0 && v <= most;
    this.tracked = tq && upTo(tq.id, 16777215) && upTo(tq.state, 3) && upTo(tq.done, 255) ? { id: tq.id, state: tq.state, done: tq.done } : null;
    // the levels there are at the waypoint's spot, when there is a choice (ask: the game is to put the question)
    const lv = r.levels;
    const levels = lv && Array.isArray(lv.list) && lv.list.length > 1 && lv.list.length <= LEVEL_LIMIT && lv.list.every((s) => typeof s === 'string')
      ? { id: lv.id | 0, at: Math.min(lv.list.length, Math.max(1, lv.at | 0)), ask: !!lv.ask, list: lv.list.map((s) => s.slice(0, 80)) } : null;
    // the other routes there are, for the game to draw beside the one it follows: each line with the map it is on, its kind of going and its route's colour
    const others = [];
    let extra = 0;
    for (const o of Array.isArray(r.others) ? r.others : []) {
      const color = rgb(o?.color);
      if (color === null) continue;
      for (const s of Array.isArray(o.pieces) ? o.pieces : []) {
        const pts = Array.isArray(s?.points) ? s.points.filter((v) => Number.isFinite(v)) : [];
        if (!Number.isInteger(s?.map) || s.map < 0 || s.map > 65535 || pts.length < 4 || pts.length % 2 || extra + pts.length > OTHER_LIMIT || others.length >= OTHER_PIECES) continue;
        extra += pts.length;
        others.push({ map: s.map, kind: [0, 1, 2, 3, 4].includes(s.kind) ? s.kind : 0, color, points: pts });
      }
    }
    // the marker dropped on the 3D map (or word that it has been taken off)
    const mk = r.marker;
    this.marker = mk && Number.isFinite(mk.stamp) && Number.isFinite(mk.placed)
      ? (mk.off ? { stamp: mk.stamp, off: true, placed: mk.placed }
        : Number.isInteger(mk.map) && Number.isFinite(mk.x) && Number.isFinite(mk.y) ? { stamp: mk.stamp, map: mk.map, x: mk.x, y: mk.y, placed: mk.placed } : null)
      : null;
    this.route = {
      slot: typeof r.slot === 'string' && SLOT.test(r.slot) ? r.slot : '', head: typeof r.head === 'string' ? r.head.slice(0, 90) : '',
      color: rgb(r.color), others,
      game: !!t && ['guide', 'journey', 'pin', 'quick'].includes(t.source),
      steps, levels,
      title: typeof r.title === 'string' ? r.title.slice(0, 90) : '',
      seconds: Number.isFinite(r.seconds) ? Math.max(0, Math.round(r.seconds)) : 0,
      at: t ? stripPoint(t.map | 0, t.x, t.y) : null,
      state: ['route', 'pending', 'none'].includes(r.state) ? r.state : 'none',
      plan: Number.isFinite(r.plan) ? r.plan | 0 : 0,
      map: Number.isFinite(r.map) ? r.map | 0 : 0,
      text: typeof r.text === 'string' ? r.text : '',
      name: typeof t?.name === 'string' ? t.name : '',
      detached: !!r.detached,
      stretches, also,
      tall: stretches.length > 0 && stretches.every((s) => s.heights && s.stack),
      there: typeof r.there === 'boolean' ? r.there : null,
      sure: typeof r.sure === 'boolean' ? r.sure : null,
      end: Array.isArray(r.end) && Number.isFinite(r.end[0]) && Number.isFinite(r.end[1]) ? [r.end[0], r.end[1]] : null,
      endMap: Number.isInteger(r.endMap) && r.endMap >= 0 && r.endMap <= 65535 ? r.endMap : null,
    };
    this.flush();
    return this.status();
  }

  /** What goes into the mailboxes now (everything but the delivery number and the time). */
  #body() {
    const T = this.target, R = this.route;
    // The game has a waypoint: only a route to that very spot answers it.
    if (T) {
      const answers = R && R.game && R.at && R.at.tm === T.tm && R.at.tx === T.tx && R.at.ty === T.ty;
      if (!answers) return { state: R ? 'pending' : 'idle', ...T, lua: '' };
      return { state: R.state, ...T, lua: this.#routeLua(R) };
    }
    // No waypoint in the game: what the map shows of its own (a marker dropped on it), for "/atlas route".
    if (R && !R.game && R.at) return { state: R.state, tk: 0, tm: 0, tx: 0, ty: 0, lua: this.#routeLua(R) };
    return { state: R ? 'none' : 'idle', tk: 0, tm: 0, tx: 0, ty: 0, lua: R ? ` text = ${luaString('no waypoint')},` : '' };
  }

  #routeLua(R) {
    let lua = ` plan = ${R.plan}, map = ${R.map},`;
    if (R.text) lua += ` text = ${luaString(R.text)},`;
    if (R.name) lua += ` name = ${luaString(R.name)},`;
    // (sk: which route this is; hd: what the game's list of routes calls it)
    if (R.slot) lua += ` sk = "${R.slot}",`;
    if (R.head) lua += ` hd = ${luaString(R.head)},`;
    if (R.detached) lua += ' detached = true,';
    // (from the map, which follows how high you are: at the waypoint on its own level; on the route; where the route ends)
    if (R.there !== null) lua += ` there = ${R.there},`;
    if (R.sure !== null) lua += ` sure = ${R.sure},`;
    if (R.end) lua += ` ex = ${num(R.end[0])}, ey = ${num(R.end[1])},${R.endMap !== null ? ` em = ${R.endMap},` : ''}`;
    if (R.state === 'route') {
      if (R.title) lua += ` title = ${luaString(R.title)},`;
      lua += ` secs = ${R.seconds},`;
      // (a step: what to do, seconds it takes, the stretch of the track it ends with, a note; and for
      // one that waits for a boat, zeppelin or tram: the line, the stop you board at, seconds the crossing takes)
      if (R.steps.length) lua += `\n steps = { ${R.steps.map((s) => `{ ${luaString(s.text)}, ${s.seconds}, ${s.stretch}${s.note || s.line ? `, ${luaString(s.note)}` : ''}${s.line ? `, ${s.line}, ${s.stop}, ${s.ride}` : ''} }`).join(', ')} },`;
      if (R.levels) lua += `\n lv = { id = ${R.levels.id}, at = ${R.levels.at},${R.levels.ask ? ' ask = true,' : ''} ${R.levels.list.map(luaString).join(', ')} },`;
      lua += `\n track = {\n${R.stretches.map((s) => `  { ${s.kind}, ${s.points.map(num).join(', ')} },`).join('\n')}\n },`;
      // (also: lines to show on the world map and not to follow - the map each is on, its kind (16 more: it goes on from the line before, over the sea), its points)
      if (R.also.length) lua += `\n also = {\n${R.also.map((s) => `  { ${s.map}, ${s.kind + (s.joins ? 16 : 0)}, ${s.points.map(num).join(', ')} },`).join('\n')}\n },`;
      // (rc: the colour this route has on the 3D map; more: the other routes there are, to show beside it - the map each line is on, its kind, its route's colour, its points)
      if (R.color !== null) lua += ` rc = ${R.color},`;
      if (R.others.length) lua += `\n more = {\n${R.others.map((s) => `  { ${s.map}, ${s.kind}, ${s.color}, ${s.points.map(num).join(', ')} },`).join('\n')}\n },`;
      // (zs: how high each point of each stretch is; am: '1' where another level lies over or under it)
      if (R.tall) lua += `\n zs = {\n${R.stretches.map((s) => `  { ${s.heights.map(num).join(', ')} },`).join('\n')}\n },\n am = { ${R.stretches.map((s) => `"${s.stack}"`).join(', ')} },`;
    }
    return lua;
  }

  /**
   * The other routes there are, each whole, and how your hearthstone was counted: said in every
   * delivery, whatever it says of the waypoint the game has (and where the game has none).
   * rs: { k (which route), st ("route", "pending": still being worked out, "none"), hd (what it
   * is called), c (its colour), plan, map, secs, steps, track, also - as for the one that leads }
   * hs: 1 where the routes were worked out with your hearthstone left out, 0 with it.
   * tq: the quest they were worked out for - its number, how it stands, which of what it asks for is done.
   */
  #restLua() {
    let lua = '';
    if (this.hearth !== null) lua += ` hs = ${this.hearth ? 1 : 0},`;
    if (this.tracked) lua += ` tq = { ${this.tracked.id}, ${this.tracked.state}, ${this.tracked.done} },`;
    if (!this.whole) return lua;
    const steps = (list) => list.map((s) => `{ ${luaString(s.text)}, ${s.seconds}, ${s.stretch}${s.note || s.line ? `, ${luaString(s.note)}` : ''}${s.line ? `, ${s.line}, ${s.stop}, ${s.ride}` : ''} }`).join(', ');
    lua += `\n rs = {${this.whole.map((o) => {
      let one = `\n  { k = "${o.slot}", st = "${o.state}",`;
      if (o.head) one += ` hd = ${luaString(o.head)},`;
      if (o.color !== null) one += ` c = ${o.color},`;
      if (o.text && o.state !== 'route') one += ` text = ${luaString(o.text)},`;
      if (o.state === 'route') {
        one += ` plan = ${o.plan}, map = ${o.map}, secs = ${o.seconds},`;
        if (o.steps.length) one += `\n   steps = { ${steps(o.steps)} },`;
        one += `\n   track = {${o.stretches.map((s) => `\n    { ${s.kind}, ${s.points.map(num).join(', ')} },`).join('')}\n   },`;
        if (o.also.length) one += `\n   also = {${o.also.map((s) => `\n    { ${s.map}, ${s.kind + (s.joins ? 16 : 0)}, ${s.points.map(num).join(', ')} },`).join('')}\n   },`;
      }
      return `${one} },`;
    }).join('')}\n },`;
    return lua;
  }

  /** Fill the mailboxes the addon will open next (again, when only the time needs renewing). */
  flush(heartbeat = false) {
    // (only while this server is hearing from the game, and a moment longer: nothing is written for a game that is not there)
    if (!this.dir || !this.size || !this.warm) return;
    const b = this.#body();
    // (mk: the marker dropped on the 3D map - its number, where it is, when it was dropped - for the
    // game to take up as its waypoint; or its number and when alone: it has been taken off, and the game lets go of its waypoint)
    const k = this.marker;
    const mark = !k ? '' : k.off ? ` mk = { ${k.stamp}, false, false, false, ${k.placed} },` : ` mk = { ${k.stamp}, ${k.map}, ${Math.round(k.x * 1000) / 1000}, ${Math.round(k.y * 1000) / 1000}, ${k.placed} },`;
    const text = `state = "${b.state}", tk = ${b.tk}, tm = ${b.tm}, tx = ${b.tx}, ty = ${b.ty},${mark}${b.lua}${this.#restLua()}`;
    const next = Math.max(1, Math.min(this.report?.next ?? 1, this.size + 1));
    const boxes = [];
    // (the first ones too: a game that has just been reloaded opens those, and says so only a moment later)
    for (let i = 1; i <= FIRST && i < next && i <= this.size; i++) boxes.push(i);
    for (let i = next; i < next + WINDOW && i <= this.size; i++) boxes.push(i);
    const filled = boxes.join(',');
    if (text === this.text && filled === this.filled && !heartbeat) return;
    if (text !== this.text) {
      this.written = (this.written % 65535) + 1;
      this.history.push({ written: this.written, state: b.state, at: Date.now() });
      if (this.history.length > 40) this.history.shift();
    }
    this.text = text;
    this.filled = filled;
    this.last = Date.now();
    const at = Math.floor(this.last / 1000);
    this.error = null;
    for (const i of boxes) {
      const put = this.boxes.get(i) ?? { first: this.last, written: [] };
      if (put.written[put.written.length - 1] !== this.written) put.written.push(this.written);
      if (put.written.length > 12) put.written.shift();
      this.boxes.set(i, put);
      if (this.boxes.size > 40) this.boxes.delete(this.boxes.keys().next().value);
      const file = path.join(this.dir, mailName(i, this.prefix), 'mail.lua');
      const lua = `${this.prefix}Mail = { v = 1, box = ${i}, written = ${this.written}, at = ${at}, ${text} }\n`;
      try {
        // (whole or not at all: the game may open the file at any moment)
        const tmp = `${file}.new`;
        fs.writeFileSync(tmp, lua);
        try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, lua); fs.rmSync(tmp, { force: true }); }
      } catch (err) { this.error = err.message; }
    }
  }

  /** For the map page: how the route's way into the game is doing. */
  status() {
    const r = this.report;
    const sent = this.history[this.history.length - 1] ?? null;
    return {
      installed: this.size,                       // mailboxes found in the game's AddOns folder
      seen: r ? r.size : null,                    // mailboxes the game itself found (null: an addon that does not say)
      left: r ? Math.max(0, r.size - r.next + 1) : null,
      state: sent?.state ?? 'idle',               // what the mailboxes hold: route / pending / none / idle
      read: !!r && !!sent && r.have === sent.written, // the game has read exactly that
      showing: !!r && !!(r.flags & 1),            // the game is drawing a route
      waiting: !!r && !!(r.flags & 2),
      stale: this.stale >= 2,                     // the game keeps reading older copies of the files
      error: this.error,
    };
  }
}
