// Which level a waypoint is on.
//
// A waypoint from the game is a spot on a flat map, and so is a click on this one as far as the
// game's ground goes: under one spot there can be a street and the terrain buried beneath it, a
// floor and the floor above, a bridge and the road under it. For every waypoint with no height
// of its own, the route worker is asked which levels there are at the spot that you can
// actually walk to; the choice between them is yours:
//   - a pin on the game's map (Ctrl-click) and a marker clicked here ask you (a prompt, here
//     or in the game), showing the route to the level nearest your own height meanwhile;
//   - a quick waypoint (Shift-click) takes the level nearest your own height without asking;
//   - a guide's step takes the level that is quickest to reach, as it always has.
// Whatever was chosen can be changed in the route panel for as long as the waypoint stands.

const NEAR = 700;   // yards: this close, on the map shown, the levels are looked for from where you stand, before any route
const SAME = 2.5;   // yards: a level this close to your own height is "your level"
const HINT = 3;     // yards: a level this close to the surface you clicked is the one you clicked
const OFF = 2.5;    // yards: a place to stand further than this from the waypoint's spot is "near it", not "at it"

const clock = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${Math.round(s)} s`);

export class LevelChooser {
  constructor(app) {
    this.app = app;
    this.cur = null;      // the waypoint in hand: { key, source, map, x, y, state, list, choice, prompt, id, ... }
    this.serial = Math.floor(Math.random() * 50000) + 1; // names each list, so an answer from the game is matched to its question
    this.rev = 0;         // changes whenever what there is to show does
    this.heardKey = '';   // the last answer from the game that was acted on
    this.onChange = () => {};
  }

  #changed() { this.rev++; this.onChange(); }

  /**
   * Called every frame, before the route is asked for.
   * @param target  { map, x, y, z?, source, hint?, quick?, stamp? } where you are heading (or null)
   * @param me      [x, y, z] where you are on the map shown (or null)
   * @returns { target, hold }  the waypoint with the chosen level's height filled in once it is
   *          known; hold: do not ask for a route yet (the levels come first, and are quick)
   */
  resolve(target, me) {
    const r = this.app.route;
    if (!target || target.z !== undefined || !r?.enabled) {
      if (this.cur) { this.cur = null; this.#changed(); }
      return { target, hold: false };
    }
    const key = `${target.source}|${target.map}|${target.x.toFixed(1)}|${target.y.toFixed(1)}|${target.stamp ?? ''}`;
    let c = this.cur;
    if (!c || c.key !== key) {
      c = this.cur = {
        key, source: target.source, map: target.map, x: target.x, y: target.y, hint: target.hint ?? null, quick: !!target.quick,
        state: 'wait', near: false, list: [], choice: -1, prompt: false, id: 0, meZ: null, picked: false,
      };
      this.#changed();
    }
    if (c.state === 'wait') this.#begin(c, me);
    if (c.state !== 'done') return { target, hold: c.near };
    if (!c.list.length) return { target, hold: false };
    // (go: where the route ends, when that is not the spot itself: a waypoint on a roof or in a
    // wall is walked to at the nearest place there is to stand)
    const l = c.list[c.choice];
    return { target: { ...target, z: l.z, go: l.off > OFF ? [l.x, l.y, l.z] : undefined }, hold: false };
  }

  /** Find out where the walk to the waypoint starts, and ask which levels can be reached from there. */
  #begin(c, me) {
    const r = this.app.route;
    const here = c.map === r.mapId;
    if (me && here && Math.hypot(me[0] - c.x, me[1] - c.y) <= NEAR) {
      if (!r.info) { c.state = 'done'; this.#changed(); return; } // (no walking data for this map: nothing to choose between)
      c.near = true;
      this.#ask(c, Promise.resolve(r.info), [me[0], me[1], me[2]], false, me[2]);
      return;
    }
    // further off, or on another map: from where the last walk of the journey there begins
    const a = r.asked;
    if (!me || !a || !a.settled || a.toMap !== c.map || Math.hypot(a.to[0] - c.x, a.to[1] - c.y) > 2 || a.to[2] !== null) return; // (not planned yet)
    const walk = r.route?.lastWalk;
    if (!walk || walk.map !== c.map) { c.state = 'done'; this.#changed(); return; } // no way there: nothing to choose between
    this.#ask(c, r.infoFor(walk.map), walk.from, walk.land, me && here ? me[2] : null);
  }

  #ask(c, info, from, land, meZ) {
    c.state = 'asking';
    c.meZ = meZ;
    const finish = (m) => {
      if (this.cur !== c) return; // the waypoint has changed meanwhile
      let list = m?.ok ? m.levels : [];
      // Ground with a street or a hall built over it is not a place anyone stands; it counts only
      // where it is all there is.
      if (list.some((l) => !l.buried)) list = list.filter((l) => !l.buried);
      c.list = list;
      c.choice = list.length ? this.#first(c) : -1;
      c.id = this.serial = (this.serial % 60000) + 1;
      c.prompt = list.length > 1 && !c.quick && (c.source === 'pin' || c.source === 'marker');
      c.state = 'done';
      this.#changed();
    };
    info.then((nav) => this.app.route.levels(nav, from, [c.x, c.y, null], { landFrom: land })).then(finish, () => finish(null));
  }

  /** The level shown until you say otherwise. */
  #first(c) {
    const list = c.list;
    const best = (f) => list.reduce((b, l, i) => (f(l) < f(list[b]) ? i : b), 0);
    // the surface you clicked on this map, if you can get to it
    if (c.hint !== null && !c.quick) {
      const i = best((l) => Math.abs(l.z - c.hint));
      if (Math.abs(list[i].z - c.hint) <= HINT) return i;
    }
    if (c.source !== 'guide' && c.meZ !== null) return best((l) => Math.abs(l.z - c.meZ));
    return best((l) => l.seconds);
  }

  /** True while the levels of this waypoint are still being worked out (no route should be handed on yet). */
  busy() { return !!this.cur && this.cur.state !== 'done'; }

  /** The levels to choose between (more than one), or null. */
  get choices() {
    const c = this.cur;
    return c && c.state === 'done' && c.list.length > 1 ? c : null;
  }

  /** You chose a level (here, or in the game). */
  choose(index) {
    const c = this.choices;
    if (!c || !(index >= 0 && index < c.list.length)) return false;
    const changed = c.choice !== index || c.prompt;
    c.choice = index;
    c.picked = true;
    c.prompt = false;
    if (changed) this.#changed();
    return true;
  }

  /** The prompt was closed without choosing: the level shown stays. */
  dismiss() {
    const c = this.cur;
    if (c?.prompt) { c.prompt = false; this.#changed(); }
  }

  /** From the game: the answer to the prompt there ({ id, index, seq, session }; index counts from 1). */
  heard(answer) {
    if (!answer) return;
    const key = `${answer.id}:${answer.session ?? 0}:${answer.seq}:${answer.index}`;
    if (key === this.heardKey) return;
    const c = this.choices;
    if (!c || c.id !== answer.id) return; // (about another waypoint: kept unheard, in case its list is the one still coming)
    this.heardKey = key;
    this.choose(answer.index - 1);
  }

  /**
   * The levels as words, highest first: [{ name, where, time, label, chosen }].
   * "Upper level · 14 yd above you · 1 min 20 s"
   */
  describe() {
    const c = this.choices;
    if (!c) return [];
    const n = c.list.length;
    return c.list.map((l, i) => {
      const name = n === 2 ? (i === 0 ? 'Upper level' : 'Lower level') : i === 0 ? 'Top level' : i === n - 1 ? 'Bottom level' : `Level ${n - i} of ${n}`;
      let where;
      if (c.meZ === null) where = `elevation ${Math.round(l.z)}`;
      else {
        const d = l.z - c.meZ;
        where = Math.abs(d) < SAME ? 'your level' : d > 0 ? `${Math.round(d)} yd above you` : `${Math.round(-d)} yd below you`;
      }
      const kind = l.swim ? ', water' : l.buried ? ', under the floor' : '';
      const time = clock(l.seconds);
      return { name, where, time, kind, label: `${name}${kind} · ${where} · ${time}`, chosen: i === c.choice };
    });
  }
}
