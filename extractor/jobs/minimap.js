// The minimap reference of a map that is one building (a dungeon, the Deeprun Tram).
//
// Inside a dungeon the game tells an addon which dungeon you are in and nothing of where. Its
// minimap shows it all the same: the picture there is centred on you. So the map server reads
// that picture off the game window (server/minimap.js) and looks for the place on the dungeon's
// plan where it fits. This job makes the plan, from the game's own files alone:
//
//   the game's table WMOMinimapTexture   which picture belongs to which room ("group") of which
//                                        building, and which block of that room it is
//   the building's own files             where each room is: its box
//   the pictures                         two pixels a yard, transparent where there is no floor
//
// How a picture lies in its room (worked out on the Stockade, and checked against where the
// addon OneForAll, which draws the same pictures, puts them in every dungeon it knows): block
// (BlockX, BlockY) of a room is a picture whose LEFT edge is at the room's local
// x = box.minX + 128 * BlockX and whose BOTTOM edge is at local y = box.minY + 128 * BlockY; the
// picture's columns run along local +x, its rows DOWN local y (the top row is the highest y).
// A map that is one building has it at the middle of the world, unturned: world X (north) is
// minus the local x, world Y (west) minus the local y.
//
// What is kept is not the pictures but, for every room, where its floor is: one bit a pixel,
// two pixels a yard, north up as the minimap is -
//   column = (originY - worldY) * 2,   row = (originX - worldX) * 2
// (origin: the world spot of the plan's north-west corner). A room apiece, because the game
// does not always draw every room: the rooms that lie wholly above the ceiling of the room you
// are in are left out, and the matcher puts the plan together as the game would.
//
// maps/<id>/minimap.bin (container 'WFR1'):
//   META   JSON: { v, map, wmo, wmoId, pxPerYard, width, height, originX, originY,
//                  groups: [{ i (the room's number in the building), n (its name), f (its flags),
//                             b: [xMin, xMax, yMin, yMax, zMin, zMax] (its box in the world),
//                             m: [col, row, w, h, offset] (its floor on the plan, and where its
//                                bits begin in MASKS) | null (a room without a picture) }] }
//   MASKS  every room's floor back to back, each w * h bits (rows from the north, the lowest bit
//          of a byte first), each beginning on a new byte; the whole deflated (raw)
import zlib from 'node:zlib';
import { packContainer, unpackContainer, writeFileAtomic } from '../container.js';
import { parseBLP, decodeMip } from '../formats/blp.js';
import { parseWmoRoot, parseWmoGroup, groupName } from '../formats/wmo.js';

export const MINIMAP_VERSION = 1;
export const RSEC = { META: 1, MASKS: 2 };
const PPY = 2;        // pixels a yard, of the game's pictures and of the plan
const BLOCK = 128;    // yards from one block of a room's picture to the next
const MARGIN = 8;     // yards of nothing round the building
const OPAQUE = 128;   // a pixel this opaque or more is floor

/**
 * @param job { map, fdid (the building), rows: [[GroupNum, BlockX, BlockY, FileDataID]] (its rows of WMOMinimapTexture), out }
 * @returns { rooms, pictured, width, height, bytes } - or throws where the building cannot be read
 */
