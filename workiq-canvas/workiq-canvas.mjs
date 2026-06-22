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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Default project root assumes a standalone layout; a host extension overrides
// this via createWorkIqCanvases({ projectRoot }) since nesting depth differs.
let PROJECT_ROOT = resolve(__dirname, "..", "..", "..");
const UI_DIR = __dirname;

// Canvas ids. The production source-of-truth skill references `foundry-workiq`;
// the local-testing v2 skill references `foundry-workiq-v2`. We register both
// so whichever skill the agent loads can open this canvas.
const CANVAS_IDS = ["foundry-workiq", "foundry-workiq-v2"];

// ─── Azure CLI / azd helpers ────────────────────────────────────────────────
const IS_WINDOWS = process.platform === "win32";

function which(bin) {
    const r = spawnSync(IS_WINDOWS ? "where" : "which", [bin], { encoding: "utf-8", shell: IS_WINDOWS });
    if (r.status === 0 && r.stdout) {
        const first = r.stdout.trim().split(/\r?\n/)[0].trim();
        if (first) return first;
    }
    return IS_WINDOWS ? `${bin}.cmd` : bin;
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

function getProjectContext() {
    const cwd = findAzdProjectDir();
    const ctx = {
        projectName: undefined,
        projectEndpoint: undefined,
        subscriptionId: undefined,
        resourceGroup: undefined,
        tenantId: undefined,
        account: undefined,
        signedIn: false,
        azdInitialized: existsSync(join(cwd, "azure.yaml")),
        warnings: [],
    };

    // azd env values (project deployment context)
    const env = run(AZD_PATH, ["env", "get-values"], cwd);
    if (env.status === 0 && env.stdout) {
        const v = parseEnvValues(env.stdout);
        ctx.projectEndpoint = v.AZURE_AI_PROJECT_ENDPOINT || v.AZURE_AIPROJECT_ENDPOINT;
        ctx.projectName = v.AZURE_AI_PROJECT_NAME || v.AZURE_AI_ACCOUNT_NAME;
        ctx.subscriptionId = v.AZURE_SUBSCRIPTION_ID;
        ctx.resourceGroup = v.AZURE_RESOURCE_GROUP;
    } else {
        ctx.warnings.push("No azd project values found. Run `azd ai agent` / select a Foundry project.");
    }

    // az identity (signed-in account + tenant)
    const acct = run(AZ_PATH, ["account", "show", "-o", "json"]);
    if (acct.status === 0 && acct.stdout) {
        try {
            const a = JSON.parse(acct.stdout);
            ctx.signedIn = true;
            ctx.tenantId = a.tenantId;
            ctx.account = a.user?.name;
            if (!ctx.subscriptionId) ctx.subscriptionId = a.id;
        } catch { /* ignore parse error */ }
    } else {
        ctx.warnings.push("Not signed in to Azure. Run `az login`.");
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
    const ctx = getProjectContext();
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
                return sendJson(res, 200, getProjectContext());
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

/** Provide the Copilot session so the Add-to-project hand-off can call session.send(...). */
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
                "Browse and add Microsoft 365 Work IQ tools (Teams, Outlook, email, meetings, files, messages) to the current Foundry project. Open this canvas when the user wants to integrate their agent with Office / Microsoft 365 / Teams / Outlook / email / messages.",
            open: async () => {
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
