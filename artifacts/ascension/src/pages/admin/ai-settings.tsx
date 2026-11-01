/**
 * AI configuration panel.
 *
 * Everything about the AI setup is edited here at runtime — provider endpoint,
 * API key, the model for each task, and each plan's daily allowance. Nothing is
 * baked into the build, so changing provider or pricing a tier needs no deploy.
 *
 * This screen is for the operator, not for students, so it is left-to-right and
 * in English while the rest of the app is Arabic and right-to-left.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Zap,
} from "lucide-react";
import {
  getAiConfig,
  getAiUsage,
  updateAiSettings,
  createProvider,
  updateProvider,
  deleteProvider,
  listProviderModels,
  testProvider,
  updateTask,
  setPolicy,
  AiAdminError,
  type AiConfig,
  type AiProvider,
  type AiTaskSettings,
  type ModelInfo,
  type UsageRow,
  type UsageTotals,
  type UsageByUser,
  type AITask,
} from "@/lib/ai-admin-api";

/** What each task is for, so the panel does not read as a list of slugs. */
const TASK_HELP: Record<AITask, string> = {
  open_answer: "Grades a written open-ended answer for relevance, grammar and clarity.",
  placement_analysis: "Turns placement test results into a level and a list of weaknesses.",
  conversation: "The curriculum-bound conversation tutor.",
  feedback: "Writes the short Arabic advice sentence from scores already computed.",
  weakness_analysis: "Finds patterns across lessons and recommends existing material.",
  transcription: "Speech to text. Needs a provider with the speech role.",
};

const PLAN_CODES = ["free", "general_english", "professional_english", "admin"];

