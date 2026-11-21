// "Report a problem": a window to say what went wrong in, and one zip file out of it - what
// you wrote, with everything that may help whoever looks into it: this computer, this copy of
// Azeroth Atlas and its notes, the game and its addons (server/report.js gathers it, and says
// what goes in and what never does). Saved where you say. Nothing is sent anywhere.
//
// The page adds what only it knows: what it was showing just then (where you were, each route
// and how it was taken to go, what the game had been handed), its own notes (log.js), and a
// picture of the map.
//
// Where the file goes is asked in whichever way there is: the application's own "Save as"
// window (app/main.cjs), else the browser's, else it is handed to the browser as a download.
//
// A script of its own, loaded before the map: a map that will not start is as good a reason
// to report a problem as any. What the map knows is taken from it when a report is made
// (window.__app: main.js) - and where there is no map, the report goes without.
import { note, notes, lean, sendNow } from './log.js';

const $ = (id) => document.getElementById(id);
const round = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v ?? null);
const spot = (p) => (p ? [...p].slice(0, 3).map(round) : null);
const FRESH = 3 * 60 * 1000; // the addon's notes written down this recently are the notes of now

/** One part of the picture of things; whatever goes wrong in gathering it is said in its place. */
const part = (fn) => { try { return fn(); } catch (err) { return { couldNotBeGathered: String(err?.message ?? err) }; } };

/** A planner's route, in words and numbers (not its line). */
function way(p, now) {
  if (!p) return null;
  const r = p.route, a = p.asked;
  return {
    label: p.label, enabled: p.enabled, onMap: p.mapId, canBeWalked: p.navigable, words: p.status, yardsOffIt: Number.isFinite(p.off) ? round(p.off) : null, onIt: p.onRoute,
    from: spot(p.me), walkOnly: p.walkOnly || undefined, fixed: p.fixed || undefined, flightSpeed: round(p.flightSpeed), hearthstoneLeadsNobodyKnowsWhere: p.noBind || undefined,
    asked: a ? { id: a.id, onMap: a.map, toMap: a.toMap, from: spot(a.from), to: spot(a.to), walkLookedFor: !!a.done, journeyLookedFor: !!a.settled, stale: a.stale || undefined, hearthstoneLeftOut: a.avoid, flight: a.flight ?? undefined, msAgo: Math.round(now - a.time) } : null,
    route: r ? {
      seconds: round(r.seconds), yards: round(r.length), onFootAllTheWay: round(r.walking), firstAnswerOnly: !!r.provisional, detached: r.detached || undefined, points: r.kinds?.length ?? null, youAreAtPoint: r.at, endsAt: spot(r.target),
      left: part(() => lean(p.remaining())), legs: lean(r.legs), alsoShown: (r.also ?? []).map((q) => ({ map: q.map, points: q.points.length / 3 })),
    } : null,
  };
}

