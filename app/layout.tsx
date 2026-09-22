import { ClerkProvider } from "@clerk/nextjs";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";

import { clerkVariables, parseTheme, THEME_COOKIE } from "@/lib/theme";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ThreadLink",
  description: "Send work from your chat to the Claude Code conversation you choose.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Read once per request: no theme flash, and Clerk's UI matches.
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <ClerkProvider
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
      appearance={{ variables: clerkVariables(theme) }}
    >
      <html
        lang="en"
        data-theme={theme === "system" ? undefined : theme}
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="flex min-h-full flex-col">{children}</body>
      </html>
    </ClerkProvider>
  );
}
