// Testes do modo Grok Bot: job assíncrono, webhook da rotina, callbacks de progresso/final,
// polling, áudio final, cancelamento, timeout, falhas e KV estilo Upstash (REST).
// Uso: node test/jobs.mjs   (sem nenhuma chave real)
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseWav } from '../lib/wav.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const wavIn = fs.readFileSync(path.join(here, 'sample.wav'));
const TOKEN = crypto.randomBytes(16).toString('hex');
const HOOK_KEY = 'fake-hook-' + crypto.randomBytes(8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const ok = (n) => { pass++; console.log('  ✔', n); };

// ---------- servidores falsos ----------
function listen(srv, port) { return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv))); }
function bodyOf(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }); }

// Rotina do Grok Bot falsa: registra o payload e age conforme o "modo"
function fakeRoutine(port) {
  const st = { calls: [], mode: 'normal' };
  const srv = http.createServer(async (req, res) => {
    const raw = await bodyOf(req);
    const p = JSON.parse(raw.toString());
    st.calls.push({ headers: req.headers, payload: p });
    if (st.mode === 'http500') { res.statusCode = 500; return res.end('boom'); }
    res.statusCode = 200; res.end('{"ok":true}');           // 200 = só "recebido"
    if (st.mode !== 'normal') return;                       // 'silent': nunca responde
    const cb = (body, token = p.callback.token) => fetch(p.callback.url, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => ({ status: 0 }));   // relay pode já ter sido encerrado no fim do teste
    await sleep(150); st.r1 = await cb({ status: 'progress', text: 'Buscando no Gmail…' });
    await sleep(150); st.r2 = await cb({ status: 'progress', text: 'Lendo os 3 e-mails mais **recentes**\n' });
    await sleep(150); st.rBad = await cb({ status: 'progress', text: 'x' }, 'token-errado');
    await sleep(150); st.r3 = await cb({ status: 'completed', text: 'Você tem 3 e-mails novos; o mais importante é do banco.' });
    await sleep(50);  st.r4 = await cb({ status: 'progress', text: 'tarde demais' });
  });
  return listen(srv, port).then(() => ({ srv, st }));
}

// Upstash REST falso (GET/SET EX/DEL/RPUSH/EXPIRE/LRANGE)
function fakeUpstash(port, token) {
  const db = new Map(); const st = { cmds: 0, authFail: 0 };
  const srv = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { st.authFail++; res.statusCode = 401; return res.end('{}'); }
    const [cmd, key, ...a] = JSON.parse((await bodyOf(req)).toString()); st.cmds++;
    let result = null;
    switch (cmd.toUpperCase()) {
      case 'GET': result = typeof db.get(key) === 'string' ? db.get(key) : null; break;
      case 'SET': db.set(key, a[0]); result = 'OK'; break;
      case 'DEL': result = db.delete(key) ? 1 : 0; break;
      case 'RPUSH': { const l = Array.isArray(db.get(key)) ? db.get(key) : []; l.push(a[0]); db.set(key, l); result = l.length; break; }
      case 'EXPIRE': result = 1; break;
      case 'LRANGE': { const l = db.get(key) || []; const n = l.length; let s = +a[0], e = +a[1]; if (s < 0) s = Math.max(0, n + s); if (e < 0) e = n + e; result = l.slice(s, e + 1); break; }
      default: res.statusCode = 400; return res.end('{"error":"cmd"}');
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result }));
  });
  return listen(srv, port).then(() => ({ srv, st, db }));
}

function startRelay(port, extraEnv) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(OPENAI|XAI|ELEVENLABS|STT_|LLM_|TTS_|KV_|UPSTASH|DEVICE_TOKEN|GROKBOT|VERCEL|JOB_|PUBLIC_BASE)/.test(k)));
  const p = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...clean, PORT: String(port), DEVICE_TOKEN: TOKEN, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay não subiu: ' + log)), 5000);
    p.stdout.on('data', () => { if (log.includes('ouvindo')) { clearTimeout(t); resolve({ p, log: () => log }); } });
  });
}

