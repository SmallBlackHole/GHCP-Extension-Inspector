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
import { joinSession, createCanvas } from "@github/copilot-sdk/extension";
import { createInspectorServer } from "./inspector-backend/index.mjs";
import { createWorkIqCanvases, setWorkIqSession } from "./workiq-canvas/workiq-canvas.mjs";

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

function createState(steps = []) {
    return {
        steps: steps.map((s) => ({ ...s, status: s.status || "pending" })),
        sseClients: new Set(),
    };
}

function broadcast(state) {
    const payload = JSON.stringify(state.steps);
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
    .subtitle { font-size: 12px; color: var(--muted); margin-bottom: 24px; }
    .steps { display: flex; flex-direction: column; gap: 0; }
    .step { display: flex; align-items: flex-start; gap: 14px; padding: 14px 0; position: relative; }
    .step:not(:last-child)::after {
      content: ''; position: absolute; left: 15px; top: 42px; bottom: 0;
      width: 2px; background: var(--border);
    }
    .step.done:not(:last-child)::after { background: var(--success); }
    .step.in-progress:not(:last-child)::after { background: var(--active); }
    .icon {
      width: 32px; height: 32px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      font-size: 14px; border: 2px solid var(--border); background: var(--surface);
      transition: all 0.3s ease;
    }
    .step.done .icon { background: var(--success); border-color: var(--success); color: #fff; }
    .step.in-progress .icon { background: var(--active); border-color: var(--active); color: #fff; animation: pulse 1.5s infinite; }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(210,153,34,0.4); }
      50% { box-shadow: 0 0 0 6px rgba(210,153,34,0); }
    }
    .content { flex: 1; min-width: 0; }
    .step-label { font-size: 14px; font-weight: 500; line-height: 32px; }
    .step.done .step-label { color: var(--success); }
    .step.in-progress .step-label { color: var(--active); }
    .step.pending .step-label { color: var(--muted); }
    .step-desc { font-size: 12px; color: var(--muted); margin-top: 2px; line-height: 1.4; }
    .step.in-progress .step-desc { color: var(--text); }
    .badge { font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 500; margin-top: 6px; display: inline-block; }
    .step.done .badge { background: rgba(63,185,80,0.15); color: var(--success); }
    .step.in-progress .badge { background: rgba(210,153,34,0.15); color: var(--active); }
    .action-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 5px 12px; margin-top: 8px; background: var(--accent); color: #fff;
      border: none; border-radius: 5px; font-size: 12px; font-weight: 500;
      cursor: pointer; text-decoration: none; transition: opacity 0.2s;
    }
    .action-btn:hover { opacity: 0.85; }
    .action-btn:disabled { opacity: 0.5; cursor: wait; }
    .progress-bar { margin-top: 20px; background: var(--surface); border-radius: 6px; height: 6px; overflow: hidden; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--success), var(--accent)); border-radius: 6px; transition: width 0.5s ease; }
    .progress-text { font-size: 11px; color: var(--muted); margin-top: 6px; text-align: right; }
  </style>
</head>
<body>
  <div id="workflow-view">
    <h1>🚀 Create Hosted Agent</h1>
    <p class="subtitle">Microsoft Foundry – Workflow Progress</p>
    <div class="steps" id="steps"></div>
    <div class="progress-bar"><div class="progress-fill" id="progress"></div></div>
    <p class="progress-text" id="progress-text"></p>
  </div>
  <div id="inspector-view" style="display:none; flex-direction:column; height:100vh;">
    <div style="display:flex; align-items:center; gap:10px; padding:8px 12px; background:var(--surface); border-bottom:1px solid var(--border); flex-shrink:0;">
      <button onclick="showWorkflow()" style="background:none; border:none; color:var(--accent); cursor:pointer; font-size:14px; padding:4px 8px; border-radius:4px; display:flex; align-items:center; gap:4px;" onmouseover="this.style.background='rgba(88,166,255,0.1)'" onmouseout="this.style.background='none'">← Back to workflow</button>
      <span style="font-size:13px; color:var(--text); font-weight:500;">Agent Inspector</span>
    </div>
    <iframe id="inspector-frame" src="" style="flex:1; border:none; width:100%; background:var(--bg);"></iframe>
  </div>
  <script>
    const icons = { pending: '○', 'in-progress': '◉', done: '✓' };

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

    function navigateTo(url, label) {
      const btn = event.currentTarget;
      const origText = btn.innerHTML;
      if (url.includes('localhost') || url.includes('127.0.0.1')) {
        btn.innerHTML = '⏳ Starting agent…';
        btn.disabled = true;
        fetch('/start-agent')
          .then(r => r.json())
          .then(data => {
            if (data.ok) {
              showInspector(data.url || url);
            } else {
              btn.innerHTML = '⚠️ ' + (data.error || 'Failed');
              setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 3000);
            }
          })
          .catch(() => {
            btn.innerHTML = '⚠️ Connection failed';
            setTimeout(() => { btn.innerHTML = origText; btn.disabled = false; }, 3000);
          });
      } else {
        window.open(url, '_blank');
        btn.innerHTML = '✓ Opened';
        setTimeout(() => { btn.innerHTML = origText; }, 2000);
      }
    }

    function render(steps) {
      const container = document.getElementById('steps');
      if (!steps || steps.length === 0) {
        container.innerHTML = '<p style="color: var(--muted); font-style: italic; padding: 20px 0;">Preparing workflow steps…</p>';
        document.getElementById('progress').style.width = '0%';
        document.getElementById('progress-text').textContent = '';
        return;
      }
      const done = steps.filter(s => s.status === 'done').length;
      const total = steps.length;
      container.innerHTML = steps.map(s => {
        const badge = s.status === 'done' ? '<span class="badge">Complete</span>'
          : s.status === 'in-progress' ? '<span class="badge">In Progress</span>' : '';
        const actionBtn = (s.status === 'done' && s.action)
          ? \`<button class="action-btn" onclick="navigateTo('\${s.action.url}', '\${s.action.label.replace(/'/g, "\\\\'")}')">
              \${s.action.label}
            </button>\`
          : '';
        return \`<div class="step \${s.status}">
          <div class="icon">\${icons[s.status]}</div>
          <div class="content">
            <div class="step-label">\${s.label}</div>
            <div class="step-desc">\${s.description}</div>
            \${badge}\${actionBtn}
          </div>
        </div>\`;
      }).join('');
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      document.getElementById('progress').style.width = pct + '%';
      document.getElementById('progress-text').textContent = done + ' of ' + total + ' steps complete (' + pct + '%)';
    }

    render([]);
    const es = new EventSource('/events');
    es.onmessage = (e) => { render(JSON.parse(e.data)); };
  </script>
</body>
</html>`;
}

// ─── Workflow canvas HTTP server ──────────────────────────────────────────────
async function startServer(instanceId, initialSteps = []) {
    const state = createState(initialSteps);
    instances.set(instanceId, state);

    const server = createServer(async (req, res) => {
        if (req.url === "/events") {
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
            state.sseClients.add(res);
            res.write(`data: ${JSON.stringify(state.steps)}\n\n`);
            req.on("close", () => state.sseClients.delete(res));
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
        ...createWorkIqCanvases(createCanvas, { projectRoot: PROJECT_ROOT }),
    ],
});

// Store session reference for fix-with-copilot callback
copilotSession = session;
setWorkIqSession(session);
