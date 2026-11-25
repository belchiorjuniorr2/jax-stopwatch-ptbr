// Modo Grok Bot: tarefas assíncronas via rotina webhook com callback de uso único.
//
//  relógio --WAV--> POST /api/agent  -> STT -> cria job no KV -> POST webhook da rotina
//  rotina  --JSON-> POST /api/callback/<id>  {status:'progress'|'completed'|'failed', text}
//  relógio --poll-> GET  /api/job/<id>        (1–2 s)
//  relógio -------> GET  /api/job/<id>/audio  (TTS do texto final, gerado na hora)
//  relógio -------> POST /api/job/<id>/cancel
import { parseWav, pcmToWav, pcmStats } from './wav.js';
import { resolveProviders, speechToText, textToSpeech, voiceFrom } from './providers.js';
import { send, json, readBody, readJson, authorized, deviceIdOf, hdr, sha256, safeEqualHex, randomHex } from './http.js';
import { kvGetJson, kvSetJson, kvRpush, kvLrange, kvIsDurable } from './kv.js';
import { appendTurn } from './memory.js';

const env = process.env;
export const JOB_TIMEOUT_MS = () => Math.max(1, parseInt(env.JOB_TIMEOUT_SECONDS || '900', 10)) * 1000; // 15 min
const JOB_TTL_SEC = 2 * 3600;
const MAX_STEPS = 20;
const MAX_STEP_CHARS = 140;
const MAX_FINAL_CHARS = 1200;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout']);

const jobKey = (id) => `m5voz:job:${id}`;
const stepsKey = (id) => `m5voz:job:${id}:steps`;
const validId = (id) => /^[a-f0-9]{32}$/.test(id || '');

