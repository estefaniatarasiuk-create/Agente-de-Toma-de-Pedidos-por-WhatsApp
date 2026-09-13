import { auth } from "@/lib/auth";
import { DashboardNav } from "@/components/dashboard-nav";
import { SignOutButton } from "@/components/sign-out-button";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  return (
    <div className="flex min-h-screen flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-4">
          <p className="text-sm font-semibold text-gray-900">
            {session?.user?.companyName}
          </p>
          <p className="text-xs text-gray-500">{session?.user?.email}</p>
        </div>
        <DashboardNav />
        <div className="border-t border-gray-200 p-3">
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
