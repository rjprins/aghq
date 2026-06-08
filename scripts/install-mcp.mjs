#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "dist", "mcp", "server.js");
const apiBase = process.env.AGMUX_API_BASE?.trim() || `http://127.0.0.1:${process.env.PORT || "4821"}`;
const token = process.env.AGMUX_TOKEN?.trim();
const target = process.argv[2] || "all";

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: opts.quiet ? "ignore" : "inherit",
    shell: false,
  });
  if (res.error) {
    if (opts.optional) return false;
    throw res.error;
  }
  if (res.status !== 0 && !opts.optional) {
    process.exit(res.status ?? 1);
  }
  return res.status === 0;
}

function ensureCommand(command) {
  const ok = run(command, ["--version"], { quiet: true, optional: true });
  if (!ok) {
    console.error(`Missing required command: ${command}`);
    process.exit(1);
  }
}

function envArgs() {
  return [
    "--env", `AGMUX_API_BASE=${apiBase}`,
    ...(token ? ["--env", `AGMUX_TOKEN=${token}`] : []),
  ];
}

function installCodex() {
  ensureCommand("codex");
  run("codex", ["mcp", "remove", "agmux"], { quiet: true, optional: true });
  run("codex", [
    "mcp",
    "add",
    "agmux",
    ...envArgs(),
    "--",
    "node",
    serverPath,
  ]);
}

function installClaude() {
  ensureCommand("claude");
  run("claude", ["mcp", "remove", "agmux"], { quiet: true, optional: true });
  const config = {
    type: "stdio",
    command: "node",
    args: [serverPath],
    env: {
      AGMUX_API_BASE: apiBase,
      ...(token ? { AGMUX_TOKEN: token } : {}),
    },
  };
  run("claude", [
    "mcp",
    "add-json",
    "--scope",
    "user",
    "agmux",
    JSON.stringify(config),
  ]);
}

if (!["all", "codex", "claude"].includes(target)) {
  console.error("Usage: npm run mcp:install [-- all|codex|claude]");
  process.exit(1);
}

run("npm", ["run", "build"]);

if (target === "all" || target === "codex") installCodex();
if (target === "all" || target === "claude") installClaude();

console.log(`agmux MCP installed for ${target === "all" ? "Codex and Claude" : target}.`);
console.log(`AGMUX_API_BASE=${apiBase}`);
if (!token) console.log("AGMUX_TOKEN was not set; this is fine when agmux token auth is disabled.");
