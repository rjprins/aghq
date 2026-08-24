import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerAzurePrRoutes } from "../src/server/routes/azure-pr.js";

function setup() {
  const fastify = Fastify();
  const acknowledgements: unknown[] = [];
  registerAzurePrRoutes({
    fastify,
    store: {} as any,
    listPtys: async () => [],
    resolveProjectRoot: async (value) => value === "/repo" ? "/repo" : null,
    prMenu: {
      list: async () => ({ supported: true as const, projectRoot: "/repo", fetchedAt: 123, prs: [] }),
      acknowledge: async (_projectRoot, markers) => {
        acknowledgements.push(markers);
      },
    },
  });
  return { fastify, acknowledgements };
}

describe("Azure PR menu routes", () => {
  it("lists PR menu data for a valid project root", async () => {
    const { fastify } = setup();
    const response = await fastify.inject({
      method: "GET",
      url: "/api/azure-pr/menu?projectRoot=%2Frepo",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ supported: true, projectRoot: "/repo", fetchedAt: 123, prs: [] });
    await fastify.close();
  });

  it("rejects missing or invalid project roots", async () => {
    const { fastify } = setup();

    expect((await fastify.inject({ method: "GET", url: "/api/azure-pr/menu" })).statusCode).toBe(400);
    expect((await fastify.inject({
      method: "GET",
      url: "/api/azure-pr/menu?projectRoot=%2Fmissing",
    })).statusCode).toBe(400);
    await fastify.close();
  });

  it("validates and forwards exact viewed attention markers", async () => {
    const { fastify, acknowledgements } = setup();
    const response = await fastify.inject({
      method: "POST",
      url: "/api/azure-pr/menu/viewed",
      payload: {
        projectRoot: "/repo",
        markers: [
          { id: 10, attention: "new" },
          { id: 11, attention: "published" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(acknowledgements).toEqual([[
      { id: 10, attention: "new" },
      { id: 11, attention: "published" },
    ]]);
    await fastify.close();
  });

  it("rejects malformed viewed markers", async () => {
    const { fastify, acknowledgements } = setup();
    const response = await fastify.inject({
      method: "POST",
      url: "/api/azure-pr/menu/viewed",
      payload: {
        projectRoot: "/repo",
        markers: [{ id: "10", attention: "everything" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(acknowledgements).toEqual([]);
    await fastify.close();
  });
});