const clean = (s, max) => String(s ?? '')
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/[*_`#>]+/g, '')            // tira markdown que atrapalha voz/tela
  .replace(/\s+/g, ' ').trim().slice(0, max);

// Rota: /api/job/<id>[/audio|/cancel] ou /api/callback/<id> (também aceita ?id=&op= vindo dos rewrites da Vercel)
export function routeInfo(req) {
  const u = new URL(req.url, 'http://x');
  const m = u.pathname.match(/^\/api\/(?:job|callback)\/([^/]+)(?:\/(audio|cancel))?\/?$/);
  return { id: (m?.[1] || u.searchParams.get('id') || '').toLowerCase(), op: m?.[2] || u.searchParams.get('op') || '' };
}

function publicBaseUrl(req) {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

function kvRequiredError() {
  // Na Vercel, cada chamada pode cair numa instância diferente: sem KV o job some.
  return env.VERCEL && !kvIsDurable()
    ? 'Modo Grok Bot precisa do Upstash (KV_REST_API_URL/KV_REST_API_TOKEN) na Vercel.'
    : '';
}

async function loadJob(id) {
  const job = await kvGetJson(jobKey(id));
  if (!job) return null;
  if (!TERMINAL.has(job.status) && Date.now() - job.createdAt > JOB_TIMEOUT_MS()) {
    job.status = 'timeout'; job.text = 'A tarefa passou de 15 minutos e foi encerrada.'; job.finishedAt = Date.now();
    await kvSetJson(jobKey(id), job, JOB_TTL_SEC);
  }
  return job;
}

// -------- Disparo da rotina --------
async function dispatchWebhook(payload) {
  const url = env.GROKBOT_WEBHOOK_URL || '';
  const key = env.GROKBOT_WEBHOOK_KEY || '';
  if (url === 'mock' || (!url && env.GROKBOT_MOCK === '1')) return mockRoutine(payload);
  if (!url) throw new Error('GROKBOT_WEBHOOK_URL não configurada');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'X-Automation-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`webhook da rotina respondeu HTTP ${r.status}`);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'webhook da rotina não respondeu em 15 s' : e.message);
  } finally { clearTimeout(t); }
}

// Rotina simulada (só servidor local / testes): manda progresso e resultado pelo próprio callback.
function mockRoutine(p) {
  const post = (body) => fetch(p.callback.url, {
    method: 'POST', headers: { Authorization: `Bearer ${p.callback.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
  const ms = parseInt(env.GROKBOT_MOCK_STEP_MS || '1500', 10);
  setTimeout(() => post({ status: 'progress', text: 'Entendendo o pedido…' }), ms);
  setTimeout(() => post({ status: 'progress', text: 'Buscando no Gmail…' }), ms * 2);
  setTimeout(() => post({ status: 'progress', text: 'Resumindo o que achei…' }), ms * 3);
  setTimeout(() => post({ status: 'completed', text: `Pronto! Simulei a tarefa "${p.text}". Tudo certo por aqui.` }), ms * 4);
  return Promise.resolve();
}

// -------- POST /api/agent (relógio) --------
export async function handleAgent(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'use POST com audio/wav' });
  if (!authorized(req)) return json(res, 401, { error: 'não autorizado' });
  const kvErr = kvRequiredError(); if (kvErr) return json(res, 503, { error: kvErr });
  const deviceId = deviceIdOf(req);
  try {
    const body = await readBody(req);
    let wav;
    try { wav = parseWav(body); } catch (e) { return json(res, 400, { error: `WAV inválido: ${e.message}` }); }
    if (wav.durationSec < 0.3) return json(res, 400, { error: 'áudio curto demais' });

    const st = pcmStats(wav);
    console.log(`[agent] wav samples=${st.samples} sr=${st.sampleRate} dur=${st.durationSec.toFixed(2)}s rms=${st.rms} peak=${st.peak} dc=${st.dc} clips=${st.clips}`);
    const transcript = await speechToText(resolveProviders().stt, body);
    if (!transcript) return json(res, 422, { error: 'Não consegui ouvir direito. Pode repetir?' });

    const id = randomHex(16);
    const cbToken = randomHex(24);
    const job = { id, deviceId, status: 'queued', transcript, text: '', createdAt: Date.now(), cbHash: sha256(cbToken) };
    await kvSetJson(jobKey(id), job, JOB_TTL_SEC);

    const payload = {
      source: 'm5-voz-stopwatch',
      requestId: id,
      jobId: id,
      text: transcript,
      deviceId,
      language: 'pt-BR',
      createdAt: new Date(job.createdAt).toISOString(),
      callback: {
        url: `${publicBaseUrl(req)}/api/callback/${id}`,
        token: cbToken,
        progressFormat: { status: 'progress', text: 'linha curta de progresso' },
        format: { status: 'completed', text: 'resposta final curta em português' },
        failFormat: { status: 'failed', text: 'motivo curto' },
        expiresInSeconds: Math.round(JOB_TIMEOUT_MS() / 1000),
      },
    };
    try {
      await dispatchWebhook(payload);
    } catch (e) {
      job.status = 'failed'; job.text = 'Não consegui acionar o Grok Bot agora.'; job.error = e.message; job.finishedAt = Date.now();
      await kvSetJson(jobKey(id), job, JOB_TTL_SEC);
      console.error('[agent] webhook falhou:', e.message);
      return json(res, 502, { error: job.text, jobId: id });
    }
    // Só marca "running" se o callback ainda não tiver mudado o estado (rotina rápida)
    const cur = await kvGetJson(jobKey(id));
    if (cur && cur.status === 'queued') { cur.status = 'running'; await kvSetJson(jobKey(id), cur, JOB_TTL_SEC); }
    console.log(`[agent] job ${id.slice(0, 8)} criado para ${deviceId}`);
    json(res, 202, { jobId: id, status: 'running', transcript, pollMs: 1500, timeoutSec: Math.round(JOB_TIMEOUT_MS() / 1000) });
  } catch (e) {
    console.error('[agent] erro:', e.message);
    json(res, e.status || 502, { error: String(e.message).slice(0, 300) });
  }
}

