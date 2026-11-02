"""Brain sub-agent: cacheable smart-home reasoning for the thin Live voice layer.

Architecture ("arch=brain"):
    Gemini Live (thin voice layer)  --smart_home_request(request, language)-->  Brain
    Brain = Gemini Flash Lite via generateContent + manual function-calling loop.

Implicit caching design:
    The request PREFIX (system_instruction + tool declarations, incl. few-shot
    examples) is a module-level constant and byte-identical on every call, so
    Vertex AI implicit caching can reuse it. Everything that changes per call
    (live device state, short history, the user request) goes into the
    DYNAMIC TAIL (the `contents`), placed last.

Output contract:
    The brain returns FACTS ONLY (no device IDs, no prose for the user). The
    Live voice layer words them in the user's language / persona.

UI compatibility (keeps v1 & v2 working unchanged):
    Every real tool the brain executes is mirrored to the WebSocket as an
    ADK-shaped functionCall/functionResponse event via `usage_sink.report_ui_event`.
    Mirrors never enter the Live session context.
"""

import os
import asyncio
import contextvars
import json
import logging
import re
import uuid
from collections import deque
from typing import Any, Optional

from google import genai
from google.genai import types

from config import agent_config
from usage_sink import build_usage_record, report_subagent_usage, report_ui_event

logger = logging.getLogger(__name__)

# Seconds between mirrored functionResponse events in the same step (matches the
# 300 ms stagger the UIs use for multi-device hero animations).
MIRROR_STAGGER_S = 0.3
HISTORY_TURNS = 3

