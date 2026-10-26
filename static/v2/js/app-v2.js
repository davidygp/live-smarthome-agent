/**
 * Supabase-Themed v2 Visuals Controller
 * Connects to existing live-smarthome-agent backend services without backend modifications.
 * Includes Supabase Dynamic Hero Action HUD for device activation and control.
 */

import { startAudioPlayerWorklet } from "/live-smarthome-agent/static/js/audio-player.js";
import { startAudioRecorderWorklet } from "/live-smarthome-agent/static/js/audio-recorder.js";

// Session / Identity State
const userId = "demo-user";
function generateSessionId() {
    return "supabase-session-" + Math.random().toString(36).substring(7);
}
let sessionId = generateSessionId();

// Cached Devices Topology
const devicesCache = {};

// Device Icons (SVG)
const deviceIcons = {
    ac: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12h20M12 2v20M20 16l-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4"/></svg>`,
    airconditioner: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M2 12h20M12 2v20M20 16l-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4"/></svg>`,
    camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`,
    light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-7 7c0 3 2 5 2 7h10c0-2 2-4 2-7a7 7 0 0 0-7-7z"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    default: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
};

// Connection & Audio Nodes
let websocket = null;
let isConnected = false;
let isConnecting = false;
let audioPlayerNode = null;
let audioPlayerContext = null;
let audioRecorderNode = null;
let audioRecorderContext = null;
let micStream = null;

// DOM Elements
const orbWrapper = document.getElementById("orb-wrapper");
const stateLabel = document.getElementById("state-label");
const stateSubtext = document.getElementById("state-subtext");
const connectBtn = document.getElementById("connect-btn");
const endBtn = document.getElementById("end-btn");
const statusPill = document.getElementById("status-pill");
const statusText = document.getElementById("status-text");

const userTranscriptBox = document.getElementById("transcript-user");
const aiTranscriptBox = document.getElementById("transcript-ai");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");

const voiceSelect = document.getElementById("voice-select");
const affectiveToggle = document.getElementById("affective-toggle");
const proactiveToggle = document.getElementById("proactive-toggle");

const terminalStream = document.getElementById("terminal-stream");
const terminalClear = document.getElementById("terminal-clear");
const toastStack = document.getElementById("toast-stack");

// Dynamic Hero HUD Elements
const heroOverlay = document.getElementById("hero-overlay");
const heroStack = document.getElementById("hero-stack");
const rightPanelContent = document.getElementById("right-panel-content");
let heroDismissTimeout = null;

// Camera Modal Elements
let currentCameraList = [];
let currentCameraIndex = 0;
const cameraModal = document.getElementById("camera-modal");
const modalTitle = document.getElementById("modal-title");
const modalPrevBtn = document.getElementById("modal-prev-btn");
const modalNextBtn = document.getElementById("modal-next-btn");
const modalImg = document.getElementById("modal-img");
const modalDesc = document.getElementById("modal-desc");
const modalClose = document.getElementById("modal-close");

// Device Grids & Telemetry
const climateGrid = document.getElementById("climate-grid");
const lightingGrid = document.getElementById("lighting-grid");
const securityGrid = document.getElementById("security-grid");
const cameraGrid = document.getElementById("camera-grid");

const totalDevicesEl = document.getElementById("telemetry-total");
const activeDevicesEl = document.getElementById("telemetry-active");
const climateActiveEl = document.getElementById("telemetry-climate");
const camerasCountEl = document.getElementById("telemetry-cameras");

// Token Usage Telemetry DOM Elements
const tokenTurnsBadgeEl = document.getElementById("v2-token-turns-badge");
const sessionCtxBadgeEl = document.getElementById("v2-session-ctx-badge");
const sessionTotalEl = document.getElementById("v2-session-total");
const sessionBreakdownEl = document.getElementById("v2-session-breakdown");
const sessionModalitiesEl = document.getElementById("v2-session-modalities");
const sessionModalitiesOutEl = document.getElementById("v2-session-modalities-out");
const callStepsBadgeEl = document.getElementById("v2-call-steps-badge");
const callTotalEl = document.getElementById("v2-call-total");
const callBreakdownEl = document.getElementById("v2-call-breakdown");
const callModalitiesEl = document.getElementById("v2-call-modalities");
const callModalitiesOutEl = document.getElementById("v2-call-modalities-out");
const cameraChecksBadgeEl = document.getElementById("v2-camera-checks-badge");
const cameraTotalEl = document.getElementById("v2-camera-total");
const cameraBreakdownEl = document.getElementById("v2-camera-breakdown");
const cameraModalitiesEl = document.getElementById("v2-camera-modalities");

// =========================================================================
// Token Usage State & Helpers (Session, Per-Call & Camera Sub-Agent)
//
// Billing semantics: the Live API re-processes (and bills) the entire context
// window on every model turn, so per-turn prompt counts — including per-modality
// AUDIO/IMAGE/TEXT — are SUMMED. "audioInNew" tracks only audio that was not
// present in the previous turn's context (informational, not billed).
// Camera checks are separate generate_content calls made by the check_camera
// tool; they are added to Session/Call totals and broken out on their own.
// =========================================================================

function emptyUsageBucket() {
    return {
        total: 0, prompt: 0, output: 0, thoughts: 0, cached: 0, toolUse: 0,
        audioIn: 0, audioInNew: 0, imageIn: 0, textIn: 0, audioOut: 0,
        cameraTotal: 0,
    };
}

const sessionUsage = Object.assign(emptyUsageBucket(), {
    latestContext: 0,
    prevPrompt: 0,
    prevAudioIn: 0,
    calls: 0,
    turns: 0
});

const callUsage = Object.assign(emptyUsageBucket(), {
    netPromptDelta: 0,
    steps: 0
});

const cameraUsage = {
    total: 0, prompt: 0, output: 0, thoughts: 0, cached: 0,
    imageIn: 0, textIn: 0, checks: 0
};

let callHasAiActivity = false;
let userUtteranceActive = false;
let turnInProgress = false;

function parseModalityTokens(detailsStr) {
    const result = { TEXT: 0, AUDIO: 0, IMAGE: 0 };
    if (!detailsStr || typeof detailsStr !== "string") return result;
    detailsStr.split("|").forEach((pair) => {
        const [rawMod, rawCount] = pair.split(":");
        if (!rawMod) return;
        const count = parseInt(rawCount, 10) || 0;
        const modUpper = rawMod.toUpperCase();
        if (modUpper.includes("AUDIO")) result.AUDIO += count;
        else if (modUpper.includes("TEXT")) result.TEXT += count;
        else if (modUpper.includes("IMAGE") || modUpper.includes("VIDEO")) result.IMAGE += count;
    });
    return result;
}

function formatNum(n) {
    return (n || 0).toLocaleString("en-US");
}

function inputModalitiesLabel(u) {
    return `Audio In: ${formatNum(u.audioIn)} (new ${formatNum(u.audioInNew)}) · Image In: ${formatNum(u.imageIn)} · Text In: ${formatNum(u.textIn)}`;
}

function outputModalitiesLabel(u) {
    const toolUse = u.toolUse > 0 ? ` · Tool Use: ${formatNum(u.toolUse)}` : "";
    return `Audio Out: ${formatNum(u.audioOut)} · Cache: ${formatNum(u.cached)} · Camera: ${formatNum(u.cameraTotal)}${toolUse}`;
}

function renderTokenUsageUI(pulseCallBox = false) {
    if (tokenTurnsBadgeEl) {
        tokenTurnsBadgeEl.innerText = `${sessionUsage.calls} ${sessionUsage.calls === 1 ? "call" : "calls"} · ${sessionUsage.turns} ${sessionUsage.turns === 1 ? "turn" : "turns"}`;
    }
    if (sessionCtxBadgeEl) {
        sessionCtxBadgeEl.innerText = `Ctx: ${formatNum(sessionUsage.latestContext)}`;
    }
    if (sessionTotalEl) {
        sessionTotalEl.innerText = formatNum(sessionUsage.total);
    }
    if (sessionBreakdownEl) {
        sessionBreakdownEl.innerText = `In: ${formatNum(sessionUsage.prompt)} · Out: ${formatNum(sessionUsage.output)} · Think: ${formatNum(sessionUsage.thoughts)}`;
    }
    if (sessionModalitiesEl) {
        sessionModalitiesEl.innerText = inputModalitiesLabel(sessionUsage);
    }
    if (sessionModalitiesOutEl) {
        sessionModalitiesOutEl.innerText = outputModalitiesLabel(sessionUsage);
    }

    if (callStepsBadgeEl) {
        const callLabel = sessionUsage.calls > 0 ? `Call #${sessionUsage.calls} · ` : "";
        callStepsBadgeEl.innerText = `${callLabel}${callUsage.steps} ${callUsage.steps === 1 ? "step" : "steps"}`;
    }
    if (callTotalEl) {
        callTotalEl.innerText = formatNum(callUsage.total);
    }
    if (callBreakdownEl) {
        const inLabel = callUsage.prompt > 0
            ? `${formatNum(callUsage.prompt)} (Δ ${formatNum(callUsage.netPromptDelta)})`
            : "0";
        callBreakdownEl.innerText = `In: ${inLabel} · Out: ${formatNum(callUsage.output)} · Think: ${formatNum(callUsage.thoughts)}`;
    }
    if (callModalitiesEl) {
        callModalitiesEl.innerText = inputModalitiesLabel(callUsage);
    }
    if (callModalitiesOutEl) {
        callModalitiesOutEl.innerText = outputModalitiesLabel(callUsage);
    }

    if (cameraChecksBadgeEl) {
        cameraChecksBadgeEl.innerText = `${cameraUsage.checks} ${cameraUsage.checks === 1 ? "check" : "checks"}`;
    }
    if (cameraTotalEl) {
        cameraTotalEl.innerText = formatNum(cameraUsage.total);
    }
    if (cameraBreakdownEl) {
        cameraBreakdownEl.innerText = `In: ${formatNum(cameraUsage.prompt)} · Out: ${formatNum(cameraUsage.output)} · Think: ${formatNum(cameraUsage.thoughts)}`;
    }
    if (cameraModalitiesEl) {
        cameraModalitiesEl.innerText = `Image In: ${formatNum(cameraUsage.imageIn)} · Text In: ${formatNum(cameraUsage.textIn)} · Cache: ${formatNum(cameraUsage.cached)}`;
    }

    if (pulseCallBox && callTotalEl) {
        const box = callTotalEl.closest(".token-stat-box");
        if (box) {
            box.classList.remove("pulse-update");
            void box.offsetWidth;
            box.classList.add("pulse-update");
            setTimeout(() => box.classList.remove("pulse-update"), 600);
        }
    }
}

