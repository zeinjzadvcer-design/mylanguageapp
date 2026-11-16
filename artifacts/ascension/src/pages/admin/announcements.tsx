/**
 * Admin announcements: write one, choose who receives it, see how many
 * students that is, then send. Below, everything sent so far.
 *
 * The audience is by plan, since the plans are what divide students: the
 * general and professional tracks, each with its own plans, and the free plan,
 * which is general-track but offered as its own choice so a message meant for
 * paying students does not reach free ones by accident.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Megaphone, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";
import {
  announcementsApi,
  AnnouncementsError,
  type Audience,
  type AudiencePlan,
} from "@/lib/announcements-api";

type Mode = "all" | "general" | "professional" | "plans";

/** The audience the form describes, or null when it names no plan at all. */
function audienceFor(
  mode: Mode,
  plans: AudiencePlan[],
  includeFree: boolean,
  chosen: string[],
): Audience | null {
  if (mode === "all") return { kind: "all" };
  const codes =
    mode === "plans"
      ? chosen
      : plans
          .filter((p) => p.track === mode && p.code !== "free")
          .map((p) => p.code)
          .concat(mode === "general" && includeFree ? ["free"] : []);
  return codes.length > 0 ? { kind: "plans", planCodes: codes } : null;
}

export default function AdminAnnouncements() {
  const { t, pick, lang } = useI18n();
  const a = t.admin.announcements;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [title, setTitle] = useState("");
  const [titleAr, setTitleAr] = useState("");
  const [body, setBody] = useState("");
  const [bodyAr, setBodyAr] = useState("");
  const [link, setLink] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [includeFree, setIncludeFree] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);

  const list = useQuery({ queryKey: ["admin-announcements"], queryFn: announcementsApi.list });
  const plans = list.data?.plans ?? [];

  const audience = useMemo(
    () => audienceFor(mode, plans, includeFree, chosen),
    [mode, plans, includeFree, chosen],
  );

  // Recounted whenever the audience changes, so the number on screen is the
  // number the send will reach.
  const preview = useQuery({
    queryKey: ["admin-announcement-preview", audience],
    queryFn: () => announcementsApi.preview(audience!),
    enabled: audience !== null && list.isSuccess,
  });
  const recipients = preview.data?.recipients;

  const send = useMutation({
    mutationFn: () =>
      announcementsApi.send({
        title: title.trim() || null,
        titleAr: titleAr.trim() || null,
        body: body.trim() || null,
        bodyAr: bodyAr.trim() || null,
        link: link.trim() || null,
        audience: audience!,
      }),
    onSuccess: (result) => {
      toast({ title: a.sent(result.recipients) });
      setTitle("");
      setTitleAr("");
      setBody("");
      setBodyAr("");
      setLink("");
      void qc.invalidateQueries({ queryKey: ["admin-announcements"] });
    },
    onError: (e) =>
      toast({
        variant: "destructive",
        title: a.sendError,
        description: e instanceof AnnouncementsError ? e.message : undefined,
      }),
  });

  const problem = !title.trim() && !titleAr.trim()
    ? a.needTitle
    : !body.trim() && !bodyAr.trim()
      ? a.needBody
      : audience === null
        ? a.needPlan
        : recipients === 0
          ? a.noRecipients
          : null;

  const submit = () => {
    if (problem || recipients === undefined) return;
    if (!window.confirm(a.confirm(recipients))) return;
    send.mutate();
  };

  const planName = (code: string) => {
    const plan = plans.find((p) => p.code === code);
    return plan ? pick(plan.nameAr, plan.name) : code;
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
          <Megaphone className="h-7 w-7 text-primary" />
          {a.title}
        </h1>
        <p className="text-muted-foreground mt-1">{a.subtitle}</p>
      </div>

      <Card className="border-2">
        <CardContent className="p-5 space-y-5">
          <h2 className="font-bold text-lg">{a.newTitle}</h2>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ann-title">{a.titleEn}</Label>
              <Input id="ann-title" dir="ltr" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ann-title-ar">{a.titleAr}</Label>
              <Input id="ann-title-ar" dir="rtl" maxLength={120} value={titleAr} onChange={(e) => setTitleAr(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ann-body">{a.bodyEn}</Label>
              <Textarea id="ann-body" dir="ltr" rows={4} maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ann-body-ar">{a.bodyAr}</Label>
              <Textarea id="ann-body-ar" dir="rtl" rows={4} maxLength={1000} value={bodyAr} onChange={(e) => setBodyAr(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{a.bothLanguagesHint}</p>

          <div className="space-y-1 max-w-md">
            <Label htmlFor="ann-link">{a.link}</Label>
            <Input id="ann-link" dir="ltr" placeholder="/lessons" maxLength={300} value={link} onChange={(e) => setLink(e.target.value)} />
            <p className="text-xs text-muted-foreground">{a.linkHint}</p>
          </div>

          <div className="space-y-3 border-t pt-4">
            <div className="space-y-1 max-w-md">
              <Label>{a.audience}</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{a.all}</SelectItem>
                  <SelectItem value="general">{a.generalTrack}</SelectItem>
                  <SelectItem value="professional">{a.professionalTrack}</SelectItem>
                  <SelectItem value="plans">{a.choosePlans}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === "general" && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={includeFree} onCheckedChange={(v) => setIncludeFree(!!v)} />
                {a.includeFree}
              </label>
            )}

            {mode === "plans" && (
              <div className="grid gap-2 sm:grid-cols-2">
                {plans.map((plan) => (
                  <label key={plan.code} className="flex items-center gap-2 text-sm rounded-md border p-2">
                    <Checkbox
                      checked={chosen.includes(plan.code)}
                      onCheckedChange={(v) =>
                        setChosen((prev) =>
                          v ? [...prev, plan.code] : prev.filter((code) => code !== plan.code),
                        )
                      }
                    />
                    {pick(plan.nameAr, plan.name)}
                  </label>
                ))}
              </div>
            )}

            {(mode === "general" || mode === "professional") && (
              <div className="flex flex-wrap gap-2">
                {(audience?.kind === "plans" ? audience.planCodes : []).map((code) => (
                  <Badge key={code} variant="secondary">{planName(code)}</Badge>
                ))}
              </div>
            )}

            <p className="text-sm font-medium" aria-live="polite">
              {audience === null
                ? a.needPlan
                : preview.isFetching || recipients === undefined
                  ? a.counting
                  : a.reaches(recipients)}
            </p>
            <p className="text-xs text-muted-foreground">{a.planRule}</p>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button onClick={submit} disabled={!!problem || recipients === undefined || send.isPending} className="gap-2">
              {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 rtl:-scale-x-100" />}
              {send.isPending ? a.sending : a.send}
            </Button>
            {problem && <span className="text-sm text-muted-foreground">{problem}</span>}
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">{a.historyTitle}</h2>
        {list.isLoading ? (
          <Skeleton className="h-40 w-full rounded-2xl" />
        ) : list.isError ? (
          <p className="text-destructive">{a.loadError}</p>
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <p className="text-muted-foreground">{a.historyEmpty}</p>
        ) : (
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-start">{a.colDate}</TableHead>
                    <TableHead className="text-start">{a.colTitle}</TableHead>
                    <TableHead className="text-start">{a.colAudience}</TableHead>
                    <TableHead className="text-start">{a.colRecipients}</TableHead>
                    <TableHead className="text-start">{a.colSentBy}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.data!.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(item.createdAt).toLocaleString(lang === "ar" ? "ar" : "en")}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{pick(item.titleAr, item.title)}</div>
                        <div className="text-xs text-muted-foreground line-clamp-2">{pick(item.bodyAr, item.body)}</div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {item.planCodes === null ? a.everyone : item.planCodes.map(planName).join("، ")}
                      </TableCell>
                      <TableCell className="tabular-nums">{item.recipientCount}</TableCell>
                      <TableCell className="text-sm">{item.sentByName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}
