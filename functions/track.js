// Every auction of a house, followed from one list to the next. (Part of the scheduled function:
// cloud.js calls it for each house it publishes; shared/sells.js says what the figures mean.)
//
// Blizzard's list gives each auction a number of its own (`id`), what it is and how many, its
// price, and roughly how long it has left (`time_left`: SHORT, MEDIUM, LONG or VERY_LONG). It
// does not say for how long it was put up, by whom, or what became of it. Followed from list to
// list, each an hour after the last, that can be worked out:
//
//   for how long it was put up   An auction seen for the first time was put up since the list
//                                before. This game has three lengths - 2, 8 and 24 hours - and one
//                                just put up for 24 has "very long" left, one for 8 "long", one
//                                for 2 "medium" (or "short", seen late). That holds as long as
//                                the lists are no more than a few hours apart; after a longer gap
//                                (a run that failed, the game's maintenance) what is new is of
//                                no known length, and is followed without being counted. Nor is
//                                what went in such a gap counted: when it went is not known, and
//                                counting only those that were surely early would flatter the rest.
//   what became of it            It was put up between the list before its first and its first,
//                                so its time ran out between those two moments plus its length.
//                                Gone from a list made before the earliest of those: it did not
//                                run out - it was bought, or taken down. Otherwise it is taken to
//                                have run its time.
//                                (The lists are an hour apart to within seconds, and a list a
//                                little late is allowed for: SLACK. Without that, whether a 2-hour
//                                auction gone at the very next list "went early" hung on those
//                                seconds - none did at one house and all at another.)
//   from when it is counted      An auction that goes early is known the hour it goes; one that
//                                runs its time, only when that is up. So for as long as an auction
//                                lasts after the following begins, the only ones that have ended
//                                are those that went early - every one of them "sold" - and
//                                counting them would say things sell that do not. Nothing of a
//                                length is counted until the following has gone on, without a
//                                long gap, for as long as such an auction lasts and one list
//                                more: from then on what goes early and what runs out are both
//                                of auctions seen being put up.
//   how long it was up           From the middle of the hour it appeared in to the middle of the
//                                hour it went in.
//   whether it was the cheapest  Its price for one piece against the lowest in the same list.
//   how soon it went             Whatever it was put up for: gone before two hours could have
//                                passed since it was put up, or eight (the same reckoning as
//                                "before its time", with two or eight for its length).
//   what looks like a sale       An auction gone early is a sale or was taken down. One with a
//                                like-for-like new auction beside it in the very list it is gone
//                                from was more likely taken down and put up again; one asking far
//                                more than the lowest price of the list before was not bought
//                                either. The rest count as sales: how many, how many pieces, for
//                                how much (the price is remembered with the auction, to a
//                                twentieth), and in which hour of the day.
//   the hours of the day         Of each list: how many auctions were up that could be seen to go
//                                (of a known length), how many sales there were among them, how
//                                many were newly put up - noted under the hour of the world's
//                                clock the middle of the step fell in (cloud.js adds the days up).
//
// What is sold by the piece ("commodities") loses pieces while it stays up: those are counted as
// sold when the number left in a listing goes down.
//
// What has to be remembered from one list to the next - every auction still up - is kept in
// the database under /track/<house>, where only this function reads it: a text of one short
// line per auction, squeezed. Nothing in it is older than the longest an auction lasts.
import zlib from 'node:zlib';
import { F, WIDTH, BLOCKS, SALE_WITHIN } from './shared/sells.js';

export const STATE_VERSION = 3; // (2: with since when the following has gone on. 3: with each auction's price - what was kept as 2 is read, its prices unknown)
const PRICE_STEPS = 20;         // a price is remembered as its natural logarithm in so many steps to one: to a twentieth
const SALE_STEPS = Math.round(Math.log(SALE_WITHIN) * PRICE_STEPS); // how many such steps over the lowest still count as a sale
/** A price as it is remembered (0: none), and back. */
const stepOf = (price) => (price > 0 ? Math.round(Math.log(Math.max(1, price)) * PRICE_STEPS) + 1 : 0);
const LENGTH = { VERY_LONG: 2, LONG: 1, MEDIUM: 0, SHORT: 0 }; // which of the three lengths (0: 2 hours, 1: 8, 2: 24) a new auction with that much left was put up for
const HOURS = [2, 8, 24];
const UNKNOWN = 3;            // of no known length: there when the following began, or new after a long gap
const GAP_MOST = 5 * 3600;    // seconds between two lists beyond which what is new is of no known length
const LOW_WITHIN = 1.01;      // a price within this of the lowest asked counts as "at the lowest"
const SLACK = 300;            // seconds a list may be late by and an auction gone from it still be "gone before its time could have run out"
const SETTLED = 1800;         // seconds past an auction's length the following must have gone on before that length is counted: the list after

