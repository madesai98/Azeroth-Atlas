// What sells, as we measure it ourselves: the figures kept per item and per auction house, and
// how they are read. (Shared with the function in the cloud that makes them: functions/track.js
// follows every auction from look to look, and this file says what it writes down.)
//
// A list of auctions says what is asked, not what sells. But Blizzard gives every auction a
// number of its own and says roughly how long it has left, and the lists are made anew every
// hour: an auction that is in one list and gone from the next, long before its time could have
// run out, was bought (or taken down by its seller: the lists cannot tell which). Followed for
// every auction of every house, that says how often an item sells of the times it is put up, how
// long it is up before it goes, and how many pieces go in a day - for each house by itself, the
// neutral ones too, which nobody else publishes figures for.
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
//
// What it cannot see, and so what the figures lean towards:
//   - sold and taken down look the same (`again` is a hint of how much of it is the second);
//   - the lists are an hour apart: an auction put up and bought within the hour is never seen
//     (the quickest sales are missing), and one put up for 2 hours is seen at most twice;
//   - what is counted as having run its time may have been bought in its last hour.
//
// Kept thirty days and no longer, like everything made from Blizzard's lists (days.js).

export const DURATIONS = [2, 8, 24];   // hours an auction can be put up for in this game
export const FIELDS = ['r2', 's2', 'r8', 's8', 'r24', 's24', 'lr2', 'ls2', 'lr8', 'ls8', 'lr24', 'ls24', 'lh', 'sold', 'again'];
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

// ---- how often a thing sells, for whoever is about to put one up ---------------------------------
// One figure per length, made from whatever there is, the nearest counting most:
//
//   our own line for the house      auctions put up at the lowest price of the moment (lr, ls) -
//                                   what somebody does who goes by the going price
//   our own line for the region     the same, of every house of the region together
//   a figure from elsewhere         for 24 hours (TradeSkillMaster's "sale rate" of the region, where
//                                   this copy has it), or none
//
// Each is leaned on the next: the figure from elsewhere counts for as much as PRIOR_WEIGHT
// auctions of our own, so a few readings move it a little and many replace it - the house's own
// over the region's in the same way. No figure at all, and fewer than PRIOR_WEIGHT readings: not
// known (and said so, not guessed).
//
// Two things are taken, not measured (to be fitted once there are weeks of readings to fit to):
//   - a figure for 24 hours stands for the shorter lengths as if things sold at the same rate all
//     the while (forLength): 34% in 24 hours is 13% in 8 and 3% in 2. Things sell quicker when
//     newly put up than later, so this is low for the short lengths until our own readings say;
//   - of the auctions that went early with a like-for-like new one beside them in the same list
//     (`again`), AGAIN_SHARE are taken to have been taken down and put up again, not sold.
export const PRIOR_WEIGHT = 8;
export const AGAIN_SHARE = 0.5;

/** A chance for 24 hours as the chance for another length: taken as going at the same rate all the while. */
export const forLength = (p24, hours) => 1 - (1 - Math.min(1, Math.max(0, p24))) ** (hours / 24);

/**
 * How often an item put up at about the lowest price sells, for each length it can be put up for.
 * @param house   our own line for the house (or nothing)
 * @param region  our own line for the region's houses together (or nothing)
 * @param prior   a figure from elsewhere for 24 hours, 0 to 1 (or null: none)
 * @returns { 2: { chance (0..1, or null: not known), ended (auctions of ours behind it: the house's), from }, 8: …, 24: … }
 *          from: 'house' (the house's own readings carry it), 'region', 'prior' (the figure from
 *          elsewhere, with what few readings there are), or null (not known)
 */
export function chances(house, region, prior = null) {
  const out = {};
  const sound = typeof prior === 'number' && prior >= 0 && prior <= 1;
  DURATIONS.forEach((d, k) => {
    let est = sound ? forLength(prior, d) : null, from = sound ? 'prior' : null;
    for (const [name, row] of [['region', region], ['house', house]]) {
      if (!Array.isArray(row)) continue;
      const ended = row[F.lr2 + k * 2] || 0;
      if (!(ended > 0)) continue;
      const wentAll = (row[F.s2] || 0) + (row[F.s8] || 0) + (row[F.s24] || 0);
      const kept = 1 - AGAIN_SHARE * Math.min(1, wentAll > 0 ? (row[F.again] || 0) / wentAll : 0);
      const went = Math.min(ended, (row[F.ls2 + k * 2] || 0) * kept);
      if (est !== null) est = (went + PRIOR_WEIGHT * est) / (ended + PRIOR_WEIGHT);
      else if (ended >= PRIOR_WEIGHT) est = went / ended;
      if (ended >= PRIOR_WEIGHT && est !== null) from = name;
    }
    out[d] = { chance: est === null ? null : Math.min(1, Math.max(0, est)), ended: Array.isArray(house) ? house[F.lr2 + k * 2] || 0 : 0, from: est === null ? null : from };
  });
  return out;
}
