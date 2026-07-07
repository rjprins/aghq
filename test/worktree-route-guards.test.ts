import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerWorktreeRoutes } from "../src/server/routes/worktrees.js";

function baseWorktrees(overrides: Record<string, unknown> = {}) {
  return {
    listWorktrees: () => ({ worktrees: [], repoRoot: "/tmp" }),
    listBranches: async () => [],
    defaultBranch: async () => "main",
    resolveProjectRoot: async (raw: unknown) => (typeof raw === "string" && raw.trim() ? raw : null),
    worktreeStatus: async () => ({ dirty: false, branch: "wt", changes: [] }),
    removeWorktree: async () => {},
    directoryExists: async () => true,
    isKnownWorktreePath: () => true,
    createWorktreeFromBase: async () => "/tmp/wt",
    isBranchFormatLikelySafe: () => true,
    ...overrides,
  } as any;
}

const scannerStub = { invalidate: () => {}, scan: async () => ({}), getCached: () => null } as any;

describe("worktree route guards", () => {
  it("returns ok:false instead of 500 when reap or dropBranch throws", async () => {
    const fastify = Fastify();
    const reaper = {
      reap: async () => {
        throw new Error("boom");
      },
      dropBranch: async () => {
        throw new Error("drop boom");
      },
    } as any;
    registerWorktreeRoutes({ fastify, worktrees: baseWorktrees(), scanner: scannerStub, reaper, store: {} as any });

    const reap = await fastify.inject({
      method: "POST",
      url: "/api/worktrees/reap",
      payload: { path: "/tmp/wt", expectedHead: "abc1234" },
    });
    expect(reap.statusCode).toBe(200);
    expect(reap.json()).toEqual({ ok: false, reason: "boom" });

    const drop = await fastify.inject({
      method: "POST",
      url: "/api/branches/drop",
      payload: { repoRoot: "/repo", branch: "feat/x" },
    });
    expect(drop.statusCode).toBe(200);
    expect(drop.json()).toEqual({ ok: false, reason: "drop boom" });
    await fastify.close();
  });

  it("rescans and invalidates the reap result's repoRoot", async () => {
    const fastify = Fastify();
    const invalidated: string[] = [];
    const scanned: string[] = [];
    const scanner = {
      invalidate: (root: string) => invalidated.push(root),
      scan: async (root: string) => {
        scanned.push(root);
        return {};
      },
    } as any;
    const reaper = {
      reap: async () => ({ ok: true, repoRoot: "/real/repo", freedBytes: 1 }),
    } as any;
    registerWorktreeRoutes({ fastify, worktrees: baseWorktrees(), scanner, reaper, store: {} as any });

    const res = await fastify.inject({
      method: "POST",
      url: "/api/worktrees/reap",
      payload: { path: "/real/repo/.worktrees/wt", expectedHead: "abc1234" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(invalidated).toEqual(["/real/repo"]);
    expect(scanned).toEqual(["/real/repo"]);
    await fastify.close();
  });

  it("refuses to delete a dirty worktree with 409", async () => {
    const fastify = Fastify();
    const removed: string[] = [];
    const worktrees = baseWorktrees({
      worktreeStatus: async () => ({ dirty: true, branch: "wt", changes: ["M file"] }),
      removeWorktree: async (p: string) => {
        removed.push(p);
      },
    });
    registerWorktreeRoutes({ fastify, worktrees, scanner: scannerStub, reaper: {} as any, store: {} as any });

    const res = await fastify.inject({ method: "DELETE", url: "/api/worktrees", payload: { path: "/tmp/wt" } });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/reap/);
    expect(removed).toHaveLength(0);
    await fastify.close();
  });

  it("still deletes a clean worktree", async () => {
    const fastify = Fastify();
    const removed: string[] = [];
    const worktrees = baseWorktrees({
      removeWorktree: async (p: string) => {
        removed.push(p);
      },
    });
    registerWorktreeRoutes({ fastify, worktrees, scanner: scannerStub, reaper: {} as any, store: {} as any });

    const res = await fastify.inject({ method: "DELETE", url: "/api/worktrees", payload: { path: "/tmp/wt" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(removed).toEqual(["/tmp/wt"]);
    await fastify.close();
  });

  it("context prefers the newest live row and only tombstoned rows yield a tombstone", async () => {
    const fastify = Fastify();
    const tombstoned = {
      id: 2,
      repo_root: "/repo",
      path: "/tmp/wt",
      prior_paths: null,
      branch: "feat/old",
      label: null,
      ticket_id: null,
      first_prompt: null,
      pr_id: null,
      pr_title: null,
      origin: null,
      state: "merged",
      state_detail: null,
      first_seen_at: 1,
      scanned_at: null,
      reaped_at: 100,
      reap_evidence: "PR !1 completed",
      salvage_path: "/attic/x.tar.gz",
      attic_tag: "attic/x",
    };
    const live = { ...tombstoned, id: 3, branch: "feat/new", reaped_at: null, reap_evidence: null, salvage_path: null, attic_tag: null };
    const rows = [live, tombstoned];
    const store = {
      findWorktreeRowsByPath: (p: string) => (p === "/tmp/wt" ? rows : []),
      listAgentSessionsByCwdPrefix: () => [],
    } as any;
    registerWorktreeRoutes({ fastify, worktrees: baseWorktrees(), scanner: scannerStub, reaper: {} as any, store });

    const withLive = await fastify.inject({ method: "GET", url: "/api/worktrees/context?path=/tmp/wt" });
    expect(withLive.statusCode).toBe(200);
    expect(withLive.json().tombstone).toBeNull();

    rows.shift(); // no live row left: the newest tombstoned row wins
    const dead = await fastify.inject({ method: "GET", url: "/api/worktrees/context?path=/tmp/wt" });
    expect(dead.json().tombstone).toMatchObject({
      branch: "feat/old",
      reapedAt: 100,
      salvagePath: "/attic/x.tar.gz",
      atticTag: "attic/x",
    });
    await fastify.close();
  });
});
