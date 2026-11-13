import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetUnreadNotificationCountQueryKey,
  getListNotificationsQueryKey,
  useGetUnreadNotificationCount,
  useListNotifications,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  type Notification,
} from "@workspace/api-client-react";
import { formatDistanceToNow } from "date-fns";
import { Bell, BookOpen, CheckCircle2, ClipboardCheck, GraduationCap, Loader2, XCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** How often the badge asks whether anything new arrived. */
const POLL_MS = 60_000;

const ICONS: Record<Notification["kind"], typeof Bell> = {
  subscription_approved: CheckCircle2,
  subscription_rejected: XCircle,
  lesson_reminder: BookOpen,
  quiz_available: GraduationCap,
  evaluation_available: ClipboardCheck,
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** The bell, its unread badge, and the list it opens. */
export function NotificationBell({ className }: { className?: string }) {
  const { t, pick, dateLocale, lang } = useI18n();
  const n = t.notifications;
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const count = useGetUnreadNotificationCount({
    query: {
      queryKey: getGetUnreadNotificationCountQueryKey(),
      refetchInterval: POLL_MS,
      refetchOnWindowFocus: true,
    },
  });
  const list = useListNotifications(undefined, {
    query: { queryKey: getListNotificationsQueryKey(), enabled: open },
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetUnreadNotificationCountQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
  };
  // Refreshed from the mutation itself, not from mutate()'s callbacks: opening a
  // notification navigates away, the bell remounts with the new page, and
  // callbacks passed to mutate() are dropped once their component unmounts —
  // which left the badge counting a notification already read.
  const markOne = useMarkNotificationRead({ mutation: { onSettled: refresh } });
  const markAll = useMarkAllNotificationsRead({ mutation: { onSettled: refresh } });

  // The count query first: it is always running, while the list query is off
  // whenever the list is closed, so its number can be out of date.
  const unread = count.data?.unread ?? list.data?.unread ?? 0;

  /** The wording for one notification, in the current language. */
  const describe = (item: Notification): { title: string; body: string } => {
    const d = item.data ?? {};
    const plan = pick(str(d.planNameAr), str(d.planName)) || n.yourPlan;
    const quiz = pick(str(d.titleAr), str(d.title));
    switch (item.kind) {
      case "subscription_approved": {
        const expires = str(d.expiresAt);
        const until = expires ? new Date(expires).toLocaleDateString(lang === "ar" ? "ar" : "en") : null;
        return { title: n.subscriptionApproved.title, body: n.subscriptionApproved.body(plan, until) };
      }
      case "subscription_rejected":
        return { title: n.subscriptionRejected.title, body: n.subscriptionRejected.body(plan, str(d.reason)) };
      case "lesson_reminder":
        return {
          title: n.lessonReminder.title,
          body: d.placement === true ? n.lessonReminder.placementBody : n.lessonReminder.body,
        };
      case "quiz_available":
        return { title: n.quizAvailable.title, body: n.quizAvailable.body(quiz) };
      case "evaluation_available":
        return { title: n.evaluationAvailable.title, body: n.evaluationAvailable.body(quiz) };
      default:
        // A kind this build does not know yet: the API and the web app deploy
        // separately, and either can go first. Shown plainly rather than
        // breaking the list.
        return { title: n.title, body: "" };
    }
  };

  const openItem = (item: Notification) => {
    if (!item.readAt) markOne.mutate({ id: item.id });
    setOpen(false);
    if (item.link) setLocation(item.link);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("relative h-10 w-10 text-muted-foreground", className)}
          aria-label={unread > 0 ? `${n.title}: ${n.unread(unread)}` : n.title}
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute top-1 end-1 min-w-[1.125rem] h-[1.125rem] px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-bold leading-[1.125rem] text-center tabular-nums">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      {/* Full width less a margin on a phone, a fixed column from small tablets
          up. The list scrolls inside a bounded height so the popover never runs
          past the bottom navigation. */}
      <PopoverContent
        align="end"
        collisionPadding={12}
        className="w-[calc(100vw-1.5rem)] sm:w-96 p-0 overflow-hidden"
      >
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
          <h2 className="font-bold text-foreground">{n.title}</h2>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 text-primary"
              disabled={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              {n.markAllRead}
            </Button>
          )}
        </div>

        <div className="max-h-[min(65dvh,28rem)] overflow-y-auto overscroll-contain">
          {list.isLoading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : list.isError ? (
            <p className="px-4 py-8 text-center text-sm text-destructive">{n.loadError}</p>
          ) : !list.data?.items.length ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{n.empty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {list.data.items.map((item) => {
                const Icon = ICONS[item.kind] ?? Bell;
                const { title, body } = describe(item);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => openItem(item)}
                      className={cn(
                        "w-full flex gap-3 px-4 py-3 text-start transition-colors hover:bg-secondary focus-visible:bg-secondary outline-none min-h-[3.5rem]",
                        !item.readAt && "bg-primary/5",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 h-9 w-9 shrink-0 rounded-full flex items-center justify-center",
                          item.kind === "subscription_rejected"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-primary/10 text-primary",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start gap-2">
                          <span className={cn("flex-1 text-sm text-foreground break-words", !item.readAt && "font-bold")}>
                            {title}
                          </span>
                          {!item.readAt && (
                            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label={n.unreadDot} />
                          )}
                        </span>
                        <span className="block text-sm text-muted-foreground break-words">{body}</span>
                        <span className="block text-xs text-muted-foreground/80 mt-1">
                          {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true, locale: dateLocale })}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
