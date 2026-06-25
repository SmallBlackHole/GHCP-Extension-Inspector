// Extension: foundry-workflow-canvas
// Displays workflow progress when creating a hosted agent in Microsoft Foundry.
// Also provides an Agent Inspector canvas that hosts the inspector UI locally
// and proxies API/WebSocket traffic to the agent process.

import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { createInspectorServer } from "./inspector-backend/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..", "..", "..");

// ─── Persistence ──────────────────────────────────────────────────────────────
const STATE_DIR = resolve(__dirname, ".state");

function stateFilePath(instanceId) {
    return join(STATE_DIR, `${instanceId}.json`);
}

function saveState(instanceId, steps) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(stateFilePath(instanceId), JSON.stringify(steps, null, 2));
}

function loadState(instanceId) {
    const file = stateFilePath(instanceId);
    if (existsSync(file)) {
        try { return JSON.parse(readFileSync(file, "utf-8")); }
        catch { /* ignore corrupt file */ }
    }
    return null;
}

// ─── Agent process management ─────────────────────────────────────────────────
const AGENT_PORT = 8088;
const INSPECTOR_UI_DIR = resolve(__dirname, "inspector-ui");
let azdProcess = null;

function resolveAzdPath() {
    const isWindows = process.platform === "win32";
    const result = spawnSync(isWindows ? "where" : "which", ["azd"], { encoding: "utf-8", shell: isWindows });
    if (result.status === 0 && result.stdout) {
        const first = result.stdout.trim().split(/\r?\n/)[0].trim();
        if (first) return first;
    }
    if (isWindows && process.env.LOCALAPPDATA) {
        return join(process.env.LOCALAPPDATA, "Programs", "Azure Dev CLI", "azd.exe");
    }
    return isWindows ? "azd.cmd" : "azd";
}

const AZD_PATH = resolveAzdPath();
console.error(`[foundry-canvas] azd: ${AZD_PATH}`);

function findAzdProjectDir() {
    if (existsSync(join(PROJECT_ROOT, "azure.yaml"))) return PROJECT_ROOT;
    try {
        for (const entry of readdirSync(PROJECT_ROOT, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const candidate = join(PROJECT_ROOT, entry.name, "azure.yaml");
                if (existsSync(candidate)) return join(PROJECT_ROOT, entry.name);
            }
        }
    } catch { /* ignore */ }
    return PROJECT_ROOT;
}

async function isAgentReady() {
    return new Promise((resolve) => {
        const socket = netConnect({ host: "127.0.0.1", port: AGENT_PORT });
        socket.on("connect", () => { socket.destroy(); resolve(true); });
        socket.on("error", () => { resolve(false); });
        socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
    });
}

async function waitForAgent(timeoutMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isAgentReady()) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
}

function startAzdAgent() {
    if (azdProcess) return Promise.resolve(true);
    return new Promise((resolve) => {
        const cwd = findAzdProjectDir();
        console.error(`[foundry-canvas] starting agent in ${cwd}`);
        azdProcess = spawn(AZD_PATH, ["ai", "agent", "run", "--no-inspector"], {
            cwd,
            stdio: "pipe",
            windowsHide: true,
        });
        azdProcess.stdout?.on("data", (d) => console.error(`[azd] ${d.toString().trim()}`));
        azdProcess.stderr?.on("data", (d) => console.error(`[azd] ${d.toString().trim()}`));
        azdProcess.on("error", (err) => { console.error(`[foundry-canvas] spawn error: ${err.message}`); azdProcess = null; resolve(false); });
        azdProcess.on("exit", (code) => { console.error(`[foundry-canvas] agent exited (code ${code})`); azdProcess = null; });
        resolve(true);
    });
}

function stopAzdAgent() {
    if (azdProcess) { azdProcess.kill(); azdProcess = null; }
}

// ─── Inspector server ─────────────────────────────────────────────────────────

let inspectorProxyUrl = null;
let inspectorProxyServer = null;
let copilotSession = null; // Set after joinSession, used by onFixRequested callback

function handleFixRequested(source, errorSummary) {
    console.error(`[foundry-canvas] Fix requested from ${source}: ${errorSummary}`);
    if (!copilotSession) {
        console.error("[foundry-canvas] Fix requested but no Copilot session available");
        return;
    }
    const prompt = `The agent encountered an error during testing in the Agent Inspector:\n\n${errorSummary}\n\nPlease fix this error and do a clean restart of the agent with previous running agent processes killed, so I can verify it works.`;
    console.error("[foundry-canvas] Sending fix request to Copilot session...");
    copilotSession.send(prompt).then(() => {
        console.error("[foundry-canvas] Fix request sent successfully");
    }).catch((err) => {
        console.error("[foundry-canvas] Failed to send fix request to Copilot:", err.message);
    });
}

async function getOrCreateInspectorProxy() {
    if (inspectorProxyUrl) return inspectorProxyUrl;
    const { url, server } = await createInspectorServer({ uiDir: INSPECTOR_UI_DIR, agentPort: AGENT_PORT, onFixRequested: handleFixRequested });
    inspectorProxyServer = server;
    inspectorProxyUrl = url;
    console.error(`[foundry-canvas] inspector server: ${inspectorProxyUrl}`);
    return inspectorProxyUrl;
}

/** Ensure agent is running, then return the inspector server URL. */
async function ensureInspectorProxy() {
    const alreadyRunning = await isAgentReady();
    if (!alreadyRunning) {
        await startAzdAgent();
        const ready = await waitForAgent();
        if (!ready) return null;
    }
    return getOrCreateInspectorProxy();
}

// ─── Runtime state ────────────────────────────────────────────────────────────
const instances = new Map();

// Follow-up "next steps" buttons shown after every workflow step is done.
// Each entry: { id, label, prompt } (prompt is sent to the Copilot session),
// { id, label, url }, or { id, label, canvas } (opens a canvas directly).
const DEFAULT_FOLLOWUPS = [
    {
        id: "evaluate",
        label: "Evaluate your agent's quality",
        prompt:
            "Help me evaluate my hosted agent's quality. Set up and run a batch evaluation following the microsoft-foundry evaluation guidance.",
    },
    {
        id: "deploy",
        label: "Deploy your agent to production",
        prompt:
            "Help me deploy my hosted agent to production using azd, following the microsoft-foundry deploy guidance.",
    },
];

