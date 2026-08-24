import { describe, expect, it } from "vitest";

import {
  latestIterationUpdatedAt,
  normalizeActivePrRecords,
  type AzureRepoRef,
} from "../src/server/azure-pr.js";
import {
  acknowledgePrAttention,
  createAzurePrMenuService,
  matchPrWorktree,
  reconcilePrMenuState,
  type PersistedPrMenuRepoState,
} from "../src/server/azure-pr-menu.js";

const ref: AzureRepoRef = {
  orgUrl: "https://dev.azure.com/example",
  project: "Demo Project",
  repo: "demo-repo",
};

function rawPr(overrides: Record<string, unknown> = {}) {
  return {
    pullRequestId: 42,
    title: "Improve launch flow",
    sourceRefName: "refs/heads/feature/launch-flow",
    targetRefName: "refs/heads/main",
    creationDate: "2026-08-24T08:55:41.378675Z",
    isDraft: true,
    createdBy: { displayName: "Rutger Prins", uniqueName: "rutger@example.com" },
    lastMergeSourceCommit: { commitId: "abc123" },
    ...overrides,
  };
}

describe("normalizeActivePrRecords", () => {
  it("normalizes documented ADO fields into the menu contract", () => {
    const [pr] = normalizeActivePrRecords(ref, [rawPr()]);

    expect(pr).toEqual({
      id: 42,
      title: "Improve launch flow",
      author: "Rutger Prins",
      isDraft: true,
      sourceBranch: "feature/launch-flow",
      targetBranch: "main",
      createdAt: Date.parse("2026-08-24T08:55:41.378675Z"),
      headSha: "abc123",
      url: "https://dev.azure.com/example/Demo%20Project/_git/demo-repo/pullrequest/42?_a=files",
    });
  });

  it("ignores malformed third-party records instead of trusting them", () => {
    const records = normalizeActivePrRecords(ref, [
      rawPr(),
      rawPr({ pullRequestId: "43" }),
      rawPr({ title: "" }),
      rawPr({ sourceRefName: "feature/no-prefix" }),
      rawPr({ creationDate: "not-a-date" }),
      rawPr({ isDraft: "false" }),
      null,
    ]);

    expect(records.map((pr) => pr.id)).toEqual([42]);
  });

  it("uses the unique name when ADO omits an author display name", () => {
    const [pr] = normalizeActivePrRecords(ref, [
      rawPr({ createdBy: { uniqueName: "rutger@example.com" } }),
    ]);

    expect(pr?.author).toBe("rutger@example.com");
  });
});

describe("latestIterationUpdatedAt", () => {
  it("uses the newest valid iteration timestamp", () => {
    const fallback = Date.parse("2026-08-20T00:00:00Z");
    expect(latestIterationUpdatedAt({
      value: [
        { updatedDate: "2026-08-21T10:00:00Z" },
        { updatedDate: "invalid" },
        { updatedDate: "2026-08-24T11:30:00Z" },
      ],
    }, fallback)).toBe(Date.parse("2026-08-24T11:30:00Z"));
  });

  it("falls back to creation time for a missing or malformed iteration list", () => {
    const fallback = Date.parse("2026-08-20T00:00:00Z");
    expect(latestIterationUpdatedAt(null, fallback)).toBe(fallback);
    expect(latestIterationUpdatedAt({ value: "bad" }, fallback)).toBe(fallback);
  });
});

