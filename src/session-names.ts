import type { PtySummary } from "./types.js";

export const BOT_NAMES = [
  "Ada",
  "Alfie",
  "Arlo",
  "Ava",
  "Bea",
  "Bix",
  "Bolt",
  "Byte",
  "Cleo",
  "Cosmo",
  "Dex",
  "Dottie",
  "Echo",
  "Eli",
  "Fig",
  "Fizz",
  "Gizmo",
  "Halo",
  "Hex",
  "Iggy",
  "Iris",
  "Juno",
  "Kiki",
  "Kira",
  "Lark",
  "Leo",
  "Luna",
  "Milo",
  "Miso",
  "Moxie",
  "Nia",
  "Nori",
  "Nova",
  "Orbit",
  "Otis",
  "Patch",
  "Pebble",
  "Pico",
  "Pip",
  "Pixel",
  "Poppy",
  "Remy",
  "Rex",
  "Rivet",
  "Robo",
  "Rory",
  "Scout",
  "Servo",
  "Skye",
  "Sprocket",
  "Tess",
  "Theo",
  "Toby",
  "Uma",
  "Vera",
  "Widget",
  "Winnie",
  "Yuki",
  "Zed",
  "Ziggy",
] as const;

const GENERIC_NAME_PATTERNS = [
  /^(?:claude|codex|pi)$/i,
  /^(?:claude|codex|pi):/i,
  /^shell:/i,
  /^tmux:/i,
];

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function isGenericSessionName(name: string | null | undefined): boolean {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return true;
  return GENERIC_NAME_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function botNameForSeed(seed: string): string {
  const index = hashSeed(seed || "agmux") % BOT_NAMES.length;
  return BOT_NAMES[index];
}

export function defaultSessionName(seed: string, name: string | null | undefined): string {
  if (!isGenericSessionName(name)) return String(name).trim();
  return botNameForSeed(seed);
}

export function displaySessionName(summary: Pick<PtySummary, "id" | "name">): string {
  return defaultSessionName(summary.id, summary.name);
}