/** What the page is showing and knows, at this moment. */
export function snapshot(app) {
  const now = performance.now(), P = app.player, cam = app.camera;
  const words = (id) => $(id)?.textContent ?? null;
  return {
    at: new Date().toISOString(),
    page: part(() => ({ address: location.pathname + location.hash, made: document.querySelector('meta[name="wfmap-stamp"]')?.content ?? null, browser: navigator.userAgent, inTheApplication: !!window.azerothAtlas, outOfSight: document.hidden, window: [window.innerWidth, window.innerHeight], pixelRatio: window.devicePixelRatio, upForSeconds: Math.round(now / 1000), stepsTaken: app.steps ?? 0, picturesDrawn: app.drawn ?? 0 })),
    said: part(() => ({ build: words('build'), update: words('updateMsg'), application: words('appMsg'), you: words('playerText'), addon: words('addonMsg'), guides: words('guideMsg'), route: words('routeMsg'), inTheGame: words('ingameMsg'), checked: [...($('checkLines')?.children ?? [])].map((d) => d.textContent), loading: $('loading')?.style.display === 'block' ? words('loading') : null, stopped: $('fatal')?.style.display === 'flex' ? [words('fatalTitle'), words('fatalMsg'), words('fatalMore')] : null, performance: words('perf'), routes: [...document.querySelectorAll('#routeList .rt')].map((r) => r.textContent.replace(/\s+/g, ' ').trim()) })),
    graphics: part(() => (app.gpu ? { ...app.gpu.info, lost: app.gpu.lost, scale: app.gpu.scale, pixelRatio: app.gpu.pixelRatio, compressedTextures: app.gpu.bc, canvas: [app.gpu.canvas.width, app.gpu.canvas.height] } : null)),
    status: part(() => lean(app.status)),
    addon: part(() => lean(app.addon ?? null)),
    map: part(() => ({ inHand: app.here ? { id: app.here.id, name: app.scene?.map?.name } : null, beside: (app.beside ?? []).map((o) => ({ id: o.id, offset: app.offs?.get(o.id) ?? null, floor: o.scene?.floor ?? undefined })), open: [...app.open.keys()], dataRevision: app.manifest?.revision ?? null, tool: app.manifest?.tool ?? null, scene: lean(app.scene?.stats ?? null), models: lean(app.models?.stats ?? null) })),
    camera: part(() => (cam ? { at: spot(cam.pos), heading: round(cam.heading), pitch: round(cam.pitch), flying: !!cam.fly || undefined } : null)),
    you: part(() => (P ? {
      asTheServerSaid: lean({ ...P.state, transit: P.state?.transit ? `(${Object.keys(P.state.transit.lines ?? {}).length} lines)` : null }),
      heardFrom: P.live, onTheMapInHand: P.onThisMap, at: P.me ? { map: P.me.map, x: round(P.me.x), y: round(P.me.y), z: round(P.me.z), heading: round(P.me.heading), indoors: P.me.indoors } : null, shownAt: spot(P.shown),
      following: P.follow, turning: P.turn, autoZoom: P.auto, place: P.place, why: P.why ?? null, switching: P.switching || undefined,
      height: part(() => ({ carried: P.height?.ride ? { flight: !!P.height.ride.flight, path: P.height.ride.path?.id ?? null, along: round(P.height.ride.along), lost: P.height.ride.lost || undefined } : null })),
      speeds: P.speeds ?? null, travel: lean(P.travel ?? null), heads: lean(P.heads ?? null), target: lean(P.target ?? null),
    } : null)),
    routes: part(() => ({
      on: app.routesOn !== false, heading: lean(app.routeTarget ?? null), leads: app.trips?.leadKind ?? null, questTheyWereWorkedOutFor: app.questFor ?? null,
      markerHere: app.pin ? { map: app.pin.map, at: [round(app.pin.x), round(app.pin.y), round(app.pin.z)], exact: !!app.pin.exact, quick: !!app.pin.quick, droppedAt: app.pin.at } : null, markerForTheGame: app.markerForGame ?? null, gamesOwnWaypoint: lean(app.gameWay ?? null),
      levels: part(() => (app.levels?.choices ? { ...lean(app.levels.choices), described: app.levels.describe().map((d) => d.label) } : null)),
      lead: way(app.route, now),
      others: (app.trips?.active() ?? []).filter((x) => !x.lead).map((x) => ({ slot: x.slot, kind: x.kind, colour: x.color, heading: lean(x.target), ...way(x.planner, now) })),
      settings: lean(app.trips?.settings ?? null),
    })),
    game: part(() => ({ handed: app.ingame?.handed ?? null, handedAt: app.ingame?.handedAt ? new Date(app.ingame.handedAt).toISOString() : null, serverSaid: app.ingame?.status ?? null, describedAs: app.ingame?.describe(P?.state?.mail) ?? null })),
    quests: part(() => {
      const N = app.npcs, mine = N?.mine;
      if (!mine) return null;
      const tracked = P?.heads?.quest || 0, me = P?.shown ?? null;
      return {
        log: [...mine.log].map(([id, state]) => ({ id, state, name: N.quests?.quests?.[id]?.n ?? null, asTheMapHasIt: lean(N.quests?.quests?.[id] ?? null) })), done: mine.done ? mine.done.size : null,
        tracked, trackedGoal: tracked && me ? part(() => lean(N.questGoal(tracked, me, P.heads?.tracked?.id === tracked ? P.heads.tracked : null))) : null,
      };
    }),
    boats: part(() => (app.transit ? { known: !!app.transit.timed, clock: app.transit.now?.() ?? null, heard: app.transit.clock !== null, live: lean(app.transit.live ?? null) } : null)),
    // (the overlays over the game - overlay.js: what is set, where the game's window is, whether the page is over it just now, and how you are taken to be doing)
    overlays: part(() => { const o = app.overlays?.state; return o ? { asTheApplicationSaid: lean(o.told ?? null), youAre: o.how, clickable: o.rects, inTheApplication: !!window.azerothAtlas?.overlay } : null; }),
    remembered: part(() => { const out = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('wfmap.')) { try { out[k] = JSON.parse(localStorage.getItem(k)); } catch { out[k] = localStorage.getItem(k); } } } return out; }),
  };
}

