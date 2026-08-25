export const KEYBINDING_ACTIONS = [
  { id: "newShell", label: "New shell" },
  { id: "closePty", label: "Close PTY" },
  { id: "toggleSidebar", label: "Toggle sidebar" },
  { id: "nextPty", label: "Next PTY" },
  { id: "previousPty", label: "Previous PTY" },
  { id: "nextReadyPty", label: "Next ready PTY" },
  { id: "reopenPrMenu", label: "Reopen last PR list" },
  { id: "claudeModelPreset", label: "Switch Claude model preset" },
] as const;

export type KeybindingActionId = (typeof KEYBINDING_ACTIONS)[number]["id"];

export type Keybinding = {
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
};

export type KeybindingOverrides = Partial<Record<KeybindingActionId, Keybinding>>;
export type ResolvedKeybindings = Record<KeybindingActionId, Keybinding>;

export type KeyEventLike = {
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
};

export const DEFAULT_KEYBINDINGS: ResolvedKeybindings = {
  newShell: { code: "Backquote", ctrl: true, shift: true, alt: false, meta: false },
  closePty: { code: "KeyQ", ctrl: true, shift: true, alt: false, meta: false },
  toggleSidebar: { code: "Backslash", ctrl: true, shift: true, alt: false, meta: false },
  nextPty: { code: "BracketRight", ctrl: true, shift: true, alt: false, meta: false },
  previousPty: { code: "BracketLeft", ctrl: true, shift: true, alt: false, meta: false },
  nextReadyPty: { code: "Space", ctrl: true, shift: true, alt: false, meta: false },
  reopenPrMenu: { code: "KeyP", ctrl: true, shift: true, alt: false, meta: false },
  claudeModelPreset: { code: "KeyM", ctrl: true, shift: true, alt: false, meta: false },
};

const ACTION_IDS = new Set<KeybindingActionId>(KEYBINDING_ACTIONS.map((action) => action.id));
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
const MODIFIER_CODE_PATTERN = /^(?:Control|Shift|Alt|Meta)(?:Left|Right)$/;

function cloneBinding(binding: Keybinding): Keybinding {
  return { ...binding };
}

function readBinding(value: unknown): { binding: Keybinding } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "shortcut must be an object" };
  }
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : "";
  if (!CODE_PATTERN.test(code) || MODIFIER_CODE_PATTERN.test(code)) {
    return { error: "shortcut has an unsupported key code" };
  }
  if (
    typeof record.ctrl !== "boolean" ||
    typeof record.shift !== "boolean" ||
    typeof record.alt !== "boolean" ||
    typeof record.meta !== "boolean"
  ) {
    return { error: "shortcut modifiers must be booleans" };
  }
  if (!record.ctrl && !record.alt && !record.meta) {
    return { error: "shortcut must include Ctrl, Alt, or Meta" };
  }
  return {
    binding: {
      code,
      ctrl: record.ctrl,
      shift: record.shift,
      alt: record.alt,
      meta: record.meta,
    },
  };
}

function bindingSignature(binding: Keybinding): string {
  return [binding.ctrl, binding.shift, binding.alt, binding.meta, binding.code].join(":");
}

function duplicateBinding(resolved: ResolvedKeybindings): { action: KeybindingActionId; other: KeybindingActionId } | null {
  const owners = new Map<string, KeybindingActionId>();
  for (const { id } of KEYBINDING_ACTIONS) {
    const signature = bindingSignature(resolved[id]);
    const other = owners.get(signature);
    if (other) return { action: id, other };
    owners.set(signature, id);
  }
  return null;
}

export function resolveKeybindings(overrides: KeybindingOverrides): ResolvedKeybindings {
  const resolved = {} as ResolvedKeybindings;
  for (const { id } of KEYBINDING_ACTIONS) {
    resolved[id] = cloneBinding(overrides[id] ?? DEFAULT_KEYBINDINGS[id]);
  }
  return resolved;
}

export function parseKeybindingOverrides(value: unknown): KeybindingOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const overrides: KeybindingOverrides = {};
  for (const { id } of KEYBINDING_ACTIONS) {
    if (!(id in record)) continue;
    const parsed = readBinding(record[id]);
    if (!("binding" in parsed)) continue;
    overrides[id] = parsed.binding;
  }
  let duplicate = duplicateBinding(resolveKeybindings(overrides));
  while (duplicate) {
    let invalidOverride: KeybindingActionId | null = null;
    if (overrides[duplicate.action]) invalidOverride = duplicate.action;
    else if (overrides[duplicate.other]) invalidOverride = duplicate.other;
    if (!invalidOverride) break;
    delete overrides[invalidOverride];
    duplicate = duplicateBinding(resolveKeybindings(overrides));
  }
  return overrides;
}

export function validateKeybindingOverrides(value: unknown): KeybindingOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("keybindings must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ACTION_IDS.has(key as KeybindingActionId)) throw new Error(`unknown keybinding action: ${key}`);
  }

  const overrides: KeybindingOverrides = {};
  for (const { id } of KEYBINDING_ACTIONS) {
    if (!(id in record)) continue;
    const parsed = readBinding(record[id]);
    if (!("binding" in parsed)) throw new Error(`keybinding ${id}: ${parsed.error}`);
    overrides[id] = parsed.binding;
  }

  const duplicate = duplicateBinding(resolveKeybindings(overrides));
  if (duplicate) {
    throw new Error(`keybinding ${duplicate.action}: shortcut duplicates ${duplicate.other}`);
  }
  return overrides;
}

function keyCodeLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const labels: Record<string, string> = {
    Backquote: "`",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    Equal: "=",
    Minus: "-",
    Period: ".",
    Quote: "'",
    Semicolon: ";",
    Slash: "/",
    Space: "Space",
  };
  return labels[code] ?? code;
}

export function formatKeybinding(binding: Keybinding): string[] {
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push("Meta");
  parts.push(keyCodeLabel(binding.code));
  return parts;
}

export function keybindingFromEvent(event: KeyEventLike): Keybinding | null {
  const parsed = readBinding({
    code: event.code,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  });
  return "binding" in parsed ? parsed.binding : null;
}

export function keybindingMatches(binding: Keybinding, event: KeyEventLike): boolean {
  return binding.code === event.code &&
    binding.ctrl === event.ctrlKey &&
    binding.shift === event.shiftKey &&
    binding.alt === event.altKey &&
    binding.meta === event.metaKey;
}
