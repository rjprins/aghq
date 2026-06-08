import type { FastifyInstance } from "fastify";

import type { PtySummary } from "../../types.js";
import type { SqliteStore } from "../../persist/sqlite.js";
import { parseJsonBody } from "../auth.js";
import { getPrComments, parseAzurePrUrl } from "../azure-pr.js";
import { markPrViewed } from "../azure-pr-poller.js";

type AzurePrRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
  listPtys: () => Promise<PtySummary[]>;
};

export function registerAzurePrRoutes(deps: AzurePrRoutesDeps): void {
  const { fastify, store, listPtys } = deps;

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
