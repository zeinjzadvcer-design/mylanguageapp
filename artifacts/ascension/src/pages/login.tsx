import { useMemo } from "react";
import { Link, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";
import { BrandLogo, LanguageSwitcher } from "@/components/brand";
import { useI18n } from "@/lib/i18n";
import type { Messages } from "@/locales/en";

const makeSchema = (t: Messages) =>
  z.object({
    email: z.string().email({ message: t.auth.invalidEmail }),
    password: z.string().min(6, { message: t.auth.passwordMin6 }),
  });

type FormValues = z.infer<ReturnType<typeof makeSchema>>;

export default function Login() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const login = useLogin();
  const { t } = useI18n();
  const a = t.auth;
  const formSchema = useMemo(() => makeSchema(t), [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  function onSubmit(values: FormValues) {
    login.mutate(
      { data: values },
      {
        onSuccess: (data) => {
          toast({
            title: a.loginSuccess,
            description: a.welcomeBack(data.user.name),
          });
          setLocation("/dashboard");
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: a.loginError,
            description: a.loginErrorBody,
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
          {a.loginTitle}
        </h2>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          {a.noAccount}{" "}
          <Link href="/register" className="font-semibold text-primary hover:text-primary/80">
            {a.registerNow}
          </Link>
        </p>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-card py-8 px-4 shadow-xl border border-border sm:rounded-3xl sm:px-10">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
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
                      <Input type="password" dir="ltr" className="text-left" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="text-end">
                <Link href="/forgot-password" className="text-sm text-primary hover:text-primary/80">
                  {a.forgotPassword}
                </Link>
              </div>

              <Button 
                type="submit" 
                className="w-full h-12 text-lg rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground"
                disabled={login.isPending}
              >
                {login.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin ms-2" />
                ) : (
                  a.loginButton
                )}
              </Button>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
