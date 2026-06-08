import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";

/** Resolve the top-level git repo root (handles running inside a worktree). */
export const REPO_ROOT = (() => {
  try {
    // --git-common-dir returns the shared .git dir even from a worktree
    const gitCommon = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return path.dirname(gitCommon);
  } catch {
    return process.cwd();
  }
})();

export const HOST = process.env.HOST ?? "127.0.0.1";
export const DEFAULT_PORT = 4821;
const requestedPort = Number(process.env.PORT ?? String(DEFAULT_PORT));
export const PORT = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;
export const PUBLIC_DIR = path.resolve("public");
export const DB_PATH = process.env.DB_PATH ?? path.resolve("data/agmux.db");
export const TRIGGERS_PATH = process.env.TRIGGERS_PATH ?? path.resolve("triggers/index.js");
export const AUTH_ENABLED = /^(1|true|yes|on)$/i.test((process.env.AGMUX_TOKEN_ENABLED ?? "").trim());
export const AUTH_TOKEN = AUTH_ENABLED
  ? (process.env.AGMUX_TOKEN?.trim() || randomBytes(32).toString("hex"))
  : "";
export const AUTH_TOKEN_SOURCE = !AUTH_ENABLED
  ? "disabled"
  : (process.env.AGMUX_TOKEN?.trim() ? "configured" : "generated");
export const ALLOW_NON_LOOPBACK_BIND = process.env.AGMUX_ALLOW_NON_LOOPBACK === "1";
export const LOG_LEVEL = (process.env.AGMUX_LOG_LEVEL?.trim() || "warn").toLowerCase();
export const READINESS_TRACE_MAX = Math.max(100, Number(process.env.AGMUX_READINESS_TRACE_MAX ?? "2000") || 2000);
export const READINESS_TRACE_LOG = process.env.AGMUX_READINESS_TRACE_LOG === "1";
export const LOG_SESSION_DISCOVERY_ENABLED = process.env.AGMUX_LOG_SESSION_DISCOVERY !== "0";
export const LOG_SESSION_SCAN_MAX = Math.max(1, Number(process.env.AGMUX_LOG_SESSION_SCAN_MAX ?? "500") || 500);
export const LOG_SESSION_CACHE_MS = Math.max(
  250,
  Number(process.env.AGMUX_LOG_SESSION_CACHE_MS ?? "5000") || 5000,
);
function originHostForBindHost(host: string): string | null {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized === "0.0.0.0" || normalized === "::") return null;
  if (normalized.includes(":") && !normalized.startsWith("[") && !normalized.endsWith("]")) {
    return `[${normalized}]`;
  }
  return normalized;
}

const bindOriginHost = originHostForBindHost(HOST);
export const WS_ALLOWED_ORIGINS = new Set(
  [
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `http://[::1]:${PORT}`,
    ...(bindOriginHost ? [`http://${bindOriginHost}:${PORT}`] : []),
    ...(process.env.AGMUX_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
  ].map((v) => v.toLowerCase()),
);
export const DEFAULT_BASE_BRANCH = "main";
const DEFAULT_TMUX_SESSION = `agmux-${PORT}`;
export const AGMUX_SESSION = process.env.AGMUX_TMUX_SESSION ?? DEFAULT_TMUX_SESSION;

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

export function assertLoopbackHostAllowed(): void {
  if (!ALLOW_NON_LOOPBACK_BIND && !isLoopbackHost(HOST)) {
    throw new Error(
      `Refusing to bind to non-loopback host "${HOST}". Set AGMUX_ALLOW_NON_LOOPBACK=1 to allow.`,
    );
  }
}
