// The overlays, as the page has them: the map drawn over the game.
//
// The application can bring three things up over the game's window, each with a key of its own
// (app/overlay.cjs has the window, the keys and the mouse; this is the page's side of it):
//
//   side   the sidebar, and everything in it
//   map    the map itself, full size
//   mini   the map small, and always on you: a minimap
//
// All three are THIS page - the one map there is - taken out of the application's window and
// laid over the game's in a see-through one the size of the game's window. There the page
// shows nothing but panels: its sidebar, and the box its map is in.
//
// One picture of the map, never two. The map's box is the full map or the minimap, not both:
// while the full map is up the minimap is put away, and is back when the full map is put away
// (if it was up before). So there is one map being drawn, at one size - nothing of it twice -
// and with either of them up, nothing at all is drawn in the application's own window, which
// only says that the map is over the game.
//
// Each panel lies where it was put: a point of the game's window (its top left corner, the
// middle of its right edge... nine to choose from) and a point of the panel itself are held so
// many pixels apart, so that a panel put in a corner is still in that corner when the game's
// window is resized. A panel that is not pinned can be dragged (the sidebar by its head, the
// map by the grip at its top, the minimap anywhere) and resized (the corner at its bottom
// right), inside the game's window and no further. Each is as clear or as faint as is set for
// standing still, for moving and for a fight, and can let clicks through while you move or
// fight. Whatever of the page can be clicked at the moment is told to the application, which
// lets the mouse through everywhere else.
//
// The full map can be set to lie behind the game's own interface. No window of another program
// can: what is done is that the map's box is left open wherever the game draws its interface -
// its bars and frames, and every window that is open - so that those show through and take
// their clicks (holesOf: the addon says where they are, through the strip, about a second
// after anything of it changes; the application is told what is left open, and lets the mouse
// through there).
//
// As a minimap the map is always on you, round or square, turning with you and zooming by the
// kind of place as is set for the minimap alone, from as far off as you last had it. The
// switches under "You" are the full map's (and the application's window's): they stand as they
// were, and the view as it was comes back with the full map.
//
// What is set is the application's to keep (the sidebar's "Overlay settings" shows and changes
// it); a page in a browser has no application behind it, and says so.
import { note } from './log.js';

const $ = (id) => document.getElementById(id);
const api = (typeof window !== 'undefined' && window.azerothAtlas?.overlay) || null;
export const IDS = ['side', 'map', 'mini'];
const NAMES = { side: 'Sidebar', map: 'Map', mini: 'Minimap' };
export const POINTS = ['tl', 'tc', 'tr', 'cl', 'cc', 'cr', 'bl', 'bc', 'br'];
const POINT_WORDS = { tl: 'top left corner', tc: 'top edge, middle', tr: 'top right corner', cl: 'left edge, middle', cc: 'middle', cr: 'right edge, middle', bl: 'bottom left corner', bc: 'bottom edge, middle', br: 'bottom right corner' };
const SHAPES = [['circle', 'Round'], ['rounded', 'Rounded'], ['square', 'Square']];
const MOVING_FOR = 700; // ms after the last sign of you moving that you still count as moving
const RIG_KEY = 'wfmap.minirig'; // how the minimap looks at you: how far off, how steeply, from which side
const frac = (c) => (c === 'l' || c === 't' ? 0 : c === 'c' ? 0.5 : 1);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Where an overlay lies inside the game's window: { x, y, w, h } from that window's top left
 * corner. Its anchor (a point of the game's window) and its origin (a point of its own) are
 * o.x and o.y apart. Kept inside the game's window, and no bigger than it.
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
 * Rectangles that may lie over one another ([left, top, right, bottom] each), as rectangles
 * that do not, covering the same ground: [{ x, y, w, h }]. (What is cut out of a panel is cut
 * out once: two cuts lying over each other would, the way such a shape is drawn, put the
 * ground they share back.)
 */
export function disjoint(rects) {
  const edges = (a, b) => [...new Set(rects.flatMap((r) => [r[a], r[b]]))].sort((p, q) => p - q);
  const xs = edges(0, 2), ys = edges(1, 3), out = [];
  let open = new Map(); // the stretches of the band above, each with the rectangle it is the foot of
  for (let j = 0; j + 1 < ys.length; j++) {
    const y1 = ys[j], y2 = ys[j + 1], cy = (y1 + y2) / 2, spans = [];
    let run = null;
    for (let i = 0; i + 1 < xs.length; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      if (rects.some((r) => cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3])) { if (run) run[1] = xs[i + 1]; else run = [xs[i], xs[i + 1]]; } else if (run) { spans.push(run); run = null; }
    }
    if (run) spans.push(run);
    const next = new Map();
    for (const [a, b] of spans) {
      const key = `${a},${b}`, above = open.get(key);
      // (the same stretch as in the band above: one rectangle, a band taller)
      if (above && above.y + above.h === y1) { above.h = y2 - above.y; next.set(key, above); } else { const q = { x: a, y: y1, w: b - a, h: y2 - y1 }; out.push(q); next.set(key, q); }
    }
    open = next;
  }
  return out;
}

