import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Device-local desktop preferences (the Runtime's own settings come from ThreadLink). */
export type DesktopSettings = { autoStart: boolean; notifications: boolean };

export const DEFAULT_SETTINGS: DesktopSettings = { autoStart: true, notifications: true };

export function settingsFile(configDir: string): string {
  return join(configDir, "desktop.json");
}

export function loadSettings(configDir: string): DesktopSettings {
  try {
    const raw = JSON.parse(
      readFileSync(settingsFile(configDir), "utf8"),
    ) as Partial<DesktopSettings>;
    return {
      autoStart: typeof raw.autoStart === "boolean" ? raw.autoStart : DEFAULT_SETTINGS.autoStart,
      notifications:
        typeof raw.notifications === "boolean" ? raw.notifications : DEFAULT_SETTINGS.notifications,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(configDir: string, patch: Partial<DesktopSettings>): DesktopSettings {
  const next = { ...loadSettings(configDir), ...patch };
  writeFileSync(settingsFile(configDir), `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return next;
}
