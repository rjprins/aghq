import { execFile, execSync, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import chokidar from "chokidar";

const repo = process.cwd();
const binExt = process.platform === "win32" ? ".cmd" : "";
const tscPath = path.join(repo, "node_modules", ".bin", `tsc${binExt}`);

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4821;
const host = process.env.HOST ?? DEFAULT_HOST;
const requestedPort = Number(process.env.PORT ?? process.env.APP_PORT ?? String(DEFAULT_PORT));
const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : DEFAULT_PORT;

function getPortListeners(p) {
  try {
    const out = execSync(`ss -H -ltnp 'sport = :${p}'`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function checkPortAvailable(bindHost, p) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen({ host: bindHost, port: p }, () => {
        probe.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE") {
      const lines = getPortListeners(p);
      if (lines.length > 0) {
        console.error(`Port ${p} on host ${bindHost} is already in use:\n${lines.join("\n")}\n`);
      } else {
        console.error(`Port ${p} on host ${bindHost} is already in use.\n`);
      }
      console.error(`Stop the process using it, or pick a different port:\n  PORT=${p + 2} npm run dev\n`);
      process.exit(2);
    }
    throw err;
  } finally {
    if (probe.listening) {
      await new Promise((resolve, reject) => {
        probe.close((closeErr) => {
          if (closeErr) reject(closeErr);
          else resolve();
        });
      });
    }
  }
}

function spawnChild(cmd, args, label, extraEnv = {}) {
  const child = spawn(cmd, args, {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[dev] ${label} exited with signal ${signal}`);
    } else if (code && code !== 0) {
      console.error(`[dev] ${label} exited with code ${code}`);
    }
  });
  return child;
}

await checkPortAvailable(host, port);

// Build UI once before starting the server.
console.log("[dev] Building UI...");
execSync("node scripts/build-ui.mjs", { cwd: repo, stdio: "inherit" });

// Watch src/ui/ for changes and rebuild UI automatically.
let rebuildTimer = null;
function scheduleRebuild() {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    console.log("[dev] UI source changed, rebuilding...");
    try {
      execSync("node scripts/build-ui.mjs", { cwd: repo, stdio: "inherit" });
    } catch (err) {
      console.error("[dev] UI rebuild failed:", err.message);
    }
  }, 200);
}

const uiDir = path.join(repo, "src", "ui");
const uiWatcher = chokidar.watch(uiDir, { ignoreInitial: true });
uiWatcher.on("all", (_event, filename) => {
  if (filename.endsWith(".ts") || filename.endsWith(".tsx") || filename.endsWith(".css")) {
    scheduleRebuild();
  }
});

console.log("[dev] Starting TypeScript compiler in watch mode...");
const tsc = spawnChild(tscPath, ["-p", "tsconfig.json", "--watch"], "tsc");

// Restart the server explicitly. Node's --watch-path is not reliably recursive
// for nested source files on every platform.
console.log("[dev] Starting server (watch mode)...");
let shuttingDown = false;
let restartingServer = false;
let serverRestartTimer = null;
let server = spawnServer();

const srcDir = path.join(repo, "src");
const serverWatcher = chokidar.watch(srcDir, { ignoreInitial: true });
serverWatcher.on("all", (_event, filename) => {
  if (!filename.endsWith(".ts") && !filename.endsWith(".tsx")) return;
  const resolved = path.resolve(filename);
  if (resolved.startsWith(`${uiDir}${path.sep}`)) return;
  scheduleServerRestart();
});

function spawnServer() {
  const child = spawnChild(
    process.execPath,
    ["--import", "tsx", "src/server.ts"],
    "server",
    {
      PORT: String(port),
      // Prevent the Node server from opening a browser on every restart.
      AGMUX_NO_OPEN: "1",
    },
  );
  child.on("exit", (code) => {
    if (shuttingDown || restartingServer) return;
    if (code && code !== 0) shutdown(code);
  });
  return child;
}

function scheduleServerRestart() {
  if (serverRestartTimer) return;
  serverRestartTimer = setTimeout(() => {
    serverRestartTimer = null;
    restartServer();
  }, 200);
}

function restartServer() {
  if (shuttingDown || restartingServer) return;
  console.log("[dev] Server source changed, restarting...");
  restartingServer = true;
  const previous = server;
  let restarted = false;
  const forceTimer = setTimeout(() => {
    if (previous.exitCode === null && previous.signalCode === null) {
      previous.kill("SIGKILL");
    }
  }, 5000);
  previous.once("exit", () => {
    if (restarted) return;
    restarted = true;
    clearTimeout(forceTimer);
    restartingServer = false;
    server = spawnServer();
  });
  previous.kill("SIGINT");
}

// Open the browser once the server is actually listening.
const appUrl = `http://127.0.0.1:${port}`;
console.log(`[dev] app: ${appUrl}`);

if (process.env.AGMUX_NO_OPEN !== "1") {
  const open =
    process.platform === "darwin"
      ? ["open", [appUrl]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", appUrl]]
        : ["xdg-open", [appUrl]];

  const poll = async () => {
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(appUrl);
        if (res.ok) return true;
      } catch {
        // Server not ready yet.
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  };
  poll().then((ok) => {
    if (ok) execFile(open[0], open[1], () => {});
  });
}

function shutdown(code) {
  shuttingDown = true;
  void uiWatcher.close();
  void serverWatcher.close();
  if (!tsc.killed) tsc.kill("SIGINT");
  if (!server.killed) server.kill("SIGINT");
  process.exit(code);
}

tsc.on("exit", (code) => {
  if (code && code !== 0) shutdown(code);
});

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
