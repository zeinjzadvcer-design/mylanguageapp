import { useState } from "react";
import {
  useGetSubscriptionPlans,
  useGetSubscription,
  useCreateSubscription,
  useGetPaymentSubmissions,
  useGetPaymentDetails,
} from "@workspace/api-client-react";
import { WalletPayment } from "@/components/wallet-payment";
import { CryptoPayment } from "@/components/crypto-payment";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { CheckCircle2, Crown, Loader2, AlertTriangle, X } from "lucide-react";
import { SubscriptionInputPlanCode, SubscriptionInputPaymentMethod } from "@workspace/api-client-react";
import { useI18n } from "@/lib/i18n";
import { formatAmount } from "@/lib/utils";

/** localStorage key for rejection notices the student has closed. */
const DISMISSED_KEY = "ascension:dismissed-payment-rejections";

export default function Subscription() {
  const { data: plans, isLoading: plansLoading } = useGetSubscriptionPlans();
  const { data: subscription, isLoading: subLoading, refetch } = useGetSubscription();
  const createSub = useCreateSubscription();
  const { toast } = useToast();
  const { t, lang, pick } = useI18n();
  const sb = t.subscription;

  /**
   * The student's payment submissions.
   *
   * Needed because GET /subscription only returns the ACTIVE subscription and,
   * finding none, synthesises a free plan with status "active" — so a student
   * waiting on a payment review looks identical to one who never paid. The
   * submission list is the only place the pending state is visible.
   */
  const { data: submissions, refetch: refetchSubmissions } = useGetPaymentSubmissions();

  /**
   * Whether crypto is offered. Until an admin sets a receiving address or QR
   * the option is not shown at all, and Syriatel Cash is the only method.
   */
  const { data: paymentDetails } = useGetPaymentDetails();
  const cryptoAvailable = Boolean(paymentDetails?.crypto?.configured);

  const pendingSubmission = submissions?.find(
    (sub) => sub.status === "pending" || sub.status === "verifying",
  );

  /**
   * Rejections the student has already read.
   *
   * Kept in localStorage, per submission id, because this is a notice rather
   * than state the server owns: the rejection itself is a permanent audit
   * record (an admin refused a payment and said why) and must not be mutated
   * just because the student closed a banner. Per-viewer and per-device is the
   * right scope for "I have seen this".
   */
  const [dismissed, setDismissed] = useState<number[]>(() => {
    try {
      const raw = localStorage.getItem(DISMISSED_KEY);
      return raw ? (JSON.parse(raw) as number[]) : [];
    } catch {
      // A private window, cleared site data, or storage blocked outright.
      // Showing the banner again is the harmless failure.
      return [];
    }
  });

  const dismiss = (id: number) => {
    setDismissed((prev) => {
      const next = [...prev, id];
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
      } catch {
        // Not worth surfacing — it reappears on the next visit at worst.
      }
      return next;
    });
  };

  /**
   * A rejection worth showing.
   *
   * Three conditions, and each removes a case where the banner was wrong:
   *
   *   - nothing newer is pending, so correcting a receipt does not leave both
   *     banners up;
   *   - the student has not dismissed it;
   *   - its subscription is not already paid for. A rejection for a
   *     subscription that was later approved — or an abandoned upgrade next to
   *     a plan that is still active — is history, not something to act on. It
   *     was showing "لم يتم قبول إثبات الدفع" above "اشتراكك الحالي: نشط",
   *     which reads as a contradiction.
   */
  const settledSubscriptionIds = new Set(
    (submissions ?? [])
      .filter((sub) => sub.status === "approved")
      .map((sub) => sub.subscriptionId),
  );

  const lastRejected = submissions?.find(
    (sub) =>
      sub.status === "rejected" &&
      sub.id != null &&
      !dismissed.includes(sub.id) &&
      sub.subscriptionId != null &&
      !settledSubscriptionIds.has(sub.subscriptionId),
  );

  const [selectedPlanCode, setSelectedPlanCode] = useState<SubscriptionInputPlanCode | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<SubscriptionInputPaymentMethod>(SubscriptionInputPaymentMethod.syriatel_cash);
  // Falls back if crypto is withdrawn while selected (an admin removed it
  // mid-session), so the student cannot submit a method that will be refused.
  const effectiveMethod =
    paymentMethod === SubscriptionInputPaymentMethod.crypto_usdt_bep20 && !cryptoAvailable
      ? SubscriptionInputPaymentMethod.syriatel_cash
      : paymentMethod;
  /**
   * Set once the subscription row exists, which switches the dialog from
   * "choose how to pay" to "here is how to pay". Held here rather than derived
   * from `subscription`, because the row we need is the pending one this
   * dialog just created, not whatever is currently active.
   */
  const [pending, setPending] = useState<{
    id: number;
    priceUsd: number;
    /** The exact USDT amount for this student, tag included. */
    amountUsdt: string;
    /** The plan's Syrian pound price. Null means the wallet cannot sell it. */
    priceSyp: string | null;
  } | null>(null);

  const isLoading = plansLoading || subLoading;

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <div className="grid md:grid-cols-3 gap-6">
          {[1,2,3].map(i => <Skeleton key={i} className="h-[400px] rounded-2xl" />)}
        </div>
      </div>
    );
  }

  const handleSubscribe = () => {
    if (!selectedPlanCode) return;
    
    createSub.mutate(
      { data: { planCode: selectedPlanCode, paymentMethod: effectiveMethod } },
      {
        onSuccess: (sub) => {
          // The subscription is only a placeholder at pending_payment; it
          // grants nothing until proof of payment is reviewed. So rather than
          // closing here, move the dialog on to the paying step.
          const plan = plans?.find((p) => p.code === selectedPlanCode);
          setPending({
            id: sub.id,
            priceUsd: plan?.priceUsd ?? 0,
            amountUsdt: sub.amountUsdt ?? "",
            // The quote taken when the subscription opened, not the plan's
            // live price: with an automatic rate the two can differ, and the
            // payment is checked against the quote.
            priceSyp: sub.priceSyp ?? plan?.priceSyp ?? null,
          });
          refetch();
          void refetchSubmissions();
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: sb.error,
            description: sb.requestFailed,
          });
        }
      }
    );
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="text-center max-w-2xl mx-auto mb-12">
        <div className="h-16 w-16 bg-mint-soft rounded-full flex items-center justify-center mx-auto mb-6">
          <Crown className="h-8 w-8 text-mint-foreground" />
        </div>
        <h1 className="text-3xl font-bold text-foreground mb-4">{sb.title}</h1>
        <p className="text-muted-foreground text-lg">
          {sb.subtitle}
        </p>
      </div>

      {/* Under review. Its own banner because GET /subscription cannot express
          this state: it returns only the active subscription, and synthesises
          a free one when there is none. */}
      {pendingSubmission && (
        <Card className="mb-6 border-2 border-amber-500 bg-amber-50/50">
          <CardContent className="p-6 flex items-start gap-4">
            <div className="p-3 rounded-full bg-amber-100 text-amber-600 shrink-0">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-lg">{sb.underReviewTitle}</h3>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                {pendingSubmission.method === "syriatel_cash"
                  ? sb.underReviewWallet
                  : sb.underReviewCrypto}
              </p>
              <div className="flex flex-wrap gap-3 mt-3 text-xs text-muted-foreground">
                <span dir="ltr">${formatAmount(pendingSubmission.amountExpected)}</span>
                <span>
                  {pendingSubmission.method === "syriatel_cash" ? sb.walletName : sb.cryptoName}
                </span>
                {pendingSubmission.createdAt && (
                  <span dir="ltr">
                    {new Date(pendingSubmission.createdAt).toLocaleString()}
                  </span>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* A rejection the student can act on. Shown only when nothing newer is
          pending, so correcting a receipt does not leave both banners up. */}
      {!pendingSubmission && lastRejected && (
        <Card className="mb-6 border-2 border-destructive/50 bg-destructive/5">
          <CardContent className="p-6 flex items-start gap-4">
            <div className="p-3 rounded-full bg-destructive/10 text-destructive shrink-0">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="flex-1">
              <h3 className="font-bold text-lg">{sb.rejectedTitle}</h3>
              {lastRejected.reviewNote && (
                <p className="text-sm mt-1 leading-relaxed">
                  <strong>{sb.rejectedReason}</strong> {lastRejected.reviewNote}
                </p>
              )}
              <p className="text-sm text-muted-foreground mt-2">
                {sb.rejectedRetry}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 -mt-2 -ms-2"
              aria-label={t.common.close}
              onClick={() => lastRejected.id != null && dismiss(lastRejected.id)}
            >
              <X className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* The plan in force. GET /subscription returns only an ACTIVE row and
          synthesises the free plan when there is none, so this is always one
          or the other — a payment awaiting review is the banner above, not a
          state of this one. */}
      {subscription && (
        <Card className="mb-12 border-2 border-mint bg-mint-soft/50">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 rounded-full bg-mint-soft text-mint-foreground shrink-0">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <h3 className="font-bold text-lg">
                {sb.currentPlan(pick(subscription.planNameAr, subscription.planName))}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                {subscription.expiresAt
                  ? sb.validUntil(
                      new Date(subscription.expiresAt).toLocaleDateString(
                        lang === "ar" ? "ar" : "en",
                      ),
                    )
                  : sb.freePlanLine}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto items-stretch">
        {plans?.map((plan) => {
          const isFree = plan.code === "free";
          const isPro = plan.code === "pro_basic" || plan.code === "pro_plus";
          const isCurrentPlan = subscription?.planCode === plan.code;
          // The larger tier in each track, which is what the badge marks now
          // that there are two of each.
          const isPlus = plan.code === "general_plus" || plan.code === "pro_plus";
          
          return (
            <Card key={plan.id} className={`flex flex-col relative transition-transform duration-300 hover:-translate-y-2 ${
              isPro ? "border-primary shadow-xl" : "border-border shadow-sm"
            }`}>
              {isPlus && (
                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-accent text-accent-foreground px-4 py-1 rounded-full text-sm font-bold shadow-lg whitespace-nowrap">
                  {sb.mostLessons}
                </div>
              )}
              
              <CardContent className="p-8 flex flex-col flex-1">
                <h3 className="text-2xl font-bold mb-2">{pick(plan.nameAr, plan.name)}</h3>
                <div className="mb-4">
                  <div className="text-4xl font-bold text-primary">
                    ${plan.priceUsd}
                    <span className="text-lg text-muted-foreground font-normal">{t.common.perMonth}</span>
                  </div>
                  {plan.priceSyp && (
                    <div className="text-sm text-muted-foreground mt-1" dir="ltr">
                      {Number(plan.priceSyp).toLocaleString("en")} {sb.syp}
                    </div>
                  )}
                </div>

                {/* The allowance, which is what separates the tiers within a
                    track — without it the $2 and $5 cards read identically. */}
                {!isFree && (
                  <ul className="space-y-2 mb-4 text-sm">
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                      <span>
                        {sb.lessonsPerMonth(plan.lessonsPerMonth)}
                      </span>
                    </li>
                    <li className="flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                      <span>{sb.callsPerMonth(plan.callsPerMonth)}</span>
                    </li>
                  </ul>
                )}
                
                <ul className="space-y-4 mb-8 flex-1">
                  {(lang === "en" && plan.features?.length ? plan.features : plan.featuresAr)?.map((feature, idx) => (
                    <li key={idx} className="flex items-start gap-3">
                      <CheckCircle2 className={`h-5 w-5 shrink-0 ${isPro ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="text-sm font-medium">{feature}</span>
                    </li>
                  ))}
                </ul>

                {!isFree && (
                  <Button 
                    className={`w-full rounded-xl h-12 text-lg ${
                      isPro ? "bg-primary hover:bg-primary/90 text-white" : ""
                    }`}
                    variant={isPro ? "default" : "outline"}
                    onClick={() => setSelectedPlanCode(plan.code as SubscriptionInputPlanCode)}
                    /**
                     * Only the plan already held is disabled, and only while a
                     * payment for it is under review.
                     *
                     * Blocking every plan whenever one was active meant nobody
                     * could ever switch — and general and professional are
                     * mutually exclusive tracks, not tiers, so a student who
                     * picked the wrong one was stuck with it permanently.
                     * Activation supersedes the previous subscription inside
                     * its own transaction, so changing plan is safe here: the
                     * current one keeps working until the new one is paid for.
                     */
                    /**
                     * Disabled for the plan already held, and for EVERY plan
                     * while a payment is under review — submitting a second
                     * payment before the first is decided gives the admin two
                     * rows to reconcile for one student, and the server
                     * refuses it with a 409 anyway. Better not to offer it.
                     */
                    disabled={
                      Boolean(pendingSubmission) ||
                      (isCurrentPlan && subscription?.status === "active")
                    }
                  >
                    {pendingSubmission
                      ? sb.awaitingReview
                      : isCurrentPlan && subscription?.status === "active"
                        ? sb.yourPlan
                        : subscription?.status === "active"
                          ? sb.switchToPlan
                          : sb.choosePlan}
                  </Button>
                )}
                {isFree && (
                  <Button variant="ghost" disabled className="w-full h-12 rounded-xl border border-dashed">
                    {sb.basicPlan}
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog
        open={!!selectedPlanCode}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedPlanCode(null);
            setPending(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md bg-card max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold">
              {pending ? sb.payTitle : sb.confirmTitle}
            </DialogTitle>
            <DialogDescription className="text-base text-muted-foreground mt-2">
              {pending
                ? sb.payBody
                : sb.confirmBody}
            </DialogDescription>
          </DialogHeader>

          {pending ? (
            effectiveMethod === SubscriptionInputPaymentMethod.syriatel_cash ? (
              <WalletPayment
                subscriptionId={pending.id}
                priceSyp={pending.priceSyp}
                onSubmitted={() => {
                  setSelectedPlanCode(null);
                  setPending(null);
                  refetch();
                  void refetchSubmissions();
                }}
              />
            ) : (
              <CryptoPayment
                subscriptionId={pending.id}
                amountUsdt={pending.amountUsdt}
                onSubmitted={() => {
                  setSelectedPlanCode(null);
                  setPending(null);
                  refetch();
                  void refetchSubmissions();
                }}
              />
            )
          ) : (
            <>
              <div className="py-4">
                <Label className="text-base font-bold mb-4 block">{sb.paymentMethod}</Label>
                <RadioGroup
                  value={effectiveMethod}
                  onValueChange={(val) => setPaymentMethod(val as SubscriptionInputPaymentMethod)}
                  className="space-y-3"
                >
                  {/* One named wallet, matching the QR the admin uploads. An
                      earlier label named three different companies at once,
                      which would have sent students to the wrong wallet. */}
                  <div className="flex items-center gap-3 border p-4 rounded-xl cursor-pointer hover:bg-secondary/50">
                    <RadioGroupItem value={SubscriptionInputPaymentMethod.syriatel_cash} id="r1" />
                    <Label htmlFor="r1" className="cursor-pointer font-medium flex-1">{sb.localCash}</Label>
                  </div>
                  {/* Not shown until an admin has set a receiving address or
                      QR — an option that leads to "unavailable" is worse than
                      no option. */}
                  {cryptoAvailable && (
                    <div className="flex items-center gap-3 border p-4 rounded-xl cursor-pointer hover:bg-secondary/50">
                      <RadioGroupItem value={SubscriptionInputPaymentMethod.crypto_usdt_bep20} id="r2" />
                      <Label htmlFor="r2" className="cursor-pointer font-medium flex-1">{sb.crypto}</Label>
                    </div>
                  )}
                </RadioGroup>
              </div>

              <div className="flex gap-3 pt-4 border-t border-border">
                <Button variant="outline" className="flex-1" onClick={() => setSelectedPlanCode(null)}>{t.common.cancel}</Button>
                <Button className="flex-1" onClick={handleSubscribe} disabled={createSub.isPending}>
                  {createSub.isPending ? <Loader2 className="h-5 w-5 animate-spin ms-2" /> : t.common.continue}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
