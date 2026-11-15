// The shared database, spoken to in plain HTTP.
//
// The facts everybody's copy of the map agrees on live in a Firebase Realtime Database: one big
// tree of JSON, where every node has an address like /truth/npc/1234 and can be read or written
// by asking for <database url>/truth/npc/1234.json. That is all this file does: five kinds of
// request (read, replace, change many places at once, add under a new key, delete), with the
// waiting, the retrying and the error messages looked after. No library is needed for it.
//
// How the database behaves, all of it tried against the real one (November 2026):
//  - Nothing empty is kept. An empty list, an empty object and null are all "nothing there":
//    they read back as null, or the key is simply gone from its parent. A list loses the nulls
//    at its end, and a list that is mostly holes comes back as an object.
//  - Children whose keys are whole numbers (0, 1, 2…; not "01", not "-1") come back as a LIST,
//    with null in the gaps, whenever at least half of the places from 0 to the highest key are
//    taken: {1, 2, 5} is a list of six, {5, 6, 7} stays an object. entries() reads both.
//  - Keys may not be empty or hold . $ # [ ] / or control characters: safeKey() makes any text
//    fit. A whole path (its keys and the slashes between them) may be 768 bytes and 32 keys deep.
//    One piece of text may be 10 MB.
//  - Numbers come back equal but may be written differently (1e-7 as 1.0E-7). Whole numbers
//    are kept exactly below 2^63, which is further than JavaScript itself can count (2^53).
//  - Nothing is compressed. The server sends plain JSON whatever is asked of it, and refuses a
//    compressed upload (HTTP 415). 20 MB is 20 MB on the wire, both ways.
//  - One request has taken 50 MB here without trouble. But a request that wipes out a large
//    branch (a delete, or a put over it) can be refused with HTTP 400 "Data to write exceeds the
//    maximum size that can be modified with a single request": the server goes by its own
//    estimate, not by the megabytes. Take such a branch apart child by child.
//
// Nothing about you or your computer is sent: only the address asked for, the data itself, and
// the name "azeroth-atlas".

const AGENT = 'azeroth-atlas';

/** Put this where a value goes and the database writes its own clock there (milliseconds). */
export const SERVER_TIME = { '.sv': 'timestamp' };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// What went wrong, as the server put it: its answer to a refused request is {"error": "..."}.
function refusal(status, text) {
  let said = text;
  try { const j = JSON.parse(text); if (j && typeof j.error === 'string') said = j.error; } catch { /* not JSON: keep the text */ }
  said = String(said ?? '').trim().slice(0, 500);
  const err = new Error(`HTTP ${status}${said ? `: ${said}` : ''}`);
  err.status = status;
  err.server = said;
  return err;
}

