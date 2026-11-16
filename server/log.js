// The map's own notes of what happened: a line for every change worth knowing about when
// something has gone wrong and nobody was looking - the game found or lost, what the addon said
// it is heading for, each route handed to the game and whether the game read it, an update put
// in, an error. Written for whoever is asked to find out why the map did what it did on someone
// else's computer: "Report a problem" (report.js) packs these files.
//
// Two files, each kept to a few megabytes (the one before is kept beside it, and no more):
//
//   events.log   what the server saw and did
//   page.log     what the map page noted (viewer/js/log.js), sent on by the page as it goes
//
// A line: the moment (as the clock of this computer has it, to the millisecond), what it is
// about, what happened, and - where there is more - the particulars as JSON.
//
//   2026-11-16T18:21:49.123Z mail     delivery 4821: route {"tk":1,"tm":2991,...}
//
// Where they are kept: beside config.json, in "logs" - the installed application's are in
// %LOCALAPPDATA%\Azeroth Atlas\logs. Run from the source they are in server/.build/logs.
// Nothing in them leaves the computer by itself.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../extractor/config.js';

const MAX_BYTES = 2e6;       // a file is put aside (as name.1.log) once it is this long
const FLOOD = 400;           // lines in FLOOD_MS before the rest are counted and not written:
const FLOOD_MS = 10000;      // something that repeats without end must not fill the disk
const KEPT = 400;            // the last lines, kept in hand as well

/** Where the notes of a copy are kept: beside its config.json (see the top of this file). */
export function logDir(configFile) {
  const home = path.dirname(path.resolve(configFile));
  return home === PROJECT_ROOT ? path.join(PROJECT_ROOT, 'server', '.build', 'logs') : path.join(home, 'logs');
}

const stamp = (ms) => new Date(ms).toISOString();
/** The particulars of a line, short enough to read: long lists and long words are cut. */
function brief(data) {
  if (data === undefined || data === null) return '';
  try {
    const text = JSON.stringify(data, (k, v) => (typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}…` : Array.isArray(v) && v.length > 60 ? [...v.slice(0, 60), `…${v.length - 60} more`] : v));
    return text === undefined ? '' : ` ${text.length > 4000 ? `${text.slice(0, 4000)}…` : text}`;
  } catch { return ' (particulars that cannot be written down)'; }
}
const oneLine = (s) => String(s).replace(/\r?\n/g, ' ⏎ ');

class LogFile {
  constructor(name) {
    this.name = name;
    this.file = null;
    this.bytes = 0;
    this.last = [];          // the last lines written
    this.since = 0;          // when the lines being counted began
    this.count = 0;
    this.dropped = 0;
  }

  open(dir) {
    this.file = path.join(dir, `${this.name}.log`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    } catch { this.file = null; }
  }

  write(line) {
    this.last.push(line);
    if (this.last.length > KEPT) this.last.shift();
    if (!this.file) return;
    const now = Date.now();
    if (now - this.since > FLOOD_MS) {
      if (this.dropped) this.#put(`${stamp(now)} log      ${this.dropped} lines were left out: too many at once`);
      this.since = now; this.count = 0; this.dropped = 0;
    }
    if (++this.count > FLOOD) { this.dropped++; return; }
    this.#put(line);
  }

  #put(line) {
    try {
      if (this.bytes > MAX_BYTES) {
        const aside = this.file.replace(/\.log$/, '.1.log');
        try { fs.rmSync(aside, { force: true }); fs.renameSync(this.file, aside); } catch { fs.rmSync(this.file, { force: true }); }
        this.bytes = 0;
      }
      const text = `${line}\n`;
      fs.appendFileSync(this.file, text);
      this.bytes += Buffer.byteLength(text);
    } catch { /* nowhere to write it: the last lines are still in hand */ }
  }

  /** The files there are, the older first: [paths]. */
  files() {
    if (!this.file) return [];
    return [this.file.replace(/\.log$/, '.1.log'), this.file].filter((f) => fs.existsSync(f));
  }
}

const events = new LogFile('events'), page = new LogFile('page');
let dir = null;

/** Begin (or go on) writing in this folder. Until then, lines are only kept in hand. */
export function openLogs(folder) {
  dir = folder;
  events.open(folder);
  page.open(folder);
  return folder;
}
export const logsDir = () => dir;
/** Every file of the notes, the older first. */
export const logFiles = () => [...events.files(), ...page.files()];
export const recentEvents = () => events.last.slice();

/**
 * Note something.
 * @param about  what it is about, in a word: link, game, mail, route, addon, update, map, error ...
 * @param text   what happened
 * @param data   the particulars (anything JSON can hold), or nothing
 */
export function note(about, text, data) {
  events.write(`${stamp(Date.now())} ${String(about).padEnd(8)} ${oneLine(text)}${brief(data)}`);
}

/** A note of the page's, as a line: { t (ms), k (what about), m (what happened), d (the particulars) }. */
export function pageLine(l) {
  const t = Number.isFinite(l?.t) ? l.t : Date.now();
  return `${stamp(t)} ${String(l?.k ?? '').slice(0, 12).padEnd(8)} ${oneLine(String(l?.m ?? '').slice(0, 2000))}${brief(l?.d)}`;
}

/** What the page noted: [{ t, k, m, d }] (see pageLine). */
export function notePage(lines) {
  if (!Array.isArray(lines)) return 0;
  let n = 0;
  for (const l of lines.slice(0, 500)) {
    if (!l || typeof l.m !== 'string') continue;
    page.write(pageLine(l));
    n++;
  }
  return n;
}

/**
 * Something that is said only when it has changed: `changed(key, value)` is true the first time,
 * and each time the value is another than the last one given under that key.
 */
const before = new Map();
export function changed(key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (before.get(key) === text) return false;
  before.set(key, text);
  return true;
}

/**
 * What stops this program is noted before it does. (Looked at only: the program stops as it
 * would have, and says what it would have said.)
 */
export function noteCrashes(who) {
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    note('error', `${who} stopped on an error${origin === 'unhandledRejection' ? ' (in something it was waiting for)' : ''}: ${err?.message ?? err}`, { stack: String(err?.stack ?? '').split('\n').slice(0, 12).join(' | ') });
  });
}
