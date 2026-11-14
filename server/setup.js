// The map tool on a computer where it does not know where the game is: the game was not found
// in any of the usual places (extractor/config.js: findInstalls) and config.json does not say.
// The page is served all the same, and asks; the answer is checked and written to config.json,
// and the server starts again as itself.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PROJECT_ROOT, checkInstall, readConfigFile } from '../extractor/config.js';
import { Changes } from './changes.js';
import { sendFile, safeJoin, localOnly, ownPage, json, readJson, MIME } from './http.js';

/**
 * @param problem  the error loadConfig gave up with (code 'NO_GAME': configured, product, port)
 * @param file     the config.json to write
 * @param app      the map tool's own updater (server/appupdate.js)
 * Never returns: the process is started again once the answer is in config.json.
 */
export function runSetup(problem, file, app) {
  const VIEWER_DIR = path.join(PROJECT_ROOT, 'viewer');
  const changes = new Changes(VIEWER_DIR);
  const product = problem.product ?? 'wowf', port = problem.port ?? 5173;
  const idle = { running: false, phase: '', done: 0, total: 0, log: [], summary: null, error: null, startedAt: null, finishedAt: null };
  const status = () => ({
    setup: { message: problem.message, configured: problem.configured ?? null, dataDir: path.join(PROJECT_ROOT, 'data') },
    installed: null, installError: problem.message, extracted: null, updateAvailable: false, updateReason: null, job: idle, app: app?.status() ?? null,
  });

  /** The answer, checked: the settings to write, or a sentence saying what is wrong with it. */
  function answer(d) {
    let root = typeof d.installRoot === 'string' ? d.installRoot.trim().replace(/^"|"$/g, '') : '';
    if (!root) return 'Type the folder the game is installed in.';
    if (!path.isAbsolute(root)) return 'Give the whole path of the folder, from the drive letter on.';
    root = path.resolve(root);
    // (the flavour's own folder, or the game's program inside it, is as good an answer: the folder above is meant)
    let what = 'none';
    for (let at = root, i = 0; i < 3; i++) {
      what = checkInstall(at, product);
      if (what !== 'none') { root = at; break; }
      const up = path.dirname(at);
      if (up === at) break;
      at = up;
    }
    if (what === 'none') return 'There is no game in that folder: it is the one with a file named .build.info in it, usually called "World of Warcraft".';
    if (what === 'other') return 'World of Warcraft is installed there, but not WoW Forever: install it from Battle.net first.';
    const out = { installRoot: root.replace(/\\/g, '/') };
    const data = typeof d.dataDir === 'string' ? d.dataDir.trim().replace(/^"|"$/g, '') : '';
    if (data) {
      if (!path.isAbsolute(data)) return 'Give the whole path of the folder for the map data, from the drive letter on (or leave it empty).';
      const full = path.resolve(data);
      if ((full + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase())) return 'The map data must not be kept inside the game folder: name another.';
      try { fs.mkdirSync(full, { recursive: true }); } catch (err) { return `That folder for the map data cannot be made (${err.message}).`; }
      out.dataDir = full.replace(/\\/g, '/');
    }
    return out;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    if (!localOnly(req)) { res.writeHead(403); res.end(); return; }
    if (p === '/api/status') { json(res, 200, status()); return; }
    if (p === '/api/changes') { changes.subscribe(req, res); return; }
    if (p === '/api/app/check') {
      if (req.method !== 'POST' || !ownPage(req)) { res.writeHead(req.method === 'POST' ? 403 : 405); res.end(); return; }
      app?.check({ apply: url.searchParams.get('apply') === '1' ? true : undefined });
      json(res, 202, app?.status() ?? null);
      return;
    }
    if (p === '/api/setup') {
      if (req.method !== 'POST' || !ownPage(req)) { res.writeHead(req.method === 'POST' ? 403 : 405); res.end(); return; }
      readJson(req).then((d) => {
        const a = answer(d);
        if (typeof a === 'string') { json(res, 200, { ok: false, error: a }); return; }
        let had = {};
        try { had = readConfigFile(file); } catch { /* one that could not be read is written anew */ }
        fs.writeFileSync(file, JSON.stringify({ ...had, ...a, product: had.product ?? product }, null, 2) + '\n');
        json(res, 200, { ok: true, ...a });
        // (server/watch.js starts the server again when config.json changes; run on its own, there is nobody to)
        if (!process.send) setTimeout(() => { console.log('Saved. Start the map again.'); process.exit(0); }, 300);
      }, (err) => json(res, 400, { ok: false, error: err.message }));
      return;
    }
    if (p.startsWith('/api/') || p.startsWith('/data/')) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('the map is not set up yet'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const full = safeJoin(VIEWER_DIR, p === '/' ? 'index.html' : p);
    if (!full) { res.writeHead(400); res.end(); return; }
    if (full === path.join(VIEWER_DIR, 'index.html')) {
      fs.readFile(full, 'utf8', (err, html) => {
        if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : changes.page(html));
      });
      return;
    }
    sendFile(req, res, full, false);
  });

  if (process.send) {
    const leave = () => process.exit(0);
    process.on('message', (m) => { if (m?.stop) leave(); });
    process.on('disconnect', leave);
  }
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log(`Azeroth Atlas: ${url}`);
    console.log(`  ${problem.message}.`);
    console.log('  The map page asks where it is: answer there (or set "installRoot" in config.json).');
    if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  });
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use (is the map already running?)` : err.message);
    process.exit(err.code === 'EADDRINUSE' ? 3 : 1);
  });
  return new Promise(() => {}); // (until it is started again)
}
