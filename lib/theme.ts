/** Appearance preference, stored per device in a cookie so SSR renders without a flash. */
export const THEME_COOKIE = "tl-theme";
export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function parseTheme(value: unknown): Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value)
    ? (value as Theme)
    : "system";
}

/** Clerk's UI follows the same palette (system falls back to Clerk's default light). */
export function clerkVariables(theme: Theme) {
  if (theme === "dark") {
    return {
      colorPrimary: "#8b8cff",
      colorBackground: "#141419",
      colorText: "#f2f2f5",
      colorTextSecondary: "#b6b6c2",
      colorInputBackground: "#1b1b22",
      colorInputText: "#f2f2f5",
      borderRadius: "0.625rem",
    };
  }
  return { colorPrimary: "#4f46e5", borderRadius: "0.625rem" };
}
