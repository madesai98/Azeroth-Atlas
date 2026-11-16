// The page's own notes of what happened: a line for every change worth knowing about when the
// map has done something it should not have and nobody can say what led to it - where each
// route was heading and which way it was taken to be, what the game was handed, what could not
// be loaded, every warning and every error. "Report a problem" (report.js) packs them.
//
// The last few thousand are kept in hand, and all of them are sent on to the map's server as
// they come, which writes them down beside its own (server/log.js: page.log). So they outlast
// the page loading itself again after an update, and a page that has stopped working.
//
// A script of its own, loaded before the map: what goes wrong while the map itself is loading
// is noted too.
//
//   note('route', 'quest: walk, then fly to Southshore', { seconds: 412 })
//   if (changed('link', status)) note('link', status)     (said once, however often it is so)
const KEPT = 4000;        // lines kept in hand
const SEND_EVERY = 4000;  // ms between sendings
const WAITING = 1500;     // lines that may wait to be sent (the server is away): past that the oldest go unsent
const lines = [];
let unsent = [];
const before = new Map();

/** Anything, as something that can be written down and read: long lists and rows of numbers are counted, not listed. */
export function lean(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : String(v);
  if (typeof v === 'string') return v.length > 1200 ? `${v.slice(0, 1200)}…` : v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'function' || typeof v === 'symbol') return undefined;
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Error) return { error: v.message, stack: String(v.stack ?? '').split('\n').slice(0, 8).join(' | ') };
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return `(${v.length ?? v.byteLength} numbers)`;
  if (depth > 6) return '(deeper)';
  if (v instanceof Map) return lean(Object.fromEntries([...v].slice(0, 80)), depth + 1);
  if (v instanceof Set) return lean([...v].slice(0, 200), depth);
  if (Array.isArray(v)) return v.length > 200 ? [...v.slice(0, 200).map((x) => lean(x, depth + 1)), `(${v.length - 200} more)`] : v.map((x) => lean(x, depth + 1));
  if (typeof v === 'object') {
    // (things of the page itself - an element, the window - are no particulars)
    if (typeof Node !== 'undefined' && v instanceof Node) return `(${v.nodeName})`;
    const out = {};
    let n = 0;
    for (const k of Object.keys(v)) { if (++n > 120) { out['…'] = 'more'; break; } const x = lean(v[k], depth + 1); if (x !== undefined) out[k] = x; }
    return out;
  }
  return String(v);
}

/**
 * Note something.
 * @param about  what it is about, in a word: route, ingame, link, map, gpu, check, error ...
 * @param text   what happened
 * @param data   the particulars, or nothing
 */
export function note(about, text, data) {
  const l = { t: Date.now(), k: String(about), m: String(text) };
  if (data !== undefined) { try { l.d = lean(data); } catch { l.d = '(particulars that could not be written down)'; } }
  lines.push(l);
  if (lines.length > KEPT) lines.shift();
  unsent.push(l);
  if (unsent.length > WAITING) unsent.splice(0, unsent.length - WAITING);
}

/** True the first time, and each time the value given under this key is another than the last. */
export function changed(key, value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(lean(value)); } catch { text = String(value); }
  if (before.get(key) === text) return false;
  before.set(key, text);
  return true;
}

/** Every line in hand, the oldest first: [{ t (ms), k, m, d }]. */
export const notes = () => lines.slice();

// ---- sent on to the server ---------------------------------------------------------------------
const PAGE = typeof window !== 'undefined' && typeof document !== 'undefined'; // (not so where a test reads this file outside any page)
let sending = false;
async function send() {
  if (sending || !unsent.length) return;
  sending = true;
  const batch = unsent.slice(0, 400);
  try {
    const res = await fetch('/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines: batch }), keepalive: true });
    // (an older server has nowhere to put them: they stay in hand, and are not offered again)
    if (res.ok || res.status === 404 || res.status === 405) unsent = unsent.filter((l) => !batch.includes(l));
  } catch { /* the server is away: offered again */ }
  sending = false;
}
if (PAGE) setInterval(send, SEND_EVERY);
// (the page is going - loading itself again, or closed: what is left is sent with it)
if (PAGE) window.addEventListener('pagehide', () => { if (unsent.length && navigator.sendBeacon) { try { navigator.sendBeacon('/api/log', JSON.stringify({ lines: unsent.slice(-400) })); unsent = []; } catch { /* it goes unsent */ } } });
/** Send what is waiting now (before a report is asked for). */
export const sendNow = () => send();

// ---- what goes wrong, noted by itself ------------------------------------------------------------
const words = (a) => a.map((x) => (x instanceof Error ? `${x.message}${x.stack ? ` @ ${String(x.stack).split('\n').slice(1, 4).join(' | ').trim()}` : ''}` : typeof x === 'string' ? x : (() => { try { return JSON.stringify(lean(x)); } catch { return String(x); } })())).join(' ');
for (const level of PAGE ? ['warn', 'error'] : []) {
  const real = console[level].bind(console);
  console[level] = (...a) => { try { note(level === 'warn' ? 'warning' : 'error', words(a).slice(0, 3000)); } catch { /* said on the console all the same */ } real(...a); };
}
if (PAGE) window.addEventListener('error', (e) => {
  // (a script or a picture that could not be fetched tells its own element, not the window: this is what the page's code threw)
  note('error', `uncaught: ${e.message}`, { file: String(e.filename ?? '').replace(location.origin, ''), line: e.lineno, column: e.colno, stack: String(e.error?.stack ?? '').split('\n').slice(0, 8).join(' | ') });
});
if (PAGE) window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  note('error', `uncaught, in something the page was waiting for: ${r?.message ?? r}`, { stack: String(r?.stack ?? '').split('\n').slice(0, 8).join(' | ') });
});
if (PAGE) document.addEventListener('visibilitychange', () => note('page', document.hidden ? 'the page is out of sight' : 'the page is in sight'));

if (PAGE) note('page', 'the page has loaded', {
  address: location.pathname + location.hash, made: document.querySelector('meta[name="wfmap-stamp"]')?.content ?? null,
  browser: navigator.userAgent, inTheApplication: !!window.azerothAtlas, threads: navigator.hardwareConcurrency ?? null, memoryGB: navigator.deviceMemory ?? null,
  window: [window.innerWidth, window.innerHeight], screen: [window.screen?.width, window.screen?.height], pixelRatio: window.devicePixelRatio, language: navigator.language,
});
if (PAGE) window.__notes = lines; // handy for looking from the console
