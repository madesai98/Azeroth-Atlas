// Worker thread: attaches to the shared archive tables and runs extraction jobs.
import { parentPort, workerData } from 'node:worker_threads';
import { Casc } from './casc/casc.js';
import { buildTile } from './jobs/tile.js';
import { buildPage } from './jobs/page.js';
import { buildAreas } from './jobs/areas.js';
import { buildPlacements } from './jobs/placements.js';
import { buildWmo, buildM2, shapeM2, copyTextures } from './jobs/model.js';
import { buildNav } from './jobs/nav.js';
import { buildNavCoarse } from './jobs/navcoarse.js';
import { buildMinimapRef } from './jobs/minimap.js';

const casc = Casc.fromShared(workerData.shared);
const handlers = {
  tile: (job) => buildTile(casc, job),
  page: (job) => buildPage(job),
  areas: (job) => buildAreas(job),
  placements: (job) => buildPlacements(job),
  wmo: (job) => buildWmo(casc, job),
  m2: (job) => buildM2(casc, job),
  m2shape: (job) => shapeM2(casc, job),
  textures: (job) => copyTextures(casc, job),
  nav: (job) => buildNav(job),
  navcoarse: (job) => buildNavCoarse(job),
  minimap: (job) => buildMinimapRef(casc, job),
};

parentPort.on('message', async (msg) => {
  if (msg.type === 'close') { casc.close(); process.exit(0); }
  try {
    const handler = handlers[msg.type];
    if (!handler) throw new Error(`unknown job type ${msg.type}`);
    const result = await handler(msg.job);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: err.message, code: err.code });
  }
});
