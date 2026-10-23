import { useState } from "react";
import { useGetSubscriptionPlans, useGetSubscription, useCreateSubscription } from "@workspace/api-client-react";
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
import { CheckCircle2, Crown, Loader2 } from "lucide-react";
import { SubscriptionInputPlanCode, SubscriptionInputPaymentMethod } from "@workspace/api-client-react";

export default function Subscription() {
  const { data: plans, isLoading: plansLoading } = useGetSubscriptionPlans();
  const { data: subscription, isLoading: subLoading, refetch } = useGetSubscription();
  const createSub = useCreateSubscription();
  const { toast } = useToast();

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

      {subscription && subscription.status !== "cancelled" && subscription.status !== "expired" && (
        <Card className={`mb-12 border-2 ${
          subscription.status === "active" ? "border-emerald-500 bg-emerald-50/50" : "border-amber-500 bg-amber-50/50"
        }`}>
          <CardContent className="p-6 flex items-center gap-4">
            <div className={`p-3 rounded-full ${
              subscription.status === "active" ? "bg-emerald-100 text-emerald-600" : "bg-amber-100 text-amber-600"
            }`}>
              {subscription.status === "active" ? <CheckCircle2 className="h-6 w-6" /> : <Loader2 className="h-6 w-6 animate-spin" />}
            </div>
            <div>
              <h3 className="font-bold text-lg">
                اشتراكك الحالي: {subscription.planNameAr}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                الحالة: {subscription.status === "active" ? "نشط" : "قيد التفعيل (بانتظار تأكيد الدفع)"}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto items-stretch">
        {plans?.map((plan) => {
          const isFree = plan.code === "free";
          const isPro = plan.code === "professional_english";
          
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
                    disabled={subscription?.status === "active" || subscription?.status === "pending_payment"}
                  >
                    اختيار الباقة
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
