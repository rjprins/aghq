import type { FastifyInstance } from "fastify";
import { parseJsonBody } from "../auth.js";

type WorktreeRoutesDeps = {
  fastify: FastifyInstance;
  worktrees: {
    listWorktrees: (projectRoot?: string | null) => {
      worktrees: Array<{ name: string; path: string; branch: string }>;
      repoRoot: string;
    };
    defaultBranch: (projectRoot: string | null) => Promise<string>;
    resolveProjectRoot: (raw: unknown) => Promise<string | null>;
    worktreeStatus: (path: string) => Promise<{ dirty: boolean; branch: string; changes: string[] }>;
    removeWorktree: (path: string) => Promise<void>;
    directoryExists: (path: string) => Promise<boolean>;
    isKnownWorktreePath: (path: string) => boolean;
  };
};

export function registerWorktreeRoutes(deps: WorktreeRoutesDeps): void {
  const { fastify, worktrees } = deps;

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
    return worktrees.listWorktrees(projectRoot);
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
      await worktrees.removeWorktree(rawPath);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(500);
      return { error: message };
    }
  });
}
