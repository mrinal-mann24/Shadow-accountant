import { LogOut, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AppUser } from "@/lib/auth/types";
import { ShadowMark } from "./shadow-mark";
import { ViewAsSelector } from "./view-as-selector";

export function TopBar({
  user,
  viewAsOptions,
}: {
  user: AppUser;
  /** Kept for the shell's call; the signed-in person now shows in the sidebar. */
  signedInUser: AppUser;
  /** Non-empty only for engineers who are not currently viewing as someone. */
  viewAsOptions: { vaId: string; name: string }[];
}) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-card/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/70 md:px-8">
      <span className="flex items-center gap-2 md:hidden">
        <ShadowMark className="size-7" />
        <span className="font-semibold tracking-tight">Shadow</span>
      </span>
      {/* Searches clients by name or WhatsApp group (the Clients page's own search). */}
      <form action="/clients" method="get" role="search" className="hidden max-w-sm flex-1 sm:block">
        <label className="flex h-10 items-center gap-2 rounded-xl border bg-canvas/60 px-3 transition-colors focus-within:border-primary/50 focus-within:bg-card">
          <Search className="size-[15px] text-muted-foreground" aria-hidden />
          <input
            name="q"
            aria-label="Search clients"
            placeholder="Search clients or groups"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
      </form>
      <div className="ml-auto flex items-center gap-2">
        {!user.viewingAs && <ViewAsSelector options={viewAsOptions} />}
        <form action="/auth/sign-out" method="post">
          <Button type="submit" variant="ghost" size="sm" aria-label="Sign out" className="press">
            <LogOut aria-hidden />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </form>
      </div>
    </header>
  );
}
