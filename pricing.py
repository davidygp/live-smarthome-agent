"""Deterministic USD cost estimation for Gemini token usage (no LLM involved).

Rates are USD per 1M tokens, loaded from `.env` (see the PRICE_* block there),
using Vertex AI *standard* pricing for prompts <= 200K tokens.

Billing semantics mirrored from the Token Usage Telemetry panel:

  * Live (voice) model - one `usage_metadata` per model turn. The Live API
    re-processes the whole context window every turn, so each turn's prompt is
    billed in full, split by modality (TEXT / AUDIO / IMAGE). There is NO
    context-cache pricing for the Live model: any `cached_content_token_count`
    it reports is billed at the normal input rate of its modality.
    `tool_use_prompt_token_count` is billed as text input. Output is split into
    AUDIO vs TEXT candidates; thinking tokens are billed at the text-output rate.
  * Lite sub-agents (camera checks, brain) - one record per generateContent.
    Input is a single rate for all modalities; cached input (implicit caching)
    at the cached-input rate. Output is never cached: candidates + thoughts are
    always billed at the output rate.

`SessionCostLedger` keeps per-WebSocket running totals for the session and for
the live / camera / brain buckets so the UI only displays Python-computed money.
"""

import logging
import os
from dataclasses import dataclass, field, asdict
from typing import Mapping

from dotenv import load_dotenv

logger = logging.getLogger(__name__)

load_dotenv(override=True)

PER_MILLION = 1_000_000


def _rate(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw.split("#", 1)[0].strip())
    except ValueError:
        logger.warning(f"Invalid pricing value {name}={raw!r}; falling back to {default}")
        return default


@dataclass(frozen=True)
class LivePricing:
    """USD per 1M tokens for the Gemini Live (voice) model (no cache pricing)."""
    text_in: float
    audio_in: float
    image_in: float
    text_out: float
    audio_out: float


@dataclass(frozen=True)
class LitePricing:
    """USD per 1M tokens for the Flash Lite sub-agents (camera + brain).

    Only input has a cached rate; output is never cached.
    """
    input: float
    cached_in: float
    output: float


def load_live_pricing() -> LivePricing:
    return LivePricing(
        text_in=_rate("PRICE_LIVE_TEXT_INPUT_PER_M", 0.75),
        audio_in=_rate("PRICE_LIVE_AUDIO_INPUT_PER_M", 3.00),
        image_in=_rate("PRICE_LIVE_IMAGE_INPUT_PER_M", 1.00),
        text_out=_rate("PRICE_LIVE_TEXT_OUTPUT_PER_M", 4.50),
        audio_out=_rate("PRICE_LIVE_AUDIO_OUTPUT_PER_M", 12.00),
    )


def load_lite_pricing() -> LitePricing:
    lite_in = _rate("PRICE_LITE_INPUT_PER_M", 0.30)
    return LitePricing(
        input=lite_in,
        cached_in=_rate("PRICE_LITE_CACHED_INPUT_PER_M", lite_in * 0.10),
        output=_rate("PRICE_LITE_OUTPUT_PER_M", 2.50),
    )


LIVE_PRICING = load_live_pricing()
LITE_PRICING = load_lite_pricing()


def _usd(tokens: int, rate_per_m: float) -> float:
    return max(0, tokens) * rate_per_m / PER_MILLION


def _empty_cost() -> dict:
    return {"inputUsd": 0.0, "cachedInputUsd": 0.0, "outputUsd": 0.0,
            "totalUsd": 0.0, "cacheSavingsUsd": 0.0}


def cost_live_turn(prompt_mod: Mapping[str, int], cand_mod: Mapping[str, int],
                   candidates_total: int, thoughts: int = 0, tool_use: int = 0,
                   pricing: LivePricing = LIVE_PRICING) -> dict:
    """USD cost of a single Live API model turn.

    The Live model has no cache pricing, so every prompt token (cached or not)
    is billed at its modality's input rate; cachedInputUsd / cacheSavingsUsd
    are always 0 for Live turns.
    """
    input_usd = (_usd(int(prompt_mod.get("TEXT", 0) or 0) + tool_use, pricing.text_in)
                 + _usd(int(prompt_mod.get("AUDIO", 0) or 0), pricing.audio_in)
                 + _usd(int(prompt_mod.get("IMAGE", 0) or 0), pricing.image_in))

    audio_out = min(int(cand_mod.get("AUDIO", 0) or 0), candidates_total)
    text_out = max(0, candidates_total - audio_out)
    output_usd = (_usd(audio_out, pricing.audio_out)
                  + _usd(text_out + thoughts, pricing.text_out))

    return {
        "inputUsd": input_usd,
        "cachedInputUsd": 0.0,
        "outputUsd": output_usd,
        "totalUsd": input_usd + output_usd,
        "cacheSavingsUsd": 0.0,
    }


def cost_lite_call(prompt: int, candidates: int, thoughts: int = 0, cached: int = 0,
                   pricing: LitePricing = LITE_PRICING) -> dict:
    """USD cost of a single Flash Lite generateContent call (camera or brain)."""
    cached = min(max(0, cached), max(0, prompt))
    input_usd = _usd(prompt - cached, pricing.input)
    cached_usd = _usd(cached, pricing.cached_in)
    output_usd = _usd(candidates + thoughts, pricing.output)
    return {
        "inputUsd": input_usd,
        "cachedInputUsd": cached_usd,
        "outputUsd": output_usd,
        "totalUsd": input_usd + cached_usd + output_usd,
        "cacheSavingsUsd": _usd(cached, pricing.input - pricing.cached_in),
    }


def cost_subagent_record(record: Mapping) -> dict:
    """Prices a `usage_sink.build_usage_record` dict (camera or brain)."""
    return cost_lite_call(
        prompt=int(record.get("promptTokenCount", 0) or 0),
        candidates=int(record.get("candidatesTokenCount", 0) or 0),
        thoughts=int(record.get("thoughtsTokenCount", 0) or 0),
        cached=int(record.get("cachedContentTokenCount", 0) or 0),
    )


def bucket_for_source(source: str) -> str:
    return "brain" if source == "brain" else "camera"


@dataclass
class SessionCostLedger:
    """Running USD totals for one WebSocket session."""
    session: dict = field(default_factory=_empty_cost)
    live: dict = field(default_factory=_empty_cost)
    camera: dict = field(default_factory=_empty_cost)
    brain: dict = field(default_factory=_empty_cost)

    def add(self, bucket: str, cost: Mapping[str, float]) -> None:
        for target in (self.session, getattr(self, bucket)):
            for key in target:
                target[key] += cost.get(key, 0.0)

    def snapshot(self) -> dict:
        return {k: dict(v) for k, v in asdict(self).items()}


def pricing_summary() -> dict:
    """Rates actually in effect, for UI tooltips and logs."""
    return {"currency": "USD", "unit": "per 1M tokens", "tier": "standard (<=200K input)",
            "live": asdict(LIVE_PRICING), "lite": asdict(LITE_PRICING)}
