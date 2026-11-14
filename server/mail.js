// The route's way into the game.
//
// An addon cannot be sent anything while the game runs, but it can load another addon on demand,
// and the game reads that addon's file from the disk at that moment. So next to the ForeverMapLink
// addon sits a row of tiny load-on-demand addons, the "mailboxes" (ForeverMapLink_Mail001, 002,
// ...), each holding one Lua file. This module keeps the next few of them filled with the route
// as it is now; the addon opens one when it wants the route (each can be opened once per login or
// /reload) and says through the strip which one it will open next and which delivery it last read.
//
// Only folders named ForeverMapLink_Mail### in the game's AddOns folder are ever written.
import fs from 'node:fs';
import path from 'node:path';

export const MAIL_COUNT = 300;  // mailboxes installed: deliveries per login or /reload
const WINDOW = 6;               // mailboxes kept filled ahead of the one the addon opens next
const HEARTBEAT_MS = 10000;     // the time written in them is renewed this often, so the addon can tell the map is running
const POINT_LIMIT = 6000;       // numbers' worth of route points (x and y) in one delivery
const STEP_LIMIT = 12;          // steps of a journey listed in one delivery
const ALSO_LIMIT = 3200;        // numbers' worth of the lines that are only shown (on other continents, across the sea)
const ALSO_PIECES = 60;         // of those lines, at most
const LEVEL_LIMIT = 6;          // levels of one spot offered to choose between
export const mailName = (i) => `ForeverMapLink_Mail${String(i).padStart(3, '0')}`;

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
      `## Title: Forever Map Link |cff888888(route mailbox ${no})|r`,
      '## Notes: One delivery of the route from the 3D map. Forever Map Link opens it when it needs one; there is nothing to turn on or off here.',
      '## Group: ForeverMapLink',
      '## Dependencies: ForeverMapLink',
      '## LoadOnDemand: 1',
      '',
      'mail.lua',
      '',
    ].join('\r\n'),
    'mail.lua': `ForeverMapLinkMail = { v = 1, box = ${i}, written = 0, at = 0, state = "idle" }\n`,
  };
}

export class RouteMail {
  /** @param addonsDir the game's Interface/AddOns folder (or null when the game was not found) */
  constructor(addonsDir) {
    this.dir = addonsDir;
    this.size = 0;
    this.report = null;   // what the addon last said: { session, next, size, have, flags }
    this.target = null;   // the waypoint the game reports: { tk, tm, tx, ty } or null
    this.route = null;    // what the map page last sent (see setRoute)
    this.written = (Math.floor(Date.now() / 1000) % 60000) + 1; // number of the delivery now in the mailboxes
    this.text = '';
    this.filled = '';     // which mailboxes hold it
    this.last = 0;
    this.live = false;
    this.error = null;
    this.history = [];    // recent deliveries: { written, state }
    this.boxes = new Map(); // mailbox -> { first: when it was first filled, written: [the deliveries put in it] }
    this.stale = 0;       // mailboxes in a row that the game opened and read something older in
    this.count();
  }

