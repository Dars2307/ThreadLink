import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * "Start ThreadLink when I log in". Windows/macOS use Electron's login-item
 * API; Linux uses the XDG autostart directory.
 */

export type LoginItemApi = {
  setLoginItemSettings: (settings: {
    openAtLogin: boolean;
    openAsHidden?: boolean;
    args?: string[];
  }) => void;
  getLoginItemSettings: (options?: { args?: string[] }) => { openAtLogin: boolean };
};

/**
 * Windows records the login item as a full command line, and Electron only
 * reports it as enabled when it is asked with the same arguments it was set
 * with. Asking without them always answers "off", however the setting stands.
 */
export const LOGIN_ARGS = ["--hidden"];

export function linuxAutostartFile(home = homedir()): string {
  return join(home, ".config", "autostart", "threadlink.desktop");
}

export function linuxAutostartContents(execPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=ThreadLink",
    "Comment=ThreadLink Runtime",
    `Exec=${execPath} --hidden`,
    "X-GNOME-Autostart-enabled=true",
    "Terminal=false",
    "",
  ].join("\n");
}

export function applyAutoStart(
  enabled: boolean,
  options: {
    platform?: NodeJS.Platform;
    execPath?: string;
    api?: LoginItemApi;
    home?: string;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    const file = linuxAutostartFile(options.home);
    if (!enabled) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, linuxAutostartContents(options.execPath ?? process.execPath), "utf8");
    return;
  }
  options.api?.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: LOGIN_ARGS,
  });
}

/** What the operating system currently reports, not what we asked for. */
export function autoStartEnabled(
  options: { platform?: NodeJS.Platform; api?: LoginItemApi; home?: string } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") return existsSync(linuxAutostartFile(options.home));
  return options.api?.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin ?? false;
}
