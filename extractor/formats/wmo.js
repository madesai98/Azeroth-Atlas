// WMO (world map object: buildings, cities, caves, bridges). Supports both the classic
// layout (MOPY/MOVI) and the newer one (MPY2/MOVX, multiple LOD group sets).
import { chunkMap, iterChunks, UNIT_SIZE } from './chunked.js';

// Per-triangle flags (MOPY / MPY2)
export const TRI = { NOCAMCOLLIDE: 0x02, DETAIL: 0x04, COLLISION: 0x08, HINT: 0x10, RENDER: 0x20, COLLIDE_HIT: 0x80 };
// Group flags (MOGP)
export const GROUP = {
  HAS_COLORS: 0x4, EXTERIOR: 0x8, HAS_LIQUID: 0x1000, INTERIOR: 0x2000, OCEAN: 0x80000,
  EXTERIOR_LIT: 0x40,     // an indoor group lit as the outdoors is: a street or square of a city, under the open sky
  UNREACHABLE: 0x80,      // nobody can get there: treetops, a far wall - and the stand-ins a city shows of itself from afar
  ANTIPORTAL: 0x4000000,  // not a part of the building at all: a slab the game hides what is behind with, and never draws
};

export function parseWmoRoot(buf) {
  const c = chunkMap(buf);
  const mohd = c.get('MOHD')?.[0];
  if (!mohd) throw new Error('WMO root without MOHD');
  const h = mohd.pos;
  const nGroups = buf.readUInt32LE(h + 4);
  const root = {
    nGroups,
    wmoId: buf.readUInt32LE(h + 32),
    bbox: [0, 1, 2, 3, 4, 5].map((i) => buf.readFloatLE(h + 36 + i * 4)),
    flags: buf.readUInt16LE(h + 60),
    numLod: buf.readUInt16LE(h + 62),
    materials: [], groupFiles: [], doodadSets: [], doodadFiles: [], doodads: [],
    // the names of its groups, back to back (a group gives the place of its own: groupName below)
    groupNames: null,
  };
  const mogn = c.get('MOGN')?.[0];
  if (mogn) root.groupNames = buf.subarray(mogn.pos, mogn.pos + mogn.size);
  const momt = c.get('MOMT')?.[0];
  if (momt) {
    for (let p = momt.pos; p + 64 <= momt.pos + momt.size; p += 64) {
      root.materials.push({ flags: buf.readUInt32LE(p), shader: buf.readUInt32LE(p + 4), blend: buf.readUInt32LE(p + 8), texture: buf.readUInt32LE(p + 12), texture2: buf.readUInt32LE(p + 24) });
    }
  }
  const gfid = c.get('GFID')?.[0];
  // GFID lists every LOD set back to back; the first nGroups entries are full detail.
  if (gfid) for (let i = 0; i < nGroups && i * 4 < gfid.size; i++) root.groupFiles.push(buf.readUInt32LE(gfid.pos + i * 4));
  const mods = c.get('MODS')?.[0];
  if (mods) {
    for (let p = mods.pos; p + 32 <= mods.pos + mods.size; p += 32) {
      root.doodadSets.push({ name: buf.latin1Slice(p, p + 20).replace(/\0.*$/, ''), start: buf.readUInt32LE(p + 20), count: buf.readUInt32LE(p + 24) });
    }
  }
  const modi = c.get('MODI')?.[0];
  if (modi) for (let p = modi.pos; p + 4 <= modi.pos + modi.size; p += 4) root.doodadFiles.push(buf.readUInt32LE(p));
  const modd = c.get('MODD')?.[0];
  if (modd) {
    for (let p = modd.pos; p + 40 <= modd.pos + modd.size; p += 40) {
      const nameAndFlags = buf.readUInt32LE(p);
      root.doodads.push({
        fdid: root.doodadFiles[nameAndFlags & 0xffffff] ?? 0, flags: nameAndFlags >>> 24,
        pos: [buf.readFloatLE(p + 4), buf.readFloatLE(p + 8), buf.readFloatLE(p + 12)],
        rot: [buf.readFloatLE(p + 16), buf.readFloatLE(p + 20), buf.readFloatLE(p + 24), buf.readFloatLE(p + 28)], // quaternion x,y,z,w
        scale: buf.readFloatLE(p + 32), color: buf.readUInt32LE(p + 36),
      });
    }
  }
  return root;
}

/** The name a group goes by in its building ("Cathy_Facade01", "antiportal"): '' when it has none. */
export function groupName(root, group) {
  const names = root.groupNames, at = group.nameOffset;
  if (!names || !(at >= 0) || at >= names.length) return '';
  let end = at;
  while (end < names.length && names[end]) end++;
  return names.latin1Slice(at, end);
}

