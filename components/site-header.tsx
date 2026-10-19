import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

import { buttonStyles } from "@/components/ui";

const LOGO_MARK = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 7H7a5 5 0 0 0 0 10h2" />
    <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
    <path d="M8 12h8" />
  </svg>
);

export function SiteHeader() {
  return (
    <header className="border-border bg-background/85 sticky top-0 z-10 border-b backdrop-blur-md">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            className="bg-accent text-accent-foreground shadow-glow flex size-7 items-center justify-center rounded-lg"
          >
            {LOGO_MARK}
          </span>
          ThreadLink
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <Show when="signed-out">
            <SignInButton>
              <button type="button" className={buttonStyles.ghost}>
                Sign in
              </button>
            </SignInButton>
            <SignUpButton>
              <button type="button" className={buttonStyles.primary}>
                Sign up
              </button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link href="/dashboard" className={buttonStyles.ghost}>
              Dashboard
            </Link>
            <UserButton />
          </Show>
        </div>
      </nav>
    </header>
  );
}
