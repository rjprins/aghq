#!/usr/bin/env node
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import * as z from "zod/v4";

import type { WorktreeAnnotated, WorktreeOverlays, WorktreesFullResponse } from "../shared/worktrees.js";

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

const WORKTREE_LIST_CAP = 60;

function normalizeWorktreePath(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function fetchFullWorktrees(projectRoot?: string): Promise<WorktreesFullResponse> {
  const params = new URLSearchParams({ full: "1" });
  if (projectRoot) params.set("projectRoot", projectRoot);
  return requestJson(`/api/worktrees?${params.toString()}`) as Promise<WorktreesFullResponse>;
}

/** Only flags that carry signal; false/null overlays are noise for an agent caller. */
function compactOverlays(overlays: WorktreeOverlays): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(overlays)) {
    if (value === true || (typeof value === "number" && value > 0)) out[key] = value;
  }
  return out;
}

function compactWorktreeRow(row: WorktreeAnnotated): JsonObject {
  const { overlays, ...rest } = row;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  const flags = compactOverlays(overlays);
  if (Object.keys(flags).length > 0) out.overlays = flags;
  return out;
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
    purpose: z.string().optional().describe("One-line reason for this session/worktree, recorded with the worktree when one is created."),
    ticket: z.string().optional().describe("Ticket/issue ID to associate with the session/worktree."),
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

server.registerTool("open_magit", {
  title: "Open Magit in Emacs",
  description: "Open the worktree for an agmux PTY in Emacs Magit using the agmux server host.",
  inputSchema: {
    ptyId: z.string().min(1).describe("Target running agmux PTY ID."),
  },
}, async ({ ptyId }) => {
  return asJsonToolResult(await requestJson(
    `/api/ptys/${encodeURIComponent(ptyId)}/open-magit`,
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

server.registerTool("worktree_list", {
  title: "List worktrees",
  description: "List a repo's git worktrees with computed lifecycle state (active/open/merged/local-only/review/stale/...), reap class, and human-readable evidence. Use this before creating a worktree, before reaping, or to pick an existing worktree to resume work in.",
  inputSchema: {
    projectRoot: z.string().optional().describe("Absolute path of the repo (or any path inside it). Omit to use the agmux default project."),
    filter: z.string().optional().describe("Case-insensitive substring match over branch, label, ticket, PR title, and first prompt."),
  },
}, async ({ projectRoot, filter }) => {
  const full = await fetchFullWorktrees(projectRoot);
  let rows = full.worktrees;
  const needle = filter?.trim().toLowerCase();
  if (needle) {
    rows = rows.filter((w) =>
      [w.branch, w.label, w.ticketId, w.prTitle, w.firstPrompt]
        .some((v) => v != null && v.toLowerCase().includes(needle)));
  }
  const result: JsonObject = {
    repoRoot: full.repoRoot,
    defaultBranch: full.defaultBranch,
    scannedAt: full.scannedAt,
    worktrees: rows.slice(0, WORKTREE_LIST_CAP).map(compactWorktreeRow),
    orphanBranchCount: full.orphanBranches.length,
    tombstoneCount: full.tombstones.length,
  };
  if (rows.length > WORKTREE_LIST_CAP) {
    result.note = `${rows.length - WORKTREE_LIST_CAP} of ${rows.length} rows omitted; narrow with the filter parameter.`;
  }
  return asJsonToolResult(result);
});

server.registerTool("worktree_create", {
  title: "Create worktree",
  description: "Create a new git branch + worktree for a task. Use this instead of raw git commands so agmux records why the worktree exists. purpose is required and becomes the branch description.",
  inputSchema: {
    projectRoot: z.string().min(1).describe("Absolute path of the repo to create the worktree in."),
    branch: z.string().optional().describe("Branch name; a verb-noun name is generated when omitted."),
    baseBranch: z.string().optional().describe("Base branch to fork from; defaults to the repo's default branch."),
    purpose: z.string().min(1).describe("One-line reason this worktree exists (stored as the branch description)."),
    ticket: z.string().optional().describe("Ticket/issue ID to associate with the worktree."),
  },
}, async (args) => {
  return asJsonToolResult(await requestJson("/api/worktrees/create", {
    method: "POST",
    body: JSON.stringify(args),
  }));
});

server.registerTool("worktree_reap", {
  title: "Reap worktree",
  description: "Remove a finished worktree. With dryRun:true (the DEFAULT) this returns a proposal only — the row's state, reapClass, and evidence — and deletes nothing. Executing with dryRun:false is DESTRUCTIVE: it removes the worktree directory (uncommitted changes are salvaged to a tarball first) and may attic-tag and delete the branch. Always review the dry-run proposal before executing. Execution is refused when the worktree is not classified as reapable.",
  inputSchema: {
    path: z.string().min(1).describe("Absolute path of the worktree to reap."),
    dryRun: z.boolean().default(true).describe("true (default): return the reap proposal without deleting anything. false: actually reap."),
    salvage: z.boolean().optional().describe("Tarball uncommitted non-ignored changes before removal. The server forces this on when such dirt exists."),
    deleteBranch: z.enum(["auto", "never"]).optional().describe("auto (default): attic-tag then delete the branch when merge is proven. never: keep the branch."),
  },
}, async ({ path, dryRun, salvage, deleteBranch }) => {
  const wanted = normalizeWorktreePath(path);
  const full = await fetchFullWorktrees(path);
  const row = full.worktrees.find((w) => normalizeWorktreePath(w.path) === wanted);
  if (!row) {
    return asJsonToolResult({ ok: false, reason: `no worktree found at ${path} in repo ${full.repoRoot}` });
  }
  const proposal: JsonObject = {
    path: row.path,
    branch: row.branch,
    state: row.state,
    reapClass: row.reapClass,
    evidence: row.evidence,
    overlays: compactOverlays(row.overlays),
  };
  if (dryRun) {
    proposal.dryRun = true;
    proposal.note = row.reapClass === "reap-safe"
      ? "Safe to reap; call again with dryRun:false to execute."
      : row.reapClass === "reap-check"
        ? "Needs review: check the evidence and overlays, then execute with dryRun:false (dirt is salvaged automatically)."
        : "Not reapable; execution would be refused.";
    return asJsonToolResult(proposal);
  }
  if (row.reapClass == null) {
    return asJsonToolResult({
      ok: false,
      refused: true,
      reason: `worktree state is "${row.state}" with no reap class; refusing to reap`,
      ...proposal,
    });
  }
  if (!row.head) {
    return asJsonToolResult({ ok: false, refused: true, reason: "worktree has no resolvable HEAD; cannot form a safe reap request", ...proposal });
  }
  const body: JsonObject = { path: row.path, expectedHead: row.head, salvage, deleteBranch };
  if (row.statusHash) body.expectedStatusHash = row.statusHash;
  return asJsonToolResult(await requestJson("/api/worktrees/reap", {
    method: "POST",
    body: JSON.stringify(body),
  }));
});

server.registerTool("worktree_context", {
  title: "Worktree context",
  description: "Get historical context for a worktree path: agent sessions that ran there and any tombstone left by a past reap. Use this to understand what a worktree was for before resuming or reaping it, or to recover salvage info after a reap.",
  inputSchema: {
    path: z.string().min(1).describe("Absolute worktree path (a since-removed path also works)."),
  },
}, async ({ path }) => {
  return asJsonToolResult(await requestJson(`/api/worktrees/context?path=${encodeURIComponent(path)}`));
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
