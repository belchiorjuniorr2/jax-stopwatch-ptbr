// Testes: retentativa de callback após 403 da borda da Vercel (dedupe + passos de reserva),
// áudio mais alto sem estourar, e escolha de voz por cabeçalho X-Voice.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { louder, beepPcm } from '../lib/wav.js';
import { startFakeUpstream } from './fake-upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const wavIn = fs.readFileSync(path.join(here, 'sample.wav'));
const TOKEN = crypto.randomBytes(16).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const ok = (n) => { pass++; console.log('  ✔', n); };

function startRelay(port, extraEnv) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(OPENAI|XAI|ELEVENLABS|STT_|LLM_|TTS_|KV_|UPSTASH|DEVICE_TOKEN|GROKBOT|VERCEL|JOB_|PUBLIC_BASE)/.test(k)));
  const p = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...clean, PORT: String(port), DEVICE_TOKEN: TOKEN, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay não subiu: ' + log)), 5000);
    p.stdout.on('data', () => { if (log.includes('ouvindo')) { clearTimeout(t); resolve({ p }); } });
  });
}
const H = { Authorization: `Bearer ${TOKEN}`, 'X-Device-Id': 'w1' };

// ---------------------------------------------------------------
console.log('Cenário R: callback de progresso bloqueado (403 na borda) e reenviado');
{
  // "Borda" falsa na frente do relay: bloqueia a 1ª tentativa de cada progresso com 403 (como a
  // mitigação de DDoS da Vercel fez com os IPs da rotina), as seguintes passam.
  const RELAY = 19301, EDGE = 19302;
  const relay = await startRelay(RELAY, { GROKBOT_WEBHOOK_URL: 'http://127.0.0.1:19303/hook', GROKBOT_WEBHOOK_KEY: 'k', PUBLIC_BASE_URL: `http://127.0.0.1:${EDGE}` });
  const seenBodies = new Map(); let blocked = 0;
  const edge = http.createServer((req, res) => {
    const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      const body = Buffer.concat(c).toString();
      const n = (seenBodies.get(body) || 0) + 1; seenBodies.set(body, n);
      if (body.includes('"progress"') && n === 1) { blocked++; res.statusCode = 403; return res.end('{"error":{"code":"403","message":"Forbidden"}}'); }
      const up = http.request({ host: '127.0.0.1', port: RELAY, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.end(body);
    });
  }).listen(EDGE, '127.0.0.1');
  let payload;
  const hook = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { payload = JSON.parse(Buffer.concat(c)); res.end('{}'); }); }).listen(19303, '127.0.0.1');
  try {
    const a = await (await fetch(`http://127.0.0.1:${RELAY}/api/agent`, { method: 'POST', body: wavIn, headers: H })).json();
    // rotina com a política de reenvio do ROTINA-GROK-BOT.md: 403/429/5xx → tenta de novo
    async function post(body) {
      for (let i = 0; i < 4; i++) {
        const r = await fetch(payload.callback.url, { method: 'POST', headers: { Authorization: `Bearer ${payload.callback.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status === 200) return 200;
        if (r.status === 401 || r.status === 410) return r.status;
        await sleep(50 * (i + 1));
      }
      return 0;
    }
    assert.equal(await post({ status: 'progress', text: 'Entendi, começando…' }), 200);
    assert.equal(await post({ status: 'progress', text: 'Buscando no Gmail…' }), 200);
    // reenvio "fantasma": a 1ª chegou mas a resposta se perdeu → não pode duplicar
    const dup = await fetch(payload.callback.url, { method: 'POST', headers: { Authorization: `Bearer ${payload.callback.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'progress', text: 'Buscando no Gmail…' }) });
    assert.equal((await dup.json()).duplicate, true);
    // final com passos de reserva (um deles nunca chegou)
    assert.equal(await post({ status: 'completed', text: 'Pronto.', steps: ['Entendi, começando…', 'Buscando no Gmail…', 'Resumindo…'] }), 200);
    const j = await (await fetch(`http://127.0.0.1:${RELAY}/api/job/${a.jobId}`, { headers: H })).json();
    assert.equal(blocked, 2);
    assert.deepEqual(j.steps, ['Entendi, começando…', 'Buscando no Gmail…', 'Resumindo…']);
    assert.equal(j.status, 'completed');
    ok('progresso bloqueado com 403 é reenviado e chega uma vez só; final completa passos perdidos');
  } finally { relay.p.kill(); edge.close(); hook.close(); }
}

console.log('Cenário L: áudio mais alto sem estourar');
{
  const quiet = Buffer.from(beepPcm(24000, [440], 300, 0)); // pico ~9000
  for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(Math.round(quiet.readInt16LE(i) / 3), i); // pico ~3000
  const peak = (b) => { let p = 0; for (let i = 0; i < b.length; i += 2) p = Math.max(p, Math.abs(b.readInt16LE(i))); return p; };
  const rms = (b) => { let s = 0; for (let i = 0; i < b.length; i += 2) s += b.readInt16LE(i) ** 2; return Math.sqrt(s / (b.length / 2)); };
  const out = louder(quiet, { extraDb: 3 });
  assert.ok(peak(out) > 3 * peak(quiet), `pico ${peak(quiet)} → ${peak(out)}`);
  assert.ok(peak(out) <= 32767 && rms(out) > 2.5 * rms(quiet));
  const loud = Buffer.from(beepPcm(24000, [440], 300, 0)); for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(Math.max(-32767, Math.min(32767, loud.readInt16LE(i) * 4)), i);
  assert.ok(peak(louder(loud, { extraDb: 6 })) <= 32767);
  ok(`voz baixa sobe ${(rms(out) / rms(quiet)).toFixed(1)}x em RMS; limitador segura o pico ≤ 32767`);
}

console.log('Cenário V: voz escolhida no relógio (X-Voice)');
{
  const up = await startFakeUpstream(19310);
  const relay = await startRelay(19311, { OPENAI_API_KEY: 'fake', OPENAI_BASE_URL: 'http://127.0.0.1:19310/v1' });
  try {
    for (const [hdr, want] of [['nova', 'nova'], ['NÃO-EXISTE', 'alloy'], ['', 'alloy']]) {
      const r = await fetch('http://127.0.0.1:19311/api/voz', { method: 'POST', body: wavIn, headers: { ...H, ...(hdr ? { 'X-Voice': encodeURIComponent(hdr) } : {}) } });
      await r.arrayBuffer(); assert.equal(r.status, 200);
      assert.equal(up.seen.filter((x) => x.path.endsWith('/audio/speech')).at(-1).voice, want);
    }
    ok('X-Voice válido muda a voz; inválido/vazio usa o padrão');
  } finally { relay.p.kill(); up.srv.close(); }
}
console.log(`\nOK — ${pass} verificações extras passaram.`);
