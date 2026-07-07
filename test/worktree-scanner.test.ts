import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { SqliteStore } from "../src/persist/sqlite.js";
import type { AgentSessionRecord } from "../src/persist/sqlite.js";
import { activeReapPaths } from "../src/server/worktree-reap.js";
import {
  createWorktreeScanner,
  parseReflogEntryEpochMs,
  templateBasenameRegex,
  type WorktreeScannerDeps,
} from "../src/server/worktree-scanner.js";

const execFileAsync = promisify(execFile);

describe("parseReflogEntryEpochMs", () => {
  test("parses the HEAD@{<epoch>} selector from %gd --date=unix", () => {
    expect(parseReflogEntryEpochMs("HEAD@{1735689600}\n")).toBe(1735689600 * 1000);
  });

  test("rejects bare committer-date output (the %ct regression)", () => {
    expect(parseReflogEntryEpochMs("1735689600\n")).toBeNull();
  });

  test("rejects empty and non-selector output", () => {
    expect(parseReflogEntryEpochMs("")).toBeNull();
    expect(parseReflogEntryEpochMs("HEAD@{now}")).toBeNull();
  });
});

describe("templateBasenameRegex", () => {
  test("default template pins the repo name and wildcards the branch", () => {
    const re = templateBasenameRegex("../{repo-name}-{branch}", "agmux");
    expect(re.test("agmux-feature-x")).toBe(true);
    expect(re.test("agmux-")).toBe(false); // empty branch
    expect(re.test("agmux")).toBe(false);
    expect(re.test("other-project")).toBe(false);
    expect(re.test("agentboard-feature-x")).toBe(false);
  });

  test("escapes regex metacharacters in repo names and literals", () => {
    const re = templateBasenameRegex("../{repo-name}-{branch}", "my.repo");
    expect(re.test("my.repo-x")).toBe(true);
    expect(re.test("myXrepo-x")).toBe(false);
  });

  test("branch-only basename matches any non-empty name", () => {
    const re = templateBasenameRegex("../wt/{branch}", "agmux");
    expect(re.test("anything")).toBe(true);
    expect(re.test("")).toBe(false);
  });
});

