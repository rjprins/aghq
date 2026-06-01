import type { PtyManager } from "../pty/manager.js";
import type { PtyReadinessIndicator, PtyReadinessState, PtySummary } from "../types.js";
import { tmuxCapturePaneVisible, tmuxPaneActiveProcessFromInspection, tmuxPaneInspect } from "../tmux.js";
import { inferPaneStatus, type PaneCacheState } from "./status-inference.js";

const READINESS_WORKING_GRACE_MS = Math.max(
  300,
  Number(process.env.AGMUX_WORKING_GRACE_MS ?? "4000") || 4000,
);
const READINESS_RECOMPUTE_DEBOUNCE_MS = Math.max(
  250,
  Number(process.env.AGMUX_READINESS_RECOMPUTE_DEBOUNCE_MS ?? "500") || 500,
);
const READINESS_LIST_REFRESH_STALE_MS = Math.max(
  2_000,
  Number(process.env.AGMUX_READINESS_LIST_REFRESH_STALE_MS ?? "10000") || 10_000,
);
const READINESS_POST_COMMAND_CHECK_MS = 800;
const READINESS_SHELL_QUIET_MS = 250;
const OUTPUT_BUFFER_LIMIT = 16_000;

export type AgentReadyProvider = "claude" | "codex";

export type PtyReadyEvent = {
  ptyId: string;
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  source: string;
  ts: number;
  cwd?: string | null;
  activeProcess?: string | null;
};

type ReadinessDeps = {
  ptys: Pick<PtyManager, "getSummary" | "getPid" | "updateCwd">;
  emitReadiness: (evt: PtyReadyEvent) => void;
};

type PtyReadyStateInternal = {
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  updatedAt: number;
  timer: NodeJS.Timeout | null;
  paneCache: PaneCacheState | undefined;
  outputBuffer: string;
  lastCwd: string | null;
  activeProcess: string | null;
  lastOutputAt: number;
  lastCommandAt: number | null;
  evaluatedAt: number | null;
  provider: AgentReadyProvider | null;
  explicitReadyReason: string | null;
  explicitReadyAt: number | null;
};

type ReadinessEvaluation = {
  state: PtyReadinessState;
  indicator: PtyReadinessIndicator;
  reason: string;
  nextCheckInMs: number | null;
  activeProcess: string | null;
  cwd: string | null;
};

export class ReadinessEngine {
  private readonly readinessByPty = new Map<string, PtyReadyStateInternal>();
  private readonly inputLineByPty = new Map<string, string>();
  private readonly postCommandTimers = new Map<string, NodeJS.Timeout>();
  private readonly recomputeInFlight = new Set<string>();
  private readonly recomputeAgainAfter = new Set<string>();

  constructor(private readonly deps: ReadinessDeps) {}

  registerAgent(ptyId: string, provider: AgentReadyProvider): void {
    const st = this.ensureReadiness(ptyId);
    if (st.provider === provider && st.activeProcess === provider) return;
    st.provider = provider;
    if (!st.activeProcess) st.activeProcess = provider;
  }

  markOutput(ptyId: string, chunk: string): void {
    const st = this.ensureReadiness(ptyId);
    st.outputBuffer = mergeOutputBuffer(st.outputBuffer, chunk);
    if (chunk) st.lastOutputAt = Date.now();
    this.scheduleReadinessRecompute(ptyId, READINESS_RECOMPUTE_DEBOUNCE_MS);
  }

  markInput(ptyId: string, data: string): void {
    const submittedCommand = this.updateInputLineBuffer(ptyId, data);
    if (submittedCommand) {
      const provider = inferAgentProviderFromCommand(submittedCommand);
      if (provider) this.registerAgent(ptyId, provider);

      const st = this.ensureReadiness(ptyId);
      st.lastCommandAt = Date.now();
      st.explicitReadyAt = null;
      st.explicitReadyReason = null;
      this.maybeUpdateCwdFromCommand(ptyId, submittedCommand);
      this.setPtyReadiness(ptyId, "busy", "input:command");
      this.scheduleReadinessRecompute(ptyId, READINESS_RECOMPUTE_DEBOUNCE_MS);
      this.schedulePostCommandCheck(ptyId);
      return;
    }
    this.scheduleReadinessRecompute(ptyId, READINESS_RECOMPUTE_DEBOUNCE_MS);
  }