export function buildMinimapRef(casc, job) {
  const root = parseWmoRoot(casc.readFile(job.fdid));
  const groups = [];
  for (let i = 0; i < root.nGroups; i++) {
    const grp = parseWmoGroup(casc.readFile(root.groupFiles[i]), root.flags);
    groups.push({ i, name: groupName(root, grp), flags: grp.flags, bbox: grp.bbox, blocks: job.rows.filter((r) => r[0] === i), mask: null });
  }
  // the plan's extent: every room's box (a picture reaches beyond its room's box only with what is transparent)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const g of groups) { x0 = Math.min(x0, g.bbox[0]); x1 = Math.max(x1, g.bbox[3]); y0 = Math.min(y0, g.bbox[1]); y1 = Math.max(y1, g.bbox[4]); }
  if (!Number.isFinite(x0 + x1 + y0 + y1)) throw new Error('the building has no rooms');
  x0 = Math.floor(x0) - MARGIN; y0 = Math.floor(y0) - MARGIN; x1 = Math.ceil(x1) + MARGIN; y1 = Math.ceil(y1) + MARGIN;
  const W = Math.round((y1 - y0) * PPY), H = Math.round((x1 - x0) * PPY); // columns run along local y, rows along local x

  const parts = [];
  let offset = 0, pictured = 0;
  for (const g of groups) {
    if (!g.blocks.length) continue;
    // the room's pictures, and the part of the plan they could reach
    const pics = [];
    let rA = H, rB = -1, cA = W, cB = -1;
    for (const [, bx, by, file] of g.blocks) {
      let blp, px;
      try { blp = parseBLP(casc.readFile(file)); px = decodeMip(blp, 0); } catch { continue; } // (a picture that is not here: that block is left bare)
      const lx0 = g.bbox[0] + bx * BLOCK, ly0 = g.bbox[1] + by * BLOCK; // local x of the picture's left edge, local y of its bottom edge
      const a = Math.max(0, Math.floor((lx0 - x0) * PPY)), b = Math.min(H - 1, Math.ceil((lx0 + blp.width / PPY - x0) * PPY));
      const c = Math.max(0, Math.floor((ly0 - y0) * PPY)), d = Math.min(W - 1, Math.ceil((ly0 + blp.height / PPY - y0) * PPY));
      if (a > b || c > d) continue;
      pics.push({ px, tw: blp.width, th: blp.height, lx0, ly0, a, b, c, d });
      rA = Math.min(rA, a); rB = Math.max(rB, b); cA = Math.min(cA, c); cB = Math.max(cB, d);
    }
    if (!pics.length) continue;
    const bw = cB - cA + 1, bh = rB - rA + 1, own = new Uint8Array(bw * bh);
    let c0 = bw, c1 = -1, r0 = bh, r1 = -1;
    for (const p of pics) {
      for (let row = p.a; row <= p.b; row++) {
        const tx = Math.floor((x0 + (row + 0.5) / PPY - p.lx0) * PPY);
        if (tx < 0 || tx >= p.tw) continue;
        for (let col = p.c; col <= p.d; col++) {
          const ty = p.th - 1 - Math.floor((y0 + (col + 0.5) / PPY - p.ly0) * PPY);
          if (ty < 0 || ty >= p.th || p.px[(ty * p.tw + tx) * 4 + 3] < OPAQUE) continue;
          const c = col - cA, r = row - rA;
          own[r * bw + c] = 1;
          if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
        }
      }
    }
    if (c1 < 0) continue; // (pictures with nothing on them)
    const mw = c1 - c0 + 1, mh = r1 - r0 + 1, bits = Buffer.alloc((mw * mh + 7) >> 3);
    for (let r = 0; r < mh; r++) for (let c = 0; c < mw; c++) if (own[(r0 + r) * bw + c0 + c]) { const k = r * mw + c; bits[k >> 3] |= 1 << (k & 7); }
    g.mask = [cA + c0, rA + r0, mw, mh, offset];
    parts.push(bits); offset += bits.length; pictured++;
  }
  const round = (v) => Math.round(v * 100) / 100;
  const meta = {
    v: MINIMAP_VERSION, map: job.map, wmo: job.fdid, wmoId: root.wmoId, pxPerYard: PPY, width: W, height: H,
    originX: -x0, originY: -y0, // the world spot of the plan's top-left (north-west) corner
    // (a room's box in the world: X north, Y west, Z up)
    groups: groups.map((g) => ({ i: g.i, n: g.name, f: g.flags, b: [-g.bbox[3], -g.bbox[0], -g.bbox[4], -g.bbox[1], g.bbox[2], g.bbox[5]].map(round), m: g.mask })),
  };
  const out = packContainer('WFR1', MINIMAP_VERSION, [
    { id: RSEC.META, data: Buffer.from(JSON.stringify(meta), 'utf8') },
    { id: RSEC.MASKS, data: zlib.deflateRawSync(Buffer.concat(parts), { level: 9 }) },
  ]);
  writeFileAtomic(job.out, out);
  return { rooms: groups.length, pictured, width: W, height: H, bytes: out.length };
}

/**
 * Read a reference back in (the map server does, and the tests):
 * { meta (as above, each pictured room with `mask: { col, row, w, h }`), masks: Uint8Array per room (one byte a pixel, 0 or 1) keyed by the room's number }
 */
export function readMinimapRef(buf) {
  const c = unpackContainer(buf, 'WFR1');
  const meta = JSON.parse(c.sections.get(RSEC.META).toString('utf8'));
  if (meta.v !== MINIMAP_VERSION) throw new Error(`a minimap reference of version ${meta.v}: this map tool reads version ${MINIMAP_VERSION}`);
  const bits = zlib.inflateRawSync(c.sections.get(RSEC.MASKS));
  const masks = new Map();
  for (const g of meta.groups) {
    if (!g.m) continue;
    const [, , w, h, offset] = g.m, m = new Uint8Array(w * h);
    for (let k = 0; k < w * h; k++) m[k] = (bits[offset + (k >> 3)] >> (k & 7)) & 1;
    masks.set(g.i, m);
  }
  return { meta, masks };
}
