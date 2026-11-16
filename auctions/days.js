// Days, and what is kept how long: the part of the auction prices that needs nothing but
// arithmetic, so that it is the same in a copy of the map and in the function in the cloud that
// writes what the copies read (functions/).
//
// A day is a day by the world's clock (UTC), written 20261116; t is seconds since 1970.
//
// NOTHING IS KEPT LONGER THAN 30 DAYS. Blizzard's terms for its API say so ("You will retain
// data pulled from Blizzard Developer APIs for no longer than 30 days"): days older than that are
// deleted on every run, on each computer (store.js) and in the Atlas database (functions/cloud.js).

export const KEEP_DAYS = 30;   // Blizzard's terms: no longer
export const KEEP_HOURS = 7;   // days of every single look, on a computer (they are large)
export const KEEP_LOOKS = 2;   // days of every single look, in the Atlas database (today and yesterday)

/** 1794842264 → 20261116 */
export const dayOf = (t) => { const d = new Date(t * 1000); return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(); };
/** 20261116 → seconds at the start of that day */
export const dayStart = (day) => Date.UTC(Math.floor(day / 10000), Math.floor(day / 100) % 100 - 1, day % 100) / 1000;
/**
 * The oldest day that may still be kept, counted from now: the first day that lies wholly inside
 * the last `days` times 24 hours (so with today, 30 days at most, and no look older than 30 days).
 */
export const oldestKept = (now = Date.now() / 1000, days = KEEP_DAYS) => dayOf(now - (days - 1) * 86400);
/** The `count` days before a day, nearest first: the day before 20261101 is 20261031. */
export const daysBefore = (day, count) => Array.from({ length: count }, (_, i) => dayOf(dayStart(day) - (i + 1) * 86400 + 43200));

/**
 * A look added to its day's line.
 * @param items  the day so far: { <id>: [low, high, close, min, q] } (low / high / close: the lowest,
 *               highest and last going price of the day; min: the lowest anybody asked; q: the pieces
 *               for sale at the last look). Changed in place, and returned.
 * @param now    the look: { <id>: [min, mv, n, q] }
 */
export function mergeDay(items, now) {
  for (const [id, e] of Object.entries(now)) {
    const [min, mv, , q] = e;
    const c = items[id];
    if (!c) items[id] = [mv, mv, mv, min, q];
    else {
      if (mv > 0) { c[0] = c[0] > 0 ? Math.min(c[0], mv) : mv; c[1] = Math.max(c[1], mv); c[2] = mv; }
      if (min > 0) c[3] = c[3] > 0 ? Math.min(c[3], min) : min;
      c[4] = q;
    }
  }
  // (what was for sale earlier in the day and is not any more: nothing is for sale now)
  for (const [id, c] of Object.entries(items)) if (!(id in now)) c[4] = 0;
  return items;
}