/**
 * Where the game's own interface is drawn within a box of the overlay: the parts of the box
 * to leave open, so that the interface shows through and takes its clicks - [{ x, y, w, h }]
 * in the overlay's window, none lying over another.
 * @param ui   what the game says of its interface (the server's strip.js: ui): { r: [left, top,
 *             right, bottom, ... each edge as so many 1023rds of the game's picture] } - or null
 * @param box  { x, y, w, h } in the overlay's window, which lies over the whole of the game's
 *             picture (gw by gh)
 * @param pad  pixels left open round each part: the game's frames have edges and glows that
 *             reach a little past the place the game gives for them
 */
export function holesOf(ui, box, gw, gh, pad = 3) {
  const r = ui?.r;
  if (!Array.isArray(r) || r.length < 4 || !(gw > 0) || !(gh > 0)) return [];
  const rects = [];
  for (let i = 0; i + 3 < r.length; i += 4) {
    const x1 = Math.max(box.x, Math.floor((r[i] / 1023) * gw) - pad), y1 = Math.max(box.y, Math.floor((r[i + 1] / 1023) * gh) - pad);
    const x2 = Math.min(box.x + box.w, Math.ceil((r[i + 2] / 1023) * gw) + pad), y2 = Math.min(box.y + box.h, Math.ceil((r[i + 3] / 1023) * gh) + pad);
    if (x2 - x1 >= 2 && y2 - y1 >= 2) rects.push([x1, y1, x2, y2]);
  }
  return disjoint(rects);
}

/** A box with parts of it cut out, as the shape it is drawn within (for the box's own style: its corner is 0, 0). */
export function cutPath(box, holes) {
  return `path(evenodd, "M0 0H${box.w}V${box.h}H0Z${holes.map((q) => `M${q.x - box.x} ${q.y - box.y}h${q.w}v${q.h}h${-q.w}Z`).join('')}")`;
}

/**
 * Which of the three are on the screen, by what is set to be shown: the full map and the
 * minimap are one picture, and the full map comes first.
 */
export function upOf(settings) {
  return { side: !!settings.side.shown, map: !!settings.map.shown, mini: !!settings.mini.shown && !settings.map.shown };
}

/**
 * A key pressed, as the application asks Windows for it ("Control+Alt+F2") - or null: not a key
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
/** ...and as it is shown: "Ctrl + Alt + F2". */
export const keyWords = (k) => (k ? k.replace(/Control/g, 'Ctrl').replace(/Super/g, 'Win').replace(/^num(\d)$/, 'Numpad $1').replace(/\+num(\d)$/, '+Numpad $1').split('+').join(' + ') : 'none');

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else if (k in e) e[k] = v; else e.setAttribute(k, v); }
  e.append(...kids);
  return e;
};

