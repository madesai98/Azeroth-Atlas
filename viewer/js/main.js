// Application entry point: wires data, renderer, camera and UI together.
import { initGPU, resizeTargets, GLOBALS_SIZE } from './gpu.js';
import { TerrainRenderer } from './terrain.js';
import { MapScene, placed } from './scene.js';
import { Camera } from './camera.js';
import { Labels } from './labels.js';
import { ModelRenderer, ObjectLayer } from './models.js';
import { PlayerLink } from './player.js';
import { DangerLayer, BANDS } from './danger.js';
import { NpcLayer, NpcRenderer, makeIconSheet } from './npcs.js';
import { bindNpcs } from './npcui.js';
import { bindQuests } from './quests.js';
import { bindPrices } from './prices.js';
import { NpcFigures } from './npcfigures.js';
import { FloorFinder } from './floors.js';
import { TravelRoutes } from './travel.js';
import { Transit } from './transit.js';
import { TransitRenderer, CRAFT_LENGTH, CRAFT_MIN_PX } from './transitview.js';
import { FigureRenderer } from './figure.js';
import { RoutePlanner, RouteRenderer } from './route.js';
import { Trips, ROUTES, kindOf } from './trips.js';
import { InGameRoute } from './ingame.js';
import { LevelChooser } from './levels.js';
import { pickSurface } from './pick.js';
import { Cutaway } from './cutaway.js';
import { worldLayout, Ground, shareSea } from './joined.js';
import { viewProj, frustumPlanes, DEG, clamp } from './math.js';
import { note, changed } from './log.js';

const $ = (id) => document.getElementById(id);
const lin = (c) => c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); // sRGB -> linear

const SUN_DIR = (() => { const v = [-0.34, 0.42, 0.84]; const l = Math.hypot(...v); return v.map((x) => x / l); })();
const LIGHT = {
  sun: [1.02, 0.96, 0.86].map((v) => v * 1.25),
  sky: lin([0.52, 0.60, 0.74]),
  ground: lin([0.40, 0.37, 0.33]),
  fog: lin([0.72, 0.81, 0.92]),
  zenith: lin([0.25, 0.47, 0.82]),
};

const app = {
  gpu: null, terrain: null, scene: null, camera: null, labels: null,
  manifest: null, world: null, status: null,
  dirty: true, opts: { slope: false, contours: false, slopeDeg: 50, figure: true, figureDist: 150 },
  vp: new Float32Array(16), globals: new Float32Array(GLOBALS_SIZE / 4),
  pin: null, lastHover: 0, hoverDirty: true, t0: performance.now(),
  // The maps on the picture. Mostly one; two where the game's own world map shows two side by
  // side (the Eastern Kingdoms and Kalimdor: joined.js). `here` is the one in hand - `scene`,
  // `objects`, `danger` and `zones` are its - and `beside` the other, drawn `besideOff` yards over.
  open: new Map(), here: null, beside: null, besideOff: [0, 0], layout: new Map(), opening: 0,
};
window.__app = app; // handy for debugging from the console
const ZERO = [0, 0];
/** Where a map's origin lies on the picture, in the coordinates of the map in hand: [x, y], or null for a map not shown. */
app.offsetOf = (id) => (id === app.here?.id ? ZERO : id === app.beside?.id ? app.besideOff : null);
/** The view is being taken somewhere else on purpose (another map, a place searched for): the camera stops following your character. */
app.letGo = () => app.player?.setFollow(false);

function fatal(title, msg) {
  note('stopped', `${title}: ${msg}`);
  $('fatalTitle').textContent = title;
  $('fatalMsg').textContent = msg;
  $('fatal').style.display = 'flex';
}

// ---- the graphics card would not start, or was lost -------------------------------------------
// Said in plain words, with a button to try again - and tried again by itself a few times, a
// little later each time: it is mostly a passing thing (the card busy with the game, or with the
// page that was here a moment ago), and the map is often left open with nobody looking at it.
const GPU_TRIES_KEY = 'wfmap.gpuTries'; // (how often this tab has tried again by itself: kept across its reloads, forgotten once the map is up)
const GPU_WAITS = [15, 30, 60];         // seconds before each of those tries
const gpuTries = () => { try { return +sessionStorage.getItem(GPU_TRIES_KEY) || 0; } catch { return 0; } };
function gpuTrouble(title, msg, detail) {
  fatal(title, msg);
  note('gpu', title, { said: detail ?? null, triedAgainBefore: gpuTries() });
  $('fatalMore').textContent = detail ?? '';
  const again = $('fatalAgain');
  again.style.display = '';
  again.onclick = () => { try { sessionStorage.removeItem(GPU_TRIES_KEY); } catch { /* tried again all the same */ } location.reload(); };
  const n = gpuTries(), wait = GPU_WAITS[n];
  if (wait === undefined) return; // (it has been tried enough by itself: the button is there)
  let left = wait;
  const tick = () => {
    $('fatalMsg').textContent = `${msg} Trying again by itself in ${left} s.`;
    if (left-- > 0) { setTimeout(tick, 1000); return; }
    try { sessionStorage.setItem(GPU_TRIES_KEY, String(n + 1)); } catch { /* it tries once more than it should, at worst */ }
    location.reload();
  };
  tick();
}
/** What the card's refusal means, in words: [title, what to do]. */
function gpuWords(err) {
  if (err?.none) return ['WebGPU is required', err.message];
  const busy = /OUTOFMEMORY|out of memory|8007000E|device.?removed|DXGI_ERROR|887A000[5-7]/i.test(err?.message ?? '');
  return ['The graphics card would not start', busy
    ? 'Windows says the graphics card is out of memory. That mostly passes by itself: it happens when the game or another program has the card busy, and just after the map has been built. If it keeps happening, close what else is using the card (or lower the game\u2019s graphics settings) and try again.'
    : 'The graphics card refused to start drawing. Trying again often helps; so does updating the graphics driver.'];
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// ---- remembered between visits ------------------------------------------------------------
// Everything you set on the page is kept in the browser, and so is where you were looking: the
// server starting again, the browser starting again, the page loading itself again after an
// update of the map (reload.js) - none of them loses any of it.
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: just not remembered */ } },
};
const UI_KEY = 'wfmap.ui', VIEW_KEY = 'wfmap.view';
// The switches and numbers kept under UI_KEY, by the id of their input. (The NPC panel, the
// spawn zones, the figures and the route switches keep themselves, under keys of their own.)
const REMEMBERED = ['optFollow', 'optTurn', 'optAuto', 'zoomIn', 'zoomTown', 'zoomOut', 'optBuildings', 'optObjects', 'optTrees', 'optCut', 'cutRadius',
  'optLabels', 'optFlights', 'optTransit', 'optSlope', 'slopeDeg', 'optContours'];
/** Put the page's switches back as they were left. */
function recall() {
  const saved = store.get(UI_KEY);
  if (!saved || typeof saved !== 'object') return;
  for (const id of REMEMBERED) {
    const input = $(id), v = saved[id];
    if (!input || v === undefined || v === null) continue;
    if (input.type === 'checkbox') input.checked = !!v;
    else if (Number.isFinite(+v) && v !== '') input.value = v;
  }
}
/** Note how the page's switches stand now. */
function remember() {
  const out = {};
  for (const id of REMEMBERED) { const input = $(id); if (input) out[id] = input.type === 'checkbox' ? input.checked : input.value; }
  store.set(UI_KEY, out);
}

// ---- URL hash state ---------------------------------------------------------------------
function readHash() {
  const out = {};
  for (const part of location.hash.slice(1).split('&')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined && Number.isFinite(+v)) out[k] = +v;
  }
  return out;
}
let hashTimer = 0;
function writeHash() {
  // (noted a moment after the picture was drawn, and no more often than that - not "once the
  // picture has stood still": with the game running it is drawn several times a second, for as
  // long as you play)
  if (hashTimer) return;
  hashTimer = setTimeout(() => {
    hashTimer = 0;
    const c = app.camera;
    if (!app.scene) return;
    const h = `#m=${app.scene.map.id}&x=${c.pos[0].toFixed(1)}&y=${c.pos[1].toFixed(1)}&z=${c.pos[2].toFixed(1)}&h=${c.heading.toFixed(1)}&p=${c.pitch.toFixed(1)}`;
    history.replaceState(null, '', h);
    // (kept as well: the page opened afresh, without its address, starts where you left it)
    store.set(VIEW_KEY, { m: app.scene.map.id, x: +c.pos[0].toFixed(1), y: +c.pos[1].toFixed(1), z: +c.pos[2].toFixed(1), h: +c.heading.toFixed(1), p: +c.pitch.toFixed(1) });
  }, 400);
}

// ---- maps --------------------------------------------------------------------------------
/**
 * Which list a map belongs in. Decided from what the game data says about the map, so it keeps
 * working after updates: maps with zones on the in-game world map are the real open world;
 * maps that are a phase of another map or only have named areas are side content; maps with no
 * names at all (or labelled test/unused by the developers) go last.
 */
function mapGroup(m) {
  // "Scott Test", "CashTest", "<unused>..." are the developers' own labels
  const leftover = /(^|[^a-z])test\b|unused|nothing to see/i.test(m.name) || /[a-z]Test\b/.test(m.name) || (!(m.areas > 0) && !(m.zones > 0) && !(m.parent >= 0) && m.instanceType === 0);
  if (leftover) return 'Unused, test or unnamed';
  if (m.instanceType === 1) return 'Dungeons';
  if (m.instanceType === 2) return 'Raids';
  if (m.instanceType === 3) return 'Battlegrounds';
  return m.zones > 0 ? 'World' : 'World: phases and side areas';
}

function fillMapSelect() {
  const sel = $('map');
  sel.textContent = '';
  for (const label of ['World', 'World: phases and side areas', 'Dungeons', 'Raids', 'Battlegrounds', 'Unused, test or unnamed']) {
    const maps = app.manifest.maps.filter((m) => mapGroup(m) === label);
    if (!maps.length) continue;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const m of maps) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.name;
      og.append(o);
    }
    sel.append(og);
  }
}

/** The maps shown on one picture with a map: itself, and the one the game's world map has beside it (joined.js). */
function shownWith(id) {
  const g = app.layout.get(id);
  if (!g) return [id];
  const other = [...app.layout].find(([k, v]) => k !== id && v.group === g.group && app.manifest.maps.some((m) => m.id === k));
  return other ? [id, other[0]] : [id];
}

/** One map, opened: its terrain, what stands on it, its spawn zones and its named zones. */
async function openScene(entry) {
  const map = placed(await getJSON(`/data/maps/${entry.id}/map.json?v=${entry.rev}`));
  const scene = new MapScene(app.gpu, app.terrain, map, app.world, () => { app.dirty = true; });
  // Buildings and objects placed on this map.
  const objects = new ObjectLayer(app.models, scene, app.m2Radius);
  objects.enabled.buildings = $('optBuildings').checked;
  objects.enabled.objects = $('optObjects').checked;
  objects.enabled.trees = $('optTrees').checked;
  scene.objects = objects;
  // Spawn zones are painted onto the terrain of this map (each map has its own, all set alike).
  const danger = new DangerLayer();
  danger.set(JSON.parse(JSON.stringify(app.danger.settings)));
  scene.overlay = danger;
  const zones = app.world.zones.filter((z) => z.map === entry.id && z.type === 3);
  const s = {
    id: entry.id, entry, map, scene, objects, danger, zones, zoneByArea: new Map(zones.filter((z) => z.area).map((z) => [z.area, z])),
    at: app.layout.get(entry.id)?.at ?? [0, 0], // where it lies on a picture it shares with another map
  };
  danger.load(map).catch((err) => console.warn('creature data unavailable', err)).then(() => { if (app.here === s) showDangerSource(); app.dirty = true; });
  objects.load().then(() => { app.dirty = true; }).catch((err) => console.warn('building list unavailable', err));
  s.ready = scene.loadRoots();
  return s;
}

/**
 * Take one of the open maps in hand: from here on the page works in its coordinates (your
 * character, the route, the NPCs, the read-out), and the other open map, if there is one, is
 * drawn beside it. The camera goes on looking at the same spot of the picture.
 */
function takeInHand(s) {
  const was = app.here;
  const b = [...app.open.values()].find((o) => o !== s) ?? null;
  app.here = s; app.scene = s.scene; app.objects = s.objects; app.danger = s.danger;
  app.zones = s.zones; app.zoneByArea = s.zoneByArea;
  app.beside = b;
  app.besideOff = b ? [b.at[0] - s.at[0], b.at[1] - s.at[1]] : [0, 0];
  shareSea(s.scene, b?.scene ?? null, app.besideOff);
  for (const o of app.open.values()) o.objects.moving.length = 0;
  app.ground = new Ground(s.scene, b?.scene ?? null, app.besideOff);
  app.camera.scene = app.ground;
  if (was && was !== s && app.open.get(was.id) === was) app.camera.shift(was.at[0] - s.at[0], was.at[1] - s.at[1]);
  app.npcUi?.close();
  app.npcs.load(s.map).catch((err) => console.warn('NPC data unavailable', err)).then(() => { app.npcUi?.note(); app.dirty = true; });
  $('map').value = String(s.id);
  app.labels.setMaps([{ id: s.id, off: ZERO }, ...(b ? [{ id: b.id, off: app.besideOff }] : [])], app.world, app.ground);
  app.route?.setMap(s.map);
  app.trips?.setMap(s.map);
  // (a marker stays where it was dropped as long as its map is on the picture)
  if (app.pin && !app.open.has(app.pin.map)) setPin(null);
  app.goal = null;
  showDangerSource();
  app.dirty = true;
  app.hoverDirty = true;
}

/**
 * Show a map (with the one that shares its picture, where there is one) and take it in hand.
 * @param view  { x, y, z, h, p }: where the camera is to be, in the map's own coordinates. Without
 *              it: the whole map from above (flown to, where the map was on the picture already).
 */
