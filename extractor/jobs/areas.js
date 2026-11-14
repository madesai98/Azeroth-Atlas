// Per-map area grid: the game's area id for every terrain chunk (16x16 per tile). Lets the
// viewer name the exact sub-zone under any point without loading the full-detail tile, and gives
// a route planner zone membership for free.
import fs from 'node:fs';
import { packContainer, unpackContainer, writeFileAtomic } from '../container.js';
import { SEC } from './tile.js';

export const AREAS_VERSION = 1;

/** @param job { tiles:[{col,row,file}], out } */
export function buildAreas(job) {
  let minCol = 64, maxCol = -1, minRow = 64, maxRow = -1;
  for (const t of job.tiles) {
    minCol = Math.min(minCol, t.col); maxCol = Math.max(maxCol, t.col);
    minRow = Math.min(minRow, t.row); maxRow = Math.max(maxRow, t.row);
  }
  const cols = maxCol - minCol + 1, rows = maxRow - minRow + 1;
  const w = cols * 16;
  const grid = new Uint32Array(w * rows * 16);
  for (const t of job.tiles) {
    const { sections } = unpackContainer(fs.readFileSync(t.file), 'WFT1');
    const ch = sections.get(SEC.CHUNKS);
    const ox = (t.col - minCol) * 16, oy = (t.row - minRow) * 16;
    for (let cy = 0; cy < 16; cy++) for (let cx = 0; cx < 16; cx++) grid[(oy + cy) * w + ox + cx] = ch.readUInt32LE((cy * 16 + cx) * 8 + 4);
  }
  const header = new Int32Array([minCol, minRow, cols, rows]);
  writeFileAtomic(job.out, packContainer('WFA1', AREAS_VERSION, [{ id: 1, data: header }, { id: 2, data: grid }]));
  return { minCol, minRow, cols, rows };
}