  /** How many mailboxes are installed. */
  count() {
    let n = 0;
    if (this.dir) while (n < 999 && fs.existsSync(path.join(this.dir, mailName(n + 1), 'mail.lua'))) n++;
    this.size = n;
    return n;
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

  /** The strip is being read (or no longer is). */
  setLive(live) {
    if (live === this.live) return;
    this.live = live;
    clearInterval(this.timer);
    if (live) {
      this.timer = setInterval(() => this.flush(true), HEARTBEAT_MS);
      this.timer.unref?.();
      this.flush(true);
    }
  }

  /**
   * From the map page: the route it shows now.
   * { target: { map, x, y, source, name } | null, state: 'route' | 'pending' | 'none', plan, map,
   *   text, detached, stretches: [{ kind, points: [x, y, x, y, ...], heights: [z, ...], stack: '0110...' }],
   *   there, sure, end: [x, y],   (what the map, which follows your height, knows: you are at the waypoint; you are on the route; where it ends)
   *   also: [{ map, kind, points: [x, y, ...] }], endMap,             (the rest of the journey, shown on the game's world map and not followed: its lines on other continents and across the sea; the map the route ends on)
   *   title, seconds, steps: [{ text, seconds, note, stretch }],      (for the arrow and the step list)
   *   levels: { id, at, ask, list: [text] } }                         (when the spot has more than one level)
   */
  setRoute(r) {
    if (!r || typeof r !== 'object') throw new Error('no route given');
    const t = r.target && Number.isFinite(r.target.x) && Number.isFinite(r.target.y) ? r.target : null;
    const stretches = [], kept = []; // kept: for each stretch sent, its number among the ones written (0: left out)
    let numbers = 0;
    for (const s of Array.isArray(r.stretches) ? r.stretches : []) {
      const pts = Array.isArray(s?.points) ? s.points.filter((v) => Number.isFinite(v)) : [];
      if (pts.length < 4 || pts.length % 2 || numbers + pts.length > POINT_LIMIT) { kept.push(0); continue; }
      numbers += pts.length;
      // (how high each point is, and at which of them another level lies over or under the line: all of them or none)
      const count = pts.length / 2;
      const heights = Array.isArray(s.heights) && s.heights.length === count && s.heights.every((v) => Number.isFinite(v)) ? s.heights : null;
      const stack = heights && typeof s.stack === 'string' && s.stack.length === count && /^[01]*$/.test(s.stack) ? s.stack : null;
      stretches.push({ kind: [0, 1, 2, 3].includes(s.kind) ? s.kind : 0, points: pts, heights, stack });
      kept.push(stretches.length);
    }
    // the lines that are only shown: each on its own map
    const also = [];
    let more = 0;
    for (const s of Array.isArray(r.also) ? r.also : []) {
      const pts = Array.isArray(s?.points) ? s.points.filter((v) => Number.isFinite(v)) : [];
      if (!Number.isInteger(s?.map) || s.map < 0 || s.map > 65535 || pts.length < 4 || pts.length % 2 || more + pts.length > ALSO_LIMIT || also.length >= ALSO_PIECES) continue;
      more += pts.length;
      also.push({ map: s.map, kind: [0, 1, 2, 3, 4].includes(s.kind) ? s.kind : 0, points: pts, joins: s.joins === true });
    }
    // the journey as a list of things to do: what each says, how long it takes, and the stretch its line ends with
    const steps = [];
    for (const s of Array.isArray(r.steps) ? r.steps.slice(0, STEP_LIMIT) : []) {
      if (typeof s?.text !== 'string' || !s.text) continue;
      const step = { text: s.text.slice(0, 90), seconds: Number.isFinite(s.seconds) ? Math.max(0, Math.round(s.seconds)) : 0, stretch: kept[(s.stretch | 0) - 1] ?? 0, note: typeof s.note === 'string' ? s.note.slice(0, 50) : '' };
      // a step that waits for a boat, zeppelin or tram: which line (its number in transit.json), the stop you board at (from 1), and how long the crossing takes
      if (Number.isInteger(s.line) && s.line > 0 && s.line < 64 && Number.isInteger(s.stop) && s.stop > 0 && s.stop < 16) { step.line = s.line; step.stop = s.stop; step.ride = Number.isFinite(s.ride) ? Math.max(0, Math.round(s.ride)) : 0; }
      steps.push(step);
    }
    // the levels there are at the waypoint's spot, when there is a choice (ask: the game is to put the question)
    const lv = r.levels;
    const levels = lv && Array.isArray(lv.list) && lv.list.length > 1 && lv.list.length <= LEVEL_LIMIT && lv.list.every((s) => typeof s === 'string')
      ? { id: lv.id | 0, at: Math.min(lv.list.length, Math.max(1, lv.at | 0)), ask: !!lv.ask, list: lv.list.map((s) => s.slice(0, 80)) } : null;
    this.route = {
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
    // No waypoint in the game: what the map shows of its own (a marker dropped on it), for "/maplink route".
    if (R && !R.game && R.at) return { state: R.state, tk: 0, tm: 0, tx: 0, ty: 0, lua: this.#routeLua(R) };
    return { state: R ? 'none' : 'idle', tk: 0, tm: 0, tx: 0, ty: 0, lua: R ? ` text = ${luaString('no waypoint')},` : '' };
  }

  #routeLua(R) {
    let lua = ` plan = ${R.plan}, map = ${R.map},`;
    if (R.text) lua += ` text = ${luaString(R.text)},`;
    if (R.name) lua += ` name = ${luaString(R.name)},`;
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
      // (zs: how high each point of each stretch is; am: '1' where another level lies over or under it)
      if (R.tall) lua += `\n zs = {\n${R.stretches.map((s) => `  { ${s.heights.map(num).join(', ')} },`).join('\n')}\n },\n am = { ${R.stretches.map((s) => `"${s.stack}"`).join(', ')} },`;
    }
    return lua;
  }

  /** Fill the mailboxes the addon will open next (again, when only the time needs renewing). */
  flush(heartbeat = false) {
    // (only while this server is hearing from the game: nothing is written for a game that is not there)
    if (!this.dir || !this.size || !this.live) return;
    const b = this.#body();
    const text = `state = "${b.state}", tk = ${b.tk}, tm = ${b.tm}, tx = ${b.tx}, ty = ${b.ty},${b.lua}`;
    const next = Math.max(1, Math.min(this.report?.next ?? 1, this.size + 1));
    const boxes = [];
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
      const file = path.join(this.dir, mailName(i), 'mail.lua');
      const lua = `ForeverMapLinkMail = { v = 1, box = ${i}, written = ${this.written}, at = ${at}, ${text} }\n`;
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
