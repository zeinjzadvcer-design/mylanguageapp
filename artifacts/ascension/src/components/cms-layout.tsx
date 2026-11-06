import { Link, useLocation } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import {
  LayoutDashboard, BookOpen, Globe, BookMarked, GraduationCap,
  BookText, Image, Star, ClipboardList, Users, LogOut, ChevronRight, FileEdit,
  ListChecks, PenLine, ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
  hideForReviewer?: boolean;
}

const navItems: NavItem[] = [
  { href: "/cms", label: "Dashboard", icon: <LayoutDashboard className="h-4 w-4" /> },
  { href: "/cms/lessons", label: "Lessons", icon: <BookOpen className="h-4 w-4" /> },
  { href: "/cms/languages", label: "Languages", icon: <Globe className="h-4 w-4" />, adminOnly: true },
  { href: "/cms/curricula", label: "Curricula", icon: <BookMarked className="h-4 w-4" />, adminOnly: true },
  { href: "/cms/levels", label: "Levels", icon: <GraduationCap className="h-4 w-4" />, adminOnly: true },
  { href: "/cms/quizzes", label: "Quizzes", icon: <ListChecks className="h-4 w-4" /> },
  { href: "/cms/placement", label: "Placement Test", icon: <ClipboardList className="h-4 w-4" /> },
  { href: "/cms/vocabulary", label: "Vocabulary", icon: <BookText className="h-4 w-4" /> },
  { href: "/cms/media", label: "Media", icon: <Image className="h-4 w-4" /> },
  { href: "/cms/grading", label: "Marking", icon: <PenLine className="h-4 w-4" /> },
  { href: "/cms/practice-reports", label: "Practice Reports", icon: <ShieldAlert className="h-4 w-4" /> },
  { href: "/cms/reviews", label: "Reviews", icon: <Star className="h-4 w-4" /> },
  { href: "/cms/audit", label: "Audit Log", icon: <ClipboardList className="h-4 w-4" /> },
];

export function CMSLayout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: user } = useGetMe();

  const isAdmin = user?.role === "admin";
  const isReviewer = user?.role === "content_reviewer";

  const visibleItems = navItems.filter(item => {
    if (item.adminOnly && !isAdmin) return false;
    return true;
  });

  return (
    // The CMS is English-only staff tooling: keep it LTR whatever language
    // the student app is set to.
    <div dir="ltr" className="min-h-[100dvh] flex bg-gray-50">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <FileEdit className="h-5 w-5 text-indigo-600" />
            <span className="font-semibold text-gray-900 text-sm">CMS</span>
          </div>
          <p className="text-xs text-gray-500 mt-0.5 truncate">{user?.name}</p>
          <span className="inline-block mt-1 text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium capitalize">
            {user?.role?.replace("_", " ")}
          </span>
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          {visibleItems.map(item => {
            const active = location === item.href || (item.href !== "/cms" && location.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
                  active
                    ? "bg-indigo-50 text-indigo-700 font-medium"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                )}>
                {item.icon}
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-2 border-t border-gray-200 space-y-0.5">
          <Link href="/dashboard" className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-100">
            <Users className="h-4 w-4" />
            Student App
          </Link>
          {isAdmin && (
            <Link href="/admin" className="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-100">
              <LayoutDashboard className="h-4 w-4" />
              Admin Panel
            </Link>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    in_review: "bg-yellow-100 text-yellow-800",
    approved: "bg-blue-100 text-blue-700",
    published: "bg-green-100 text-green-700",
    archived: "bg-red-100 text-red-700",
  };
  return (
    <span className={cn("inline-block px-2 py-0.5 rounded text-xs font-medium capitalize", map[status] ?? "bg-gray-100 text-gray-600")}>
      {status.replace("_", " ")}
    </span>
  );
}
