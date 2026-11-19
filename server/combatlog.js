// What the game's own combat log says of the creatures you fight.
//
// The game can write down every blow of a fight as it happens: /combatlog switches that on and
// off, and so does the addon where you let it (its options: "Have the game keep its combat
// log"). The file is <game>/Logs/WoWCombatLog-<date>_<time>.txt, a line a blow, made for
// programs outside the game to read. Beside a blow the game writes a row of figures about one
// of the two fighting: how much health it has and can have, which level it is, and WHERE IT IS,
// in the game's own yards. That last is the find: it is there inside a dungeon too, where the
// game tells an addon nothing of where anybody is.
//
// So for every creature you fight the log has what no other source has for this game's new
// creatures, and what the old sources have wrong for the old ones (this game gives a Defias
// Captive 2,538 health at level 24; the original game's tables say 1,815):
//
//   where it was when the fight began   the first place the log has for that one creature: where
//                                       it stood when your shot landed, or where it had run to
//                                       by its first swing. No height: the log has none.
//   its level, and its health at it     the game's own figures for the one you fought
//   how it stands towards you           hostile, neutral or friendly, as the game marked it
//
// and, while you are in a dungeon, where YOU are: the figures of your own blows.
//
// What is kept (<dataDir>/user/logged.json) is those facts and nothing else of the log: no
// names, no player but you (and of you only where you last were, in memory, for the map to
// show, and which side each of your characters is on, under a scrambled form of the game's name
// for it, which never leaves this disk), not who hit whom, when, or for how much. The log
// itself is only ever read: never changed, moved or deleted. Kept facts go to the Atlas database with the rest of what this copy
// learns (atlasdb/collect.js), under the same switch.
//
// A line, as this game writes it (log version 22):
//
//   11/18/2026 12:09:18.482-8  RANGE_DAMAGE,<who did it>,"name",<flags>,<raid flags>,<to whom>,"name",<flags>,<raid flags>,
//       <the spell: id, "name", school>,<THE ROW: one of the two (its own name for itself), its owner (zeros: none),
//       health, most health, attack power, spell power, armour, absorbed, 0, 0, kind of power, power, most power, its cost,
//       x, y, the game's map of the place, facing, level>,<what the blow did...>
//
// The row is told by its shape (two names for a thing, then seventeen numbers), wherever in the
// line the kind of blow puts it. A log of another version than the ones known here is not read
// at all: its row may be laid out differently, and nothing is better than rubbish.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { flavourFolder } from '../extractor/config.js';
import { writeFileAtomic } from '../extractor/container.js';
import { note } from './log.js';

const LOOK = 4000;          // ms between looks at the log
const KEEP = 20000;         // ms: what was learned is written to disk no more often than this
const NEAR = 25;            // yards: a place this close to one already kept for the same creature is the same place
const MOST = 80;            // places kept of one creature on one map
const INDIVIDUALS = 30000;  // creatures remembered one by one in a run, so that only the first place of each is taken
const CHUNK = 1 << 20;      // bytes of the log read at a time
const KNOWN_VERSIONS = new Set([22]);
const FILE = /^WoWCombatLog.*\.txt$/i;
const NOBODY = '0000000000000000';

// What the game's flags for one of the two fighting say (its own numbers).
const MINE = 0x1, FRIENDLY = 0x10, NEUTRAL = 0x20, HOSTILE = 0x40, PLAYERS = 0x100, ITS_OWN = 0x200, PLAYER = 0x400, NPC = 0x800, PET = 0x1000, GUARDIAN = 0x2000;

/** A line's fields: split at the commas that are not inside a quoted name. */
function fields(text) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

const isName = (s) => s === NOBODY || /^(Player|Creature|Vehicle|Pet|GameObject)-[0-9A-Za-z-]+$/.test(s ?? '');
const isNumber = (s) => /^-?\d+(\.\d+)?$/.test(s ?? '');

