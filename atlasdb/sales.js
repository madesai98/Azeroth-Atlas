// What became of the auctions the players of the copies put up themselves, and what the auction
// houses took for them: read out of the game's saved settings, sent to the Atlas database as
// lines, and put together there for every copy.
//
// The lists of auctions cannot tell an auction that was bought from one its seller took down
// (functions/track.js): only the seller knows. And what a house keeps of a sale, and what it
// asks as a deposit, is in the game's files for nobody to check. The addon notes both of your
// own auctions (addon/AzerothAtlas/Sales.lua: AzerothAtlasDB.sales) - how many you put up of an
// item, for how long, at which house, and how many of those sold, ran out or were taken down;
// the deposit the game asked against what a vendor pays for the thing; the cut it took of a
// sale. Here that becomes lines, with nothing of the player in them:
//
//   a,<item>,<house>,<hours>,<put up>,<sold>,<ran out>,<taken down>,<asked in all>,<got in all>
//   k,<1 your side's house, 2 the neutral one>,<hours>,<auctions>,<deposits in all>,<what a vendor pays for those things in all>
//   k,<1 or 2>,0,<sales>,<cut in all>,<paid by the buyers in all>
//
// A line is the whole of what a copy has counted so far, not what is new: a copy's later line
// stands for its earlier ones (the one with the more auctions). Put together, every copy's
// count is added up. Published as records of two kinds of their own (records.js: SALE, COST):
//
//   sale, an item:      { h: { <house>: { <hours>: [put up, sold, ran out, taken down, asked, got] } } }
//   cost, 1 or 2:       { d: { <hours>: [auctions, deposits, vendor's worth] }, c: [sales, cut, paid] }
//
// These are the players' own auctions, not Blizzard's lists: the thirty days of those do not
// bind them. Only what is sound passes; saved settings of another addon, or broken ones, give
// no lines; nothing here throws.
import { luaValue } from './boats.js';

const ID = 16777215;       // the most an item can be numbered
const COUNT_MOST = 1e6;    // auctions of one item by one copy beyond which a line is not believed
const COPPER_MOST = 1e13;  // a sum of copper beyond which it is none
const HOUSE = /^[a-z]{2}-\d{1,4}$/;
const LENGTHS = [2, 8, 24];
const LINES_MOST = 4000;   // lines of a copy: what is beyond is the items put up the least
export const COST_LEAST = 5;     // auctions (or sales) it takes before what the houses took is gone by
export const COST_NEAR = 0.04;   // a measured share this near the game's own figure confirms it (deposits are rounded down to the copper)
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** One item's count at a house for a length, where it is sound: [put up, sold, ran out, taken down, asked, got] - or null. */
function soundSale(v) {
  if (!Array.isArray(v) || v.length < 6) return null;
  const [p, s, x, c, ask, got] = v.map((n) => (typeof n === 'number' ? Math.round(n) : NaN));
  if (!whole(p, 1, COUNT_MOST) || !whole(s, 0, p) || !whole(x, 0, p) || !whole(c, 0, p) || s + x + c > p) return null;
  if (!whole(ask, 0, COPPER_MOST) || !whole(got, 0, COPPER_MOST)) return null;
  return [p, s, x, c, ask, got];
}
/** What a house took, where it is sound: [how many, the house's take in all, what it is a share of in all] - or null. */
function soundCost(v) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [n, a, b] = v.map((x) => (typeof x === 'number' ? Math.round(x) : NaN));
  if (!whole(n, 1, COUNT_MOST) || !whole(a, 0, COPPER_MOST) || !whole(b, 1, COPPER_MOST)) return null;
  return [n, a, b];
}

/**
 * What the addon has noted, out of the text of a SavedVariables/AzerothAtlas.lua.
 * @returns { sales: Map<"item,house,hours", [put up, sold, ran out, taken down, asked, got]>,
 *            costs: Map<"side,hours", [how many, taken, of]> } (empty where there is nothing sound)
 */
