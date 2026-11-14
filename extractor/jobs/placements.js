// Map-wide list of building (WMO) placements, de-duplicated across tiles, so large structures
// can be drawn from far away without loading every full-detail tile around them.
import fs from 'node:fs';
import { packContainer, unpackContainer, writeFileAtomic } from '../container.js';
import { SEC } from './tile.js';

export const PLACEMENTS_VERSION = 1;
const WMO_SIZE = 68, DOODAD_SIZE = 40;

/** @param job { tiles:[{file}], out } */
export function buildPlacements(job) {
  const seen = new Map();
  for (const t of job.tiles) {
    const { sections } = unpackContainer(fs.readFileSync(t.file), 'WFT1');
    const s = sections.get(SEC.OBJECTS);
    if (!s || s.length < 8) continue;
    const nDoodads = s.readUInt32LE(0), nWmos = s.readUInt32LE(4);
    const base = 8 + nDoodads * DOODAD_SIZE;
    for (let i = 0; i < nWmos; i++) {
      const p = base + i * WMO_SIZE;
      const uniqueId = s.readUInt32LE(p + 4);
      if (!seen.has(uniqueId)) seen.set(uniqueId, s.subarray(p, p + WMO_SIZE));
    }
  }
  const out = Buffer.concat([...seen.values()]);
  writeFileAtomic(job.out, packContainer('WFW1', PLACEMENTS_VERSION, [{ id: 1, data: out }]));
  return { count: seen.size };
}
