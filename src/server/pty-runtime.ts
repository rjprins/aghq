import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { PtyManager } from "../pty/manager.js";
import { ReadinessEngine, type PtyReadyEvent } from "../readiness/engine.js";
import { TriggerEngine } from "../triggers/engine.js";
import { TriggerLoader } from "../triggers/loader.js";
import { WsHub } from "../ws/hub.js";
import type { AgentProvider, PrSummary, PtySummary, ServerToClientMessage } from "../types.js";
import type { SqliteStore } from "../persist/sqlite.js";
import { projectRootFromCwdAny, worktreeFromCwdAny } from "../worktree.js";
import {
  tmuxCaptureHistoryRegion,
  tmuxCreateLinkedSession,
  tmuxCreateWindow,
  tmuxKillSession,
  tmuxKillWindow,
  tmuxListWindows,
  tmuxPaneCurrentPath,
  tmuxPanePosition,
  tmuxPruneDetachedLinkedSessions,
  tmuxTargetSession,
  tmuxEnsureSession,
  type TmuxServer,
} from "../tmux.js";
import type { TriggerSpawnShellOptions } from "../triggers/types.js";
import { findActiveLogSessionByCwd, readConversationMessages } from "../logSessions.js";
import { historyNeedle, InputAnchorStore, locateInLines } from "./history-scroll.js";

export type RuntimeDeps = {
  store: SqliteStore;
  logger: FastifyBaseLogger;
  agentSessions: {
    persistRuntimeCwdForAgentPty: (ptyId: string, cwd: string | null | undefined, ts: number) => void;
    attachedAgentSessionForPty: (ptyId: string) => { provider: AgentProvider; providerSessionId: string } | null;
    attachDiscoveredSessionToPty: (
      ptyId: string,
      provider: AgentProvider,
      providerSessionId: string,
      opts: { cwd: string | null; name?: string | null; createdAt?: number | null },
    ) => void;
    detachPty: (ptyId: string) => void;
  };
  readinessTraceMax: number;
  readinessTraceLog: boolean;
  triggersPath: string;
  agmuxSession: string;
  refreshWorktrees: () => void;
};

type ReadinessTraceEntry = PtyReadyEvent & { seq: number };

