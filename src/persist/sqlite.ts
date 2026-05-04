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
  bufferLine: number;
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
          history = parsed.filter(
            (x: any) => x && typeof x.text === "string" && x.text.trim().length > 0,
          );
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
