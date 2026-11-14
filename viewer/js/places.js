// What kind of place your character is in, for the following camera's automatic zoom (player.js):
//
//   'in'    inside a building or a cave
//   'town'  in a city or a town, or where your quests have you go
//   'out'   anywhere else
//
// Nothing here is a list of places: it is all worked out from the game's own data, so it keeps
// working when the game adds a town.
//
// Indoors is the game's own word for it (the addon passes it on) - except in a city under the
// ground. Ironforge and the Undercity are each one building, and in the game's data every room
// of them is an indoor room, the great halls and the streets included: the game's word cannot
// tell a shop from the hall it opens on there. So there it goes by the room you stand in, as
// the game itself divides the city into rooms. A shop, the inn, the bank, the auction house are
// rooms of a few hundred square yards (270 to 2,200 in the two cities); the halls, rings and
// quarters are rooms of 4,000 and up.
//
// A town is: one of the capitals (the game says which city's map you are on; the map's area
// data says it too); a named part of a zone with an innkeeper or several people with a job in
// it (vendors, trainers, a flight master...), or one the game's own world map marks as a town;
// or anywhere an innkeeper or several such people are close by.
//
// Where your quests have you go: near who gives a quest open to you, near what a quest in your
// log has you kill, use or collect, near where one is handed in (npcs.js works these out from
// your quest log), and near the waypoint you are heading for.

export const SMALL_ROOM = 3000; // square yards: a room smaller than this, in a city under the ground, is "indoors"
const UNDER = 4;           // yards under the terrain over you before you count as under the ground
const BUSY = 3;            // this many people with a job close by make a town...
const BUSY_NEAR = 70;      // ...within this many yards
const INN_NEAR = 80;       // an innkeeper this close makes one by itself
const AREA_BUSY = 4;       // a named part of a zone with this many of them in it (or an innkeeper) is a town
const QUEST_NEAR = 60;     // yards from the business of a quest
const GOAL_NEAR = 60;      // yards from where you are heading
const STAY = 1.4;          // once in a town or a quest's area, it reaches this much further (no flickering at its edge)
const TOWN_ICONS = new Set([4, 5, 6]); // how the game's world map marks settlements

export class Places {
  constructor(app) {
    this.app = app;
    this.why = '';       // what the last answer went by, in a few words (shown as a tip on the page)
    this.small = false;  // the last room found in a city under the ground was a small one
    this.towns = null;
  }

  /**
   * @param me   the game's latest reading of you ({ map, indoors, taxi, zone, ... }: player.js)
   * @param at   where you are, [x, y, z] (z as the map follows it)
   * @param was  the answer last time
   */
  kind(me, at, was = 'out') {
    if (me.taxi) { this.why = 'on a flight'; return 'out'; }
    const town = this.#town(me, at, was === 'town' ? STAY : 1);
    if (this.#indoors(me, at, town)) return 'in';
    if (town) { this.why = town; return 'town'; }
    const quest = this.#quest(me, at, was === 'town' ? STAY : 1);
    if (quest) { this.why = quest; return 'town'; }
    this.why = 'open country';
    return 'out';
  }

  #indoors(me, at, town) {
    const app = this.app, scene = app.scene;
    const over = scene?.heightAt(at[0], at[1]) ?? null;
    if (town && over !== null && at[2] < over - UNDER) {
      // a city under the ground: by the room you are in
      const { room, pending } = app.floors?.room(app.objects?.wmos ?? [], at[0], at[1], at[2]) ?? { room: null, pending: false };
      if (room) this.small = room.area < SMALL_ROOM;
      else if (!pending) this.small = false; // (on no floor of the city's: its open ground)
      if (this.small) this.why = `a room of ${town}`;
      return this.small;
    }
    this.small = false;
    if (me.indoors) this.why = 'indoors';
    return !!me.indoors;
  }

  /** The towns of the map in hand: { areas: Set of area ids, spots } (worked out again when its NPCs or their part in your quests change). */
  #towns() {
    const app = this.app, scene = app.scene, spots = app.npcs?.spots() ?? null;
    const t = this.towns;
    if (t && t.scene === scene && t.grid === scene.areas && t.spots === spots) return t;
    const areas = new Set(), world = app.world;
    const part = (x, y) => { const id = scene.areaAt(x, y); return id && world.areas[id]?.p ? id : 0; }; // (a whole zone is not a town)
    if (spots && spots.map === scene.map.id) {
      const by = new Map();
      for (let k = 0; k < spots.n; k++) {
        if (!(spots.bits[k] & 1)) continue;
        const id = part(spots.x[k], spots.y[k]);
        if (!id) continue;
        let a = by.get(id);
        if (!a) by.set(id, (a = { who: new Set(), inn: false }));
        a.who.add(spots.who[k]);
        if (spots.bits[k] & 2) a.inn = true;
      }
      for (const [id, a] of by) if (a.inn || a.who.size >= AREA_BUSY) areas.add(id);
    }
    // what the game's world map marks as a settlement, where it stands in the part of the zone named after it
    for (const p of world.pois ?? []) {
      if (p.map !== scene.map.id || !TOWN_ICONS.has(p.icon)) continue;
      const id = part(p.pos[0], p.pos[1]);
      if (id && world.areas[id].n === p.name) areas.add(id);
    }
    this.towns = { scene, grid: scene.areas, spots, areas };
    return this.towns;
  }

  /** The name of the town you are in, or null. */
  #town(me, at, reach) {
    const app = this.app, world = app.world, scene = app.scene;
    if (!scene || !world) return null;
    this.capitals ??= new Set((world.capitals ?? []).map((c) => c.area));
    this.zoneOf ??= new Map(world.zones.map((z) => [z.uiMap, z]));
    // a capital: the game's word (which city's map you are on), else the map's own area data
    const zone = this.zoneOf.get(me.zone);
    if (zone && zone.map === me.map && this.capitals.has(zone.area)) return zone.name;
    const here = scene.areaAt(at[0], at[1]);
    for (let i = 0, id = here; i < 8 && id; i++, id = world.areas[id]?.p) if (this.capitals.has(id)) return world.areas[id].n;
    const t = this.#towns();
    if (t.areas.has(here)) return world.areas[here].n;
    // who works close by
    const s = t.spots;
    if (s && s.map === me.map) {
      const who = new Set(), busy = BUSY_NEAR * reach, inn = INN_NEAR * reach;
      for (let k = 0; k < s.n; k++) {
        if (!(s.bits[k] & 1)) continue;
        const d = Math.hypot(s.x[k] - at[0], s.y[k] - at[1]);
        if (s.bits[k] & 2 && d <= inn) return 'an inn';
        if (d <= busy) who.add(s.who[k]);
      }
      if (who.size >= BUSY) return 'a settlement';
    }
    return null;
  }

  /** What of your quests is close by, in a few words, or null. */
  #quest(me, at, reach) {
    const app = this.app;
    const goal = app.routeTarget;
    if (goal && goal.map === me.map && Math.hypot(goal.x - at[0], goal.y - at[1]) <= GOAL_NEAR * reach) return 'where you are heading';
    const s = app.npcs?.spots();
    if (!s || s.map !== me.map) return null;
    const near = QUEST_NEAR * reach;
    for (let k = 0; k < s.n; k++) if (s.bits[k] & 4 && Math.abs(s.x[k] - at[0]) <= near && Math.hypot(s.x[k] - at[0], s.y[k] - at[1]) <= near) return 'a quest of yours';
    return null;
  }
}
