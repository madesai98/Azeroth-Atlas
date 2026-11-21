// Auction prices: what every item costs at your auction house, and how that has moved.
//
// Where it comes from (server/auctions.js keeps it up while the map runs):
//   Blizzard's own game data      every auction in every house, listed anew each hour. Read once an
//                                 hour by a scheduled function in the cloud (functions/) and put into
//                                 the Atlas database; every copy reads it from there. Kept 30 days and
//                                 no longer (Blizzard's terms for that data), so a chart never reaches
//                                 further back.
//   the game's item tables        each item's name and kind (from your own installed game)
//   TradeSkillMaster              how often and how fast an item SELLS, which no list of auctions can
//                                 say; fetched by each copy for itself from TSM's public price files
//
// Two prices are told apart everywhere:
//   lowest       the cheapest anybody asks for one piece right now
//   going price  what the cheap end of the market asks, oddities left out (functions/summary.js):
//                one seller dumping a single piece moves the lowest, not this
//
// An item's page also says what the item gives (its stats, armor and damage, worked out from the
// game's tables: extractor/jobs/items.js), which recipe makes it and what that costs at today's
// prices, and which recipes it goes into. The Crafting list is every recipe costed that way
// (auctions/craft.js says what is and is not in the sum).
//
// The charts follow one set of rules: one measure to a chart (price above, pieces for sale
// below, never two scales on one), colours by what a line IS (always the same one), every
// number reachable without the pointer (the table under the charts), and a crosshair that finds
// the nearest look so nobody has to aim at a line.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'style') e.style.cssText = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v); }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};
const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== false && v !== null && v !== undefined) e.setAttribute(k, v);
  for (const c of children) if (c) e.append(c);
  return e;
};

/** A piece of text in a chart. */
const label = (attrs, words) => { const t = svg('text', attrs); t.textContent = words; return t; };