export function salesIn(text) {
  const out = { sales: new Map(), costs: new Map() };
  try {
    if (typeof text !== 'string') return out;
    const at = text.indexOf('AzerothAtlasDB = {');
    if (at < 0) return out;
    const sales = luaValue(text, at + 17)?.sales;
    if (!sales || typeof sales !== 'object') return out;
    for (const [key, rec] of Object.entries(sales.n && typeof sales.n === 'object' ? sales.n : {})) {
      const m = /^([a-z]{2}-\d{1,4}):(\d{1,8}):(2|8|24)$/.exec(key);
      if (!m || !rec || typeof rec !== 'object' || !whole(+m[2], 1, ID)) continue;
      const ok = soundSale([rec.p, rec.s ?? 0, rec.x ?? 0, rec.c ?? 0, rec.ask ?? 0, rec.got ?? 0]);
      if (ok) out.sales.set(`${+m[2]},${m[1]},${+m[3]}`, ok);
    }
    for (const [key, rec] of Object.entries(sales.cost && typeof sales.cost === 'object' ? sales.cost : {})) {
      const m = /^(own|neutral):(2|8|24|cut)$/.exec(key);
      if (!m || !rec || typeof rec !== 'object') continue;
      const ok = soundCost(m[2] === 'cut' ? [rec.n, rec.cut, rec.bid] : [rec.n, rec.dep, rec.ven]);
      if (ok) out.costs.set(`${m[1] === 'own' ? 1 : 2},${m[2] === 'cut' ? 0 : +m[2]}`, ok);
    }
  } catch {
    return { sales: new Map(), costs: new Map() };
  }
  return out;
}

/** Several accounts' counts (salesIn of each) as lines for the database: the accounts of one computer added up. */
export function saleLines(accounts) {
  const sales = new Map(), costs = new Map();
  const add = (into, key, v) => { const had = into.get(key); into.set(key, had ? had.map((x, i) => x + v[i]) : [...v]); };
  for (const one of accounts) {
    for (const [key, v] of one?.sales ?? []) add(sales, key, v);
    for (const [key, v] of one?.costs ?? []) add(costs, key, v);
  }
  const lines = [];
  for (const [key, v] of [...costs].sort()) { const line = `k,${key},${v.join(',')}`; if (soundCost(v) && line.length <= 100) lines.push(line); }
  // (the most put up first: a copy with more items than a delivery holds sends those it knows most of)
  for (const [key, v] of [...sales].sort((a, b) => b[1][0] - a[1][0] || (a[0] < b[0] ? -1 : 1)).slice(0, LINES_MOST)) {
    const line = `a,${key},${v.join(',')}`;
    if (soundSale(v) && line.length <= 100) lines.push(line);
  }
  return lines;
}

/** A line as it was sent, cut at its commas: { kind: 'a', key, item, house, hours, v } or { kind: 'k', key, side, hours, v } - or null where it is not sound. */
export function readSaleLine(parts) {
  if (!Array.isArray(parts)) return null;
  if (parts[0] === 'a' && parts.length === 10 && HOUSE.test(parts[2]) && [1, 3, 4, 5, 6, 7, 8, 9].every((i) => /^\d{1,14}$/.test(parts[i]))) {
    const item = +parts[1], hours = +parts[3];
    const v = soundSale(parts.slice(4).map(Number));
    if (!whole(item, 1, ID) || !LENGTHS.includes(hours) || !v) return null;
    return { kind: 'a', key: `${item},${parts[2]},${hours}`, item, house: parts[2], hours, v };
  }
  if (parts[0] === 'k' && parts.length === 6 && parts.slice(1).every((p) => /^\d{1,14}$/.test(p))) {
    const side = +parts[1], hours = +parts[2];
    const v = soundCost(parts.slice(3).map(Number));
    if ((side !== 1 && side !== 2) || !(hours === 0 || LENGTHS.includes(hours)) || !v) return null;
    return { kind: 'k', key: `${side},${hours}`, side, hours, v };
  }
  return null;
}

