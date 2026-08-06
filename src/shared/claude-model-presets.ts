import type { AgentProvider } from "./protocol.js";

export const CLAUDE_EFFORT_LEVELS = [
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const;

export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

export type ClaudeModelPreset = {
  id: string;
  name: string;
  model: string;
  effort: ClaudeEffortLevel;
};

const MAX_PRESETS = 50;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;
const MODEL_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,200}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function readPreset(value: unknown): { preset: ClaudeModelPreset } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "must be an object" };
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  const effort = record.effort;

  if (!ID_PATTERN.test(id)) return { error: "id contains unsupported characters" };
  if (!name || name.length > 80 || CONTROL_PATTERN.test(name)) {
    return { error: "name must be 1-80 printable characters" };
  }
  if (!MODEL_PATTERN.test(model)) return { error: "model must be a single terminal argument" };
  if (typeof effort !== "string" || !CLAUDE_EFFORT_LEVELS.includes(effort as ClaudeEffortLevel)) {
    return { error: "effort is unsupported" };
  }

  return { preset: { id, name, model, effort: effort as ClaudeEffortLevel } };
}

export function parseClaudeModelPresets(value: unknown): ClaudeModelPreset[] {
  if (!Array.isArray(value)) return [];
  const presets: ClaudeModelPreset[] = [];
  const ids = new Set<string>();
  for (const item of value.slice(0, MAX_PRESETS)) {
    const parsed = readPreset(item);
    if (!("preset" in parsed) || ids.has(parsed.preset.id)) continue;
    ids.add(parsed.preset.id);
    presets.push(parsed.preset);
  }
  return presets;
}

export function validateClaudeModelPresets(value: unknown): ClaudeModelPreset[] {
  if (!Array.isArray(value)) throw new Error("claudeModelPresets must be an array");
  if (value.length > MAX_PRESETS) throw new Error(`claudeModelPresets cannot contain more than ${MAX_PRESETS} presets`);

  const presets: ClaudeModelPreset[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const parsed = readPreset(item);
    if (!("preset" in parsed)) throw new Error(`preset ${index + 1}: ${parsed.error}`);
    if (ids.has(parsed.preset.id)) throw new Error(`preset ${index + 1}: duplicate preset id`);
    ids.add(parsed.preset.id);
    presets.push(parsed.preset);
  }
  return presets;
}

export function claudePresetCommands(preset: ClaudeModelPreset): string[] {
  return [`/model ${preset.model}\r`, `/effort ${preset.effort}\r`];
}

export function isClaudeHarness(
  provider: AgentProvider | string | null | undefined,
  activeProcess: string | null | undefined,
): boolean {
  if (provider) return provider === "claude";
  return /(?:^|[\\/])claude(?:\.exe)?$/i.test((activeProcess ?? "").trim());
}

export function nextClaudePresetIndex(currentIndex: number, presetCount: number): number {
  if (presetCount < 1) return -1;
  return (currentIndex + 1 + presetCount) % presetCount;
}
