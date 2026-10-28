"""Unit tests for pricing.py (Estimated Cost panel).

Run from the project root:
    .venv/bin/python -m unittest discover -s tests -v
(also collected as-is by pytest, if installed)

All expected values are hand-computed: tokens * USD-per-1M / 1,000,000.
Tests use explicit rate fixtures so they stay deterministic even if `.env`
changes; `TestEnvRates` separately asserts the `.env` values in effect.
"""

import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pricing as P  # noqa: E402
from usage_sink import modality_counts  # noqa: E402

M = 1_000_000

# Rates from the brief (Vertex AI standard tier, <=200K input tokens)
LIVE = P.LivePricing(text_in=0.75, audio_in=3.00, image_in=1.00, text_out=4.50, audio_out=12.00)
LITE = P.LitePricing(input=0.30, cached_in=0.03, output=2.50)


class PricingTestCase(unittest.TestCase):
    def assertUsd(self, got, want, msg=None):
        self.assertAlmostEqual(got, want, places=12, msg=msg)


class TestEnvRates(PricingTestCase):
    """The `.env` PRICE_* block is what the running app uses."""

    def test_live_rates_from_env(self):
        self.assertEqual(P.LIVE_PRICING, LIVE)

    def test_lite_rates_from_env(self):
        self.assertEqual(P.LITE_PRICING, LITE)

    def test_live_has_no_cache_rates(self):
        self.assertFalse(any("cached" in f for f in P.LivePricing.__dataclass_fields__))

    def test_lite_has_no_cached_output_rate(self):
        self.assertEqual(set(P.LitePricing.__dataclass_fields__), {"input", "cached_in", "output"})

    def test_rate_parser_strips_inline_comment(self):
        with mock.patch.dict(os.environ, {"X_RATE": "1.25 # note"}):
            self.assertEqual(P._rate("X_RATE", 9.0), 1.25)

    def test_rate_parser_falls_back_on_invalid_or_missing(self):
        with mock.patch.dict(os.environ, {"X_RATE": "abc", "X_EMPTY": ""}):
            self.assertEqual(P._rate("X_RATE", 9.0), 9.0)
            self.assertEqual(P._rate("X_EMPTY", 9.0), 9.0)
            self.assertEqual(P._rate("X_MISSING_RATE", 9.0), 9.0)


