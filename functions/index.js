// Azeroth Atlas in the cloud: two scheduled functions of the Atlas database's own Firebase
// project. Each fetches something that is published elsewhere and puts it into the database,
// with nobody's computer on, so that a copy of the map has only the database to ask:
//
//   auctions   the auction houses, looked at twice an hour (below, and cloud.js)
//   questie    QuestieDB - who stands where, the quests - looked for once an hour and taken in
//              whenever a new version of it is out (the end of this file, and questie.js)
//
// The auction houses. Twice an hour the function asks Blizzard's API for every auction house
// whose list is newer than the one in the database, boils each down to a line per item
// (summary.js), and writes it to /market (cloud.js). This is the only place the auction houses
// are read: a copy of the map takes its prices from the database and never goes to Blizzard.
// The function keeps nothing of its own: what it must know from one hour to the next is in the
// database.
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
import { lookAndImport } from './questie.js';

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

// QuestieDB. Once an hour the function asks where QuestieDB is published (GitHub) which version
// is the latest: one small question. Only when that is another than the database holds does it
// fetch the release (16 MB) and write the files the map reads into /questie (questie.js). It
// needs no key and no secret: QuestieDB's releases are public.
export const questie = onSchedule({
  schedule: '35 * * * *',       // (between the two looks at the auction houses)
  timeZone: 'Etc/UTC',
  region: 'us-central1',
  memory: '512MiB',             // the release unpacked is 36 MB, of which half is taken
  timeoutSeconds: 300,
  maxInstances: 1,
  retryCount: 0,                // a run that fails is made up for by the next
}, async () => {
  const database = getDatabase();
  const db = {
    get: async (path) => (await database.ref(path).get()).val(),
    set: async (path, value) => { await database.ref(path).set(value); },
    remove: async (path) => { await database.ref(path).remove(); },
  };
  const r = await lookAndImport(db, { log: (line) => console.log(line) });
  console.log(r.same ? `questie: QuestieDB ${r.version} (${r.tag}) is the latest, and the database has it` : `questie: QuestieDB ${r.version} (${r.tag}) taken in: ${r.imported} files written (${(r.written / 1e6).toFixed(1)} MB), ${r.kept} as they were`);
});
