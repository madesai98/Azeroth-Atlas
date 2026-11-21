// The overlays, as the page has them: the map drawn over the game.
//
// The application can bring three things up over the game's window, each with a key of its own
// (app/overlay.cjs has the windows, the keys and the mouse; this is the page's side of it):
//
//   side   the sidebar, and everything in it
//   map    the map itself, full size
//   mini   a small map that stays on you: a minimap
//
// The sidebar and the map over the game are THIS page - the one map there is - taken out of
// the application's window and laid over the game's in a see-through one the size of the
// game's window. There the page shows nothing but two panels: its sidebar, and the box its
// map is in. Each lies where it was put: a point of the game's window (its top left corner,
// the middle of its right edge... nine to choose from) and a point of the panel itself are
// held so many pixels apart, so that a panel put in a corner is still in that corner when the
// game's window is resized. A panel that is not pinned can be dragged (the sidebar by its
// head, the map by the grip at its top) and resized (the corner at its bottom right), inside
// the game's window and no further. Each is as clear or as faint as is set for standing still,
// for moving and for a fight, and can let clicks through while you move or fight. Whatever
// of the page can be clicked at the moment is told to the application, which lets the mouse
// through everywhere else.
//
// The minimap is a second copy of the page (role.js: MINI) in a small window of its own: only
// the map, always on you, round or square, turning with you and zooming by the kind of place
// as is set for it alone - the map itself and the sidebar go by the switches under "You".
//
// What is set is the application's to keep (the sidebar's "Overlay settings" shows and changes
// it); a page in a browser has no application behind it, and says so.
import { MINI } from './role.js';
import { note } from './log.js';

const $ = (id) => document.getElementById(id);
const api = (typeof window !== 'undefined' && window.azerothAtlas?.overlay) || null;
export const IDS = ['side', 'map', 'mini'];
const NAMES = { side: 'Sidebar', map: 'Map', mini: 'Minimap' };
export const POINTS = ['tl', 'tc', 'tr', 'cl', 'cc', 'cr', 'bl', 'bc', 'br'];
const POINT_WORDS = { tl: 'top left corner', tc: 'top edge, middle', tr: 'top right corner', cl: 'left edge, middle', cc: 'middle', cr: 'right edge, middle', bl: 'bottom left corner', bc: 'bottom edge, middle', br: 'bottom right corner' };
const SHAPES = [['circle', 'Round'], ['rounded', 'Rounded'], ['square', 'Square']];
const MOVING_FOR = 700; // ms after the last sign of you moving that you still count as moving
const frac = (c) => (c === 'l' || c === 't' ? 0 : c === 'c' ? 0.5 : 1);

/**
 * Where an overlay lies inside the game's window: { x, y, w, h } from that window's top left
 * corner. Its anchor (a point of the game's window) and its origin (a point of its own) are
 * o.x and o.y apart. Kept inside the game's window, and no bigger than it. (The application
 * has the same reckoning for the minimap's window: app/overlay.cjs, place.)
 */
export function place(o, gw, gh, least = [1, 1]) {
  const w = Math.round(Math.max(Math.min(least[0], gw), Math.min(o.w, gw))), h = Math.round(Math.max(Math.min(least[1], gh), Math.min(o.h, gh)));
  // (each point at a whole pixel - the middle of an odd width is half a pixel on - so that what is worked back from a place leads to that place again)
  const x = Math.round(frac(o.anchor[1]) * gw) + o.x - Math.round(frac(o.origin[1]) * w), y = Math.round(frac(o.anchor[0]) * gh) + o.y - Math.round(frac(o.origin[0]) * h);
  return { x: Math.round(Math.min(Math.max(0, x), gw - w)), y: Math.round(Math.min(Math.max(0, y), gh - h)), w, h };
}

