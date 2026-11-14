// Ways of getting about that are not walking or a flight path: boats and zeppelins, and the
// doorways that take you from one map to another (the Deeprun Tram, Darnassus' portal).
//
// Boats and zeppelins come from the game's own tables: they sail the same kind of route a flight
// path flies, and the points where they wait are marked. Doorways are not in the game's files
// (where one leads is decided by the server), so those are read, when it is installed, from the
// ShortestPathForever addon's public data, which lists them for this game.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { flavourFolder } from './config.js';

const TRANSPORT_SPEED = 30; // yards per second a boat or zeppelin travels at
const STOP = 2;             // TaxiPathNode flag: the transport waits here
const JUMP = 1;             // TaxiPathNode flag: the transport is moved from here to the next point
const JUMP_YARDS = 1500;    // no real stretch between two points is this long
const LOADING = 10;         // seconds a loading screen takes

/**
 * @param taxiNodes, taxiPaths, pathNodes  rows of the game tables
 * @returns [{ id, name, kind, period (seconds for a full round), stops: [{ map, pos, wait, next (seconds of travel to the following stop) }] }]
 */
export function transportLines(taxiNodes, taxiPaths, pathNodes) {
  const name = new Map(taxiNodes.map((r) => [r.ID, r.Name_lang ?? '']));
  const byPath = new Map();
  for (const n of pathNodes) {
    let list = byPath.get(n.PathID);
    if (!list) byPath.set(n.PathID, (list = []));
    list.push(n);
  }
  const lines = [];
  for (const p of taxiPaths) {
    const pts = (byPath.get(p.ID) ?? []).sort((a, b) => a.NodeIndex - b.NodeIndex);
    const stopAt = pts.map((r, i) => (r.Flags & STOP ? i : -1)).filter((i) => i >= 0);
    if (stopAt.length < 2) continue;
    // travel time from each stop to the next, going round (the route is a loop). Where the
    // transport is moved rather than travels (a change of map, a point marked as a jump, or a
    // step no real stretch is as long as) there is a loading screen, not a distance.
    const leg = (a, b) => {
      let yards = 0;
      for (let i = a; i !== b; i = (i + 1) % pts.length) {
        const q = pts[i], r = pts[(i + 1) % pts.length];
        const d = Math.hypot(r.Loc[0] - q.Loc[0], r.Loc[1] - q.Loc[1], r.Loc[2] - q.Loc[2]);
        if (q.ContinentID === r.ContinentID && !(q.Flags & JUMP) && d < JUMP_YARDS) yards += d;
        else yards += LOADING * TRANSPORT_SPEED;
      }
      return yards / TRANSPORT_SPEED;
    };
    const stops = stopAt.map((i, k) => ({
      map: pts[i].ContinentID, pos: pts[i].Loc.map((v) => Math.round(v * 100) / 100), wait: pts[i].Delay,
      next: Math.round(leg(i, stopAt[(k + 1) % stopAt.length])),
    }));
    // the same place twice in a row (a boat that turns round) is one stop
    const distinct = stops.filter((s, k) => { const o = stops[(k + stops.length - 1) % stops.length]; return !(o.map === s.map && Math.hypot(o.pos[0] - s.pos[0], o.pos[1] - s.pos[1]) < 30) || stops.length === 1; });
    if (distinct.length < 2) continue;
    const label = (name.get(p.FromTaxiNode) || name.get(p.ToTaxiNode) || `Route ${p.ID}`).replace(/^Transport,\s*/, '');
    const high = Math.max(...stops.map((s) => s.pos[2]));
    lines.push({
      id: p.ID, name: label, kind: high > 20 ? 'zeppelin' : 'boat',
      period: Math.round(stops.reduce((t, s) => t + s.next + s.wait, 0)),
      stops: distinct,
    });
  }
  return lines;
}

// ---- a small reader for the plain data tables in an addon's Lua file ----
function luaTable(src, at) {
  let p = at;
  const ws = () => { for (;;) { while (/\s/.test(src[p] ?? '')) p++; if (src.startsWith('--', p)) { while (p < src.length && src[p] !== '\n') p++; } else break; } };
  const value = () => {
    ws();
    const c = src[p];
    if (c === '{') {
      p++;
      const list = [], obj = {};
      let keyed = false;
      for (;;) {
        ws();
        if (src[p] === '}') { p++; break; }
        const m = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(src.slice(p, p + 80));
        if (m) { p += m[0].length; obj[m[1]] = value(); keyed = true; }
        else if (src[p] === '[') { const e = src.indexOf(']', p); const k = src.slice(p + 1, e).trim().replace(/^["']|["']$/g, ''); p = e + 1; ws(); p++; obj[k] = value(); keyed = true; }
        else list.push(value());
        ws();
        if (src[p] === ',' || src[p] === ';') p++;
      }
      return keyed ? obj : list;
    }
    if (c === '"' || c === "'") {
      let e = p + 1, out = '';
      while (e < src.length && src[e] !== c) { if (src[e] === '\\') e++; out += src[e++]; }
      p = e + 1;
      return out;
    }
    const m = /^(-?\d+\.?\d*(?:[eE][-+]?\d+)?|true|false|nil)/.exec(src.slice(p, p + 40));
    if (!m) throw new Error(`unexpected "${src.slice(p, p + 20)}"`);
    p += m[0].length;
    return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'nil' ? null : +m[0];
  };
  return value();
}

/** Path of ShortestPathForever's doorway list, or null if the addon is not installed. */
export function findPortalData(cfg) {
  const folder = flavourFolder(cfg);
  if (!folder) return null;
  const file = path.join(cfg.installRoot, folder, 'Interface', 'AddOns', 'ShortestPathForever', 'Data', 'Portals.lua');
  return fs.existsSync(file) ? file : null;
}

/**
 * @returns {{ hash, portals: [{ name, kind, from: { map, pos }, to: { map, pos }, seconds }] }}
 */
export function readPortals(file) {
  const src = fs.readFileSync(file, 'utf8');
  const at = src.search(/ns\.Portals\s*=\s*\{/);
  if (at < 0) throw new Error('no portal list found');
  const list = luaTable(src, src.indexOf('{', at));
  const end = (e) => (e && Number.isFinite(e.map) && Number.isFinite(e.x) && Number.isFinite(e.y) ? { map: e.map, pos: [e.x, e.y, Number.isFinite(e.z) ? e.z : null] } : null);
  const portals = [];
  for (const p of Array.isArray(list) ? list : []) {
    const from = end(p.from), to = end(p.to);
    if (from && to) portals.push({ name: typeof p.name === 'string' ? p.name : 'Portal', kind: typeof p.kind === 'string' ? p.kind : 'portal', from, to, seconds: Number.isFinite(p.seconds) ? p.seconds : 5 });
  }
  return { hash: crypto.createHash('sha1').update(src).digest('hex'), portals };
}
