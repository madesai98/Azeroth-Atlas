// A thread of its own for working out what the Atlas database adds to the QuestieDB in the game
// (facts.js): QuestieDB is read whole and the database laid over it, which takes half a second,
// and the map server must go on answering the page meanwhile. Started by facts.js, once for
// each time the rows are to be made; it says what it made and ends.
import { parentPort, workerData } from 'node:worker_threads';
import { buildFacts } from './facts.js';

try {
  parentPort.postMessage({ ok: true, built: buildFacts(workerData) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
