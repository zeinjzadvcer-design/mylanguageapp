/**
 * USDT (BEP-20) payment step.
 *
 * The automated path. The student sends USDT to our wallet, pastes the
 * transaction hash, and the server reads the chain to decide — usually within
 * a minute, without anyone reviewing it.
 *
 * The network warning is load-bearing, not decoration. A 0x address is valid
 * on Ethereum too, and USDT sent on TRC-20 or ERC-20 to this address is
 * permanently lost. That is why the network is stated above the address, in
 * Arabic, rather than in fine print below it.
 */

import { useState } from "react";
import { useGetPaymentDetails, useCreateCryptoSubmission } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Copy, Loader2 } from "lucide-react";

interface Props {
  subscriptionId: number;
  priceUsd: number;
  onSubmitted: () => void;
}

/** Matches the server's check, so a mistyped hash is caught before a request. */
const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export function CryptoPayment({ subscriptionId, priceUsd, onSubmitted }: Props) {
  const { data: details, isLoading } = useGetPaymentDetails();
  const createSubmission = useCreateCryptoSubmission();
  const { toast } = useToast();

  const [txHash, setTxHash] = useState("");

  if (isLoading) return <Skeleton className="h-96 w-full rounded-2xl" />;

  const crypto = details?.crypto;

  if (!crypto?.configured || !crypto.walletAddress) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3 text-amber-800">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="text-sm leading-relaxed">
          <strong>الدفع بالعملات الرقمية غير متاح حالياً.</strong>
          <br />
          يرجى اختيار شام كاش.
        </div>
      </div>
    );
  }

  const trimmed = txHash.trim();
  const looksValid = TX_HASH_RE.test(trimmed);

  const copyAddress = () => {
    void navigator.clipboard?.writeText(crypto.walletAddress!).then(
      () => toast({ title: "تم نسخ العنوان" }),
      // Clipboard access can be refused; the address is visible either way.
      () => undefined,
    );
  };

  const handleSubmit = () => {
    createSubmission.mutate(
      { data: { subscriptionId, txHash: trimmed } },
      {
        onSuccess: () => {
          toast({
            title: "تم استلام معرّف العملية",
            description: "جارٍ التحقق من الشبكة. سيتم تفعيل اشتراكك تلقائياً عند التأكيد.",
          });
          onSubmitted();
        },
        onError: (err) => {
          // 409 is the one worth naming: it means this hash already bought a
          // subscription, which a generic message would leave mysterious.
          const status = (err as { status?: number })?.status;
          toast({
            variant: "destructive",
            title: "خطأ",
            description:
              status === 409
                ? "تم استخدام معرّف هذه العملية مسبقاً لاشتراك آخر."
                : "تعذر إرسال معرّف العملية. تأكد من صحته وحاول مرة أخرى.",
          });
        },
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="text-center">
        <p className="text-sm text-muted-foreground mb-1">المبلغ المطلوب</p>
        <p className="text-3xl font-bold text-primary">{priceUsd.toFixed(2)} USDT</p>
      </div>

      {/* Stated before the address, deliberately. Sending on the wrong network
          loses the money with no way to recover it. */}
      <div className="bg-destructive/10 border-2 border-destructive/40 rounded-xl p-4 flex gap-3">
        <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5 text-destructive" />
        <div className="text-sm leading-relaxed">
          <strong className="text-destructive block mb-1">
            شبكة {crypto.networkLabel} فقط
          </strong>
          الإرسال عبر أي شبكة أخرى (TRC-20 أو ERC-20) سيؤدي إلى ضياع أموالك نهائياً.
        </div>
      </div>

      <div className="space-y-2">
        <Label className="font-bold">عنوان المحفظة</Label>
        <div className="flex gap-2">
          <code
            className="flex-1 text-xs bg-secondary/60 rounded-lg p-3 break-all font-mono"
            dir="ltr"
          >
            {crypto.walletAddress}
          </code>
          <Button type="button" variant="outline" size="icon" onClick={copyAddress}>
            <Copy className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Label className="font-bold">معرّف العملية (Transaction Hash)</Label>
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
          <p className="text-xs text-destructive">
            يجب أن يبدأ بـ 0x ويتكون من 64 خانة بعدها.
          </p>
        )}
      </div>

      <Button
        className="w-full h-12 rounded-xl text-lg"
        onClick={handleSubmit}
        disabled={!looksValid || createSubmission.isPending}
      >
        {createSubmission.isPending ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          "تحقق من الدفع"
        )}
      </Button>
    </div>
  );
}
