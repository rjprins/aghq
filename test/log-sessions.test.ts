import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  LogSessionDiscovery,
  discoverInactiveLogSessions,
  extractFirstUserPrompt,
  findRecentLogSessionByCwd,
  findLogFileForSession,
  readConversationMessages,
  recentMutatedPaths,
} from "../src/logSessions.js";

function assistantToolUse(...tools: Array<{ name: string; file_path?: string; notebook_path?: string }>) {
  return {
    type: "assistant",
    message: {
      content: tools.map((t) => ({
        type: "tool_use",
        name: t.name,
        input: t.notebook_path ? { notebook_path: t.notebook_path } : { file_path: t.file_path },
      })),
    },
  };
}

async function writeJsonl(filePath: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  await fs.writeFile(filePath, body, "utf8");
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // Small polling loop for async background cache refreshes.
  while (true) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("discoverInactiveLogSessions", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("discovers claude/codex/pi sessions and skips codex subagent logs", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");
    const codexDir = path.join(tmpRoot, "codex");
    const piDir = path.join(tmpRoot, "pi");

    await writeJsonl(path.join(claudeDir, "projects", "a", "claude-1.jsonl"), [
      { sessionId: "claude-1", cwd: "/tmp/project-alpha" },
    ]);
    await writeJsonl(path.join(codexDir, "sessions", "2026", "01", "codex-1.jsonl"), [
      { type: "session_meta", payload: { id: "codex-1", source: "cli", cwd: "/tmp/project-beta" } },
    ]);
    await writeJsonl(path.join(codexDir, "sessions", "2026", "01", "subagent.jsonl"), [
      { type: "session_meta", payload: { id: "codex-sub", source: { subagent: "review" }, cwd: "/tmp/review" } },
    ]);
    await writeJsonl(path.join(piDir, "agent", "sessions", "x", "pi-1.jsonl"), [
      { type: "session", id: "pi-1", payload: { working_directory: "/tmp/project-gamma" } },
    ]);

    const sessions = discoverInactiveLogSessions({
      claudeConfigDir: claudeDir,
      codexHomeDir: codexDir,
      piHomeDir: piDir,
      scanLimit: 50,
    });

    expect(sessions.map((s) => s.id)).toEqual(expect.arrayContaining([
      "log:claude:claude-1",
      "log:codex:codex-1",
      "log:pi:pi-1",
    ]));
    expect(sessions.find((s) => s.id === "log:claude:claude-1")?.args).toEqual(["--resume", "claude-1"]);
    expect(sessions.find((s) => s.id === "log:codex:codex-1")?.args).toEqual(["resume", "codex-1"]);
    expect(sessions.some((s) => s.id.includes("codex-sub"))).toBe(false);
    expect(sessions.every((s) => s.status === "exited")).toBe(true);
  });

  test("skips claude ancillary logs (file-history-snapshot / summary only)", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");

    // Ancillary file-history-snapshot file (should be skipped)
    await writeJsonl(path.join(claudeDir, "projects", "a", "fh-only.jsonl"), [
      { type: "file-history-snapshot", snapshot: {} },
      { type: "file-history-snapshot", snapshot: {} },
    ]);

    // Ancillary summary + file-history-snapshot file (should be skipped)
    await writeJsonl(path.join(claudeDir, "projects", "a", "summary-fh.jsonl"), [
      { type: "summary", summary: "Some summary", leafUuid: "abc" },
      { type: "file-history-snapshot", snapshot: {} },
    ]);

    // Real session that starts with file-history-snapshot but has session data (should be kept)
    await writeJsonl(path.join(claudeDir, "projects", "a", "real-session.jsonl"), [
      { type: "file-history-snapshot", snapshot: {} },
      { type: "progress", sessionId: "real-1", cwd: "/tmp/real" },
      { type: "user", sessionId: "real-1", cwd: "/tmp/real" },
    ]);

    const sessions = discoverInactiveLogSessions({
      claudeConfigDir: claudeDir,
      codexHomeDir: path.join(tmpRoot, "codex"),
      piHomeDir: path.join(tmpRoot, "pi"),
      scanLimit: 50,
    });

    expect(sessions.some((s) => s.id.includes("fh-only"))).toBe(false);
    expect(sessions.some((s) => s.id.includes("summary-fh"))).toBe(false);
    expect(sessions.some((s) => s.id === "log:claude:real-1")).toBe(true);
    expect(sessions.find((s) => s.id === "log:claude:real-1")?.cwd).toBe("/tmp/real");
  });

  test("uses filename stem when session id is missing", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");
    await writeJsonl(path.join(claudeDir, "projects", "a", "fallback-name.jsonl"), [
      { foo: "bar" },
      { cwd: "/tmp/project-fallback" },
    ]);

    const sessions = discoverInactiveLogSessions({
      claudeConfigDir: claudeDir,
      codexHomeDir: path.join(tmpRoot, "codex"),
      piHomeDir: path.join(tmpRoot, "pi"),
      scanLimit: 10,
    });

    expect(sessions[0]?.id).toBe("log:claude:fallback-name");
    expect(sessions[0]?.cwd).toBe("/tmp/project-fallback");
  });

  test("prefers explicit provider session names from codex index and claude rename metadata", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");
    const codexDir = path.join(tmpRoot, "codex");

    await writeJsonl(path.join(claudeDir, "projects", "a", "claude-renamed.jsonl"), [
      { type: "system", sessionId: "claude-rename", cwd: "/tmp/claude-project" },
      { type: "user", sessionId: "claude-rename", message: { content: [{ type: "text", text: "Implement the first pass of this feature" }] } },
      { type: "custom-title", customTitle: "claude-renamed", sessionId: "claude-rename" },
    ]);

    await writeJsonl(path.join(codexDir, "sessions", "2026", "04", "codex-renamed.jsonl"), [
      { type: "session_meta", payload: { id: "codex-rename", source: "cli", cwd: "/tmp/codex-project" } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Implement transcript-backed history" }] } },
    ]);
    await writeJsonl(path.join(codexDir, "session_index.jsonl"), [
      { id: "codex-rename", thread_name: "codex-renamed", updated_at: "2026-04-10T14:01:05.000Z" },
    ]);

    const sessions = discoverInactiveLogSessions({
      claudeConfigDir: claudeDir,
      codexHomeDir: codexDir,
      piHomeDir: path.join(tmpRoot, "pi"),
      scanLimit: 50,
    });

    expect(sessions.find((s) => s.id === "log:claude:claude-rename")?.name).toBe("claude-renamed");
    expect(sessions.find((s) => s.id === "log:claude:claude-rename")?.nameSource).toBe("provider");
    expect(sessions.find((s) => s.id === "log:codex:codex-rename")?.name).toBe("codex-renamed");
    expect(sessions.find((s) => s.id === "log:codex:codex-rename")?.nameSource).toBe("provider");
  });

  test("uses active claude session metadata name when transcript has no rename event", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");

    await writeJsonl(path.join(claudeDir, "projects", "a", "claude-active.jsonl"), [
      { type: "system", sessionId: "claude-active", cwd: "/tmp/claude-active-project" },
      { type: "user", sessionId: "claude-active", message: { content: [{ type: "text", text: "Implement something without a rename event" }] } },
    ]);
    await fs.mkdir(path.join(claudeDir, "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "sessions", "1234.json"),
      JSON.stringify({
        pid: 1234,
        sessionId: "claude-active",
        cwd: "/tmp/claude-active-project",
        name: "claude-active-name",
      }),
      "utf8",
    );

    const sessions = discoverInactiveLogSessions({
      claudeConfigDir: claudeDir,
      codexHomeDir: path.join(tmpRoot, "codex"),
      piHomeDir: path.join(tmpRoot, "pi"),
      scanLimit: 50,
    });

    expect(sessions.find((s) => s.id === "log:claude:claude-active")?.name).toBe("claude-active-name");
    expect(sessions.find((s) => s.id === "log:claude:claude-active")?.nameSource).toBe("provider");
  });
});