/** Resolve the LiquidType id of a group's liquid (legacy ids are remapped the way the client does). */
function liquidTypeId(rootFlags, groupFlags, groupLiquid) {
  const basic = (x) => {
    switch (x & 3) {
      case 0: return groupFlags & GROUP.OCEAN ? 14 : 13;
      case 1: return 14;
      case 2: return 19;
      default: return 20;
    }
  };
  if (rootFlags & 0x4) return groupLiquid < 21 ? basic(groupLiquid - 1) : groupLiquid;
  if (groupLiquid === 15) return 15;
  return groupLiquid < 21 ? basic(groupLiquid) : groupLiquid + 1;
}

export function parseWmoGroup(buf, rootFlags = 0) {
  let mogp = null;
  for (const c of iterChunks(buf)) if (c.magic === 'MOGP') { mogp = c; break; }
  if (!mogp) throw new Error('WMO group without MOGP');
  const h = mogp.pos;
  const g = {
    nameOffset: buf.readUInt32LE(h), // where its name starts among the building's group names
    doodadRefs: [],                  // the objects placed in the building that are this group's (MODR)
    flags: buf.readUInt32LE(h + 8),
    bbox: [0, 1, 2, 3, 4, 5].map((i) => buf.readFloatLE(h + 12 + i * 4)),
    groupLiquid: buf.readUInt32LE(h + 0x34),
    areaGroupId: buf.readUInt32LE(h + 0x38),
    nTris: 0, triFlags: null, triMaterial: null, indices: null, positions: null, normals: null, uvs: null, colors: null, liquid: null,
  };
  let nVerts = 0;
  for (const c of iterChunks(buf, h + 68, mogp.pos + mogp.size)) {
    const p = c.pos;
    switch (c.magic) {
      case 'MOPY': {
        const n = c.size >> 1;
        g.triFlags = new Uint8Array(n); g.triMaterial = new Uint16Array(n);
        for (let i = 0; i < n; i++) { g.triFlags[i] = buf[p + i * 2]; const m = buf[p + i * 2 + 1]; g.triMaterial[i] = m === 0xff ? 0xffff : m; }
        break;
      }
      case 'MPY2': {
        const n = c.size >> 2;
        g.triFlags = new Uint8Array(n); g.triMaterial = new Uint16Array(n);
        for (let i = 0; i < n; i++) { g.triFlags[i] = buf.readUInt16LE(p + i * 4) & 0xff; g.triMaterial[i] = buf.readUInt16LE(p + i * 4 + 2); }
        break;
      }
      case 'MOVI': {
        const n = c.size >> 1;
        g.indices = new Uint32Array(n);
        for (let i = 0; i < n; i++) g.indices[i] = buf.readUInt16LE(p + i * 2);
        break;
      }
      case 'MOVX': {
        const n = c.size >> 2;
        g.indices = new Uint32Array(n);
        for (let i = 0; i < n; i++) g.indices[i] = buf.readUInt32LE(p + i * 4);
        break;
      }
      case 'MOVT': {
        nVerts = c.size / 12;
        g.positions = new Float32Array(nVerts * 3);
        for (let i = 0; i < nVerts * 3; i++) g.positions[i] = buf.readFloatLE(p + i * 4);
        break;
      }
      case 'MONR': {
        const n = c.size / 4;
        g.normals = new Float32Array(n);
        for (let i = 0; i < n; i++) g.normals[i] = buf.readFloatLE(p + i * 4);
        break;
      }
      case 'MOTV': {
        if (g.uvs) break; // extra UV sets are not needed
        const n = c.size / 4;
        g.uvs = new Float32Array(n);
        for (let i = 0; i < n; i++) g.uvs[i] = buf.readFloatLE(p + i * 4);
        break;
      }
      case 'MODR': {
        for (let o = 0; o + 2 <= c.size; o += 2) g.doodadRefs.push(buf.readUInt16LE(p + o));
        break;
      }
      case 'MOCV': {
        if (g.colors) break;
        g.colors = Uint8Array.from(buf.subarray(p, p + c.size)); // BGRA
        break;
      }
      case 'MLIQ': {
        const xv = buf.readUInt32LE(p), yv = buf.readUInt32LE(p + 4), xt = buf.readUInt32LE(p + 8), yt = buf.readUInt32LE(p + 12);
        const corner = [buf.readFloatLE(p + 16), buf.readFloatLE(p + 20), buf.readFloatLE(p + 24)];
        const vBase = p + 30, tBase = vBase + xv * yv * 8;
        if (tBase + xt * yt > c.pos + c.size || xv !== xt + 1 || yv !== yt + 1) break;
        const heights = new Float32Array(xv * yv);
        for (let i = 0; i < xv * yv; i++) heights[i] = buf.readFloatLE(vBase + i * 8 + 4);
        const tiles = Uint8Array.from(buf.subarray(tBase, tBase + xt * yt));
        g.liquid = { xv, yv, xt, yt, corner, heights, tiles, type: liquidTypeId(rootFlags, g.flags, g.groupLiquid), unit: UNIT_SIZE };
        break;
      }
      default:
    }
  }
  g.nTris = g.indices ? g.indices.length / 3 : 0;
  g.nVerts = nVerts;
  return g;
}