function resetSessionUsage() {
    Object.assign(sessionUsage, emptyUsageBucket(), {
        latestContext: 0, prevPrompt: 0, prevAudioIn: 0, calls: 0, turns: 0
    });
    Object.assign(callUsage, emptyUsageBucket(), { netPromptDelta: 0, steps: 0 });
    Object.assign(cameraUsage, {
        total: 0, prompt: 0, output: 0, thoughts: 0, cached: 0,
        imageIn: 0, textIn: 0, checks: 0
    });
    callHasAiActivity = false;
    userUtteranceActive = false;
    turnInProgress = false;
    renderTokenUsageUI(false);
}

function startNewCall() {
    sessionUsage.calls += 1;
    Object.assign(callUsage, emptyUsageBucket(), { netPromptDelta: 0, steps: 0 });
    callHasAiActivity = false;
    renderTokenUsageUI(true);
}

function addToBucket(bucket, d) {
    for (const key of Object.keys(d)) {
        bucket[key] = (bucket[key] || 0) + d[key];
    }
}

// Live API usage (one event per model turn)
function handleTokenUsageEvent(payload) {
    const total = payload.totalTokenCount || 0;
    const prompt = payload.promptTokenCount || 0;
    const output = payload.candidatesTokenCount || 0;
    const thoughts = payload.thoughtsTokenCount || 0;
    const cached = payload.cachedContentTokenCount || 0;
    const toolUse = payload.toolUsePromptTokenCount || 0;

    const pMod = parseModalityTokens(payload.promptTokensDetails);
    const cMod = parseModalityTokens(payload.candidatesTokensDetails);

    // Incremental deltas of the cumulative context (informational only)
    const audioInDelta = Math.max(0, pMod.AUDIO - sessionUsage.prevAudioIn);
    const promptDelta = Math.max(0, prompt - sessionUsage.prevPrompt);
    if (pMod.AUDIO > 0) sessionUsage.prevAudioIn = pMod.AUDIO;
    if (prompt > 0) sessionUsage.prevPrompt = prompt;

    const delta = {
        total, prompt, output, thoughts, cached, toolUse,
        audioIn: pMod.AUDIO,          // billed: full audio context re-processed each turn
        audioInNew: audioInDelta,
        imageIn: pMod.IMAGE,
        textIn: pMod.TEXT,
        audioOut: cMod.AUDIO,
    };

    // 1. Always accumulate into Session Total
    addToBucket(sessionUsage, delta);
    if (prompt > 0) sessionUsage.latestContext = prompt;
    sessionUsage.turns += 1;

    // 2. Accumulate into Per-Call stats once the user has initiated a call
    if (sessionUsage.calls > 0) {
        addToBucket(callUsage, delta);
        callUsage.netPromptDelta += promptDelta;
        callUsage.steps += 1;
        callHasAiActivity = true;
    }

    renderTokenUsageUI(sessionUsage.calls > 0);

    const scopeLabel = sessionUsage.calls > 0
        ? `Call #${sessionUsage.calls} (Step ${callUsage.steps})`
        : `Session Handshake`;
    logTerminal(
        "TOKENS",
        `${scopeLabel}: +${formatNum(total)} tokens (In: ${formatNum(prompt)} [Δ ${formatNum(promptDelta)}; Audio ${formatNum(pMod.AUDIO)}, Image ${formatNum(pMod.IMAGE)}, Text ${formatNum(pMod.TEXT)}], Out: ${formatNum(output)}, Think: ${formatNum(thoughts)}) | Session Total: ${formatNum(sessionUsage.total)}`,
        false
    );
}