describe("worktree scanner (integration)", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  async function git(args: string[], cwd: string): Promise<string> {
    const { stdout } = await execFileAsync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", ...args],
      { cwd },
    );
    return stdout;
  }

  /** Repo at <tmp>/repo with one linked worktree at <tmp>/repo-feat (branch feat). */
  async function makeFixture(): Promise<{ root: string; wt: string; store: SqliteStore }> {
    tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agmux-scanner-")));
    const root = path.join(tmpRoot, "repo");
    await fs.mkdir(root);
    await git(["init", "-q", "-b", "main"], root);
    await git(["commit", "-q", "--allow-empty", "-m", "init"], root);
    const wt = path.join(tmpRoot, "repo-feat");
    await git(["worktree", "add", "-q", "-b", "feat", wt], root);
    const store = new SqliteStore(path.join(tmpRoot, "scanner.db"));
    return { root, wt, store };
  }

  const silentLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  } as unknown as FastifyBaseLogger;

  function makeScanner(store: SqliteStore, extra: Partial<WorktreeScannerDeps> = {}) {
    return createWorktreeScanner({
      store,
      logger: silentLogger,
      getLivePtyCwds: async () => [],
      getWorktreeTemplate: () => "../{repo-name}-{branch}",
      resolveDefaultBranch: async () => "main",
      ...extra,
    });
  }

  function agentSession(overrides: Partial<AgentSessionRecord>): AgentSessionRecord {
    return {
      provider: "claude",
      providerSessionId: "sess",
      name: "session",
      nameSource: "derived",
      command: "claude",
      args: [],
      cwd: null,
      cwdSource: "log",
      createdAt: 1_000,
      lastSeenAt: 1_000,
      lastRestoredAt: null,
      ...overrides,
    };
  }

  test("scan from a linked-worktree path keys everything off the true primary root", async () => {
    const { root, wt, store } = await makeFixture();
    const scanner = makeScanner(store);

    const res = await scanner.scan(wt); // deliberately NOT the primary root
    expect(res.repoRoot).toBe(root);
    const primary = res.worktrees.find((w) => w.path === root);
    const linked = res.worktrees.find((w) => w.path === wt);
    expect(primary?.isPrimary).toBe(true);
    expect(linked?.isPrimary).toBe(false);
    // Rows are namespaced under the primary root, not the linked path.
    expect(store.listWorktreeRows(root).length).toBe(2);
    expect(store.listWorktreeRows(wt).length).toBe(0);
    // The cache is keyed by the primary root too.
    expect(scanner.getCached(root)).toBe(res);
  });

  test("invalidate drops the cached scan even when given a linked-worktree path", async () => {
    const { root, wt, store } = await makeFixture();
    const scanner = makeScanner(store);
    await scanner.scan(root);
    expect(scanner.getCached(root)).not.toBeNull();
    scanner.invalidate(wt);
    expect(scanner.getCached(root)).toBeNull();
  });

  test("single-flight: equal scans join, a request for more work chains a follow-up", async () => {
    const { root, store } = await makeFixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let enteredFirst!: () => void;
    const entered = new Promise<void>((r) => (enteredFirst = r));
    let calls = 0;
    const scanner = makeScanner(store, {
      getLivePtyCwds: async () => {
        calls += 1;
        if (calls === 1) {
          enteredFirst();
          await gate; // hold the first scan mid-flight
        }
        return [];
      },
    });

    const p1 = scanner.scan(root);
    await entered;
    const p2 = scanner.scan(root); // same work: joins p1
    const p3 = scanner.scan(root, { expensive: true }); // more work: chains after p1
    await new Promise((r) => setTimeout(r, 150)); // let p2/p3 reach the in-flight lookup
    release();

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r2).toBe(r1);
    expect(r3).not.toBe(r1);
    expect(r3.scannedAt).toBeGreaterThanOrEqual(r1.scannedAt);
    expect(calls).toBe(2); // exactly two scans ran
  });

  test("paths mid-reap are neither annotated nor tombstoned by the scanner", async () => {
    const { root, wt, store } = await makeFixture();
    const scanner = makeScanner(store);
    await scanner.scan(root); // adopt both worktrees into the store

    activeReapPaths.add(wt);
    try {
      const res = await scanner.scan(root);
      expect(res.worktrees.some((w) => w.path === wt)).toBe(false);
      // The reap funnel owns the row: no "removed out-of-band" tombstone.
      const row = store.listWorktreeRows(root, { includeTombstones: true }).find((r) => r.path === wt);
      expect(row?.reaped_at ?? null).toBeNull();
    } finally {
      activeReapPaths.delete(wt);
    }
  });

  test("detached pr-<N> checkout acquires PR status via lookupPrById under verifyProofs", async () => {
    const { root, store } = await makeFixture();
    const prPath = path.join(tmpRoot as string, "pr-7");
    await git(["worktree", "add", "-q", "--detach", prPath], root);

    const lookups: number[] = [];
    const scanner = makeScanner(store, {
      lookupPrById: async (_repoRoot, prId) => {
        lookups.push(prId);
        return { id: prId, title: "Fix things", status: "completed", mergeSourceSha: null, completedAt: 123 };
      },
    });

    const plain = await scanner.scan(root);
    expect(lookups).toEqual([]); // only under verifyProofs
    expect(plain.worktrees.find((w) => w.path === prPath)?.prStatus ?? null).toBeNull();

    const verified = await scanner.scan(root, { verifyProofs: true });
    const pr = verified.worktrees.find((w) => w.path === prPath);
    expect(lookups).toEqual([7]);
    expect(pr?.prStatus).toBe("completed");
    expect(pr?.prId).toBe("7");
    expect(pr?.state).toBe("review");
    expect(pr?.reapClass).toBe("reap-safe");
  });

  test("backfillTombstones only tombstones template-conformant vanished siblings", async () => {
    const { root, store } = await makeFixture();
    const scanner = makeScanner(store);
    const goneWorktree = path.join(tmpRoot as string, "repo-old-branch");
    const goneUnrelated = path.join(tmpRoot as string, "unrelated-project");
    store.upsertAgentSession(agentSession({ providerSessionId: "a", cwd: goneWorktree }));
    store.upsertAgentSession(agentSession({ providerSessionId: "b", cwd: goneUnrelated }));

    const inserted = await scanner.backfillTombstones(root);
    expect(inserted).toBe(1);
    const stonePaths = store
      .listWorktreeRows(root, { includeTombstones: true })
      .filter((r) => r.reaped_at != null)
      .map((r) => r.path);
    expect(stonePaths).toEqual([goneWorktree]);
  });
});
