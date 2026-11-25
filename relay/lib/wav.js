// Utilidades WAV/PCM (16-bit little-endian, mono)

export function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('não é WAV RIFF/WAVE');
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === 'data' && (size === 0 || size === 0xffffffff || start + size > buf.length)) size = buf.length - start;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
      break;
    }
    off = start + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV sem fmt/data');
  return { ...fmt, data, durationSec: data.length / (fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8)) };
}

export function pcmToWav(pcm, sampleRate, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bits / 8;
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(channels * bits / 8, 32);
  h.writeUInt16LE(bits, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Normaliza qualquer WAV PCM16 recebido do TTS para mono 16-bit (mantém a taxa).
export function toMono16(wav) {
  if (wav.format !== 1 || wav.bitsPerSample !== 16) throw new Error('TTS devolveu WAV não-PCM16');
  if (wav.channels === 1) return wav.data;
  const frames = wav.data.length / (2 * wav.channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < wav.channels; c++) s += wav.data.readInt16LE((i * wav.channels + c) * 2);
    out.writeInt16LE(Math.round(s / wav.channels), i * 2);
  }
  return out;
}

// Tons simples (usado pelo mock de TTS)
export function beepPcm(sampleRate, freqs, msEach = 180, gap = 60) {
  const parts = [];
  for (const f of freqs) {
    const n = Math.round(sampleRate * msEach / 1000), b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 200, (n - i) / 200);
      b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * f * i / sampleRate) * 9000 * env), i * 2);
    }
    parts.push(b, Buffer.alloc(Math.round(sampleRate * gap / 1000) * 2));
  }
  return Buffer.concat(parts);
}

// Deixa a voz mais alta sem estourar: normaliza o pico para ~-1 dBFS (ganho máx. limitado)
// e aplica um limitador suave. TTS_GAIN_DB (env) soma um ganho extra antes do limitador.
export function louder(pcm, { maxGain = 4, extraDb = 0 } = {}) {
  const n = pcm.length >> 1;
  if (!n) return pcm;
  let peak = 1;
  for (let i = 0; i < n; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)); if (v > peak) peak = v; }
  const g = Math.min(maxGain, 32000 / peak) * Math.pow(10, extraDb / 20);
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < n; i++) {
    let x = (pcm.readInt16LE(i * 2) * g) / 32767;
    // limitador suave (aprox. tanh): linear até ~0,6, satura sem quinas acima disso
    if (Math.abs(x) > 0.6) { const sgn = Math.sign(x), a = Math.abs(x); x = sgn * (0.6 + 0.4 * Math.tanh((a - 0.6) / 0.4)); }
    out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x * 32767))), i * 2);
  }
  return out;
}

// Estatísticas de PCM16 mono (ou do buffer data de parseWav) para diagnóstico do microfone.
export function pcmStats(wav) {
  const data = wav.data || wav;
  const n = (data.length / 2) | 0;
  let sum = 0, sq = 0, peak = 0, clips = 0;
  for (let i = 0; i < n; i++) {
    const v = data.readInt16LE(i * 2);
    sum += v;
    sq += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 32700) clips++;
  }
  const dc = n ? Math.round(sum / n) : 0;
  const rms = n ? Math.round(Math.sqrt(sq / n)) : 0;
  const sampleRate = wav.sampleRate || 0;
  const durationSec = sampleRate ? n / sampleRate : (wav.durationSec || 0);
  return { samples: n, sampleRate, durationSec, rms, peak, dc, clips };
}

