import Link from "next/link";
import type { AppUser } from "@/lib/auth/types";
import { navForUser } from "./nav";
import { SidebarNav } from "./sidebar-nav";
import { TopBar } from "./top-bar";
import { ViewAsBanner } from "./view-as-banner";

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
    <div className="flex min-h-svh bg-background text-foreground">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r p-4 md:flex">
        <Link href="/home" className="px-3 text-base font-semibold">
          Shadow Accountant
        </Link>
        <SidebarNav items={items} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {user.viewingAs && <ViewAsBanner name={user.viewingAs.name} />}
        <TopBar
          user={user}
          signedInUser={signedInUser}
          viewAsOptions={viewAsOptions}
        />
        <div className="border-b px-2 py-2 md:hidden">
          <SidebarNav items={items} orientation="horizontal" />
        </div>
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
