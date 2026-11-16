// Blizzard's own Game Data API, asked for what the auction houses hold.
//
// Blizzard hands the lists out to anybody with an "API client" (a name and a secret, made for
// free at https://develop.battle.net), and a client may not be handed on. So only this function
// has one: it is kept in the project's Secret Manager, is no part of the map tool, never goes
// into the database and is never shown. With it a pass is fetched (good for a day, kept only
// for as long as this instance of the function lives) and every request carries the pass.
//
// The addresses for this game are not in Blizzard's documentation yet (November 2026); they
// were found by people trying them:
//
//   /data/wow/ruleset/index                              the rulesets (they stand where realms stood)
//   /data/wow/ruleset/<id>/auctions/                     the auction houses (the slash at the end is needed)
//   /data/wow/ruleset/<id>/auctions/<house>              what is up for sale in one house
//   /data/wow/ruleset/<id>/auctions/<house>/commodities  and what is sold by the piece there
//
// each with ?namespace=dynamic-forever-<region>. Blizzard allows 36,000 requests an hour; this
// asks for a few dozen.

export const REGIONS = ['us', 'eu', 'kr', 'tw'];
const AGENT = 'azeroth-atlas';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export class Blizzard {
  /** @param key { id, secret } */
  constructor(key, { timeoutMs = 120000, retries = 3 } = {}) {
    this.key = key;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.pass = null;
    this.requests = 0;
    this.bytes = 0;
  }

  async #fetch(url, init) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      const text = res.status === 304 ? '' : await res.text();
      return { status: res.status, headers: res.headers, text };
    } catch (cause) {
      const err = new Error(ctl.signal.aborted ? `no answer within ${this.timeoutMs} ms` : (cause?.cause?.message || cause?.message || 'connection failed'), { cause });
      err.status = 0;
      throw err;
    } finally { clearTimeout(timer); }
  }

  /** The pass every request carries: the one in hand, while it has an hour left, else a new one. */
  async token() {
    if (this.pass && this.pass.until - Date.now() > 3600 * 1000) return this.pass.token;
    const basic = Buffer.from(`${this.key.id}:${this.key.secret}`).toString('base64');
    const res = await this.#fetch('https://oauth.battle.net/token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': AGENT },
      body: 'grant_type=client_credentials',
    });
    if (res.status === 401 || res.status === 400) {
      const err = new Error('Blizzard does not know this API client: the name or the secret is not right');
      err.status = res.status;
      throw err;
    }
    if (res.status !== 200) { const err = new Error(`Blizzard gave no pass (HTTP ${res.status})`); err.status = res.status; throw err; }
    const j = JSON.parse(res.text);
    this.pass = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return this.pass.token;
  }

  /**
   * One thing asked of the API. → { status, json, modified } where `modified` is when Blizzard
   * last changed it (as it says itself; null when it does not say).
   *  since   only if it has changed since then (what `modified` was last time): → status 304, json null
   *  accept  statuses that are an answer and not a failure (404: "there is no such thing")
   */
  async get(region, route, { namespace, since = null, accept = [] } = {}) {
    if (!REGIONS.includes(region)) throw new Error(`no such region: ${region}`);
    const url = `https://${region}.api.blizzard.com${route}${route.includes('?') ? '&' : '?'}namespace=${namespace}-${region}&locale=en_US`;
    for (let attempt = 0; ; attempt++) {
      let res = null, err;
      try {
        const headers = { Authorization: `Bearer ${await this.token()}`, 'User-Agent': AGENT };
        if (since) headers['If-Modified-Since'] = since;
        res = await this.#fetch(url, { headers });
        this.requests++;
        this.bytes += res.text.length;
      } catch (e) { if (e.status) throw e; err = e; }
      if (res) {
        const modified = res.headers.get('last-modified');
        if (res.status === 200) return { status: 200, json: JSON.parse(res.text), modified, bytes: res.text.length };
        if (res.status === 304 || accept.includes(res.status)) return { status: res.status, json: null, modified, bytes: 0 };
        if (res.status === 401 && attempt === 0) { this.pass = null; continue; } // the pass ran out early: a new one
        err = new Error(`${route}: HTTP ${res.status}`);
        err.status = res.status;
        if (res.status !== 429 && res.status < 500) throw err;
      }
      if (attempt >= this.retries) throw err;
      await sleep(1000 * 2 ** attempt * (0.75 + Math.random() / 2));
    }
  }

  rulesets(region) { return this.get(region, '/data/wow/ruleset/index', { namespace: 'dynamic-forever' }); }
  houses(region, ruleset) { return this.get(region, `/data/wow/ruleset/${ruleset}/auctions/`, { namespace: 'dynamic-forever' }); }
  house(region, ruleset, house, opts = {}) { return this.get(region, `/data/wow/ruleset/${ruleset}/auctions/${house}`, { namespace: 'dynamic-forever', accept: [404], ...opts }); }
  commodities(region, ruleset, house, opts = {}) { return this.get(region, `/data/wow/ruleset/${ruleset}/auctions/${house}/commodities`, { namespace: 'dynamic-forever', accept: [404], ...opts }); }
}
