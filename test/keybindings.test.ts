import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEYBINDINGS,
  formatKeybinding,
  keybindingFromEvent,
  keybindingMatches,
  parseKeybindingOverrides,
  resolveKeybindings,
  validateKeybindingOverrides,
} from "../src/shared/keybindings.js";

describe("configurable keybindings", () => {
  it("keeps the existing shortcuts as defaults", () => {
    expect(formatKeybinding(DEFAULT_KEYBINDINGS.newShell)).toEqual(["Ctrl", "Shift", "`"]);
    expect(formatKeybinding(DEFAULT_KEYBINDINGS.claudeModelPreset)).toEqual(["Ctrl", "Shift", "M"]);
    expect(formatKeybinding(DEFAULT_KEYBINDINGS.reopenPrMenu)).toEqual(["Alt", "Shift", "P"]);
  });

  it("parses valid overrides and ignores malformed persisted values", () => {
    expect(parseKeybindingOverrides({
      claudeModelPreset: { code: "KeyM", ctrl: false, shift: true, alt: true, meta: false },
      closePty: { code: "KeyQ", ctrl: false, shift: true, alt: false, meta: false },
      unknownAction: { code: "KeyU", ctrl: true, shift: false, alt: false, meta: false },
    })).toEqual({
      claudeModelPreset: { code: "KeyM", ctrl: false, shift: true, alt: true, meta: false },
    });
  });

  it("strictly rejects unsafe, unknown, and duplicate overrides", () => {
    expect(() => validateKeybindingOverrides({
      closePty: { code: "KeyQ", ctrl: false, shift: true, alt: false, meta: false },
    })).toThrow("Ctrl, Alt, or Meta");
    expect(() => validateKeybindingOverrides({
      unknownAction: { code: "KeyU", ctrl: true, shift: false, alt: false, meta: false },
    })).toThrow("unknown keybinding action");
    expect(() => validateKeybindingOverrides({
      newShell: { code: "KeyK", ctrl: true, shift: false, alt: false, meta: false },
      closePty: { code: "KeyK", ctrl: true, shift: false, alt: false, meta: false },
    })).toThrow("duplicates");
  });

  it("resolves overrides without changing unrelated defaults", () => {
    const resolved = resolveKeybindings({
      claudeModelPreset: { code: "KeyM", ctrl: false, shift: true, alt: true, meta: false },
    });
    expect(formatKeybinding(resolved.claudeModelPreset)).toEqual(["Alt", "Shift", "M"]);
    expect(resolved.closePty).toEqual(DEFAULT_KEYBINDINGS.closePty);
  });

  it("preserves valid swaps while normalizing persisted overrides", () => {
    const swapped = {
      newShell: DEFAULT_KEYBINDINGS.closePty,
      closePty: DEFAULT_KEYBINDINGS.newShell,
    };
    expect(parseKeybindingOverrides(swapped)).toEqual(swapped);
    expect(validateKeybindingOverrides(swapped)).toEqual(swapped);
  });

  it("captures and matches exact modifier combinations", () => {
    const binding = keybindingFromEvent({
      code: "KeyM",
      ctrlKey: false,
      shiftKey: true,
      altKey: true,
      metaKey: false,
    });
    expect(binding).toEqual({ code: "KeyM", ctrl: false, shift: true, alt: true, meta: false });
    expect(keybindingMatches(binding!, {
      code: "KeyM",
      ctrlKey: false,
      shiftKey: true,
      altKey: true,
      metaKey: false,
    })).toBe(true);
    expect(keybindingMatches(binding!, {
      code: "KeyM",
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
      metaKey: false,
    })).toBe(false);
    expect(keybindingFromEvent({
      code: "KeyM",
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: false,
    })).toBeNull();
  });
});
