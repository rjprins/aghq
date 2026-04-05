import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { findRecentLogSessionByCwd } from "../../logSessions.js";
import type { SqliteStore } from "../../persist/sqlite.js";
import type { AgentProvider, PtySummary, SessionTaskRef } from "../../types.js";
import { buildAgentReadyEnvExports, isAgentReadyProvider } from "../agent-ready.js";
import {
  tmuxApplySessionUiOptions,
  tmuxCreateLinkedSession,
  tmuxCreateWindow,
  tmuxEnsureSession,
  tmuxHasAttachedLinkedViewSession,
  tmuxIsLinkedViewSession,
  tmuxKillWindow,
  tmuxListWindows,
  tmuxLocateSession,
  tmuxTargetSession,
  type TmuxServer,
} from "../../tmux.js";
import { parseJsonBody } from "../auth.js";
import {
  defaultAgentSessionName,
  resumeArgsForProvider,
  type AgentSessionService,
} from "../agent-sessions.js";

type PtyRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
  agentSessions: AgentSessionService;
  runtime: {
    ptys: { spawn: Function; list: Function; getSummary: Function; kill: Function; write: Function; resize: Function; updateName: Function };
    readinessEngine: { registerAgent: Function; markBusy: Function; markExited: Function; markReady: Function };
    listPtys: () => Promise<unknown>;
    broadcastPtyList: () => Promise<void>;
    trackLinkedSession: (ptyId: string, linkedSession: string, server: TmuxServer) => void;
    getReadinessTrace: (opts?: { ptyId?: string | null; limit?: number }) => Array<unknown>;
  };
  worktrees: {
    resolveProjectRoot: (raw: unknown) => Promise<string | null>;
    createWorktreeFromBase: (opts: { projectRoot?: string | null; branch: string; baseBranch?: string }) => Promise<string>;
    directoryExists: (path: string) => Promise<boolean>;
    isKnownWorktreePath: (path: string) => boolean;
  };
  defaultBaseBranch: string;
  agmuxSession: string;
};

export const FLAG_DEFAULTS: Record<string, Record<string, string>> = {
  claude: { "--permission-mode": "default" },
  codex: { "--ask-for-approval": "untrusted", "--sandbox": "read-only" },
};

export function agentCommand(agent: string, flags: Record<string, string | boolean>): string {
  const defaults = FLAG_DEFAULTS[agent] ?? {};

  // Codex: --full-auto and --dangerously-bypass-approvals-and-sandbox both make
  // --ask-for-approval and --sandbox meaningless. Strip the conflicting flags so
  // the generated command is not self-contradictory.
  const suppressedFlags = new Set<string>();
  if (agent === "codex") {
    if (flags["--full-auto"] === true || flags["--dangerously-bypass-approvals-and-sandbox"] === true) {
      suppressedFlags.add("--ask-for-approval");
      suppressedFlags.add("--sandbox");
    }
  }

  const parts = [agent];
  for (const [flag, value] of Object.entries(flags)) {
    if (suppressedFlags.has(flag)) continue;
    if (typeof value === "boolean") {
      if (value) parts.push(flag);
    } else if (typeof value === "string" && value && value !== defaults[flag]) {
      parts.push(`${flag} ${value}`);
    }
  }
  return parts.join(" ");
}

