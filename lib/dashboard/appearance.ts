/**
 * Appearance beyond the theme (0.11 design canvas): the app backdrop and
 * whether it moves. Stored per browser in cookies (like the theme) so the
 * server renders the right backdrop with no flash. Pure.
 */

export const BACKDROP_COOKIE = "tl-backdrop";
export const MOTION_COOKIE = "tl-motion";

export const BACKDROPS = ["aurora", "dusk", "grid", "plain"] as const;
export type Backdrop = (typeof BACKDROPS)[number];

export const BACKDROP_LABELS: Record<Backdrop, string> = {
  aurora: "Aurora",
  dusk: "Dusk",
  grid: "Grid",
  plain: "Plain",
};

export const DEFAULT_BACKDROP: Backdrop = "aurora";

export function parseBackdrop(v: unknown): Backdrop {
  return typeof v === "string" && (BACKDROPS as readonly string[]).includes(v)
    ? (v as Backdrop)
    : DEFAULT_BACKDROP;
}

/** Animation is on unless the owner turned it off ("off"). Reduced motion is handled in CSS. */
export function parseMotion(v: unknown): boolean {
  return v !== "off";
}

export const APPEARANCE_MAX_AGE = 60 * 60 * 24 * 365;

export function appearanceCookie(name: string, value: string): string {
  return `${name}=${value}; path=/; max-age=${APPEARANCE_MAX_AGE}; samesite=lax`;
}