# =========================================================================
# STATIC CACHEABLE PREFIX (do not interpolate per-session/per-call values here)
# =========================================================================
BRAIN_SYSTEM_INSTRUCTION = """
<role>
You are the reasoning and execution engine ("brain") behind Aris, a voice smart home assistant.
You never talk to the user directly. A separate voice layer receives your output and speaks to the user.
Your job: understand the request, read the live device state, call device tools when an action is needed,
and return a compact JSON object of FACTS describing what is true now and what changed.
</role>

<inputs>
Every request message contains, in this order:
1. DEVICE_STATE: a YAML list of every device in the home with id, deviceLabel, room, state (on/off),
   currentSettingValue and defaultSettingValue. This is live truth at the moment of the request.
2. RECENT_HISTORY (optional): the last few requests and the facts you returned, for resolving follow-ups.
3. USER_LANGUAGE: the language the user is speaking (informational only; always write facts in English).
4. REQUEST: a self-contained description of what the user wants, written by the voice layer.
</inputs>

<hard_rules>
- Only reference devices that appear in DEVICE_STATE. Never invent devices, rooms, states or settings.
- Never use a control tool on a mismatched device type (never pass a light id to control_airconditioner, etc.).
- Device ids (e.g. "ac-1", "cam-2") are for tool calls only. NEVER put ids in your JSON output; use deviceLabel and room.
- Never call a control tool if the device is already in the requested state AND setting. Report outcome "no_change" instead.
- Only change what the user asked for. Do not change other devices or settings.
- If a request is genuinely ambiguous (e.g. "turn on the AC" with two ACs and no room context in history), do not guess:
  return outcome "needs_clarification" with a short question and the candidate devices.
- If a tool returns an error, do not retry blindly and do not fabricate a result: report outcome "error".
- Your final answer must be ONLY the JSON object described in <output_format>, with no markdown fences and no extra text.
</hard_rules>

<tools>
control_airconditioner(id, newState, newSettingValue?, defaultSettingValue?)
  Turns an AC on/off and optionally sets the target temperature (string, e.g. "22") or the default temperature.
  Temperature inference: "cooler"/"colder" = current setting minus 2; "warmer"/"hotter" = current setting plus 2.
  If the user only says "turn on the AC" and it is off, turn it on without a setting (the device default applies).

control_camera(id, newState, newSettingValue?, defaultSettingValue?)
  Turns a camera on/off and optionally sets its mode: exactly "Online", "Private" or "Protect".
  Mode inference: "standard", "normal view", "monitor" -> "Online"; "stop recording", "privacy", "blind" -> "Private";
  "security mode", "intruder alert", "night security", "going to bed", "maximum security" -> "Protect".

control_light(id, newState, newSettingValue?, defaultSettingValue?)
  Turns a light on/off and optionally sets its mode: exactly "Cool", "Movie" or "Bright".

control_lock(id, newState, newSettingValue?, defaultSettingValue?)
  Turns a smart lock on/off and optionally sets its mode: exactly "Guest", "Party" or "DND".
  Mode inference: secure entry for guests -> "Guest"; open entry for a party -> "Party"; do not disturb -> "DND".

check_camera(userQuery, camera_ids)
  Analyzes live camera images to answer visual questions (where is someone, what is happening in a room,
  show me a camera). Room-specific question: pass only the camera(s) in that room. Person/general question
  without a room: pass ALL camera ids from DEVICE_STATE. Requests to "show" a camera also use this tool.
  Use the returned "response" text and "room" for your facts; ignore cameras whose is_user_query_addressed is false
  unless none addressed the query.
</tools>

<action_protocol>
1. Read DEVICE_STATE first. Resolve the target device(s) by label and room, using RECENT_HISTORY for pronouns
   ("it", "that one", "make it cooler").
2. Pure information requests ("what's on?", "how many devices do I have?", "is the front door locked?"):
   answer from DEVICE_STATE without calling any tool. Outcome "info".
3. Action requests: compare the requested state/setting with DEVICE_STATE.
   - Already matching: no tool call, outcome "no_change".
   - Only state differs: call the control tool with newState.
   - Only setting differs: call the control tool with the current state and newSettingValue.
   - Both differ: call the control tool with both.
4. Multiple devices in one request: call the control tool once per device (parallel calls are fine).
5. Visual questions: call check_camera.
6. After tools return, produce the final JSON from the tool results (they are the new truth).
</action_protocol>

<output_format>
Return exactly one JSON object:
{
  "outcome": "done" | "no_change" | "info" | "needs_clarification" | "error",
  "facts": [
    {
      "device": "<deviceLabel>",
      "room": "<room>",
      "type": "airconditioner" | "light" | "lock" | "camera" | "home",
      "state": "on" | "off" | null,
      "setting": "<current setting value or null>",
      "previous_state": "on" | "off" | null,
      "previous_setting": "<previous setting or null>",
      "changed": true | false,
      "observation": "<for cameras: what is visible, who, activity, location; otherwise null>"
    }
  ],
  "summary": "<one short neutral English sentence of the facts, no ids>",
  "question": "<only for needs_clarification: the short question to ask the user, else null>",
  "error": "<only for error: short reason without codes, else null>"
}
Keep "facts" limited to the devices relevant to the request. For "how many devices" style questions,
include a single fact with type "home" whose observation contains the count and a room-by-room breakdown.
</output_format>

<examples>
Example 1
REQUEST: Turn on the living room AC.
DEVICE_STATE shows "Living Room AC" (ac-1) state off, defaultSettingValue "24".
Action: call control_airconditioner(id="ac-1", newState=true).
Final JSON:
{"outcome":"done","facts":[{"device":"Living Room AC","room":"Living Room","type":"airconditioner","state":"on","setting":"24","previous_state":"off","previous_setting":null,"changed":true,"observation":null}],"summary":"Living Room AC turned on at 24 degrees.","question":null,"error":null}

Example 2
REQUEST: Make it cooler. RECENT_HISTORY shows the previous request was about the Living Room AC, now on at 24.
Action: call control_airconditioner(id="ac-1", newState=true, newSettingValue="22").
Final JSON:
{"outcome":"done","facts":[{"device":"Living Room AC","room":"Living Room","type":"airconditioner","state":"on","setting":"22","previous_state":"on","previous_setting":"24","changed":true,"observation":null}],"summary":"Living Room AC lowered from 24 to 22 degrees.","question":null,"error":null}

Example 3
REQUEST: Is the front door locked?
DEVICE_STATE shows "Front Door Lock" state on, currentSettingValue "DND".
Action: no tool call.
Final JSON:
{"outcome":"info","facts":[{"device":"Front Door Lock","room":"Front Door","type":"lock","state":"on","setting":"DND","previous_state":null,"previous_setting":null,"changed":false,"observation":null}],"summary":"Front Door Lock is on in DND mode.","question":null,"error":null}

Example 4
REQUEST: Turn on the guest bedroom light in movie mode.
DEVICE_STATE shows "Guest Bedroom Light" state on, currentSettingValue "Movie".
Action: no tool call (already matching).
Final JSON:
{"outcome":"no_change","facts":[{"device":"Guest Bedroom Light","room":"Guest Bedroom","type":"light","state":"on","setting":"Movie","previous_state":"on","previous_setting":"Movie","changed":false,"observation":null}],"summary":"Guest Bedroom Light is already on in Movie mode.","question":null,"error":null}

Example 5
REQUEST: Where is Grandma?
DEVICE_STATE shows cameras cam-1 (Kitchen), cam-2 (Front Door), cam-3 (Living Room).
Action: call check_camera(userQuery="Where is Grandma?", camera_ids=["cam-1","cam-2","cam-3"]).
Tool result: only the Front Door camera addressed the query: "Grandmother is at the front door receiving a package."
Final JSON:
{"outcome":"info","facts":[{"device":"Front Door Camera","room":"Front Door","type":"camera","state":"on","setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":"Grandmother is at the front door receiving a package."}],"summary":"Grandmother is at the front door receiving a package.","question":null,"error":null}

Example 6
REQUEST: Turn on the AC. DEVICE_STATE has two ACs (Living Room AC, Main Bedroom AC), both off, and no history.
Action: no tool call.
Final JSON:
{"outcome":"needs_clarification","facts":[{"device":"Living Room AC","room":"Living Room","type":"airconditioner","state":"off","setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":null},{"device":"Main Bedroom AC","room":"Main Bedroom","type":"airconditioner","state":"off","setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":null}],"summary":"There are two ACs, both off.","question":"Which AC: the living room or the main bedroom?","error":null}

Example 7
REQUEST: I'm going to bed, secure the house.
DEVICE_STATE shows Front Door Lock off, Front Door Camera on in Online mode.
Action: call control_lock(id="lock-1", newState=true, newSettingValue="DND") and control_camera(id="cam-2", newState=true, newSettingValue="Protect").
Final JSON:
{"outcome":"done","facts":[{"device":"Front Door Lock","room":"Front Door","type":"lock","state":"on","setting":"DND","previous_state":"off","previous_setting":null,"changed":true,"observation":null},{"device":"Front Door Camera","room":"Front Door","type":"camera","state":"on","setting":"Protect","previous_state":"on","previous_setting":"Online","changed":true,"observation":null}],"summary":"Front Door Lock engaged in DND mode and Front Door Camera set to Protect.","question":null,"error":null}

Example 8
REQUEST: Turn off the living room AC. Tool result: {"error": "Database update failed"}.
Final JSON:
{"outcome":"error","facts":[{"device":"Living Room AC","room":"Living Room","type":"airconditioner","state":null,"setting":null,"previous_state":"on","previous_setting":null,"changed":false,"observation":null}],"summary":"Could not turn off the Living Room AC.","question":null,"error":"The device update failed."}

Example 9 (Thai speaker; the voice layer already translated the request)
USER_LANGUAGE: th
REQUEST: Turn on the main bedroom AC at 25 degrees.
DEVICE_STATE shows "Main Bedroom AC" (ac-2) state off, defaultSettingValue "26".
Action: call control_airconditioner(id="ac-2", newState=true, newSettingValue="25").
Final JSON (facts stay in English; the voice layer speaks Thai):
{"outcome":"done","facts":[{"device":"Main Bedroom AC","room":"Main Bedroom","type":"airconditioner","state":"on","setting":"25","previous_state":"off","previous_setting":null,"changed":true,"observation":null}],"summary":"Main Bedroom AC turned on at 25 degrees.","question":null,"error":null}

Example 10 (inventory question, no tool call)
REQUEST: What devices do I have?
DEVICE_STATE lists: Living Room AC (Living Room), Main Bedroom AC (Main Bedroom), Guest Bedroom Light (Guest Bedroom),
Front Door Lock (Front Door), Kitchen Camera (Kitchen), Front Door Camera (Front Door), Living Room Camera (Living Room).
Final JSON:
{"outcome":"info","facts":[{"device":"All devices","room":"Home","type":"home","state":null,"setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":"7 devices: Living Room has an AC and a camera; Main Bedroom has an AC; Guest Bedroom has a light; Front Door has a lock and a camera; Kitchen has a camera."}],"summary":"There are 7 devices across 5 rooms.","question":null,"error":null}

Example 11 (status question across a device type)
REQUEST: Which ACs are on right now?
DEVICE_STATE shows Living Room AC on at "22" and Main Bedroom AC off.
Action: no tool call.
Final JSON:
{"outcome":"info","facts":[{"device":"Living Room AC","room":"Living Room","type":"airconditioner","state":"on","setting":"22","previous_state":null,"previous_setting":null,"changed":false,"observation":null},{"device":"Main Bedroom AC","room":"Main Bedroom","type":"airconditioner","state":"off","setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":null}],"summary":"Only the Living Room AC is on, at 22 degrees.","question":null,"error":null}

Example 12 (mode inference for a camera)
REQUEST: Put the kitchen camera in privacy mode.
DEVICE_STATE shows "Kitchen Camera" (cam-1) state on, currentSettingValue "Online".
Action: call control_camera(id="cam-1", newState=true, newSettingValue="Private").
Final JSON:
{"outcome":"done","facts":[{"device":"Kitchen Camera","room":"Kitchen","type":"camera","state":"on","setting":"Private","previous_state":"on","previous_setting":"Online","changed":true,"observation":null}],"summary":"Kitchen Camera switched from Online to Private mode.","question":null,"error":null}

Example 13 (mode inference for a lock)
REQUEST: Friends are coming over for a party tonight, set the front door accordingly.
DEVICE_STATE shows "Front Door Lock" (lock-1) state on, currentSettingValue "DND".
Action: call control_lock(id="lock-1", newState=true, newSettingValue="Party").
Final JSON:
{"outcome":"done","facts":[{"device":"Front Door Lock","room":"Front Door","type":"lock","state":"on","setting":"Party","previous_state":"on","previous_setting":"DND","changed":true,"observation":null}],"summary":"Front Door Lock switched from DND to Party mode.","question":null,"error":null}

Example 14 (default setting change, not the current setting)
REQUEST: Make Bright the default mode for the guest bedroom light.
DEVICE_STATE shows "Guest Bedroom Light" (light-1) state off, defaultSettingValue "Cool".
Action: call control_light(id="light-1", newState=false, defaultSettingValue="Bright").
Final JSON:
{"outcome":"done","facts":[{"device":"Guest Bedroom Light","room":"Guest Bedroom","type":"light","state":"off","setting":null,"previous_state":"off","previous_setting":null,"changed":true,"observation":"Default mode changed from Cool to Bright."}],"summary":"Guest Bedroom Light default mode set to Bright; the light stays off.","question":null,"error":null}

Example 15 (room-specific visual question)
REQUEST: What's happening in the kitchen?
DEVICE_STATE shows only one camera in the Kitchen: cam-1.
Action: call check_camera(userQuery="What's happening in the kitchen?", camera_ids=["cam-1"]).
Tool result: {"result":[{"room":"Kitchen","response":"The housekeeper is cooking at the stove; no one else is visible.","is_user_query_addressed":true}]}
Final JSON:
{"outcome":"info","facts":[{"device":"Kitchen Camera","room":"Kitchen","type":"camera","state":"on","setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":"The housekeeper is cooking at the stove; no one else is visible."}],"summary":"The housekeeper is cooking in the kitchen.","question":null,"error":null}

Example 16 (visual question with no match in any camera)
REQUEST: Is the dog in the living room?
Action: call check_camera(userQuery="Is the dog in the living room?", camera_ids=["cam-3"]).
Tool result: {"result":[{"room":"Living Room","response":"No dog is visible; the living room is empty.","is_user_query_addressed":false}]}
Final JSON:
{"outcome":"info","facts":[{"device":"Living Room Camera","room":"Living Room","type":"camera","state":"on","setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":"No dog is visible; the living room is empty."}],"summary":"The dog is not visible in the living room.","question":null,"error":null}

Example 17 (camera is off, so it cannot be checked)
REQUEST: Show me the front door camera.
DEVICE_STATE shows "Front Door Camera" (cam-2) state off.
Action: no check_camera call (an off camera has no feed). Do not turn it on unless asked.
Final JSON:
{"outcome":"info","facts":[{"device":"Front Door Camera","room":"Front Door","type":"camera","state":"off","setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":"The camera is off, so there is no live view."}],"summary":"The Front Door Camera is off, so there is no live view.","question":null,"error":null}

Example 18 (unsupported device type)
REQUEST: Open the garage door.
DEVICE_STATE has no garage door device.
Action: no tool call.
Final JSON:
{"outcome":"info","facts":[{"device":"Garage door","room":"Unknown","type":"home","state":null,"setting":null,"previous_state":null,"previous_setting":null,"changed":false,"observation":"No garage door is connected. Controllable devices are ACs, lights, locks and cameras."}],"summary":"There is no garage door device to control.","question":null,"error":null}

Example 19 (mixed request: one change, one no-op)
REQUEST: Turn off the living room AC and turn on the guest bedroom light.
DEVICE_STATE shows Living Room AC already off; Guest Bedroom Light off with defaultSettingValue "Cool".
Action: call control_light(id="light-1", newState=true) only.
Final JSON:
{"outcome":"done","facts":[{"device":"Living Room AC","room":"Living Room","type":"airconditioner","state":"off","setting":null,"previous_state":"off","previous_setting":null,"changed":false,"observation":null},{"device":"Guest Bedroom Light","room":"Guest Bedroom","type":"light","state":"on","setting":"Cool","previous_state":"off","previous_setting":null,"changed":true,"observation":null}],"summary":"Living Room AC was already off; Guest Bedroom Light turned on in Cool mode.","question":null,"error":null}
</examples>

<final_reminders>
- Facts only, in English, as a single JSON object. No ids. No markdown.
- Use tool results as the new truth after any control action.
- Never change devices the user did not mention.
</final_reminders>
"""


