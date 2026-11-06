import { Link, useLocation } from "wouter";
import { BookOpen, GraduationCap, Home, User as UserIcon, BookMarked, Mic, Settings, LogOut, Loader2, Crown } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { Button } from "./ui/button";
import { BrandLogo, LanguageSwitcher } from "./brand";
import { useI18n } from "@/lib/i18n";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useGetMe();
  const [location, setLocation] = useLocation();
  const logout = useLogout();
  const queryClient = useQueryClient();
  const { t } = useI18n();

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    // Should be redirected by Route guards, but just in case
    return <>{children}</>;
  }

  const handleLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        setLocation("/login");
        // The server session is gone, but the cache still holds the user and
        // their data: the landing page and route guards read that cached user
        // and sent the student straight back into the app. Navigate first so
        // the protected pages unmount instead of refetching into 401s.
        queryClient.clear();
      }
    });
  };

  const navItems = [
    { href: "/dashboard", label: t.nav.home, icon: Home },
    { href: "/learn", label: t.nav.curriculum, icon: BookOpen },
    { href: "/quizzes", label: t.nav.quizzes, icon: GraduationCap },
    { href: "/vocabulary", label: t.nav.vocabulary, icon: BookMarked },
    { href: "/practice", label: t.nav.practice, icon: Mic },
    { href: "/profile", label: t.nav.profile, icon: UserIcon },
  ];

  if (user.role === "admin") {
    navItems.push({ href: "/admin", label: t.nav.admin, icon: Settings });
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background pb-16 md:pb-0 md:ps-64">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col fixed top-0 start-0 w-64 h-[100dvh] bg-card border-e border-border z-40">
        <div className="px-6 h-[73px] flex items-center border-b border-border">
          <Link href="/dashboard">
            <BrandLogo />
          </Link>
        </div>

        <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
          {navItems.map((item) => {
            const isActive = location === item.href || location.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
                }`}
              >
                <item.icon className="h-5 w-5" />
                <span className="font-medium">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-border space-y-2">
          <Link href="/subscription" className="flex items-center gap-3 px-4 py-3 rounded-xl text-mint-foreground bg-mint-soft hover:bg-mint/30 transition-colors">
             <Crown className="h-5 w-5" />
             <span className="font-semibold">{t.nav.subscription}</span>
          </Link>

          <LanguageSwitcher variant="row" />

          <Button
            variant="ghost"
            className="w-full flex items-center justify-start gap-3 text-muted-foreground hover:text-destructive"
            onClick={handleLogout}
            disabled={logout.isPending}
          >
            <LogOut className="h-5 w-5" />
            <span className="font-medium">{t.nav.logout}</span>
          </Button>
        </div>
      </aside>

      {/* Mobile top bar: the bottom nav has no room for the brand or the language switch */}
      <header className="md:hidden sticky top-0 z-30 h-14 flex items-center justify-between px-4 bg-background/85 backdrop-blur-md border-b border-border">
        <Link href="/dashboard">
          <BrandLogo size="sm" />
        </Link>
        <LanguageSwitcher />
      </header>

      {/* Main Content */}
      <main className="flex-1 min-h-[100dvh] w-full mx-auto max-w-5xl">
        {children}
      </main>

      {/* Mobile Bottom Nav */}
      <nav className="md:hidden fixed bottom-0 end-0 start-0 h-16 bg-card border-t border-border flex items-center justify-around px-2 z-40">
        {navItems.map((item) => {
          const isActive = location === item.href || location.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-col items-center justify-center w-full h-full space-y-1 ${
                isActive ? "text-primary" : "text-muted-foreground"
              }`}
            >
              <item.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