/** The other way: how far apart anchor and origin are for an overlay that lies at (left, top) with size w by h: { x, y }. */
export function apart(anchor, origin, gw, gh, left, top, w, h) {
  return { x: Math.round(left) - Math.round(frac(anchor[1]) * gw) + Math.round(frac(origin[1]) * w), y: Math.round(top) - Math.round(frac(anchor[0]) * gh) + Math.round(frac(origin[0]) * h) };
}

/**
 * A key pressed, as the application asks Windows for it ("Control+Alt+1") - or null: not a key
 * an overlay can have (a key that only holds, or a letter or a figure with nothing held, which
 * would be taken from the game and from everything typed anywhere).
 */
export function keyOf(e) {
  const c = e.code ?? '';
  let k = null;
  if (/^Key[A-Z]$/.test(c)) k = c.slice(3);
  else if (/^Digit\d$/.test(c)) k = c.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(c)) k = c;
  else if (/^Numpad\d$/.test(c)) k = `num${c.slice(6)}`;
  else k = { Space: 'Space', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/' }[c] ?? null;
  if (!k) return null;
  const held = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!held.some((h) => h !== 'Shift') && !/^F\d+$/.test(k)) return null;
  return [...held, k].join('+');
}
/** ...and as it is shown: "Ctrl + Alt + 1". */
export const keyWords = (k) => (k ? k.replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win').replace(/^num(\d)$/, 'Numpad $1').replace(/\+num(\d)$/, '+Numpad $1').split('+').join(' + ') : 'none');

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k in e) e[k] = v; else e.setAttribute(k, v); }
  e.append(...kids);
  return e;
};

