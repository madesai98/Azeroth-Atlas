// The quest explorer: every quest the map's data has, to search and to look into - what it asks
// for, who gives and takes it, the chain it is part of, and about how long it takes.
//
// Where it all comes from (quests.json, built by extractor/jobs/npcs.js):
//   QuestieDB (this game's own)       the quests, who gives and takes them, what each asks for,
//                                     which comes before which, where everyone stands
//   cmangos classic-db (the           how many of each thing a quest asks for, how often each
//   reference database)               creature or chest gives an item (drop rates gathered from
//                                     players of the original game), each creature's health and
//                                     how soon it is back once killed
// A quest or creature new to this game is not in the reference database: its counts are read
// out of the quest's own words where they can be, and a drop rate nobody recorded is counted
// at DROP_GUESS. The card says which numbers are of that kind.
//
// How long a quest takes is an estimate, and says so: the walk from who gives it to what it
// asks for and on to who takes it, the kills (a creature's health over what someone of the
// level deals, and the time between one kill and the next), the kills it takes to get what
// only drops some of the time, and the wait for things to come back where a quest asks for
// more than there are. "Plot the route" works the walking out for real, over the map's own
// ground and flight paths, and draws it.
import { RoutePlanner, RouteRenderer } from './route.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'style') e.style.cssText = v; else if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};

const DROP_GUESS = 0.35;   // a drop rate nobody recorded is counted at this
const BETWEEN = 12;        // seconds from one kill to the next: getting to it, and looting
const REST = 0.35;         // of the time a fight takes, spent recovering from it
const USE = 18;            // seconds to get to a thing and use, open or pick it up
const TALK = 10;           // seconds to take a quest, and to hand one in
const DETOUR = 1.25;       // a walk is this many times the straight line, until it has been worked out
const FAR = 300;           // seconds counted for getting to another map, until it has been worked out
const BACK = 300;          // seconds a creature takes to come back, where that is not recorded
const GROUP_OVER = 8;      // a creature with this many times the health of an ordinary one of its level is not fought alone...
const GROUP_FIGHT = 45;    // ...and the fight is counted at this many seconds, for the group that takes it on...
const BOSS_FIGHT = 240;    // ...or this many, for a boss
const LONG_BACK = 1800;    // a creature longer than this in coming back is not waited for (a dungeon's, a rare one: see `kills`)
const CEILING = 2 * 3600;  // no one thing a quest asks for is counted at more than this (see `capped`)
const LIST = 80;           // quests listed at once
const PLOT_COLOR = '#ff9f43';
const KIND = { 1: 'Elite', 41: 'PvP', 62: 'Raid', 81: 'Dungeon', 82: 'World event', 83: 'Legendary', 84: 'Escort' };
const RANK_HP = [1, 2.8, 3.2, 6, 1.5]; // how much tougher than an ordinary creature of its level: ordinary, elite, rare elite, boss, rare

