// Which Atlas database a copy of the map talks to, and what it does there.
//
// The database this version of the map uses is named in atlasdb/database.json: its address, and
// the "apiKey" a copy signs in with (signin.js). Neither is a secret: the key only says which
// Firebase project is meant, and what a copy may do there is settled by the database's own rules
// (rules.json), not by knowing the key.
//
// In config.json:
//
//   "database": {
//     "url": "https://...",    another database than the one this version names
//     "apiKey": "...",         and the key to sign in to it with (none: it is open to all)
//     "share": false,          send nothing of what this copy learns (it still fetches the database)
//     "maintain": true         this copy also makes the database: it merges everything sent with
//                              the sources on its own disk and publishes the result. The database
//                              lets only the copies it lists as maintainers do that.
//   }
//
// "database": false switches the whole thing off.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../extractor/config.js';

/** @returns {{ url: string|null, apiKey: string|null, share: boolean, maintain: boolean }} */
export function databaseSettings(cfg) {
  const own = cfg?.database;
  if (own === false) return { url: null, apiKey: null, share: false, maintain: false };
  let named = {};
  try { named = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'atlasdb', 'database.json'), 'utf8')) ?? {}; } catch { /* this version names none */ }
  const clean = (u) => (typeof u === 'string' ? u.replace(/\/+$/, '') : '');
  let url = typeof own?.url === 'string' && own.url ? own.url : named.url ?? null;
  if (typeof url !== 'string' || !/^https:\/\/[\w.-]+\//.test(url + '/')) url = null;
  // (the key goes with the database it belongs to: a database of your own is signed in to with a key of its own, or not at all)
  let apiKey = typeof own?.apiKey === 'string' && own.apiKey ? own.apiKey : null;
  if (!apiKey && url && clean(url) === clean(named.url) && typeof named.apiKey === 'string' && named.apiKey) apiKey = named.apiKey;
  return { url, apiKey: url ? apiKey : null, share: own?.share !== false, maintain: own?.maintain === true };
}