async function openMap(id, view) {
  const entry = app.manifest.maps.find((m) => m.id === id) ?? app.manifest.maps.find((m) => m.kind === 'terrain');
  if (!entry) throw new Error('No map data has been extracted yet.');
  const ids = shownWith(entry.id);
  note('map', `opening ${entry.name} (map ${entry.id})`, { with: ids.filter((k) => k !== entry.id), asked: id });
  const turn = ++app.opening;
  const missing = ids.filter((k) => !app.open.has(k));
  let fresh = [];
  if (missing.length) {
    $('loading').style.display = 'block';
    fresh = await Promise.all(missing.map((k) => openScene(app.manifest.maps.find((m) => m.id === k))));
    // (another map was asked for while these were being fetched: that one is shown, not this)
    if (turn !== app.opening) { for (const s of fresh) s.scene.dispose(); return app.scene; }
  }
  for (const s of fresh) app.open.set(s.id, s);
  for (const [k, s] of app.open) if (!ids.includes(k)) { s.scene.dispose(); app.open.delete(k); }
  const here = app.open.get(entry.id);
  const onPicture = !!app.here && app.here !== here && app.open.get(app.here.id) === app.here; // (it was the map beside the one in hand)
  if (app.here !== here || fresh.length) takeInHand(here);
  if (view) {
    app.camera.pos = [view.x, view.y, view.z];
    app.camera.heading = view.h ?? 0;
    app.camera.pitch = view.p ?? -55;
    app.camera.anim = null;
  } else {
    // (two maps new on the picture: both of them, the sea between included)
    const b = { ...here.scene.bounds };
    let span = Math.max(b.x1 - b.x0, b.y1 - b.y0);
    if (app.beside && !onPicture) {
      const o = app.besideOff, q = app.beside.scene.bounds;
      b.x0 = Math.min(b.x0, q.x0 + o[0]); b.x1 = Math.max(b.x1, q.x1 + o[0]); b.y0 = Math.min(b.y0, q.y0 + o[1]); b.y1 = Math.max(b.y1, q.y1 + o[1]);
      // (side by side they are far wider than tall: as near as the window's shape lets both fit)
      span = Math.max(b.x1 - b.x0, (b.y1 - b.y0) / Math.max(0.3, app.camera.aspect));
    }
    app.camera.lookAt([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, here.scene.planeZ ?? 0], span * 1.05 + 400, 0, -62, onPicture);
  }
  app.dirty = true;
  await Promise.all([...app.open.values()].map((s) => s.ready));
  $('loading').style.display = 'none';
  app.dirty = true;
  return here.scene;
}

// ---- pacing --------------------------------------------------------------------------------
// The map shares the graphics card with the game, and the game comes first: while the game is
// the window in front, its frames are served before the map's. Sending the card frames faster
// than it hands them back only queues them up (the picture falls behind what is happening, then
// freezes while the queue drains). So:
//  - a new frame is not begun until the card has finished the last one;
//  - while the map is not the window in front it draws at most BACKGROUND_FPS times a second
//    (plenty for a map at your side, and it leaves the card to the game);
//  - if the card is still slow to hand frames back, the picture is drawn at a lower resolution
//    until it has time again (full resolution returns at once when you click on the map).
const BACKGROUND_FPS = 30;
const SLOW_MS = 45;                 // a frame taking longer than this to come back is "slow"
const QUICK_MS = 14;                // ...and quicker than this, there is time to spare
const SCALES = [1, 0.75, 0.5];      // the resolutions stepped through
const pace = { flying: 0, sent: 0, last: 0, ms: 0, slowSince: 0, quickSince: 0, upWait: 5000, wentUp: -1e9, frames: 0, fps: 0, fpsAt: 0 };
app.pace = pace;

/** True if a frame may be drawn now. */
function mayDraw(now) {
  const front = document.hasFocus();
  if (pace.flying >= (front ? 2 : 1)) {
    if (now - pace.sent < 1000) return false;
    pace.flying = 0; // (it never said it was done: do not wait for ever)
  }
  return front || now - pace.last >= 1000 / BACKGROUND_FPS - 2;
}

/** A frame has been sent to the card: time how long it takes to come back, and adjust to that. */
function sentFrame(gpu) {
  const sent = performance.now();
  pace.flying++; pace.sent = sent; pace.frames++;
  if (sent - pace.fpsAt >= 1000) { pace.fps = Math.round((pace.frames * 1000) / (sent - pace.fpsAt)); pace.frames = 0; pace.fpsAt = sent; }
  gpu.device.queue.onSubmittedWorkDone().then(() => {
    pace.flying = Math.max(0, pace.flying - 1);
    const now = performance.now();
    pace.ms += (now - sent - pace.ms) * 0.2;
    const level = Math.max(0, SCALES.indexOf(gpu.scale));
    if (pace.ms > SLOW_MS) {
      pace.quickSince = 0;
      if (!pace.slowSince) pace.slowSince = now;
      else if (now - pace.slowSince > 1500 && level < SCALES.length - 1) {
        // (going back up did not hold: wait longer before trying that again)
        if (now - pace.wentUp < 15000) pace.upWait = Math.min(120000, pace.upWait * 2);
        gpu.scale = SCALES[level + 1]; pace.slowSince = 0; pace.ms = 0; app.dirty = true;
      }
    } else {
      pace.slowSince = 0;
      if (pace.ms < QUICK_MS && level > 0) {
        if (!pace.quickSince) pace.quickSince = now;
        else if (now - pace.quickSince > pace.upWait) { gpu.scale = SCALES[level - 1]; pace.quickSince = 0; pace.wentUp = now; app.dirty = true; }
      } else pace.quickSince = 0;
    }
  }, () => { pace.flying = 0; });
}
// Back in front: full resolution again straight away.
window.addEventListener('focus', () => { pace.upWait = 5000; pace.slowSince = 0; pace.ms = 0; if (app.gpu && app.gpu.scale !== 1) { app.gpu.scale = 1; app.dirty = true; } });

// ---- rendering ---------------------------------------------------------------------------
function render() {
  const { gpu, camera, scene } = app;
  if (!scene || gpu.lost) return;
  resizeTargets(gpu);
  app.labels.resize();
  const b = camera.basis();
  const near = 0.5;
  viewProj(app.vp, b, camera.fov, gpu.width / gpu.height, near);
  const planes = frustumPlanes(app.vp, near);
  scene.update(camera.pos, planes);
  // A second map on the picture (the other continent): the same, with the camera where it is
  // in that map's coordinates. What it gives to draw is counted from the camera, like the first
  // map's, so the two lists are simply put together.
  const beside = app.beside, off = app.besideOff;
  const cam2 = beside ? [camera.pos[0] - off[0], camera.pos[1] - off[1], camera.pos[2]] : null;
  let draws = scene.draws, sea = scene.filler.subarray(0, scene.fillerCount * 24);
  if (beside) {
    beside.scene.update(cam2, planes);
    draws = scene.draws.concat(beside.scene.draws).sort((a, b) => a.dist - b.dist);
    const more = beside.scene.filler.subarray(0, beside.scene.fillerCount * 24);
    if (!app.seaBoth) app.seaBoth = new Float32Array(scene.filler.length + beside.scene.filler.length);
    app.seaBoth.set(sea);
    app.seaBoth.set(more, sea.length);
    sea = app.seaBoth.subarray(0, sea.length + more.length);
  }
  // The boats, zeppelins and trams that have been timed, each where it is this moment
  // (transit.js). Close up: the game's own model of the craft, placed like any building. From
  // further off, where that would be a speck: a plain shape, enlarged to stay easy to find.
  if (app.transit) {
    // (the one you are aboard is kept just where the game has it: you are on it)
    const ride = app.player?.height.ride;
    app.transit.riding = ride && !ride.flight && ride.path ? app.transit.byId.get(ride.path.id)?.n ?? null : null;
  }
  const afloat = app.transit && app.opts.transit !== false ? app.transit.onMap(app.offsetOf, mmss) : null;
  const shapes = [];
  app.objects.moving.length = 0;
  for (const c of afloat?.crafts ?? []) {
    const model = app.transit.model(c.line), m = model ? app.models.model(model.kind, model.id, 0) : null;
    const dist = Math.hypot(c.x - camera.pos[0], c.y - camera.pos[1], c.z - camera.pos[2]);
    const px = (CRAFT_LENGTH[c.line.kind] ?? 36) * gpu.canvas.clientHeight / (2 * Math.tan((camera.fov * DEG) / 2) * Math.max(dist, 0.01));
    if (m?.loaded && px >= CRAFT_MIN_PX) {
      const h = ((c.heading + (model.turn ?? 0)) * Math.PI) / 180, fx = Math.cos(h), fy = -Math.sin(h);
      app.objects.moving.push({ kind: model.kind, fdid: model.id, mat: [fx, -fy, 0, c.x, fy, fx, 0, c.y, 0, 0, 1, c.z] });
    } else shapes.push(c);
  }
  app.afloat = afloat?.crafts.length ?? 0;
  app.models.beginFrame();
  app.objects.collect(camera.pos, planes);
  if (beside) beside.objects.collect(cam2, planes);
  app.models.endFrame();

  const clearance = Math.max(0, camera.clearance());
  const g = app.globals;
  g.set(app.vp, 0);
  g.set(SUN_DIR, 16); g[19] = (performance.now() - app.t0) / 1000;
  g.set(LIGHT.sun, 20); g[23] = 0.000035 / (1 + clearance / 1200);
  g.set(LIGHT.sky, 24); g[27] = Math.cos(app.opts.slopeDeg * DEG);
  g.set(LIGHT.ground, 28); g[31] = (app.opts.slope ? 1 : 0) | (app.opts.contours ? 2 : 0);
  g.set(LIGHT.fog, 32); g[35] = clearance > 6000 ? 100 : clearance > 1500 ? 50 : 10;
  g[36] = camera.pos[2]; g[37] = (2 * Math.tan((camera.fov * DEG) / 2)) / gpu.height;
  g.set(LIGHT.zenith, 40);
  const ty = Math.tan((camera.fov * DEG) / 2), tx = ty * (gpu.width / gpu.height);
  g.set(b.r, 44); g[47] = tx;
  g.set(b.u, 48); g[51] = ty;
  g.set(b.f, 52);
  // Cutaway: what is taken off the picture so that your character can be seen (cutaway.js).
  app.cutaway.fill(g, 56, camera.pos);
  gpu.device.queue.writeBuffer(gpu.globalsBuffer, 0, g);

  const encoder = gpu.device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: gpu.colorView,
      resolveTarget: gpu.context.getCurrentTexture().createView({ format: gpu.colorFormat }),
      clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard',
    }],
    depthStencilAttachment: { view: gpu.depthView, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  });
  app.terrain.drawTerrain(pass, draws, [0, 0, -camera.pos[2]]);
  app.models.drawOpaque(pass);
  // (the whole journey: its lines on the map beside this one too, each where that map lies on the picture)
  const layout = `${app.here?.id}|${app.beside?.id}`;
  app.trips.draw(pass, camera, app.offsetOf, layout); // (the routes to the other places you could be heading for: trips.js)
  app.questUi.draw(pass, camera, app.offsetOf, layout); // (a quest's own route, plotted from the quest explorer: quests.js)
  app.routeRenderer.draw(pass, app.route, camera, app.offsetOf, layout);
  // You, as a figure standing in the world once the camera is close (the flat arrow from further away).
  const live = app.player?.markers() ?? null;
  // Where each route ends: marked in its colour, with what is left of the way there.
  app.wayMark = null; // (where your waypoint's route ends in this picture: for a right-click on it)
  if (live) {
    live.targets = [];
    for (const r of app.trips.active()) {
      const t = r.target, off = t ? app.offsetOf(t.map) : null;
      if (!off || !r.planner.enabled) continue;
      const left = r.planner.route ? r.planner.remaining() : null;
      // (where the route ends: on the level chosen, and beside the spot if the spot itself is a roof or a wall)
      const at = t.go ?? [t.x, t.y, t.z ?? r.planner.route?.target?.[2] ?? undefined];
      live.targets.push({ x: at[0] + off[0], y: at[1] + off[1], z: at[2] ?? app.ground.heightAt(t.x + off[0], t.y + off[1]) ?? 0, color: r.color,
        text: `${r.lead || !t.name ? '' : `${t.name} · `}${left ? `${Math.round(left.yards)} yd · ${clock(left.seconds)}` : ''}` });
      if (r.kind === 'waypoint') { const mark = live.targets[live.targets.length - 1]; app.wayMark = { x: mark.x, y: mark.y, z: mark.z }; }
    }
  }
  if (live?.player && app.opts.figure && !live.player.beside) {
    const m = live.player, away = Math.hypot(m.x - camera.pos[0], m.y - camera.pos[1], m.z - camera.pos[2]);
    // (a little slack so it does not flicker between the two right at the limit)
    app.figureOn = away < app.opts.figureDist * (m.flight ? FLIGHT_REACH : 1) * (app.figureOn ? 1.08 : 1);
    if (app.figureOn) { app.figure.draw(pass, m, camera, (performance.now() - app.t0) / 1000); m.figure = true; }
  } else app.figureOn = false;
  // The same for everyone else: close up, NPCs and quest objects stand in the world as figures
  // (their signs, smaller, over their heads); from further off they are the signs alone.
  app.npcs.figureDist = app.opts.figure ? app.opts.figureDist : 0;
  app.npcFigures.draw(pass, app.npcs, camera, app.npcs.figureDist);
  if (shapes.length) app.transitView.draw(pass, shapes, camera);
  // (the routes' lines, for the water to be behind where they are in front of it: a flight over a river)
  app.routeRenderer.cover(pass);
  app.trips.cover(pass);
  app.questUi.cover(pass);
  app.terrain.drawWater(pass, draws, sea);
  // (the rest of a journey - on the other continent, across the sea - over the water it crosses)
  app.routeRenderer.drawRest(pass);
  app.trips.drawRest(pass);
  app.questUi.drawRest(pass);
  app.models.drawTransparent(pass);
  app.npcRenderer.draw(pass, app.npcs, camera);
  pass.end();
  gpu.device.queue.submit([encoder.finish()]);
  sentFrame(gpu);
  app.drawn = (app.drawn ?? 0) + 1;
  app.models.pump();

  app.labels.live = live;
  app.labels.notes = app.npcs.count ? app.npcs.names(camera.pos) : [];
  // what each craft is doing, over it, and at each dock when its next one comes
  if (afloat) {
    const far = 2500 + clearance * 4;
    for (const c of afloat.crafts) app.labels.notes.push({ kind: 'npc', name: c.text, x: c.x, y: c.y, z: c.z, lift: c.line.kind === 'zeppelin' ? 30 : c.line.kind === 'tram' ? 8 : 26, minDist: 0, maxDist: far * 2, prio: 70, color: '#ffe9a3' });
    for (const d of afloat.docks) app.labels.notes.push({ kind: 'npc', name: d.text, x: d.x, y: d.y, z: d.z, lift: 12, minDist: 0, maxDist: far, prio: 60, color: '#bfe6ff' });
  }
  // the marker you dropped: where it is on the picture (it may be on the map beside the one in hand)
  const pinOff = app.pin ? app.offsetOf(app.pin.map) : null;
  app.labels.pins = !pinOff ? [] : pinOff === ZERO ? [app.pin] : [{ ...app.pin, x: app.pin.x + pinOff[0], y: app.pin.y + pinOff[1] }];
  app.labels.draw(camera.pos, app.vp, clearance);
  let s = scene.stats;
  if (beside) { const q = beside.scene.stats; s = { nodes: s.nodes + q.nodes, tris: s.tris + q.tris, loaded: Math.min(s.loaded, q.loaded), pending: (s.pending ?? 0) + (q.pending ?? 0) }; }
  const ms = app.models.stats, pending = (s.pending ?? 0) + app.models.pending;
  const text = `${((s.tris + ms.tris) / 1000).toFixed(0)}k tris · ${ms.instances} objects · ${s.nodes + ms.draws} draws${pending ? ` · loading ${pending}` : ''}${gpu.scale < 1 ? ` · ${Math.round(gpu.scale * 100)}% resolution (graphics card busy)` : ''}`;
  if (text !== app.perfText) { app.perfText = text; $('perf').textContent = text; }
  $('loading').style.display = s.pending > 0 && s.loaded < 4 ? 'block' : 'none';
  app.hoverDirty = true;
  writeHash();
}

