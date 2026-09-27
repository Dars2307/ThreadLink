import { cookies } from "next/headers";
import { Suspense } from "react";

import { ProfileMenu } from "@/components/dashboard/profile-menu";
import { KeyboardShortcuts } from "@/components/dashboard/shortcuts";
import { Sidebar } from "@/components/dashboard/sidebar";
import { loadChats } from "@/lib/dashboard/chats-data";
import { chatNav } from "@/lib/dashboard/nav";
import { listMyThreadLinks } from "@/lib/sessions/repository";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

/** Signed-in app shell: sidebar + content. proxy.ts already requires a Clerk session. */
export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const [pending, chats] = await Promise.all([
    listMyThreadLinks()
      .then((links) => links.filter((l) => l.status === "pending").length)
      .catch(() => 0),
    loadChats(),
  ]);
  const nav = chats ? chatNav(chats) : null;

  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <a
        href="#main"
        className="focus:bg-surface focus:text-foreground sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar
        profile={<ProfileMenu theme={theme} />}
        chats={nav}
        badges={
          pending
            ? { "/dashboard/agents": pending, "/dashboard/notifications": pending }
            : undefined
        }
      />
      <main id="main" className="min-w-0 flex-1">
        {children}
      </main>
      <Suspense fallback={null}>
        <KeyboardShortcuts chatOrder={nav?.order ?? []} />
      </Suspense>
    </div>
  );
}
