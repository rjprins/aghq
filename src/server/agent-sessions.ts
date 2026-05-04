import path from "node:path";
import type { AgentProvider, AgentSessionCwdSource, AgentSessionSummary, PtySummary } from "../types.js";
import type { AgentSessionNameSource, AgentSessionRecord, SqliteStore } from "../persist/sqlite.js";
import type { LogSessionDiscovery } from "../logSessions.js";
import { projectRootFromCwdAny, worktreeFromCwdAny } from "../worktree.js";

type AgentSessionServiceDeps = {
  store: SqliteStore;
  logSessionDiscovery: LogSessionDiscovery;
  repoRoot: string;
};

const CWD_SOURCE_PRIORITY: Record<AgentSessionCwdSource, number> = {
  log: 1,
  db: 2,
  runtime: 3,
  user: 4,
};

export function normalizeAgentProvider(value: string | null | undefined): AgentProvider | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "claude" || v === "codex" || v === "pi") return v;
  return null;
}

export function resumeArgsForProvider(provider: AgentProvider, providerSessionId: string): string[] {
  return provider === "claude" ? ["--resume", providerSessionId] : ["resume", providerSessionId];
}

export function defaultAgentSessionName(provider: AgentProvider, providerSessionId: string, cwd: string | null): string {
  const leaf = cwd ? path.basename(cwd) : providerSessionId.slice(0, 8);
  return `${provider}:${leaf || providerSessionId.slice(0, 8) || "session"}`;
}

export function agentSessionPublicId(provider: AgentProvider, providerSessionId: string): string {
  return `agent:${provider}:${providerSessionId}`;
}

export type AgentSessionService = ReturnType<typeof createAgentSessionService>;

type ResolvedAgentSessionSummary = AgentSessionSummary & { nameSource: AgentSessionNameSource };

