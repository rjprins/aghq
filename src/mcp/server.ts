#!/usr/bin/env node
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import * as z from "zod/v4";

type JsonObject = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_AGMUX_PORT = 4821;

function baseUrl(): URL {
  const raw = process.env.AGMUX_API_BASE?.trim() || `http://127.0.0.1:${process.env.PORT || DEFAULT_AGMUX_PORT}`;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AGMUX_API_BASE must use http:// or https://");
  }
  return url;
}

function token(): string {
  return process.env.AGMUX_TOKEN?.trim() ?? "";
}

function withTokenHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const authToken = token();
  return authToken ? { ...headers, "x-agmux-token": authToken } : headers;
}

function pathUrl(path: string): URL {
  return new URL(path, baseUrl());
}

function wsUrl(): URL {
  const url = new URL("/ws", baseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const authToken = token();
  if (authToken) url.searchParams.set("token", authToken);
  return url;
}

async function requestJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(pathUrl(path), {
      ...init,
      signal: controller.signal,
      headers: withTokenHeaders({
        accept: "application/json",
        ...(init.body != null ? { "content-type": "application/json" } : {}),
      }),
    });
    const text = await res.text();
    let body: unknown = null;
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { text };
      }
    }
    if (!res.ok) {
      const message = typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : text || res.statusText;
      throw new Error(`agmux HTTP ${res.status}: ${message}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function asJsonToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as JsonObject,
  };
}

function sendWsMessage(message: JsonObject): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl(), { handshakeTimeout: REQUEST_TIMEOUT_MS });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out connecting to agmux websocket"));
    }, REQUEST_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify(message), (err) => {
        clearTimeout(timer);
        ws.close();
        if (err) {
          reject(err);
          return;
        }
        resolve({ ok: true });
      });
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function requestSnapshot(ptyId: string, lines: number): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const requestId = `mcp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ws = new WebSocket(wsUrl(), { handshakeTimeout: REQUEST_TIMEOUT_MS });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timed out waiting for agmux snapshot"));
    }, REQUEST_TIMEOUT_MS);

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "mobile_snapshot_request", requestId, ptyId, lines }));
    });
    ws.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8")) as unknown;
      } catch {
        return;
      }
      if (
        typeof parsed !== "object" ||
        !parsed ||
        (parsed as { type?: unknown }).type !== "mobile_snapshot_response" ||
        (parsed as { requestId?: unknown }).requestId !== requestId
      ) {
        return;
      }
      clearTimeout(timer);
      ws.close();
      resolve(parsed as JsonObject);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const server = new McpServer({
  name: "agmux",
  version: "1.0.0",
});

server.registerTool("list_ptys", {
  title: "List agmux PTYs",
  description: "List active and recent agmux terminal sessions, including PTY IDs needed by other tools.",
}, async () => asJsonToolResult(await requestJson("/api/ptys")));

server.registerTool("send_input", {
  title: "Send terminal input",
  description: "Write raw input to an agmux PTY. By default this submits the input with Enter.",
  inputSchema: {
    ptyId: z.string().min(1).describe("Target agmux PTY ID, for example pty_abc123."),
    data: z.string().max(64 * 1024).describe("Raw terminal input to write."),
    appendEnter: z.boolean().default(true).describe("Append carriage return if data does not already end with Enter."),
  },
}, async ({ ptyId, data, appendEnter }) => {
  if (appendEnter && !/[\r\n]$/.test(data)) {
    return asJsonToolResult(await sendWsMessage({ type: "mobile_submit", ptyId, body: data }));
  }
  return asJsonToolResult(await sendWsMessage({ type: "input", ptyId, data }));
});

server.registerTool("snapshot", {
  title: "Capture PTY snapshot",
  description: "Capture recent visible/history text from an agmux PTY.",
  inputSchema: {
    ptyId: z.string().min(1).describe("Target agmux PTY ID."),
    lines: z.number().int().min(1).max(20_000).default(200).describe("Number of lines to capture."),
  },
}, async ({ ptyId, lines }) => asJsonToolResult(await requestSnapshot(ptyId, lines)));

