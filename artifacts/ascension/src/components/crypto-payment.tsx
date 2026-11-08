/**
 * USDT (BEP-20) payment step.
 *
 * The admin sets a receiving address, a QR, or both. With an address the
 * student's transaction is confirmed on chain, usually within a minute and with
 * nobody reviewing it. With only a QR there is nothing to check the recipient
 * against, so the payment goes to an admin — and the student is told which.
 *
 * The network warning is load-bearing, not decoration. A 0x address is valid on
 * Ethereum too, and USDT sent on TRC-20 or ERC-20 to it is permanently lost.
 * That is why the network is stated above the address rather than below it.
 */

import { useState } from "react";
import { useGetPaymentDetails, useCreateCryptoSubmission } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";
import { AlertTriangle, Copy, Info, Loader2 } from "lucide-react";

interface Props {
  subscriptionId: number;
  /** Exact, tag included. The last digits are what identify this student. */
  amountUsdt: string;
  onSubmitted: () => void;
}

/** Matches the server's check, so a mistyped hash is caught before a request. */
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export function CryptoPayment({ subscriptionId, amountUsdt, onSubmitted }: Props) {
  const { data: details, isLoading } = useGetPaymentDetails();
  const createSubmission = useCreateCryptoSubmission();
  const { toast } = useToast();
  const { t, lang } = useI18n();
  const pc = t.payment.crypto;

  const [txHash, setTxHash] = useState("");

  if (isLoading) return <Skeleton className="h-96 w-full rounded-2xl" />;

  const crypto = details?.crypto;

  // Withdrawn while the dialog was open. The option is hidden when this is
  // false, so reaching here means an admin removed it mid-session.
  if (!crypto?.configured) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3 text-amber-800">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="text-sm leading-relaxed">
          <strong>{pc.unavailableTitle}</strong>
          <br />
          {pc.unavailableBody}
        </div>
      </div>
    );
  }

  const trimmed = txHash.trim();
  const looksValid = TX_HASH_RE.test(trimmed);

  const copyAddress = () => {
    if (!crypto.walletAddress) return;
    void navigator.clipboard?.writeText(crypto.walletAddress).then(
      () => toast({ title: pc.copied }),
      // Clipboard access can be refused; the address is visible either way.
      () => undefined,
    );
  };

  const handleSubmit = () => {
    createSubmission.mutate(
      { data: { subscriptionId, txHash: trimmed } },
      {
        onSuccess: (created) => {
          toast({
            title: pc.receivedTitle,
            // From the response: a resubmission goes to the team even when
            // automatic checking is available.
            description: created.status === "verifying" ? pc.receivedAuto : pc.receivedManual,
          });
          onSubmitted();
        },
        onError: (err) => {
          // 409 is the one worth naming, and the server says which it was:
          // the hash already bought a subscription, or a payment is already
          // under review.
          const { status, data } = err as {
            status?: number;
            data?: { error?: string; errorAr?: string };
          };
          toast({
            variant: "destructive",
            title: t.subscription.error,
            description:
              status === 409
                ? ((lang === "ar" ? data?.errorAr : data?.error) ?? pc.alreadyUsed)
                : pc.submitFailed,
          });
        },
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-sm text-muted-foreground mb-1">{pc.amountDue}</p>
        <p className="text-3xl font-bold text-primary" dir="ltr">
          {amountUsdt} USDT
        </p>
        <p className="text-xs text-muted-foreground mt-2 leading-relaxed">{pc.exactAmountNote}</p>
      </div>

      {/* Stated before the address, deliberately. Sending on the wrong network
          loses the money with no way to recover it. */}
      <div className="bg-destructive/10 border-2 border-destructive/40 rounded-xl p-4 flex gap-3">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-destructive" />
        <div className="text-sm leading-relaxed">
          <strong className="text-destructive block mb-1">
            {pc.networkOnly(crypto.networkLabel ?? "BNB Smart Chain (BEP-20)")}
          </strong>
          {pc.networkWarning}
        </div>
      </div>

      {crypto.qrUrl && (
        <div className="flex justify-center p-4 bg-secondary/40 rounded-xl">
          <img
            src={crypto.qrUrl}
            alt={pc.qrAlt}
            className="w-48 h-48 object-contain bg-white rounded-lg p-2"
          />
        </div>
      )}

      {crypto.walletAddress && (
        <div className="space-y-2">
          <Label className="font-bold">{pc.walletAddress}</Label>
          <div className="flex gap-2">
            <code
              className="flex-1 text-xs bg-secondary/60 rounded-lg p-3 break-all font-mono"
              dir="ltr"
            >
              {crypto.walletAddress}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={copyAddress}
              aria-label={pc.copy}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* QR only: there is no address to check the recipient against, so the
          chain cannot confirm this payment. Said up front, so a student is not
          left waiting on an automatic activation that will not come. */}
      {!crypto.autoVerify && (
        <div className="bg-secondary/50 border rounded-xl p-3 flex gap-3 text-sm">
          <Info className="h-5 w-5 shrink-0 mt-0.5 text-muted-foreground" />
          <span className="leading-relaxed">{pc.manualReviewNote}</span>
        </div>
      )}

      <div className="space-y-2">
        <Label className="font-bold">{pc.txHash}</Label>
        <Input
          value={txHash}
          onChange={(e) => setTxHash(e.target.value)}
          placeholder="0x..."
          dir="ltr"
          className="font-mono text-xs"
          disabled={createSubmission.isPending}
        />
        {/* Shown only once something has been typed, so an empty field is not
            scolded before the student has started. */}
        {trimmed.length > 0 && !looksValid && (
          <p className="text-xs text-destructive">{pc.txHashInvalid}</p>
        )}
      </div>

      <Button
        className="w-full h-12 rounded-xl text-lg"
        onClick={handleSubmit}
        disabled={!looksValid || createSubmission.isPending}
      >
        {createSubmission.isPending ? <Loader2 className="h-5 w-5 animate-spin" /> : pc.submit}
      </Button>
    </div>
  );
}
