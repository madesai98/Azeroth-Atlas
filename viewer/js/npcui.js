// The NPC panel: the switches for who is shown, the card for the NPC you click, and the line
// that says what was learned when you talk to someone in the game. (The data and the drawing
// are in npcs.js.)
import { KINDS, GROUPS, RANKS, TYPES, HEIGHT_HOW, SEEN, iconStyle, kindIcon } from './npcs.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'style') e.style.cssText = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
};

/**
 * @param app    the viewer (app.npcs is the NpcLayer)
 * @param sheet  the canvas the markers were drawn into (for the little copies beside each switch)
 * @returns { hover(spawn | -1), open(spawn), close() }
 */
export function bindNpcs(app, sheet) {
  const layer = app.npcs, s = layer.settings;
  const sheetUrl = sheet.toDataURL();
  const redraw = () => { app.dirty = true; };

  // ---- the switches ----
  // One for every kind of NPC, in groups; each group can be switched on or off as a whole.
  const kinds = $('npcKinds');
  const boxes = new Map();
  for (const g of GROUPS) {
    const mine = KINDS.filter((k) => k.group === g.key);
    const all = (on) => (e) => {
      e.preventDefault();
      for (const k of mine) boxes.get(k.key).checked = on;
      layer.set({ kinds: { ...s.kinds, ...Object.fromEntries(mine.map((k) => [k.key, on])) } });
    };
    const grid = el('div', { class: 'kinds' });
    for (const k of mine) {
      const box = el('input', { type: 'checkbox', id: `npcKind_${k.key}` });
      box.checked = !!s.kinds[k.key];
      box.addEventListener('change', () => layer.set({ kinds: { ...s.kinds, [k.key]: box.checked } }));
      boxes.set(k.key, box);
      grid.append(el('label', { title: k.hint ?? k.label }, box, el('span', { style: iconStyle(sheetUrl, kindIcon(k.key)) }), document.createTextNode(k.label)));
    }
    const group = el('div', { class: 'kindGroup' },
      el('div', { class: 'head' }, el('span', { class: 'grow', style: 'flex:1', text: g.label }),
        mine.length > 1 ? el('a', { href: '#', text: 'all', onclick: all(true) }) : null, mine.length > 1 ? el('a', { href: '#', text: 'none', onclick: all(false) }) : null),
      grid);
    kinds.append(group);
    if (g.key !== 'creatures') continue;
    // Creatures (friendly, neutral, hostile, side not recorded) are narrowed further: by rank, and
    // by the kind of thing they are where the map's data says (see extractor/jobs/npcs.js).
    const narrow = (title, list, key, hint) => {
      const row = el('div', { class: 'kinds', title: hint });
      for (const [value, label] of list) {
        const box = el('input', { type: 'checkbox' });
        box.checked = s[key][value] !== false;
        box.addEventListener('change', () => layer.set({ [key]: { ...s[key], [value]: box.checked } }));
        row.append(el('label', {}, box, document.createTextNode(label)));
      }
      return el('div', { class: 'kindGroup' }, el('div', { class: 'head', text: title }), row);
    };
    group.append(narrow('Creatures: rank', RANKS, 'ranks', 'Which creatures, by rank'));
    const types = narrow('Creatures: kind', TYPES, 'types', 'Which creatures, by the kind of thing they are (from the reference database; a creature new to this game is "not recorded")');
    types.id = 'npcTypes';
    group.append(types);
  }
  const number = (v) => { const n = Math.round(+v); return Number.isFinite(n) && n > 0 ? n : null; };
  const bind = (id, key, read) => {
    const input = $(id);
    if (input.type === 'checkbox') input.checked = !!s[key]; else input.value = s[key] ?? '';
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => layer.set({ [key]: read(input) }));
  };
  bind('optNpcs', 'enabled', (i) => i.checked);
  bind('npcMyQuests', 'myQuests', (i) => i.checked);
  bind('npcUnsure', 'unsure', (i) => i.checked);
  bind('npcNames', 'names', (i) => i.checked);
  bind('npcMin', 'min', (i) => number(i.value));
  bind('npcMax', 'max', (i) => number(i.value));
  bind('npcRange', 'range', (i) => Math.max(50, Math.min(60000, number(i.value) ?? 1200)));
  const search = $('npcSearch');
  search.addEventListener('input', () => { layer.settings.search = search.value; layer.rebuild(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { search.value = ''; layer.settings.search = ''; layer.rebuild(); search.blur(); }
    // Enter: fly to the nearest of what was found
    if (e.key === 'Enter' && layer.count) {
      const cam = app.camera, o = layer.origin, inst = layer.inst;
      let best = 0, bestD = Infinity;
      const S = layer.stride;
      for (let k = 0; k < layer.count; k++) { const d = Math.hypot(inst[k * S] + o[0] - cam.pos[0], inst[k * S + 1] + o[1] - cam.pos[1]); if (d < bestD) { bestD = d; best = k; } }
      cam.lookAt([inst[best * S] + o[0], inst[best * S + 1] + o[1], inst[best * S + 2] + o[2]], 90, cam.heading, -40, true);
      open(layer.shown[best]);
    }
  });

  // ---- what the panel says about the map ----
  const note = () => {
    $('npcBody').className = s.enabled ? '' : 'off';
    // (what kind of thing a creature is: only where this map's data says so)
    $('npcTypes').style.display = !layer.data || layer.data.typed ? '' : 'none';
    let text = '';
    if (!app.manifest?.npcs) text = 'No NPC data: install the QuestieDB addon, then press Update map.';
    else if (!layer.data) text = app.scene?.map.npcs ? 'Loading…' : 'No NPCs recorded for this map.';
    else {
      const h = layer.heights(), total = layer.data.n, pct = (c) => `${Math.round((c / Math.max(1, total)) * 100)}%`;
      const sure = h[4] + h[3] + h[SEEN];
      text = !total ? `Nobody could be placed on this map (${layer.data.source}).` : `${layer.count.toLocaleString()} shown of ${total.toLocaleString()} (${layer.data.source}). Heights: ${pct(sure)} known${h[SEEN] ? ` (${h[SEEN]} seen by you)` : ''}, ${pct(h[2])} the only place to stand, ${pct(h[1] + h[0])} a best guess.`;
      const lost = layer.data.unplaced.length;
      if (lost) text += ` ${lost}${total ? ' more' : ''} ${lost === 1 ? 'is' : 'are'} known to be on this map, but not where (${layer.data.unplaced.slice(0, 4).join(', ')}${lost > 4 ? ', …' : ''}).`;
    }
    $('npcNote').title = layer.data?.unplaced.length ? `Known to be here, but not where: ${layer.data.unplaced.join(', ')}` : '';
    const me = layer.mine;
    $('npcQuests').textContent = !layer.data ? '' : me ? `Your quests, from the game: ${me.log.size} in your log${me.done ? `, ${me.done.size.toLocaleString()} done` : ' (the ones done are still arriving)'}.` : 'Which quests you have and have done is not known: it comes from the game (live link, addon version 5). Until then quests go by side and level.';
    $('npcNote').textContent = text;
    $('npcCount').textContent = s.enabled && layer.data ? layer.count.toLocaleString() : '';
    const f = $('npcFocus');
    if (layer.focus !== null) {
      const q = layer.quests?.quests?.[layer.focus];
      f.replaceChildren(document.createTextNode(`Showing only: ${q?.n ?? 'quest'} `), el('a', { href: '#', text: 'show everything', onclick: (e) => { e.preventDefault(); layer.setFocus(null); } }));
    } else f.replaceChildren();
    redraw();
  };
  layer.onChange = note;

  // ---- the card ----
  const card = $('npcCard');
  const fill = (box, ...parts) => box.replaceChildren(...parts.filter((p) => p !== null && p !== undefined));
  let showing = -1;
  const close = () => { card.style.display = 'none'; showing = -1; };
  // (the card is in the sidebar, at the top of the NPC section: it opens for it)
  const reveal = () => { card.style.display = 'block'; app.reveal?.(card); };
  const questLine = (q, pick) => el('div', { class: `q${q.live ? ' good' : q.note ? ' dim' : ''}` },
    el('a', { href: '#', text: `${q.level !== null ? `[${q.level}] ` : ''}${q.name}`, title: 'What this quest asks for, and where', onclick: (e) => { e.preventDefault(); pick(q.id); } }),
    q.note ? document.createTextNode(` (${q.note})`) : null);
  const names = (list) => list.map((w) => `${w.name}${w.here ? '' : ' (another map)'}`).join(', ');
  function openQuest(id, back) {
    const q = layer.describeQuest(id);
    if (!q) return;
    const rows = [];
    const row = (label, text) => { if (text) rows.push(el('div', { class: 'r' }, el('span', { class: 'dim', text: `${label} ` }), document.createTextNode(text))); };
    row('From', names(q.starts));
    row('To', names(q.ends));
    row('Kill', names(q.kill));
    row('Use', names(q.use));
    for (const it of q.items) row('Collect', `${it.name}${it.from.length ? ` — from ${names(it.from.slice(0, 8))}${it.from.length > 8 ? ' …' : ''}` : ''}`);
    row('After', q.before.join(', '));
    row('Leads to', q.next ?? '');
    fill(card,
      el('div', { class: 'head' }, el('span', { class: 'title grow', text: `${q.level !== null ? `[${q.level}] ` : ''}${q.name}` }), el('button', { text: '×', title: 'Close', onclick: close })),
      el('div', { class: 'dim', text: `Quest${q.min ? `, from level ${q.min}` : ''}${q.side === 1 ? ', Alliance' : q.side === 2 ? ', Horde' : ''}` }),
      q.text ? el('div', { class: 'r', text: q.text }) : null,
      ...rows,
      el('div', { class: 'btnrow', style: 'margin-top:8px' },
        el('button', { text: layer.focus === id ? 'Show everything again' : 'Show these on the map', title: 'Show only who gives it, who takes it, and what it has you kill or collect', onclick: () => { layer.setFocus(layer.focus === id ? null : id); openQuest(id, back); } }),
        back >= 0 ? el('button', { text: 'Back', onclick: () => open(back) }) : null),
    );
    reveal();
  }
  function open(i) {
    if (!layer.data || i < 0) { close(); return; }
    showing = i;
    const d = layer.describe(i);
    const line = [d.object ? 'Object' : d.level ? `Level ${d.level}` : '', d.rank, d.type, d.reaction].filter(Boolean).join(' · ');
    const list = (title, quests) => (quests.length ? [el('div', { class: 'sub', text: `${title} (${quests.length})` }), ...quests.map((q) => questLine(q, (id) => openQuest(id, i)))] : []);
    fill(card,
      el('div', { class: 'head' }, el('span', { class: 'title grow', text: d.name }), el('button', { text: '×', title: 'Close', onclick: close })),
      d.title ? el('div', { class: 'dim', text: `<${d.title}>` }) : null,
      line ? el('div', { text: line }) : null,
      d.jobs.length ? el('div', { text: d.jobs.join(', ') }) : null,
      ...list('Starts', d.starts), ...list('Ends', d.ends),
      el('div', { class: 'sub', text: 'Where' }),
      el('div', { class: 'r', text: `${d.x.toFixed(0)}, ${d.y.toFixed(0)}${d.z !== null ? `, ${d.z.toFixed(1)} yd up` : ''}${d.places > 1 ? ` · one of ${d.places} places` : ''}` }),
      el('div', { class: d.src === SEEN || d.src >= 3 ? 'r good' : d.src <= 1 ? 'r warn' : 'r dim', text: `Height ${HEIGHT_HOW[d.src]}.` }),
      el('div', { class: 'btnrow', style: 'margin-top:8px' },
        el('button', { text: 'Route here', title: 'Drop the marker here: with "Route to my waypoint" on, the way there is drawn', onclick: () => app.setPin?.([d.x, d.y, d.z ?? app.scene.heightAt(d.x, d.y) ?? 0], d.name, d.z !== null) }),
        el('button', { text: 'Look', title: 'Fly the camera here', onclick: () => app.camera.lookAt([d.x, d.y, d.z ?? app.scene.heightAt(d.x, d.y) ?? 0], 70, app.camera.heading, -40, true) })),
    );
    reveal();
  }

  // ---- what talking to someone taught the map ----
  let noteTimer = 0;
  layer.onNote = (text, info) => {
    const box = $('npcSeen');
    box.textContent = text;
    box.className = info?.corrected ? 'warn' : 'good';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => { box.textContent = ''; }, 20000);
    if (showing === info?.spawn) open(showing);
    note();
  };

  note();
  return {
    /** One line for the marker under the cursor ('' for none). */
    hover(i) {
      if (i < 0 || !layer.data) return '';
      const d = layer.describe(i);
      const bits = [d.title ? `<${d.title}>` : '', d.object ? 'object' : d.level ? `level ${d.level}` : '', d.rank, d.reaction, d.starts.length ? `starts ${d.starts.length}` : '', d.ends.length ? `ends ${d.ends.length}` : ''].filter(Boolean);
      return `${d.name}${bits.length ? ` — ${bits.join(', ')}` : ''}${d.src <= 1 ? ' (height is a guess)' : ''}`;
    },
    open, close, note,
  };
}