const dev = (port) => ({
  base: `http://127.0.0.1:${port}`,
  h: (id = 'watch-1') => ({ Authorization: `Bearer ${TOKEN}`, 'X-Device-Id': id }),
  async agent(id) {
    const r = await fetch(`${this.base}/api/agent`, { method: 'POST', body: wavIn, headers: { ...this.h(id), 'Content-Type': 'audio/wav' } });
    return { r, j: await r.json() };
  },
  async job(jobId) { const r = await fetch(`${this.base}/api/job/${jobId}`, { headers: this.h() }); return { r, j: await r.json() }; },
  async poll(jobId, until, maxMs = 8000) {
    const seen = []; const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const { j } = await this.job(jobId); seen.push(j);
      if (until(j)) return { j, seen };
      await sleep(100);   // o relógio usa 1,5 s; aqui acelerado
    }
    throw new Error('poll estourou: ' + JSON.stringify(seen.at(-1)));
  },
});

// =================================================================
console.log('Cenário A: fluxo completo com rotina falsa (KV em memória)');
{
  const R = await fakeRoutine(19100);
  const relay = await startRelay(19001, { GROKBOT_WEBHOOK_URL: 'http://127.0.0.1:19100/automations/webhook/abc', GROKBOT_WEBHOOK_KEY: HOOK_KEY });
  const d = dev(19001);
  try {
    const h = await (await fetch(`${d.base}/api/health`)).json();
    assert.equal(h.grokBot, 'configured'); ok('health: grokBot configurado');

    const { r, j } = await d.agent();
    assert.equal(r.status, 202, JSON.stringify(j)); assert.match(j.jobId, /^[a-f0-9]{32}$/);
    assert.equal(j.status, 'running'); assert.match(j.transcript, /teste/); ok('POST /api/agent → 202 com jobId e transcrição');

    const call = R.st.calls[0];
    assert.equal(call.headers.authorization, `Bearer ${HOOK_KEY}`);
    assert.equal(call.headers['x-automation-key'], HOOK_KEY);
    assert.equal(call.payload.jobId, j.jobId); assert.equal(call.payload.requestId, j.jobId);
    assert.equal(call.payload.text, j.transcript);
    assert.equal(call.payload.callback.url, `${d.base}/api/callback/${j.jobId}`);
    assert.match(call.payload.callback.token, /^[a-f0-9]{48}$/);
    ok('webhook recebe Bearer + X-Automation-Key, texto, jobId e callback de uso único');

    const { j: fin, seen } = await d.poll(j.jobId, (x) => x.status === 'completed');
    const mid = seen.find((x) => x.status === 'running' && x.steps.length === 1);
    assert.ok(mid, 'deveria ver um passo intermediário'); assert.equal(mid.text, '');
    assert.deepEqual(fin.steps, ['Buscando no Gmail…', 'Lendo os 3 e-mails mais recentes']);
    assert.match(fin.text, /3 e-mails novos/);
    ok(`polling vê progresso ao vivo e o final: ${JSON.stringify(fin.steps)}`);

    for (let i = 0; i < 50 && !R.st.r4; i++) await sleep(20);
    assert.equal(R.st.r1.status, 200); assert.equal(R.st.rBad.status, 401); assert.equal(R.st.r4.status, 410);
    ok('callback: token errado → 401; depois do final → 410 (uso único)');

    const a = await fetch(`${d.base}/api/job/${j.jobId}/audio`, { headers: d.h() });
    assert.equal(a.status, 200); const w = parseWav(Buffer.from(await a.arrayBuffer()));
    assert.equal(w.channels, 1); assert.match(decodeURIComponent(a.headers.get('x-reply')), /mais importante é do banco/);
    ok('GET /api/job/<id>/audio devolve WAV mono + X-Reply com acentos');

    const v = await fetch(`${d.base}/api/voz`, { method: 'POST', body: wavIn, headers: { ...d.h(), 'Content-Type': 'audio/wav' } });
    await v.arrayBuffer();
    assert.match(decodeURIComponent(v.headers.get('x-reply')), /mensagem 2 /);
    ok('resposta do Grok Bot entra na memória do modo rápido (botão A)');

    const noauth = await fetch(`${d.base}/api/job/${j.jobId}`);
    assert.equal(noauth.status, 401);
    const bogus = await fetch(`${d.base}/api/job/zzz`, { headers: d.h() });
    assert.equal(bogus.status, 404);
    ok('job sem token do relógio → 401; id inválido → 404');

    // cancelamento: rotina silenciosa
    R.st.mode = 'silent';
    const c = await d.agent();
    const callC = R.st.calls.at(-1).payload;
    const cr = await fetch(`${d.base}/api/job/${c.j.jobId}/cancel`, { method: 'POST', headers: d.h() });
    assert.equal((await cr.json()).status, 'cancelled');
    const late = await fetch(callC.callback.url, { method: 'POST', headers: { Authorization: `Bearer ${callC.callback.token}`, 'Content-Type': 'application/json' }, body: '{"status":"completed","text":"oi"}' });
    assert.equal(late.status, 410);
    assert.equal((await d.job(c.j.jobId)).j.status, 'cancelled');
    ok('cancelar → status cancelled; callback atrasado da rotina → 410');

    const badStatus = await d.agent();
    const callS = R.st.calls.at(-1).payload;
    const bs = await fetch(callS.callback.url, { method: 'POST', headers: { Authorization: `Bearer ${callS.callback.token}`, 'Content-Type': 'application/json' }, body: '{"status":"done","text":"x"}' });
    assert.equal(bs.status, 400); ok("status desconhecido no callback → 400");

    R.st.mode = 'http500';
    const f = await d.agent();
    assert.equal(f.r.status, 502); assert.equal((await d.job(f.j.jobId)).j.status, 'failed');
    ok('webhook com HTTP 500 → 502 e job failed');

    assert.ok(!relay.log().includes(HOOK_KEY)); ok('chave do webhook não aparece nos logs');
  } finally { relay.p.kill(); R.srv.close(); }
}

