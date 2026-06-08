import Fastify from "fastify";
import { execFile } from "node:child_process";
import process from "node:process";

import { LogSessionDiscovery } from "./logSessions.js";
import { SqliteStore } from "./persist/sqlite.js";
import { createAgentSessionService } from "./server/agent-sessions.js";
import { registerAuthHook } from "./server/auth.js";
import {
  AGMUX_SESSION,
  AUTH_ENABLED,
  AUTH_TOKEN,
  AUTH_TOKEN_SOURCE,
  DB_PATH,
  DEFAULT_BASE_BRANCH,
  HOST,
  LOG_LEVEL,
  LOG_SESSION_CACHE_MS,
  LOG_SESSION_DISCOVERY_ENABLED,
  LOG_SESSION_SCAN_MAX,
  PORT,
  PUBLIC_DIR,
  READINESS_TRACE_LOG,
  READINESS_TRACE_MAX,
  REPO_ROOT,
  TRIGGERS_PATH,
  assertLoopbackHostAllowed,
} from "./server/config.js";
import { createRuntime } from "./server/pty-runtime.js";
import { registerAgentRoutes } from "./server/routes/agents.js";
import { registerPtyRoutes } from "./server/routes/ptys.js";
import { registerSettingsRoutes } from "./server/routes/settings.js";
import { registerStaticRoutes } from "./server/routes/static.js";
import { registerTmuxRoutes } from "./server/routes/tmux.js";
import { registerTaskRoutes } from "./server/routes/tasks.js";
import { registerTriggerRoutes } from "./server/routes/triggers.js";
import { registerWorktreeRoutes } from "./server/routes/worktrees.js";
import { createWorktreeService } from "./server/worktrees.js";
import { registerWs } from "./server/ws.js";

assertLoopbackHostAllowed();

const fastify = Fastify({
  logger: { level: LOG_LEVEL },
  disableRequestLogging: true,
});

const store = new SqliteStore(DB_PATH);
const logSessionDiscovery = new LogSessionDiscovery({
  enabled: LOG_SESSION_DISCOVERY_ENABLED,
  scanLimit: LOG_SESSION_SCAN_MAX,
  cacheMs: LOG_SESSION_CACHE_MS,
});

const worktrees = createWorktreeService({
  repoRoot: REPO_ROOT,
  store,
  defaultBaseBranch: DEFAULT_BASE_BRANCH,
});

const agentSessions = createAgentSessionService({
  store,
  logSessionDiscovery,
  repoRoot: REPO_ROOT,
});

const runtime = createRuntime({
  store,
  logger: fastify.log,
  agentSessions,
  readinessTraceMax: READINESS_TRACE_MAX,
  readinessTraceLog: READINESS_TRACE_LOG,
  triggersPath: TRIGGERS_PATH,
  agmuxSession: AGMUX_SESSION,
  refreshWorktrees: () => worktrees.refreshCache(),
});

registerAuthHook(fastify);

registerAgentRoutes({
  fastify,
  store,
  agentSessions,
  worktrees,
  runtime,
  repoRoot: REPO_ROOT,
  agmuxSession: AGMUX_SESSION,
});

registerWorktreeRoutes({ fastify, worktrees });
registerTmuxRoutes({ fastify });
registerSettingsRoutes({ fastify, store });
registerTaskRoutes({ fastify, store });
registerPtyRoutes({
  fastify,
  store,
  agentSessions,
  runtime,
  worktrees,
  defaultBaseBranch: DEFAULT_BASE_BRANCH,
  agmuxSession: AGMUX_SESSION,
});
registerTriggerRoutes({ fastify, loadTriggersAndBroadcast: runtime.loadTriggersAndBroadcast });
registerStaticRoutes({ fastify, publicDir: PUBLIC_DIR });

registerWs({
  fastify,
  hub: runtime.hub,
  ptys: runtime.ptys,
  readinessEngine: runtime.readinessEngine,
  listPtys: runtime.listPtys,
});

function openBrowser(url: string): void {
  const plat = process.platform;
  if (plat === "darwin") {
    execFile("open", [url], () => {});
  } else if (plat === "win32") {
    execFile("cmd", ["/c", "start", url], () => {});
  } else {
    execFile("xdg-open", [url], () => {});
  }
}

await runtime.loadTriggersAndBroadcast("startup");
runtime.triggerLoader.watch(() => void runtime.loadTriggersAndBroadcast("watch"));
await runtime.restoreAtStartup();

await fastify.listen({ host: HOST, port: PORT });

const appUrl = `http://${HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST}:${PORT}`;
const appUrlWithToken = AUTH_ENABLED ? `${appUrl}/?token=${encodeURIComponent(AUTH_TOKEN)}` : appUrl;
console.log(`[agmux] Ready at ${appUrl}`);
console.log(`[agmux] Log level: ${LOG_LEVEL}`);
if (AUTH_ENABLED) {
  console.log(`[agmux] Auth token enabled via AGMUX_TOKEN_ENABLED=1 (${AUTH_TOKEN_SOURCE}).`);
  console.log(`[agmux] Token: ${AUTH_TOKEN}`);
  console.log(`[agmux] URL with token: ${appUrlWithToken}`);
  if (AUTH_TOKEN_SOURCE === "generated") {
    console.log("[agmux] Token was generated because AGMUX_TOKEN was unset.");
  }
} else {
  console.log("[agmux] Auth token disabled (opt-in). Set AGMUX_TOKEN_ENABLED=1 to enable API/WS auth.");
}

if (process.env.AGMUX_NO_OPEN !== "1") {
  openBrowser(appUrlWithToken);
}