const SWAP_BELOW = 20000; // yards up: below this, the map you look at is taken in hand (see frame)
const FLIGHT_REACH = 5;   // on a flight path you are a figure from this many times as far as on the ground: what flies you is that much bigger than you
let lastTime = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  step(now, true);
}

// The map goes on working while nobody can see it. A page that is not on show - its window
// behind the game on the one screen there is, or minimized - is given no frames to draw, and
// everything here used to hang on those: where you are, the routes, what the game is sent. So
// the game got no route unless the map happened to be in view. Now a worker keeps time beside
// the frames (its clock is not held back as a hidden page's own is), and when no frame has come
// for a moment the same step is taken from there - all of it but the picture, which is drawn
// once a second at most: nobody is looking, and it keeps the ground under you loaded.
const UNSEEN_AFTER = 350; // ms without a frame: the page is not being shown
const UNSEEN_DRAW = 1000; // ms between pictures drawn while it is not
let unseenDrawn = 0;
function startTicking() {
  try {
    const ticker = new Worker(new URL('./tick.js', import.meta.url));
    ticker.onmessage = () => {
      const now = performance.now();
      if (now - lastTime >= UNSEEN_AFTER || app.unseen) step(now, false);
    };
    app.ticker = ticker;
  } catch (err) { console.warn('no timekeeper beside the frames: the map only works while it is on show', err); }
}

/** One step of everything: where you are, the routes, what the game is sent - and, when the page is on show (seen), the picture. */
function step(now, seen) {
  // (unseen: frames have stopped coming; over as soon as one comes again)
  if (seen) app.unseen = false;
  else if (!app.unseen) { app.unseen = true; unseenDrawn = now; }
  app.steps = (app.steps ?? 0) + 1; // (how many steps have been taken, and - app.drawn - pictures drawn: for the tests)
  // (noted once a minute - log.js: how the drawing goes)
  if (now - (app.paceAt ?? -1e9) > 60000) {
    if (app.paceAt !== undefined) note('pace', app.perfText ?? '', { pictures: (app.drawn ?? 0) - app.paceDrawn, steps: app.steps - app.paceSteps, inSight: seen, resolution: app.gpu?.scale, memoryMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : undefined });
    app.paceAt = now; app.paceDrawn = app.drawn ?? 0; app.paceSteps = app.steps;
  }
  const dt = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (app.camera.update(dt)) app.dirty = true;
  if (app.player?.update(dt)) app.dirty = true;
  if (app.cutaway?.update(dt, now)) app.dirty = true;
  // (boats on this map are moving: drawn again some fifteen times a second; their countdowns alone, once a second)
  if (app.transit?.known && now - (app.transitAt ?? 0) > (app.afloat ? 66 : 1000)) { app.transitAt = now; app.dirty = true; }
  if (app.npcs?.meeting) app.npcs.update(app.player?.live ? app.player.me : null, app.player.height);
  // Two maps on the picture: the one you are looking at is the one in hand (its NPCs, its
  // places and zones under the cursor, the map routes are worked out on). Not while your
  // character is on the one in hand, though: then that one stays, or your route would go.
  // (Nor from high up, where both are in view and nothing that depends on it can be made out.)
  if (app.beside && !app.camera.anim && app.camera.pos[2] < SWAP_BELOW && !app.player?.switching && !(app.player?.live && app.player.onThisMap)) {
    const c = app.camera, f = c.basis().f, o = app.besideOff;
    // (where the middle of the view meets the sea; looking level or up, where the camera is)
    const t = f[2] < -0.05 && c.pos[2] > 0 ? Math.min(60000, -c.pos[2] / f[2]) : 0;
    const x = c.pos[0] + f[0] * t, y = c.pos[1] + f[1] * t;
    if (!app.scene.hasTile(x, y) && app.beside.scene.hasTile(x - o[0], y - o[1])) takeInHand(app.beside);
  }
  // Under the terrain (a city inside a mountain, a cave)? Then the level you are on is the camera's ground.
  {
    const P = app.player, s = P?.onThisMap && P.shown && app.scene ? P.shown : null;
    const over = s ? app.scene.heightAt(s[0], s[1]) : null;
    app.camera.under = s && over !== null && s[2] < over - 4 ? { x: s[0], y: s[1], z: s[2], r: 300 } : null;
  }
  if (app.route && app.scene) {
    // Where you are heading: the waypoint the game reports, else a marker clicked on this map.
    const P = app.player, me = P?.live && P.onThisMap && P.shown ? P.shown : app.routeFrom ?? null;
    const marker = app.pin ? {
      map: app.pin.map, x: app.pin.x, y: app.pin.y, z: app.pin.exact ? app.pin.z : undefined, name: app.pin.exact ? app.pin.name : undefined, source: 'marker',
      // (hint: the height of the surface that was clicked; quick: no question about the level; stamp: a new one with every click)
      hint: app.pin.hit, quick: app.pin.quick, stamp: app.pin.stamp,
    } : null;
    // One waypoint of your own, wherever it was placed - a Ctrl-click or a Shift-click on the
    // game's map, a click on this one: the newest takes the place of the one before.
    const gw = (P?.live ? P.heads : null)?.waypoint ?? null;
    const gwKey = gw ? `${gw.map},${gw.x.toFixed(1)},${gw.y.toFixed(1)}` : '';
    if (gwKey !== (app.gameWay?.key ?? '')) {
      app.gameWay = { key: gwKey, at: Date.now(), spot: gw };
      // (one placed in the game since the marker was dropped here: the marker is done with -
      // unless it is that very marker, which the game has taken up as its waypoint)
      if (gw && app.pin && !samePlace(gw, app.pin)) setPin(null, null, false, false, undefined, true);
    }
    if (app.wayDropped && !samePlace(gw, app.wayDropped)) app.wayDropped = null; // (the game has let go of it too)
    const taken = samePlace(gw, app.pin);                                         // the game's waypoint is the marker dropped here
    const newer = !!app.pin && !!gw && !taken && app.pin.at > app.gameWay.at;     // the marker was dropped after the game's waypoint was placed: that one is done with
    const gone = samePlace(gw, app.wayDropped);                                   // taken off here: the game's is done with too
    // (what the game is told when it next asks for a route - ingame.js: take this marker up as
    // your waypoint; or let go of the waypoint you have)
    app.markerForGame = app.pin && (!gw || taken || newer) ? { stamp: app.pin.at, map: app.pin.map, x: app.pin.x, y: app.pin.y, placed: Math.floor(app.pin.at / 1000) }
      : gone ? { stamp: app.wayDropped.at, off: true, placed: Math.floor(app.wayDropped.at / 1000) } : null;
    // What the game is heading for - but not a waypoint of its own that is done with; and the
    // marker it has taken up is still the marker, on the level that was chosen for it here.
    let fromGame = P?.target ?? null;
    if (fromGame && fromGame.source !== 'guide' && (newer || gone) && samePlace(gw, fromGame)) fromGame = null;
    else if (fromGame && taken && samePlace(fromGame, app.pin) && app.pin.z !== undefined) fromGame = { ...fromGame, z: app.pin.z, name: app.pin.exact ? app.pin.name : undefined };
    let target = fromGame ?? app.routeTo ?? marker;
    // Which kind of route that is: to your guide's step, or to a waypoint of your own. It leads -
    // it is the one the game follows - and this planner has it; the others are trips.js's.
    const leadKind = target?.source === 'guide' ? 'guide' : 'waypoint';
    app.route.enabled = app.routesOn !== false && app.trips.on(leadKind);
    // A waypoint from the game is a spot on the map with no height, and a building has several
    // floors under one spot. If someone the map knows stands there, it is them you are heading
    // for, on the floor they are on (worked out once per waypoint, and again when the NPCs change).
    if (target && target.z === undefined && target.source !== 'marker' && target.map === app.scene.map.id && app.npcs.data) {
      const key = `${target.map},${target.x.toFixed(1)},${target.y.toFixed(1)},${app.npcs.rev}`;
      if (app.goal?.key !== key) app.goal = { key, who: app.npcs.at(target.x, target.y) };
      if (app.goal.who) target = { ...target, z: app.goal.who.z, name: app.goal.who.name, guess: app.goal.who.src <= 1 };
    }
    // Still no height: which of the levels at that spot is meant (levels.js)? The marker stands on the one chosen.
    const level = app.levels.resolve(target, me);
    target = level.target;
    if (target?.source === 'marker' && target.z !== undefined && app.pin && !app.pin.exact && app.pin.z !== target.z) { app.pin.z = target.z; app.dirty = true; }
    app.routeTarget = target;
    app.route.update(me, level.hold ? null : target, P?.speeds);
    // The other places you could be heading for, as the game names them (player.js: heads): a
    // route to each. (From an addon that names only the one that leads, there are no others.)
    const want = {}, heads = P?.live ? P.heads : null, here = app.scene.map.id;
    if (heads && me) {
      if (heads.guide) want.guide = { ...heads.guide, source: 'guide' };
      if (gw && !taken && !newer && !gone) want.waypoint = { ...gw, source: 'pin' };
      if (heads.quest) {
        // (how far it has got, as the game says: what is done is not led to any more)
        const g = app.npcs.questGoal(heads.quest, me, heads.tracked?.id === heads.quest ? heads.tracked : null);
        // (g.map: a dungeon's door on another map than this one - the way there is a journey)
        if (g) want.quest = { map: g.map ?? here, x: g.x, y: g.y, z: g.z ?? undefined, name: `${app.npcs.quests?.quests?.[heads.quest]?.n ?? 'Quest'}: ${g.done ? 'hand in to ' : ''}${g.name}`, source: 'quest' };
      }
      if (heads.corpse && P.state.player?.dead) want.death = { ...heads.corpse, name: 'Your body', source: 'corpse' };
    }
    // Which quest the routes of this moment were worked out for, and how far it had got: said to
    // the game with them (ingame.js). The game knows that at first hand - it hears of a thing
    // done before this page does - and so can tell the route from before from the one it waits for.
    app.questFor = heads ? { id: heads.quest ?? 0, state: heads.tracked?.id === heads.quest ? heads.tracked.state : 0, done: heads.tracked?.id === heads.quest ? heads.tracked.done : 0 } : null;
    // (noted when it changes - log.js: what the routes of the moment are worked out for)
    if (changed('quest', app.questFor)) note('quest', app.questFor?.id ? `the quest you track: ${app.npcs.quests?.quests?.[app.questFor.id]?.n ?? app.questFor.id}` : 'no quest is tracked', { ...app.questFor, asTheGameSays: heads?.tracked ?? null, leadsTo: want.quest ? { name: want.quest.name, at: [Math.round(want.quest.x), Math.round(want.quest.y)] } : null, knownToTheMap: !!app.npcs.quests?.quests?.[app.questFor?.id] });
    if (changed('lead', [leadKind, target?.source ?? null, !!app.route.enabled])) note('route', target ? `the route that leads is the one to your ${leadKind === 'guide' ? "guide's step" : 'waypoint'}` : 'nothing leads: the game has no waypoint, and no marker is dropped here', { said: target?.source ?? null, drawn: app.route.enabled });
    if (changed('marker', app.markerForGame)) note('route', app.markerForGame ? (app.markerForGame.off ? 'the game is to let go of its waypoint (taken off here)' : 'the marker dropped here is offered to the game as its waypoint') : 'no marker of this map is offered to the game', app.markerForGame ?? undefined);
    // (a marker dropped here is a waypoint of your own too, where the game has none)
    if (!want.waypoint && marker && leadKind !== 'waypoint') want.waypoint = marker;
    if (P?.live && me) for (const m of P.state.party ?? []) if (m.x !== null && m.x !== undefined) want[`ally${m.slot}`] = { map: here, x: m.x, y: m.y, name: m.name ?? `Party ${m.slot}`, source: 'ally' };
    app.trips.update(me, leadKind, want, P?.speeds, app.routesOn !== false);
    app.questUi.frame(P?.speeds);
    if (now - (app.routesShownAt ?? 0) > 1000) { app.routesShownAt = now; showRoutes(); }
    // the same route, for the game's own map and minimap
    app.ingame?.update();
  }
  if (!seen) {
    // not on show: a picture now and then, and nothing of what only a look at it is for
    if (app.dirty && now - unseenDrawn >= UNSEEN_DRAW && mayDraw(now)) {
      unseenDrawn = now;
      app.dirty = false;
      pace.last = now;
      // (a picture that cannot be drawn unseen is not a failure of the map: tried again in a while)
      try { render(); } catch (err) { console.warn('no picture while the map is not on show', err); unseenDrawn = now + 30000; }
    }
    return;
  }
  if (app.dirty && mayDraw(now)) {
    app.dirty = false;
    pace.last = now;
    try { render(); } catch (err) { console.error(err); fatal('Rendering failed', err.message); return; }
  }
  if (app.hoverDirty && now - app.lastHover > 60) { app.hoverDirty = false; app.lastHover = now; updateReadout(); }
  if (now - (app.zoomShownAt ?? 0) > 200) { app.zoomShownAt = now; showZoom(); }
}

