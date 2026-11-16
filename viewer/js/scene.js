// One loaded map: a quadtree of terrain nodes streamed in by distance, plus CPU-side copies of
// the exact height data for picking and coordinate read-outs.
import { TILE, UNIT, boxVisible } from './math.js';
import { unpackContainer, sectionView } from './formats.js';

const NONE = 0, QUEUED = 1, LOADING = 2, READY = 3, FAILED = 4;
const MAX_ACTIVE_LOADS = 8;
const NODE_BUDGET = 260;
const MESH_CELLS = [128, 128, 64, 32, 16];
const KIND_INDEX = { water: 1, ocean: 2, magma: 3, slime: 4 };
const NO_WATER = -1e8;
const SEA_PAD = 5;    // how far beyond its land a map's open sea is drawn, in squares of its coarsest level

const MAP_HALF = 32 * TILE; // yards from a map's corner to the middle of the world

/**
 * A map's record (map.json), with the one building of a map that is nothing else placed where
 * it stands: from the middle of the world. A map built before that was known has it placed from
 * the map's corner, 17,067 yards north and west of everyone in it - the Deeprun Tram's tunnel
 * was nowhere to be seen from where you stood in it. Put right here, so that it is right without
 * the map being built again (one built since says `middle`, and is left as it is).
 */
export function placed(map) {
  const g = map?.globalWmo;
  if (g && !g.middle) {
    g.pos = [g.pos[0] - MAP_HALF, g.pos[1] - MAP_HALF, g.pos[2]];
    g.bounds = [g.bounds[0] - MAP_HALF, g.bounds[1] - MAP_HALF, g.bounds[2], g.bounds[3] - MAP_HALF, g.bounds[4] - MAP_HALF, g.bounds[5]];
    g.middle = true;
  }
  return map;
}

