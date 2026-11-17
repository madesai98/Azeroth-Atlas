// Measures where each boat, zeppelin and tram line stands on the server's clock, and writes it
// into viewer/transit.json (`period`, `periodUnsure`, `left`, `leftUnsure`).
//
// The rule (found by the Azeroth Tripview addon, checked here against our own sightings): the
// server counts real time in milliseconds in a number of 32 bits, which starts again from
// nought every 49.7 days. A craft is at the second point of its path (the first only shapes the
// curve) at the moment that counter is at nought, and again every `period` after it, whatever
// the server does in between: restarts and patches do not move it.
//
// So a sighting ("it left this stop then") says how many loops and what fraction of one that
// was after the counter last started again. Our recorded tracks say how long after leaving a
// stop the craft is at the point its loop starts at; the loops are a whole number; and with
// some ten thousand of them behind it, one sighting to the second gives the period to a
// ten-thousandth of a second. Nothing here is taken from another addon's figures: the path is
// the game's own (world.json), the tracks and the sightings are ours.
//
//   node tools/clock-transit.mjs [--write] [--prefer key=seconds ...] <SavedVariables file or folder> ...
//
// The files are AzerothAtlas.lua as the game saves it (a game's WTF folder, or the copies in
// "Report a problem" zips): what the addon had seen. --write puts the figures into
// transit.json (then: node tools/make-transit-lua.mjs). --prefer: where a line was seen too
// little to tell two neighbouring periods apart (they differ by a loop more or less since the
// counter started), the period to take the nearest to.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapBefore, stopTimes } from '../viewer/js/clock.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const write = args.includes('--write');
const prefer = new Map();
const where = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--write') continue;
  if (args[i] === '--prefer') { const [k, v] = String(args[++i]).split('='); prefer.set(k, +v); continue; }
  where.push(args[i]);
}
if (!where.length) { console.log('usage: node tools/clock-transit.mjs [--write] [--prefer key=seconds ...] <SavedVariables file or folder> ...'); process.exit(1); }

const UNSURE = { own: 0.7, dw: 1.5, ft: 3, nau: 4, tv: 4 };   // as the addon weighs them (Transit.lua)
const TRAM = 143.333;      // the tram's loop: an animation of the game's, a whole number of milliseconds
const START_UNSURE = 3;    // seconds: how well our tracks place the point a loop starts at