describe("LogSessionDiscovery cache", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("reuses cached result until cache ttl expires", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    const claudeDir = path.join(tmpRoot, "claude");
    const codexDir = path.join(tmpRoot, "codex");
    const piDir = path.join(tmpRoot, "pi");

    await writeJsonl(path.join(claudeDir, "projects", "a", "one.jsonl"), [
      { sessionId: "one", cwd: "/tmp/one" },
    ]);

    const discovery = new LogSessionDiscovery({
      claudeConfigDir: claudeDir,
      codexHomeDir: codexDir,
      piHomeDir: piDir,
      scanLimit: 50,
      cacheMs: 1000,
    });

    const at0 = await discovery.list(10_000);
    expect(at0.some((s) => s.id === "log:claude:one")).toBe(true);

    await writeJsonl(path.join(claudeDir, "projects", "a", "two.jsonl"), [
      { sessionId: "two", cwd: "/tmp/two" },
    ]);

    const at500 = await discovery.list(10_500);
    expect(at500.some((s) => s.id === "log:claude:two")).toBe(false);

    const at1501 = await discovery.list(11_501);
    expect(at1501.some((s) => s.id === "log:claude:two")).toBe(false);

    const refreshed = await waitFor(
      () => discovery.list(11_502),
      (sessions) => sessions.some((s) => s.id === "log:claude:two"),
    );
    expect(refreshed.some((s) => s.id === "log:claude:two")).toBe(true);
  });
});

