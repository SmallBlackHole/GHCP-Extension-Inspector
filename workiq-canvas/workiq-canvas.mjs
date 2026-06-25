// Extension: foundry-workiq-canvas
// A standalone "quick and dirty" canvas that lets a user browse Work IQ
// (Microsoft 365) tools available/creatable in their current Foundry project
// and add one to the project. Adding a tool hands the work off to the Copilot
// session, which uses the microsoft-foundry skill (tool-work-iq) to create the
// connection + toolbox entry and wire it into the hosted agent.
//
// The page is intentionally simple: a static index.html served by a tiny Node
// HTTP server. The server also exposes:
//   GET  /api/context   -> current Foundry project info + signed-in identity
//   GET  /api/tools     -> Work IQ toolbox MCP tool list (live catalog, `workiq`-tagged)
//   POST /api/add-tool  -> hand the "add this tool" intent to the Copilot session
//
// It mirrors the sibling Agent Inspector extension's canvas pattern.

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Default project root assumes a standalone layout; a host extension overrides
// this via createWorkIqCanvases({ projectRoot }) since nesting depth differs.
let PROJECT_ROOT = resolve(__dirname, "..", "..", "..");
const UI_DIR = __dirname;

// Project context the *agent* passes when it opens the canvas. Since the agent
// scaffolded the project it already knows where it lives, so this is the most
// reliable source — we only probe the filesystem when these are absent.
let agentHint = { projectDir: undefined, projectEndpoint: undefined, projectName: undefined };

/** Record agent-supplied project context from the canvas `open` input. */
export function setAgentProjectHint(input) {
    if (!input || typeof input !== "object") return;
    for (const k of ["projectDir", "projectEndpoint", "projectName"]) {
        const v = input[k];
        if (typeof v === "string" && v.trim()) agentHint[k] = v.trim();
    }
}

// Canvas ids. The production source-of-truth skill references `foundry-workiq`;
// the local-testing v2 skill references `foundry-workiq-v2`. We register both
// so whichever skill the agent loads can open this canvas.
const CANVAS_IDS = ["foundry-workiq", "foundry-workiq-v2"];

// ─── Azure CLI / azd helpers ────────────────────────────────────────────────
const IS_WINDOWS = process.platform === "win32";

function probeKnownPaths(bin) {
    if (!IS_WINDOWS) return undefined;
    const PF = process.env["ProgramFiles"] || "C:\\Program Files";
    const LAD = process.env["LOCALAPPDATA"];
    const candidates = [];
    if (bin === "az") {
        candidates.push(join(PF, "Microsoft SDKs", "Azure", "CLI2", "wbin", "az.cmd"));
    } else if (bin === "azd") {
        candidates.push(join(PF, "Azure Dev CLI", "azd.exe"));
        if (LAD) candidates.push(join(LAD, "Programs", "Azure Dev CLI", "azd.exe"));
    }
    return candidates.find(c => existsSync(c));
}

function which(bin) {
    const r = spawnSync(IS_WINDOWS ? "where" : "which", [bin], { encoding: "utf-8", shell: IS_WINDOWS });
    if (r.status === 0 && r.stdout) {
        const first = r.stdout.trim().split(/\r?\n/)[0].trim();
        if (first) return first;
    }
    // GUI-launched extension hosts can have a reduced PATH that omits az/azd.
    return probeKnownPaths(bin) || (IS_WINDOWS ? `${bin}.cmd` : bin);
}

const AZD_PATH = which("azd");
const AZ_PATH = which("az");

