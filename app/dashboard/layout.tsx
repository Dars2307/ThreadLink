import { cookies } from "next/headers";

import { ProfileMenu } from "@/components/dashboard/profile-menu";
import { Sidebar } from "@/components/dashboard/sidebar";
import { listMyThreadLinks } from "@/lib/sessions/repository";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

/** Signed-in app shell: sidebar + content. proxy.ts already requires a Clerk session. */
export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const pending = await listMyThreadLinks()
    .then((links) => links.filter((l) => l.status === "pending").length)
    .catch(() => 0);

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <Sidebar
        profile={<ProfileMenu theme={theme} />}
        badges={pending ? { "/dashboard/links": pending } : undefined}
      />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
