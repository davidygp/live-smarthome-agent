"""Per-session side channel for sub-agent (non-Live) token usage and UI events.

Tools like `check_camera` make their own `generate_content` calls whose usage
never appears in the Live API `usage_metadata`. Rather than leaking usage data
into the tool response (which the Live model would read and pay for), tools
report it here and `main.py` forwards it to the UI and the trace log.

The same channel carries "mirrored" tool events from the brain sub-agent
(`brain.py`): ADK-shaped functionCall/functionResponse events that are sent to
the WebSocket ONLY (never to the Live session), so both v1 and v2 UIs keep
driving hero cards / camera modals / tool logs from the real tool names.

Queue items are tagged dicts:
    {"kind": "usage",    "record": {...}}   -> trace log + subagent_token_usage
    {"kind": "ui_event", "event":  {...}}   -> forwarded verbatim to the WebSocket

The sink is bound per WebSocket session via a ContextVar. asyncio tasks copy
the current context on creation, so ADK tool executions spawned inside
`runner.run_live()` inherit the session's queue automatically.
"""

import asyncio
import contextvars
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

_subagent_usage_queue: contextvars.ContextVar[Optional[asyncio.Queue]] = contextvars.ContextVar(
    "subagent_usage_queue", default=None
)


def bind_session_queue() -> asyncio.Queue:
    """Creates and binds a fresh usage queue to the current (session) context."""
    queue: asyncio.Queue = asyncio.Queue()
    _subagent_usage_queue.set(queue)
    return queue


def _modality_counts(details) -> dict[str, int]:
    """Collapses a list of ModalityTokenCount into {TEXT, AUDIO, IMAGE} buckets."""
    counts = {"TEXT": 0, "AUDIO": 0, "IMAGE": 0}
    for item in details or []:
        modality = str(getattr(item, "modality", "") or "").upper()
        token_count = getattr(item, "token_count", 0) or 0
        if "AUDIO" in modality:
            counts["AUDIO"] += token_count
        elif "IMAGE" in modality or "VIDEO" in modality:
            counts["IMAGE"] += token_count
        else:
            counts["TEXT"] += token_count
    return counts


modality_counts = _modality_counts  # public alias (used by main.py for cost estimation)


def build_usage_record(source: str, model: str, usage_metadata, **extra: Any) -> dict:
    """Normalizes a GenerateContentResponseUsageMetadata into a flat dict."""
    um = usage_metadata
    prompt_mod = _modality_counts(getattr(um, "prompt_tokens_details", None))
    record = {
        "source": source,
        "model": model,
        "totalTokenCount": getattr(um, "total_token_count", 0) or 0,
        "promptTokenCount": getattr(um, "prompt_token_count", 0) or 0,
        "imageInTokenCount": prompt_mod["IMAGE"],
        "textInTokenCount": prompt_mod["TEXT"],
        "candidatesTokenCount": getattr(um, "candidates_token_count", 0) or 0,
        "thoughtsTokenCount": getattr(um, "thoughts_token_count", 0) or 0,
        "cachedContentTokenCount": getattr(um, "cached_content_token_count", 0) or 0,
    }
    record.update(extra)
    return record


def report_subagent_usage(record: dict) -> None:
    """Queues a usage record for the current session (no-op outside a session)."""
    queue = _subagent_usage_queue.get()
    if queue is None:
        logger.info(f"Sub-agent usage (no session bound): {record}")
        return
    queue.put_nowait({"kind": "usage", "record": record})


def report_ui_event(event: dict) -> None:
    """Queues a WebSocket-only UI event for the current session (no-op outside a session)."""
    queue = _subagent_usage_queue.get()
    if queue is None:
        logger.debug(f"UI event dropped (no session bound): {event}")
        return
    queue.put_nowait({"kind": "ui_event", "event": event})
