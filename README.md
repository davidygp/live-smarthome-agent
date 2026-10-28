# live-smarthome-agent #

### 1) Prework
Ensure following baseline roles are added to the account on a fresh run\
(setup.sh will verify these and automatically grant the remaining operator roles):
  - Project IAM Admin (roles/resourcemanager.projectIamAdmin)
  - Service Usage Admin (roles/serviceusage.serviceUsageAdmin)

Edit the .env file (changing <project_id>)

### 2) Setup the infra, IAM, etc
```bash
bash setup.sh
```

### 3) Create a virtual environment and install dependencies
```bash
uv venv
source .venv/bin/activate
uv pip install -r requirements.txt
```

### 4a) Start the server (active)
```bash
uv run main.py
```

### 4b) Start the server (in background)
```bash
tmux new-session -d -s smarthome 'uv run main.py'
tmux attach-session -t smarthome
```

### 5) Access via these URLs
http://localhost:8001/live-smarthome-agent               # Main UI (Auto-resolves default or ?ui=v2 / ?ui=v1)
http://localhost:8001/live-smarthome-agent/v1            # Explicit v1 Legacy UI
http://localhost:8001/live-smarthome-agent/v2            # Explicit v2 Supabase Developer UI
http://localhost:8001/live-smarthome-agent/initialize    # Admin / Firestore Initializer
http://localhost:8001/live-smarthome-agent/camview        # Camera Feed Viewer

### 6) Visual Versions & Switching
The application supports multi-version frontend visuals over an identical backend:
- **v1 Legacy UI**: Apple-inspired dark glassmorphism dashboard.
- **v2 Supabase UI**: Developer-first dark emerald theme based on the [Supabase Design System](DESIGN.md).
- **Switching Methods**:
  1. **In-App Toggle**: Click the segmented switcher in the top bar or settings drawer.
  2. **Query Parameter**: Append `?ui=v1` or `?ui=v2` to the URL.
  3. **Environment Default**: Set `SMARTHOME_UI_VERSION=v2` in `.env`.

### 7) Agent Architectures (per WebSocket session)
| Arch | What runs | Who uses it |
|---|---|---|
| `monolithic` | One Gemini Live agent with all rules + 6 device tools (original). | v1 (default) |
| `brain` | Thin Gemini Live voice layer with one tool (`smart_home_request`) delegating to a Flash Lite **brain** (`brain.py`) via `generateContent`. The brain's static prefix (rules, tool declarations, examples) is byte-identical every call so **implicit context caching** can hit; device state and the request go last. The brain returns facts only; Live words them. | v2 (sends `?arch=brain`) |

#### Architecture diagram
```mermaid
flowchart LR
    subgraph Browser["Browser"]
        V1["v1 UI (static/index.html + js/app.js)"]
        V2["v2 UI (static/v2 + app-v2.js)"]
    end

    subgraph Server["FastAPI server (main.py)"]
        WS["WebSocket /ws/{user_id}/{session_id}"]
        ARCH{"resolve_agent_arch: ?arch= then SMARTHOME_AGENT_ARCH then monolithic"}
        SINK["usage_sink.py per-session queue (ContextVar)"]
        SSE["SSE /api/devices/stream"]
        TRACE["gemini_usage_trace.log + Cloud Logging"]
    end

    subgraph Mono["arch = monolithic (v1 default)"]
        LIVEM["Gemini Live agent (LIVEAGENT_VERTEXAI_MODEL): full rules + 6 tools"]
    end

    subgraph Brain["arch = brain (v2 default)"]
        LIVET["Thin Gemini Live voice agent: persona + 1 tool smart_home_request"]
        BR["brain.py: Flash Lite generateContent loop (BRAIN_MODEL, thinking MEDIUM)"]
        PREFIX["Static cacheable prefix: system instruction + tool declarations + examples"]
        TAIL["Dynamic tail: device state + recent history + language + request"]
    end

    TOOLS["tools.py: control_airconditioner / control_light / control_lock / control_camera / get_smart_home_devices_info"]
    CAM["check_camera -> camfeed.py: Flash Lite vision (SUBAGENT_LITE_MODEL)"]
    FS[("Firestore home-users/default")]
    MON["gemini_live_telemetry: Cloud Monitoring + metrics/*.json"]

    V1 -- "audio / text, no arch param" --> WS
    V2 -- "audio / text, arch=brain" --> WS
    WS --> ARCH
    ARCH -- "monolithic" --> LIVEM
    ARCH -- "brain" --> LIVET

    LIVEM -- "tool calls" --> TOOLS
    LIVEM -- "tool calls" --> CAM

    LIVET -- "smart_home_request(request, language)" --> BR
    BR -- "facts only, no IDs" --> LIVET
    PREFIX --> BR
    TAIL --> BR
    BR -- "function calls" --> TOOLS
    BR -- "function calls" --> CAM

    TOOLS --> FS
    FS -- "on_snapshot" --> SSE
    SSE -- "device grid updates" --> V1
    SSE -- "device grid updates" --> V2

    BR -. "mirrored functionCall / functionResponse + brain token usage" .-> SINK
    CAM -. "camera token usage" .-> SINK
    SINK -. "WebSocket only, never sent to Live" .-> WS
    WS -- "audio, transcripts, token_usage, session_info, mirrored events" --> V1
    WS -- "audio, transcripts, token_usage, session_info, mirrored events" --> V2
    WS --> TRACE
    LIVEM -.-> MON
    LIVET -.-> MON
```

- Resolution order: `?arch=` on the WebSocket → `SMARTHOME_AGENT_ARCH` in `.env` → `monolithic`.
- A/B in v2: open `/live-smarthome-agent/v2?arch=monolithic`.
- UI compatibility: every tool the brain runs is mirrored to the WebSocket as an ADK-shaped `functionCall`/`functionResponse` event (never sent to the Live session), so v1 and v2 hero cards, camera modal and tool logs work under either architecture.
- Brain token usage (incl. `cached_content_token_count`) is logged as `subagent_usage ... brain ...` rows in `gemini_usage_trace.log` and shown in v2 under **Telemetry & Vocabulary → BRAIN (SUB-AGENT)**.
