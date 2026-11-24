// Place-name overlay (zones, settlements, flight masters), drawn on a 2D canvas above the 3D view.
import { project } from './math.js';

export class Labels {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];
    this.pins = [];
    this.notes = [];   // names over NPC markers (drawn whether or not place names are on)
    this.enabled = true;
    this.showFlights = true;
  }

  /**
   * Build the label list from world.json, for the map in hand and any drawn beside it.
   * @param maps   [{ id, off: [x, y] }]: each map on the picture, and where its origin lies on it
   * @param scene  the ground of the picture (anything with heightAt)
   */
  setMaps(maps, world, scene) {
    this.scene = scene;
    const items = [];
    for (const { id: mapId, off } of maps) {
      const seen = new Set();
      const zones = world.zones.filter((z) => z.map === mapId && z.type === 3);
      for (const z of zones) {
        const key = z.name;
        if (seen.has(key)) continue;
        seen.add(key);
        const [minX, minY, maxX, maxY] = z.region;
        items.push({ kind: 'zone', name: z.name, x: (minX + maxX) / 2 + off[0], y: (minY + maxY) / 2 + off[1], z: null, lift: 60, minDist: 500, maxDist: 60000, prio: 100 });
      }
      for (const p of world.pois) {
        if (p.map !== mapId || !p.name || seen.has(p.name)) continue;
        seen.add(p.name);
        items.push({ kind: 'poi', name: p.name, x: p.pos[0] + off[0], y: p.pos[1] + off[1], z: p.pos[2], lift: 25, minDist: 0, maxDist: p.importance >= 3 ? 7000 : 3500, prio: 40 + p.importance * 5 });
      }
      for (const t of world.taxiNodes) {
        // skip internal entries (quest flight paths, placeholders) that are not flight masters
        if (t.map !== mapId || !t.name || /^(generic|quest|transport|test)\b/i.test(t.name)) continue;
        items.push({ kind: 'taxi', name: t.name.split(',')[0], x: t.pos[0] + off[0], y: t.pos[1] + off[1], z: t.pos[2], lift: 12, minDist: 0, maxDist: 2600, prio: 20 });
      }
    }
    this.items = items;
  }

  /** The same for one map alone. */
  setMap(mapId, world, scene) { this.setMaps([{ id: mapId, off: [0, 0] }], world, scene); }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr;
  }

  /** @param clearance camera height above ground: the higher you are, the further names reach. */
  draw(camPos, viewProj, clearance = 0) {
    const ctx = this.ctx, dpr = this.dpr ?? 1;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    if (!this.scene) return;
    const visible = [];
    const reach = { zone: 3200 + clearance * 5, poi: 1400 + clearance * 2.5, taxi: 1100 + clearance * 1.5 };
    const consider = (it, pinned) => {
      if (it.kind === 'taxi' && !this.showFlights) return;
      let z = it.z;
      if (z === null) z = this.scene.heightAt(it.x, it.y) ?? 0;
      const rx = it.x - camPos[0], ry = it.y - camPos[1], rz = z + it.lift - camPos[2];
      const dist = Math.hypot(rx, ry, rz);
      const maxDist = pinned ? Infinity : Math.min(it.maxDist, reach[it.kind] ?? it.maxDist);
      if (!pinned && (dist < it.minDist || dist > maxDist)) return;
      const p = project(viewProj, rx, ry, rz);
      if (!p || Math.abs(p[0]) > 1.1 || Math.abs(p[1]) > 1.1) return;
      const fade = pinned ? 1 : Math.min(1, (maxDist - dist) / (maxDist * 0.25));
      visible.push({ it, sx: (p[0] * 0.5 + 0.5) * W, sy: (0.5 - p[1] * 0.5) * H, dist, fade, pinned });
    };
    if (this.enabled) for (const it of this.items) consider(it, false);
    for (const it of this.notes) consider(it, false);
    for (const pin of this.pins) consider(pin, true);
    visible.sort((a, b) => (b.pinned - a.pinned) || (b.it.prio - a.it.prio) || (a.dist - b.dist));

    const boxes = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const v of visible) {
      const it = v.it;
      const size = (it.kind === 'zone' ? 15 : it.kind === 'pin' ? 13 : it.kind === 'poi' ? 12 : 11) * dpr;
      const note = it.kind === 'npc'; // (its marker is drawn in the world: only the name goes here, above it)
      ctx.font = `${it.kind === 'zone' ? '600' : '500'} ${size}px "Segoe UI", system-ui, sans-serif`;
      const text = it.kind === 'zone' ? it.name.toUpperCase() : it.name;
      if (it.kind === 'zone') ctx.letterSpacing = `${1.5 * dpr}px`; else ctx.letterSpacing = '0px';
      const tw = ctx.measureText(text).width + 10 * dpr, th = size + 8 * dpr;
      const marker = it.kind !== 'zone' && !note;
      const ty = note ? v.sy - 20 * dpr : marker ? v.sy - size * 0.95 : v.sy;
      const box = [v.sx - tw / 2, ty - th / 2, v.sx + tw / 2, ty + th / 2 + (marker ? size * 0.9 : 0)];
      if (!v.pinned && boxes.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
      boxes.push(box);
      ctx.globalAlpha = Math.max(0, v.fade);
      if (marker) {
        ctx.beginPath();
        ctx.arc(v.sx, v.sy, (it.kind === 'pin' ? 5 : 3) * dpr, 0, Math.PI * 2);
        ctx.fillStyle = it.kind === 'pin' ? '#ff5a4d' : it.kind === 'taxi' ? '#7fd4ff' : '#ffe08a';
        ctx.fill();
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.stroke();
      }
      ctx.lineWidth = 3.5 * dpr;
      ctx.strokeStyle = 'rgba(8,10,14,0.85)';
      ctx.strokeText(text, v.sx, ty);
      ctx.fillStyle = note ? it.color : it.kind === 'zone' ? '#fff3c9' : it.kind === 'taxi' ? '#bfe6ff' : it.kind === 'pin' ? '#ffd0cb' : '#ffffff';
      ctx.fillText(text, v.sx, ty);
    }
    ctx.globalAlpha = 1;
    ctx.letterSpacing = '0px';
    this.#drawLive(camPos, viewProj, W, H, dpr);
  }

  /** You and your party (from the live game link). */
  #drawLive(cam, vp, W, H, dpr) {
    const live = this.live;
    if (!live) return;
    const ctx = this.ctx;
    const toScreen = (x, y, z) => {
      const p = project(vp, x - cam[0], y - cam[1], z - cam[2]);
      return p ? [(p[0] * 0.5 + 0.5) * W, (0.5 - p[1] * 0.5) * H, p[2]] : null;
    };
    const outlined = (text, x, y, fill, size = 12) => {
      ctx.font = `600 ${size * dpr}px "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      ctx.lineWidth = 3.5 * dpr; ctx.strokeStyle = 'rgba(8,10,14,0.9)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = fill;
      ctx.fillText(text, x, y);
    };

    // What the game's minimap shows as dots (server/dots.js), drawn as the game draws them: a disc
    // of its colour in a ring - red hostile, yellow neutral, green friendly, blue your pet; the ring
    // silver, and gold on your target - and on a thing your tracking finds (a herb, a vein), which
    // the game draws as a yellow disc in a gold ring. Your pet has its name over it.
    for (const d of live.dots ?? []) {
      const p = toScreen(d.x, d.y, d.z + 1.5);
      if (!p || p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) continue;
      const pet = d.role === 'pet';
      const fill = pet ? (d.dead ? '#8b93a0' : '#8877ff') : d.kind === 'red' ? '#d21a1a' : d.kind === 'green' ? '#27bb00' : d.kind === 'yellow' ? '#eebb00' : '#7d8694';
      const r = (pet ? 4.2 : 3.8) * dpr;
      const disc = (radius, colour) => { ctx.beginPath(); ctx.arc(p[0], p[1], radius, 0, Math.PI * 2); ctx.fillStyle = colour; ctx.fill(); };
      disc(r + 3.4 * dpr, 'rgba(8,10,14,0.9)');
      disc(r + 2.2 * dpr, d.role === 'target' || d.ring === 'gold' ? '#ffd24a' : '#d9dbe0');
      disc(r + 0.4 * dpr, 'rgba(8,10,14,0.85)');
      disc(r, fill);
      if (pet) outlined(`${d.name ?? 'Pet'}${d.dead ? ' (dead)' : ''}`, p[0], p[1] - 14 * dpr, '#d9d3ff', 11);
    }

    for (const m of live.party) {
      const p = toScreen(m.x, m.y, m.z + 2);
      if (!p || p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) continue;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 5.5 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = m.dead ? '#8b93a0' : '#5ee08a';
      ctx.fill();
      ctx.lineWidth = 2 * dpr; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      outlined(m.name, p[0], p[1] - 14 * dpr, m.dead ? '#c9ced6' : '#c9ffd9');
    }

    // Where you are heading: a diamond at the end of each route, in the route's colour, with what is left of the way there.
    for (const t of live.targets ?? (live.target ? [live.target] : [])) {
      const p = toScreen(t.x, t.y, t.z + 2);
      if (p && p[0] >= -20 && p[0] <= W + 20 && p[1] >= -20 && p[1] <= H + 20) {
        const r = 7 * dpr;
        ctx.beginPath();
        ctx.moveTo(p[0], p[1] - r); ctx.lineTo(p[0] + r, p[1]); ctx.lineTo(p[0], p[1] + r); ctx.lineTo(p[0] - r, p[1]);
        ctx.closePath();
        ctx.lineJoin = 'round'; ctx.lineWidth = 4.5 * dpr; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
        ctx.fillStyle = t.color ?? '#ffd23a'; ctx.fill();
        if (t.text) outlined(t.text, p[0], p[1] - 17 * dpr, '#ffffff', 11);
      }
    }

    const me = live.player;
    if (!me) return;
    const rx = me.x - cam[0], ry = me.y - cam[1], rz = me.z + 2 - cam[2];
    const p = toScreen(me.x, me.y, me.z + 2);
    const color = me.stale ? '#7d8694' : me.dead ? '#aab2bf' : '#35c8ff';
    const arrow = (x, y, angle, r) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(r, 0); ctx.lineTo(-r * 0.75, r * 0.68); ctx.lineTo(-r * 0.35, 0); ctx.lineTo(-r * 0.75, -r * 0.68);
      ctx.closePath();
      ctx.lineJoin = 'round';
      ctx.lineWidth = 5 * dpr; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      ctx.fillStyle = color; ctx.fill();
      ctx.lineWidth = 1.6 * dpr; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      ctx.restore();
    };
    const margin = 26 * dpr;
    if (p && p[0] >= margin && p[0] <= W - margin && p[1] >= margin && p[1] <= H - margin) {
      if (me.figure) return; // close up you are drawn as a figure in the world instead (figure.js)
      let angle = null;
      if (me.heading !== null) {
        // Point the arrow the way the character faces, as seen from the current camera.
        const h = (me.heading * Math.PI) / 180, len = Math.max(2, p[2] * 0.03);
        const q = toScreen(me.x + Math.cos(h) * len, me.y - Math.sin(h) * len, me.z + 2);
        if (q) angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
      }
      if (angle === null) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], 7 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      } else arrow(p[0], p[1], angle, 12 * dpr);
    } else {
      // Off screen: an arrow on the edge pointing toward you, with the distance.
      let cx = vp[0] * rx + vp[4] * ry + vp[8] * rz, cy = vp[1] * rx + vp[5] * ry + vp[9] * rz;
      const w = vp[3] * rx + vp[7] * ry + vp[11] * rz;
      if (w < 0) { cx = -cx; cy = -cy; }
      const len = Math.hypot(cx, cy) || 1;
      const dx = cx / len, dy = -cy / len; // canvas y runs down
      const t = Math.min((W / 2 - margin) / Math.abs(dx || 1e-9), (H / 2 - margin) / Math.abs(dy || 1e-9));
      const ex = W / 2 + dx * t, ey = H / 2 + dy * t;
      arrow(ex, ey, Math.atan2(dy, dx), 10 * dpr);
      const dist = Math.hypot(rx, ry, rz);
      outlined(dist >= 1760 ? `${(dist / 1760).toFixed(1)} mi` : `${Math.round(dist)} yd`, ex - dx * 30 * dpr, ey - dy * 30 * dpr, '#bfeaff', 11);
    }
  }
}