server.registerTool("spawn_shell", {
  title: "Spawn shell",
  description: "Create or attach a shell PTY in the agmux tmux session.",
}, async () => asJsonToolResult(await requestJson("/api/ptys/shell", { method: "POST" })));

server.registerTool("launch_agent", {
  title: "Launch agent",
  description: "Launch a shell, Codex, Claude, or another CLI agent in an existing or new worktree.",
  inputSchema: {
    agent: z.string().min(1).describe("Agent command, for example shell, codex, or claude."),
    worktree: z.string().min(1).describe("Existing worktree path, or __new__ to create one."),
    projectRoot: z.string().optional().describe("Project root used when creating a new worktree."),
    branch: z.string().optional().describe("Branch name when worktree is __new__."),
    baseBranch: z.string().optional().describe("Base branch when worktree is __new__."),
    name: z.string().optional().describe("Display name for the new session."),
    initialInput: z.string().optional().describe("First prompt sent to the agent on launch, e.g. a slash command to run."),
    flags: z.record(z.string(), z.union([z.string(), z.boolean()])).optional().describe("Agent CLI flags."),
  },
}, async (args) => {
  return asJsonToolResult(await requestJson("/api/ptys/launch", {
    method: "POST",
    body: JSON.stringify(args),
  }));
});

server.registerTool("attach_tmux", {
  title: "Attach tmux session",
  description: "Attach an existing tmux session through agmux.",
  inputSchema: {
    name: z.string().min(1).describe("tmux session/window target name."),
    server: z.enum(["agmux", "default"]).optional().describe("tmux server to search."),
  },
}, async (args) => {
  return asJsonToolResult(await requestJson("/api/ptys/attach-tmux", {
    method: "POST",
    body: JSON.stringify(args),
  }));
});

server.registerTool("kill_pty", {
  title: "Kill PTY",
  description: "Kill an agmux PTY and its tmux window when applicable.",
  inputSchema: {
    ptyId: z.string().min(1).describe("Target agmux PTY ID."),
  },
}, async ({ ptyId }) => {
  return asJsonToolResult(await requestJson(`/api/ptys/${encodeURIComponent(ptyId)}/kill`, { method: "POST" }));
});

server.registerTool("rename_pty", {
  title: "Rename PTY",
  description: "Rename an agmux PTY session.",
  inputSchema: {
    ptyId: z.string().min(1).describe("Target agmux PTY ID."),
    name: z.string().min(1).max(40).describe("New display name."),
  },
}, async ({ ptyId, name }) => {
  return asJsonToolResult(await requestJson(`/api/ptys/${encodeURIComponent(ptyId)}/name`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  }));
});

server.registerTool("open_branch_review", {
  title: "Open branch review in Emacs",
  description: "Open the worktree for an agmux PTY in Emacs branch-review using the agmux server host.",
  inputSchema: {
    ptyId: z.string().min(1).describe("Target running agmux PTY ID."),
  },
}, async ({ ptyId }) => {
  return asJsonToolResult(await requestJson(
    `/api/ptys/${encodeURIComponent(ptyId)}/open-branch-review`,
    { method: "POST" },
  ));
});

server.registerTool("list_agent_sessions", {
  title: "List agent sessions",
  description: "List discovered/restorable Claude, Codex, and Pi agent sessions.",
}, async () => asJsonToolResult(await requestJson("/api/agent-sessions")));

server.registerTool("restore_agent_session", {
  title: "Restore agent session",
  description: "Restore a discovered Claude, Codex, or Pi session into a new agmux PTY.",
  inputSchema: {
    provider: z.enum(["claude", "codex", "pi"]).describe("Agent provider."),
    sessionId: z.string().min(1).describe("Provider session ID."),
    cwd: z.string().optional().describe("Optional working directory override."),
  },
}, async ({ provider, sessionId, cwd }) => {
  return asJsonToolResult(await requestJson(
    `/api/agent-sessions/${encodeURIComponent(provider)}/${encodeURIComponent(sessionId)}/restore`,
    {
      method: "POST",
      body: cwd ? JSON.stringify({ cwd }) : JSON.stringify({}),
    },
  ));
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`agmux MCP server connected to ${baseUrl().toString()}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
