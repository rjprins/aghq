import { WebSocketServer } from "ws";
import type WebSocket from "ws";
import type { FastifyInstance } from "fastify";

import type { ClientToServerMessage, PtySummary, ServerToClientMessage } from "../types.js";
import type { PtyManager } from "../pty/manager.js";
import type { ReadinessEngine } from "../readiness/engine.js";
import type { WsHub } from "../ws/hub.js";
import { tmuxCapturePaneVisible, tmuxScrollHistory, tmuxSearchHistory } from "../tmux.js";
import { AUTH_ENABLED } from "./config.js";
import { isRecord } from "./utils.js";
import { isTokenValid, isWsOriginAllowed, parseTokenFromHeaders, parseTokenFromUrl } from "./auth.js";

type WsDeps = {
  fastify: FastifyInstance;
  hub: WsHub;
  ptys: PtyManager;
  readinessEngine: ReadinessEngine;
  listPtys: () => Promise<unknown>;
};

const MOBILE_SNAPSHOT_MAX_LINES = 20_000;
const MOBILE_SUBMIT_GATE_TIMEOUT_MS = 800;
const MOBILE_SUBMIT_MAX_BODY_BYTES = 64 * 1024;

function send(ws: WebSocket, msg: ServerToClientMessage): void {
  ws.send(JSON.stringify(msg));
}

function tmuxCaptureTarget(summary: PtySummary): { target: string; server: PtySummary["tmuxServer"] } | null {
  const args = Array.isArray(summary.args) ? summary.args : [];
  // Prefer the exact attached linked-session target used by this PTY process.
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "-t") continue;
    const candidate = (args[i + 1] ?? "").trim();
    if (!candidate) continue;
    return { target: candidate, server: summary.tmuxServer };
  }
  const fallback = (summary.tmuxSession ?? "").trim();
  if (!fallback) return null;
  return { target: fallback, server: summary.tmuxServer };
}

function parseWsMessage(raw: unknown): ClientToServerMessage | null {
  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString("utf8");
  } else if (Array.isArray(raw) && raw.every(Buffer.isBuffer)) {
    text = Buffer.concat(raw).toString("utf8");
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString("utf8");
  } else {
    return null;
  }

  if (Buffer.byteLength(text, "utf8") > 256 * 1024) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  if (parsed.type === "kick_other_subscribers") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    return { type: "kick_other_subscribers", ptyId: parsed.ptyId };
  }
  if (parsed.type === "subscribe") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    return { type: "subscribe", ptyId: parsed.ptyId };
  }
  if (parsed.type === "input") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    if (typeof parsed.data !== "string") return null;
    if (Buffer.byteLength(parsed.data, "utf8") > 64 * 1024) return null;
    return { type: "input", ptyId: parsed.ptyId, data: parsed.data };
  }
  if (parsed.type === "mobile_submit") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    if (typeof parsed.body !== "string") return null;
    if (Buffer.byteLength(parsed.body, "utf8") > MOBILE_SUBMIT_MAX_BODY_BYTES) return null;
    return { type: "mobile_submit", ptyId: parsed.ptyId, body: parsed.body };
  }
  if (parsed.type === "resize") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    const cols = parsed.cols;
    const rows = parsed.rows;
    if (typeof cols !== "number" || typeof rows !== "number") return null;
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
    if (cols < 1 || cols > 1000) return null;
    if (rows < 1 || rows > 1000) return null;
    return { type: "resize", ptyId: parsed.ptyId, cols, rows };
  }
  if (parsed.type === "tmux_control") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    const direction = parsed.direction;
    const lines = parsed.lines;
    if (direction !== "up" && direction !== "down") return null;
    if (typeof lines !== "number" || !Number.isInteger(lines)) return null;
    if (lines < 1 || lines > 200) return null;
    return { type: "tmux_control", ptyId: parsed.ptyId, direction, lines };
  }
  if (parsed.type === "tmux_search") {
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    const direction = parsed.direction;
    const query = parsed.query;
    if (direction !== "backward" && direction !== "forward") return null;
    if (typeof query !== "string" || query.length === 0 || query.length > 256) return null;
    return { type: "tmux_search", ptyId: parsed.ptyId, direction, query };
  }
  if (parsed.type === "mobile_snapshot_request") {
    if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0 || parsed.requestId.length > 128) return null;
    if (typeof parsed.ptyId !== "string" || parsed.ptyId.length === 0) return null;
    const lines = parsed.lines;
    if (typeof lines !== "number" || !Number.isInteger(lines)) return null;
    if (lines < 1 || lines > MOBILE_SNAPSHOT_MAX_LINES) return null;
    return { type: "mobile_snapshot_request", requestId: parsed.requestId, ptyId: parsed.ptyId, lines };
  }
  return null;
}

