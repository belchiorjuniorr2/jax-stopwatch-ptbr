// Provedores plugáveis: STT, LLM e TTS. Chaves vêm SÓ de variáveis de ambiente.
import { pcmToWav, parseWav, toMono16, beepPcm, louder } from './wav.js';

const env = process.env;
const trimSlash = (u) => (u || '').replace(/\/+$/, '');
const OPENAI_BASE = trimSlash(env.OPENAI_BASE_URL || 'https://api.openai.com/v1');

export const DEFAULT_SYSTEM_PROMPT =
  'Você é a assistente de voz do relógio M5 do Zé. Responda sempre em português do Brasil, ' +
  'de forma natural e conversacional, em cerca de 3 a 6 frases (o bastante para uns 20 a 40 ' +
  'segundos de fala). Sem listas, sem markdown, sem emojis: o texto vai ser falado em voz alta ' +
  'e mostrado numa tela pequena e redonda.';

// Na Vercel, sem chave NÃO cai no mock (evita disparar a rotina do Grok Bot com texto falso).
// Para forçar mock lá: ALLOW_MOCK=1 ou *_PROVIDER=mock.
const mockAllowed = () => !env.VERCEL || env.ALLOW_MOCK === '1';
function pick(explicit, auto) {
  const v = (explicit || '').trim().toLowerCase();
  if (v) return v;
  return auto === 'mock' && !mockAllowed() ? 'none' : auto;
}

export function resolveProviders() {
  const stt = pick(env.STT_PROVIDER, (env.STT_API_KEY || env.OPENAI_API_KEY) ? 'openai' : 'mock');
  const llm = pick(env.LLM_PROVIDER, (env.LLM_API_KEY || env.OPENAI_API_KEY) ? 'openai' : env.XAI_API_KEY ? 'xai' : 'mock');
  const tts = pick(env.TTS_PROVIDER, env.ELEVENLABS_API_KEY ? 'elevenlabs' : (env.TTS_API_KEY || env.OPENAI_API_KEY) ? 'openai' : 'mock');
  return { stt, llm, tts };
}

async function failIfBad(r, what) {
  if (r.ok) return;
  let detail = '';
  try { detail = (await r.text()).slice(0, 300); } catch {}
  // nunca inclui cabeçalhos/chaves na mensagem
  throw new Error(`${what}: HTTP ${r.status} ${detail}`);
}

// ---------------- STT ----------------
export async function speechToText(provider, wavBuf) {
  if (provider === 'mock') {
    const w = parseWav(wavBuf);
    return `Olá relógio, isso é um teste de ${w.durationSec.toFixed(1)} segundos.`;
  }
  if (provider === 'none') throw new Error('STT sem chave: configure OPENAI_API_KEY (ou STT_API_KEY) na Vercel');
  if (provider !== 'openai') throw new Error(`STT_PROVIDER desconhecido: ${provider}`);
  const base = trimSlash(env.STT_BASE_URL) || OPENAI_BASE;
  const key = env.STT_API_KEY || env.OPENAI_API_KEY;
  const fd = new FormData();
  fd.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'fala.wav');
  fd.append('model', env.STT_MODEL || 'gpt-4o-mini-transcribe');
  fd.append('language', 'pt');
  fd.append('prompt', env.STT_PROMPT || 'Transcrição em português do Brasil (pt-BR). O usuário fala português brasileiro.');
  fd.append('response_format', 'json');
  const r = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd });
  await failIfBad(r, 'STT');
  const j = await r.json();
  return (j.text || '').trim();
}

// ---------------- LLM ----------------
export async function chat(provider, messages, turnNumber) {
  if (provider === 'mock') {
    const last = messages[messages.length - 1]?.content || '';
    return `Entendi: "${last}". Esta é a mensagem ${turnNumber} da nossa conversa.`;
  }
  let base, key, model;
  if (provider === 'none') throw new Error('LLM sem chave: configure OPENAI_API_KEY ou XAI_API_KEY na Vercel');
  if (provider === 'openai') {
    base = trimSlash(env.LLM_BASE_URL) || OPENAI_BASE;
    key = env.LLM_API_KEY || env.OPENAI_API_KEY;
    model = env.LLM_MODEL || 'gpt-4o-mini';
  } else if (provider === 'xai') {
    base = trimSlash(env.XAI_BASE_URL || 'https://api.x.ai/v1');
    key = env.XAI_API_KEY;
    model = env.XAI_MODEL || env.LLM_MODEL || 'grok-4-fast-non-reasoning';
  } else throw new Error(`LLM_PROVIDER desconhecido: ${provider}`);
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 700, temperature: 0.7 }),
  });
  await failIfBad(r, 'LLM');
  const j = await r.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

// ---------------- TTS ----------------
export const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
export function voiceFrom(req) {
  const v = String(req?.headers?.['x-voice'] || '').trim().toLowerCase();
  return OPENAI_VOICES.includes(v) ? v : '';
}

// Sempre devolve { pcm (mono 16-bit LE), sampleRate }, já normalizado e mais alto
export async function textToSpeech(provider, text, opts = {}) {
  const r = await rawTextToSpeech(provider, text, opts);
  const extraDb = Math.max(-12, Math.min(12, parseFloat(env.TTS_GAIN_DB || '3') || 0));
  return { pcm: louder(r.pcm, { extraDb }), sampleRate: r.sampleRate };
}

async function rawTextToSpeech(provider, text, opts) {
  if (provider === 'mock') {
    const sr = 24000;
    return { pcm: beepPcm(sr, [660, 880, 990]), sampleRate: sr };
  }
  if (provider === 'none') throw new Error('TTS sem chave: configure OPENAI_API_KEY ou ELEVENLABS_API_KEY na Vercel');
  if (provider === 'openai') {
    const base = trimSlash(env.TTS_BASE_URL) || OPENAI_BASE;
    const key = env.TTS_API_KEY || env.OPENAI_API_KEY;
    const r = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.TTS_MODEL || 'gpt-4o-mini-tts',
        voice: opts.voice || env.TTS_VOICE || 'alloy',
        input: text,
        response_format: 'wav',
        instructions: 'Fale em português do Brasil, tom amigável e natural, com voz bem projetada e clara, como quem fala num ambiente com barulho.',
      }),
    });
    await failIfBad(r, 'TTS');
    const buf = Buffer.from(await r.arrayBuffer());
    const w = parseWav(buf);
    return { pcm: toMono16(w), sampleRate: w.sampleRate };
  }
  if (provider === 'elevenlabs') {
    const voice = env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    const sr = 24000;
    const r = await fetch(`${trimSlash(env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io')}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=pcm_${sr}`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/pcm' },
      body: JSON.stringify(elevenBody(text)),
    });
    await failIfBad(r, 'TTS ElevenLabs');
    return { pcm: Buffer.from(await r.arrayBuffer()), sampleRate: sr };
  }
  throw new Error(`TTS_PROVIDER desconhecido: ${provider}`);
}

function elevenBody(text) {
  const model_id = env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
  const b = { text, model_id };
  if (/v2_5|v3/.test(model_id)) b.language_code = 'pt'; // só modelos que aceitam language_code
  return b;
}

export { pcmToWav };
