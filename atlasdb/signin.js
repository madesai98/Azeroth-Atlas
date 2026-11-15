// Signing in to the Atlas database.
//
// The database lets in only those who are signed in, and lets each copy of the map write only
// to its own corner (atlasdb/rules.json). A copy signs in as nobody in particular: the first
// time it asks Firebase for an anonymous account, which is no more than a made-up name (the
// "uid") and a key to come back as the same one. No e-mail, no password, nothing about you.
// The name and the key are kept in <dataDir>/atlasdb/install.json; delete the file and the copy
// is a new nobody the next time.
//
// (The "apiKey" this needs is not a secret: it only says which Firebase project is meant, and
// is published with the map like the database's address.)
const SIGN_UP = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp';
const REFRESH = 'https://securetoken.googleapis.com/v1/token';

async function ask(url, apiKey, body, form) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(`${url}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'User-Agent': 'azeroth-atlas' },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) {
      const said = json?.error?.message ?? text.slice(0, 200);
      const err = new Error(said === 'ADMIN_ONLY_OPERATION' || said === 'OPERATION_NOT_ALLOWED' ? 'the database does not take new copies (anonymous sign-in is switched off there)' : `sign-in refused (${said})`);
      err.status = res.status; err.said = said;
      throw err;
    }
    return json;
  } catch (err) {
    if (err.status) throw err;
    throw new Error(`sign-in: ${ctl.signal.aborted ? 'no answer' : err.cause?.message || err.message}`);
  } finally { clearTimeout(timer); }
}

/**
 * Sign in as this copy (making it an account the first time).
 * @param store LocalStore: where the copy's name and key are kept
 * @returns {{ uid: string, token: string, fresh: boolean }} token: what the database wants with every request, good for an hour
 */
export async function signIn(apiKey, store) {
  const me = store.read('install.json') ?? {};
  if (typeof me.refresh === 'string' && me.refresh) {
    try {
      const r = await ask(REFRESH, apiKey, { grant_type: 'refresh_token', refresh_token: me.refresh }, true);
      if (r.refresh_token !== me.refresh || r.user_id !== me.id) store.write('install.json', { id: r.user_id, refresh: r.refresh_token });
      return { uid: r.user_id, token: r.id_token, fresh: false };
    } catch (err) {
      // (the account is gone, or its key no longer fits: a new one. Anything else - no network - is not a reason to change who this copy is)
      if (!/TOKEN_EXPIRED|USER_NOT_FOUND|USER_DISABLED|INVALID_REFRESH_TOKEN|INVALID_GRANT_TYPE|MISSING_REFRESH_TOKEN/.test(err.said ?? '')) throw err;
    }
  }
  const r = await ask(SIGN_UP, apiKey, { returnSecureToken: true }, false);
  store.write('install.json', { id: r.localId, refresh: r.refreshToken });
  // (what was sent before went under another name: it is sent again under this one)
  if (me.id && me.id !== r.localId) store.write('sent.json', {});
  return { uid: r.localId, token: r.idToken, fresh: true };
}
