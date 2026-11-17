// Writes the addon's list of the places it measures your height by
// (addon/AzerothAtlas/HeightRefs.lua): every flight master and every landmark the game's own
// data has, with where each is - from the map data's world.json (extracted from the game by
// Update map). Run it after a game patch that moves or adds any:
//   node tools/make-height-refs.mjs [dataDir]        (dataDir: as in config.json, the default)
//
// Why the addon wants them: the game does not tell addons how high you are, but the distance it
// shows to a flight master or a landmark its marker is pointed at counts height. See "How your
// height is known" in the README, and Height.lua.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let dataDir = process.argv[2];
if (!dataDir) {
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  dataDir = path.resolve(root, cfg.dataDir);
}
const world = JSON.parse(fs.readFileSync(path.join(dataDir, 'world.json'), 'utf8'));
const num = (v) => String(Math.round(v * 1000) / 1000);
const byMap = new Map();
const take = (kind, list) => {
  for (const r of list ?? []) {
    if (!Number.isInteger(r.id) || r.id <= 0 || r.id > 32767 || !Array.isArray(r.pos) || !r.pos.every(Number.isFinite)) continue;
    const map = r.map ?? 0;
    if (!byMap.has(map)) byMap.set(map, []);
    byMap.get(map).push([kind, r.id, r.pos[0], r.pos[1], r.pos[2]]);
  }
};
take(1, world.taxiNodes);
take(2, world.pois);

const out = [
  '-- Azeroth Atlas: the places your height is measured by.',
  '-- Written by tools/make-height-refs.mjs from the map data (world.json): do not edit by hand.',
  '--',
  '-- Every flight master (kind 1) and landmark (kind 2) of the game\'s own data, by the map it is',
  '-- on: five numbers each - kind, the game\'s number for it, north, west, height (yards, as the',
  '-- game counts them). What they are for: Height.lua.',
  'local shared = AzerothAtlas',
  'if type(shared) ~= "table" then return end',
  '',
  'shared.HeightRefs = {',
];
let count = 0;
for (const map of [...byMap.keys()].sort((a, b) => a - b)) {
  const list = byMap.get(map).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  count += list.length;
  out.push(`  [${map}] = {`);
  for (let i = 0; i < list.length; i += 4) out.push('    ' + list.slice(i, i + 4).map((r) => `${r[0]}, ${r[1]}, ${num(r[2])}, ${num(r[3])}, ${num(r[4])},`).join('  '));
  out.push('  },');
}
out.push('}', '');
fs.writeFileSync(path.join(root, 'addon/AzerothAtlas/HeightRefs.lua'), out.join('\n'));
console.log(`addon/AzerothAtlas/HeightRefs.lua: ${count} places on ${byMap.size} maps`);