// Camera check sub-agent usage (one event per camera analysed)
function handleSubagentTokenUsageEvent(payload) {
    const d = {
        total: payload.totalTokenCount || 0,
        prompt: payload.promptTokenCount || 0,
        output: payload.candidatesTokenCount || 0,
        thoughts: payload.thoughtsTokenCount || 0,
        cached: payload.cachedContentTokenCount || 0,
        imageIn: payload.imageInTokenCount || 0,
        textIn: payload.textInTokenCount || 0,
    };

    addToBucket(cameraUsage, d);
    cameraUsage.checks += 1;

    // Fold into Session / Call totals (no audio for the vision sub-agent)
    const rollup = {
        total: d.total, prompt: d.prompt, output: d.output, thoughts: d.thoughts,
        cached: d.cached, imageIn: d.imageIn, textIn: d.textIn, cameraTotal: d.total,
    };
    addToBucket(sessionUsage, rollup);
    if (sessionUsage.calls > 0) {
        addToBucket(callUsage, rollup);
        callHasAiActivity = true;
    }

    renderTokenUsageUI(sessionUsage.calls > 0);

    logTerminal(
        "TOKENS",
        `Camera ${payload.cameraId || "?"} (${payload.model || "sub-agent"}): +${formatNum(d.total)} tokens (In: ${formatNum(d.prompt)} [Image ${formatNum(d.imageIn)}, Text ${formatNum(d.textIn)}], Out: ${formatNum(d.output)}, Think: ${formatNum(d.thoughts)}) | Session Total: ${formatNum(sessionUsage.total)}`,
        false
    );
}

// =========================================================================
// UI State Updates
// =========================================================================

function setAgentState(state) {
    if (!orbWrapper || !stateLabel) return;
    orbWrapper.className = `orb-wrapper state-${state.toLowerCase()}`;
    
    const descriptions = {
        'IDLE': { label: 'System Idle', subtext: 'Tap orb or Connect to begin' },
        'LISTENING': { label: 'Listening', subtext: 'Streaming microphone audio...' },
        'THINKING': { label: 'Thinking', subtext: 'Processing neural multi-agent turn...' },
        'SPEAKING': { label: 'Speaking', subtext: 'Synthesizing voice response...' }
    };
    const current = descriptions[state] || descriptions['IDLE'];
    stateLabel.innerText = current.label;
    stateSubtext.innerText = current.subtext;

    const transcriptBadge = document.getElementById("transcript-state-badge");
    if (transcriptBadge) {
        transcriptBadge.innerText = state;
    }
}

