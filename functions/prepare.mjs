// Before the function is deployed: the files it shares with the map, copied in beside it.
//
// Firebase uploads the functions/ folder and nothing else. Three small files the function needs
// are the map's too (which house is which, the days and how long they are kept, how prices are
// written in the database: the function writes what the map reads). They are copied into
// functions/shared/ here, each as it is. The copy is not kept in the repository: the originals
// in auctions/ are the ones to change.
//
//   node functions/prepare.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, '..', 'auctions');
const to = path.join(here, 'shared');
// (None of them may lean on the rest of the map tool: a file that did would not be found in the
// cloud. The check below sees to it.)
const FILES = ['houses.js', 'days.js', 'pack.js'];

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const f of FILES) {
  const text = fs.readFileSync(path.join(from, f), 'utf8');
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"\n]*from\s+['"]([^'"]+)['"]/gm)) {
    const what = m[1];
    if (what.startsWith('node:')) continue;
    if (!what.startsWith('./') || !FILES.includes(what.slice(2))) throw new Error(`auctions/${f} imports "${what}", which the function would not have: add it to FILES in functions/prepare.mjs, or do without it`);
  }
  fs.writeFileSync(path.join(to, f), `// A COPY of auctions/${f}, made by functions/prepare.mjs: change the original, not this.\n${text}`);
}
console.log(`functions/shared: ${FILES.length} files copied from auctions/`);
