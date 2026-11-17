// The boats, zeppelins and tram in the Atlas database: every copy's sightings put together, and
// each line's place on the server's clock measured from all of them.
//
// A craft runs to the server's clock (viewer/js/clock.js): two figures say where a line stands
// on it, how long its round is and a moment at which a craft left its first stop. The map comes
// with those as they were measured once. They get better the more is seen, and they have to be
// measured again when the server's count has started anew or the game has changed a line. So:
//
//   a copy sends   every sighting its addon has taken (AzerothAtlasDB.transit.out in the game's
//                  saved settings): your own rides, and what other players' addons passed on.
//                  As "this line, this stop, left (or got in) at this moment, by this way" -
//                  no names, neither yours nor theirs. (Of a ride of your own that does say
//                  that this copy's player was on that boat then.)
//   the database   has a function in the cloud (functions/boats.js) take in what was sent,
//                  every ten minutes, and measure each line anew: `fold` and `figures` below.
//   every copy     fetches the figures (/transit) and goes by them where they are newer than
//                  its own: the map at once, the addon from the next time the game loads it.
//
// How a line is measured. Each sighting is so many whole rounds and a bit after the count
// started: with the figures there are, the rounds are known, and the bit is how far the
// sighting is off them. Sightings that agree on that (within a few seconds) and come to a ride
// or two players' word are believed; anything else leaves the figures as they are. Through the
// believed ones goes a straight line - the moment against the number of rounds - whose slope is
// the round and whose start is where the craft stands as the count begins. The sightings of the
// count before stay in: they lie ten thousand rounds further along, and a line through both
// ends has its slope to a twenty-thousandth of a second. Where rides and other addons' sightings
// of a line differ by a steady amount (each addon has its own idea of the moment a boat
// "leaves"), the rides are right and the others are shifted to them.
//
// Nothing here leans on the rest of the map but clock.js: the function in the cloud has a copy
// of both (functions/prepare.mjs).
import { WRAP, wrapBefore, stopTimes } from '../viewer/js/clock.js';

/** How exact a sighting's time is, by the way it came (seconds), and what it counts for (as in the addon: Transit.lua). */
export const UNSURE = { own: 0.7, dw: 1.5, ft: 3, nau: 4, tv: 4 };
export const WORTH = { own: 3, dw: 1.5, ft: 1, nau: 0.5, tv: 0.5 };
const SOUND = 3;          // what sightings must come to before the figures follow them: a ride, or two players
const NEAR = 6;           // seconds sightings may differ by and still be of one timetable
const KEEP_NOW = 400;     // sightings of a line kept of the count that runs
const KEEP_BEFORE = 80;   // ...and of the one before it
const MOST_AGE = 60 * 86400;
const mod = (v, m) => ((v % m) + m) % m;
const around = (v, m) => { v = mod(v, m); return v > m / 2 ? v - m : v; };

// ---- a sighting, as it is sent --------------------------------------------------------------------
/** "line,stop,d or a,moment,way,track": the line's number in transit.json, the stop from 1, left or got in, server time, how it came, the tram's track (0: none). */
export const pack = (x) => [x.n, x.s, x.arr ? 'a' : 'd', x.t.toFixed(2), x.src, x.lane === 1 || x.lane === 2 ? x.lane : 0].join(',');
export function unpack(text) {
  if (typeof text !== 'string' || text.length > 48) return null;
  const f = text.split(',');
  if (f.length !== 6) return null;
  const n = +f[0], s = +f[1], t = +f[3], lane = +f[5];
  if (!Number.isInteger(n) || !Number.isInteger(s) || n < 1 || n > 99 || s < 1 || s > 9 || !Number.isFinite(t) || t < 1e9 || t > 1e11) return null;
  if ((f[2] !== 'a' && f[2] !== 'd') || !(f[4] in UNSURE) || ![0, 1, 2].includes(lane)) return null;
  return { n, s, arr: f[2] === 'a', t, src: f[4], lane: lane || null };
}

