// What sells, as we measure it ourselves: the figures kept per item and per auction house, and
// how they are read. (Shared with the function in the cloud that makes them: functions/track.js
// follows every auction from look to look, and this file says what it writes down.)
//
// A list of auctions says what is asked, not what sells. But Blizzard gives every auction a
// number of its own and says roughly how long it has left, and the lists are made anew every
// hour: an auction that is in one list and gone from the next, long before its time could have
// run out, was bought (or taken down by its seller: the lists cannot tell which). Followed for
// every auction of every house, that says how often an item sells of the times it is put up, how
// long it is up before it goes, how many pieces go in a day, for how much, and at which hours of
// the day - for each house by itself, the neutral ones too, which nobody else publishes figures for.
//
// One line per item:
//
//   r2 s2  r8 s8  r24 s24     auctions put up for 2, 8 and 24 hours (the three this game has) that
//                             have ended (r), and how many of those went before their time could
//                             have run out (s): sold, or taken down
//   lr2 ls2 lr8 ls8 lr24 ls24 the same, counting only auctions put up at the lowest price asked
//                             for the item at that moment
//   lh                        tenths of an hour those (ls) were up before they went, summed
//   sold                      pieces that went that way (and pieces bought out of a listing that
//                             is sold by the piece and is still up)
//   again                     of the auctions that went early, how many had a like-for-like new
//                             auction of the same item appear in the very same list (the same
//                             number of pieces): more likely taken down and put up again than sold
//   a2 g2                     how soon things go, whatever length they were put up for: of the
//                             auctions put up at the lowest price that have ended (a2: of any
//                             length), how many were gone within two hours (g2)
//   a8 g8                     the same for eight hours: of those put up for 8 or 24 (a8), how many
//                             were gone within eight (g8). (For 24 hours: lr24 and ls24.)
//   pe pn pl                  what looks like a sale, and for how much. An auction that went early,
//                             with no like-for-like new one beside it, at no more than SALE_WITHIN
//                             times the lowest price then asked; or pieces bought out of a listing
//                             that is still up. pe: how many such; pn: pieces; pl: the pieces' prices
//                             as 100 x their natural logarithm, summed - so that what it sells for
//                             is the middle of the prices paid (salePrice), which one auction taken
//                             down at a hundred times the price does not move much
//   b0 … b7                   those sales by the hour of the day they fell in, by the world's clock
//                             (UTC), in blocks of three hours from midnight
//
// From when: nothing of a length is counted until the following has gone on for as long as such
// an auction lasts (track.js says why: until then only the ones that went early can have ended).
// So after the following begins - or begins again after a long gap - the 2-hour figures start
// three hours on, the 8-hour ones nine, the 24-hour ones a day and an hour. What looks like a
// sale (pe on) is counted from the first hour: a sale is a sale whenever it is seen.
//
// What it cannot see, and so what the figures lean towards:
//   - sold and taken down look the same (`again` is a hint of how much of it is the second);
//   - the lists are an hour apart: an auction put up and bought within the hour is never seen
//     (the quickest sales are missing), and one put up for 2 hours is seen at most twice;
//   - what is counted as having run its time may have been bought in its last hour.
//
// Kept thirty days and no longer, like everything made from Blizzard's lists (days.js).

export const DURATIONS = [2, 8, 24];   // hours an auction can be put up for in this game
/**
 * Which making of the figures this is. The function writes it beside them, begins them anew
 * where what is there is of another, and a copy does not go by figures of another. (1: counted
 * from the first hour, which leaned high for as long as an auction lasts. 2: from when what
 * runs its time can have ended too. Fields added at the end of a line since - a2 on - began at
 * nought beside what was there, and are told apart by being there: no new making for them.)
 */
export const FIGURES = 2;
export const BLOCKS = 8;               // the blocks of the day an item's own sales are counted in: three hours each
export const SALE_WITHIN = 1.5;        // an auction gone early counts as a sale at no more than this many times the lowest price then asked
export const FIELDS = ['r2', 's2', 'r8', 's8', 'r24', 's24', 'lr2', 'ls2', 'lr8', 'ls8', 'lr24', 'ls24', 'lh', 'sold', 'again',
  'a2', 'g2', 'a8', 'g8', 'pe', 'pn', 'pl', ...Array.from({ length: BLOCKS }, (_, k) => `b${k}`)];
