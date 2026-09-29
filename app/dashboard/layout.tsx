import { cookies } from "next/headers";
import { Suspense } from "react";

import { DashboardFrame } from "@/components/dashboard/frame";
import { ProfileMenu } from "@/components/dashboard/profile-menu";
import { KeyboardShortcuts } from "@/components/dashboard/shortcuts";
import { Sidebar } from "@/components/dashboard/sidebar";
import {
  BACKDROP_COOKIE,
  MOTION_COOKIE,
  parseBackdrop,
  parseMotion,
} from "@/lib/dashboard/appearance";
import { loadChats } from "@/lib/dashboard/chats-data";
import { chatNav } from "@/lib/dashboard/nav";
import { listMyThreadLinks } from "@/lib/sessions/repository";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

/** Signed-in app shell: sidebar + content. proxy.ts already requires a Clerk session. */
export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const jar = await cookies();
  const theme = parseTheme(jar.get(THEME_COOKIE)?.value);
  const backdrop = parseBackdrop(jar.get(BACKDROP_COOKIE)?.value);
  const animate = parseMotion(jar.get(MOTION_COOKIE)?.value);
  const [pending, chats] = await Promise.all([
    listMyThreadLinks()
      .then((links) => links.filter((l) => l.status === "pending").length)
      .catch(() => 0),
    loadChats(),
  ]);
  const nav = chats ? chatNav(chats) : null;

  return (
    <DashboardFrame
      backdrop={backdrop}
      animate={animate}
      sidebar={
        <Sidebar
          profile={<ProfileMenu theme={theme} />}
          chats={nav}
          badges={
            pending
              ? { "/dashboard/agents": pending, "/dashboard/notifications": pending }
              : undefined
          }
        />
      }
      after={
        <Suspense fallback={null}>
          <KeyboardShortcuts chatOrder={nav?.order ?? []} />
        </Suspense>
      }
    >
      {children}
    </DashboardFrame>
  );
}
