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
