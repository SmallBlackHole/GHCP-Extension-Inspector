// Inspector Backend: hosts the inspector UI and proxies traffic to the agent.
// Serves static files from inspector-ui/, implements the JSON-RPC WebSocket
// protocol at /agentdev/ws/rpc, and a health WebSocket at /agentdev/ws/health.

import { createServer, request as httpRequest } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocketServer, WebSocket } = require("ws");

// ─── Static file serving ──────────────────────────────────────────────────────

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
};

function getMimeType(filePath) {
    return MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

function createStaticHandler(uiDir) {
    return function tryServeStatic(req, res) {
        const urlPath = (req.url || "/").split("?")[0];
        let filePath;
        if (urlPath === "/" || urlPath === "/index.html") {
            filePath = join(uiDir, "index.html");
        } else {
            filePath = join(uiDir, urlPath);
        }
        if (!filePath.startsWith(uiDir)) return false;
        try {
            const stat = statSync(filePath);
            if (!stat.isFile()) return false;
        } catch { return false; }
        const content = readFileSync(filePath);
        res.writeHead(200, { "Content-Type": getMimeType(filePath) });
        res.end(content);
        return true;
    };
}

// ─── JSON-RPC proxy over WebSocket ────────────────────────────────────────────
// Implements the /agentdev/ws/rpc endpoint that the inspector UI connects to.
// Handles system RPCs (theme, navigation) and proxy methods (fetch, SSE, WS).

function handleRpcConnection(ws, agentPort, onFixRequested) {
    const activeSSE = new Map();
    const activeWS = new Map();

    function sendMsg(msg) {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    let nextRequestId = 1;
    function sendRequest(method, params) {
        sendMsg({ jsonrpc: "2.0", id: `server-${nextRequestId++}`, method, params });
    }

    function sendResult(id, result) {
        sendMsg({ jsonrpc: "2.0", id, result: result ?? null });
    }

    function sendError(id, message) {
        sendMsg({ jsonrpc: "2.0", id, error: { code: -32000, message } });
    }

    function sendNotification(method, params) {
        sendMsg({ jsonrpc: "2.0", method, params: [params] });
    }

    // ── Proxy handlers ──

    async function handleFetch(id, params) {
        try {
            const resp = await fetch(params.url, {
                method: params.method || "GET",
                headers: params.headers,
                body: params.body,
            });
            const body = await resp.text();
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            sendResult(id, { status: resp.status, statusText: resp.statusText, headers, body });
        } catch (err) { sendError(id, err.message); }
    }

    function handleFetchSSE(id, params) {
        const abort = new AbortController();
        activeSSE.set(params.requestId, abort);
        sendResult(id, null);

        (async () => {
            try {
                const resp = await fetch(params.url, {
                    method: params.method || "POST",
                    headers: params.headers,
                    body: params.body,
                    signal: abort.signal,
                });
                if (!resp.ok) {
                    // Read response body for meaningful error details
                    let errorMessage = `HTTP ${resp.status} ${resp.statusText}`;
                    try {
                        const body = await resp.text();
                        if (body) {
                            try {
                                const parsed = JSON.parse(body);
                                const detail = parsed?.error?.message || parsed?.detail || parsed?.message || parsed?.error;
                                if (typeof detail === "string") errorMessage = detail;
                                else errorMessage = body;
                            } catch { errorMessage = body; }
                        }
                    } catch { /* keep status-line error */ }
                    sendNotification("webviewProxy/fetchSSE/done", { requestId: params.requestId, error: errorMessage });
                    return;
                }
                const reader = resp.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                        if (line.startsWith("data: ")) {
                            const data = line.slice(6);
                            if (data === "[DONE]") break;
                            sendNotification("webviewProxy/fetchSSE/chunk", { requestId: params.requestId, data });
                        }
                    }
                }
                sendNotification("webviewProxy/fetchSSE/done", { requestId: params.requestId });
            } catch (err) {
                if (!abort.signal.aborted) {
                    sendNotification("webviewProxy/fetchSSE/done", { requestId: params.requestId, error: err.message });
                }
            } finally { activeSSE.delete(params.requestId); }
        })();
    }

    function handleFetchSSECancel(id, requestId) {
        activeSSE.get(requestId)?.abort();
        activeSSE.delete(requestId);
        sendResult(id, null);
    }

    async function handleInvoke(id, params) {
        const abort = new AbortController();
        activeSSE.set(params.requestId, abort);
        try {
            const resp = await fetch(params.url, {
                method: "POST",
                headers: params.headers,
                body: params.body,
                signal: abort.signal,
            });
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            const contentType = (headers["content-type"] || "").toLowerCase();
            const isSSE = contentType.startsWith("text/event-stream");

            if (!isSSE) {
                activeSSE.delete(params.requestId);
                const body = await resp.text();
                sendResult(id, { status: resp.status, statusText: resp.statusText, headers, mode: "buffered", body });
                return;
            }

            sendResult(id, { status: resp.status, statusText: resp.statusText, headers, mode: "streaming" });

            (async () => {
                try {
                    const reader = resp.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = "";
                    while (true) {
                        if (abort.signal.aborted) break;
                        const { done, value } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split("\n");
                        buffer = lines.pop() || "";
                        if (lines.length > 0) {
                            sendNotification("webviewProxy/fetchSSE/chunk", { requestId: params.requestId, data: lines.join("\n") });
                        }
                    }
                    sendNotification("webviewProxy/fetchSSE/done", { requestId: params.requestId });
                } catch (err) {
                    if (!abort.signal.aborted) {
                        sendNotification("webviewProxy/fetchSSE/done", { requestId: params.requestId, error: err.message });
                    }
                } finally { activeSSE.delete(params.requestId); }
            })();
        } catch (err) {
            activeSSE.delete(params.requestId);
            sendError(id, err.message);
        }
    }

    function handleWSConnect(id, params) {
        try {
            const target = new WebSocket(params.url);
            target.on("open", () => {
                activeWS.set(params.requestId, target);
                sendResult(id, null);
            });
            target.on("message", (data) => {
                sendNotification("webviewProxy/ws/message", { requestId: params.requestId, data: data.toString() });
            });
            target.on("close", (code, reason) => {
                activeWS.delete(params.requestId);
                sendNotification("webviewProxy/ws/disconnect", { requestId: params.requestId, code, reason: reason?.toString() });
            });
            target.on("error", (err) => {
                if (activeWS.has(params.requestId)) {
                    activeWS.delete(params.requestId);
                    sendNotification("webviewProxy/ws/disconnect", { requestId: params.requestId, reason: err.message });
                } else {
                    sendError(id, `WebSocket connection failed: ${err.message}`);
                }
            });
        } catch (err) { sendError(id, err.message); }
    }

    function handleWSSend(id, params) {
        const target = activeWS.get(params.requestId);
        if (target) target.send(params.data);
        sendResult(id, null);
    }

    function handleWSClose(id, requestId) {
        const target = activeWS.get(requestId);
        if (target) { target.close(); activeWS.delete(requestId); }
        sendResult(id, null);
    }

    // ── Message router ──

    ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        const { id, method, params } = msg;
        // Ignore responses to our server-sent requests
        if (!method && id != null) return;
        const p = Array.isArray(params) ? params[0] : params;

        switch (method) {
            // System RPCs - UI initialization
            case "getThemeRequest":
                if (id != null) sendResult(id, "light");
                break;
            case "getPlatformSettingsRequest":
                if (id != null) sendResult(id, { platform: "win32", hideFinetuning: false, isFoundryLocalEnabled: false, resourceUsageSupportedProviders: [] });
                break;
            case "setViewReady":
                // UI is ready - send navigation command to show the Agent Inspector view
                sendRequest("navigateToStep", ["testTool", { port: agentPort }]);
                break;
            case "sendTelemetry":
            case "logInfo":
            case "logError":
            case "getFeatureFlags":
                // Telemetry/logging/feature flags - acknowledge if request
                if (id != null) sendResult(id, null);
                break;
            // Proxy RPCs
            case "webviewProxy/fetch": handleFetch(id, p); break;
            case "webviewProxy/fetchSSE": handleFetchSSE(id, p); break;
            case "webviewProxy/fetchSSE/cancel": handleFetchSSECancel(id, p); break;
            case "webviewProxy/invoke": handleInvoke(id, p); break;
            case "webviewProxy/ws/connect": handleWSConnect(id, p); break;
            case "webviewProxy/ws/send": handleWSSend(id, p); break;
            case "webviewProxy/ws/close": handleWSClose(id, p); break;
            // Fix with Copilot: forward fix request to the extension
            case "inspector/fixRequested":
                if (onFixRequested && p) {
                    onFixRequested(p.source, p.errorSummary);
                }
                if (id != null) sendResult(id, null);
                break;
            default:
                // Respond with null to unblock UI for unknown requests
                if (id != null) sendResult(id, null);
        }
    });

    ws.on("close", () => {
        for (const abort of activeSSE.values()) abort.abort();
        activeSSE.clear();
        for (const target of activeWS.values()) target.close();
        activeWS.clear();
    });
}