  markReady(ptyId: string, provider: AgentReadyProvider, reason: string): void {
    this.registerAgent(ptyId, provider);
    const st = this.ensureReadiness(ptyId);
    st.explicitReadyAt = Date.now();
    st.explicitReadyReason = reason;
    st.activeProcess = provider;
    this.setPtyReadiness(ptyId, "ready", reason, true, "ready", undefined, provider);
  }

  markBusy(ptyId: string, reason: string, provider?: AgentReadyProvider | null): void {
    if (provider) this.registerAgent(ptyId, provider);
    const st = this.ensureReadiness(ptyId);
    st.explicitReadyAt = null;
    st.explicitReadyReason = null;
    if (provider) st.activeProcess = provider;
    this.setPtyReadiness(ptyId, "busy", reason, true, "busy", undefined, st.activeProcess);
  }

  markExited(ptyId: string): void {
    const st = this.ensureReadiness(ptyId);
    this.clearReadinessTimer(st);
    this.clearPostCommandTimer(ptyId);
    this.inputLineByPty.delete(ptyId);
    st.paneCache = undefined;
    st.outputBuffer = "";
    st.explicitReadyAt = null;
    st.explicitReadyReason = null;
    this.setPtyReadiness(ptyId, "busy", "exited");
  }

  /**
   * Enrich list responses from cached readiness only; stale tmux inspection is
   * refreshed in the background so /api/ptys does not block on every pane.
   */
  async withActiveProcesses(items: PtySummary[]): Promise<PtySummary[]> {
    const now = Date.now();
    return items.map((p, index) => {
      const st = this.ensureReadiness(p.id);
      if (p.status !== "running") {
        this.clearReadinessTimer(st);
        this.recomputeAgainAfter.delete(p.id);
        this.setPtyReadiness(p.id, "busy", "exited", false);
        return {
          ...p,
          activeProcess: p.activeProcess ?? st.activeProcess ?? null,
          ready: false,
          readyState: "busy",
          readyIndicator: "busy",
          readyReason: "exited",
        };
      }

      if (st.evaluatedAt == null) {
        void this.recomputeReadiness(p.id);
      } else if (now - st.evaluatedAt >= READINESS_LIST_REFRESH_STALE_MS && !st.timer && !this.recomputeInFlight.has(p.id)) {
        this.scheduleReadinessRecompute(p.id, Math.min(1_000, index * 75));
      }

      const cwd = st.lastCwd ?? p.cwd ?? null;
      const activeProcess = p.activeProcess ?? st.activeProcess ?? null;

      return {
        ...p,
        activeProcess,
        cwd,
        ready: st.state === "ready",
        readyState: st.state,
        readyIndicator: st.indicator,
        readyReason: st.reason,
        readyStateChangedAt: st.updatedAt,
      };
    });
  }

