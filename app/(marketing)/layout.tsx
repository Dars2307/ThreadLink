import { Space_Grotesk } from "next/font/google";

import { SiteHeader } from "@/components/site-header";

/** Display typeface for the landing page hero headline. */
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
});

/**
 * Public marketing pages: landing, sign-in, sign-up.
 * Applies the .tl-marketing dark context so all child elements
 * (header, hero, auth forms) inherit the dark design tokens.
 */
export default function MarketingLayout({ children }: LayoutProps<"/">) {
  return (
    <div className={`tl-marketing flex min-h-dvh flex-col ${spaceGrotesk.variable}`}>
      <SiteHeader />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}
