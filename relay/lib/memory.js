// Memória curta de conversa por dispositivo (usa o KV: Upstash na Vercel, Map local).
import { kvGetJson, kvSetJson, kvDel, kvBackend } from './kv.js';

const env = process.env;
const TURNS = () => Math.max(0, parseInt(env.MEMORY_TURNS || '6', 10));
const TTL = () => Math.max(60, parseInt(env.MEMORY_TTL_SECONDS || '1800', 10));
const key = (id) => `m5voz:hist:${id}`;

export const memoryBackend = () => kvBackend();

export async function getHistory(deviceId) {
  try { return (await kvGetJson(key(deviceId))) || []; }
  catch (e) { console.warn('[memória] falha ao ler:', e.message); return []; }
}

export async function appendTurn(deviceId, userText, assistantText) {
  const msgs = [...(await getHistory(deviceId)), { role: 'user', content: userText }, { role: 'assistant', content: assistantText }]
    .slice(-TURNS() * 2);
  try { await kvSetJson(key(deviceId), msgs, TTL()); }
  catch (e) { console.warn('[memória] falha ao gravar:', e.message); }
}

export async function clearHistory(deviceId) {
  try { await kvDel(key(deviceId)); } catch {}
}