export function bindOverlays(app) {
  const st = {
    told: null,         // how things stand, as the application last said: { settings, game, over, keys, keysHeld, least }
    tab: 'side',        // the overlay whose settings the sidebar shows
    asking: null,       // the overlay a key is being pressed for
    movedAt: -1e9, at: null, combat: false, how: 'still',
    drag: null,         // a panel being dragged or resized: { id, kind, rect, ... }
    form: null,         // what the map's box is just now, over the game: 'map', 'mini' or null (put away)
    gameSaid: '', typing: false, built: false, rects: '',
    uiSaid: '',         // where the game's interface is, as last heard (see heard)
    holes: 0,           // how many parts of the map are left open for it just now
    cut: '',            // ...and the shape the map's box is cut to for that ('' whole)
  };
  const html = document.documentElement, body = document.body;
  const over = () => !!st.told?.over;
  const size = () => [window.innerWidth, window.innerHeight];

  // ---- how you are doing: still, moving, in a fight --------------------------------------------
  /** The game has said something (player.js): where its window is goes to the application; whether you move or fight is kept. */
  function heard() {
    const s = app.player?.state, p = s?.player;
    if (api && s) {
      const said = JSON.stringify([s.status, s.window ?? null]);
      if (said !== st.gameSaid) { st.gameSaid = said; api.game({ status: s.status, window: s.window ?? null }); }
    }
    // (where the game's own interface is has changed - a window opened, a bag shut: the map that
    // lies behind the interface is left open somewhere else)
    const ui = s?.ui && Array.isArray(s.ui.r) ? `${s.ui.n}:${s.ui.r.join()}` : '';
    if (ui !== st.uiSaid) { st.uiSaid = ui; if (over() && st.told?.settings.map.below) { lay(); show(); } }
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

  // ---- the map as a minimap, and as the map again -----------------------------------------------
  // One map, one view. As a minimap it is on you, from where the minimap was last looked at
  // from, turning and zooming as is set for the minimap; what the map's own view and following
  // were is kept meanwhile, and put back when it is the map again.
  let rig = { dist: 140, pitch: -70, heading: 0 };
  try { const r = JSON.parse(localStorage.getItem(RIG_KEY)); if (r && [r.dist, r.pitch, r.heading].every(Number.isFinite)) rig = { dist: clamp(r.dist, 6, 60000), pitch: clamp(r.pitch, -89.5, -5), heading: ((r.heading % 360) + 360) % 360 }; } catch { /* as it comes */ }
  let kept = null;
  const keepRig = () => {
    const r = app.player?.rig;
    if (!app.miniForm || !r || (r.dist === rig.dist && r.pitch === rig.pitch && r.heading === rig.heading)) return;
    rig = { dist: r.dist, pitch: r.pitch, heading: r.heading };
    try { localStorage.setItem(RIG_KEY, JSON.stringify(rig)); } catch { /* not remembered */ }
  };
  function asMini(on) {
    const P = app.player, cam = app.camera;
    if (!P || !cam || !!app.miniForm === on) return;
    if (on) {
      kept = { rig: P.rig ? { ...P.rig } : null, map: app.scene?.map.id ?? null, pos: [...cam.pos], heading: cam.heading, pitch: cam.pitch };
      app.miniForm = true;
      const o = st.told.settings.mini;
      P.turn = !!o.turn; P.auto = !!o.auto;
      P.rig = { ...rig };
      P.setFollow(true);
    } else {
      keepRig();
      app.miniForm = false;
      const k = kept;
      kept = null;
      // (turning and zooming as the switches under "You" have them; following, if that is what was set)
      if ($('optFollow').checked) { P.rig = k?.rig ? { ...k.rig } : null; app.applyFollow?.(); P.setFollow(true); }
      else {
        P.setFollow(false);
        app.applyFollow?.();
        // (the view as it was, where that is still the map being looked at)
        if (k && app.scene?.map.id === k.map) { cam.anim = null; cam.pos = k.pos; cam.heading = k.heading; cam.pitch = k.pitch; cam.rev = (cam.rev ?? 0) + 1; }
      }
    }
    app.dirty = true;
  }

  // ---- the page over the game: its panels ------------------------------------------------------
  const through = (o) => (st.how === 'still' ? false : !!o.through?.[st.how]) && !st.drag;
  const rectOf = (id) => (st.drag?.id === id ? st.drag.rect : place(st.told.settings[id], ...size(), st.told.least?.[id]));

  /** Everything put where and how it is set. */
  function lay() {
    const t = st.told, on = over();
    html.classList.toggle('ov', on);
    body.classList.toggle('ov', on);
    const up = on ? upOf(t.settings) : { side: false, map: false, mini: false };
    const form = up.map ? 'map' : up.mini ? 'mini' : null;
    st.form = form;
    // (with neither the map nor the minimap up there is nothing to draw: main.js, step - and what is
    // drawn over the game is drawn at the pace of a map that is not the window in front: mayDraw)
    app.noDraw = on && !form;
    app.overGame = on;
    asMini(form === 'mini');
    body.classList.toggle('ov-mini', form === 'mini');
    for (const [k] of SHAPES) body.classList.toggle(`ov-shape-${k}`, form === 'mini' && t.settings.mini.shape === k);
    if (!on || form !== 'map' || !t.settings.map.below) { if (st.cut) { st.cut = ''; $('mapBox').style.clipPath = ''; } st.holes = 0; }
    if (!on) { if (st.rects !== '[]' && api) { st.rects = '[]'; api.rects([]); } app.dirty = true; return; }
    if (form === 'mini') { const o = t.settings.mini, P = app.player; if (P && (P.turn !== !!o.turn || P.auto !== !!o.auto)) { P.turn = !!o.turn; P.auto = !!o.auto; } }
    const list = [];
    // the sidebar
    {
      const o = t.settings.side;
      body.classList.toggle('ov-noside', !up.side);
      body.classList.toggle('ov-pin-side', !!o.pinned);
      const r = rectOf('side');
      for (const k of ['x', 'y', 'w', 'h']) html.style.setProperty(`--ov-side-${k}`, `${r[k]}px`);
      html.style.setProperty('--ov-side-o', String(o.opacity[st.how] / 100));
      if (up.side && !through(o)) list.push(r);
    }
    // the map's box: the full map, or the minimap
    body.classList.toggle('ov-nomap', !form);
    if (form) {
      const o = t.settings[form];
      body.classList.toggle('ov-pin-map', !!o.pinned);
      const r = rectOf(form);
      for (const k of ['x', 'y', 'w', 'h']) html.style.setProperty(`--ov-map-${k}`, `${r[k]}px`);
      html.style.setProperty('--ov-map-o', String(o.opacity[st.how] / 100));
      // The map set to lie behind the game's own interface: no window of another program can, so
      // it is left open wherever the game draws its interface (the addon says where: holesOf) -
      // the interface shows through there, and a click there is the game's.
      let holes = [];
      if (form === 'map' && o.below) {
        holes = holesOf(app.player?.state?.ui, r, ...size());
        const shape = holes.length ? cutPath(r, holes) : '';
        // (set only when it is another shape: the browser writes it in its own way, so what is set is remembered here)
        if (shape !== st.cut) { st.cut = shape; $('mapBox').style.clipPath = shape; }
        st.holes = holes.length;
      }
      // (round: its corners are the game's to click)
      if (!through(o)) list.push(form === 'mini' && o.shape === 'circle' ? { ...r, round: true } : holes.length ? { ...r, holes } : r);
    }
    const said = JSON.stringify(list);
    if (said !== st.rects) { st.rects = said; api?.rects(list); }
    tools();
    app.dirty = true;
  }

  // ---- a panel's handles: to move it by, to pin it, to put it away, to resize it ----------------
  const handles = {};
  const boxId = () => st.form ?? 'map';
  function tools() {
    const s = st.told?.settings;
    if (handles.made) { handles.pinSide.classList.toggle('on', !!s?.side.pinned); handles.pinBox.classList.toggle('on', !!s?.[boxId()].pinned); return; }
    handles.made = true;
    const make = (id, box, grip) => {
      const pin = el('button', { text: '\u{1F4CC}', title: 'Pin it where it is: it cannot be moved or resized until it is unpinned' });
      const shut = el('button', { text: '×', title: 'Put it away (its key brings it back)' });
      pin.addEventListener('click', () => api?.set({ [id()]: { pinned: !st.told.settings[id()].pinned } }));
      shut.addEventListener('click', () => api?.set({ [id()]: { shown: false } }));
      const bar = el('div', { class: 'ovtools' }, pin, shut);
      for (const b of [pin, shut]) b.addEventListener('pointerdown', (e) => e.stopPropagation());
      const corner = el('div', { class: 'ovsize', title: 'Drag to resize' });
      box.append(bar, corner);
      if (grip === true) { grip = el('div', { class: 'ovgrip', title: 'Drag to move' }); box.append(grip); }
      grip.addEventListener('pointerdown', (e) => begin(e, id(), 'move'));
      corner.addEventListener('pointerdown', (e) => begin(e, id(), 'size'));
      return pin;
    };
    handles.pinSide = make(() => 'side', $('side'), $('sideHead'));
    handles.pinBox = make(boxId, $('mapBox'), true);
    tools();
  }

  /** A drag begins: of the panel itself, or of its corner. */
  function begin(e, id, kind) {
    const t = st.told, o = t?.settings[id];
    if (e.button !== 0 || !o || o.pinned || !over() || e.target.closest?.('button, input, select, a')) return;
    e.preventDefault(); e.stopPropagation();
    const [gw, gh] = size();
    const rect = place(o, gw, gh, t.least?.[id]);
    st.drag = { id, kind, rect: { ...rect }, from: rect, sx: e.screenX, sy: e.screenY, gw, gh, least: t.least?.[id] ?? [80, 80] };
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
      lay();
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
  // (as a minimap: a left drag of the map moves the minimap, not the view off you - and a click drops
  // no marker; the right button swings the view, the wheel zooms)
  $('mapBox').addEventListener('pointerdown', (e) => {
    if (!app.miniForm || e.button !== 0 || e.target.closest?.('.ovtools, .ovsize, .ovgrip')) return;
    e.stopPropagation();
    begin(e, 'mini', 'move');
  }, true);
  $('mapBox').addEventListener('dblclick', (e) => { if (app.miniForm) e.stopPropagation(); }, true);

  // ---- the keyboard, while it is over the game --------------------------------------------------
  // The overlay's window never takes the keyboard from the game - until you click into something
  // to type in. Then it does, and gives it back when you leave that (Esc, or a click elsewhere).
  const typed = (t) => !!t?.closest?.('input:not([type=checkbox]):not([type=color]):not([type=radio]), textarea, select') || !!t?.closest?.('.ovkey.asking');
  const setTyping = (on) => { if (st.typing !== on && over()) { st.typing = on; api?.typing(on); } else if (!on) st.typing = false; };
  document.addEventListener('pointerdown', (e) => { if (over() && typed(e.target)) setTyping(true); }, true);
  document.addEventListener('focusout', () => { setTimeout(() => { if (st.typing && !typed(document.activeElement) && !st.asking) setTyping(false); }, 120); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.typing && !st.asking && typed(document.activeElement)) document.activeElement.blur(); });
  window.addEventListener('blur', () => { if (st.typing) { if (typed(document.activeElement)) document.activeElement.blur(); st.asking = null; setTyping(false); show(); } });

  // ---- what is set: the sidebar's section -----------------------------------------------------
  const ui = {};
  function build() {
    const box = $('ovBody');
    if (!box || st.built) return;
    st.built = true;
    ui.note = el('div', { id: 'ovNote', class: 'dim small' });
    if (!api) {
      ui.note.textContent = 'The overlays are drawn over the game by the Azeroth Atlas application: the sidebar, the map and a minimap, each brought up with a key. This page is open in a browser, which cannot draw over the game.';
      box.append(ui.note);
      return;
    }
    const set = (patch) => api.set({ [st.tab]: patch });
    const row = (...kids) => el('div', { class: 'row' }, ...kids);
    const cur = () => st.told.settings[st.tab];
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

    ui.tabs = el('div', { class: 'btnrow tabs' }, ...IDS.map((id) => {
      const b = el('button', { text: NAMES[id] });
      b.addEventListener('click', () => { st.tab = id; st.asking = null; show(); });
      // (a dot: on the screen; a ring: set to be shown, and put away while the full map is up)
      (ui.shows ??= []).push(() => { const up = upOf(st.told.settings); b.classList.toggle('chosen', st.tab === id); b.textContent = `${NAMES[id]}${up[id] ? ' ●' : st.told.settings[id].shown ? ' ○' : ''}`; });
      return b;
    }));
    ui.key = el('button', { class: 'ovkey', title: 'The key that brings this overlay up and puts it away, wherever the keyboard is - in the game too. Click, then press the key you want (with Ctrl, Alt or Shift held, or one of F1 to F24). Esc leaves it as it is; Backspace takes the key away.' });
    ui.key.addEventListener('click', () => { st.asking = st.asking ? null : st.tab; if (st.asking) setTyping(true); show(); });
    ui.keyMsg = el('div', { class: 'small warn' });
    ui.only = el('div', { class: 'small dim' });
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
    // (the map alone: over the game's own interface, as it comes - or behind it)
    ui.below = check('Behind the game’s interface', 'Unticked, the map lies over everything in the game: your bars, your bags, any window you open. Ticked, it looks as if it lay behind the game’s interface: wherever the game draws its bars, frames and open windows the map is left open, so that they show through - and a click there is the game’s, not the map’s. The addon in the game says where the interface is, about a second after it changes.', () => st.told.settings.map.below, (v) => api.set({ map: { below: v } }));
    ui.belowNote = el('div', { class: 'small dim' });
    box.append(ui.note, ui.tabs, shown, ui.keyMsg, ui.only, ui.below, ui.belowNote,
      check('Pinned: it cannot be moved or resized', 'Unpinned, drag it by its head (the sidebar) or the grip at its top (the map; the minimap can be dragged anywhere), and resize it by its bottom right corner. It stays inside the game’s window.', (o) => o.pinned, (v) => set({ pinned: v })),
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
    if (!st.built || !api || !st.told) return;
    const t = st.told, o = t.settings[st.tab], up = upOf(t.settings);
    for (const f of ui.shows ?? []) f();
    ui.mini.style.display = st.tab === 'mini' ? 'flex' : 'none';
    // (behind the game's interface: the map's alone - and what the game says of where its interface is)
    ui.below.style.display = st.tab === 'map' ? '' : 'none';
    const said = app.player?.state?.ui, live = app.player?.state?.status === 'live';
    ui.belowNote.style.display = st.tab === 'map' && t.settings.map.below ? '' : 'none';
    ui.belowNote.textContent = !live ? 'It goes by what the game says of where its interface is: nothing is heard from the game just now, so the map lies over all of it.'
      : !said ? 'The game does not say where its interface is, so the map lies over all of it. That takes version 37 of the addon (Update addon, then start the game again: it has a new file), and /atlas windows on in the game if it was switched off there.'
        : `The game names ${said.r.length / 4} part${said.r.length === 4 ? '' : 's'} of the screen its interface is drawn in${up.map ? `; the map is left open in ${st.holes} place${st.holes === 1 ? '' : 's'}` : ''}.`;
    ui.key.classList.toggle('asking', st.asking === st.tab);
    ui.key.textContent = st.asking === st.tab ? 'Press the key…' : keyWords(o.hotkey);
    const given = t.keys?.[st.tab];
    ui.keyMsg.textContent = o.hotkey && given === false ? 'Windows would not give this key to the overlay: another program has it, or another overlay. Choose another.' : '';
    // (a key held for an overlay is taken from every other program: so they are held only while the game runs)
    ui.keyMsg.className = o.hotkey && given === false ? 'small warn' : 'small dim';
    if (!ui.keyMsg.textContent && o.hotkey && t.keysHeld === false) ui.keyMsg.textContent = 'The keys work while the game is running: with no game there, none is taken from other programs.';
    // (one picture of the map at a time)
    ui.only.textContent = st.tab === 'mini' && o.shown && t.settings.map.shown ? 'Put away while the full map is up: it is back when that is put away.'
      : st.tab === 'map' && o.shown && t.settings.mini.shown ? 'The minimap is put away while this is up, and comes back after it.'
      : st.tab !== 'side' ? 'The map and the minimap are one picture: only one of them is up at a time, the full map first.' : '';
    const count = IDS.filter((id) => up[id]).length;
    $('ovNow').textContent = count ? `${count} up` : '';
    ui.note.textContent = t.game.minimized ? 'The game is minimized: the overlays are put away until it is back.'
      : t.game.from === 'game' ? `Drawn over the game’s window (${t.game.w} × ${t.game.h}), and kept inside it.`
      : `No game window is to be seen: an overlay brought up now lies over the main screen (${t.game.w} × ${t.game.h}), to be set up there.`;
  }

  /** The application has said how things stand. */
  function take(t) {
    if (!t || typeof t !== 'object' || !t.settings) return;
    const was = st.told;
    st.told = t;
    // (over the game the keyboard is the game's: a key held as the page went there is never heard
    // let go of, and would drift the view from then on)
    if (!was?.over && t.over) app.camera?.keys.clear();
    lay();
    if (!!was?.over !== !!t.over || (was && JSON.stringify(upOf(was.settings)) !== JSON.stringify(upOf(t.settings)))) note('overlay', t.over ? `over the game: ${IDS.filter((id) => upOf(t.settings)[id]).map((id) => NAMES[id].toLowerCase()).join(', ') || 'nothing'}` : 'the page is back in its window', { game: t.game, set: IDS.filter((id) => t.settings[id].shown) });
    show();
  }

  build();
  if (api) {
    api.on(take);
    api.get().then(take, () => {});
    window.addEventListener('resize', () => { if (over()) lay(); });
    window.addEventListener('pagehide', keepRig);
    setInterval(() => {
      mood();
      // (as a minimap it is on you, whatever took the view elsewhere - a place searched for, a map chosen)
      if (app.miniForm) { const P = app.player; if (P?.live && !P.follow) P.setFollow(true); keepRig(); }
      // (a window of the page's own that only the application's window can show - "Report a problem",
      // something gone wrong: the page goes back there for it)
      if (over() && ($('fatal').style.display === 'flex' || $('report').style.display === 'flex')) api.dock();
    }, 250);
  }
  return { heard, state: st, lay, take };
}
