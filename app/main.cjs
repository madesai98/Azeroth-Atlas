// Azeroth Atlas as an application: one window with the map in it, and the map's server run
// behind it with nothing else on show (no terminal, no browser tab).
//
// The map itself is the same page the server has always served (viewer/), and the server the
// same server (server/watch.js, which keeps server/server.js running and starts it again when
// its code is updated). This file is only the frame round them:
//
//   - it runs the server with the Node that is built into the application (nobody has to
//     install Node), unless a map server is already answering on the port: then the window
//     simply shows that one;
//   - it shows the page in a window of its own, remembers where the window was, and opens
//     links that lead elsewhere in your browser;
//   - closed, it takes the server with it.
//
// As an installed application (packaged), what is yours is kept outside the application's own
// folder, in %LOCALAPPDATA%\Azeroth Atlas: config.json, the map data (unless config.json names
// another place), the log. So a new copy of the application can be put in place of an old one
// and nothing is lost. Run from the source (npm run app), everything is where it always was.
//
// The application's own files are plain files (resources/app), and the map tool keeps them up
// to date by itself as ever (server/appupdate.js). When this file is among the ones updated,
// the application starts itself again.
const { app, BrowserWindow, Menu, shell, screen } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'Azeroth Atlas';
const AGAIN = 75;      // the watcher asking to be started again (its own code has been updated)
const PORT_TAKEN = 3;  // the server saying another one has the port
const args = process.argv.slice(1);
const configArg = args.find((a) => a.startsWith('--config='));

app.setName(NAME);
app.setAppUserModelId('AzerothAtlas');
// The map goes on working with its window out of sight - behind the game, on the one screen
// there is, or minimized: the routes are worked out and sent to the game all the same. The
// page sees to that itself (viewer/js/main.js: step); here it is only made sure that a page
// nobody is looking at is not put on short rations for it. (It draws next to nothing then: a
// picture a second.)
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Where what is yours is kept (see the top of this file).
const HOME = process.env.AZEROTH_ATLAS_HOME ? path.resolve(process.env.AZEROTH_ATLAS_HOME)
  : app.isPackaged ? path.join(process.env.LOCALAPPDATA || app.getPath('appData'), NAME) : null;
if (HOME) {
  process.env.AZEROTH_ATLAS_HOME = HOME;
  fs.mkdirSync(HOME, { recursive: true });
  app.setPath('userData', path.join(HOME, 'window')); // (what the page remembers: your switches, where you were looking)
}
const LOG = HOME ? path.join(HOME, 'server.log') : path.join(ROOT, 'server', '.build', 'app.log');
const STATE = path.join(app.getPath('userData'), 'window.json');

function port() {
  const file = configArg ? path.resolve(configArg.slice(9)) : path.join(HOME ?? ROOT, 'config.json');
  try { const p = JSON.parse(fs.readFileSync(file, 'utf8')).port; if (Number.isInteger(p) && p > 0) return p; } catch { /* no settings yet: the usual port */ }
  return 5173;
}
const PORT = port();
const URL_ = `http://localhost:${PORT}/`;

// ---- the server -------------------------------------------------------------------------------
let child = null;      // the watcher, where this application runs the server itself
let busy = false;      // the server is in the middle of something that must not be cut short (a map build, an update of itself)
let renew = false;     // this file has been updated: the application is to start again
let quitting = false;
let said = [];         // the last things the server said, for the window while it is not up
let log = null;

function note(text) {
  for (const line of String(text).split(/\r?\n/)) { if (!line.trim()) continue; said.push(line); if (said.length > 14) said.shift(); }
  try {
    if (!log) { fs.mkdirSync(path.dirname(LOG), { recursive: true }); if (fs.existsSync(LOG) && fs.statSync(LOG).size > 1e6) fs.rmSync(LOG); log = fs.createWriteStream(LOG, { flags: 'a' }); }
    log.write(text);
  } catch { /* nowhere to write it: it is still in the window */ }
}

/** Is a map server answering? Resolves to true or false. */
function answering() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', headers: { host: `localhost:${PORT}` }, timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => { try { resolve(typeof JSON.parse(body).job === 'object'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function startServer() {
  if (child || quitting) return;
  note(`\n[${new Date().toLocaleString()}] starting the map server\n`);
  const mine = fork(path.join(ROOT, 'server', 'watch.js'), configArg ? [configArg] : [], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
    // (the application's own program, run as plain Node - and so is everything the server starts in turn)
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AZEROTH_ATLAS_APP: '1' },
  });
  child = mine;
  mine.stdout.on('data', (c) => note(c.toString()));
  mine.stderr.on('data', (c) => note(c.toString()));
  mine.on('message', (m) => { if (typeof m?.busy === 'boolean') { busy = m.busy; if (!busy && renew) again(); } });
  mine.on('exit', (code) => {
    if (child !== mine) return;
    child = null;
    busy = false;
    if (quitting) return;
    if (code === AGAIN) { startServer(); return; }
    if (code === PORT_TAKEN) note(`Port ${PORT} is in use by another program.\n`);
    else if (code) note('The map server stopped on an error (above).\n');
    // (tried again, a little later each time: see watch())
    failed++;
    notBefore = Date.now() + Math.min(30000, 1500 * failed);
  });
}
let failed = 0, notBefore = 0; // how often the server has gone of itself, and when it is next worth starting

