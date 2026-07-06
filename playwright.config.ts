import { defineConfig } from "@playwright/test";

const DEFAULT_E2E_APP_PORT = 4956;
const requestedPort = Number(process.env.E2E_APP_PORT ?? String(DEFAULT_E2E_APP_PORT));
const appPort = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_E2E_APP_PORT;
const appUrl = `http://127.0.0.1:${appPort}`;
const e2eToken = process.env.E2E_AGMUX_TOKEN ?? "e2e-token";
const e2eSuffix =
  process.env.E2E_TMUX_SUFFIX ??
  `${Date.now().toString(36)}-${process.pid}-${Math.floor(Math.random() * 1_000_000).toString(36)}`;
// Suffix the DB per run: a reused DB leaks agent sessions from earlier runs
// (and from misbehaving tests) into session lists and naming.
const dbPath = process.env.E2E_DB_PATH ?? `/tmp/agmux-e2e-${appPort}-${e2eSuffix}.db`;
const tmuxSocket = process.env.E2E_TMUX_SOCKET ?? `agmux-e2e-${e2eSuffix}`;
const tmuxSession = process.env.E2E_TMUX_SESSION ?? `agmux-e2e-${e2eSuffix}`;
// Isolate agent-session discovery from the developer's real ~/.claude, ~/.codex
// and ~/.pi so tests neither see real sessions nor touch real files.
const agentLogRoot = process.env.E2E_AGENT_LOG_ROOT ?? `/tmp/agmux-e2e-logs-${e2eSuffix}`;

process.env.AGMUX_TMUX_SOCKET = tmuxSocket;
process.env.AGMUX_TMUX_SESSION = tmuxSession;
process.env.E2E_TMUX_SOCKET = tmuxSocket;
process.env.E2E_TMUX_SESSION = tmuxSession;
process.env.E2E_AGENT_LOG_ROOT = agentLogRoot;

export default defineConfig({
  globalTeardown: "./e2e/global-teardown.ts",
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: appUrl,
    browserName: "chromium",
    launchOptions: {
      // Use system Chromium if available, otherwise fall back to Playwright's managed browser.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
    },
  },
  webServer: {
    command: `HOST=127.0.0.1 AGMUX_TMUX_SOCKET=${tmuxSocket} AGMUX_TMUX_SESSION=${tmuxSession} AGMUX_TOKEN_ENABLED=1 AGMUX_TOKEN=${e2eToken} AGMUX_SHELL=bash AGMUX_SHELL_BACKEND=pty AGMUX_NO_OPEN=1 CLAUDE_CONFIG_DIR=${agentLogRoot}/claude CODEX_HOME=${agentLogRoot}/codex PI_HOME=${agentLogRoot}/pi AGMUX_AUTO_ATTACH_INTERVAL_MS=2000 DB_PATH=${dbPath} PORT=${appPort} npm run -s app`,
    url: appUrl,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
