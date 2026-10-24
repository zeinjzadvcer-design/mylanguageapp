import { useState } from "react";
import {
  useGetSubscriptionPlans,
  useGetSubscription,
  useCreateSubscription,
  useGetPaymentSubmissions,
} from "@workspace/api-client-react";
import { ShamCashPayment } from "@/components/sham-cash-payment";
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

/** localStorage key for rejection notices the student has closed. */
const DISMISSED_KEY = "ascension:dismissed-payment-rejections";

export default function Subscription() {
  const { data: plans, isLoading: plansLoading } = useGetSubscriptionPlans();
  const { data: subscription, isLoading: subLoading, refetch } = useGetSubscription();
  const createSub = useCreateSubscription();
  const { toast } = useToast();

  /**
   * The student's payment submissions.
   *
   * Needed because GET /subscription only returns the ACTIVE subscription and,
   * finding none, synthesises a free plan with status "active" — so a student
   * waiting on a payment review looks identical to one who never paid. The
   * submission list is the only place the pending state is visible.
   */
  const { data: submissions, refetch: refetchSubmissions } = useGetPaymentSubmissions();

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
  const [paymentMethod, setPaymentMethod] = useState<SubscriptionInputPaymentMethod>(SubscriptionInputPaymentMethod.sham_cash);
  /**
   * Set once the subscription row exists, which switches the dialog from
   * "choose how to pay" to "here is how to pay". Held here rather than derived
   * from `subscription`, because the row we need is the pending one this
   * dialog just created, not whatever is currently active.
   */
  const [pending, setPending] = useState<{ id: number; priceUsd: number } | null>(null);

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
      { data: { planCode: selectedPlanCode, paymentMethod } },
      {
        onSuccess: (sub) => {
          // The subscription is only a placeholder at pending_payment; it
          // grants nothing until proof of payment is reviewed. So rather than
          // closing here, move the dialog on to the paying step.
          setPending({
            id: sub.id,
            priceUsd: plans?.find((p) => p.code === selectedPlanCode)?.priceUsd ?? 0,
          });
          refetch();
          void refetchSubmissions();
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: "خطأ",
            description: "حدث خطأ أثناء تقديم الطلب. يرجى المحاولة لاحقاً.",
          });
        }
      }
    );
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="text-center max-w-2xl mx-auto mb-12">
        <div className="h-16 w-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-6">
          <Crown className="h-8 w-8 text-amber-500" />
        </div>
        <h1 className="text-3xl font-bold text-foreground mb-4">الاشتراكات المميزة</h1>
        <p className="text-muted-foreground text-lg">
          استثمر في مستقبلك بتكلفة مدروسة. طور لغتك الإنجليزية للعمل والدراسة.
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
              <h3 className="font-bold text-lg">طلب الدفع قيد المراجعة</h3>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                {pendingSubmission.method === "sham_cash"
                  ? "استلمنا إثبات الدفع وسيقوم الفريق بمراجعته وتفعيل اشتراكك قريباً."
                  : "جارٍ التحقق من العملية على الشبكة. سيتم التفعيل تلقائياً عند التأكيد."}
              </p>
              <div className="flex flex-wrap gap-3 mt-3 text-xs text-muted-foreground">
                <span dir="ltr">${pendingSubmission.amountExpected}</span>
                <span>
                  {pendingSubmission.method === "sham_cash" ? "شام كاش" : "USDT (BEP-20)"}
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
              <h3 className="font-bold text-lg">لم يتم قبول إثبات الدفع</h3>
              {lastRejected.reviewNote && (
                <p className="text-sm mt-1 leading-relaxed">
                  <strong>السبب:</strong> {lastRejected.reviewNote}
                </p>
              )}
              <p className="text-sm text-muted-foreground mt-2">
                يمكنك اختيار الباقة وإرسال إثبات جديد.
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 -mt-2 -ml-2"
              aria-label="إغلاق"
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
        <Card className="mb-12 border-2 border-emerald-500 bg-emerald-50/50">
          <CardContent className="p-6 flex items-center gap-4">
            <div className="p-3 rounded-full bg-emerald-100 text-emerald-600 shrink-0">
              <CheckCircle2 className="h-6 w-6" />
            </div>
            <div>
              <h3 className="font-bold text-lg">
                اشتراكك الحالي: {subscription.planNameAr}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                {subscription.expiresAt
                  ? `ساري حتى ${new Date(subscription.expiresAt).toLocaleDateString("ar")}`
                  : "الخطة الأساسية — درس مجاني واحد بعد اختبار تحديد المستوى"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto items-stretch">
        {plans?.map((plan) => {
          const isFree = plan.code === "free";
          const isPro = plan.code === "professional_english";
          const isCurrentPlan = subscription?.planCode === plan.code;
          
          return (
            <Card key={plan.id} className={`flex flex-col relative transition-transform duration-300 hover:-translate-y-2 ${
              isPro ? "border-primary shadow-xl" : "border-border shadow-sm"
            }`}>
              {isPro && (
                <div className="absolute top-0 right-1/2 translate-x-1/2 -translate-y-1/2 bg-amber-500 text-white px-4 py-1 rounded-full text-sm font-bold shadow-lg">
                  الأفضل للموظفين
                </div>
              )}
              
              <CardContent className="p-8 flex flex-col flex-1">
                <h3 className="text-2xl font-bold mb-2">{plan.nameAr}</h3>
                <div className="text-4xl font-bold mb-6 text-primary">
                  ${plan.priceUsd}
                  <span className="text-lg text-muted-foreground font-normal"> / شهرياً</span>
                </div>
                
                <ul className="space-y-4 mb-8 flex-1">
                  {plan.featuresAr?.map((feature, idx) => (
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
                      ? "بانتظار مراجعة الدفع"
                      : isCurrentPlan && subscription?.status === "active"
                        ? "باقتك الحالية"
                        : subscription?.status === "active"
                          ? "التغيير إلى هذه الباقة"
                          : "اختيار الباقة"}
                  </Button>
                )}
                {isFree && (
                  <Button variant="ghost" disabled className="w-full h-12 rounded-xl border border-dashed">
                    الباقة الأساسية
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
        <DialogContent className="sm:max-w-md bg-card max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold">
              {pending ? "إتمام الدفع" : "تأكيد الاشتراك"}
            </DialogTitle>
            <DialogDescription className="text-base text-muted-foreground mt-2">
              {pending
                ? "حوّل المبلغ ثم أرسل صورة الإشعار لمراجعتها."
                : "اختر طريقة الدفع المناسبة لك."}
            </DialogDescription>
          </DialogHeader>

          {pending ? (
            paymentMethod === SubscriptionInputPaymentMethod.sham_cash ? (
              <ShamCashPayment
                subscriptionId={pending.id}
                priceUsd={pending.priceUsd}
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
                priceUsd={pending.priceUsd}
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
                <Label className="text-base font-bold mb-4 block">طريقة الدفع (Payment Method)</Label>
                <RadioGroup
                  value={paymentMethod}
                  onValueChange={(val) => setPaymentMethod(val as SubscriptionInputPaymentMethod)}
                  className="space-y-3"
                >
                  {/* شام كاش, not Syriatel/MTN: those are different companies and
                      the QR the admin uploads is a ShamCash account. The label used
                      to name all three, which would have sent students to the wrong
                      wallet. */}
                  <div className="flex items-center space-x-3 space-x-reverse border p-4 rounded-xl cursor-pointer hover:bg-secondary/50">
                    <RadioGroupItem value={SubscriptionInputPaymentMethod.sham_cash} id="r1" />
                    <Label htmlFor="r1" className="cursor-pointer font-medium flex-1">شام كاش (محلي)</Label>
                  </div>
                  <div className="flex items-center space-x-3 space-x-reverse border p-4 rounded-xl cursor-pointer hover:bg-secondary/50">
                    <RadioGroupItem value={SubscriptionInputPaymentMethod.crypto_usdt_bep20} id="r2" />
                    <Label htmlFor="r2" className="cursor-pointer font-medium flex-1">عملات رقمية — USDT (BEP-20)</Label>
                  </div>
                </RadioGroup>
              </div>

              <div className="flex gap-3 pt-4 border-t border-border">
                <Button variant="outline" className="flex-1" onClick={() => setSelectedPlanCode(null)}>إلغاء</Button>
                <Button className="flex-1" onClick={handleSubscribe} disabled={createSub.isPending}>
                  {createSub.isPending ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : "متابعة"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
