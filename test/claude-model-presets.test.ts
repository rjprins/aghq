import { describe, expect, it } from "vitest";

import {
  claudePresetCommands,
  isClaudeHarness,
  nextClaudePresetIndex,
  parseClaudeModelPresets,
  validateClaudeModelPresets,
} from "../src/shared/claude-model-presets.js";

describe("Claude model presets", () => {
  it("parses valid presets and discards malformed persisted values", () => {
    expect(parseClaudeModelPresets([
      { id: "fast", name: "Fast", model: "sonnet", effort: "low" },
      { id: "deep", name: "Deep work", model: "claude-opus-4-6", effort: "xhigh" },
      { id: "bad effort", name: "Bad", model: "opus", effort: "extreme" },
      { id: "injected", name: "Injected", model: "opus\r/exit", effort: "high" },
      { id: "fast", name: "Duplicate", model: "opus", effort: "high" },
    ])).toEqual([
      { id: "fast", name: "Fast", model: "sonnet", effort: "low" },
      { id: "deep", name: "Deep work", model: "claude-opus-4-6", effort: "xhigh" },
    ]);
  });

  it("strictly validates settings writes", () => {
    expect(validateClaudeModelPresets([
      { id: "default", name: "Default", model: "opus", effort: "auto" },
      { id: "maximum", name: "Maximum", model: "claude-opus-4-7", effort: "max" },
      { id: "workflow", name: "Workflow", model: "fable", effort: "ultracode" },
    ])).toHaveLength(3);

    expect(() => validateClaudeModelPresets("not-an-array")).toThrow("must be an array");
    expect(() => validateClaudeModelPresets([
      { id: "one", name: "One", model: "opus", effort: "low" },
      { id: "one", name: "Two", model: "sonnet", effort: "high" },
    ])).toThrow("duplicate preset id");
    expect(() => validateClaudeModelPresets([
      { id: "spaces", name: "Spaces", model: "not a model", effort: "high" },
    ])).toThrow("model must be a single terminal argument");
  });

  it("builds the documented Claude slash commands", () => {
    expect(claudePresetCommands({
      id: "review",
      name: "Review",
      model: "claude-opus-4-7",
      effort: "xhigh",
    })).toEqual([
      "/model claude-opus-4-7\r",
      "/effort xhigh\r",
    ]);
  });

  it("recognizes Claude from attached provider metadata or the active process", () => {
    expect(isClaudeHarness("claude", "node")).toBe(true);
    expect(isClaudeHarness("codex", "claude")).toBe(false);
    expect(isClaudeHarness(null, "/home/me/.local/bin/claude")).toBe(true);
    expect(isClaudeHarness(undefined, "node")).toBe(false);
  });

  it("cycles preset indices with wraparound", () => {
    expect(nextClaudePresetIndex(-1, 3)).toBe(0);
    expect(nextClaudePresetIndex(0, 3)).toBe(1);
    expect(nextClaudePresetIndex(2, 3)).toBe(0);
    expect(nextClaudePresetIndex(0, 0)).toBe(-1);
  });
});