  private async evaluateReadiness(ptyId: string, summary: PtySummary): Promise<ReadinessEvaluation> {
    const st = this.ensureReadiness(ptyId);
    let activeProcess: string | null = summary.activeProcess ?? st.activeProcess ?? null;
    let cwd: string | null = summary.cwd ?? null;
    const now = Date.now();

    if (!summary.tmuxSession) {
      return this.applyExplicitReadyOverride(st, {
        state: "unknown",
        indicator: st.indicator,
        reason: "no-tmux-session",
        nextCheckInMs: null,
        activeProcess,
        cwd,
      });
    }

    const [paneInfo, paneContent] = await Promise.all([
      tmuxPaneInspect(summary.tmuxSession, summary.tmuxServer),
      tmuxCapturePaneVisible(summary.tmuxSession, summary.tmuxServer),
    ]);
    const proc = paneInfo
      ? await tmuxPaneActiveProcessFromInspection(summary.tmuxSession, paneInfo)
      : null;
    const liveCwd = paneInfo?.cwd ?? null;
    activeProcess = proc ?? activeProcess;
    if (liveCwd) {
      this.deps.ptys.updateCwd(ptyId, liveCwd);
      cwd = liveCwd;
    }

    if (paneContent == null) {
      const lastOutputAt = st.lastOutputAt ?? 0;
      const lastCommandAt = st.lastCommandAt ?? 0;
      const quietForMs = lastOutputAt > 0 ? now - lastOutputAt : Number.POSITIVE_INFINITY;
      const sinceCommandMs = lastCommandAt > 0 ? now - lastCommandAt : Number.POSITIVE_INFINITY;
      const isQuiet = activeProcess == null &&
        quietForMs >= READINESS_SHELL_QUIET_MS &&
        sinceCommandMs >= READINESS_POST_COMMAND_CHECK_MS;
      return this.applyExplicitReadyOverride(st, {
        state: isQuiet ? "ready" : "busy",
        indicator: isQuiet ? "ready" : "busy",
        reason: "tmux:capture-unavailable",
        nextCheckInMs: isQuiet ? null : 250,
        activeProcess,
        cwd,
      });
    }

    const inferred = inferPaneStatus({
      prev: st.paneCache,
      next: {
        content: paneContent,
        width: paneInfo?.width ?? 120,
        height: paneInfo?.height ?? 30,
      },
      now,
      workingGracePeriodMs: READINESS_WORKING_GRACE_MS,
    });
    st.paneCache = inferred.nextCache;
    let evaluation = this.mapInferred(inferred.status, inferred.nextCheckInMs, activeProcess, cwd, st.indicator);

    if (activeProcess == null && evaluation.state === "busy") {
      const lastCommandAt = st.lastCommandAt ?? 0;
      const lastOutputAt = st.lastOutputAt ?? 0;
      const quietForMs = lastOutputAt > 0 ? now - lastOutputAt : Number.POSITIVE_INFINITY;
      const sinceCommandMs = lastCommandAt > 0 ? now - lastCommandAt : Number.POSITIVE_INFINITY;
      if (quietForMs >= READINESS_SHELL_QUIET_MS && sinceCommandMs >= READINESS_POST_COMMAND_CHECK_MS) {
        evaluation = {
          state: "ready",
          indicator: "ready",
          reason: "input:quiet",
          nextCheckInMs: null,
          activeProcess,
          cwd,
        };
      }
    }

    return this.applyExplicitReadyOverride(st, evaluation);
  }

  markCwd(ptyId: string, cwd: string): void {
    this.deps.ptys.updateCwd(ptyId, cwd);
    const st = this.ensureReadiness(ptyId);
    this.setPtyReadiness(ptyId, st.state, st.reason, true, st.indicator, cwd, st.activeProcess);
  }

  private applyExplicitReadyOverride(
    st: PtyReadyStateInternal,
    evaluation: ReadinessEvaluation,
  ): ReadinessEvaluation {
    if (
      st.explicitReadyAt != null &&
      (st.lastCommandAt == null || st.explicitReadyAt >= st.lastCommandAt) &&
      st.explicitReadyReason
    ) {
      return {
        state: "ready",
        indicator: "ready",
        reason: st.explicitReadyReason,
        nextCheckInMs: null,
        activeProcess: st.provider ?? evaluation.activeProcess,
        cwd: evaluation.cwd,
      };
    }
    return evaluation;
  }

  private mapInferred(
    status: "waiting" | "working" | "permission",
    nextCheckInMs: number | null,
    activeProcess: string | null,
    cwd: string | null,
    fallbackIndicator: PtyReadinessIndicator,
  ): ReadinessEvaluation {
    if (status === "working") {
      return {
        state: "busy",
        indicator: "busy",
        reason: "pane:working",
        nextCheckInMs,
        activeProcess,
        cwd,
      };
    }
    if (status === "permission") {
      return {
        state: "ready",
        indicator: "ready",
        reason: "pane:permission",
        nextCheckInMs,
        activeProcess,
        cwd,
      };
    }
    return {
      state: "ready",
      indicator: status === "waiting" ? "ready" : fallbackIndicator,
      reason: "pane:waiting",
      nextCheckInMs,
      activeProcess,
      cwd,
    };
  }

