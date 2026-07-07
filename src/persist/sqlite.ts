import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { AgentSessionCwdSource, PtySummary, SessionTaskAssignment, SessionTaskRef } from "../types.js";

export type AgentSessionNameSource = "derived" | "provider" | "user";

export type PersistedEvent = {
  sessionId: string;
  ts: number;
  type: string;
  payload: unknown;
};

export type InputHistoryEntry = {
  text: string;
  /** Epoch ms of the submit; 0 when unknown (e.g. rows persisted before ts existed). */
  ts: number;
};

export type InputMeta = {
  lastInput?: string;
  processHint?: string;
  history: InputHistoryEntry[];
};

export type AgentSessionRecord = {
  provider: string;
  providerSessionId: string;
  name: string;
  nameSource: AgentSessionNameSource;
  command: string;
  args: string[];
  cwd: string | null;
  cwdSource: AgentSessionCwdSource;
  createdAt: number;
  lastSeenAt: number;
  lastRestoredAt: number | null;
};

export type SessionTaskAssignmentRecord = SessionTaskAssignment & {
  sessionId: string;
  unassignedAt: number | null;
  active: boolean;
};

export type AssignTaskToSessionInput = SessionTaskRef & {
  sessionId: string;
  worktreePath?: string | null;
  cwd?: string | null;
  assignedAt?: number;
};

/** Raw `worktrees` row; columns stay snake_case, JSON columns stay as text. */
export type WorktreeRow = {
  id: number;
  repo_root: string;
  path: string;
  prior_paths: string | null;
  branch: string | null;
  label: string | null;
  ticket_id: string | null;
  first_prompt: string | null;
  pr_id: string | null;
  pr_title: string | null;
  origin: string | null;
  state: string;
  state_detail: string | null;
  first_seen_at: number;
  scanned_at: number | null;
  reaped_at: number | null;
  reap_evidence: string | null;
  salvage_path: string | null;
  attic_tag: string | null;
};

export type WorktreeObservationInput = {
  repoRoot: string;
  path: string;
  branch: string | null;
  state: string;
  stateDetail: unknown;
  scannedAt: number;
  origin?: string | null;
};

export type WorktreeMetaPatch = {
  label?: string | null;
  ticketId?: string | null;
  firstPrompt?: string | null;
  prId?: string | null;
  prTitle?: string | null;
};

export type WorktreePrProof = {
  prId: string;
  prTitle: string;
  prStatus: string;
  mergeSourceSha: string | null;
  prCompletedAt: number | null;
};

export type WorktreeTombstoneInput = {
  state: string;
  reapEvidence: string | null;
  salvagePath: string | null;
  atticTag: string | null;
};

export type WorktreeBackfillTombstoneInput = {
  repoRoot: string;
  path: string;
  branch: string | null;
  label?: string | null;
  firstPrompt?: string | null;
  reapEvidence: string | null;
  origin: "backfill";
  reapedAt: number;
};

export type AgentSessionContext = {
  sessionCount: number;
  earliestName: string | null;
  earliestCreatedAt: number | null;
  lastSeenAt: number | null;
};

// Single source for the worktrees select list (queried in several methods).
const WORKTREE_COLUMNS =
  "id, repo_root, path, prior_paths, branch, label, ticket_id, first_prompt, pr_id, pr_title, " +
  "origin, state, state_detail, first_seen_at, scanned_at, reaped_at, reap_evidence, salvage_path, attic_tag";

export class SqliteStore {
  private db: any;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists sessions (
        id text primary key,
        name text not null,
        backend text,
        tmux_session text,
        tmux_server text,
        command text not null,
        args_json text not null,
        cwd text,
        created_at integer not null,
        last_seen_at integer not null,
        status text not null,
        exit_code integer,
        exit_signal text
      );

      create table if not exists events (
        id integer primary key autoincrement,
        session_id text not null,
        ts integer not null,
        type text not null,
        payload_json text not null
      );

      create index if not exists idx_events_session_ts on events(session_id, ts);

      create table if not exists input_history (
        session_id text primary key,
        last_input text,
        process_hint text,
        history_json text not null default '[]',
        updated_at integer not null
      );

      create table if not exists preferences (
        key text primary key,
        value_json text not null,
        updated_at integer not null
      );

