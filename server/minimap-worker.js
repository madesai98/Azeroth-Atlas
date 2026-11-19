// A thread of its own for finding the minimap on a dungeon's plan (minimap-find.js): a look
// through a whole plan takes half a second and more, and the map server must go on answering
// the page meanwhile. Started by minimap.js, which hands it the pictures one at a time and
// gets back what each gave - with the picture itself, to keep for a report of a problem.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { Finder } from './minimap-find.js';

const finder = new Finder({
  read: (map) => { const file = path.join(workerData.dataDir, 'maps', String(map), 'minimap.bin'); return fs.existsSync(file) ? fs.readFileSync(file) : null; },
});

parentPort.on('message', (m) => {
  if (m.type === 'reset') { finder.reset(); return; }
  if (m.type !== 'frame') return;
  const f = m.frame;
  let result;
  try { result = finder.frame(f); } catch (err) { result = { ok: false, map: f.map, at: f.at, reason: `the matcher failed: ${err.message}`, failed: true, want: null }; }
  parentPort.postMessage({ type: 'result', id: m.id, result, pic: f.pic }, [f.pic.data.buffer]);
});
