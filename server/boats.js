// Where the boats, zeppelins and tram stand on the server's clock, as the Atlas database has
// measured it from everybody's sightings (atlasdb/boats.js), handed on to the two that go by
// it: the map's page (which asks for it: /api/transit/clock) and the addon in the game.
//
// The addon can be handed nothing while the game runs but what the game itself loads. So the
// figures are written as a small addon of their own beside it, AzerothAtlas_Clock: one file
// that sets them, which the game loads before Azeroth Atlas (which names it as one to load
// first, if it is there). They are taken up the next time the game loads its addons: when it
// starts, or on /reload. (The folder itself is only found when the game starts.) Only ever
// written where Azeroth Atlas is installed, and only that one folder.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../extractor/container.js';
import { addonsDir } from './addon.js';

const NAME = 'AzerothAtlas', CLOCK = 'AzerothAtlas_Clock';

/** The figures as last fetched: { v, at, count, lines: { [key]: { period, periodUnsure, left, leftUnsure, ... } } }, or null. */
export function clockFigures(dataDir) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(dataDir, 'atlasdb', 'transit.json'), 'utf8'));
    return d?.v === 1 && d.lines && typeof d.lines === 'object' ? d : null;
  } catch { return null; }
}

const fine = (v) => String(Math.round(v * 1e5) / 1e5);
const good = (f) => f && [f.period, f.periodUnsure, f.left, f.leftUnsure].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);

/** The small addon's files: { name: text }. */
export function clockAddonFiles(figures, interfaceVersion) {
  const lines = Object.entries(figures?.lines ?? {}).filter(([key, f]) => /^[a-z0-9-]{1,60}$/.test(key) && good(f)).sort(([a], [b]) => a.localeCompare(b));
  return {
    [`${CLOCK}.toc`]: [
      `## Interface: ${interfaceVersion}`,
      '## Title: Azeroth Atlas |cff888888(boat times)|r',
      '## Notes: Where the boats, zeppelins and tram stand on the server\'s clock, as the Atlas database has measured it from everybody\'s sightings. Written by the 3D map; Azeroth Atlas reads it as the game starts. There is nothing to turn on or off here.',
      '## Group: AzerothAtlas',
      '',
      'clock.lua',
      '',
    ].join('\r\n'),
    'clock.lua': [
      '-- Azeroth Atlas: where the boats, zeppelins and tram stand on the server\'s clock, as the Atlas',
      '-- database has measured it from everybody\'s sightings. Written by the 3D map (server/boats.js):',
      '-- do not edit by hand. A line: how long its round is, a moment (server time) at which a craft',
      '-- left its first stop, and how unsure each is (seconds).',
      `AzerothAtlasClock = { v = 1, at = ${Math.round(figures?.at ?? 0)}, lines = {`,
      ...lines.map(([key, f]) => `  ["${key}"] = { period = ${fine(f.period)}, periodUnsure = ${fine(f.periodUnsure)}, left = ${Math.round(f.left * 100) / 100}, leftUnsure = ${Math.round(f.leftUnsure * 100) / 100} },`),
      '} }',
      '',
    ].join('\n'),
  };
}

/**
 * Write the figures for the addon, where they are not there as they stand.
 * @returns { written, fresh (the folder is new: the game finds it when it next starts), lines } - or null where
 *          there is nothing to write, or no Azeroth Atlas in the game to write it for
 */
export function writeClockAddon(cfg, dataDir) {
  const figures = clockFigures(dataDir), dir = addonsDir(cfg);
  if (!figures || !dir || !fs.existsSync(path.join(dir, NAME, `${NAME}.toc`))) return null;
  let iface = '0';
  try { iface = /^## Interface:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, NAME, `${NAME}.toc`), 'utf8'))?.[1].trim() ?? '0'; } catch { /* as it is */ }
  const files = clockAddonFiles(figures, iface);
  const folder = path.join(dir, CLOCK), fresh = !fs.existsSync(folder);
  let written = false;
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(folder, name);
    let same = false;
    try { same = fs.readFileSync(file, 'utf8') === text; } catch { /* not there yet */ }
    if (same) continue;
    fs.mkdirSync(folder, { recursive: true });
    writeFileAtomic(file, text);
    written = true;
  }
  return { written, fresh: fresh && written, lines: Object.keys(figures.lines).length };
}
