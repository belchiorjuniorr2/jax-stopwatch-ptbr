// Handler único usado pela Vercel (api/*.js) e pelo servidor local (server.js).
import { parseWav, pcmToWav, pcmStats } from './wav.js';
import { resolveProviders, speechToText, chat, textToSpeech, voiceFrom, DEFAULT_SYSTEM_PROMPT } from './providers.js';
import { send, json, readBody, authorized, deviceIdOf, hdr } from './http.js';
import { getHistory, appendTurn, clearHistory, memoryBackend } from './memory.js';

export async function handleHealth(req, res) {
  const p = resolveProviders();
  json(res, 200, {
    ok: true, providers: p, memory: memoryBackend(), tokenConfigured: !!process.env.DEVICE_TOKEN,
    grokBot: process.env.GROKBOT_WEBHOOK_URL === 'mock' || process.env.GROKBOT_MOCK === '1' ? 'mock'
      : process.env.GROKBOT_WEBHOOK_URL ? 'configured' : 'off',
  });
}

export async function handleReset(req, res) {
  if (!authorized(req)) return json(res, 401, { error: 'não autorizado' });
  await clearHistory(deviceIdOf(req));
  json(res, 200, { ok: true });
}

export async function handleVoz(req, res) {
  const t0 = Date.now();
  if (req.method !== 'POST') return json(res, 405, { error: 'use POST com audio/wav' });
  if (!authorized(req)) return json(res, 401, { error: 'não autorizado' });
  const deviceId = deviceIdOf(req);
  const providers = resolveProviders();
  try {
    const body = await readBody(req);
    let wav;
    try { wav = parseWav(body); } catch (e) { return json(res, 400, { error: `WAV inválido: ${e.message}` }); }
    if (wav.durationSec < 0.3) return json(res, 400, { error: 'áudio curto demais' });

    const st = pcmStats(wav);
    console.log(`[voz] wav samples=${st.samples} sr=${st.sampleRate} dur=${st.durationSec.toFixed(2)}s rms=${st.rms} peak=${st.peak} dc=${st.dc} clips=${st.clips}`);
    const transcript = await speechToText(providers.stt, body);
    const t1 = Date.now();

    let reply;
    if (!transcript) {
      reply = 'Não consegui ouvir direito. Pode repetir?';
    } else {
      const history = await getHistory(deviceId);
      const messages = [
        { role: 'system', content: process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT },
        ...history,
        { role: 'user', content: transcript },
      ];
      reply = await chat(providers.llm, messages, history.length / 2 + 1);
      if (!reply) reply = 'Fiquei sem resposta agora. Tenta de novo?';
      await appendTurn(deviceId, transcript, reply);
    }
    const t2 = Date.now();

    const { pcm, sampleRate } = await textToSpeech(providers.tts, reply, { voice: voiceFrom(req) });
    const t3 = Date.now();

    const url = new URL(req.url, 'http://x');
    const wantPcm = url.searchParams.get('format') === 'pcm';
    const out = wantPcm ? pcm : pcmToWav(pcm, sampleRate);
    console.log(`[voz] ${deviceId} in=${wav.durationSec.toFixed(1)}s stt=${t1 - t0}ms llm=${t2 - t1}ms tts=${t3 - t2}ms out=${out.length}B`);
    send(res, 200, {
      'Content-Type': wantPcm ? 'audio/L16' : 'audio/wav',
      'Content-Length': String(out.length),
      'X-Sample-Rate': String(sampleRate),
      'X-Transcript': hdr(transcript || '', 600),
      'X-Reply': hdr(reply),
      'X-Providers': `${providers.stt},${providers.llm},${providers.tts}`,
      'Cache-Control': 'no-store',
    }, out);
  } catch (e) {
    console.error('[voz] erro:', e.message);
    json(res, e.status || 502, { error: String(e.message).slice(0, 300) });
  }
}
