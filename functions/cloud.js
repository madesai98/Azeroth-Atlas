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
// And what sells. Every auction is followed from one list to the next (track.js), which says
// what a list alone cannot: how often an item sells of the times it is put up, for how long it
// was put up, how soon it went (shared/sells.js has what is written down and what it means):
//
//   /market/sells/<house>/d<day>          what ended that day, item by item: "id,r2,s2,…;…"
//   /market/sell/<house>                  the same for the last 30 days together: what a copy reads
//   /market/sell/all-<region>             ...and for every house of the region together: what a copy
//                                         goes by for an item its own house has no readings of
//   /market/sellindex/<house>             { t, v, since, pfrom, ended, went, young, sales, items, hours }:
//                                         when that was last added to, which making of the figures
//                                         it is (sells.js: FIGURES - figures of another making are
//                                         not added to: they begin anew), since when the following
//                                         has gone on, since when sales have been counted (for "so
//                                         many a day"), and the hours of the day of the last 30 days
//                                         together (sells.js: packHours)
//   /market/hours/<house>/d<day>          one day's hours of the day: how many auctions were up, how
//                                         many sales there were, how many were put up, hour by hour
//   /track/<house>                        every auction still up, as the next run needs it (only
//                                         this function reads it: it is no part of /market)
//
// What is too old to be kept is deleted on every run: days after 30 days (Blizzard's terms for
// its data: days.js), single looks after two. The 30 days' figures lose each day as it falls
// out of them.
import { summarise } from './summary.js';
import { RULESETS, housesOf, parseHouse } from './shared/houses.js';
import { pack, unpack } from './shared/pack.js';
import { KEEP_DAYS, KEEP_LOOKS, dayOf, dayStart, daysBefore, mergeDay, oldestKept } from './shared/days.js';
import { addRows, trimRows, FIGURES, packHours, unpackHours, sumHours, noHours } from './shared/sells.js';
import { follow, packState, unpackState } from './track.js';

const SWEEP = 90; // how many days back the deleting reaches on each run (nothing older can be there: see below)

/**
 * Look at every house of the regions asked for, and publish each that has a newer list.
 * @param reader  who is doing this, noted beside each house it publishes ('cloud')
 * @returns {{ sent: string[], same: string[], failed: [string, string][], listed, requests, bytes, written }}
 *          listed: when the newest list among these houses was made (seconds; 0: none is known)
 */