/**
 * Every copy's counts put together.
 * @param byCopy Map<copy, Map<kind + key, a line read (the one of its key with the most auctions)>>
 * @returns { sales: Map<item, { h: { house: { hours: [put up, sold, ran out, taken down, asked, got] } } }>,
 *            costs: Map<1 | 2, { d: { hours: [auctions, deposits, vendor's worth] }, c: [sales, cut, paid] }> }
 */
export function foldSales(byCopy) {
  const sales = new Map(), costs = new Map();
  for (const lines of byCopy.values()) {
    for (const said of lines.values()) {
      if (said.kind === 'a') {
        let rec = sales.get(said.item);
        if (!rec) sales.set(said.item, (rec = { h: {} }));
        const house = (rec.h[said.house] ??= {});
        house[said.hours] = house[said.hours] ? house[said.hours].map((x, i) => x + said.v[i]) : [...said.v];
      } else {
        let rec = costs.get(said.side);
        if (!rec) costs.set(said.side, (rec = { d: {} }));
        if (said.hours === 0) rec.c = rec.c ? rec.c.map((x, i) => x + said.v[i]) : [...said.v];
        else rec.d[said.hours] = rec.d[said.hours] ? rec.d[said.hours].map((x, i) => x + said.v[i]) : [...said.v];
      }
    }
  }
  return { sales, costs };
}

const records = (local) => Object.values(local && typeof local === 'object' ? local : {}).flatMap((part) => Object.entries(part ?? {}));

/**
 * The published counts as a copy last fetched them (truth-sale.json, as the local store reads
 * it): Map<item, Map<house, { 2: [ended, sold, put up], 8: …, 24: … }>> - ended: sold or ran
 * out (one taken down says nothing of whether it would have sold).
 */
export function readSales(local) {
  const out = new Map();
  for (const [key, rec] of records(local)) {
    const item = Number(String(key).slice(1));
    if (!whole(item, 1, ID) || !rec || typeof rec.h !== 'object' || !rec.h) continue;
    const houses = new Map();
    for (const [house, by] of Object.entries(rec.h)) {
      if (!HOUSE.test(house) || !by || typeof by !== 'object') continue;
      const lengths = {};
      for (const d of LENGTHS) { const v = soundSale(by[d]); if (v) lengths[d] = [v[1] + v[2], v[1], v[0]]; }
      if (Object.keys(lengths).length) houses.set(house, lengths);
    }
    if (houses.size) out.set(item, houses);
  }
  return out;
}

/**
 * What the houses took, as the copies' players found it (truth-cost.json): for your side's
 * house and the neutral one { deposit: { 2, 8, 24: per cent of what a vendor pays, or null },
 * cut: per cent of a sale, or null, n: auctions and sales behind it } - a figure only where
 * COST_LEAST auctions (or sales) are behind it.
 */
export function readCosts(local) {
  const out = { own: { deposit: { 2: null, 8: null, 24: null }, cut: null, n: 0 }, neutral: { deposit: { 2: null, 8: null, 24: null }, cut: null, n: 0 } };
  for (const [key, rec] of records(local)) {
    const side = Number(String(key).slice(1)) === 1 ? out.own : Number(String(key).slice(1)) === 2 ? out.neutral : null;
    if (!side || !rec || typeof rec !== 'object') continue;
    for (const d of LENGTHS) {
      const v = soundCost(rec.d?.[d]);
      if (v && v[0] >= COST_LEAST) { side.deposit[d] = v[1] / v[2] * 100; side.n += v[0]; }
    }
    const c = soundCost(rec.c);
    if (c && c[0] >= COST_LEAST) { side.cut = c[1] / c[2] * 100; side.n += c[0]; }
  }
  return out;
}

/**
 * The game's own figure held against a measured one: the game's where the two agree (within
 * COST_NEAR of it: deposits are rounded down to the copper) or nothing was measured, else the
 * measured one to the whole per cent. → { value, measured: 'same' | 'other' | null }
 */
export function settle(game, measured) {
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0 || measured > 1000) return { value: game, measured: null };
  if (Math.abs(measured - game) <= Math.max(0.5, game * COST_NEAR)) return { value: game, measured: 'same' };
  return { value: Math.round(measured), measured: 'other' };
}
