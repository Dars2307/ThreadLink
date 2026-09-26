import Link from "next/link";

import { cx } from "@/components/ui";

const SECTIONS = [
  { href: "/dashboard/settings", label: "General" },
  { href: "/dashboard/settings/providers", label: "Providers & plans" },
  { href: "/dashboard/settings/apps", label: "Connected apps" },
  { href: "/dashboard/devices", label: "Devices" },
  { href: "/dashboard/settings/cleanup", label: "Cleanup" },
  { href: "/dashboard/settings/advanced", label: "Advanced" },
] as const;

export type SettingsSection = (typeof SECTIONS)[number]["href"];

/** Settings sub-sections as a scrollable tab row (works at phone widths). */
export function SettingsNav({ current }: { current: SettingsSection }) {
  return (
    <nav aria-label="Settings" className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="border-border flex w-max gap-1 border-b sm:w-auto">
        {SECTIONS.map((s) => (
          <li key={s.href}>
            <Link
              href={s.href}
              aria-current={current === s.href ? "page" : undefined}
              className={cx(
                "-mb-px inline-block border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                current === s.href
                  ? "border-accent text-foreground font-medium"
                  : "text-muted hover:text-foreground border-transparent",
              )}
            >
              {s.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