// ---- what the addon has kept for sending ----------------------------------------------------------
/** A Lua table as the game saves it, read from `at` (the place of its opening brace or value). */
export function luaValue(src, at) {
  let i = at;
  const ws = () => { for (;;) { while (/\s/.test(src[i] ?? '')) i++; if (src.startsWith('--', i)) { while (i < src.length && src[i] !== '\n') i++; } else break; } };
  const value = () => {
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const list = [], obj = {};
      let keyed = false;
      for (;;) {
        ws();
        if (i >= src.length) throw new Error('the table does not end');
        if (src[i] === '}') { i++; break; }
        if (src[i] === '[') { i++; const k = value(); ws(); i++; ws(); i++; obj[k] = value(); keyed = true; }
        else { const m = /^([A-Za-z_]\w*)\s*=/.exec(src.slice(i, i + 60)); if (m) { i += m[0].length; obj[m[1]] = value(); keyed = true; } else list.push(value()); }
        ws();
        if (src[i] === ',' || src[i] === ';') i++;
      }
      if (!keyed) return list;
      list.forEach((v, n) => { obj[n + 1] = v; });
      return obj;
    }
    if (c === '"') { let j = i + 1, out = ''; while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; out += src[j++]; } i = j + 1; return out; }
    const m = /^(-?[\d.]+(?:e[-+]?\d+)?|true|false|nil)/i.exec(src.slice(i, i + 40));
    if (!m) throw new Error(`cannot read "${src.slice(i, i + 20)}"`);
    i += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'nil' ? null : Number(m[0]);
  };
  return value();
}

/**
 * The sightings in the addon's saved settings (the text of a SavedVariables/AzerothAtlas.lua):
 * [{ n, s, arr, t, src, lane }]. `all`: also the ones it keeps for its own timetables (with
 * `out` alone, a version of the addon from before it kept them for sending gives none).
 */
export function sightingsIn(text, { all = false } = {}) {
  const at = text.indexOf('AzerothAtlasDB = {');
  if (at < 0) return [];
  let db;
  try { db = luaValue(text, at + 17); } catch { return []; }
  const tr = db?.transit;
  const found = new Map();
  for (const store of all ? [tr?.out, tr?.sight, tr?.aside] : [tr?.out]) {
    if (!store || typeof store !== 'object') continue;
    for (const [n, list] of Array.isArray(store) ? store.map((v, k) => [k + 1, v]) : Object.entries(store)) {
      for (const x of Array.isArray(list) ? list : Object.values(list ?? {})) {
        if (!x || typeof x.t !== 'number' || typeof x.s !== 'number' || !(x.src in UNSURE)) continue;
        const y = { n: +n, s: x.s, arr: x.arr === true, t: x.t, src: x.src, lane: x.lane === 1 || x.lane === 2 ? x.lane : null };
        if (unpack(pack(y))) found.set(`${y.n}|${y.s}|${y.arr ? 'a' : 'd'}|${y.t.toFixed(1)}`, y);
      }
    }
  }
  return [...found.values()];
}

// ---- in the database ------------------------------------------------------------------------------
/** When the craft of a sighting left the line's first stop on that round (the tram: as if it were the car on the first track); null where the sighting is of no stop of the line, or of a tram car on no known track. */
export function leftFirst(line, x) {
  const { dep, arr } = stopTimes(line);
  const into = x.arr ? arr[x.s - 1] : dep[x.s - 1];
  if (into === undefined) return null;
  const cars = line.cars ?? 1;
  if (cars > 1 && !x.lane) return null;
  return x.t - into - (cars > 1 && x.lane === 2 ? line.period / cars : 0);
}

