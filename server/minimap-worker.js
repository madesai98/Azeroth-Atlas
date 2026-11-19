// A thread of its own for finding the minimap on a dungeon's plan (minimap-find.js): a look
// through a whole plan takes half a second and more, and the map server must go on answering
// the page meanwhile. Started by minimap.js, which hands it the pictures one at a time and
// gets back what each gave - with the picture itself, to keep for a report of a problem.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { Finder } from './minimap-find.js';
import { groundOf } from './minimap-ground.js';

/** The lifts of a map (world.json: lifts): what there is to walk on has them for ways with nothing walked. */
function liftsOn(map) {
  try { return (JSON.parse(fs.readFileSync(path.join(workerData.dataDir, 'world.json'), 'utf8')).lifts ?? []).filter((l) => l.map === map && Number.isFinite(l.x) && Number.isFinite(l.y)); } catch { return []; }
}

const finder = new Finder({
  read: (map) => { const file = path.join(workerData.dataDir, 'maps', String(map), 'minimap.bin'); return fs.existsSync(file) ? fs.readFileSync(file) : null; },
  // (the dungeon's floors, where the map has them: the places found are held against what you can have walked to)
  ground: (map) => (fs.existsSync(path.join(workerData.dataDir, 'maps', String(map), 'nav')) ? groundOf(fs, path, workerData.dataDir, map, liftsOn(map)) : null),
});

parentPort.on('message', (m) => {
  if (m.type === 'reset') { finder.reset(); return; }
  if (m.type !== 'frame') return;
  const f = m.frame;
  let result;
  try { result = finder.frame(f); } catch (err) { result = { ok: false, map: f.map, at: f.at, reason: `the matcher failed: ${err.message}`, failed: true, want: null }; }
  parentPort.postMessage({ type: 'result', id: m.id, result, pic: f.pic }, [f.pic.data.buffer]);
});
