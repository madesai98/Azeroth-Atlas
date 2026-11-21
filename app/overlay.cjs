// The overlays: the map drawn over the game.
//
// Three things can be brought up over the game's window, each with a key of its own:
//
//   side   the sidebar, and everything in it
//   map    the map itself, full size
//   mini   a small map that stays on you: a minimap
//
// The first two are not a second map. They are the application's own page - the one map there
// is, with its routes, its place in your guide, what it sends the game - taken out of its
// window and put into one that is see-through, has no frame and stays on top of everything,
// laid over the game's window; there the page shows its sidebar and its map as two panels and
// nothing else (viewer/js/overlay.js). Let go of both, and the page is back in its window as it
// was. (A second copy of the page would be a second map working out the same routes and
// sending the game its own: the game is handed one route, and the last to speak would win.)
// While it is over the game, the application's own window says so, with a button to bring it
// back.
//
// The minimap is a second copy of the page, and a light one (it sends nothing anywhere, and is
// told where you are by the first): a small window of its own, see-through outside its shape.
//
// What is done here, and not in the page:
//   - the windows: made, shown, hidden, kept where the game's window is. The page says where
//     the game's window is (it hears it from the map's server, which reads the game's window);
//     with no game on this computer's screens they are laid over the main screen, so that they
//     can be set up without it. With the game minimized they are put away until it is back.
//   - the keys: one for each overlay, asked of Windows for the whole computer, so that they
//     work while the game has the keyboard. A key so held is taken from every other program,
//     so they are held only while the game is running (as the map's server sees it), and the
//     ones they come with are not ones anything is typed with (Ctrl + Alt + a figure is how
//     many keyboards type @, # and {).
//   - the mouse. An overlay's window lies over the whole of the game's, and must not take a
//     click meant for the game: it takes none, except while the pointer is on a panel the page
//     has said can be clicked (it is looked at thirty times a second). The windows never take
//     the keyboard either - a click on the map over the game leaves your character running -
//     until you click into something to type in, and give it back when you are done.
//   - what you have set (overlays.json, beside what the window remembers): the page shows it
//     and changes it, every window is told of a change.
const fs = require('node:fs');
const path = require('node:path');

const IDS = ['side', 'map', 'mini'];
const POINTS = ['tl', 'tc', 'tr', 'cl', 'cc', 'cr', 'bl', 'bc', 'br']; // top/centre/bottom, left/centre/right
const SHAPES = ['circle', 'rounded', 'square'];
const DEFAULTS = {
  v: 1,
  side: { shown: false, hotkey: 'Control+Alt+F1', pinned: false, anchor: 'tl', origin: 'tl', x: 16, y: 80, w: 344, h: 720, opacity: { still: 100, moving: 70, combat: 45 }, through: { moving: false, combat: true } },
  map: { shown: false, hotkey: 'Control+Alt+F2', pinned: false, anchor: 'cc', origin: 'cc', x: 0, y: 0, w: 960, h: 640, opacity: { still: 100, moving: 70, combat: 45 }, through: { moving: false, combat: true } },
  mini: { shown: false, hotkey: 'Control+Alt+F3', pinned: false, anchor: 'tr', origin: 'tr', x: -24, y: 24, w: 260, h: 260, opacity: { still: 100, moving: 100, combat: 85 }, through: { moving: false, combat: false }, shape: 'circle', turn: true, auto: false },
};
const LEAST = { side: [260, 220], map: [320, 220], mini: [120, 120] }; // the smallest an overlay can be made
const KEEP_MINI = 5 * 60 * 1000; // a minimap put away is kept this long, ready to come back at once

const num = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const frac = (c) => (c === 'l' || c === 't' ? 0 : c === 'c' ? 0.5 : 1);