/**
 * What was sent, taken into what the database keeps of every line.
 * @param state       { lines: { [key]: [ "moment a craft left the first stop,way,who" ] } } - or null
 * @param deliveries  [{ copy (the made-up name it was sent under), s: [packed sightings] }]
 * @param lines       transit.json's lines (their stops, legs and figures; the tracks are not needed)
 * @returns { state, taken, refused }
 */
export function fold(state, deliveries, lines, now) {
  const out = { v: 1, lines: {} };
  for (const [key, list] of Object.entries(state?.lines ?? {})) out.lines[key] = Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
  let taken = 0, refused = 0;
  const have = new Map();
  const mark = (key, e, src) => `${key}|${src}|${Math.round(e * 4)}`;   // (the same sighting, heard by several copies, is one)
  for (const [key, list] of Object.entries(out.lines)) for (const p of list) { const f = p.split(','); have.set(mark(key, +f[0], f[1]), true); }
  for (const d of deliveries) {
    for (const text of Array.isArray(d.s) ? d.s : Object.values(d.s ?? {})) {
      const x = unpack(text);
      const line = x && lines.find((l) => l.n === x.n);
      const e = line ? leftFirst(line, x) : null;
      if (e === null || x.t > now + 60 || x.t < now - MOST_AGE) { refused++; continue; }
      const m = mark(line.key, e, x.src);
      if (have.has(m)) continue;
      have.set(m, true);
      // (a ride is one voice a copy; what an addon passed on is whoever saw it, who is not named: each such sighting a voice of its own)
      (out.lines[line.key] ??= []).push(`${e.toFixed(2)},${x.src},${x.src === 'own' ? String(d.copy).slice(0, 12) : ''}`);
      taken++;
    }
  }
  // what is kept: the newest of the count that runs, and of the one before it
  const W = wrapBefore(now);
  for (const key of Object.keys(out.lines)) {
    const pts = out.lines[key].map((p) => [+p.split(',')[0], p]).sort((a, b) => b[0] - a[0]);
    const cur = pts.filter(([e]) => e > W).slice(0, KEEP_NOW), before = pts.filter(([e]) => e <= W && e > W - WRAP).slice(0, KEEP_BEFORE);
    out.lines[key] = [...cur, ...before].map(([, p]) => p);
  }
  return { state: out, taken, refused };
}

/**
 * A line's place on the clock, measured from what the database keeps of it.
 * @param line   the line, with the figures the map comes with (period, periodUnsure, left, leftUnsure)
 * @param points the line's sightings as `fold` keeps them
 * @param start  the figures to count rounds by: the ones published last, where there are any (nearer the
 *               truth than the map's own, so that every sighting is put down to the right round). What the
 *               round is held near is always the map's own figure, as unsure as that is: were it what was
 *               published last, the same sightings would count again every time, and it would come out
 *               surer than it is.
 * @returns { period, periodUnsure, left, leftUnsure, seen (sightings it rests on), rides, bias: { way: seconds } } -
 *          or null where what was seen does not come to enough to say anything
 */
