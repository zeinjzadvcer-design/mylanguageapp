/**
 * Payments: prices, receiving accounts, and the review queue.
 *
 * Four jobs on one screen because they belong to the same person and the first
 * three are prerequisites for the fourth: an admin prices the plans, sets up
 * where money is received, then works the queue as payments arrive.
 *
 * Bilingual like the rest of the admin area. It used to be Arabic-only with a
 * forced right-to-left layout, which laid the page out backwards for an admin
 * using the app in English.
 */

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetPaymentSubmissions1,
  useApprovePaymentSubmission,
  useRejectPaymentSubmission,
  useGetPaymentSettings,
  useUpdatePaymentSettings,
  useRotateIngestToken,
  useRefreshSypRate,
  useGetSubscriptionPlans,
  useUpdatePlanPrice,
  useGetPaymentSettingsHistory,
  getGetPaymentSettingsHistoryQueryKey,
  type PaymentSettings,
  type PaymentSettingsUpdate,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";
import { useCan } from "@/lib/permissions";
import { formatAmount } from "@/lib/utils";
import { uploadPaymentImage, MediaUploadError } from "@/lib/media-api";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";

/**
 * `verifying` is a tab of its own, not folded into `pending`.
 *
 * A Syriatel or crypto submission starts there: the matcher decides next, so it
 * is not yet an admin's to action. But it must still be VISIBLE — a payment
 * whose confirmation never arrived, or whose student mistyped a number, would
 * otherwise sit in a status no screen showed and nobody could help.
 */
type StatusFilter = "pending" | "verifying" | "approved" | "rejected";

/** The settings update, with the error body the server sends on a refusal. */
type ApiErr = { status?: number; data?: { errorAr?: string; error?: string } };

