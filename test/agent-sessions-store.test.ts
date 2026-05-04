import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SqliteStore } from "../src/persist/sqlite.js";

describe("SqliteStore agent_sessions", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("upserts and keeps existing cwd when new record has null cwd", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-agent-sessions-"));
    const dbPath = path.join(tmpRoot, "agent.db");
    const store = new SqliteStore(dbPath);

    store.upsertAgentSession({
      provider: "codex",
      providerSessionId: "sess-1",
      name: "codex:repo",
      nameSource: "derived",
      command: "codex",
      args: ["resume", "sess-1"],
      cwd: "/tmp/repo/.worktrees/a",
      cwdSource: "runtime",
      createdAt: 1_000,
      lastSeenAt: 2_000,
      lastRestoredAt: 1_500,
    });

    store.upsertAgentSession({
      provider: "codex",
      providerSessionId: "sess-1",
      name: "codex:repo",
      nameSource: "provider",
      command: "codex",
      args: ["resume", "sess-1"],
      cwd: null,
      cwdSource: "log",
      createdAt: 900,
      lastSeenAt: 3_000,
      lastRestoredAt: null,
    });

    const row = store.getAgentSession("codex", "sess-1");
    expect(row).not.toBeNull();
    expect(row?.cwd).toBe("/tmp/repo/.worktrees/a");
    expect(row?.cwdSource).toBe("runtime");
    expect(row?.nameSource).toBe("provider");
    expect(row?.createdAt).toBe(900);
    expect(row?.lastSeenAt).toBe(3_000);
    expect(row?.lastRestoredAt).toBe(1_500);
  });

  test("lists agent sessions ordered by last_seen_at desc", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-agent-sessions-"));
    const dbPath = path.join(tmpRoot, "agent.db");
    const store = new SqliteStore(dbPath);

    store.upsertAgentSession({
      provider: "claude",
      providerSessionId: "a",
      name: "claude:a",
      nameSource: "derived",
      command: "claude",
      args: ["--resume", "a"],
      cwd: "/tmp/a",
      cwdSource: "log",
      createdAt: 1_000,
      lastSeenAt: 5_000,
      lastRestoredAt: null,
    });
    store.upsertAgentSession({
      provider: "codex",
      providerSessionId: "b",
      name: "codex:b",
      nameSource: "derived",
      command: "codex",
      args: ["resume", "b"],
      cwd: "/tmp/b",
      cwdSource: "db",
      createdAt: 1_000,
      lastSeenAt: 7_000,
      lastRestoredAt: null,
    });

    const rows = store.listAgentSessions();
    expect(rows.map((r) => `${r.provider}:${r.providerSessionId}`)).toEqual(["codex:b", "claude:a"]);
  });

  test("keeps manual user names over newer provider-imported names", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-agent-sessions-"));
    const dbPath = path.join(tmpRoot, "agent.db");
    const store = new SqliteStore(dbPath);

    store.upsertAgentSession({
      provider: "codex",
      providerSessionId: "sess-2",
      name: "Manual Name",
      nameSource: "user",
      command: "codex",
      args: ["resume", "sess-2"],
      cwd: "/tmp/repo",
      cwdSource: "user",
      createdAt: 1_000,
      lastSeenAt: 2_000,
      lastRestoredAt: null,
    });

    store.upsertAgentSession({
      provider: "codex",
      providerSessionId: "sess-2",
      name: "Provider Rename",
      nameSource: "provider",
      command: "codex",
      args: ["resume", "sess-2"],
      cwd: "/tmp/repo",
      cwdSource: "log",
      createdAt: 1_000,
      lastSeenAt: 9_000,
      lastRestoredAt: null,
    });

    const row = store.getAgentSession("codex", "sess-2");
    expect(row?.name).toBe("Manual Name");
    expect(row?.nameSource).toBe("user");
    expect(row?.lastSeenAt).toBe(9_000);
  });
});
