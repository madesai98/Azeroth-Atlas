// Maps that belong on one picture.
//
// The game keeps each continent as a map of its own, with its own coordinates, and moves you
// from one to the other on a boat. Its world map shows them side by side all the same: the
// picture of Azeroth has a rectangle for the Eastern Kingdoms and one for Kalimdor. Those
// rectangles are in the game's files (world.json's zones), so where the continents lie from one
// another can be worked out, and both can be drawn here on one sea, as far apart as the game's
// own world map has them.
//
// Zephras Isle has no rectangle on that picture: it is an island in the sky, its ground some 650
// yards up, reached only by the airships from Dalaran and from Skywatcher Plateau. It is put on
// the picture all the same, out over the sea between the two continents its airships come from
// (see islandsOn), at its own heights: it floats over the sea.
//
// One of the maps on a picture is the map in hand: everything on the page works in its
// coordinates, as with any single map. The others are drawn beside it, each moved over by a
// fixed number of yards (a whole number of terrain tiles, so that all of them lie on one grid and
// the sea between them can be shared out tile by tile).

import { TILE } from './math.js';

const ZERO = [0, 0];

/**
 * Where each map that shares a picture of the world with another lies: Map of map id ->
 * { group (the picture's id), at: [x, y], floor } - a place in the map's own coordinates is at
 * that place plus `at`, in yards, in a frame common to the group; `floor` (an island in the sky
 * only) is the height below which its ground is not drawn (see islandsOn). Maps not in it stand
 * alone.
 * @param world  world.json
 * @param have   the ids of the maps there is terrain for
 */
export function worldLayout(world, have) {
  const out = new Map();
  const pictures = new Map();
  // (type 1: a picture of a whole world, each continent a rectangle on it)
  for (const z of world.zones ?? []) {
    if (z.type !== 1 || !have.has(z.map) || !z.ui || !(z.ui[2] > z.ui[0]) || !(z.ui[3] > z.ui[1])) continue;
    if (!pictures.has(z.uiMap)) pictures.set(z.uiMap, []);
    if (!pictures.get(z.uiMap).some((q) => q.map === z.map)) pictures.get(z.uiMap).push(z);
  }
  for (const [id, list] of pictures) {
    if (list.length < 2) continue;
    // Yards to one unit of the picture, down it and across it (the same for every map on it, but
    // for rounding in the game's numbers: the mean is used).
    let down = 0, across = 0;
    for (const z of list) { down += (z.region[2] - z.region[0]) / (z.ui[3] - z.ui[1]); across += (z.region[3] - z.region[1]) / (z.ui[2] - z.ui[0]); }
    down /= list.length; across /= list.length;
    const mid = (z) => ({ u: (z.ui[0] + z.ui[2]) / 2, v: (z.ui[1] + z.ui[3]) / 2, x: (z.region[0] + z.region[2]) / 2, y: (z.region[1] + z.region[3]) / 2 });
    const first = mid(list[0]);
    for (const z of list) {
      if (out.has(z.map)) continue;
      const m = mid(z);
      // (north is up the picture and x runs north; west is to its left and y runs west)
      const x = first.x - (m.v - first.v) * down - m.x, y = first.y - (m.u - first.u) * across - m.y;
      out.set(z.map, { group: id, at: [Math.round(x / TILE) * TILE, Math.round(y / TILE) * TILE] });
    }
  }
  islandsOn(world, have, out);
  return out;
}

/**
 * Maps that are on no picture of the game's, but that its airships or boats join to two maps
 * of one (Zephras Isle: from Dalaran, in the Eastern Kingdoms, and from Skywatcher Plateau, in
 * Kalimdor), are put on that picture too. Where is this map's own choice, not the game's:
 *  - as far north as puts its docks level with the middle of the docks its craft sail from, so
 *    that the crossings go across the sea between the continents rather than up or down it;
 *  - east to west, its middle halfway between the coasts of those two maps, along the stretch
 *    of the sea it takes up (each coast as far out as the zones of that map go there);
 *  - in whole tiles, as everything on a picture is.
 * Its ground goes down in cliffs from its docks almost to the height of the sea (in the game
 * there is nothing under the island but sky). Over the sea of the picture those cliffs would
 * stand in the water, so the island is drawn down to halfway between its lowest dock and the
 * sea, and floats.
 */
