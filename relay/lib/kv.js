// KV mínimo: Upstash Redis via REST (Vercel) ou Map em memória (servidor local / testes).
const env = process.env;
const url = () => env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
const token = () => env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';

export const kvBackend = () => (url() && token() ? 'redis-rest' : 'in-memory');
export const kvIsDurable = () => kvBackend() === 'redis-rest';

const store = new Map(); // key -> { v, exp }

async function redis(cmd) {
  const r = await fetch(url(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!r.ok) throw new Error(`KV HTTP ${r.status}`);
  return (await r.json()).result;
}

function live(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.exp && e.exp < Date.now()) { store.delete(key); return undefined; }
  return e;
}

export async function kvGetJson(key) {
  if (kvIsDurable()) { const v = await redis(['GET', key]); return v ? JSON.parse(v) : null; }
  const e = live(key); return e ? structuredClone(e.v) : null;
}

export async function kvSetJson(key, value, ttlSec) {
  if (kvIsDurable()) { await redis(['SET', key, JSON.stringify(value), 'EX', String(ttlSec)]); return; }
  store.set(key, { v: structuredClone(value), exp: Date.now() + ttlSec * 1000 });
}

export async function kvDel(key) {
  if (kvIsDurable()) { await redis(['DEL', key]); return; }
  store.delete(key);
}

export async function kvRpush(key, value, ttlSec) {
  if (kvIsDurable()) {
    const n = await redis(['RPUSH', key, value]);
    await redis(['EXPIRE', key, String(ttlSec)]);
    return n;
  }
  const e = live(key) || { v: [], exp: 0 };
  e.v.push(value); e.exp = Date.now() + ttlSec * 1000; store.set(key, e);
  return e.v.length;
}

export async function kvLrange(key, start = 0, stop = -1) {
  if (kvIsDurable()) return (await redis(['LRANGE', key, String(start), String(stop)])) || [];
  const e = live(key); if (!e) return [];
  const a = e.v, n = a.length;
  const s = start < 0 ? Math.max(0, n + start) : start, t = stop < 0 ? n + stop : Math.min(stop, n - 1);
  return a.slice(s, t + 1);
}
