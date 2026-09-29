/** The chat's right drawer tabs (§8). Pure: shared by the page (server) and the drawer. */
export const DRAWER_TABS = ["activity", "progress", "findings", "details", "provenance"] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number];

export const DRAWER_LABELS: Record<DrawerTab, string> = {
  activity: "Activity",
  progress: "Progress",
  findings: "Findings",
  details: "Details",
  provenance: "Sources",
};

export function parseDrawerTab(v: unknown): DrawerTab | null {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" && (DRAWER_TABS as readonly string[]).includes(x)
    ? (x as DrawerTab)
    : null;
}

/**
 * Which drawer tab the URL opens: `?panel=activity|progress|findings|details`,
 * or the 0.10 `?tab=progress|details` (Alt+2 / Alt+3). `?tab=chat` → none.
 */
export function initialPanel(
  search: Record<string, string | string[] | undefined>,
): DrawerTab | null {
  const panel = parseDrawerTab(search.panel);
  if (panel && panel !== "provenance") return panel;
  const tab = Array.isArray(search.tab) ? search.tab[0] : search.tab;
  return tab === "progress" || tab === "details" ? tab : null;
}