export class MapScene {
  /**
   * @param gpu      device wrapper
   * @param terrain  TerrainRenderer
   * @param map      parsed map.json
   * @param world    parsed world.json
   * @param onChange called whenever new data finished loading (triggers a redraw)
   */
  constructor(gpu, terrain, map, world, onChange) {
    this.gpu = gpu; this.terrain = terrain; this.map = map; this.world = world; this.onChange = onChange;
    this.base = `/data/maps/${map.id}/`;
    this.rev = map.rev;
    this.disposed = false;
    this.frame = 0;
    this.active = 0;
    this.queue = [];
    this.loadedCount = 0;
    this.splitK = 2.0;
    this.draws = [];
    this.filler = new Float32Array(24 * 3000);
    this.fillerCount = 0;
    // Set while another map is shown beside this one (see joined.js): which part of a square of
    // open sea is this map's to draw. (xN, yW, size) -> 0 all of it, 1 none, 2 some (it is split).
    this.seaClip = null;
    this.stats = { nodes: 0, tris: 0, loaded: 0 };

    this.nodes = new Map();
    const add = (level, x, y, minH, maxH, flags) => {
      const size = TILE * 2 ** level;
      const node = {
        level, x, y, minH, maxH, flags, size,
        xN: (32 - y * 2 ** level) * TILE, yW: (32 - x * 2 ** level) * TILE,
        children: null, state: NONE, res: null, cpu: null, lastUsed: 0, wanted: 0, priority: 0, overlayRev: 0,
      };
      this.nodes.set(`${level}/${x}_${y}`, node);
      return node;
    };
    for (const [x, y, minH, maxH, flags] of map.tiles) add(0, x, y, minH, maxH, flags);
    this.top = map.topLevel;
    for (let level = 1; level <= this.top; level++) {
      for (const [x, y, minH, maxH, water] of map.pages[level] ?? []) {
        const node = add(level, x, y, minH, maxH, water);
        node.children = [0, 1, 2, 3].map((k) => this.nodes.get(`${level - 1}/${x * 2 + (k & 1)}_${y * 2 + (k >> 1)}`) ?? null);
      }
    }
    this.roots = [...this.nodes.values()].filter((n) => n.level === this.top);
    this.rootSet = new Set(this.roots.map((n) => `${n.x}_${n.y}`));

    // World-space bounds of the map (for the initial camera and the sea filler).
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [col, row] of map.tiles) {
      x1 = Math.max(x1, (32 - row) * TILE); x0 = Math.min(x0, (31 - row) * TILE);
      y1 = Math.max(y1, (32 - col) * TILE); y0 = Math.min(y0, (31 - col) * TILE);
    }
    this.bounds = { x0, x1, y0, y1 };
    // Which squares of the world's 64 x 64 grid this map has a tile on, summed so that the tiles
    // in any block of squares are counted at once (tilesIn).
    const sum = (this.tileSum = new Int32Array(65 * 65));
    for (const [col, row] of map.tiles) if (col >= 0 && col < 64 && row >= 0 && row < 64) sum[(row + 1) * 65 + col + 1] = 1;
    for (let r = 1; r <= 64; r++) for (let c = 1; c <= 64; c++) sum[r * 65 + c] += sum[(r - 1) * 65 + c] + sum[r * 65 + c - 1] - sum[(r - 1) * 65 + c - 1];
    // The stretch of sea this map draws around its land: [x0, x1] x [y0, y1], or null (no open sea).
    this.sea = null;
    if (map.ocean && this.roots.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const r of this.roots) { minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x); minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y); }
      const s = 2 ** this.top;
      this.seaRoots = { minX: minX - SEA_PAD, maxX: maxX + SEA_PAD, minY: minY - SEA_PAD, maxY: maxY + SEA_PAD };
      this.sea = { x0: (32 - (maxY + SEA_PAD + 1) * s) * TILE, x1: (32 - (minY - SEA_PAD) * s) * TILE, y0: (32 - (maxX + SEA_PAD + 1) * s) * TILE, y1: (32 - (minX - SEA_PAD) * s) * TILE };
    }
    // Interior maps (dungeons) are one big building with no terrain: use its box instead.
    if (!map.tiles.length && map.globalWmo) {
      const b = map.globalWmo.bounds;
      this.bounds = { x0: b[0], x1: b[3], y0: b[1], y1: b[4] };
      this.planeZ = (b[2] + b[5]) / 2;
    }
    this.kinds = {};
    for (const [id, t] of Object.entries(world.liquidTypes)) this.kinds[id] = KIND_INDEX[t.kind] ?? 1;
  }

  dispose() {
    this.disposed = true;
    for (const n of this.nodes.values()) if (n.res) { this.terrain.destroyNode(n.res); n.res = null; }
  }

  /** Start loading the coarsest level; resolves when the whole map is drawable. */
  async loadRoots() {
    await Promise.all([...this.roots.map((n) => this.#load(n)), this.loadAreas()]);
  }

  // ---- per-frame selection ---------------------------------------------------------------
  update(cam, planes) {
    this.frame++;
    this.draws.length = 0;
    this.fillerCount = 0;
    this.cam = cam;
    this.planes = planes;
    this.overlayBudget = 10; // nodes repainted per frame, to keep setting changes smooth
    // Zones switched off: drop every painted overlay at once (also the ones not in view).
    if (this.overlay && !this.overlay.active && this.overlayCleared !== this.overlay.rev) {
      this.overlayCleared = this.overlay.rev;
      for (const n of this.nodes.values()) if (n.res) { this.terrain.setOverlay(n.res, null); n.overlayRev = this.overlay.rev; }
    }
    this.overlayPending = false;
    for (const root of this.roots) this.#visit(root);
    if (this.overlayPending) this.onChange();
    if (this.seaRoots) {
      const s = TILE * 2 ** this.top, { minX, maxX, minY, maxY } = this.seaRoots;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        if (!this.rootSet.has(`${x}_${y}`)) this.#fillerQuad((32 - y * 2 ** this.top) * TILE, (32 - x * 2 ** this.top) * TILE, s);
      }
    }
    this.draws.sort((a, b) => a.dist - b.dist);
    this.#pump();
    if (this.frame % 30 === 0) this.#evict();
    let tris = 0;
    for (const d of this.draws) tris += MESH_CELLS[d.mesh] ** 2 * (d.mesh === 0 ? 4 : 2);
    this.stats = { nodes: this.draws.length, tris, loaded: this.loadedCount, pending: this.queue.length + this.active };
  }

  #dist(node) {
    const c = this.cam;
    const dx = Math.max(node.xN - node.size - c[0], 0, c[0] - node.xN);
    const dy = Math.max(node.yW - node.size - c[1], 0, c[1] - node.yW);
    const dz = Math.max(node.minH - c[2], 0, c[2] - node.maxH);
    return Math.hypot(dx, dy, dz);
  }

  #visit(node) {
    node.lastUsed = this.frame;
    const d = this.#dist(node);
    if (node.level > 0 && d < this.splitK * node.size) {
      let ready = true;
      for (const ch of node.children) {
        if (!ch || ch.state === FAILED) continue;
        if (ch.state !== READY) { ready = false; this.#request(ch, d); }
      }
      if (ready) {
        for (let k = 0; k < 4; k++) {
          const ch = node.children[k];
          if (ch && ch.state === READY) this.#visit(ch);
          else if (this.map.ocean) {
            const s = node.size / 2;
            this.#fillerQuad(node.xN - (k >> 1) * s, node.yW - (k & 1) * s, s);
          }
        }
        return;
      }
    }
    if (node.state !== READY) { this.#request(node, d); return; }
    const c = this.cam;
    const rx = node.xN - c[0], ry = node.yW - c[1];
    if (!boxVisible(this.planes, rx - node.size, ry - node.size, node.minH - c[2] - 80, rx, ry, node.maxH - c[2] + 5)) return;
    const ratio = d / node.size;
    let mesh;
    if (node.level === 0) mesh = ratio < 0.85 ? 0 : ratio < 1.9 ? 1 : ratio < 4 ? 2 : 3;
    else mesh = ratio < 1.9 ? 1 : ratio < 4 ? 2 : ratio < 8 ? 3 : 4;
    const cell = node.size / MESH_CELLS[mesh];
    // Ground overlay (spawn zones): repaint this node if the zones changed since it was last painted.
    if (this.overlay && node.overlayRev !== this.overlay.rev) {
      if (this.overlayBudget > 0) {
        this.overlayBudget--;
        this.terrain.setOverlay(node.res, this.overlay.rasterize(node.xN, node.yW, node.size));
        node.overlayRev = this.overlay.rev;
      } else this.overlayPending = true;
    }
    this.draws.push({ res: node.res, originRel: [rx, ry, -c[2]], scale: node.size / 256, skirt: cell * 1.5 + 2, mesh, level: node.level, dist: d });
  }

  #fillerQuad(xN, yW, size) {
    const c = this.cam;
    const x1 = xN - c[0], x0 = x1 - size, y1 = yW - c[1], y0 = y1 - size;
    const z0 = this.map.seaLevel - c[2];
    if (!boxVisible(this.planes, x0, y0, z0 - 1, x1, y1, z0 + 1)) return;
    // With another map beside this one, the sea over that map's land (some of it lies below
    // sea level) and the sea that map draws itself are left out: the square is split down to
    // single tiles where it is partly this map's.
    const part = this.seaClip ? this.seaClip(xN, yW, size) : 0;
    if (part === 1) return;
    if (part === 2) {
      if (size <= TILE * 1.01) return;
      const h = size / 2;
      for (let k = 0; k < 4; k++) this.#fillerQuad(xN - (k >> 1) * h, yW - (k & 1) * h, h);
      return;
    }
    if (this.fillerCount * 24 + 24 > this.filler.length) return;
    const f = this.filler, z = this.map.seaLevel, k = 10; // ocean | "open sea" flag
    let o = this.fillerCount++ * 24;
    const v = (x, y) => { f[o++] = -y; f[o++] = -x; f[o++] = z; f[o++] = k; };
    v(x1, y1); v(x1, y0); v(x0, y1); v(x1, y0); v(x0, y0); v(x0, y1);
  }

  // ---- streaming -------------------------------------------------------------------------
  #request(node, priority) {
    node.priority = priority;
    node.wanted = this.frame;
    if (node.state === NONE) { node.state = QUEUED; this.queue.push(node); }
  }

  #pump() {
    if (!this.queue.length) return;
    // Forget requests that are no longer wanted (camera moved on).
    this.queue = this.queue.filter((n) => {
      if (this.frame - n.wanted > 20) { n.state = NONE; return false; }
      return true;
    });
    this.queue.sort((a, b) => a.priority - b.priority);
    while (this.active < MAX_ACTIVE_LOADS && this.queue.length) this.#load(this.queue.shift());
  }

  #evict() {
    if (this.loadedCount <= NODE_BUDGET) return;
    const old = [];
    for (const n of this.nodes.values()) if (n.state === READY && n.level < this.top && this.frame - n.lastUsed > 90) old.push(n);
    old.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const n of old) {
      if (this.loadedCount <= NODE_BUDGET * 0.8) break;
      this.terrain.destroyNode(n.res);
      this.objects?.removeTile(n);
      n.res = null; n.cpu = null; n.state = NONE; n.overlayRev = 0;
      this.loadedCount--;
    }
  }

  async #fetch(rel) {
    const res = await fetch(`${this.base}${rel}?v=${this.rev}`);
    if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  async #load(node) {
    node.state = LOADING;
    this.active++;
    try {
      const data = node.level === 0 ? await this.#loadTile(node) : await this.#loadPage(node);
      if (this.disposed) return;
      node.res = this.terrain.createNode(data);
      node.cpu = data.cpu;
      if (data.objects) this.objects?.addTile(node, data.objects.buffer, data.objects.section);
      node.state = READY;
      node.lastUsed = this.frame;
      this.loadedCount++;
    } catch (err) {
      console.warn('node load failed', node.level, node.x, node.y, err);
      node.state = FAILED;
    } finally {
      this.active--;
      if (!this.disposed) this.onChange();
    }
  }

  async #loadTile(node) {
    const name = `${node.x}_${node.y}`;
    const [bin, blp] = await Promise.all([this.#fetch(`t/${name}.bin`), node.flags & 1 ? this.#fetch(`c/${name}.blp`) : null]);
    const c = unpackContainer(bin, 'WFT1');
    const heights = sectionView(c, 1, Float32Array);
    const normals = sectionView(c, 2, Int8Array).subarray(0, 129 * 129 * 4);
    const holeBits = sectionView(c, 4, Uint8Array);
    const chunks = sectionView(c, 5, Uint32Array);
    let holes = null;
    if (holeBits.some((b) => b !== 0)) {
      const data = new Uint8Array(128 * 128);
      for (let ci = 0; ci < 256; ci++) for (let r = 0; r < 8; r++) {
        const bits = holeBits[ci * 8 + r];
        if (!bits) continue;
        for (let q = 0; q < 8; q++) if (bits & (1 << q)) data[((ci >> 4) * 8 + r) * 128 + (ci & 15) * 8 + q] = 255;
      }
      holes = { size: 128, data };
    }
    const liquid = c.sections.get(6);
    const water = liquid ? this.#tileWater(new DataView(bin, liquid.offset, liquid.size), bin, liquid.offset) : null;
    const objects = c.sections.get(7);
    return { heights, normals, colorBLP: blp, holes, water, cpu: { heights, holeBits, chunks, water: water?.grid ?? null }, objects: objects ? { buffer: bin, section: objects } : null };
  }

  /** Exact liquid surfaces of a tile -> vertices (hx, hy, level, kind). */
  #tileWater(dv, buffer, base) {
    const count = dv.getUint32(0, true);
    if (!count) return null;
    const verts = [], idx = [];
    // level of the water surface per terrain quad (NaN = none), for waterAt()
    const grid = new Float32Array(128 * 128).fill(NaN);
    let p = 4;
    for (let i = 0; i < count; i++) {
      const chunk = dv.getUint16(p, true), type = dv.getUint16(p + 2, true);
      const lx = dv.getUint8(p + 4), ly = dv.getUint8(p + 5), w = dv.getUint8(p + 6), h = dv.getUint8(p + 7);
      const flags = dv.getUint32(p + 8, true), minH = dv.getFloat32(p + 12, true);
      p += 20;
      const n = (w + 1) * (h + 1);
      let exists = null, heights = null;
      if (flags & 1) { exists = new Uint8Array(buffer, base + p, 8); p += 8; }
      if (flags & 2) { heights = new Float32Array(buffer, base + p, n); p += n * 4; }
      if (flags & 4) p += (n + 3) & ~3;
      if (flags & 8) p += 16;
      const kind = this.kinds[type] ?? 1;
      const cr = chunk >> 4, cc = chunk & 15;
      const v0 = verts.length / 4;
      for (let vy = 0; vy <= h; vy++) for (let vx = 0; vx <= w; vx++) {
        verts.push(2 * (cc * 8 + lx + vx), 2 * (cr * 8 + ly + vy), heights ? heights[vy * (w + 1) + vx] : minH, kind);
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const bit = y * w + x;
        if (exists && !((exists[bit >> 3] >> (bit & 7)) & 1)) continue;
        const a = v0 + y * (w + 1) + x, b = a + 1, d = a + w + 1, e = d + 1;
        idx.push(a, b, d, b, e, d);
        const level = heights ? (heights[y * (w + 1) + x] + heights[y * (w + 1) + x + 1] + heights[(y + 1) * (w + 1) + x] + heights[(y + 1) * (w + 1) + x + 1]) / 4 : minH;
        const cell = (cr * 8 + ly + y) * 128 + cc * 8 + lx + x;
        if (!(grid[cell] >= level)) grid[cell] = level; // where layers overlap, the top one
      }
    }
    return { vertices: new Float32Array(verts), indices: new Uint32Array(idx), grid };
  }

  async #loadPage(node) {
    const bin = await this.#fetch(`p${node.level}/${node.x}_${node.y}.bin`);
    const c = unpackContainer(bin, 'WFP1');
    const heights = sectionView(c, 1, Float32Array);
    const normals = sectionView(c, 2, Int8Array);
    const colorSec = c.sections.get(3);
    const coverage = sectionView(c, 4, Uint8Array);
    let holes = null;
    if (coverage.some((v) => v === 0)) {
      const size = 2 ** node.level;
      holes = { size, data: Uint8Array.from(coverage, (v) => (v ? 0 : 255)) };
    }
    let water = null, waterGrid = null;
    const wl = sectionView(c, 5, Float32Array), wk = sectionView(c, 6, Uint8Array);
    if (wl) {
      waterGrid = Float32Array.from(wl, (v, o) => (wk[o] && v >= NO_WATER ? v : NaN));
      // Merge horizontal runs of equal level/kind into single quads.
      const verts = [], idx = [];
      for (let j = 0; j < 128; j++) {
        let i = 0;
        while (i < 128) {
          const o = j * 128 + i;
          if (!wk[o] || wl[o] < NO_WATER) { i++; continue; }
          let e = i + 1;
          while (e < 128 && wk[j * 128 + e] === wk[o] && wl[j * 128 + e] === wl[o]) e++;
          const v0 = verts.length / 4;
          verts.push(2 * i, 2 * j, wl[o], wk[o], 2 * e, 2 * j, wl[o], wk[o], 2 * i, 2 * j + 2, wl[o], wk[o], 2 * e, 2 * j + 2, wl[o], wk[o]);
          idx.push(v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2);
          i = e;
        }
      }
      water = { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
    }
    return { heights, normals, colorBLP: bin.slice(colorSec.offset, colorSec.offset + colorSec.size), holes, water, cpu: { heights, coverage, water: waterGrid } };
  }

  // ---- queries ---------------------------------------------------------------------------
  /** True where this map has a tile (land, or sea that is part of the map itself). */
  hasTile(x, y) {
    return this.nodes.has(`0/${Math.floor(32 - y / TILE)}_${Math.floor(32 - x / TILE)}`);
  }

  /** How many of this map's tiles lie in a square (its north-west corner, its side: laid on the tile grid). */
  tilesIn(xN, yW, size) {
    const n = Math.round(size / TILE);
    const c0 = Math.max(0, Math.min(64, Math.round(32 - yW / TILE))), c1 = Math.max(0, Math.min(64, Math.round(32 - yW / TILE) + n));
    const r0 = Math.max(0, Math.min(64, Math.round(32 - xN / TILE))), r1 = Math.max(0, Math.min(64, Math.round(32 - xN / TILE) + n));
    const s = this.tileSum;
    return s[r1 * 65 + c1] - s[r0 * 65 + c1] - s[r1 * 65 + c0] + s[r0 * 65 + c0];
  }

  /** Finest loaded node containing a world position. */
  #nodeAt(x, y) {
    const col = Math.floor(32 - y / TILE), row = Math.floor(32 - x / TILE);
    let best = null;
    for (let level = this.top; level >= 0; level--) {
      const n = this.nodes.get(`${level}/${col >> level}_${row >> level}`);
      if (!n) { if (level === this.top) return null; break; }
      if (n.state === READY) best = n;
    }
    return best;
  }

  /**
   * True where the game cuts a hole in the terrain (the mouth of a cave, the cellar of a
   * building): heightAt() still gives the height the ground would have, but there is no ground.
   * Known only where the full-detail tile is loaded.
   */
  holeAt(x, y) {
    const n = this.#nodeAt(x, y);
    if (!n || n.level > 0 || !n.cpu?.holeBits) return false;
    const cell = n.size / 128;
    const i = Math.min(127, Math.max(0, Math.floor((n.yW - y) / cell))), j = Math.min(127, Math.max(0, Math.floor((n.xN - x) / cell)));
    return ((n.cpu.holeBits[((j >> 3) * 16 + (i >> 3)) * 8 + (j & 7)] >> (i & 7)) & 1) === 1;
  }

  /** Terrain height at a world position (exact where the full-detail tile is loaded). */
  heightAt(x, y) {
    const n = this.#nodeAt(x, y);
    if (!n) return null;
    const cell = n.size / 128;
    const fx = (n.yW - y) / cell, fy = (n.xN - x) / cell; // grid column / row
    const i = Math.min(127, Math.max(0, Math.floor(fx))), j = Math.min(127, Math.max(0, Math.floor(fy)));
    const u = fx - i, v = fy - j;
    const H = n.cpu.heights;
    const h00 = H[j * 129 + i], h10 = H[j * 129 + i + 1], h01 = H[(j + 1) * 129 + i], h11 = H[(j + 1) * 129 + i + 1];
    if (n.level > 0) {
      const cov = n.cpu.coverage, side = 2 ** n.level;
      if (!cov[Math.min(side - 1, Math.floor(fy / (128 / side))) * side + Math.min(side - 1, Math.floor(fx / (128 / side)))]) return null;
      return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
    }
    // Full detail: each quad is four triangles around its centre vertex, exactly as in game.
    const hc = H[129 * 129 + j * 128 + i];
    const du = u - 0.5, dv = v - 0.5;
    if (Math.abs(du) > Math.abs(dv)) {
      return du > 0 ? hc + (h10 + h11 - 2 * hc) * du + (h11 - h10) * dv : hc - (h00 + h01 - 2 * hc) * du + (h01 - h00) * dv;
    }
    return dv > 0 ? hc + (h01 + h11 - 2 * hc) * dv + (h11 - h01) * du : hc - (h00 + h10 - 2 * hc) * dv + (h10 - h00) * du;
  }

  /**
   * Level of the water surface (lake, river, sea, lava) over a world position, or null where
   * there is none. Water inside buildings (canals, cave pools) is not included.
   */
  waterAt(x, y) {
    const n = this.#nodeAt(x, y);
    if (!n) return this.map.ocean ? this.map.seaLevel : null; // open sea beyond the mapped tiles
    const grid = n.cpu.water;
    if (!grid) return null;
    const cell = n.size / 128;
    const i = Math.min(127, Math.max(0, Math.floor((n.yW - y) / cell))), j = Math.min(127, Math.max(0, Math.floor((n.xN - x) / cell)));
    const level = grid[j * 128 + i];
    return Number.isNaN(level) ? null : level;
  }

  /** Load the per-chunk area id grid (small; lets any point be named without its detail tile). */
  async loadAreas() {
    if (!this.map.areas) return;
    try {
      const c = unpackContainer(await this.#fetch('areas.bin'), 'WFA1');
      const [minCol, minRow, cols, rows] = sectionView(c, 1, Int32Array);
      this.areas = { minCol, minRow, cols, rows, grid: sectionView(c, 2, Uint32Array) };
    } catch (err) { console.warn('area grid unavailable', err); }
  }

  /** The game's area id under a world position (0 if outside the map). */
  areaAt(x, y) {
    const a = this.areas;
    if (!a) return 0;
    const cx = Math.floor((32 - y / TILE) * 16) - a.minCol * 16, cy = Math.floor((32 - x / TILE) * 16) - a.minRow * 16;
    if (cx < 0 || cy < 0 || cx >= a.cols * 16 || cy >= a.rows * 16) return 0;
    return a.grid[cy * a.cols * 16 + cx];
  }

  /**
   * First intersection of a ray with the terrain (or the sea plane). Returns [x,y,z] or null.
   * @param gone  (x, y, z) => true where the ground is not drawn just now (the cutaway's hole
   *              through a hill): the ray goes on through it
   */
  pick(origin, dir, maxDist = 80000, gone = null) {
    if (!this.roots.length) {
      // No terrain: give the camera a horizontal plane through the building to grab.
      if (this.planeZ === undefined || dir[2] > -1e-3) return null;
      const t = (this.planeZ - origin[2]) / dir[2];
      return t > 0 && t < maxDist ? [origin[0] + dir[0] * t, origin[1] + dir[1] * t, this.planeZ] : null;
    }
    const sea = this.map.ocean ? this.map.seaLevel : null;
    let t = 0, prevT = 0, prevAbove = true;
    for (let i = 0; i < 2000 && t < maxDist; i++) {
      const x = origin[0] + dir[0] * t, y = origin[1] + dir[1] * t, z = origin[2] + dir[2] * t;
      let h = this.heightAt(x, y);
      if (h === null) h = sea ?? -Infinity; else if (sea !== null) h = Math.max(h, sea);
      const above = z > h;
      if (!above && i > 0 && prevAbove) {
        let a = prevT, b = t;
        for (let k = 0; k < 24; k++) {
          const m = (a + b) / 2;
          const mx = origin[0] + dir[0] * m, my = origin[1] + dir[1] * m;
          let mh = this.heightAt(mx, my);
          if (mh === null) mh = sea ?? -Infinity; else if (sea !== null) mh = Math.max(mh, sea);
          if (origin[2] + dir[2] * m > mh) a = m; else b = m;
        }
        const hit = [origin[0] + dir[0] * b, origin[1] + dir[1] * b, origin[2] + dir[2] * b];
        if (!gone || !gone(hit[0], hit[1], hit[2])) return hit;
      }
      if (!above && i === 0) return null; // camera below the surface
      prevAbove = above; prevT = t;
      // Step proportional to the clearance above ground, so flat-angle rays stay accurate.
      t += Math.max(UNIT * 0.5, Math.min((z - h) * 0.6, 400), t * 0.004);
    }
    return null;
  }
}
