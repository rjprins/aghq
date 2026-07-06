import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TmuxServer, TmuxSessionCheck, TmuxSessionInfo } from "./shared/protocol.js";

const execFileAsync = promisify(execFile);

// Keep agmux sessions isolated from any user tmux server.
// - `-L <socket>`: use a dedicated server socket name
// - `-f /dev/null`: do not load user config; we set options explicitly
const DEFAULT_TMUX_SOCKET = process.env.PORT ? `agmux-${process.env.PORT}` : "agmux";
const TMUX_SOCKET = process.env.AGMUX_TMUX_SOCKET ?? DEFAULT_TMUX_SOCKET;
const TMUX_BASE_ARGS = ["-L", TMUX_SOCKET, "-f", "/dev/null"];
const DEBUG_ACTIVE_PROCESS = process.env.AGMUX_DEBUG_ACTIVE_PROCESS === "1";

export type { TmuxServer, TmuxSessionCheck, TmuxSessionInfo };

function debugActiveProcess(details: Record<string, unknown>): void {
  if (!DEBUG_ACTIVE_PROCESS) return;
  try {
    console.log("[agmux][active-process]", JSON.stringify(details));
  } catch {
    // ignore logging issues
  }
}

export function validateShellExecutable(shell: string): string {
  const trimmed = shell.trim();
  if (!trimmed) {
    throw new Error("shell must not be empty");
  }
  if (trimmed.startsWith("-")) {
    throw new Error("shell must not start with '-'");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("shell must be a single executable path without arguments");
  }
  if (trimmed.includes("\u0000")) {
    throw new Error("shell contains invalid NUL byte");
  }
  return trimmed;
}

async function tmuxExec(server: TmuxServer, args: string[]): Promise<{ stdout: string; stderr: string }> {
  if (server === "default") {
    return (await execFileAsync("tmux", args)) as { stdout: string; stderr: string };
  }
  return (await execFileAsync("tmux", [...TMUX_BASE_ARGS, ...args])) as { stdout: string; stderr: string };
}

async function tmuxAgent(args: string[]): Promise<void> {
  await tmuxExec("agmux", args);
}

async function tmuxDefault(args: string[]): Promise<void> {
  await tmuxExec("default", args);
}

async function tmuxByServer(server: TmuxServer, args: string[]): Promise<void> {
  if (server === "default") {
    await tmuxDefault(args);
    return;
  }
  await tmuxAgent(args);
}

async function tmuxAgentOut(args: string[]): Promise<string> {
  const { stdout } = await tmuxExec("agmux", args);
  return stdout;
}

async function tmuxDefaultOut(args: string[]): Promise<string> {
  const { stdout } = await tmuxExec("default", args);
  return stdout;
}

/** Extract the session name from a tmux target like "session:window". */
export function tmuxTargetSession(target: string): string {
  const i = target.indexOf(":");
  return i >= 0 ? target.substring(0, i) : target;
}

export function tmuxIsLinkedViewSession(name: string, baseSession?: string): boolean {
  const marker = "_view_";
  const markerIndex = name.lastIndexOf(marker);
  if (markerIndex <= 0) return false;
  if (baseSession && !name.startsWith(`${baseSession}${marker}`)) return false;
  const suffix = name.slice(markerIndex + marker.length);
  return /^[0-9]+$/.test(suffix);
}

export async function tmuxLocateSession(
  target: string,
  preferredServer?: TmuxServer,
): Promise<TmuxServer | null> {
  const session = tmuxTargetSession(target);
  const order: TmuxServer[] = preferredServer
    ? [preferredServer, preferredServer === "agmux" ? "default" : "agmux"]
    : ["agmux", "default"];

  for (const server of order) {
    try {
      await tmuxExec(server, ["has-session", "-t", session]);
      return server;
    } catch {
      // try next server
    }
  }
  return null;
}

function normalizeServerHint(server: TmuxServer | null | undefined): TmuxServer | null {
  if (server === "agmux" || server === "default") return server;
  return null;
}

/**
 * Create a linked session that shares windows with the target session but has
 * its own independent active-window pointer.  This prevents PTY switches from
 * affecting each other when multiple tmux attach clients are running.
 *
 * Returns the args needed to attach to the new linked session.
 */