// ---- a Lua table, as the game saves it ----
function luaValue(src, from) {
  let i = from;
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

// ---- where a line's loop starts ----
// How long after leaving its first stop a craft is at the point its loop starts at (the second
// point of the game's path for it): { after (seconds), how (in words) }, or null.
//
// That point is mostly out at sea, just where the craft has been moved to from another map:
// its riders were looking at a loading screen, and no track of ours has it. So the recorded
// moments of that leg are laid along the path, and the craft's pace over the first of them says
// how long before them it was at the start. Where the point is a stop, the craft stands there
// as its loop starts, and leaves as long after as the game's own table has it wait at that point.
function loopStartAfter(L, p, transport) {
  if (!p || p.points.length < 4) return null;
  const { dep } = stopTimes(L), count = L.stops.length;
  const mapOf = (i) => (p.pointMaps ? p.pointMaps[i] : p.map);
  const node = p.points[1], nodeMap = mapOf(1);
  const stop = L.stops.findIndex((s) => s.map === nodeMap && Math.hypot(s.x - node[0], s.y - node[1]) < 40);
  if (stop >= 0) {
    const game = transport?.stops.find((s) => s.map === nodeMap && Math.hypot(s.pos[0] - node[0], s.pos[1] - node[1]) < 40);
    const wait = game?.wait ?? 60;
    return { after: dep[stop] - wait, how: `${wait} s before it leaves ${L.stops[stop].name}` };
  }
  // how far along the path each of its points is (a move to another map, or a leap, is no distance)
  const along = [0];
  for (let i = 1; i < p.points.length; i++) {
    const a = p.points[i - 1], b = p.points[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    along[i] = along[i - 1] + (mapOf(i) === mapOf(i - 1) && d < 1500 ? d : 0);
  }
  const arcOf = (map, x, y, reach) => {
    let best = reach, arc = null;
    for (let i = 2; i < p.points.length; i++) {
      const a = p.points[i - 1], b = p.points[i];
      if (mapOf(i) !== map || mapOf(i - 1) !== map || along[i] === along[i - 1]) continue;
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const f = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)));
      const d = Math.hypot(a[0] + vx * f - x, a[1] + vy * f - y);
      if (d < best) { best = d; arc = along[i - 1] + (along[i] - along[i - 1]) * f; }
    }
    return arc;
  };
  const zero = along[1];
  // the stop that comes first after the start, going round: the craft is on the leg into it
  let B = -1, least = Infinity;
  L.stops.forEach((s, i) => { const a = arcOf(s.map, s.x, s.y, 400); if (a !== null && a > zero && a < least) { least = a; B = i; } });
  if (B < 0) return null;
  const A = (B + count - 1) % count;
  const laid = L.legs[A].track.map(([tau, map, x, y]) => ({ tau, arc: map === nodeMap ? arcOf(map, x, y, 150) : null }))
    .filter((q) => q.arc !== null && q.arc >= zero && q.arc <= least).sort((a, b) => a.tau - b.tau);
  const first = laid[0], second = first && laid.find((q) => q.tau - first.tau >= 3.5 && q.arc > first.arc);
  if (!second) return null;
  const pace = (second.arc - first.arc) / (second.tau - first.tau);
  const tau = first.tau - (first.arc - zero) / pace;
  return { after: dep[A] + tau, how: `${tau.toFixed(1)} s out of ${L.stops[A].name}` };
}

// ---- every sighting in the files given (the same one in several files counts once) ----
const files = [];
(function walk(list) {
  for (const p of list) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(fs.readdirSync(p).map((f) => path.join(p, f)));
    else if (/AzerothAtlas\.lua(\.bak)?$/i.test(p)) files.push(p);
  }
})(where);
const seen = new Map();
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const at = text.indexOf('AzerothAtlasDB = {');
  if (at < 0) continue;
  let db;
  try { db = luaValue(text, at + 17); } catch { continue; }
  const tr = db?.transit;
  for (const store of [tr?.sight, tr?.aside, tr?.out]) {
    if (!store) continue;
    for (const [n, list] of Array.isArray(store) ? store.map((v, k) => [k + 1, v]) : Object.entries(store)) {
      for (const x of Array.isArray(list) ? list : Object.values(list ?? {})) {
        if (x && typeof x.t === 'number' && typeof x.s === 'number') seen.set([n, x.s, x.arr ? 'a' : 'd', x.t.toFixed(1)].join('|'), { n: +n, ...x });
      }
    }
  }
}

