import { redirect } from "next/navigation";

import { CONVERSATIONS_REDIRECT } from "@/lib/dashboard/chats";

/** Provider-native sessions now live on the Agents page. */
export default function ConversationsRedirect() {
  redirect(CONVERSATIONS_REDIRECT);
}
