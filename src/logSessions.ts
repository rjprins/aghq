import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PtySummary } from "./types.js";

const LOG_HEAD_BYTE_LIMIT = 64 * 1024;
const LOG_HEAD_MAX_LIMIT = 1024 * 1024; // 1 MB

type LogSource = "claude" | "codex" | "pi";

type DiscoveryOptions = {
  enabled?: boolean;
  scanLimit?: number;
  claudeConfigDir?: string;
  codexHomeDir?: string;
  piHomeDir?: string;
};

type SearchRoot = {
  source: LogSource;
  dir: string;
  maxDepth: number;
};

type FileCandidate = {
  source: LogSource;
  logPath: string;
  mtimeMs: number;
  birthtimeMs: number;
};

type SessionNameRecord = {
  name: string;
  updatedAtMs: number;
};

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function claudeConfigDir(options: DiscoveryOptions): string {
  return options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homeDir(), ".claude");
}

function codexHomeDir(options: DiscoveryOptions): string {
  return options.codexHomeDir ?? process.env.CODEX_HOME ?? path.join(homeDir(), ".codex");
}

function piHomeDir(options: DiscoveryOptions): string {
  return options.piHomeDir ?? process.env.PI_HOME ?? path.join(homeDir(), ".pi");
}

function getSearchRoots(options: DiscoveryOptions): SearchRoot[] {
  return [
    { source: "claude", dir: path.join(claudeConfigDir(options), "projects"), maxDepth: 3 },
    { source: "codex", dir: path.join(codexHomeDir(options), "sessions"), maxDepth: 4 },
    { source: "pi", dir: path.join(piHomeDir(options), "agent", "sessions"), maxDepth: 4 },
  ];
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readLogHead(logPath: string, byteLimit = LOG_HEAD_BYTE_LIMIT): string {
  try {
    const fd = fs.openSync(logPath, "r");
    const buffer = Buffer.alloc(byteLimit);
    const bytes = fs.readSync(fd, buffer, 0, byteLimit, 0);
    fs.closeSync(fd);
    if (bytes <= 0) return "";
    return buffer.slice(0, bytes).toString("utf8");
  } catch {
    return "";
  }
}

function readLogTail(logPath: string, byteLimit = LOG_HEAD_BYTE_LIMIT): string {
  try {
    const stats = fs.statSync(logPath);
    if (!stats.isFile()) return "";
    const size = Math.max(0, stats.size);
    if (size === 0) return "";
    const start = Math.max(0, size - byteLimit);
    const fd = fs.openSync(logPath, "r");
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, size - start, start);
    fs.closeSync(fd);
    if (bytes <= 0) return "";
    return buffer.slice(0, bytes).toString("utf8");
  } catch {
    return "";
  }
}

async function readLogHeadAsync(logPath: string, byteLimit = LOG_HEAD_BYTE_LIMIT): Promise<string> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(logPath, "r");
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await fd.read(buffer, 0, byteLimit, 0);
    if (bytesRead <= 0) return "";
    return buffer.slice(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await fd?.close().catch(() => {});
  }
}

async function readLogTailAsync(logPath: string, byteLimit = LOG_HEAD_BYTE_LIMIT): Promise<string> {
  try {
    const stats = await fs.promises.stat(logPath);
    if (!stats.isFile()) return "";
    const size = Math.max(0, stats.size);
    if (size === 0) return "";
    const start = Math.max(0, size - byteLimit);
    const fd = await fs.promises.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await fd.read(buffer, 0, size - start, start);
      if (bytesRead <= 0) return "";
      return buffer.slice(0, bytesRead).toString("utf8");
    } finally {
      await fd.close().catch(() => {});
    }
  } catch {
    return "";
  }
}

function parseLogHeadEntries(
  logPath: string,
  initialLimit = LOG_HEAD_BYTE_LIMIT,
  maxLimit = LOG_HEAD_MAX_LIMIT,
): Array<Record<string, unknown>> {
  let byteLimit = initialLimit;
  while (byteLimit <= maxLimit) {
    const head = readLogHead(logPath, byteLimit);
    if (!head) return [];

    const lines = head.split("\n");
    const entries: Array<Record<string, unknown>> = [];
    let hadTruncatedLine = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? "";
      if (!line) continue;
      const parsed = safeParseJson(line);
      if (parsed) {
        entries.push(parsed);
      } else if (i === lines.length - 1 || (i === lines.length - 2 && !(lines[lines.length - 1]?.trim() ?? ""))) {
        hadTruncatedLine = true;
      }
    }
    if (entries.length > 0 && !hadTruncatedLine) return entries;
    if (hadTruncatedLine && byteLimit < maxLimit) {
      byteLimit = Math.min(byteLimit * 4, maxLimit);
      continue;
    }
    return entries;
  }
  return [];
}