/** When a line was written, as milliseconds: "11/18/2026 12:09:18.482-8" (the last figure: hours from UTC). */
function when(stamp) {
  const m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)\.(\d+)([+-]\d+(?:\.\d+)?)?$/.exec(stamp);
  if (!m) return null;
  return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6], +m[7]) - (Number(m[8]) || 0) * 3600000;
}

/**
 * Which creature a name of the game's is: { id, map } - or null for a player, a pet, an object.
 * "Creature-0-6833-34-25436-1707-0003FE00C3": the fourth part is the map it is on (a dungeon's
 * own number, or the continent's), the sixth which creature.
 */
export function creatureOf(guid) {
  const p = String(guid ?? '').split('-');
  if ((p[0] !== 'Creature' && p[0] !== 'Vehicle') || p.length !== 7) return null;
  const map = Number(p[3]), id = Number(p[5]);
  if (!Number.isInteger(map) || map < 0 || map > 99999 || !Number.isInteger(id) || id <= 0 || id > 16777215) return null;
  return { id, map };
}

/**
 * One line of the log.
 * @returns null (not a line), or { at, event, version (the log's first line), zone (a change of map: its number),
 *   unit: { guid, flags (as far as the line gives them), owned, health, most, x, y, facing, level } | null }
 */
export function parseLine(line) {
  const cut = line.indexOf('  ');
  if (cut < 0) return null;
  const f = fields(line.slice(cut + 2).trimEnd());
  const out = { at: when(line.slice(0, cut)), event: f[0], unit: null };
  if (f[0] === 'COMBAT_LOG_VERSION') { out.version = Number(f[1]); return out; }
  if (f[0] === 'ZONE_CHANGE') { const map = Number(f[1]); if (Number.isInteger(map) && map >= 0) out.zone = map; return out; }
  // whose log this is: the game marks one of the two who fought as you, where it is you (its own name for you, used in memory only)
  for (const [guid, flags] of [[f[1], Number(f[3])], [f[5], Number(f[7])]]) {
    if (typeof guid === 'string' && guid.startsWith('Player-') && Number.isFinite(flags) && (flags & MINE) && (flags & PLAYER)) { out.mine = guid; break; }
  }
  if (f.length < 28) return out;
  // the row of figures: after the two who fought (and the spell, where there is one)
  for (let i = 9; i <= 13 && i + 19 <= f.length; i++) {
    if (!isName(f[i]) || !isName(f[i + 1])) continue;
    let ok = true;
    for (let k = i + 2; k < i + 19; k++) if (!isNumber(f[k])) { ok = false; break; }
    if (!ok) continue;
    const v = f.slice(i + 2, i + 19).map(Number);
    const guid = f[i];
    const flags = guid === f[1] ? Number(f[3]) : guid === f[5] ? Number(f[7]) : NaN;
    out.unit = { guid, flags: Number.isFinite(flags) ? flags : null, owned: f[i + 1] !== NOBODY, health: v[0], most: v[1], x: v[12], y: v[13], facing: v[15], level: v[16] };
    break;
  }
  return out;
}

