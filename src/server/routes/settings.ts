import type { FastifyInstance } from "fastify";
import type { SqliteStore } from "../../persist/sqlite.js";
import {
  parseClaudeModelPresets,
  validateClaudeModelPresets,
} from "../../shared/claude-model-presets.js";
import {
  parseKeybindingOverrides,
  validateKeybindingOverrides,
} from "../../shared/keybindings.js";
import { parseJsonBody } from "../auth.js";

type SettingsRoutesDeps = {
  fastify: FastifyInstance;
  store: SqliteStore;
};

export function registerSettingsRoutes(deps: SettingsRoutesDeps): void {
  const { fastify, store } = deps;

  fastify.get("/api/launch-preferences", async (req) => {
    const query = req.query as Record<string, unknown>;
    const projectRoot = typeof query.projectRoot === "string" ? query.projectRoot.trim() : null;
    const global = store.getPreference<Record<string, unknown>>("launch") ?? {};
    if (!projectRoot) return global;
    const perProject = store.getPreference<Record<string, unknown>>(`launch:${projectRoot}`) ?? {};
    return { ...global, ...perProject };
  });

  fastify.put("/api/launch-preferences", async (req) => {
    const body = parseJsonBody(req.body) as Record<string, unknown>;
    const { projectRoot, ...prefs } = body;
    const key = typeof projectRoot === "string" && projectRoot.trim()
      ? `launch:${projectRoot.trim()}`
      : "launch";
    const prev = store.getPreference<Record<string, unknown>>(key) ?? {};
    const merged = { ...prev, ...prefs };
    store.setPreference(key, merged);
    return merged;
  });

  fastify.get("/api/settings", async () => {
    const stored = store.getPreference<Record<string, unknown>>("settings") ?? {};
    const settings = { ...stored };
    if ("claudeModelPresets" in settings) {
      settings.claudeModelPresets = parseClaudeModelPresets(settings.claudeModelPresets);
    }
    if ("keybindings" in settings) {
      settings.keybindings = parseKeybindingOverrides(settings.keybindings);
    }
    return settings;
  });

  fastify.put("/api/settings", async (req, reply) => {
    const body = { ...parseJsonBody(req.body) };
    if ("claudeModelPresets" in body) {
      try {
        body.claudeModelPresets = validateClaudeModelPresets(body.claudeModelPresets);
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    if ("keybindings" in body) {
      try {
        body.keybindings = validateKeybindingOverrides(body.keybindings);
      } catch (err) {
        reply.code(400);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
    const prev = store.getPreference<Record<string, unknown>>("settings") ?? {};
    const merged = { ...prev, ...body };
    for (const [k, v] of Object.entries(merged)) {
      if (v === null) delete merged[k];
    }
    store.setPreference("settings", merged);
    return merged;
  });
}