/** A picture of the map as it is now (the map and what is written over it), as a data: URL - or null. */
function picture(app) {
  try {
    const gl = $('gl'), over = $('labels');
    if (!gl?.width || !app.snap) return null;
    // (drawn and read in one go: once it has been shown, a picture of the graphics card's is gone from where it can be read)
    app.snap();
    const scale = Math.min(1, 1920 / gl.width);
    const c = document.createElement('canvas');
    c.width = Math.round(gl.width * scale); c.height = Math.round(gl.height * scale);
    const g = c.getContext('2d');
    g.drawImage(gl, 0, 0, c.width, c.height);
    if (over?.width) g.drawImage(over, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } catch (err) { note('report', 'a picture of the map could not be taken', { error: String(err?.message ?? err) }); return null; }
}

const fileName = () => { const d = new Date(), p = (v) => String(v).padStart(2, '0'); return `Azeroth-Atlas-report-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`; };
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? `${s} seconds ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 172800 ? `${Math.round(s / 3600)} hours ago` : `${Math.round(s / 86400)} days ago`; };

/**
 * Where the file is to go, asked for now (while the click that asked is still the reason):
 * { name (what to call it when telling you), save(blob) } - or null: you thought better of it.
 */
async function destination(name) {
  const own = window.azerothAtlas;
  if (own?.chooseSave) {
    // the application's own "Save as" window
    const chosen = await own.chooseSave(name);
    if (!chosen) return null;
    return { name: chosen.file, reveal: own.reveal ? () => own.reveal(chosen.token) : null, save: async (blob) => { const r = await own.write(chosen.token, await blob.arrayBuffer()); if (r?.error) throw new Error(r.error); } };
  }
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, startIn: 'desktop', types: [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }] });
      return { name: handle.name, save: async (blob) => { const w = await handle.createWritable(); await w.write(blob); await w.close(); } };
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      note('report', 'the browser\'s "Save as" could not be used: handed over as a download', { error: String(err?.message ?? err) });
    }
  }
  // (no way to ask: the browser saves it where it saves downloads, or asks in its own way)
  return {
    name: `${name} (with your browser's downloads)`,
    save: async (blob) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); },
  };
}

