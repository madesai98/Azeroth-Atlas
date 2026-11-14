// What every part of the local server answers with: files, a little JSON, and who may ask.
import fs from 'node:fs';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.wgsl': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.bin': 'application/octet-stream', '.blp': 'application/octet-stream', '.ico': 'image/x-icon',
};

export function sendFile(req, res, file, immutable) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      etag,
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    headers['content-length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

export function safeJoin(base, rel) {
  const full = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return full === base || full.startsWith(base + path.sep) ? full : null;
}

/** Only this machine may talk to the server (defends against other sites / DNS rebinding). */
export function localOnly(req) {
  const host = (req.headers.host ?? '').split(':')[0];
  return host === 'localhost' || host === '127.0.0.1';
}

/** A request that changes something must come from the map page itself, not from another site's page. */
export function ownPage(req) {
  const origin = req.headers.origin;
  try { return !origin || new URL(origin).host === req.headers.host; } catch { return false; }
}

export function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** A small JSON body, read whole: resolves to what it holds ({} for none). */
export function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { req.destroy(); reject(new Error('too much sent')); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}