// -------- POST /api/callback/<id> (rotina do Grok Bot) --------
export async function handleCallback(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
  const { id } = routeInfo(req);
  if (!validId(id)) return json(res, 404, { error: 'job desconhecido' });
  const job = await loadJob(id);
  if (!job) return json(res, 404, { error: 'job desconhecido ou expirado' });
  const h = String(req.headers['authorization'] || '');
  const tok = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!tok || !safeEqualHex(sha256(tok), job.cbHash)) return json(res, 401, { error: 'token de callback inválido' });
  if (TERMINAL.has(job.status)) return json(res, 410, { error: `job já está ${job.status}`, status: job.status });

  let body;
  try { body = await readJson(req); } catch (e) { return json(res, e.status || 400, { error: e.message }); }
  const status = String(body.status || '').toLowerCase();
  if (status === 'progress') {
    const text = clean(body.text, MAX_STEP_CHARS);
    if (!text) return json(res, 400, { error: 'text vazio' });
    // Reenvio (a rotina repete após 403/timeout da Vercel): não duplica o mesmo passo
    const last = (await kvLrange(stepsKey(id), -1, -1))[0];
    if (last === text) return json(res, 200, { ok: true, duplicate: true });
    const n = await kvRpush(stepsKey(id), text, JOB_TTL_SEC);
    if (job.status === 'queued') { job.status = 'running'; await kvSetJson(jobKey(id), job, JOB_TTL_SEC); }
    return json(res, 200, { ok: true, steps: n });
  }
  if (status === 'completed' || status === 'failed') {
    // Passos de reserva: se algum progresso se perdeu (ex.: 403 da Vercel), a rotina pode reenviá-los aqui
    if (Array.isArray(body.steps) && body.steps.length) {
      const have = new Set(await kvLrange(stepsKey(id), 0, -1));
      for (const st of body.steps.slice(0, MAX_STEPS)) {
        const t = clean(st, MAX_STEP_CHARS);
        if (t && !have.has(t)) { await kvRpush(stepsKey(id), t, JOB_TTL_SEC); have.add(t); }
      }
    }
    job.status = status;
    job.text = clean(body.text, MAX_FINAL_CHARS) || (status === 'completed' ? 'Pronto.' : 'Não deu certo.');
    job.finishedAt = Date.now();
    await kvSetJson(jobKey(id), job, JOB_TTL_SEC);   // estado terminal: o token deixa de valer
    if (status === 'completed') await appendTurn(job.deviceId, job.transcript, job.text);
    console.log(`[callback] job ${id.slice(0, 8)} ${status}`);
    return json(res, 200, { ok: true });
  }
  return json(res, 400, { error: "status deve ser 'progress', 'completed' ou 'failed'" });
}

// -------- /api/job/<id>[/audio|/cancel] (relógio) --------
export async function handleJob(req, res) {
  if (!authorized(req)) return json(res, 401, { error: 'não autorizado' });
  const { id, op } = routeInfo(req);
  if (!validId(id)) return json(res, 404, { error: 'job desconhecido' });
  const job = await loadJob(id);
  if (!job) return json(res, 404, { error: 'job desconhecido ou expirado' });

  if (op === 'cancel') {
    if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
    if (!TERMINAL.has(job.status)) {
      job.status = 'cancelled'; job.text = 'Tarefa cancelada.'; job.finishedAt = Date.now();
      await kvSetJson(jobKey(id), job, JOB_TTL_SEC);
    }
    return json(res, 200, { ok: true, status: job.status });
  }

  if (op === 'audio') {
    if (!['completed', 'failed', 'timeout'].includes(job.status)) return json(res, 409, { error: 'job ainda não terminou' });
    try {
      const { pcm, sampleRate } = await textToSpeech(resolveProviders().tts, job.text, { voice: voiceFrom(req) });
      const out = pcmToWav(pcm, sampleRate);
      return send(res, 200, {
        'Content-Type': 'audio/wav', 'Content-Length': String(out.length), 'X-Sample-Rate': String(sampleRate),
        'X-Reply': hdr(job.text), 'Cache-Control': 'no-store',
      }, out);
    } catch (e) {
      console.error('[job] TTS falhou:', e.message);
      return json(res, 502, { error: 'falha no TTS' });
    }
  }

  const steps = await kvLrange(stepsKey(id), -MAX_STEPS, -1);
  json(res, 200, {
    id, status: job.status, transcript: job.transcript, steps,
    text: TERMINAL.has(job.status) ? job.text : '',
    elapsedMs: (job.finishedAt || Date.now()) - job.createdAt,
    timeoutSec: Math.round(JOB_TIMEOUT_MS() / 1000),
  });
}