/** Set the window up. */
function bindReport() {
  const box = $('report');
  if (!box) return;
  const map = () => window.__app ?? null; // the map itself, if it has got as far as being there
  let poll = 0, busy = false;
  const say = (text, cls = 'dim') => { const m = $('reportMsg'); m.className = `small ${cls}`; m.textContent = text; };

  // In the game first: the addon's own notes are only on the disk once the game has written them.
  const check = async () => {
    const line = $('reportAddon');
    let d = null;
    try { const res = await fetch('/api/report/check', { cache: 'no-store' }); if (res.ok) d = await res.json(); } catch { /* the server is away: said below */ }
    if (!d) { line.className = 'small dim'; line.textContent = ''; return; }
    if (!d.game) { line.className = 'small dim'; line.textContent = 'The game has not been found on this computer, so nothing about it can be added.'; return; }
    const fresh = d.savedAt && Date.now() - d.savedAt < FRESH;
    line.className = `small ${fresh ? 'good' : d.heard || d.savedAt ? 'warn' : 'dim'}`;
    line.textContent = fresh ? `✓ The addon's notes were written down ${ago(d.savedAt)}.`
      : !d.savedAt ? (d.heard ? 'The addon has not had anything written down yet: type /reload in the game now.' : 'The addon has saved nothing yet (it does once it has run in the game).')
      : d.heard ? `The addon's notes were last written down ${ago(d.savedAt)}: type /reload in the game now, and what it has noted since is added.`
      : `The addon's notes were last written down ${ago(d.savedAt)} (when you last left the game, or typed /reload).`;
  };

  const open = () => {
    box.style.display = 'flex';
    $('reportDone').style.display = 'none';
    $('reportForm').style.display = '';
    say('');
    check();
    clearInterval(poll);
    poll = setInterval(check, 2500);
    $('reportText').focus();
    note('report', 'the window for reporting a problem was opened');
  };
  const close = () => { if (busy) return; box.style.display = 'none'; clearInterval(poll); };

  const make = async () => {
    if (busy) return;
    const text = $('reportText').value.trim();
    if (!text) { say('Say in a few words what went wrong first: without them, nobody can tell what to look for.', 'warn'); $('reportText').focus(); return; }
    busy = true;
    $('reportSave').disabled = true;
    $('reportCancel').disabled = true;
    try {
      const where = await destination(fileName());
      if (!where) { say(''); return; }
      say('Gathering everything: this takes a few seconds…');
      await sendNow();
      const include = { shot: $('reportShot').checked, cache: $('reportCache').checked, others: $('reportOthers').checked, hotfixes: $('reportHotfixes').checked };
      const app = map();
      const page = { state: app ? part(() => snapshot(app)) : { note: 'the map itself had not started' }, log: notes(), shot: include.shot && app ? picture(app) : null };
      const body = JSON.stringify({ text, when: $('reportWhen').value, include, page });
      const ask = () => fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      let res;
      try { res = await ask(); } catch (err) {
        // The map's server went away while it was asked (it was starting itself again just then:
        // an update of the map): once it answers, it is asked once more.
        note('report', 'the map\'s server went away while the report was being made: asked again once it answers', { error: String(err?.message ?? err) });
        say('The map\'s server is starting itself again: one moment…');
        let up = false;
        for (let i = 0; i < 40 && !up; i++) {
          await new Promise((r) => setTimeout(r, 750));
          try { up = (await fetch('/api/report/check', { cache: 'no-store' })).ok; } catch { /* not yet */ }
        }
        if (!up) throw new Error('the map\'s server is not answering. Try again once the map is back.');
        say('Gathering everything: this takes a few seconds…');
        res = await ask();
      }
      if (!res.ok) { let why = `the map's server answered ${res.status}`; try { why = (await res.json()).error ?? why; } catch { /* as said */ } throw new Error(why); }
      const blob = await res.blob();
      let about = {};
      try { about = JSON.parse(decodeURIComponent(res.headers.get('x-report') ?? '%7B%7D')); } catch { /* the file is what counts */ }
      say('Saving…');
      await where.save(blob);
      note('report', 'a report was saved', { bytes: blob.size, files: about.files, couldNot: about.trouble });
      $('reportForm').style.display = 'none';
      $('reportDone').style.display = '';
      $('reportDoneText').textContent = `Saved: ${where.name}`;
      $('reportDoneMore').textContent = `${about.files ?? 'Several'} files in one zip, ${size(blob.size)}. Nothing has been sent anywhere: pass that file on to whoever is looking into the problem.${blob.size > 10 * 1048576 ? ' It is larger than some chat programs let you send: untick what you do not need and make it again, or send it another way.' : ''}`;
      $('reportDoneLeft').textContent = [...(about.trouble ?? []).map((t) => `Could not be gathered: ${t}`), ...(about.left ?? []).map((t) => `Left out: ${t}`)].join('\n');
      $('reportShow').style.display = where.reveal ? '' : 'none';
      $('reportShow').onclick = () => where.reveal?.();
    } catch (err) {
      note('report', 'a report could not be made', { error: String(err?.message ?? err) });
      say(`That did not work: ${err?.message ?? err}`, 'warn');
    } finally {
      busy = false;
      $('reportSave').disabled = false;
      $('reportCancel').disabled = false;
    }
  };

  for (const id of ['btnReport', 'fatalReport']) $(id)?.addEventListener('click', open);
  $('reportClose').addEventListener('click', close);
  $('reportCancel').addEventListener('click', close);
  $('reportAgain').addEventListener('click', close);
  $('reportSave').addEventListener('click', make);
  box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });
  box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }); // (what is typed here is not for the map's keys)
  window.__report = { open, close, make }; // (for the tests, and for the console)
}
bindReport();