/** What was set, made whole and sound: anything missing or out of range is as it comes. */
function sound(raw) {
  const out = { v: 1 };
  for (const id of IDS) {
    const d = DEFAULTS[id], r = raw && typeof raw[id] === 'object' && raw[id] ? raw[id] : {};
    const o = {
      shown: r.shown === true,
      hotkey: typeof r.hotkey === 'string' && r.hotkey.length <= 60 ? r.hotkey : d.hotkey,
      pinned: r.pinned === true,
      anchor: POINTS.includes(r.anchor) ? r.anchor : d.anchor,
      origin: POINTS.includes(r.origin) ? r.origin : d.origin,
      x: Math.round(num(r.x, -20000, 20000, d.x)), y: Math.round(num(r.y, -20000, 20000, d.y)),
      w: Math.round(num(r.w, LEAST[id][0], 20000, d.w)), h: Math.round(num(r.h, LEAST[id][1], 20000, d.h)),
      opacity: {}, through: {},
    };
    for (const k of ['still', 'moving', 'combat']) o.opacity[k] = Math.round(num(r.opacity?.[k], 5, 100, d.opacity[k]));
    for (const k of ['moving', 'combat']) o.through[k] = typeof r.through?.[k] === 'boolean' ? r.through[k] : d.through[k];
    if (id === 'mini') {
      o.shape = SHAPES.includes(r.shape) ? r.shape : d.shape;
      o.turn = typeof r.turn === 'boolean' ? r.turn : d.turn;
      o.auto = typeof r.auto === 'boolean' ? r.auto : d.auto;
    }
    out[id] = o;
  }
  return out;
}

/**
 * Where an overlay lies inside the game's window: { x, y, w, h } from that window's top left
 * corner. A point of the game's window (anchor) and a point of the overlay itself (origin) are
 * held x and y apart; whatever the game's window is resized to, that holds. Kept inside the
 * game's window, and no bigger than it. (The page has the same reckoning for its own panels:
 * viewer/js/overlay.js, place.)
 */
function place(o, gw, gh, least = [1, 1]) {
  const w = Math.round(Math.max(Math.min(least[0], gw), Math.min(o.w, gw))), h = Math.round(Math.max(Math.min(least[1], gh), Math.min(o.h, gh)));
  // (each point at a whole pixel - the middle of an odd width is half a pixel on - so that what is worked back from a place leads to that place again)
  const x = Math.round(frac(o.anchor[1]) * gw) + o.x - Math.round(frac(o.origin[1]) * w), y = Math.round(frac(o.anchor[0]) * gh) + o.y - Math.round(frac(o.origin[0]) * h);
  return { x: Math.round(Math.min(Math.max(0, x), gw - w)), y: Math.round(Math.min(Math.max(0, y), gh - h)), w, h };
}