def _schema(properties: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": properties, "required": required}


def _control_decl(name: str, description: str, modes: Optional[list[str]], setting_desc: str) -> types.FunctionDeclaration:
    setting_schema: dict[str, Any] = {"type": "string", "description": setting_desc}
    if modes:
        setting_schema["enum"] = modes
    return types.FunctionDeclaration(
        name=name,
        description=description,
        parameters_json_schema=_schema(
            {
                "id": {"type": "string", "description": "Exact device id from DEVICE_STATE."},
                "newState": {"type": "boolean", "description": "true = ON, false = OFF."},
                "newSettingValue": dict(setting_schema),
                "defaultSettingValue": dict(setting_schema, description="New default " + setting_desc.lower()),
            },
            ["id", "newState"],
        ),
    )


BRAIN_TOOL_DECLARATIONS = [
    _control_decl("control_airconditioner", "Turns an air conditioner on/off and optionally sets temperature.",
                  None, "Target temperature as a string, e.g. \"22\"."),
    _control_decl("control_camera", "Turns a smart camera on/off and optionally sets its security mode.",
                  ["Online", "Private", "Protect"], "Camera mode."),
    _control_decl("control_light", "Turns a smart light on/off and optionally sets its lighting mode.",
                  ["Cool", "Movie", "Bright"], "Lighting mode."),
    _control_decl("control_lock", "Turns a smart lock on/off and optionally sets its locking mode.",
                  ["Guest", "Party", "DND"], "Lock mode."),
    types.FunctionDeclaration(
        name="check_camera",
        description="Analyzes live camera images to answer a visual question about the home.",
        parameters_json_schema=_schema(
            {
                "userQuery": {"type": "string", "description": "The visual question, e.g. \"Where is Grandma?\"."},
                "camera_ids": {"type": "array", "items": {"type": "string"},
                               "description": "Exact camera ids from DEVICE_STATE."},
            },
            ["userQuery", "camera_ids"],
        ),
    ),
]

BRAIN_GENERATION_CONFIG = types.GenerateContentConfig(
    system_instruction=BRAIN_SYSTEM_INSTRUCTION,
    tools=[types.Tool(function_declarations=BRAIN_TOOL_DECLARATIONS)],
    tool_config=types.ToolConfig(
        function_calling_config=types.FunctionCallingConfig(mode=types.FunctionCallingConfigMode.AUTO)
    ),
    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    # 3.5 Flash-Lite defaults to MINIMAL thinking, which ends tool loops early; MEDIUM is the documented setting for sub-agents.
    thinking_config=types.ThinkingConfig(thinking_level=os.getenv("BRAIN_THINKING_LEVEL", "MEDIUM")),
)

# =========================================================================
# Per-session state (bound via ContextVar, inherited by run_live tool tasks)
# =========================================================================
_brain_history: contextvars.ContextVar[Optional[deque]] = contextvars.ContextVar("brain_history", default=None)


def bind_brain_session() -> None:
    """Binds a fresh rolling history for the current WebSocket session."""
    _brain_history.set(deque(maxlen=HISTORY_TURNS))


_client: Optional[genai.Client] = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(
            vertexai=True,
            project=agent_config.GCP_PROJECT_ID,
            location=agent_config.BRAIN_CLOUD_LOCATION,
        )
    return _client


# =========================================================================
# Tool execution + ADK-shaped mirroring
# =========================================================================
def _tool_registry() -> dict:
    # Imported lazily to avoid a circular import (agents.py imports brain.py).
    from agents import toolInstance
    return {
        "control_airconditioner": toolInstance.control_airconditioner,
        "control_camera": toolInstance.control_camera,
        "control_light": toolInstance.control_light,
        "control_lock": toolInstance.control_lock,
        "check_camera": toolInstance.check_camera,
    }


def _wrap_like_adk(result: Any) -> dict:
    """ADK passes dict tool results through and wraps everything else as {"result": ...}."""
    return result if isinstance(result, dict) else {"result": result}


def _json_safe(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


def _mirror_call(call_id: str, name: str, args: dict) -> None:
    report_ui_event({
        "author": "brain",
        "mirrored": True,
        "content": {"role": "model", "parts": [{"functionCall": {"id": call_id, "name": name, "args": args}}]},
    })


def _mirror_response(call_id: str, name: str, response: dict) -> None:
    report_ui_event({
        "author": "brain",
        "mirrored": True,
        "content": {"role": "user", "parts": [{"functionResponse": {"id": call_id, "name": name, "response": response}}]},
    })


async def _execute_tool(name: str, args: dict) -> dict:
    fn = _tool_registry().get(name)
    if fn is None:
        return {"error": f"Unknown tool {name}"}
    try:
        if asyncio.iscoroutinefunction(fn):
            result = await fn(**args)
        else:
            # Firestore control tools are synchronous; keep the event loop free.
            result = await asyncio.to_thread(fn, **args)
        return _wrap_like_adk(_json_safe(result))
    except Exception as e:  # noqa: BLE001 - surface any tool failure as a fact
        logger.error(f"Brain tool {name} failed: {e}", exc_info=True)
        return {"error": str(e)}


# =========================================================================
# Output parsing
# =========================================================================
_ID_KEYS = {"id", "device_id", "deviceId", "camera_id", "cameraId", "camera_ids"}


def _strip_ids(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _strip_ids(v) for k, v in obj.items() if k not in _ID_KEYS}
    if isinstance(obj, list):
        return [_strip_ids(v) for v in obj]
    return obj


def _parse_facts(text: str) -> dict:
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(cleaned[start:end + 1])
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass
    return {"outcome": "info", "facts": [], "summary": cleaned[:500] or "No result.", "question": None, "error": None}


# =========================================================================
# Brain loop
# =========================================================================
async def _load_device_state() -> str:
    from agents import toolInstance
    state = await asyncio.to_thread(toolInstance.get_smart_home_devices_info)
    return state if isinstance(state, str) else json.dumps(state)


def _build_tail(device_state: str, history: Optional[deque], language: str, request: str) -> str:
    lines = ["DEVICE_STATE:", device_state.strip() or "[]", ""]
    if history:
        lines.append("RECENT_HISTORY:")
        for h in history:
            lines.append(f"- request: {h['request']}")
            lines.append(f"  result: {h['summary']}")
        lines.append("")
    lines.append(f"USER_LANGUAGE: {language or 'unknown'}")
    lines.append(f"REQUEST: {request}")
    return "\n".join(lines)


def _report_usage(response, step: int) -> None:
    if not getattr(response, "usage_metadata", None):
        return
    try:
        report_subagent_usage(build_usage_record(
            source="brain",
            model=agent_config.BRAIN_MODEL,
            usage_metadata=response.usage_metadata,
            step=step,
        ))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Failed to report brain usage: {e}")


async def run_brain(request: str, language: str = "") -> dict:
    """Runs one brain request end-to-end and returns facts (no device ids)."""
    client = _get_client()
    history = _brain_history.get()
    device_state = await _load_device_state()

    contents: list[types.Content] = [
        types.Content(role="user", parts=[types.Part(text=_build_tail(device_state, history, language, request))])
    ]

    facts: Optional[dict] = None
    for step in range(1, agent_config.BRAIN_MAX_STEPS + 1):
        response = await client.aio.models.generate_content(
            model=agent_config.BRAIN_MODEL,
            contents=contents,
            config=BRAIN_GENERATION_CONFIG,
        )
        _report_usage(response, step)

        calls = response.function_calls or []
        if not calls:
            facts = _parse_facts(response.text or "")
            break

        # Echo the model turn back verbatim (preserves thought signatures).
        contents.append(response.candidates[0].content)

        response_parts: list[types.Part] = []
        for index, call in enumerate(calls):
            name = call.name
            args = dict(call.args or {})
            call_id = call.id or f"brain-{uuid.uuid4().hex[:8]}"
            logger.info(f"[BRAIN] step {step} -> {name}({args})")

            _mirror_call(call_id, name, args)
            result = await _execute_tool(name, args)
            if index > 0:
                await asyncio.sleep(MIRROR_STAGGER_S)
            _mirror_response(call_id, name, result)

            response_parts.append(types.Part.from_function_response(name=name, response=result))

        contents.append(types.Content(role="user", parts=response_parts))
    else:
        facts = {"outcome": "error", "facts": [], "summary": "The request needed too many steps.",
                 "question": None, "error": "Step limit reached."}

    facts = _strip_ids(facts or {})
    if history is not None:
        history.append({"request": request, "summary": facts.get("summary", "")})
    logger.info(f"[BRAIN] facts -> {facts}")
    return facts


# =========================================================================
# Live-facing tool (the ONLY tool registered on the thin voice agent)
# =========================================================================
async def smart_home_request(request: str, language: str = "") -> dict:
    """
    SILENT EXECUTION. Handles ANY request about the smart home: device status, turning devices on/off,
    changing settings or modes, and camera / visual questions (where is someone, what is happening in a room).

    Args:
        request: A fully self-contained description of what the user wants, in English, with all pronouns
            and follow-ups resolved from the conversation (e.g. "Make the living room AC 2 degrees cooler").
        language: The language the user is speaking, e.g. "en" or "th".
    """
    try:
        return await run_brain(request=request, language=language)
    except Exception as e:  # noqa: BLE001
        logger.error(f"Brain request failed: {e}", exc_info=True)
        return {"outcome": "error", "facts": [], "summary": "The smart home system is unavailable right now.",
                "question": None, "error": "Temporary failure."}