class TestLiveTurn(PricingTestCase):
    """Gemini 3.8 Live: per-modality input, audio/text output, no caching."""

    def cost(self, prompt_mod, cand_mod, cand_total, thoughts=0, tool_use=0):
        return P.cost_live_turn(prompt_mod, cand_mod, cand_total,
                                thoughts=thoughts, tool_use=tool_use, pricing=LIVE)

    def test_text_input_only(self):
        c = self.cost({"TEXT": 1_000_000}, {}, 0)
        self.assertUsd(c["inputUsd"], 0.75)
        self.assertUsd(c["totalUsd"], 0.75)

    def test_audio_input_only(self):
        self.assertUsd(self.cost({"AUDIO": 1_000_000}, {}, 0)["totalUsd"], 3.00)

    def test_image_input_only(self):
        self.assertUsd(self.cost({"IMAGE": 1_000_000}, {}, 0)["totalUsd"], 1.00)

    def test_text_output_only(self):
        self.assertUsd(self.cost({}, {"TEXT": 1_000_000}, 1_000_000)["outputUsd"], 4.50)

    def test_audio_output_only(self):
        self.assertUsd(self.cost({}, {"AUDIO": 1_000_000}, 1_000_000)["outputUsd"], 12.00)

    def test_thoughts_billed_as_text_output(self):
        self.assertUsd(self.cost({}, {}, 0, thoughts=1_000_000)["outputUsd"], 4.50)

    def test_tool_use_prompt_billed_as_text_input(self):
        self.assertUsd(self.cost({}, {}, 0, tool_use=1_000_000)["inputUsd"], 0.75)

    def test_text_output_is_candidates_minus_audio(self):
        # 204 candidates of which 182 audio -> 22 text (plus 68 thoughts at text rate)
        c = self.cost({}, {"AUDIO": 182, "TEXT": 22}, 204, thoughts=68)
        self.assertUsd(c["outputUsd"], 182 * 12.00 / M + (22 + 68) * 4.50 / M)  # $0.002589

    def test_audio_out_clamped_to_candidates_total(self):
        c = self.cost({}, {"AUDIO": 500}, 100)
        self.assertUsd(c["outputUsd"], 100 * 12.00 / M)

    def test_real_trace_turn(self):
        # usage_metadata row: AUDIO:83|TEXT:858 in, TEXT:31 out, 67 thoughts
        c = self.cost({"AUDIO": 83, "TEXT": 858}, {"TEXT": 31}, 31, thoughts=67)
        self.assertUsd(c["inputUsd"], 83 * 3.00 / M + 858 * 0.75 / M)   # $0.0008925
        self.assertUsd(c["outputUsd"], (31 + 67) * 4.50 / M)             # $0.000441
        self.assertUsd(c["totalUsd"], 0.0013335)

    def test_mixed_modalities(self):
        c = self.cost({"TEXT": 2000, "AUDIO": 1000, "IMAGE": 258}, {"AUDIO": 300, "TEXT": 20}, 320,
                      thoughts=100, tool_use=50)
        want_in = (2000 + 50) * 0.75 / M + 1000 * 3.00 / M + 258 * 1.00 / M
        want_out = 300 * 12.00 / M + (20 + 100) * 4.50 / M
        self.assertUsd(c["inputUsd"], want_in)
        self.assertUsd(c["outputUsd"], want_out)
        self.assertUsd(c["totalUsd"], want_in + want_out)

    def test_no_cache_discount_or_cached_bucket(self):
        # Live has no caching: never any cached-input cost or savings
        c = self.cost({"TEXT": 1000, "AUDIO": 500}, {}, 0)
        self.assertEqual(c["cachedInputUsd"], 0.0)
        self.assertEqual(c["cacheSavingsUsd"], 0.0)
        self.assertUsd(c["inputUsd"], 1000 * 0.75 / M + 500 * 3.00 / M)

    def test_cache_args_not_accepted(self):
        with self.assertRaises(TypeError):
            P.cost_live_turn({"TEXT": 1}, {}, 0, cached_total=1, pricing=LIVE)

    def test_zero_usage(self):
        c = self.cost({}, {}, 0)
        self.assertEqual(c, {"inputUsd": 0.0, "cachedInputUsd": 0.0, "outputUsd": 0.0,
                             "totalUsd": 0.0, "cacheSavingsUsd": 0.0})


class TestLiteCall(PricingTestCase):
    """Gemini 3.5 Flash Lite (camera checks + brain): cached input only."""

    def test_input_only(self):
        self.assertUsd(P.cost_lite_call(1_000_000, 0, pricing=LITE)["totalUsd"], 0.30)

    def test_output_only(self):
        self.assertUsd(P.cost_lite_call(0, 1_000_000, pricing=LITE)["totalUsd"], 2.50)

    def test_thoughts_billed_as_output(self):
        self.assertUsd(P.cost_lite_call(0, 0, thoughts=1_000_000, pricing=LITE)["outputUsd"], 2.50)

    def test_fully_cached_input(self):
        c = P.cost_lite_call(1_000_000, 0, cached=1_000_000, pricing=LITE)
        self.assertUsd(c["inputUsd"], 0.0)
        self.assertUsd(c["cachedInputUsd"], 0.03)
        self.assertUsd(c["cacheSavingsUsd"], 0.27)

    def test_output_never_discounted_by_cache(self):
        no_cache = P.cost_lite_call(10_000, 1_000, thoughts=500, cached=0, pricing=LITE)
        cached = P.cost_lite_call(10_000, 1_000, thoughts=500, cached=10_000, pricing=LITE)
        self.assertUsd(cached["outputUsd"], no_cache["outputUsd"])
        self.assertUsd(cached["outputUsd"], 1_500 * 2.50 / M)

    def test_cached_clamped_to_prompt(self):
        c = P.cost_lite_call(100, 0, cached=500, pricing=LITE)
        self.assertUsd(c["cachedInputUsd"], 100 * 0.03 / M)
        self.assertUsd(c["inputUsd"], 0.0)

    def test_real_brain_step_with_implicit_cache(self):
        # subagent_usage brain row: prompt 5941, cached 3757, out 306, thoughts 648
        c = P.cost_lite_call(5941, 306, thoughts=648, cached=3757, pricing=LITE)
        self.assertUsd(c["inputUsd"], (5941 - 3757) * 0.30 / M)   # $0.0006552
        self.assertUsd(c["cachedInputUsd"], 3757 * 0.03 / M)      # $0.00011271
        self.assertUsd(c["outputUsd"], (306 + 648) * 2.50 / M)    # $0.002385
        self.assertUsd(c["totalUsd"], 0.00315291)
        self.assertUsd(c["cacheSavingsUsd"], 3757 * 0.27 / M)     # $0.00101439

    def test_camera_check_record(self):
        rec = {"source": "check_camera", "promptTokenCount": 1300, "imageInTokenCount": 1100,
               "textInTokenCount": 200, "candidatesTokenCount": 80, "thoughtsTokenCount": 200,
               "cachedContentTokenCount": 0}
        with mock.patch.object(P, "LITE_PRICING", LITE):
            c = P.cost_subagent_record(rec)
        # Image and text input share one Lite input rate
        self.assertUsd(c["totalUsd"], 1300 * 0.30 / M + 280 * 2.50 / M)  # $0.00109

    def test_subagent_record_missing_fields_is_zero(self):
        self.assertEqual(P.cost_subagent_record({"source": "brain"})["totalUsd"], 0.0)


