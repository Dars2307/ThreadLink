import { SiteHeader } from "@/components/site-header";

/** Public pages keep the simple top bar; the dashboard uses its own sidebar. */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader />
      <main className="flex flex-1 flex-col">{children}</main>
    </>
  );
}
