import { appearanceCookie, BACKDROP_COOKIE, MOTION_COOKIE, type Backdrop } from "./appearance";

/** The backdrop element's id (components/dashboard/backdrop.tsx). */
export const BACKDROP_ID = "tl-backdrop";

/**
 * Applies a backdrop choice on this browser: a year-long cookie (so SSR has
 * it) plus the backdrop element's attribute (so it changes at once). Lives
 * outside components so the React compiler sees no DOM writes in render.
 */
export function persistBackdrop(next: Backdrop): void {
  document.cookie = appearanceCookie(BACKDROP_COOKIE, next);
  document.getElementById(BACKDROP_ID)?.setAttribute("data-backdrop", next);
}

export function persistMotion(on: boolean): void {
  document.cookie = appearanceCookie(MOTION_COOKIE, on ? "on" : "off");
  document.getElementById(BACKDROP_ID)?.setAttribute("data-animate", on ? "on" : "off");
}
