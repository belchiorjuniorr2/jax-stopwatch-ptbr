import crypto from 'node:crypto';

export const MAX_BODY = 4 * 1024 * 1024; // abaixo do limite de 4,5 MB da Vercel (~2 min de 16 kHz mono)

export function send(res, status, headers, body) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}
export const json = (res, status, obj) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(obj));

export function readBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > MAX_BODY) { reject(Object.assign(new Error('áudio grande demais'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function authorized(req) {
  const expected = process.env.DEVICE_TOKEN || '';
  if (!expected) return false; // sem token configurado, nada passa
  const h = req.headers['authorization'] || '';
  const got = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-device-token'] || '');
  const a = Buffer.from(String(got)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function deviceIdOf(req) {
  const raw = String(req.headers['x-device-id'] || 'default');
  return raw.replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 64) || 'default';
}

// Texto para cabeçalho HTTP: UTF-8 percent-encoded (ASCII puro), limitado
export const hdr = (s, max = 1500) => encodeURIComponent(s).slice(0, max).replace(/%[0-9A-F]?$/i, '');


export function readJson(req, max = 64 * 1024) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return readBody(req).then((b) => {
    if (b.length > max) throw Object.assign(new Error('JSON grande demais'), { status: 413 });
    try { return JSON.parse(b.toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
  });
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const randomHex = (n) => crypto.randomBytes(n).toString('hex');