/** The price of one piece: a listing's unit price, or an auction's buyout over what is in it (0: it can only be bid on). */
const pieceOf = (a) => (a.unit_price > 0 ? a.unit_price : a.buyout > 0 ? a.buyout / Math.max(1, a.quantity || 1) : 0);

/**
 * One list held against what was up at the list before.
 * @param prev         what was remembered: { t (when that list was made), since (when the following began, or began again after a long gap), up: Map<id, [item, t0, gap, length, low, q, price (stepOf)]> } - or null (the first list ever)
 * @param auctions     the house's auctions as Blizzard lists them
 * @param commodities  and what is sold by the piece there
 * @param t            when this list was made (seconds)
 * @returns { state: { t, since, up }, rows: { <item>: line of figures to add (shared/sells.js) },
 *            seen: { up, fresh, ended, went, young (ended, and not counted: the following has not gone on long enough for their length), sales },
 *            by: { hour (0 to 23, by the world's clock: the middle of the step from the list before), e (sales), u (auctions of a known
 *                  length that were up at the list before), f (newly put up) } - or null (the first list, or after a long gap) }
 */
export function follow(prev, auctions, commodities, t) {
  const rows = {};
  const row = (item) => (rows[item] ??= new Array(WIDTH).fill(0));
  const up = new Map();
  const seen = { up: 0, fresh: 0, ended: 0, went: 0, young: 0, sales: 0 };
  // (a list no newer than the one remembered: nothing can be told from it)
  if (prev && t <= prev.t) return { state: prev, rows, seen, by: null };
  const gap = prev ? t - prev.t : Infinity;
  const known = gap <= GAP_MOST;
  // (since when the lists have followed one another without a long gap)
  const since = known && Number.isFinite(prev.since) ? prev.since : t;
  // (the hour of the day what happened since the list before is put under, and its block of three)
  const hour = known ? Math.floor((prev.t + t) / 2 / 3600) % 24 : 0;
  const block = F.b0 + Math.floor(hour / (24 / BLOCKS));
  const by = known ? { hour, e: 0, u: 0, f: 0 } : null;
  /** One sale: so many pieces at a price (as it is remembered). */
  const sale = (item, pieces, step) => {
    const r = row(item);
    r[F.pe]++; r[F.pn] += pieces; r[F.pl] += Math.round(pieces * (step - 1) * 100 / PRICE_STEPS); r[block]++;
    seen.sales++;
  };
  // the lowest price asked for a piece of each item, in this list
  const lowest = new Map();
  const all = [];
  for (const [list, byPiece] of [[auctions ?? [], false], [commodities ?? [], true]]) {
    for (const a of list) {
      const id = a?.id, item = a?.item?.id;
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(item) || item <= 0) continue;
      const price = pieceOf(a);
      if (price > 0 && !(lowest.get(item) <= price)) lowest.set(item, price);
      all.push([id, item, Math.max(1, Math.round(a.quantity || 1)), price, a.time_left, byPiece]);
    }
  }
  // what is new, per item and number of pieces: held against what went early, for "again"
  const fresh = new Map();
  for (const [id, item, q, price, left] of all) {
    const was = prev?.up.get(id);
    if (was) {
      // still up: fewer pieces in it than before were bought out of it
      if (q < was[5]) {
        row(item)[F.sold] += was[5] - q;
        if (known && price > 0) { sale(item, was[5] - q, stepOf(price)); if (was[3] !== UNKNOWN) by.e++; }
      }
      up.set(id, [item, was[1], was[2], was[3], was[4], q, stepOf(price) || was[6] || 0]);
    } else {
      const length = known && left in LENGTH ? LENGTH[left] : UNKNOWN;
      const low = price > 0 && price <= (lowest.get(item) ?? price) * LOW_WITHIN ? 1 : 0;
      up.set(id, [item, t, known ? Math.round(gap) : 0, length, low, q, stepOf(price)]);
      if (prev) { seen.fresh++; const key = `${item}:${q}`; fresh.set(key, (fresh.get(key) ?? 0) + 1); }
      if (by && length !== UNKNOWN) by.f++;
    }
  }
  seen.up = up.size;
  // the lowest price asked for each item in the list before (as prices are remembered): what a sale is held against
  const lowBefore = new Map();
  if (known) {
    for (const was of prev.up.values()) {
      if (was[3] !== UNKNOWN) by.u++;
      if (was[6] > 0 && !(lowBefore.get(was[0]) <= was[6])) lowBefore.set(was[0], was[6]);
    }
  }
  // what was up and is gone (not after a long gap: see the top of this file)
  for (const [id, was] of known ? prev.up : []) {
    if (up.has(id)) continue;
    const [item, t0, gap0, length, low, q, step] = was;
    if (length === UNKNOWN) continue;
    // put up between t0 - gap0 and t0: its time ran out no earlier than t0 - gap0 + its length
    const within = (hours) => t <= t0 - gap0 + hours * 3600 + SLACK;
    const early = within(HOURS[length]);
    // (with a like-for-like new one in this list: more likely taken down and put up again than sold)
    let again = false;
    if (early) { const key = `${item}:${q}`, n = fresh.get(key) ?? 0; if (n > 0) { again = true; fresh.set(key, n - 1); } }
    // what looks like a sale: whenever it is seen (a sale is a sale, however long the following has gone on)
    if (early && !again && step > 0 && step <= (lowBefore.get(item) ?? step) + SALE_STEPS) { sale(item, q, step); by.e++; }
    // (the rest not until what runs its time can have ended too: see "from when it is counted" at the top)
    if (t < since + HOURS[length] * 3600 + SETTLED) { seen.young++; continue; }
    seen.ended++;
    const r = row(item);
    r[F.r2 + length * 2]++;
    if (low) {
      r[F.lr2 + length * 2]++;
      // how soon it went, whatever it was put up for
      r[F.a2]++; if (within(2)) r[F.g2]++;
      if (length >= 1) { r[F.a8]++; if (within(8)) r[F.g8]++; }
    }
    if (early) {
      seen.went++;
      r[F.s2 + length * 2]++;
      r[F.sold] += q;
      if (low) {
        r[F.ls2 + length * 2]++;
        r[F.lh] += Math.max(1, Math.round(((prev.t + t) / 2 - (t0 - gap0 / 2)) / 360));
      }
      if (again) r[F.again]++;
    }
  }
  return { state: { t, since, up }, rows, seen, by };
}