// ─── Inspector server factory ─────────────────────────────────────────────────

/**
 * Creates and starts the inspector backend server.
 * @param {object} options
 * @param {string} options.uiDir - Absolute path to the inspector UI static files
 * @param {number} options.agentPort - Port the agent is running on
 * @returns {Promise<{url: string, server: import('node:http').Server}>}
 */
export async function createInspectorServer({ uiDir, agentPort, onFixRequested }) {
    const tryServeStatic = createStaticHandler(uiDir);

    const server = createServer((req, res) => {
        if (tryServeStatic(req, res)) return;
        // Proxy non-static HTTP requests to the agent
        const proxyReq = httpRequest(
            { hostname: "127.0.0.1", port: agentPort, path: req.url || "/", method: req.method, headers: { ...req.headers, host: `localhost:${agentPort}` } },
            (proxyRes) => {
                const headers = { ...proxyRes.headers };
                delete headers["x-frame-options"];
                delete headers["content-security-policy"];
                res.writeHead(proxyRes.statusCode, headers);
                proxyRes.pipe(res, { end: true });
            }
        );
        proxyReq.on("error", () => { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("Agent not reachable"); });
        req.pipe(proxyReq, { end: true });
    });

    // WebSocket server for /agentdev/ws/rpc and /agentdev/ws/health
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
        const path = (req.url || "").split("?")[0];
        if (path === "/agentdev/ws/rpc") {
            wss.handleUpgrade(req, socket, head, (ws) => {
                handleRpcConnection(ws, agentPort, onFixRequested);
            });
        } else if (path === "/agentdev/ws/health") {
            wss.handleUpgrade(req, socket, head, (ws) => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ status: "ok", agentPort }));
                }
                ws.on("message", () => {
                    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ status: "ok", agentPort }));
                });
            });
        } else {
            socket.destroy();
        }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const url = `http://127.0.0.1:${addr.port}/`;
    return { url, server };
}