function parseLogTailEntries(
  logPath: string,
  initialLimit = LOG_HEAD_BYTE_LIMIT,
  maxLimit = LOG_HEAD_MAX_LIMIT,
): Array<Record<string, unknown>> {
  let byteLimit = initialLimit;
  while (byteLimit <= maxLimit) {
    const tail = readLogTail(logPath, byteLimit);
    if (!tail) return [];
    const truncated = (() => {
      try {
        return fs.statSync(logPath).size > byteLimit;
      } catch {
        return false;
      }
    })();

    const lines = tail.split("\n");
    const entries: Array<Record<string, unknown>> = [];
    let startIndex = 0;
    if (truncated && lines.length > 1) startIndex = 1; // ignore potentially truncated leading line
    for (let i = startIndex; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? "";
      if (!line) continue;
      const parsed = safeParseJson(line);
      if (parsed) entries.push(parsed);
    }
    if (entries.length > 0) return entries;
    if (byteLimit < maxLimit) {
      byteLimit = Math.min(byteLimit * 4, maxLimit);
      continue;
    }
    return [];
  }
  return [];
}

async function parseLogHeadEntriesAsync(
  logPath: string,
  initialLimit = LOG_HEAD_BYTE_LIMIT,
  maxLimit = LOG_HEAD_MAX_LIMIT,
): Promise<Array<Record<string, unknown>>> {
  let byteLimit = initialLimit;
  while (byteLimit <= maxLimit) {
    const head = await readLogHeadAsync(logPath, byteLimit);
    if (!head) return [];

    const lines = head.split("\n");
    const entries: Array<Record<string, unknown>> = [];
    let hadTruncatedLine = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? "";
      if (!line) continue;
      const parsed = safeParseJson(line);
      if (parsed) {
        entries.push(parsed);
      } else if (i === lines.length - 1 || (i === lines.length - 2 && !(lines[lines.length - 1]?.trim() ?? ""))) {
        hadTruncatedLine = true;
      }
    }
    if (entries.length > 0 && !hadTruncatedLine) return entries;
    if (hadTruncatedLine && byteLimit < maxLimit) {
      byteLimit = Math.min(byteLimit * 4, maxLimit);
      continue;
    }
    return entries;
  }
  return [];
}

async function parseLogTailEntriesAsync(
  logPath: string,
  initialLimit = LOG_HEAD_BYTE_LIMIT,
  maxLimit = LOG_HEAD_MAX_LIMIT,
): Promise<Array<Record<string, unknown>>> {
  let byteLimit = initialLimit;
  while (byteLimit <= maxLimit) {
    const tail = await readLogTailAsync(logPath, byteLimit);
    if (!tail) return [];
    const truncated = await fs.promises.stat(logPath).then((stats) => stats.size > byteLimit).catch(() => false);

    const lines = tail.split("\n");
    const entries: Array<Record<string, unknown>> = [];
    let startIndex = 0;
    if (truncated && lines.length > 1) startIndex = 1; // ignore potentially truncated leading line
    for (let i = startIndex; i < lines.length; i += 1) {
      const line = lines[i]?.trim() ?? "";
      if (!line) continue;
      const parsed = safeParseJson(line);
      if (parsed) entries.push(parsed);
    }
    if (entries.length > 0) return entries;
    if (byteLimit < maxLimit) {
      byteLimit = Math.min(byteLimit * 4, maxLimit);
      continue;
    }
    return [];
  }
  return [];
}