describe("findRecentLogSessionByCwd", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("matches the most recent codex session for a cwd near launch time", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-recent-logs-"));
    const codexDir = path.join(tmpRoot, "codex");
    const cwd = "/tmp/project-beta";
    const older = path.join(codexDir, "sessions", "2026", "03", "older.jsonl");
    const newer = path.join(codexDir, "sessions", "2026", "03", "newer.jsonl");

    await writeJsonl(older, [
      { type: "session_meta", payload: { id: "codex-old", source: "cli", cwd, timestamp: "2026-03-23T14:00:00.000Z" } },
    ]);
    await writeJsonl(newer, [
      { type: "session_meta", payload: { id: "codex-new", source: "cli", cwd, timestamp: "2026-03-23T14:35:03.742Z" } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Implement transcript-backed history" }] } },
    ]);

    const match = findRecentLogSessionByCwd("codex", cwd, Date.parse("2026-03-23T14:35:00.000Z"), {
      codexHomeDir: codexDir,
      windowMs: 20_000,
    });

    expect(match?.sessionId).toBe("codex-new");
    expect(match?.cwd).toBe(cwd);
    expect(match?.prompt).toBe("transcript-backed history");
  });

  test("returns null when only older codex sessions exist for that cwd", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-recent-logs-"));
    const codexDir = path.join(tmpRoot, "codex");
    const cwd = "/tmp/project-beta";
    const logPath = path.join(codexDir, "sessions", "2026", "03", "older.jsonl");

    await writeJsonl(logPath, [
      { type: "session_meta", payload: { id: "codex-old", source: "cli", cwd, timestamp: "2026-03-23T13:00:00.000Z" } },
    ]);

    const match = findRecentLogSessionByCwd("codex", cwd, Date.parse("2026-03-23T14:35:00.000Z"), {
      codexHomeDir: codexDir,
      windowMs: 20_000,
    });

    expect(match).toBeNull();
  });
});