export default function AiSettings() {
  const { toast } = useToast();
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const [byUser, setByUser] = useState<UsageByUser[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, u] = await Promise.all([getAiConfig(), getAiUsage(30)]);
      setConfig(c);
      setUsage(u.rows);
      setTotals(u.totals ?? null);
      setByUser(u.byUser ?? []);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof AiAdminError ? e.message : "Could not load AI configuration");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run a mutation, report failure, and refresh from the server afterwards. */
  const run = async (fn: () => Promise<unknown>, successMessage?: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      if (successMessage) toast({ title: successMessage });
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Failed",
        description: e instanceof AiAdminError ? e.message : "Something went wrong.",
      });
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-center space-y-4">
        <AlertCircle className="h-10 w-10 mx-auto text-destructive" />
        <p className="text-destructive font-medium">{loadError}</p>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-4">
        <Skeleton className="h-10 w-64 rounded-lg" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  const { settings, providers, tasks, policies } = config;
  const chatProviders = providers.filter((p) => p.role === "chat");
  const totalSpend = usage.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  return (
    <div dir="ltr" className="p-4 md:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">AI configuration</h1>
          <p className="text-sm text-muted-foreground">
            Provider, models and limits. Changes take effect immediately — no deploy.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {!settings.encryptionAvailable && (
        <Card className="border-2 border-amber-300 bg-amber-50">
          <CardContent className="p-4 flex gap-3">
            <AlertCircle className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              <p className="font-bold">AI_CONFIG_SECRET is not set.</p>
              <p>
                API keys cannot be stored until it is. Generate one with{" "}
                <code className="font-mono">openssl rand -hex 32</code> and set it on the API
                server, then reload this page.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Global switch and budget */}
      <Card className="border-2">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-bold">Master switch</h2>
              <p className="text-sm text-muted-foreground">
                Off means no AI call is made anywhere, whatever else is configured.
              </p>
            </div>
            <Switch
              checked={settings.enabled}
              disabled={busy || !settings.encryptionAvailable}
              onCheckedChange={(v) =>
                run(() => updateAiSettings({ enabled: v }), v ? "AI enabled" : "AI disabled")
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 pt-2 border-t">
            <BudgetField
              value={settings.monthlyBudgetUsd}
              disabled={busy}
              onSave={(v) => run(() => updateAiSettings({ monthlyBudgetUsd: v }), "Budget saved")}
            />
            <div>
              <Label className="text-xs text-muted-foreground">Spend this month</Label>
              <p className="text-2xl font-bold tabular-nums">
                ${settings.monthToDateSpendUsd.toFixed(2)}
              </p>
              {settings.monthlyBudgetUsd != null && (
                <p className="text-xs text-muted-foreground">
                  of ${settings.monthlyBudgetUsd.toFixed(2)} — calls are refused past the ceiling
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Providers */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Providers</h2>
        <p className="text-sm text-muted-foreground">
          Any OpenAI-compatible endpoint. NVIDIA NIM is{" "}
          <code className="font-mono text-xs">https://integrate.api.nvidia.com/v1</code>. One
          provider can be active per role.
        </p>

        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            busy={busy}
            onSave={(patch) => run(() => updateProvider(p.id, patch), "Provider saved")}
            onDelete={() => run(() => deleteProvider(p.id), "Provider deleted")}
          />
        ))}

        <NewProviderCard
          busy={busy}
          onCreate={(input) => run(() => createProvider(input), "Provider added")}
        />
      </section>

      {/* Tasks */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Tasks</h2>
        <p className="text-sm text-muted-foreground">
          Each task picks its own model, so cheap high-volume work and careful work can use
          different ones. A task cannot be enabled without a provider and a model.
        </p>
        {tasks.map((t) => (
          <TaskCard
            key={t.task}
            task={t}
            providers={t.task === "transcription" ? providers : chatProviders}
            busy={busy}
            onSave={(patch) => run(() => updateTask(t.task, patch), `${t.task} saved`)}
          />
        ))}
      </section>

      {/* Plan limits */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Daily limits by plan</h2>
        <p className="text-sm text-muted-foreground">
          Requests per rolling day. 0 denies the feature, −1 is unlimited. A plan and task with
          no row is denied.
        </p>
        <Card className="border-2 overflow-x-auto">
          <CardContent className="p-0">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-3 font-medium">Task</th>
                  {PLAN_CODES.map((code) => (
                    <th key={code} className="text-left p-3 font-medium whitespace-nowrap">
                      {code}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.task} className="border-t">
                    <td className="p-3 font-mono text-xs whitespace-nowrap">{t.task}</td>
                    {PLAN_CODES.map((code) => {
                      const policy = policies.find(
                        (p) => p.planCode === code && p.task === t.task,
                      );
                      return (
                        <td key={code} className="p-2">
                          <LimitField
                            value={policy?.dailyLimit ?? 0}
                            disabled={busy}
                            onSave={(v) => run(() => setPolicy(code, t.task, v))}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </section>

      {/* Usage */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Usage, last 30 days</h2>

        {totals && totals.calls > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="border-2">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Total spend</div>
                <div className="text-2xl font-bold">${totals.total_cost_usd.toFixed(2)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {totals.calls.toLocaleString()} calls
                </div>
              </CardContent>
            </Card>

            <Card className="border-2">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Average per student</div>
                <div className="text-2xl font-bold">${totals.avg_cost_usd.toFixed(3)}</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {totals.active_users} active
                </div>
              </CardContent>
            </Card>

            {/* The number that says whether the quotas bind. Above the cheapest
                paid plan means one student costs more than they pay. */}
            <Card className={totals.max_cost_usd >= 2 ? "border-2 border-destructive" : "border-2"}>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Heaviest student</div>
                <div className={`text-2xl font-bold ${totals.max_cost_usd >= 2 ? "text-destructive" : ""}`}>
                  ${totals.max_cost_usd.toFixed(3)}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {totals.max_cost_usd >= 2 ? "above the $2 plan — check limits" : "within plan"}
                </div>
              </CardContent>
            </Card>

            <Card className={totals.failures > 0 ? "border-2 border-amber-500" : "border-2"}>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Failures</div>
                <div className={`text-2xl font-bold ${totals.failures > 0 ? "text-amber-600" : ""}`}>
                  {totals.failures}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {totals.calls > 0
                    ? `${((totals.failures / totals.calls) * 100).toFixed(1)}% of calls`
                    : "—"}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {usage.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI calls recorded yet.</p>
        ) : (
          <Card className="border-2 overflow-x-auto">
            <CardContent className="p-0">
              <table className="w-full text-sm min-w-[480px]">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-3 font-medium">Task</th>
                    <th className="text-right p-3 font-medium">Calls</th>
                    <th className="text-right p-3 font-medium">Failures</th>
                    <th className="text-right p-3 font-medium">Tokens</th>
                    <th className="text-right p-3 font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.map((r) => (
                    <tr key={r.task} className="border-t">
                      <td className="p-3 font-mono text-xs">{r.task}</td>
                      <td className="p-3 text-right tabular-nums">{r.calls}</td>
                      <td
                        className={`p-3 text-right tabular-nums ${r.failures > 0 ? "text-destructive" : ""}`}
                      >
                        {r.failures}
                      </td>
                      <td className="p-3 text-right tabular-nums">{r.tokens.toLocaleString()}</td>
                      <td className="p-3 text-right tabular-nums">
                        ${(r.cost_usd ?? 0).toFixed(4)}
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t bg-muted/30 font-bold">
                    <td className="p-3">Total</td>
                    <td className="p-3 text-right tabular-nums">
                      {usage.reduce((s, r) => s + r.calls, 0)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {usage.reduce((s, r) => s + r.failures, 0)}
                    </td>
                    <td className="p-3 text-right tabular-nums">
                      {usage.reduce((s, r) => s + r.tokens, 0).toLocaleString()}
                    </td>
                    <td className="p-3 text-right tabular-nums">${totalSpend.toFixed(4)}</td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {/* Per student, worst first. The aggregate above says what the product
            costs; this says whether any one student costs more than they pay. */}
        {byUser.length > 0 && (
          <>
            <h3 className="text-sm font-semibold pt-2">Heaviest students</h3>
            <Card className="border-2 overflow-x-auto">
              <CardContent className="p-0">
                <table className="w-full text-sm min-w-[520px]">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left p-3 font-medium">Student</th>
                      <th className="text-left p-3 font-medium">Plan</th>
                      <th className="text-right p-3 font-medium">Calls</th>
                      <th className="text-right p-3 font-medium">Spend</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byUser.map((u) => {
                      const planPrice =
                        u.plan_code === "professional_english" ? 4 :
                        u.plan_code === "general_english" ? 2 : 0;
                      const overspending = planPrice > 0 && u.cost_usd >= planPrice;
                      return (
                        <tr key={u.user_id} className="border-t border-border">
                          <td className="p-3">
                            <div className="font-medium">{u.name ?? `#${u.user_id}`}</div>
                            <div className="text-xs text-muted-foreground" dir="ltr">
                              {u.email ?? "—"}
                            </div>
                          </td>
                          <td className="p-3 text-xs text-muted-foreground">{u.plan_code}</td>
                          <td className="p-3 text-right tabular-nums">{u.calls}</td>
                          <td className={`p-3 text-right tabular-nums ${overspending ? "text-destructive font-semibold" : ""}`}>
                            ${u.cost_usd.toFixed(4)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground">
              A student in red costs more in AI than their subscription brings in.
              One or two is ordinary; a pattern means the monthly limits need tightening.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function BudgetField({
  value,
  disabled,
  onSave,
}: {
  value: number | null;
  disabled: boolean;
  onSave: (v: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));

  useEffect(() => {
    setText(value == null ? "" : String(value));
  }, [value]);

  return (
    <div>
      <Label htmlFor="budget" className="text-xs text-muted-foreground">
        Monthly ceiling (USD) — blank for none
      </Label>
      <div className="flex gap-2 mt-1">
        <Input
          id="budget"
          type="number"
          min={0}
          step="0.5"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="rounded-xl"
        />
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => onSave(text.trim() === "" ? null : Number(text))}
          className="rounded-xl"
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function LimitField({
  value,
  disabled,
  onSave,
}: {
  value: number;
  disabled: boolean;
  onSave: (v: number) => void;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < -1 || n === value) {
      setText(String(value));
      return;
    }
    onSave(n);
  };

  return (
    <Input
      type="number"
      min={-1}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="w-20 h-9 rounded-lg tabular-nums"
    />
  );
}

function ProviderCard({
  provider,
  busy,
  onSave,
  onDelete,
}: {
  provider: AiProvider;
  busy: boolean;
  onSave: (patch: {
    label?: string;
    baseUrl?: string;
    apiKey?: string;
    isActive?: boolean;
    inputPricePerMtok?: number | null;
    outputPricePerMtok?: number | null;
    pricePerMinute?: number | null;
  }) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(provider.label);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [inPrice, setInPrice] = useState(
    provider.inputPricePerMtok == null ? "" : String(provider.inputPricePerMtok),
  );
  const [outPrice, setOutPrice] = useState(
    provider.outputPricePerMtok == null ? "" : String(provider.outputPricePerMtok),
  );
  const [minutePrice, setMinutePrice] = useState(
    provider.pricePerMinute == null ? "" : String(provider.pricePerMinute),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const asPrice = (t: string) => (t.trim() === "" ? null : Number(t));

  /**
   * Speech is sold per minute of audio, chat per million tokens. Showing both
   * sets to both roles is how AssemblyAI ended up with two fields that could
   * never apply to it and no field that could.
   */
  const isSpeech = provider.role === "speech";

  const dirty =
    label !== provider.label ||
    baseUrl !== provider.baseUrl ||
    apiKey.trim().length > 0 ||
    (isSpeech
      ? asPrice(minutePrice) !== provider.pricePerMinute
      : asPrice(inPrice) !== provider.inputPricePerMtok ||
        asPrice(outPrice) !== provider.outputPricePerMtok);

  return (
    <Card className={`border-2 ${provider.isActive ? "border-emerald-300" : ""}`}>
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge variant={provider.role === "chat" ? "default" : "secondary"}>
              {provider.role}
            </Badge>
            {provider.isActive && (
              <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
                active
              </Badge>
            )}
            {!provider.hasApiKey && <Badge variant="destructive">no key</Badge>}
            {(isSpeech
              ? provider.pricePerMinute == null
              : provider.inputPricePerMtok == null && provider.outputPricePerMtok == null) && (
              <Badge variant="outline" title="Cost is not recorded, so the monthly budget cannot act on this provider">
                no prices
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Active</Label>
            <Switch
              checked={provider.isActive}
              disabled={busy || !provider.hasApiKey}
              onCheckedChange={(v) => onSave({ isActive: v })}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">Label</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="rounded-xl mt-1"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Base URL</Label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              className="rounded-xl mt-1 font-mono text-xs"
            />
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">
            API key {provider.apiKeyHint ? `(stored: ${provider.apiKeyHint})` : "(none stored)"}
          </Label>
          <Input
            type="password"
            value={apiKey}
            placeholder={provider.hasApiKey ? "Leave blank to keep the stored key" : "Paste the key"}
            onChange={(e) => setApiKey(e.target.value)}
            className="rounded-xl mt-1 font-mono text-xs"
            autoComplete="off"
          />
        </div>

        {isSpeech ? (
          <div>
            <Label className="text-xs text-muted-foreground">
              Price, USD per minute of audio
            </Label>
            <Input
              type="number"
              min={0}
              step="0.0001"
              value={minutePrice}
              placeholder="unknown — cost not recorded"
              onChange={(e) => setMinutePrice(e.target.value)}
              className="rounded-xl mt-1"
            />
            <p className="text-xs text-muted-foreground mt-2">
              Transcription is billed per minute, not per token. Multichannel is billed
              per channel, so a stereo peer-call recording costs this rate twice over —
              the server counts the channels, so enter the single-channel rate.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs text-muted-foreground">
                Input price, USD per 1M tokens
              </Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={inPrice}
                placeholder="unknown — cost not recorded"
                onChange={(e) => setInPrice(e.target.value)}
                className="rounded-xl mt-1"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">
                Output price, USD per 1M tokens
              </Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={outPrice}
                placeholder="unknown — cost not recorded"
                onChange={(e) => setOutPrice(e.target.value)}
                className="rounded-xl mt-1"
              />
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Without a price, calls record no cost and the monthly ceiling can never trigger.
        </p>

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <Button
            disabled={busy || !dirty}
            onClick={() => {
              onSave({
                label,
                baseUrl,
                ...(isSpeech
                  ? { pricePerMinute: asPrice(minutePrice) }
                  : {
                      inputPricePerMtok: asPrice(inPrice),
                      outputPricePerMtok: asPrice(outPrice),
                    }),
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              });
              setApiKey("");
            }}
            className="rounded-xl"
          >
            Save
          </Button>

          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-destructive">Delete this provider?</span>
              <Button variant="destructive" size="sm" disabled={busy} onClick={onDelete}>
                Yes, delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function NewProviderCard({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (input: {
    label: string;
    role: "chat" | "speech";
    baseUrl: string;
    apiKey?: string;
    isActive?: boolean;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("NVIDIA NIM");
  const [role, setRole] = useState<"chat" | "speech">("chat");
  const [baseUrl, setBaseUrl] = useState("https://integrate.api.nvidia.com/v1");
  const [apiKey, setApiKey] = useState("");

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)} className="rounded-xl gap-2">
        <Plus className="h-4 w-4" />
        Add provider
      </Button>
    );
  }

  return (
    <Card className="border-2 border-dashed">
      <CardContent className="p-5 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} className="rounded-xl mt-1" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Role</Label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "chat" | "speech")}
              className="w-full h-9 mt-1 rounded-xl border bg-background px-3 text-sm"
            >
              <option value="chat">chat — text in, text out</option>
              <option value="speech">speech — audio in, transcript out</option>
            </select>
          </div>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Base URL</Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="rounded-xl mt-1 font-mono text-xs"
          />
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">API key</Label>
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="rounded-xl mt-1 font-mono text-xs"
            autoComplete="off"
          />
        </div>

        <div className="flex gap-2">
          <Button
            disabled={busy || !label.trim() || !baseUrl.trim()}
            onClick={() => {
              onCreate({
                label: label.trim(),
                role,
                baseUrl: baseUrl.trim(),
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              });
              setOpen(false);
              setApiKey("");
            }}
            className="rounded-xl"
          >
            Add
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TaskCard({
  task,
  providers,
  busy,
  onSave,
}: {
  task: AiTaskSettings;
  providers: AiProvider[];
  busy: boolean;
  onSave: (patch: Partial<AiTaskSettings>) => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelId, setModelId] = useState(task.modelId ?? "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    setModelId(task.modelId ?? "");
  }, [task.modelId]);

  const fetchModels = async () => {
    if (!task.providerId) return;
    setLoadingModels(true);
    try {
      const { models: list } = await listProviderModels(task.providerId);
      setModels(list);
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Could not list models",
        description: e instanceof AiAdminError ? e.message : "Request failed.",
      });
    } finally {
      setLoadingModels(false);
    }
  };

  const runTest = async () => {
    if (!task.providerId || !modelId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testProvider(task.providerId, modelId);
      setTestResult(`OK — ${r.latencyMs}ms, ${r.usage.totalTokens} tokens, replied "${r.reply}"`);
    } catch (e) {
      setTestResult(e instanceof AiAdminError ? `Failed — ${e.message}` : "Failed");
    } finally {
      setTesting(false);
    }
  };

  const canEnable = Boolean(task.providerId && task.modelId);

  return (
    <Card className="border-2">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="font-bold font-mono text-sm">{task.task}</h3>
            <p className="text-xs text-muted-foreground">{TASK_HELP[task.task]}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Label className="text-xs text-muted-foreground">Enabled</Label>
            <Switch
              checked={task.enabled}
              disabled={busy || (!task.enabled && !canEnable)}
              onCheckedChange={(v) => onSave({ enabled: v })}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">Provider</Label>
            <select
              value={task.providerId ?? ""}
              disabled={busy}
              onChange={(e) => {
                setModels(null);
                onSave({ providerId: e.target.value ? Number(e.target.value) : null });
              }}
              className="w-full h-9 mt-1 rounded-xl border bg-background px-3 text-sm"
            >
              <option value="">— none —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.isActive ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground">Model</Label>
            <div className="flex gap-2 mt-1">
              {models ? (
                <select
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="flex-1 h-9 rounded-xl border bg-background px-3 text-sm font-mono"
                >
                  <option value="">— choose —</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="model id"
                  className="rounded-xl font-mono text-xs"
                />
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={!task.providerId || loadingModels}
                onClick={fetchModels}
                title="Fetch the model list from this provider"
                className="rounded-xl shrink-0"
              >
                {loadingModels ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">
              Temperature ({task.temperature})
            </Label>
            <Input
              type="number"
              min={0}
              max={2}
              step="0.1"
              defaultValue={task.temperature}
              disabled={busy}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v !== task.temperature && v >= 0 && v <= 2) onSave({ temperature: v });
              }}
              className="rounded-xl mt-1"
            />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Max tokens</Label>
            <Input
              type="number"
              min={1}
              max={32768}
              defaultValue={task.maxTokens}
              disabled={busy}
              onBlur={(e) => {
                const v = parseInt(e.target.value, 10);
                if (v !== task.maxTokens && v > 0 && v <= 32768) onSave({ maxTokens: v });
              }}
              className="rounded-xl mt-1"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={busy || modelId === (task.modelId ?? "")}
            onClick={() => onSave({ modelId: modelId || null })}
            className="rounded-xl"
          >
            Save model
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={testing || !task.providerId || !modelId}
            onClick={runTest}
            className="rounded-xl gap-2"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Test
          </Button>
          {testResult && (
            <span
              className={`text-xs flex items-center gap-1 ${
                testResult.startsWith("OK") ? "text-emerald-600" : "text-destructive"
              }`}
            >
              {testResult.startsWith("OK") ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5" />
              )}
              {testResult}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