class TestBucketsAndLedger(PricingTestCase):
    def test_bucket_for_source(self):
        self.assertEqual(P.bucket_for_source("brain"), "brain")
        self.assertEqual(P.bucket_for_source("check_camera"), "camera")

    def test_session_is_sum_of_live_camera_brain(self):
        ledger = P.SessionCostLedger()
        live = P.cost_live_turn({"AUDIO": 83, "TEXT": 858}, {"TEXT": 31}, 31, thoughts=67, pricing=LIVE)
        cam = P.cost_lite_call(1300, 80, thoughts=200, pricing=LITE)
        brain = P.cost_lite_call(5941, 306, thoughts=648, cached=3757, pricing=LITE)
        ledger.add("live", live)
        ledger.add("camera", cam)
        ledger.add("brain", brain)
        ledger.add("brain", brain)
        snap = ledger.snapshot()
        for key in ("inputUsd", "cachedInputUsd", "outputUsd", "totalUsd", "cacheSavingsUsd"):
            self.assertUsd(snap["session"][key],
                           snap["live"][key] + snap["camera"][key] + snap["brain"][key], key)
        self.assertUsd(snap["session"]["totalUsd"], 0.0013335 + 0.00109 + 2 * 0.00315291)
        self.assertEqual(snap["live"]["cachedInputUsd"], 0.0)

    def test_snapshot_is_a_copy(self):
        ledger = P.SessionCostLedger()
        snap = ledger.snapshot()
        ledger.add("live", {"totalUsd": 1.0})
        self.assertEqual(snap["session"]["totalUsd"], 0.0)

    def test_pricing_summary_shape(self):
        s = P.pricing_summary()
        self.assertEqual(s["currency"], "USD")
        self.assertIn("image_in", s["live"])
        self.assertNotIn("text_cached_in", s["live"])
        self.assertIn("cached_in", s["lite"])


class TestModalityCountsIntegration(PricingTestCase):
    """main.py feeds Live `usage_metadata` details through usage_sink.modality_counts."""

    def test_live_usage_metadata_to_cost(self):
        detail = lambda m, n: SimpleNamespace(modality=f"MediaModality.{m}", token_count=n)  # noqa: E731
        prompt = modality_counts([detail("AUDIO", 83), detail("TEXT", 858)])
        cand = modality_counts([detail("TEXT", 31)])
        self.assertEqual(prompt, {"TEXT": 858, "AUDIO": 83, "IMAGE": 0})
        c = P.cost_live_turn(prompt, cand, 31, thoughts=67, pricing=LIVE)
        self.assertUsd(c["totalUsd"], 0.0013335)

    def test_video_counts_as_image(self):
        mods = modality_counts([SimpleNamespace(modality="VIDEO", token_count=258)])
        self.assertEqual(mods["IMAGE"], 258)
        self.assertUsd(P.cost_live_turn(mods, {}, 0, pricing=LIVE)["totalUsd"], 258 * 1.00 / M)


if __name__ == "__main__":
    unittest.main(verbosity=2)
