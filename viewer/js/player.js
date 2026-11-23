// Live link to the game: where you and your party are.
// Data comes from the local server (server/tracker.js), which reads the AzerothAtlas addon's
// coded strip from the game window. How high you are is worked out in height.js.
//
// Inside a dungeon the strip says which dungeon and nothing of where: the game hides it. There
// the server reads your place off the game's minimap (server/minimap.js), a few times a second,
// and - failing that - has the place of your last blow from the game's combat log
// (server/combatlog.js). Either comes as state.placed, and is taken as where you are (receive).
//
// The following camera is here too. With "Follow me" on, the camera is tied to your character:
// it looks at them from a distance, a tilt and a compass direction of your choosing (the "rig"),
// and goes where they go. You may swing it around them and zoom; moving the map from under them
// lets go (camera.js), and "Find me" takes hold again. With "Turn with me" the direction is the
// way you face - swing it aside and it comes back when you let go. With "Auto-zoom" the distance
// is one of three, by the kind of place you are in (places.js) - zoom yourself and it comes
// back a few seconds later.
import { HeightTracker } from './height.js';
import { note } from './log.js';
import { Places } from './places.js';
import { basis, clamp, DEG } from './math.js';

const angleDelta = (a, b) => ((a - b + 540) % 360) - 180;
const HOLD_ZOOM_MS = 5000;   // after you have zoomed yourself, the automatic zoom leaves the view alone this long
const SETTLE_MS = 1200;      // a new kind of place has to last this long before the zoom goes by it (a doorway, the edge of a town)
const LOOK_MS = 250;         // how often the kind of place is looked at
export const ZOOM_DEFAULT = { in: 35, town: 110, out: 300 }; // yards from you, by the kind of place

const INSIDE_KEY = 'wfmap.inside';     // the dungeon you were last in, kept across reloads of the page
const DIED_KEY = 'wfmap.died';         // where you died, and how high (see #died), kept across reloads of the page
const DIED_FOR = 3 * 3600 * 1000;      // ...for this long: a ghost does not wait longer than that
const DIED_NEAR = 12;                  // yards: the game's place for your body is the place you died within this far (it is read off a map, to a yard or so)
const ALIVE_FOR = 20000;               // ms: where you were last heard from alive counts for where you died this long after
const PLACED_FOR = 15000;             // ms: how long where the combat log or the minimap last had you counts as where you are
const PLACED_STALE = 3000;            // ...and after this long with no new place from the minimap, the figure is drawn as one last seen there
const STEP_MOST = 700;                // ms: from one place read off the minimap to the next, at most (longer: no gliding between them)
const STEP_FAR = 14;                  // yards: ...and no further apart than this
const CATCH_FOR = 6000;               // ms: a place that comes this long after the one before is caught up with, not jumped to...
const CATCH_MS = 350;                 // ...in this long (where it is no further off than you can have run meanwhile)
const INSIDE_FOR = 3 * 3600 * 1000;    // ...for this long: a ghost does not wait longer than that

export class PlayerLink {
  constructor(app) {
    this.app = app;
    this.state = { status: 'off' };
    this.me = null;        // { map, x, y, heading, ... } resolved to world coordinates, or null
    this.shown = null;     // smoothed [x, y, z] of the marker
    this.heading = null;   // smoothed compass heading in degrees
    this.flight = null;    // on a flight path: how what flies you is turned - { heading, pitch, bank } in degrees (see #fly)
    this.follow = false;
    this.turn = false;     // (only while following) the view faces the way you face
    this.auto = false;     // (only while following) the distance goes by the kind of place you are in
    this.zoom = { ...ZOOM_DEFAULT };
    this.rig = null;       // while following: { dist, pitch, heading } - where the camera sits, counted from you
    this.place = 'out';    // the kind of place you are in ('in', 'town', 'out'), as the automatic zoom has it
    this.places = new Places(app);
    this.onChange = () => {};
    this.onFollow = () => {}; // following was switched on or off (by you, or by moving the map from under yourself)
    this.switching = false;
    this.height = new HeightTracker(app, { note });
    // the dungeon you were last in while alive or dead in it ({ map, at }), and - dead outside it - the dungeon your body is in (see receive)
    this.inside = null;
    this.bodyIn = null;
    // the last two places read off the minimap, for gliding from one to the next (see #glide): { from, to, at, span }
    this.walk = null;
    try { const s = JSON.parse(localStorage.getItem(INSIDE_KEY)); if (s && Number.isInteger(s.map) && Date.now() - s.at < INSIDE_FOR) this.inside = s; } catch { /* nothing kept */ }
    // Where you died, and how high: { map, x, y, z, at }. The game says where your body lies on
    // its flat map and nothing of how high - and a body in a cave lies under the hill the map
    // shows. This map followed you to the spot, and knows (see #died, and bodyHeight).
    this.died = null;
    this.alive = null;     // where you were last heard from alive: { map, x, y, z, at }
    this.wasDead = null;   // what the reading before said (null: none yet - a page opened on a ghost saw nobody die)
    try { const s = JSON.parse(localStorage.getItem(DIED_KEY)); if (s && Number.isInteger(s.map) && [s.x, s.y, s.z].every(Number.isFinite) && Date.now() - s.at < DIED_FOR) this.died = s; } catch { /* nothing kept */ }
  }