function updateConnectionUI(connected) {
    const transcriptBadge = document.getElementById("transcript-state-badge");
    if (connected) {
        statusPill.classList.add("online");
        statusText.innerText = "Connected (BIDI)";
        connectBtn.style.display = "none";
        endBtn.classList.add("visible");
        setAgentState("LISTENING");
        if (transcriptBadge) transcriptBadge.innerText = "ONLINE";
    } else {
        statusPill.classList.remove("online");
        statusText.innerText = "Disconnected";
        connectBtn.style.display = "flex";
        endBtn.classList.remove("visible");
        setAgentState("IDLE");
        if (userTranscriptBox) userTranscriptBox.innerText = "Press connect, then speak...";
        if (aiTranscriptBox) aiTranscriptBox.innerText = "";
        if (transcriptBadge) transcriptBadge.innerText = "OFFLINE";
    }
}

// Log into Supabase Terminal Stream
function logTerminal(tag, message, isResponse = false) {
    if (!terminalStream) return;
    const row = document.createElement("div");
    row.className = "stream-row";
    
    const now = new Date();
    const timeStr = now.toTimeString().split(" ")[0];

    const tagClass = tag === "TOKENS"
        ? "stream-tag usage"
        : (isResponse ? "stream-tag response" : "stream-tag call");
    row.innerHTML = `
        <span class="stream-time">${timeStr}</span>
        <span class="${tagClass}">${tag}</span>
        <span class="stream-msg">${escapeHtml(message)}</span>
    `;
    terminalStream.appendChild(row);
    terminalStream.scrollTop = terminalStream.scrollHeight;
}