async function waitForMobileSubmitGate(
  ptys: PtyManager,
  ptyId: string,
  body: string,
  timeoutMs = MOBILE_SUBMIT_GATE_TIMEOUT_MS,
): Promise<void> {
  const needle = body.trim().replace(/\s+/g, " ").toLowerCase().slice(-120);
  if (!needle) return;
  await new Promise<void>((resolve) => {
    let done = false;
    let recent = "";
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ptys.off("output", onOutput);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(120, timeoutMs));
    const onOutput = (outPtyId: string, data: string) => {
      if (outPtyId !== ptyId || !data) return;
      // Strip common ANSI sequences and compare on normalized text chunks.
      recent = (recent + data)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (recent.length > 8000) recent = recent.slice(-8000);
      if (recent.includes(needle)) finish();
    };
    ptys.on("output", onOutput);
  });
}

export function registerWs(deps: WsDeps): void {
  const { fastify, hub, ptys, readinessEngine, listPtys } = deps;
  const wss = new WebSocketServer({ noServer: true });

  hub.onSubscriberChange = () => {
    hub.broadcast({ type: "viewer_counts", counts: hub.subscriberCounts() });
  };

  wss.on("connection", (ws) => {
    const client = hub.add(ws);

    void listPtys()
      .then((items) => send(ws, { type: "pty_list", ptys: items as any }))
      .catch(() => send(ws, { type: "pty_list", ptys: ptys.list() as any }));
    send(ws, { type: "viewer_counts", counts: hub.subscriberCounts() });

    ws.on("message", (raw) => {
      const msg = parseWsMessage(raw);
      if (!msg) return;

      if (msg.type === "subscribe") {
        hub.markSubscribed(client, msg.ptyId);
        return;
      }
      if (msg.type === "kick_other_subscribers") {
        hub.kickOthers(msg.ptyId, client);
        return;
      }
      if (msg.type === "input") {
        readinessEngine.markInput(msg.ptyId, msg.data);
        ptys.write(msg.ptyId, msg.data);
        return;
      }
      if (msg.type === "mobile_submit") {
        const body = msg.body.replace(/\r\n?/g, "\n").replace(/[\r\n]+/g, "");
        if (body.length > 0) {
          readinessEngine.markInput(msg.ptyId, body);
          ptys.write(msg.ptyId, body);
          void waitForMobileSubmitGate(ptys, msg.ptyId, body)
            .catch(() => {})
            .finally(() => {
              readinessEngine.markInput(msg.ptyId, "\r");
              ptys.write(msg.ptyId, "\r");
            });
          return;
        }
        readinessEngine.markInput(msg.ptyId, "\r");
        ptys.write(msg.ptyId, "\r");
        return;
      }
      if (msg.type === "resize") {
        ptys.resize(msg.ptyId, msg.cols, msg.rows);
        return;
      }
      if (msg.type === "tmux_control") {
        const summary = ptys.getSummary(msg.ptyId);
        if (!summary || !summary.tmuxSession) return;
        void tmuxScrollHistory(summary.tmuxSession, msg.direction, msg.lines, summary.tmuxServer).catch(() => {
          // ignore best-effort tmux history control
        });
        return;
      }
      if (msg.type === "tmux_search") {
        const summary = ptys.getSummary(msg.ptyId);
        if (!summary || !summary.tmuxSession) return;
        void tmuxSearchHistory(summary.tmuxSession, msg.direction, msg.query, summary.tmuxServer).catch(() => {
          // ignore best-effort tmux history search
        });
        return;
      }
      if (msg.type === "mobile_snapshot_request") {
        const summary = ptys.getSummary(msg.ptyId);
        if (!summary) {
          send(ws, {
            type: "mobile_snapshot_response",
            requestId: msg.requestId,
            ptyId: msg.ptyId,
            ok: false,
            error: "PTY is not an active tmux session",
          });
          return;
        }
        const capture = tmuxCaptureTarget(summary);
        if (!capture) {
          send(ws, {
            type: "mobile_snapshot_response",
            requestId: msg.requestId,
            ptyId: msg.ptyId,
            ok: false,
            error: "PTY is not an active tmux session",
          });
          return;
        }
        void tmuxCapturePaneVisible(capture.target, capture.server, msg.lines)
          .then((snapshot) => {
            if (ws.readyState !== ws.OPEN) return;
            const text = snapshot ?? "";
            const lineCount = text ? text.split("\n").length : 0;
            send(ws, {
              type: "mobile_snapshot_response",
              requestId: msg.requestId,
              ptyId: msg.ptyId,
              ok: true,
              capturedAt: Date.now(),
              lineCount,
              truncated: lineCount >= msg.lines,
              text,
            });
          })
          .catch(() => {
            if (ws.readyState !== ws.OPEN) return;
            send(ws, {
              type: "mobile_snapshot_response",
              requestId: msg.requestId,
              ptyId: msg.ptyId,
              ok: false,
              error: "Failed to capture tmux snapshot",
            });
          });
        return;
      }
    });
  });

  fastify.server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      if (!isWsOriginAllowed(req.headers.origin)) {
        socket.destroy();
        return;
      }
      if (AUTH_ENABLED) {
        const headerToken = parseTokenFromHeaders(req.headers as unknown as Record<string, unknown>);
        const urlToken = parseTokenFromUrl(req.url);
        if (!isTokenValid(headerToken, urlToken)) {
          socket.destroy();
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  });
}