function islandsOn(world, have, out) {
  const zones = (map) => (world.zones ?? []).filter((z) => z.type === 3 && z.map === map && z.region);
  for (const id of have) {
    if (out.has(id)) continue;
    // the lines that join it to maps on a picture: its own dock, and the dock across on the picture
    const links = [];
    for (const t of world.transports ?? []) {
      const mine = t.stops.find((s) => s.map === id);
      if (!mine) continue;
      for (const s of t.stops) {
        const g = out.get(s.map);
        if (g && s.map !== id) links.push({ group: g.group, map: s.map, from: mine.pos, to: [s.pos[0] + g.at[0], s.pos[1] + g.at[1]] });
      }
    }
    const own = zones(id);
    for (const group of new Set(links.map((l) => l.group))) {
      const ls = links.filter((l) => l.group === group), maps = [...new Set(ls.map((l) => l.map))];
      if (maps.length < 2 || !own.length) continue;
      const mean = (f) => ls.reduce((s, l) => s + f(l), 0) / ls.length;
      const x = Math.round((mean((l) => l.to[0]) - mean((l) => l.from[0])) / TILE) * TILE;
      // (the island's own extent, from its zones; and each map's coast along the stretch it takes up)
      const x0 = Math.min(...own.map((z) => z.region[0])) + x, x1 = Math.max(...own.map((z) => z.region[2])) + x;
      const y0 = Math.min(...own.map((z) => z.region[1])), y1 = Math.max(...own.map((z) => z.region[3]));
      const sides = maps.map((m) => {
        const g = out.get(m), along = zones(m).filter((z) => z.region[2] + g.at[0] > x0 && z.region[0] + g.at[0] < x1);
        return along.length ? [Math.min(...along.map((z) => z.region[1])) + g.at[1], Math.max(...along.map((z) => z.region[3])) + g.at[1]] : null;
      }).filter(Boolean).sort((a, b) => a[0] + a[1] - b[0] - b[1]);
      // (two maps side by side, the sea open between them: its middle; otherwise between the docks across)
      const middle = sides.length === 2 && sides[0][1] < sides[1][0] ? (sides[0][1] + sides[1][0]) / 2 : mean((l) => l.to[1]);
      const y = Math.round((middle - (y0 + y1) / 2) / TILE) * TILE;
      out.set(id, { group, at: [x, y], floor: Math.min(...ls.map((l) => l.from[2] ?? 0)) / 2 });
      break;
    }
  }
}

/** Is this map an island in the sky over the sea of its picture (it has a floor: see islandsOn)? */
const floats = (scene) => typeof scene.floor === 'number';

/** The ground of one map, where it is ground: an island in the sky has none in its holes, nor under its floor. */
function groundOf(scene, x, y) {
  const h = scene.heightAt(x, y);
  if (h === null || !floats(scene)) return h;
  return h < scene.floor || scene.holeAt(x, y) ? null : h;
}

/**
 * The ground of the picture, for the camera: the map in hand, and the others on the picture
 * where the first has nothing. Positions are in the coordinates of the map in hand.
 */
export class Ground {
  /**
   * @param scene   MapScene of the map in hand
   * @param beside  the other maps on the picture: [{ scene (MapScene), off (where its origin
   *                lies in the first one's coordinates: [x, y]) }]
   */
  constructor(scene, beside = []) {
    this.scene = scene; this.beside = beside;
  }

  get map() { return this.scene.map; }

  heightAt(x, y) {
    const h = groundOf(this.scene, x, y);
    if (h !== null) return h;
    for (const b of this.beside) {
      const g = groundOf(b.scene, x - b.off[0], y - b.off[1]);
      if (g !== null) return g;
    }
    return null;
  }