function escapeHtml(str) {
    if (typeof str !== "string") str = JSON.stringify(str);
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

if (terminalClear) {
    terminalClear.addEventListener("click", () => {
        terminalStream.innerHTML = "";
    });
}

// =========================================================================
// SUPABASE DYNAMIC HERO HUD (v2 Equivalent of v1 Hero Stack)
// =========================================================================

function triggerHeroAction(eventPayload, toolName = "") {
    if (!heroOverlay || !heroStack || !rightPanelContent) return;

    // Activate blur on underlying dashboard and fade in HUD overlay
    if (!heroOverlay.classList.contains("active")) {
        heroOverlay.classList.add("active");
        rightPanelContent.classList.add("grid-blurred");
    }

    const deviceId = eventPayload.id || "device";
    const cached = devicesCache[deviceId] || {};
    const deviceLabel = eventPayload.deviceLabel || cached.deviceLabel || deviceId;
    const room = eventPayload.room || cached.room || "Smart Home";
    
    const rawType = cached.deviceType || (
        deviceId.startsWith("ac-") ? "ac" :
        deviceId.startsWith("light-") ? "light" :
        deviceId.startsWith("lock-") ? "lock" :
        deviceId.startsWith("cam-") ? "camera" : "default"
    );
    const deviceType = rawType.toLowerCase();

    const oldState = (eventPayload.oldState || cached.state || "off").toLowerCase();
    const newState = (eventPayload.newState || eventPayload.state || "on").toLowerCase();
    const currentSetting = (eventPayload.currentSettingValue || cached.currentSettingValue || "").toLowerCase();
    const oldSetting = (eventPayload.oldSettingValue || cached.oldSettingValue || "").toLowerCase();

    let actionClass = "state-on";
    let actionLabel = "Turned On";
    let metricText = "Active";
    let techEyebrow = "HARDWARE_NODE";

    if (newState === "off") {
        actionClass = "state-off";
        actionLabel = "Turned Off";
        metricText = "Standby";
        techEyebrow = "POWER_SUSPEND";
        if (deviceType === "camera") { actionLabel = "Feed Paused"; metricText = "Offline"; }
        if (deviceType === "lock") { actionLabel = "Disengaged"; metricText = "Unlocked"; }
    } else {
        if (deviceType === "ac" || deviceType === "airconditioner") {
            techEyebrow = "HVAC_CONTROLLER";
            const newTemp = parseFloat(eventPayload.currentSettingValue || cached.currentSettingValue || "24");
            const oldTemp = parseFloat(eventPayload.oldSettingValue || cached.oldSettingValue || "24");

            if (oldState === "off") {
                actionClass = "state-on";
                actionLabel = "Unit Engaged";
                metricText = `${newTemp}°C`;
            } else if (newTemp < oldTemp) {
                actionClass = "state-cooling";
                actionLabel = "Cooling Cycle";
                metricText = `${newTemp}°C`;
            } else if (newTemp > oldTemp) {
                actionClass = "state-heating";
                actionLabel = "Heating Cycle";
                metricText = `${newTemp}°C`;
            } else {
                actionClass = "state-on";
                actionLabel = "Target Set";
                metricText = `${newTemp}°C`;
            }
        } else if (deviceType === "camera") {
            techEyebrow = "SURVEILLANCE_NODE";
            if (currentSetting === "online") {
                actionClass = "state-cooling";
                actionLabel = "Stream Live";
                metricText = "Online";
            } else if (currentSetting === "private") {
                actionClass = "state-heating";
                actionLabel = "Privacy Guard";
                metricText = "Private";
            } else if (currentSetting === "protect") {
                actionClass = "state-on";
                actionLabel = "Sentry Active";
                metricText = "Protect";
            } else {
                actionClass = "state-on";
                actionLabel = "Sensor Online";
                metricText = "Active";
            }
        } else if (deviceType === "lock") {
            techEyebrow = "PERIMETER_SECURITY";
            if (currentSetting === "dnd") {
                actionClass = "state-on";
                actionLabel = "Lockdown / DND";
                metricText = "Secure";
            } else if (currentSetting === "guest") {
                actionClass = "state-cooling";
                actionLabel = "Access Pass";
                metricText = "Guest";
            } else if (currentSetting === "party") {
                actionClass = "state-heating";
                actionLabel = "Entry Mode";
                metricText = "Party";
            } else {
                actionClass = "state-on";
                actionLabel = "Deadbolt Engaged";
                metricText = "Locked";
            }
        } else if (deviceType === "light") {
            techEyebrow = "LUMINANCE_NODE";
            if (currentSetting === "cool") {
                actionClass = "state-cooling";
                actionLabel = "Daylight 5000K";
                metricText = "Cool";
            } else if (currentSetting === "movie") {
                actionClass = "state-heating";
                actionLabel = "Cinema Accent";
                metricText = "Movie";
            } else if (currentSetting === "warm") {
                actionClass = "state-on";
                actionLabel = "Warm 2700K";
                metricText = "Warm";
            } else {
                actionClass = "state-on";
                actionLabel = "Illuminated";
                metricText = "On";
            }
        }
    }

    const iconSvg = deviceIcons[deviceType] || deviceIcons["default"];

    const card = document.createElement("div");
    card.className = `supabase-hero-card ${actionClass}`;
    card.innerHTML = `
        <div class="hero-card-icon-box">
            ${iconSvg}
        </div>
        <div class="hero-card-content">
            <div class="hero-tech-eyebrow">[${techEyebrow}]</div>
            <div class="hero-card-title">${escapeHtml(deviceLabel)}</div>
            <div class="hero-card-sub">${escapeHtml(room)} · ${deviceId}</div>
        </div>
        <div class="hero-card-metric-block">
            <span class="hero-action-pill ${actionClass}">${actionLabel}</span>
            <span class="hero-metric-text">${metricText}</span>
        </div>
        <div class="hero-dismiss-bar"></div>
    `;

    heroStack.appendChild(card);
    heroStack.scrollTo({ top: heroStack.scrollHeight, behavior: "smooth" });

    // Flash the corresponding card in the grid
    const targetCard = document.getElementById(`card-${deviceId}`);
    if (targetCard) {
        targetCard.classList.remove("flash-active");
        void targetCard.offsetWidth; // trigger DOM reflow to restart animation
        targetCard.classList.add("flash-active");
    }

    // Auto-dismiss countdown after 3.5s
    if (heroDismissTimeout) clearTimeout(heroDismissTimeout);
    heroDismissTimeout = setTimeout(() => {
        heroOverlay.classList.remove("active");
        rightPanelContent.classList.remove("grid-blurred");
        setTimeout(() => { heroStack.innerHTML = ""; }, 400);
    }, 3500);
}

// Window export for backwards-compatibility
window.addDynamicHeroAction = triggerHeroAction;

// Interactive Toggle via REST API
async function toggleDeviceState(deviceId) {
    const device = devicesCache[deviceId];
    if (!device) return;

    const currentIsOn = (device.state || "").toLowerCase() === "on";
    const newStateStr = currentIsOn ? "off" : "on";

    // Immediate optimistic hero trigger
    triggerHeroAction({
        id: deviceId,
        deviceLabel: device.deviceLabel,
        room: device.room,
        oldState: device.state,
        newState: newStateStr,
        oldSettingValue: device.currentSettingValue,
        currentSettingValue: device.currentSettingValue || device.defaultSettingValue
    });

    try {
        await fetch("/live-smarthome-agent/api/devices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                devices: {
                    [deviceId]: {
                        state: newStateStr
                    }
                }
            })
        });
        logTerminal("SYS", `Manual toggle sent for ${deviceId} -> ${newStateStr}`, true);
    } catch (e) {
        console.error("Failed to toggle device:", e);
    }
}

// =========================================================================
// Audio Worklet & WebSocket Pipeline
// =========================================================================

function audioRecorderHandler(pcmData) {
    if (websocket && websocket.readyState === WebSocket.OPEN && isConnected) {
        websocket.send(pcmData);
    }
}

