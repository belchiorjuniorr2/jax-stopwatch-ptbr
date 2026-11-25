import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from wake import UtteranceGate, parse_voice, validate_name
import bridge as module


class VoiceRoutingTests(unittest.TestCase):
    def test_ambient_or_mid_sentence_name_cannot_submit(self):
        for text in ("apaga o arquivo", "queria trocar o nome do Jax", "hoje vamos falar do Codex", "Pony, calcula pra mim"):
            with self.subTest(text=text):
                self.assertIsNone(parse_voice(text, "Jax"))

    def test_repeated_name_and_codex_alias(self):
        intent = parse_voice("Jax, Jax, pede pro Codex anotar um recado.", "Jax")
        self.assertEqual((intent.kind, intent.agent, intent.text), ("command", "codex", "anotar um recado"))

    def test_grok_route_and_local_switch(self):
        intent = parse_voice("Jax, pede pro Grok Bot somar dezenove mais vinte e três.", "Jax")
        self.assertEqual((intent.agent, intent.text), ("grok", "somar dezenove mais vinte e três"))
        self.assertEqual(parse_voice("Jax, trocar para Codex.", "Jax").kind, "select")
        self.assertEqual(parse_voice("Jacs, mudar para o Codex.", "Jax").kind, "select")
        self.assertEqual(parse_voice("Jacks, pede pro Grok somar um mais um", "Jax").agent, "grok")
        intent = parse_voice("Jax, abre o Grok Bot e vê quantos seguidores eu tenho agora.", "Jax")
        self.assertEqual((intent.agent, intent.text), ("grok", "e vê quantos seguidores eu tenho agora"))

    def test_name_only_and_followup_entitlement(self):
        self.assertEqual(parse_voice("Oi, Jax.", "Jax").kind, "wake")
        self.assertIsNone(parse_voice("um mais um", "Jax"))
        self.assertEqual(parse_voice("um mais um", "Jax", armed=True).text, "um mais um")

    def test_custom_name_and_latin_boundaries(self):
        self.assertIsNone(parse_voice("Jax, calcula", "Pony"))
        self.assertEqual(parse_voice("Pony, usa o Codex e calcula", "Pony").agent, "codex")
        self.assertIsNone(parse_voice("Jaxson hello", "Jax"))
        self.assertIsNone(parse_voice("Jax, Codexx o que e isso", "Jax").agent)
        for bad in ("", "A", "<script>", "Ja x", "nome" * 7):
            with self.assertRaises(ValueError):
                validate_name(bad)


class GateTests(unittest.TestCase):
    def setUp(self):
        self.quiet = bytes(1280)
        wave = np.sin(np.arange(640) * 2 * np.pi * 300 / 16000) * 5000
        self.voice = wave.astype("<i2").tobytes()

    def test_quiet_and_clicks_are_discarded(self):
        gate = UtteranceGate()
        for pcm in [self.quiet] * 30 + [self.voice] + [self.quiet] * 30:
            self.assertIsNone(gate.feed(pcm))

    def test_vad_rejects_loud_non_speech(self):
        gate = UtteranceGate()
        for _ in range(100):
            self.assertIsNone(gate.feed(self.voice, speech_probability=.01))
        self.assertFalse(gate.audio)

    def test_phrase_keeps_preroll_and_finishes_once(self):
        gate = UtteranceGate()
        results = [gate.feed(pcm) for pcm in [self.quiet]*10 + [self.voice]*15 + [self.quiet]*30]
        complete = [x for x in results if x]
        self.assertEqual(len(complete), 1)
        self.assertTrue(complete[0].startswith(self.quiet))
        self.assertGreater(len(complete[0]), 15 * len(self.voice))

    def test_overlong_speech_is_never_dispatched_as_partial(self):
        gate = UtteranceGate(max_seconds=1)
        for pcm in [self.voice]*70 + [self.quiet]*30:
            self.assertIsNone(gate.feed(pcm))
        results = [gate.feed(pcm) for pcm in [self.voice]*8 + [self.quiet]*22]
        # Tail is also bounded; use a larger limit to test recovery separately.
        self.assertFalse(any(results))
        gate.max_bytes = 32000 * 3
        results = [gate.feed(pcm) for pcm in [self.quiet]*30 + [self.voice]*8 + [self.quiet]*22]
        self.assertEqual(sum(bool(x) for x in results), 1)

    def test_finish_submits_phrase_when_stream_stops(self):
        gate = UtteranceGate()
        loud = (np.sin(np.arange(640) / 3) * 3000).astype("<i2").tobytes()
        quiet = np.zeros(640, dtype="<i2").tobytes()
        for _ in range(10):
            self.assertIsNone(gate.feed(loud, .9))
        for _ in range(17):
            self.assertIsNone(gate.feed(quiet, 0.))
        self.assertTrue(gate.finish())
        self.assertFalse(gate.audio)
        self.assertIsNone(gate.finish())

    def test_reset_drops_partial_recording(self):
        gate = UtteranceGate()
        for _ in range(15):
            gate.feed(self.voice)
        gate.reset()
        self.assertFalse(any(gate.feed(self.quiet) for _ in range(30)))


class BridgeWakeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        (root / "runtime").mkdir()
        self.root_patch = patch.object(module, "ROOT", root)
        self.runtime_patch = patch.object(module, "RUNTIME", root / "runtime")
        self.root_patch.start(); self.runtime_patch.start()
        self.addCleanup(self.root_patch.stop); self.addCleanup(self.runtime_patch.stop)
        self.bridge = module.Bridge()
        self.bridge.state.update(connected=True, phase="ready")
        self.bridge.wake_enabled = True
        self.bridge.device.connected = True
        self.bridge.device.idle = AsyncMock()
        self.bridge.execute = AsyncMock()
        self.bridge.speak = AsyncMock()

    async def test_ambient_audio_leaves_no_text_log_or_agent_call(self):
        self.bridge.speech.transcribe = Mock(return_value="amanha de tarde vou passear")
        await self.bridge.process_wake_audio(b"test", 0, False)
        self.bridge.execute.assert_not_awaited()
        self.assertEqual(self.bridge.history, [])

    async def test_wake_routes_only_stripped_command(self):
        self.bridge.speech.transcribe = Mock(return_value="Jax, pede pro Grok responder dezenove mais vinte e tres")
        await self.bridge.process_wake_audio(b"test", 0, False)
        self.assertEqual(self.bridge.state["agent"], "grok")
        self.bridge.execute.assert_awaited_once_with("responder dezenove mais vinte e tres")

    async def test_stale_audio_after_disconnect_cannot_submit(self):
        self.bridge.speech.transcribe = Mock(return_value="Jax, executa a tarefa")
        self.bridge.wake_epoch = 1
        await self.bridge.process_wake_audio(b"test", 0, False)
        self.bridge.execute.assert_not_awaited()

    async def test_name_only_arms_one_followup(self):
        self.bridge.speech.transcribe = Mock(return_value="Jax")
        await self.bridge.process_wake_audio(b"test", 0, False)
        self.bridge.speak.assert_awaited_once_with("Estou aqui. Pode falar.")
        self.assertTrue(self.bridge.wake_status()["awaitingCommand"])
        self.bridge.speech.transcribe = Mock(return_value="calcula um mais um")
        await self.bridge.process_wake_audio(b"test", 0, True)
        self.bridge.execute.assert_awaited_once_with("calcula um mais um")
        self.assertEqual(self.bridge.wake_armed_until, 0)

    async def test_busy_playback_and_approval_disable_listening(self):
        self.assertTrue(self.bridge.can_wake_listen())
        for phase in ("recording", "speaking", "working", "grok_waiting", "approval", "disconnected"):
            self.bridge.state["phase"] = phase
            self.assertFalse(self.bridge.can_wake_listen())
        self.bridge.state["phase"] = "ready"
        self.bridge.wake_speaker_pending = True
        self.assertFalse(self.bridge.can_wake_listen())

    async def test_invalid_config_is_atomic_and_disable_clears_followup(self):
        with self.assertRaises(ValueError):
            await self.bridge.configure_wake({"name": "<script>", "enabled": False})
        self.assertTrue(self.bridge.wake_enabled)
        self.bridge.wake_armed_until = 999999999
        await self.bridge.configure_wake({"name": "Jax", "enabled": False})
        self.assertFalse(self.bridge.can_wake_listen())
        self.assertEqual(self.bridge.wake_armed_until, 0)
        self.assertEqual(self.bridge.wake_file.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
