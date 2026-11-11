import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { BookOpen, Mic, Award, CheckCircle2, ChevronLeft, Target } from "lucide-react";
import { useGetMe, useGetSubscriptionPlans } from "@workspace/api-client-react";
import { useEffect } from "react";
import { BrandLogo, LanguageSwitcher } from "@/components/brand";
import heroImg from "@assets/generated_images/landing-hero.jpg";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { landingPath } from "@/lib/permissions";

export default function Landing() {
  const { data: user } = useGetMe();
  const { data: plans, isLoading: plansLoading } = useGetSubscriptionPlans();
  const [, setLocation] = useLocation();
  const { t, lang, pick } = useI18n();
  const l = t.landing;
  const sb = t.subscription;

  const plansByPrice = [...(plans ?? [])].sort(
    (a, b) => a.priceUsd - b.priceUsd || a.id - b.id,
  );

  useEffect(() => {
    if (user) {
      setLocation(landingPath(user));
    }
  }, [user, setLocation]);

  return (
    <div className="min-h-screen bg-background font-sans">
      {/* Header */}
      <header className="fixed top-0 w-full border-b border-border bg-background/80 backdrop-blur-md z-50">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between gap-3">
          <BrandLogo />
          <div className="flex items-center gap-3 sm:gap-4">
            <LanguageSwitcher />
            <Link href="/login" className="hidden sm:inline text-sm font-medium hover:text-primary transition-colors">
              {l.login}
            </Link>
            <Link href="/register">
               <Button size="sm" className="bg-accent hover:bg-accent/90 text-accent-foreground rounded-full px-5 font-bold">
                 {l.startFree}
               </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden pt-28 pb-16 md:pt-36 md:pb-24">
        {/* soft brand blobs */}
        <div aria-hidden className="pointer-events-none absolute -top-24 end-[-10%] h-[28rem] w-[28rem] rounded-full bg-primary/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute bottom-0 start-[-8%] h-80 w-80 rounded-full bg-mint/25 blur-3xl" />

        <div className="container relative mx-auto px-4 grid md:grid-cols-2 gap-12 items-center">
          <div className="space-y-6">
            <span className="inline-flex items-center gap-2 rounded-full bg-lavender px-3 py-1 text-sm font-semibold text-lavender-foreground">
              <span className="h-2 w-2 rounded-full bg-mint" />
              {t.common.tagline}
            </span>
            <h1 className="text-4xl md:text-6xl font-extrabold leading-tight text-foreground">
              {l.heroTitle1} <br />
              <span className="text-primary">{l.heroTitle2}</span>
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground max-w-lg leading-relaxed">
              {l.heroBody}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 pt-4">
              <Link href="/register">
                <Button size="lg" className="w-full sm:w-auto text-lg h-14 px-8 rounded-2xl shadow-lg shadow-primary/20">
                  {l.heroCta}
                  <ChevronLeft className="ms-2 h-5 w-5 ltr:-scale-x-100" />
                </Button>
              </Link>
              <Link href="/login">
                <Button size="lg" variant="outline" className="w-full sm:w-auto text-lg h-14 px-8 rounded-2xl border-border bg-card/60">
                  {l.haveAccount}
                </Button>
              </Link>
            </div>
          </div>

          <div className="relative">
            <div className="relative overflow-hidden rounded-[2.5rem] border border-border shadow-2xl shadow-primary/10">
              <img
                src={heroImg}
                alt={l.heroImageAlt}
                fetchPriority="high"
                className="w-full aspect-[4/3] object-cover"
              />
              {/* A light wash of the brand colour, so the photo sits in the theme. */}
              <div aria-hidden className="absolute inset-0 bg-primary/10 mix-blend-multiply" />
            </div>
          </div>
        </div>
      </section>

      {/* Steps */}
      <section className="pb-20">
        <div className="container mx-auto px-4">
          <h2 className="text-center text-2xl font-bold text-foreground mb-10">{l.stepsTitle}</h2>
          <ol className="grid gap-4 md:grid-cols-3 max-w-4xl mx-auto">
            {[
              { icon: Target, text: l.step1 },
              { icon: BookOpen, text: l.step2 },
              { icon: Mic, text: l.step3 },
            ].map(({ icon: Icon, text }, i) => (
              <li key={i} className="flex items-center gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground font-extrabold">
                  {i + 1}
                </span>
                <span className="font-semibold text-foreground">{text}</span>
                <Icon className="ms-auto h-5 w-5 text-mint-foreground" />
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Benefits */}
      <section className="py-20 bg-secondary/50">
        <div className="container mx-auto px-4">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <h2 className="text-3xl font-bold text-foreground mb-4">{l.whyTitle}</h2>
            <p className="text-muted-foreground text-lg">{l.whyBody}</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              { icon: Mic, title: l.f1Title, body: l.f1Body, tile: "bg-mint-soft text-mint-foreground" },
              { icon: BookOpen, title: l.f2Title, body: l.f2Body, tile: "bg-lavender text-lavender-foreground" },
              { icon: Award, title: l.f3Title, body: l.f3Body, tile: "bg-mint-soft text-mint-foreground" },
            ].map(({ icon: Icon, title, body, tile }) => (
              <div key={title} className="bg-card p-8 rounded-3xl border border-border shadow-sm hover:shadow-md transition-shadow">
                <div className={`h-14 w-14 rounded-2xl flex items-center justify-center mb-6 ${tile}`}>
                  <Icon className="h-7 w-7" />
                </div>
                <h3 className="text-xl font-bold mb-3">{title}</h3>
                <p className="text-muted-foreground leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing. Hidden when the plans cannot be loaded: no prices at all is
          better than prices that may not be the ones an admin set. */}
      {(plansLoading || plansByPrice.length > 0) && (
        <section className="py-24">
          <div className="container mx-auto px-4">
            <div className="text-center max-w-2xl mx-auto mb-16">
              <h2 className="text-3xl font-bold text-foreground mb-4">{l.pricingTitle}</h2>
              <p className="text-muted-foreground text-lg">{l.pricingBody}</p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8 max-w-5xl mx-auto">
              {plansLoading &&
                [1, 2, 3].map((i) => <Skeleton key={i} className="h-96 rounded-3xl" />)}

              {plansByPrice.map((plan) => {
                const isFree = plan.code === "free";
                const isFeatured = plan.code === "general_basic";
                const mutedText = isFeatured ? "text-primary-foreground/80" : "text-muted-foreground";
                const tick = `h-5 w-5 shrink-0 ${isFeatured ? "text-mint" : "text-primary"}`;
                const features =
                  lang === "en" && plan.features?.length ? plan.features : plan.featuresAr;

                return (
                  <div
                    key={plan.id}
                    className={
                      isFeatured
                        ? "bg-primary text-primary-foreground p-8 rounded-3xl shadow-xl shadow-primary/25 relative flex flex-col"
                        : "bg-card p-8 rounded-3xl border border-border flex flex-col"
                    }
                  >
                    {isFeatured && (
                      <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-accent text-accent-foreground px-4 py-1 rounded-full text-sm font-bold shadow-lg whitespace-nowrap">
                        {l.popular}
                      </div>
                    )}
                    <h3 className="text-2xl font-bold mb-2">{pick(plan.nameAr, plan.name)}</h3>
                    <div className="mb-6">
                      <div className="text-4xl font-bold">
                        ${plan.priceUsd}
                        <span className={`text-lg font-normal ${mutedText}`}>{t.common.perMonth}</span>
                      </div>
                      {plan.priceSyp && !isFree && (
                        <div className={`text-sm mt-1 ${mutedText}`} dir="ltr">
                          {Number(plan.priceSyp).toLocaleString("en")} {sb.syp}
                        </div>
                      )}
                    </div>
                    <ul className="space-y-4 mb-8 flex-1">
                      {!isFree && (
                        <>
                          <li className="flex items-center gap-3">
                            <CheckCircle2 className={tick} />
                            <span>{sb.lessonsPerMonth(plan.lessonsPerMonth)}</span>
                          </li>
                          <li className="flex items-center gap-3">
                            <CheckCircle2 className={tick} />
                            <span>{sb.callsPerMonth(plan.callsPerMonth)}</span>
                          </li>
                        </>
                      )}
                      {features?.map((feature) => (
                        <li key={feature} className="flex items-center gap-3">
                          <CheckCircle2 className={tick} /> <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                    <Link href="/register">
                      {isFeatured ? (
                        <Button className="w-full rounded-xl h-12 text-lg bg-accent hover:bg-accent/90 text-accent-foreground font-bold">
                          {l.subscribeNow}
                        </Button>
                      ) : (
                        <Button variant="outline" className="w-full rounded-xl h-12 text-lg">
                          {isFree ? l.startNow : l.choosePlan}
                        </Button>
                      )}
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="border-t border-border bg-card py-12 text-center text-muted-foreground">
        <div className="container mx-auto px-4 flex flex-col items-center">
          <BrandLogo size="sm" className="mb-4" />
          <p className="mb-6">{l.footerLine}</p>
          <p className="text-sm">© {new Date().getFullYear()} EnStep. {l.rights}</p>
        </div>
      </footer>
    </div>
  );
}