function getSessionIdFromEntry(entry: Record<string, unknown>): string | null {
  if (typeof entry.sessionId === "string" && entry.sessionId.trim()) return entry.sessionId.trim();
  if (typeof entry.session_id === "string" && entry.session_id.trim()) return entry.session_id.trim();
  if (entry.type === "session" && typeof entry.id === "string" && entry.id.trim()) return entry.id.trim();

  if (entry.payload && typeof entry.payload === "object") {
    const payload = entry.payload as Record<string, unknown>;
    const candidate =
      typeof payload.id === "string"
        ? payload.id
        : typeof payload.sessionId === "string"
          ? payload.sessionId
          : typeof payload.session_id === "string"
            ? payload.session_id
            : null;
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return null;
}

function getProjectPathFromEntry(entry: Record<string, unknown>): string | null {
  if (typeof entry.cwd === "string" && entry.cwd.trim()) return entry.cwd.trim();

  if (entry.payload && typeof entry.payload === "object") {
    const payload = entry.payload as Record<string, unknown>;
    const candidate =
      typeof payload.cwd === "string"
        ? payload.cwd
        : typeof payload.working_directory === "string"
          ? payload.working_directory
          : null;
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return null;
}

function extractSessionId(entries: Array<Record<string, unknown>>): string | null {
  for (const entry of entries) {
    const sessionId = getSessionIdFromEntry(entry);
    if (sessionId) return sessionId;
  }
  return null;
}

function extractProjectPath(entries: Array<Record<string, unknown>>): string | null {
  for (const entry of entries) {
    const projectPath = getProjectPathFromEntry(entry);
    if (projectPath) return projectPath;
  }
  return null;
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (typeof b.text === "string" && b.text.trim()) return b.text;
  }
  return null;
}

const SKIP_PATTERNS = [
  /^# AGENTS\.md/,
  /<environment_context>/,
  /<turn_aborted>/,
  /^# INSTRUCTIONS/,
  /<command[ _-]message>/,
  /<local-command-caveat>/,
  /^<[a-z][\w-]*>/,  // any message starting with an XML tag
];

const CONVERSATIONAL_PREFIX = /^(?:hey[,!]?\s+|hi[,!]?\s+|can you\s+|could you\s+|please\s+|i (?:seem to|think i|believe i|guess i)\s+(?:have\s+)?)/i;
// Strip common imperative verbs that don't add meaning to the session title.
// Keep "review" and "report" — those describe the session's purpose.
const LEADING_VERB = /^(?:implement|add|create|build|make|write|update|change|modify|set up|fix|refactor|remove|delete|move|rename|convert|migrate|ensure|check|run|execute|help me(?:\s+to)?|i want(?:\s+you)?\s+to|i need(?:\s+you)?\s+to|i'd like(?:\s+you)?\s+to)\s+/i;

function stripConversationalPrefixes(text: string): string {
  let result = text;
  let prev: string;
  do {
    prev = result;
    result = result.replace(CONVERSATIONAL_PREFIX, "");
  } while (result !== prev);
  return result;
}

function findFirstUserMessage(entries: Array<Record<string, unknown>>): string | null {
  for (const entry of entries) {
    let text: string | null = null;

    // Claude format: type "user", message.content
    if (entry.type === "user" && entry.message && typeof entry.message === "object") {
      const msg = entry.message as Record<string, unknown>;
      text = extractTextFromContent(msg.content);
    }

    // Codex/Pi format: type "response_item", payload.role "user"
    if (
      entry.type === "response_item" &&
      entry.payload &&
      typeof entry.payload === "object"
    ) {
      const payload = entry.payload as Record<string, unknown>;
      if (payload.role === "user") {
        text = extractTextFromContent(payload.content);
      }
    }

    if (!text) continue;
    const trimmed = text.trim();
    if (trimmed.length < 10) continue;
    if (SKIP_PATTERNS.some((p) => p.test(trimmed))) continue;

    // Take first line only, strip conversational fluff and leading verbs, collapse whitespace
    let line = trimmed.split("\n")[0] ?? trimmed;
    line = stripConversationalPrefixes(line);
    line = line.replace(LEADING_VERB, "");
    line = line.replace(/\s+/g, " ").trim();
    if (line.length < 10) continue;
    return line;
  }
  return null;
}

function truncateAtWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.lastIndexOf(" ", maxLen);
  return text.slice(0, cut > maxLen / 2 ? cut : maxLen) + "…";
}

export function extractFirstUserPrompt(entries: Array<Record<string, unknown>>): string | null {
  const line = findFirstUserMessage(entries);
  return line ? truncateAtWordBoundary(line, 160) : null;
}

function isCodexSubagent(entries: Array<Record<string, unknown>>): boolean {
  const first = entries[0];
  if (!first || first.type !== "session_meta") return false;
  const payload = first.payload;
  if (!payload || typeof payload !== "object") return false;
  return typeof (payload as Record<string, unknown>).source === "object";
}

/**
 * Claude Code writes ancillary JSONL files alongside real session transcripts.
 * These contain only `file-history-snapshot` and/or `summary` entries with no
 * sessionId / cwd, so they are not resumable sessions and should be skipped.
 */
const CLAUDE_ANCILLARY_TYPES = new Set(["file-history-snapshot", "summary"]);

function isClaudeAncillaryLog(entries: Array<Record<string, unknown>>): boolean {
  if (entries.length === 0) return false;
  return entries.every((e) => typeof e.type === "string" && CLAUDE_ANCILLARY_TYPES.has(e.type));
}

function scanDirForJsonl(root: string, maxDepth: number): string[] {
  if (!root || !fs.existsSync(root)) return [];

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const paths: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { dir, depth } = current;
    if (depth > maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Matches Agentboard behavior: skip codex subagent nested logs.
        if (entry.name === "subagents") continue;
        if (depth < maxDepth) stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        paths.push(fullPath);
      }
    }
  }
  return paths;
}

async function scanDirForJsonlAsync(root: string, maxDepth: number): Promise<string[]> {
  if (!root) return [];

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const paths: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const { dir, depth } = current;
    if (depth > maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Matches Agentboard behavior: skip codex subagent nested logs.
        if (entry.name === "subagents") continue;
        if (depth < maxDepth) stack.push({ dir: fullPath, depth: depth + 1 });
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        paths.push(fullPath);
      }
    }
  }
  return paths;
}