describe("reconcilePrMenuState", () => {
  it("establishes the first successful list as a baseline", () => {
    const result = reconcilePrMenuState(undefined, [
      { id: 10, isDraft: false },
      { id: 11, isDraft: true },
    ]);

    expect(result.attention).toEqual({});
    expect(result.known).toEqual({
      "10": { isDraft: false },
      "11": { isDraft: true },
    });
  });

  it("marks PR ids discovered after the baseline as new", () => {
    const baseline = reconcilePrMenuState(undefined, [{ id: 10, isDraft: false }]);
    const result = reconcilePrMenuState(baseline, [
      { id: 10, isDraft: false },
      { id: 11, isDraft: true },
    ]);

    expect(result.attention).toEqual({ "11": "new" });
  });

  it("marks a known draft as published", () => {
    const baseline = reconcilePrMenuState(undefined, [{ id: 10, isDraft: true }]);
    const result = reconcilePrMenuState(baseline, [{ id: 10, isDraft: false }]);

    expect(result.attention).toEqual({ "10": "published" });
  });

  it("does not mark a published PR when it moves back to draft", () => {
    const baseline = reconcilePrMenuState(undefined, [{ id: 10, isDraft: false }]);
    const result = reconcilePrMenuState(baseline, [{ id: 10, isDraft: true }]);

    expect(result.attention).toEqual({});
  });

  it("upgrades an unseen new draft marker when that PR is published", () => {
    let state = reconcilePrMenuState(undefined, [{ id: 10, isDraft: false }]);
    state = reconcilePrMenuState(state, [
      { id: 10, isDraft: false },
      { id: 11, isDraft: true },
    ]);
    state = reconcilePrMenuState(state, [
      { id: 10, isDraft: false },
      { id: 11, isDraft: false },
    ]);

    expect(state.attention).toEqual({ "11": "published" });
  });

  it("retains known ids after they leave the active list", () => {
    let state = reconcilePrMenuState(undefined, [{ id: 10, isDraft: false }]);
    state = reconcilePrMenuState(state, []);
    state = reconcilePrMenuState(state, [{ id: 10, isDraft: false }]);

    expect(state.attention).toEqual({});
  });
});

describe("acknowledgePrAttention", () => {
  const state: PersistedPrMenuRepoState = {
    known: { "10": { isDraft: false }, "11": { isDraft: false } },
    attention: { "10": "new", "11": "published" },
  };

  it("clears only the exact markers the user saw", () => {
    expect(acknowledgePrAttention(state, [
      { id: 10, attention: "new" },
      { id: 11, attention: "new" },
    ])).toEqual({
      known: state.known,
      attention: { "11": "published" },
    });
  });
});

describe("matchPrWorktree", () => {
  it("matches only the exact source branch", () => {
    const match = matchPrWorktree("feature/launch-flow", [
      { name: "other", path: "/repo-other", branch: "feature/other" },
      { name: "launch-flow", path: "/repo-launch", branch: "feature/launch-flow" },
    ]);

    expect(match).toEqual({
      name: "launch-flow",
      path: "/repo-launch",
      branch: "feature/launch-flow",
    });
    expect(matchPrWorktree("launch-flow", [
      { name: "nested", path: "/repo-nested", branch: "feature/launch-flow" },
    ])).toBeNull();
  });
});

function activePr(id: number, isDraft: boolean, createdAt: number) {
  return {
    id,
    title: `PR ${id}`,
    author: "Reviewer",
    isDraft,
    sourceBranch: `feature/${id}`,
    targetBranch: "main",
    createdAt,
    headSha: `sha-${id}`,
    url: `https://example.test/pr/${id}`,
  };
}

function memoryStore(initial: unknown = undefined) {
  let value = initial;
  return {
    getPreference: (key: string) => key === "azurePrMenuState" ? value : undefined,
    setPreference: (key: string, next: unknown) => {
      if (key === "azurePrMenuState") value = next;
    },
    read: () => value,
  };
}