export const F = Object.fromEntries(FIELDS.map((f, i) => [f, i]));
export const WIDTH = FIELDS.length;

/** `more` added into `into` ({ id: row }, changed in place and returned); `sign` -1 takes it away again (never below nothing). */
export function addRows(into, more, sign = 1) {
  for (const [id, row] of Object.entries(more)) {
    let have = into[id];
    if (!have) { if (sign < 0) continue; have = into[id] = new Array(WIDTH).fill(0); }
    for (let i = 0; i < WIDTH; i++) have[i] = Math.max(0, (have[i] || 0) + sign * (row[i] || 0));
    if (sign < 0 && have.every((v) => !v)) delete into[id];
  }
  return into;
}

/** Lines as they are written down: without the noughts at their end (a line read back is as long as it is; what is not there is nought). */
export function trimRows(rows) {
  const out = {};
  for (const [id, row] of Object.entries(rows)) {
    let n = row.length;
    while (n > 1 && !row[n - 1]) n--;
    out[id] = n === row.length ? row : row.slice(0, n);
  }
  return out;
}

/**
 * What a line says, for whoever shows it or reckons with it:
 *   { ended, went, chance (went / ended; null under `least` ended), hours (the average time up of
 *     those put up at the lowest price that went; null where none), sold (pieces), again }
 * @param row       one item's line (or nothing)
 * @param duration  2, 8 or 24: only auctions put up for that long; nothing: all of them
 * @param low       true: only auctions put up at the lowest price of the moment
 * @param least     how many must have ended for the chance to mean anything
 */
export function reading(row, { duration = null, low = false, least = 8 } = {}) {
  const r = Array.isArray(row) ? row : [];
  const base = low ? F.lr2 : F.r2;
  let ended = 0, went = 0;
  DURATIONS.forEach((d, k) => { if (duration === null || duration === d) { ended += r[base + k * 2] || 0; went += r[base + k * 2 + 1] || 0; } });
  const lowWent = (r[F.ls2] || 0) + (r[F.ls8] || 0) + (r[F.ls24] || 0);
  return {
    ended, went, chance: ended >= least ? Math.min(1, went / ended) : null,
    hours: lowWent > 0 ? (r[F.lh] || 0) / 10 / lowWent : null,
    sold: r[F.sold] || 0, again: r[F.again] || 0,
  };
}

// ---- what a thing sells for, and how many a day --------------------------------------------------
export const SALES_LEAST = 4; // sales it takes for their price to stand for "what it sells for"

/**
 * What an item sells for: the middle of the prices of what looked like sales (the geometric
 * mean, in copper) - or null where fewer than `least` such were seen.
 */
export function salePrice(row, least = SALES_LEAST) {
  const r = Array.isArray(row) ? row : [];
  const pieces = r[F.pn] || 0;
  if ((r[F.pe] || 0) < least || !(pieces > 0)) return null;
  const price = Math.exp((r[F.pl] || 0) / 100 / pieces);
  return Number.isFinite(price) && price >= 1 ? Math.round(price) : null;
}

/**
 * How many pieces of an item sell in a day at a house, as far as the following saw: the pieces of
 * what looked like sales, over the days they were counted (`from`: when that began; `t`: up to
 * when; never more than the 30 days the figures hold) - or null where that is under `least` days.
 * A floor: a thing put up and bought within the hour was never seen.
 */
export function soldADay(row, from, t, { least = 0.5, most = 30 } = {}) {
  const r = Array.isArray(row) ? row : [];
  const days = Math.min(most, (t - from) / 86400);
  if (!(days >= least)) return null;
  return (r[F.pn] || 0) / days;
}

// ---- the hours of the day ------------------------------------------------------------------------
// Things do not sell at the same pace all day. For every house the function counts, hour by
// hour of the world's clock: how many auctions were up that could have been seen to go (u), how
// many sales there were among them (e), and how many auctions were put up (f) - and on how
// many days each hour was counted (d). The pace of an hour is e / u; held against the day's
// average it says how much better than usual the next two or eight hours are for putting a
// thing up. (For 24 hours it makes no difference: every hour of the day is in them.)
//
//   "e0,…,e23;u0,…,u23;f0,…,f23;d0,…,d23"     as it is kept in the database (numbers in base 36)
export const SHAPE_DAYS = 3;     // days an hour of the day must have been counted on before the shape is gone by
export const ITEM_SALES = 30;    // sales of its own an item needs for its own hours to bend the house's shape
export const SHAPE_WEIGHT = 24;  // the house's shape counts for as much as this many sales of the item's own