export async function tmuxCreateLinkedSession(
  windowTarget: string,
  server: TmuxServer = "agmux",
): Promise<{ linkedSession: string; attachArgs: string[] }> {
  const session = tmuxTargetSession(windowTarget);
  const windowPart = windowTarget.includes(":") ? windowTarget.slice(windowTarget.indexOf(":") + 1).trim() : "";
  const linked = `${session}_view_${Date.now()}`;

  // Create a grouped (linked) session sharing windows with the parent session.
  // -d: don't attach, -t: group with parent session
  const newArgs = ["new-session", "-d", "-s", linked, "-t", session];
  if (server === "default") {
    await tmuxDefault(newArgs);
  } else {
    await tmuxAgent(newArgs);
  }

  // If caller provided a specific window target (session:window), keep that
  // active in the linked session. For plain session targets, keep tmux default.
  if (windowPart.length > 0) {
    const linkedWindowTarget = `${linked}:${windowPart}`;
    const selectArgs = ["select-window", "-t", linkedWindowTarget];
    if (server === "default") {
      await tmuxDefault(selectArgs);
    } else {
      await tmuxAgent(selectArgs);
    }

    // Pin the linked session to this window: if tmux switches the active window
    // (e.g. because a window is destroyed or a hook fires), automatically switch
    // back.  This prevents the xterm from silently showing a different project.
    const hookCmd = `select-window -t ${linkedWindowTarget}`;
    const hookArgs = ["set-hook", "-t", linked, "session-window-changed", hookCmd];
    try {
      if (server === "default") {
        await tmuxDefault(hookArgs);
      } else {
        await tmuxAgent(hookArgs);
      }
    } catch {
      // Older tmux versions may not support set-hook; ignore.
    }
  }

  // Apply UI options (status off, mouse off, etc.) to the linked session so
  // the tmux chrome doesn't render inside the xterm.js view.
  await tmuxApplySessionUiOptions(linked, server);

  const attachArgs = server === "default"
    ? ["attach-session", "-t", linked]
    : [...TMUX_BASE_ARGS, "attach-session", "-t", linked];
  return { linkedSession: linked, attachArgs };
}

export function tmuxAttachArgs(name: string, server: TmuxServer = "agmux"): string[] {
  if (server === "default") return ["attach-session", "-t", name];
  return [...TMUX_BASE_ARGS, "attach-session", "-t", name];
}

export async function tmuxHasSession(name: string): Promise<boolean> {
  return (await tmuxLocateSession(name)) != null;
}

/**
 * Check whether a tmux target (session:window) exists.
 * tmux silently falls back to the current window for invalid targets,
 * so we verify by listing actual windows.
 */
export async function tmuxTargetExists(target: string, server: TmuxServer): Promise<boolean> {
  const session = tmuxTargetSession(target);
  if (session === target) {
    // No window specifier — just check the session.
    try {
      await tmuxExec(server, ["has-session", "-t", session]);
      return true;
    } catch {
      return false;
    }
  }
  // Has a window specifier — verify it's in the actual window list.
  const windows = await tmuxListWindows(session, server);
  return windows.some((w) => w.target === target);
}