export async function lookAndPublish(api, db, regions, { log = () => {}, now = () => Date.now() / 1000, reader = null } = {}) {
  const out = { sent: [], same: [], failed: [], written: 0, listed: 0, followed: { up: 0, fresh: 0, ended: 0, went: 0, young: 0, sales: 0 } };
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
        // Every auction followed from the list before (track.js). Not from a list whose other
        // half could not be read: everything sold by the piece would look bought at once. (The
        // next list is then held against the one before this, a longer step.)
        const whole = c.status === 200 || c.status === 404;
        const stale = !had || had < now() - KEEP_DAYS * 86400; // (nothing may be kept, or nothing is: the following begins anew)
        const f = whole ? follow(stale ? null : unpackState(await db.get(`track/${house}`)), a.json?.auctions ?? [], c.json?.auctions ?? [], t) : null;
        const look = {}, short = {};
        for (const [id, e] of items) if (Number.isInteger(id)) { look[id] = [e.min, e.mv, e.n, e.q]; short[id] = [e.min, e.mv, e.q]; }
        const day = dayOf(t);
        // A database not written to for 30 days holds nothing that may be kept: cleared first.
        // (That is also why the deleting below need reach no further back than it does.)
        if (had && had < now() - KEEP_DAYS * 86400) await db.patch('market', { [`days/${house}`]: null, [`looks/${house}`]: null, [`sells/${house}`]: null, [`sell/${house}`]: null, [`hours/${house}`]: null });
        const line = mergeDay(unpack(await db.get(`market/days/${house}/d${day}`)), look);
        const request = {
          [`now/${house}`]: pack(look),
          [`days/${house}/d${day}`]: pack(line),
          [`looks/${house}/d${day}/t${t}`]: pack(short),
          [`index/${house}`]: { t, n: Object.keys(look).length, by: 'blizzard', ...(reader ? { reader } : {}) },
        };
        if (f) {
          // what ended since the list before: into its day, and into the 30 days together -
          // which first lose every day that has fallen out of them since this house was last listed
          // (figures of another making - sells.js: FIGURES - are not added to: they begin anew, their days with them)
          const was = stale ? null : await db.get(`market/sellindex/${house}`);
          const anew = !stale && (was?.v ?? 1) !== FIGURES;
          if (anew) await db.patch('market', { [`sells/${house}`]: null, [`sell/${house}`]: null, [`hours/${house}`]: null });
          const sold = addRows(anew ? {} : unpack(await db.get(`market/sells/${house}/d${day}`)), f.rows);
          let total = stale || anew ? {} : unpack(await db.get(`market/sell/${house}`));
          const oldest = oldestKept(now());
          for (let d = oldestKept(had || now()); !anew && d < oldest; d = dayOf(dayStart(d) + 86400 + 43200)) total = addRows(total, unpack(await db.get(`market/sells/${house}/d${d}`)), -1);
          total = addRows(total, f.rows);
          request[`sells/${house}/d${day}`] = pack(trimRows(sold));
          request[`sell/${house}`] = pack(trimRows(total));
          // the hours of the day: this step's counts into its day, and the days still kept together
          const days = stale || anew ? {} : (await db.get(`market/hours/${house}`)) ?? {};
          const today = typeof days[`d${day}`] === 'string' ? unpackHours(days[`d${day}`]) : noHours();
          if (f.by) { today.e[f.by.hour] += f.by.e; today.u[f.by.hour] += f.by.u; today.f[f.by.hour] += f.by.f; }
          days[`d${day}`] = packHours(today);
          request[`hours/${house}/d${day}`] = days[`d${day}`];
          const kept = Object.entries(days).filter(([k, v]) => /^d\d{8}$/.test(k) && Number(k.slice(1)) >= oldest && typeof v === 'string').map(([, v]) => unpackHours(v));
          request[`sellindex/${house}`] = {
            t, v: FIGURES, since: Math.round(f.state.since), pfrom: !stale && !anew && was?.pfrom > 0 ? was.pfrom : t,
            up: f.seen.up, ended: f.seen.ended, went: f.seen.went, young: f.seen.young, sales: f.seen.sales, items: Object.keys(total).length, hours: packHours(sumHours(kept)),
          };
          for (const k of Object.keys(out.followed)) out.followed[k] += f.seen[k];
          out.written += request[`sells/${house}/d${day}`].length + request[`sell/${house}`].length;
        }
        // what is too old: deleted whether or not it is there
        for (const old of daysBefore(oldestKept(now()), SWEEP)) { request[`days/${house}/d${old}`] = null; request[`sells/${house}/d${old}`] = null; request[`hours/${house}/d${old}`] = null; }
        for (const old of daysBefore(oldestKept(now(), KEEP_LOOKS), SWEEP)) request[`looks/${house}/d${old}`] = null;
        // (written in one go with what is remembered of the auctions still up: were the one written
        // and not the other, the next list would count the same auctions twice, or miss them)
        const all = Object.fromEntries(Object.entries(request).map(([k, v]) => [`market/${k}`, v]));
        if (f) { all[`track/${house}`] = packState(f.state); out.written += all[`track/${house}`].length; }
        await db.patch('/', all);
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
  // Every house of a region together, once a day: what a copy goes by for an item its own house
  // has no readings of (the first run of a day that published anything makes it).
  for (const region of regions) {
    try {
      const day = dayOf(now());
      const made = await db.get(`market/sellindex/all-${region}`);
      if (!out.sent.some((house) => house.startsWith(`${region}-`)) || (made?.day === day && made.v === FIGURES)) continue;
      let total = {}, houses = 0;
      const hours = [];
      for (const house of housesOf(region)) {
        // (only figures of this making: a house whose figures have not begun anew yet is left out)
        const idx = await db.get(`market/sellindex/${house}`);
        if ((idx?.v ?? 1) !== FIGURES) continue;
        const rows = unpack(await db.get(`market/sell/${house}`));
        if (Object.keys(rows).length) { total = addRows(total, rows); houses++; }
        // (the hours of the day of the region: each house's 30 days, added up - how many days each hour was counted on is the most of any house)
        if (typeof idx.hours === 'string') hours.push(unpackHours(idx.hours));
      }
      // (none yet, where there were figures of another making: those are taken away)
      if (!houses) { if (made && made.v !== FIGURES) await db.patch('market', { [`sell/all-${region}`]: null, [`sellindex/all-${region}`]: null }); continue; }
      const text = pack(trimRows(total));
      const together = sumHours(hours);
      for (let i = 0; i < 24; i++) together.d[i] = Math.max(0, ...hours.map((h) => h.d[i] || 0));
      await db.patch('market', { [`sell/all-${region}`]: text, [`sellindex/all-${region}`]: { t: Math.floor(now()), v: FIGURES, day, houses, items: Object.keys(total).length, hours: packHours(together) } });
      out.written += text.length;
      log(`${region}: what sells in its ${houses} houses together, ${Object.keys(total).length.toLocaleString()} items, published`);
    } catch (err) { log(`${region}: its houses together could not be written (${err.message})`); }
  }
  out.requests = api.requests;
  out.bytes = api.bytes;
  return out;
}
