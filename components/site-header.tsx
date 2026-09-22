import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/nextjs";
import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-black/10 dark:border-white/15">
      <nav className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
        <Link href="/" className="font-semibold tracking-tight">
          ThreadLink
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Show when="signed-out">
            <SignInButton>
              <button type="button" className="hover:underline">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton>
              <button
                type="button"
                className="bg-foreground text-background rounded-md px-3 py-1.5"
              >
                Sign up
              </button>
            </SignUpButton>
          </Show>
          <Show when="signed-in">
            <Link href="/dashboard" className="hover:underline">
              Dashboard
            </Link>
            <UserButton />
          </Show>
        </div>
      </nav>
    </header>
  );
}