function buildStableId(source: LogSource, sessionId: string, logPath: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length > 0) return `log:${source}:${trimmed}`;
  const digest = createHash("sha1").update(path.resolve(logPath)).digest("hex").slice(0, 16);
  return `log:${source}:file-${digest}`;
}

function leafOrDefault(projectPath: string | null, fallback: string): string {
  if (!projectPath) return fallback;
  const leaf = path.basename(projectPath);
  return leaf || fallback;
}

function resumeArgsForSource(source: LogSource, sessionId: string): string[] {
  if (source === "claude") return ["--resume", sessionId];
  return ["resume", sessionId];
}

function putSessionNameRecord(
  target: Map<string, SessionNameRecord>,
  sessionId: string,
  name: string,
  updatedAtMs: number,
): void {
  const normalizedId = sessionId.trim();
  const normalizedName = name.trim();
  if (!normalizedId || !normalizedName) return;
  const prev = target.get(normalizedId);
  if (!prev || updatedAtMs >= prev.updatedAtMs) {
    target.set(normalizedId, { name: normalizedName, updatedAtMs });
  }
}

function loadClaudeSessionNames(options: DiscoveryOptions): Map<string, SessionNameRecord> {
  const result = new Map<string, SessionNameRecord>();
  const sessionsDir = path.join(claudeConfigDir(options), "sessions");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(sessionsDir, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const parsed = safeParseJson(raw.trim());
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId.trim() : "";
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    if (!sessionId || !name) continue;
    let updatedAtMs = 0;
    try {
      updatedAtMs = fs.statSync(filePath).mtimeMs || 0;
    } catch {
      // ignore
    }
    putSessionNameRecord(result, sessionId, name, updatedAtMs);
  }
  return result;
}

async function loadClaudeSessionNamesAsync(options: DiscoveryOptions): Promise<Map<string, SessionNameRecord>> {
  const result = new Map<string, SessionNameRecord>();
  const sessionsDir = path.join(claudeConfigDir(options), "sessions");
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(sessionsDir, entry.name);
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const parsed = safeParseJson(raw.trim());
    const sessionId = typeof parsed?.sessionId === "string" ? parsed.sessionId.trim() : "";
    const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
    if (!sessionId || !name) continue;
    let updatedAtMs = 0;
    try {
      updatedAtMs = (await fs.promises.stat(filePath)).mtimeMs || 0;
    } catch {
      // ignore
    }
    putSessionNameRecord(result, sessionId, name, updatedAtMs);
  }
  return result;
}

function loadCodexSessionNames(options: DiscoveryOptions): Map<string, SessionNameRecord> {
  const result = new Map<string, SessionNameRecord>();
  const indexPath = path.join(codexHomeDir(options), "session_index.jsonl");
  let body: string;
  try {
    body = fs.readFileSync(indexPath, "utf8");
  } catch {
    return result;
  }

  for (const line of body.split("\n")) {
    const parsed = safeParseJson(line.trim());
    const sessionId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
    const name = typeof parsed?.thread_name === "string" ? parsed.thread_name.trim() : "";
    if (!sessionId || !name) continue;
    putSessionNameRecord(result, sessionId, name, parseTimestampMs(parsed?.updated_at) ?? 0);
  }
  return result;
}

async function loadCodexSessionNamesAsync(options: DiscoveryOptions): Promise<Map<string, SessionNameRecord>> {
  const result = new Map<string, SessionNameRecord>();
  const indexPath = path.join(codexHomeDir(options), "session_index.jsonl");
  let body: string;
  try {
    body = await fs.promises.readFile(indexPath, "utf8");
  } catch {
    return result;
  }

  for (const line of body.split("\n")) {
    const parsed = safeParseJson(line.trim());
    const sessionId = typeof parsed?.id === "string" ? parsed.id.trim() : "";
    const name = typeof parsed?.thread_name === "string" ? parsed.thread_name.trim() : "";
    if (!sessionId || !name) continue;
    putSessionNameRecord(result, sessionId, name, parseTimestampMs(parsed?.updated_at) ?? 0);
  }
  return result;
}

function extractClaudeCustomName(logPath: string, sessionId: string): string | null {
  const entries = parseLogTailEntries(logPath);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    const entrySessionId = getSessionIdFromEntry(entry);
    if (entrySessionId && entrySessionId !== sessionId) continue;
    if (entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim()) {
      return entry.customTitle.trim();
    }
    if (entry.type === "agent-name" && typeof entry.agentName === "string" && entry.agentName.trim()) {
      return entry.agentName.trim();
    }
  }
  return null;
}

