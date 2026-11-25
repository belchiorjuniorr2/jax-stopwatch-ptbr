"""Local utterance gating and explicit wake-name / assistant routing.

No audio or unmatched transcription is persisted by this module.
"""
import re
import unicodedata
from collections import deque
from dataclasses import dataclass

import numpy as np


SEPARATORS = " \t\r\n，,。.!！?？:：;；、~～"
NAME_ALIASES = {"Jax": ("Jax", "Jacs", "Jacks", "Jaques", "Jacques")}
AGENT_ALIASES = {
    "codex": ("codex", "codec", "assistente de codigo", "assistente de código", "codigo", "código"),
    "grok": ("grok bot", "grokbot", "grok", "groke"),
}


@dataclass(frozen=True)
class VoiceIntent:
    kind: str  # wake, select, command
    text: str = ""
    agent: str | None = None


def validate_name(name):
    if not isinstance(name, str):
        raise ValueError("Digite o nome do mascote")
    name = unicodedata.normalize("NFKC", name).strip()
    if not 2 <= len(name) <= 12 or not all(c.isalnum() for c in name):
        raise ValueError("O nome deve ter 2–12 letras ou números, sem espaços nem pontuação")
    return name


def parse_voice(text, name, *, armed=False):
    """Only an anchored name or an explicitly armed follow-up admits a task."""
    text = unicodedata.normalize("NFKC", text).strip(SEPARATORS)
    aliases = NAME_ALIASES.get(name, (name,))
    names = "|".join(re.escape(x) for x in sorted(aliases, key=len, reverse=True))
    prefix = re.compile(r"^(?:(?:ei|oi|olá|ola|fala|alô|alo|hey|e aí|e ai)[\s，,。.!！]*)?(?:" + names + r")", re.I)
    matched = False
    while True:
        m = prefix.match(text)
        if not m:
            break
        # Do not treat a longer Latin word as this pet's name.
        if m.end() < len(text) and text[m.end()-1].isascii() and text[m.end()].isascii() and text[m.end()].isalnum():
            break
        matched = True
        text = text[m.end():].lstrip(SEPARATORS)
    if not matched and not armed:
        return None
    if not text:
        return VoiceIntent("wake") if matched else None
    for agent, aliases in AGENT_ALIASES.items():
        pattern = "|".join(re.escape(x) for x in sorted(aliases, key=len, reverse=True))
        m = re.match(
            r"^(?:por favor|pfv)?"
            r"(?:deixa(?:r)?(?:\s+(?:o|a|pro|pra|para(?:\s+o)?))?|"
            r"manda(?:r)?(?:\s+(?:o|pro|pra))?|"
            r"pede(?:r)?(?:\s+(?:pro|pra|para(?:\s+o)?|ao))?|"
            r"usa(?:r)?(?:\s+o)?|"
            r"chama(?:r)?(?:\s+o)?|"
            r"troca(?:r)?(?:\s+(?:para|pro|pra)(?:\s+o)?)?|"
            r"mudar?(?:\s+(?:para|pro|pra)(?:\s+o)?)?|"
            r"pergunta(?:r)?(?:\s+(?:ao|pro|pra|para(?:\s+o)?))?|"
            r"abre(?:r)?(?:\s+o)?|"
            r"escolhe(?:r)?(?:\s+o)?|"
            r"use|switch\s+to|ask)?"
            r"[\s，,:：]*(?:" + pattern + r")(?=$|[^a-zA-Z])",
            text,
            re.I,
        )
        if m:
            command = text[m.end():].strip(SEPARATORS)
            return VoiceIntent("command" if command else "select", command, agent)
    return VoiceIntent("command", text)


class UtteranceGate:
    """Bounded utterance segmenter for the device's 16 kHz PCM stream.

    Firmware supplies a 500 ms pre-roll and 1 s post-speech tail. A second
    300 ms local pre-roll protects soft initial syllables. Overlong input is
    discarded through its next quiet boundary, never submitted as fragments.
    """
    def __init__(self, silence_seconds=.80, max_seconds=20, min_voice_seconds=.24):
        self.silence_seconds = silence_seconds
        self.max_bytes = int(max_seconds * 32000)
        self.min_voice_seconds = min_voice_seconds
        self.noise = .001
        self.last_rms = 0.
        self.reset()

    def reset(self):
        self.pre = deque()
        self.pre_bytes = 0
        self.audio = bytearray()
        self.voice_seconds = 0.
        self.silence = 0.
        self.dropping = False

    def feed(self, pcm, speech_probability=None):
        if not pcm or len(pcm) % 2:
            return None
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.
        samples -= samples.mean()
        rms = float(np.sqrt(np.mean(samples * samples)))
        self.last_rms = rms
        duration = len(pcm) / 32000.
        threshold = max(.0035 if self.audio else .005, self.noise * 2.8)
        voiced = rms >= threshold
        if speech_probability is not None:
            voiced = speech_probability >= (.35 if self.audio else .5)
        if not voiced and not self.audio and not self.dropping:
            self.noise = self.noise * .98 + min(rms, .012) * .02
        if self.dropping:
            self.silence = 0. if voiced else self.silence + duration
            if self.silence >= self.silence_seconds:
                self.reset()
            return None
        if not self.audio:
            self.pre.append(bytes(pcm))
            self.pre_bytes += len(pcm)
            while self.pre_bytes > 9600 and len(self.pre) > 1:
                self.pre_bytes -= len(self.pre.popleft())
            if not voiced:
                return None
            self.audio.extend(b"".join(self.pre))
            self.pre.clear()
            self.pre_bytes = 0
        else:
            self.audio.extend(pcm)
        if voiced:
            self.voice_seconds += duration
            self.silence = 0.
        else:
            self.silence += duration
        if len(self.audio) > self.max_bytes:
            self.reset()
            self.dropping = True
            return None
        if self.silence >= self.silence_seconds:
            result = bytes(self.audio) if self.voice_seconds >= self.min_voice_seconds else None
            self.reset()
            return result
        return None

    def finish(self):
        """End the phrase when the firmware gate stops sending audio before local silence is reached."""
        result = bytes(self.audio) if self.audio and not self.dropping and self.voice_seconds >= self.min_voice_seconds else None
        self.reset()
        return result


class SileroVoice:
    """Local CPU-only Silero VAD, using a pinned official model file."""
    def __init__(self, model_path):
        self.model_path = model_path
        self.model = None
        self.pending = bytearray()
        self.last_probability = 0.

    def load(self):
        if self.model is None:
            import torch
            torch.set_num_threads(1)
            self.model = torch.jit.load(str(self.model_path), map_location="cpu")
            self.model.eval()
            self.reset()

    def reset(self):
        self.pending.clear()
        self.last_probability = 0.
        if self.model is not None:
            self.model.reset_states()

    def probability(self, pcm):
        import torch
        self.pending.extend(pcm)
        values = []
        while len(self.pending) >= 1024:
            block = bytes(self.pending[:1024])
            del self.pending[:1024]
            audio = np.frombuffer(block, dtype="<i2").astype(np.float32) / 32768.
            audio -= audio.mean()
            with torch.inference_mode():
                values.append(float(self.model(torch.from_numpy(audio), 16000).item()))
        if values:
            self.last_probability = max(values)
        return self.last_probability
