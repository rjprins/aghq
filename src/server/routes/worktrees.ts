import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { parseJsonBody } from "../auth.js";
import type { SqliteStore } from "../../persist/sqlite.js";
import type { WorktreeScanner } from "../worktree-scanner.js";
import type { ReapService } from "../worktree-reap.js";
import { generateBranchName } from "../../shared/worktrees.js";
import { gitRepoRootFromCwd, refreshWorktreeCacheSync, resolveWorktreePath } from "../../worktree.js";

const execFileAsync = promisify(execFile);

type WorktreeRoutesDeps = {
  fastify: FastifyInstance;
  worktrees: {
    listWorktrees: (projectRoot?: string | null) => {
      worktrees: Array<{ name: string; path: string; branch: string }>;
      repoRoot: string;
    };
    listBranches: (projectRoot: string | null) => Promise<Array<{ name: string }>>;
    defaultBranch: (projectRoot: string | null) => Promise<string>;
    resolveProjectRoot: (raw: unknown) => Promise<string | null>;
    worktreeStatus: (path: string) => Promise<{ dirty: boolean; branch: string; changes: string[] }>;
    removeWorktree: (path: string) => Promise<void>;
    directoryExists: (path: string) => Promise<boolean>;
    isKnownWorktreePath: (path: string) => boolean;
    createWorktreeFromBase: (options: { projectRoot?: string | null; branch: string; baseBranch?: string }) => Promise<string>;
    isBranchFormatLikelySafe: (branch: string) => boolean;
  };
  scanner: WorktreeScanner;
  reaper: ReapService;
  store: SqliteStore;
};