  private ensureReadiness(ptyId: string): PtyReadyStateInternal {
    let st = this.readinessByPty.get(ptyId);
    if (st) return st;
    st = {
      state: "unknown",
      indicator: "unknown",
      reason: "startup",
      updatedAt: Date.now(),
      timer: null,
      paneCache: undefined,
      outputBuffer: "",
      lastCwd: null,
      activeProcess: null,
      lastOutputAt: 0,
      lastCommandAt: null,
      evaluatedAt: null,
      provider: null,
      explicitReadyReason: null,
      explicitReadyAt: null,
    };
    this.readinessByPty.set(ptyId, st);
    return st;
  }

  private clearReadinessTimer(st: PtyReadyStateInternal): void {
    if (!st.timer) return;
    clearTimeout(st.timer);
    st.timer = null;
  }

  private updateInputLineBuffer(ptyId: string, data: string): string | null {
    const cleaned = data
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b./g, "");
    let line = this.inputLineByPty.get(ptyId) ?? "";
    let submitted: string | null = null;
    for (const ch of cleaned) {
      if (ch === "\r" || ch === "\n") {
        const trimmed = line.trim();
        if (trimmed.length > 0) submitted = trimmed;
        line = "";
        continue;
      }
      if (ch === "\u0008" || ch === "\u007f") {
        line = line.slice(0, -1);
        continue;
      }
      if (ch === "\u0015") {
        line = "";
        continue;
      }
      if (ch <= "\u001f" || ch === "\u007f") continue;
      line += ch;
      if (line.length > 2000) line = line.slice(-1000);
    }
    this.inputLineByPty.set(ptyId, line);
    return submitted;
  }

  private maybeUpdateCwdFromCommand(ptyId: string, command: string): void {
    const trimmed = command.trim();
    if (!trimmed) return;
    const m = /^cd\s+(.+)$/.exec(trimmed);
    if (!m) return;
    let target = (m[1] ?? "").trim();
    if (!target) return;
    if ((target.startsWith("\"") && target.endsWith("\"")) || (target.startsWith("'") && target.endsWith("'"))) {
      target = target.slice(1, -1).trim();
    }
    if (!target.startsWith("/")) return;
    this.deps.ptys.updateCwd(ptyId, target);
  }

  private setPtyReadiness(
    ptyId: string,
    state: PtyReadinessState,
    reason: string,
    emitEvent = true,
    indicatorOverride?: PtyReadinessIndicator,
    cwdOverride?: string | null,
    activeProcessOverride?: string | null,
  ): void {
    const st = this.ensureReadiness(ptyId);
    const indicator = state === "ready" ? "ready" : state === "busy" ? "busy" : (indicatorOverride ?? "unknown");
    const cwd = cwdOverride ?? this.deps.ptys.getSummary(ptyId)?.cwd ?? null;
    const activeProcess = activeProcessOverride ?? st.activeProcess;
    const cwdChanged = cwd !== st.lastCwd;
    if (
      st.state === state &&
      st.reason === reason &&
      st.indicator === indicator &&
      st.activeProcess === activeProcess &&
      !cwdChanged
    ) return;
    st.state = state;
    st.indicator = indicator;
    st.reason = reason;
    st.activeProcess = activeProcess;
    st.lastCwd = cwd;
    st.updatedAt = Date.now();
    if (!emitEvent) return;
    this.deps.emitReadiness({
      ptyId,
      state,
      indicator,
      reason,
      source: this.readinessSignalSource(reason),
      ts: st.updatedAt,
      cwd,
      activeProcess,
    });
  }

  private scheduleReadinessRecompute(ptyId: string, delayMs = READINESS_RECOMPUTE_DEBOUNCE_MS): void {
    const st = this.ensureReadiness(ptyId);
    this.clearReadinessTimer(st);
    st.timer = setTimeout(() => {
      st.timer = null;
      void this.recomputeReadiness(ptyId);
    }, Math.max(20, delayMs));
  }

  private schedulePostCommandCheck(ptyId: string): void {
    this.clearPostCommandTimer(ptyId);
    const timer = setTimeout(() => {
      this.postCommandTimers.delete(ptyId);
      void this.recomputeReadiness(ptyId);
    }, READINESS_POST_COMMAND_CHECK_MS);
    this.postCommandTimers.set(ptyId, timer);
  }

  private clearPostCommandTimer(ptyId: string): void {
    const timer = this.postCommandTimers.get(ptyId);
    if (!timer) return;
    clearTimeout(timer);
    this.postCommandTimers.delete(ptyId);
  }

  private async recomputeReadiness(ptyId: string): Promise<void> {
    if (this.recomputeInFlight.has(ptyId)) {
      this.recomputeAgainAfter.add(ptyId);
      return;
    }
    this.recomputeInFlight.add(ptyId);
    try {
      const summary = this.deps.ptys.getSummary(ptyId);
      if (!summary || summary.status !== "running") {
        const st = this.ensureReadiness(ptyId);
        st.evaluatedAt = Date.now();
        this.setPtyReadiness(ptyId, "busy", "exited");
        return;
      }

      const evaluation = await this.evaluateReadiness(ptyId, summary);
      const st = this.ensureReadiness(ptyId);
      st.evaluatedAt = Date.now();
      st.activeProcess = evaluation.activeProcess ?? st.activeProcess;
      this.setPtyReadiness(ptyId, evaluation.state, evaluation.reason, true, evaluation.indicator, evaluation.cwd, st.activeProcess);
      if (evaluation.nextCheckInMs != null) this.scheduleReadinessRecompute(ptyId, evaluation.nextCheckInMs);
    } catch {
      const st = this.ensureReadiness(ptyId);
      st.evaluatedAt = Date.now();
      this.setPtyReadiness(ptyId, "unknown", "inspection:error", true, "unknown");
    } finally {
      this.recomputeInFlight.delete(ptyId);
      if (this.recomputeAgainAfter.delete(ptyId)) {
        const summary = this.deps.ptys.getSummary(ptyId);
        if (summary?.status === "running") {
          this.scheduleReadinessRecompute(ptyId, READINESS_RECOMPUTE_DEBOUNCE_MS);
        }
      }
    }
  }

  private readinessSignalSource(reason: string): string {
    if (reason.startsWith("callback:")) return "agent-callback";
    if (reason.startsWith("pane:")) return "pane-inference";
    if (reason.startsWith("tmux:")) return "tmux-pane-inspection";
    if (reason.startsWith("input:")) return "input-event";
    if (reason === "exited") return "process-exit";
    return "status-engine";
  }
}

function mergeOutputBuffer(current: string, nextChunk: string): string {
  if (!nextChunk) return current;
  const merged = current + nextChunk;
  if (merged.length <= OUTPUT_BUFFER_LIMIT) return merged;
  return merged.slice(-OUTPUT_BUFFER_LIMIT);
}

function inferAgentProviderFromCommand(command: string): AgentReadyProvider | null {
  const parts = command
    .split(/[|;&]/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const provider = firstAgentToken(part);
    if (provider) return provider;
  }
  return null;
}

function firstAgentToken(command: string): AgentReadyProvider | null {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let i = 0;
  while (i < tokens.length) {
    const token = stripQuotes(tokens[i] ?? "");
    if (!token) {
      i += 1;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      i += 1;
      continue;
    }
    if (token === "env") {
      i += 1;
      continue;
    }
    if (token === "unset") {
      while (i + 1 < tokens.length) {
        const next = stripQuotes(tokens[i + 1] ?? "");
        if (!next || next.startsWith("-")) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    const base = token.split("/").filter(Boolean).at(-1)?.toLowerCase() ?? token.toLowerCase();
    if (base === "claude") return "claude";
    if (base === "codex") return "codex";
    return null;
  }
  return null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}