console.log('Cenário B: timeout');
{
  const R = await fakeRoutine(19101); R.st.mode = 'silent';
  const relay = await startRelay(19002, { GROKBOT_WEBHOOK_URL: 'http://127.0.0.1:19101/hook', GROKBOT_WEBHOOK_KEY: HOOK_KEY, JOB_TIMEOUT_SECONDS: '1' });
  const d = dev(19002);
  try {
    const { j } = await d.agent();
    await sleep(1300);
    const { j: t } = await d.job(j.jobId);
    assert.equal(t.status, 'timeout'); assert.match(t.text, /15 minutos/);
    const call = R.st.calls[0].payload;
    const late = await fetch(call.callback.url, { method: 'POST', headers: { Authorization: `Bearer ${call.callback.token}`, 'Content-Type': 'application/json' }, body: '{"status":"progress","text":"oi"}' });
    assert.equal(late.status, 410);
    ok('job passa do limite → timeout; callback depois → 410');
  } finally { relay.p.kill(); R.srv.close(); }
}

console.log('Cenário C: rotina simulada embutida (GROKBOT_WEBHOOK_URL=mock)');
{
  const relay = await startRelay(19003, { GROKBOT_WEBHOOK_URL: 'mock', GROKBOT_MOCK_STEP_MS: '100' });
  const d = dev(19003);
  try {
    const { r, j } = await d.agent();
    assert.equal(r.status, 202);
    const { j: fin } = await d.poll(j.jobId, (x) => x.status === 'completed');
    assert.equal(fin.steps.length, 3); assert.match(fin.text, /Simulei a tarefa/);
    ok('mock local: 3 passos + resposta final');
  } finally { relay.p.kill(); }
}

