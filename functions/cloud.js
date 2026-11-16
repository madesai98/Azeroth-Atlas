// Looking at the auction houses and putting what is found straight into the Atlas database.
//
// This is the whole of the publishing: the work of the scheduled function (index.js), and of
// nothing else. No copy of the map does any of it; a copy only reads what is written here
// (auctions/share.js). It keeps nothing of its own: what it needs to know from one hour to the
// next (when each house was last listed, the day's line so far) it reads from the database it
// writes to. It asks Blizzard for a house only if its list is newer than the one in the
// database, so a run that comes too early, or twice, changes nothing.
//
// It needs only a database it can read and write ({ get(path), patch(path, changes) }: index.js
// makes one) and Blizzard's API (blizzard.js).
//
//   /market/index/<house>                 { t, n, by, reader }: when the house was last listed (seconds), how many
//                                         items, and who read it ("cloud": this function)
//   /market/now/<house>                   the house as last listed: "id,min,mv,n,q;…" (pack.js)
//   /market/days/<house>/d<day>           one day: "id,low,high,close,min,q;…"
//   /market/looks/<house>/d<day>/t<t>     one look, kept two days: "id,min,mv,q;…"
//
// What is too old to be kept is deleted on every run: days after 30 days (Blizzard's terms for
// its data: days.js), single looks after two.
import { summarise } from './summary.js';
import { RULESETS, housesOf, parseHouse } from './shared/houses.js';
import { pack, unpack } from './shared/pack.js';
import { KEEP_DAYS, KEEP_LOOKS, dayOf, daysBefore, mergeDay, oldestKept } from './shared/days.js';

const SWEEP = 90; // how many days back the deleting reaches on each run (nothing older can be there: see below)

/**
 * Look at every house of the regions asked for, and publish each that has a newer list.
 * @param reader  who is doing this, noted beside each house it publishes ('cloud')
 * @returns {{ sent: string[], same: string[], failed: [string, string][], listed, requests, bytes, written }}
 *          listed: when the newest list among these houses was made (seconds; 0: none is known)
 */
export async function lookAndPublish(api, db, regions, { log = () => {}, now = () => Date.now() / 1000, reader = null } = {}) {
  const out = { sent: [], same: [], failed: [], written: 0, listed: 0 };
  const index = (await db.get('market/index')) ?? {};
  for (const region of regions) {
    for (const house of housesOf(region)) {
      const h = parseHouse(house);
      const ruleset = RULESETS[h.ruleset].id; // (the same houses are listed under every ruleset: asked for under their own)
      const had = index[house]?.t ?? 0;
      out.listed = Math.max(out.listed, had);
      try {
        const a = await api.house(region, ruleset, h.id, { since: had ? new Date(had * 1000).toUTCString() : null });
        if (a.status === 304) { out.same.push(house); continue; }
        if (a.status !== 200) { out.failed.push([house, `HTTP ${a.status}`]); continue; }
        const t = Math.floor(Date.parse(a.modified ?? '') / 1000) || Math.floor(now());
        if (t <= had) { out.same.push(house); continue; }
        const c = await api.commodities(region, ruleset, h.id);
        const items = summarise(a.json?.auctions ?? [], c.status === 200 ? c.json?.auctions ?? [] : []);
        const look = {}, short = {};
        for (const [id, e] of items) if (Number.isInteger(id)) { look[id] = [e.min, e.mv, e.n, e.q]; short[id] = [e.min, e.mv, e.q]; }
        const day = dayOf(t);
        // A database not written to for 30 days holds nothing that may be kept: cleared first.
        // (That is also why the deleting below need reach no further back than it does.)
        if (had && had < now() - KEEP_DAYS * 86400) await db.patch('market', { [`days/${house}`]: null, [`looks/${house}`]: null });
        const line = mergeDay(unpack(await db.get(`market/days/${house}/d${day}`)), look);
        const request = {
          [`now/${house}`]: pack(look),
          [`days/${house}/d${day}`]: pack(line),
          [`looks/${house}/d${day}/t${t}`]: pack(short),
          [`index/${house}`]: { t, n: Object.keys(look).length, by: 'blizzard', ...(reader ? { reader } : {}) },
        };
        // what is too old: deleted whether or not it is there
        for (const old of daysBefore(oldestKept(now()), SWEEP)) request[`days/${house}/d${old}`] = null;
        for (const old of daysBefore(oldestKept(now(), KEEP_LOOKS), SWEEP)) request[`looks/${house}/d${old}`] = null;
        await db.patch('market', request);
        out.sent.push(house);
        out.listed = Math.max(out.listed, t);
        out.written += pack(look).length + pack(line).length + pack(short).length;
        log(`${house}: ${items.size.toLocaleString()} items, listed ${new Date(t * 1000).toISOString().slice(11, 16)} UTC, published`);
      } catch (err) {
        out.failed.push([house, err.message]);
        log(`${house}: ${err.message}`);
        if (err.status === 401 || err.status === 403) break; // (refused outright: no use asking on)
      }
    }
  }
  out.requests = api.requests;
  out.bytes = api.bytes;
  return out;
}