const clock = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.max(1, Math.round(s))} s`);
/** What someone of a level deals in a second, questing alone (a round figure: gear, class and talents all move it). */
const dps = (level) => 2 + 1.55 * level + 0.011 * level * level;
/** An ordinary creature's health at a level (for the ones the reference database does not have). */
const health = (level) => 20 + 9 * level + 0.72 * level * level;

export function bindQuests(app) {
  const layer = app.npcs;
  const box = $('questBody');
  let Q = null;          // quests.json
  let index = null;      // the quests as a list, and who follows whom
  let open = null;       // the quest whose card is showing
  let plot = null;       // the route plotted for a quest: { id, map, note, legs: [{ leg, from, target, planner, renderer }] }
  let shownFor = '', shownMine = null; // what the list was last made for
  const state = { text: '', side: 'mine', min: '', max: '', zone: '', mine: false, chains: false, sort: 'level' };

  const search = el('input', { type: 'text', placeholder: 'Search quests by name (or a number)', autocomplete: 'off', spellcheck: 'false' });
  const side = el('select', { title: 'Whose quests' }, el('option', { value: 'mine', text: 'My side' }), el('option', { value: 'all', text: 'Both sides' }));
  const zone = el('select', { title: 'Where the quest belongs' }, el('option', { value: '', text: 'Anywhere' }));
  const min = el('input', { type: 'number', min: '1', max: '63', placeholder: 'any', title: 'Quests of this level and up' });
  const max = el('input', { type: 'number', min: '1', max: '63', placeholder: 'any', title: 'Quests up to this level' });
  const mine = el('input', { type: 'checkbox' }), chains = el('input', { type: 'checkbox' });
  const sort = el('select', { title: 'In what order' }, el('option', { value: 'level', text: 'By level' }), el('option', { value: 'time', text: 'Quickest first' }), el('option', { value: 'long', text: 'Longest first' }), el('option', { value: 'name', text: 'By name' }));
  const list = el('div', { id: 'questList' }), card = el('div', { id: 'questCard' }), note = el('div', { class: 'dim small' });
  box.append(
    search,
    el('div', { class: 'row' }, side, zone),
    el('div', { class: 'row' }, el('span', { class: 'grow', text: 'Levels' }), min, document.createTextNode('–'), max, sort),
    el('div', { class: 'opts' },
      el('label', { title: 'Only the quests you could take now: your side, your level, what they need done first (with the live link: not the ones you have or have done)' }, mine, document.createTextNode('Open to me now')),
      el('label', { title: 'List whole chains - quests that follow one from another - with how long each chain takes from its first quest to its last' }, chains, document.createTextNode('Chains'))),
    card, list, note);
  const style = document.createElement('style');
  style.textContent = `
    #questBody .opts { display: flex; gap: 16px; flex-wrap: wrap; }
    #questBody .opts label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
    #questList { display: flex; flex-direction: column; max-height: 46vh; overflow-y: auto; scrollbar-width: thin; }
    #questList .q { display: flex; gap: 6px; padding: 3px 5px; border-radius: 5px; cursor: pointer; align-items: baseline; }
    #questList .q:hover, #questList .q.sel { background: rgba(255,255,255,.1); }
    #questList .q .lv { color: var(--dim); width: 26px; flex: none; text-align: right; font-variant-numeric: tabular-nums; }
    #questList .q .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #questList .q .tm { color: var(--dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
    #questList .q.done .nm { color: var(--dim); text-decoration: line-through; }
    #questList .q.have .nm { color: var(--good); }
    #questCard { display: none; padding: 8px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg2); }
    #questCard .head { display: flex; align-items: flex-start; gap: 8px; }
    #questCard .head .grow { flex: 1; font-size: 14px; color: var(--accent); font-weight: 600; }
    #questCard .head button { width: auto; padding: 0 7px; }
    #questCard .sub { margin-top: 8px; font-weight: 600; }
    #questCard .r { margin-top: 2px; }
    #questCard .part { display: flex; gap: 8px; margin-top: 2px; }
    #questCard .part .grow { flex: 1; }
    #questCard .part .t { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dim); }
    #questCard .chain .q { cursor: pointer; display: flex; gap: 6px; padding: 1px 0; }
    #questCard .chain .q.cur { color: var(--accent); }
    #questCard .chain .q .t { margin-left: auto; color: var(--dim); white-space: nowrap; font-variant-numeric: tabular-nums; }
    #questCard a { text-decoration: none; cursor: pointer; }
    #questCard a:hover { text-decoration: underline; }
    #questCard .big { font-size: 15px; font-weight: 600; }
    .badge { display: inline-block; padding: 0 6px; border-radius: 9px; background: rgba(255,255,255,.12); font-size: 11px; margin-left: 5px; }
  `;
  document.head.append(style);

  // ---- the data ------------------------------------------------------------------------------
  const me = () => ({ level: app.danger?.settings.level ?? 10, faction: app.danger?.settings.faction ?? 'alliance', run: app.player?.speeds?.run || 7, live: !!app.player?.live });
  const sideOf = (q) => (q.side === 1 ? 'Alliance' : q.side === 2 ? 'Horde' : '');
  const zoneName = (q) => (q.z > 0 ? app.world?.areas?.[q.z]?.n ?? '' : '');
  function build() {
    const quests = [], after = new Map();
    for (const [key, q] of Object.entries(Q.quests)) {
      const id = +key;
      quests.push({ id, q, name: q.n, lower: q.n.toLowerCase(), level: q.l > 0 ? q.l : q.m > 0 ? q.m : 0, zone: zoneName(q) });
      for (const p of [...(q.pre ?? []), ...(q.pa ?? [])]) { if (!after.has(p)) after.set(p, []); after.get(p).push(id); }
    }
    // (what a quest leads to: the one its data names as next, else whatever needs it done first)
    for (const { id, q } of quests) if (q.nx && Q.quests[q.nx] && !(after.get(id) ?? []).includes(q.nx)) { if (!after.has(id)) after.set(id, []); after.get(id).push(q.nx); }
    const zones = [...new Set(quests.map((e) => e.zone).filter(Boolean))].sort();
    for (const z of zones) zone.append(el('option', { value: z, text: z }));
    index = { quests, after, byId: new Map(quests.map((e) => [e.id, e])), memo: new Map(), chainOf: new Map() };
  }

  /** The quests of the chain a quest is part of, first to last: back through what each needs done first, on through what each leads to. */
  function chain(id) {
    let out = index.chainOf.get(id);
    if (out) return out;
    const seen = new Set([id]);
    const before = [];
    for (let at = id; ;) {
      const q = Q.quests[at];
      const prev = [...(q?.pre ?? []), ...(q?.pa ?? [])].find((p) => Q.quests[p] && !seen.has(p));
      if (prev === undefined || before.length > 60) break;
      before.unshift(prev); seen.add(prev); at = prev;
    }
    const later = [];
    for (let at = id; ;) {
      const q = Q.quests[at], next = index.after.get(at) ?? [];
      // (on along the one the data names as next; else the only one that follows; a fork ends the chain here)
      const to = q?.nx && Q.quests[q.nx] && !seen.has(q.nx) ? q.nx : next.filter((n) => !seen.has(n)).length === 1 ? next.find((n) => !seen.has(n)) : undefined;
      if (to === undefined || later.length > 60) break;
      later.push(to); seen.add(to); at = to;
    }
    out = [...before, id, ...later];
    for (const q of out) if (!index.chainOf.has(q) || index.chainOf.get(q).length < out.length) index.chainOf.set(q, out);
    return out;
  }

  // ---- where things are --------------------------------------------------------------------
  /** Where someone or something is: { map, x, y, z (null: not known), name } - the place of theirs nearest \`near\` on the map in hand, else the first the data has. */
  let placed = null; // the places of everyone on the map in hand, by who they are: { d, n, of: Map<entry, [spawn points]> }
  function where(kind, id, near = null) {
    const d = layer.data, table = kind === 'o' ? Q.objects : Q.npcs, rec = table?.[id];
    const e = d?.index.get((kind === 'o' ? 'o' : 'n') + id);
    if (e !== undefined) {
      if (placed?.d !== d || placed.n !== d.n) {
        placed = { d, n: d.n, of: new Map() };
        for (let i = 0; i < d.n; i++) { const list = placed.of.get(d.owner[i]); if (list) list.push(i); else placed.of.set(d.owner[i], [i]); }
      }
      let best = -1, bestD = Infinity;
      for (const i of placed.of.get(e) ?? []) {
        const dist = near && near.map === d.map ? Math.hypot(d.x[i] - near.x, d.y[i] - near.y) : best < 0 ? 0 : 1;
        if (dist < bestD) { bestD = dist; best = i; }
      }
      if (best >= 0) return { map: d.map, x: d.x[best], y: d.y[best], z: Number.isFinite(d.z[best]) ? d.z[best] : null, name: d.entries[e].n, exact: true };
    }
    if (!rec || rec.length < 4) return rec ? { name: rec[0] } : null;
    return { map: rec[1], x: rec[2], y: rec[3], z: null, name: rec[0] };
  }
  const nameOf = (kind, id) => (kind === 'o' ? Q.objects?.[id]?.[0] : kind === 'i' ? Q.items?.[id]?.n : Q.npcs?.[id]?.[0]) ?? `${kind === 'o' ? 'Object' : kind === 'i' ? 'Item' : 'Creature'} ${id}`;

  // ---- how long -------------------------------------------------------------------------------
  /** What a quest asks for: [{ kind ('n' kill, 'o' use, 'i' collect), id, count, sure (the count is the data's, not read out of its words) }] */
  function needs(q) {
    if (q.nd) return q.nd.map(([kind, id, count]) => ({ kind, id, count, sure: true }));
    const out = [], words = q.t ?? '';
    const numbers = [...words.matchAll(/\b(\d+)\b/g)].map((m) => +m[1]);
    const things = [...(q.oc ?? []).map((id) => ['n', id]), ...(q.ok ?? []).map((id) => ['n', id]), ...(q.oo ?? []).map((id) => ['o', id]), ...(q.oi ?? []).map((id) => ['i', id])];
    for (const [kind, id] of things) {
      const name = nameOf(kind, id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`(\\d+)\\s+(?:of\\s+)?(?:the\\s+)?${name}`, 'i').exec(words);
      // (said in its words; else the one number they hold, where it asks for one thing; else one - and the card says so)
      const count = m ? +m[1] : things.length === 1 && numbers.length === 1 ? numbers[0] : 1;
      out.push({ kind, id, count: Math.min(count, 200), sure: !!m });
    }
    return out;
  }

  /** How long one kill of a creature takes someone of a level, and from one kill to the next: { fight, cycle, level, guess (its health is not recorded) } */
  function kill(id, level) {
    const m = Q.mobs?.[id] ?? {};
    const lv = m.lv ? (m.lv[0] + m.lv[1]) / 2 : level;
    const hp = m.hp ?? health(lv) * (RANK_HP[m.rk ?? 0] ?? 1);
    // (a creature below you goes down faster, one above you slower)
    const edge = Math.max(0.5, Math.min(2.5, 1 + 0.08 * (level - lv)));
    // (a boss, or anything with many times the health of its level: a fight for a group, counted at a round figure)
    const group = m.rk === 3 || hp > GROUP_OVER * health(lv);
    const fight = group ? (m.rk === 3 ? BOSS_FIGHT : GROUP_FIGHT) : hp / (dps(level) * edge);
    return { fight, cycle: fight * (1 + REST) + BETWEEN, level: lv, guess: !m.hp, group, rank: m.rk ?? 0, places: m.sp ?? 0, back: m.rs ?? BACK, backKnown: !!m.rs };
  }
  /** Killing \`count\` of a creature: the kills themselves, or the wait for it to come back where there are fewer of it than that. */
  function kills(id, count, level) {
    const k = kill(id, level);
    const fought = count * k.cycle;
    // (Fewer of them on record than are asked for: the rest are waited for - unless they are
    // hours in coming back. Those are a dungeon's, whose creatures the database places at its
    // door and which are all there at once, or a rare one's: counted as if there were enough.)
    const few = k.places > 0 && count > k.places;
    const waited = few && k.back <= LONG_BACK ? ((count - k.places) * k.back) / k.places : 0;
    return { ...k, count, seconds: Math.max(fought, waited), waits: waited > fought, scarce: few && k.back > LONG_BACK };
  }

  /**
   * One thing a quest asks for, held to the ceiling. Hours of killing for one drop, or weeks of
   * waiting for a boss to come back, are what the arithmetic says of things that are in truth
   * bought, made, traded for or won with a group over many visits: no figure for those would be
   * an honest one, so it is counted at the ceiling and the card says so.
   */
  function capped(part, rough) {
    if (part.seconds <= CEILING) return part;
    rough.push(`"${part.label}" comes to far more than ${clock(CEILING)} by this reckoning (it is more likely bought, made, or won over several visits with a group): counted at ${clock(CEILING)}`);
    return { ...part, seconds: CEILING, detail: `${part.detail}${part.detail ? '; ' : ''}by that reckoning ${clock(part.seconds)}: counted at ${clock(CEILING)}` };
  }

  /**
   * About how long a quest takes: { seconds, travel, parts: [{ label, detail, seconds }], level,
   * rough: [what makes it rougher than usual], stops: [the places it goes by, in order] }
   * @param walked  { [leg]: seconds } the legs of the way that have been worked out for real (a
   *                plotted route), in place of the straight-line figure (leg i: from stop i - 1 to stop i)
   */
  function estimate(id, walked = null) {
    const key = `${id}|${me().level}|${layer.data?.map ?? ''}`;
    if (walked === null && index.memo.has(key)) return index.memo.get(key);
    const q = Q.quests[id], who = me();
    // (for someone of your level, if the quest is one for your level; else for someone of the quest's own)
    const base = q.l > 0 ? q.l : Math.max(1, q.m);
    const level = who.level >= q.m && who.level <= base + 6 ? who.level : base;
    const parts = [], rough = [];
    const from = (q.s ?? []).map((n) => where('n', n)).find((p) => p?.map !== undefined) ?? (q.so ?? []).map((n) => where('o', n)).find((p) => p?.map !== undefined) ?? null;
    const spots = [];
    for (const need of needs(q)) {
      if (!need.sure && Q.mobs) rough.push(`how many ${nameOf(need.kind, need.id)} it asks for is not recorded`);
      if (need.kind === 'n') {
        const k = kills(need.id, need.count, level);
        if (k.guess && Q.mobs) rough.push(`${nameOf('n', need.id)} is new to this game: its health is taken from its level`);
        parts.push(capped({ label: `Kill ${need.count} ${nameOf('n', need.id)}`, seconds: k.seconds, detail: `level ${Math.round(k.level)}${['', ' elite', ' rare elite', ' boss', ' rare'][k.rank]}: ${k.group ? `a fight for a group, counted at ${clock(k.fight)}` : `${Math.round(k.fight)} s a fight`}, ${Math.round(k.cycle)} s from one to the next${k.waits ? `; only ${k.places} of them, back after ${clock(k.back)}${k.backKnown ? '' : ' (not recorded: a usual figure)'}: the wait is longer than the fighting` : ''}` }, rough));
        if (k.group) rough.push(`${nameOf('n', need.id)} takes a group: the fight is counted at ${clock(k.fight)}, and finding the group is not counted`);
        if (k.scarce) rough.push(`only ${k.places} ${nameOf('n', need.id)} on record, ${clock(k.back)} in coming back (a dungeon's, or a rare one): counted as if there were enough`);
        else if (k.rank === 1 || k.rank === 2) rough.push(`${nameOf('n', need.id)} is ${['', 'an elite', 'a rare elite'][k.rank]}: counted as fought alone`);
        const p = where('n', need.id, from);
        if (p?.map !== undefined) spots.push(p);
      } else if (need.kind === 'o') {
        parts.push({ label: `${need.count > 1 ? `${need.count} × ` : ''}${nameOf('o', need.id)}`, seconds: need.count * USE, detail: `${USE} s each to get to and use` });
        const p = where('o', need.id, from);
        if (p?.map !== undefined) spots.push(p);
      } else {
        const it = Q.items?.[need.id] ?? {};
        // from whom or what it is quickest to get: a creature that drops it, a thing that holds it, a vendor
        let best = null;
        for (const n of it.d ?? []) {
          const c = it.dc?.[n], rate = c ? (c[0] / 100) * c[1] : DROP_GUESS;
          if (!(rate > 0)) continue;
          const k = kills(n, Math.ceil(need.count / rate), level);
          const option = { seconds: k.seconds, at: ['n', n], detail: `from ${nameOf('n', n)}: ${c ? `drops ${c[0]}% of the time${c[1] > 1 ? `, ${c[1]} at a time` : ''}` : `drop rate not recorded, counted at ${DROP_GUESS * 100}%`}, so about ${k.count.toLocaleString()} kill${k.count === 1 ? '' : 's'} at ${k.group ? `${clock(k.cycle)} each (a fight for a group)` : `${Math.round(k.cycle)} s each`}${k.waits ? ` (only ${k.places} of them, back after ${clock(k.back)}: the wait for them to come back is longer)` : ''}`, guess: !c, group: k.group };
          if (!best || option.seconds < best.seconds) best = option;
        }
        for (const o of it.o ?? []) {
          const c = it.oc?.[o], rate = c ? (c[0] / 100) * c[1] : 1;
          const opens = Math.ceil(need.count / Math.max(rate, 0.01));
          const option = { seconds: opens * USE, at: ['o', o], detail: `from ${nameOf('o', o)}${c && c[0] < 100 ? `: holds it ${c[0]}% of the time, so about ${opens} of them` : `: ${opens} of them`}, ${USE} s each` };
          if (!best || option.seconds < best.seconds) best = option;
        }
        if (!best && it.v?.length) best = { seconds: 20, at: ['n', it.v[0]], detail: `sold by ${nameOf('n', it.v[0])}` };
        const got = !!best;
        if (!best) best = { seconds: 0, at: null, detail: 'given to you with the quest, made, or come by some other way: no time counted' };
        if (best.guess && Q.mobs) rough.push(`how often ${it.n ?? 'an item'} drops is not recorded`);
        if (best.group) rough.push(`${it.n ?? 'an item'} comes from a fight that takes a group: finding the group is not counted`);
        parts.push(capped({ label: `${got ? 'Collect' : 'Bring'} ${need.count} ${it.n ?? nameOf('i', need.id)}`, seconds: best.seconds, detail: best.detail }, rough));
        const p = best.at ? where(best.at[0], best.at[1], from) : null;
        if (p?.map !== undefined) spots.push(p);
      }
    }
    if (q.tr) { parts.push({ label: q.tr.t || 'Go to the place it names', seconds: TALK, detail: '' }); const s = q.tr.at?.[0]; if (s) spots.push({ map: s[0], x: s[1], y: s[2], z: null, name: q.tr.t || 'the place' }); }
    // (nothing it asks for is placed anywhere: where the game's own map puts it, if a player's addon has noted that)
    if (!spots.length && q.gp?.o?.[0]) { const s = q.gp.o[0]; spots.push({ map: s[0], x: s[1], y: s[2], z: null, name: 'where the game\'s map puts it' }); }
    if (q.ty && KIND[q.ty] && q.ty !== 84) rough.push(`a ${KIND[q.ty].toLowerCase()} quest: the time is what the fighting would take one player, and takes no account of finding a group or getting through the place`);
    const to = (q.e ?? []).map((n) => where('n', n, spots[spots.length - 1] ?? from)).find((p) => p?.map !== undefined) ?? (q.eo ?? []).map((n) => where('o', n)).find((p) => p?.map !== undefined) ?? null;
    // the way round: from who gives it, to each thing it asks for (the nearest next), to who takes it
    const stops = [];
    if (from) stops.push({ ...from, what: 'start' });
    const left = [...spots];
    for (let at = from; left.length;) {
      let k = 0;
      if (at) left.forEach((p, i) => { if (p.map === at.map && (left[k].map !== at.map || Math.hypot(p.x - at.x, p.y - at.y) < Math.hypot(left[k].x - at.x, left[k].y - at.y))) k = i; });
      at = left.splice(k, 1)[0];
      if (!stops.some((s) => s.map === at.map && Math.hypot(s.x - at.x, s.y - at.y) < 40)) stops.push({ ...at, what: 'objective' });
    }
    if (to) stops.push({ ...to, what: 'end' });
    let travel = 0, apart = false, exact = 0;
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1], b = stops[i];
      if (walked?.[i] !== undefined) { travel += walked[i]; exact++; }
      else if (a.map !== b.map) { travel += FAR; apart = true; }
      else travel += (Math.hypot(a.x - b.x, a.y - b.y) * DETOUR) / who.run;
    }
    if (apart) rough.push('part of it is on another map: getting there is counted at five minutes until that part of the route is plotted');
    // (map data from before the quest explorer: nothing in it but who and where)
    if (!Q.mobs) rough.unshift('this map\u2019s data was built before the quest explorer, and has no counts, drop rates, health or respawn times in it: everything here is by rule of thumb until you press Update map');
    const work = parts.reduce((s, p) => s + p.seconds, 0);
    // (walked: 0 none of the way has been worked out, 1 some of it, 2 all of it)
    const out = { id, seconds: travel + work + 2 * TALK, travel, walked: !exact ? 0 : exact < stops.length - 1 ? 1 : 2, parts, level, rough: [...new Set(rough)], stops, from, to };
    if (walked === null) index.memo.set(key, out);
    return out;
  }

  /** A chain's time: its quests one after the other, and the way from where one is handed in to where the next is taken. */
  function chainTime(ids) {
    let seconds = 0, last = null;
    const who = me();
    for (const id of ids) {
      const e = estimate(id);
      if (last && e.from && last.map === e.from.map) seconds += (Math.hypot(last.x - e.from.x, last.y - e.from.y) * DETOUR) / who.run;
      else if (last && e.from) seconds += FAR;
      seconds += e.seconds;
      last = e.to ?? last;
    }
    return seconds;
  }

  // ---- the list ------------------------------------------------------------------------------
  function matches() {
    const who = me(), text = state.text.trim().toLowerCase(), mineBit = who.faction === 'horde' ? 2 : 1;
    const lo = +state.min || 0, hi = +state.max || 99;
    let found = index.quests.filter((e) => {
      if (text && !(e.lower.includes(text) || String(e.id) === text)) return false;
      if (state.side === 'mine' && !(e.q.side & mineBit)) return false;
      if (e.level && (e.level < lo || e.level > hi)) return false;
      if (!e.level && (lo > 0 || hi < 99)) return false;
      if (state.zone && e.zone !== state.zone) return false;
      if (state.mine && layer.closed(e.id) !== '') return false;
      return true;
    });
    if (state.chains) {
      // one line for each chain a found quest is part of (three quests or more), under its first quest
      const seen = new Set(), out = [];
      for (const e of found) {
        const c = chain(e.id);
        if (c.length < 3 || seen.has(c[0])) continue;
        seen.add(c[0]);
        out.push({ ...index.byId.get(c[0]), chain: c, time: chainTime(c) });
      }
      found = out;
    }
    const time = (e) => e.time ?? (e.time = estimate(e.id).seconds);
    if (state.sort === 'time' || state.sort === 'long') { for (const e of found) time(e); found.sort((a, b) => (state.sort === 'time' ? 1 : -1) * ((a.time ?? 1e9) - (b.time ?? 1e9))); }
    else if (state.sort === 'name') found.sort((a, b) => a.name.localeCompare(b.name));
    else found.sort((a, b) => (a.level || 99) - (b.level || 99) || a.name.localeCompare(b.name));
    return found;
  }
  function showList() {
    if (!index) return;
    const found = matches();
    list.replaceChildren();
    for (const e of found.slice(0, LIST)) {
      const why = layer.mine ? layer.closed(e.id) : '';
      const row = el('div', { class: `q${open === e.id ? ' sel' : ''}${why === 'done' ? ' done' : why === 'in your log' || why === 'ready to hand in' ? ' have' : ''}`, title: `${e.name}${e.zone ? ` · ${e.zone}` : ''}${why ? ` · ${why}` : ''}`, onclick: () => show(e.id) },
        el('span', { class: 'lv', text: e.level ? String(e.level) : '' }),
        el('span', { class: 'nm', text: e.chain ? `${e.name} … (${e.chain.length} quests)` : e.name }),
        el('span', { class: 'tm', text: clock(e.time ?? estimate(e.id).seconds) }));
      list.append(row);
    }
    const what = state.chains ? (found.length === 1 ? 'chain' : 'chains') : found.length === 1 ? 'quest' : 'quests';
    note.textContent = found.length > LIST ? `${found.length.toLocaleString()} ${what} found: the first ${LIST} are listed. Narrow it down to see the rest.`
      : !found.length ? `No ${what} found.${state.chains ? ' (A chain is three quests or more that follow one from another.)' : ''}`
      : `${found.length.toLocaleString()} ${what} found. Times are estimates for one player: open a quest to see what its time is made of.`;
    if (!Q.mobs) note.textContent += ' Press Update map (under Map & search) once: the times are rough until the map\u2019s data has the counts, drop rates and creature health in it.';
    $('questCount').textContent = index.quests.length.toLocaleString();
  }

  // ---- the card ------------------------------------------------------------------------------
  const link = (text, title, onclick) => el('a', { title, text, onclick: (e) => { e.preventDefault(); onclick(); } });
  const look = (p) => { if (!p || p.map === undefined) return; const go = () => { const z = p.z ?? app.scene.heightAt(p.x, p.y) ?? 0; app.camera.lookAt([p.x, p.y, z], 160, app.camera.heading, -45, true); }; app.letGo?.(); if (app.scene.map.id !== p.map) app.openMap(p.map).then(go); else go(); };
  function show(id) {
    const q = Q.quests[id];
    if (!q) return;
    open = id;
    // (the legs of a plotted route that have been worked out: what each takes, in place of the straight line)
    let walked = null;
    if (plot?.id === id) for (const l of plot.legs) { const left = l.planner.route ? l.planner.remaining() : null; if (left) (walked ??= {})[l.leg] = left.seconds; }
    const e = estimate(id, walked), who = me();
    const why = layer.closed(id);
    const place = (label, p, missing) => (p ? el('div', { class: 'r' }, el('span', { class: 'dim', text: `${label} ` }), link(p.name, 'Look at this place on the map', () => look(p)), p.map !== app.scene?.map.id ? el('span', { class: 'dim', text: ` (${app.manifest.maps.find((m) => m.id === p.map)?.name ?? 'another map'})` }) : null)
      : missing ? el('div', { class: 'r dim', text: `${label} ${missing}` }) : null);
    const c = chain(id);
    const chainRows = c.length > 1 ? [
      el('div', { class: 'sub', text: `Chain: ${c.length} quests, about ${clock(chainTime(c))} in all` }),
      el('div', { class: 'chain' }, ...c.map((qid, i) => el('div', { class: `q${qid === id ? ' cur' : ''}`, onclick: () => show(qid) }, el('span', { text: `${i + 1}. ${Q.quests[qid].l > 0 ? `[${Q.quests[qid].l}] ` : ''}${Q.quests[qid].n}` }), el('span', { class: 't', text: clock(estimate(qid).seconds) })))),
    ] : [];
    const others = (index.after.get(id) ?? []).filter((n) => !c.includes(n));
    const needsFirst = [...(q.pre ?? []), ...(q.pa ?? [])].filter((n) => Q.quests[n] && !c.includes(n));
    card.replaceChildren(...[
      el('div', { class: 'head' }, el('span', { class: 'grow', text: `${q.l > 0 ? `[${q.l}] ` : ''}${q.n}` }), el('button', { text: '×', title: 'Close', onclick: () => { open = null; card.style.display = 'none'; showList(); } })),
      el('div', { class: 'dim' }, document.createTextNode([`Quest ${id}`, q.m ? `from level ${q.m}` : '', sideOf(q), zoneName(q)].filter(Boolean).join(' · ')), q.ty && KIND[q.ty] ? el('span', { class: 'badge', text: KIND[q.ty] }) : null, q.rep ? el('span', { class: 'badge', text: 'Repeatable' }) : null),
      why ? el('div', { class: why === 'in your log' || why === 'ready to hand in' ? 'good' : 'warn', text: `For you now: ${why}.` }) : who.live ? el('div', { class: 'good', text: 'Open to you now.' }) : null,
      q.t ? el('div', { class: 'r', text: q.t }) : null,
      el('div', { class: 'sub' }, document.createTextNode('About '), el('span', { class: 'big', text: clock(e.seconds) }), el('span', { class: 'dim', text: ` for one player of level ${e.level}` })),
      el('div', { class: 'part' }, el('span', { class: 'grow', text: `Getting about (${['by the straight line', 'part of it worked out over the map', 'worked out over the map'][e.walked]})` }), el('span', { class: 't', text: clock(e.travel) })),
      ...e.parts.map((p) => el('div', { class: 'part', title: p.detail }, el('span', { class: 'grow' }, document.createTextNode(p.label), p.detail ? el('div', { class: 'dim small', text: p.detail }) : null), el('span', { class: 't', text: p.seconds ? clock(p.seconds) : '–' }))),
      el('div', { class: 'part' }, el('span', { class: 'grow', text: 'Taking it and handing it in' }), el('span', { class: 't', text: clock(2 * TALK) })),
      e.rough.length ? el('div', { class: 'warn small', style: 'margin-top:4px', text: `Rougher than usual: ${e.rough.join('; ')}.` }) : null,
      el('div', { class: 'sub', text: 'Where' }),
      place('From', e.from, q.si?.length ? `an item: ${Q.items?.[q.si[0]]?.n ?? 'one you find'}` : 'somewhere the data does not record'),
      ...e.stops.filter((s) => s.what === 'objective').map((s) => place('Then', s)),
      place('To', e.to, 'somewhere the data does not record'),
      ...chainRows,
      needsFirst.length ? el('div', { class: 'r' }, el('span', { class: 'dim', text: 'Also needs: ' }), ...needsFirst.flatMap((n, i) => [i ? document.createTextNode(', ') : null, link(Q.quests[n].n, 'Open this quest', () => show(n))])) : null,
      others.length ? el('div', { class: 'r' }, el('span', { class: 'dim', text: 'Also opens: ' }), ...others.slice(0, 12).flatMap((n, i) => [i ? document.createTextNode(', ') : null, link(Q.quests[n]?.n ?? `Quest ${n}`, 'Open this quest', () => show(n))])) : null,
      el('div', { class: 'btnrow', style: 'margin-top:8px' },
        el('button', { text: plot?.id === id ? 'Clear the route' : 'Plot the route', title: 'Work out the way from who gives it, by what it asks for, to who takes it - over the ground and the flight paths you know - and draw it', onclick: () => { if (plot?.id === id) unplot(); else plan(id); show(id); } }),
        el('button', { text: layer.focus === id ? 'Show everything' : 'Show on the map', title: 'Show only who gives it, who takes it, and what it has you kill or collect', onclick: () => { const on = layer.focus !== id; if (on && !layer.settings.enabled) $('optNpcs').click(); layer.setFocus(on ? id : null); show(id); } })),
      el('div', { class: 'btnrow', style: 'margin-top:4px' },
        el('button', { text: 'Route me to the start', title: e.from ? 'Drop the marker on who gives it: the waypoint route goes there' : 'Where it starts is not recorded', ...(e.from ? {} : { disabled: '' }), onclick: () => { const p = e.from; if (p?.map === app.scene.map.id) app.setPin?.([p.x, p.y, p.z ?? app.scene.heightAt(p.x, p.y) ?? 0], p.name, p.z !== null); else look(p); } }),
        id < 20000 ? el('a', { href: `https://www.wowhead.com/classic/quest=${id}`, target: '_blank', rel: 'noopener noreferrer', style: 'align-self:center;padding:0 6px;white-space:nowrap', text: 'Wowhead ↗', title: 'This quest on Wowhead (opens in a new tab). Only the quests of the original game are there.' }) : null),
      plot?.id === id ? el('div', { class: 'dim small', style: 'margin-top:4px', text: plot.note }) : null,
      el('div', { class: 'dim small', style: 'margin-top:5px', text: `Quests and places: ${Q.source ?? 'QuestieDB'}. Counts, drop rates, health and respawn times: ${Q.reference ? `${Q.reference.replace(/\.sql\.gz$/i, '')} (cmangos classic-db, the original game)` : 'not in this map’s data yet - press Update map'}.` }),
    ].flat().filter((row) => row !== null && row !== undefined && row !== false));
    card.style.display = 'block';
    showList();
    app.reveal?.(card);
  }

  // ---- the route of a quest, plotted -------------------------------------------------------------
  function unplot() { plot = null; app.dirty = true; }
  /** Work out, leg by leg, the way a quest takes you: from who gives it, by what it asks for, to who takes it. */
  function plan(id) {
    const e = estimate(id), here = app.scene.map.id;
    const legs = [];
    let skipped = 0;
    for (let i = 1; i < e.stops.length; i++) {
      const a = e.stops[i - 1], b = e.stops[i];
      if (a.map !== here) { skipped++; continue; } // (a leg is worked out from the map in hand)
      const planner = new RoutePlanner(app, app.route);
      planner.fixed = true; // (from a place, not from you: nothing is carrying it, and no hearthstone)
      planner.setMap(app.scene.map);
      planner.onChange = () => { app.dirty = true; if (open === id) clearTimeout(plan.timer), (plan.timer = setTimeout(() => { if (open === id && plot?.id === id) show(id); }, 400)); };
      const renderer = new RouteRenderer(app.gpu);
      renderer.setColor(PLOT_COLOR);
      legs.push({ leg: i, from: [a.x, a.y, a.z ?? null], target: { map: b.map, x: b.x, y: b.y, z: b.z ?? undefined, source: 'quest' }, planner, renderer });
    }
    plot = { id, legs, map: here, note: legs.length ? `The route is drawn in orange${skipped ? ` (${skipped} part${skipped === 1 ? '' : 's'} of it begin${skipped === 1 ? 's' : ''} on another map: open that map and plot again for those)` : ''}. Its time takes the place of the straight-line figure once it is worked out.` : 'Nothing of this quest begins on the map in hand: open the map it is on and plot again.' };
    app.dirty = true;
  }

  // ---- wiring ------------------------------------------------------------------------------------
  const refresh = () => { state.text = search.value; state.side = side.value; state.zone = zone.value; state.min = min.value; state.max = max.value; state.mine = mine.checked; state.chains = chains.checked; state.sort = sort.value; showList(); };
  for (const input of [search, min, max]) input.addEventListener('input', refresh);
  for (const input of [side, zone, mine, chains, sort]) input.addEventListener('change', refresh);
  note.textContent = 'The quests are read when a map with NPC data is opened…';

  return {
    /** The quest data has arrived (or the map, your level or your quests have changed): the list is made again. */
    update() {
      if (layer.quests && layer.quests !== Q) { Q = layer.quests; build(); }
      if (!index) return;
      // (the markers change far more often than anything shown here does)
      const who = me(), now = `${layer.data?.map ?? ''}|${who.level}|${who.faction}|${Math.round(who.run * 10)}`;
      if (now === shownFor && layer.mine === shownMine) return;
      shownFor = now; shownMine = layer.mine;
      index.memo.clear();
      for (const e of index.quests) e.time = undefined;
      showList();
      if (open !== null && card.style.display !== 'none') show(open);
    },
    /** Called every frame: the legs of a plotted route are kept worked out. */
    frame(speeds) {
      if (!plot) return;
      if (plot.map !== app.scene?.map.id) { unplot(); return; }
      for (const l of plot.legs) { l.planner.enabled = true; l.planner.update(l.from, l.target, speeds); }
    },
    draw(pass, camera, offsetOf, key) { if (plot) for (const l of plot.legs) l.renderer.draw(pass, l.planner, camera, offsetOf, key); },
    drawRest(pass) { if (plot) for (const l of plot.legs) l.renderer.drawRest(pass); },
    cover(pass) { if (plot) for (const l of plot.legs) l.renderer.cover(pass); },
    show, estimate: (id) => (index ? estimate(id) : null), chain: (id) => (index ? chain(id) : null),
    get plot() { return plot; },
  };
}
