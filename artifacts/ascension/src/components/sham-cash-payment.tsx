/**
 * ShamCash payment step.
 *
 * Shown after a student picks a plan. They scan the admin-uploaded receive QR,
 * pay in their own ShamCash app, then send back a screenshot of the transfer
 * and whatever they want to say about it. An admin reviews it; nothing is
 * activated here.
 */

import { useRef, useState } from "react";
import { useGetPaymentDetails, useCreatePaymentSubmission } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { uploadPaymentImage, MediaUploadError } from "@/lib/media-api";
import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react";

interface Props {
  subscriptionId: number;
  priceUsd: number;
  onSubmitted: () => void;
}

export function ShamCashPayment({ subscriptionId, priceUsd, onSubmitted }: Props) {
  const { data: details, isLoading } = useGetPaymentDetails();
  const createSubmission = useCreatePaymentSubmission();
  const { toast } = useToast();

  const fileInput = useRef<HTMLInputElement>(null);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);

  if (isLoading) {
    return <Skeleton className="h-96 w-full rounded-2xl" />;
  }

  const shamCash = details?.shamCash;

  // No QR uploaded yet. Say so plainly rather than showing an empty frame the
  // student cannot act on — they would otherwise sit waiting for an image.
  if (!shamCash?.configured) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3 text-amber-800">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="text-sm leading-relaxed">
          <strong>الدفع عبر شام كاش غير متاح حالياً.</strong>
          <br />
          لم يتم إعداد حساب الاستلام بعد. يرجى المحاولة لاحقاً أو التواصل مع الدعم.
        </div>
      </div>
    );
  }

  const handleSubmit = async () => {
    if (!receipt) return;

    setUploading(true);
    try {
      // Upload first, submit second. The submission requires a completed
      // upload, so doing it the other way round would create a row the student
      // has no proof for.
      const { mediaId } = await uploadPaymentImage(receipt, "payment_receipt");

      await createSubmission.mutateAsync({
        data: {
          subscriptionId,
          receiptMediaId: mediaId,
          ...(note.trim() ? { studentNote: note.trim() } : {}),
        },
      });

      toast({
        title: "تم استلام إثبات الدفع",
        description: "سيقوم الفريق بمراجعته وتفعيل اشتراكك قريباً.",
      });
      onSubmitted();
    } catch (err) {
      // A validation message from the upload helper is already in Arabic and
      // says what to fix; anything else is unexpected and gets a generic line.
      const description =
        err instanceof MediaUploadError
          ? err.message
          : "تعذر إرسال إثبات الدفع. يرجى المحاولة مرة أخرى.";
      toast({ variant: "destructive", title: "خطأ", description });
    } finally {
      setUploading(false);
    }
  };

  const busy = uploading || createSubmission.isPending;

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-sm text-muted-foreground mb-1">المبلغ المطلوب</p>
        <p className="text-3xl font-bold text-primary">${priceUsd.toFixed(2)}</p>
      </div>

      <div className="flex flex-col items-center gap-3 p-4 bg-secondary/40 rounded-xl">
        <img
          src={shamCash.qrUrl ?? undefined}
          alt="رمز الاستلام عبر شام كاش"
          className="w-48 h-48 object-contain bg-white rounded-lg p-2"
        />
        {shamCash.accountName && (
          <p className="text-sm font-medium">{shamCash.accountName}</p>
        )}
        {/* Shown so a student whose app cannot scan can still type it, and so
            anyone can confirm they are paying the account they expect. */}
        {shamCash.accountNumber && (
          <p className="text-sm font-mono tracking-wide" dir="ltr">
            {shamCash.accountNumber}
          </p>
        )}
      </div>

      {shamCash.instructionsAr && (
        <div className="text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
          {shamCash.instructionsAr}
        </div>
      )}

      <div className="space-y-2">
        <Label className="font-bold">صورة إشعار التحويل</Label>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          variant="outline"
          className="w-full h-12 rounded-xl justify-start gap-3"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          {receipt ? (
            <>
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              <span className="truncate">{receipt.name}</span>
            </>
          ) : (
            <>
              <Upload className="h-5 w-5" />
              اختر صورة الإشعار
            </>
          )}
        </Button>
      </div>

      <div className="space-y-2">
        <Label className="font-bold">
          تفاصيل إضافية <span className="font-normal text-muted-foreground">(اختياري)</span>
        </Label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={3}
          placeholder="مثال: تم التحويل من الرقم ... بتاريخ ..."
          disabled={busy}
        />
      </div>

      <Button
        className="w-full h-12 rounded-xl text-lg"
        onClick={handleSubmit}
        disabled={!receipt || busy}
      >
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : "إرسال إثبات الدفع"}
      </Button>
    </div>
  );
}