// ---- read-out ----------------------------------------------------------------------------
/**
 * Which of the maps on the picture a spot is on, and where on that map: { on (the open map),
 * x, y }. The spot is in the coordinates of the map in hand; it is on the map beside it where
 * that one has land (or sea of its own) and the one in hand has not.
 */
function spotOn(p) {
  const b = app.beside, o = app.besideOff;
  if (b && !app.scene.hasTile(p[0], p[1]) && b.scene.hasTile(p[0] - o[0], p[1] - o[1])) return { on: b, x: p[0] - o[0], y: p[1] - o[1] };
  return { on: app.here, x: p[0], y: p[1] };
}

function zoneAt(x, y, on = app.here) {
  let best = null, bestArea = Infinity;
  for (const z of on?.zones ?? []) {
    const [minX, minY, maxX, maxY] = z.region;
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const a = (maxX - minX) * (maxY - minY);
    if (a < bestArea) { best = z; bestArea = a; }
  }
  return best;
}
const zoneCoords = (z, x, y) => [((z.region[3] - y) / (z.region[3] - z.region[1])) * 100, ((z.region[2] - x) / (z.region[2] - z.region[0])) * 100];
const zoneToWorld = (z, cx, cy) => [z.region[2] - (cy / 100) * (z.region[2] - z.region[0]), z.region[3] - (cx / 100) * (z.region[3] - z.region[1])];

/** The map zone an area belongs to (walks up the area hierarchy), or null. */
function zoneForArea(id, on = app.here) {
  const areas = app.world.areas;
  for (let i = 0; i < 8 && id; i++) {
    const z = on.zoneByArea.get(id);
    if (z) return z;
    id = areas[id]?.p;
  }
  return null;
}

/** What a place is called. @param p [x, y] on the map `on` (one of the open maps; the one in hand unless said) */
function describe(p, on = app.here) {
  const areas = app.world.areas;
  const id = on.scene.areaAt(p[0], p[1]);
  // Zone rectangles overlap their neighbours, so prefer the game's own area id for this spot.
  const zone = zoneForArea(id, on) ?? zoneAt(p[0], p[1], on);
  let place = '';
  if (id && areas[id]) {
    const a = areas[id];
    place = a.n;
    const parent = a.p && areas[a.p] ? areas[a.p].n : null;
    if (parent && parent !== a.n) place += `, ${parent}`;
  } else if (zone) place = zone.name;
  let coords = '';
  if (zone) { const [cx, cy] = zoneCoords(zone, p[0], p[1]); coords = `${zone.name}  ${cx.toFixed(1)}, ${cy.toFixed(1)}`; }
  return { place, coords, zone };
}

function updateReadout() {
  const { camera, scene } = app;
  if (!scene) return;
  // (flying freely there is no pointer: what the ring in the middle of the view is on)
  const aiming = camera.flyLook || (app.pointing && !!camera.mouse);
  const m = camera.flyLook || !camera.mouse ? [camera.canvas.clientWidth / 2, camera.canvas.clientHeight / 2] : camera.mouse;
  const p = aiming ? camera.pickAt(m[0], m[1]) : null;
  app.npcHover = aiming && app.npcs.count ? app.npcs.pick(camera.pos, app.vp, camera.canvas.clientWidth, camera.canvas.clientHeight, m[0], m[1]) : -1;
  $('npcLine').textContent = app.npcUi?.hover(app.npcHover) ?? '';
  // (on your waypoint's mark: said, with how to take it away)
  const onWay = aiming && app.npcHover < 0 && !camera.flyLook && onWaypoint(camera.mouse);
  if (onWay) $('npcLine').textContent = 'Your waypoint. Right-click to take it away (Esc does the same).';
  camera.canvas.style.cursor = app.npcHover >= 0 || onWay ? 'pointer' : '';
  const zoneInfo = $('zoneInfo');
  // The read-out is there only while the pointer is on the map and on something in the world:
  // off the page, over the sidebar, or on the open sky there is nothing to say.
  $('readout').classList.toggle('on', !!p);
  if (!p) { $('place').textContent = ' '; $('coords').textContent = ' '; $('worldpos').textContent = ' '; zoneInfo.textContent = ''; return; }
  // Which creatures make this spot dangerous (for the groups you have selected).
  // (the spot may be on the map beside the one in hand: it is read out in that map's own coordinates)
  const spot = spotOn(p);
  const zone = spot.on.danger.at(spot.x, spot.y);
  if (zone) {
    const lv = (c) => (c.min === c.max ? c.max : `${c.min}-${c.max}`);
    // "~" = level estimated from its zone
    const shown = zone.creatures.slice(0, 3).map((c) => `${c.name} ${c.estimated ? '~' : ''}${lv(c)}${c.rank ? ` ${c.rank}` : ''}`);
    zoneInfo.textContent = `Spawns here (${BANDS[zone.band].label.toLowerCase()}): ${shown.join(', ')}${zone.creatures.length > 3 ? ` +${zone.creatures.length - 3} more` : ''}`;
    zoneInfo.style.color = `rgb(${BANDS[zone.band].color.join(',')})`;
  } else zoneInfo.textContent = '';
  const d = describe([spot.x, spot.y], spot.on);
  $('place').textContent = d.place || spot.on.map.name;
  $('coords').textContent = d.coords || ' ';
  const whole = (v) => Math.round(v) || 0; // (never "-0")
  let line = `X ${whole(spot.x)}  Y ${whole(spot.y)}  elevation ${whole(p[2])}`;
  if (app.beside) line = `${spot.on.map.name}:  ${line}`;
  if (app.pin?.map === spot.on.id) line +=`  ·  ${Math.hypot(spot.x - app.pin.x, spot.y - app.pin.y, p[2] - app.pin.z).toFixed(0)} yd from marker`;
  $('worldpos').textContent = line;
}

/**
 * @param quick  a marker dropped with Shift held: it goes on the level nearest your own height,
 *               with no question asked (as a Shift-click on the game's map does)
 */
// p: [x, y, z] on the map `on` (one of the open maps; the one in hand unless said), or null to take the marker away
/** Is this the same place, to within a step? ({ map, x, y } each) */
const samePlace = (a, b) => !!a && !!b && a.map === b.map && Math.hypot(a.x - b.x, a.y - b.y) < 1.5;

/**
 * Take your waypoint away, from here - whichever side it was placed on: the marker dropped on
 * this map, or the waypoint placed in the game. It goes here at once. The game cannot be told
 * anything unasked, so there it goes when the game next asks for a route (/atlas route asks at
 * once); until then it is simply not shown here. True if there was one to take away.
 */
function clearWaypoint() {
  const g = app.gameWay?.spot ?? null;
  if (app.pin) { setPin(null); return true; }
  if (g && !samePlace(g, app.wayDropped)) { app.wayDropped = { map: g.map, x: g.x, y: g.y, at: Date.now() }; app.dirty = true; return true; }
  return false;
}
/** Where your waypoint is in the picture, in pixels of the map's canvas ([x, y]) - or null: you have none, or it is not in view. */
function waypointAt() {
  // (the marker dropped here is your waypoint where there is one - also with no game running, when no route is drawn to it; else where the waypoint's route ends)
  const off = app.pin ? app.offsetOf(app.pin.map) : null;
  const w = app.pin && off ? { x: app.pin.x + off[0], y: app.pin.y + off[1], z: app.pin.z } : app.wayMark, m = app.vp, c = app.camera;
  if (!w || !m || !c) return null;
  const p = [w.x - c.pos[0], w.y - c.pos[1], w.z - c.pos[2]];
  const X = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], Y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], W = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (!(W > 0)) return null;
  return [(X / W * 0.5 + 0.5) * c.canvas.clientWidth, (0.5 - Y / W * 0.5) * c.canvas.clientHeight];
}
const WAY_REACH = 26; // pixels from your waypoint's mark within which the pointer is on it
/** Is the pointer on your waypoint's mark? (mouse: [x, y] on the canvas) */
function onWaypoint(mouse) {
  const at = mouse ? waypointAt() : null;
  // (the mark stands a little above the spot, with its words over it: the reach is a circle round where it is drawn)
  return !!at && Math.hypot(mouse[0] - at[0], mouse[1] - (at[1] - 10)) <= WAY_REACH;
}

/** @param byGame  (taking it off) a waypoint newly placed in the game has taken its place: nothing of the game's is to be let go of */
function setPin(p, name = null, exact = false, quick = false, on = app.here, byGame = false) {
  if (!p) {
    // Taken off by you, where it had become the game's waypoint too - or had taken the place of
    // an older one of the game's: the game is to let go of its waypoint as well (it is told
    // when it next asks for a route), and until it has, that waypoint is not shown here.
    const g = app.gameWay?.spot;
    if (app.pin && !byGame && g && (samePlace(g, app.pin) || app.pin.at > app.gameWay.at)) app.wayDropped = { map: g.map, x: g.x, y: g.y, at: Date.now() };
    app.pin = null; app.labels.pins = []; app.dirty = true;
    return;
  }
  const d = describe(p, on);
  app.pinStamp = (app.pinStamp ?? 0) + 1;
  app.wayDropped = null;
  // (at: when it was dropped - which of it and a waypoint placed in the game is the newer goes by this)
  app.pin = { kind: 'pin', map: on.id, exact, quick, hit: p[2], stamp: app.pinStamp, at: Date.now(), name: name || d.coords || `${p[0].toFixed(0)}, ${p[1].toFixed(0)}`, x: p[0], y: p[1], z: p[2], lift: 2, prio: 1000, minDist: 0, maxDist: Infinity };
  app.dirty = true;
}

// ---- search ------------------------------------------------------------------------------
function buildSearchIndex() {
  const mapName = Object.fromEntries(app.manifest.maps.map((m) => [m.id, m.name]));
  const have = new Set(app.manifest.maps.map((m) => m.id));
  const idx = [];
  const seen = new Set();
  const add = (label, sub, map, pos, dist, pitch) => {
    const key = `${label}|${map}|${sub}`;
    if (!label || !have.has(map) || seen.has(key)) return;
    seen.add(key);
    idx.push({ label, lower: label.toLowerCase(), sub, map, pos, dist, pitch });
  };
  for (const z of app.world.zones) {
    if (z.type !== 3) continue;
    const [minX, minY, maxX, maxY] = z.region;
    add(z.name, 'Zone', z.map, [(minX + maxX) / 2, (minY + maxY) / 2, null], Math.max(maxX - minX, maxY - minY) * 0.85, -58);
  }
  for (const p of app.world.pois) add(p.name, mapName[p.map] ?? 'Place', p.map, p.pos, 450, -38);
  for (const t of app.world.taxiNodes) add(t.name, 'Flight master', t.map, t.pos, 320, -35);
  for (const m of app.manifest.maps) idx.push({ label: m.name, lower: m.name.toLowerCase(), sub: 'Map', map: m.id, pos: null });
  app.searchIndex = idx;
}

function search(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const m = /^(-?\d+(?:\.\d+)?)[\s,]+(-?\d+(?:\.\d+)?)$/.exec(q);
  if (m) {
    const a = +m[1], b = +m[2];
    const c = app.camera, center = c.pickAt(c.canvas.clientWidth / 2, c.canvas.clientHeight / 2);
    // (the numbers are taken as a place on the map you are looking at: with two on the picture, that may be the one beside the one in hand)
    const spot = center ? spotOn(center) : { on: app.here };
    const zone = center ? describe([spot.x, spot.y], spot.on).zone : null;
    const out = [];
    if (zone && a >= 0 && a <= 100 && b >= 0 && b <= 100) {
      const [x, y] = zoneToWorld(zone, a, b);
      out.push({ label: `${zone.name} ${a}, ${b}`, sub: 'Map coords', map: spot.on.id, pos: [x, y, null], dist: 260, pitch: -45, pin: true });
    }
    out.push({ label: `World X ${a}, Y ${b}`, sub: 'World coords', map: spot.on.id, pos: [a, b, null], dist: 400, pitch: -45, pin: true });
    return out;
  }
  const cur = app.scene?.map.id;
  return app.searchIndex
    .filter((e) => e.lower.includes(q))
    .sort((x, y) => (y.lower.startsWith(q) - x.lower.startsWith(q)) || ((y.map === cur) - (x.map === cur)) || x.label.length - y.label.length)
    .slice(0, 12);
}

async function goTo(entry) {
  app.letGo(); // (going to look at a place ends the following of your character)
  if (entry.map !== app.scene.map.id) await openMap(entry.map);
  if (!entry.pos) return;
  const z = entry.pos[2] ?? app.scene.heightAt(entry.pos[0], entry.pos[1]) ?? 0;
  const p = [entry.pos[0], entry.pos[1], z];
  app.camera.lookAt(p, entry.dist ?? 400, 0, entry.pitch ?? -45);
  if (entry.pin) setPin(p);
}