describe("extractFirstUserPrompt", () => {
  test("extracts claude user message (string content)", () => {
    const entries = [
      { type: "progress", sessionId: "s1", cwd: "/tmp" },
      { type: "user", message: { role: "user", content: "Fix the bug in auth.js" } },
    ];
    // "Fix" is stripped as a common verb
    expect(extractFirstUserPrompt(entries as any)).toBe("the bug in auth.js");
  });

  test("extracts claude user message (array content)", () => {
    const entries = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "Refactor the login flow" }] } },
    ];
    expect(extractFirstUserPrompt(entries as any)).toBe("the login flow");
  });

  test("extracts codex user message", () => {
    const entries = [
      { type: "session_meta", payload: { id: "c1" } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Add dark mode support to the app" }] } },
    ];
    expect(extractFirstUserPrompt(entries as any)).toBe("dark mode support to the app");
  });

  test("skips environment_context and AGENTS.md preambles", () => {
    const entries = [
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>" }] } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /home/user/project\n..." }] } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Build a REST API for user management" }] } },
    ];
    expect(extractFirstUserPrompt(entries as any)).toBe("a REST API for user management");
  });

  test("strips conversational prefixes and verbs", () => {
    const entries = [
      { type: "user", message: { role: "user", content: "Hey, can you fix the broken tests in utils?" } },
    ];
    expect(extractFirstUserPrompt(entries as any)).toBe("the broken tests in utils?");
  });

  test("preserves review and report verbs", () => {
    const reviewEntries = [
      { type: "user", message: { role: "user", content: "Review the pull request for security issues" } },
    ];
    expect(extractFirstUserPrompt(reviewEntries as any)).toBe("Review the pull request for security issues");

    const reportEntries = [
      { type: "user", message: { role: "user", content: "Report on the test coverage for this module" } },
    ];
    expect(extractFirstUserPrompt(reportEntries as any)).toBe("Report on the test coverage for this module");
  });

  test("truncates long prompts at word boundary (160 chars)", () => {
    const long = "a comprehensive authentication system with OAuth2 support including refresh tokens and session management for the entire application stack plus additional context that pushes it well over the limit";
    const entries = [
      { type: "user", message: { role: "user", content: long } },
    ];
    const result = extractFirstUserPrompt(entries as any)!;
    expect(result.length).toBeLessThanOrEqual(161); // 160 + ellipsis
    expect(result).toContain("…");
  });

  test("does not truncate prompts under 160 chars", () => {
    const text = "a comprehensive authentication system with OAuth2 support including refresh tokens and session management for the entire application stack";
    const entries = [
      { type: "user", message: { role: "user", content: text } },
    ];
    expect(extractFirstUserPrompt(entries as any)).toBe(text);
  });

  test("takes only first line of multi-line prompt", () => {
    const entries = [
      { type: "user", message: { role: "user", content: "the login page needs a redesign\nAlso update the CSS\nAnd add tests" } },
    ];
    expect(extractFirstUserPrompt(entries as any)).toBe("the login page needs a redesign");
  });

  test("returns null when no user messages found", () => {
    const entries = [
      { type: "progress", sessionId: "s1" },
      { type: "file-history-snapshot", snapshot: {} },
    ];
    expect(extractFirstUserPrompt(entries as any)).toBeNull();
  });

  test("skips messages shorter than 10 chars", () => {
    const entries = [
      { type: "user", message: { role: "user", content: "hi" } },
      { type: "user", message: { role: "user", content: "Update the database migration scripts" } },
    ];
    // "Update" is stripped
    expect(extractFirstUserPrompt(entries as any)).toBe("the database migration scripts");
  });

  test("uses prompt-based name in discoverInactiveLogSessions", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    try {
      const claudeDir = path.join(tmpRoot, "claude");
      await writeJsonl(path.join(claudeDir, "projects", "a", "session.jsonl"), [
        { type: "progress", sessionId: "s1", cwd: "/tmp/my-project" },
        { type: "user", sessionId: "s1", message: { role: "user", content: "Fix the authentication bug in login" } },
      ]);

      const sessions = discoverInactiveLogSessions({
        claudeConfigDir: claudeDir,
        codexHomeDir: path.join(tmpRoot, "codex"),
        piHomeDir: path.join(tmpRoot, "pi"),
        scanLimit: 10,
      });

      expect(sessions[0]?.name).toBe("the authentication bug in login");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test("falls back to source:leaf when no prompt found", async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-logs-"));
    try {
      const claudeDir = path.join(tmpRoot, "claude");
      await writeJsonl(path.join(claudeDir, "projects", "a", "session.jsonl"), [
        { type: "progress", sessionId: "s1", cwd: "/tmp/my-project" },
      ]);

      const sessions = discoverInactiveLogSessions({
        claudeConfigDir: claudeDir,
        codexHomeDir: path.join(tmpRoot, "codex"),
        piHomeDir: path.join(tmpRoot, "pi"),
        scanLimit: 10,
      });

      expect(sessions[0]?.name).toBe("claude:my-project");
    } finally {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("findLogFileForSession", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("finds a claude session log file by provider session id", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-find-"));
    const claudeDir = path.join(tmpRoot, "claude");
    const logFile = path.join(claudeDir, "projects", "a", "session.jsonl");
    await writeJsonl(logFile, [
      { sessionId: "find-me-123", cwd: "/tmp/project" },
      { type: "user", message: { role: "user", content: "Hello world" } },
    ]);

    const result = findLogFileForSession("claude", "find-me-123", {
      claudeConfigDir: claudeDir,
      codexHomeDir: path.join(tmpRoot, "codex"),
      piHomeDir: path.join(tmpRoot, "pi"),
    });

    expect(result).toBe(logFile);
  });

  test("returns null when session id not found", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-find-"));
    const claudeDir = path.join(tmpRoot, "claude");
    await writeJsonl(path.join(claudeDir, "projects", "a", "other.jsonl"), [
      { sessionId: "other-id", cwd: "/tmp/project" },
    ]);

    const result = findLogFileForSession("claude", "nonexistent-id", {
      claudeConfigDir: claudeDir,
      codexHomeDir: path.join(tmpRoot, "codex"),
      piHomeDir: path.join(tmpRoot, "pi"),
    });

    expect(result).toBeNull();
  });
});

describe("readConversationMessages", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  test("extracts user and assistant messages from claude format", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-conv-"));
    const logFile = path.join(tmpRoot, "session.jsonl");
    await writeJsonl(logFile, [
      { type: "progress", sessionId: "s1", cwd: "/tmp" },
      { type: "user", message: { role: "user", content: "Fix the bug in auth.js" } },
      { type: "assistant", message: { role: "assistant", content: "I'll look at auth.js and fix the bug." } },
      { type: "user", message: { role: "user", content: "Great, now add tests" } },
      { type: "assistant", message: { role: "assistant", content: "Adding tests for auth.js now." } },
    ]);

    const messages = readConversationMessages(logFile);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toEqual({ role: "user", text: "Fix the bug in auth.js", ts: null });
    expect(messages[1]).toEqual({ role: "assistant", text: "I'll look at auth.js and fix the bug.", ts: null });
    expect(messages[2]).toEqual({ role: "user", text: "Great, now add tests", ts: null });
    expect(messages[3]).toEqual({ role: "assistant", text: "Adding tests for auth.js now.", ts: null });
  });

  test("extracts entry timestamps as epoch ms", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-conv-"));
    const logFile = path.join(tmpRoot, "session.jsonl");
    await writeJsonl(logFile, [
      { type: "user", timestamp: "2026-07-06T10:00:00.000Z", message: { role: "user", content: "First prompt" } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Codex prompt" }], timestamp: "2026-07-06T11:00:00.000Z" } },
    ]);

    const messages = readConversationMessages(logFile);
    expect(messages).toHaveLength(2);
    expect(messages[0].ts).toBe(Date.parse("2026-07-06T10:00:00.000Z"));
    expect(messages[1].ts).toBe(Date.parse("2026-07-06T11:00:00.000Z"));
  });

  test("extracts messages from codex format", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-conv-"));
    const logFile = path.join(tmpRoot, "codex-session.jsonl");
    await writeJsonl(logFile, [
      { type: "session_meta", payload: { id: "c1", source: "cli" } },
      { type: "response_item", payload: { role: "user", content: [{ type: "input_text", text: "Add dark mode" }] } },
      { type: "response_item", payload: { role: "assistant", content: [{ type: "text", text: "I'll implement dark mode." }] } },
    ]);

    const messages = readConversationMessages(logFile);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: "user", text: "Add dark mode", ts: null });
    expect(messages[1]).toEqual({ role: "assistant", text: "I'll implement dark mode.", ts: null });
  });

  test("skips non-message entries", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-conv-"));
    const logFile = path.join(tmpRoot, "session.jsonl");
    await writeJsonl(logFile, [
      { type: "file-history-snapshot", snapshot: {} },
      { type: "summary", summary: "Some summary" },
      { type: "progress", sessionId: "s1" },
      { type: "user", message: { role: "user", content: "Hello world example" } },
      { type: "tool_use", name: "bash", input: { command: "ls" } },
      { type: "tool_result", output: "file1\nfile2" },
      { type: "assistant", message: { role: "assistant", content: "Done!" } },
    ]);

    const messages = readConversationMessages(logFile);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  test("truncates long messages", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-conv-"));
    const logFile = path.join(tmpRoot, "session.jsonl");
    const longText = "a".repeat(3000);
    await writeJsonl(logFile, [
      { type: "user", message: { role: "user", content: longText } },
    ]);

    const messages = readConversationMessages(logFile);
    expect(messages).toHaveLength(1);
    expect(messages[0].text.length).toBe(2003); // 2000 + "..."
    expect(messages[0].text.endsWith("...")).toBe(true);
  });

  test("skips user messages matching skip patterns", async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-conv-"));
    const logFile = path.join(tmpRoot, "session.jsonl");
    await writeJsonl(logFile, [
      { type: "user", message: { role: "user", content: "# AGENTS.md instructions for this project" } },
      { type: "user", message: { role: "user", content: "<environment_context>\n<cwd>/tmp</cwd>\n</environment_context>" } },
      { type: "user", message: { role: "user", content: "Fix the actual bug in auth.js" } },
    ]);

    const messages = readConversationMessages(logFile);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Fix the actual bug in auth.js");
  });

  test("returns empty array for nonexistent file", () => {
    const messages = readConversationMessages("/tmp/nonexistent-file.jsonl");
    expect(messages).toEqual([]);
  });
});

