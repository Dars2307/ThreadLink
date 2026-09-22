import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  getLoginItemSettings: () => { openAtLogin: boolean };
};

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
    args: ["--hidden"],
  });
}
