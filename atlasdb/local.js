// What a copy of the map keeps on its own disk about the Atlas database, in <dataDir>/atlasdb:
//
//   install.json   who this copy is to the database: a made-up name ("id") that what it sends is
//                  filed under, and the key ("refresh") it comes back as the same one with
//                  (signin.js). It says nothing about who you are (no account of yours, no
//                  character, no computer name), and a new one is made if the file is deleted.
//   sent.json      a fingerprint of every fact already sent, so nothing is sent twice
//   loot-own.json  what the games on this computer have counted in the corpses looted, by the
//                  made-up number each game's saved settings go by (loot.js): kept for good, so
//                  that settings written anew add to the count and do not begin it again
//   loot-sent.json that count as it was last sent, creature by creature
//   truth-*.json   the database as last fetched, one file per kind, and truth-meta.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic } from '../extractor/container.js';

export class LocalStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'atlasdb');
  }

  read(name, fallback = null) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return fallback; }
  }

  write(name, value) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(path.join(this.dir, name), JSON.stringify(value));
  }

  /** This copy's made-up name, for a database that is open to all (one that is signed in to gives the name itself: signin.js). */
  install() {
    let me = this.read('install.json');
    if (!me || typeof me.id !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(me.id)) {
      me = { id: crypto.randomBytes(12).toString('base64url') };
      this.write('install.json', me);
    }
    return me.id;
  }
}