describe("recentMutatedPaths", () => {
  let tmpRoot: string | null = null;

  afterEach(async () => {
    if (tmpRoot) {
      await fs.rm(tmpRoot, { recursive: true, force: true });
      tmpRoot = null;
    }
  });

  async function write(lines: unknown[]): Promise<string> {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agmux-mut-"));
    const logFile = path.join(tmpRoot, "s.jsonl");
    await writeJsonl(logFile, lines);
    return logFile;
  }

  test("returns mutated paths most-recent first, deduped", async () => {
    const logFile = await write([
      { type: "user", message: { role: "user", content: "go" } },
      assistantToolUse({ name: "Write", file_path: "/repo/a.ts" }),
      assistantToolUse({ name: "Edit", file_path: "/repo/b.ts" }),
      assistantToolUse({ name: "Edit", file_path: "/repo/a.ts" }),
    ]);
    expect(recentMutatedPaths(logFile)).toEqual(["/repo/a.ts", "/repo/b.ts"]);
  });

  test("ignores non-mutating tools (Read/Bash/Grep)", async () => {
    const logFile = await write([
      assistantToolUse({ name: "Read", file_path: "/other-repo/x.ts" }),
      assistantToolUse({ name: "Grep", file_path: "/other-repo/y.ts" }),
      assistantToolUse({ name: "Edit", file_path: "/repo/real.ts" }),
    ]);
    expect(recentMutatedPaths(logFile)).toEqual(["/repo/real.ts"]);
  });

  test("picks up NotebookEdit notebook_path", async () => {
    const logFile = await write([
      assistantToolUse({ name: "NotebookEdit", notebook_path: "/repo/nb.ipynb" }),
    ]);
    expect(recentMutatedPaths(logFile)).toEqual(["/repo/nb.ipynb"]);
  });

  test("respects the limit", async () => {
    const logFile = await write([
      assistantToolUse({ name: "Edit", file_path: "/repo/a.ts" }),
      assistantToolUse({ name: "Edit", file_path: "/repo/b.ts" }),
      assistantToolUse({ name: "Edit", file_path: "/repo/c.ts" }),
    ]);
    expect(recentMutatedPaths(logFile, { limit: 2 })).toEqual(["/repo/c.ts", "/repo/b.ts"]);
  });

  test("returns empty for a transcript with no mutations", async () => {
    const logFile = await write([
      { type: "user", message: { role: "user", content: "hello" } },
      assistantToolUse({ name: "Read", file_path: "/repo/a.ts" }),
    ]);
    expect(recentMutatedPaths(logFile)).toEqual([]);
  });
});
