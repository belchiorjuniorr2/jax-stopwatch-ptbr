// Teste ponta a ponta do relay: sobe o servidor local e simula o relógio.
// Uso: node test/e2e.mjs        (não precisa de chave; usa mock e um upstream falso)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseWav } from '../lib/wav.js';
import { startFakeUpstream } from './fake-upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const outDir = path.join(here, 'out');
fs.mkdirSync(outDir, { recursive: true });
const sample = path.join(here, 'sample.wav');

// WAV de exemplo: 16 kHz mono 16-bit, 2,5 s (mesmo formato que o relógio envia)
if (!fs.existsSync(sample)) {
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2.5', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', sample]);
  } catch {
    const { pcmToWav, beepPcm } = await import('../lib/wav.js');
    fs.writeFileSync(sample, pcmToWav(beepPcm(16000, [300, 400, 500], 800, 0), 16000));
  }
}
const wavIn = fs.readFileSync(sample);
const TOKEN = crypto.randomBytes(16).toString('hex');

function startRelay(port, extraEnv) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(OPENAI|XAI|ELEVENLABS|STT_|LLM_|TTS_|KV_|UPSTASH|DEVICE_TOKEN)/.test(k)));
  const p = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...clean, PORT: String(port), DEVICE_TOKEN: TOKEN, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('relay não subiu: ' + log)), 5000);
    p.stdout.on('data', () => { if (log.includes('ouvindo')) { clearTimeout(t); resolve({ p, getLog: () => log }); } });
  });
}

