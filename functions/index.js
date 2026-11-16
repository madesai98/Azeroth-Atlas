// Azeroth Atlas in the cloud: the auction houses, looked at once an hour.
//
// A scheduled function of the Atlas database's own Firebase project. Twice an hour it asks
// Blizzard's API for every auction house whose list is newer than the one in the database, boils
// each down to a line per item (summary.js), and writes it to /market (cloud.js), with nobody's
// computer on. This is the only place the auction houses are read: a copy of the map takes
// its prices from the database and never goes to Blizzard. The function keeps nothing of its
// own: what it must know from one hour to the next is in the database.
//
// Blizzard makes its lists anew once an hour, at about 18 minutes past. The function runs at 20
// past, and again at 45 past for a list that came late or a run that failed; a run that finds
// nothing newer asks twelve short questions and is done in a second or two.
//
// What it needs, set once when it is deployed (the README, "Auction prices", says how):
//   BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET   a Blizzard API client, kept in the project's Secret
//                                                Manager and nowhere in this repository
//   AUCTION_REGIONS (.env)                       which regions to read: "us", or "us,eu,kr,tw"
//
// shared/ is a copy of the three small files it shares with the map: which house is which, the
// days, and how prices are written (prepare.mjs makes it before a deploy).
import { onSchedule } from 'firebase-functions/scheduler';
import { defineSecret, defineString } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { Blizzard, REGIONS } from './blizzard.js';
import { lookAndPublish } from './cloud.js';

const CLIENT_ID = defineSecret('BLIZZARD_CLIENT_ID');
const CLIENT_SECRET = defineSecret('BLIZZARD_CLIENT_SECRET');
const AUCTION_REGIONS = defineString('AUCTION_REGIONS', { default: 'us', description: 'The regions whose auction houses are read: us, eu, kr, tw, with commas between' });

initializeApp();

export const auctions = onSchedule({
  schedule: '20,45 * * * *',
  timeZone: 'Etc/UTC',
  region: 'us-central1',        // where the database is
  secrets: [CLIENT_ID, CLIENT_SECRET],
  memory: '1GiB',               // a busy house's list is ten megabytes of text, and far more once read
  timeoutSeconds: 540,
  maxInstances: 1,              // never two at once
  retryCount: 0,                // a run that fails is made up for by the next
}, async () => {
  const database = getDatabase();
  // the database as cloud.js speaks to it (here with the project's own rights, which the rules do not bind)
  const db = {
    get: async (path) => (await database.ref(path).get()).val(),
    patch: async (path, changes) => { await database.ref(path).update(changes); return true; },
  };
  const regions = AUCTION_REGIONS.value().split(',').map((r) => r.trim().toLowerCase()).filter((r) => REGIONS.includes(r));
  const api = new Blizzard({ id: CLIENT_ID.value().trim(), secret: CLIENT_SECRET.value().trim() });
  const r = await lookAndPublish(api, db, regions, { log: (line) => console.log(line), reader: 'cloud' });
  console.log(`auctions: ${r.sent.length} houses published, ${r.same.length} had no newer list, ${r.failed.length} failed; ${r.requests} requests to Blizzard (${(r.bytes / 1e6).toFixed(1)} MB), ${(r.written / 1024).toFixed(0)} KB written`);
  // (a run in which nothing at all could be read is a failed run: it shows as one in the logs)
  if (r.failed.length && !r.sent.length && !r.same.length) throw new Error(`no house could be read: ${r.failed.slice(0, 3).map((f) => f.join(' ')).join('; ')}`);
  for (const [house, why] of r.failed) console.warn(`auctions: ${house} failed: ${why}`);
});