export default function AdminPayments() {
  const { toast } = useToast();
  const { t, lang, pick } = useI18n();
  const can = useCan();
  const pa = t.payment.admin;
  const [status, setStatus] = useState<StatusFilter>("pending");

  const submissions = useGetPaymentSubmissions1({ status });
  const approve = useApprovePaymentSubmission();
  const reject = useRejectPaymentSubmission();

  /** Per-row rejection reason. Required, so it is held per submission. */
  const [reasons, setReasons] = useState<Record<number, string>>({});

  const handleApprove = (id: number) => {
    approve.mutate(
      { id, data: {} },
      {
        onSuccess: (res) => {
          toast({
            title: res?.alreadyActive ? pa.alreadyActiveTitle : pa.activatedTitle,
            description: res?.alreadyActive ? pa.alreadyActiveBody : pa.activatedBody,
          });
          void submissions.refetch();
        },
        onError: (err) => {
          // The server explains the one refusal an admin can act on (the
          // subscription was already activated); anything else is generic.
          const data = (err as ApiErr)?.data;
          toast({
            variant: "destructive",
            title: t.subscription.error,
            description: (lang === "ar" ? data?.errorAr : data?.error) ?? pa.activateFailed,
          });
        },
      },
    );
  };

  const handleReject = (id: number) => {
    const reviewNote = (reasons[id] ?? "").trim();
    if (!reviewNote) {
      // Enforced here as well as on the server: a rejection the student cannot
      // see a reason for becomes a support ticket.
      toast({ variant: "destructive", title: pa.reasonRequiredTitle, description: pa.reasonRequiredBody });
      return;
    }

    reject.mutate(
      { id, data: { reviewNote } },
      {
        onSuccess: () => {
          toast({ title: pa.rejectedTitle, description: pa.rejectedBody });
          setReasons((r) => ({ ...r, [id]: "" }));
          void submissions.refetch();
        },
        onError: () =>
          toast({ variant: "destructive", title: t.subscription.error, description: pa.rejectFailed }),
      },
    );
  };

  const rows = submissions.data ?? [];
  const busy = approve.isPending || reject.isPending;
  const statusLabel: Record<StatusFilter, string> = {
    pending: pa.tabPending,
    verifying: pa.tabVerifying,
    approved: pa.tabApproved,
    rejected: pa.tabRejected,
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        {can("students.manage") && (
          <Link href="/admin">
            <Button variant="ghost" size="icon" aria-label={t.common.back}>
              {/* Points backwards in either reading direction. */}
              <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
            </Button>
          </Link>
        )}
        <div>
          <h1 className="text-2xl font-bold">{pa.title}</h1>
          <p className="text-muted-foreground text-sm">{pa.subtitle}</p>
        </div>
      </div>

      {can("payments.settings") && (
        <>
          <PricingSettings />

          <WalletSettings />

          {/* Not shown at all to staff: they cannot change it, and the
              server sends them none of it. */}
          {can("payments.crypto") && <CryptoSettings />}

          {can("payments.crypto") && <SettingsHistory />}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-3">
            <span>{pa.queueTitle}</span>
            <div className="flex flex-wrap gap-2">
              {(["pending", "verifying", "approved", "rejected"] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={status === s ? "default" : "outline"}
                  onClick={() => setStatus(s)}
                >
                  {statusLabel[s]}
                </Button>
              ))}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {submissions.isLoading && <Skeleton className="h-32 w-full rounded-xl" />}

          {!submissions.isLoading && rows.length === 0 && (
            <p className="text-muted-foreground text-center py-8">{pa.empty}</p>
          )}

          {status === "verifying" && rows.length > 0 && (
            <p className="text-xs text-muted-foreground leading-relaxed bg-secondary/40 rounded-lg p-3">
              {pa.verifyingNote}
            </p>
          )}

          {rows.map((row) => (
            <div key={row.id} className="border rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold">{row.studentName}</p>
                  <p className="text-sm text-muted-foreground" dir="ltr">
                    {row.studentEmail}
                  </p>
                </div>
                <div className="text-end">
                  <p className="font-bold text-primary" dir="ltr">
                    ${formatAmount(row.amountExpected)}
                  </p>
                  <Badge variant="outline">{pick(row.planNameAr, row.planName)}</Badge>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">
                  {row.method === "syriatel_cash"
                    ? t.subscription.walletName
                    : row.method === "crypto_usdt_bep20"
                      ? t.subscription.cryptoName
                      : row.method}
                </Badge>
                <Badge variant="outline" dir="ltr">
                  {row.createdAt
                    ? new Date(row.createdAt).toLocaleString(lang === "ar" ? "ar" : "en")
                    : "—"}
                </Badge>
              </div>

              {row.studentNote && (
                <p className="text-sm bg-secondary/50 rounded-lg p-3 whitespace-pre-line">
                  {row.studentNote}
                </p>
              )}

              {/* The receipt. A signed URL, so it expires — reload to refresh. */}
              {row.receiptUrl && (
                <a href={row.receiptUrl} target="_blank" rel="noreferrer">
                  <img
                    src={row.receiptUrl}
                    alt={pa.receiptAlt}
                    className="max-h-64 rounded-lg border object-contain bg-white"
                  />
                </a>
              )}

              {row.method === "syriatel_cash" && row.operationNumber && (
                <div className="text-xs space-y-1 bg-secondary/50 rounded-lg p-3" dir="ltr">
                  <p>
                    <strong>operation:</strong> {row.operationNumber}
                  </p>
                  {row.amountExpectedSyp && (
                    <p>
                      <strong>expected:</strong> {row.amountExpectedSyp} SYP
                    </p>
                  )}
                  {/* What the matcher saw, so an admin is not guessing why a
                      payment needs a human. */}
                  {row.verificationLog != null && (
                    <pre className="whitespace-pre-wrap text-[11px] opacity-80">
                      {JSON.stringify(row.verificationLog, null, 1)}
                    </pre>
                  )}
                </div>
              )}

              {row.method === "crypto_usdt_bep20" && (
                <div className="text-xs space-y-1 bg-secondary/50 rounded-lg p-3" dir="ltr">
                  <p className="break-all">
                    <strong>tx:</strong> {row.txHash}
                  </p>
                  {row.amountObserved && (
                    <p>
                      <strong>observed:</strong> {row.amountObserved} USDT
                    </p>
                  )}
                  {row.senderAddress && (
                    <p className="break-all">
                      <strong>from:</strong> {row.senderAddress}
                    </p>
                  )}
                  {row.verificationLog != null && (
                    <pre className="whitespace-pre-wrap text-[11px] opacity-80">
                      {JSON.stringify(row.verificationLog, null, 1)}
                    </pre>
                  )}
                </div>
              )}

              {row.reviewNote && status !== "pending" && (
                <p className="text-sm text-muted-foreground">
                  <strong>{pa.reviewNote}</strong> {row.reviewNote}
                </p>
              )}

              {(status === "pending" || status === "verifying") && row.id != null && (
                <div className="space-y-2 pt-2 border-t">
                  <Label className="text-xs">{pa.rejectReasonLabel}</Label>
                  <Textarea
                    rows={2}
                    value={reasons[row.id] ?? ""}
                    onChange={(e) =>
                      setReasons((r) => ({ ...r, [row.id as number]: e.target.value }))
                    }
                    placeholder={pa.rejectReasonPlaceholder}
                    disabled={busy}
                  />
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      onClick={() => handleApprove(row.id as number)}
                      disabled={busy}
                    >
                      <CheckCircle2 className="h-4 w-4 me-2" />
                      {pa.approve}
                    </Button>
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={() => handleReject(row.id as number)}
                      disabled={busy}
                    >
                      <XCircle className="h-4 w-4 me-2" />
                      {pa.reject}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Shared save for the settings sections: one mutation, one toast, and the
 * server's own reason shown on a refusal — an address rejected as TRON says so
 * rather than reporting a generic failure.
 */
/** Refetch the change history after anything that adds to it. */
function useRefreshHistory() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: getGetPaymentSettingsHistoryQueryKey() });
}

function useSaveSettings() {
  const { toast } = useToast();
  const { t, lang } = useI18n();
  const settings = useGetPaymentSettings();
  const update = useUpdatePaymentSettings();
  const refreshHistory = useRefreshHistory();

  const save = (patch: PaymentSettingsUpdate, onDone?: () => void) => {
    update.mutate(
      { data: patch },
      {
        onSuccess: () => {
          toast({ title: t.payment.admin.saved });
          void settings.refetch();
          refreshHistory();
          onDone?.();
        },
        onError: (err) => {
          const data = (err as ApiErr)?.data;
          toast({
            variant: "destructive",
            title: t.subscription.error,
            description:
              (lang === "ar" ? data?.errorAr : data?.error) ?? t.payment.admin.saveFailed,
          });
        },
      },
    );
  };

  return { settings, save, saving: update.isPending };
}

/** Upload an image as a payment QR and return its media id, or null on failure. */
function useQrUpload() {
  const { toast } = useToast();
  const { t } = useI18n();
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File): Promise<number | null> => {
    setUploading(true);
    try {
      const { mediaId } = await uploadPaymentImage(file, "payment_qr");
      return mediaId;
    } catch (err) {
      toast({
        variant: "destructive",
        title: t.subscription.error,
        description: err instanceof MediaUploadError ? err.message : t.payment.admin.uploadFailed,
      });
      return null;
    } finally {
      setUploading(false);
    }
  };

  return { upload, uploading };
}

/** A file picker styled as a button. */
function QrPicker({
  hasQr,
  uploading,
  onFile,
  disabled = false,
}: {
  hasQr: boolean;
  uploading: boolean;
  onFile: (file: File) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const off = uploading || disabled;
  return (
    <Button variant="outline" asChild disabled={off}>
      <label className={off ? "pointer-events-none opacity-50" : "cursor-pointer"} aria-disabled={off}>
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin me-2" />
        ) : (
          <Upload className="h-4 w-4 me-2" />
        )}
        {hasQr ? t.payment.admin.replaceImage : t.payment.admin.uploadImage}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          disabled={off}
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Cleared so picking the same file again still fires a change.
            e.target.value = "";
            if (f) onFile(f);
          }}
        />
      </label>
    </Button>
  );
}

function formatWhen(iso: string | null | undefined, lang: string): string | null {
  return iso ? new Date(iso).toLocaleString(lang === "ar" ? "ar" : "en") : null;
}

/**
 * Who changed what in the payment settings, and when.
 *
 * Field names only: the server keeps no values in the history, so nothing
 * here can leak a wallet address or account number.
 */
function SettingsHistory() {
  const { t, lang } = useI18n();
  const pa = t.payment.admin;
  const history = useGetPaymentSettingsHistory();
  const entries = history.data?.entries ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{pa.historyTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground leading-relaxed">{pa.historyHelp}</p>
        {history.isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : history.isError ? (
          <p className="text-sm text-destructive">{pa.historyFailed}</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{pa.historyEmpty}</p>
        ) : (
          <ul className="divide-y rounded-lg border max-h-80 overflow-y-auto">
            {entries.map((entry) => (
              <li key={entry.id} className="p-3 text-sm space-y-1">
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <span>{entry.byName ?? pa.unknownAdmin}</span>
                  <span>{formatWhen(entry.createdAt, lang)}</span>
                </div>
                <div>
                  {entry.target && <span className="font-medium">{pa.historyPlan(entry.target)}: </span>}
                  {entry.changes
                    .map(
                      (c) =>
                        `${pa.historyFields[c.field] ?? c.field} — ${pa.historyChange[c.change] ?? c.change}`,
                    )
                    .join(lang === "ar" ? "، " : ", ")}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Plan prices, in dollars and Syrian pounds.
 *
 * Two modes for the SYP figure. Manual: the admin types it. Automatic: it is
 * the dollar price × a rate fetched from SP Today (الليرة اليوم), rounded up to
 * a whole pound. The manual figures stay editable in automatic mode — they are
 * what students are charged if no rate has been fetched yet, so switching to
 * automatic never takes a selling plan off sale.
 */
function PricingSettings() {
  const refreshHistory = useRefreshHistory();
  const { toast } = useToast();
  const { t, lang, pick } = useI18n();
  const pa = t.payment.admin;
  const plans = useGetSubscriptionPlans();
  const updatePrice = useUpdatePlanPrice();
  const refresh = useRefreshSypRate();
  const { settings, save, saving } = useSaveSettings();

  /**
   * Edits in progress, keyed by plan code. Held per plan so one Save writes
   * both prices together: a tier's dollar and pound figures are one decision.
   */
  const [draft, setDraft] = useState<Record<string, { usd: string; syp: string }>>({});

  if (plans.isLoading || settings.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  const s = settings.data;
  const auto = Boolean(s?.sypRateAuto);
  const sellable = (plans.data ?? []).filter((plan) => plan.code !== "free");

  const savePlan = (code: string, usdRaw: string, sypRaw: string) => {
    const priceUsd = Number(usdRaw.trim());
    if (usdRaw.trim() === "" || !Number.isFinite(priceUsd) || priceUsd < 0) {
      toast({ variant: "destructive", title: pa.invalidUsdTitle, description: pa.invalidUsdBody });
      return;
    }
    // Empty means "no manual figure", which is a null rather than a 0: zero
    // would read as a free plan and let a payment of nothing verify.
    const priceSyp = sypRaw.trim() === "" ? null : Number(sypRaw.trim());
    if (priceSyp !== null && (!Number.isFinite(priceSyp) || priceSyp <= 0)) {
      toast({ variant: "destructive", title: pa.invalidSypTitle, description: pa.invalidSypBody });
      return;
    }

    updatePrice.mutate(
      { code, data: { priceUsd, priceSyp } },
      {
        onSuccess: () => {
          toast({ title: pa.pricesSaved });
          refreshHistory();
          setDraft((d) => {
            const next = { ...d };
            delete next[code];
            return next;
          });
          void plans.refetch();
        },
        onError: () =>
          toast({ variant: "destructive", title: t.subscription.error, description: pa.pricesSaveFailed }),
      },
    );
  };

  const doRefresh = () =>
    refresh.mutate(undefined, {
      onSuccess: () => {
        toast({ title: pa.rateRefreshed });
        void settings.refetch();
        void plans.refetch();
      },
      onError: () => {
        toast({ variant: "destructive", title: t.subscription.error, description: pa.rateRefreshFailed });
        void settings.refetch();
      },
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{pa.pricingTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-start justify-between gap-4 border rounded-xl p-4">
          <div className="space-y-1">
            <Label htmlFor="syp-auto" className="font-bold">
              {pa.autoRateLabel}
            </Label>
            <p className="text-xs text-muted-foreground leading-relaxed">{pa.autoRateHelp}</p>
          </div>
          <Switch
            id="syp-auto"
            checked={auto}
            disabled={saving}
            onCheckedChange={(checked) => save({ sypRateAuto: checked }, () => void plans.refetch())}
          />
        </div>

        {auto && (
          <div className="space-y-3 border rounded-xl p-4 bg-secondary/30">
            {!s?.sptodayConfigured && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3 text-amber-800 text-sm">
                <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
                <span>{pa.noApiKey}</span>
              </div>
            )}

            {/* Which pound. Syria redenominated at 100 old = 1 new and SP Today
                still reports in old, so getting this wrong prices every plan a
                hundred times too high or too low. */}
            <div className="space-y-2">
              <Label className="text-xs">{pa.unitLabel}</Label>
              <div className="flex gap-2">
                {(["new", "old"] as const).map((unit) => (
                  <Button
                    key={unit}
                    size="sm"
                    variant={s?.sypUnit === unit ? "default" : "outline"}
                    disabled={saving}
                    onClick={() => save({ sypUnit: unit }, () => void plans.refetch())}
                  >
                    {unit === "new" ? pa.unitNew : pa.unitOld}
                  </Button>
                ))}
              </div>
            </div>

            <div className="text-sm space-y-1">
              <p>
                <strong>{pa.currentRate}</strong>{" "}
                {s?.sypRate ? (
                  <span dir="ltr">
                    1 USD = {Number(s.sypRate).toLocaleString("en", { maximumFractionDigits: 2 })}{" "}
                    {t.subscription.syp}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{pa.noRateYet}</span>
                )}
              </p>
              {s?.sypRateFetchedAt && (
                <p className="text-xs text-muted-foreground">
                  {pa.fetchedAt(formatWhen(s.sypRateFetchedAt, lang) ?? "")}
                  {s.sypRateSourceUpdatedAt &&
                    ` · ${pa.sourceUpdatedAt(formatWhen(s.sypRateSourceUpdatedAt, lang) ?? "")}`}
                </p>
              )}
              {/* A feed that has quietly stopped updating is the failure that
                  matters here, so the last error is shown rather than hidden. */}
              {s?.sypRateError && (
                <p className="text-xs text-destructive break-words">
                  {pa.lastError} {s.sypRateError}
                </p>
              )}
            </div>

            <Button
              size="sm"
              variant="outline"
              disabled={!s?.sptodayConfigured || refresh.isPending}
              onClick={doRefresh}
            >
              {refresh.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin me-2" />
              ) : (
                <RefreshCw className="h-4 w-4 me-2" />
              )}
              {pa.refreshNow}
            </Button>
            <p className="text-xs text-muted-foreground">{pa.refreshHelp}</p>
          </div>
        )}

        {sellable.map((plan) => {
          const code = plan.code ?? "";
          const savedUsd = String(plan.priceUsd ?? "");
          const savedSyp = plan.priceSypManual ?? "";
          const d = draft[code];
          const usd = d?.usd ?? savedUsd;
          const syp = d?.syp ?? String(savedSyp);
          const dirty = d !== undefined && (d.usd !== savedUsd || d.syp !== String(savedSyp));

          // Seeds the draft from what is displayed, then applies the patch, so
          // typing in one field does not blank the other.
          const edit = (patch: { usd?: string; syp?: string }) =>
            setDraft((prev) => {
              const existing = prev[code] ?? { usd, syp };
              return {
                ...prev,
                [code]: { usd: patch.usd ?? existing.usd, syp: patch.syp ?? existing.syp },
              };
            });

          return (
            <div key={code} className="flex flex-wrap items-end gap-3 border rounded-xl p-3">
              <div className="flex-1 min-w-[160px]">
                <p className="font-bold">{pick(plan.nameAr, plan.name)}</p>
                <p className="text-xs text-muted-foreground">
                  {t.subscription.lessonsPerMonth(plan.lessonsPerMonth)} ·{" "}
                  {t.subscription.callsPerMonth(plan.callsPerMonth)}
                </p>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">{pa.usd}</Label>
                <Input
                  className="w-28 font-mono"
                  dir="ltr"
                  inputMode="decimal"
                  value={usd}
                  onChange={(e) => edit({ usd: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">{auto ? pa.sypFallback : pa.syp}</Label>
                <Input
                  className="w-36 font-mono"
                  dir="ltr"
                  inputMode="decimal"
                  placeholder={pa.notSet}
                  value={syp}
                  onChange={(e) => edit({ syp: e.target.value })}
                />
              </div>

              <Button
                size="sm"
                variant={dirty ? "default" : "outline"}
                disabled={!dirty || updatePrice.isPending}
                onClick={() => savePlan(code, usd, syp)}
              >
                {updatePrice.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : t.common.save}
              </Button>

              {/* What a student is actually charged right now, whichever mode
                  produced it — the number to sanity-check against the unit. */}
              <p className="text-xs w-full">
                {plan.priceSyp ? (
                  <>
                    {pa.chargedNow}{" "}
                    <strong dir="ltr">
                      {Number(plan.priceSyp).toLocaleString("en")} {t.subscription.syp}
                    </strong>
                    {auto && s?.sypRate && <span className="text-muted-foreground"> {pa.fromRate}</span>}
                  </>
                ) : (
                  <span className="text-amber-700">⚠ {pa.walletDisabledForPlan}</span>
                )}
              </p>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/**
 * Syriatel Cash receive details.
 *
 * Admin-editable. A swapped QR here produces no matching confirmation SMS on
 * the merchant phone, so nothing activates — the mismatch is caught.
 */
function WalletSettings() {
  const { toast } = useToast();
  const { t } = useI18n();
  const can = useCan();
  const canEdit = can("payments.wallet");
  const canIssueToken = can("payments.sms_token");
  const refreshHistory = useRefreshHistory();
  const pa = t.payment.admin;
  const { settings, save, saving } = useSaveSettings();
  const { upload, uploading } = useQrUpload();

  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [instructions, setInstructions] = useState("");
  const [merchantPhone, setMerchantPhone] = useState("");
  /**
   * The generated token, held only until the page is left. The server returns
   * it once and never again: anything able to POST a forwarded SMS can mint a
   * subscription, so the admin must copy it now.
   */
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const rotateToken = useRotateIngestToken();

  // Fill the form once the saved values arrive, without clobbering edits in
  // progress on a refetch.
  useEffect(() => {
    if (!settings.data) return;
    setAccountName(settings.data.walletAccountName ?? "");
    setAccountNumber(settings.data.walletAccountNumber ?? "");
    setInstructions(settings.data.walletInstructionsAr ?? "");
    setMerchantPhone(settings.data.walletMerchantPhone ?? "");
  }, [settings.data?.updatedAt]);

  if (settings.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  const hasQr = Boolean(settings.data?.walletQrMediaId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{pa.walletTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {!hasQr && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex gap-3 text-amber-800 text-sm">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <span>{pa.walletNoQr}</span>
          </div>
        )}

        {!canEdit && <p className="text-sm text-muted-foreground">{pa.adminOnly}</p>}

        <fieldset disabled={!canEdit} className="min-w-0 space-y-5">
          <div className="space-y-2">
            <Label className="font-bold">{pa.receiveQr}</Label>
            <div className="flex items-center gap-3">
              {canEdit && (
                <QrPicker
                  hasQr={hasQr}
                  uploading={uploading}
                  onFile={async (file) => {
                    const mediaId = await upload(file);
                    if (mediaId !== null) save({ walletQrMediaId: mediaId });
                  }}
                />
              )}
              {hasQr && (
                <span className="text-sm text-mint-foreground flex items-center gap-1">
                  <CheckCircle2 className="h-4 w-4" /> {pa.uploaded}
                </span>
              )}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{pa.accountName}</Label>
              <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{pa.accountNumber}</Label>
              <Input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} dir="ltr" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{pa.merchantPhone}</Label>
            <Input
              value={merchantPhone}
              onChange={(e) => setMerchantPhone(e.target.value)}
              dir="ltr"
              placeholder="09xxxxxxxx"
            />
            <p className="text-xs text-muted-foreground">{pa.merchantPhoneHelp}</p>
          </div>

          <div className="space-y-2">
            <Label>{pa.instructions}</Label>
            <Textarea
              rows={3}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={pa.instructionsPlaceholder}
            />
          </div>
        </fieldset>

        <div className="space-y-2 pt-4 border-t">
          <Label className="font-bold">{pa.companionTitle}</Label>
          <p className="text-xs text-muted-foreground leading-relaxed">{pa.companionHelp}</p>

          {freshToken ? (
            // Shown once. The server does not return it again, so an admin who
            // navigates away must generate a new one.
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
              <p className="text-xs text-amber-800 font-bold">{pa.tokenCopyNow}</p>
              <code className="block text-xs bg-white rounded p-2 break-all" dir="ltr">
                {freshToken}
              </code>
            </div>
          ) : (
            <p className="text-xs">
              {settings.data?.hasIngestToken ? `✓ ${pa.tokenExists}` : pa.tokenMissing}
            </p>
          )}

          {canIssueToken && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rotateToken.isPending}
              onClick={() =>
                rotateToken.mutate(undefined, {
                  onSuccess: (res) => {
                    setFreshToken(res?.token ?? null);
                    void settings.refetch();
                    refreshHistory();
                  },
                  onError: () =>
                    toast({ variant: "destructive", title: t.subscription.error, description: pa.tokenFailed }),
                })
              }
            >
              {rotateToken.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : settings.data?.hasIngestToken ? (
                pa.tokenRotate
              ) : (
                pa.tokenCreate
              )}
            </Button>
          )}
        </div>

        {canEdit && (
          <Button
            onClick={() =>
              save({
                walletAccountName: accountName.trim() || null,
                walletAccountNumber: accountNumber.trim() || null,
                walletInstructionsAr: instructions.trim() || null,
                walletMerchantPhone: merchantPhone.trim() || null,
              })
            }
            disabled={saving}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : t.common.save}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The crypto receiving wallet.
 *
 * Students are offered crypto only once an address or a QR is set here, and it
 * disappears again when both are removed. With an address, payments are
 * confirmed on chain; with only a QR, an admin reviews each one, because there
 * is nothing to check the recipient against.
 *
 * Every change is shown with who made it. The address decides where money goes
 * and a crypto payment is otherwise verified with nobody looking, so a change
 * an admin did not expect is the thing to notice.
 */
function CryptoSettings() {
  const { t, lang } = useI18n();
  const can = useCan();
  const canEdit = can("payments.crypto");
  const pa = t.payment.admin;
  const { settings, save, saving } = useSaveSettings();
  const { upload, uploading } = useQrUpload();
  const [address, setAddress] = useState("");
  // Asked for on every change, and forgotten once it has been used.
  const [password, setPassword] = useState("");
  const hasPassword = password !== "";
  const saveCrypto = (patch: PaymentSettingsUpdate, onDone?: () => void) =>
    save({ ...patch, currentPassword: password }, () => {
      setPassword("");
      onDone?.();
    });

  useEffect(() => {
    setAddress(settings.data?.cryptoWalletAddress ?? "");
  }, [settings.data?.cryptoWalletAddress]);

  if (settings.isLoading) return <Skeleton className="h-48 w-full rounded-xl" />;

  const s: PaymentSettings | undefined = settings.data;
  const savedAddress = s?.cryptoWalletAddress ?? null;
  const hasQr = Boolean(s?.cryptoQrMediaId);
  const offered = Boolean(savedAddress || hasQr);
  const addressDirty = address.trim().toLowerCase() !== (savedAddress ?? "");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3">
          <span>{pa.cryptoTitle}</span>
          <Badge variant={offered ? "default" : "outline"}>
            {offered ? pa.cryptoShown : pa.cryptoHidden}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground leading-relaxed">{pa.cryptoHelp}</p>

        {!canEdit && <p className="text-sm text-muted-foreground">{pa.adminOnly}</p>}

        {canEdit && (
          <div className="space-y-2">
            <Label className="font-bold" htmlFor="crypto-password">
              {pa.cryptoPassword}
            </Label>
            <Input
              id="crypto-password"
              type="password"
              autoComplete="current-password"
              className="max-w-xs"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{pa.cryptoPasswordHelp}</p>
          </div>
        )}

        <div className="space-y-2">
          <Label className="font-bold">{pa.cryptoAddress}</Label>
          <div className="flex flex-wrap gap-2">
            <Input
              className="flex-1 min-w-[260px] font-mono text-xs"
              dir="ltr"
              placeholder="0x…"
              value={address}
              readOnly={!canEdit}
              onChange={(e) => setAddress(e.target.value)}
            />
            {canEdit && (
              <Button
                disabled={!addressDirty || saving || address.trim() === "" || !hasPassword}
                onClick={() => saveCrypto({ cryptoWalletAddress: address.trim() })}
              >
                {t.common.save}
              </Button>
            )}
            {canEdit && savedAddress && (
              <Button
                variant="outline"
                disabled={saving || !hasPassword}
                onClick={() => saveCrypto({ cryptoWalletAddress: null }, () => setAddress(""))}
                aria-label={pa.remove}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{pa.cryptoAddressHelp}</p>
        </div>

        <div className="space-y-2">
          <Label className="font-bold">{pa.cryptoQr}</Label>
          <div className="flex flex-wrap items-center gap-3">
            {canEdit && (
              <QrPicker
                hasQr={hasQr}
                uploading={uploading}
                disabled={!hasPassword}
                onFile={async (file) => {
                  const mediaId = await upload(file);
                  if (mediaId !== null) saveCrypto({ cryptoQrMediaId: mediaId });
                }}
              />
            )}
            {hasQr && (
              <span className="text-sm text-mint-foreground flex items-center gap-1">
                <CheckCircle2 className="h-4 w-4" /> {pa.uploaded}
              </span>
            )}
            {canEdit && hasQr && (
              <Button
                variant="outline"
                size="sm"
                disabled={saving || !hasPassword}
                onClick={() => saveCrypto({ cryptoQrMediaId: null })}
              >
                <Trash2 className="h-4 w-4 me-2" />
                {pa.remove}
              </Button>
            )}
          </div>
        </div>

        {/* QR only: students can pay, but nothing can confirm the payment
            reached this wallet, so each one lands in the queue below. */}
        {hasQr && !savedAddress && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3 text-amber-800 text-sm">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <span>{pa.cryptoQrOnly}</span>
          </div>
        )}

        {s?.cryptoUpdatedAt && (
          <p className="text-xs text-muted-foreground">
            {pa.lastChanged(
              formatWhen(s.cryptoUpdatedAt, lang) ?? "",
              s.cryptoUpdatedByName ?? pa.unknownAdmin,
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