function run(cmd, args, cwd) {
    try {
        const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", shell: IS_WINDOWS, windowsHide: true });
        return { status: r.status ?? -1, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
    } catch (err) {
        return { status: -1, stdout: "", stderr: String(err?.message || err) };
    }
}

// Asynchronously locate the azd project dir (the one holding `azure.yaml`) by
// probing the top 3 directory levels under the workspace root. The agent
// usually scaffolds the project into a sub-folder (e.g. `workagent1/`), so a
// single-level scan isn't enough. Prefer a project that already has an
// initialized azd env (`.azure/`). Only used when the agent didn't pass a dir.
async function findAzdProjectDirAsync() {
    const SKIP = new Set(["node_modules", ".git", ".github", ".azure", "dist", "out", "bin", "obj", ".vs", ".vscode", "__pycache__"]);
    const matches = [];
    const walk = async (dir, depth) => {
        if (depth > 2) return; // top 3 levels: root (0) + 2 nested
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        if (entries.some(e => e.isFile() && e.name === "azure.yaml")) {
            matches.push({ dir, hasEnv: existsSync(join(dir, ".azure")) });
            return; // don't descend into a found project
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

// Read azd env values straight off disk (`.azure/config.json` ->
// defaultEnvironment -> `.azure/<env>/.env`). This is far more reliable than
// spawning `azd` inside a GUI-launched extension host with a reduced PATH.
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

// Decode the payload of a JWT (no verification — we only read tid/upn claims).
function decodeJwtPayload(jwt) {
    try {
        const part = String(jwt).split(".")[1];
        const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
        return JSON.parse(json);
    } catch {
        return null;
    }
}

// Determine the signed-in identity. Prefer DefaultAzureCredential (azd/az/env/
// managed-identity/VS Code) so it works even when `az` isn't on PATH; fall back
// to `az account show` if @azure/identity isn't installed or yields no token.
let cachedCred;
async function getSignInIdentity() {
    try {
        const idm = await import("@azure/identity");
        const cred = cachedCred || (cachedCred = new idm.DefaultAzureCredential());
        const token = await cred.getToken("https://management.azure.com/.default");
        if (token?.token) {
            const c = decodeJwtPayload(token.token);
            return {
                signedIn: true,
                tenantId: c?.tid,
                account: c?.upn || c?.preferred_username || c?.email || c?.unique_name,
            };
        }
    } catch { /* fall through to az */ }
    const acct = run(AZ_PATH, ["account", "show", "-o", "json"]);
    if (acct.status === 0 && acct.stdout) {
        try {
            const a = JSON.parse(acct.stdout);
            return { signedIn: true, tenantId: a.tenantId, account: a.user?.name, subscriptionId: a.id };
        } catch { /* ignore */ }
    }
    return { signedIn: false };
}

// Parse `azd env get-values` output (KEY="value" or KEY=value, one per line).
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

async function getProjectContext() {
    const ctx = {
        projectName: undefined,
        projectEndpoint: undefined,
        subscriptionId: undefined,
        resourceGroup: undefined,
        tenantId: undefined,
        account: undefined,
        signedIn: false,
        azdInitialized: false,
        projectSource: undefined, // "agent" | "disk" | "azd-cli"
        warnings: [],
    };

    // 1) Agent-provided context wins. The agent created the project, so if it
    //    passed projectDir / projectEndpoint / projectName when opening the
    //    canvas, trust that over any filesystem guess.
    if (agentHint.projectEndpoint) { ctx.projectEndpoint = agentHint.projectEndpoint; ctx.projectSource = "agent"; }
    if (agentHint.projectName) ctx.projectName = agentHint.projectName;

    // 2) Resolve the azd project dir: agent-provided dir first, else probe the
    //    top 3 directory levels asynchronously for an `azure.yaml`.
    let cwd = agentHint.projectDir && existsSync(join(agentHint.projectDir, "azure.yaml"))
        ? agentHint.projectDir
        : await findAzdProjectDirAsync();
    ctx.azdInitialized = existsSync(join(cwd, "azure.yaml"));

    // 3) Fill project endpoint/name/sub/rg by reading the azd env straight off
    //    disk (robust — no spawn). Only spawn `azd` as a last resort.
    if (!ctx.projectEndpoint || !ctx.subscriptionId) {
        const v = readAzdEnvFromDisk(cwd);
        if (!ctx.projectEndpoint) {
            ctx.projectEndpoint = v.AZURE_AI_PROJECT_ENDPOINT || v.AZURE_AIPROJECT_ENDPOINT;
            if (ctx.projectEndpoint) ctx.projectSource = ctx.projectSource || "disk";
        }
        ctx.projectName = ctx.projectName || v.AZURE_AI_PROJECT_NAME || v.AZURE_AI_ACCOUNT_NAME;
        ctx.subscriptionId = ctx.subscriptionId || v.AZURE_SUBSCRIPTION_ID;
        ctx.resourceGroup = ctx.resourceGroup || v.AZURE_RESOURCE_GROUP;
    }
    if (!ctx.projectEndpoint) {
        const proj = run(AZD_PATH, ["ai", "project", "show"], cwd);
        if (proj.status === 0 && proj.stdout) {
            const ep = proj.stdout.match(/Project endpoint:\s*(\S+)/i);
            if (ep) { ctx.projectEndpoint = ep[1]; ctx.projectSource = "azd-cli"; }
        }
    }
    // Derive the project name from the endpoint if we still don't have one.
    if (!ctx.projectName && ctx.projectEndpoint) {
        const nameMatch = ctx.projectEndpoint.match(/\/projects\/([^/?#]+)/i);
        if (nameMatch) ctx.projectName = decodeURIComponent(nameMatch[1]);
    }
    if (!ctx.projectEndpoint) {
        ctx.warnings.push("No Foundry project found. The agent can pass the project directory/endpoint when opening this canvas, or run `azd ai project select` (or `azd ai agent`) in your project folder.");
    }

    // 4) Signed-in identity via DefaultAzureCredential (azd/az/env/MI/VS Code),
    //    falling back to `az account show`. Works even when `az` isn't on PATH.
    const id = await getSignInIdentity();
    if (id.signedIn) {
        ctx.signedIn = true;
        ctx.tenantId = ctx.tenantId || id.tenantId;
        ctx.account = ctx.account || id.account;
        ctx.subscriptionId = ctx.subscriptionId || id.subscriptionId;
    } else {
        ctx.warnings.push("Not signed in to Azure. Run `az login` (or configure a DefaultAzureCredential source such as `azd auth login`).");
    }

    return ctx;
}

// ─── Work IQ tool catalog ───────────────────────────────────────────────────
// Same anonymous catalog endpoint the ai-mlstudio extension uses. Work IQ tools
// are catalog entries tagged `workiq` — the toolbox MCP connectors (Mail,
// Calendar, Teams, Outlook, SharePoint, OneDrive, etc.). We intentionally do
// NOT surface the A2A "Work IQ Chat" variant: it routes the Copilot hand-off
// to a different (wrong) doc/flow. Only the toolbox `mcp` tools are offered.
const WORKIQ_TAG = "workiq";
const CATALOG_ENDPOINT = "https://ai.azure.com/api/eastus/ux/v1.0/entities/crossRegion";

function catalogRequestBody() {
    return {
        resourceIds: [{ resourceId: "registry-prod-bl", entityContainerType: "ApiCenter", region: "eastus" }],
        indexEntitiesRequest: {
            filters: [
                { field: "type", operator: "eq", values: ["tools"] },
                { field: "kind", operator: "eq", values: ["Versioned"] },
                { field: "labels", operator: "eq", values: ["latest"] },
            ],
            freeTextSearch: "",
            order: [
                { field: "usage/popularity", direction: "Desc" },
                { field: "relevancyScore", direction: "Desc" },
                { field: "name", direction: "Asc" },
            ],
            pageSize: 100,
            includeTotalResultCount: true,
            searchBuilder: "AppendPrefix",
        },
    };
}

function mapCatalogEntry(entry) {
    const p = entry.properties || {};
    const tags = Array.isArray(p["x-ms-tags"]) ? p["x-ms-tags"] : [];
    const remotes = Array.isArray(p.remotes) ? p.remotes : [];
    const custom = p.customProperties || {};
    return {
        id: entry.entityId || custom.internalName || p.title || "unknown",
        internalName: entry.entityObjectId || custom.internalName || p.name || entry.entityId,
        name: p.title || "Unknown tool",
        description: entry.annotations?.description || "",
        kind: "mcp",
        serverUrl: remotes[0]?.url,
        icon: typeof (custom.icon ?? p["x-ms-icon"]) === "string" ? (custom.icon ?? p["x-ms-icon"]) : undefined,
        provider: typeof custom.vendor === "string" ? custom.vendor : "Microsoft",
        isPreview: true,
        tags,
    };
}

async function getWorkIqTools() {
    const tools = [];
    try {
        const resp = await fetch(CATALOG_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                // The catalog endpoint throttles unknown user-agents (429); use the
                // same UA the ai-mlstudio extension's catalog accessor sends.
                "x-ms-user-agent": "AzureMachineLearningWorkspacePortal/12.0",
            },
            body: JSON.stringify(catalogRequestBody()),
        });
        if (resp.ok) {
            const data = await resp.json();
            const values = data?.indexEntitiesResponse?.value || [];
            for (const entry of values) {
                const t = mapCatalogEntry(entry);
                if (t.tags?.includes(WORKIQ_TAG)) {
                    delete t.tags;
                    tools.push(t);
                }
            }
        } else {
            console.error(`[workiq-canvas] catalog request failed: HTTP ${resp.status}`);
        }
    } catch (err) {
        console.error(`[workiq-canvas] catalog fetch error: ${err?.message || err}`);
    }
    return tools;
}

// ─── Add-tool hand-off to the Copilot session ───────────────────────────────
let copilotSession = null; // assigned after joinSession

function buildAddToolPrompt(tool, ctx) {
    const projectLine = ctx?.projectEndpoint
        ? `my current Foundry project "${ctx.projectName || ctx.projectEndpoint}" (endpoint ${ctx.projectEndpoint})`
        : "my current Foundry project";
    const audience = "ea9ffc3e-8a23-4a7d-836d-234d7c7565c1"; // Work IQ app ID — token audience for the MCP connectors (Mail/Calendar/etc.)
    const wiring = `- Create the \`RemoteTool\` (MCP) project connection for the Work IQ MCP server ${tool.serverUrl || "(see catalog)"} per foundry-tool-catalog.md with \`UserEntraToken\` auth and \`metadata.audience = ${audience}\`, then add a \`{ "type": "mcp", "project_connection_id": "<conn>" }\` entry to the agent's toolbox version.`;

    return [
        `Integrate my Foundry agent with Microsoft 365 Work IQ by adding the **Work IQ toolbox MCP tool** "${tool.name}" (catalog id \`${tool.internalName || tool.id}\`) to ${projectLine}. This is the toolbox MCP connector (Teams, Outlook, Mail, Calendar, etc.) — NOT the A2A "Work IQ Chat".`,
        ``,
        `Use the microsoft-foundry skill's Work IQ workflow (foundry-agent/create/references/tool-work-iq.md) and do the FULL chain so the tool is actually usable and testable in the Agent Inspector:`,
        wiring,
        `- Ensure the hosted agent is wired to that toolbox: confirm \`TOOLBOX_ENDPOINT\` is set (declare the toolbox + connection in \`azure.yaml\` so \`azd up\` provisions it and injects the env var if it isn't already).`,
        `- Walk me through the Work IQ prerequisites: 1P managed OAuth (OBO) — each user signs in once, no BYO Entra app or Global-Admin admin consent; an M365 Copilot license for the calling user; and a non-VNet project endpoint.`,
        `- Then do a clean restart of the local agent (kill the previous process) so I can verify it in the Agent Inspector.`,
    ].join("\n");
}

async function handleAddTool(tool) {
    const ctx = await getProjectContext();
    const prompt = buildAddToolPrompt(tool, ctx);
    if (!copilotSession) {
        console.error("[workiq-canvas] add-tool requested but no Copilot session (standalone mode). Prompt would be:\n" + prompt);
        return { ok: true, standalone: true, message: "Running standalone — would hand off to Copilot:", prompt };
    }
    try {
        await copilotSession.send(prompt);
        return { ok: true, message: `Asked Copilot to add "${tool.name}" to your project.` };
    } catch (err) {
        return { ok: false, error: err?.message || String(err) };
    }
}

// ─── Static file + API HTTP server ──────────────────────────────────────────
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};

function serveStatic(req, res) {
    const urlPath = (req.url || "/").split("?")[0];
    const rel = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");
    const filePath = join(UI_DIR, rel);
    if (!filePath.startsWith(UI_DIR)) { res.writeHead(403).end(); return; }
    try {
        if (!statSync(filePath).isFile()) throw new Error("not a file");
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(filePath).toLowerCase()] || "application/octet-stream" });
    res.end(readFileSync(filePath));
}

function readJsonBody(req) {
    return new Promise((resolveBody) => {
        let data = "";
        req.on("data", (c) => { data += c; if (data.length > 1_000_000) req.destroy(); });
        req.on("end", () => { try { resolveBody(JSON.parse(data || "{}")); } catch { resolveBody({}); } });
        req.on("error", () => resolveBody({}));
    });
}

function sendJson(res, status, payload) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

async function startServer() {
    const server = createServer(async (req, res) => {
        const path = (req.url || "/").split("?")[0];
        try {
            if (path === "/api/context") {
                return sendJson(res, 200, await getProjectContext());
            }
            if (path === "/api/tools") {
                return sendJson(res, 200, { tools: await getWorkIqTools() });
            }
            if (path === "/api/add-tool" && req.method === "POST") {
                const body = await readJsonBody(req);
                if (!body?.name) return sendJson(res, 400, { ok: false, error: "Missing tool" });
                return sendJson(res, 200, await handleAddTool(body));
            }
            return serveStatic(req, res);
        } catch (err) {
            return sendJson(res, 500, { ok: false, error: err?.message || String(err) });
        }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    return { server, url: `http://127.0.0.1:${port}/` };
}

// ─── Public API: embed into a host extension ────────────────────────────────
let sharedServer = null;

async function ensureServer() {
    if (!sharedServer) sharedServer = await startServer();
    return sharedServer;
}

/** Provide the Copilot session so the Add-to-agent hand-off can call session.send(...). */
export function setWorkIqSession(session) {
    copilotSession = session;
}

/**
 * Build the Work IQ canvas objects to add to a host extension's
 * joinSession({ canvases }) array. Pass the host's createCanvas and its resolved
 * project root (so azd context resolves relative to the repo, not this nested file).
 */
export function createWorkIqCanvases(createCanvas, { projectRoot } = {}) {
    if (projectRoot) PROJECT_ROOT = projectRoot;
    return CANVAS_IDS.map((id) =>
        createCanvas({
            id,
            displayName: "Work IQ Tools",
            description:
                "Browse and add Microsoft 365 Work IQ tools (Teams, Outlook, email, meetings, files, messages) to the current Foundry project. Open this canvas when the user wants to integrate their agent with Office / Microsoft 365 / Teams / Outlook / email / messages. The agent should pass the project it created via input { projectDir, projectEndpoint, projectName } so the canvas doesn't have to guess.",
            inputSchema: {
                type: "object",
                properties: {
                    projectDir: { type: "string", description: "Absolute path to the azd project directory the agent created (the folder holding azure.yaml). Preferred source of project context." },
                    projectEndpoint: { type: "string", description: "Foundry project endpoint, if the agent already knows it." },
                    projectName: { type: "string", description: "Foundry project name, if the agent already knows it." },
                },
            },
            open: async (ctx) => {
                setAgentProjectHint(ctx?.input);
                const { url } = await ensureServer();
                return { title: "Work IQ Tools", url };
            },
            onClose: async () => {},
        }),
    );
}

// ─── Standalone mode (node workiq-canvas.mjs) ───────────────────────────────
// When run directly (not imported), start the server so the page can be opened
// in a browser, registering canvases only if the Copilot SDK is available.
async function runStandalone() {
    try {
        const { joinSession, createCanvas } = await import("@github/copilot-sdk/extension");
        const session = await joinSession({ canvases: createWorkIqCanvases(createCanvas) });
        setWorkIqSession(session);
        console.error(`[workiq-canvas] registered canvases: ${CANVAS_IDS.join(", ")}`);
    } catch {
        const { url } = await ensureServer();
        console.error(`[workiq-canvas] Copilot SDK not found — running standalone. Open: ${url}`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
    runStandalone().catch((err) => {
        console.error(`[workiq-canvas] failed to start: ${err?.message || err}`);
    });
}
