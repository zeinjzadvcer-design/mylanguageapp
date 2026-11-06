import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { useRegister, RegisterInputPreferredLanguage, RegisterInputReferralSource, getGetMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { BrandLogo, LanguageSwitcher } from "@/components/brand";
import { useI18n } from "@/lib/i18n";
import type { Messages } from "@/locales/en";

/** Signup referral options, in the order they are offered. */
const REFERRAL_SOURCES: RegisterInputReferralSource[] = [
  RegisterInputReferralSource.facebook,
  RegisterInputReferralSource.instagram,
  RegisterInputReferralSource.tiktok,
  RegisterInputReferralSource.youtube,
  RegisterInputReferralSource.whatsapp,
  RegisterInputReferralSource.friend,
  RegisterInputReferralSource.search,
  RegisterInputReferralSource.advertisement,
  RegisterInputReferralSource.other,
];

// Keep this in sync with the weak-password list in artifacts/api-server/src/lib/validate.ts
// so the browser catches the same obviously-weak passwords before hitting the server.
const WEAK_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "letmein123",
  "welcome123",
  "iloveyou1",
  "admin1234",
  "changeme1",
]);

const makeSchema = (t: Messages) =>
  z.object({
    name: z.string().min(2, { message: t.auth.nameMin }),
    email: z.string().email({ message: t.auth.invalidEmail }),
    password: z
      .string()
      .min(8, { message: t.auth.passwordMin8 })
      .regex(/[a-zA-Z]/, { message: t.auth.passwordLetter })
      .regex(/[0-9]/, { message: t.auth.passwordDigit })
      .refine((value) => !WEAK_PASSWORDS.has(value.toLowerCase()), {
        message: t.auth.passwordWeak,
      }),
    confirmPassword: z.string().min(1, { message: t.auth.confirmRequired }),
    preferredLanguage: z.nativeEnum(RegisterInputPreferredLanguage).default(RegisterInputPreferredLanguage.ar),
    country: z.string().length(2).default("SY"),
    referralSource: z.nativeEnum(RegisterInputReferralSource, {
      errorMap: () => ({ message: t.auth.referralRequired }),
    }),
    referralDetail: z.string().max(200).optional(),
  }).refine((data) => data.password === data.confirmPassword, {
    message: t.auth.passwordsMismatch,
    path: ["confirmPassword"],
  });

type FormValues = z.infer<ReturnType<typeof makeSchema>>;

export default function Register() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const register = useRegister();
  const queryClient = useQueryClient();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  
  const { t, lang } = useI18n();
  const a = t.auth;
  const formSchema = useMemo(() => makeSchema(t), [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
      // Default to the language the visitor is already reading the page in.
      preferredLanguage: lang === "en" ? RegisterInputPreferredLanguage.en : RegisterInputPreferredLanguage.ar,
      country: "SY",
    },
  });

  function onSubmit(values: FormValues) {
    // confirmPassword only exists to check the two password fields match in
    // the browser — the backend only ever sees "password".
    const { confirmPassword: _confirmPassword, ...data } = values;
    register.mutate(
      { data },
      {
        onSuccess: () => {
          queryClient.removeQueries({ queryKey: getGetMeQueryKey() });
          toast({
            title: a.registerSuccess,
            description: a.registerSuccessBody,
          });
          setLocation("/placement");
        },
        onError: (error) => {
          // The server sends back the real reason the request failed (e.g.
          // "email already registered", or a list of field validation
          // errors) — show that instead of always guessing "email taken".
          const data = error?.data as
            | { error?: string; details?: Array<{ message?: string }> }
            | null
            | undefined;
          const description =
            data?.details
              ?.map((d) => d.message)
              .filter((message): message is string => Boolean(message))
              .join(lang === "ar" ? "، " : ", ") ||
            data?.error ||
            a.unexpectedError;
          toast({
            variant: "destructive",
            title: a.registerError,
            description,
          });
        },
      }
    );
  }

  return (
    <div className="relative min-h-screen bg-background flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <LanguageSwitcher className="absolute top-4 end-4" />
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <Link href="/" className="inline-flex mb-6 cursor-pointer">
          <BrandLogo size="lg" />
        </Link>
        <h2 className="mt-2 text-center text-3xl font-extrabold text-foreground">
          {a.registerTitle}
        </h2>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          {a.haveAccount}{" "}
          <Link href="/login" className="font-semibold text-primary hover:text-primary/80">
            {a.loginTitle}
          </Link>
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-card py-8 px-4 shadow-xl border border-border sm:rounded-3xl sm:px-10">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{a.fullName}</FormLabel>
                    <FormControl>
                      <Input placeholder={a.namePlaceholder} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{a.emailLabel}</FormLabel>
                    <FormControl>
                      <Input placeholder="your@email.com" dir="ltr" className="text-left" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{a.passwordLabel}</FormLabel>
                    <FormControl>
                      <InputGroup dir="ltr">
                        <InputGroupInput
                          type={showPassword ? "text" : "password"}
                          className="text-left"
                          {...field}
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            type="button"
                            aria-label={showPassword ? a.hidePassword : a.showPassword}
                            onClick={() => setShowPassword((prev) => !prev)}
                          >
                            {showPassword ? <EyeOff /> : <Eye />}
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="confirmPassword"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{a.confirmPassword}</FormLabel>
                    <FormControl>
                      <InputGroup dir="ltr">
                        <InputGroupInput
                          type={showConfirmPassword ? "text" : "password"}
                          className="text-left"
                          {...field}
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupButton
                            type="button"
                            aria-label={showConfirmPassword ? a.hidePassword : a.showPassword}
                            onClick={() => setShowConfirmPassword((prev) => !prev)}
                          >
                            {showConfirmPassword ? <EyeOff /> : <Eye />}
                          </InputGroupButton>
                        </InputGroupAddon>
                      </InputGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="preferredLanguage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{a.uiLanguage}</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={a.chooseLanguage} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="ar">العربية</SelectItem>
                          <SelectItem value="en">English</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                
                <FormField
                  control={form.control}
                  name="country"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{a.country}</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder={a.chooseCountry} />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="SY">{a.syria}</SelectItem>
                          <SelectItem value="XX">{a.other}</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="referralSource"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{a.referralQuestion}</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder={a.choose} />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {REFERRAL_SOURCES.map((value) => (
                          <SelectItem key={value} value={value}>{a.referral[value] ?? value}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Only "other" has anything to add — the rest are self-describing. */}
              {form.watch("referralSource") === RegisterInputReferralSource.other && (
                <FormField
                  control={form.control}
                  name="referralDetail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{a.how}</FormLabel>
                      <FormControl>
                        <Input {...field} value={field.value ?? ""} placeholder={a.writeHere} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <Button
                type="submit"
                className="w-full h-12 text-lg rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground mt-4"
                disabled={register.isPending}
              >
                {register.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin ms-2" />
                ) : (
                  a.registerButton
                )}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
