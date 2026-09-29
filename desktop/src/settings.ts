import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How the app looks (0.11 design): device-local, never sent to ThreadLink. */
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const BACKDROPS = ["aurora", "dusk", "grid", "none"] as const;
export type Backdrop = (typeof BACKDROPS)[number];

/** Device-local desktop preferences (the Runtime's own settings come from ThreadLink). */
export type DesktopSettings = {
  autoStart: boolean;
  notifications: boolean;
  /** Follow the OS (default), or always light / dark. */
  theme: Theme;
  /** The background behind every surface; Dusk by default. */
  backdrop: Backdrop;
  /** Slow background motion (off anyway when the OS asks for reduced motion). */
  animate: boolean;
};

export const DEFAULT_SETTINGS: DesktopSettings = {
  autoStart: true,
  notifications: true,
  theme: "system",
  backdrop: "dusk",
  animate: true,
};

export function settingsFile(configDir: string): string {
  return join(configDir, "desktop.json");
}

const isTheme = (v: unknown): v is Theme =>
  typeof v === "string" && (THEMES as readonly string[]).includes(v);
const isBackdrop = (v: unknown): v is Backdrop =>
  typeof v === "string" && (BACKDROPS as readonly string[]).includes(v);

/**
 * An allow-listed patch from the (untrusted) renderer: only known keys with
 * valid values survive; anything else is dropped.
 */
export function validSettingsPatch(patch: unknown): Partial<DesktopSettings> {
  const p =
    patch && typeof patch === "object" && !Array.isArray(patch)
      ? (patch as Record<string, unknown>)
      : {};
  return {
    ...(typeof p.autoStart === "boolean" ? { autoStart: p.autoStart } : {}),
    ...(typeof p.notifications === "boolean" ? { notifications: p.notifications } : {}),
    ...(isTheme(p.theme) ? { theme: p.theme } : {}),
    ...(isBackdrop(p.backdrop) ? { backdrop: p.backdrop } : {}),
    ...(typeof p.animate === "boolean" ? { animate: p.animate } : {}),
  };
}

export function loadSettings(configDir: string): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsFile(configDir), "utf8")) as unknown;
    return { ...DEFAULT_SETTINGS, ...validSettingsPatch(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(configDir: string, patch: Partial<DesktopSettings>): DesktopSettings {
  const next = { ...loadSettings(configDir), ...validSettingsPatch(patch) };
  writeFileSync(settingsFile(configDir), `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return next;
}
