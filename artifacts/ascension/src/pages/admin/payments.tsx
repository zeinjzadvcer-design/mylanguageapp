/**
 * Payment review and ShamCash settings.
 *
 * Two jobs on one screen, because they belong to the same person and the
 * second is a prerequisite for the first: an admin configures the receive QR
 * once, then works the review queue as receipts arrive.
 *
 * Arabic, unlike the AI settings panel. This screen reads student names and
 * their own notes, and an admin comparing a receipt against an account number
 * is reading Arabic either way.
 */

import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  useGetPaymentSubmissions1,
  useApprovePaymentSubmission,
  useRejectPaymentSubmission,
  useGetPaymentSettings,
  useUpdatePaymentSettings,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { uploadPaymentImage, MediaUploadError } from "@/lib/media-api";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Upload,
  XCircle,
} from "lucide-react";

type StatusFilter = "pending" | "approved" | "rejected";

export default function AdminPayments() {
  const { toast } = useToast();
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
            title: res?.alreadyActive ? "كان مُفعّلاً مسبقاً" : "تم التفعيل",
            description: res?.alreadyActive
              ? "هذه الدفعة كانت معتمدة بالفعل."
              : "تم تفعيل اشتراك الطالب.",
          });
          void submissions.refetch();
        },
        onError: () =>
          toast({ variant: "destructive", title: "خطأ", description: "تعذر التفعيل." }),
      },
    );
  };

  const handleReject = (id: number) => {
    const reviewNote = (reasons[id] ?? "").trim();
    if (!reviewNote) {
      // Enforced here as well as on the server: a rejection the student cannot
      // see a reason for becomes a support ticket.
      toast({
        variant: "destructive",
        title: "السبب مطلوب",
        description: "اكتب سبب الرفض — سيظهر للطالب.",
      });
      return;
    }

    reject.mutate(
      { id, data: { reviewNote } },
      {
        onSuccess: () => {
          toast({ title: "تم الرفض", description: "تم إبلاغ الطالب بالسبب." });
          setReasons((r) => ({ ...r, [id]: "" }));
          void submissions.refetch();
        },
        onError: () =>
          toast({ variant: "destructive", title: "خطأ", description: "تعذر الرفض." }),
      },
    );
  };

  const rows = submissions.data ?? [];
  const busy = approve.isPending || reject.isPending;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8" dir="rtl">
      <div className="flex items-center gap-3">
        <Link href="/admin">
          <Button variant="ghost" size="icon">
            <ArrowRight className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">المدفوعات</h1>
          <p className="text-muted-foreground text-sm">
            مراجعة إثباتات الدفع وإعداد حساب الاستلام.
          </p>
        </div>
      </div>

      <ShamCashSettings />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>طلبات الدفع</span>
            <div className="flex gap-2">
              {(["pending", "approved", "rejected"] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={status === s ? "default" : "outline"}
                  onClick={() => setStatus(s)}
                >
                  {s === "pending" ? "قيد المراجعة" : s === "approved" ? "مقبولة" : "مرفوضة"}
                </Button>
              ))}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {submissions.isLoading && <Skeleton className="h-32 w-full rounded-xl" />}

          {!submissions.isLoading && rows.length === 0 && (
            <p className="text-muted-foreground text-center py-8">لا توجد طلبات.</p>
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
                <div className="text-left">
                  <p className="font-bold text-primary" dir="ltr">
                    ${row.amountExpected}
                  </p>
                  <Badge variant="outline">{row.planNameAr}</Badge>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                <Badge variant="secondary">
                  {row.method === "sham_cash" ? "شام كاش" : "USDT (BEP-20)"}
                </Badge>
                <Badge variant="outline" dir="ltr">
                  {row.createdAt ? new Date(row.createdAt).toLocaleString() : "—"}
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
                    alt="إشعار التحويل"
                    className="max-h-64 rounded-lg border object-contain bg-white"
                  />
                </a>
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
                  {/* Why the automatic check could not decide. Without this an
                      admin is guessing at a crypto row. */}
                  {row.verificationLog != null && (
                    <pre className="whitespace-pre-wrap text-[11px] opacity-80">
                      {JSON.stringify(row.verificationLog, null, 1)}
                    </pre>
                  )}
                </div>
              )}

              {row.reviewNote && status !== "pending" && (
                <p className="text-sm text-muted-foreground">
                  <strong>ملاحظة المراجعة:</strong> {row.reviewNote}
                </p>
              )}

              {status === "pending" && row.id != null && (
                <div className="space-y-2 pt-2 border-t">
                  <Label className="text-xs">سبب الرفض (مطلوب للرفض فقط)</Label>
                  <Textarea
                    rows={2}
                    value={reasons[row.id] ?? ""}
                    onChange={(e) =>
                      setReasons((r) => ({ ...r, [row.id as number]: e.target.value }))
                    }
                    placeholder="مثال: صورة الإشعار غير واضحة"
                    disabled={busy}
                  />
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      onClick={() => handleApprove(row.id as number)}
                      disabled={busy}
                    >
                      <CheckCircle2 className="h-4 w-4 ml-2" />
                      تفعيل الاشتراك
                    </Button>
                    <Button
                      variant="destructive"
                      className="flex-1"
                      onClick={() => handleReject(row.id as number)}
                      disabled={busy}
                    >
                      <XCircle className="h-4 w-4 ml-2" />
                      رفض
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
 * ShamCash receive details.
 *
 * Admin-editable, unlike the crypto wallet address shown read-only below: a
 * person reads every ShamCash receipt before anything activates, so a swapped
 * QR surfaces as receipts naming an unfamiliar account. The crypto path has no
 * such review, which makes its address deploy configuration.
 */
function ShamCashSettings() {
  const { toast } = useToast();
  const settings = useGetPaymentSettings();
  const update = useUpdatePaymentSettings();

  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [instructions, setInstructions] = useState("");
  const [uploading, setUploading] = useState(false);

  // Fill the form once the saved values arrive, without clobbering edits in
  // progress on a refetch.
  useEffect(() => {
    if (!settings.data) return;
    setAccountName(settings.data.shamCashAccountName ?? "");
    setAccountNumber(settings.data.shamCashAccountNumber ?? "");
    setInstructions(settings.data.shamCashInstructionsAr ?? "");
  }, [settings.data?.updatedAt]);

  const save = (patch: Record<string, unknown>) => {
    update.mutate(
      { data: patch },
      {
        onSuccess: () => {
          toast({ title: "تم الحفظ" });
          void settings.refetch();
        },
        onError: () =>
          toast({ variant: "destructive", title: "خطأ", description: "تعذر الحفظ." }),
      },
    );
  };

  const handleQr = async (file: File) => {
    setUploading(true);
    try {
      const { mediaId } = await uploadPaymentImage(file, "payment_qr");
      save({ shamCashQrMediaId: mediaId });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "خطأ",
        description:
          err instanceof MediaUploadError ? err.message : "تعذر رفع الصورة.",
      });
    } finally {
      setUploading(false);
    }
  };

  if (settings.isLoading) return <Skeleton className="h-64 w-full rounded-xl" />;

  const hasQr = Boolean(settings.data?.shamCashQrMediaId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>إعدادات شام كاش</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {!hasQr && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex gap-3 text-amber-800 text-sm">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <span>
              لم يتم رفع رمز الاستلام بعد — الدفع عبر شام كاش غير متاح للطلاب حتى
              يتم رفعه.
            </span>
          </div>
        )}

        <div className="space-y-2">
          <Label className="font-bold">رمز الاستلام (QR)</Label>
          <div className="flex items-center gap-3">
            <Button variant="outline" asChild disabled={uploading}>
              <label className="cursor-pointer">
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin ml-2" />
                ) : (
                  <Upload className="h-4 w-4 ml-2" />
                )}
                {hasQr ? "استبدال الصورة" : "رفع الصورة"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleQr(f);
                  }}
                />
              </label>
            </Button>
            {hasQr && (
              <span className="text-sm text-emerald-600 flex items-center gap-1">
                <CheckCircle2 className="h-4 w-4" /> تم الرفع
              </span>
            )}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>اسم الحساب</Label>
            <Input value={accountName} onChange={(e) => setAccountName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>رقم الحساب</Label>
            <Input
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
              dir="ltr"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>تعليمات الدفع (تظهر للطالب)</Label>
          <Textarea
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="مثال: امسح الرمز عبر تطبيق شام كاش، ثم أرسل صورة الإشعار."
          />
        </div>

        <Button
          onClick={() =>
            save({
              shamCashAccountName: accountName.trim() || null,
              shamCashAccountNumber: accountNumber.trim() || null,
              shamCashInstructionsAr: instructions.trim() || null,
            })
          }
          disabled={update.isPending}
        >
          {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "حفظ"}
        </Button>
      </CardContent>
    </Card>
  );
}
