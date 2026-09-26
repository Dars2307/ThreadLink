import { redirect } from "next/navigation";

import { TEAM_REDIRECT } from "@/lib/dashboard/chats";

/** Team is a chat mode now: the old Team page lists the Team-mode chats. */
export default function TeamRedirect() {
  redirect(TEAM_REDIRECT);
}
