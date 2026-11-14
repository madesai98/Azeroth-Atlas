// Fixed-size worker thread pool with a simple FIFO queue.
import { Worker } from 'node:worker_threads';

export class Pool {
  constructor(size, workerData) {
    this.queue = [];
    this.pending = new Map();
    this.nextId = 1;
    this.workers = [];
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { workerData });
      w.busy = false;
      w.on('message', (msg) => {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        w.busy = false;
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error), { code: msg.code }));
        this.#pump();
      });
      w.on('error', (err) => {
        // A crashed worker fails everything it owned; the run reports the error.
        for (const [id, p] of this.pending) if (p.worker === w) { this.pending.delete(id); p.reject(err); }
      });
      this.workers.push(w);
    }
  }

  #pump() {
    for (const w of this.workers) {
      if (w.busy) continue;
      const item = this.queue.shift();
      if (!item) return;
      w.busy = true;
      item.worker = w;
      this.pending.set(item.id, item);
      w.postMessage({ id: item.id, type: item.type, job: item.job });
    }
  }

  run(type, job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, type, job, resolve, reject });
      this.#pump();
    });
  }

  async close() {
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