function bindSearch() {
  const input = $('search'), list = $('results');
  let results = [], sel = 0;
  const show = () => {
    list.textContent = '';
    results.forEach((r, i) => {
      const li = document.createElement('li');
      if (i === sel) li.className = 'sel';
      const a = document.createElement('span'), b = document.createElement('span');
      a.textContent = r.label; b.textContent = r.sub;
      li.append(a, b);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });
      list.append(li);
    });
  };
  const choose = (i) => {
    const r = results[i];
    if (!r) return;
    input.value = ''; results = []; show(); input.blur();
    goTo(r).catch((err) => fatal('Could not open map', err.message));
  };
  input.addEventListener('input', () => { results = search(input.value); sel = 0; show(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); show(); e.preventDefault(); }
    else if (e.key === 'Enter') choose(sel);
    else if (e.key === 'Escape') { input.value = ''; results = []; show(); input.blur(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { results = []; show(); }, 150));
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape' && document.activeElement !== input) { clearWaypoint(); $('help').style.display = 'none'; }
  });
}

// ---- the map tool's own version, and bringing it up to date (server/appupdate.js) --------------
function showApp(a) {
  const line = $('appLine'), btn = $('appUpdate');
  if (!a) { line.style.display = 'none'; btn.style.display = 'none'; return; }
  const name = `Map tool ${a.version}${a.commit ? ` (${a.commit})` : ''}`;
  const looked = a.checkedAt ? `, looked ${new Date(a.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  $('appMsg').textContent = a.state === 'updating' ? `${name}: putting in the newer one…`
    : a.state === 'checking' ? `${name}: looking for a newer one…`
    : a.error ? `${name}. Could not look for a newer one: ${a.error}`
    : a.note ? `${name}. ${a.note}`
    : a.updated && Date.now() - a.updated.at < 600000 ? `${name}: just updated`
    : a.checkedAt ? `${name}: up to date${looked}`
    : name; // (it has not looked yet: nothing is claimed)
  $('appMsg').title = a.from ? `Updated from ${a.from}${a.kind === 'git' ? ' (with git)' : ''}${a.auto ? ', by itself' : ': only when you say ("autoUpdate": false in config.json)'}` : '';
  line.style.display = '';
  $('appCheck').style.display = a.state === 'idle' ? '' : 'none';
  // (the button: only where it is not put in by itself - switched off, or put off for something)
  btn.style.display = a.available && a.canApply && a.state === 'idle' ? '' : 'none';
}

// ---- the first start on a computer where the game could not be found (server/setup.js) ----------
function showSetup(st) {
  const s = st.setup;
  for (const id of ['map', 'search', 'results', 'update', 'progress', 'updateMsg']) $(id).style.display = 'none';
  $('setup').style.display = '';
  $('setupWhy').textContent = `${s.message}. Tell the map where it is:`;
  if (s.configured && !$('setupGame').value) $('setupGame').value = s.configured;
  $('setupData').placeholder = s.dataDir;
  $('loading').textContent = 'The map needs to know where the game is installed: see the sidebar.';
  $('loading').style.display = 'block';
  document.body.classList.add('setup'); // (nothing else in the sidebar has anything to work with yet)
  document.querySelector('details.sec[data-sec="map"]').open = true;
  document.body.classList.remove('side-shut');
  if (showSetup.bound) return;
  showSetup.bound = true;
  const save = async () => {
    const msg = $('setupMsg');
    msg.className = 'small dim';
    msg.textContent = 'Checking…';
    try {
      const res = await fetch('/api/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installRoot: $('setupGame').value, dataDir: $('setupData').value }) });
      const d = await res.json();
      if (!d.ok) { msg.className = 'small warn'; msg.textContent = d.error ?? 'That did not work.'; return; }
      msg.className = 'small good';
      msg.textContent = 'Saved. Starting the map…';
      $('setupSave').disabled = true;
      // (the server starts again as itself: the page loads again once it is there)
      const wait = async () => { try { const now = await getJSON('/api/status'); if (!now.setup) { location.reload(); return; } } catch { /* on its way */ } setTimeout(wait, 700); };
      setTimeout(wait, 900);
    } catch (err) { msg.className = 'small warn'; msg.textContent = `Could not save: ${err.message}`; }
  };
  $('setupSave').addEventListener('click', save);
  for (const id of ['setupGame', 'setupData']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// ---- "Check for updates": everything, in turn ----------------------------------------------
// One button that brings up to date whatever is not, and leaves alone what is:
//   1. Azeroth Atlas itself (server/appupdate.js: a newer version is fetched and put in);
//   2. the map's data (built again where the game, the QuestieDB addon or the map tool has moved on);
//   3. the addon in the game (installed or updated - it is the one that came with this version);
//   4. guide packs made for Guidelime (converted, so that the addon runs them).
// An update of the map tool, and a new build of the map, load the page again: where the run has
// got to is kept for the tab (sessionStorage), and it carries on from there when the page is back.
const RUN_KEY = 'wfmap.checkRun';
const RUN_MAX = 45 * 60 * 1000; // (a run left over from longer ago than this is not taken up again)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function showRun(run) {
  const box = $('checkLines');
  box.replaceChildren(...run.lines.filter(Boolean).map((l) => { const d = document.createElement('div'); d.className = l.cls ?? ''; d.textContent = l.text; return d; }));
}
async function checkAll(resume = null) {
  const btn = $('checkAll');
  if (btn.disabled && !resume) return;
  const run = resume ?? { step: 1, at: Date.now(), lines: [] };
  const keep = () => { try { sessionStorage.setItem(RUN_KEY, JSON.stringify(run)); } catch { /* it starts over after a reload, that is all */ } };
  const say = (i, text, cls = 'busy') => { run.lines[i] = { text, cls }; showRun(run); keep(); if (cls !== 'busy') note('check', text); };
  const post = async (url) => { const res = await fetch(url, { method: 'POST' }); return res.json(); };
  // (the server starts itself again when its own code has been updated: asked until it answers)
  const status = async () => { for (let i = 0; ; i++) { try { return await getJSON('/api/status'); } catch (err) { if (i > 40) throw err; await sleep(700); } } };
  btn.disabled = true;
  btn.textContent = 'Checking…';
  showRun(run);
  try {
    // 1. Azeroth Atlas itself
    if (run.step <= 1) {
      say(0, 'Azeroth Atlas: looking for a newer version…');
      try { await post('/api/app/check?apply=1'); } catch { /* on its way back: asked below */ }
      let a = null;
      for (let i = 0; i < 400; i++) { await sleep(600); a = (await status()).app; if (!a || a.state === 'idle') break; say(0, a.state === 'updating' ? 'Azeroth Atlas: putting in the newer version…' : 'Azeroth Atlas: looking for a newer version…'); }
      const name = a ? `Azeroth Atlas ${a.version}${a.commit ? ` (${a.commit})` : ''}` : 'Azeroth Atlas';
      const updated = a?.updated && a.updated.at >= run.at - 2000;
      if (!a) say(0, 'Azeroth Atlas: this copy cannot look for a newer version', 'warn');
      else if (a.error) say(0, `${name}: could not look for a newer version (${a.error})`, 'warn');
      else if (updated) say(0, `${name}: updated just now`, 'good');
      else if (a.available) say(0, `${name}. ${a.note ?? 'A newer version is out.'}`, 'warn');
      else say(0, `${name}: up to date${a.note ? `. ${a.note}` : ''}`, a.note ? '' : 'good');
      run.step = 2; keep();
      // (its own files changed: the page loads itself again in a moment, and this carries on from step 2)
      if (updated) await sleep(4000);
    }
    // 2. the map's data
    if (run.step <= 2) {
      let st = await status();
      if (st.setup) { say(1, 'Map: tell Azeroth Atlas where the game is first (above), then check again', 'warn'); run.step = 99; }
      else {
        const needed = !st.extracted || st.updateAvailable;
        if (needed && !st.job.running && !run.building) {
          run.building = st.extracted ? 'update' : 'build';
          say(1, st.extracted ? 'Map: updating…' : 'Map: building it from your game (the first time takes a good while)…');
          await post('/api/update');
        }
        if (run.building) {
          for (;;) {
            await sleep(700);
            st = await status();
            if (!st.job.running) break;
            say(1, `Map: ${run.building === 'build' ? 'building' : 'updating'}… ${st.job.phase}${st.job.total ? ` ${Math.round((st.job.done / st.job.total) * 100)}%` : ''}`);
          }
          if (st.job.error) say(1, `Map: the ${run.building} failed (${st.job.error})`, 'warn');
          else say(1, run.building === 'build' ? 'Map: built' : 'Map: updated', 'good');
          run.step = 3; keep();
          // (new map data: the page loads itself again to show it - by itself, a moment after the build ends - and this carries on from step 3)
          if (!st.job.error && st.job.summary?.changed) { await sleep(2500); location.reload(); return; }
        } else { say(1, 'Map: up to date', 'good'); run.step = 3; keep(); }
      }
    }
    // 3. the addon in the game, and 4. the guide packs
    if (run.step <= 3) {
      const packs = (n) => `${n} guide pack${n === 1 ? '' : 's'}`;
      let a = await getJSON('/api/addon');
      if (a.error || !a.available) say(2, `Addon: ${a.error ?? a.reason ?? 'the game\u2019s AddOns folder was not found'}`, 'warn');
      else if (!a.current) {
        const was = a.installed;
        const r = await post('/api/addon/install');
        if (r.error) say(2, `Addon: ${r.error}`, 'warn');
        else say(2, r.carried ? 'Addon: installed under its new name, Azeroth Atlas, with your settings and guide progress carried over. Start the game.'
          : !was ? 'Addon: installed. Restart the game so that it loads.'
          : r.restart ? 'Addon: updated. Restart the game once (leave it altogether: this update brings new files).'
          : 'Addon: updated. Type /reload in the game.', 'good');
        a = r.error ? a : r;
      } else say(2, `Addon: up to date${a.version ? ` (version ${a.version})` : ''}`, 'good');
      const needs = a.installed ? a.guides?.needs?.length ?? 0 : 0;
      if (needs) {
        const r = await post('/api/addon/guides');
        if (r.error) say(3, `Guides: ${r.error}`, 'warn');
        else say(3, `Guides: converted ${packs(r.done?.length ?? 0)} (${(r.done ?? []).join(', ')}). Restart the game once.`, 'good');
      } else if (a.guides?.converted?.length) say(3, `Guides: ${packs(a.guides.converted.length)} ready, nothing to convert`, 'good');
      else if (a.available) say(3, 'Guides: no guide packs made for Guidelime are installed', '');
    }
    say(4, `Checked at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`, '');
  } catch (err) {
    say(4, `Stopped: ${err.message}`, 'warn');
  }
  try { sessionStorage.removeItem(RUN_KEY); } catch { /* nothing kept */ }
  btn.disabled = false;
  btn.textContent = 'Check for updates';
  refreshAddon(false);
  pollStatus();
}
/** A run that was under way when the page loaded itself again: taken up where it was. */
function resumeCheck() {
  let run = null;
  try { run = JSON.parse(sessionStorage.getItem(RUN_KEY)); } catch { /* none */ }
  if (run && Date.now() - run.at < RUN_MAX) checkAll(run);
  else { try { sessionStorage.removeItem(RUN_KEY); } catch { /* none */ } }
}

// ---- update button -----------------------------------------------------------------------
let pollTimer = 0;
function showStatus(st) {
  app.status = st;
  if (changed('status', [st.installed?.version, st.extracted?.build.version, st.extracted?.revision, st.updateAvailable, st.updateReason, st.installError, st.job.running, st.job.error, st.app?.version, st.app?.commit, st.app?.state, st.app?.error, st.app?.note, !!st.setup])) {
    note('status', st.setup ? 'the game has not been found: asked for' : st.job.running ? 'the map is being built' : st.installError ? `the game: ${st.installError}` : !st.extracted ? 'no map has been built yet' : st.updateAvailable ? `the map could be updated (${st.updateReason})` : 'the map is up to date', { game: st.installed?.version ?? null, mapFrom: st.extracted?.build.version ?? null, mapRevision: st.extracted?.revision ?? null, buildError: st.job.error ?? undefined, application: st.app ? { version: st.app.version, commit: st.app.commit, kind: st.app.kind, state: st.app.state, newerOut: st.app.available, error: st.app.error ?? undefined, note: st.app.note ?? undefined } : null });
  }
  showApp(st.app);
  const btn = $('update'), msg = $('updateMsg'), bar = $('progress');
  const inst = st.installed?.version, ext = st.extracted?.build.version;
  if (st.installError) $('build').textContent = `Game not found: ${st.installError}`;
  else if (!ext) $('build').textContent = `Game build ${inst} — map not built yet`;
  else if (st.updateAvailable && st.updateReason === 'creatures') $('build').textContent = `Game build ${inst} — the QuestieDB addon has changed since the map's creature data was built`;
  else if (st.updateAvailable && st.updateReason === 'tool') $('build').textContent = `Game build ${inst} — the map tool has been updated since the map was built: press Update map`;
  else if (st.updateAvailable) $('build').textContent = `Map is from build ${ext}; game is now ${inst}`;
  else $('build').textContent = `Game build ${inst} — map up to date`;
  const job = st.job;
  if (job.running) {
    btn.disabled = true;
    btn.textContent = 'Updating…';
    bar.style.display = 'block';
    bar.firstElementChild.style.width = job.total ? `${(job.done / job.total) * 100}%` : '100%';
    msg.textContent = job.total ? `${job.phase} — ${job.done.toLocaleString()} / ${job.total.toLocaleString()}` : job.phase;
  } else {
    btn.disabled = !st.installed;
    bar.style.display = 'none';
    btn.textContent = st.updateAvailable ? (!ext ? 'Build map' : st.updateReason === 'creatures' ? 'Update map (new creature data)' : st.updateReason === 'tool' ? 'Update map (the map tool is newer)' : 'Update map (new game build)') : 'Update map';
    btn.className = st.updateAvailable ? 'attention' : 'primary';
    if (job.error) msg.textContent = `Update failed: ${job.error}`;
  }
}

