// Maps that belong on one picture.
//
// The game keeps each continent as a map of its own, with its own coordinates, and moves you
// from one to the other on a boat. Its world map shows them side by side all the same: the
// picture of Azeroth has a rectangle for the Eastern Kingdoms and one for Kalimdor. Those
// rectangles are in the game's files (world.json's zones), so where the continents lie from one
// another can be worked out, and both can be drawn here on one sea, as far apart as the game's
// own world map has them.
//
// One of the two is the map in hand: everything on the page works in its coordinates, as with
// any single map. The other is drawn beside it, moved over by a fixed number of yards (a whole
// number of terrain tiles, so both lie on one grid and the sea between them can be shared out
// tile by tile).

import { TILE } from './math.js';

/**
 * Where each map that shares a picture of the world with another lies: Map of map id ->
 * { group (the picture's id), at: [x, y] } - a place in the map's own coordinates is at that
 * place plus `at`, in yards, in a frame common to the group. Maps not in it stand alone.
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
  return out;
}

/**
 * The ground of the picture, for the camera: the map in hand, and the one beside it where the
 * first has nothing. Positions are in the coordinates of the map in hand.
 */
export class Ground {
  /**
   * @param scene   MapScene of the map in hand
   * @param beside  MapScene of the map beside it, or null
   * @param off     where that map's origin lies in the first one's coordinates: [x, y]
   */
  constructor(scene, beside = null, off = [0, 0]) {
    this.scene = scene; this.beside = beside; this.off = off;
  }

  get map() { return this.scene.map; }

  heightAt(x, y) {
    const h = this.scene.heightAt(x, y);
    if (h !== null || !this.beside) return h;
    return this.beside.heightAt(x - this.off[0], y - this.off[1]);
  }

  /** First thing a ray meets on either map (or their sea): [x, y, z] or null. */
  pick(origin, dir, maxDist, gone = null) {
    const a = this.scene.pick(origin, dir, maxDist, gone); // (the hole is on the map you are on: the one in hand)
    if (!this.beside) return a;
    const o = this.off;
    const b = this.beside.pick([origin[0] - o[0], origin[1] - o[1], origin[2]], dir, maxDist);
    if (!b) return a;
    b[0] += o[0]; b[1] += o[1];
    if (!a) return b;
    const far = (p) => (p[0] - origin[0]) ** 2 + (p[1] - origin[1]) ** 2 + (p[2] - origin[2]) ** 2;
    return far(b) < far(a) ? b : a;
  }
}

/**
 * Share the open sea out between two maps drawn side by side, so that no stretch of it is drawn
 * twice and none is drawn over the other map's land: the map in hand draws all of its own
 * stretch but for the other's tiles, the other draws only what lies outside that stretch.
 * (With no second map: back to each drawing its own.)
 */
export function shareSea(scene, beside, off) {
  scene.seaClip = null;
  if (!beside) return;
  beside.seaClip = null;
  scene.seaClip = (xN, yW, size) => {
    const n = beside.tilesIn(xN - off[0], yW - off[1], size), all = Math.round(size / TILE) ** 2;
    return n === 0 ? 0 : n >= all ? 1 : 2;
  };
  const sea = scene.sea;
  if (!sea) return;
  beside.seaClip = (xN, yW, size) => {
    const x1 = xN + off[0], x0 = x1 - size, y1 = yW + off[1], y0 = y1 - size;
    if (x1 <= sea.x0 + 1 || x0 >= sea.x1 - 1 || y1 <= sea.y0 + 1 || y0 >= sea.y1 - 1) return 0;
    return x0 >= sea.x0 - 1 && x1 <= sea.x1 + 1 && y0 >= sea.y0 - 1 && y1 <= sea.y1 + 1 ? 1 : 2;
  };
}