export class Rtdb {
  /**
   * @param url  the database's address, e.g. https://<name>-default-rtdb.firebaseio.com
   * @param auth       a token or database secret, sent as ?auth= (null: none, for an open database)
   * @param timeoutMs  how long one attempt may take, from the first byte sent to the last received
   * @param retries    how many more times to try after a failure that may pass by itself
   */
  constructor(url, { auth = null, timeoutMs = 60000, retries = 3 } = {}) {
    this.base = String(url).replace(/\/+$/, '');
    this.auth = auth;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  // 'truth/npc' or '/truth/npc' → https://…/truth/npc.json?… Each part of the path is encoded,
  // so a key holding a space, a % or a letter from another alphabet arrives as it was written.
  address(path, query = {}) {
    const parts = String(path ?? '').split('/').filter((p) => p !== '').map(encodeURIComponent);
    const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
    if (this.auth) q.push(`auth=${encodeURIComponent(this.auth)}`);
    return `${this.base}/${parts.join('/')}.json${q.length ? `?${q.join('&')}` : ''}`;
  }

  // One attempt: the whole exchange, the answer's body included, inside the time allowed.
  // Failing here means no HTTP answer was had at all: the error's status is 0.
  async once(method, url, headers, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctl.signal, redirect: 'follow' });
      return { status: res.status, headers: res.headers, text: await res.text() };
    } catch (cause) {
      const why = ctl.signal.aborted ? `no answer within ${this.timeoutMs} ms` : (cause?.cause?.message || cause?.message || 'connection failed');
      const err = new Error(`${method} ${url.split('?')[0]}: ${why}`, { cause });
      err.status = 0;
      err.server = '';
      throw err;
    } finally { clearTimeout(timer); }
  }

  // A request, tried again after a pause (half a second, then one, then two…) when the failure
  // is the kind that passes: the connection dropped or timed out, the server is busy (429) or
  // broken (5xx). A refusal (any other 4xx) is final. `repeatable: false` is for the one request
  // that must not be sent twice blindly (post: a second copy would be added): it is tried again
  // only when the server itself answered that it did not do it.
  // `accept` lists statuses outside 2xx that are an answer and not a failure.
  async send(method, path, { query, body, headers = {}, repeatable = true, accept = [] } = {}) {
    const url = this.address(path, query);
    const head = { 'User-Agent': AGENT, ...headers }; // (fetch adds Accept-Encoding: br, gzip, deflate by itself)
    let text;
    if (body !== undefined) { text = JSON.stringify(body ?? null); head['Content-Type'] = 'application/json; charset=utf-8'; }
    for (let attempt = 0; ; attempt++) {
      let pause = 500 * 2 ** attempt * (0.75 + Math.random() / 2);
      let res = null; let err;
      try { res = await this.once(method, url, head, text); } catch (e) { if (!repeatable) throw e; err = e; }
      if (res) {
        if ((res.status >= 200 && res.status < 300) || accept.includes(res.status)) return res;
        err = refusal(res.status, res.text);
        if (res.status !== 429 && res.status < 500) throw err;
        const asked = Number(res.headers.get('retry-after'));
        if (asked > 0) pause = Math.max(pause, Math.min(asked, 30) * 1000);
      }
      if (attempt >= this.retries) throw err;
      await sleep(pause);
    }
  }

  /**
   * Read what is at a path: the value, or null when nothing is there.
   *  shallow      only the names of the children ({ name: true, … }), not what is in them.
   *               (limitToFirst may go with it; the ranges below may not.)
   *  orderByKey, startAt, endAt, limitToFirst, limitToLast
   *               only the children whose keys fall in a range (both ends included), or the
   *               first/last few. Keys that are whole numbers of up to 2147483647 are compared as
   *               numbers (15 < 1000 < 263380, and "0015" counts as 15), all others as text, and
   *               every number comes before every text. Giving a range or a limit is enough: the
   *               ordering is asked for with it. No index rule is needed for keys.
   *  etag         also say which version this is → { value, etag }, for put(…, { ifMatch }).
   *               (Not together with shallow or a range: the database refuses the mix.)
   * The answer is an object in no particular order, or a list (see entries()).
   */
  async get(path, { shallow = false, orderByKey = false, startAt, endAt, limitToFirst, limitToLast, etag = false } = {}) {
    const query = {};
    if (shallow) query.shallow = 'true';
    else if (orderByKey || startAt !== undefined || endAt !== undefined || limitToFirst !== undefined || limitToLast !== undefined) query.orderBy = '"$key"';
    if (startAt !== undefined) query.startAt = JSON.stringify(String(startAt));
    if (endAt !== undefined) query.endAt = JSON.stringify(String(endAt));
    if (limitToFirst !== undefined) query.limitToFirst = limitToFirst;
    if (limitToLast !== undefined) query.limitToLast = limitToLast;
    const res = await this.send('GET', path, { query, headers: etag ? { 'X-Firebase-ETag': 'true' } : {} });
    const value = res.text ? JSON.parse(res.text) : null;
    return etag ? { value, etag: res.headers.get('etag') } : value;
  }

  /**
   * Replace what is at a path (null deletes it). → true.
   * With ifMatch (the etag a get gave), the write happens only if what is there is still what
   * was read: → false when somebody changed it in between, and nothing is written. Read again
   * and decide again. The etag of a place with nothing in it is 'null_etag', everywhere: giving
   * that means "only if nothing is there yet".
   */
  async put(path, value, { ifMatch } = {}) {
    if (ifMatch === undefined || ifMatch === null) {
      await this.send('PUT', path, { query: { print: 'silent' }, body: value ?? null });
      return true;
    }
    // (The database refuses print=silent together with if-match, so here what was written is
    // sent back and thrown away: keep conditional writes small.)
    const res = await this.send('PUT', path, { body: value ?? null, headers: { 'if-match': String(ifMatch) }, accept: [412] });
    return res.status !== 412;
  }

  /**
   * Change several places in one go: { 'a/b/c': 1, 'a/d': null, e: {…} } sets /path/a/b/c,
   * deletes /path/a/d and replaces /path/e, leaving everything else alone. All of it happens or
   * none of it. One key may not lie inside another ('a' and 'a/b' together are refused).
   * Thousands of paths in one request are fine: 2,000 took a third of a second, 100,000 took nine.
   */
  async patch(path, object) {
    await this.send('PATCH', path, { query: { print: 'silent' }, body: object });
    return true;
  }

  /** Add a value under a new key made by the database (keys made later sort later). → the key. */
  async post(path, value) {
    const res = await this.send('POST', path, { body: value, repeatable: false });
    return JSON.parse(res.text).name;
  }

  /** Delete what is at a path, and everything under it. */
  async remove(path) {
    await this.send('DELETE', path, { query: { print: 'silent' } });
    return true;
  }
}

/**
 * The children of what a get returned, as [[key, value], …] with keys as text. The database
 * hands back an object, or, when the keys are small whole numbers close together, a list with
 * null where a number is missing: both read the same here, and the gaps are left out.
 */
export function entries(node) {
  const out = [];
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) if (node[i] !== null && node[i] !== undefined) out.push([String(i), node[i]]);
    return out;
  }
  for (const key of Object.keys(node)) if (node[key] !== null && node[key] !== undefined) out.push([key, node[key]]);
  return out;
}

/**
 * Any text as a key the database accepts. The characters it refuses ( . $ # [ ] / and control
 * characters) are written as % and their code, like in a web address ("Mr. Smite" → "Mr%2E Smite"),
 * and so is % itself, which makes it reversible: decodeURIComponent() gives the text back.
 * Nothing at all becomes "%" (a key may not be empty). Length is not looked at: see the top.
 */
export function safeKey(s) {
  const text = String(s ?? '').toWellFormed();
  const key = text.replace(/[%.$#[\]/\u0000-\u001f\u007f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return key === '' ? '%' : key;
}