const n36 = (v) => Math.max(0, Math.round(Number(v) || 0)).toString(36);
const blank = () => ({ e: new Array(24).fill(0), u: new Array(24).fill(0), f: new Array(24).fill(0), d: new Array(24).fill(0) });
export const noHours = blank;

export function packHours(h) {
  return ['e', 'u', 'f', 'd'].map((k) => Array.from({ length: 24 }, (_, i) => n36(h?.[k]?.[i])).join(',')).join(';');
}
export function unpackHours(text) {
  const out = blank();
  if (typeof text !== 'string') return out;
  text.split(';').forEach((part, k) => {
    const key = ['e', 'u', 'f', 'd'][k];
    if (!key) return;
    part.split(',').slice(0, 24).forEach((s, i) => { const v = /^[0-9a-z]+$/.test(s) ? parseInt(s, 36) : 0; out[key][i] = Number.isSafeInteger(v) ? v : 0; });
  });
  return out;
}
/** Several days' hours (or several houses') together; `d` counts the ones in which an hour had anything up. */
export function sumHours(list) {
  const out = blank();
  for (const h of list) {
    if (!h) continue;
    for (let i = 0; i < 24; i++) {
      out.e[i] += h.e?.[i] || 0; out.u[i] += h.u?.[i] || 0; out.f[i] += h.f?.[i] || 0;
      if (h.u?.[i] > 0) out.d[i] += 1;
    }
  }
  return out;
}

/**
 * The shape of a day at a house: 24 numbers, an hour each from midnight by the world's clock,
 * whose average is 1 - how fast things go in that hour against the day's average. Null where
 * any hour has been counted on fewer than `least` days, or nothing sold at all.
 * @param hours { e, u, d } (unpackHours)
 */
export function dayShape(hours, { least = SHAPE_DAYS } = {}) {
  if (!hours || !Array.isArray(hours.e) || !Array.isArray(hours.u)) return null;
  const pace = [];
  for (let h = 0; h < 24; h++) {
    if (!(hours.u[h] > 0) || (hours.d?.[h] ?? 0) < least) return null;
    pace.push((hours.e[h] || 0) / hours.u[h]);
  }
  const mean = pace.reduce((a, b) => a + b, 0) / 24;
  return mean > 0 ? pace.map((p) => p / mean) : null;
}

/**
 * An item's own shape of the day: the house's, bent by where the item's own sales fall (its
 * line's three-hour blocks) - the more sales of its own, the more. Null where the item has
 * fewer than ITEM_SALES sales counted by the hour: the house's shape stands for it then.
 * @param shape  the house's (dayShape)
 * @param hours  the house's counts (for where its sales fall, block by block)
 */
export function itemShape(row, shape, hours) {
  if (!Array.isArray(row) || !shape || !hours) return null;
  const own = Array.from({ length: BLOCKS }, (_, k) => row[F.b0 + k] || 0);
  const n = own.reduce((a, b) => a + b, 0);
  if (n < ITEM_SALES) return null;
  const size = 24 / BLOCKS;
  const house = Array.from({ length: BLOCKS }, (_, k) => { let s = 0; for (let i = 0; i < size; i++) s += hours.e[k * size + i] || 0; return s; });
  const all = house.reduce((a, b) => a + b, 0);
  if (!(all > 0)) return null;
  const bent = shape.map((s, h) => {
    const k = Math.floor(h / size), usual = house[k] / all;
    if (!(usual > 0)) return s;
    return s * ((own[k] + SHAPE_WEIGHT * usual) / (n + SHAPE_WEIGHT)) / usual;
  });
  const mean = bent.reduce((a, b) => a + b, 0) / 24;
  return mean > 0 ? bent.map((v) => v / mean) : null;
}

/**
 * For each hour of the day an auction might be put up in: how the pace of the `length` hours
 * that follow stands to the pace of the hours auctions are usually up in (the hours they are
 * put up at, `posted`, weighing). 1: as usual. 24 numbers; all 1 for a whole day.
 * A chance measured over every auction, whenever it was put up, becomes the chance of one put
 * up at that hour as chanceAt(chance, pace).
 */