/** A key as Windows is asked for it, or null: nothing with a quote or a space in it, a key at the end, the rest ways of holding. */
function key(text) {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split('+');
  const last = parts.pop();
  if (!parts.every((p) => ['Control', 'Alt', 'Shift', 'Super'].includes(p)) || new Set(parts).size !== parts.length) return null;
  if (!/^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|num[0-9]|Space|Tab|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert|Delete|[`\-=\[\]\\;',./])$/.test(last)) return null;
  // (a letter or a figure by itself would be taken from the game and from everything typed anywhere)
  if (!parts.some((p) => p !== 'Shift') && !/^F\d+$/.test(last)) return null;
  return [...parts, last].join('+');
}

/**
 * @param d  what the application hands over: { electron (its own module), home (the window the page lives in), view (the page),
 *           address (the page's), preload, file (where what is set is kept), noted (to note what happens), unseen (true: nothing is
 *           ever put on the screen - for the tests), fit (lay the page out in its window again) }
 */
function overlays(d) {
  const { BaseWindow, BrowserWindow, WebContentsView, screen, globalShortcut, ipcMain } = d.electron;
  let settings = sound(null);
  try { settings = sound(JSON.parse(fs.readFileSync(d.file, 'utf8'))); } catch { /* nothing set yet */ }
  const game = { status: 'off', window: null }; // as the page last said: the game's window in the screen's own pixels
  let host = null;        // the see-through window the page is put into
  let hosted = false;     // the page is in it
  let away = null;        // what the application's own window shows meanwhile
  let mini = null;        // the minimap's window
  let miniGone = 0;       // (a timer: the minimap's window is given up once it has been put away for a while)
  const keys = {};        // overlay -> the key Windows has given it, or false: it would not
  const mouse = { rects: [], hold: false, miniThrough: false, miniHold: false, hostTakes: null, miniTakes: null, typing: null };
  let closing = false;
  let watching = 0;

  const save = () => { try { fs.mkdirSync(path.dirname(d.file), { recursive: true }); fs.writeFileSync(d.file, JSON.stringify(settings, null, 1)); } catch (err) { d.noted('what is set for the overlays could not be kept', { error: err.message }); } };
  const alive = (w) => !!w && !w.isDestroyed();
  const pages = () => [d.view?.webContents, alive(mini) ? mini.webContents : null, away?.webContents].filter((c) => c && !c.isDestroyed());

  /** The game's window, as this application counts places on the screen - or the main screen, with no game to lay anything over. */
  function ground() {
    const w = game.window;
    if (w && w.w > 200 && w.h > 150 && !['off', 'nogame'].includes(game.status)) {
      try {
        const r = screen.screenToDipRect(null, { x: Math.round(w.x), y: Math.round(w.y), width: Math.round(w.w), height: Math.round(w.h) });
        if (r.width > 100 && r.height > 100) return { x: r.x, y: r.y, w: r.width, h: r.height, from: 'game' };
      } catch { /* the main screen, then */ }
    }
    const b = screen.getPrimaryDisplay().bounds;
    return { x: b.x, y: b.y, w: b.width, h: b.height, from: 'screen' };
  }
  const away_ = () => game.status === 'minimized'; // the game is minimized: nothing is laid over a desktop
  const running = () => ['live', 'nosignal', 'minimized'].includes(game.status); // the game is there: the keys are held
  let held = false;

  /** What every page is told: what is set, where the game is, whether the page is over the game, which keys Windows gave. */
  function told() {
    const g = ground();
    return { settings, game: { w: g.w, h: g.h, from: g.from, status: game.status, minimized: away_() }, over: hosted, keys: { ...keys }, keysHeld: held, least: LEAST, unseen: !!d.unseen };
  }
  const tell = () => { const t = told(); for (const c of pages()) { try { c.send('atlas:overlay:changed', t); } catch { /* gone */ } } };

  // ---- the keys -----------------------------------------------------------------------------
  function bind() {
    try { globalShortcut.unregisterAll(); } catch { /* none were held */ }
    held = running();
    // (no game: no key is taken from anybody)
    if (!held) { for (const id of IDS) keys[id] = null; return; }
    const taken = new Set();
    for (const id of IDS) {
      const k = key(settings[id].hotkey);
      if (!k) { keys[id] = settings[id].hotkey ? false : null; continue; }
      // (one key for two overlays: the first has it)
      if (taken.has(k)) { keys[id] = false; continue; }
      let ok = false;
      try { ok = globalShortcut.register(k, () => toggle(id)); } catch { ok = false; }
      keys[id] = ok ? k : false;
      if (ok) taken.add(k);
      else d.noted('Windows would not give a key to an overlay (something else has it)', { overlay: id, key: k });
    }
  }

  // ---- the windows ----------------------------------------------------------------------------
  const SEE_THROUGH = { frame: false, transparent: true, show: false, skipTaskbar: true, focusable: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false, backgroundColor: '#00000000' };
  const onTop = (w) => { try { w.setAlwaysOnTop(true, 'screen-saver'); } catch { /* as high as it goes */ } };
  const takes = (w, on) => { try { w.setIgnoreMouseEvents(!on); } catch { /* gone */ } };

  function makeHost() {
    if (alive(host)) return host;
    host = new BaseWindow({ ...SEE_THROUGH, title: 'Azeroth Atlas (over the game)', width: 800, height: 600 });
    onTop(host);
    takes(host, false);
    mouse.hostTakes = false;
    host.on('closed', () => { host = null; });
    return host;
  }

  /** The page, out of its own window and over the game - or back. */
  function move(over) {
    if (over === hosted || closing || !d.view || d.view.webContents.isDestroyed()) return;
    const view = d.view;
    try {
      if (over) {
        const h = makeHost(), g = ground();
        h.setBounds({ x: g.x, y: g.y, width: g.w, height: g.h });
        d.home.contentView.removeChildView(view);
        h.contentView.addChildView(view);
        view.setBackgroundColor('#00000000');
        view.setBounds({ x: 0, y: 0, width: g.w, height: g.h });
        if (!away) {
          away = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: d.preload } });
          away.webContents.loadFile(path.join(__dirname, 'away.html')).catch(() => {});
        }
        d.home.contentView.addChildView(away);
        const [w, hh] = d.home.getContentSize();
        away.setBounds({ x: 0, y: 0, width: w, height: hh });
        hosted = true;
      } else {
        if (alive(host)) { host.contentView.removeChildView(view); host.hide(); }
        if (away) { try { d.home.contentView.removeChildView(away); } catch { /* not there */ } }
        d.home.contentView.addChildView(view);
        view.setBackgroundColor('#0b0e14');
        hosted = false;
        mouse.rects = []; mouse.hold = false;
        if (mouse.typing === 'host') mouse.typing = null;
        d.fit();
      }
      d.noted(over ? 'the page is put over the game' : 'the page is back in its window');
    } catch (err) { d.noted('the page could not be moved between its window and the overlay', { error: err.message, over }); }
  }

  function makeMini() {
    if (alive(mini)) return mini;
    mini = new BrowserWindow({ ...SEE_THROUGH, title: 'Azeroth Atlas (minimap)', width: settings.mini.w, height: settings.mini.h, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: d.preload, backgroundThrottling: false } });
    onTop(mini);
    takes(mini, false);
    mouse.miniTakes = false; mouse.miniHold = false;
    const mine = mini;
    mine.on('closed', () => { if (mini === mine) mini = null; });
    mine.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mine.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(d.address)) e.preventDefault(); });
    // (the map's server away for a moment - it starts itself again after an update: tried again)
    mine.webContents.on('did-fail-load', (e, code, text, url, main) => { if (main && alive(mine)) setTimeout(() => { if (alive(mine)) mine.loadURL(`${d.address}?overlay=mini`).catch(() => {}); }, 2500); });
    mine.webContents.on('render-process-gone', () => { if (alive(mine)) mine.destroy(); });
    mine.loadURL(`${d.address}?overlay=mini`).catch(() => {});
    return mini;
  }

  /** Everything put as it should be: which windows there are, where, and what is on show. */
  function arrange() {
    if (closing) return;
    const g = ground(), gone = away_();
    const wantPanels = (settings.side.shown || settings.map.shown) && !gone && d.ready();
    move(wantPanels);
    if (hosted && alive(host)) {
      const b = host.getBounds();
      if (b.x !== g.x || b.y !== g.y || b.width !== g.w || b.height !== g.h) { host.setBounds({ x: g.x, y: g.y, width: g.w, height: g.h }); d.view.setBounds({ x: 0, y: 0, width: g.w, height: g.h }); }
      if (!d.unseen && !host.isVisible()) { host.showInactive(); onTop(host); }
    }
    const wantMini = settings.mini.shown && !gone && d.ready();
    if (wantMini) {
      clearTimeout(miniGone); miniGone = 0;
      const m = makeMini(), p = place(settings.mini, g.w, g.h, LEAST.mini);
      const want = { x: g.x + p.x, y: g.y + p.y, width: p.w, height: p.h }, b = m.getBounds();
      if (b.x !== want.x || b.y !== want.y || b.width !== want.width || b.height !== want.height) m.setBounds(want);
      if (!d.unseen && !m.isVisible()) { m.showInactive(); onTop(m); }
    } else if (alive(mini)) {
      if (mini.isVisible()) mini.hide();
      if (!miniGone) miniGone = setTimeout(() => { miniGone = 0; if (alive(mini) && !(settings.mini.shown && !away_())) mini.destroy(); }, KEEP_MINI);
    }
    watch();
    tell();
  }

  // ---- the mouse ------------------------------------------------------------------------------
  /** Looked at while an overlay is up: a window takes the mouse only while the pointer is on something of it that can be clicked. */
  function look() {
    let p = null;
    try { p = screen.getCursorScreenPoint(); } catch { return; }
    if (hosted && alive(host)) {
      const b = host.getBounds();
      // (not held on to while you type: a click on the game then goes to the game, which takes the keyboard back with it)
      const on = mouse.hold || mouse.rects.some((r) => p.x >= b.x + r.x && p.x < b.x + r.x + r.w && p.y >= b.y + r.y && p.y < b.y + r.y + r.h);
      if (on !== mouse.hostTakes) { mouse.hostTakes = on; takes(host, on); }
    }
    if (alive(mini) && (mini.isVisible() || d.unseen)) {
      const b = mini.getBounds();
      let on = !mouse.miniThrough && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      // (round: its corners are the game's)
      if (on && settings.mini.shape === 'circle') { const rx = b.width / 2, ry = b.height / 2; on = ((p.x - b.x - rx) / rx) ** 2 + ((p.y - b.y - ry) / ry) ** 2 <= 1; }
      on = on || mouse.miniHold;
      if (on !== mouse.miniTakes) { mouse.miniTakes = on; takes(mini, on); }
    }
  }
  function watch() {
    const up = (hosted && alive(host)) || (alive(mini) && settings.mini.shown);
    if (up && !watching) watching = setInterval(look, 33);
    else if (!up && watching) { clearInterval(watching); watching = 0; }
  }

  /** The keyboard: taken while you type into an overlay, and given back. */
  function typing(which, on) {
    const w = which === 'host' ? host : mini;
    if (!alive(w)) return;
    try {
      if (on) {
        mouse.typing = which;
        w.setFocusable(true);
        if (!d.unseen) { w.focus(); (which === 'host' ? d.view.webContents : w.webContents).focus(); }
      } else {
        if (mouse.typing === which) mouse.typing = null;
        if (!d.unseen) w.blur();
        w.setFocusable(false);
        onTop(w);
      }
    } catch (err) { d.noted('an overlay could not take or give back the keyboard', { error: err.message, which, on }); }
  }

  // ---- what is asked of it -------------------------------------------------------------------
  function toggle(id) {
    if (!IDS.includes(id)) return;
    settings = sound({ ...settings, [id]: { ...settings[id], shown: !settings[id].shown } });
    save();
    d.noted(`overlay ${id}: ${settings[id].shown ? 'brought up' : 'put away'}`);
    arrange();
  }
  /** A change to what is set: { side: { ... }, map: { ... }, mini: { ... } }, each with only what changes. */
  function set(patch) {
    if (!patch || typeof patch !== 'object') return told();
    const next = { ...settings };
    let keysChanged = false;
    for (const id of IDS) {
      const p = patch[id];
      if (!p || typeof p !== 'object') continue;
      if ('hotkey' in p && p.hotkey !== settings[id].hotkey) keysChanged = true;
      next[id] = { ...settings[id], ...p, opacity: { ...settings[id].opacity, ...(p.opacity ?? {}) }, through: { ...settings[id].through, ...(p.through ?? {}) } };
    }
    settings = sound(next);
    save();
    if (keysChanged) bind();
    arrange();
    return told();
  }

  const who = (e) => (d.view && e.sender === d.view.webContents ? 'page' : alive(mini) && e.sender === mini.webContents ? 'mini' : away && e.sender === away.webContents ? 'away' : null);
  const from = (e) => { const url = e.senderFrame?.url ?? ''; return who(e) && (url.startsWith(d.address) || url.startsWith('file:')) ? who(e) : null; };
  ipcMain.handle('atlas:overlay:get', (e) => (from(e) ? { ...told(), role: from(e) } : null));
  ipcMain.handle('atlas:overlay:set', (e, patch) => (from(e) ? set(patch) : null));
  ipcMain.handle('atlas:overlay:toggle', (e, id) => { if (from(e)) toggle(String(id)); return from(e) ? told() : null; });
  // (both put away: the page is back in its window)
  ipcMain.handle('atlas:overlay:dock', (e) => { if (!from(e)) return null; return set({ side: { shown: false }, map: { shown: false } }); });
  // (the game's window, as the map's server has it: the page passes it on)
  ipcMain.on('atlas:overlay:game', (e, info) => {
    if (from(e) !== 'page' || !info || typeof info !== 'object') return;
    const w = info.window && [info.window.x, info.window.y, info.window.w, info.window.h].every((v) => typeof v === 'number' && Number.isFinite(v)) ? { x: info.window.x, y: info.window.y, w: info.window.w, h: info.window.h } : null;
    const status = typeof info.status === 'string' ? info.status.slice(0, 20) : 'off';
    if (status === game.status && JSON.stringify(w) === JSON.stringify(game.window)) return;
    game.status = status; game.window = w;
    if (running() !== held) bind();
    arrange();
  });
  // (what of the page can be clicked just now, in the overlay's window: [{ x, y, w, h }]; and a drag under way)
  ipcMain.on('atlas:overlay:rects', (e, list) => {
    if (from(e) !== 'page') return;
    mouse.rects = Array.isArray(list) ? list.slice(0, 12).filter((r) => r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v))).map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })) : [];
  });
  ipcMain.on('atlas:overlay:hold', (e, on) => { const f = from(e); if (f === 'page') mouse.hold = on === true; else if (f === 'mini') mouse.miniHold = on === true; });
  ipcMain.on('atlas:overlay:through', (e, on) => { if (from(e) === 'mini') mouse.miniThrough = on === true; });
  ipcMain.on('atlas:overlay:typing', (e, on) => { const f = from(e); if (f === 'page' && hosted) typing('host', on === true); else if (f === 'mini') typing('mini', on === true); });
  // (for the tests: how things stand)
  ipcMain.handle('atlas:overlay:state', (e) => (from(e) && process.env.AZEROTH_ATLAS_TEST ? {
    hosted, game: { ...game }, ground: ground(), keys: { ...keys }, keysHeld: held, settings,
    host: alive(host) ? { bounds: host.getBounds(), visible: host.isVisible(), onTop: host.isAlwaysOnTop(), focusable: host.isFocusable(), takes: mouse.hostTakes } : null,
    mini: alive(mini) ? { bounds: mini.getBounds(), visible: mini.isVisible(), onTop: mini.isAlwaysOnTop(), focusable: mini.isFocusable(), takes: mouse.miniTakes, url: mini.webContents.getURL() } : null,
    mouse: { rects: mouse.rects, hold: mouse.hold, miniThrough: mouse.miniThrough, typing: mouse.typing }, homeHasPage: !hosted,
    page: (() => { try { return d.view.getBounds(); } catch { return null; } })(),
  } : null));

  screen.on('display-metrics-changed', () => arrange());
  screen.on('display-removed', () => arrange());
  bind();

  return {
    /** The page has come up (or come up again): everything is put as it was left. */
    arrange,
    /** The application's window has been resized: what it shows while the page is away fills it. */
    fitAway() { if (hosted && away) { const [w, h] = d.home.getContentSize(); away.setBounds({ x: 0, y: 0, width: w, height: h }); } },
    get hosted() { return hosted; },
    /** The application is going: every window of the overlays with it. */
    close() {
      closing = true;
      clearInterval(watching); clearTimeout(miniGone);
      try { globalShortcut.unregisterAll(); } catch { /* none */ }
      if (alive(mini)) mini.destroy();
      if (alive(host)) { try { if (hosted) host.contentView.removeChildView(d.view); } catch { /* gone */ } host.destroy(); }
    },
  };
}

module.exports = { overlays, sound, place, key, DEFAULTS, LEAST, IDS, POINTS, SHAPES };
