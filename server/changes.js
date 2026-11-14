// Tells the map page when the page's own files have changed on disk (an update of the map),
// so that it can load itself again (viewer/js/reload.js). The page knows which files it was
// built from by a stamp written into the page as it is served; the stamp is a digest of the
// name, size and date of every file of the viewer.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SETTLE_MS = 400;   // an update writes several files: wait until it has gone quiet
const CHECK_MS = 2000;   // how often to look, where the folder cannot be watched

export class Changes {
  constructor(dir) {
    this.dir = dir;
    this.clients = new Set();
    this.stamp = this.#read();
    this.started = Date.now(); // tells one run of the server from the next (the page sends its route again to a new one)
    this.timer = 0;
    const look = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const now = this.#read();
        if (now === this.stamp) return;
        this.stamp = now;
        for (const res of this.clients) res.write(`data: ${this.#state()}\n\n`);
      }, SETTLE_MS);
    };
    try { fs.watch(dir, { recursive: true }, look); } catch { setInterval(look, CHECK_MS).unref(); }
  }

  #read() {
    const hash = crypto.createHash('sha1');
    const walk = (dir, rel) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = path.join(dir, e.name), name = rel + e.name;
        if (e.isDirectory()) { walk(full, name + '/'); continue; }
        try { const st = fs.statSync(full); hash.update(`${name}|${st.size}|${Math.floor(st.mtimeMs)}\n`); } catch { /* gone again */ }
      }
    };
    walk(this.dir, '');
    return hash.digest('hex').slice(0, 16);
  }

  #state() { return JSON.stringify({ viewer: this.stamp, started: this.started }); }

  /** The page, with the stamp of the files it is made of written into it. */
  page(html) {
    return html.replace('</head>', `<meta name="wfmap-stamp" content="${this.stamp}">\n</head>`);
  }

  /** A page listening for changes (server-sent events). */
  subscribe(req, res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 1500\n\ndata: ${this.#state()}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); this.clients.delete(res); });
  }
}
