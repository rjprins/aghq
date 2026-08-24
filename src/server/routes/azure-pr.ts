import type { FastifyInstance } from "fastify";

import type { PtySummary } from "../../types.js";
import type { SqliteStore } from "../../persist/sqlite.js";
import type { AzurePrMenuService, PrAttention } from "../azure-pr-menu.js";
import { parseJsonBody } from "../auth.js";
import { getPrComments, parseAzurePrUrl } from "../azure-pr.js";
import { markPrViewed } from "../azure-pr-poller.js";

type AzurePrRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
  listPtys: () => Promise<PtySummary[]>;
  resolveProjectRoot: (raw: unknown) => Promise<string | null>;
  prMenu: AzurePrMenuService;
};

export function registerAzurePrRoutes(deps: AzurePrRoutesDeps): void {
  const { fastify, store, listPtys, resolveProjectRoot, prMenu } = deps;

  fastify.get("/api/azure-pr/menu", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const projectRoot = await resolveProjectRoot(q.projectRoot);
    if (!projectRoot) {
      reply.code(400);
      return { error: "projectRoot must be an existing git repository" };
    }
    try {
      return await prMenu.list(projectRoot);
    } catch (err) {
      reply.code(502);
      return { error: `failed to fetch active PRs: ${String(err)}` };
    }
  });

  fastify.post("/api/azure-pr/menu/viewed", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const projectRoot = await resolveProjectRoot(body.projectRoot);
    if (!projectRoot) {
      reply.code(400);
      return { error: "projectRoot must be an existing git repository" };
    }
    if (!Array.isArray(body.markers) || body.markers.length > 1000) {
      reply.code(400);
      return { error: "markers must be an array" };
    }
    const markers: Array<{ id: number; attention: PrAttention }> = [];
    for (const value of body.markers) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        reply.code(400);
        return { error: "invalid attention marker" };
      }
      const marker = value as Record<string, unknown>;
      if (!Number.isSafeInteger(marker.id) || Number(marker.id) <= 0 ||
          (marker.attention !== "new" && marker.attention !== "published")) {
        reply.code(400);
        return { error: "invalid attention marker" };
      }
      markers.push({ id: Number(marker.id), attention: marker.attention });
    }
    await prMenu.acknowledge(projectRoot, markers);
    return { ok: true };
  });

  // Mark the PR shown on a session as viewed, clearing its new-comment flag.
  fastify.post("/api/azure-pr/viewed", async (req, reply) => {
    const body = parseJsonBody(req.body);
    const ptyId = typeof body.ptyId === "string" ? body.ptyId.trim() : "";
    if (!ptyId) {
      reply.code(400);
      return { error: "ptyId is required" };
    }
    const pr = (await listPtys()).find((p) => p.id === ptyId)?.pr;
    if (pr) markPrViewed(store, pr.id);
    return { ok: true };
  });

  // Fetch the actual review comment threads for the PR shown on a session.
  fastify.get("/api/azure-pr/threads", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const ptyId = typeof q.ptyId === "string" ? q.ptyId.trim() : "";
    if (!ptyId) {
      reply.code(400);
      return { error: "ptyId is required" };
    }
    const pr = (await listPtys()).find((p) => p.id === ptyId)?.pr;
    const parsed = pr ? parseAzurePrUrl(pr.url) : null;
    if (!parsed) return { threads: [] };
    try {
      return { threads: await getPrComments(parsed.ref, parsed.prId) };
    } catch (err) {
      reply.code(502);
      return { error: `failed to fetch PR comments: ${String(err)}` };
    }
  });
}
