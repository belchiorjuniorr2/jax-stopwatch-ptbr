// Upstream falso compatível com OpenAI (+ ElevenLabs) para testar os caminhos reais dos provedores sem chave.
import http from 'node:http';
import { pcmToWav, beepPcm } from '../lib/wav.js';

export function startFakeUpstream(port) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers['authorization'] || req.headers['xi-api-key'] || '';
      seen.push({ path: req.url, auth: auth ? 'present' : 'missing', ct: req.headers['content-type'] || '' });
      if (!auth) { res.statusCode = 401; return res.end('{"error":"no key"}'); }
      if (req.url.endsWith('/audio/transcriptions')) {
        const ok = body.includes(Buffer.from('RIFF')) && body.includes(Buffer.from('name="language"')) && body.includes(Buffer.from('name="prompt"'));
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ text: ok ? 'Qual é a capital de Minas Gerais?' : '' }));
      }
      if (req.url.endsWith('/chat/completions')) {
        const j = JSON.parse(body.toString());
        const n = j.messages.filter((m) => m.role === 'user').length;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ choices: [{ message: { content: `É Belo Horizonte, ${j.model}! Já são ${n} perguntas, ação.` } }] }));
      }
      if (req.url.endsWith('/audio/speech')) {
        try { seen[seen.length - 1].voice = JSON.parse(body.toString()).voice; } catch {}
        // OpenAI devolve WAV 24 kHz; aqui simulamos estéreo para testar a conversão p/ mono
        const mono = beepPcm(24000, [500]);
        const st = Buffer.alloc(mono.length * 2);
        for (let i = 0; i < mono.length / 2; i++) { const s = mono.readInt16LE(i * 2); st.writeInt16LE(s, i * 4); st.writeInt16LE(s, i * 4 + 2); }
        res.setHeader('Content-Type', 'audio/wav');
        return res.end(pcmToWav(st, 24000, 2));
      }
      if (req.url.startsWith('/v1/text-to-speech/')) {
        res.setHeader('Content-Type', 'audio/pcm');
        return res.end(beepPcm(24000, [700, 800]));
      }
      res.statusCode = 404; res.end('nope');
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, seen })));
}
