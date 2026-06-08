import path from "node:path";
import { AUTH_ENABLED, AUTH_TOKEN, HOST, PORT, REPO_ROOT } from "./config.js";

export type AgentReadyProvider = "claude" | "codex";

const CALLBACK_HOST = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;

export const AGMUX_API_BASE = `http://${CALLBACK_HOST}:${PORT}`;
export const AGMUX_READY_HELPER = path.resolve(REPO_ROOT, "scripts/agent-ready.mjs");

export function isAgentReadyProvider(value: unknown): value is AgentReadyProvider {
  return value === "claude" || value === "codex";
}

export function buildAgentReadyEnvExports(ptyId: string, tmuxSession: string | null | undefined): string {
  const lines = [
    `export AGMUX_PTY_ID=${shQuote(ptyId)}`,
    `export AGMUX_API_BASE=${shQuote(AGMUX_API_BASE)}`,
    `export AGMUX_READY_HELPER=${shQuote(AGMUX_READY_HELPER)}`,
  ];
  if (tmuxSession && tmuxSession.trim().length > 0) {
    lines.push(`export AGMUX_TMUX_SESSION=${shQuote(tmuxSession.trim())}`);
  } else {
    lines.push("unset AGMUX_TMUX_SESSION");
  }
  if (AUTH_ENABLED) {
    lines.push(`export AGMUX_TOKEN=${shQuote(AUTH_TOKEN)}`);
  } else {
    lines.push("unset AGMUX_TOKEN");
  }
  return lines.join("; ");
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
