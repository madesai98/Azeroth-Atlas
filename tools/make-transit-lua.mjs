// Writes the addon's copy of the boat, zeppelin and tram timetables
// (addon/AzerothAtlas/TransitData.lua) from the project's own (viewer/transit.json), so
// that the game and the map count from the same figures. Run it after changing transit.json:
//   node tools/make-transit-lua.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'viewer/transit.json'), 'utf8'));
const str = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const num = (v) => String(Math.round(v * 1000) / 1000);
const track = (t) => '{ ' + t.map((p) => '{ ' + p.map(num).join(', ') + ' }').join(', ') + ' }';

const out = [
  '-- Azeroth Atlas: the timetables of the boats, zeppelins and tram.',
  '-- Written by tools/make-transit-lua.mjs from viewer/transit.json: do not edit by hand.',
  '--',
  ...data.credit.map((c) => '-- ' + c),
  '--',
  '-- A line: n (its number between the addon and the map), id (the game\'s own number for its',
  '-- path; none for the tram), period (seconds for one craft\'s whole round), periodUnsure (seconds',
  '-- that round may be off, given for a line whose round is less well measured than the others;',
  '-- for the rest the addon has a figure of its own), stops (in the order the craft calls at them:',
  '-- name, map, x and y as the game counts them, wait in seconds), legs',
  '-- (leg i runs from stop i to the stop after it: trip in seconds, and track, where the craft is',
  '-- so many seconds after leaving: { seconds, map, x, y }; track2 is the tram\'s other track),',
  '-- ft and ftStops (ForeverTransport\'s and Nauticus\' number for the line, and which of our',
  '-- stops each of their docks is), cars and lanes (the tram: two cars, each on a track of its own).',
  'local shared = AzerothAtlas',
  'if type(shared) ~= "table" then return end',
  '',
  'shared.TransitData = {',
];
for (const l of data.lines) {
  out.push(`  { n = ${l.n}, ${l.id ? `id = ${l.id}, ` : ''}key = ${str(l.key)}, kind = ${str(l.kind)}, period = ${num(l.period)},${l.periodUnsure ? ` periodUnsure = ${num(l.periodUnsure)},` : ''}${l.rough ? ' rough = true,' : ''}${l.cars ? ` cars = ${l.cars},` : ''}`);
  out.push(`    ft = ${l.ft.id},${l.ft.id2 ? ` ft2 = ${l.ft.id2},` : ''} ftStops = { ${l.ft.stops.map((s) => s + 1).join(', ')} },`);
  if (l.lanes) out.push(`    lanes = { ${l.lanes.map((a) => `{ name = ${str(a.name)}, x = ${num(a.x)} }`).join(', ')} },`);
  out.push('    stops = {');
  for (const s of l.stops) out.push(`      { name = ${str(s.name)}, map = ${s.map}, x = ${num(s.x)}, y = ${num(s.y)}, wait = ${num(s.wait)} },`);
  out.push('    },', '    legs = {');
  for (const g of l.legs) out.push(`      { trip = ${num(g.trip)}, track = ${track(g.track)}${g.track2 ? `,\n        track2 = ${track(g.track2)}` : ''} },`);
  out.push('    },', '  },');
}
out.push('}', '');
const file = path.join(root, 'addon/AzerothAtlas/TransitData.lua');
fs.writeFileSync(file, out.join('\n'));
console.log(`wrote ${path.relative(root, file)}: ${data.lines.length} lines, ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
