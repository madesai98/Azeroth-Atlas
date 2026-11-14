// The routes: one to each place you could be heading for, each in its own colour.
//
//   guide     your guide's current step
//   quest     the quest you are tracking in the game: the nearest of what it has you kill, use
//             or collect - or, once it is ready to hand in, who takes it
//   waypoint  the last waypoint you placed yourself: a Ctrl-click or a Shift-click on the game's
//             map, or a click on this one
//   death     your body, while you are a ghost
//   ally      each member of your party
//
// One of them leads: the one the game itself is heading for (its route is the one the addon
// follows there). That one is worked out by the page's own planner (main.js: app.route), as it
// always was. The others get a planner each here; they all ask the one route worker, and share
// the walks it has already worked out. Each can be switched off, and given another colour.
import { RoutePlanner, RouteRenderer } from './route.js';

export const ROUTES = [
  { key: 'guide', label: 'Guide objective', color: '#4ade80', hint: "To your guide's current step" },
  { key: 'quest', label: 'Tracked quest', color: '#ffd23a', hint: 'To the quest you are tracking in the game: the nearest of what it has you kill, use or collect, or who takes it once it is ready to hand in' },
  { key: 'waypoint', label: 'Waypoint', color: '#4aa8ff', hint: "To the last waypoint you placed: a Ctrl-click or Shift-click on the game's map, or a click on this one" },
  { key: 'death', label: 'Corpse run', color: '#ff5a4d', hint: 'To your body, while you are a ghost (on foot: a ghost takes no flight)' },
  { key: 'ally', label: 'Party members', color: '#b98cff', hint: 'To each member of your party who is on your map' },
];
const SLOTS = ['guide', 'quest', 'waypoint', 'death', 'ally1', 'ally2', 'ally3', 'ally4'];
export const kindOf = (slot) => (slot.startsWith('ally') ? 'ally' : slot);
const KEY = 'wfmap.routes';
const ALLY_EVERY = 4000; // ms: someone on the move is headed for anew no more often than this...
const ALLY_FAR = 60;     // ...unless they have gone this many yards

export class Trips {
  /** @param lead  the page's own planner (the route that leads)   @param leadRenderer  what draws it */
  constructor(app, lead, leadRenderer) {
    this.app = app;
    this.lead = lead;
    this.leadRenderer = leadRenderer;
    this.leadKind = 'waypoint';
    this.settings = Object.fromEntries(ROUTES.map((r) => [r.key, { on: true, color: r.color }]));
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      for (const r of ROUTES) {
        const s = saved?.[r.key];
        if (!s) continue;
        if (typeof s.on === 'boolean') this.settings[r.key].on = s.on;
        if (/^#[0-9a-f]{6}$/i.test(s.color ?? '')) this.settings[r.key].color = s.color;
      }
    } catch { /* the usual colours, all of them on */ }
    this.extra = new Map(); // slot -> { planner, renderer, target, given, givenAt }
    this.map = null;
    this.onChange = () => {};
  }

  /** Switch a kind of route on or off, or give it another colour. */
  set(kind, patch) {
    Object.assign(this.settings[kind], patch);
    try { localStorage.setItem(KEY, JSON.stringify(this.settings)); } catch { /* not remembered */ }
    this.onChange();
  }

  color(kind) { return this.settings[kind]?.color ?? '#ffd23a'; }
  on(kind) { return !!this.settings[kind]?.on; }

  /** The map in hand has changed: every planner searches that one now. */
  setMap(map) {
    this.map = map;
    for (const x of this.extra.values()) x.planner.setMap(map);
  }

  #slot(slot) {
    let x = this.extra.get(slot);
    if (!x) {
      const planner = new RoutePlanner(this.app, this.lead);
      planner.walkOnly = slot === 'death';
      planner.onChange = () => this.onChange();
      if (this.map) planner.setMap(this.map);
      x = { slot, planner, renderer: new RouteRenderer(this.app.gpu), target: null, given: null, givenAt: 0 };
      this.extra.set(slot, x);
    }
    return x;
  }

  /**
   * Keep every route but the leading one current. Called every frame.
   * @param me        [x, y, z] where you are (or null)
   * @param leadKind  the kind of the route that leads ('guide' or 'waypoint'): the page's own planner has that one
   * @param want      { [slot]: { map, x, y, z?, name?, source } } where each of the others is heading
   * @param on        false: routes are switched off altogether
   */
  update(me, leadKind, want, speeds, on, now = performance.now()) {
    this.leadKind = leadKind;
    for (const slot of SLOTS) {
      const kind = kindOf(slot);
      let target = on && this.settings[kind].on && slot !== leadKind ? want[slot] ?? null : null;
      const had = this.extra.get(slot);
      if (!target && !had) continue;
      const x = had ?? this.#slot(slot);
      if (target && kind === 'ally' && x.given) {
        // (someone walking is somewhere new with every reading: the way to them is not worked out again for each)
        const far = Math.hypot(target.x - x.given.x, target.y - x.given.y) > ALLY_FAR || target.map !== x.given.map;
        if (!far && now - x.givenAt < ALLY_EVERY) target = x.given;
      }
      if (target !== x.given) { x.given = target; x.givenAt = now; }
      x.target = target;
      x.planner.enabled = !!target;
      x.planner.update(target ? me : null, target, speeds, now);
    }
  }

  /**
   * Every route there is just now, the leading one first: [{ kind, slot, color, planner, renderer,
   * target, lead }]. (For the lines on the map, the marks at their ends and the list in the sidebar.)
   */
  active() {
    const out = [];
    if (this.lead.route || this.lead.asked) out.push({ kind: this.leadKind, slot: this.leadKind, color: this.color(this.leadKind), planner: this.lead, renderer: this.leadRenderer, target: this.app.routeTarget ?? null, lead: true });
    for (const x of this.extra.values()) {
      if (!x.target) continue;
      const kind = kindOf(x.slot);
      out.push({ kind, slot: x.slot, color: this.color(kind), planner: x.planner, renderer: x.renderer, target: x.target, lead: false });
    }
    return out;
  }

  /** The lines of the routes that do not lead (the leading one is drawn by main.js, as ever). */
  draw(pass, camera, offsetOf, key) {
    this.leadRenderer.setColor(this.color(this.leadKind));
    for (const x of this.extra.values()) {
      if (!x.target) continue;
      x.renderer.setColor(this.color(kindOf(x.slot)));
      x.renderer.draw(pass, x.planner, camera, offsetOf, key);
    }
  }

  /** ...and what of them lies on the other continent or across the sea (after the water: see RouteRenderer.drawRest). */
  drawRest(pass) {
    for (const x of this.extra.values()) if (x.target) x.renderer.drawRest(pass);
  }
}
