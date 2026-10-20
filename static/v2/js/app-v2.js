/**
 * Supabase-Themed v2 Visuals Controller
 * Connects to existing live-smarthome-agent backend services without backend modifications.
 */

import { startAudioPlayerWorklet } from "/live-smarthome-agent/static/js/audio-player.js";
import { startAudioRecorderWorklet } from "/live-smarthome-agent/static/js/audio-recorder.js";

// Session / Identity State
const userId = "demo-user";
function generateSessionId() {
    return "supabase-session-" + Math.random().toString(36).substring(7);
}
let sessionId = generateSessionId();

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

// Camera Modal Elements
const cameraModal = document.getElementById("camera-modal");
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
}

function updateConnectionUI(connected) {
    if (connected) {
        statusPill.classList.add("online");
        statusText.innerText = "Connected (BIDI)";
        connectBtn.style.display = "none";
        endBtn.classList.add("visible");
        setAgentState("LISTENING");
    } else {
        statusPill.classList.remove("online");
        statusText.innerText = "Disconnected";
        connectBtn.style.display = "flex";
        endBtn.classList.remove("visible");
        setAgentState("IDLE");
    }
}

// Log into Supabase Terminal Stream
function logTerminal(tag, message, isResponse = false) {
    if (!terminalStream) return;
    const row = document.createElement("div");
    row.className = "stream-row";
    
    const now = new Date();
    const timeStr = now.toTimeString().split(" ")[0];

    const tagClass = isResponse ? "stream-tag response" : "stream-tag call";
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

// Supabase Toast Notification
function showToast(message) {
    if (!toastStack) return;
    const toast = document.createElement("div");
    toast.className = "supabase-toast";
    toast.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3ecf8e" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>${message}</span>
    `;
    toastStack.appendChild(toast);
    setTimeout(() => {
        toast.style.transition = "opacity 0.3s ease, transform 0.3s ease";
        toast.style.opacity = "0";
        toast.style.transform = "translateY(10px)";
        setTimeout(() => toast.remove(), 300);
    }, 4000);
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
        updateConnectionUI(true);
        logTerminal("SYS", "Gemini Live BIDI stream established.", true);
    };

    let aiTurnActive = false;

    websocket.onmessage = (event) => {
        // Raw Audio Binary Stream
        if (event.data instanceof ArrayBuffer) {
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

        // User transcription
        if (adkEvent.inputTranscription && adkEvent.inputTranscription.text) {
            const txt = adkEvent.inputTranscription.text;
            userTranscriptBox.innerText = `"${txt}"`;
            if (!adkEvent.inputTranscription.finished) {
                setAgentState("THINKING");
            }
        }

        // Agent transcription
        if (adkEvent.outputTranscription && adkEvent.outputTranscription.text) {
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
            adkEvent.content.parts.forEach((part) => {
                if (part.functionCall) {
                    const name = part.functionCall.name;
                    const args = part.functionCall.args || {};
                    logTerminal("CALL", `${name}(${JSON.stringify(args)})`, false);
                }

                if (part.functionResponse) {
                    const name = part.functionResponse.name;
                    const resp = part.functionResponse.response;
                    logTerminal("RESULT", `${name} -> ${JSON.stringify(resp)}`, true);

                    // Camera check modal
                    if (name === "check_camera") {
                        handleCameraResponse(resp);
                    }

                    // Device action update toast
                    if (["control_airconditioner", "control_light", "control_lock", "control_camera"].includes(name)) {
                        handleDeviceAction(name, resp);
                    }
                }
            });
        }

        // Turn complete
        if (adkEvent.turnComplete) {
            aiTurnActive = false;
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
            setAgentState("LISTENING");
        }
    };

    websocket.onclose = () => {
        isConnected = false;
        isConnecting = false;
        updateConnectionUI(false);
        logTerminal("SYS", "WebSocket closed.");

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
    const analysis = payload.analysis || (Array.isArray(payload) ? payload[0]?.analysis : "Camera analyzed.");
    const camId = payload.cam_id || (Array.isArray(payload) ? payload[0]?.cam_id : "cam-1");
    
    modalImg.src = `/live-smarthome-agent/static/camview/${camId}.jpg?t=${Date.now()}`;
    modalDesc.innerText = analysis;
    cameraModal.classList.add("open");
}

if (modalClose) {
    modalClose.addEventListener("click", () => {
        cameraModal.classList.remove("open");
    });
}

function handleDeviceAction(toolName, resp) {
    const deviceId = resp.id || "Device";
    const status = resp.status || resp.state || "Updated";
    const label = `${deviceId}: ${status}`;
    showToast(`⚡ ${label}`);
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
    card.className = `device-card ${isOn ? "is-on active-glow" : ""}`;
    card.innerHTML = `
        <div class="device-header">
            <div class="device-icon-box">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
                </svg>
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
    card.className = `device-card ${isOn ? "is-on active-glow" : ""}`;
    card.innerHTML = `
        <div class="device-header">
            <div class="device-icon-box">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-7 7c0 3 2 5 2 7h10c0-2 2-4 2-7a7 7 0 0 0-7-7z"></path>
                </svg>
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
    card.className = `device-card ${isOn ? "is-on" : ""}`;
    card.innerHTML = `
        <div class="device-header">
            <div class="device-icon-box">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
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
    card.className = `device-card camera-card ${isOn ? "is-on" : ""}`;
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

    // Start SSE stream
    initFirestoreStream();
});