export function registerWorktreeRoutes(deps: WorktreeRoutesDeps): void {
  const { fastify, worktrees, scanner, reaper, store } = deps;

  fastify.get("/api/directory-exists", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const rawPath = typeof q.path === "string" ? q.path.trim() : "";
    if (!rawPath) {
      reply.code(400);
      return { error: "path is required" };
    }
    const exists = await worktrees.directoryExists(rawPath);
    return { exists };
  });

  fastify.get("/api/worktrees", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const rawProjectRoot = typeof q.projectRoot === "string" ? q.projectRoot.trim() : "";
    const projectRoot = await worktrees.resolveProjectRoot(q.projectRoot);
    if (rawProjectRoot && !projectRoot) {
      reply.code(400);
      return { error: `project directory is not a git repository: ${rawProjectRoot}` };
    }
    if (q.full === "1" || q.full === "true") {
      const bare = worktrees.listWorktrees(projectRoot);
      try {
        return await scanner.getFullFresh(bare.repoRoot);
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return worktrees.listWorktrees(projectRoot);
  });

  fastify.post("/api/worktrees/scan", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const rawProjectRoot = typeof body.projectRoot === "string" ? body.projectRoot.trim() : "";
    const projectRoot = await worktrees.resolveProjectRoot(body.projectRoot);
    if (rawProjectRoot && !projectRoot) {
      reply.code(400);
      return { error: `project directory is not a git repository: ${rawProjectRoot}` };
    }
    const repoRoot = projectRoot ?? worktrees.listWorktrees(null).repoRoot;
    try {
      return await scanner.scan(repoRoot, {
        fetchPrune: body.fetchPrune === true,
        expensive: body.expensive === true,
        verifyProofs: body.fetchPrune === true || body.verifyProofs === true,
      });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  fastify.post("/api/worktrees/create", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const projectRoot = await worktrees.resolveProjectRoot(body.projectRoot);
    if (!projectRoot) {
      reply.code(400);
      return { error: "projectRoot must be an existing git repository" };
    }
    const branch = typeof body.branch === "string" && body.branch.trim() ? body.branch.trim() : generateBranchName();
    if (!worktrees.isBranchFormatLikelySafe(branch)) {
      reply.code(400);
      return { error: "invalid branch name" };
    }
    const baseBranch = typeof body.baseBranch === "string" && body.baseBranch.trim() ? body.baseBranch.trim() : undefined;
    const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "";
    const ticket = typeof body.ticket === "string" ? body.ticket.trim() : "";
    // A linked-worktree projectRoot would anchor the path template in the wrong
    // place; normalize to the main repo root first.
    const repoRoot = gitRepoRootFromCwd(projectRoot) ?? projectRoot;
    try {
      const wtPath = await worktrees.createWorktreeFromBase({ projectRoot: repoRoot, branch, baseBranch });
      // Purpose lives in both places: git (travels with the repo) and the row (survives reaping).
      if (purpose) {
        try {
          await execFileAsync("git", ["config", `branch.${branch}.description`, purpose], { cwd: repoRoot, timeout: 10_000 });
        } catch {
          // description is a bonus mirror; the row below is authoritative
        }
      }
      store.upsertWorktreeObservation({
        repoRoot,
        path: wtPath,
        branch,
        state: "unknown",
        stateDetail: {},
        scannedAt: Date.now(),
        origin: "agmux",
      });
      store.setWorktreeMeta(repoRoot, wtPath, {
        ...(purpose ? { label: purpose } : {}),
        ...(ticket ? { ticketId: ticket } : {}),
      });
      void scanner.scan(repoRoot).catch(() => {});
      return { path: wtPath, branch };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  fastify.post("/api/worktrees/reap", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const rawPath = typeof body.path === "string" ? body.path.trim() : "";
    const expectedHead = typeof body.expectedHead === "string" ? body.expectedHead.trim() : "";
    if (!rawPath || !expectedHead) {
      reply.code(400);
      return { error: "path and expectedHead are required" };
    }
    try {
      const result = await reaper.reap({
        path: rawPath,
        expectedHead,
        expectedStatusHash: typeof body.expectedStatusHash === "string" ? body.expectedStatusHash : undefined,
        salvage: body.salvage !== false,
        deleteBranch: body.deleteBranch === "never" || body.deleteBranch === "force" ? body.deleteBranch : "auto",
      });
      if (result.ok && result.repoRoot) {
        scanner.invalidate(result.repoRoot);
        void scanner.scan(result.repoRoot).catch(() => {});
      }
      return result;
    } catch (err) {
      // Unexpected throws surface as guard refusals: the UI treats transport
      // errors (500) differently from ok:false.
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  fastify.post("/api/branches/drop", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const projectRoot = await worktrees.resolveProjectRoot(body.repoRoot);
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";
    if (!projectRoot || !branch) {
      reply.code(400);
      return { error: "repoRoot (a git repository) and branch are required" };
    }
    try {
      const result = await reaper.dropBranch({ repoRoot: projectRoot, branch });
      if (result.ok) void scanner.scan(projectRoot).catch(() => {});
      return result;
    } catch (err) {
      // Same contract as reap: never a bare 500 for an unexpected throw.
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  fastify.post("/api/worktrees/move", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const rawPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!rawPath) {
      reply.code(400);
      return { error: "path is required" };
    }
    const resolved = path.resolve(rawPath);
    const repoRoot = gitRepoRootFromCwd(resolved);
    if (!repoRoot || !worktrees.isKnownWorktreePath(resolved)) {
      reply.code(400);
      return { error: "path is not a known worktree" };
    }
    try {
      // Read the branch live — scanner cache is empty after restart and can be stale.
      let branch = "";
      try {
        const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: resolved, timeout: 10_000 });
        branch = stdout.trim();
      } catch {
        branch = "";
      }
      if (!branch || branch === "HEAD") {
        reply.code(400);
        return { error: "cannot move a detached worktree to a canonical path" };
      }
      let template = "";
      try {
        const { stdout } = await execFileAsync("git", ["config", "--get", "agmux.worktreeTemplate"], { cwd: repoRoot, timeout: 10_000 });
        template = stdout.trim();
      } catch {
        template = "";
      }
      if (!template) {
        const settings = store.getPreference<{ worktreePathTemplate?: string }>("settings");
        template = settings?.worktreePathTemplate || "../{repo-name}-{branch}";
      }
      const target = resolveWorktreePath(repoRoot, branch, template);
      if (target === resolved) return { ok: true, newPath: resolved };
      await execFileAsync("git", ["worktree", "move", resolved, target], { cwd: repoRoot, timeout: 60_000 });
      store.moveWorktreePath(repoRoot, resolved, target);
      refreshWorktreeCacheSync(repoRoot);
      scanner.invalidate(repoRoot);
      void scanner.scan(repoRoot).catch(() => {});
      return { ok: true, newPath: target };
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  fastify.patch("/api/worktrees/label", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const rawPath = typeof body.path === "string" ? body.path.trim() : "";
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!rawPath) {
      reply.code(400);
      return { error: "path is required" };
    }
    const resolved = path.resolve(rawPath);
    const repoRoot = gitRepoRootFromCwd(resolved);
    if (!repoRoot) {
      reply.code(400);
      return { error: "path is not inside a git repository" };
    }
    store.setWorktreeMeta(repoRoot, resolved, { label: label || null });
    const row = store.getWorktreeRowByPath(repoRoot, resolved);
    if (label && row?.branch) {
      try {
        await execFileAsync("git", ["config", `branch.${row.branch}.description`, label], { cwd: repoRoot, timeout: 10_000 });
      } catch {
        // best-effort mirror
      }
    }
    return { ok: true };
  });

  fastify.get("/api/worktrees/context", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const rawPath = typeof q.path === "string" ? q.path.trim() : "";
    if (!rawPath) {
      reply.code(400);
      return { error: "path is required" };
    }
    const resolved = path.resolve(rawPath);
    // Path-keyed lookup: the dir may already be deleted, so no repo-root probe.
    // Prefer the newest live row; only a tombstoned row yields a tombstone.
    const rows = store.findWorktreeRowsByPath(resolved);
    const row = rows.find((r) => r.reaped_at == null) ?? rows[0];
    const sessions = store.listAgentSessionsByCwdPrefix(resolved);
    const tombstone = row?.reaped_at
      ? {
          path: row.path,
          branch: row.branch,
          label: row.label,
          ticketId: row.ticket_id,
          prTitle: row.pr_title,
          firstPrompt: row.first_prompt,
          reapedAt: row.reaped_at,
          reapEvidence: row.reap_evidence,
          salvagePath: row.salvage_path,
          atticTag: row.attic_tag,
        }
      : null;
    return { sessions, tombstone };
  });

  fastify.get("/api/default-branch", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const rawProjectRoot = typeof q.projectRoot === "string" ? q.projectRoot.trim() : "";
    const projectRoot = await worktrees.resolveProjectRoot(q.projectRoot);
    if (rawProjectRoot && !projectRoot) {
      reply.code(400);
      return { error: `project directory is not a git repository: ${rawProjectRoot}` };
    }
    const branch = await worktrees.defaultBranch(projectRoot);
    return { branch };
  });

  fastify.get("/api/branches", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const rawProjectRoot = typeof q.projectRoot === "string" ? q.projectRoot.trim() : "";
    const projectRoot = await worktrees.resolveProjectRoot(q.projectRoot);
    if (rawProjectRoot && !projectRoot) {
      reply.code(400);
      return { error: `project directory is not a git repository: ${rawProjectRoot}` };
    }
    const [branches, defaultBranch] = await Promise.all([
      worktrees.listBranches(projectRoot),
      worktrees.defaultBranch(projectRoot),
    ]);
    return { branches, defaultBranch };
  });

  fastify.get("/api/worktrees/status", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const wtPath = typeof q.path === "string" ? q.path.trim() : "";
    if (!wtPath) {
      reply.code(400);
      return { error: "path is required" };
    }
    if (!worktrees.isKnownWorktreePath(wtPath)) {
      reply.code(400);
      return { error: "path is not a known worktree" };
    }
    try {
      const status = await worktrees.worktreeStatus(wtPath);
      return status;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { error: message };
    }
  });

  fastify.delete("/api/worktrees", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const rawPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!rawPath) {
      reply.code(400);
      return { error: "path is required" };
    }
    if (!worktrees.isKnownWorktreePath(rawPath)) {
      reply.code(400);
      return { error: "path is not a known worktree" };
    }
    try {
      // Dirty trees must go through the reap funnel, which salvages first.
      const status = await worktrees.worktreeStatus(rawPath);
      if (status.dirty) {
        reply.code(409);
        return { error: "worktree has uncommitted changes; use /api/worktrees/reap" };
      }
      await worktrees.removeWorktree(rawPath);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { error: message };
    }
  });
}