      create table if not exists agent_sessions (
        provider text not null,
        provider_session_id text not null,
        name text not null,
        name_source text not null default 'derived',
        command text not null,
        args_json text not null,
        cwd text,
        cwd_source text not null default 'log',
        created_at integer not null,
        last_seen_at integer not null,
        last_restored_at integer,
        primary key (provider, provider_session_id)
      );

      create index if not exists idx_agent_sessions_last_seen
        on agent_sessions(last_seen_at desc);

      create table if not exists session_task_assignments (
        id integer primary key autoincrement,
        session_id text not null,
        project_root text not null,
        task_provider text not null,
        task_id text not null,
        worktree_path text,
        cwd text,
        assigned_at integer not null,
        unassigned_at integer,
        active integer not null default 1
      );

      create index if not exists idx_session_task_assignments_session
        on session_task_assignments(session_id, active);

      create index if not exists idx_session_task_assignments_task
        on session_task_assignments(project_root, task_provider, task_id, active);

      create unique index if not exists idx_session_task_assignments_one_active_per_session
        on session_task_assignments(session_id)
        where active = 1;

      create table if not exists worktrees (
        id integer primary key autoincrement,
        repo_root text not null,
        path text not null,
        prior_paths text,
        branch text,
        label text,
        ticket_id text,
        first_prompt text,
        pr_id text,
        pr_title text,
        origin text,
        state text not null default 'unknown',
        state_detail text,
        first_seen_at integer not null,
        scanned_at integer,
        reaped_at integer,
        reap_evidence text,
        salvage_path text,
        attic_tag text
      );

      create unique index if not exists idx_worktrees_live
        on worktrees(repo_root, path)
        where reaped_at is null;

      create index if not exists idx_worktrees_state
        on worktrees(repo_root, state);

