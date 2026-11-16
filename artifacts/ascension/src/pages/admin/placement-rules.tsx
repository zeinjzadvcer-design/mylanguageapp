/**
 * Admin placement rules: the score each level needs, what each question is
 * worth, how much writing counts, and the strength/weakness cut-offs — with a
 * preview of what typical students would be placed at before anything is saved.
 *
 * Every box is edited as text and turned into numbers on the way out, so a
 * half-typed value is shown as a problem instead of being snapped to a number
 * under the administrator's cursor. The server checks everything again.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GraduationCap, Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";
import {
  DIFFICULTIES,
  placementRulesApi,
  PlacementRulesError,
  type PlacementRules,
} from "@/lib/placement-rules-api";

/** The form: every box as typed. */
interface Form {
  thresholds: Record<string, string>;
  weights: Record<string, string>;
  writingWeight: string;
  weakBelow: string;
  strongAt: string;
}

const text = (n: number | null) => (n === null ? "" : String(n));

function formOf(rules: PlacementRules, levelCodes: string[]): Form {
  return {
    thresholds: Object.fromEntries(levelCodes.map((c) => [c, text(rules.levelThresholds[c] ?? null)])),
    weights: Object.fromEntries(DIFFICULTIES.map((d) => [d, text(rules.difficultyWeights[d])])),
    writingWeight: text(rules.writingWeight),
    weakBelow: text(rules.weakBelow),
    strongAt: text(rules.strongAt),
  };
}

/** A number in [min, max], or undefined when the box does not hold one. */
function num(s: string, min: number, max: number): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** The rules the form describes, or null when a box does not hold a usable number. */
function rulesOf(form: Form, levelCodes: string[]): PlacementRules | null {
  const levelThresholds: Record<string, number | null> = {};
  for (const c of levelCodes) {
    const s = form.thresholds[c] ?? "";
    if (s.trim() === "") {
      levelThresholds[c] = null;
      continue;
    }
    const n = num(s, 0, 100);
    if (n === undefined) return null;
    levelThresholds[c] = n;
  }
  const difficultyWeights = {} as PlacementRules["difficultyWeights"];
  for (const d of DIFFICULTIES) {
    const n = num(form.weights[d] ?? "", 0.1, 10);
    if (n === undefined) return null;
    difficultyWeights[d] = n;
  }
  const writingWeight = num(form.writingWeight, 0, 10);
  const weakBelow = num(form.weakBelow, 0, 100);
  const strongAt = num(form.strongAt, 0, 100);
  if (writingWeight === undefined || weakBelow === undefined || strongAt === undefined) return null;
  return { difficultyWeights, levelThresholds, writingWeight, weakBelow, strongAt };
}