  /** First thing a ray meets on any of the maps (or their sea): [x, y, z] or null. */
  pick(origin, dir, maxDist = 80000, gone = null) {
    let best = null, bestD = Infinity;
    // (the cutaway's hole is on the map you are on: the one in hand)
    for (const { scene, off, cut } of [{ scene: this.scene, off: ZERO, cut: gone }, ...this.beside]) {
      const o = [origin[0] - off[0], origin[1] - off[1], origin[2]];
      let reach = maxDist, skip = cut ?? null;
      if (floats(scene)) {
        // An island in the sky: what lies in its holes or under its floor is not there, and a
        // ray that has gone down past the floor meets nothing of it.
        const floor = scene.floor;
        if (dir[2] < 0) reach = Math.min(maxDist, (floor - o[2]) / dir[2]);
        if (!(reach > 0)) continue;
        skip = (x, y, z) => z < floor || scene.holeAt(x, y) || !!cut?.(x, y, z);
      }
      const p = scene.pick(o, dir, reach, skip);
      if (!p) continue;
      p[0] += off[0]; p[1] += off[1];
      const d = (p[0] - origin[0]) ** 2 + (p[1] - origin[1]) ** 2 + (p[2] - origin[2]) ** 2;
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  /**
   * Which of the maps on the picture a spot is on: the one in hand where it has a tile; else
   * another that has one - an island in the sky only where the spot is up on it, above its floor
   * (under it is the sea) - else, out on the open sea, the one in hand, or the first with a sea
   * of its own where the one in hand has none. @returns the map's index: 0 for the one in hand,
   * 1 + its place in `beside` for another
   * @param z  the height of the spot (null: not known; then any tile there counts)
   */
  whose(x, y, z = null) {
    const on = (scene, sx, sy) => scene.hasTile(sx, sy) && (!floats(scene) || z === null || z >= scene.floor);
    if (on(this.scene, x, y)) return 0;
    const i = this.beside.findIndex((b) => on(b.scene, x - b.off[0], y - b.off[1]));
    if (i >= 0) return i + 1;
    return this.scene.map.ocean ? 0 : this.beside.findIndex((b) => b.scene.map.ocean) + 1;
  }
}

/**
 * Share the open sea out between the maps drawn on one picture, so that no stretch of it is
 * drawn twice and none is drawn over another map's land: the map in hand draws all of its own
 * stretch but for the other maps' tiles, and each of the others draws what lies outside the
 * stretches of the ones before it, again but for the others' tiles. A map with no sea of its own
 * (an island in the sky) takes no part: the sea goes on under it, at the level of the others'.
 * (With one map that has a sea: back to each drawing its own.)
 * @param maps  [{ scene, off }]: the map in hand first, then the others, each with where its
 *              origin lies in the coordinates of the one in hand ([x, y])
 */
export function shareSea(maps) {
  for (const m of maps) m.scene.seaClip = null;
  const seas = maps.filter((m) => m.scene.map.ocean);
  if (seas.length < 2) return;
  seas.forEach((m, k) => {
    const others = seas.filter((o) => o !== m), before = seas.slice(0, k).filter((o) => o.scene.sea);
    m.scene.seaClip = (xN, yW, size) => {
      // (the square, in the coordinates of the map in hand)
      const X = xN + m.off[0], Y = yW + m.off[1], all = Math.round(size / TILE) ** 2;
      let part = 0;
      for (const o of others) {
        const n = o.scene.tilesIn(X - o.off[0], Y - o.off[1], size);
        if (n >= all) return 1;
        if (n > 0) part = 2;
      }
      for (const o of before) {
        const sea = o.scene.sea, x1 = X - o.off[0], x0 = x1 - size, y1 = Y - o.off[1], y0 = y1 - size;
        if (x1 <= sea.x0 + 1 || x0 >= sea.x1 - 1 || y1 <= sea.y0 + 1 || y0 >= sea.y1 - 1) continue;
        if (x0 >= sea.x0 - 1 && x1 <= sea.x1 + 1 && y0 >= sea.y0 - 1 && y1 <= sea.y1 + 1) return 1;
        part = 2;
      }
      return part;
    };
  });
}