function createState(steps = [], followups = DEFAULT_FOLLOWUPS) {
    return {
        steps: steps.map((s) => ({ ...s, status: s.status || "pending" })),
        followups,
        sseClients: new Set(),
    };
}

function broadcast(state) {
    const payload = JSON.stringify({ steps: state.steps, followups: state.followups });
    for (const res of state.sseClients) {
        res.write(`data: ${payload}\n\n`);
    }
}

// ─── Workflow canvas HTML ─────────────────────────────────────────────────────
function renderHtml() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Foundry Agent – Workflow Progress</title>
  <style>
    :root {
      --bg: #1e1e2e;
      --surface: #262637;
      --surface-2: #2e2e44;
      --text: #e0e0e0;
      --muted: #8888aa;
      --accent: #58a6ff;
      --success: #3fb950;
      --active: #d29922;
      --border: #3a3a52;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 0;
      min-height: 100vh;
    }
    #workflow-view { padding: 24px 20px; }
    h1 { font-size: 16px; font-weight: 600; margin-bottom: 4px; color: var(--accent); }
    .subtitle { font-size: 12px; color: var(--muted); margin-bottom: 20px; }

    /* ─── Collapsible progress section ─── */
    .progress-header {
      display: flex; align-items: center; gap: 10px; cursor: pointer;
      padding: 12px 14px; background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; margin-bottom: 16px; user-select: none;
      transition: border-color 0.2s;
    }
    .progress-header:hover { border-color: var(--accent); }
    .progress-header .chevron {
      font-size: 12px; color: var(--muted); transition: transform 0.2s;
    }
    .progress-header.expanded .chevron { transform: rotate(90deg); }
    .progress-header .status-icon { font-size: 16px; }
    .progress-header .summary { flex: 1; font-size: 13px; font-weight: 500; }
    .progress-header .progress-pill {
      font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 500;
    }
    .progress-header .progress-pill.complete { background: rgba(63,185,80,0.15); color: var(--success); }
    .progress-header .progress-pill.in-progress { background: rgba(210,153,34,0.15); color: var(--active); }
    .progress-header .progress-pill.pending { background: rgba(136,136,170,0.15); color: var(--muted); }

    .progress-details {
      max-height: 0; overflow: hidden; transition: max-height 0.3s ease;
      margin-bottom: 0;
    }
    .progress-details.expanded {
      max-height: 600px; margin-bottom: 16px;
    }
    .progress-details-inner {
      padding: 8px 14px 14px;
      background: var(--surface); border: 1px solid var(--border); border-top: none;
      border-radius: 0 0 8px 8px; margin-top: -17px;
    }
    .steps { display: flex; flex-direction: column; gap: 0; }
    .step { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; position: relative; }
    .step:not(:last-child)::after {
      content: ''; position: absolute; left: 11px; top: 32px; bottom: 0;
      width: 2px; background: var(--border);
    }
    .step.done:not(:last-child)::after { background: var(--success); }
    .step.in-progress:not(:last-child)::after { background: var(--active); }
    .step-icon {
      width: 24px; height: 24px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      font-size: 11px; border: 2px solid var(--border); background: var(--surface-2);
    }
    .step.done .step-icon { background: var(--success); border-color: var(--success); color: #fff; }
    .step.in-progress .step-icon { background: var(--active); border-color: var(--active); color: #fff; animation: pulse 1.5s infinite; }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(210,153,34,0.4); }
      50% { box-shadow: 0 0 0 5px rgba(210,153,34,0); }
    }
    .step-content { flex: 1; }
    .step-label { font-size: 12px; font-weight: 500; line-height: 24px; }
    .step.done .step-label { color: var(--success); }
    .step.in-progress .step-label { color: var(--active); }
    .step.pending .step-label { color: var(--muted); }

    /* ─── Current step highlight ─── */
    .current-step {
      background: var(--surface); border: 1px solid var(--active);
      border-radius: 8px; padding: 14px 16px; margin-bottom: 20px;
      display: none;
    }
    .current-step.visible { display: block; }
    .current-step-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .current-step-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--active); animation: pulse 1.5s infinite; }
    .current-step-title { font-size: 13px; font-weight: 600; color: var(--active); }
    .current-step-desc { font-size: 12px; color: var(--text); line-height: 1.4; }
    .progress-bar { margin-top: 10px; background: var(--surface-2); border-radius: 4px; height: 4px; overflow: hidden; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--success), var(--accent)); border-radius: 4px; transition: width 0.5s ease; }

    /* ─── Next steps section ─── */
    .next-steps { display: none; }
    .next-steps.visible { display: block; }
    .section-title { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    .subsection-title { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 10px; margin-top: 16px; }

    /* ─── Tool cards grid ─── */
    .tool-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 20px; }
    .tool-card {
      background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
      padding: 14px 12px; display: flex; flex-direction: column; align-items: center;
      gap: 8px; text-align: center; transition: border-color 0.2s, background 0.2s;
    }
    .tool-card:hover { border-color: var(--accent); background: rgba(88,166,255,0.04); }
    .tool-card .tool-icon {
      width: 36px; height: 36px; border-radius: 8px; background: var(--surface-2);
      display: flex; align-items: center; justify-content: center; overflow: hidden;
    }
    .tool-card .tool-icon svg { width: 20px; height: 20px; }
    .tool-card .tool-icon img { width: 100%; height: 100%; object-fit: contain; }
    .tool-card .tool-name { font-size: 12px; font-weight: 500; line-height: 1.3; }
    .tool-card .tool-add-btn {
      margin-top: auto; padding: 4px 12px; font-size: 11px; font-weight: 600;
      background: var(--accent); color: #fff; border: none; border-radius: 4px;
      cursor: pointer; transition: opacity 0.2s;
    }
    .tool-card .tool-add-btn:hover { opacity: 0.85; }
    .tool-card .tool-add-btn:disabled { opacity: 0.5; cursor: default; }
    .tool-card .tool-add-btn.done { background: var(--success); }

    .browse-all {
      display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
      color: var(--accent); cursor: pointer; border: none; background: none;
      padding: 4px 0; margin-bottom: 20px; font-weight: 500;
    }
    .browse-all:hover { text-decoration: underline; }
    .browse-all:disabled { opacity: 0.5; cursor: wait; }

    /* ─── Action rows ─── */
    .action-row {
      display: flex; align-items: center; gap: 12px;
      padding: 12px 14px; background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; margin-bottom: 10px; cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
    }
    .action-row:hover { border-color: var(--accent); background: rgba(88,166,255,0.04); }
    .action-row:active { background: rgba(88,166,255,0.08); }
    .action-row .action-icon { font-size: 18px; flex-shrink: 0; }
    .action-row .action-text { flex: 1; }
    .action-row .action-label { font-size: 13px; font-weight: 500; }
    .action-row .action-desc { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .action-row .action-arrow { color: var(--accent); font-size: 14px; }
    .action-row.disabled { opacity: 0.6; cursor: wait; }

    /* ─── Inspector embed ─── */
    #inspector-view {
      display: none; flex-direction: column; height: 100vh;
    }
    .inspector-bar {
      display: flex; align-items: center; gap: 10px; padding: 8px 12px;
      background: var(--surface); border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .back-btn {
      background: none; border: none; color: var(--accent); cursor: pointer;
      font-size: 14px; padding: 4px 8px; border-radius: 4px;
      display: flex; align-items: center; gap: 4px;
    }
    .back-btn:hover { background: rgba(88,166,255,0.1); }
  </style>
</head>
<body>
  <div id="workflow-view">
    <h1>🚀 Create Hosted Agent</h1>
    <p class="subtitle">Microsoft Foundry</p>

    <!-- Collapsible progress -->
    <div class="progress-header" id="progress-header" onclick="toggleProgress()">
      <span class="chevron">▶</span>
      <span class="status-icon" id="status-icon">⏳</span>
      <span class="summary" id="progress-summary">Preparing…</span>
      <span class="progress-pill pending" id="progress-pill"></span>
    </div>
    <div class="progress-details" id="progress-details">
      <div class="progress-details-inner">
        <div class="steps" id="steps"></div>
      </div>
    </div>

    <!-- Current step highlight (shown during progress) -->
    <div class="current-step" id="current-step">
      <div class="current-step-header">
        <span class="current-step-dot"></span>
        <span class="current-step-title" id="current-step-title"></span>
      </div>
      <div class="current-step-desc" id="current-step-desc"></div>
      <div class="progress-bar"><div class="progress-fill" id="progress-bar"></div></div>
    </div>

    <!-- Next steps (shown after completion) -->
    <div class="next-steps" id="next-steps">
      <div class="section-title">✨ What's next</div>

      <div class="subsection-title">🔧 Add tools to your agent</div>
      <div class="tool-cards" id="tool-cards"></div>
      <button class="browse-all" id="browse-all" onclick="browseAllTools()">Browse more tools →</button>

      <div class="subsection-title">🧪 Test your agent</div>
      <div class="action-row" id="action-test" onclick="testAgent()">
        <span class="action-icon">▶️</span>
        <div class="action-text">
          <div class="action-label">Launch Agent Inspector</div>
          <div class="action-desc">Try your agent locally in the interactive inspector</div>
        </div>
        <span class="action-arrow">→</span>
      </div>

      <div class="subsection-title">📊 Set up evaluation</div>
      <div class="action-row" id="action-eval" onclick="setupEval()">
        <span class="action-icon">📋</span>
        <div class="action-text">
          <div class="action-label">Run batch evaluation</div>
          <div class="action-desc">Measure your agent's quality with automated tests</div>
        </div>
        <span class="action-arrow">→</span>
      </div>
    </div>
  </div>

  <div id="inspector-view">
    <div class="inspector-bar">
      <button class="back-btn" onclick="showWorkflow()">← Back</button>
      <span style="font-size:13px; color:var(--text); font-weight:500;">Agent Inspector</span>
    </div>
    <iframe id="inspector-frame" src="" style="flex:1; border:none; width:100%; background:var(--bg);"></iframe>
  </div>

  <script>
    const stepIcons = { pending: '○', 'in-progress': '◉', done: '✓' };

    // Popular tools to show inline as cards
    const POPULAR_TOOLS = [
      { id: 'bing-grounding', name: 'Web Search', icon: 'bing', description: 'Search the web using Bing grounding' },
      { id: 'workiq-mail', name: 'Work IQ Mail', icon: 'mail', description: 'Access Outlook email via Microsoft 365' },
      { id: 'workiq-teams', name: 'Work IQ Teams', icon: 'teams', description: 'Access Teams messages and channels' },
      { id: 'workiq-calendar', name: 'Work IQ Calendar', icon: 'calendar', description: 'Access calendar events and meetings' },
      { id: 'fabric-iq', name: 'Fabric IQ', icon: 'fabric', description: 'Query data with Microsoft Fabric' },
    ];

    const TOOL_ICONS = {
      bing: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><g><path d="M4.99971 2.00243C4.99984 1.20087 5.89575 0.725217 6.5598 1.17416L9.12019 2.90519C9.67036 3.27715 10 3.89794 10 4.56206V19.0005C10 19.0005 8.05428 20.5039 6.99362 20.0005C5.61376 19.3456 4.99731 16.6372 4.99731 16.6372L4.99971 2.00243Z" fill="url(#bing0)"/><path d="M4.99971 2.00243C4.99984 1.20087 5.89575 0.725217 6.5598 1.17416L9.12019 2.90519C9.67036 3.27715 10 3.89794 10 4.56206V19.0005C10 19.0005 8.05428 20.5039 6.99362 20.0005C5.61376 19.3456 4.99731 16.6372 4.99731 16.6372L4.99971 2.00243Z" fill="url(#bing1)"/><path d="M5.06546 16.2617L5 15.9999V16.1984C5 19.4025 7.59745 22 10.8016 22C11.9106 22 12.9964 21.6821 13.9303 21.084L18.1548 18.3787C18.993 17.8419 19.5 16.9151 19.5 15.9198V14.1879C19.5 13.5318 18.9681 12.9999 18.312 12.9999C18.1075 12.9999 17.9064 13.0527 17.7283 13.1532L9.12389 18.0069C8.55916 18.3255 7.90076 18.4364 7.26283 18.3204C6.18961 18.1253 5.33001 17.32 5.06546 16.2617Z" fill="url(#bing2)"/><path d="M5.06546 16.2617L5 15.9999V16.1984C5 19.4025 7.59745 22 10.8016 22C11.9106 22 12.9964 21.6821 13.9303 21.084L18.1548 18.3787C18.993 17.8419 19.5 16.9151 19.5 15.9198V14.1879C19.5 13.5318 18.9681 12.9999 18.312 12.9999C18.1075 12.9999 17.9064 13.0527 17.7283 13.1532L9.12389 18.0069C8.55916 18.3255 7.90076 18.4364 7.26283 18.3204C6.18961 18.1253 5.33001 17.32 5.06546 16.2617Z" fill="url(#bing3)"/><path d="M13.2924 12.3771L12.0446 8.63386C12.0151 8.5452 12 8.45236 12 8.3589C12 7.72437 12.6577 7.30355 13.2338 7.56946L16.7005 9.16944C17.8657 9.70724 18.8144 10.6239 19.3919 11.7699C20.2661 13.5048 20.1928 15.5661 19.1976 17.2345L18.9616 17.63L18.6406 18C19.5697 16.6153 18.9111 14.7263 17.3224 14.2194L14.1255 13.1995C13.7324 13.0741 13.4229 12.7686 13.2924 12.3771Z" fill="url(#bing4)"/></g><defs><linearGradient id="bing0" x1="13.7356" y1="20.3051" x2="13.7356" y2="1.25562" gradientUnits="userSpaceOnUse"><stop stop-color="#1B48EF"/><stop offset="0.12" stop-color="#1C51F0"/><stop offset="0.32" stop-color="#1E69F5"/><stop offset="0.57" stop-color="#2190FB"/><stop offset="1" stop-color="#26B8F4"/></linearGradient><linearGradient id="bing1" x1="13.7309" y1="1.75831" x2="13.7309" y2="20.0054" gradientUnits="userSpaceOnUse"><stop stop-opacity="0"/><stop offset="1" stop-opacity="0.1"/></linearGradient><linearGradient id="bing2" x1="5" y1="17.4914" x2="19.4993" y2="17.4914" gradientUnits="userSpaceOnUse"><stop stop-color="#39D2FF"/><stop offset="0.15" stop-color="#38CEFE"/><stop offset="0.29" stop-color="#35C3FA"/><stop offset="0.43" stop-color="#2FB0F3"/><stop offset="0.55" stop-color="#299AEB"/><stop offset="0.58" stop-color="#2692EC"/><stop offset="0.76" stop-color="#1A6CF1"/><stop offset="0.91" stop-color="#1355F4"/><stop offset="1" stop-color="#104CF5"/></linearGradient><linearGradient id="bing3" x1="6.66842" y1="20.5831" x2="17.5046" y2="13.5619" gradientUnits="userSpaceOnUse"><stop stop-color="white" stop-opacity="0"/><stop offset="1" stop-opacity="0.15"/></linearGradient><linearGradient id="bing4" x1="10.6272" y1="9.58126" x2="20.7898" y2="16.6342" gradientUnits="userSpaceOnUse"><stop stop-color="#37BDFF"/><stop offset="0.18" stop-color="#33BFFD"/><stop offset="0.36" stop-color="#28C5F5"/><stop offset="0.53" stop-color="#15D0E9"/><stop offset="0.55" stop-color="#12D1E7"/><stop offset="0.59" stop-color="#1CD2E5"/><stop offset="0.77" stop-color="#42D8DC"/><stop offset="0.91" stop-color="#59DBD6"/><stop offset="1" stop-color="#62DCD4"/></linearGradient></defs></svg>',
      mail: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M22 8.608v8.142a2.25 2.25 0 0 1-2.25 2.25H4.25A2.25 2.25 0 0 1 2 16.75V8.608l9.652 5.056a.75.75 0 0 0 .696 0L22 8.608Z" fill="#0078D4"/><path d="M22 7.25v.308l-9.652 5.056a.75.75 0 0 1-.696 0L2 7.558V7.25A2.25 2.25 0 0 1 4.25 5h15.5A2.25 2.25 0 0 1 22 7.25Z" fill="#28A8EA"/></svg>',
      teams: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M16.5 5.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" fill="#5B5FC7"/><path d="M14 7h5.5a1.5 1.5 0 0 1 1.5 1.5v4a3.5 3.5 0 0 1-5.05 3.143L14 7Z" fill="#5B5FC7"/><path d="M10 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" fill="#7B83EB"/><path d="M13.5 7h-8A1.5 1.5 0 0 0 4 8.5v6a5.5 5.5 0 0 0 9.91 3.27A5.5 5.5 0 0 0 15 14.5v-6A1.5 1.5 0 0 0 13.5 7Z" fill="#7B83EB"/></svg>',
      calendar: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M21 6.25A2.25 2.25 0 0 0 18.75 4H5.25A2.25 2.25 0 0 0 3 6.25v1.25h18V6.25Z" fill="#0078D4"/><path d="M3 7.5v10.25A2.25 2.25 0 0 0 5.25 20h13.5A2.25 2.25 0 0 0 21 17.75V7.5H3Z" fill="#28A8EA"/><rect x="6" y="10" width="3" height="2.5" rx=".5" fill="#0078D4"/><rect x="10.5" y="10" width="3" height="2.5" rx=".5" fill="#0078D4"/><rect x="15" y="10" width="3" height="2.5" rx=".5" fill="#0078D4"/><rect x="6" y="14.5" width="3" height="2.5" rx=".5" fill="#0078D4"/><rect x="10.5" y="14.5" width="3" height="2.5" rx=".5" fill="#0078D4"/></svg>',
      fabric: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M11.1155 10.7654C11.6625 10.4115 12.3374 10.4115 12.8844 10.7654L20.6482 15.788C21.1173 16.0914 21.1173 16.8473 20.6482 17.1507L12.7077 22.2876C12.27 22.5708 11.73 22.5708 11.2924 22.2876L3.35178 17.1507C2.88274 16.8473 2.88274 16.0914 3.35178 15.788L11.1155 10.7654Z" fill="url(#fab0)"/><path d="M11.1155 6.26541C11.6626 5.91153 12.3374 5.91153 12.8845 6.26541L20.6482 11.2879C21.1173 11.5913 21.1173 12.3473 20.6482 12.6507L12.7076 17.7876C12.27 18.0708 11.73 18.0708 11.2924 17.7876L3.35178 12.6507C2.88274 12.3473 2.88274 11.5913 3.35178 11.2879L11.1155 6.26541Z" fill="url(#fab1)"/><path d="M11.2924 1.71125C11.73 1.42958 12.27 1.42958 12.7076 1.71125L20.6482 6.82205C21.1173 7.12394 21.1173 7.87607 20.6482 8.17796L12.7076 13.2888C12.27 13.5704 11.73 13.5704 11.2924 13.2888L3.35178 8.17796C2.88274 7.87607 2.88274 7.12394 3.35178 6.82205L11.2924 1.71125Z" fill="url(#fab2)"/><defs><radialGradient id="fab0" cx="0" cy="0" r="1" gradientTransform="matrix(.26471 13.0435 -17.7264 .65422 11.7353 11.8044)" gradientUnits="userSpaceOnUse"><stop stop-color="#110350"/><stop offset=".51" stop-color="#005639"/><stop offset="1" stop-color="#4FCA89"/></radialGradient><radialGradient id="fab1" cx="0" cy="0" r="1" gradientTransform="matrix(3.16407 12.8152 -13.187 4.24692 10.3125 4.69563)" gradientUnits="userSpaceOnUse"><stop stop-color="#042132"/><stop offset=".27" stop-color="#054248"/><stop offset=".66" stop-color="#17844A"/><stop offset=".94" stop-color="#51C581"/></radialGradient><linearGradient id="fab2" x1="5.80179" y1="10.0275" x2="11.2238" y2="1.8615" gradientUnits="userSpaceOnUse"><stop stop-color="#52C79A"/><stop offset=".64" stop-color="#78DAA1"/><stop offset="1" stop-color="#B1F3AD"/></linearGradient></defs></svg>',
    };

    let isProgressExpanded = false;
    let addingTool = false; // global lock — one add at a time
    let workflowComplete = false; // once initial workflow finishes, lock the next-steps view

    function toggleProgress() {
      isProgressExpanded = !isProgressExpanded;
      const header = document.getElementById('progress-header');
      const details = document.getElementById('progress-details');
      header.classList.toggle('expanded', isProgressExpanded);
      details.classList.toggle('expanded', isProgressExpanded);
    }

    function showInspector(url) {
      document.getElementById('workflow-view').style.display = 'none';
      const inspector = document.getElementById('inspector-view');
      inspector.style.display = 'flex';
      document.getElementById('inspector-frame').src = url;
    }

    function showWorkflow() {
      document.getElementById('inspector-view').style.display = 'none';
      document.getElementById('workflow-view').style.display = 'block';
      document.getElementById('inspector-frame').src = '';
    }

    function render(steps) {
      // Once workflow is complete and next-steps are shown, ignore further updates
      if (workflowComplete) return;

      const container = document.getElementById('steps');
      const currentStepEl = document.getElementById('current-step');
      const nextStepsEl = document.getElementById('next-steps');

      if (!steps || steps.length === 0) {
        container.innerHTML = '<p style="color: var(--muted); font-style: italic; padding: 12px 0;">Preparing workflow steps…</p>';
        document.getElementById('progress-summary').textContent = 'Preparing…';
        document.getElementById('status-icon').textContent = '⏳';
        document.getElementById('progress-pill').textContent = '';
        document.getElementById('progress-pill').className = 'progress-pill pending';
        currentStepEl.classList.remove('visible');
        nextStepsEl.classList.remove('visible');
        document.getElementById('progress-bar').style.width = '0%';
        return;
      }

      const done = steps.filter(s => s.status === 'done').length;
      const total = steps.length;
      const allDone = done === total;
      const currentStep = steps.find(s => s.status === 'in-progress');
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;

      // Update collapsed header
      const pill = document.getElementById('progress-pill');
      const summary = document.getElementById('progress-summary');
      const statusIcon = document.getElementById('status-icon');
      if (allDone) {
        statusIcon.textContent = '✓';
        summary.textContent = 'Agent created successfully';
        pill.textContent = done + '/' + total + ' complete';
        pill.className = 'progress-pill complete';
        // Auto-collapse when done
        if (isProgressExpanded) { toggleProgress(); }
      } else {
        statusIcon.textContent = '⏳';
        summary.textContent = currentStep ? currentStep.label : 'Setting up…';
        pill.textContent = done + '/' + total;
        pill.className = 'progress-pill in-progress';
      }

      // Render step details inside expandable
      container.innerHTML = steps.map(s =>
        \`<div class="step \${s.status}">
          <div class="step-icon">\${stepIcons[s.status]}</div>
          <div class="step-content">
            <div class="step-label">\${s.label}</div>
          </div>
        </div>\`
      ).join('');

      // Current step highlight
      if (currentStep && !allDone) {
        document.getElementById('current-step-title').textContent = currentStep.label;
        document.getElementById('current-step-desc').textContent = currentStep.description;
        currentStepEl.classList.add('visible');
      } else {
        currentStepEl.classList.remove('visible');
      }

      // Progress bar
      document.getElementById('progress-bar').style.width = pct + '%';

      // Show next steps when complete
      if (allDone) {
        workflowComplete = true;
        nextStepsEl.classList.add('visible');
        renderToolCards();
      } else {
        nextStepsEl.classList.remove('visible');
      }
    }

    function renderToolCards() {
      const grid = document.getElementById('tool-cards');
      grid.innerHTML = POPULAR_TOOLS.map((tool, i) =>
        \`<div class="tool-card">
          <div class="tool-icon">\${TOOL_ICONS[tool.icon] || '🔧'}</div>
          <div class="tool-name">\${tool.name}</div>
          <button class="tool-add-btn" data-idx="\${i}" onclick="addTool(\${i}, this)">Add to agent</button>
        </div>\`
      ).join('');
    }

    function addTool(idx, btn) {
      if (addingTool) return;
      const tool = POPULAR_TOOLS[idx];
      if (!tool) return;
      addingTool = true;
      btn.disabled = true;
      btn.textContent = 'Adding';
      // Disable all other add buttons
      document.querySelectorAll('.tool-add-btn').forEach(b => { if (b !== btn) b.disabled = true; });
      fetch('/add-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: tool.id, name: tool.name }),
      })
        .then(r => r.json())
        .then(data => {
          if (data.ok) {
            // Keep button as 'Adding' - Copilot is still processing the flow.
            // Do not update to 'Added' here; stay in Adding state until done.
            btn.classList.add('done'); // keeps button disabled in the finally block
          } else {
            btn.textContent = 'Add to agent';
            btn.disabled = false;
          }
        })
        .catch(() => {
          btn.textContent = 'Add to agent';
          btn.disabled = false;
        })
        .finally(() => {
          addingTool = false;
          // Re-enable other buttons
          document.querySelectorAll('.tool-add-btn').forEach(b => {
            if (!b.classList.contains('done')) b.disabled = false;
          });
        });
    }

    function browseAllTools() {
      const btn = document.getElementById('browse-all');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      fetch('/add-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'browse-tools', name: 'Browse tools' }),
      })
        .then(r => r.json())
        .then(data => {
          btn.textContent = data.ok ? '✓ Sent to Copilot' : 'Browse more tools →';
          setTimeout(() => { btn.textContent = 'Browse more tools →'; btn.disabled = false; }, 2500);
        })
        .catch(() => {
          btn.textContent = 'Browse more tools →';
          btn.disabled = false;
        });
    }

    function testAgent() {
      const row = document.getElementById('action-test');
      if (row.classList.contains('disabled')) return;
      row.classList.add('disabled');
      row.querySelector('.action-arrow').textContent = '⏳';
      fetch('/start-agent')
        .then(r => r.json())
        .then(data => {
          if (data.ok) {
            showInspector(data.url);
          } else {
            row.querySelector('.action-arrow').textContent = '⚠️';
            setTimeout(() => { row.querySelector('.action-arrow').textContent = '→'; row.classList.remove('disabled'); }, 3000);
          }
        })
        .catch(() => {
          row.querySelector('.action-arrow').textContent = '→';
          row.classList.remove('disabled');
        });
    }

    function setupEval() {
      const row = document.getElementById('action-eval');
      if (row.classList.contains('disabled')) return;
      row.classList.add('disabled');
      row.querySelector('.action-arrow').textContent = '⏳';
      fetch('/followup?id=evaluate')
        .then(r => r.json())
        .then(data => {
          row.querySelector('.action-arrow').textContent = data.ok ? '✓' : '→';
          setTimeout(() => { row.querySelector('.action-arrow').textContent = '→'; row.classList.remove('disabled'); }, 3000);
        })
        .catch(() => {
          row.querySelector('.action-arrow').textContent = '→';
          row.classList.remove('disabled');
        });
    }

    render([]);
    const es = new EventSource('/events');
    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      render(data.steps);
    };
  </script>
</body>
</html>`;
}

// ─── Add-tool prompt builder ──────────────────────────────────────────────────
// Mirrors the WorkIQ canvas's prompt-building logic: resolves azd project
// context from disk, then constructs a detailed prompt for the Copilot session.

const WORKIQ_AUDIENCE = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1";

const WORKIQ_SERVER_URLS = {
    "workiq-mail": "https://workiq.microsoft.com/api/mcp/mail",
    "workiq-teams": "https://workiq.microsoft.com/api/mcp/teams",
    "workiq-calendar": "https://workiq.microsoft.com/api/mcp/calendar",
};

function parseEnvValues(text) {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        out[m[1]] = v;
    }
    return out;
}

function readAzdEnvFromDisk(dir) {
    try {
        const cfgPath = join(dir, ".azure", "config.json");
        if (!existsSync(cfgPath)) return {};
        const envName = JSON.parse(readFileSync(cfgPath, "utf-8"))?.defaultEnvironment;
        if (!envName) return {};
        const envPath = join(dir, ".azure", envName, ".env");
        if (!existsSync(envPath)) return {};
        return parseEnvValues(readFileSync(envPath, "utf-8"));
    } catch {
        return {};
    }
}

async function findAzdProjectDirAsync() {
    const SKIP = new Set(["node_modules", ".git", ".github", ".azure", "dist", "out", "bin", "obj", ".vs", ".vscode", "__pycache__"]);
    const matches = [];
    const walk = async (dir, depth) => {
        if (depth > 2) return;
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        if (entries.some(e => e.isFile() && e.name === "azure.yaml")) {
            matches.push({ dir, hasEnv: existsSync(join(dir, ".azure")) });
            return;
        }
        await Promise.all(entries
            .filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith("."))
            .map(e => walk(join(dir, e.name), depth + 1)));
    };
    await walk(PROJECT_ROOT, 0);
    if (matches.length) {
        return (matches.find(m => m.hasEnv) || matches[0]).dir;
    }
    return PROJECT_ROOT;
}

async function getProjectContext() {
    const ctx = { projectName: undefined, projectEndpoint: undefined };
    const cwd = await findAzdProjectDirAsync();
    const v = readAzdEnvFromDisk(cwd);
    ctx.projectEndpoint = v.AZURE_AI_PROJECT_ENDPOINT || v.AZURE_AIPROJECT_ENDPOINT;
    ctx.projectName = v.AZURE_AI_PROJECT_NAME || v.AZURE_AI_ACCOUNT_NAME;
    if (!ctx.projectName && ctx.projectEndpoint) {
        const nameMatch = ctx.projectEndpoint.match(/\/projects\/([^/?#]+)/i);
        if (nameMatch) ctx.projectName = decodeURIComponent(nameMatch[1]);
    }
    return ctx;
}

function buildAddToolPrompt(tool) {
    if (tool.id === "browse-tools") {
        return "Show me what other tools I can add to my hosted agent. List the available tools from the Foundry tool catalog (MCP connectors, Bing grounding, Fabric IQ, etc.) and help me choose.";
    }
    const isWorkIq = tool.id.startsWith("workiq-");
    if (isWorkIq) {
        const serverUrl = WORKIQ_SERVER_URLS[tool.id] || "(see catalog)";
        const wiring = `- Create the \`RemoteTool\` (MCP) project connection for the Work IQ MCP server ${serverUrl} per foundry-tool-catalog.md with \`UserEntraToken\` auth and \`metadata.audience = ${WORKIQ_AUDIENCE}\`, then add a \`{ "type": "mcp", "project_connection_id": "<conn>" }\` entry to the agent's toolbox version.`;
        return [
            `Integrate my Foundry agent with Microsoft 365 Work IQ by adding the **Work IQ toolbox MCP tool** "${tool.name}" to my current Foundry project. This is the toolbox MCP connector — NOT the A2A "Work IQ Chat".`,
            ``,
            `Use the microsoft-foundry skill's Work IQ workflow (foundry-agent/create/references/tool-work-iq.md) and do the FULL chain so the tool is actually usable and testable in the Agent Inspector:`,
            wiring,
            `- Ensure the hosted agent is wired to that toolbox: confirm \`TOOLBOX_ENDPOINT\` is set (declare the toolbox + connection in \`azure.yaml\` so \`azd up\` provisions it and injects the env var if it isn't already).`,
            `- Walk me through the Work IQ prerequisites: 1P managed OAuth (OBO) — each user signs in once, no BYO Entra app or Global-Admin admin consent; an M365 Copilot license for the calling user; and a non-VNet project endpoint.`,
            `- Then do a clean restart of the local agent (kill the previous process) so I can verify it in the Agent Inspector.`,
        ].join("\n");
    }
    if (tool.id === "bing-grounding") {
        return [
            `Add Bing grounding (web search) capability to my hosted agent.`,
            ``,
            `Use the microsoft-foundry skill to:`,
            `- Create the Bing grounding connection in the Foundry project.`,
            `- Wire it into the agent's toolbox so the agent can search the web.`,
            `- Update \`azure.yaml\` if needed so \`azd up\` provisions the connection.`,
            `- Then do a clean restart of the local agent so I can verify it in the Agent Inspector.`,
        ].join("\n");
    }
    if (tool.id === "fabric-iq") {
        return [
            `Add Fabric IQ capability to my hosted agent so it can query data using Microsoft Fabric.`,
            ``,
            `Use the microsoft-foundry skill to:`,
            `- Set up the Fabric IQ connection in the Foundry project.`,
            `- Wire it into the agent's toolbox.`,
            `- Update \`azure.yaml\` if needed so \`azd up\` provisions the connection.`,
            `- Then do a clean restart of the local agent so I can verify it in the Agent Inspector.`,
        ].join("\n");
    }
    return `Add the "${tool.name}" tool to my hosted agent. Use the microsoft-foundry skill to integrate it, wire it into the agent's toolbox, and restart the local agent so I can test it.`;
}

// ─── Workflow canvas HTTP server ──────────────────────────────────────────────
async function startServer(instanceId, initialSteps = []) {
    const state = createState(initialSteps);
    instances.set(instanceId, state);

    const server = createServer(async (req, res) => {
        if (req.url === "/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            state.sseClients.add(res);
            res.write(`data: ${JSON.stringify({ steps: state.steps, followups: state.followups })}\n\n`);
            req.on("close", () => state.sseClients.delete(res));
            return;
        }
        if (req.url && req.url.startsWith("/followup")) {
            res.setHeader("Content-Type", "application/json");
            try {
                const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id");
                const followup = (state.followups || []).find((f) => f.id === id);
                if (!followup) {
                    res.end(JSON.stringify({ ok: false, error: "Unknown follow-up" }));
                } else if (followup.canvas) {
                    // Open a canvas directly instead of sending a prompt
                    if (!copilotSession) {
                        res.end(JSON.stringify({ ok: false, error: "Copilot session not available" }));
                    } else {
                        copilotSession.rpc.canvas.open({
                            canvasId: followup.canvas,
                            instanceId: `${followup.canvas}-followup`,
                            input: followup.canvasInput || {},
                        }).then(() => {
                            res.end(JSON.stringify({ ok: true, canvas: true }));
                        }).catch((err) => {
                            console.error(`[foundry-canvas] follow-up canvas open failed: ${err.message}`);
                            res.end(JSON.stringify({ ok: false, error: err.message }));
                        });
                    }
                } else if (!followup.prompt) {
                    res.end(JSON.stringify({ ok: false, error: "No prompt configured" }));
                } else if (!copilotSession) {
                    res.end(JSON.stringify({ ok: false, error: "Copilot session not available" }));
                } else {
                    copilotSession.send(followup.prompt).catch((err) =>
                        console.error(`[foundry-canvas] follow-up send failed: ${err.message}`),
                    );
                    res.end(JSON.stringify({ ok: true }));
                }
            } catch (err) {
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
            return;
        }
        if (req.url === "/start-agent") {
            res.setHeader("Content-Type", "application/json");
            try {
                const proxyUrl = await ensureInspectorProxy();
                if (!proxyUrl) {
                    res.end(JSON.stringify({ ok: false, error: "Inspector not ready within timeout" }));
                } else {
                    res.end(JSON.stringify({ ok: true, url: proxyUrl }));
                }
            } catch (err) {
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
            return;
        }
        if (req.url === "/add-tool" && req.method === "POST") {
            res.setHeader("Content-Type", "application/json");
            try {
                let body = "";
                await new Promise((r) => {
                    req.on("data", (c) => { body += c; });
                    req.on("end", r);
                });
                const tool = JSON.parse(body || "{}");
                if (!tool?.id || !tool?.name) {
                    res.end(JSON.stringify({ ok: false, error: "Missing tool info" }));
                    return;
                }
                if (!copilotSession) {
                    res.end(JSON.stringify({ ok: false, error: "Copilot session not available" }));
                    return;
                }
                const prompt = buildAddToolPrompt(tool);
                copilotSession.send(prompt).catch((err) =>
                    console.error(`[foundry-canvas] add-tool send failed: ${err.message}`),
                );
                res.end(JSON.stringify({ ok: true }));
            } catch (err) {
                res.end(JSON.stringify({ ok: false, error: err.message }));
            }
            return;
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderHtml());
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return { server, url: `http://127.0.0.1:${address.port}/` };
}

// ─── Canvas registration ──────────────────────────────────────────────────────
const servers = new Map();

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "foundry-workflow-canvas",
            displayName: "Foundry Agent Workflow",
            description:
                "Displays step-by-step progress when creating a hosted agent in Microsoft Foundry. Open this canvas at the start of a create-hosted-agent workflow, then call set_steps to define the workflow steps and update_step to advance each step.",
            inputSchema: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Optional custom title for the workflow" },
                    steps: {
                        type: "array",
                        description: "Optional initial steps. Each needs id, label, description. Optionally include action {label, url} for a button shown when the step is done.",
                        items: {
                            type: "object",
                            properties: {
                                id: { type: "string" },
                                label: { type: "string" },
                                description: { type: "string" },
                                action: {
                                    type: "object",
                                    properties: { label: { type: "string" }, url: { type: "string" } },
                                    required: ["label", "url"],
                                },
                            },
                            required: ["id", "label", "description"],
                        },
                    },
                },
            },
            actions: [
                {
                    name: "set_steps",
                    description: "Define or replace the workflow steps.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            steps: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "string", description: "Unique step identifier (kebab-case)" },
                                        label: { type: "string", description: "Short display label" },
                                        description: { type: "string", description: "What this step does" },
                                        action: {
                                            type: "object",
                                            properties: {
                                                label: { type: "string", description: "Button text" },
                                                url: { type: "string", description: "URL to open" },
                                            },
                                            required: ["label", "url"],
                                        },
                                    },
                                    required: ["id", "label", "description"],
                                },
                            },
                            followups: {
                                type: "array",
                                description: "Optional override for the 'Next steps' buttons shown after every step is done. Defaults include integrating with Work IQ, evaluating, and deploying.",
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "string", description: "Unique follow-up identifier" },
                                        label: { type: "string", description: "Button text" },
                                        prompt: { type: "string", description: "Prompt sent to Copilot when clicked" },
                                        url: { type: "string", description: "URL to open instead of sending a prompt" },
                                    },
                                    required: ["id", "label"],
                                },
                            },
                        },
                        required: ["steps"],
                    },
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        if (!state) return { error: "Canvas instance not found" };
                        state.steps = ctx.input.steps.map((s) => ({
                            id: s.id, label: s.label, description: s.description,
                            ...(s.action ? { action: s.action } : {}),
                            status: "pending",
                        }));
                        if (Array.isArray(ctx.input.followups)) state.followups = ctx.input.followups;
                        broadcast(state);
                        saveState(ctx.instanceId, state.steps);
                        return { ok: true, step_count: state.steps.length, step_ids: state.steps.map((s) => s.id) };
                    },
                },
                {
                    name: "update_step",
                    description: "Update the status of a workflow step. Valid statuses: pending, in-progress, done.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            step_id: { type: "string", description: "Step ID to update" },
                            status: { type: "string", enum: ["pending", "in-progress", "done"] },
                            action: {
                                type: "object",
                                description: "Optional action button for when step is done",
                                properties: { label: { type: "string" }, url: { type: "string" } },
                                required: ["label", "url"],
                            },
                        },
                        required: ["step_id", "status"],
                    },
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        if (!state) return { error: "Canvas instance not found" };
                        const step = state.steps.find((s) => s.id === ctx.input.step_id);
                        if (!step) return { error: `Unknown step: ${ctx.input.step_id}. Available: ${state.steps.map((s) => s.id).join(", ")}` };
                        step.status = ctx.input.status;
                        if (ctx.input.action) step.action = ctx.input.action;
                        broadcast(state);
                        saveState(ctx.instanceId, state.steps);
                        const done = state.steps.filter((s) => s.status === "done").length;
                        return { ok: true, step_id: step.id, status: step.status, progress: `${done}/${state.steps.length}` };
                    },
                },
                {
                    name: "reset",
                    description: "Reset all steps back to pending.",
                    handler: async (ctx) => {
                        const state = instances.get(ctx.instanceId);
                        if (!state) return { error: "Canvas instance not found" };
                        for (const step of state.steps) step.status = "pending";
                        broadcast(state);
                        saveState(ctx.instanceId, state.steps);
                        return { ok: true };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    const persisted = loadState(ctx.instanceId);
                    const initialSteps = persisted || ctx.input?.steps || [];
                    entry = await startServer(ctx.instanceId, initialSteps);
                    servers.set(ctx.instanceId, entry);
                }
                return { title: ctx.input?.title || "Create Hosted Agent", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    instances.delete(ctx.instanceId);
                    await new Promise((r) => entry.server.close(r));
                }
                stopAzdAgent();
            },
        }),
        createCanvas({
            id: "foundry-agent-inspector",
            displayName: "Agent Inspector",
            description:
                "Interactive inspector UI for testing the local Foundry agent. Opens the agent inspector directly in a side panel. The agent must be running locally (azd ai agent run --no-inspector).",
            open: async () => {
                const proxyUrl = await ensureInspectorProxy();
                if (!proxyUrl) {
                    console.error("[foundry-canvas] Inspector not ready when opening inspector canvas");
                }
                return { title: "Agent Inspector", url: proxyUrl || `http://127.0.0.1:${AGENT_PORT}` };
            },
            onClose: async () => {},
        }),
    ],
});

// Store session reference for add-tool hand-off
copilotSession = session;