const data = JSON.parse(fs.readFileSync(path.join(root, 'viewer/transit.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const world = JSON.parse(fs.readFileSync(path.join(path.resolve(root, cfg.dataDir ?? 'data'), 'world.json'), 'utf8'));
const when = (t) => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');

console.log(`${files.length} files, ${seen.size} sightings`);
console.log('line                              seen  loops   period       (it was)    spread  left stop 1 at (server time)        unsure   the loop starts');
for (const L of data.lines) {
  const cars = L.cars ?? 1;
  const { dep, arr } = stopTimes(L);
  const start = L.id ? loopStartAfter(L, world.taxiPaths.find((p) => p.id === L.id), world.transports?.find((t) => t.id === L.id)) : { after: 0, how: 'as a car leaves stop 1 on track 1' };
  const mine = [...seen.values()].filter((x) => x.n === L.n && (x.arr ? arr[x.s - 1] : dep[x.s - 1]) !== undefined && (cars === 1 || x.lane))
    .map((x) => ({ ...x, e: x.t - (x.arr ? arr[x.s - 1] : dep[x.s - 1]) - (cars > 1 && x.lane === 2 ? L.period / cars : 0), w: 1 / (UNSURE[x.src] ?? 4) ** 2 }));
  if (!start || !mine.length) { console.log(`${L.key.padEnd(34)}${start ? 'not seen' : 'no path to go by'}: left as it is`); continue; }
  mine.sort((a, b) => a.t - b.t);
  // (what was seen before the counter last started again says nothing of now)
  const W = wrapBefore(mine[mine.length - 1].t);
  const live = mine.filter((x) => x.t > W + 1);
  // phi: from the loop that began as the counter started, to the start of the loop this sighting was of
  for (const x of live) x.phi = x.e + start.after - W;
  const fit = (P, fixed) => {
    const res = live.map((x) => { const n = Math.round(x.phi / P); return { x, n, r: x.phi - n * P }; });
    const mid = [...res].sort((a, b) => a.r - b.r)[res.length >> 1].r;
    const keep = res.filter((q) => Math.abs(q.r - mid) <= 6);
    let swnn = 0, swnp = 0, sw = 0, swr = 0;
    for (const q of keep) { swnn += q.x.w * q.n * q.n; swnp += q.x.w * q.n * q.x.phi; }
    const period = fixed ? P : swnp / swnn;
    for (const q of keep) { q.r = q.x.phi - q.n * period; sw += q.x.w; swr += q.x.w * q.r; }
    const off = swr / sw;
    const spread = Math.sqrt(keep.reduce((t, q) => t + (q.r - off) ** 2, 0) / keep.length);
    const loops = keep.map((q) => q.n);
    return { period, off, spread, kept: keep.length, first: Math.min(...loops), last: Math.max(...loops), cost: spread + (res.length - keep.length) * 2 };
  };
  let best = null;
  if (!L.id) best = fit(TRAM, true);
  else {
    const ref = live[live.length >> 1].phi, N0 = Math.round(ref / L.period);
    const want = prefer.get(L.key);
    for (let N = N0 - 400; N <= N0 + 400; N++) {
      const f = fit(ref / N, false);
      if (want !== undefined) f.cost = Math.abs(f.period - want);
      if (!best || f.cost < best.cost) best = f;
    }
  }
  // Two periods a loop apart since the counter started differ by period / loops a round: told
  // apart only where the sightings span enough rounds for that to show against their own scatter.
  const step = best.period / best.last, span = best.last - best.first;
  const told = !L.id || (span > 0 && 1.5 / span < step / 4);
  const periodUnsure = !L.id ? 0.0001 : told ? Math.max(0.0002, (L.rough ? 2 : 1) * START_UNSURE / best.last) : step;
  // when a craft (the tram: the car on track 1) left stop 1 on the newest loop seen
  const left = W + best.off - start.after + best.last * best.period;
  const leftUnsure = Math.max(best.kept < 5 ? 1.5 : 0.7, 2 * best.spread / Math.sqrt(best.kept));
  console.log(L.key.padEnd(34) + `${best.kept}/${live.length}`.padEnd(6) + String(best.last).padEnd(8) + best.period.toFixed(5).padEnd(13) + String(Math.round(L.period * 1e5) / 1e5).padEnd(12)
    + best.spread.toFixed(2).padEnd(8) + `${left.toFixed(2)} (${when(left)})`.padEnd(37) + `${leftUnsure.toFixed(1)} s`.padEnd(9) + start.how + (told ? '' : `  [seen too little: the period may be ${step.toFixed(4)} s more or less]`));
  if (write) {
    L.period = Math.round(best.period * 1e5) / 1e5;
    L.periodUnsure = Math.round(periodUnsure * 1e5) / 1e5;
    L.left = Math.round(left * 100) / 100;
    L.leftUnsure = Math.round(leftUnsure * 10) / 10;
  }
}
if (write) {
  fs.writeFileSync(path.join(root, 'viewer/transit.json'), JSON.stringify(data));
  console.log('written to viewer/transit.json; now: node tools/make-transit-lua.mjs');
}

