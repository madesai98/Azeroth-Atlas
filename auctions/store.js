// What this computer keeps of the auction houses, in <dataDir>/auctions. All of it was fetched
// from the Atlas database (share.js): a copy of the map reads no auction house itself.
//
//   state.json                  when each house was last fetched
//   <house>/now.json            the house as last listed: { t, items: { <id>: [min, mv, n, q] } }
//   <house>/days/<day>.json     one day in one line per item: { day, t, items: { <id>: [low, high, close, min, q] } }
//                               low / high / close: the lowest, the highest and the last going price
//                               of the day; min: the lowest price anybody asked that day; q: how many
//                               pieces were for sale at the last look
//   <house>/hours/<day>.json.gz every look of one day: { day, t: [...], items: { <id>: [min, mv, q, min, mv, q, …] } }
//                               (three numbers for each time in t; 0 0 0: not for sale then)
//   tsm/                        TradeSkillMaster's public files as last fetched (tsm.js)
//
// <house> is region and number ('us-110': houses.js); <day> is the day by the world's clock
// (UTC), as 20261116; t is seconds since 1970; prices are copper.
//
// NOTHING HERE IS KEPT LONGER THAN 30 DAYS (days.js says why): prune() sees to it on every run.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { KEEP_DAYS, KEEP_HOURS, dayOf, mergeDay, oldestKept } from './days.js';

export { KEEP_DAYS, KEEP_HOURS, dayOf, dayStart, oldestKept } from './days.js';

/** Where this computer keeps what it has of the auction houses. */
export const auctionsDir = (dataDir) => path.join(dataDir, 'auctions');

/** A file written whole or not at all: under another name first, then put in its place. */
function writeWhole(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class AuctionStore {
  constructor(dataDir) {
    this.dir = auctionsDir(dataDir);
  }

  file(...parts) { return path.join(this.dir, ...parts.map(String)); }

  read(rel, fallback = null) {
    try {
      const raw = fs.readFileSync(this.file(rel));
      return JSON.parse(rel.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8'));
    } catch { return fallback; }
  }

  write(rel, value) {
    const file = this.file(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify(value);
    writeWhole(file, rel.endsWith('.gz') ? zlib.gzipSync(text) : text);
  }

  state() { return this.read('state.json', {}) ?? {}; }
  setState(change) { const s = { ...this.state(), ...change }; this.write('state.json', s); return s; }
  /** One house's line in state.json changed. */
  note(house, change) {
    const s = this.state();
    s.houses = { ...s.houses, [house]: { ...s.houses?.[house], ...change } };
    this.write('state.json', s);
  }

  now(house) { return this.read(`${house}/now.json`); }
  day(house, day) { return this.read(`${house}/days/${day}.json`); }
  hours(house, day) { return this.read(`${house}/hours/${day}.json.gz`); }

  /** The days kept of a house, oldest first. */
  days(house, sub = 'days') {
    try {
      return fs.readdirSync(this.file(house, sub)).map((f) => /^(\d{8})\.json(\.gz)?$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    } catch { return []; }
  }

  /** The houses anything is kept of. */
  houses() {
    try { return fs.readdirSync(this.dir).filter((f) => /^[a-z]{2}-\d+$/.test(f)); } catch { return []; }
  }

  /**
   * One look put among the looks of its day, at its place in time. A look already there (the
   * same t) is left as it is. → true when it was added
   * @param items { <id>: [min, mv, q] }
   */
  addHour(house, t, items) {
    const day = dayOf(t);
    const hours = this.hours(house, day) ?? { day, t: [], items: {} };
    if (hours.t.includes(t)) return false;
    const at = hours.t.findIndex((x) => x > t) < 0 ? hours.t.length : hours.t.findIndex((x) => x > t);
    const count = hours.t.length;
    hours.t.splice(at, 0, t);
    const ids = new Set([...Object.keys(hours.items), ...Object.keys(items)]);
    for (const id of ids) {
      const row = hours.items[id] ?? (hours.items[id] = []);
      const e = items[id];
      if (!e && row.length <= at * 3) continue; // (not for sale then, and its row ends before: nothing to write)
      while (row.length < Math.min(at, count) * 3) row.push(0);
      row.splice(at * 3, 0, e?.[0] ?? 0, e?.[1] ?? 0, e?.[2] ?? 0);
    }
    this.write(`${house}/hours/${day}.json.gz`, hours);
    return true;
  }

  /**
   * One look at a house, written down: it becomes "now", one of its day's looks, and part of
   * its day's line. A look no newer than the last one written changes nothing.
   * @param items Map<id, { min, mv, n, q }>; keys that are not plain item numbers are left out
   */
  addLook(house, t, items) {
    const had = this.now(house);
    if (had && had.t >= t) return false;
    const now = {}, short = {};
    for (const [id, e] of items) if (Number.isInteger(id)) { now[id] = [e.min, e.mv, e.n, e.q]; short[id] = [e.min, e.mv, e.q]; }
    this.write(`${house}/now.json`, { t, items: now });
    this.addHour(house, t, short);
    const day = dayOf(t);
    const line = this.day(house, day) ?? { day, t: 0, items: {} };
    mergeDay(line.items, now);
    line.t = t;
    this.write(`${house}/days/${day}.json`, line);
    return true;
  }

  /** Delete what may not be kept any longer. → how many files went */
  prune(now = Date.now() / 1000) {
    let gone = 0;
    for (const house of this.houses()) {
      for (const [sub, keep] of [['days', KEEP_DAYS], ['hours', KEEP_HOURS]]) {
        const oldest = oldestKept(now, keep);
        for (const day of this.days(house, sub)) {
          if (day >= oldest) continue;
          for (const ext of ['.json', '.json.gz']) { try { fs.rmSync(this.file(house, sub, `${day}${ext}`)); gone++; } catch { /* not that one */ } }
        }
      }
      // a house not looked at for 30 days: what is "now" there is that old too
      const cur = this.now(house);
      if (cur && cur.t < now - KEEP_DAYS * 86400) { try { fs.rmSync(this.file(house, 'now.json')); gone++; } catch { /* gone */ } }
    }
    return gone;
  }
}
