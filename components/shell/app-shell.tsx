import Link from "next/link";
import { ROLE_LABELS, type AppUser } from "@/lib/auth/types";
import { navForUser } from "./nav";
import { ShadowMark } from "./shadow-mark";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";
import { ViewAsBanner } from "./view-as-banner";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function AppShell({
  user,
  signedInUser,
  viewAsOptions,
  children,
}: {
  user: AppUser;
  signedInUser: AppUser;
  viewAsOptions: { vaId: string; name: string }[];
  children: React.ReactNode;
}) {
  const items = navForUser(user);
  return (
    <div className="flex min-h-svh bg-canvas text-foreground">
      <aside className="sticky top-0 hidden h-svh w-[248px] shrink-0 flex-col gap-5 border-r bg-card px-3.5 py-5 md:flex">
        <Link href="/home" className="flex items-center gap-2.5 px-2 py-1">
          <ShadowMark />
          <span className="text-[15px] font-semibold tracking-tight">Shadow</span>
        </Link>
        <SidebarNav items={items} />
        <div className="mt-auto flex items-center gap-2.5 rounded-xl border p-2.5">
          <span className="flex size-8 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-accent-foreground">
            {initials(signedInUser.name)}
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold">{signedInUser.name}</div>
            <div className="text-xs text-muted-foreground">{ROLE_LABELS[signedInUser.role]}</div>
          </div>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {user.viewingAs && <ViewAsBanner name={user.viewingAs.name} />}
        <TopBar user={user} signedInUser={signedInUser} viewAsOptions={viewAsOptions} />
        <div className="border-b bg-card px-2 py-2 md:hidden">
          <SidebarNav items={items} orientation="horizontal" />
        </div>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-7">{children}</main>
      </div>
    </div>
  );
}