// what a line is, and the one colour it always has (checked against this page's dark surface)
const SERIES = {
  going: { name: 'Going price', color: '#3987e5' },
  lowest: { name: 'Lowest asked', color: '#d95926' },
  pieces: { name: 'Pieces for sale', color: '#199e70' },
};
const QUALITY = ['Poor', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
const QUALITY_COLOR = ['#9d9d9d', '#e8ecf2', '#3fd14a', '#4a9dff', '#b56bf5', '#ff8c1a'];
const KINDS = { 0: 'Consumables', 1: 'Containers', 2: 'Weapons', 3: 'Gems', 4: 'Armor', 5: 'Reagents', 6: 'Projectiles', 7: 'Trade goods', 9: 'Recipes', 11: 'Quivers', 12: 'Quest items', 13: 'Keys', 15: 'Miscellaneous' };
const KEY = 'wfmap.prices';
const PAGE = 250; // rows put on the page at a time

// the columns of a row as the server sends it (auctions/view.js)
const C = { id: 0, name: 1, quality: 2, kind: 3, sub: 4, req: 5, min: 6, mv: 7, auctions: 8, pieces: 9, day: 10, week: 11, rate: 12, perDay: 13 };

/** 123456 copper → "12g 34s 56c" (the copper left off from 100g, the silver from 10,000g) */
export function money(c) {
  c = Math.round(Number(c) || 0);
  if (c <= 0) return '–';
  const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, k = c % 100;
  if (g >= 10000) return `${g.toLocaleString()}g`;
  if (g >= 100) return `${g.toLocaleString()}g ${s}s`;
  if (g) return `${g}g ${s}s ${k}c`;
  return s ? `${s}s ${k}c` : `${k}c`;
}
/** A price as an axis says it: one unit, a round number ("2g", "50s", "1g 50s"). */
function axisMoney(c) {
  c = Math.round(c);
  if (c >= 10000) { const g = Math.floor(c / 10000), s = Math.round((c % 10000) / 100); return s ? `${g.toLocaleString()}g ${s}s` : `${g.toLocaleString()}g`; }
  if (c >= 100) { const s = Math.floor(c / 100), k = c % 100; return k ? `${s}s ${k}c` : `${s}s`; }
  return `${c}c`;
}
/** A difference in money, with its sign: "+1g 2s 3c", "−45c". */
const signed = (c) => (c > 0 ? `+${money(c)}` : c < 0 ? `−${money(-c)}` : '0c');
const pct = (now, then) => (now > 0 && then > 0 ? (now - then) / then : null);
const pctText = (p) => (p === null ? '–' : Math.abs(p) < 0.005 ? '0%' : `${p > 0 ? '▲' : '▼'} ${Math.abs(p * 100) >= 100 ? Math.round(Math.abs(p * 100)).toLocaleString() : (Math.abs(p * 100)).toFixed(Math.abs(p) < 0.1 ? 1 : 0)}%`);
const ago = (t) => { const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60)); return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`; };
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayText = (day) => new Date(Date.UTC(Math.floor(day / 10000), Math.floor(day / 100) % 100 - 1, day % 100)).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dayStart = (day) => Date.UTC(Math.floor(day / 10000), Math.floor(day / 100) % 100 - 1, day % 100) / 1000;

async function ask(url, opts) {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
  return j;
}

// ---- the charts ---------------------------------------------------------------------------

/** Round numbers to put along an axis from lo to hi: about `want` of them. */
function ticks(lo, hi, want = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / want, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/**
 * One chart: lines over time, with a crosshair that finds the nearest look.
 * @param spec { title, height, zero (the axis starts at nothing), whole (what is counted comes whole), fmt (a value as text), fmtAxis, fmtTime,
 *               xs: [t…] (every look, shared by all lines),
 *               lines: [{ key (of SERIES), values: [v…] (0: nothing then), wash (fill under it) }],
 *               band: { lo: [v…], hi: [v…], of (key) } (a day's range, drawn as a wash),
 *               extra: (i) => [[label, value]…] more to say in the readout }
 */
function drawChart(box, spec) {
  box.textContent = '';
  const W = Math.max(320, box.clientWidth || 640), H = spec.height;
  const m = { l: 62, r: 86, t: 10, b: 22 };
  const xs = spec.xs, n = xs.length;
  const all = [];
  for (const l of spec.lines) for (const v of l.values) if (v > 0) all.push(v);
  if (spec.band) for (let i = 0; i < n; i++) { if (spec.band.lo[i] > 0) all.push(spec.band.lo[i]); if (spec.band.hi[i] > 0) all.push(spec.band.hi[i]); }
  if (!n || !all.length) { box.append(el('div', { class: 'dim small', text: 'Nothing to draw yet.' })); return; }
  let lo = spec.zero ? 0 : Math.min(...all), hi = Math.max(...all);
  if (hi === lo) { hi = lo * 1.1 + 1; lo = spec.zero ? 0 : Math.max(0, lo * 0.9 - 1); }
  const pad = (hi - lo) * 0.08;
  lo = spec.zero ? 0 : Math.max(0, lo - pad); hi += pad;
  const tk = ticks(lo, hi, 4).filter((v) => !spec.whole || Number.isInteger(v)); // (no "1" twice where the marks would fall on halves)
  let x0 = xs[0], x1 = xs[n - 1];
  if (x1 === x0) { x0 -= 3600; x1 += 3600; }
  const X = (t) => m.l + ((t - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);

  const root = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: 0, 'aria-label': `${spec.title}: ${n} ${n === 1 ? 'look' : 'looks'}, the last ${spec.fmt(spec.lines[0].values[n - 1])}. Left and right arrows step through them; the table below has every number.`, class: 'pchart' });
  // the grid: hairlines, and the round numbers they stand for
  for (const v of tk) {
    root.append(svg('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }));
    root.append(label({ x: m.l - 6, y: Y(v) + 3.5, 'text-anchor': 'end', class: 'axis' }, spec.fmtAxis(v)));
  }
  // the times along the bottom: as many as fit side by side, the last look always among them
  // (placed from the right; `free` is the left edge of the one placed last)
  let free = Infinity;
  for (let i = n - 1, step = Math.max(1, Math.ceil(n / 12)); i >= 0; i -= step) {
    const words = spec.fmtTime(xs[i], true), wide = words.length * 6.4, x = X(xs[i]);
    const right = i === n - 1 ? x : x + wide / 2;
    if (right > free - 12 || right - wide < m.l - 24) continue;
    free = right - wide;
    root.append(label({ x, y: H - 6, 'text-anchor': i === n - 1 ? 'end' : 'middle', class: 'axis' }, words));
  }
  // a day's range: a wash behind its line
  if (spec.band && n > 1) {
    const up = [], down = [];
    for (let i = 0; i < n; i++) { if (!(spec.band.hi[i] > 0)) continue; up.push(`${X(xs[i]).toFixed(1)},${Y(spec.band.hi[i]).toFixed(1)}`); down.unshift(`${X(xs[i]).toFixed(1)},${Y(spec.band.lo[i] > 0 ? spec.band.lo[i] : spec.band.hi[i]).toFixed(1)}`); }
    if (up.length > 1) root.append(svg('polygon', { points: [...up, ...down].join(' '), fill: SERIES[spec.band.of].color, opacity: 0.16 }));
  }
  // the lines: broken where there was nothing for sale; a look that stands alone is a dot
  const ends = [];
  for (const l of spec.lines) {
    const color = SERIES[l.key].color;
    let d = '', run = [], lastI = -1;
    const runs = [];
    for (let i = 0; i < n; i++) {
      if (l.values[i] > 0) { run.push(i); lastI = i; } else if (run.length) { runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      if (r.length === 1) { root.append(svg('circle', { cx: X(xs[r[0]]), cy: Y(l.values[r[0]]), r: 4, fill: color })); continue; }
      const path = r.map((i, k) => `${k ? 'L' : 'M'}${X(xs[i]).toFixed(1)},${Y(l.values[i]).toFixed(1)}`).join('');
      if (l.wash) root.append(svg('path', { d: `${path}L${X(xs[r[r.length - 1]]).toFixed(1)},${Y(lo).toFixed(1)}L${X(xs[r[0]]).toFixed(1)},${Y(lo).toFixed(1)}Z`, fill: color, opacity: 0.1 }));
      d += path;
    }
    if (d) root.append(svg('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (lastI >= 0) ends.push({ l, y: Y(l.values[lastI]), x: X(xs[lastI]), v: l.values[lastI] });
  }
  // each line's last value, written at its end (kept apart where two end close together)
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
  for (const e of ends) {
    const lx = Math.min(e.x + 8, W - m.r + 8);
    root.append(svg('line', { x1: lx, x2: lx + 10, y1: e.y, y2: e.y, stroke: SERIES[e.l.key].color, 'stroke-width': 2, 'stroke-linecap': 'round' }));
    root.append(label({ x: lx + 14, y: e.y + 3.5, class: 'endlabel' }, spec.fmt(e.v)));
  }
  // the crosshair and what it reads out
  const hair = svg('line', { y1: m.t, y2: H - m.b, class: 'hair', visibility: 'hidden' });
  const dots = spec.lines.map((l) => svg('circle', { r: 4.5, fill: SERIES[l.key].color, stroke: '#10131a', 'stroke-width': 2, visibility: 'hidden' }));
  root.append(hair, ...dots);
  const tip = el('div', { class: 'ptip', style: 'display:none' });
  const wrap = el('div', { class: 'pchartwrap' }, root, tip);
  let at = -1;
  const show = (i) => {
    at = i;
    if (i < 0) { hair.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.style.display = 'none'; return; }
    const x = X(xs[i]);
    hair.setAttribute('x1', x); hair.setAttribute('x2', x); hair.setAttribute('visibility', 'visible');
    tip.textContent = '';
    tip.append(el('div', { class: 'when', text: spec.fmtTime(xs[i], false) }));
    spec.lines.forEach((l, k) => {
      const v = l.values[i];
      if (v > 0) { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', Y(v)); dots[k].setAttribute('visibility', 'visible'); } else dots[k].setAttribute('visibility', 'hidden');
      tip.append(el('div', { class: 'trow' }, el('span', { class: 'key', style: `background:${SERIES[l.key].color}` }), el('b', { text: v > 0 ? spec.fmt(v) : 'none' }), el('span', { class: 'dim', text: spec.names?.[l.key] ?? SERIES[l.key].name })));
    });
    for (const [label, value] of spec.extra?.(i) ?? []) tip.append(el('div', { class: 'trow' }, el('span', { class: 'key none' }), el('b', { text: value }), el('span', { class: 'dim', text: label })));
    tip.style.display = 'block';
    const tw = tip.offsetWidth || 170;
    tip.style.left = `${x + 14 + tw > W ? Math.max(0, x - 14 - tw) : x + 14}px`;
    tip.style.top = `${m.t}px`;
  };
  const nearest = (px) => { let best = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = Math.abs(X(xs[i]) - px); if (d < bd) { bd = d; best = i; } } return best; };
  root.addEventListener('pointermove', (ev) => { const r = root.getBoundingClientRect(); show(nearest((ev.clientX - r.left) * (W / r.width))); });
  root.addEventListener('pointerleave', () => { if (document.activeElement !== root) show(-1); });
  root.addEventListener('focus', () => { if (at < 0) show(n - 1); });
  root.addEventListener('blur', () => show(-1));
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') show(Math.max(0, (at < 0 ? n : at) - 1));
    else if (ev.key === 'ArrowRight') show(Math.min(n - 1, at + 1));
    else if (ev.key === 'Home') show(0);
    else if (ev.key === 'End') show(n - 1);
    else return;
    ev.preventDefault(); ev.stopPropagation();
  });
  box.append(wrap);
}

/** What the lines in a chart are: a short stroke of each one's colour, and its name. */
const legend = (keys, names = {}) => el('div', { class: 'plegend' }, ...keys.map((k) => el('span', {}, el('span', { class: 'key', style: `background:${SERIES[k].color}` }), names[k] ?? SERIES[k].name)));

// ---- the page -----------------------------------------------------------------------------

export function bindPrices() {
  const box = $('priceBody');
  if (!box) return { update() {} };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* nothing kept */ }
  const state = { text: '', kind: '', quality: '', sort: 'pieces', down: true, shown: PAGE, range: 'days', view: 'items', ctext: '', cskill: '', csort: 'diff', cdown: true, cshown: PAGE, conly: true, ...saved, item: null, open: false };
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify({ kind: state.kind, quality: state.quality, sort: state.sort, down: state.down, range: state.range, view: state.view, cskill: state.cskill, csort: state.csort, cdown: state.cdown, conly: state.conly })); } catch { /* not kept */ } };
  let status = null;   // /api/prices
  let list = null;     // /api/prices/list
  let listFor = '';    // which house and list `list` is
  let detail = null;   // /api/prices/item
  let crafts = null;   // /api/prices/recipes
  let craftsFor = '';  // which list's prices `crafts` was costed at

  // -- the sidebar: which house, a search, how fresh
  const house = el('select', { title: 'The auction house whose prices are shown: your ruleset and your side' });
  const find = el('input', { type: 'text', placeholder: 'Find an item (Enter: the price list)', autocomplete: 'off', spellcheck: 'false' });
  const openBtn = el('button', { text: 'Open the price list' });
  const note = el('div', { class: 'dim small' });
  const source = el('div', { class: 'dim small', title: 'The lists of auctions are Blizzard Entertainment\'s game data, read once an hour and kept for 30 days. How often an item sells is from TradeSkillMaster\'s public price files. Azeroth Atlas is not affiliated with, or endorsed by, either.', text: 'Auctions: Blizzard\'s game data, hourly. Sales: TradeSkillMaster.' });
  box.append(house, find, openBtn, note, source);

  // -- over the map: the list, or one item
  const panel = el('div', { id: 'prices', class: 'panel', style: 'display:none' });
  (document.getElementById('mapBox') ?? document.body).append(panel); // (over the map: with it wherever the map is - main.js, overlay.js)
  const title = el('div', { class: 'title grow' });
  const when = el('div', { class: 'dim small' });
  const close = el('button', { class: 'x', title: 'Close (Esc)', text: '×', onclick: () => show(false) });
  const head = el('div', { class: 'phead' }, el('div', { class: 'grow' }, title, when), close);
  const body = el('div', { class: 'pbody' });
  panel.append(head, body);

  const show = (on) => {
    state.open = on;
    panel.style.display = on ? 'flex' : 'none';
    if (on) { refresh(true); render(); }
  };
  openBtn.addEventListener('click', () => { state.item = null; show(true); });
  find.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { state.text = find.value.trim(); state.item = null; state.shown = PAGE; show(true); } ev.stopPropagation(); });
  find.addEventListener('keyup', (ev) => ev.stopPropagation());
  panel.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { if (state.item) { state.item = null; render(); } else show(false); } ev.stopPropagation(); });
  panel.addEventListener('keyup', (ev) => ev.stopPropagation());
  panel.addEventListener('wheel', (ev) => ev.stopPropagation(), { passive: true });
  house.addEventListener('change', async () => {
    if (!house.value) return;
    note.textContent = 'Fetching that house…';
    try { status = await ask(`/api/prices?house=${encodeURIComponent(house.value)}`, { method: 'POST' }); list = null; listFor = ''; crafts = null; craftsFor = ''; state.item = null; paint(); refresh(true); } catch (err) { note.textContent = err.message; }
  });

  /** The sidebar's lines, from what the server says. */
  function paint() {
    const s = status;
    if (!s) return;
    if (!house.options.length) {
      house.append(el('option', { value: '', text: 'Choose your auction house…' }));
      for (const r of s.regions ?? []) house.append(el('optgroup', { label: r.name }, ...r.houses.map((h) => el('option', { value: h.key, text: h.name }))));
    }
    house.value = s.house ?? '';
    const sum = $('priceWhen');
    if (!s.on) { note.textContent = 'Auction prices are switched off in config.json.'; if (sum) sum.textContent = ''; return; }
    if (!s.house) { note.textContent = 'Choose the house of your ruleset and side.'; if (sum) sum.textContent = ''; return; }
    if (sum) sum.textContent = s.t ? ago(s.t) : '';
    const bits = [];
    if (s.t) bits.push(`${s.items.toLocaleString()} items, listed at ${clock(s.t)} (${ago(s.t)})`);
    else bits.push(s.running ? 'Fetching the prices…' : 'No prices for this house in the Atlas database yet.');
    if (s.running && s.t) bits.push('looking for a newer list…');
    if (s.error) bits.push(`Last try: ${s.error}`);
    note.textContent = bits.join(' · ');
    note.classList.toggle('warn', !!s.error && !s.t);
  }

  let busy = false, timer = null;
  /** Ask the server how things stand, and for the list when it has a newer one. */
  async function refresh(now = false) {
    clearTimeout(timer);
    if (!busy) {
      busy = true;
      try {
        status = await ask('/api/prices');
        paint();
        const want = status.house && status.t ? `${status.house}:${status.t}` : '';
        if (state.open && want && want !== listFor) {
          const got = await ask('/api/prices/list');
          if (!got.none) { list = got; listFor = `${got.house}:${got.t}`; if (state.item) await openItem(state.item, false); if (state.view === 'craft') loadCrafts(); render(); }
        }
        if (state.open && !want) render();
      } catch (err) { note.textContent = `Prices: ${err.message}`; }
      busy = false;
    }
    // asked again: often while something is being fetched, every minute while the list is open, seldom otherwise
    const sec = $('priceBody')?.closest('details');
    timer = setTimeout(refresh, status?.running ? 4000 : state.open ? 60000 : sec?.open ? 120000 : 600000);
    void now;
  }

  async function openItem(id, draw = true) {
    state.item = id;
    try { detail = await ask(`/api/prices/item?id=${id}`); } catch (err) { detail = { error: err.message }; }
    if (draw) render();
  }

  // -- the list
  const COLS = [
    ['name', 'Item', 'left', 'Its name; the colour is its quality'],
    ['min', 'Lowest', 'right', 'The cheapest anybody asks for one piece right now'],
    ['mv', 'Going price', 'right', 'What the cheap end of the market asks, oddities left out'],
    ['day', '1 day', 'right', 'The going price against the last one of the day before'],
    ['week', '7 days', 'right', 'The going price against a week ago (or the oldest day kept, when that is less)'],
    ['pieces', 'For sale', 'right', 'How many pieces are up for sale'],
    ['rate', 'Sells', 'right', 'TradeSkillMaster, for the whole region: of the times it is put up for sale, how often it sells; and how many sell in a day'],
  ];
  const valueOf = { name: (r) => r[C.name].toLowerCase(), min: (r) => r[C.min], mv: (r) => r[C.mv], day: (r) => pct(r[C.mv], r[C.day]) ?? -Infinity, week: (r) => pct(r[C.mv], r[C.week]) ?? -Infinity, pieces: (r) => r[C.pieces], rate: (r) => r[C.perDay] };

  function rowsNow() {
    const text = state.text.toLowerCase();
    const num = /^\d+$/.test(text) ? Number(text) : null;
    const kind = state.kind === '' ? null : Number(state.kind), quality = state.quality === '' ? null : Number(state.quality);
    const rows = list.rows.filter((r) => (kind === null || r[C.kind] === kind) && (quality === null || r[C.quality] === quality) && (!text || r[C.name].toLowerCase().includes(text) || r[C.id] === num));
    const v = valueOf[state.sort] ?? valueOf.pieces;
    rows.sort((a, b) => { const x = v(a), y = v(b); return (x < y ? -1 : x > y ? 1 : 0) * (state.down ? -1 : 1) || (a[C.name] < b[C.name] ? -1 : 1); });
    return rows;
  }

  function renderList() {
    const search = el('input', { type: 'text', placeholder: 'Name, or an item\'s number', value: state.text, autocomplete: 'off', spellcheck: 'false' });
    const kinds = [...new Set(list.rows.map((r) => r[C.kind]))].filter((k) => KINDS[k]).sort((a, b) => a - b);
    const kind = el('select', { title: 'What kind of thing' }, el('option', { value: '', text: 'Every kind' }), ...kinds.map((k) => el('option', { value: k, text: KINDS[k] })));
    kind.value = state.kind;
    const quality = el('select', { title: 'Quality' }, el('option', { value: '', text: 'Any quality' }), ...QUALITY.map((q, i) => el('option', { value: i, text: q })));
    quality.value = state.quality;
    const count = el('div', { class: 'dim small' });
    const table = el('table', { class: 'ptable' });
    const more = el('button', { style: 'display:none' });
    const fill = () => {
      const rows = rowsNow();
      table.textContent = '';
      table.append(el('thead', {}, el('tr', {}, ...COLS.map(([key, label, align, tip]) => el('th', { class: align, title: tip, 'aria-sort': state.sort === key ? (state.down ? 'descending' : 'ascending') : 'none', tabindex: 0,
        onclick: () => { if (state.sort === key) state.down = !state.down; else { state.sort = key; state.down = key !== 'name'; } state.shown = PAGE; keep(); fill(); },
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.target.click(); } } }, label + (state.sort === key ? (state.down ? ' ▾' : ' ▴') : ''))))));
      const tb = el('tbody');
      for (const r of rows.slice(0, state.shown)) {
        const d = pct(r[C.mv], r[C.day]), w = pct(r[C.mv], r[C.week]);
        tb.append(el('tr', { tabindex: 0, onclick: () => openItem(r[C.id]), onkeydown: (ev) => { if (ev.key === 'Enter') openItem(r[C.id]); } },
          el('td', { class: 'name', style: `color:${QUALITY_COLOR[r[C.quality]] ?? 'inherit'}`, title: `${QUALITY[r[C.quality]] ?? ''}${r[C.req] ? ` · needs level ${r[C.req]}` : ''} · item ${r[C.id]}`, text: r[C.name] }),
          el('td', { class: 'right', text: money(r[C.min]) }),
          el('td', { class: 'right', text: money(r[C.mv]) }),
          el('td', { class: 'right dim', text: pctText(d) }),
          el('td', { class: 'right dim', text: pctText(w) }),
          el('td', { class: 'right', text: r[C.pieces].toLocaleString() }),
          el('td', { class: 'right dim', text: r[C.perDay] ? `${Math.round(r[C.rate] * 100)}% · ${r[C.perDay] >= 10 ? Math.round(r[C.perDay]).toLocaleString() : r[C.perDay].toFixed(1)}/day` : '–' })));
      }
      table.append(tb);
      count.textContent = `${rows.length.toLocaleString()} of ${list.rows.length.toLocaleString()} items`;
      more.style.display = rows.length > state.shown ? '' : 'none';
      more.textContent = `Show ${Math.min(PAGE, rows.length - state.shown)} more (${(rows.length - state.shown).toLocaleString()} not shown)`;
    };
    more.addEventListener('click', () => { state.shown += PAGE; fill(); });
    let typing = null;
    search.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { state.text = search.value.trim(); state.shown = PAGE; fill(); }, 120); });
    kind.addEventListener('change', () => { state.kind = kind.value; state.shown = PAGE; keep(); fill(); });
    quality.addEventListener('change', () => { state.quality = quality.value; state.shown = PAGE; keep(); fill(); });
    fill();
    body.append(el('div', { class: 'pfilters' }, search, kind, quality, count), el('div', { class: 'pscroll' }, table, more));
    if (list.taken) body.append(el('div', { class: 'dim small', text: 'Which ruleset a neutral house serves is taken from its place in Blizzard\'s list, not proven: there is nothing to hold it against.' }));
  }

  // -- one item
  function renderItem() {
    const d = detail;
    const back = el('button', { class: 'back', text: state.view === 'craft' ? '‹ The recipes' : '‹ The list', onclick: () => { state.item = null; render(); } });
    if (!d || d.error || d.none) { body.append(back, el('div', { class: 'warn', text: d?.error ?? 'Nothing is known of that item here.' })); return; }
    const it = d.item;
    const name = el('div', { class: 'pname', style: `color:${QUALITY_COLOR[it?.quality] ?? 'inherit'}`, text: it?.name ?? `Item ${d.id}` });
    const worn = it && (it.class === 2 || it.class === 4);
    const about = [QUALITY[it?.quality], worn && it.kind ? it.kind : KINDS[it?.class], worn ? it.where : null, worn && it.level ? `item level ${it.level}` : null, it?.requires ? `needs level ${it.requires}` : null, it?.stack > 1 ? `stacks of ${it.stack}` : null, it?.sell ? `a vendor pays ${money(it.sell)}` : null, `item ${d.id}`].filter(Boolean).join(' · ');

    // what it gives whoever wears or wields it
    const gives = [];
    if (d.does) {
      const dm = d.does.damage;
      if (dm && dm[2]) gives.push(`${dm[0]} - ${dm[1]} Damage · speed ${(dm[2] / 1000).toFixed(2)} · ${dm[3].toFixed(1)} damage per second`);
      else if (dm) gives.push(`Adds ${dm[3].toFixed(1)} damage per second`);
      if (d.does.armor) gives.push(`${d.does.armor.toLocaleString()} Armor`);
      for (const [word, value] of d.does.stats) gives.push(`${value < 0 ? '−' : '+'}${Math.abs(value)} ${word}`);
    }
    const givesBox = gives.length ? el('div', { class: 'pgives', title: 'Worked out the way the game does it, from the tables in your installed game: this game keeps no stats on an item, only its share of a budget' }, ...gives.map((g) => el('div', { text: g }))) : null;
    // what makes it, costed, and what it goes into
    const link = (id, text, quality) => el('a', { href: '#', style: `color:${QUALITY_COLOR[quality] ?? 'inherit'}`, onclick: (ev) => { ev.preventDefault(); openItem(id); } }, text);
    const madeBox = (d.made ?? []).map((m) => {
      const lines = m.parts.map(([id, pname, q, n, price, where]) => el('tr', {},
        el('td', { class: 'left' }, link(id, pname, q), el('span', { class: 'dim', text: ` ×${n}` })),
        el('td', { class: 'right dim', text: price ? `${money(price)} each${where === 'vendor' ? ', from a vendor' : ''}` : 'no price: not for sale, no vendor known' }),
        el('td', { class: 'right', text: price ? money(price * n) : '?' })));
      const one = m.count > 1 ? `the ${m.count} it makes go` : 'it goes';
      const sum = m.missing ? `The reagents that have a price come to ${money(m.cost)}; ${m.missing} ${m.missing === 1 ? 'has' : 'have'} none.`
        : !m.value ? `Costs ${money(m.cost)} to make. None is for sale to hold that against.`
          : `Costs ${money(m.cost)} to make; ${one} for ${money(m.value)}: ${m.value >= m.cost ? `${money(m.value - m.cost)} more` : `${money(m.cost - m.value)} less`} than the reagents (the auction house's cut not counted).`;
      return el('div', { class: 'pmade' },
        el('div', {}, el('b', { text: `${m.skill}: ${m.name}` }), el('span', { class: 'dim', text: `  yellow at ${m.yellow}, grey at ${m.grey}${m.count > 1 ? ` · makes ${m.count}` : ''}` })),
        el('table', { class: 'ptable plain' }, el('tbody', {}, ...lines)),
        el('div', { class: 'small', text: sum }),
        m.taught ? el('div', { class: 'small dim' }, 'Taught by ', link(m.taught[0], m.taught[1], m.taught[2])) : null);
    });
    const usesBox = d.uses?.length ? el('details', { class: 'pnumbers' }, el('summary', { text: `Goes into ${d.uses.length} ${d.uses.length === 1 ? 'recipe' : 'recipes'}` }),
      el('div', { class: 'puses' }, ...d.uses.map(([spell, rname, skill, n, pid, pname, pq]) => el('div', {}, pid ? link(pid, pname || rname, pq) : el('span', { text: rname }), el('span', { class: 'dim', text: `  ${skill} · uses ${n}` }))))) : null;
    const tiles = el('div', { class: 'ptiles' });
    const tile = (label, value, sub) => tiles.append(el('div', { class: 'ptile' }, el('div', { class: 'dim small', text: label }), el('div', { class: 'v', text: value }), sub ? el('div', { class: 'dim small', text: sub }) : null));
    const now = d.now;
    if (now) {
      tile('Lowest asked', money(now[0]), it?.sell && now[0] && now[0] <= it.sell ? 'no more than a vendor pays' : null);
      tile('Going price', money(now[1]));
      tile('For sale', `${now[3].toLocaleString()}`, `in ${now[2].toLocaleString()} ${now[2] === 1 ? 'auction' : 'auctions'}`);
    } else tile('Now', 'None for sale', d.t ? `as listed ${ago(d.t)}` : null);
    const reg = d.tsm?.region, hs = d.tsm?.house;
    if (reg?.soldPerDay) tile('Sells', `${Math.round(reg.saleRate * 100)}% of the time`, `${reg.soldPerDay >= 10 ? Math.round(reg.soldPerDay).toLocaleString() : reg.soldPerDay.toFixed(1)} a day in the region, for ${money(reg.avgSalePrice)} on average`);

    // which looks: every one of the last days, or one line a day
    const hours = d.hours ?? [], days = d.days ?? [];
    const byDay = state.range === 'days' || !hours.length;
    const pick = el('div', { class: 'btnrow prange', role: 'group', 'aria-label': 'What the charts show' },
      el('button', { class: byDay ? 'chosen' : '', text: `Day by day (${days.length} ${days.length === 1 ? 'day' : 'days'})`, 'aria-pressed': byDay, onclick: () => { state.range = 'days'; keep(); render(); } }),
      el('button', { class: byDay ? '' : 'chosen', text: `Every look (${hours.length})`, 'aria-pressed': !byDay, disabled: !hours.length, onclick: () => { state.range = 'hours'; keep(); render(); } }));
    const priceBox = el('div'), pieceBox = el('div');
    const xs = byDay ? days.map((x) => dayStart(x[0])) : hours.map((x) => x[0]);
    const fmtTime = byDay ? (t, short) => new Date(t * 1000).toLocaleDateString([], short ? { month: 'short', day: 'numeric', timeZone: 'UTC' } : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
      : (t, short) => new Date(t * 1000).toLocaleString([], short ? { weekday: 'short', hour: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    // (a day's line holds the day's last going price and the lowest anybody asked in all of that day:
    // said so, or the chart's last "lowest" would seem to contradict the one in the box above)
    const names = byDay ? { going: 'Going price (the day\'s last)', lowest: 'Lowest asked that day' } : {};
    const price = {
      title: 'Price', height: 230, zero: false, fmt: money, fmtAxis: axisMoney, fmtTime, xs, names,
      lines: [{ key: 'going', values: byDay ? days.map((x) => x[3]) : hours.map((x) => x[2]) }, { key: 'lowest', values: byDay ? days.map((x) => x[4]) : hours.map((x) => x[1]) }],
      band: byDay ? { lo: days.map((x) => x[1]), hi: days.map((x) => x[2]), of: 'going' } : null,
      extra: byDay ? (i) => (days[i][1] > 0 && days[i][2] > days[i][1] ? [['going price that day', `${money(days[i][1])} to ${money(days[i][2])}`]] : []) : null,
    };
    const pieces = { title: 'Pieces for sale', height: 120, zero: true, whole: true, fmt: (v) => Math.round(v).toLocaleString(), fmtAxis: (v) => (v >= 10000 ? `${Math.round(v / 1000)}K` : Math.round(v).toLocaleString()), fmtTime, xs, lines: [{ key: 'pieces', values: byDay ? days.map((x) => x[5]) : hours.map((x) => x[3]), wash: true }] };

    // every number of the charts, as a table
    const rowsOf = byDay ? days.slice().reverse().map((x) => [dayText(x[0]), money(x[3]), x[2] > x[1] ? `${money(x[1])} to ${money(x[2])}` : '–', money(x[4]), x[5].toLocaleString()])
      : hours.slice().reverse().map((x) => [fmtTime(x[0], false), money(x[2]), null, money(x[1]), x[3].toLocaleString()]);
    const heads = byDay ? ['Day', 'Going price (last)', 'Range that day', 'Lowest asked', 'For sale (last)'] : ['Look', 'Going price', null, 'Lowest asked', 'For sale'];
    const numbers = el('details', { class: 'pnumbers' }, el('summary', { text: 'The numbers as a table' }),
      el('table', { class: 'ptable plain' }, el('thead', {}, el('tr', {}, ...heads.filter(Boolean).map((h, i) => el('th', { class: i ? 'right' : 'left', text: h })))),
        el('tbody', {}, ...rowsOf.map((r) => el('tr', {}, ...r.filter((c) => c !== null).map((c, i) => el('td', { class: i ? 'right' : 'left', text: c })))))));

    const notes = [];
    if (hs) notes.push(`TradeSkillMaster for this house (as of ${new Date(hs.updated).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}): market value ${money(hs.marketValue)}, lowest ${money(hs.minBuyout)}, long-run average ${money(hs.historical)}.`);
    notes.push(days.length < 2 ? 'The charts grow as the house is looked at: a look an hour, a line a day.' : `Auction lists may be kept 30 days (Blizzard's terms for its data): the charts go back no further. ${days.length} ${days.length === 1 ? 'day is' : 'days are'} kept now.`);

    // (what an item has not got - no stats, no recipe - is left out)
    body.append(...[back, name, el('div', { class: 'dim small', text: about }), givesBox, tiles, ...madeBox, usesBox, pick,
      el('div', { class: 'pchead' }, el('span', { class: 'title', text: 'Price of one piece' }), legend(['going', 'lowest'], names)), priceBox,
      el('div', { class: 'pchead' }, el('span', { class: 'title', text: 'Pieces for sale' })), pieceBox,
      numbers, ...notes.map((t) => el('div', { class: 'dim small', text: t }))].filter(Boolean));
    drawChart(priceBox, price);
    drawChart(pieceBox, pieces);
  }


  // -- the recipes: what each costs to make at today's prices, and what the thing made goes for
  const CCOLS = [
    ['name', 'Recipe', 'left', 'What is made; the colour is its quality. Click for the item, and what the recipe uses'],
    ['skill', 'Skill', 'right', 'The skill at which the recipe turns yellow (fewer skill points) and grey (none)'],
    ['cost', 'Costs', 'right', 'What the reagents cost: the going price at the auction house, or a vendor\'s where one sells the reagent for no more'],
    ['value', 'Sells for', 'right', 'What the things made go for at the auction house (all of them, where the recipe makes several)'],
    ['diff', 'Difference', 'right', 'Sells for, less costs. The auction house\'s cut is not taken off, and a price asked is not a sale: see Sells'],
    ['rate', 'Sells', 'right', 'TradeSkillMaster, for the whole region: how often the thing made sells of the times it is put up, and how many sell in a day'],
  ];
  const R = { spell: 0, name: 1, skill: 2, learnt: 3, yellow: 4, grey: 5, item: 6, itemName: 7, quality: 8, count: 9, cost: 10, missing: 11, value: 12, rate: 13, perDay: 14, taught: 15 };
  const diffOf = (r) => (r[R.missing] || !r[R.value] || !r[R.cost] ? null : r[R.value] - r[R.cost]);
  const cvalue = { name: (r) => (r[R.itemName] || r[R.name]).toLowerCase(), skill: (r) => r[R.yellow], cost: (r) => r[R.cost], value: (r) => r[R.value], diff: (r) => diffOf(r) ?? -Infinity, rate: (r) => r[R.perDay] };

  function renderCraft() {
    if (!crafts) { body.append(el('div', { class: 'dim', text: 'Costing the recipes…' })); return; }
    const search = el('input', { type: 'text', placeholder: 'A recipe, or what it makes', value: state.ctext, autocomplete: 'off', spellcheck: 'false' });
    const skills = Object.entries(crafts.skills).sort((a, b) => (a[1] < b[1] ? -1 : 1));
    const skill = el('select', { title: 'Which profession' }, el('option', { value: '', text: 'Every profession' }), ...skills.map(([id, n]) => el('option', { value: id, text: n })));
    skill.value = state.cskill;
    const whole = el('input', { type: 'checkbox' });
    whole.checked = !!state.conly;
    const count = el('div', { class: 'dim small' });
    const table = el('table', { class: 'ptable' });
    const more = el('button', { style: 'display:none' });
    const fill = () => {
      const text = state.ctext.toLowerCase(), sk = state.cskill === '' ? null : Number(state.cskill);
      const rows = crafts.rows.filter((r) => (sk === null || r[R.skill] === sk) && (!state.conly || diffOf(r) !== null) && (!text || r[R.name].toLowerCase().includes(text) || r[R.itemName].toLowerCase().includes(text)));
      const v = cvalue[state.csort] ?? cvalue.diff;
      rows.sort((a, b) => { const x = v(a), y = v(b); return (x < y ? -1 : x > y ? 1 : 0) * (state.cdown ? -1 : 1) || (a[R.name] < b[R.name] ? -1 : 1); });
      table.textContent = '';
      table.append(el('thead', {}, el('tr', {}, ...CCOLS.map(([key, label, align, tip]) => el('th', { class: align, title: tip, 'aria-sort': state.csort === key ? (state.cdown ? 'descending' : 'ascending') : 'none', tabindex: 0,
        onclick: () => { if (state.csort === key) state.cdown = !state.cdown; else { state.csort = key; state.cdown = key !== 'name'; } state.cshown = PAGE; keep(); fill(); },
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.target.click(); } } }, label + (state.csort === key ? (state.cdown ? ' ▾' : ' ▴') : ''))))));
      const tb = el('tbody');
      for (const r of rows.slice(0, state.cshown)) {
        const d = diffOf(r), made = r[R.item] > 0;
        const go = () => { if (made) openItem(r[R.item]); };
        tb.append(el('tr', { tabindex: made ? 0 : null, class: made ? '' : 'still', onclick: go, onkeydown: (ev) => { if (ev.key === 'Enter') go(); } },
          el('td', { class: 'name', title: `${crafts.skills[r[R.skill]] ?? ''}${made ? '' : ' · makes no item (an enchantment, say)'}${r[R.taught] ? ' · taught by an item' : ''} · spell ${r[R.spell]}` },
            el('span', { style: `color:${QUALITY_COLOR[r[R.quality]] ?? 'inherit'}`, text: r[R.itemName] || r[R.name] }), r[R.count] > 1 ? el('span', { class: 'dim', text: ` ×${r[R.count]}` }) : null,
            el('span', { class: 'dim small', text: `  ${crafts.skills[r[R.skill]] ?? ''}` })),
          el('td', { class: 'right dim', text: r[R.yellow] || r[R.grey] ? `${r[R.yellow]} / ${r[R.grey]}` : '–' }),
          el('td', { class: 'right', title: r[R.missing] ? `${r[R.missing]} of its reagents ${r[R.missing] === 1 ? 'has' : 'have'} no price: not for sale at the house, and no vendor known to sell ${r[R.missing] === 1 ? 'it' : 'them'}` : null, text: r[R.missing] ? (r[R.cost] ? `${money(r[R.cost])} + ?` : '?') : money(r[R.cost]) }),
          el('td', { class: 'right', text: money(r[R.value]) }),
          el('td', { class: 'right', text: d === null ? '–' : signed(d) }),
          el('td', { class: 'right dim', text: r[R.perDay] ? `${Math.round(r[R.rate] * 100)}% · ${r[R.perDay] >= 10 ? Math.round(r[R.perDay]).toLocaleString() : r[R.perDay].toFixed(1)}/day` : '–' })));
      }
      table.append(tb);
      count.textContent = `${rows.length.toLocaleString()} of ${crafts.rows.length.toLocaleString()} recipes`;
      more.style.display = rows.length > state.cshown ? '' : 'none';
      more.textContent = `Show ${Math.min(PAGE, rows.length - state.cshown)} more (${(rows.length - state.cshown).toLocaleString()} not shown)`;
    };
    more.addEventListener('click', () => { state.cshown += PAGE; fill(); });
    let typing = null;
    search.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(() => { state.ctext = search.value.trim(); state.cshown = PAGE; fill(); }, 120); });
    skill.addEventListener('change', () => { state.cskill = skill.value; state.cshown = PAGE; keep(); fill(); });
    whole.addEventListener('change', () => { state.conly = whole.checked; state.cshown = PAGE; keep(); fill(); });
    fill();
    body.append(el('div', { class: 'pfilters' }, search, skill, el('label', { class: 'row', title: 'Leave out the recipes whose difference cannot be worked out: a reagent with no price, or nothing of what it makes for sale' }, whole, 'Only what can be costed'), count),
      el('div', { class: 'pscroll' }, table, more),
      el('div', { class: 'dim small', text: `Costs are today's: each reagent at the auction house's going price, or at a vendor's where one sells it for no more (${crafts.vendors} reagents are known to be sold by vendors). Not counted: the auction house's cut, and the price of learning the recipe. A difference is between two prices asked, not a promise: "Sells" says whether the thing is bought at all.` }));
  }

  /** The two lists to choose between. */
  function tabs() {
    const to = (view) => () => { state.view = view; state.item = null; keep(); if (view === 'craft') loadCrafts(); render(); };
    return el('div', { class: 'btnrow prange ptabs', role: 'group', 'aria-label': 'Which list' },
      el('button', { class: state.view === 'craft' ? '' : 'chosen', 'aria-pressed': state.view !== 'craft', text: 'Items', onclick: to('items') }),
      el('button', { class: state.view === 'craft' ? 'chosen' : '', 'aria-pressed': state.view === 'craft', text: 'Crafting', onclick: to('craft') }));
  }

  async function loadCrafts() {
    if (!listFor || craftsFor === listFor) return;
    const want = listFor;
    try { const got = await ask('/api/prices/recipes'); if (!got.none) { crafts = got; craftsFor = want; } } catch { /* asked again with the next list */ }
    if (state.open && state.view === 'craft' && !state.item) render();
  }

  function render() {
    if (!state.open) return;
    body.textContent = '';
    title.textContent = `Auction prices${status?.name ? ` · ${status.name}` : ''}`;
    when.textContent = list ? `Listed at ${clock(list.t)} (${ago(list.t)}) by Blizzard${list.by === 'atlas' ? ', by way of the Atlas database' : ''}. A new list comes about once an hour.` : '';
    if (!status?.house) { body.append(el('div', { class: 'dim', text: 'Choose your auction house in the sidebar (Auction prices): the one of your ruleset and your side.' })); return; }
    if (!list) { body.append(el('div', { class: 'dim', text: status?.running ? 'Fetching the prices…' : status?.error ? `No prices yet. Last try: ${status.error}` : 'No prices for this house yet.' })); return; }
    if (state.item) { renderItem(); return; }
    body.append(tabs());
    if (state.view === 'craft') { if (craftsFor !== listFor) loadCrafts(); renderCraft(); } else renderList();
  }
  window.addEventListener('resize', () => { if (state.open && state.item) render(); });

  refresh(true);
  return { update: refresh, open: (text) => { if (typeof text === 'string') state.text = text; state.item = null; show(true); }, item: (id) => { show(true); openItem(id); } };
}