console.log('Cenário D: "Vercel" com Upstash REST falso');
{
  const KVT = 'kv-' + crypto.randomBytes(6).toString('hex');
  const U = await fakeUpstash(19200, KVT);
  const R = await fakeRoutine(19102);
  const common = { VERCEL: '1', ALLOW_MOCK: '1', GROKBOT_WEBHOOK_URL: 'http://127.0.0.1:19102/hook', GROKBOT_WEBHOOK_KEY: HOOK_KEY, PUBLIC_BASE_URL: 'http://127.0.0.1:19004' };
  // duas instâncias do relay compartilhando o KV, como funções separadas na Vercel
  const r1 = await startRelay(19004, { ...common, KV_REST_API_URL: 'http://127.0.0.1:19200', KV_REST_API_TOKEN: KVT });
  const r2 = await startRelay(19005, { ...common, KV_REST_API_URL: 'http://127.0.0.1:19200', KV_REST_API_TOKEN: KVT });
  const noKv = await startRelay(19006, { ...common });
  try {
    const { r, j } = await dev(19004).agent();
    assert.equal(r.status, 202);
    const { j: fin } = await dev(19005).poll(j.jobId, (x) => x.status === 'completed');   // outra instância
    assert.equal(fin.steps.length, 2); assert.ok(U.st.cmds > 5); assert.equal(U.st.authFail, 0);
    ok('job criado numa instância e lido em outra via Upstash REST');
    const n = await dev(19006).agent();
    assert.equal(n.r.status, 503); assert.match(n.j.error, /Upstash/);
    ok('na Vercel sem KV → 503 explicando que precisa do Upstash');
  } finally { r1.p.kill(); r2.p.kill(); noKv.p.kill(); R.srv.close(); U.srv.close(); }
}

console.log('Cenário F: Vercel sem chave de provedor não usa mock');
{
  const R = await fakeRoutine(19103);
  const KVT = 'kv-' + crypto.randomBytes(6).toString('hex');
  const U = await fakeUpstash(19201, KVT);
  const relay = await startRelay(19007, { VERCEL: '1', KV_REST_API_URL: 'http://127.0.0.1:19201', KV_REST_API_TOKEN: KVT,
    GROKBOT_WEBHOOK_URL: 'http://127.0.0.1:19103/hook', GROKBOT_WEBHOOK_KEY: HOOK_KEY });
  try {
    const h = await (await fetch('http://127.0.0.1:19007/api/health')).json();
    assert.deepEqual(h.providers, { stt: 'none', llm: 'none', tts: 'none' });
    const { r, j } = await dev(19007).agent();
    assert.equal(r.status, 502); assert.match(j.error, /OPENAI_API_KEY/);
    assert.equal(R.st.calls.length, 0);
    ok('sem OPENAI_API_KEY: /api/agent → 502 pedindo a chave, rotina NÃO é disparada');
  } finally { relay.p.kill(); R.srv.close(); U.srv.close(); }
}

console.log('Cenário E: rotas reescritas pela Vercel');
{
  const { routeInfo } = await import('../lib/jobs.js');
  const id = 'a'.repeat(32);
  assert.deepEqual(routeInfo({ url: `/api/job/${id}/audio` }), { id, op: 'audio' });
  assert.deepEqual(routeInfo({ url: `/api/job?id=${id}&op=cancel` }), { id, op: 'cancel' });
  assert.deepEqual(routeInfo({ url: `/api/callback?id=${id}` }), { id, op: '' });
  const vj = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.equal(vj.rewrites.length, 3);
  ok('id/op lidos tanto do caminho quanto do ?id=&op= dos rewrites');
}

console.log(`\nOK — ${pass} verificações do modo Grok Bot passaram.`);