export default function AdminPlacementRules() {
  const { t, lang } = useI18n();
  const p = t.admin.placementRules;
  const { toast } = useToast();
  const qc = useQueryClient();

  const state = useQuery({ queryKey: ["admin-placement-rules"], queryFn: placementRulesApi.get });
  const levelCodes = state.data?.levelCodes ?? [];

  const [form, setForm] = useState<Form | null>(null);
  const [writingMark, setWritingMark] = useState("");

  // Filled once from the server, and again after a save.
  useEffect(() => {
    if (state.data && form === null) setForm(formOf(state.data.rules, state.data.levelCodes));
  }, [state.data, form]);

  const rules = useMemo(() => (form ? rulesOf(form, levelCodes) : null), [form, levelCodes]);

  /** The same checks the server makes, in the administrator's language. */
  const problems = useMemo(() => {
    if (!form) return [];
    if (!rules) return [p.problemNumber];
    const out: string[] = [];
    const used = levelCodes.filter((c) => rules.levelThresholds[c] !== null);
    if (used.length === 0) out.push(p.problemNoLevel);
    else {
      if (rules.levelThresholds[used[0]] !== 0) out.push(p.problemFloor(used[0]));
      for (let i = 1; i < used.length; i++) {
        if ((rules.levelThresholds[used[i]] as number) <= (rules.levelThresholds[used[i - 1]] as number)) {
          out.push(p.problemOrder(used[i], used[i - 1]));
        }
      }
    }
    if (rules.weakBelow >= rules.strongAt) out.push(p.problemSkills);
    return out;
  }, [form, rules, levelCodes, p]);

  // The preview follows the form, a moment after typing stops.
  const writingScore = writingMark.trim() === "" ? null : num(writingMark, 0, 100) ?? null;
  const [previewInput, setPreviewInput] = useState<{ rules: PlacementRules; writingScore: number | null } | null>(null);
  useEffect(() => {
    if (!rules || problems.length) {
      setPreviewInput(null);
      return;
    }
    const timer = setTimeout(() => setPreviewInput({ rules, writingScore }), 350);
    return () => clearTimeout(timer);
  }, [rules, writingScore, problems.length]);

  const preview = useQuery({
    queryKey: ["admin-placement-rules-preview", previewInput],
    queryFn: () => placementRulesApi.preview(previewInput!.rules, previewInput!.writingScore),
    enabled: previewInput !== null,
  });

  const save = useMutation({
    mutationFn: () => placementRulesApi.save(rules!),
    onSuccess: () => {
      // The form already shows what was saved; the refetch only updates who saved it and when.
      toast({ title: p.saved });
      void qc.invalidateQueries({ queryKey: ["admin-placement-rules"] });
    },
    onError: (e) =>
      toast({
        variant: "destructive",
        title: p.saveError,
        description: e instanceof PlacementRulesError ? e.message : undefined,
      }),
  });

  const scenarioLabel = (key: string) =>
    key === "guess" ? p.scenarioGuess : key === "none" ? p.scenarioNone : p.scenarioUpTo(key.replace("upTo:", ""));

  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  if (state.isError) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto">
        <p className="text-destructive">{p.loadError}</p>
      </div>
    );
  }

  if (!state.data || !form) {
    return (
      <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const data = state.data;
  const when = data.updatedAt ? new Date(data.updatedAt).toLocaleString(lang === "ar" ? "ar" : "en") : null;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold text-foreground flex items-center gap-3">
          <GraduationCap className="h-7 w-7 text-primary" />
          {p.title}
        </h1>
        <p className="text-muted-foreground mt-1">{p.subtitle}</p>
        <p className="text-sm text-muted-foreground mt-2">
          {when ? (data.updatedByName ? p.savedBy(data.updatedByName, when) : p.savedOn(when)) : p.usingDefaults}{" "}
          {p.testHas(data.questions.choice, data.questions.written)}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="border-2 lg:row-span-2">
          <CardContent className="p-5 space-y-3">
            <h2 className="font-bold text-lg">{p.levelsTitle}</h2>
            <p className="text-sm text-muted-foreground">{p.levelsHint}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{p.level}</TableHead>
                  <TableHead>{p.minScore}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {levelCodes.map((code) => (
                  <TableRow key={code}>
                    <TableCell className="font-medium" dir="ltr">{code}</TableCell>
                    <TableCell>
                      <Input
                        aria-label={`${p.minScore} ${code}`}
                        dir="ltr"
                        inputMode="decimal"
                        className="w-28"
                        placeholder={p.notUsed}
                        value={form.thresholds[code] ?? ""}
                        onChange={(e) => set({ thresholds: { ...form.thresholds, [code]: e.target.value } })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border-2">
          <CardContent className="p-5 space-y-3">
            <h2 className="font-bold text-lg">{p.weightsTitle}</h2>
            <p className="text-sm text-muted-foreground">{p.weightsHint}</p>
            <div className="grid grid-cols-3 gap-3">
              {DIFFICULTIES.map((d) => (
                <div key={d} className="space-y-1">
                  <Label htmlFor={`w-${d}`} dir="ltr">{d}</Label>
                  <Input
                    id={`w-${d}`}
                    dir="ltr"
                    inputMode="decimal"
                    value={form.weights[d] ?? ""}
                    onChange={(e) => set({ weights: { ...form.weights, [d]: e.target.value } })}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="border-2">
          <CardContent className="p-5 space-y-3">
            <h2 className="font-bold text-lg">{p.writingTitle}</h2>
            <div className="space-y-1">
              <Label htmlFor="writing-weight">{p.writingWeight}</Label>
              <Input
                id="writing-weight"
                dir="ltr"
                inputMode="decimal"
                className="w-28"
                value={form.writingWeight}
                onChange={(e) => set({ writingWeight: e.target.value })}
              />
            </div>
            <p className="text-sm text-muted-foreground">{p.writingHint}</p>
            <p className="text-sm text-muted-foreground">{p.writingPlans}</p>
          </CardContent>
        </Card>

        <Card className="border-2">
          <CardContent className="p-5 space-y-3">
            <h2 className="font-bold text-lg">{p.skillsTitle}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="weak-below">{p.weakBelow}</Label>
                <Input id="weak-below" dir="ltr" inputMode="decimal" value={form.weakBelow} onChange={(e) => set({ weakBelow: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="strong-at">{p.strongAt}</Label>
                <Input id="strong-at" dir="ltr" inputMode="decimal" value={form.strongAt} onChange={(e) => set({ strongAt: e.target.value })} />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{p.skillsHint}</p>
          </CardContent>
        </Card>

        <Card className="border-2">
          <CardContent className="p-5 space-y-2">
            <h2 className="font-bold text-lg">{p.aiTitle}</h2>
            <p className="text-sm text-muted-foreground">{data.aiAdjustmentEnabled ? p.aiOn : p.aiOff}</p>
            <Link href="/admin/ai" className="text-sm text-primary underline">{p.aiChange}</Link>
          </CardContent>
        </Card>
      </div>

      <Card className="border-2">
        <CardContent className="p-5 space-y-3">
          <h2 className="font-bold text-lg">{p.previewTitle}</h2>
          <p className="text-sm text-muted-foreground">{p.previewHint}</p>
          {data.questions.written > 0 && (
            <div className="space-y-1">
              <Label htmlFor="preview-writing">{p.previewWriting}</Label>
              <Input
                id="preview-writing"
                dir="ltr"
                inputMode="decimal"
                className="w-40"
                placeholder={p.previewWritingNone}
                value={writingMark}
                onChange={(e) => setWritingMark(e.target.value)}
              />
            </div>
          )}
          {problems.length > 0 ? (
            <ul className="list-disc ps-5 text-sm text-destructive space-y-1">
              {problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          ) : preview.isError ? (
            <p className="text-sm text-destructive">
              {p.previewError}
              {preview.error instanceof PlacementRulesError ? ` (${preview.error.message})` : ""}
            </p>
          ) : preview.data ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{p.scenario}</TableHead>
                  <TableHead>{p.weighted}</TableHead>
                  <TableHead>{p.placedAt}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.data.scenarios.map((s) => (
                  <TableRow key={s.key}>
                    <TableCell>{scenarioLabel(s.key)}</TableCell>
                    <TableCell dir="ltr" className="text-start">{s.overall}%</TableCell>
                    <TableCell dir="ltr" className="text-start font-medium">{s.levelCode}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={!rules || problems.length > 0 || save.isPending}>
          {save.isPending ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Save className="h-4 w-4 me-2" />}
          {save.isPending ? p.saving : p.save}
        </Button>
        <Button variant="outline" title={p.resetHint} onClick={() => setForm(formOf(data.defaults, levelCodes))}>
          <RotateCcw className="h-4 w-4 me-2" />
          {p.reset}
        </Button>
        <span className="text-xs text-muted-foreground">{p.resetHint}</span>
      </div>
    </div>
  );
}