async function pollStatus(fast) {
  clearTimeout(pollTimer);
  let st;
  try { st = await getJSON('/api/status'); } catch { pollTimer = setTimeout(pollStatus, 5000); return; }
  const wasRunning = app.status?.job.running;
  showStatus(st);
  if (wasRunning && !st.job.running && !st.job.error && st.job.summary) {
    const s = st.job.summary;
    if (s.changed) {
      $('updateMsg').textContent = `Updated (${s.built.toLocaleString()} rebuilt, ${s.removed} removed) — reloading…`;
      setTimeout(() => location.reload(), 900);
      return;
    }
    $('updateMsg').textContent = `Already up to date (checked ${s.reused.toLocaleString()} files in ${s.seconds}s)`;
  }
  // (quicker while something is going on: a map build, the map tool being looked for or put in)
  pollTimer = setTimeout(pollStatus, st.job.running || fast ? 350 : st.app && st.app.state !== 'idle' ? 1500 : 20000);
}

// ---- live player link ---------------------------------------------------------------------
function showPlayer() {
  const link = app.player, s = link.state, p = s.player;
  const dot = $('playerDot'), text = $('playerText');
  const addon = app.addon;
  let cls = '', msg;
  if (s.status === 'live') {
    cls = 'live';
    if (link.me && link.onThisMap) {
      const z = app.scene.heightAt(link.me.x, link.me.y) ?? 0;
      const d = describe([link.me.x, link.me.y, z]);
      msg = `You: ${d.coords || d.place || app.scene.map.name}`;
    } else {
      const name = app.manifest.maps.find((m) => m.id === p.map)?.name ?? `map ${p.map}`;
      msg = link.me ? `You are in ${name}` : `You are in ${name} (the game hides your position here)`;
    }
    if (p.dead) msg += ' · dead';
    if (p.taxi) msg += ' · flying';
  } else if (s.status === 'nogame') msg = 'Game is not running';
  else if (s.status === 'minimized') { cls = 'warn'; msg = 'Game window is minimized'; }
  else if (s.status === 'nosignal') {
    cls = 'warn';
    if (addon && !addon.installed) msg = 'Player link: addon not installed';
    else if (s.reason === 'version') msg = 'Addon is a different version: update it, then /reload';
    else if (s.reason === 'colors') msg = 'Cannot read the strip colours (colour filter on?)';
    else if (s.reason === 'stalled') msg = 'The game window has stopped updating';
    else if (s.reason === 'server') msg = 'No word from the map server (it is starting again, or has been closed)';
    // Reading the game window itself works with other windows in front; reading the screen does not.
    // (the strip can be moved to another corner of the game: said where something is in its way)
    else if (s.capture === 'window') msg = s.reason === 'covered' || s.reason === 'checksum' ? 'Cannot read the strip: something is drawn over it in the game (an overlay?). Move it to a free corner: in the game, Esc > Options > AddOns > Azeroth Atlas' : 'No signal: is the addon enabled (/atlas) and your character in the world?';
    else if (s.reason === 'covered' || s.reason === 'checksum') msg = 'Strip partly hidden: something is covering it. Uncover that corner of the game, or move the strip (in the game: Esc > Options > AddOns > Azeroth Atlas)';
    else msg = 'No signal: is the addon enabled (/atlas) and the game visible?';
  } else if (s.status === 'error') { cls = 'bad'; msg = `Player link problem: ${s.reason}`; }
  else msg = 'Player link: starting…';
  dot.className = `dot ${cls}`;
  text.textContent = msg;
  // (noted when it is another state of things - log.js - in the words the sidebar has for it)
  if (changed('link', [s.status, s.reason, s.capture, p?.map ?? null, !!p?.dead, !!link.me, link.onThisMap])) note('link', msg, { status: s.status, reason: s.reason ?? undefined, read: s.capture ?? undefined });
  $('btnFind').disabled = s.status !== 'live';
  syncDangerFromGame();
  showInGame();
  showFollow();
  app.dirty = true;
}

// ---- the following camera -------------------------------------------------------------------
const ZOOMS = [['in', 'zoomIn', 'zoomRowIn'], ['town', 'zoomTown', 'zoomRowTown'], ['out', 'zoomOut', 'zoomRowOut']];

/** The switches of the following camera, as they stand: "Turn with me" and "Auto-zoom" are only to be had while following. */
function showFollow() {
  const P = app.player;
  if (!P) return;
  $('optFollow').checked = P.follow;
  $('btnFind').classList.toggle('following', P.follow);
  for (const id of ['optTurn', 'optAuto']) { $(id).disabled = !P.follow; $(id).closest('label').classList.toggle('off', !P.follow); }
  $('zoomBox').className = P.auto ? '' : 'off';
  const working = P.follow && P.auto;
  for (const [kind, id, row] of ZOOMS) {
    $(id).disabled = !P.follow;
    $(row).classList.toggle('off', !P.follow);
    $(row).classList.toggle('now', working && !!P.rig && P.place === kind);
  }
  showZoom();
}

/** How far the camera is from you just now (to go by when setting the three distances), and what the automatic zoom takes the place for. */
function showZoom() {
  const P = app.player, cam = app.camera;
  let text = '', tip = '';
  if (P?.follow && P.rig && P.shown && cam) {
    text = `${Math.round(Math.hypot(cam.pos[0] - P.shown[0], cam.pos[1] - P.shown[1], cam.pos[2] - P.shown[2]))} yd`;
    tip = `The camera is ${text} from you now.${P.auto && P.why ? ` Zoom chosen for: ${P.why}.` : ''}`;
  }
  if (text !== app.zoomText) { app.zoomText = text; $('zoomNow').textContent = text; }
  if (tip !== app.zoomTip) { app.zoomTip = tip; $('zoomNow').title = tip; }
}

/** The page's switches for the following camera, handed to it. */
function applyFollow() {
  const P = app.player;
  if (!P) return;
  P.turn = $('optTurn').checked;
  P.auto = $('optAuto').checked;
  for (const [kind, id] of ZOOMS) { const v = +$(id).value; if (v >= 6 && v <= 5000) P.zoom[kind] = v; }
  remember();
  showFollow();
  app.dirty = true;
}

