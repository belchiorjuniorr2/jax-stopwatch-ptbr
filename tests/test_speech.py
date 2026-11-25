import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from speech import hallucinated, prompt

SPEECH = [{"no_speech_prob": .05, "avg_logprob": -.3}]


class HallucinationTests(unittest.TestCase):
    def test_prompt_carries_name_and_assistants(self):
        self.assertEqual(prompt("Jax"), "português do Brasil. Jax. Codex. Grok Bot. assistente.")

    def test_echoed_prompt_is_rejected(self):
        for text in ("assistente. Codex. Grok Bot. assistente.", "Codex. Grok Bot.", "Codex. Codex.", "português do Brasil."):
            with self.subTest(text=text):
                self.assertTrue(hallucinated(text, SPEECH, "Jax"))

    def test_stock_subtitle_phrases_are_rejected(self):
        self.assertTrue(hallucinated("legendas por Soraya", SPEECH, "Jax"))
        self.assertTrue(hallucinated("inscreva-se deixe seu like", SPEECH))

    def test_low_speech_confidence_is_rejected(self):
        self.assertTrue(hallucinated("republicar.", [{"no_speech_prob": .62, "avg_logprob": -.4}]))

    def test_real_commands_survive(self):
        for text in ("Jax.", "Jax. Codex.", "trocar para o Grok.", "Codex.", "Jax, Jax, pede pro Codex anotar um recado.",
                     "curte essa publicação pra mim"):
            with self.subTest(text=text):
                self.assertFalse(hallucinated(text, SPEECH, "Jax"))


if __name__ == "__main__":
    unittest.main()
