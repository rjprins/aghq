import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { PtyId, PtySummary, TmuxServer } from "../types.js";
import { defaultSessionName } from "../session-names.js";

export type PtySpawnRequest = {
  id?: string;
  name?: string;
  backend?: "tmux";
  tmuxSession?: string | null;
  tmuxServer?: TmuxServer | null;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  createdAt?: number;
};

export type PtyManagerEvents = {
  output: (ptyId: PtyId, data: string) => void;
  exit: (ptyId: PtyId, code: number | null, signal: string | null) => void;
};

type PtySession = {
  id: PtyId;
  pty: IPty;
  summary: PtySummary;
};

export class PtyManager extends EventEmitter {
  private sessions = new Map<PtyId, PtySession>();

  spawn(req: PtySpawnRequest): PtySummary {
    const id = req.id ?? `pty_${randomUUID()}`;
    const args = req.args ?? [];
    const cols = req.cols ?? 120;
    const rows = req.rows ?? 30;
    const existing = this.sessions.get(id);
    const createdAt = req.createdAt ?? existing?.summary.createdAt ?? Date.now();

    // Replace existing session if any (e.g. reattach after restart).
    if (existing?.pty) {
      try {
        existing.pty.kill();
      } catch {
        // ignore
      }
    }

    const child = pty.spawn(req.command, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: req.cwd ?? process.cwd(),
      env: { ...process.env, ...(req.env ?? {}) } as Record<string, string>,
    });

    const summary: PtySummary = {
      id,
      name: defaultSessionName(id, req.name ?? req.command),
      backend: "tmux",
      tmuxSession: req.tmuxSession ?? null,
      tmuxServer: req.tmuxServer ?? null,
      command: req.command,
      args,
      cwd: req.cwd ?? null,
      createdAt,
      status: "running",
    };

    const session: PtySession = { id, pty: child, summary };
    this.sessions.set(id, session);

    child.onData((data) => {
      this.emit("output", id, data);
    });

    child.onExit(({ exitCode, signal }) => {
      const s = this.sessions.get(id);
      if (s) {
        s.summary.status = "exited";
        s.summary.exitCode = exitCode ?? null;
        s.summary.exitSignal = signal == null ? null : String(signal);
      }
      this.emit("exit", id, exitCode ?? null, signal == null ? null : String(signal));
    });

    return summary;
  }

  list(): PtySummary[] {
    return [...this.sessions.values()]
      .map((s) => ({ ...s.summary }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  getSummary(id: PtyId): PtySummary | null {
    const s = this.sessions.get(id);
    return s ? { ...s.summary } : null;
  }

  write(id: PtyId, data: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.pty.write(data);
  }

  resize(id: PtyId, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.pty.resize(cols, rows);
    } catch {
      // Some PTYs reject resize during teardown; ignore.
    }
  }

  updateCwd(id: PtyId, cwd: string): void {
    const s = this.sessions.get(id);
    if (s) s.summary.cwd = cwd;
  }

  updateName(id: PtyId, name: string): PtySummary | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    s.summary.name = name;
    return { ...s.summary };
  }

  getPid(id: PtyId): number | null {
    const s = this.sessions.get(id);
    return s ? s.pty.pid : null;
  }

  kill(id: PtyId): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    try {
      s.pty.kill();
      return true;
    } catch {
      return false;
    }
  }
}
