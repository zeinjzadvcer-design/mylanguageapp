/**
 * Syriatel Cash payment step.
 *
 * The admin uploads a merchant receive QR and an account code; the student
 * scans or types it, pays in their own wallet app, then enters the operation
 * number from their confirmation SMS.
 *
 * That number is the whole mechanism. Syriatel sends it to the payer and to the
 * merchant, and nowhere else, so when the companion app forwards the merchant's
 * copy the two can be matched on an exact value. Verification is automatic —
 * usually within a minute — and falls back to an admin only when the amount is
 * short or the SMS never arrives.
 */

import { useState } from "react";
import {
  useGetPaymentDetails,
  useCreateWalletSubmission,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";
import { AlertTriangle, Copy, Loader2 } from "lucide-react";

interface Props {
  subscriptionId: number;
  /** The plan's Syrian pound price — what the student must transfer exactly. */
  priceSyp: string | null;
  onSubmitted: () => void;
}

/** Matches the server's check, so an obvious typo is caught before a request. */
const OPERATION_RE = /^\d{4,24}$/;

export function WalletPayment({ subscriptionId, priceSyp, onSubmitted }: Props) {
  const { data: details, isLoading } = useGetPaymentDetails();
  const createSubmission = useCreateWalletSubmission();
  const { toast } = useToast();
  const { t } = useI18n();
  const pw = t.payment.wallet;

  const [operationNumber, setOperationNumber] = useState("");
  const [note, setNote] = useState("");

  if (isLoading) return <Skeleton className="h-96 w-full rounded-2xl" />;

  const wallet = details?.wallet;

  // No QR uploaded yet. Say so rather than showing an empty frame the student
  // cannot act on — they would otherwise sit waiting for an image.
  if (!wallet?.configured) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3 text-amber-800">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="text-sm leading-relaxed">
          <strong>{pw.unavailableTitle}</strong>
          <br />
          {pw.unavailableBody}
        </div>
      </div>
    );
  }

  // An admin has not set a Syrian pound price, so there is no exact figure to
  // ask for and nothing to verify a transfer against.
  if (!priceSyp) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3 text-amber-800">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="text-sm leading-relaxed">
          <strong>{pw.noPriceTitle}</strong>
          <br />
          {pw.noPriceBody}
        </div>
      </div>
    );
  }

  const trimmed = operationNumber.trim();
  const looksValid = OPERATION_RE.test(trimmed);

  const copyAccount = () => {
    if (!wallet.accountNumber) return;
    void navigator.clipboard?.writeText(wallet.accountNumber).then(
      () => toast({ title: pw.copied }),
      // Clipboard access can be refused; the code is visible either way.
      () => undefined,
    );
  };

  const handleSubmit = () => {
    createSubmission.mutate(
      {
        data: {
          subscriptionId,
          operationNumber: trimmed,
          amountSyp: Number(priceSyp),
          ...(note.trim() ? { studentNote: note.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          toast({
            title: pw.receivedTitle,
            description: pw.receivedBody,
          });
          onSubmitted();
        },
        onError: (err) => {
          // 409 is the one worth naming: the number has already bought a
          // subscription, which a generic message would leave mysterious.
          const status = (err as { status?: number })?.status;
          toast({
            variant: "destructive",
            title: t.subscription.error,
            description:
              status === 409
                ? pw.alreadyUsed
                : pw.submitFailed,
          });
        },
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-sm text-muted-foreground mb-1">{pw.amountDue}</p>
        {/* The exact figure. Transferring a different amount sends the payment
            to an admin for review instead of activating automatically. */}
        <p className="text-3xl font-bold text-primary" dir="ltr">
          {Number(priceSyp).toLocaleString("en")} {t.subscription.syp}
        </p>
      </div>

      <div className="flex flex-col items-center gap-3 p-4 bg-secondary/40 rounded-xl">
        <img
          src={wallet.qrUrl ?? undefined}
          alt={pw.qrAlt}
          className="w-48 h-48 object-contain bg-white rounded-lg p-2"
        />
        {wallet.accountName && (
          <p className="text-sm font-medium">{wallet.accountName}</p>
        )}
        {/* The account code, so a student whose app cannot scan can still pay,
            and so anyone can confirm the account before sending money. */}
        {wallet.accountNumber && (
          <div className="flex items-center gap-2">
            <code className="text-sm font-mono tracking-wide" dir="ltr">
              {wallet.accountNumber}
            </code>
            <Button type="button" variant="ghost" size="icon" onClick={copyAccount}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      {wallet.instructionsAr && (
        <div className="text-sm leading-relaxed text-muted-foreground whitespace-pre-line">
          {wallet.instructionsAr}
        </div>
      )}

      <div className="space-y-2">
        <Label className="font-bold">{pw.operationNumber}</Label>
        <Input
          value={operationNumber}
          onChange={(e) => setOperationNumber(e.target.value)}
          placeholder="600123456789"
          dir="ltr"
          className="font-mono"
          inputMode="numeric"
          disabled={createSubmission.isPending}
        />
        <p className="text-xs text-muted-foreground leading-relaxed">
          {pw.operationHint}
        </p>
        {/* Shown only once something has been typed, so an empty field is not
            scolded before the student has started. */}
        {trimmed.length > 0 && !looksValid && (
          <p className="text-xs text-destructive">
            {pw.operationInvalid}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label className="font-bold">
          {pw.note} <span className="font-normal text-muted-foreground">{pw.optional}</span>
        </Label>
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={2000}
          rows={2}
          placeholder={pw.notePlaceholder}
          disabled={createSubmission.isPending}
        />
      </div>

      <Button
        className="w-full h-12 rounded-xl text-lg"
        onClick={handleSubmit}
        disabled={!looksValid || createSubmission.isPending}
      >
        {createSubmission.isPending ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          pw.submit
        )}
      </Button>
    </div>
  );
}