export function figures(line, points, now, start = line) {
  const P0 = line.period, cars = line.cars ?? 1;
  if (!(P0 > 0) || !(line.left > 0)) return null;
  const PS = start.period > 0 && start.left > 0 ? start.period : P0;
  const z0 = PS === P0 && start === line ? mod(line.left - wrapBefore(line.left), P0) : mod((start.left > 0 ? start.left : line.left) - wrapBefore(start.left > 0 ? start.left : line.left), PS);
  const W = wrapBefore(now);
  const pts = [];
  for (const p of points ?? []) {
    const [e, src, who] = String(p).split(',');
    if (!(src in UNSURE) || !Number.isFinite(+e)) continue;
    const began = wrapBefore(+e), phi = +e - began;
    const n = Math.round((phi - z0) / PS);
    pts.push({ e: +e, src, who: who || `${src}${Math.round(+e)}`, now: began === W, phi, n, r: phi - z0 - n * PS });
  }
  // In each count: the sightings that agree with each other, where they come to enough.
  const sound = (list) => {
    let best = null;
    for (const c of list) {
      const seen = new Map();
      for (const q of list) if (Math.abs(q.r - c.r) <= NEAR / 2) seen.set(q.who, Math.max(seen.get(q.who) ?? 0, WORTH[q.src]));
      let worth = 0;
      for (const w of seen.values()) worth += w;
      if (!best || worth > best.worth) best = { worth, at: c.r };
    }
    if (!best || best.worth < SOUND) return [];
    return list.filter((q) => Math.abs(q.r - best.at) <= NEAR);
  };
  const cur = sound(pts.filter((q) => q.now)), before = sound(pts.filter((q) => !q.now));
  if (!cur.length) return null;
  // Each addon's own idea of the moment: shifted to the rides, where there are enough of both.
  const bias = {};
  const mean = (list) => { let sw = 0, s = 0; for (const q of list) { const w = 1 / UNSURE[q.src] ** 2; sw += w; s += w * q.r; } return s / sw; };
  for (const part of [cur, before]) {
    const rides = part.filter((q) => q.src === 'own');
    if (rides.length < 3) continue;
    const base = mean(rides);
    for (const src of Object.keys(UNSURE)) {
      const theirs = part.filter((q) => q.src === src);
      if (src === 'own' || theirs.length < 5) continue;
      const off = Math.max(-4, Math.min(4, mean(theirs) - base));
      for (const q of theirs) q.phi -= off;
      if (part === cur) bias[src] = Math.round(off * 100) / 100;
    }
  }
  // The straight line through them: phi = z + n * P. The round is held near the map's own
  // figure, as firmly as that is sure (a line seen little keeps the round it had).
  const all = [...cur, ...before];
  const hold = 1 / Math.max(line.periodUnsure ?? 0.01, 0.0001) ** 2;
  let sw = 0, sn = 0, snn = 0, sy = 0, sny = 0;
  for (const q of all) { const w = 1 / UNSURE[q.src] ** 2; sw += w; sn += w * q.n; snn += w * q.n * q.n; sy += w * q.phi; sny += w * q.n * q.phi; }
  const det = sw * (snn + hold) - sn * sn;
  if (!(det > 0)) return null;
  const z = (sy * (snn + hold) - sn * (sny + hold * P0)) / det;
  const P = (sw * (sny + hold * P0) - sn * sy) / det;
  const vz = (snn + hold) / det, vp = sw / det, czp = -sn / det;
  // (a round that comes out far from the line's own is not this line's any more: left for whoever keeps the map)
  if (Math.abs(P - P0) > 0.2) return null;
  const last = Math.max(...cur.map((q) => q.n));
  const round = (v, d) => Math.round(v * d) / d;
  return {
    period: round(P, 1e5), periodUnsure: round(Math.max(Math.sqrt(vp), 0.00005), 1e5),
    left: round(W + z + last * P, 100), leftUnsure: round(Math.max(Math.sqrt(Math.max(0, vz + last * last * vp + 2 * last * czp)), 0.3), 10),
    seen: all.length, rides: all.filter((q) => q.src === 'own').length, bias,
    cars: cars > 1 ? cars : undefined,
  };
}

/**
 * Every line measured: what is published as /transit. A line of which too little was seen keeps
 * the figures that were published before (`was`), or has none (a copy then goes by its own).
 */
export function measure(state, lines, was, now) {
  const out = {};
  for (const line of lines) {
    const old = was?.lines?.[line.key];
    // (rounds counted by what was published, where that is of the line as it is here)
    const start = old && Math.abs(old.period - line.period) < 0.2 && old.left >= line.left ? old : line;
    const f = figures(line, state?.lines?.[line.key], now, start);
    if (f) { delete f.cars; out[line.key] = f; } else if (old) out[line.key] = old;
  }
  return { v: 1, count: wrapBefore(now), lines: out };
}
