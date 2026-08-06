import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerSettingsRoutes } from "../src/server/routes/settings.js";

function setup(initial: Record<string, unknown> = {}) {
  const fastify = Fastify();
  let settings = initial;
  const store = {
    getPreference: (key: string) => key === "settings" ? settings : null,
    setPreference: (key: string, value: Record<string, unknown>) => {
      if (key === "settings") settings = value;
    },
  } as any;
  registerSettingsRoutes({ fastify, store });
  return { fastify, readSettings: () => settings };
}

describe("settings routes", () => {
  it("normalizes persisted Claude presets on read", async () => {
    const { fastify } = setup({
      worktreePathTemplate: "../{repo-name}-{branch}",
      claudeModelPresets: [
        { id: "fast", name: "Fast", model: "sonnet", effort: "low" },
        { id: "bad", name: "Bad", model: "opus\n/exit", effort: "high" },
      ],
    });

    const response = await fastify.inject({ method: "GET", url: "/api/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      worktreePathTemplate: "../{repo-name}-{branch}",
      claudeModelPresets: [
        { id: "fast", name: "Fast", model: "sonnet", effort: "low" },
      ],
    });
    await fastify.close();
  });

  it("validates and persists Claude presets", async () => {
    const { fastify, readSettings } = setup({ worktreePathTemplate: "../custom" });

    const response = await fastify.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        claudeModelPresets: [
          { id: "deep", name: "Deep", model: "opus", effort: "max" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(readSettings()).toEqual({
      worktreePathTemplate: "../custom",
      claudeModelPresets: [
        { id: "deep", name: "Deep", model: "opus", effort: "max" },
      ],
    });
    await fastify.close();
  });

  it("rejects malformed Claude presets without changing settings", async () => {
    const initial = { worktreePathTemplate: "../custom" };
    const { fastify, readSettings } = setup(initial);

    const response = await fastify.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        claudeModelPresets: [
          { id: "bad", name: "Bad", model: "opus\r/exit", effort: "high" },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "preset 1: model must be a single terminal argument" });
    expect(readSettings()).toEqual(initial);
    await fastify.close();
  });

  it("validates and persists keybinding overrides", async () => {
    const { fastify, readSettings } = setup({ worktreePathTemplate: "../custom" });

    const response = await fastify.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        keybindings: {
          claudeModelPreset: { code: "KeyM", ctrl: false, shift: true, alt: true, meta: false },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(readSettings()).toEqual({
      worktreePathTemplate: "../custom",
      keybindings: {
        claudeModelPreset: { code: "KeyM", ctrl: false, shift: true, alt: true, meta: false },
      },
    });
    await fastify.close();
  });

  it("rejects unsafe keybinding overrides without changing settings", async () => {
    const initial = { worktreePathTemplate: "../custom" };
    const { fastify, readSettings } = setup(initial);

    const response = await fastify.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        keybindings: {
          claudeModelPreset: { code: "KeyM", ctrl: false, shift: true, alt: false, meta: false },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "keybinding claudeModelPreset: shortcut must include Ctrl, Alt, or Meta",
    });
    expect(readSettings()).toEqual(initial);
    await fastify.close();
  });
});
