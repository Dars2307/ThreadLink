/** True for a request from this site (never from a cross-site page). */
export function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) return false;
  // A browser always sends at least one of the two on a POST/PATCH/DELETE.
  return site !== null || origin !== null;
}

/** True for a JSON request from this site (never from a cross-site page). */
export function sameOriginJson(request: Request): boolean {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return false;
  return sameOriginRequest(request);
}
