import { useState, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  useGetProfile,
  useUpdateProfile,
  ProfileUpdatePreferredLanguage,
  useGetNotificationSettings,
  useUpdateNotificationSettings,
} from "@workspace/api-client-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { User as UserIcon, Loader2, Save, Calendar, Globe, BookOpen, Crown } from "lucide-react";
import { format } from "date-fns";
import { useI18n } from "@/lib/i18n";
import { LanguageSwitcher } from "@/components/brand";
import type { Messages } from "@/locales/en";

const makeSchema = (t: Messages) =>
  z.object({
    name: z.string().min(2, { message: t.profile.nameMin }),
    bio: z.string().max(160, { message: t.profile.bioMax }).optional(),
    preferredLanguage: z.nativeEnum(ProfileUpdatePreferredLanguage).default(ProfileUpdatePreferredLanguage.ar),
    country: z.string().default("Syria"),
  });

type FormValues = z.infer<ReturnType<typeof makeSchema>>;

export default function Profile() {
  const { data: profile, isLoading, refetch } = useGetProfile();
  const updateProfile = useUpdateProfile();
  const { toast } = useToast();
  const [isEditing, setIsEditing] = useState(false);
  const { t, setLang, dateLocale } = useI18n();
  const p = t.profile;
  const formSchema = useMemo(() => makeSchema(t), [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      bio: "",
      preferredLanguage: ProfileUpdatePreferredLanguage.ar,
      country: "",
    },
  });

  useEffect(() => {
    if (profile) {
      form.reset({
        name: profile.name,
        bio: profile.bio || "",
        preferredLanguage: profile.preferredLanguage || ProfileUpdatePreferredLanguage.ar,
        country: profile.country || "Syria",
      });
    }
  }, [profile, form]);

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (!profile) return null;

  // Staff have no student record, so progress, plan and bio do not apply.
  const isLearner = profile.id !== null;

  function onSubmit(values: FormValues) {
    updateProfile.mutate(
      { data: values },
      {
        onSuccess: () => {
          // The saved preference is also the language to show right now.
          setLang(values.preferredLanguage === ProfileUpdatePreferredLanguage.en ? "en" : "ar");
          toast({
            title: p.updated,
          });
          setIsEditing(false);
          refetch();
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: p.error,
            description: p.updateFailed,
          });
        }
      }
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-8 animate-in fade-in duration-500">
      
      {/* Profile Header */}
      <Card className="overflow-hidden border-border bg-gradient-to-br from-card to-secondary/30">
        <CardContent className="p-8 md:p-12 text-center md:text-start flex flex-col md:flex-row items-center gap-8">
          <div className="h-32 w-32 rounded-full bg-primary/10 flex items-center justify-center shrink-0 border-4 border-card shadow-lg relative">
            <UserIcon className="h-16 w-16 text-primary" />
          </div>
          <div className="flex-1 space-y-2 text-center md:text-start">
            <h1 className="text-3xl font-bold text-foreground">{profile.name}</h1>
            <p className="text-muted-foreground text-lg" dir="ltr">{profile.email}</p>
            {profile.bio && (
              <p className="text-foreground mt-4 max-w-md mx-auto md:mx-0 bg-background/50 p-3 rounded-lg border border-border/50">
                {profile.bio}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center md:justify-start gap-4 pt-4 mt-4 border-t border-border/50 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Calendar className="h-4 w-4" />
                {p.joined(format(new Date(profile.createdAt), "MMMM yyyy", { locale: dateLocale }))}
              </div>
              <div className="flex items-center gap-1.5">
                <Globe className="h-4 w-4" />
                {(profile.country && p.countries[profile.country]) || profile.country || p.defaultCountry}
              </div>
              {isLearner && (
                <div className="flex items-center gap-1.5">
                  <BookOpen className="h-4 w-4" />
                  {p.level(profile.currentLevelCode ?? "—")}
                </div>
              )}
            </div>
          </div>
          
          <Button 
            variant={isEditing ? "outline" : "default"} 
            className="md:self-start rounded-xl"
            onClick={() => setIsEditing(!isEditing)}
          >
            {isEditing ? p.cancelEdit : p.edit}
          </Button>
        </CardContent>
      </Card>

      {/* Edit Form */}
      {isEditing ? (
        <Card>
          <CardHeader>
            <CardTitle>{p.editTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <div className="grid md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{p.fullName}</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="country"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{p.country}</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={p.chooseCountry} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {["Syria", "Lebanon", "Jordan", "Other"].map((c) => (
                              <SelectItem key={c} value={c}>{p.countries[c]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="preferredLanguage"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{p.preferredLanguage}</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder={p.chooseLanguage} />
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
                </div>

                {isLearner && <FormField
                  control={form.control}
                  name="bio"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{p.bio}</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder={p.bioPlaceholder} 
                          className="resize-none"
                          {...field} 
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />}

                <Button type="submit" disabled={updateProfile.isPending} className="rounded-xl">
                  {updateProfile.isPending ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Save className="h-4 w-4 me-2" />}
                  {p.saveChanges}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {isLearner && <>
          <Card>
            <CardHeader className="bg-secondary/30 pb-4">
              <CardTitle className="text-lg">{p.statsTitle}</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              <div className="flex justify-between items-center pb-4 border-b border-border">
                <span className="text-muted-foreground font-medium">{p.lessonsDone}</span>
                <span className="text-xl font-bold text-foreground">{profile.totalLessonsCompleted}</span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b border-border">
                <span className="text-muted-foreground font-medium">{p.streak}</span>
                <span className="text-xl font-bold text-mint-foreground">{profile.streakDays}🔥</span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b border-border">
                <span className="text-muted-foreground font-medium">{p.totalXp}</span>
                <span className="text-xl font-bold text-primary">{profile.totalXp} XP</span>
              </div>
              <div className="flex justify-between items-center pb-4 border-b border-border">
                <span className="text-muted-foreground font-medium">{p.placementStatus}</span>
                <span className={`text-sm font-bold px-3 py-1 rounded-full ${profile.placementCompleted ? "bg-mint-soft text-mint-foreground" : "bg-muted text-muted-foreground"}`}>
                  {profile.placementCompleted ? p.complete : p.incomplete}
                </span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="bg-secondary/30 pb-4">
              <CardTitle className="text-lg">{p.planTitle}</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 flex flex-col items-center justify-center text-center space-y-4">
              <div className="h-16 w-16 bg-primary/10 rounded-full flex items-center justify-center mb-2">
                <Crown className="h-8 w-8 text-primary" />
              </div>
              <h3 className="text-2xl font-bold capitalize">
                {(profile.subscriptionPlan && p.plans[profile.subscriptionPlan]) || profile.subscriptionPlan}
              </h3>
              <p className="text-muted-foreground text-sm max-w-xs mx-auto">
                {p.planBody}
              </p>
              <Button onClick={() => window.location.href="/subscription"} className="mt-4 rounded-xl" variant="outline">
                {p.manage}
              </Button>
            </CardContent>
          </Card>
          </>}

          {isLearner && <ReminderSetting />}

          <Card className="md:col-span-2">
            <CardContent className="p-6 flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex-1">
                <h3 className="font-bold text-foreground">{p.languageTitle}</h3>
                <p className="text-sm text-muted-foreground mt-1">{p.languageBody}</p>
              </div>
              <LanguageSwitcher className="self-start sm:self-auto" />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

/** The daily lesson reminder, on or off. Hidden for an account with no student profile. */
function ReminderSetting() {
  const { t } = useI18n();
  const n = t.notifications;
  const { toast } = useToast();
  const settings = useGetNotificationSettings();
  const update = useUpdateNotificationSettings();

  if (settings.data && settings.data.lessonReminders === null) return null;
  const on = settings.data?.lessonReminders ?? true;

  return (
    <Card className="md:col-span-2">
      <CardContent className="p-6 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <Label htmlFor="lesson-reminders" className="font-bold text-foreground text-base">
            {n.remindersTitle}
          </Label>
          <p className="text-sm text-muted-foreground mt-1">{n.remindersBody}</p>
        </div>
        <Switch
          id="lesson-reminders"
          className="shrink-0"
          checked={on}
          disabled={settings.isLoading || update.isPending}
          onCheckedChange={(value) =>
            update.mutate(
              { data: { lessonReminders: value } },
              {
                onSuccess: () => {
                  void settings.refetch();
                  toast({ title: value ? n.remindersOn : n.remindersOff });
                },
                onError: () => toast({ variant: "destructive", title: n.remindersFailed }),
              },
            )
          }
        />
      </CardContent>
    </Card>
  );
}