// ---- route ---------------------------------------------------------------------------------
const mmss = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
// (a boat or tram that has been timed: how long until it leaves, as of this moment)
const leavesIn = (leg) => Math.max(0, leg.leaves && app.transit?.now() ? leg.leaves - app.transit.now() : leg.wait);
const clock = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${Math.round(s)} s`);

/** The list of routes in the sidebar: which there are just now, and how long each takes. */
function showRoutes() {
  if (!app.trips) return;
  const active = app.trips.active();
  for (const r of ROUTES) {
    const mine = active.filter((a) => a.kind === r.key && a.planner.enabled);
    const row = $(`route_${r.key}`)?.closest('.rt'), when = $(`routeWhen_${r.key}`);
    if (!row) continue;
    let text = '';
    const timed = mine.map((a) => (a.planner.route ? a.planner.remaining() : null)).filter(Boolean);
    if (timed.length) {
      const best = timed.reduce((b, t) => (t.seconds < b.seconds ? t : b));
      text = `${mmss(best.seconds)}${timed.length > 1 ? ` (+${timed.length - 1})` : ''}`;
    } else if (mine.length) text = mine.some((a) => a.planner.asked && !a.planner.asked.settled) ? '…' : 'no way';
    row.classList.toggle('none', !mine.length);
    if (r.key === 'waypoint') $('routeClear_waypoint').style.display = mine.length || app.pin ? '' : 'none';
    if (when.textContent !== text) when.textContent = text;
    const why = mine.map((a) => `${a.target?.name ? `${a.target.name}: ` : ''}${a.planner.route ? `${Math.round(a.planner.remaining().yards)} yd on this map, about ${clock(a.planner.remaining().seconds)}` : a.planner.status || 'being worked out'}`).join('\n');
    when.title = why;
  }
}

function showRoute() {
  const r = app.route, t = app.routeTarget;
  let msg = '';
  if (!r.enabled) msg = '';
  else if (!t) msg = 'No waypoint: set one in game (a guide step, Shift-click or Ctrl-click the map), or click this map to drop a marker.';
  else if (r.route) {
    const left = r.remaining(), swims = r.route.kinds.some((k, i) => i >= r.route.at && k & 1);
    // (with more than one level at the spot: which one this goes to)
    const levels = app.levels?.choices, level = levels ? `, ${app.levels.describe()[levels.choice].name.toLowerCase()}` : '';
    const where = (t.name ? `To ${t.name}${t.guess ? ' (which floor is a guess)' : ''}` : t.source === 'marker' ? 'To the marker' : t.source === 'guide' ? "To your guide's step" : t.source === 'journey' ? 'To your Shortest Path destination' : t.source === 'pin' ? 'To your map pin' : t.source === 'quick' ? 'To your quick waypoint' : 'To your waypoint') + level;
    const legs = r.route.legs ?? [];
    if (legs.length > 1) {
      // a quicker way than walking it all: say each part
      const part = (l) => (l.mode === 'walk' ? `${l.rough ? 'roughly ' : ''}${Math.round(l.rough ? l.yards / 50 : l.yards) * (l.rough ? 50 : 1)} yd on foot${l.to ? ` to ${l.to}` : ''}`
        : l.mode === 'fly' ? (l.aloft ? `the rest of your flight to ${l.to}` : `fly ${l.from} to ${l.to} (${clock(l.seconds)})`)
        : l.mode === 'boat' || l.mode === 'zeppelin' ? `the ${l.mode} from ${l.from} to ${l.to} (${clock(l.seconds)}, ${l.known ? `it leaves in ${clock(leavesIn(l))}` : `counting a ${clock(l.wait)} wait`})`
        : l.mode === 'tram' ? `the tram (${clock(l.seconds)}${l.known ? `, it leaves in ${clock(leavesIn(l))}` : ''})`
        : l.mode === 'door' ? `through the ${l.name.replace(/^(Passage|Portal) to /, '')} ${/^Portal/.test(l.name) ? 'portal' : 'entrance'}`
        : l.wait > 0 ? `hearthstone (ready in ${clock(l.wait)})` : 'use your hearthstone');
      msg = `${where}, about ${clock(left.seconds)}: ${legs.map(part).join(', then ')}${r.route.walking ? `. On foot all the way: ${clock(r.route.walking)}` : ''}`;
    } else msg = `${where}: ${Math.round(left.yards)} yd, about ${clock(left.seconds)}${swims ? ', part of it swimming' : ''}`;
  } else if (r.status) msg = `Route: ${r.status}`;
  else msg = app.player?.live || app.routeFrom ? 'Working out the route…' : 'Route: waiting for your position from the game';
  $('routeMsg').textContent = msg;
  app.routeText = r.enabled && t && r.route ? msg : '';
}

/** The name of the place a waypoint is in ("Trade District"), when it is on the map shown. */
function placeAt(t) {
  const on = app.open.get(t.map);
  return on ? describe([t.x, t.y], on).place || null : null;
}

/**
 * The levels a waypoint could be on, to choose between: always in the route panel, and as a
 * prompt over the map for a marker just dropped here (a pin placed in the game is asked about
 * in the game).
 */
function showLevels() {
  const L = app.levels, c = L.choices, rows = L.describe();
  const fill = (box, heading, extra) => {
    box.replaceChildren();
    if (!rows.length) return;
    const head = document.createElement('div');
    head.className = 'dim';
    head.textContent = heading;
    box.append(head);
    rows.forEach((row, i) => {
      const b = document.createElement('button');
      b.className = row.chosen ? 'level chosen' : 'level';
      b.textContent = row.label;
      b.title = row.chosen ? 'The route goes to this level' : 'Send the route to this level';
      b.addEventListener('click', () => L.choose(i));
      box.append(b);
    });
    if (extra) box.append(extra);
  };
  fill($('levelBox'), 'There is more than one level at that spot:');
  const prompt = $('levelPrompt');
  const ask = !!c?.prompt && c.source === 'marker';
  prompt.style.display = ask ? 'flex' : 'none';
  if (ask && !app.levelAsked) app.reveal?.(prompt); // (a question has to be seen: the sidebar opens at it)
  app.levelAsked = ask;
  if (ask) {
    const keep = document.createElement('button');
    keep.textContent = 'Keep the one shown';
    keep.addEventListener('click', () => L.dismiss());
    fill(prompt, 'Which level is the marker on?', keep);
  } else prompt.replaceChildren();
}

/** How the route's way into the game is doing (the addon draws it on the game's map and minimap). */
function showInGame() {
  const live = app.player?.state.status === 'live';
  // (your hearthstone, where you have said in the game that routes are to leave it out)
  const hearth = live && app.player.travel?.hearth?.avoid ? 'Your hearthstone is left out of routes (the button beside "Routes" in the game brings it back).' : '';
  // (...and where the map cannot tell which inn the game means by the name it gives: route.js looks for it, and says here that it could not)
  const h = live ? app.player.travel?.hearth : null;
  const lost = h?.has && !h.avoid ? [app.route, ...(app.trips?.active() ?? []).map((x) => x.planner)].find((q) => q?.noBind)?.noBind : null;
  const where = lost ? `Your hearthstone is left out of routes: the map cannot tell which inn "${lost}" is. Set it again at the innkeeper, and it will know.` : '';
  $('ingameMsg').textContent = [live && app.route?.enabled ? app.ingame?.describe(app.player.state.mail) ?? '' : '', hearth, where].filter(Boolean).join(' ');
}

// ---- spawn zones ---------------------------------------------------------------------------
const DANGER_KEY = 'wfmap.danger';

/** Change the danger settings, on every map that is open (each has its own zones). True if it changed anything on the map in hand. */
function setDanger(patch) {
  let changed = false;
  for (const d of new Set([app.danger, ...[...app.open.values()].map((s) => s.danger)])) {
    const c = d.set(patch);
    if (d === app.danger) changed = c;
  }
  return changed;
}

/** While the game link is live, your level and faction come from the game. */
function syncDangerFromGame() {
  const p = app.player?.state.player;
  const live = app.player?.live && p && p.level > 0;
  $('dangerLevel').disabled = !!live;
  $('dangerFaction').disabled = !!live;
  $('dangerAuto').textContent = live ? 'Level and faction are read from the game.' : '';
  if (!live) return;
  $('dangerLevel').value = p.level;
  $('dangerFaction').value = p.faction ?? 'alliance';
  if (setDanger({ level: p.level, faction: p.faction ?? 'alliance' })) { app.npcs?.rebuild(); app.dirty = true; } // (who is hostile, and which quests count, follow your side and level)
}

function applyDanger() {
  const bands = BANDS.map((_, i) => $(`band${i}`).checked);
  const s = {
    kinds: Object.fromEntries(ZONE_KINDS.map(([key]) => [key, $(`zoneKind_${key}`).checked])),
    enabled: $('optDanger').checked,
    level: clamp(Math.round(+$('dangerLevel').value) || 1, 1, 63),
    faction: $('dangerFaction').value,
    margin: clamp(+$('dangerMargin').value || 0, 0, 15),
    bands,
  };
  if (setDanger(s)) app.npcs?.rebuild();
  try { localStorage.setItem(DANGER_KEY, JSON.stringify(s)); } catch { /* private mode: just not remembered */ }
  $('dangerBody').className = s.enabled ? '' : 'off';
  app.dirty = true;
  app.hoverDirty = true;
}

function showDangerSource() {
  const map = app.scene?.map;
  let note = '';
  if (!app.manifest.danger) note = 'No creature data: install the QuestieDB addon, then press Update map.';
  else if (!map?.creatures) note = 'No creature data for this map.';
  else {
    const loose = app.danger.unconfirmed;
    const sides = loose ? `${loose.toLocaleString()} creatures new to this game have no side recorded, and are painted only with "Side not recorded" ticked`
      : 'Creatures with no side recorded are not in this map\u2019s data yet: press Update map to add them';
    note = `${map.creatures.spawns.toLocaleString()} spawn points on this map (${app.manifest.danger.source}). Whether a creature attacks your side is the game\u2019s own faction data. ${sides}. Zones show where creatures are stationed, not where they are right now, and routes pay them no heed.`;
  }
  $('dangerNote').textContent = note;
}

// Which creatures make spawn zones: [key, label, hint]
const ZONE_KINDS = [
  ['hostile', 'Hostile', 'Attacks your side on sight'],
  ['neutral', 'Neutral', 'Leaves you alone unless you attack it'],
  ['unconfirmed', 'Side not recorded', 'New to this game: the database does not say whose side it is on, so whether it attacks you is not known'],
];

function bindDanger() {
  const kinds = $('zoneKinds');
  for (const [key, label, hint] of ZONE_KINDS) {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = `zoneKind_${key}`;
    const l = document.createElement('label');
    l.title = hint;
    l.append(cb, document.createTextNode(label));
    kinds.append(l);
    cb.addEventListener('change', applyDanger);
  }
  const box = $('dangerBands');
  BANDS.forEach((b, i) => {
    const label = document.createElement('label');
    label.title = b.hint;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = `band${i}`;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = `rgb(${b.color.join(',')})`;
    label.append(cb, chip, document.createTextNode(b.label));
    box.append(label);
    cb.addEventListener('change', applyDanger);
  });
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DANGER_KEY)); } catch { /* ignore */ }
  const s = { ...app.danger.settings, ...(saved ?? {}), kinds: { ...app.danger.settings.kinds, ...(saved?.kinds ?? {}) } };
  for (const [key] of ZONE_KINDS) $(`zoneKind_${key}`).checked = !!s.kinds[key];
  $('optDanger').checked = !!s.enabled;
  $('dangerLevel').value = s.level;
  $('dangerFaction').value = s.faction;
  $('dangerMargin').value = s.margin;
  BANDS.forEach((_, i) => { $(`band${i}`).checked = !!s.bands?.[i]; });
  for (const id of ['optDanger', 'dangerLevel', 'dangerFaction', 'dangerMargin']) $(id).addEventListener(id === 'optDanger' ? 'change' : 'input', applyDanger);
  applyDanger();
}

// The Atlas database (server/atlasdb.js): whether this copy sends what it learns, and which
// version of the database it has. The line is only there where a database is set up.
async function refreshDatabase(share) {
  try {
    const res = await fetch(share === undefined ? '/api/database' : `/api/database?share=${share ? 1 : 0}`, { method: share === undefined ? 'GET' : 'POST' });
    const st = await res.json();
    if (st.error) throw new Error(st.error);
    $('dbRow').style.display = st.on ? '' : 'none';
    $('optShare').checked = !!st.share;
    const r = st.result, sent = r?.collect?.sent;
    const n = sent ? sent.npc + sent.object + sent.quest + sent.seen : 0;
    $('dbNow').textContent = st.error ? 'not reached' : st.running ? 'working…' : n ? `${n.toLocaleString()} sent` : r?.pull?.rev ? `database ${r.pull.rev}` : '';
    $('dbNow').title = st.error ?? '';
  } catch { /* an older server: no such line */ }
}

// what: nothing (only look), 'install' (Update addon) or 'guides' (Convert guide packs)
async function refreshAddon(what) {
  const btn = $('btnAddon'), msg = $('addonMsg');
  const packs = (n) => `${n} guide pack${n === 1 ? '' : 's'}`;
  try {
    const before = app.addon;
    const res = await fetch(what ? `/api/addon/${what}` : '/api/addon', { method: what ? 'POST' : 'GET' });
    const st = await res.json();
    if (st.error) throw new Error(st.error);
    app.addon = st;
    if (what === 'install') msg.textContent = st.carried ? `Addon installed under its new name, Azeroth Atlas. Carried over from the old one: your settings and guide progress (${st.carried.saved} file${st.carried.saved === 1 ? '' : 's'})${st.carried.packs.length ? `, ${st.carried.packs.length} converted guide pack${st.carried.packs.length === 1 ? '' : 's'}` : ''}. Start the game.`
      : !before?.installed ? 'Addon installed: restart the game so it loads (new addons are only picked up at start).'
      : st.restart ? 'Addon updated. Restart the game once (leave it altogether, not /reload): this update brings new files, and the game only finds those when it starts.'
      : 'Addon updated: type /reload in the game.';
    if (what === 'guides') msg.textContent = `Converted ${packs(st.done?.length ?? 0)}. Restart the game once (leave it altogether, not /reload): it reads which addon needs which only when it starts.`;
  } catch (err) { msg.textContent = `Addon: ${err.message}`; }
  const a = app.addon;
  // Your leveling guides in the game: guide packs made for Guidelime, which the addon runs once
  // they are converted (they name Guidelime as the addon they need until then).
  const g = a?.installed ? a.guides : null;
  const needs = g?.needs?.length ?? 0, converted = g?.converted?.length ?? 0;
  $('guideMsg').textContent = needs ? `Guides: ${packs(needs)} only ${needs === 1 ? 'loads' : 'load'} with Guidelime switched on. Converted, ${needs === 1 ? 'it runs' : 'they run'} in the addon's own guide window, with or without Guidelime.`
    : converted ? `Guides: ${packs(converted)} ${converted === 1 ? 'runs' : 'run'} in the addon's own guide window (/atlas guide).${g.guidelime ? ' While Guidelime is switched on in the game, it runs them instead.' : ''}`
    : '';
  $('guideMsg').title = needs ? `To convert: ${g.needs.join(', ')}` : converted ? `Converted: ${g.converted.join(', ')}` : '';
  $('guideRow').style.display = needs ? '' : 'none';
  $('btnGuides').textContent = `Convert ${packs(needs)}`;
  if (a?.available && !a.current) {
    btn.style.display = '';
    btn.textContent = a.legacy ? 'Update addon (it has a new name)' : a.installed ? 'Update addon' : 'Install addon';
    // (a copy from before the addon's new name: it goes on working, and is replaced while the game is closed)
    if (a.legacy && !what) msg.textContent = 'The addon has a new name, Azeroth Atlas. The one in the game goes on working until you replace it: close the game, press Update addon, start the game again. Your settings and guide progress are carried over.';
    btn.className = 'attention';
    // (not to be missed in a section that is shut: opened once, when it first has something to say)
    if (!app.addonTold) { app.addonTold = true; document.querySelector('details.sec[data-sec="you"]').open = true; }
  } else btn.style.display = 'none';
  if (app.player) showPlayer();
}

/** The switch for the trees: there to be used once the map knows which objects are trees. */
function showTrees() {
  const known = !!app.models?.trees;
  $('optTrees').disabled = !known;
  $('treesRow').classList.toggle('off', !known);
  $('treesRow').title = known ? 'The trees, apart from everything else that stands in the world: switch them off to see the ground under a forest'
    : 'The map does not know yet which objects are trees: press "Update map" once. Until then they are shown and hidden with the other objects.';
}

// ---- the sidebar ---------------------------------------------------------------------------
// Everything there is to set is in one sidebar, in sections that fold. Which are open, and
// whether the sidebar itself is folded away, is kept like every other setting.
const SIDE_KEY = 'wfmap.side';
function bindSide() {
  const saved = store.get(SIDE_KEY) ?? {};
  const sections = [...document.querySelectorAll('details.sec')];
  const note = () => store.set(SIDE_KEY, { shut: document.body.classList.contains('side-shut'), open: Object.fromEntries(sections.map((d) => [d.dataset.sec, d.open])) });
  for (const d of sections) {
    if (typeof saved.open?.[d.dataset.sec] === 'boolean') d.open = saved.open[d.dataset.sec];
    d.addEventListener('toggle', note);
  }
  const fold = (shut) => { document.body.classList.toggle('side-shut', shut); note(); app.dirty = true; };
  if (saved.shut) document.body.classList.add('side-shut');
  $('sideToggle').addEventListener('click', () => fold(!document.body.classList.contains('side-shut')));
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyB' || e.ctrlKey || e.altKey || e.metaKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    fold(!document.body.classList.contains('side-shut'));
  });
  /** Bring something in the sidebar into sight: the sidebar out, its section open, scrolled to. */
  app.reveal = (el) => {
    if (document.body.classList.contains('side-shut')) fold(false);
    const sec = el.closest('details.sec');
    if (sec && !sec.open) sec.open = true;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  // Is the pointer on the map? (The read-out at the bottom left is only there while it is.)
  const gl = $('gl');
  const point = (on) => { if (app.pointing !== on) { app.pointing = on; app.hoverDirty = true; } };
  gl.addEventListener('pointerenter', () => point(true));
  gl.addEventListener('pointermove', () => point(true));
  gl.addEventListener('pointerleave', () => point(false));
  document.documentElement.addEventListener('mouseleave', () => point(false));
  window.addEventListener('blur', () => point(false));
}

