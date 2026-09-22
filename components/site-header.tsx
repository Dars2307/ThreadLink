import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

import { buttonStyles } from "@/components/ui";

export function SiteHeader() {
  return (
    <header className="border-border bg-background/85 sticky top-0 z-10 border-b backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="bg-accent text-accent-foreground flex size-6 items-center justify-center rounded-md text-xs"
          >
            ⇄
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
