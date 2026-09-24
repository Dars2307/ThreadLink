import type { Metadata } from "next";

import { ConversationActivity, RecentActivity } from "@/components/dashboard/overview";
import { PageHeader, Shell } from "@/components/dashboard/shell";
import { Card } from "@/components/ui";
import { loadAccount } from "@/lib/dashboard/data";
import { deriveDashboard } from "@/lib/dashboard/view-model";

export const metadata: Metadata = { title: "Activity · ThreadLink" };

export default async function ActivityPage() {
  const account = await loadAccount();
  if (!account)
    return (
      <Shell>
        <Card>Could not load activity.</Card>
      </Shell>
    );
  const view = deriveDashboard(account);
  return (
    <Shell>
      <PageHeader
        title="Activity"
        description="Requests sent from your chats to Claude, newest first."
      />
      <ConversationActivity groups={view.linkActivity} limit={10} />
      <RecentActivity activity={view.activity} limit={50} />
    </Shell>
  );
}