export function paceTable(shape, posted, length) {
  if (!shape || length >= 24) return new Array(24).fill(1);
  const ahead = Array.from({ length: 24 }, (_, h) => { let s = 0; for (let i = 0; i < length; i++) s += shape[(h + i) % 24]; return s / length; });
  let weight = 0, sum = 0;
  for (let h = 0; h < 24; h++) { const p = posted?.[h] > 0 ? posted[h] : 0; weight += p; sum += p * ahead[h]; }
  const usual = weight > 0 && sum > 0 ? sum / weight : 1;
  return ahead.map((v) => v / usual);
}
/** A chance at so many times the usual pace. */
export const chanceAt = (chance, pace) => 1 - (1 - Math.min(1, Math.max(0, chance))) ** Math.max(0, pace);

// ---- how often a thing sells, for whoever is about to put one up ---------------------------------
// One figure per length, made from whatever there is, the nearest counting most:
//
//   our own line for the house      auctions put up at the lowest price of the moment - what
//                                   somebody does who goes by the going price. For 24 hours those
//                                   put up for 24 (lr24, ls24); for 2 and 8 hours how soon things
//                                   went whatever they were put up for (a2 g2, a8 g8: far more
//                                   auctions than those put up for 2 or 8 alone)
//   our own line for the region     the same, of every house of the region together
//   a figure from elsewhere         for 24 hours (TradeSkillMaster's "sale rate" of the region, where
//                                   this copy has it), or none
//
// Each is leaned on the next: the figure from elsewhere counts for as much as PRIOR_WEIGHT
// auctions of our own, so a few readings move it a little and many replace it - the house's own
// over the region's in the same way. No figure at all, and fewer than PRIOR_WEIGHT readings: not
// known (and said so, not guessed).
//
// A figure for 24 hours stands for the shorter lengths where there are no readings of those -
// by `curve`: how a chance for 24 hours becomes one for 2 or 8, as an exponent (curveOf: measured
// over every item of the region together, once there is enough; until then as if things sold
// at the same pace all the while they are up, which is low for the short lengths: things sell
// quicker newly put up than later).
//
// One thing is taken, not measured: of the auctions that went early with a like-for-like new one
// beside them in the same list (`again`), AGAIN_SHARE are taken to have been taken down and put
// up again, not sold. Only somebody's own auctions can say (atlasdb/sales.js has what the players
// of the copies report of theirs: `exact`, which counts as it stands).
export const PRIOR_WEIGHT = 8;
export const AGAIN_SHARE = 0.5;
export const CURVE_LEAST = 400;   // auctions ended, at the lowest price, it takes to measure the curve

/** A chance for 24 hours as the chance for another length: taken as going at the same pace all the while. */
export const forLength = (p24, hours) => 1 - (1 - Math.min(1, Math.max(0, p24))) ** (hours / 24);
const STEADY = { 2: 2 / 24, 8: 8 / 24, 24: 1 };

/** What a line has to say of one length: [ended, went] at the lowest price. */
function evidence(row, d) {
  if (d === 2 && (row[F.a2] || 0) > 0) return [row[F.a2], row[F.g2] || 0];
  if (d === 8 && (row[F.a8] || 0) > 0) return [row[F.a8], row[F.g8] || 0];
  const k = DURATIONS.indexOf(d);
  return [row[F.lr2 + k * 2] || 0, row[F.ls2 + k * 2] || 0];
}
/** The share of a line's early-gone auctions taken as sold, not taken down and put up again. */
function kept(row) {
  const wentAll = (row[F.s2] || 0) + (row[F.s8] || 0) + (row[F.s24] || 0);
  return 1 - AGAIN_SHARE * Math.min(1, wentAll > 0 ? (row[F.again] || 0) / wentAll : 0);
}

/**
 * How a chance for 24 hours becomes one for 2 or 8, measured: over every line given (a region's
 * items), of the auctions put up at the lowest price, how many were gone within 2, 8 and 24
 * hours. → { 2, 8, 24: 1 } exponents (chance for d = 1 - (1 - chance for 24) ^ curve[d]) - never
 * under the steady pace, never over 1; the steady pace where there is too little to measure.
 */
