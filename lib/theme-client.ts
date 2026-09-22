import { THEME_COOKIE, type Theme } from "./theme";

/**
 * Applies an appearance choice on this device: a year-long cookie (so SSR has
 * it) plus the html attribute (so it takes effect immediately).
 * Lives outside components so the React compiler sees no DOM writes in render.
 */
export function persistTheme(next: Theme): void {
  document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  const root = document.documentElement;
  if (next === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", next);
}