async function talk(port, dev, body = wavIn, token = TOKEN) {
  const r = await fetch(`http://127.0.0.1:${port}/api/voz`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${token}`, 'X-Device-Id': dev },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return { r, buf, reply: decodeURIComponent(r.headers.get('x-reply') || ''), transcript: decodeURIComponent(r.headers.get('x-transcript') || '') };
}

let pass = 0;
const ok = (name) => { pass++; console.log('  ✔', name); };

// ---------- 1) Modo mock (sem nenhuma chave) ----------
console.log('Cenário 1: provedores mock');
{
  const port = 18787;
  const relay = await startRelay(port, {});
  try {
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.deepEqual(h.providers, { stt: 'mock', llm: 'mock', tts: 'mock' }); ok('health indica mock');

    const a = await talk(port, 'aa:bb:cc:01');
    assert.equal(a.r.status, 200); assert.equal(a.r.headers.get('content-type'), 'audio/wav');
    const w = parseWav(a.buf);
    assert.equal(w.channels, 1); assert.equal(w.bitsPerSample, 16); assert.ok([16000, 24000].includes(w.sampleRate));
    assert.equal(Number(a.r.headers.get('x-sample-rate')), w.sampleRate);
    fs.writeFileSync(path.join(outDir, 'resposta-mock.wav'), a.buf);
    assert.match(a.transcript, /2\.5 segundos/); assert.match(a.reply, /mensagem 1 /); ok(`resposta WAV ${w.sampleRate} Hz mono, texto: "${a.reply}"`);

    const b = await talk(port, 'aa:bb:cc:01');
    assert.match(b.reply, /mensagem 2 /); ok('memória por dispositivo (2ª mensagem)');
    const c = await talk(port, 'aa:bb:cc:02');
    assert.match(c.reply, /mensagem 1 /); ok('outro dispositivo tem memória separada');

    const rs = await fetch(`http://127.0.0.1:${port}/api/reset`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Device-Id': 'aa:bb:cc:01' } });
    assert.equal(rs.status, 200);
    const d = await talk(port, 'aa:bb:cc:01');
    assert.match(d.reply, /mensagem 1 /); ok('reset limpa a memória');

    const bad = await talk(port, 'x', wavIn, 'token-errado');
    assert.equal(bad.r.status, 401); ok('token errado → 401');
    const junk = await talk(port, 'x', Buffer.from('não sou wav'));
    assert.equal(junk.r.status, 400); ok('corpo não-WAV → 400');
    const pcm = await fetch(`http://127.0.0.1:${port}/api/voz?format=pcm`, { method: 'POST', body: wavIn, headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(pcm.headers.get('content-type'), 'audio/L16'); await pcm.arrayBuffer(); ok('format=pcm devolve PCM cru');
  } finally { relay.p.kill(); }
}

// ---------- 2) Caminho OpenAI-compatível (STT+LLM+TTS) contra upstream falso ----------
console.log('Cenário 2: provedor OpenAI-compatível (upstream falso)');
const up = await startFakeUpstream(18900);
{
  const port = 18788;
  const relay = await startRelay(port, { OPENAI_API_KEY: 'fake-test-key', OPENAI_BASE_URL: 'http://127.0.0.1:18900/v1' });
  try {
    const a = await talk(port, 'dev-oa');
    assert.equal(a.r.status, 200, a.buf.toString());
    assert.equal(a.r.headers.get('x-providers'), 'openai,openai,openai');
    assert.equal(a.transcript, 'Qual é a capital de Minas Gerais?');
    assert.match(a.reply, /Belo Horizonte, gpt-4o-mini! Já são 1 perguntas, ação\./);
    const w = parseWav(a.buf); assert.equal(w.channels, 1); assert.equal(w.sampleRate, 24000);
    ok(`STT multipart pt + chat + TTS wav estéreo→mono; acentos ok: "${a.reply}"`);
    const b = await talk(port, 'dev-oa');
    assert.match(b.reply, /2 perguntas/); ok('histórico enviado ao LLM');
    assert.ok(!relay.getLog().includes('fake-test-key')); ok('chave não aparece no log');
  } finally { relay.p.kill(); }
}

// ---------- 3) xAI no LLM + ElevenLabs no TTS ----------
console.log('Cenário 3: xAI (LLM) + ElevenLabs (TTS) + STT OpenAI-compatível');
{
  const port = 18789;
  const relay = await startRelay(port, {
    STT_API_KEY: 'fake-stt', STT_BASE_URL: 'http://127.0.0.1:18900/v1',
    XAI_API_KEY: 'fake-xai', XAI_BASE_URL: 'http://127.0.0.1:18900/v1',
    ELEVENLABS_API_KEY: 'fake-11', ELEVENLABS_BASE_URL: 'http://127.0.0.1:18900',
  });
  try {
    const a = await talk(port, 'dev-x');
    assert.equal(a.r.status, 200, a.buf.toString());
    assert.equal(a.r.headers.get('x-providers'), 'openai,xai,elevenlabs');
    assert.match(a.reply, /grok-4-fast-non-reasoning/);
    assert.equal(parseWav(a.buf).sampleRate, 24000);
    ok('roteamento automático pelas chaves: openai / xai / elevenlabs');
  } finally { relay.p.kill(); }
}
up.srv.close();

// ---------- 4) Simulação do runtime da Vercel (req.body já vem como Buffer) ----------
console.log('Cenário 4: export default de api/voz.js como na Vercel');
{
  process.env.DEVICE_TOKEN = TOKEN;
  for (const k of Object.keys(process.env)) if (/^(OPENAI|XAI|ELEVENLABS|STT_|LLM_|TTS_)/.test(k)) delete process.env[k];
  const { default: voz } = await import('../api/voz.js');
  const { default: health } = await import('../api/health.js');
  const http = await import('node:http');
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { req.body = Buffer.concat(chunks); (req.url.startsWith('/api/health') ? health : voz)(req, res); });
  });
  await new Promise((r) => srv.listen(18790, '127.0.0.1', r));
  const a = await talk(18790, 'vercel-dev');
  assert.equal(a.r.status, 200); parseWav(a.buf); ok('handler funciona com corpo pré-lido (estilo Vercel)');
  srv.close();
}
console.log(`\nOK — ${pass} verificações passaram.`);