const n36 = (v) => Math.max(0, Math.round(Number(v) || 0)).toString(36);

/** What is remembered, as it is kept in the database: one text. (Numbers in order, each written as what it is more than the one before.) */
export function packState(state) {
  const ids = [...state.up.keys()].sort((a, b) => a - b);
  const lines = [];
  let before = 0;
  for (const id of ids) {
    const [item, t0, gap, length, low, q, step] = state.up.get(id);
    // (t0 as minutes before the list's own time; the gap in minutes; the price as it is remembered, nothing where there is none)
    lines.push(`${n36(id - before)},${n36(item)},${n36((state.t - t0) / 60)},${n36(gap / 60)},${length + low * 4},${q === 1 ? '' : n36(q)},${step > 0 ? n36(step) : ''}`);
    before = id;
  }
  const text = `${STATE_VERSION};${Math.round(state.t)};${Math.round(state.since ?? state.t)};${lines.join(';')}`;
  return zlib.deflateRawSync(Buffer.from(text, 'latin1'), { level: 6 }).toString('base64');
}

/** ...and read back: { t, since, up } - or null (nothing kept, or something this version cannot read: the following begins anew). */
export function unpackState(text) {
  if (typeof text !== 'string' || !text) return null;
  let plain;
  try { plain = zlib.inflateRawSync(Buffer.from(text, 'base64')).toString('latin1'); } catch { return null; }
  const parts = plain.split(';');
  // (what was kept before prices were: read as it is, its prices unknown - the following goes on)
  const version = Number(parts[0]);
  if (version !== STATE_VERSION && version !== 2) return null;
  const fields = version === 2 ? 6 : 7;
  const t = Number(parts[1]), since = Number(parts[2]);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(since) || since <= 0 || since > t) return null;
  const up = new Map();
  let id = 0;
  for (let i = 3; i < parts.length; i++) {
    if (!parts[i]) continue;
    const c = parts[i].split(',');
    if (c.length !== fields) return null;
    id += parseInt(c[0], 36);
    const flags = parseInt(c[4], 36);
    up.set(id, [parseInt(c[1], 36), t - parseInt(c[2], 36) * 60, parseInt(c[3], 36) * 60, flags & 3, flags >> 2 & 1, c[5] === '' ? 1 : parseInt(c[5], 36), c[6] ? parseInt(c[6], 36) : 0]);
  }
  return { t, since, up };
}