function stopServer() {
  const mine = child;
  child = null;
  if (!mine) return Promise.resolve();
  return new Promise((resolve) => {
    const done = setTimeout(() => { try { mine.kill(); } catch { /* gone */ } resolve(); }, 3000);
    mine.once('exit', () => { clearTimeout(done); resolve(); });
    try { mine.send({ quit: true }); } catch { try { mine.kill(); } catch { /* gone */ } }
  });
}

// ---- the window -------------------------------------------------------------------------------
let win = null;
let showing = 'loading'; // which page the window has: 'loading' or 'map'

function bounds() {
  let b = { width: 1500, height: 950 };
  try { b = { ...b, ...JSON.parse(fs.readFileSync(STATE, 'utf8')) }; } catch { /* first time */ }
  // (only where there still is a screen: a monitor may have gone since)
  const on = Number.isFinite(b.x) && Number.isFinite(b.y) && screen.getAllDisplays().some((d) => b.x < d.workArea.x + d.workArea.width - 80 && b.x + b.width > d.workArea.x + 80 && b.y >= d.workArea.y - 10 && b.y < d.workArea.y + d.workArea.height - 80);
  if (!on) { delete b.x; delete b.y; }
  return b;
}

function remember() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.isMaximized() || win.isFullScreen() ? win.getNormalBounds() : win.getBounds();
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch { /* not remembered */ }
}

function open() {
  const b = bounds();
  win = new BrowserWindow({
    ...b, minWidth: 720, minHeight: 480, title: NAME, backgroundColor: '#0b0e14', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (b.maximized) win.maximize();
  // (AZEROTH_ATLAS_HIDDEN: for the tests, which run it while the game is being played on the same
  // screen - never shown at all, or, set to "minimized", minimized from the start: the state in
  // which the map has to go on working, and one of the tests looks at exactly that)
  win.once('ready-to-show', () => { if (!process.env.AZEROTH_ATLAS_HIDDEN) win.show(); else if (process.env.AZEROTH_ATLAS_HIDDEN === 'minimized') win.minimize(); });
  // (where it is, noted whenever it changes and not only as it closes: a window can go without being asked)
  let noting = 0;
  const soon = () => { clearTimeout(noting); noting = setTimeout(remember, 500); };
  win.once('ready-to-show', soon);
  win.on('resize', soon);
  win.on('move', soon);
  win.on('close', () => { clearTimeout(noting); remember(); });
  win.on('closed', () => { win = null; });
  win.on('page-title-updated', (e) => e.preventDefault()); // (the window is called what the application is)
  // A link that leads somewhere else opens in your browser; the window itself stays on the map.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(URL_) && !url.startsWith('file:')) { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); } });
  win.webContents.on('did-fail-load', (e, code, text, url, main) => { if (main && showing === 'map') loading(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) { e.preventDefault(); if (showing === 'map') win.webContents.reload(); }
    else if (input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) { e.preventDefault(); win.webContents.toggleDevTools(); }
  });
  loading();
}

function loading() {
  showing = 'loading';
  if (win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'loading.html'));
}

/** Kept an eye on: the window shows the map as soon as the server answers, and the server is (re)started where nobody else's is there. */
let waited = 0, everUp = false;
async function watch() {
  if (quitting) return;
  const up = await answering();
  if (quitting || !win || win.isDestroyed()) return;
  if (up) {
    waited = 0;
    everUp = true;
    failed = 0;
    if (showing !== 'map') { showing = 'map'; win.loadURL(URL_); }
  } else {
    waited++;
    // (A server that was there and is not for a moment is starting itself again after an update
    // of its code - whoever runs it. Only one that stays away is replaced by one of this
    // application's own.)
    if (!child && Date.now() >= notBefore && (!everUp || waited > 6)) startServer();
    // (the map was up and its server has gone - closed from outside, or stopped on an error: said so, until it is back)
    if (showing === 'map' && waited > 4) loading();
    if (showing === 'loading' && waited > 3) win.webContents.executeJavaScript(`window.say && window.say(${JSON.stringify(said.join('\n'))}, ${JSON.stringify(LOG)})`).catch(() => {});
  }
  setTimeout(watch, up ? 4000 : 700);
}

/** This file has been updated (the map tool updates itself): the application starts again, once nothing is being cut short. */
function again() {
  if (quitting) return;
  quitting = true;
  remember();
  stopServer().then(() => { app.relaunch(); app.exit(0); });
}

// ---- the application ----------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    open();
    watch();
    try {
      let timer = 0;
      fs.watch(__dirname, (event, name) => {
        if (!name || !/^main\.cjs$/i.test(name)) return;
        clearTimeout(timer);
        timer = setTimeout(() => { renew = true; if (!busy) again(); }, 1500);
      });
    } catch { /* started again by hand after such an update, that is all */ }
  });
  app.on('window-all-closed', () => {
    if (quitting) return;
    quitting = true;
    stopServer().then(() => app.quit());
  });
  app.on('before-quit', () => { quitting = true; if (child) { try { child.send({ quit: true }); } catch { /* gone */ } } });
}