export function bindOverlays(app) {
  const st = {
    told: null,         // how things stand, as the application last said: { settings, game, over, keys, least }
    tab: 'side',        // the overlay whose settings the sidebar shows
    asking: null,       // the overlay a key is being pressed for
    movedAt: -1e9, at: null, combat: false, how: 'still',
    drag: null,         // a panel being dragged or resized: { id, kind, rect, ... }
    gameSaid: '', typing: false, built: false, rects: '',
  };
  const html = document.documentElement, body = document.body;
  const over = () => !MINI && !!st.told?.over;
  const size = () => (MINI ? [st.told?.game?.w ?? screen.width, st.told?.game?.h ?? screen.height] : [window.innerWidth, window.innerHeight]);

  // ---- how you are doing: still, moving, in a fight --------------------------------------------
  /** The game has said something (player.js): where its window is goes to the application; whether you move or fight is kept. */
  function heard() {
    const s = app.player?.state, p = s?.player;
    if (api && !MINI && s) {
      const said = JSON.stringify([s.status, s.window ?? null]);
      if (said !== st.gameSaid) { st.gameSaid = said; api.game({ status: s.status, window: s.window ?? null }); }
    }
    const now = performance.now();
    if (p && s.status === 'live') {
      if ((typeof p.speed === 'number' && p.speed > 0.2) || p.taxi) st.movedAt = now;
      if (typeof p.x === 'number' && st.at && (Math.abs(p.x - st.at[0]) > 0.05 || Math.abs(p.y - st.at[1]) > 0.05)) st.movedAt = now;
      st.at = typeof p.x === 'number' ? [p.x, p.y] : null;
      st.combat = p.combat === true;
    } else { st.combat = false; st.at = null; }
    mood();
  }
  /** Still, moving or in a fight - as of now; what hangs on it is put right when it changes. */
  function mood() {
    const how = st.combat ? 'combat' : performance.now() - st.movedAt < MOVING_FOR ? 'moving' : 'still';
    if (how !== st.how) { st.how = how; lay(); }
  }

  // ---- the page over the game: two panels ------------------------------------------------------
  const through = (o) => (st.how === 'still' ? false : !!o.through?.[st.how]) && !st.drag;
  const rectOf = (id) => (st.drag?.id === id ? st.drag.rect : place(st.told.settings[id], ...size(), st.told.least?.[id]));

  /** Everything put where and how it is set. */
  function lay() {
    const t = st.told;
    const on = over();
    html.classList.toggle('ov', on);
    body.classList.toggle('ov', on);
    // (with the map put away there is nothing to draw: main.js, step)
    app.noDraw = on && !t.settings.map.shown;
    if (MINI && t) {
      const o = t.settings.mini;
      for (const [k] of SHAPES) body.classList.toggle(`shape-${k}`, o.shape === k);
      body.classList.toggle('ov-pin-mini', !!o.pinned);
      html.style.setProperty('--ov-mini-o', String(o.opacity[st.how] / 100));
      api?.through(through(o));
      // how it turns and zooms is its own (the map's switches are not asked: main.js, recall)
      if ($('optTurn').checked !== o.turn || $('optAuto').checked !== o.auto) { $('optTurn').checked = o.turn; $('optAuto').checked = o.auto; app.applyFollow?.(); }
      if (app.player && !app.player.follow) app.player.setFollow(true);
      tools();
    }
    if (!on) { if (st.rects !== '[]' && api && !MINI) { st.rects = '[]'; api.rects([]); } if (!MINI) app.dirty = true; return; }
    const list = [];
    for (const id of ['side', 'map']) {
      const o = t.settings[id];
      body.classList.toggle(`ov-no${id}`, !o.shown);
      body.classList.toggle(`ov-pin-${id}`, !!o.pinned);
      const r = rectOf(id);
      for (const k of ['x', 'y', 'w', 'h']) html.style.setProperty(`--ov-${id}-${k}`, `${r[k]}px`);
      html.style.setProperty(`--ov-${id}-o`, String(o.opacity[st.how] / 100));
      if (o.shown && !through(o)) list.push(r);
    }
    const said = JSON.stringify(list);
    if (said !== st.rects) { st.rects = said; api?.rects(list); }
    tools();
    app.dirty = true;
  }

  // ---- a panel's handles: to move it by, to pin it, to put it away, to resize it ----------------
  const handles = {};
  function tools() {
    if (handles.made) { for (const id of Object.keys(handles.pin ?? {})) handles.pin[id].classList.toggle('on', !!st.told?.settings[id]?.pinned); return; }
    handles.made = true;
    handles.pin = {};
    const make = (id, box, grip) => {
      const pin = el('button', { text: '\u{1F4CC}', title: 'Pin it where it is: it cannot be moved or resized until it is unpinned' });
      const shut = el('button', { text: '×', title: `Put it away${st.told?.settings[id]?.hotkey ? ` (${keyWords(st.told.settings[id].hotkey)} brings it back)` : ''}` });
      pin.addEventListener('click', () => api?.set({ [id]: { pinned: !st.told.settings[id].pinned } }));
      shut.addEventListener('click', () => api?.set({ [id]: { shown: false } }));
      handles.pin[id] = pin;
      pin.classList.toggle('on', !!st.told?.settings[id]?.pinned);
      const bar = el('div', { class: 'ovtools' }, pin, shut);
      for (const b of [pin, shut]) b.addEventListener('pointerdown', (e) => e.stopPropagation());
      const corner = el('div', { class: 'ovsize', title: 'Drag to resize' });
      box.append(bar, corner);
      if (grip === true) { grip = el('div', { class: 'ovgrip', title: 'Drag to move' }); box.append(grip); }
      grip.addEventListener('pointerdown', (e) => begin(e, id, 'move'));
      corner.addEventListener('pointerdown', (e) => begin(e, id, 'size'));
    };
    if (MINI) make('mini', $('mapBox'), true);
    else { make('side', $('side'), $('sideHead')); make('map', $('mapBox'), true); }
  }

  /** A drag begins: of the panel itself, or of its corner. */
  function begin(e, id, kind) {
    const t = st.told, o = t?.settings[id];
    if (e.button !== 0 || !o || o.pinned || (!over() && !MINI) || e.target.closest?.('button, input, select, a')) return;
    e.preventDefault(); e.stopPropagation();
    const [gw, gh] = size();
    const rect = place(o, gw, gh, t.least?.[id]);
    st.drag = { id, kind, rect: { ...rect }, from: rect, sx: e.screenX, sy: e.screenY, gw, gh, least: t.least?.[id] ?? [80, 80], sent: 0 };
    body.classList.add('ov-dragging');
    api?.hold(true);
    const move = (ev) => {
      const d = st.drag;
      if (!d) return;
      const dx = ev.screenX - d.sx, dy = ev.screenY - d.sy, f = d.from, r = d.rect;
      if (d.kind === 'move') {
        r.x = Math.round(Math.min(Math.max(0, f.x + dx), d.gw - f.w)); r.y = Math.round(Math.min(Math.max(0, f.y + dy), d.gh - f.h));
      } else {
        r.w = Math.round(Math.min(Math.max(d.least[0], f.w + dx), d.gw - f.x)); r.h = Math.round(Math.min(Math.max(d.least[1], f.h + dy), d.gh - f.y));
        // (round is round: as wide as it is high)
        if (id === 'mini' && o.shape === 'circle') { const s = Math.min(Math.max(r.w, r.h), d.gw - f.x, d.gh - f.y); r.w = s; r.h = s; }
      }
      if (MINI) {
        // (the minimap's window is the application's to move: asked for as it goes, some thirty times a second)
        const now = performance.now();
        if (now - d.sent > 30) { d.sent = now; api?.set({ mini: { ...apart(o.anchor, o.origin, d.gw, d.gh, r.x, r.y, r.w, r.h), w: r.w, h: r.h } }); }
      } else lay();
    };
    const end = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      const d = st.drag;
      st.drag = null;
      body.classList.remove('ov-dragging');
      api?.hold(false);
      if (!d) return;
      const r = d.rect;
      // (kept as the points it is held by and how far apart they are: it stays put when the game's window is resized)
      api?.set({ [id]: { ...apart(o.anchor, o.origin, d.gw, d.gh, r.x, r.y, r.w, r.h), w: r.w, h: r.h } });
      note('overlay', `${NAMES[id]} ${d.kind === 'move' ? 'moved' : 'resized'}`, { to: r, within: [d.gw, d.gh] });
      lay();
    };
    try { e.target.setPointerCapture?.(e.pointerId); } catch { /* followed through the window all the same */ }
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
  }

  // ---- the keyboard, while it is over the game --------------------------------------------------
  // An overlay's window never takes the keyboard from the game - until you click into something
  // to type in. Then it does, and gives it back when you leave that (Esc, or a click elsewhere).
  const typed = (t) => !!t?.closest?.('input:not([type=checkbox]):not([type=color]):not([type=radio]), textarea, select') || !!t?.closest?.('.ovkey.asking');
  const setTyping = (on) => { if (st.typing !== on && (over() || MINI)) { st.typing = on; api?.typing(on); } else if (!on) st.typing = false; };
  document.addEventListener('pointerdown', (e) => { if ((over() || MINI) && typed(e.target)) setTyping(true); }, true);
  document.addEventListener('focusout', () => { setTimeout(() => { if (st.typing && !typed(document.activeElement) && !st.asking) setTyping(false); }, 120); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.typing && !st.asking && typed(document.activeElement)) document.activeElement.blur(); });
  window.addEventListener('blur', () => { if (st.typing) { if (typed(document.activeElement)) document.activeElement.blur(); st.asking = null; setTyping(false); show(); } });

  // ---- the minimap: nothing but the map, always on you ------------------------------------------
  if (MINI) {
    html.classList.add('mini');
    body.classList.add('mini', 'shape-circle');
    // (a left drag of the minimap moves the minimap, not the view off you; the right button swings the view, the wheel zooms)
    $('mapBox').addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest?.('.ovtools, .ovsize, .ovgrip')) return;
      e.stopPropagation();
      begin(e, 'mini', 'move');
    }, true);
    $('mapBox').addEventListener('dblclick', (e) => e.stopPropagation(), true);
    // What the map has set is what the minimap draws: when it changes there, it changes here.
    let again = 0;
    window.addEventListener('storage', (e) => {
      let v = null;
      try { v = JSON.parse(e.newValue); } catch { return; }
      if (!v || typeof v !== 'object') return;
      try {
        if (e.key === 'wfmap.ui') { app.reapply?.(); lay(); }
        else if (e.key === 'wfmap.npcs') app.npcs?.set(v);
        else if (e.key === 'wfmap.routes') { for (const k of Object.keys(v)) if (app.trips?.settings?.[k]) Object.assign(app.trips.settings[k], v[k]); app.showRouteList?.(); app.dirty = true; }
        else if (e.key === 'wfmap.route') { $('optRoute').checked = v.on !== false; app.applyRoute?.(); }
        // (the spawn zones, the figures: read as the page starts - so it starts again, once the changing is over)
        else if (e.key === 'wfmap.danger' || e.key === 'wfmap.figure') { clearTimeout(again); again = setTimeout(() => location.reload(), 2500); }
      } catch (err) { console.warn('what was set on the map could not be taken over by the minimap', err); }
    });
  }

  // ---- what is set: the sidebar's section -----------------------------------------------------
  const ui = {};
  function build() {
    const box = $('ovBody');
    if (!box || st.built || MINI) return;
    st.built = true;
    ui.note = el('div', { id: 'ovNote', class: 'dim small' });
    if (!api) {
      ui.note.textContent = 'The overlays are drawn over the game by the Azeroth Atlas application: the sidebar, the map and a minimap, each brought up with a key. This page is open in a browser, which cannot draw over the game.';
      box.append(ui.note);
      return;
    }
    const set = (patch) => api.set({ [st.tab]: patch });
    const row = (...kids) => el('div', { class: 'row' }, ...kids);
    const check = (text, title, get, put) => {
      const input = el('input', { type: 'checkbox' });
      input.addEventListener('change', () => put(input.checked));
      (ui.shows ??= []).push(() => { input.checked = !!get(cur()); });
      return el('label', { class: 'row', title }, input, el('span', { class: 'grow', text }));
    };
    const number = (get, put, lo, hi) => {
      const input = el('input', { type: 'number', min: String(lo), max: String(hi) });
      input.addEventListener('change', () => { const v = Math.round(+input.value); if (Number.isFinite(v) && input.value !== '') put(Math.min(hi, Math.max(lo, v))); else show(); });
      (ui.shows ??= []).push(() => { if (document.activeElement !== input) input.value = String(get(cur())); });
      return input;
    };
    const grid = (field, title) => {
      const g = el('div', { class: 'grid9', title });
      for (const p of POINTS) {
        const b = el('button', { title: POINT_WORDS[p] });
        b.addEventListener('click', () => {
          // (held by another point, it stays where it is on the screen: only what it is held by changes)
          const o = cur(), [gw, gh] = [st.told.game.w, st.told.game.h], r = place(o, gw, gh, st.told.least?.[st.tab]);
          const next = { anchor: o.anchor, origin: o.origin, [field]: p };
          set({ [field]: p, ...apart(next.anchor, next.origin, gw, gh, r.x, r.y, r.w, r.h) });
        });
        (ui.shows ??= []).push(() => b.classList.toggle('chosen', cur()[field] === p));
        g.append(b);
      }
      return g;
    };
    const cur = () => st.told.settings[st.tab];

    ui.tabs = el('div', { class: 'btnrow tabs' }, ...IDS.map((id) => {
      const b = el('button', { text: NAMES[id] });
      b.addEventListener('click', () => { st.tab = id; st.asking = null; show(); });
      (ui.shows ??= []).push(() => { b.classList.toggle('chosen', st.tab === id); b.textContent = `${NAMES[id]}${st.told.settings[id].shown ? ' ●' : ''}`; });
      return b;
    }));
    ui.key = el('button', { class: 'ovkey', title: 'The key that brings this overlay up and puts it away, wherever the keyboard is - in the game too. Click, then press the key you want (with Ctrl, Alt or Shift held, or one of F1 to F24). Esc leaves it as it is; Backspace takes the key away.' });
    ui.key.addEventListener('click', () => { st.asking = st.asking ? null : st.tab; if (st.asking) setTyping(true); show(); });
    ui.keyMsg = el('div', { class: 'small warn' });
    const shown = check('Shown over the game', 'Bring it up over the game’s window, or put it away. Its key does the same.', (o) => o.shown, (v) => set({ shown: v }));
    shown.append(ui.key);
    const pct = (k, text) => row(el('span', { class: 'grow', text }), number((o) => o.opacity[k], (v) => set({ opacity: { [k]: v } }), 5, 100), el('span', { text: '%' }));
    const thru = (k, text) => { const c = check(text, 'Clicks then go through it to the game, as if it were not there.', (o) => o.through[k], (v) => set({ through: { [k]: v } })); c.classList.remove('row'); c.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer'; return c; };
    ui.mini = el('div', { style: 'display:flex;flex-direction:column;gap:5px' },
      el('div', { class: 'btnrow shapes' }, ...SHAPES.map(([k, text]) => {
        const b = el('button', { text });
        b.addEventListener('click', () => { const o = cur(); set(k === 'circle' ? { shape: k, w: Math.min(o.w, o.h), h: Math.min(o.w, o.h) } : { shape: k }); });
        (ui.shows ??= []).push(() => b.classList.toggle('chosen', st.told.settings.mini.shape === k));
        return b;
      })),
      el('div', { class: 'btnrow' },
        check('Turn with me', 'The minimap keeps the way you face at its top. Its own switch: the map and the sidebar go by "Turn with me" under You.', () => st.told.settings.mini.turn, (v) => api.set({ mini: { turn: v } })),
        check('Auto-zoom', 'The minimap’s distance from you goes by the kind of place you are in (the three distances under You). Its own switch: unticked, it stays as far off as you zoom it with the wheel.', () => st.told.settings.mini.auto, (v) => api.set({ mini: { auto: v } }))));
    const reset = el('button', { text: 'Put it back where it comes', title: 'Where it lies, how big it is and what it is held by, as they were before anything was changed.' });
    reset.addEventListener('click', () => api.set({ [st.tab]: { anchor: null, origin: null, x: null, y: null, w: null, h: null } }));
    box.append(ui.note, ui.tabs, shown, ui.keyMsg,
      check('Pinned: it cannot be moved or resized', 'Unpinned, drag it by its head (the sidebar) or the grip at its top (the map, the minimap - which can be dragged anywhere), and resize it by its bottom right corner. It stays inside the game’s window.', (o) => o.pinned, (v) => set({ pinned: v })),
      pct('still', 'Opacity standing still'), pct('moving', 'Opacity while moving'), pct('combat', 'Opacity in a fight'),
      row(el('span', { class: 'grow', text: 'Clicks go through it' }), thru('moving', 'moving'), thru('combat', 'in a fight')),
      row(el('span', { class: 'grow', text: 'Held to the game window’s', title: 'The point of the game’s window it is held to (the first grid), and the point of the overlay itself that is held there (the second). Resize the game’s window, and it keeps its distance from that point.' }), grid('anchor', 'The point of the game’s window it is held to'),
        el('span', { text: 'by its own', title: 'The point of the overlay itself that is held there.' }), grid('origin', 'The point of the overlay itself that is held there')),
      row(el('span', { class: 'grow', text: 'Apart, across and down' }), number((o) => o.x, (v) => set({ x: v }), -20000, 20000), number((o) => o.y, (v) => set({ y: v }), -20000, 20000), el('span', { text: 'px' })),
      row(el('span', { class: 'grow', text: 'Size' }), number((o) => o.w, (v) => set(st.tab === 'mini' && cur().shape === 'circle' ? { w: v, h: v } : { w: v }), 80, 20000), el('span', { text: '×' }), number((o) => o.h, (v) => set(st.tab === 'mini' && cur().shape === 'circle' ? { w: v, h: v } : { h: v }), 80, 20000), el('span', { text: 'px' })),
      ui.mini, reset);
    // (a key is being pressed for an overlay)
    window.addEventListener('keydown', (e) => {
      if (!st.asking) return;
      e.preventDefault(); e.stopPropagation();
      const id = st.asking;
      if (e.key === 'Escape') { st.asking = null; setTyping(false); show(); return; }
      if (e.key === 'Backspace') { st.asking = null; setTyping(false); api.set({ [id]: { hotkey: '' } }); return; }
      const k = keyOf(e);
      if (!k) return; // (a key that only holds, or one no overlay can have: still waiting)
      st.asking = null;
      setTyping(false);
      api.set({ [id]: { hotkey: k } });
    }, true);
  }

  /** The section, as things stand. */
  function show() {
    if (MINI || !st.built || !api || !st.told) return;
    const t = st.told, o = t.settings[st.tab];
    for (const f of ui.shows ?? []) f();
    ui.mini.style.display = st.tab === 'mini' ? 'flex' : 'none';
    ui.key.classList.toggle('asking', st.asking === st.tab);
    ui.key.textContent = st.asking === st.tab ? 'Press the key…' : keyWords(o.hotkey);
    const given = t.keys?.[st.tab];
    ui.keyMsg.textContent = o.hotkey && given === false ? 'Windows would not give this key to the overlay: another program has it, or another overlay. Choose another.' : '';
    // (a key held for an overlay is taken from every other program: so they are held only while the game runs)
    ui.keyMsg.className = o.hotkey && given === false ? 'small warn' : 'small dim';
    if (!ui.keyMsg.textContent && o.hotkey && t.keysHeld === false) ui.keyMsg.textContent = 'The keys work while the game is running: with no game there, none is taken from other programs.';
    const up = IDS.filter((id) => t.settings[id].shown).length;
    $('ovNow').textContent = up ? `${up} up` : '';
    ui.note.textContent = t.game.minimized ? 'The game is minimized: the overlays are put away until it is back.'
      : t.game.from === 'game' ? `Drawn over the game’s window (${t.game.w} × ${t.game.h}), and kept inside it.`
      : `No game window is to be seen: an overlay brought up now lies over the main screen (${t.game.w} × ${t.game.h}), to be set up there.`;
  }

  /** The application has said how things stand. */
  function take(t) {
    if (!t || typeof t !== 'object' || !t.settings) return;
    const was = st.told;
    st.told = t;
    if (!MINI && !!was?.over !== !!t.over) note('overlay', t.over ? 'the page is over the game: the sidebar and the map as panels' : 'the page is back in its window', { game: t.game, shown: IDS.filter((id) => t.settings[id].shown) });
    lay();
    show();
  }

  build();
  if (api) {
    api.on(take);
    api.get().then(take, () => {});
    window.addEventListener('resize', () => { if (over()) lay(); });
    // (a window of the page's own that only the application's window can show - "Report a problem",
    // something gone wrong: the page goes back there for it)
    setInterval(() => {
      mood();
      if (over() && ($('fatal').style.display === 'flex' || $('report').style.display === 'flex')) api.dock();
    }, 250);
  }
  if (!api && MINI) { body.classList.add('mini'); html.classList.add('mini'); }
  return { heard, state: st, lay, take };
}