export function curveOf(rows) {
  const sum = { 2: [0, 0], 8: [0, 0], 24: [0, 0] };
  for (const row of Object.values(rows ?? {})) {
    if (!Array.isArray(row)) continue;
    const k = kept(row);
    for (const d of DURATIONS) {
      const [ended, went] = d === 24 ? [row[F.lr24] || 0, row[F.ls24] || 0] : d === 2 ? [row[F.a2] || 0, row[F.g2] || 0] : [row[F.a8] || 0, row[F.g8] || 0];
      sum[d][0] += ended; sum[d][1] += went * k;
    }
  }
  const out = { ...STEADY, measured: false };
  if (sum[24][0] < CURVE_LEAST) return out;
  const p24 = sum[24][1] / sum[24][0];
  if (!(p24 > 0.01 && p24 < 0.99)) return out;
  for (const d of [2, 8]) {
    if (sum[d][0] < CURVE_LEAST) continue;
    const p = Math.min(p24, sum[d][1] / sum[d][0]);
    out[d] = Math.min(1, Math.max(STEADY[d], Math.log(1 - p) / Math.log(1 - p24)));
    out.measured = true;
  }
  if (out[8] < out[2]) out[8] = out[2];
  return out;
}

/**
 * How often an item put up at about the lowest price sells, for each length it can be put up for.
 * @param house   our own line for the house (or nothing)
 * @param region  our own line for the region's houses together (or nothing)
 * @param prior   a figure from elsewhere for 24 hours, 0 to 1 (or null: none)
 * @param curve   how a chance for 24 hours becomes one for 2 or 8 (curveOf; nothing: the steady pace)
 * @param exact   what became of auctions whose owners said: { 2: [ended, sold], 8: …, 24: … } (or nothing)
 * @returns { 2: { chance (0..1, or null: not known), ended (auctions of ours behind it: the house's), from }, 8: …, 24: … }
 *          from: 'house' (the house's own readings carry it), 'region', 'prior' (the figure from
 *          elsewhere, with what few readings there are), 'own' (the owners' word), or null (not known)
 */
export function chances(house, region, prior = null, { curve = null, exact = null } = {}) {
  const out = {};
  const sound = typeof prior === 'number' && prior >= 0 && prior <= 1;
  const lean = (d, est, from) => {
    for (const [name, row] of [['region', region], ['house', house]]) {
      if (!Array.isArray(row)) continue;
      const [ended, gone] = evidence(row, d);
      if (!(ended > 0)) continue;
      const went = Math.min(ended, gone * kept(row));
      if (est !== null) est = (went + PRIOR_WEIGHT * est) / (ended + PRIOR_WEIGHT);
      else if (ended >= PRIOR_WEIGHT) est = went / ended;
      if (ended >= PRIOR_WEIGHT && est !== null) from = name;
    }
    const said = exact?.[d];
    if (Array.isArray(said) && said[0] > 0) {
      const ended = said[0], sold = Math.min(ended, said[1] || 0);
      if (est !== null) est = (sold + PRIOR_WEIGHT * est) / (ended + PRIOR_WEIGHT);
      else if (ended >= PRIOR_WEIGHT) est = sold / ended;
      if (ended >= PRIOR_WEIGHT && est !== null) from = 'own';
    }
    return [est, from];
  };
  // 24 hours first: the shorter lengths start from it
  const [day, dayFrom] = lean(24, sound ? prior : null, sound ? 'prior' : null);
  for (const d of DURATIONS) {
    let est = day, from = dayFrom;
    if (d !== 24) {
      const power = curve?.[d] > 0 ? curve[d] : STEADY[d];
      [est, from] = lean(d, day === null ? null : 1 - (1 - Math.min(1, Math.max(0, day))) ** power, dayFrom);
    }
    out[d] = { chance: est === null ? null : Math.min(1, Math.max(0, est)), ended: Array.isArray(house) ? evidence(house, d)[0] : 0, from: est === null ? null : from };
  }
  // (a longer auction sells at least as often as a shorter one: few readings must not say otherwise)
  if (out[8].chance !== null && out[2].chance !== null && out[8].chance < out[2].chance) out[8].chance = out[2].chance;
  if (out[24].chance !== null && out[8].chance !== null && out[24].chance < out[8].chance) out[24].chance = out[8].chance;
  if (out[24].chance !== null && out[2].chance !== null && out[24].chance < out[2].chance) out[24].chance = out[2].chance;
  return out;
}
