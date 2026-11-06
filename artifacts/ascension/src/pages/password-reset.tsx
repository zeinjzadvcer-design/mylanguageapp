/**
 * Password recovery: request a link, then set a new password with it.
 *
 * Two screens in one file because they are two halves of one flow and share
 * their API calls. Hand-written fetch rather than generated hooks: these
 * endpoints are not in `openapi.yaml`, the same reason `quiz-api.ts` exists.
 */
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, CheckCircle2, ArrowLeft } from "lucide-react";
import { BrandLogo, LanguageSwitcher } from "@/components/brand";
import { PasswordInput } from "@/components/password-input";
import { useI18n } from "@/lib/i18n";

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

async function post<T>(path: string, body: unknown, fallbackError: string): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(payload?.error ?? fallbackError);
  }
  return payload as T;
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen bg-background flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <LanguageSwitcher className="absolute top-4 end-4" />
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <Link href="/" className="inline-flex mb-6 cursor-pointer">
          <BrandLogo size="lg" />
        </Link>
        <h2 className="mt-2 text-3xl font-extrabold text-foreground">{title}</h2>
      </div>
      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-card py-8 px-4 shadow-xl border border-border sm:rounded-3xl sm:px-10 space-y-5">
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── Request a link ───────────────────────────────────────────────────────────

export function ForgotPassword() {
  const { toast } = useToast();
  const { t } = useI18n();
  const a = t.auth;
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  /** Only returned in development, when no mail provider is configured. */
  const [devLink, setDevLink] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      const r = await post<{ message: string; devResetLink?: string }>(
        "/auth/forgot-password",
        { email },
        a.genericError,
      );
      setDevLink(r.devResetLink ?? null);
      setSent(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: a.sendLinkFailed,
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <Shell title={a.checkEmailTitle}>
        <div className="flex flex-col items-center text-center gap-3">
          <CheckCircle2 className="h-12 w-12 text-emerald-600" />
          <p className="text-muted-foreground leading-relaxed">
            {a.checkEmailBody}
          </p>
        </div>

        {devLink && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs space-y-1">
            <p className="font-medium text-amber-900">
              {a.devLinkNote}
            </p>
            <a href={devLink} className="break-all text-amber-700 underline" dir="ltr">
              {devLink}
            </a>
          </div>
        )}

        <Link href="/login">
          <Button variant="outline" className="w-full">{a.backToLogin}</Button>
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title={a.forgotTitle}>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {a.forgotBody}
      </p>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label>{a.emailLabel}</Label>
          <Input
            type="email"
            required
            dir="ltr"
            className="text-left"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button type="submit" className="w-full h-12 text-lg rounded-xl" disabled={pending}>
          {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : a.sendLink}
        </Button>
      </form>
      <Link href="/login" className="block text-center text-sm text-muted-foreground hover:text-foreground">
        {a.backToLogin}
      </Link>
    </Shell>
  );
}

// ─── Set a new password ───────────────────────────────────────────────────────

export function ResetPassword() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const { t } = useI18n();
  const a = t.auth;
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);

  // wouter's useSearch is not used elsewhere in this app; read it directly.
  const token = new URLSearchParams(window.location.search).get("token") ?? "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      toast({ variant: "destructive", title: a.passwordsMismatch });
      return;
    }
    setPending(true);
    try {
      await post("/auth/reset-password", { token, password }, a.genericError);
      toast({ title: a.passwordChanged, description: a.canLoginNow });
      setLocation("/login");
    } catch (err) {
      toast({
        variant: "destructive",
        title: a.changeFailed,
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setPending(false);
    }
  };

  if (!token) {
    return (
      <Shell title={a.invalidLinkTitle}>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {a.invalidLinkBody}
        </p>
        <Link href="/forgot-password">
          <Button className="w-full">
            {a.requestNewLink} <ArrowLeft className="h-4 w-4 ms-1 ltr:-scale-x-100" />
          </Button>
        </Link>
      </Shell>
    );
  }

  return (
    <Shell title={a.newPasswordTitle}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label>{a.newPassword}</Label>
          <PasswordInput
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {a.passwordHint}
          </p>
        </div>
        <div className="space-y-2">
          <Label>{a.confirmPassword}</Label>
          <PasswordInput
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <Button type="submit" className="w-full h-12 text-lg rounded-xl" disabled={pending}>
          {pending ? <Loader2 className="h-5 w-5 animate-spin" /> : a.changePassword}
        </Button>
      </form>
    </Shell>
  );
}