async function tmuxListSessionsOn(server: TmuxServer): Promise<TmuxSessionInfo[]> {
  const fmt = "#{session_name}\t#{session_created}\t#{session_windows}";
  try {
    const { stdout } = await tmuxExec(server, ["list-sessions", "-F", fmt]);
    const lines = stdout.split("\n").map((v) => v.trim()).filter((v) => v.length > 0);
    const out: TmuxSessionInfo[] = [];
    for (const line of lines) {
      const [nameRaw, createdRaw, windowsRaw] = line.split("\t", 3);
      const name = (nameRaw ?? "").trim();
      if (!name) continue;
      const createdNum = Number(createdRaw);
      const windowsNum = Number(windowsRaw);
      out.push({
        name,
        server,
        createdAt: Number.isFinite(createdNum) ? createdNum * 1000 : null,
        windows: Number.isFinite(windowsNum) ? windowsNum : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function tmuxListSessions(): Promise<TmuxSessionInfo[]> {
  const [agent, def] = await Promise.all([
    tmuxListSessionsOn("agmux"),
    tmuxListSessionsOn("default"),
  ]);
  return [...agent, ...def].sort((a, b) => {
    const at = a.createdAt ?? 0;
    const bt = b.createdAt ?? 0;
    return bt - at || a.name.localeCompare(b.name);
  });
}

export async function tmuxHasAttachedLinkedViewSession(
  baseSession: string,
  server: TmuxServer,
): Promise<boolean> {
  const fmt = "#{session_name}\t#{session_attached}";
  try {
    const { stdout } = await tmuxExec(server, ["list-sessions", "-F", fmt]);
    const lines = stdout.split("\n").map((v) => v.trim()).filter((v) => v.length > 0);
    for (const line of lines) {
      const [nameRaw, attachedRaw] = line.split("\t", 2);
      const name = (nameRaw ?? "").trim();
      if (!name || !tmuxIsLinkedViewSession(name, baseSession)) continue;
      const attached = Number(attachedRaw);
      if (Number.isFinite(attached) && attached > 0) return true;
    }
  } catch {
    // ignore best-effort probe
  }
  return false;
}

async function tmuxShowOption(
  server: TmuxServer,
  args: string[],
  trim = true,
): Promise<string | null> {
  try {
    const { stdout } = await tmuxExec(server, args);
    const v = trim ? stdout.trim() : stdout;
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export async function tmuxCheckSessionConfig(
  name: string,
  server: TmuxServer,
): Promise<TmuxSessionCheck> {
  const [mouse, alternateScreenRaw, historyLimitRaw, terminalOverrides] = await Promise.all([
    tmuxShowOption(server, ["show-options", "-w", "-v", "-t", name, "mouse"]),
    tmuxShowOption(server, ["show-options", "-w", "-v", "-t", name, "alternate-screen"]),
    tmuxShowOption(server, ["show-options", "-w", "-v", "-t", name, "history-limit"]),
    tmuxShowOption(server, ["show-options", "-gs", "terminal-overrides"], false),
  ]);

  const alternateScreen = alternateScreenRaw?.trim() ?? null;
  const historyLimitNum = historyLimitRaw && Number.isFinite(Number(historyLimitRaw))
    ? Number(historyLimitRaw)
    : null;

  const warnings: string[] = [];
  if (mouse && mouse !== "off") {
    warnings.push("tmux mouse is enabled; wheel behavior can conflict with browser scrolling.");
  }
  if (alternateScreen && alternateScreen !== "off") {
    warnings.push("tmux alternate-screen is enabled; full-screen apps may hide expected scrollback.");
  }
  if (historyLimitNum != null && historyLimitNum < 5000) {
    warnings.push(`tmux history-limit is low (${historyLimitNum}); old output may disappear quickly.`);
  }
  const overridesNormalized = terminalOverrides?.toLowerCase() ?? "";
  if (!overridesNormalized.includes("smcup@") || !overridesNormalized.includes("rmcup@")) {
    warnings.push("tmux terminal-overrides does not disable smcup/rmcup; alternate-buffer behavior may be inconsistent.");
  }

  return {
    name,
    server,
    warnings,
    observed: {
      mouse,
      alternateScreen,
      historyLimit: historyLimitNum,
      terminalOverrides,
    },
  };
}

export async function tmuxNewSessionDetached(name: string, shell: string): Promise<void> {
  const safeShell = validateShellExecutable(shell);
  await tmuxAgent(["new-session", "-d", "-s", name, "--", safeShell]);
  await tmuxApplySessionUiOptions(name, "agmux");
}

/** Ensure the named session exists on the agmux server; create if missing. */
export async function tmuxEnsureSession(name: string, shell: string): Promise<void> {
  try {
    await tmuxAgent(["has-session", "-t", name]);
  } catch {
    await tmuxNewSessionDetached(name, shell);
  }
}

/** Create a new window in an existing session. Returns a stable target like "session:@id". */
export async function tmuxCreateWindow(sessionName: string, shell: string, cwd?: string): Promise<string> {
  const safeShell = validateShellExecutable(shell);
  const args = ["new-window", "-d", "-t", sessionName, "-P", "-F", "#{session_name}:#{window_id}"];
  if (cwd) args.push("-c", cwd);
  args.push("--", safeShell);
  const out = await tmuxAgentOut(args);
  const target = out.trim();
  await tmuxApplySessionUiOptions(target, "agmux");
  return target;
}

export type TmuxWindowInfo = {
  target: string; // e.g. "agmux:@3"
  index: number;
};

/** List all windows in a session as stable targets. */
export async function tmuxListWindows(
  sessionName: string,
  server: TmuxServer = "agmux",
): Promise<TmuxWindowInfo[]> {
  const fmt = "#{session_name}:#{window_id}\t#{window_index}";
  try {
    const { stdout } = await tmuxExec(server, ["list-windows", "-t", sessionName, "-F", fmt]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [target, idxRaw] = line.split("\t", 2);
        return { target: (target ?? "").trim(), index: Number(idxRaw) };
      });
  } catch {
    return [];
  }
}

/** Kill a single window (not the whole session). */
export async function tmuxKillWindow(
  target: string,
  serverHint?: TmuxServer | null,
): Promise<void> {
  const server = normalizeServerHint(serverHint) ?? await tmuxLocateSession(target);
  if (!server) return;
  try {
    await tmuxByServer(server, ["kill-window", "-t", target]);
  } catch {
    // Window may already be gone.
  }
}

export async function tmuxApplySessionUiOptions(
  name: string,
  server: TmuxServer = "agmux",
): Promise<void> {
  if (server === "agmux") {
    try {
      // Disable alternate-screen capabilities at the tmux server level so
      // tmux does not switch the outer terminal to the alt buffer.
      await tmuxAgent(["set-option", "-g", "terminal-overrides", "*:smcup@:rmcup@"]);
    } catch {
      // ignore
    }
  }

  // We use tmux only for persistence; keep the user experience "plain shell".
  try {
    // xterm.js sends complete escape sequences atomically over WebSocket, so
    // tmux doesn't need to wait to disambiguate bare Escape from sequences.
    // The default 500ms makes Escape feel broken in vim/neovim.
    await tmuxByServer(server, ["set-option", "-s", "escape-time", "10"]);
  } catch {
    // ignore
  }
  try {
    // Size each window independently to its own attached client rather than
    // the smallest client across the whole session.
    await tmuxByServer(server, ["set-option", "-g", "window-size", "latest"]);
    await tmuxByServer(server, ["set-option", "-g", "aggressive-resize", "on"]);
  } catch {
    // tmux < 2.9 may not support window-size; ignore.
  }
  await tmuxByServer(server, ["set-option", "-t", name, "status", "off"]);
  await tmuxByServer(server, ["set-option", "-t", name, "mouse", "off"]);
  await tmuxByServer(server, ["set-option", "-t", name, "prefix", "None"]);
  try {
    // Older tmux versions may not have prefix2; ignore.
    await tmuxByServer(server, ["set-option", "-t", name, "prefix2", "None"]);
  } catch {
    // ignore
  }
  try {
    // Prevent full-screen apps from switching to alternate buffer; keep xterm.js scrollback usable.
    await tmuxByServer(server, ["set-option", "-w", "-t", name, "alternate-screen", "off"]);
  } catch {
    // ignore
  }
  try {
    // Increase tmux pane history so app scrollback has enough source material.
    await tmuxByServer(server, ["set-option", "-w", "-t", name, "history-limit", "50000"]);
  } catch {
    // ignore
  }
}

export async function tmuxKillSession(
  name: string,
  serverHint?: TmuxServer | null,
): Promise<void> {
  const server = normalizeServerHint(serverHint) ?? await tmuxLocateSession(name);
  if (!server) return;
  if (server === "default") {
    await tmuxDefault(["kill-session", "-t", name]);
    return;
  }
  await tmuxAgent(["kill-session", "-t", name]);
}

export async function tmuxPruneDetachedLinkedSessions(
  baseSession: string,
  server: TmuxServer = "agmux",
): Promise<string[]> {
  const fmt = "#{session_name}\t#{session_attached}";
  try {
    const { stdout } = await tmuxExec(server, ["list-sessions", "-F", fmt]);
    const lines = stdout.split("\n").map((v) => v.trim()).filter((v) => v.length > 0);
    const killed: string[] = [];
    for (const line of lines) {
      const [nameRaw, attachedRaw] = line.split("\t", 2);
      const name = (nameRaw ?? "").trim();
      if (!name || !tmuxIsLinkedViewSession(name, baseSession)) continue;
      const attached = Number(attachedRaw);
      if (Number.isFinite(attached) && attached > 0) continue;
      try {
        await tmuxByServer(server, ["kill-session", "-t", name]);
        killed.push(name);
      } catch {
        // Session may have disappeared concurrently.
      }
    }
    return killed;
  } catch {
    return [];
  }
}

export async function tmuxScrollHistory(
  name: string,
  direction: "up" | "down",
  lines: number,
  serverHint?: TmuxServer | null,
): Promise<void> {
  const server = normalizeServerHint(serverHint) ?? await tmuxLocateSession(name);
  if (!server) return;
  const n = Math.max(1, Math.min(200, Math.floor(lines)));

  if (direction === "up") {
    await tmuxByServer(server, ["copy-mode", "-e", "-t", name]);
  }
  await tmuxByServer(server, [
    "send-keys",
    "-t",
    name,
    "-X",
    "-N",
    String(n),
    direction === "up" ? "scroll-up" : "scroll-down",
  ]);
}

// Enter copy-mode and jump to a past command by searching its text. Used to
// scroll the pane to where a history-panel entry was run. Best-effort: tmux
// leaves the cursor put if there is no match.
export async function tmuxSearchHistory(
  name: string,
  direction: "backward" | "forward",
  query: string,
  serverHint?: TmuxServer | null,
): Promise<void> {
  const needle = query.trim();
  if (!needle) return;
  const server = normalizeServerHint(serverHint) ?? await tmuxLocateSession(name);
  if (!server) return;
  await tmuxByServer(server, ["copy-mode", "-e", "-t", name]);
  await tmuxByServer(server, [
    "send-keys",
    "-t",
    name,
    "-X",
    direction === "backward" ? "search-backward" : "search-forward",
    needle,
  ]);
}

export async function tmuxCapturePaneVisible(
  name: string,
  serverHint?: TmuxServer | null,
  historyLines = 0,
  opts?: { joinWrapped?: boolean },
): Promise<string | null> {
  const server = normalizeServerHint(serverHint) ?? await tmuxLocateSession(name);
  if (!server) return null;
  try {
    const joinWrapped = opts?.joinWrapped !== false;
    const args = ["capture-pane", "-p", "-e", "-t", name];
    if (joinWrapped) args.splice(3, 0, "-J");
    if (historyLines > 0) args.splice(1, 0, "-S", `-${Math.floor(historyLines)}`);
    const { stdout } = await tmuxExec(server, args);
    const lines = stdout.replaceAll("\r", "").split("\n");
    while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
    const cleaned = lines.join("\n");
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

const SHELL_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "nu",
]);
const RUNTIME_WRAPPER_COMMANDS = new Set(["node", "python", "python3", "bun", "deno", "npm", "npx", "pnpm", "yarn"]);
const MATCHABLE_THREAD_BASES = new Set([...SHELL_COMMANDS, ...RUNTIME_WRAPPER_COMMANDS]);

export function normalizeCommandName(cmd: string): string {
  const base = cmd.trim().split("/").filter(Boolean).at(-1) ?? cmd.trim();
  const lower = base.toLowerCase();
  if (lower.endsWith("-mainthread")) {
    const candidate = lower.slice(0, -"-mainthread".length);
    if (MATCHABLE_THREAD_BASES.has(candidate)) return candidate;
  }
  return lower;
}

function isShellCommand(cmd: string): boolean {
  return SHELL_COMMANDS.has(normalizeCommandName(cmd));
}

export type TmuxPaneInspection = {
  command: string;
  panePid: number | null;
  tty: string | null;
  cwd: string | null;
  width: number | null;
  height: number | null;
};

async function tmuxPaneMeta(
  name: string,
  serverHint?: TmuxServer | null,
): Promise<{ command: string; panePid: number | null; tty: string | null } | null> {
  const info = await tmuxPaneInspect(name, serverHint);
  if (!info) return null;
  return { command: info.command, panePid: info.panePid, tty: info.tty };
}

export async function tmuxPaneInspect(
  name: string,
  serverHint?: TmuxServer | null,
): Promise<TmuxPaneInspection | null> {
  const server = normalizeServerHint(serverHint) ?? await tmuxLocateSession(name);
  if (!server) return null;
  try {
    const fmt = "#{pane_current_command}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}";
    const out =
      server === "default"
        ? await tmuxDefaultOut(["display-message", "-p", "-t", name, fmt])
        : await tmuxAgentOut(["display-message", "-p", "-t", name, fmt]);
    const [commandRaw, panePidRaw, ttyRaw, cwdRaw, widthRaw, heightRaw] = out.trim().split("\t");
    const command = (commandRaw ?? "").trim();
    const panePidNum = Number((panePidRaw ?? "").trim());
    const panePid = Number.isFinite(panePidNum) && panePidNum > 0 ? panePidNum : null;
    const tty = (ttyRaw ?? "").trim() || null;
    const cwd = (cwdRaw ?? "").trim() || null;
    const widthNum = Number.parseInt((widthRaw ?? "").trim(), 10);
    const heightNum = Number.parseInt((heightRaw ?? "").trim(), 10);
    const width = Number.isFinite(widthNum) && widthNum > 0 ? widthNum : null;
    const height = Number.isFinite(heightNum) && heightNum > 0 ? heightNum : null;
    return { command, panePid, tty, cwd, width, height };
  } catch {
    return null;
  }
}

type ForegroundProcess = {
  pid: number;
  comm: string;
};

type ForegroundProcessRow = {
  pid: number;
  pgid: number;
  tpgid: number;
  comm: string;
};

export function pickForegroundProcess(
  rows: ForegroundProcessRow[],
  panePid: number | null,
): ForegroundProcess | null {
  const foregroundGroup = rows.filter((r) => r.pgid === r.tpgid && !isShellCommand(r.comm));
  const directForeground = foregroundGroup.find((r) => !isRuntimeWrapperCommand(r.comm));
  if (directForeground) return { pid: directForeground.pid, comm: directForeground.comm };
  if (foregroundGroup.length > 0) {
    const fallback = foregroundGroup.find((r) => panePid == null || r.pid !== panePid) ?? foregroundGroup[0];
    return { pid: fallback.pid, comm: fallback.comm };
  }
  return null;
}

async function ttyForegroundProcess(tty: string, panePid: number | null): Promise<ForegroundProcess | null> {
  try {
    const ttyArg = tty.startsWith("/dev/") ? tty.slice("/dev/".length) : tty;
    const { stdout } = await execFileAsync("ps", ["-o", "pid=,pgid=,tpgid=,comm=", "-t", ttyArg]);
    const rows = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        if (!m) return null;
        return { pid: Number(m[1]), pgid: Number(m[2]), tpgid: Number(m[3]), comm: m[4].trim() };
      })
      .filter((r): r is ForegroundProcessRow => r != null);

    return pickForegroundProcess(rows, panePid);
  } catch {
    return null;
  }
}

function isRuntimeWrapperCommand(cmd: string): boolean {
  return RUNTIME_WRAPPER_COMMANDS.has(normalizeCommandName(cmd));
}

export function inferAgentFromProcessArgs(args: string): string | null {
  const text = args.toLowerCase();
  const direct = text.match(/(?:^|\s)(codex|claude|aider|goose|opencode|cursor-agent)(?=\s|$)/);
  if (direct) return direct[1];
  const pathLike = text.match(/(?:\/|\\)(codex|claude|aider|goose|opencode|cursor-agent)(?:[\\/._ -]|$)/);
  if (pathLike) return pathLike[1];
  return null;
}

async function processArgs(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "args=", "-p", String(pid)]);
    const out = stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export async function tmuxPaneCurrentPath(
  name: string,
  serverHint?: TmuxServer | null,
): Promise<string | null> {
  const server = normalizeServerHint(serverHint) ?? await tmuxLocateSession(name);
  if (!server) return null;
  try {
    const out =
      server === "default"
        ? await tmuxDefaultOut(["display-message", "-p", "-t", name, "#{pane_current_path}"])
        : await tmuxAgentOut(["display-message", "-p", "-t", name, "#{pane_current_path}"]);
    const p = out.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

export async function tmuxPaneDimensions(
  name: string,
  serverHint?: TmuxServer | null,
): Promise<{ width: number; height: number } | null> {
  const server = normalizeServerHint(serverHint) ?? await tmuxLocateSession(name);
  if (!server) return null;
  try {
    const out =
      server === "default"
        ? await tmuxDefaultOut(["display-message", "-p", "-t", name, "#{pane_width}\t#{pane_height}"])
        : await tmuxAgentOut(["display-message", "-p", "-t", name, "#{pane_width}\t#{pane_height}"]);
    const [wRaw, hRaw] = out.trim().split("\t", 2);
    const width = Number.parseInt((wRaw ?? "").trim(), 10);
    const height = Number.parseInt((hRaw ?? "").trim(), 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

export async function tmuxPaneActiveProcess(
  name: string,
  serverHint?: TmuxServer | null,
): Promise<string | null> {
  const meta = await tmuxPaneMeta(name, serverHint);
  return tmuxPaneActiveProcessFromInspection(name, meta);
}

export async function tmuxPaneActiveProcessFromInspection(
  name: string,
  meta: Pick<TmuxPaneInspection, "command" | "panePid" | "tty"> | null,
): Promise<string | null> {
  if (!meta || !meta.command) return null;
  if (!isShellCommand(meta.command)) {
    if (!isRuntimeWrapperCommand(meta.command)) {
      debugActiveProcess({ name, mode: "meta-direct", command: meta.command, panePid: meta.panePid });
      return meta.command;
    }

    // For wrapper commands (node/python/etc), prefer the foreground TTY process.
    // pane_pid can point at the parent shell even when pane_current_command is the wrapper.
    if (meta.tty) {
      const fg = await ttyForegroundProcess(meta.tty, meta.panePid);
      if (fg) {
        if (!isRuntimeWrapperCommand(fg.comm)) {
          debugActiveProcess({
            name,
            mode: "meta-wrapper-foreground-direct",
            command: meta.command,
            panePid: meta.panePid,
            fgPid: fg.pid,
            fgComm: fg.comm,
          });
          return fg.comm;
        }
        const fgArgs = await processArgs(fg.pid);
        if (fgArgs) {
          const inferred = inferAgentFromProcessArgs(fgArgs);
          debugActiveProcess({
            name,
            mode: "meta-wrapper-foreground-wrapper",
            command: meta.command,
            panePid: meta.panePid,
            fgPid: fg.pid,
            fgComm: fg.comm,
            inferred,
            args: fgArgs.slice(0, 260),
          });
          return inferred ?? fg.comm;
        }
        debugActiveProcess({
          name,
          mode: "meta-wrapper-foreground-wrapper-no-args",
          command: meta.command,
          panePid: meta.panePid,
          fgPid: fg.pid,
          fgComm: fg.comm,
        });
        return fg.comm;
      }
    }

    // Fallback to pane_pid args if no foreground process could be resolved.
    if (!meta.panePid) {
      debugActiveProcess({ name, mode: "meta-wrapper-no-pane-pid", command: meta.command });
      return meta.command;
    }
    const args = await processArgs(meta.panePid);
    if (!args) {
      debugActiveProcess({ name, mode: "meta-wrapper-no-args", command: meta.command, panePid: meta.panePid });
      return meta.command;
    }
    const inferred = inferAgentFromProcessArgs(args);
    debugActiveProcess({
      name,
      mode: "meta-wrapper",
      command: meta.command,
      panePid: meta.panePid,
      inferred,
      args: args.slice(0, 260),
    });
    return inferred ?? meta.command;
  }
  if (!meta.tty) return null;
  const fg = await ttyForegroundProcess(meta.tty, meta.panePid);
  if (!fg) {
    debugActiveProcess({ name, mode: "shell-no-foreground", tty: meta.tty, panePid: meta.panePid });
    return null;
  }
  if (!isRuntimeWrapperCommand(fg.comm)) {
    debugActiveProcess({ name, mode: "shell-foreground-direct", tty: meta.tty, fgPid: fg.pid, fgComm: fg.comm });
    return fg.comm;
  }
  const args = await processArgs(fg.pid);
  if (!args) {
    debugActiveProcess({ name, mode: "shell-foreground-wrapper-no-args", tty: meta.tty, fgPid: fg.pid, fgComm: fg.comm });
    return fg.comm;
  }
  const inferred = inferAgentFromProcessArgs(args);
  debugActiveProcess({
    name,
    mode: "shell-foreground-wrapper",
    tty: meta.tty,
    fgPid: fg.pid,
    fgComm: fg.comm,
    inferred,
    args: args.slice(0, 260),
  });
  return inferred ?? fg.comm;
}
