// Before the functions are deployed: the files they share with the map, copied in beside them.
//
// Firebase uploads the functions/ folder and nothing else. A few small files the functions need
// are the map's too: which auction house is which, the days and how long they are kept, how
// prices are written in the database (the auctions function writes what the map reads); and
// how the boats are measured, with the server's clock and the lines' own figures (the boats
// function does with everybody's sightings what the map's own code says). They are copied into
// functions/shared/ here, each as it is, but for the line that says where another of them is.
// The copy is not kept in the repository: the originals are the ones to change.
//
//   node functions/prepare.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const to = path.join(here, 'shared');
// (None of them may lean on the rest of the map tool: a file that did would not be found in the
// cloud. The check below sees to it. `as`: what another of these files is called here, where
// the original names it by its place in the map.)
const FILES = [
  { from: 'auctions/houses.js' }, { from: 'auctions/days.js' }, { from: 'auctions/pack.js' },
  { from: 'viewer/js/clock.js' }, { from: 'atlasdb/boats.js', as: { '../viewer/js/clock.js': './clock.js' } },
];
const names = FILES.map((f) => path.basename(f.from));

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const f of FILES) {
  let text = fs.readFileSync(path.join(root, f.from), 'utf8');
  for (const [was, now] of Object.entries(f.as ?? {})) text = text.split(`'${was}'`).join(`'${now}'`);
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"\n]*from\s+['"]([^'"]+)['"]/gm)) {
    const what = m[1];
    if (what.startsWith('node:')) continue;
    if (!what.startsWith('./') || !names.includes(what.slice(2))) throw new Error(`${f.from} imports "${what}", which the function would not have: add it to FILES in functions/prepare.mjs, or do without it`);
  }
  fs.writeFileSync(path.join(to, path.basename(f.from)), `// A COPY of ${f.from}, made by functions/prepare.mjs: change the original, not this.\n${text}`);
}
// The boat lines, as the map has them (viewer/transit.json), without the tracks: what the boats
// function needs to turn a sighting at any stop into a moment at the first, and the figures it
// measures on from.
const transit = JSON.parse(fs.readFileSync(path.join(root, 'viewer/transit.json'), 'utf8'));
const lines = transit.lines.map((l) => ({
  n: l.n, key: l.key, kind: l.kind, cars: l.cars, period: l.period, periodUnsure: l.periodUnsure, left: l.left, leftUnsure: l.leftUnsure,
  stops: l.stops.map((s) => ({ name: s.name, wait: s.wait })), legs: l.legs.map((g) => ({ trip: g.trip })),
}));
fs.writeFileSync(path.join(to, 'lines.json'), JSON.stringify(lines));
console.log(`functions/shared: ${FILES.length} files copied (${names.join(', ')}), and the ${lines.length} boat lines`);