export function registerPtyRoutes(deps: PtyRoutesDeps): void {
  const { fastify, store, agentSessions, runtime, worktrees, defaultBaseBranch, agmuxSession } = deps;
  const CODEX_ATTACH_POLL_MS = 750;
  const CODEX_ATTACH_TIMEOUT_MS = 30_000;

  function attachLiveAgentSession(
    ptyId: string,
    provider: AgentProvider,
    providerSessionId: string,
    cwd: string,
    createdAt: number,
    name?: string | null,
    cwdSource: "log" | "user" = "user",
  ): void {
    agentSessions.attachPtyToAgentSession(ptyId, provider, providerSessionId);
    agentSessions.upsertAgentSessionSummary({
      id: `agent:${provider}:${providerSessionId}`,
      provider,
      providerSessionId,
      name: name?.trim() || defaultAgentSessionName(provider, providerSessionId, cwd),
      command: provider,
      args: resumeArgsForProvider(provider, providerSessionId),
      cwd,
      cwdSource,
      projectRoot: null,
      worktree: null,
      createdAt,
      lastSeenAt: createdAt,
      lastRestoredAt: null,
    });
  }

  function scheduleCodexSessionAttach(ptyId: string, cwd: string, launchedAt: number): void {
    const startedAt = Date.now();
    const attempt = (): void => {
      const summary = runtime.ptys.getSummary(ptyId) as { status?: string } | null;
      if (!summary || summary.status !== "running") return;

      const match = findRecentLogSessionByCwd("codex", cwd, launchedAt);
      if (match) {
        attachLiveAgentSession(
          ptyId,
          "codex",
          match.sessionId,
          match.cwd ?? cwd,
          match.createdAt || launchedAt,
          match.prompt ?? null,
          "log",
        );
        void runtime.broadcastPtyList();
        return;
      }

      if ((Date.now() - startedAt) >= CODEX_ATTACH_TIMEOUT_MS) return;
      setTimeout(attempt, CODEX_ATTACH_POLL_MS);
    };

    setTimeout(attempt, CODEX_ATTACH_POLL_MS);
  }

  async function parseTaskRef(raw: unknown): Promise<{ taskRef: SessionTaskRef; worktreePath: string | null }> {
    if (typeof raw !== "object" || !raw || Array.isArray(raw)) {
      throw new Error("taskRef must be an object");
    }
    const record = raw as Record<string, unknown>;
    const projectRootRaw = typeof record.projectRoot === "string" ? record.projectRoot.trim() : "";
    const provider = typeof record.provider === "string" ? record.provider.trim() : "";
    const taskId = typeof record.taskId === "string" ? record.taskId.trim() : "";
    const worktreePathRaw = typeof record.worktreePath === "string" ? record.worktreePath.trim() : "";
    if (!projectRootRaw) throw new Error("taskRef.projectRoot is required");
    if (!provider) throw new Error("taskRef.provider is required");
    if (!taskId) throw new Error("taskRef.taskId is required");

    const projectRoot = path.resolve(projectRootRaw);
    if (!(await worktrees.directoryExists(projectRoot))) {
      throw new Error(`taskRef.projectRoot not found: ${projectRoot}`);
    }

    let worktreePath: string | null = null;
    if (worktreePathRaw) {
      worktreePath = path.resolve(worktreePathRaw);
      if (!(await worktrees.directoryExists(worktreePath))) {
        throw new Error(`taskRef.worktreePath not found: ${worktreePath}`);
      }
    }

    return {
      taskRef: {
        projectRoot,
        provider,
        taskId,
      },
      worktreePath,
    };
  }

  fastify.get("/api/ptys", async () => {
    return { ptys: await runtime.listPtys() };
  });

  fastify.get("/api/readiness/trace", async (req) => {
    const q = req.query as Record<string, unknown>;
    const ptyId = typeof q.ptyId === "string" && q.ptyId.trim().length > 0 ? q.ptyId.trim() : null;
    const parsedLimit = Number(q.limit);
    const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(2000, parsedLimit)) : 200;
    const events = runtime.getReadinessTrace({ ptyId, limit });
    return { events };
  });

  fastify.post("/api/readiness/report", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const state = body.state === "busy" ? "busy" : "ready";
    const reason = typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : (state === "ready" ? "callback:ready" : "callback:busy");
    const ptyId = typeof body.ptyId === "string" ? body.ptyId.trim() : "";
    const tmuxSession = typeof body.tmuxSession === "string" ? body.tmuxSession.trim() : "";

    if (!isAgentReadyProvider(provider)) {
      reply.code(400);
      return { error: "provider must be claude or codex" };
    }
    if (!ptyId && !tmuxSession) {
      reply.code(400);
      return { error: "ptyId or tmuxSession is required" };
    }

    const summaries = runtime.ptys.list() as Array<{
      id: string;
      status?: string;
      tmuxSession?: string | null;
    }>;
    const summary = (
      (ptyId ? runtime.ptys.getSummary(ptyId) : null) ??
      summaries.find((item) => item.status === "running" && item.tmuxSession === tmuxSession) ??
      null
    ) as { id: string; status?: string; tmuxSession?: string | null } | null;

    if (!summary || summary.status !== "running") {
      reply.code(404);
      return { error: "running PTY not found" };
    }

    runtime.readinessEngine.registerAgent(summary.id, provider);
    if (state === "ready") {
      runtime.readinessEngine.markReady(summary.id, provider, `callback:${provider}:${reason}`);
    } else {
      runtime.readinessEngine.markBusy(summary.id, `callback:${provider}:${reason}`, provider);
    }
    return { ok: true, id: summary.id };
  });

  fastify.post("/api/ptys/launch", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    const worktree = typeof body.worktree === "string" ? body.worktree.trim() : "";
    if (!agent) {
      reply.code(400);
      return { error: "agent is required" };
    }
    if (!worktree) {
      reply.code(400);
      return { error: "worktree is required" };
    }

    let launchTaskRef: { taskRef: SessionTaskRef; worktreePath: string | null } | null = null;
    if (body.taskRef != null) {
      try {
        launchTaskRef = await parseTaskRef(body.taskRef);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400);
        return { error: message };
      }
    }

    const projectRoot = await worktrees.resolveProjectRoot(body.projectRoot);
    if (body.projectRoot && !projectRoot) {
      reply.code(400);
      return { error: `project directory not found: ${body.projectRoot}` };
    }

    let cwd: string;
    if (worktree === "__new__") {
      const branch = typeof body.branch === "string" && body.branch.trim()
        ? body.branch.trim()
        : `wt-${Date.now()}`;
      const baseBranch = typeof body.baseBranch === "string" && body.baseBranch.trim().length > 0
        ? body.baseBranch.trim()
        : defaultBaseBranch;
      try {
        cwd = await worktrees.createWorktreeFromBase({ projectRoot, branch, baseBranch });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.code(400);
        return { error: message };
      }
    } else {
      if (!(await worktrees.directoryExists(worktree))) {
        reply.code(400);
        return { error: "worktree path does not exist or is not a directory" };
      }
      cwd = path.resolve(worktree);
    }

    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    const SESSION_NAME = agmuxSession;
    const launchedAt = Date.now();
    try {
      await tmuxEnsureSession(SESSION_NAME, shell);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("shell must")) {
        reply.code(400);
        return { error: message };
      }
      throw err;
    }

    const tmuxTarget = await tmuxCreateWindow(SESSION_NAME, shell, cwd);
    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);

    const name = agent !== "shell" ? agent : `shell:${path.basename(shell)}`;
    const summary = runtime.ptys.spawn({
      name,
      backend: "tmux",
      tmuxSession: tmuxTarget,
      tmuxServer: "agmux",
      command: "tmux",
      args: attachArgs,
      cols: 120,
      rows: 30,
    });
    runtime.trackLinkedSession(summary.id, linkedSession, "agmux");
    store.upsertSession(summary);
    let launchProvider: AgentProvider | null = null;
    let launchProviderSessionId: string | null = null;
    if (agent === "claude") {
      launchProvider = "claude";
      launchProviderSessionId = randomUUID();
      attachLiveAgentSession(summary.id, launchProvider, launchProviderSessionId, cwd, launchedAt);
    }
    if (launchTaskRef) {
      store.assignTaskToSession({
        sessionId: summary.id,
        projectRoot: launchTaskRef.taskRef.projectRoot,
        provider: launchTaskRef.taskRef.provider,
        taskId: launchTaskRef.taskRef.taskId,
        worktreePath: launchTaskRef.worktreePath ?? (worktrees.isKnownWorktreePath(cwd) ? cwd : null),
        cwd,
      });
    }
    fastify.log.info({ ptyId: summary.id, agent, cwd, tmuxSession: tmuxTarget }, "launch: shell spawned");
    await runtime.broadcastPtyList();

    const shellExports = buildAgentReadyEnvExports(summary.id, summary.tmuxSession);
    if (agent !== "shell") {
      const flags = typeof body.flags === "object" && body.flags ? body.flags as Record<string, string | boolean> : {};
      if (isAgentReadyProvider(agent)) {
        runtime.readinessEngine.registerAgent(summary.id, agent);
        runtime.readinessEngine.markBusy(summary.id, "agent:launch", agent);
      }
      setTimeout(() => {
        const cmd = launchProvider === "claude" && launchProviderSessionId
          ? `${agentCommand(agent, flags)} --session-id ${launchProviderSessionId}`
          : agentCommand(agent, flags);
        runtime.ptys.write(summary.id, `${shellExports}; unset CLAUDECODE; ${cmd}\n`);
      }, 300);
      if (agent === "codex") {
        scheduleCodexSessionAttach(summary.id, cwd, launchedAt);
      }
    } else {
      setTimeout(() => {
        runtime.ptys.write(summary.id, `${shellExports}\n`);
      }, 300);
    }

    const agentFlags = typeof body.flags === "object" && body.flags ? body.flags : {};
    const prev = store.getPreference<{ agent?: string; flags?: Record<string, unknown> }>("launch") ?? {};
    const allFlags = { ...(prev.flags ?? {}), [agent]: agentFlags };
    store.setPreference("launch", { agent, flags: allFlags });

    return { id: summary.id };
  });

  fastify.post("/api/ptys/:id/task", async (req, reply) => {
    const id = (req.params as any).id as string;
    const summary = runtime.ptys.getSummary(id);
    if (!summary) {
      reply.code(404);
      return { error: "unknown PTY" };
    }

    const body = parseJsonBody(req.body);
    let parsedTaskRef: { taskRef: SessionTaskRef; worktreePath: string | null };
    try {
      parsedTaskRef = await parseTaskRef(body.taskRef);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { error: message };
    }

    const cwd = summary.cwd ?? null;
    const worktreePath = parsedTaskRef.worktreePath ?? (
      cwd && worktrees.isKnownWorktreePath(cwd) ? cwd : null
    );
    const assignment = store.assignTaskToSession({
      sessionId: id,
      projectRoot: parsedTaskRef.taskRef.projectRoot,
      provider: parsedTaskRef.taskRef.provider,
      taskId: parsedTaskRef.taskRef.taskId,
      worktreePath,
      cwd,
    });

    await runtime.broadcastPtyList();
    return { ok: true, assignment };
  });

  fastify.delete("/api/ptys/:id/task", async (req, reply) => {
    const id = (req.params as any).id as string;
    const summary = runtime.ptys.getSummary(id);
    if (!summary) {
      reply.code(404);
      return { error: "unknown PTY" };
    }
    store.clearTaskAssignment(id);
    await runtime.broadcastPtyList();
    return { ok: true };
  });

  fastify.post("/api/ptys/shell", async (_req, reply) => {
    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    try {
      await tmuxEnsureSession(agmuxSession, shell);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("shell must")) {
        reply.code(400);
        return { error: message };
      }
      throw err;
    }

    const windows = await tmuxListWindows(agmuxSession);
    const attachedTargets = new Set(
      runtime.ptys
        .list()
        .filter((p: any) => p.tmuxSession && p.tmuxServer !== "default")
        .map((p: any) => p.tmuxSession),
    );
    let tmuxTarget: string | null = null;
    for (const w of windows) {
      if (!attachedTargets.has(w.target)) {
        tmuxTarget = w.target;
        break;
      }
    }
    if (!tmuxTarget) {
      tmuxTarget = await tmuxCreateWindow(agmuxSession, shell);
    }
    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);
    const name = `shell:${path.basename(shell)}`;
    const summary = runtime.ptys.spawn({
      name,
      backend: "tmux",
      tmuxSession: tmuxTarget,
      tmuxServer: "agmux",
      command: "tmux",
      args: attachArgs,
      cols: 120,
      rows: 30,
    });
    runtime.trackLinkedSession(summary.id, linkedSession, "agmux");
    store.upsertSession(summary);
    fastify.log.info({ ptyId: summary.id, shell, tmuxSession: tmuxTarget }, "shell spawned");
    await runtime.broadcastPtyList();
    setTimeout(() => {
      runtime.ptys.write(summary.id, `${buildAgentReadyEnvExports(summary.id, summary.tmuxSession)}\n`);
    }, 300);
    return { id: summary.id };
  });

  fastify.post("/api/ptys/attach-tmux", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const requestedServer = body.server;
    if (!name) {
      reply.code(400);
      return { error: "name is required" };
    }
    if (requestedServer != null && requestedServer !== "agmux" && requestedServer !== "default") {
      reply.code(400);
      return { error: "server must be agmux or default" };
    }

    const preferredServer: TmuxServer | undefined = requestedServer === "agmux" || requestedServer === "default"
      ? requestedServer
      : undefined;
    const located = await tmuxLocateSession(name, preferredServer);
    if (!located) {
      reply.code(404);
      return { error: "tmux session not found" };
    }
    if (requestedServer != null && requestedServer !== located) {
      reply.code(409);
      return { error: `tmux session exists on ${located}, not ${requestedServer}` };
    }
    if (tmuxIsLinkedViewSession(name)) {
      reply.code(400);
      return { error: "linked tmux view sessions cannot be attached directly" };
    }
    const server: TmuxServer = located;
    const running = runtime.ptys.list() as Array<{
      id: string;
      status?: string;
      tmuxSession?: string | null;
      tmuxServer?: TmuxServer | null;
    }>;
    const existing = running.find(
      (p) => p.status === "running" && p.tmuxSession === name && p.tmuxServer === server,
    );
    if (existing) {
      return { id: existing.id, reused: true };
    }
    const baseSession = tmuxTargetSession(name);
    const existingForBase = running.find(
      (p) =>
        p.status === "running" &&
        p.tmuxServer === server &&
        p.tmuxSession &&
        tmuxTargetSession(p.tmuxSession) === baseSession,
    );
    if (existingForBase) {
      return { id: existingForBase.id, reused: true };
    }
    if (await tmuxHasAttachedLinkedViewSession(baseSession, server)) {
      reply.code(409);
      return { error: "tmux session is already attached by another agmux server" };
    }
    try {
      await tmuxApplySessionUiOptions(name, server);
    } catch {
      // Ignore best-effort option sync; attach can continue.
    }

    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(name, server);
    const summary = runtime.ptys.spawn({
      name: `tmux:${name}`,
      backend: "tmux",
      tmuxSession: name,
      tmuxServer: server,
      command: "tmux",
      args: attachArgs,
      cols: 120,
      rows: 30,
    });
    runtime.trackLinkedSession(summary.id, linkedSession, server);
    store.upsertSession(summary);
    await runtime.broadcastPtyList();
    return { id: summary.id };
  });

  fastify.post("/api/ptys/:id/kill", async (req, reply) => {
    const id = (req.params as any).id as string;
    const summary = runtime.ptys.getSummary(id);
    if (!summary) {
      reply.code(404);
      return { error: "unknown PTY" };
    }
    if (summary.tmuxSession) {
      try {
        await tmuxKillWindow(summary.tmuxSession, summary.tmuxServer);
      } catch {
        // If it's already gone, continue with local cleanup.
      }
    }
    runtime.ptys.kill(id);
    fastify.log.info({ ptyId: id }, "pty killed");

    const after = runtime.ptys.getSummary(id) ?? summary;
    after.status = "exited";
    after.exitCode = after.exitCode ?? null;
    after.exitSignal = after.exitSignal ?? null;
    store.upsertSession(after);
    runtime.readinessEngine.markExited(id);
    await runtime.broadcastPtyList();
    return { ok: true };
  });

  fastify.put("/api/ptys/:id/name", async (req, reply) => {
    const id = (req.params as any).id as string;
    const body = parseJsonBody(req.body);
    const rawName = typeof body.name === "string" ? body.name.trim() : "";
    if (!rawName) {
      reply.code(400);
      return { error: "name is required" };
    }
    if (rawName.length > 40) {
      reply.code(400);
      return { error: "name must be 40 characters or fewer" };
    }

    const updated = runtime.ptys.updateName(id, rawName) as PtySummary | null;
    if (!updated) {
      reply.code(404);
      return { error: "unknown PTY" };
    }

    store.upsertSession(updated);
    agentSessions.renameAttachedSession(id, rawName);
    await runtime.broadcastPtyList();
    return { ok: true };
  });

  fastify.post("/api/ptys/:id/resume", async (req, reply) => {
    const id = (req.params as any).id as string;
    const live = runtime.ptys.getSummary(id);
    if (live?.status === "running") {
      return { id: live.id, reused: true };
    }
    reply.code(410);
    return {
      error:
        "runtime session resume is deprecated: tmux/runtime terminals reconnect automatically; use /api/agent-sessions/.../restore for Claude/Codex/Pi session restore",
    };
  });

  fastify.get("/api/input-history", async () => {
    return { history: store.loadAllInputHistory() };
  });

  fastify.put("/api/ptys/:id/input-history", async (req) => {
    const id = (req.params as any).id as string;
    const body = parseJsonBody(req.body);
    const history = Array.isArray(body.history) ? body.history : [];
    const lastInput = typeof body.lastInput === "string" ? body.lastInput : undefined;
    const processHint = typeof body.processHint === "string" ? body.processHint : undefined;
    const entries = history
      .filter((x: any) => x && typeof x.text === "string" && x.text.trim().length > 0)
      .map((x: any) => ({
        text: String(x.text),
        bufferLine: typeof x.bufferLine === "number" ? x.bufferLine : 0,
      }))
      .slice(-40);
    store.saveInputHistory(id, { lastInput, processHint, history: entries });
    return { ok: true };
  });
}