      create index if not exists idx_agent_sessions_cwd
        on agent_sessions(cwd);
    `);

    // Backwards-compatible column adds for existing DBs.
    const cols = this.db.prepare(`pragma table_info(sessions);`).all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has("backend")) {
      this.db.exec(`alter table sessions add column backend text;`);
    }
    if (!have.has("tmux_session")) {
      this.db.exec(`alter table sessions add column tmux_session text;`);
    }
    if (!have.has("tmux_server")) {
      this.db.exec(`alter table sessions add column tmux_server text;`);
    }
    if (!have.has("task_id")) {
      this.db.exec(`alter table sessions add column task_id text;`);
    }

    const agentCols = this.db.prepare(`pragma table_info(agent_sessions);`).all() as Array<{ name: string }>;
    const haveAgent = new Set(agentCols.map((c) => c.name));
    if (!haveAgent.has("name_source")) {
      this.db.exec(`alter table agent_sessions add column name_source text not null default 'derived';`);
    }
    if (!haveAgent.has("cwd_source")) {
      this.db.exec(`alter table agent_sessions add column cwd_source text not null default 'log';`);
    }
    if (!haveAgent.has("last_restored_at")) {
      this.db.exec(`alter table agent_sessions add column last_restored_at integer;`);
    }
  }

  upsertSession(summary: PtySummary): void {
    const stmt = this.db.prepare(`
      insert into sessions (
        id, name, backend, tmux_session, tmux_server, command, args_json, cwd, created_at, last_seen_at, status, exit_code, exit_signal
      ) values (
        @id, @name, @backend, @tmux_session, @tmux_server, @command, @args_json, @cwd, @created_at, @last_seen_at, @status, @exit_code, @exit_signal
      )
      on conflict(id) do update set
        name=excluded.name,
        backend=excluded.backend,
        tmux_session=excluded.tmux_session,
        tmux_server=excluded.tmux_server,
        command=excluded.command,
        args_json=excluded.args_json,
        cwd=excluded.cwd,
        last_seen_at=excluded.last_seen_at,
        status=excluded.status,
        exit_code=excluded.exit_code,
        exit_signal=excluded.exit_signal;
    `);

    stmt.run({
      id: summary.id,
      name: summary.name,
      backend: summary.backend ?? null,
      tmux_session: summary.tmuxSession ?? null,
      tmux_server: summary.tmuxServer ?? null,
      command: summary.command,
      args_json: JSON.stringify(summary.args),
      cwd: summary.cwd,
      created_at: summary.createdAt,
      last_seen_at: Date.now(),
      status: summary.status,
      exit_code: summary.exitCode ?? null,
      exit_signal: summary.exitSignal ?? null,
    });
  }

  insertEvent(evt: PersistedEvent): void {
    const stmt = this.db.prepare(`
      insert into events (session_id, ts, type, payload_json)
      values (@session_id, @ts, @type, @payload_json);
    `);
    stmt.run({
      session_id: evt.sessionId,
      ts: evt.ts,
      type: evt.type,
      payload_json: JSON.stringify(evt.payload ?? null),
    });
  }

  listSessions(limit = 200): PtySummary[] {
    const stmt = this.db.prepare(`
      select id, name, backend, tmux_session, tmux_server, command, args_json, cwd, created_at, last_seen_at, status, exit_code, exit_signal
      from sessions
      order by last_seen_at desc
      limit ?;
    `);
    const rows = stmt.all(limit) as Array<{
      id: string;
      name: string;
      backend: string | null;
      tmux_session: string | null;
      tmux_server: string | null;
      command: string;
      args_json: string;
      cwd: string | null;
      created_at: number;
      last_seen_at: number;
      status: string;
      exit_code: number | null;
      exit_signal: string | null;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      backend: "tmux" as const,
      tmuxSession: r.tmux_session,
      tmuxServer: r.tmux_server === "default" ? "default" : r.tmux_server === "agmux" ? "agmux" : null,
      command: r.command,
      args: this.parseArgsJson(r.args_json),
      cwd: r.cwd,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      status: r.status === "running" ? "running" : "exited",
      exitCode: r.exit_code,
      exitSignal: r.exit_signal,
    }));
  }

  saveInputHistory(sessionId: string, meta: InputMeta): void {
    const stmt = this.db.prepare(`
      insert into input_history (session_id, last_input, process_hint, history_json, updated_at)
      values (@session_id, @last_input, @process_hint, @history_json, @updated_at)
      on conflict(session_id) do update set
        last_input=excluded.last_input,
        process_hint=excluded.process_hint,
        history_json=excluded.history_json,
        updated_at=excluded.updated_at;
    `);
    stmt.run({
      session_id: sessionId,
      last_input: meta.lastInput ?? null,
      process_hint: meta.processHint ?? null,
      history_json: JSON.stringify(meta.history),
      updated_at: Date.now(),
    });
  }

  loadAllInputHistory(): Record<string, InputMeta> {
    const stmt = this.db.prepare(`
      select session_id, last_input, process_hint, history_json
      from input_history
      order by updated_at desc;
    `);
    const rows = stmt.all() as Array<{
      session_id: string;
      last_input: string | null;
      process_hint: string | null;
      history_json: string;
    }>;
    const result: Record<string, InputMeta> = {};
    for (const r of rows) {
      let history: InputHistoryEntry[] = [];
      try {
        const parsed = JSON.parse(r.history_json);
        if (Array.isArray(parsed)) {
          history = parsed
            .filter((x: any) => x && typeof x.text === "string" && x.text.trim().length > 0)
            .map((x: any) => ({ text: x.text, ts: typeof x.ts === "number" ? x.ts : 0 }));
        }
      } catch {
        // ignore
      }
      result[r.session_id] = {
        ...(r.last_input ? { lastInput: r.last_input } : {}),
        ...(r.process_hint ? { processHint: r.process_hint } : {}),
        history,
      };
    }
    return result;
  }

  deleteInputHistory(sessionId: string): void {
    this.db.prepare(`delete from input_history where session_id = ?;`).run(sessionId);
  }

  getPreference<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare(`select value_json from preferences where key = ?;`).get(key) as
      | { value_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return undefined;
    }
  }

  setPreference(key: string, value: unknown): void {
    this.db.prepare(`
      insert into preferences (key, value_json, updated_at)
      values (@key, @value_json, @updated_at)
      on conflict(key) do update set
        value_json=excluded.value_json,
        updated_at=excluded.updated_at;
    `).run({
      key,
      value_json: JSON.stringify(value),
      updated_at: Date.now(),
    });
  }

  assignTaskToSession(input: AssignTaskToSessionInput): SessionTaskAssignmentRecord {
    const now = input.assignedAt ?? Date.now();
    const worktreePath = input.worktreePath ?? null;
    const cwd = input.cwd ?? null;

    const tx = this.db.transaction(() => {
      this.db.prepare(`
        update session_task_assignments
        set active = 0, unassigned_at = @now
        where session_id = @session_id and active = 1;
      `).run({
        now,
        session_id: input.sessionId,
      });

      this.db.prepare(`
        insert into session_task_assignments (
          session_id, project_root, task_provider, task_id, worktree_path, cwd, assigned_at, active
        ) values (
          @session_id, @project_root, @task_provider, @task_id, @worktree_path, @cwd, @assigned_at, 1
        );
      `).run({
        session_id: input.sessionId,
        project_root: input.projectRoot,
        task_provider: input.provider,
        task_id: input.taskId,
        worktree_path: worktreePath,
        cwd,
        assigned_at: now,
      });

      this.db.prepare(`
        update sessions
        set task_id = @task_id
        where id = @session_id;
      `).run({
        session_id: input.sessionId,
        task_id: `${input.provider}:${input.taskId}`,
      });
    });

    tx();
    return {
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      provider: input.provider,
      taskId: input.taskId,
      worktreePath,
      cwd,
      assignedAt: now,
      unassignedAt: null,
      active: true,
    };
  }

  clearTaskAssignment(sessionId: string, unassignedAt = Date.now()): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        update session_task_assignments
        set active = 0, unassigned_at = @unassigned_at
        where session_id = @session_id and active = 1;
      `).run({
        session_id: sessionId,
        unassigned_at: unassignedAt,
      });

      this.db.prepare(`
        update sessions
        set task_id = null
        where id = @session_id;
      `).run({
        session_id: sessionId,
      });
    });

    tx();
  }

  getActiveTaskAssignment(sessionId: string): SessionTaskAssignmentRecord | null {
    const row = this.db.prepare(`
      select session_id, project_root, task_provider, task_id, worktree_path, cwd, assigned_at, unassigned_at, active
      from session_task_assignments
      where session_id = ? and active = 1
      order by assigned_at desc
      limit 1;
    `).get(sessionId) as
      | {
          session_id: string;
          project_root: string;
          task_provider: string;
          task_id: string;
          worktree_path: string | null;
          cwd: string | null;
          assigned_at: number;
          unassigned_at: number | null;
          active: number;
        }
      | undefined;

    if (!row) return null;
    return {
      sessionId: row.session_id,
      projectRoot: row.project_root,
      provider: row.task_provider,
      taskId: row.task_id,
      worktreePath: row.worktree_path,
      cwd: row.cwd,
      assignedAt: row.assigned_at,
      unassignedAt: row.unassigned_at,
      active: row.active === 1,
    };
  }

  listActiveTaskAssignments(sessionIds?: string[]): SessionTaskAssignmentRecord[] {
    if (Array.isArray(sessionIds) && sessionIds.length === 0) return [];

    const rows = Array.isArray(sessionIds)
      ? this.db.prepare(`
          select session_id, project_root, task_provider, task_id, worktree_path, cwd, assigned_at, unassigned_at, active
          from session_task_assignments
          where active = 1 and session_id in (${sessionIds.map(() => "?").join(",")})
          order by assigned_at desc;
        `).all(...sessionIds)
      : this.db.prepare(`
          select session_id, project_root, task_provider, task_id, worktree_path, cwd, assigned_at, unassigned_at, active
          from session_task_assignments
          where active = 1
          order by assigned_at desc;
        `).all();

    return (rows as Array<{
      session_id: string;
      project_root: string;
      task_provider: string;
      task_id: string;
      worktree_path: string | null;
      cwd: string | null;
      assigned_at: number;
      unassigned_at: number | null;
      active: number;
    }>).map((row) => ({
      sessionId: row.session_id,
      projectRoot: row.project_root,
      provider: row.task_provider,
      taskId: row.task_id,
      worktreePath: row.worktree_path,
      cwd: row.cwd,
      assignedAt: row.assigned_at,
      unassignedAt: row.unassigned_at,
      active: row.active === 1,
    }));
  }

  getAgentSession(provider: string, providerSessionId: string): AgentSessionRecord | null {
    const row = this.db.prepare(`
      select provider, provider_session_id, name, name_source, command, args_json, cwd, cwd_source, created_at, last_seen_at, last_restored_at
      from agent_sessions
      where provider = ? and provider_session_id = ?;
    `).get(provider, providerSessionId) as
      | {
          provider: string;
          provider_session_id: string;
          name: string;
          name_source: string | null;
          command: string;
          args_json: string;
          cwd: string | null;
          cwd_source: string | null;
          created_at: number;
          last_seen_at: number;
          last_restored_at: number | null;
        }
      | undefined;
    if (!row) return null;
    return {
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      name: row.name,
      nameSource: this.parseAgentNameSource(row.name_source),
      command: row.command,
      args: this.parseArgsJson(row.args_json),
      cwd: row.cwd,
      cwdSource: this.parseAgentCwdSource(row.cwd_source),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      lastRestoredAt: row.last_restored_at ?? null,
    };
  }

  listAgentSessions(limit = 500): AgentSessionRecord[] {
    const rows = this.db.prepare(`
      select provider, provider_session_id, name, name_source, command, args_json, cwd, cwd_source, created_at, last_seen_at, last_restored_at
      from agent_sessions
      order by last_seen_at desc
      limit ?;
    `).all(limit) as Array<{
      provider: string;
      provider_session_id: string;
      name: string;
      name_source: string | null;
      command: string;
      args_json: string;
      cwd: string | null;
      cwd_source: string | null;
      created_at: number;
      last_seen_at: number;
      last_restored_at: number | null;
    }>;

    return rows.map((row) => ({
      provider: row.provider,
      providerSessionId: row.provider_session_id,
      name: row.name,
      nameSource: this.parseAgentNameSource(row.name_source),
      command: row.command,
      args: this.parseArgsJson(row.args_json),
      cwd: row.cwd,
      cwdSource: this.parseAgentCwdSource(row.cwd_source),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      lastRestoredAt: row.last_restored_at ?? null,
    }));
  }

  upsertAgentSession(record: AgentSessionRecord): void {
    this.db.prepare(`
      insert into agent_sessions (
        provider, provider_session_id, name, name_source, command, args_json, cwd, cwd_source, created_at, last_seen_at, last_restored_at
      ) values (
        @provider, @provider_session_id, @name, @name_source, @command, @args_json, @cwd, @cwd_source, @created_at, @last_seen_at, @last_restored_at
      )
      on conflict(provider, provider_session_id) do update set
        name=case
          when
            (case excluded.name_source when 'user' then 3 when 'provider' then 2 else 1 end) >
            (case agent_sessions.name_source when 'user' then 3 when 'provider' then 2 else 1 end)
            or (
              (case excluded.name_source when 'user' then 3 when 'provider' then 2 else 1 end) =
              (case agent_sessions.name_source when 'user' then 3 when 'provider' then 2 else 1 end)
              and excluded.last_seen_at >= agent_sessions.last_seen_at
            )
          then excluded.name
          else agent_sessions.name
        end,
        name_source=case
          when
            (case excluded.name_source when 'user' then 3 when 'provider' then 2 else 1 end) >
            (case agent_sessions.name_source when 'user' then 3 when 'provider' then 2 else 1 end)
            or (
              (case excluded.name_source when 'user' then 3 when 'provider' then 2 else 1 end) =
              (case agent_sessions.name_source when 'user' then 3 when 'provider' then 2 else 1 end)
              and excluded.last_seen_at >= agent_sessions.last_seen_at
            )
          then excluded.name_source
          else agent_sessions.name_source
        end,
        command=excluded.command,
        args_json=excluded.args_json,
        cwd=coalesce(excluded.cwd, agent_sessions.cwd),
        cwd_source=case when excluded.cwd is not null then excluded.cwd_source else agent_sessions.cwd_source end,
        created_at=min(agent_sessions.created_at, excluded.created_at),
        last_seen_at=max(agent_sessions.last_seen_at, excluded.last_seen_at),
        last_restored_at=coalesce(excluded.last_restored_at, agent_sessions.last_restored_at);
    `).run({
      provider: record.provider,
      provider_session_id: record.providerSessionId,
      name: record.name,
      name_source: record.nameSource,
      command: record.command,
      args_json: JSON.stringify(record.args),
      cwd: record.cwd,
      cwd_source: record.cwdSource,
      created_at: record.createdAt,
      last_seen_at: record.lastSeenAt,
      last_restored_at: record.lastRestoredAt,
    });
  }

  /** Insert a live row (first_seen_at=now) or refresh the existing live row. Returns the row id. */
  upsertWorktreeObservation(input: WorktreeObservationInput): number {
    this.db.prepare(`
      insert into worktrees (repo_root, path, branch, origin, state, state_detail, first_seen_at, scanned_at)
      values (@repo_root, @path, @branch, @origin, @state, @state_detail, @first_seen_at, @scanned_at)
      on conflict(repo_root, path) where reaped_at is null do update set
        branch=excluded.branch,
        state=excluded.state,
        state_detail=excluded.state_detail,
        scanned_at=excluded.scanned_at,
        origin=coalesce(worktrees.origin, excluded.origin);
    `).run({
      repo_root: input.repoRoot,
      path: input.path,
      branch: input.branch,
      origin: input.origin ?? null,
      state: input.state,
      state_detail: JSON.stringify(input.stateDetail ?? null),
      first_seen_at: Date.now(),
      scanned_at: input.scannedAt,
    });

    const row = this.db.prepare(`
      select id from worktrees where repo_root = ? and path = ? and reaped_at is null;
    `).get(input.repoRoot, input.path) as { id: number };
    return row.id;
  }

  /** Partial meta update of the live row; only provided keys are written. */
  setWorktreeMeta(repoRoot: string, path: string, meta: WorktreeMetaPatch): void {
    const sets: string[] = [];
    const params: Record<string, unknown> = { repo_root: repoRoot, path };
    if (meta.label !== undefined) {
      sets.push("label=@label");
      params.label = meta.label;
    }
    if (meta.ticketId !== undefined) {
      sets.push("ticket_id=@ticket_id");
      params.ticket_id = meta.ticketId;
    }
    if (meta.firstPrompt !== undefined) {
      sets.push("first_prompt=@first_prompt");
      params.first_prompt = meta.firstPrompt;
    }
    if (meta.prId !== undefined) {
      sets.push("pr_id=@pr_id");
      params.pr_id = meta.prId;
    }
    if (meta.prTitle !== undefined) {
      sets.push("pr_title=@pr_title");
      params.pr_title = meta.prTitle;
    }
    if (sets.length === 0) return;

    this.db.prepare(`
      update worktrees
      set ${sets.join(", ")}
      where repo_root = @repo_root and path = @path and reaped_at is null;
    `).run(params);
  }

  /** Record PR proof on live row(s) for a branch; merges keys into the state_detail JSON. */
  setWorktreePrProofByBranch(repoRoot: string, branch: string, proof: WorktreePrProof): void {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`
        select id, state_detail from worktrees
        where repo_root = ? and branch = ? and reaped_at is null;
      `).all(repoRoot, branch) as Array<{ id: number; state_detail: string | null }>;

      const update = this.db.prepare(`
        update worktrees
        set pr_id = @pr_id, pr_title = @pr_title, state_detail = @state_detail
        where id = @id;
      `);

      for (const row of rows) {
        let detail: Record<string, unknown> = {};
        try {
          const parsed = row.state_detail ? (JSON.parse(row.state_detail) as unknown) : null;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            detail = parsed as Record<string, unknown>;
          }
        } catch {
          // corrupt JSON: start fresh rather than fail the proof write
        }
        detail.prStatus = proof.prStatus;
        detail.mergeSourceSha = proof.mergeSourceSha;
        detail.prCompletedAt = proof.prCompletedAt;
        update.run({
          id: row.id,
          pr_id: proof.prId,
          pr_title: proof.prTitle,
          state_detail: JSON.stringify(detail),
        });
      }
    });
    tx();
  }

  /** Mark the live row at path as reaped. */
  tombstoneWorktree(repoRoot: string, path: string, t: WorktreeTombstoneInput): void {
    this.db.prepare(`
      update worktrees
      set reaped_at = @reaped_at,
          state = @state,
          reap_evidence = @reap_evidence,
          salvage_path = @salvage_path,
          attic_tag = @attic_tag
      where repo_root = @repo_root and path = @path and reaped_at is null;
    `).run({
      repo_root: repoRoot,
      path,
      reaped_at: Date.now(),
      state: t.state,
      reap_evidence: t.reapEvidence,
      salvage_path: t.salvagePath,
      attic_tag: t.atticTag,
    });
  }

  /** Rename a live row's path, remembering the old path. Merges into an existing live row at newPath. */
  moveWorktreePath(repoRoot: string, oldPath: string, newPath: string): void {
    const tx = this.db.transaction(() => {
      const moved = this.getLiveWorktreeRow(repoRoot, oldPath);
      if (!moved) return;
      const target = this.getLiveWorktreeRow(repoRoot, newPath);

      const priorPaths = [
        ...this.parsePriorPaths(moved.prior_paths),
        ...this.parsePriorPaths(target?.prior_paths ?? null),
        oldPath,
      ].filter((p, i, arr) => p !== newPath && arr.indexOf(p) === i);

      if (target) {
        // Duplicate live rows for one worktree: keep the moved row's identity,
        // absorb the target's meta, keep the oldest first_seen_at.
        this.db.prepare(`delete from worktrees where id = ?;`).run(target.id);
        this.db.prepare(`
          update worktrees
          set path = @path,
              prior_paths = @prior_paths,
              first_seen_at = @first_seen_at,
              label = @label,
              ticket_id = @ticket_id,
              first_prompt = @first_prompt
          where id = @id;
        `).run({
          id: moved.id,
          path: newPath,
          prior_paths: JSON.stringify(priorPaths),
          first_seen_at: Math.min(moved.first_seen_at, target.first_seen_at),
          label: moved.label ?? target.label,
          ticket_id: moved.ticket_id ?? target.ticket_id,
          first_prompt: moved.first_prompt ?? target.first_prompt,
        });
      } else {
        this.db.prepare(`
          update worktrees set path = @path, prior_paths = @prior_paths where id = @id;
        `).run({
          id: moved.id,
          path: newPath,
          prior_paths: JSON.stringify(priorPaths),
        });
      }
    });
    tx();
  }

  listWorktreeRows(repoRoot: string, opts?: { includeTombstones?: boolean }): WorktreeRow[] {
    const tombstoneFilter = opts?.includeTombstones ? "" : "and reaped_at is null";
    return this.db.prepare(`
      select ${WORKTREE_COLUMNS}
      from worktrees
      where repo_root = ? ${tombstoneFilter}
      order by first_seen_at asc, id asc;
    `).all(repoRoot) as WorktreeRow[];
  }

  getWorktreeRowByPath(repoRoot: string, path: string): WorktreeRow | undefined {
    return this.getLiveWorktreeRow(repoRoot, path);
  }

  /** Backfill a tombstone for a path with no row at all. Returns true when inserted. */
  insertWorktreeTombstoneIfMissing(input: WorktreeBackfillTombstoneInput): boolean {
    const exists = this.db.prepare(`
      select 1 from worktrees where repo_root = ? and path = ? limit 1;
    `).get(input.repoRoot, input.path) as { 1: number } | undefined;
    if (exists) return false;

    this.db.prepare(`
      insert into worktrees (repo_root, path, branch, label, first_prompt, origin, first_seen_at, reaped_at, reap_evidence)
      values (@repo_root, @path, @branch, @label, @first_prompt, @origin, @first_seen_at, @reaped_at, @reap_evidence);
    `).run({
      repo_root: input.repoRoot,
      path: input.path,
      branch: input.branch,
      label: input.label ?? null,
      first_prompt: input.firstPrompt ?? null,
      origin: input.origin,
      first_seen_at: input.reapedAt,
      reaped_at: input.reapedAt,
      reap_evidence: input.reapEvidence,
    });
    return true;
  }

  /** Aggregate agent_sessions whose cwd is at, or nested under, any candidate path. */
  agentSessionContextForPath(paths: string[]): AgentSessionContext {
    const empty: AgentSessionContext = {
      sessionCount: 0,
      earliestName: null,
      earliestCreatedAt: null,
      lastSeenAt: null,
    };
    const candidates = paths.filter((p) => typeof p === "string" && p.length > 0);
    if (candidates.length === 0) return empty;

    const clause = candidates.map(() => "(cwd = ? or cwd like ? || '/%')").join(" or ");
    const params: string[] = [];
    for (const p of candidates) params.push(p, p);

    const agg = this.db.prepare(`
      select count(*) as session_count, min(created_at) as earliest_created_at, max(last_seen_at) as last_seen_at
      from agent_sessions
      where ${clause};
    `).get(...params) as { session_count: number; earliest_created_at: number | null; last_seen_at: number | null };
    if (!agg || agg.session_count === 0) return empty;

    const earliest = this.db.prepare(`
      select name from agent_sessions
      where ${clause}
      order by created_at asc
      limit 1;
    `).get(...params) as { name: string } | undefined;

    return {
      sessionCount: agg.session_count,
      earliestName: earliest?.name ?? null,
      earliestCreatedAt: agg.earliest_created_at,
      lastSeenAt: agg.last_seen_at,
    };
  }

  /** Agent sessions whose cwd is at, or nested under, the given path (newest first). */
  listAgentSessionsByCwdPrefix(prefix: string, limit = 50): Array<{
    provider: string;
    providerSessionId: string;
    name: string;
    createdAt: number;
    lastSeenAt: number;
  }> {
    const rows = this.db.prepare(`
      select provider, provider_session_id, name, created_at, last_seen_at
      from agent_sessions
      where cwd = ? or cwd like ? || '/%'
      order by last_seen_at desc
      limit ?;
    `).all(prefix, prefix, limit) as Array<{
      provider: string;
      provider_session_id: string;
      name: string;
      created_at: number;
      last_seen_at: number;
    }>;
    return rows.map((r) => ({
      provider: r.provider,
      providerSessionId: r.provider_session_id,
      name: r.name,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    }));
  }

  /** Distinct repo roots that have any worktree row (live or tombstoned). */
  listWorktreeRepoRoots(): string[] {
    const rows = this.db.prepare(`select distinct repo_root from worktrees;`).all() as Array<{ repo_root: string }>;
    return rows.map((r) => r.repo_root);
  }

  /** Distinct agent-session cwds with earliest-session context (for tombstone backfill). */
  listAgentSessionCwds(): Array<{ cwd: string; earliestName: string | null; earliestCreatedAt: number | null; lastSeenAt: number | null }> {
    const rows = this.db.prepare(`
      select cwd, count(*) as session_count, min(created_at) as earliest_created_at, max(last_seen_at) as last_seen_at
      from agent_sessions
      where cwd is not null and cwd != ''
      group by cwd;
    `).all() as Array<{ cwd: string; session_count: number; earliest_created_at: number | null; last_seen_at: number | null }>;
    const earliestStmt = this.db.prepare(`
      select name from agent_sessions where cwd = ? order by created_at asc limit 1;
    `);
    return rows.map((r) => {
      const earliest = earliestStmt.get(r.cwd) as { name: string } | undefined;
      return {
        cwd: r.cwd,
        earliestName: earliest?.name ?? null,
        earliestCreatedAt: r.earliest_created_at,
        lastSeenAt: r.last_seen_at,
      };
    });
  }

  private getLiveWorktreeRow(repoRoot: string, path: string): WorktreeRow | undefined {
    return this.db.prepare(`
      select ${WORKTREE_COLUMNS}
      from worktrees
      where repo_root = ? and path = ? and reaped_at is null;
    `).get(repoRoot, path) as WorktreeRow | undefined;
  }

  private parsePriorPaths(raw: string | null): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((p): p is string => typeof p === "string");
    } catch {
      return [];
    }
  }

  private parseAgentCwdSource(value: string | null): AgentSessionCwdSource {
    if (value === "runtime" || value === "db" || value === "log" || value === "user") return value;
    return "db";
  }

  private parseAgentNameSource(value: string | null): AgentSessionNameSource {
    if (value === "user" || value === "provider" || value === "derived") return value;
    return "derived";
  }

  private parseArgsJson(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.map(String);
    } catch {
      return [];
    }
  }
}
