// Client database tables used by the extractor, addressed by their (stable) FileDataIDs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTable } from './formats/db2.js';

const DBD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dbd');
const DBD_URL = 'https://raw.githubusercontent.com/wowdev/WoWDBDefs/master/definitions/';

export const TABLE_FDID = {
  Map: 1349477,
  AreaTable: 1353545,
  UiMap: 1957206,
  UiMapAssignment: 1957219,
  AreaPOI: 1000630,
  LiquidType: 1371380,
  LiquidObject: 1308058,
  LiquidMaterial: 1132538,
  TaxiNodes: 1068100,
  TaxiPath: 1067802,
  TaxiPathNode: 1000437,
  AreaTrigger: 1354401,
  WorldSafeLocs: 1369425,
  WMOAreaTable: 1355528,
  FactionTemplate: 1361579,
  Light: 1375579,
  LightParams: 1334669,
  LightData: 1375580,
};

async function refreshDefinition(name) {
  // Column definitions are public community data (WoWDBDefs). They are not handed on with the map
  // tool: each is fetched the first time it is needed and kept in extractor/dbd/. A new game patch
  // can add a table layout that the kept copy does not know yet, and then the current one is fetched.
  const res = await fetch(DBD_URL + name + '.dbd');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith('COLUMNS')) throw new Error('unexpected response');
  fs.mkdirSync(DBD_DIR, { recursive: true });
  fs.writeFileSync(path.join(DBD_DIR, name + '.dbd'), text);
  return text;
}

/**
 * Load a table as plain row objects. Returns { rows, hash } or null when the table is
 * unavailable (not downloaded / fully encrypted / no matching definition).
 */
export async function loadTable(casc, name, log = () => {}) {
  const fdid = TABLE_FDID[name];
  let buf;
  try {
    buf = casc.readFile(fdid, { skipEncrypted: true });
  } catch (err) {
    log(`table ${name}: unreadable (${err.message})`);
    return null;
  }
  if (!buf) { log(`table ${name}: not present in local game data`); return null; }
  const file = path.join(DBD_DIR, name + '.dbd');
  let dbd = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!dbd) throw Object.assign(new Error('no definition yet'), { code: 'ELAYOUT', first: true });
      const t = readTable(buf, dbd, { build: casc.build.version });
      return { rows: t.rows, hash: casc.contentHash(fdid), skippedEncryptedSections: t.skippedEncryptedSections };
    } catch (err) {
      if (err.code !== 'ELAYOUT' || attempt === 1) { log(`table ${name}: ${err.message}`); return null; }
      try {
        log(err.first ? `table ${name}: fetching its column definitions (first use)` : `table ${name}: layout changed, fetching updated column definitions`);
        dbd = await refreshDefinition(name);
      } catch (e2) {
        log(`table ${name}: could not refresh definition (${e2.message})`);
        return null;
      }
    }
  }
  return null;
}