  connect() {
    const es = new EventSource('/api/player/events');
    es.onmessage = (e) => { this.receive(JSON.parse(e.data)); };
    es.onopen = () => { this.onOpen?.(); };
    es.onerror = () => {
      // The server is away. For a moment, most likely: it starts itself again when the map is
      // updated (server/watch.js). So you stay where you were last seen, as with any lost signal,
      // and the camera stays with you; the browser keeps trying, and where it has given up, so do we.
      if (this.state.player && this.me) { this.state = { ...this.state, status: 'nosignal', reason: 'server' }; this.onChange(); }
      else this.receive({ status: 'off', reason: 'server' });
      if (es.readyState === EventSource.CLOSED) { es.close(); setTimeout(() => this.connect(), 2000); }
    };
  }

  /** The dungeon you are in (its map), or null: you are alive outside. Kept, so that it outlasts the page loading itself again. */
  #wasIn(map) {
    if ((this.inside?.map ?? null) === map) return;
    this.inside = map === null ? null : { map, at: Date.now() };
    try { if (this.inside) localStorage.setItem(INSIDE_KEY, JSON.stringify(this.inside)); else localStorage.removeItem(INSIDE_KEY); } catch { /* not kept */ }
  }

  /**
   * Alive or dead, as the reading in hand has it: where you died is kept, with the height this
   * map had you at. The moment the game first says you are dead you still lie where you fell
   * (a ghost is only at the graveyard once you let go), so that reading's place is your body's -
   * and the height is the one you were followed to. Where the page was not on your map then
   * (no height), the last place it had you alive, if that was a moment ago and beside it.
   * Alive again, it is forgotten.
   */
  #died(p) {
    const me = this.me, z = this.height.z;
    const outdoors = !!me && !p.inInstance && !me.placed;
    if (!p.dead) {
      if (this.died) { this.died = null; try { localStorage.removeItem(DIED_KEY); } catch { /* not kept */ } }
      if (outdoors && this.onThisMap && Number.isFinite(z)) this.alive = { map: me.map, x: me.x, y: me.y, z, at: Date.now() };
      this.wasDead = false;
      return;
    }
    if (this.wasDead === false && outdoors) {
      const a = this.alive, beside = !!a && a.map === me.map && Date.now() - a.at < ALIVE_FOR && Math.hypot(a.x - me.x, a.y - me.y) <= DIED_NEAR * 2;
      const high = this.onThisMap && Number.isFinite(z) ? z : beside ? a.z : null;
      if (high !== null) {
        this.died = { map: me.map, x: me.x, y: me.y, z: high, at: Date.now() };
        try { localStorage.setItem(DIED_KEY, JSON.stringify(this.died)); } catch { /* not kept */ }
        note('route', 'you died: the height you were at is kept, for the way back to your body', { at: [Math.round(me.x), Math.round(me.y), Math.round(high * 10) / 10], indoors: !!p.indoors });
      } else note('route', 'you died where the map had no height for you: the way back to your body goes by the map alone', { at: [Math.round(me.x), Math.round(me.y)] });
    }
    this.wasDead = true;
  }

  /**
   * How high your body lies, where the game says it is at { map, x, y }: the height you died at,
   * when that is the place you died - or null (the page did not see you die, or the game has
   * your body somewhere else: carried off, or another death's).
   */
  bodyHeight(corpse) {
    const d = this.died;
    if (!d || !corpse || d.map !== corpse.map || Date.now() - d.at > DIED_FOR) return null;
    return Math.hypot(d.x - corpse.x, d.y - corpse.y) <= DIED_NEAR ? d.z : null;
  }

  get live() { return this.state.status === 'live'; }
  /** True when the marker belongs on the map that is currently open. */
  get onThisMap() { return !!this.me && this.app.scene && this.me.map === this.app.scene.map.id; }

  /** Take in the latest state from the server (what the addon in the game reported). */
  receive(state) {
    this.state = state;
    const p = state.player;
    this.me = null;
    if (p && state.status !== 'off') {
      if (p.mode === 'world') this.me = { map: p.map, x: p.x, y: p.y, z: p.z ?? null };
      else if (p.mode === 'zone') {
        // Fallback: position given as a fraction of the zone's map; convert with the zone rectangle.
        const z = this.app.world?.zones.find((q) => q.uiMap === p.zone);
        if (z) this.me = { map: z.map, x: z.region[2] - p.y * (z.region[2] - z.region[0]), y: z.region[3] - p.x * (z.region[3] - z.region[1]), z: null };
      }
      // Inside a dungeon the game tells the addon which dungeon and nothing of where. Something
      // else may say where (state.placed, from the server). The game's minimap does, all the
      // time: the server finds its picture on the dungeon's plan a few times a second
      // (server/minimap.js) - that is where you are, as surely as what the strip says outdoors.
      // And the game's own combat log does, with every blow of yours (server/combatlog.js): where
      // you WERE at that blow, shown while the minimap has nothing to say. Either is only taken
      // while it is news.
      let placedFacing = null;
      const at = state.placed;
      if (!this.me && p.inInstance && at && at.map === p.map && Number.isFinite(at.x) && Number.isFinite(at.y) && Math.abs(Date.now() - at.t) < PLACED_FOR) {
        this.me = { map: p.map, x: at.x, y: at.y, z: null, placed: at.from ?? 'log', placedAt: at.t };
        placedFacing = Number.isFinite(at.facing) ? at.facing : null;
        // (from the minimap: the heights the rooms you may be in span - which floor, where two lie over each other)
        if (Array.isArray(at.band) && at.band.length === 2 && at.band.every(Number.isFinite)) this.me.band = at.band;
        // (something was over the minimap: this is where you would have got to, going on as you were - drawn as a place not seen)
        if (at.guess) this.me.guess = true;
        if (this.me.placed === 'minimap') this.#stepped(at);
      } else if (!p.inInstance) this.walk = null;
      if (this.me) {
        const facing = p.facing ?? placedFacing;
        this.me.heading = facing === null || facing === undefined ? null : (360 - (facing * 180) / Math.PI) % 360;
        this.me.indoors = !!p.indoors;
        this.me.taxi = !!p.taxi;
        this.me.dead = !!p.dead; // (dead or a ghost: the game's marker is on your body, and nothing is measured by it - height.js)
        this.me.zone = p.zone ?? 0; // the game's own map of where you are (a zone's, or a city's)
        // How you are moving, for the height (null = the addon in the game is an older one that does not say).
        this.me.swimming = p.swimming ?? null;
        this.me.falling = p.falling ?? null;
        this.me.flying = p.flying ?? null;
        // (from the current addon: your head is under water; a time in the air began with a jump; the keys that
        // take you up and down in water; how fast the game says you move; the number of what it calls the place;
        // and when this was read off the game's window)
        this.me.submerged = p.submerged ?? null;
        this.me.mounted = p.mounted ?? null;
        this.me.jumped = p.jumped ?? null;
        this.me.ascend = p.ascend ?? null;
        this.me.descend = p.descend ?? null;
        this.me.speed = p.speed ?? null;
        this.me.place = p.place ?? null;
        // (a place read off the minimap has its own moment: the strip has said the same thing all the while)
        this.me.t = this.me.placed === 'minimap' ? this.me.placedAt : p.t ?? null;
        // (and your height as the game measured it, when it has: how far above or below two places of its map you are)
        this.me.fix = p.fix ?? null;
        this.height.reading(this.me);
      }
    }
    // In a dungeon the game says which one, and nothing of where. Dead outside, having been in one
    // when you were last heard from alive - or dead - in there, your body is in it: the run back
    // is to its door (main.js). Mostly the game has no word of where that is: its own tables say
    // it for the dungeons of the original game, and not for one new to this game.
    if (p && state.status === 'live') {
      if (p.inInstance) this.#wasIn(p.map);
      else if (!p.dead) this.#wasIn(null);
      this.bodyIn = p.dead && !p.inInstance && this.inside ? this.inside.map : null;
      this.#died(p);
    }
    // Where you are heading (your guide's current step, or a pin on the game's map) and how you
    // can travel: run and swim speed, hearthstone, the flight points you know.
    if (state.status !== 'off') {
      // (quick: a Shift-click on the game's map - no question about which level of the spot is meant)
      this.target = state.target ? { map: state.target.map, x: state.target.x, y: state.target.y, source: state.target.source, quick: state.target.source === 'quick' } : null;
      // every place you could be heading for, each on its own (addon version 6: your guide's step,
      // your own waypoint, your body, the quest you are tracking) - null from an addon that only says the one that leads
      this.heads = state.heads ?? null;
      // the level you chose in the game, for a pin with more than one under it
      if (state.choice) this.app.levels?.heard(state.choice);
      this.travel = state.travel ?? null;
      this.speeds = this.travel && this.travel.run > 0 ? { run: this.travel.run, swim: this.travel.swim > 0 ? this.travel.swim : undefined } : undefined;
    }
    // When the boats, zeppelins and tram run, as far as the game knows (kept while the game is closed: they sail on).
    if (state.transit) this.app.transit?.setLive(state.transit);
    // Your quest log and the quests you have done: fetched when the game reports a change.
    const quests = state.quests;
    if (quests && quests.rev !== this.questRev && state.status !== 'off') {
      this.questRev = quests.rev;
      fetch('/api/player/quests').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d && d.rev === this.questRev) this.app.npcs?.setQuestState(d); }).catch(() => { /* next change */ });
    }
    // Whose window you have just opened in the game: you are standing next to them (see npcs.js).
    const talk = state.talk;
    if (talk && talk.at !== this.talkAt) {
      this.talkAt = talk.at;
      if (state.status === 'live' && Date.now() - talk.at < 8000) this.app.npcs?.meet(talk, this.me);
    }
    // Follow across maps (boat, portal, entering a dungeon): the map you are on is the one in
    // hand. (Looking at another map is a way of moving the view off yourself: it ends the
    // following - see main.js - so while it is on, this is always wanted.)
    if (this.live && p && this.follow && this.app.scene && p.map !== this.app.scene.map.id) this.#switchMap(p.map);
    this.onChange();
  }

  /**
   * A place read off the minimap has come. They come four or five a second, a yard or two apart
   * at a run: shown each as it came, the figure would go in jumps. So it glides from the one
   * before to this one in the time that lay between them - a quarter of a second behind you, and
   * smoothly. (Not across a gap: after a pause, or a leap, it is simply where the new one says.)
   */
  #stepped(at) {
    const w = this.walk;
    if (w && w.t === at.t) return; // (the same place again: the link says other things in between)
    const now = performance.now();
    const to = [at.x, at.y];
    const span = w ? at.t - w.t : Infinity;
    const far = w ? Math.hypot(to[0] - w.to[0], to[1] - w.to[1]) : Infinity;
    const near = w && span > 0 && span <= STEP_MOST && far <= STEP_FAR;
    // (after a pause - a look that took long, something over the minimap for a moment - a quick catching up instead of a jump)
    const late = w && !near && span > 0 && span <= CATCH_FOR && far <= STEP_FAR + (9 * span) / 1000;
    // (from where the glide had got to, so that a place that comes early does not jerk it back)
    this.walk = { from: near || late ? this.#glide(now) ?? w.to : to, to, at: now, span: near ? span : late ? CATCH_MS : 0, t: at.t };
  }

  /** Where the glide from the last place read off the minimap to the newest has got to: [x, y] - or null: no such places. */
  #glide(now) {
    const w = this.walk;
    if (!w) return null;
    const u = w.span > 0 ? clamp((now - w.at) / w.span, 0, 1) : 1;
    return [w.from[0] + (w.to[0] - w.from[0]) * u, w.from[1] + (w.to[1] - w.from[1]) * u];
  }

  /** True while the place shown is one the minimap gave a while ago and nothing has come since (drawn as last seen there) - or one it could only guess at. */
  get waning() {
    const me = this.me;
    return !!me && me.placed === 'minimap' && (Date.now() - me.placedAt > PLACED_STALE || !!me.guess);
  }

  async #switchMap(id) {
    if (this.switching || !this.app.manifest.maps.some((m) => m.id === id)) return;
    this.switching = true;
    // (the map is about to change under the camera: none of that is you moving the view off yourself)
    this.app.camera.lock = null;
    try {
      await this.app.openMap(id);
      this.shown = null;
      this.height.reset();
    } finally { this.switching = false; }
  }

  #ground(x, y) {
    const scene = this.app.scene;
    return scene.heightAt(x, y) ?? scene.planeZ ?? (scene.map.ocean ? scene.map.seaLevel : 0);
  }

  /**
   * Fly the camera to you, to sit where the rig has it. With no rig yet (the following has just
   * begun): as far off as the view is now, where that is sensible, and no flatter than a slant.
   */
  #jumpToMe() {
    const cam = this.app.camera, me = this.me;
    const p = this.shown ?? [me.x, me.y, me.z ?? this.#ground(me.x, me.y)];
    if (!this.rig) {
      const center = cam.pickAt(cam.canvas.clientWidth / 2, cam.canvas.clientHeight / 2);
      const d = center ? Math.hypot(center[0] - cam.pos[0], center[1] - cam.pos[1], center[2] - cam.pos[2]) : 300;
      this.rig = { dist: clamp(d, 60, 700), heading: cam.heading, pitch: Math.min(cam.pitch, -30) };
    }
    if (this.auto) {
      // (the kind of place, as of now: the flight should end at the right distance)
      if (this.onThisMap) { this.place = this.places.kind(me, p, this.place); this.why = this.places.why; this.next = null; }
      this.rig.dist = this.zoom[this.place];
    }
    if (this.turn && me.heading !== null) this.rig.heading = me.heading;
    this.touch = cam.touched;
    this.zoomSeen = cam.zoomedAt;
    cam.lookAt(p, this.rig.dist, this.rig.heading, this.rig.pitch, true, true);
  }

  /** "Find me": fly the camera to your character (switching map if needed), and follow them from then on. */
  find() {
    if (this.live && this.state.player) this.setFollow(true);
  }

  setFollow(on) {
    on = !!on;
    if (this.follow !== on) {
      this.follow = on;
      if (!on) { this.rig = null; this.app.camera.lock = null; }
      this.onFollow(on);
    }
    this.app.dirty = true;
    const p = this.state.player;
    if (!on || !p || !this.live) return; // (not in the game just now: the camera comes to you when you are)
    if (this.app.scene.map.id !== p.map) this.#switchMap(p.map);
    else if (this.me && this.shown) this.#jumpToMe();
  }

  /** What you have done to the view since the last frame (a swing, a zoom), taken into the rig: counted from where you were then. */
  #capture() {
    const cam = this.app.camera, p = cam.lock.point, a = cam.anim?.tied ? cam.anim.to : cam, rig = this.rig;
    // (the distance only where you changed it: a swing leaves it be, even while the camera is riding over a hill)
    if (cam.zoomedAt !== this.zoomSeen) rig.dist = clamp(Math.hypot(a.pos[0] - p[0], a.pos[1] - p[1], a.pos[2] - p[2]), 6, 60000);
    rig.pitch = clamp(a.pitch, -89.5, -5);
    rig.heading = ((a.heading % 360) + 360) % 360;
    this.touch = cam.touched;
    this.zoomSeen = cam.zoomedAt;
  }

  /** The kind of place you are in, for the automatic zoom: looked at a few times a second, and believed once it has lasted. */
  #lookAround(now) {
    if (now - (this.lookedAt ?? 0) < LOOK_MS) return;
    this.lookedAt = now;
    const kind = this.places.kind(this.me, this.shown, this.place);
    if (kind === this.place) { this.next = null; return; }
    if (this.next?.kind !== kind) this.next = { kind, since: now, why: this.places.why };
    if (now - this.next.since >= SETTLE_MS || this.why === undefined) { this.place = kind; this.next = null; this.why = this.places.why; this.onChange(); }
  }

  /**
   * On a flight path: which way what is flying you heads, how far its nose is up or down and
   * how far it leans, for the figure to be drawn by (figure.js). It heads along the flight
   * route at the spot you are at (the game's own curve: steadier than your position from one
   * reading to the next, and right from the first moment), noses up and down with the route,
   * and leans into a turn by how fast it is turning. Off any route the map knows, it heads the
   * way you are moving, or failing that the way the game says you face.
   */
  #fly(dt) {
    const me = this.me;
    if (!me.taxi) { this.flight = null; return; }
    const ride = this.height.ride, course = this.height.course;
    let dir = null, rise = 0;
    if (ride?.flight && ride.dir) {
      dir = ride.dir; rise = ride.rise ?? 0;
      // (a route flown the other way, or taken for the one coming back beside it)
      if (course && dir[0] * course[0] + dir[1] * course[1] < 0) { dir = [-dir[0], -dir[1]]; rise = -rise; }
    } else if (course) dir = course;
    const f = this.flight;
    const want = dir ? (Math.atan2(-dir[1], dir[0]) / DEG + 360) % 360 : me.heading ?? f?.heading ?? 0;
    const pitch = clamp(Math.atan(rise) / DEG, -50, 50);
    if (!f) { this.flight = { heading: want, pitch, bank: 0 }; return; }
    const turn = angleDelta(want, f.heading) * (1 - Math.exp(-dt * 6));
    f.heading = (f.heading + turn + 360) % 360;
    f.pitch += (pitch - f.pitch) * (1 - Math.exp(-dt * 4));
    // (degrees a second it is turning by; to the right is leaning right)
    const lean = dt > 0 ? clamp((turn / dt) * 1.1, -32, 32) : 0;
    f.bank += (lean - f.bank) * (1 - Math.exp(-dt * 3));
  }

  /** The camera while it follows you: where the rig has it, turned and zoomed as asked. True while it is moving. */
  #followCamera(dt, now) {
    const cam = this.app.camera, at = this.shown;
    if (cam.lock) cam.lock.point = at; else cam.lock = { point: at };
    if (this.auto) this.#lookAround(now);
    // not with you yet (the following has just begun, or something that was no move of yours - a map opening - sent the view elsewhere): fly there
    if (!this.rig || (cam.anim && !cam.anim.tied)) { this.#jumpToMe(); return true; }
    const rig = this.rig;
    if (cam.anim) {
      // on the way to you: the flight ends where you are by then
      const a = cam.anim, b = basis(a.to.heading, a.to.pitch);
      a.to.pos = [at[0] - b.f[0] * rig.dist, at[1] - b.f[1] * rig.dist, at[2] - b.f[2] * rig.dist];
      return true;
    }
    // Turn with me: the view faces the way you face. While you hold it aside (a drag, Q or E) it is yours; let go, and it comes back.
    if (this.turn && this.heading !== null && !cam.drag?.orbit && !cam.keys.has('KeyQ') && !cam.keys.has('KeyE')) {
      const d = angleDelta(this.heading, rig.heading);
      rig.heading = Math.abs(d) > 0.05 ? (rig.heading + d * (1 - Math.exp(-dt * 5)) + 360) % 360 : this.heading;
    }
    // Auto-zoom: the distance set for this kind of place. Zoom yourself, and it is left alone for a few seconds.
    if (this.auto && now - cam.zoomedAt > HOLD_ZOOM_MS) {
      const want = this.zoom[this.place], r = want / rig.dist;
      rig.dist = Math.abs(Math.log(r)) > 0.002 ? rig.dist * r ** (1 - Math.exp(-dt * 2.5)) : want;
    }
    return cam.place(at, rig.heading, rig.pitch, rig.dist);
  }

  /** Advance smoothing and follow-camera. Returns true while something is still moving. */
  update(dt) {
    const cam = this.app.camera;
    if (!this.onThisMap) { cam.lock = null; if (this.shown) { this.shown = null; return true; } return false; }
    if (!this.live) return false; // signal lost: leave the marker at the last known spot (and the camera with it)
    if (this.follow && this.rig && cam.lock && cam.touched !== this.touch) this.#capture();
    const me = this.me, now = performance.now();
    const jumped = !this.shown || Math.hypot(me.x - this.shown[0], me.y - this.shown[1]) > 120;
    if (jumped) this.height.reset(); // first fix or a teleport: no way in between to go by
    const target = [me.x, me.y, this.height.update(me)];
    // (read off the minimap: on the way from the place before to this one - #stepped)
    const glide = me.placed === 'minimap' && !jumped ? this.#glide(now) : null;
    if (glide) { target[0] = glide[0]; target[1] = glide[1]; }
    this.#fly(dt);
    // (keep refreshing until the buildings here have loaded - and on a flight path, where wings are beating - and while gliding)
    let moving = this.height.pending || !!this.flight || (!!glide && this.walk.span > 0 && now - this.walk.at < this.walk.span);
    if (jumped) {
      // do not glide across the map
      const first = !this.shown;
      this.shown = target;
      this.heading = me.heading;
      if (this.follow) {
        cam.lock = { point: this.shown };
        // (a teleport: the camera flies after you; the first sight of you is left to the frame after this)
        if (this.rig && !first) this.#jumpToMe();
      }
      return true;
    }
    const k = 1 - Math.exp(-dt * 14);
    const step = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      step[i] = (target[i] - this.shown[i]) * k;
      if (Math.abs(target[i] - this.shown[i]) < 0.02) step[i] = target[i] - this.shown[i];
      this.shown[i] += step[i];
      if (step[i] !== 0) moving = true;
    }
    if (me.heading !== null) {
      if (this.heading === null) this.heading = me.heading;
      const d = angleDelta(me.heading, this.heading);
      if (Math.abs(d) > 0.05) { this.heading = (this.heading + d * (1 - Math.exp(-dt * 16)) + 360) % 360; moving = true; }
    } else this.heading = null;

    if (this.follow) { if (this.#followCamera(dt, now)) moving = true; }
    else cam.lock = null;
    return moving;
  }

  /** What to draw on the map this frame. */
  markers() {
    const out = { player: null, party: [], dots: [] };
    if (!this.app.scene) return out;
    const s = this.state;
    if (this.shown && this.onThisMap) {
      // stale = last known position while the signal is lost (drawn greyed out)
      // (...or where the minimap last had you, some seconds ago: it shows nothing just now, or is covered)
      out.player = { x: this.shown[0], y: this.shown[1], z: this.shown[2], heading: this.heading, dead: s.player.dead, stale: !this.live || this.waning };
      // on a flight path: drawn riding what flies your side's (figure.js), turned as it is
      if (this.flight && this.me?.taxi) out.player.flight = { ...this.flight, faction: s.player.faction };
    } else if (this.me && s.player) {
      // On another map of the picture than the one in hand (the other continent, the island): the arrow, where the game says you are.
      const off = this.app.offsetOf?.(this.me.map), x = this.me.x + (off?.[0] ?? 0), y = this.me.y + (off?.[1] ?? 0);
      if (off) out.player = { x, y, z: this.me.z ?? this.app.camera?.scene?.heightAt(x, y) ?? 0, heading: this.me.heading, dead: s.player.dead, stale: !this.live, beside: true };
    }
    if (this.live && s.player && s.player.map === this.app.scene.map.id) {
      for (const m of s.party ?? []) {
        if (m.x === null) continue;
        out.party.push({ x: m.x, y: m.y, z: this.#ground(m.x, m.y), name: m.name ?? `Party ${m.slot}`, dead: m.dead });
      }
      // What the game's minimap shows as dots - what you track, your target, your pet
      // (server/dots.js): each where it is. The game says nothing of how high: on the ground there -
      // or, where you are indoors or under ground yourself, as high as you are.
      const show = this.app.opts?.dots, level = s.player.indoors && this.shown ? this.shown[2] : null;
      for (const d of show ? s.dots ?? [] : []) {
        if (d.role === 'pet' ? show.pet : show.tracked) out.dots.push({ ...d, z: level ?? this.#ground(d.x, d.y) });
      }
    }
    return out;
  }
}