export function createAgentSessionService(deps: AgentSessionServiceDeps) {
  const { store, logSessionDiscovery } = deps;
  const agentSessionRefByPty = new Map<string, { provider: AgentProvider; providerSessionId: string }>();

  function serverWorktreeFromCwd(cwd: string | null): string | null {
    return worktreeFromCwdAny(cwd);
  }

  function serverProjectRootFromCwd(cwd: string | null): string | null {
    return projectRootFromCwdAny(cwd);
  }

  function nameSourcePriority(source: AgentSessionNameSource): number {
    if (source === "user") return 3;
    if (source === "provider") return 2;
    return 1;
  }

  function mergeAgentSessions(base: ResolvedAgentSessionSummary, next: ResolvedAgentSessionSummary): ResolvedAgentSessionSummary {
    const chooseCwd =
      next.cwd != null &&
      (base.cwd == null ||
        CWD_SOURCE_PRIORITY[next.cwdSource] > CWD_SOURCE_PRIORITY[base.cwdSource] ||
        (CWD_SOURCE_PRIORITY[next.cwdSource] === CWD_SOURCE_PRIORITY[base.cwdSource] &&
          next.lastSeenAt > base.lastSeenAt));

    const cwd = chooseCwd ? next.cwd : base.cwd;
    const cwdSource = chooseCwd ? next.cwdSource : base.cwdSource;
    const nextNameWins =
      nameSourcePriority(next.nameSource) > nameSourcePriority(base.nameSource) ||
      (nameSourcePriority(next.nameSource) === nameSourcePriority(base.nameSource) &&
        next.lastSeenAt >= base.lastSeenAt);
    const chosenName = nextNameWins ? next : base;
    const newer = next.lastSeenAt >= base.lastSeenAt ? next : base;

    return {
      id: agentSessionPublicId(base.provider, base.providerSessionId),
      provider: base.provider,
      providerSessionId: base.providerSessionId,
      name: chosenName.name,
      nameSource: chosenName.nameSource,
      command: newer.command,
      args: newer.args,
      cwd,
      cwdSource,
      projectRoot: serverProjectRootFromCwd(cwd),
      worktree: serverWorktreeFromCwd(cwd),
      createdAt: Math.min(base.createdAt, next.createdAt),
      lastSeenAt: Math.max(base.lastSeenAt, next.lastSeenAt),
      lastRestoredAt: Math.max(base.lastRestoredAt ?? 0, next.lastRestoredAt ?? 0) || null,
    };
  }

  function parseProviderSessionIdFromLog(summary: PtySummary): string | null {
    const parsed = summary.id.match(/^log:(?:claude|codex|pi):(.+)$/);
    if (parsed && parsed[1]?.trim()) return parsed[1].trim();
    const lastArg = summary.args.length > 0 ? summary.args[summary.args.length - 1] : "";
    const normalized = typeof lastArg === "string" ? lastArg.trim() : "";
    return normalized.length > 0 ? normalized : null;
  }

  function toAgentSessionFromLog(summary: PtySummary): ResolvedAgentSessionSummary | null {
    const fromId = /^log:(claude|codex|pi):/.exec(summary.id)?.[1] ?? null;
    const provider = normalizeAgentProvider(fromId ?? summary.command);
    if (!provider) return null;
    const providerSessionId = parseProviderSessionIdFromLog(summary);
    if (!providerSessionId) return null;
    const cwd = summary.cwd ?? null;
    return {
      id: agentSessionPublicId(provider, providerSessionId),
      provider,
      providerSessionId,
      name: summary.name || defaultAgentSessionName(provider, providerSessionId, cwd),
      nameSource: summary.nameSource === "provider" ? "provider" : "derived",
      command: provider,
      args: resumeArgsForProvider(provider, providerSessionId),
      cwd,
      cwdSource: "log",
      projectRoot: serverProjectRootFromCwd(cwd),
      worktree: serverWorktreeFromCwd(cwd),
      createdAt: summary.createdAt,
      lastSeenAt: summary.lastSeenAt ?? summary.createdAt,
      lastRestoredAt: null,
    };
  }

  function toAgentSessionFromRecord(record: AgentSessionRecord): ResolvedAgentSessionSummary | null {
    const provider = normalizeAgentProvider(record.provider);
    if (!provider) return null;
    const providerSessionId = record.providerSessionId.trim();
    if (!providerSessionId) return null;
    const cwd = record.cwd ?? null;
    const fallbackName = defaultAgentSessionName(provider, providerSessionId, cwd);
    return {
      id: agentSessionPublicId(provider, providerSessionId),
      provider,
      providerSessionId,
      name: record.name || fallbackName,
      nameSource: record.nameSource,
      command: record.command || provider,
      args: record.args.length > 0 ? record.args : resumeArgsForProvider(provider, providerSessionId),
      cwd,
      cwdSource: record.cwdSource,
      projectRoot: serverProjectRootFromCwd(cwd),
      worktree: serverWorktreeFromCwd(cwd),
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      lastRestoredAt: record.lastRestoredAt ?? null,
    };
  }

  function toAgentSessionFromLegacySessionRow(summary: PtySummary): ResolvedAgentSessionSummary | null {
    const fromId = /^log:(claude|codex|pi):/.exec(summary.id)?.[1] ?? null;
    const provider = normalizeAgentProvider(fromId ?? summary.command);
    if (!provider) return null;
    const providerSessionId = parseProviderSessionIdFromLog(summary);
    if (!providerSessionId) return null;
    const cwd = summary.cwd ?? null;
    return {
      id: agentSessionPublicId(provider, providerSessionId),
      provider,
      providerSessionId,
      name: summary.name || defaultAgentSessionName(provider, providerSessionId, cwd),
      nameSource: "derived",
      command: provider,
      args: resumeArgsForProvider(provider, providerSessionId),
      cwd,
      cwdSource: "db",
      projectRoot: serverProjectRootFromCwd(cwd),
      worktree: serverWorktreeFromCwd(cwd),
      createdAt: summary.createdAt,
      lastSeenAt: summary.lastSeenAt ?? summary.createdAt,
      lastRestoredAt: null,
    };
  }

  function toPublicAgentSession(summary: ResolvedAgentSessionSummary): AgentSessionSummary {
    const { nameSource: _nameSource, ...rest } = summary;
    return rest;
  }

  function upsertAgentSessionSummary(
    summary: AgentSessionSummary,
    nameSource: AgentSessionNameSource = "derived",
  ): void {
    store.upsertAgentSession({
      provider: summary.provider,
      providerSessionId: summary.providerSessionId,
      name: summary.name,
      nameSource,
      command: summary.command,
      args: summary.args,
      cwd: summary.cwd,
      cwdSource: summary.cwdSource,
      createdAt: summary.createdAt,
      lastSeenAt: summary.lastSeenAt,
      lastRestoredAt: summary.lastRestoredAt ?? null,
    });
  }

  async function listAgentSessions(): Promise<AgentSessionSummary[]> {
    const merged = new Map<string, ResolvedAgentSessionSummary>();
    const dbRows = store.listAgentSessions().map(toAgentSessionFromRecord).filter((x): x is ResolvedAgentSessionSummary => x != null);
    const legacyRows = store.listSessions(800).map(toAgentSessionFromLegacySessionRow).filter((x): x is ResolvedAgentSessionSummary => x != null);
    const discovered = (await logSessionDiscovery.list()).map(toAgentSessionFromLog).filter((x): x is ResolvedAgentSessionSummary => x != null);

    for (const session of [...dbRows, ...legacyRows, ...discovered]) {
      const key = `${session.provider}:${session.providerSessionId}`;
      const prev = merged.get(key);
      merged.set(key, prev ? mergeAgentSessions(prev, session) : session);
    }

    const sessions = [...merged.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
    for (const session of sessions) {
      upsertAgentSessionSummary(session, session.nameSource);
    }
    return sessions.map(toPublicAgentSession);
  }

  async function findAgentSessionSummary(provider: AgentProvider, providerSessionId: string): Promise<AgentSessionSummary | null> {
    const wantedKey = `${provider}:${providerSessionId}`;
    for (const session of await listAgentSessions()) {
      if (`${session.provider}:${session.providerSessionId}` === wantedKey) return session;
    }
    return null;
  }

  function persistRuntimeCwdForAgentPty(ptyId: string, cwd: string | null | undefined, ts: number): void {
    const ref = agentSessionRefByPty.get(ptyId);
    if (!ref) return;
    const persisted = store.getAgentSession(ref.provider, ref.providerSessionId);
    const normalizedCwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd.trim() : null;
    const effectiveCwd = normalizedCwd ?? persisted?.cwd ?? null;
    const merged: AgentSessionSummary = {
      id: agentSessionPublicId(ref.provider, ref.providerSessionId),
      provider: ref.provider,
      providerSessionId: ref.providerSessionId,
      name: persisted?.name ?? defaultAgentSessionName(ref.provider, ref.providerSessionId, effectiveCwd),
      command: persisted?.command ?? ref.provider,
      args: persisted?.args ?? resumeArgsForProvider(ref.provider, ref.providerSessionId),
      cwd: effectiveCwd,
      cwdSource: normalizedCwd ? "runtime" : (persisted?.cwdSource ?? "db"),
      projectRoot: serverProjectRootFromCwd(effectiveCwd),
      worktree: serverWorktreeFromCwd(effectiveCwd),
      createdAt: persisted?.createdAt ?? ts,
      lastSeenAt: ts,
      lastRestoredAt: persisted?.lastRestoredAt ?? null,
    };
    upsertAgentSessionSummary(merged, persisted?.nameSource ?? "derived");
  }

  function attachPtyToAgentSession(ptyId: string, provider: AgentProvider, providerSessionId: string): void {
    agentSessionRefByPty.set(ptyId, { provider, providerSessionId });
  }

  function attachedAgentSessionForPty(ptyId: string): { provider: AgentProvider; providerSessionId: string } | null {
    return agentSessionRefByPty.get(ptyId) ?? null;
  }

  function detachPty(ptyId: string): void {
    agentSessionRefByPty.delete(ptyId);
  }

  function renameAttachedSession(ptyId: string, name: string, ts = Date.now()): boolean {
    const ref = agentSessionRefByPty.get(ptyId);
    if (!ref) return false;
    const persisted = store.getAgentSession(ref.provider, ref.providerSessionId);
    const effectiveName = name.trim();
    if (!effectiveName) return false;
    upsertAgentSessionSummary({
      id: agentSessionPublicId(ref.provider, ref.providerSessionId),
      provider: ref.provider,
      providerSessionId: ref.providerSessionId,
      name: effectiveName,
      command: persisted?.command ?? ref.provider,
      args: persisted?.args ?? resumeArgsForProvider(ref.provider, ref.providerSessionId),
      cwd: persisted?.cwd ?? null,
      cwdSource: persisted?.cwdSource ?? "db",
      projectRoot: serverProjectRootFromCwd(persisted?.cwd ?? null),
      worktree: serverWorktreeFromCwd(persisted?.cwd ?? null),
      createdAt: persisted?.createdAt ?? ts,
      lastSeenAt: Math.max(persisted?.lastSeenAt ?? 0, ts),
      lastRestoredAt: persisted?.lastRestoredAt ?? null,
    }, "user");
    return true;
  }

  return {
    listAgentSessions,
    findAgentSessionSummary,
    upsertAgentSessionSummary,
    persistRuntimeCwdForAgentPty,
    attachPtyToAgentSession,
    attachedAgentSessionForPty,
    detachPty,
    renameAttachedSession,
  };
}
