// The auction prices, fetched from the shared Atlas database by a copy of the map.
//
// Blizzard gives its lists to whoever has an API client, and a client may not be handed on. So
// one reader, a scheduled function in the cloud (functions/), reads the lists and puts what it
// makes of them into the Atlas database, and every copy of the map reads them from there. That
// is what Blizzard's terms call distributing the data "to end users for their personal use via
// Your Application". They also say how long it may be kept: 30 days, and no longer (days.js).
//
// What is in the database, and how it is written: functions/cloud.js and pack.js. The rules
// (atlasdb/rules.json) let every copy read /market and only the maintainers write it.
import { entries } from '../atlasdb/rtdb.js';
import { KEEP_DAYS, KEEP_HOURS, dayOf, dayStart, oldestKept } from './days.js';
import { unpack } from './pack.js';

export { pack, unpack } from './pack.js';
import { FIGURES } from './sells.js';

const SELLS_EVERY = 6 * 3600; // seconds: what sells changes slowly - a copy asks for it no more often than this

/**
 * Only what a house holds now, and nothing of its days: for the neutral house that goes with
 * this copy's own, whose prices are wanted and whose history is not.
 * @returns { house, t, fetched } or null when the house is not published
 */
export async function pullNow(db, store, house) {
  const idx = await db.get(`market/index/${house}`);
  if (!idx?.t || idx.t < Date.now() / 1000 - KEEP_DAYS * 86400) return null;
  const have = store.now(house);
  if (have && have.t >= idx.t) return { house, t: have.t, fetched: 0 };
  const items = {};
  for (const [id, r] of Object.entries(unpack(await db.get(`market/now/${house}`)))) items[id] = [r[0], r[1], r[2], r[3]];
  store.write(`${house}/now.json`, { t: idx.t, items });
  return { house, t: idx.t, fetched: 1 };
}

/**
 * What sells (sells.js: how often, how soon, how many), as the function in the cloud has
 * measured it over the last 30 days, fetched where the database has something newer than this
 * computer - and asked for no more often than every six hours.
 * @param key  a house ('us-110'), or every house of a region together ('all-us')
 * Kept with which making of the figures it is (sells.js: FIGURES): what this computer has of
 * another making is asked after at once, whenever it was last asked - and nobody goes by it.
 * @returns { key, t, fetched } or null when there are no figures yet
 */
export async function pullSells(db, store, key, now = Date.now() / 1000) {
  const have = store.sells(key);
  if (have && have.v === FIGURES && now - (have.at ?? 0) < SELLS_EVERY) return { key, t: have.t, fetched: 0 };
  const idx = await db.get(`market/sellindex/${key}`);
  if (!idx?.t || idx.t < now - KEEP_DAYS * 86400) return null;
  const v = idx.v ?? 1;
  if (have && have.t >= idx.t && have.v === v) { store.write(`${key}/sell.json`, { ...have, at: Math.floor(now) }); return { key, t: have.t, fetched: 0 }; }
  const items = unpack(await db.get(`market/sell/${key}`));
  store.write(`${key}/sell.json`, { t: idx.t, v, at: Math.floor(now), items });
  return { key, t: idx.t, fetched: 1 };
}

/**
 * Fetch one house from the database into this computer's store: "now" when it is newer than what
 * is here, the days this copy has not got whole, and the single looks it has not seen.
 * @returns { house, t, fetched: number of texts fetched } or null when the house is not published
 */
export async function pullMarket(db, store, house, log = () => {}) {
  const idx = await db.get(`market/index/${house}`);
  // (a list older than may be kept is as good as none: whoever publishes has stopped)
  if (!idx?.t || idx.t < Date.now() / 1000 - KEEP_DAYS * 86400) return null;
  const mine = store.state().houses?.[house] ?? {};
  let fetched = 0;
  const have = store.now(house);
  if (!have || have.t < idx.t) {
    const items = unpack(await db.get(`market/now/${house}`));
    const look = new Map(Object.entries(items).map(([id, r]) => [Number(id), { min: r[0], mv: r[1], n: r[2], q: r[3] }]));
    store.addLook(house, idx.t, look);
    fetched++;
  }
  // A day is whole once the house was listed after the day ended. Days this copy has whole are
  // not asked for again; the rest (today, and any it has never had) are.
  const whole = new Set(mine.whole ?? []);
  const oldest = oldestKept();
  const listed = entries(await db.get(`market/days/${house}`, { shallow: true })).map(([d]) => Number(d.slice(1))).filter((d) => d >= oldest).sort((a, b) => a - b);
  const want = listed.filter((d) => !whole.has(d));
  let next = 0;
  const one = async () => {
    while (next < want.length) {
      const day = want[next++];
      const items = unpack(await db.get(`market/days/${house}/d${day}`));
      if (!Object.keys(items).length) continue;
      store.write(`${house}/days/${day}.json`, { day, t: Math.min(idx.t, dayStart(day) + 86399), items });
      fetched++;
      if (idx.t >= dayStart(day) + 86400) whole.add(day);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, want.length) }, one));
  // The single looks the database still has (today's and yesterday's) and this copy has not: so the
  // look-by-look chart is whole for the last two days however seldom the map is opened, and for as
  // long as this computer keeps them (7 days) when it is opened often.
  const oldestHour = oldestKept(Date.now() / 1000, KEEP_HOURS);
  for (const [dkey] of entries(await db.get(`market/looks/${house}`, { shallow: true }))) {
    const day = Number(dkey.slice(1));
    if (!/^d\d{8}$/.test(dkey) || day < oldestHour) continue;
    const got = new Set(store.hours(house, day)?.t ?? []);
    const times = entries(await db.get(`market/looks/${house}/${dkey}`, { shallow: true })).map(([k]) => Number(k.slice(1))).filter((t) => t > 0 && !got.has(t) && dayOf(t) === day).sort((a, b) => a - b);
    if (!times.length) continue;
    // (most of a day missing: the day in one request; a look or two: each by itself)
    const all = times.length > 3 ? (await db.get(`market/looks/${house}/${dkey}`)) ?? {} : null;
    for (const t of times) {
      const items = unpack(all ? all[`t${t}`] : await db.get(`market/looks/${house}/${dkey}/t${t}`));
      if (Object.keys(items).length && store.addHour(house, t, items)) fetched++;
    }
  }
  store.note(house, { t: idx.t, items: idx.n, by: 'atlas', at: Date.now(), whole: [...whole].filter((d) => d >= oldest).sort((a, b) => a - b) });
  if (fetched) log(`${house}: fetched from the Atlas database (${fetched} ${fetched === 1 ? 'part' : 'parts'}), listed ${new Date(idx.t * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  return { house, t: idx.t, fetched, day: dayOf(idx.t) };
}
