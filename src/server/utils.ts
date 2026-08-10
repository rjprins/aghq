import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function pathExistsAndIsDirectory(target: string): Promise<boolean> {
  try {
    const st = await fs.stat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export function expandHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Directory completions for a partial path, shell-style: "~/pro" → ["~/projects", ...].
 * A trailing "/" lists the directory's children. Results keep the caller's
 * tilde notation. Hidden directories only match when the fragment starts with ".".
 */
export async function completeDirectoryPath(rawPrefix: string, limit = 20): Promise<string[]> {
  const raw = rawPrefix.trim();
  if (!raw) return [];
  const prefix = raw === "~" ? "~/" : raw;
  const expanded = expandHomePath(prefix);
  if (!path.isAbsolute(expanded)) return [];
  const listChildren = prefix.endsWith("/");
  const baseDir = listChildren ? expanded : path.dirname(expanded);
  const fragment = listChildren ? "" : path.basename(expanded);

  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const fragmentLower = fragment.toLowerCase();
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && !fragment.startsWith(".")) continue;
    if (!entry.name.toLowerCase().startsWith(fragmentLower)) continue;
    if (entry.isDirectory()) names.push(entry.name);
    else if (entry.isSymbolicLink() && await pathExistsAndIsDirectory(path.join(baseDir, entry.name))) {
      names.push(entry.name);
    }
  }
  names.sort((a, b) => a.localeCompare(b));

  const results = names.slice(0, limit).map((name) => path.join(baseDir, name));
  if (!raw.startsWith("~")) return results;
  const home = os.homedir();
  return results.map((p) => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p));
}