export class CombatLog {
  /**
   * @param side   () => 'A' | 'H' | null: which side you are on, as far as the map knows (the live link says)
   * @param onFix  ({ map, x, y, facing, at }) => called with where you are, each time the log says
   * @param onNew  () => called when something new about a creature has been kept
   */
  constructor(cfg, { side = () => null, onFix = null, onNew = null } = {}) {
    const folder = flavourFolder(cfg);
    this.dir = folder ? path.join(cfg.installRoot, folder, 'Logs') : null;
    this.file = path.join(cfg.dataDir, 'user', 'logged.json');
    this.side = side; this.onFix = onFix; this.onNew = onNew;
    // (mine: which side each character of yours is on, under a scrambled form of its name - see #whose)
    this.store = { v: 1, read: {}, places: {}, levels: {}, stands: {}, mine: {} };
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d?.v === 1) for (const k of ['read', 'places', 'levels', 'stands', 'mine']) if (d[k] && typeof d[k] === 'object' && !Array.isArray(d[k])) this.store[k] = d[k];
    } catch { /* nothing read yet */ }
    this.mine = null;         // the character whose log is being read, as the game names it (in memory only)
    this.mySide = null;       // ...and its side: 'A', 'H', or null where that is not known
    this.met = new Set();     // the creatures of this run whose first place has been taken, one by one
    this.zone = null;         // the map the log last said you were on
    this.version = null;      // of the log being read
    this.me = null;           // where you last were: { map, x, y, facing, at }
    this.dirty = false; this.savedAt = 0;
    this.state = { file: null, lines: 0, lastAt: null, unknownVersion: null };
    this.timer = null;
  }

  start() {
    if (!this.dir || this.timer) return;
    const look = () => { try { this.read(); } catch (err) { note('combatlog', 'the combat log could not be read', { error: err.message }); } };
    this.timer = setInterval(look, LOOK);
    this.timer.unref?.();
    setTimeout(look, 1500).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.#save(true);
  }

  status() {
    const count = (o) => Object.keys(o).length;
    let places = 0;
    for (const list of Object.values(this.store.places)) places += list.length;
    return { folder: this.dir, ...this.state, creatures: count(this.store.levels), places, sides: count(this.store.stands), me: this.me };
  }

  /** Read whatever the game has written since the last look. @returns how many new facts were kept */
  read() {
    if (!this.dir) return 0;
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => FILE.test(n)); } catch { return 0; }
    const files = [];
    for (const name of names) { try { const st = fs.statSync(path.join(this.dir, name)); files.push({ name, size: st.size, mtime: st.mtimeMs }); } catch { /* gone again */ } }
    files.sort((a, b) => a.mtime - b.mtime);
    // (a log that is no longer there is forgotten)
    for (const name of Object.keys(this.store.read)) if (!names.includes(name)) { delete this.store.read[name]; this.dirty = true; }
    let fresh = 0;
    for (const f of files) {
      let from = this.store.read[f.name] ?? 0;
      if (from > f.size) from = 0; // (written anew under the same name)
      if (from === f.size) continue;
      fresh += this.#readFile(f.name, from, f.size);
    }
    if (fresh) { try { this.onNew?.(); } catch { /* its own affair */ } }
    this.#save(false);
    return fresh;
  }

  #readFile(name, from, size) {
    let fd;
    try { fd = fs.openSync(path.join(this.dir, name), 'r'); } catch { return 0; }
    let fresh = 0, at = from;
    // (a file begun in the middle - by a run before this one - has its version on its first line)
    if (from > 0 && this.state.file !== name) this.#head(fd);
    // (another log may be another character's: whose it is, and where they are, is learned anew from it)
    if (this.state.file !== name) { this.mine = null; this.mySide = null; this.zone = null; }
    this.state.file = name;
    let rest = Buffer.alloc(0); // the end of what was read, where it stopped in the middle of a line
    try {
      const buf = Buffer.alloc(CHUNK);
      while (at < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - at), at);
        if (!n) break;
        at += n;
        const bytes = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
        const end = bytes.lastIndexOf(10);
        if (end < 0) { rest = Buffer.from(bytes); continue; }
        rest = Buffer.from(bytes.subarray(end + 1));
        for (const line of bytes.toString('utf8', 0, end).split('\n')) fresh += this.#line(line);
      }
    } finally { fs.closeSync(fd); }
    // (what counts as read ends with the last whole line: the half line after it is read again, with its other half, next time)
    this.store.read[name] = at - rest.length;
    this.dirty = true;
    return fresh;
  }

  #head(fd) {
    try {
      const buf = Buffer.alloc(400);
      const n = fs.readSync(fd, buf, 0, 400, 0);
      const first = parseLine(buf.toString('utf8', 0, n).split('\n')[0] ?? '');
      if (first?.version !== undefined) this.#version(first.version);
    } catch { /* not told */ }
  }

  #version(v) {
    this.version = v;
    if (!KNOWN_VERSIONS.has(v) && this.state.unknownVersion !== v) {
      this.state.unknownVersion = v;
      note('combatlog', 'the game writes its combat log in a version this map does not know: it is left unread', { version: v });
    }
  }

  /** One line. @returns how many new facts it gave */
  #line(line) {
    const l = parseLine(line);
    if (!l) return 0;
    this.state.lines++;
    if (l.at) this.state.lastAt = l.at;
    if (l.version !== undefined) { this.#version(l.version); return 0; }
    if (l.zone !== undefined) { this.zone = l.zone; return 0; }
    if (l.mine) this.#whose(l.mine, l.at);
    const u = l.unit;
    if (!u || !KNOWN_VERSIONS.has(this.version)) return 0;
    if (![u.x, u.y].every((v) => Number.isFinite(v) && Math.abs(v) < 40000) || (u.x === 0 && u.y === 0)) return 0;
    if (u.guid.startsWith('Player-')) {
      // you (the game marks whose log it is): where you are - kept in memory only, for the map to show
      if (u.flags !== null && (u.flags & MINE) && (u.flags & PLAYER) && this.zone !== null) {
        this.me = { map: this.zone, x: u.x, y: u.y, facing: Number.isFinite(u.facing) ? u.facing : null, at: l.at ?? Date.now() };
        try { this.onFix?.(this.me); } catch { /* its own affair */ }
      }
      return 0;
    }
    const who = creatureOf(u.guid);
    // a creature of the world's own: not a pet, a guardian or a totem of somebody's, nor anything a player steers
    if (!who || u.owned || u.flags === null || !(u.flags & NPC) || !(u.flags & ITS_OWN) || (u.flags & (PLAYERS | PET | GUARDIAN))) return 0;
    // (a log taken up in the middle has not said which map you are on: the creatures you fight are on it)
    this.zone ??= who.map;
    let fresh = 0;
    const s = this.store;
    if (Number.isInteger(u.level) && u.level >= 1 && u.level <= 99 && Number.isInteger(u.most) && u.most > 0 && u.most <= 2e9) {
      const by = (s.levels[who.id] ??= {});
      if (by[u.level] !== u.most) { by[u.level] = u.most; fresh++; }
    }
    const side = this.mySide;
    const how = u.flags & HOSTILE ? -1 : u.flags & NEUTRAL ? 0 : u.flags & FRIENDLY ? 1 : null;
    if ((side === 'A' || side === 'H') && how !== null) {
      const by = (s.stands[who.id] ??= {});
      if (by[side] !== how) { by[side] = how; fresh++; }
    }
    if (!this.met.has(u.guid)) {
      if (this.met.size >= INDIVIDUALS) this.met.clear();
      this.met.add(u.guid);
      const list = (s.places[`${who.id}:${who.map}`] ??= []);
      if (list.length < MOST && !list.some((p) => Math.hypot(p[0] - u.x, p[1] - u.y) < NEAR)) { list.push([Math.round(u.x * 10) / 10, Math.round(u.y * 10) / 10]); fresh++; }
    }
    if (fresh) this.dirty = true;
    return fresh;
  }

  /**
   * Whose side the character of this log is on. The log does not say; the live link does, of the
   * character you are playing now. So it is learned while the two are plainly the same - a line
   * written within the last two minutes, the link live - and kept under a scrambled form of the
   * character's own name for itself (never the name, and never sent anywhere), for the logs of
   * that character that are read when the link is not there: a log from last night, read today.
   */
  #whose(guid, at) {
    if (guid === this.mine) return;
    this.mine = guid;
    const key = crypto.createHash('sha1').update(guid).digest('hex').slice(0, 12);
    const live = at && Math.abs(Date.now() - at) < 120000 ? this.side?.() : null;
    if ((live === 'A' || live === 'H') && this.store.mine[key] !== live) { this.store.mine[key] = live; this.dirty = true; }
    this.mySide = this.store.mine[key] ?? null;
  }

  #save(now) {
    if (!this.dirty || (!now && Date.now() - this.savedAt < KEEP)) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, JSON.stringify(this.store));
      this.dirty = false; this.savedAt = Date.now();
    } catch (err) { note('combatlog', 'what the combat log said could not be kept', { error: err.message }); }
  }
}
