import { Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

const asset = (name: string) => `${import.meta.env.BASE_URL}brand/${name}`;

/** The full lock-up: mark, wordmark and the "English step by step" tagline. */
export const LOGO_FULL_SRC = asset("logo-full.png");
/** The app icon: the mark and wordmark on the purple squircle. */
export const LOGO_ICON_SRC = asset("logo-icon.png");
const LOGO_MARK_SRC = asset("logo-mark.png");

/**
 * The speech-bubble "E" mark beside an "EnStep" wordmark set in type, so it
 * stays crisp at any size. The wordmark is always LTR, also on Arabic pages.
 */
export function BrandLogo({
  size = "md",
  className,
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const mark = { sm: "h-7", md: "h-9", lg: "h-12" }[size];
  const text = { sm: "text-xl", md: "text-2xl", lg: "text-3xl" }[size];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <img src={LOGO_MARK_SRC} alt="" aria-hidden className={cn(mark, "w-auto")} />
      <span dir="ltr" className={cn(text, "font-extrabold tracking-tight font-brand")}>
        <span className="text-primary">En</span>
        <span className="text-mint">Step</span>
      </span>
    </span>
  );
}

/**
 * Switches between Arabic and English. Each option is labelled in its own
 * language, so it can be found by someone who cannot read the current one.
 */
export function LanguageSwitcher({
  variant = "pill",
  className,
}: {
  /** "pill" for headers, "row" for a full-width menu entry. */
  variant?: "pill" | "row";
  className?: string;
}) {
  const { lang, setLang, t } = useI18n();
  const next = lang === "ar" ? "en" : "ar";
  const label = next === "en" ? "English" : "العربية";

  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={() => setLang(next)}
        className={cn(
          "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-muted-foreground hover:bg-secondary hover:text-secondary-foreground transition-colors",
          className,
        )}
        aria-label={t.common.switchLanguage}
      >
        <Languages className="h-5 w-5" />
        <span className="font-medium" lang={next}>{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setLang(next)}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-card/70 px-3 py-1.5 text-sm font-semibold text-foreground hover:border-primary/40 hover:text-primary transition-colors",
        className,
      )}
      aria-label={t.common.switchLanguage}
    >
      <Languages className="h-4 w-4" />
      <span lang={next}>{label}</span>
    </button>
  );
}