async function connect() {
    if (isConnected || isConnecting) return;
    isConnecting = true;
    updateConnectionUI(false);
    stateLabel.innerText = "Connecting...";

    try {
        const [pNode, pCtx] = await startAudioPlayerWorklet();
        audioPlayerNode = pNode;
        audioPlayerContext = pCtx;

        audioPlayerNode.port.onmessage = (event) => {
            if (event.data.command === "playbackComplete") {
                setAgentState("LISTENING");
            }
        };

        const [rNode, rCtx, stream] = await startAudioRecorderWorklet(audioRecorderHandler);
        audioRecorderNode = rNode;
        audioRecorderContext = rCtx;
        micStream = stream;
    } catch (err) {
        alert("Audio hardware initialization failed: " + err.message);
        console.error(err);
        if (micStream) micStream.getTracks().forEach(t => t.stop());
        isConnecting = false;
        setAgentState("IDLE");
        return;
    }

    sessionId = generateSessionId();

    const voice = voiceSelect ? voiceSelect.value : "aoede";
    const affective = affectiveToggle && affectiveToggle.classList.contains("active");
    const proactive = proactiveToggle && proactiveToggle.classList.contains("active");

    const params = new URLSearchParams({
        voice: voice,
        affective_dialog: affective,
        proactive_audio: proactive
    });

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/live-smarthome-agent/ws/${userId}/${sessionId}?${params.toString()}`;

    logTerminal("SYS", `Opening WebSocket stream to ${wsUrl}`);
    websocket = new WebSocket(wsUrl);
    websocket.binaryType = "arraybuffer";

    websocket.onopen = () => {
        isConnected = true;
        isConnecting = false;
        resetSessionUsage();
        updateConnectionUI(true);
        logTerminal("SYS", "Gemini Live BIDI stream established.", true);
    };

    let aiTurnActive = false;

    websocket.onmessage = (event) => {
        // Raw Audio Binary Stream
        if (event.data instanceof ArrayBuffer) {
            callHasAiActivity = true;
            if (audioPlayerNode) {
                audioPlayerNode.port.postMessage(event.data);
                setAgentState("SPEAKING");
            }
            return;
        }

        // ADK JSON Events
        let adkEvent;
        try {
            adkEvent = JSON.parse(event.data);
        } catch {
            return;
        }

        // Dedicated Token Usage Event from main.py
        if (adkEvent.type === "token_usage") {
            handleTokenUsageEvent(adkEvent);
            return;
        }

        // Camera check sub-agent usage (side channel from main.py)
        if (adkEvent.type === "subagent_token_usage") {
            handleSubagentTokenUsageEvent(adkEvent);
            return;
        }

        // User transcription
        if (adkEvent.inputTranscription && adkEvent.inputTranscription.text) {
            if (!userUtteranceActive && !turnInProgress && (sessionUsage.calls === 0 || callHasAiActivity)) {
                startNewCall();
            }
            userUtteranceActive = !adkEvent.inputTranscription.finished;

            const txt = adkEvent.inputTranscription.text;
            userTranscriptBox.innerText = `"${txt}"`;
            if (!adkEvent.inputTranscription.finished) {
                setAgentState("THINKING");
            }
        }

        // Agent transcription
        if (adkEvent.outputTranscription && adkEvent.outputTranscription.text) {
            callHasAiActivity = true;
            const txt = adkEvent.outputTranscription.text;
            if (adkEvent.outputTranscription.finished || !adkEvent.partial) {
                aiTranscriptBox.innerText = txt;
            } else if (!aiTurnActive) {
                aiTranscriptBox.innerText = txt;
                aiTurnActive = true;
            } else {
                aiTranscriptBox.innerText += txt;
            }
        }

        // Tool calls & responses
        if (adkEvent.content && adkEvent.content.parts) {
            adkEvent.content.parts.forEach((part, index) => {
                if (part.functionCall) {
                    callHasAiActivity = true;
                    turnInProgress = true;
                    const name = part.functionCall.name;
                    const args = part.functionCall.args || {};
                    logTerminal("CALL", `${name}(${JSON.stringify(args)})`, false);
                }

                if (part.functionResponse) {
                    callHasAiActivity = true;
                    turnInProgress = true;
                    const name = part.functionResponse.name;
                    const resp = part.functionResponse.response;
                    logTerminal("RESULT", `${name} -> ${JSON.stringify(resp)}`, true);

                    // Camera check modal
                    if (name === "check_camera") {
                        handleCameraResponse(resp);
                    }

                    // Device action update HUD (Dynamic Hero Stack!)
                    if (["control_airconditioner", "control_light", "control_lock", "control_camera"].includes(name)) {
                        // Stagger hero animations by 300ms if multiple devices updated
                        setTimeout(() => {
                            triggerHeroAction(resp, name);
                        }, 300 + index * 300);
                    }
                }
            });
        }

        // Turn complete
        if (adkEvent.turnComplete) {
            aiTurnActive = false;
            userUtteranceActive = false;
            turnInProgress = false;
            if (audioPlayerNode) {
                audioPlayerNode.port.postMessage({ command: "endOfTurn" });
            } else {
                setAgentState("LISTENING");
            }
        }

        // Interruption
        if (adkEvent.interrupted) {
            if (audioPlayerNode) {
                audioPlayerNode.port.postMessage({ command: "endOfAudio" });
            }
            aiTurnActive = false;
            userUtteranceActive = false;
            turnInProgress = false;
            setAgentState("LISTENING");
        }
    };

    websocket.onclose = () => {
        isConnected = false;
        isConnecting = false;
        updateConnectionUI(false);
        logTerminal(
            "SYS",
            `WebSocket closed. Final Session Tokens: ${formatNum(sessionUsage.total)} across ${sessionUsage.calls} calls (${sessionUsage.turns} model turns).`
        );

        if (micStream) {
            micStream.getTracks().forEach(t => t.stop());
            micStream = null;
        }
        if (audioPlayerContext && audioPlayerContext.state !== "closed") {
            audioPlayerContext.close();
        }
        if (audioRecorderContext && audioRecorderContext.state !== "closed") {
            audioRecorderContext.close();
        }
    };
}

function disconnect() {
    if (websocket && isConnected) {
        websocket.close();
    }
}

function sendText() {
    const text = chatInput.value.trim();
    if (!text) return;
    if (websocket && websocket.readyState === WebSocket.OPEN && isConnected) {
        startNewCall();
        userUtteranceActive = false;
        websocket.send(JSON.stringify({ type: "text", text: text }));
        userTranscriptBox.innerText = `"${text}"`;
        chatInput.value = "";
    } else {
        alert("Not connected. Connect to Gemini Live first.");
    }
}

// =========================================================================
// Real-Time Tool Actions & Modals
// =========================================================================

function handleCameraResponse(payload) {
    if (!payload || !cameraModal) return;

    // 1. Normalize list whether wrapped in .result or raw array/object or string
    let rawList = [];
    if (Array.isArray(payload)) {
        rawList = payload;
    } else if (payload.result && Array.isArray(payload.result)) {
        rawList = payload.result;
    } else if (typeof payload === "string") {
        try {
            const parsed = JSON.parse(payload);
            rawList = Array.isArray(parsed) ? parsed : (parsed.result || [parsed]);
        } catch {
            rawList = [];
        }
    } else if (typeof payload === "object") {
        rawList = [payload];
    }

    // 2. Filter for cameras that actually addressed the user query
    const addressedCameras = rawList.filter(cam => cam.is_user_query_addressed === true);
    currentCameraList = addressedCameras.length > 0 ? addressedCameras : rawList;

    if (currentCameraList.length === 0) return;

    currentCameraIndex = 0;
    renderActiveCameraModal();
    cameraModal.classList.add("open");
}

function renderActiveCameraModal() {
    if (currentCameraList.length === 0) return;
    const cam = currentCameraList[currentCameraIndex];
    if (!cam) return;

    const camId = cam.id || cam.cam_id || "cam-1";
    const room = cam.room || (devicesCache[camId]?.room) || "Camera Feed";
    const text = cam.response || cam.analysis || `Live surveillance feed for ${camId}.`;

    if (modalTitle) modalTitle.innerText = `${room} View (${camId})`;
    if (modalImg) modalImg.src = `/live-smarthome-agent/static/camview/${camId}.jpg?t=${Date.now()}`;
    if (modalDesc) modalDesc.innerText = text;

    // Carousel buttons display & state
    if (modalPrevBtn && modalNextBtn) {
        if (currentCameraList.length <= 1) {
            modalPrevBtn.style.display = "none";
            modalNextBtn.style.display = "none";
        } else {
            modalPrevBtn.style.display = "flex";
            modalNextBtn.style.display = "flex";
            modalPrevBtn.style.opacity = currentCameraIndex === 0 ? "0.3" : "1";
            modalPrevBtn.style.pointerEvents = currentCameraIndex === 0 ? "none" : "auto";
            modalNextBtn.style.opacity = currentCameraIndex === currentCameraList.length - 1 ? "0.3" : "1";
            modalNextBtn.style.pointerEvents = currentCameraIndex === currentCameraList.length - 1 ? "none" : "auto";
        }
    }
}

// =========================================================================
// Firestore SSE Real-Time Sync
// =========================================================================

function initFirestoreStream() {
    logTerminal("DB", "Subscribing to Firestore SSE stream: /api/devices/stream");
    const eventSource = new EventSource("/live-smarthome-agent/api/devices/stream");

    eventSource.onmessage = (event) => {
        try {
            const parsed = JSON.parse(event.data);
            if (parsed.exists && parsed.data && parsed.data.devices) {
                Object.assign(devicesCache, parsed.data.devices);
                renderDevices(parsed.data.devices);
            }
        } catch (err) {
            console.error("Failed to parse device stream payload", err);
        }
    };

    eventSource.onerror = () => {
        logTerminal("DB", "Firestore SSE stream reconnecting...");
    };
}

function renderDevices(devicesMap) {
    // Clear grids
    if (climateGrid) climateGrid.innerHTML = "";
    if (lightingGrid) lightingGrid.innerHTML = "";
    if (securityGrid) securityGrid.innerHTML = "";
    if (cameraGrid) cameraGrid.innerHTML = "";

    let total = 0;
    let active = 0;
    let climateActive = 0;
    let camerasCount = 0;

    Object.entries(devicesMap).forEach(([id, device]) => {
        total++;
        const isOn = (device.state || "").toLowerCase() === "on";
        if (isOn) active++;

        const type = (device.deviceType || "").toLowerCase();

        if (type === "airconditioner" || id.startsWith("ac-")) {
            if (isOn) climateActive++;
            climateGrid.appendChild(createClimateCard(device));
        } else if (type === "light" || id.startsWith("light-")) {
            lightingGrid.appendChild(createLightingCard(device));
        } else if (type === "lock" || id.startsWith("lock-")) {
            securityGrid.appendChild(createSecurityCard(device));
        } else if (type === "camera" || id.startsWith("cam-")) {
            camerasCount++;
            cameraGrid.appendChild(createCameraCard(device));
        }
    });

    if (totalDevicesEl) totalDevicesEl.innerText = total;
    if (activeDevicesEl) activeDevicesEl.innerText = active;
    if (climateActiveEl) climateActiveEl.innerText = climateActive;
    if (camerasCountEl) camerasCountEl.innerText = camerasCount;
}

function createClimateCard(device) {
    const card = document.createElement("div");
    const isOn = (device.state || "").toLowerCase() === "on";
    card.id = `card-${device.id}`;
    card.className = `device-card ${isOn ? "is-on active-glow" : ""}`;
    card.style.cursor = "pointer";
    card.title = "Click to toggle power";
    card.onclick = () => toggleDeviceState(device.id);

    card.innerHTML = `
        <div class="device-header">
            <div class="device-icon-box">
                ${deviceIcons.ac}
            </div>
            <div class="device-info">
                <div class="device-name">${device.deviceLabel || device.id}</div>
                <div class="device-room">${device.room || "Room"} · ${device.id}</div>
            </div>
            <span class="device-status-badge">${device.state?.toUpperCase() || "OFF"}</span>
        </div>
        <div class="device-body">
            <span class="device-setting-val">${device.currentSettingValue || device.defaultSettingValue || "24°C"}</span>
            <span class="card-badge">${device.settingLabel || "Mode"}: ${device.currentSettingValue || "Normal"}</span>
        </div>
    `;
    return card;
}

function createLightingCard(device) {
    const card = document.createElement("div");
    const isOn = (device.state || "").toLowerCase() === "on";
    card.id = `card-${device.id}`;
    card.className = `device-card ${isOn ? "is-on active-glow" : ""}`;
    card.style.cursor = "pointer";
    card.title = "Click to toggle light";
    card.onclick = () => toggleDeviceState(device.id);

    card.innerHTML = `
        <div class="device-header">
            <div class="device-icon-box">
                ${deviceIcons.light}
            </div>
            <div class="device-info">
                <div class="device-name">${device.deviceLabel || device.id}</div>
                <div class="device-room">${device.room || "Room"} · ${device.id}</div>
            </div>
            <span class="device-status-badge">${device.state?.toUpperCase() || "OFF"}</span>
        </div>
        <div class="device-body">
            <span class="device-setting-val">${device.currentSettingValue || "Warm"}</span>
            <span class="card-badge">Lighting</span>
        </div>
    `;
    return card;
}

function createSecurityCard(device) {
    const card = document.createElement("div");
    const isOn = (device.state || "").toLowerCase() === "on";
    card.id = `card-${device.id}`;
    card.className = `device-card ${isOn ? "is-on" : ""}`;
    card.style.cursor = "pointer";
    card.title = "Click to toggle lock state";
    card.onclick = () => toggleDeviceState(device.id);

    card.innerHTML = `
        <div class="device-header">
            <div class="device-icon-box">
                ${deviceIcons.lock}
            </div>
            <div class="device-info">
                <div class="device-name">${device.deviceLabel || device.id}</div>
                <div class="device-room">${device.room || "Front Door"} · ${device.id}</div>
            </div>
            <span class="device-status-badge">${device.currentSettingValue || (isOn ? "LOCKED" : "UNLOCKED")}</span>
        </div>
        <div class="device-body">
            <span class="device-setting-val">Access: ${device.defaultSettingValue || "Secure"}</span>
            <span class="card-badge">Deadbolt</span>
        </div>
    `;
    return card;
}

function createCameraCard(device) {
    const card = document.createElement("div");
    const isOn = (device.state || "").toLowerCase() === "on";
    card.id = `card-${device.id}`;
    card.className = `device-card camera-card ${isOn ? "is-on" : ""}`;
    card.style.cursor = "pointer";
    card.title = "Click to inspect camera";
    card.onclick = () => {
        handleCameraResponse({
            id: device.id,
            room: device.room,
            response: `Camera ${device.id} (${device.room}) live inspection feed. Mode: ${device.currentSettingValue || "Active"}.`,
            is_user_query_addressed: true
        });
    };

    card.innerHTML = `
        <div class="cam-preview-box">
            <img src="/live-smarthome-agent/static/camview/${device.id}.jpg" onerror="this.src='/live-smarthome-agent/static/livingroom.avif'" alt="${device.id}">
            <div class="cam-overlay-badge">${device.room || "Camera"} · ${device.currentSettingValue || "Online"}</div>
        </div>
        <div class="device-header" style="margin-top: 4px;">
            <div class="device-info" style="margin-left: 0;">
                <div class="device-name">${device.deviceLabel || device.id}</div>
                <div class="device-room">${device.id} · Mode: ${device.currentSettingValue || "Active"}</div>
            </div>
            <span class="device-status-badge">${device.state?.toUpperCase() || "OFF"}</span>
        </div>
    `;
    return card;
}

// =========================================================================
// Version Switcher Helper
// =========================================================================
window.switchUiVersion = function(version) {
    document.cookie = `ui_version=${version}; path=/live-smarthome-agent; max-age=31536000; SameSite=Lax`;
    window.location.href = `/live-smarthome-agent?ui=${version}`;
};

// =========================================================================
// Initialization & Event Binding
// =========================================================================

document.addEventListener("DOMContentLoaded", () => {
    if (connectBtn) connectBtn.addEventListener("click", connect);
    if (endBtn) endBtn.addEventListener("click", disconnect);
    if (orbWrapper) orbWrapper.addEventListener("click", () => {
        if (!isConnected) connect();
        else disconnect();
    });

    if (chatSendBtn) chatSendBtn.addEventListener("click", sendText);
    if (chatInput) {
        chatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendText();
            }
        });
    }

    if (affectiveToggle) {
        affectiveToggle.addEventListener("click", () => {
            affectiveToggle.classList.toggle("active");
        });
    }
    if (proactiveToggle) {
        proactiveToggle.addEventListener("click", () => {
            proactiveToggle.classList.toggle("active");
        });
    }

    if (modalClose) {
        modalClose.addEventListener("click", () => {
            cameraModal.classList.remove("open");
        });
    }
    if (cameraModal) {
        cameraModal.addEventListener("click", (e) => {
            if (e.target === cameraModal) cameraModal.classList.remove("open");
        });
    }
    if (modalPrevBtn) {
        modalPrevBtn.addEventListener("click", () => {
            if (currentCameraIndex > 0) {
                currentCameraIndex--;
                renderActiveCameraModal();
            }
        });
    }
    if (modalNextBtn) {
        modalNextBtn.addEventListener("click", () => {
            if (currentCameraIndex < currentCameraList.length - 1) {
                currentCameraIndex++;
                renderActiveCameraModal();
            }
        });
    }

    // Start SSE stream
    initFirestoreStream();
});