function bindUI() {
  recall(); // (before anything reads the switches)
  bindSide();
  showTrees();
  $('optFollow').addEventListener('change', (e) => { if (app.player) app.player.setFollow(e.target.checked); else remember(); });
  for (const id of ['optTurn', 'optAuto', ...ZOOMS.map((z) => z[1])]) $(id).addEventListener($(id).type === 'checkbox' ? 'change' : 'input', applyFollow);
  $('btnFind').addEventListener('click', () => app.player?.find());
  const applyCut = () => {
    remember();
    if (!app.cutaway) return;
    app.cutaway.on = $('optCut').checked;
    app.cutaway.radius = clamp(+$('cutRadius').value || 30, 5, 300);
    app.dirty = true;
  };
  app.applyCut = applyCut; // run once the cutaway exists (see main)
  // 3D figure in place of the arrow when the camera is close
  const FIGURE_KEY = 'wfmap.figure';
  try { const f = JSON.parse(localStorage.getItem(FIGURE_KEY)); if (f) { $('optFigure').checked = f.on !== false; if (f.dist > 0) $('figureDist').value = f.dist; } } catch { /* use the defaults */ }
  const applyFigure = () => {
    app.opts.figure = $('optFigure').checked;
    app.opts.figureDist = clamp(+$('figureDist').value || 150, 5, 20000);
    try { localStorage.setItem(FIGURE_KEY, JSON.stringify({ on: app.opts.figure, dist: app.opts.figureDist })); } catch { /* private mode: just not remembered */ }
    app.dirty = true;
  };
  // route to the waypoint
  const ROUTE_KEY = 'wfmap.route';
  try { const f = JSON.parse(localStorage.getItem(ROUTE_KEY)); if (f) $('optRoute').checked = f.on !== false; } catch { /* use the defaults */ }
  const applyRoute = () => {
    if (!app.route) return;
    // (all of them at once; each kind has a switch of its own in the list: trips.js)
    app.routesOn = $('optRoute').checked;
    try { localStorage.setItem(ROUTE_KEY, JSON.stringify({ on: app.routesOn })); } catch { /* private mode: just not remembered */ }
    $('routeList').classList.toggle('off', !app.routesOn);
    showRoute();
    app.dirty = true;
  };
  $('optRoute').addEventListener('change', applyRoute);
  // one line for each kind of route: shown or not, its colour, what it is, how long it takes
  for (const r of ROUTES) {
    const box = document.createElement('input'), color = document.createElement('input'), label = document.createElement('label'), when = document.createElement('span'), row = document.createElement('div');
    box.type = 'checkbox'; box.id = `route_${r.key}`;
    color.type = 'color'; color.id = `routeColor_${r.key}`; color.title = 'The colour of this route. What is flown is drawn in a lighter tint of it.';
    label.className = 'grow'; label.htmlFor = box.id; label.textContent = r.label; label.title = r.hint;
    when.className = 'when'; when.id = `routeWhen_${r.key}`;
    row.className = 'rt none';
    row.append(box, color, label, when);
    if (r.key === 'waypoint') {
      // (your waypoint can be taken away from here too)
      const off = document.createElement('button');
      off.id = 'routeClear_waypoint'; off.className = 'clear'; off.textContent = '×'; off.style.display = 'none';
      off.title = 'Take your waypoint away. (A right-click on it on the map, or Esc, does the same. In the game it goes when the game next asks for a route: /atlas route asks at once.)';
      off.addEventListener('click', () => { clearWaypoint(); showRoutes(); });
      row.append(off);
    }
    $('routeList').append(row);
    box.addEventListener('change', () => app.trips?.set(r.key, { on: box.checked }));
    color.addEventListener('input', () => app.trips?.set(r.key, { color: color.value }));
  }
  /** The switches and colours of the list, as the routes have them (once they exist: see main). */
  app.showRouteList = () => { for (const r of ROUTES) { $(`route_${r.key}`).checked = app.trips.on(r.key); $(`routeColor_${r.key}`).value = app.trips.color(r.key); } };
  app.applyRoute = applyRoute; // run once the planner exists (see main)
  $('optFigure').addEventListener('change', applyFigure);
  $('figureDist').addEventListener('input', applyFigure);
  applyFigure();
  $('optCut').addEventListener('change', applyCut);
  $('cutRadius').addEventListener('input', applyCut);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyX' || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    $('optCut').checked = !$('optCut').checked;
    applyCut();
  });
  const lookForApp = (apply) => async (e) => {
    e.preventDefault();
    $('appMsg').textContent = 'Looking for a newer map tool…';
    try { showApp(await (await fetch(`/api/app/check${apply ? '?apply=1' : ''}`, { method: 'POST' })).json()); } catch (err) { $('appMsg').textContent = `Could not look: ${err.message}`; }
    clearTimeout(pollTimer);
    pollTimer = setTimeout(pollStatus, 1500);
  };
  $('appCheck').addEventListener('click', lookForApp(false));
  $('appUpdate').addEventListener('click', lookForApp(true));
  $('btnAddon').addEventListener('click', () => refreshAddon('install'));
  $('optShare').addEventListener('change', (e) => refreshDatabase(e.target.checked));
  $('btnGuides').addEventListener('click', () => refreshAddon('guides'));
  $('update').addEventListener('click', async () => {
    $('update').disabled = true;
    $('updateMsg').textContent = 'Starting…';
    try {
      await fetch('/api/update', { method: 'POST' });
      app.status.job.running = true;
      pollStatus(true);
    } catch (err) { $('updateMsg').textContent = `Could not start update: ${err.message}`; }
  });
  // (choosing a map to look at ends the following of your character)
  $('map').addEventListener('change', () => { app.letGo(); openMap(+$('map').value).catch((err) => fatal('Could not open map', err.message)); });
  const redraw = () => { app.dirty = true; };
  // What is drawn: the switches of the tools panel, handed on as they stand (now, as they were left last time, and whenever one changes).
  const applyTools = () => {
    if (app.labels) { app.labels.enabled = $('optLabels').checked; app.labels.showFlights = $('optFlights').checked; }
    app.opts.transit = $('optTransit').checked;
    app.opts.slope = $('optSlope').checked;
    app.opts.contours = $('optContours').checked;
    app.opts.slopeDeg = clamp(+$('slopeDeg').value || 50, 20, 80);
    for (const s of app.open.values()) { s.objects.enabled.buildings = $('optBuildings').checked; s.objects.enabled.objects = $('optObjects').checked; s.objects.enabled.trees = $('optTrees').checked; }
    remember();
    redraw();
  };
  for (const id of ['optLabels', 'optFlights', 'optTransit', 'optSlope', 'optContours', 'optBuildings', 'optObjects', 'optTrees']) $(id).addEventListener('change', applyTools);
  $('slopeDeg').addEventListener('input', applyTools);
  app.applyTools = applyTools; // run once the labels exist (see main)
  $('btnNorth').addEventListener('click', () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN' })));
  $('btnTop').addEventListener('click', () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyT' })));
  $('btnFly').addEventListener('click', () => app.camera.toggleFly());
  $('btnHelp').addEventListener('click', () => { $('help').style.display = $('help').style.display === 'block' ? 'none' : 'block'; });
  $('helpClose').addEventListener('click', () => { $('help').style.display = 'none'; });
  window.addEventListener('resize', redraw);
  new ResizeObserver(redraw).observe($('gl'));
  const gl = $('gl');
  gl.addEventListener('pointerdown', () => gl.classList.add('dragging'));
  window.addEventListener('pointerup', () => gl.classList.remove('dragging'));
}

// ---- boot --------------------------------------------------------------------------------
async function main() {
  bindUI();
  let st;
  try { st = await getJSON('/api/status'); } catch (err) { fatal('Map server is not running', 'Start it with "Start Map.bat" (or "npm start") and reload this page.'); return; }
  showStatus(st);
  $('checkAll').addEventListener('click', () => checkAll());
  if (st.setup) { showSetup(st); resumeCheck(); return; } // (the game has not been found on this computer: asked for, and nothing else until then)
  pollStatus();
  try {
    app.gpu = await initGPU($('gl'), (i, of) => { $('loading').style.display = 'block'; $('loading').textContent = `The graphics card is busy: asking again (${i} of ${of})…`; });
  } catch (err) { console.error(err); const [title, words] = gpuWords(err); if (err?.none) fatal(title, words); else gpuTrouble(title, words, err.message); return; }
  $('loading').textContent = 'Loading terrain…';
  // (lost while drawing - the driver was reset, the card taken away: the page starts afresh, which is what puts it right)
  app.gpu.onLost = (info) => { if (info.reason !== 'destroyed') gpuTrouble('The graphics card was lost', 'Windows took the graphics card away from the map (a driver that was reset, or the card too busy).', info.message || ''); };
  // (let go of at once when the page goes - loading itself again, or closed: the page that comes next can then have it)
  window.addEventListener('pagehide', () => { try { app.gpu.device.destroy(); } catch { /* gone already */ } });
  app.terrain = new TerrainRenderer(app.gpu);
  app.models = new ModelRenderer(app.gpu);
  app.models.onChange = () => { app.dirty = true; };
  app.floors = new FloorFinder(app.models);
  app.cutaway = new Cutaway(app);
  app.applyCut();
  app.figure = new FigureRenderer(app.gpu);
  app.transitView = new TransitRenderer(app.gpu);
  app.route = new RoutePlanner(app);
  app.route.onChange = () => { app.dirty = true; showRoute(); };
  app.levels = new LevelChooser(app);
  app.levels.onChange = () => { app.dirty = true; showLevels(); showRoute(); };
  app.placeAt = placeAt;
  app.pickSurface = (px, py) => pickSurface(app, px, py);
  app.ingame = new InGameRoute(app);
  // (for "Report a problem" - report.js: the picture as it is now, drawn so that it can be read back)
  app.snap = () => render();
  app.onInGame = showInGame;
  // (the server has been started again - after an update of the map, see reload.js: it is sent the route once more)
  window.addEventListener('wfmap-server', () => { app.ingame.sig = ''; });
  app.routeRenderer = new RouteRenderer(app.gpu);
  // a route to each of the other places you could be heading for, each in its own colour
  app.trips = new Trips(app, app.route, app.routeRenderer);
  app.trips.onChange = () => { app.dirty = true; showRoutes(); };
  app.showRouteList();
  app.applyRoute();
  app.danger = new DangerLayer();
  bindDanger();
  // everyone and everything, standing in the world (the NPC panel)
  app.npcs = new NpcLayer(app);
  const sheet = makeIconSheet();
  app.npcRenderer = new NpcRenderer(app.gpu, sheet);
  app.npcFigures = new NpcFigures(app.gpu);
  app.npcUi = bindNpcs(app, sheet);
  // every quest there is, to search and look into (the Quests section)
  app.questUi = bindQuests(app);
  // what things cost at the auction house, and how that has moved (the Auction prices section)
  app.priceUi = bindPrices();
  { const told = app.npcs.onChange; app.npcs.onChange = () => { told(); app.questUi.update(); }; }
  app.setPin = setPin;
  app.clearWaypoint = clearWaypoint;
  app.waypointAt = waypointAt;
  app.labels = new Labels($('labels'));
  app.applyTools();
  app.camera = new Camera($('gl'), () => { app.dirty = true; });
  // (the view moved off your character - a drag of the map, the movement keys: the following ends)
  app.camera.onLetGo = () => app.player?.setFollow(false);
  // (a hill the cutaway has opened to show your character: the cursor points through the hole)
  app.camera.gone = (x, y, z) => app.cutaway.hidesGround(x, y, z);
  app.camera.onHover = () => { app.hoverDirty = true; };
  app.camera.onClick = (hit, e) => {
    // a right-click on your waypoint takes it away
    if (e.button === 2 && !e.altKey && !e.ctrlKey && onWaypoint(app.camera.mouse)) { clearWaypoint(); return; }
    if (e.button !== 0 || e.altKey || e.ctrlKey) return;
    // a click on a marker opens that NPC's card; anywhere else drops the marker pin
    const m = app.camera.mouse;
    const npc = m && app.npcs.count ? app.npcs.pick(app.camera.pos, app.vp, app.camera.canvas.clientWidth, app.camera.canvas.clientHeight, m[0], m[1]) : -1;
    if (npc >= 0) { app.npcUi.open(npc); return; }
    // the street, floor or roof under the cursor (the ground only where nothing is built over it);
    // with Shift, a quick marker: no question about which level
    const spot = (m && pickSurface(app, m[0], m[1])) ?? hit;
    if (!spot) return;
    // (on the map beside the one in hand: the marker is that map's, and a route to it is a journey there)
    const s = spotOn(spot);
    setPin([s.x, s.y, spot[2]], null, false, e.shiftKey, s.on);
  };
  app.camera.onModeChange = (fly) => { $('flyhint').style.display = fly ? 'block' : 'none'; $('crosshair').style.display = fly ? 'block' : 'none'; };
  if (!st.extracted) {
    $('build').textContent = 'No map data yet — press "Build map" (or "Check for updates", below) to read it from your installed game.';
    resumeCheck();
    return;
  }
  try {
    [app.manifest, app.world] = await Promise.all([getJSON('/data/manifest.json'), getJSON(`/data/world.json?v=${st.extracted.revision}`)]);
  } catch (err) { fatal('Map data could not be loaded', err.message); return; }
  app.models.rev = app.manifest.revision;
  // Portals that put you on another floor of the same building: the map has to know them to
  // follow you through (teleports.json, which comes with the page; height.js).
  try { const res = await fetch('/teleports.json', { cache: 'no-cache' }); app.world.teleports = res.ok ? (await res.json()).teleports ?? [] : []; } catch (err) { app.world.teleports = []; console.warn('the list of portals between floors is unavailable', err); }
  // Sizes of all placeable objects (for distance culling before a model is downloaded).
  app.m2Radius = new Map();
  try {
    const res = await fetch(`/data/models/m2-index.bin?v=${app.manifest.revision}`);
    if (res.ok) {
      const dv = new DataView(await res.arrayBuffer());
      for (let p = 0; p + 8 <= dv.byteLength; p += 8) app.m2Radius.set(dv.getUint32(p, true), dv.getFloat32(p + 4, true));
    }
  } catch (err) { console.warn('object index unavailable', err); }
  // Which of the objects are trees (worked out when the map is updated: extractor/trees.js). A
  // map built before that was added does not say: the trees then stay with the other objects.
  if (app.manifest.models?.trees !== undefined) {
    try {
      const res = await fetch(`/data/models/trees.bin?v=${app.manifest.revision}`);
      if (res.ok) app.models.trees = new Set(new Uint32Array(await res.arrayBuffer()));
    } catch (err) { console.warn('tree list unavailable', err); }
  }
  showTrees();
  fillMapSelect();
  buildSearchIndex();
  bindSearch();
  app.openMap = openMap;
  app.routes = new TravelRoutes(app.world); // flight paths and boat routes, for your height while carried
  app.transit = new Transit();              // when the boats, zeppelins and tram run, and where each is
  await app.transit.load(app.world);
  // The continents the game's world map shows side by side are shown side by side here too, the boats sailing between them.
  app.layout = worldLayout(app.world, new Set(app.manifest.maps.filter((m) => m.kind === 'terrain').map((m) => m.id)));
  app.transit.setLayout(app.layout);
  app.player = new PlayerLink(app);
  app.player.onChange = showPlayer;
  // The following camera, as it was left: it takes hold when your character is first seen.
  app.player.onFollow = () => { showFollow(); remember(); };
  app.player.follow = $('optFollow').checked;
  applyFollow();
  requestAnimationFrame(frame);
  startTicking(); // (the same steps while the page is not on show: see step)
  // Where to begin: where the page's address says, else where you were looking last time.
  const h = readHash(), last = store.get(VIEW_KEY);
  const known = (v) => !!v && ['m', 'x', 'y', 'z'].every((k) => Number.isFinite(v[k])) && app.manifest.maps.some((m) => m.id === v.m);
  const view = ['x', 'y', 'z'].every((k) => k in h) ? h : known(last) ? last : null;
  const startMap = 'm' in h ? h.m : view?.m ?? (app.manifest.maps.find((m) => m.id === 0 && m.kind === 'terrain') ? 0 : -1);
  try { await openMap(startMap, view); } catch (err) { fatal('Could not open map', err.message); return; }
  try { sessionStorage.removeItem(GPU_TRIES_KEY); } catch { /* nothing to forget */ }
  // Start listening for the game only once a map is up.
  refreshAddon(false);
  resumeCheck();
  // (a guide pack installed or updated since is offered for converting without reloading the page)
  setInterval(() => { if (!document.hidden) refreshAddon(false); }, 30000);
  refreshDatabase();
  setInterval(() => { if (!document.hidden) refreshDatabase(); }, 60000);
  app.player.connect();
}

main();