async function extractClaudeCustomNameAsync(logPath: string, sessionId: string): Promise<string | null> {
  const entries = await parseLogTailEntriesAsync(logPath);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry) continue;
    const entrySessionId = getSessionIdFromEntry(entry);
    if (entrySessionId && entrySessionId !== sessionId) continue;
    if (entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim()) {
      return entry.customTitle.trim();
    }
    if (entry.type === "agent-name" && typeof entry.agentName === "string" && entry.agentName.trim()) {
      return entry.agentName.trim();
    }
  }
  return null;
}

export function discoverInactiveLogSessions(options: DiscoveryOptions = {}): PtySummary[] {
  if (options.enabled === false) return [];
  const scanLimit = Math.max(1, Math.floor(options.scanLimit ?? 500));
  const candidates: FileCandidate[] = [];
  const claudeSessionNames = loadClaudeSessionNames(options);
  const codexSessionNames = loadCodexSessionNames(options);

  for (const root of getSearchRoots(options)) {
    for (const logPath of scanDirForJsonl(root.dir, root.maxDepth)) {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(logPath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      candidates.push({
        source: root.source,
        logPath,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
      });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = candidates.slice(0, scanLimit);
  const byId = new Map<string, PtySummary>();

  for (const candidate of limited) {
    const entries = parseLogHeadEntries(candidate.logPath);
    if (entries.length === 0) continue;
    if (candidate.source === "codex" && isCodexSubagent(entries)) continue;
    if (candidate.source === "claude" && isClaudeAncillaryLog(entries)) continue;

    const derivedSessionId = extractSessionId(entries) ?? path.basename(candidate.logPath, ".jsonl");
    const projectPath = extractProjectPath(entries);
    const fallbackName = derivedSessionId.slice(0, 8) || "session";
    const promptName = extractFirstUserPrompt(entries);
    const explicitName = candidate.source === "claude"
      ? (extractClaudeCustomName(candidate.logPath, derivedSessionId) ?? claudeSessionNames.get(derivedSessionId)?.name ?? null)
      : candidate.source === "codex"
        ? (codexSessionNames.get(derivedSessionId)?.name ?? null)
        : null;
    const summary: PtySummary = {
      id: buildStableId(candidate.source, derivedSessionId, candidate.logPath),
      name: explicitName ?? promptName ?? `${candidate.source}:${leafOrDefault(projectPath, fallbackName)}`,
      nameSource: explicitName ? "provider" : "derived",
      backend: "tmux",
      command: candidate.source,
      args: resumeArgsForSource(candidate.source, derivedSessionId),
      cwd: projectPath,
      createdAt: Math.floor(candidate.birthtimeMs || candidate.mtimeMs || Date.now()),
      lastSeenAt: Math.floor(candidate.mtimeMs || Date.now()),
      status: "exited",
      exitCode: null,
      exitSignal: null,
    };

    const previous = byId.get(summary.id);
    if (!previous || (summary.lastSeenAt ?? summary.createdAt) > (previous.lastSeenAt ?? previous.createdAt)) {
      byId.set(summary.id, summary);
    }
  }

  return [...byId.values()].sort(
    (a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt),
  );
}

export async function discoverInactiveLogSessionsAsync(options: DiscoveryOptions = {}): Promise<PtySummary[]> {
  if (options.enabled === false) return [];
  const scanLimit = Math.max(1, Math.floor(options.scanLimit ?? 500));
  const candidates: FileCandidate[] = [];
  const [claudeSessionNames, codexSessionNames] = await Promise.all([
    loadClaudeSessionNamesAsync(options),
    loadCodexSessionNamesAsync(options),
  ]);

  for (const root of getSearchRoots(options)) {
    for (const logPath of await scanDirForJsonlAsync(root.dir, root.maxDepth)) {
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(logPath);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      candidates.push({
        source: root.source,
        logPath,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
      });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limited = candidates.slice(0, scanLimit);
  const byId = new Map<string, PtySummary>();

  for (const candidate of limited) {
    const entries = await parseLogHeadEntriesAsync(candidate.logPath);
    if (entries.length === 0) continue;
    if (candidate.source === "codex" && isCodexSubagent(entries)) continue;
    if (candidate.source === "claude" && isClaudeAncillaryLog(entries)) continue;

    const derivedSessionId = extractSessionId(entries) ?? path.basename(candidate.logPath, ".jsonl");
    const projectPath = extractProjectPath(entries);
    const fallbackName = derivedSessionId.slice(0, 8) || "session";
    const promptName = extractFirstUserPrompt(entries);
    const explicitName = candidate.source === "claude"
      ? (await extractClaudeCustomNameAsync(candidate.logPath, derivedSessionId) ?? claudeSessionNames.get(derivedSessionId)?.name ?? null)
      : candidate.source === "codex"
        ? (codexSessionNames.get(derivedSessionId)?.name ?? null)
        : null;
    const summary: PtySummary = {
      id: buildStableId(candidate.source, derivedSessionId, candidate.logPath),
      name: explicitName ?? promptName ?? `${candidate.source}:${leafOrDefault(projectPath, fallbackName)}`,
      nameSource: explicitName ? "provider" : "derived",
      backend: "tmux",
      command: candidate.source,
      args: resumeArgsForSource(candidate.source, derivedSessionId),
      cwd: projectPath,
      createdAt: Math.floor(candidate.birthtimeMs || candidate.mtimeMs || Date.now()),
      lastSeenAt: Math.floor(candidate.mtimeMs || Date.now()),
      status: "exited",
      exitCode: null,
      exitSignal: null,
    };

    const previous = byId.get(summary.id);
    if (!previous || (summary.lastSeenAt ?? summary.createdAt) > (previous.lastSeenAt ?? previous.createdAt)) {
      byId.set(summary.id, summary);
    }
  }

  return [...byId.values()].sort(
    (a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt),
  );
}

type CacheOptions = DiscoveryOptions & {
  cacheMs?: number;
};

export class LogSessionDiscovery {
  private readonly options: CacheOptions;
  private readonly cacheMs: number;
  private cachedAt = 0;
  private cached: PtySummary[] = [];
  private hasCached = false;
  private inFlight: Promise<PtySummary[]> | null = null;

  constructor(options: CacheOptions = {}) {
    this.options = options;
    this.cacheMs = Math.max(250, Math.floor(options.cacheMs ?? 5000));
  }

  async list(nowMs = Date.now()): Promise<PtySummary[]> {
    if (this.options.enabled === false) return [];
    if (this.hasCached && nowMs - this.cachedAt <= this.cacheMs) {
      return cloneDiscoveredSessions(this.cached);
    }
    if (this.hasCached) {
      void this.refresh(nowMs).catch(() => {});
      return cloneDiscoveredSessions(this.cached);
    }
    return this.refresh(nowMs);
  }

  private async refresh(nowMs: number): Promise<PtySummary[]> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const sessions = await discoverInactiveLogSessionsAsync(this.options);
      this.cached = sessions;
      this.cachedAt = nowMs;
      this.hasCached = true;
      return cloneDiscoveredSessions(sessions);
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }
}

function cloneDiscoveredSessions(sessions: PtySummary[]): PtySummary[] {
  return sessions.map((session) => ({ ...session, args: [...session.args] }));
}

// ---------------------------------------------------------------------------
// Log file finder: locate the JSONL file for a given provider session ID.
// ---------------------------------------------------------------------------

const logFileCache = new Map<string, string | null>();

export function findLogFileForSession(
  provider: LogSource,
  providerSessionId: string,
  options: DiscoveryOptions = {},
): string | null {
  const cacheKey = `${provider}:${providerSessionId}`;
  if (logFileCache.has(cacheKey)) return logFileCache.get(cacheKey)!;

  const roots = getSearchRoots(options).filter((r) => r.source === provider);
  for (const root of roots) {
    for (const logPath of scanDirForJsonl(root.dir, root.maxDepth)) {
      const entries = parseLogHeadEntries(logPath);
      if (entries.length === 0) continue;
      const sessionId = extractSessionId(entries);
      if (sessionId === providerSessionId) {
        logFileCache.set(cacheKey, logPath);
        return logPath;
      }
    }
  }

  // Fallback: scan all sources (in case the provider hint doesn't match the directory structure)
  for (const root of getSearchRoots(options)) {
    if (root.source === provider) continue; // already scanned
    for (const logPath of scanDirForJsonl(root.dir, root.maxDepth)) {
      const entries = parseLogHeadEntries(logPath);
      if (entries.length === 0) continue;
      const sessionId = extractSessionId(entries);
      if (sessionId === providerSessionId) {
        logFileCache.set(cacheKey, logPath);
        return logPath;
      }
    }
  }

  logFileCache.set(cacheKey, null);
  return null;
}

// ---------------------------------------------------------------------------
// Conversation reader: extract user/assistant messages from a JSONL log file.
// ---------------------------------------------------------------------------

export type ConversationMessage = {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms of the log entry, when the log records one. */
  ts: number | null;
};

export type RecentLogSessionMatch = {
  source: LogSource;
  sessionId: string;
  logPath: string;
  cwd: string | null;
  createdAt: number;
  lastSeenAt: number;
  prompt: string | null;
};

const MSG_TEXT_LIMIT = 2000;
const SKIP_ENTRY_TYPES = new Set([
  "file-history-snapshot",
  "summary",
  "progress",
  "session",
  "session_meta",
  "system",
  "result",
  "tool_use",
  "tool_result",
]);

export function readConversationMessages(logPath: string): ConversationMessage[] {
  let content: string;
  try {
    content = fs.readFileSync(logPath, "utf8");
  } catch {
    return [];
  }

  const messages: ConversationMessage[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = safeParseJson(trimmed);
    if (!entry) continue;
    if (typeof entry.type === "string" && SKIP_ENTRY_TYPES.has(entry.type)) continue;

    let role: "user" | "assistant" | null = null;
    let text: string | null = null;

    // Claude format: type "user" with message.content
    if (entry.type === "user" && entry.message && typeof entry.message === "object") {
      role = "user";
      const msg = entry.message as Record<string, unknown>;
      text = extractTextFromContent(msg.content);
    }

    // Claude format: type "assistant" with message.content
    if (entry.type === "assistant" && entry.message && typeof entry.message === "object") {
      role = "assistant";
      const msg = entry.message as Record<string, unknown>;
      text = extractTextFromContent(msg.content);
    }

    // Codex/Pi format: type "response_item" with payload.role
    if (entry.type === "response_item" && entry.payload && typeof entry.payload === "object") {
      const payload = entry.payload as Record<string, unknown>;
      if (payload.role === "user") {
        role = "user";
        text = extractTextFromContent(payload.content);
      } else if (payload.role === "assistant") {
        role = "assistant";
        text = extractTextFromContent(payload.content);
      }
    }

    if (!role || !text) continue;
    const trimmedText = text.trim();
    if (!trimmedText) continue;
    if (role === "user" && SKIP_PATTERNS.some((p) => p.test(trimmedText))) continue;

    const truncated =
      trimmedText.length > MSG_TEXT_LIMIT
        ? trimmedText.slice(0, MSG_TEXT_LIMIT) + "..."
        : trimmedText;

    messages.push({ role, text: truncated, ts: entryTimestampMs(entry) });
  }

  return messages;
}

// File-mutating tool names (case-insensitive). Read/Grep/Glob are excluded on
// purpose: an agent reading a file in another worktree is not "working" there.
const MUTATING_TOOL_NAMES = new Set(["edit", "write", "multiedit", "notebookedit"]);

function mutatedPathFromToolUse(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  if (b.type !== "tool_use") return null;
  const name = typeof b.name === "string" ? b.name.toLowerCase() : "";
  if (!MUTATING_TOOL_NAMES.has(name)) return null;
  if (!b.input || typeof b.input !== "object") return null;
  const input = b.input as Record<string, unknown>;
  const fp =
    typeof input.file_path === "string"
      ? input.file_path
      : typeof input.notebook_path === "string"
        ? input.notebook_path
        : null;
  return fp && fp.trim() ? fp.trim() : null;
}

/**
 * Absolute paths the agent has *mutated* (Edit/Write/MultiEdit/NotebookEdit),
 * most-recent first, deduped. Read from the transcript tail, so it reflects
 * recent activity rather than the whole session. Claude format only for now
 * (assistant message tool_use blocks); other providers return their edits via
 * different shapes and are handled elsewhere.
 */
export function recentMutatedPaths(logPath: string, opts: { limit?: number } = {}): string[] {
  const limit = Math.max(1, Math.floor(opts.limit ?? 20));
  const entries = parseLogTailEntries(logPath);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry || entry.type !== "assistant") continue;
    if (!entry.message || typeof entry.message !== "object") continue;
    const content = (entry.message as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const fp = mutatedPathFromToolUse(block);
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      out.push(fp);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function entryTimestampMs(entry: Record<string, unknown>): number | null {
  const direct =
    parseTimestampMs(entry.timestamp) ??
    parseTimestampMs(entry.created_at) ??
    parseTimestampMs(entry.createdAt);
  if (direct != null) return direct;
  if (!entry.payload || typeof entry.payload !== "object") return null;
  const payload = entry.payload as Record<string, unknown>;
  return (
    parseTimestampMs(payload.timestamp) ??
    parseTimestampMs(payload.created_at) ??
    parseTimestampMs(payload.createdAt)
  );
}

function extractSessionTimestampMs(entries: Array<Record<string, unknown>>): number | null {
  for (const entry of entries) {
    const ts = entryTimestampMs(entry);
    if (ts != null) return ts;
  }
  return null;
}

export function findRecentLogSessionByCwd(
  source: LogSource,
  cwd: string,
  launchedAtMs: number,
  options: DiscoveryOptions & {
    windowMs?: number;
    leewayMs?: number;
    scanLimit?: number;
  } = {},
): RecentLogSessionMatch | null {
  const normalizedCwd = path.resolve(cwd);
  const windowMs = Math.max(1_000, Math.floor(options.windowMs ?? 45_000));
  const leewayMs = Math.max(0, Math.floor(options.leewayMs ?? 5_000));
  const scanLimit = Math.max(1, Math.floor(options.scanLimit ?? 200));
  const roots = getSearchRoots(options).filter((root) => root.source === source);
  const candidates: Array<RecentLogSessionMatch & { score: number; startedAt: number }> = [];

  for (const root of roots) {
    const paths = scanDirForJsonl(root.dir, root.maxDepth);
    const rankedPaths = paths
      .map((logPath) => {
        try {
          const stats = fs.statSync(logPath);
          return {
            logPath,
            stats,
            roughRecentAt: Math.max(stats.birthtimeMs || 0, stats.mtimeMs || 0),
          };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { logPath: string; stats: fs.Stats; roughRecentAt: number } => entry != null)
      .sort((a, b) => b.roughRecentAt - a.roughRecentAt)
      .slice(0, scanLimit);

    for (const candidate of rankedPaths) {
      const { logPath, stats, roughRecentAt } = candidate;
      if (roughRecentAt < (launchedAtMs - leewayMs)) continue;

      const entries = parseLogHeadEntries(logPath);
      if (entries.length === 0) continue;
      if (source === "codex" && isCodexSubagent(entries)) continue;
      if (source === "claude" && isClaudeAncillaryLog(entries)) continue;

      const entryCwd = extractProjectPath(entries);
      if (!entryCwd || path.resolve(entryCwd) !== normalizedCwd) continue;
      const sessionId = extractSessionId(entries);
      if (!sessionId) continue;

      const startedAt = extractSessionTimestampMs(entries) ?? roughRecentAt;
      if (startedAt < (launchedAtMs - leewayMs) || startedAt > (launchedAtMs + windowMs)) continue;

      candidates.push({
        source,
        sessionId,
        logPath,
        cwd: entryCwd,
        createdAt: Math.floor(stats.birthtimeMs || startedAt || Date.now()),
        lastSeenAt: Math.floor(stats.mtimeMs || startedAt || Date.now()),
        prompt: extractFirstUserPrompt(entries),
        startedAt,
        score: Math.abs(startedAt - launchedAtMs),
      });
    }
  }

  candidates.sort((a, b) => a.score - b.score || b.startedAt - a.startedAt || b.lastSeenAt - a.lastSeenAt);
  const match = candidates[0];
  if (!match) return null;
  return {
    source: match.source,
    sessionId: match.sessionId,
    logPath: match.logPath,
    cwd: match.cwd,
    createdAt: match.createdAt,
    lastSeenAt: match.lastSeenAt,
    prompt: match.prompt,
  };
}

// Find the log session currently being appended to for a cwd. Unlike
// findRecentLogSessionByCwd (which keys on session *start* time and so misses
// resumed sessions and attach-after-the-fact), this keys on recent file
// activity: an agent process in a pane plus a log in the same cwd with a
// fresh mtime is a strong signal they belong together. Returns null when two
// candidates are similarly active — better unattached than misattached.
export function findActiveLogSessionByCwd(
  source: LogSource,
  cwd: string,
  options: DiscoveryOptions & {
    activeWithinMs?: number;
    ambiguityMs?: number;
    scanLimit?: number;
  } = {},
): RecentLogSessionMatch | null {
  const normalizedCwd = path.resolve(cwd);
  const activeWithinMs = Math.max(1_000, Math.floor(options.activeWithinMs ?? 120_000));
  const ambiguityMs = Math.max(0, Math.floor(options.ambiguityMs ?? 30_000));
  const scanLimit = Math.max(1, Math.floor(options.scanLimit ?? 200));
  const now = Date.now();
  const roots = getSearchRoots(options).filter((root) => root.source === source);
  const candidates: RecentLogSessionMatch[] = [];

  for (const root of roots) {
    const paths = scanDirForJsonl(root.dir, root.maxDepth);
    const rankedPaths = paths
      .map((logPath) => {
        try {
          return { logPath, stats: fs.statSync(logPath) };
        } catch {
          return null;
        }
      })
      .filter((entry): entry is { logPath: string; stats: fs.Stats } => entry != null)
      .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
      .slice(0, scanLimit);

    for (const { logPath, stats } of rankedPaths) {
      if (now - stats.mtimeMs > activeWithinMs) continue;

      const entries = parseLogHeadEntries(logPath);
      if (entries.length === 0) continue;
      if (source === "codex" && isCodexSubagent(entries)) continue;
      if (source === "claude" && isClaudeAncillaryLog(entries)) continue;

      const entryCwd = extractProjectPath(entries);
      if (!entryCwd || path.resolve(entryCwd) !== normalizedCwd) continue;
      const sessionId = extractSessionId(entries);
      if (!sessionId) continue;

      candidates.push({
        source,
        sessionId,
        logPath,
        cwd: entryCwd,
        createdAt: Math.floor(stats.birthtimeMs || stats.mtimeMs),
        lastSeenAt: Math.floor(stats.mtimeMs),
        prompt: extractFirstUserPrompt(entries),
      });
    }
  }

  candidates.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const best = candidates[0];
  if (!best) return null;
  const runnerUp = candidates[1];
  if (runnerUp && best.lastSeenAt - runnerUp.lastSeenAt < ambiguityMs) return null;
  return best;
}
