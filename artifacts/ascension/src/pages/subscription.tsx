import { useState } from "react";
import { useGetSubscriptionPlans, useGetSubscription, useCreateSubscription } from "@workspace/api-client-react";
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
import { CheckCircle2, Crown, AlertTriangle, Loader2 } from "lucide-react";
import { SubscriptionInputPlanCode, SubscriptionInputPaymentMethod } from "@workspace/api-client-react";
import { useI18n } from "@/lib/i18n";

export default function Subscription() {
  const { data: plans, isLoading: plansLoading } = useGetSubscriptionPlans();
  const { data: subscription, isLoading: subLoading, refetch } = useGetSubscription();
  const createSub = useCreateSubscription();
  const { toast } = useToast();
  const { t, lang, pick } = useI18n();
  const sb = t.subscription;

  const [selectedPlanCode, setSelectedPlanCode] = useState<SubscriptionInputPlanCode | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<SubscriptionInputPaymentMethod>(SubscriptionInputPaymentMethod.sham_cash);

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
        onSuccess: () => {
          toast({
            title: sb.requestReceived,
            description: sb.requestReceivedBody,
          });
          setSelectedPlanCode(null);
          refetch();
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

      {subscription && subscription.status !== "cancelled" && subscription.status !== "expired" && (
        <Card className={`mb-12 border-2 ${
          subscription.status === "active" ? "border-mint bg-mint-soft/50" : "border-amber-500 bg-amber-50/50"
        }`}>
          <CardContent className="p-6 flex items-center gap-4">
            <div className={`p-3 rounded-full ${
              subscription.status === "active" ? "bg-mint-soft text-mint-foreground" : "bg-amber-100 text-amber-600"
            }`}>
              {subscription.status === "active" ? <CheckCircle2 className="h-6 w-6" /> : <Loader2 className="h-6 w-6 animate-spin" />}
            </div>
            <div>
              <h3 className="font-bold text-lg">
                {sb.currentPlan(pick(subscription.planNameAr, subscription.planName))}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                {sb.status} {subscription.status === "active" ? sb.active : sb.pending}
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
                <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-accent text-accent-foreground px-4 py-1 rounded-full text-sm font-bold shadow-lg whitespace-nowrap">
                  {sb.bestForWork}
                </div>
              )}
              
              <CardContent className="p-8 flex flex-col flex-1">
                <h3 className="text-2xl font-bold mb-2">{pick(plan.nameAr, plan.name)}</h3>
                <div className="text-4xl font-bold mb-6 text-primary">
                  ${plan.priceUsd}
                  <span className="text-lg text-muted-foreground font-normal">{t.common.perMonth}</span>
                </div>
                
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
                    disabled={subscription?.status === "active" || subscription?.status === "pending_payment"}
                  >
                    {sb.choosePlan}
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

      <Dialog open={!!selectedPlanCode} onOpenChange={(open) => !open && setSelectedPlanCode(null)}>
        <DialogContent className="sm:max-w-md bg-card">
          <DialogHeader>
            <DialogTitle className="text-2xl font-bold">{sb.confirmTitle}</DialogTitle>
            <DialogDescription className="text-base text-muted-foreground mt-2">
              {sb.confirmBody}
            </DialogDescription>
          </DialogHeader>
          
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 my-4 flex gap-3 text-amber-800">
            <AlertTriangle className="h-5 w-5 shrink-0 mt-0.5" />
            <div className="text-sm leading-relaxed">
              <strong>{sb.manualNoticeTitle}</strong><br/>
              {sb.manualNoticeBody}
            </div>
          </div>

          <div className="py-4">
            <Label className="text-base font-bold mb-4 block">{sb.paymentMethod}</Label>
            <RadioGroup 
              value={paymentMethod} 
              onValueChange={(val) => setPaymentMethod(val as SubscriptionInputPaymentMethod)}
              className="space-y-3"
            >
              <div className="flex items-center gap-3 border p-4 rounded-xl cursor-pointer hover:bg-secondary/50">
                <RadioGroupItem value={SubscriptionInputPaymentMethod.sham_cash} id="r1" />
                <Label htmlFor="r1" className="cursor-pointer font-medium flex-1">{sb.localCash}</Label>
              </div>
              <div className="flex items-center gap-3 border p-4 rounded-xl cursor-pointer hover:bg-secondary/50">
                <RadioGroupItem value={SubscriptionInputPaymentMethod.cryptocurrency} id="r2" />
                <Label htmlFor="r2" className="cursor-pointer font-medium flex-1">{sb.crypto}</Label>
              </div>
            </RadioGroup>
          </div>

          <div className="flex gap-3 pt-4 border-t border-border">
            <Button variant="outline" className="flex-1" onClick={() => setSelectedPlanCode(null)}>{t.common.cancel}</Button>
            <Button className="flex-1" onClick={handleSubscribe} disabled={createSub.isPending}>
              {createSub.isPending ? <Loader2 className="h-5 w-5 animate-spin ms-2" /> : sb.confirm}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