describe("createAzurePrMenuService", () => {
  it("repairs malformed persisted attention state as a fresh baseline", async () => {
    const store = memoryStore({ "/repo": { known: null, attention: "bad" } });
    const service = createAzurePrMenuService({
      store,
      cacheTtlMs: 60_000,
      now: () => 1_000_000,
      repoRootFromCwd: () => "/repo",
      repoRefForRoot: async () => ref,
      listActivePrs: async () => [activePr(10, false, 100)],
      latestUpdateAt: async (_ref, pr) => pr.createdAt,
      listWorktrees: () => [],
      worktreeStatus: async () => ({ dirty: false }),
    });

    await expect(service.list("/repo")).resolves.toEqual(expect.objectContaining({
      supported: true,
      prs: [expect.objectContaining({ id: 10, attention: null })],
    }));
    expect(store.read()).toEqual({
      "/repo": {
        known: { "10": { isDraft: false } },
        attention: {},
      },
    });
  });

  it("returns sorted PRs with exact worktree and dirty state", async () => {
    const store = memoryStore();
    const service = createAzurePrMenuService({
      store,
      cacheTtlMs: 60_000,
      now: () => 1_000_000,
      repoRootFromCwd: () => "/repo",
      repoRefForRoot: async () => ref,
      listActivePrs: async () => [
        activePr(10, false, 100),
        activePr(11, true, 200),
      ],
      latestUpdateAt: async (_ref, pr) => pr.id === 10 ? 500 : 300,
      listWorktrees: () => [
        { name: "feature-10", path: "/repo-feature-10", branch: "feature/10" },
      ],
      worktreeStatus: async () => ({ dirty: true }),
    });

    const result = await service.list("/repo-linked");

    expect(result).toEqual({
      supported: true,
      projectRoot: "/repo",
      fetchedAt: 1_000_000,
      prs: [
        expect.objectContaining({ id: 10, updatedAt: 500, worktree: {
          name: "feature-10",
          path: "/repo-feature-10",
          dirty: true,
        }, attention: null }),
        expect.objectContaining({ id: 11, updatedAt: 300, worktree: null, attention: null }),
      ],
    });
  });

  it("bounds concurrent PR detail lookups", async () => {
    const store = memoryStore();
    let activeLookups = 0;
    let maxActiveLookups = 0;
    const service = createAzurePrMenuService({
      store,
      cacheTtlMs: 60_000,
      now: () => 1_000_000,
      repoRootFromCwd: () => "/repo",
      repoRefForRoot: async () => ref,
      listActivePrs: async () => Array.from({ length: 12 }, (_, index) => activePr(index + 1, false, index)),
      latestUpdateAt: async (_ref, pr) => {
        activeLookups += 1;
        maxActiveLookups = Math.max(maxActiveLookups, activeLookups);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeLookups -= 1;
        return pr.createdAt;
      },
      listWorktrees: () => [],
      worktreeStatus: async () => ({ dirty: false }),
    });

    await service.list("/repo");

    expect(maxActiveLookups).toBeGreaterThan(1);
    expect(maxActiveLookups).toBeLessThanOrEqual(4);
  });

  it("uses its one-minute cache and refreshes attention after expiry", async () => {
    const store = memoryStore();
    let now = 1_000_000;
    let calls = 0;
    let prs = [activePr(10, true, 100)];
    const service = createAzurePrMenuService({
      store,
      cacheTtlMs: 60_000,
      now: () => now,
      repoRootFromCwd: () => "/repo",
      repoRefForRoot: async () => ref,
      listActivePrs: async () => {
        calls++;
        return prs;
      },
      latestUpdateAt: async (_ref, pr) => pr.createdAt,
      listWorktrees: () => [],
      worktreeStatus: async () => ({ dirty: false }),
    });

    await service.list("/repo");
    await service.list("/repo");
    expect(calls).toBe(1);

    prs = [activePr(10, false, 100), activePr(11, true, 200)];
    now += 60_001;
    const refreshed = await service.list("/repo");

    expect(calls).toBe(2);
    expect(refreshed.supported && refreshed.prs.map((pr) => [pr.id, pr.attention])).toEqual([
      [11, "new"],
      [10, "published"],
    ]);
  });

  it("acknowledges displayed markers in persisted and cached state", async () => {
    const store = memoryStore({
      "/repo": {
        known: { "10": { isDraft: true } },
        attention: {},
      },
    });
    const service = createAzurePrMenuService({
      store,
      cacheTtlMs: 60_000,
      now: () => 1_000_000,
      repoRootFromCwd: () => "/repo",
      repoRefForRoot: async () => ref,
      listActivePrs: async () => [activePr(10, false, 100)],
      latestUpdateAt: async (_ref, pr) => pr.createdAt,
      listWorktrees: () => [],
      worktreeStatus: async () => ({ dirty: false }),
    });

    const before = await service.list("/repo");
    expect(before.supported && before.prs[0]?.attention).toBe("published");

    await service.acknowledge("/repo", [{ id: 10, attention: "published" }]);
    const after = await service.list("/repo");

    expect(after.supported && after.prs[0]?.attention).toBeNull();
    expect(store.read()).toEqual({
      "/repo": {
        known: { "10": { isDraft: false } },
        attention: {},
      },
    });
  });

  it("returns unsupported without querying PRs for a non-ADO repository", async () => {
    let listCalls = 0;
    const service = createAzurePrMenuService({
      store: memoryStore(),
      cacheTtlMs: 60_000,
      now: () => 1_000_000,
      repoRootFromCwd: () => "/repo",
      repoRefForRoot: async () => null,
      listActivePrs: async () => {
        listCalls++;
        return [];
      },
      latestUpdateAt: async (_ref, pr) => pr.createdAt,
      listWorktrees: () => [],
      worktreeStatus: async () => ({ dirty: false }),
    });

    await expect(service.list("/repo")).resolves.toEqual({ supported: false, projectRoot: "/repo" });
    expect(listCalls).toBe(0);
  });
});
