// The boats, zeppelins and tram: every copy's sightings taken in, and each line's place on the
// server's clock measured anew from all of them.
//
// This is the whole of it in the cloud: the work of the scheduled function (index.js). What is
// done with the sightings is the map's own code (shared/boats.js, a copy of atlasdb/boats.js:
// `fold` and `measure`, which say how a line is measured); here they are only fetched, handed
// to it, and what comes out written back. It keeps nothing of its own.
//
//   /boats/seen/<copy>/<delivery>   what a copy sent, until it is taken in: { v, at, app, s: [a sighting as it is sent] }.
//                                   A copy may add to its own corner and nothing else (atlasdb/rules.json)
//   /boats/state                    what the database keeps of every line: its newest sightings of the count
//                                   that runs and of the one before. Nobody but the function reads it
//   /transit                        what is published, for every copy to fetch: { v, at, count (when the server's
//                                   count last started), lines: { [key]: { period, periodUnsure, left, leftUnsure,
//                                   seen, rides, bias } } }. A line of which too little was seen is not in it
//
// A run that finds nothing sent asks one question and is done. What was sent is taken away only
// after it is in /boats/state: a run that stops half way is made up for by the next, and a
// sighting taken in twice is one sighting (boats.js).
import { fold, measure } from './shared/boats.js';

/**
 * Take in what was sent, measure, publish.
 * @param db     { get(path), set(path, value), patch(path, changes) }
 * @param lines  the lines of the map's transit.json (shared/lines.json)
 * @returns { same (nothing had been sent), deliveries, taken, refused, lines (how many are measured), changed }
 */
export async function lookAndMeasure(db, lines, { now = Date.now() / 1000, log = () => {} } = {}) {
  const seen = await db.get('boats/seen');
  const deliveries = [], done = {};
  for (const [copy, list] of Object.entries(seen ?? {})) {
    for (const [id, d] of Object.entries(list ?? {})) {
      deliveries.push({ copy, s: d?.s ?? [] });
      done[`${copy}/${id}`] = null;
    }
  }
  if (!deliveries.length) return { same: true, deliveries: 0 };
  const [state, was] = [await db.get('boats/state'), await db.get('transit')];
  const r = fold(state, deliveries, lines, now);
  const made = measure(r.state, lines, was, now);
  await db.set('boats/state', r.state);
  const changed = made.count !== was?.count || JSON.stringify(made.lines) !== JSON.stringify(was?.lines ?? {});
  if (changed) await db.set('transit', { ...made, at: Math.round(now) });
  await db.patch('boats/seen', done);
  for (const [key, f] of Object.entries(made.lines)) log(`${key}: round ${f.period} s (+-${f.periodUnsure}), left its first stop ${f.left} (+-${f.leftUnsure} s); ${f.seen} sightings, ${f.rides} of them rides`);
  return { same: false, deliveries: deliveries.length, taken: r.taken, refused: r.refused, lines: Object.keys(made.lines).length, changed };
}