export function createRuntime(deps: RuntimeDeps) {
  const { store, logger, agentSessions, readinessTraceMax, readinessTraceLog, triggersPath, agmuxSession, refreshWorktrees } = deps;
  const ptys = new PtyManager();
  const hub = new WsHub();
  const triggerEngine = new TriggerEngine();
  const triggerLoader = new TriggerLoader(triggersPath);

  const linkedSessionsByPty = new Map<string, { name: string; server: TmuxServer }>();

  // PR state keyed by `${projectRoot}\n${branch}`, populated by the Azure PR poller and
  // merged into PtySummary so sessions on a PR's branch carry its PR info.
  const prStateByKey = new Map<string, PrSummary>();
  const prKey = (projectRoot: string, branch: string): string => `${projectRoot}\n${branch}`;
  function setPrStateForBranch(projectRoot: string, branch: string, pr: PrSummary | null): void {
    const key = prKey(projectRoot, branch);
    if (pr) prStateByKey.set(key, pr);
    else prStateByKey.delete(key);
  }

  const readinessTrace: ReadinessTraceEntry[] = [];
  let readinessTraceSeq = 0;
  const cwdPollIntervalMs = Math.max(
    2_000,
    Number(process.env.AGMUX_CWD_POLL_INTERVAL_MS ?? "10000") || 10_000,
  );

  function recordReadinessTrace(evt: PtyReadyEvent): void {
    readinessTrace.push({ ...evt, seq: readinessTraceSeq++ });
    if (readinessTrace.length > readinessTraceMax) {
      readinessTrace.splice(0, readinessTrace.length - readinessTraceMax);
    }
    if (readinessTraceLog) {
      logger.info(
        {
          ptyId: evt.ptyId,
          state: evt.state,
          indicator: evt.indicator,
          reason: evt.reason,
          source: evt.source,
          ts: evt.ts,
        },
        "readiness decision",
      );
    }
  }

  function broadcast(evt: ServerToClientMessage): void {
    hub.broadcast(evt);
    if (evt.type === "trigger_fired") {
      store.insertEvent({
        sessionId: evt.ptyId,
        ts: evt.ts,
        type: evt.type,
        payload: evt,
      });
    }
  }

  const readinessEngine = new ReadinessEngine({
    ptys,
    emitReadiness: ({ ptyId, state, indicator, reason, ts, cwd, source, activeProcess }) => {
      agentSessions.persistRuntimeCwdForAgentPty(ptyId, cwd, ts);
      recordReadinessTrace({ ptyId, state, indicator, reason, source, ts, cwd, activeProcess });
      broadcast({ type: "pty_ready", ptyId, state, indicator, reason, ts, cwd, activeProcess });
    },
  });

  // Periodically refresh cwd from tmux in case readiness misses a fast cwd change.
  setInterval(() => {
    const running = ptys.list().filter((p) => p.status === "running" && p.tmuxSession);
    for (const p of running) {
      if (!p.tmuxSession) continue;
      void tmuxPaneCurrentPath(p.tmuxSession, p.tmuxServer)
        .then((cwd) => {
          if (!cwd || cwd === p.cwd) return;
          readinessEngine.markCwd(p.id, cwd);
        })
        .catch(() => {
          // ignore best-effort polling failures
        });
    }
  }, cwdPollIntervalMs);

  // Input anchors: on every submit (Enter written to a tmux pane), remember
  // the pane's absolute cursor line keyed by time. History-panel clicks use
  // these to scroll back to where a prompt was entered.
  const inputAnchors = new InputAnchorStore();
  const anchorSampledAt = new Map<string, number>();
  ptys.on("input", (ptyId: string, data: string) => {
    if (!data.includes("\r") && !data.includes("\n")) return;
    const summary = ptys.getSummary(ptyId);
    if (!summary?.tmuxSession || summary.status !== "running") return;
    const now = Date.now();
    if (now - (anchorSampledAt.get(ptyId) ?? 0) < 250) return;
    anchorSampledAt.set(ptyId, now);
    void tmuxPanePosition(summary.tmuxSession, summary.tmuxServer)
      .then((pos) => {
        if (pos) inputAnchors.record(ptyId, { ts: now, line: pos.historySize + pos.cursorY });
      })
      .catch(() => {
        // ignore best-effort anchor sampling failures
      });
  });

  // Auto-attach: link running agent processes to the JSONL session they are
  // appending to (matched by cwd + recent log activity). Covers agents
  // started by hand inside a shell and re-links attachments lost to a server
  // restart. Idle sessions attach on their next interaction, when their log
  // mtime bumps.
  const AGENT_PROCESSES = new Set<AgentProvider>(["claude", "codex", "pi"]);
  const autoAttachIntervalMs = Math.max(
    2_000,
    Number(process.env.AGMUX_AUTO_ATTACH_INTERVAL_MS ?? "10000") || 10_000,
  );
  // cwd + activity alone can misattach (another process of the same agent
  // writing to a log in the same cwd), so require content evidence: the
  // log's last user prompt must be visible in this pane's scrollback.
  async function paneShowsLastUserPrompt(
    tmuxSession: string,
    tmuxServer: TmuxServer | null | undefined,
    logPath: string,
  ): Promise<boolean> {
    const messages = readConversationMessages(logPath);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return false;
    const needle = historyNeedle(lastUser.text);
    if (!needle) return false;
    const pos = await tmuxPanePosition(tmuxSession, tmuxServer);
    if (!pos) return false;
    const bottom = pos.historySize + pos.paneHeight - 1;
    const start = Math.max(0, bottom - 2_000);
    const lines = await tmuxCaptureHistoryRegion(tmuxSession, pos.historySize, start, bottom, tmuxServer);
    if (!lines) return false;
    return locateInLines(lines, start, needle, null) != null;
  }

  async function autoAttachSweep(): Promise<void> {
    let changed = false;
    const summaries = await readinessEngine.withActiveProcesses(ptys.list());
    for (const p of summaries) {
      if (p.status !== "running" || !p.tmuxSession || !p.cwd) continue;
      if (agentSessions.attachedAgentSessionForPty(p.id)) continue;
      const proc = (p.activeProcess ?? "").toLowerCase() as AgentProvider;
      if (!AGENT_PROCESSES.has(proc)) continue;
      const match = findActiveLogSessionByCwd(proc, p.cwd);
      if (!match) continue;
      const verified = await paneShowsLastUserPrompt(p.tmuxSession, p.tmuxServer, match.logPath).catch(() => false);
      if (!verified) continue;
      agentSessions.attachDiscoveredSessionToPty(p.id, proc, match.sessionId, {
        cwd: match.cwd ?? p.cwd,
        name: match.prompt,
        createdAt: match.createdAt,
      });
      logger.info(
        { ptyId: p.id, provider: proc, providerSessionId: match.sessionId, logPath: match.logPath },
        "auto-attached agent session from log activity",
      );
      changed = true;
    }
    if (changed) await broadcastPtyList();
  }
  setInterval(() => {
    void autoAttachSweep().catch(() => {});
  }, autoAttachIntervalMs);

  async function listPtys(): Promise<PtySummary[]> {
    const base = await readinessEngine.withActiveProcesses(ptys.list());
    if (base.length === 0) return base;

    const assignments = store.listActiveTaskAssignments(base.map((p) => p.id));
    const bySessionId = new Map(assignments.map((a) => [a.sessionId, a]));

    return base.map((summary) => {
      const assignment = bySessionId.get(summary.id);
      const agentRef = agentSessions.attachedAgentSessionForPty(summary.id);
      const projectRoot = projectRootFromCwdAny(summary.cwd ?? null);
      const worktree = worktreeFromCwdAny(summary.cwd ?? null);
      const pr = projectRoot && worktree ? prStateByKey.get(prKey(projectRoot, worktree)) ?? null : null;
      const next = {
        ...summary,
        projectRoot,
        worktree,
        pr,
        ...(agentRef
          ? {
              agentProvider: agentRef.provider,
              agentProviderSessionId: agentRef.providerSessionId,
            }
          : {}),
      };
      if (!assignment) return next;
      return {
        ...next,
        task: {
          projectRoot: assignment.projectRoot,
          provider: assignment.provider,
          taskId: assignment.taskId,
          assignedAt: assignment.assignedAt,
          worktreePath: assignment.worktreePath,
          cwd: assignment.cwd,
        },
      };
    });
  }

  async function broadcastPtyList(): Promise<void> {
    broadcast({ type: "pty_list", ptys: await listPtys() });
  }

  function stripAlternateScreenSequences(s: string): string {
    return s
      .replaceAll("\x1b[?1049h", "")
      .replaceAll("\x1b[?1049l", "")
      .replaceAll("\x1b[?47h", "")
      .replaceAll("\x1b[?47l", "")
      .replaceAll("\x1b[?1047h", "")
      .replaceAll("\x1b[?1047l", "");
  }

  async function spawnTriggerShell(opts?: TriggerSpawnShellOptions): Promise<{
    ptyId: string;
    cwd: string | null;
    tmuxSession: string | null;
  }> {
    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    const rawCwd = typeof opts?.cwd === "string" ? opts.cwd.trim() : "";
    const cwd = rawCwd.length > 0 ? path.resolve(rawCwd) : undefined;
    await tmuxEnsureSession(agmuxSession, shell);
    const tmuxTarget = await tmuxCreateWindow(agmuxSession, shell, cwd);
    const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(tmuxTarget);
    const label = typeof opts?.name === "string" && opts.name.trim().length > 0
      ? opts.name.trim()
      : `shell:${path.basename(shell)}`;
    const summary = ptys.spawn({
      name: label,
      backend: "tmux",
      tmuxSession: tmuxTarget,
      tmuxServer: "agmux",
      command: "tmux",
      args: attachArgs,
      cols: 120,
      rows: 30,
    });
    linkedSessionsByPty.set(summary.id, { name: linkedSession, server: "agmux" });
    store.upsertSession(summary);
    logger.info({ ptyId: summary.id, tmuxSession: tmuxTarget, source: "trigger" }, "spawned shell from trigger hook");
    await broadcastPtyList();
    return { ptyId: summary.id, cwd: summary.cwd ?? null, tmuxSession: summary.tmuxSession ?? null };
  }

  // PTY events -> persistence + triggers + WS
  ptys.on("output", (ptyId: string, data: string) => {
    const out = stripAlternateScreenSequences(data);
    readinessEngine.markOutput(ptyId, out);

    hub.queuePtyOutput(ptyId, out);
    triggerEngine.onOutput(
      ptyId,
      out,
      (evt) => {
        const type = (evt as any)?.type;
        if (typeof type !== "string") return;
        if (type === "trigger_fired" || type === "pty_highlight") {
          broadcast(evt as any);
          return;
        }
        hub.broadcast(evt as any);
      },
      (id, d) => ptys.write(id, d),
      {
        writeTo: (id, d) => ptys.write(id, d),
        listPtys: () => ptys.list(),
        spawnShell: spawnTriggerShell,
      },
    );
  });

  ptys.on("exit", (ptyId: string, code: number | null, signal: string | null) => {
    const summary = ptys.getSummary(ptyId);
    if (summary) store.upsertSession(summary);
    store.clearTaskAssignment(ptyId);
    readinessEngine.markExited(ptyId);
    agentSessions.detachPty(ptyId);
    inputAnchors.clear(ptyId);
    anchorSampledAt.delete(ptyId);
    logger.info({ ptyId, code, signal }, "pty exited");
    broadcast({ type: "pty_exit", ptyId, code, signal });

    const linked = linkedSessionsByPty.get(ptyId);
    if (linked) {
      linkedSessionsByPty.delete(ptyId);
      tmuxKillSession(linked.name, linked.server).catch(() => {});
    }

    if (summary?.tmuxSession && summary.tmuxServer !== "default") {
      // Kill the tmux window when the PTY owned a specific window (window-level
      // target, e.g. "agmux:1"). Session-level targets (no ":") belong to
      // user-managed sessions and must not be destroyed here.
      if (summary.tmuxSession.includes(":")) {
        tmuxKillWindow(summary.tmuxSession, summary.tmuxServer ?? "agmux").catch(() => {});
      }
      void (async () => {
        await new Promise((r) => setTimeout(r, 250));
        await reconcileTmuxAttachments();
        await broadcastPtyList();
      })();
    }
  });

  let reconciling = false;

  async function reconcileTmuxAttachments(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      const windows = await tmuxListWindows(agmuxSession);
      const windowTargets = new Set(windows.map((w) => w.target));
      const persistedRunningByTarget = new Map<string, PtySummary>();
      for (const session of store.listSessions(1000)) {
        if (
          session.status !== "running" ||
          !session.tmuxSession ||
          session.tmuxServer === "default" ||
          tmuxTargetSession(session.tmuxSession) !== agmuxSession ||
          persistedRunningByTarget.has(session.tmuxSession)
        ) {
          continue;
        }
        persistedRunningByTarget.set(session.tmuxSession, session);
      }

      const runningByTarget = new Map<string, string>();
      // Track PTYs that target a whole session (no window specifier) — these
      // cover every window in that session and must not be duplicated.
      const sessionLevelPtyIds = new Set<string>();
      for (const p of ptys.list()) {
        if (
          p.status === "running" &&
          p.tmuxSession &&
          p.tmuxServer !== "default" &&
          tmuxTargetSession(p.tmuxSession) === agmuxSession
        ) {
          if (runningByTarget.has(p.tmuxSession)) {
            ptys.kill(p.id);
            logger.info({ ptyId: p.id, tmuxSession: p.tmuxSession }, "killed duplicate PTY for same window");
            continue;
          }
          runningByTarget.set(p.tmuxSession, p.id);
          if (!p.tmuxSession.includes(":")) {
            sessionLevelPtyIds.add(p.id);
          }
        }
      }

      const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
      for (const w of windows) {
        if (!runningByTarget.has(w.target) && !runningByTarget.has(agmuxSession)) {
          const persisted = persistedRunningByTarget.get(w.target);
          const { linkedSession, attachArgs } = await tmuxCreateLinkedSession(w.target);
          const summary = ptys.spawn({
            id: persisted?.id,
            name: persisted?.name ?? `shell:${path.basename(shell)}`,
            backend: "tmux",
            tmuxSession: w.target,
            tmuxServer: "agmux",
            command: "tmux",
            args: attachArgs,
            cols: 120,
            rows: 30,
            cwd: persisted?.cwd ?? undefined,
            createdAt: persisted?.createdAt,
          });
          linkedSessionsByPty.set(summary.id, { name: linkedSession, server: "agmux" });
          store.upsertSession(summary);
          logger.info({ ptyId: summary.id, tmuxSession: w.target }, "reconcile: attached orphaned window");
        }
      }

      for (const [target, ptyId] of runningByTarget) {
        // Session-level PTYs (no window specifier) are not expected to match a
        // specific window target — skip them to avoid false kills.
        if (sessionLevelPtyIds.has(ptyId)) continue;
        if (!windowTargets.has(target)) {
          ptys.kill(ptyId);
          logger.info({ ptyId, tmuxSession: target }, "reconcile: killed PTY for missing window");
        }
      }
    } finally {
      reconciling = false;
    }
  }

  async function loadTriggersAndBroadcast(reason: string): Promise<void> {
    try {
      const { triggers, version } = await triggerLoader.load();
      triggerEngine.setTriggers(triggers);
      logger.info({ reason, version, count: triggers.length }, "Triggers loaded");
    } catch (err) {
      triggerEngine.setTriggers(triggerLoader.lastGoodTriggers());
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "Trigger reload failed");
      broadcast({
        type: "trigger_error",
        ptyId: "system",
        trigger: "reload",
        ts: Date.now(),
        message,
      });
    }
  }

  async function restoreAtStartup(): Promise<void> {
    refreshWorktrees();
    const shell = process.env.AGMUX_SHELL ?? process.env.SHELL ?? "bash";
    await tmuxEnsureSession(agmuxSession, shell);
    const pruned = await tmuxPruneDetachedLinkedSessions(agmuxSession);
    if (pruned.length > 0) {
      logger.info({ count: pruned.length }, "pruned stale linked tmux sessions");
    }
    await reconcileTmuxAttachments();
  }

  function trackLinkedSession(ptyId: string, linkedSession: string, server: TmuxServer): void {
    linkedSessionsByPty.set(ptyId, { name: linkedSession, server });
  }

  function getReadinessTrace(opts?: { ptyId?: string | null; limit?: number }): ReadinessTraceEntry[] {
    const limit = opts?.limit ?? 200;
    const filtered = opts?.ptyId ? readinessTrace.filter((evt) => evt.ptyId === opts.ptyId) : readinessTrace;
    return filtered.slice(-limit);
  }

  return {
    ptys,
    hub,
    readinessEngine,
    inputAnchors,
    triggerLoader,
    listPtys,
    broadcast,
    broadcastPtyList,
    loadTriggersAndBroadcast,
    restoreAtStartup,
    reconcileTmuxAttachments,
    trackLinkedSession,
    getReadinessTrace,
    setPrStateForBranch,
  };
}
