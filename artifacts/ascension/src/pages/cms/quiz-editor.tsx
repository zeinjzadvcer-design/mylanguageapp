/**
 * Quiz and level-evaluation editor.
 *
 * Two halves: the settings that decide what the quiz *is* (practice or the gate
 * on a level, what passes, how often it may be retried), and the timeline of
 * questions with their answer keys.
 *
 * The answer keys live here and nowhere a student can reach — the server strips
 * `config` from every student-facing payload. This screen is the only place
 * they are ever visible.
 */

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  cmsApi,
  type CMSQuiz,
  type CMSQuizBlock,
  type QuizBlockConfig,
} from "@/lib/cms-api";
import { CMSLayout } from "@/components/cms-layout";
import { useCan } from "@/lib/permissions";
import type { Permission } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { MediaPicker } from "@/components/media-picker";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  AlertCircle,
  Check,
  Mic,
} from "lucide-react";

/** Block types, grouped by what marks them — the thing an author needs to know. */
const BLOCK_GROUPS: Array<{ label: string; hint: string; types: string[] }> = [
  {
    label: "Marked automatically",
    hint: "No AI, no teacher. Instant and free.",
    types: ["mcq", "multi_select", "spelling"],
  },
  {
    label: "Marked by AI",
    hint: "Needs the matching task enabled in AI settings, or it waits for a teacher.",
    types: ["writing", "speaking_prompt", "image_describe", "listening"],
  },
  {
    label: "Not marked",
    hint: "Presentational only. Cannot lower a score.",
    types: ["text", "explanation", "audio", "video"],
  },
];

const AUTO_GRADED = new Set(["mcq", "multi_select", "spelling"]);
const CHOICE_TYPES = new Set(["mcq", "multi_select"]);
const WRITTEN_TYPES = new Set(["writing", "image_describe"]);
/** Block types that carry a media file of their own. */
const MEDIA_TYPES = new Set(["image_describe", "listening", "audio", "video"]);

export default function QuizEditor({ params }: { params: { id: string } }) {
  const quizId = parseInt(params.id, 10);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const { data: quiz, isLoading } = useQuery({
    queryKey: ["cms-quiz", quizId],
    queryFn: () => cmsApi.quizzes.get(quizId),
    enabled: !isNaN(quizId),
  });

  const can = useCan();
  const { data: levelsData } = useQuery({
    queryKey: ["cms-levels"],
    queryFn: () => cmsApi.levels.list(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cms-quiz", quizId] });
    qc.invalidateQueries({ queryKey: ["cms-quizzes"] });
  };

  const fail = (e: Error) =>
    toast({ title: "Error", description: e.message, variant: "destructive" });

  const updateMut = useMutation({
    mutationFn: (patch: Partial<CMSQuiz>) => cmsApi.quizzes.update(quizId, patch),
    onSuccess: invalidate,
    onError: fail,
  });

  const addBlockMut = useMutation({
    mutationFn: (type: string) => cmsApi.quizzes.addBlock(quizId, { type }),
    onSuccess: invalidate,
    onError: fail,
  });

  const updateBlockMut = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<CMSQuizBlock> }) =>
      cmsApi.quizzes.updateBlock(quizId, id, patch),
    onSuccess: invalidate,
    onError: fail,
  });

  const deleteBlockMut = useMutation({
    mutationFn: (id: number) => cmsApi.quizzes.deleteBlock(quizId, id),
    onSuccess: invalidate,
    onError: fail,
  });

  const reorderMut = useMutation({
    mutationFn: (blockIds: number[]) => cmsApi.quizzes.reorderBlocks(quizId, blockIds),
    onSuccess: invalidate,
    onError: fail,
  });

  const transitionMut = useMutation({
    mutationFn: (action: string) => cmsApi.quizzes.transition(quizId, action),
    onSuccess: (r) => {
      invalidate();
      toast({ title: `Quiz is now ${r.status.replace("_", " ")}` });
    },
    onError: fail,
  });

  if (isLoading || !quiz) {
    return (
      <CMSLayout>
        <div className="p-6 text-center text-gray-400 text-sm">Loading…</div>
      </CMSLayout>
    );
  }

  const blocks = [...(quiz.blocks ?? [])].sort((a, b) => a.order - b.order);
  const locked = quiz.status === "published" || quiz.status === "archived";
  const readOnly = locked || !can("content.edit");
  const isEvaluation = quiz.kind === "level_evaluation";

  const move = (index: number, delta: number) => {
    const next = [...blocks];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorderMut.mutate(next.map((b) => b.id));
  };

  return (
    <CMSLayout>
      <div className="space-y-4">
        <button
          onClick={() => setLocation("/cms/quizzes")}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
        >
          <ArrowLeft className="h-4 w-4" /> All quizzes
        </button>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{quiz.title}</h1>
            <p className="text-sm text-gray-500" dir="rtl">
              {quiz.titleAr}
            </p>
          </div>
          <WorkflowButtons
            status={quiz.status}
            blockCount={blocks.length}
            pending={transitionMut.isPending}
            onAction={(a) => transitionMut.mutate(a)}
          />
        </div>

        {locked && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-px" />
            <span>
              Editing is disabled while this quiz is {quiz.status}. Unpublish it first:
              publishing again bumps the content version, so students with an attempt in
              flight stay on the version they started rather than having it change under
              them.
            </span>
          </div>
        )}

        <Settings
          quiz={quiz}
          levels={levelsData ?? []}
          disabled={readOnly || updateMut.isPending}
          onSave={(patch) => updateMut.mutate(patch)}
        />

        {/* Timeline */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">
              Questions ({blocks.length})
            </h2>
          </div>

          {isEvaluation && blocks.length > 0 && (
            <GatingWarning blocks={blocks} />
          )}

          {blocks.map((block, i) => (
            <BlockCard
              key={block.id}
              block={block}
              index={i}
              total={blocks.length}
              disabled={readOnly}
              onMove={(d) => move(i, d)}
              onSave={(patch) => updateBlockMut.mutate({ id: block.id, patch })}
              onDelete={() => deleteBlockMut.mutate(block.id)}
            />
          ))}

          {!readOnly && <AddBlock onAdd={(t) => addBlockMut.mutate(t)} />}
        </div>
      </div>
    </CMSLayout>
  );
}

// ─── Gating warning ───────────────────────────────────────────────────────────

/**
 * An evaluation is what decides whether a student moves up, and promotion is
 * withheld until every block has a verdict. A block that needs AI will sit
 * unmarked whenever AI is unavailable — which means the student is stuck, not
 * failed. Worth saying before it is published rather than after.
 */
function GatingWarning({ blocks }: { blocks: CMSQuizBlock[] }) {
  const needsAssessment = blocks.filter(
    (b) => !AUTO_GRADED.has(b.type) && !["text", "explanation", "audio", "video"].includes(b.type),
  );

  if (needsAssessment.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 flex gap-2">
      <AlertCircle className="h-4 w-4 shrink-0 mt-px" />
      <span>
        {needsAssessment.length} question{needsAssessment.length > 1 ? "s" : ""} need
        {needsAssessment.length > 1 ? "" : "s"} AI or a teacher to mark. Promotion is held
        until every question has a verdict, so if AI is unavailable a student who passes
        will wait rather than advance. For a gate that must always resolve, use only
        multiple-choice and spelling questions.
      </span>
    </div>
  );
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

/** Who may press each workflow button; the API enforces the same. */
const ACTION_PERMISSION: Record<string, Permission> = {
  submit: "content.edit",
  approve: "content.review",
  reject: "content.review",
  publish: "content.publish",
  unpublish: "content.publish",
  restore: "content.publish",
};

function WorkflowButtons({
  status,
  blockCount,
  pending,
  onAction,
}: {
  status: string;
  blockCount: number;
  pending: boolean;
  onAction: (action: string) => void;
}) {
  const can = useCan();
  const actions: Array<{ action: string; label: string; variant?: "outline" }> = [];

  if (status === "draft") {
    actions.push({ action: "submit", label: "Submit for review" });
    actions.push({ action: "publish", label: "Publish", variant: "outline" });
  }
  if (status === "in_review") {
    actions.push({ action: "approve", label: "Approve" });
    actions.push({ action: "reject", label: "Send back", variant: "outline" });
  }
  if (status === "approved") actions.push({ action: "publish", label: "Publish" });
  if (status === "published") {
    actions.push({ action: "unpublish", label: "Unpublish", variant: "outline" });
  }
  if (status === "archived") actions.push({ action: "restore", label: "Restore" });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600">
        {status.replace("_", " ")}
      </span>
      {actions.filter((a) => can(ACTION_PERMISSION[a.action])).map((a) => (
        <Button
          key={a.action}
          size="sm"
          variant={a.variant}
          disabled={pending || (blockCount === 0 && a.action !== "restore")}
          title={blockCount === 0 ? "Add at least one question first" : undefined}
          onClick={() => onAction(a.action)}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function Settings({
  quiz,
  levels,
  disabled,
  onSave,
}: {
  quiz: CMSQuiz;
  levels: Array<{ id: number; code: string; name: string }>;
  disabled: boolean;
  onSave: (patch: Partial<CMSQuiz>) => void;
}) {
  const [form, setForm] = useState<Partial<CMSQuiz>>({});

  useEffect(() => setForm({}), [quiz.id]);

  const value = <K extends keyof CMSQuiz>(key: K): CMSQuiz[K] =>
    (form[key] !== undefined ? form[key] : quiz[key]) as CMSQuiz[K];
  const set = <K extends keyof CMSQuiz>(key: K, v: CMSQuiz[K]) =>
    setForm((f) => ({ ...f, [key]: v }));

  const dirty = Object.keys(form).length > 0;
  const isEvaluation = value("kind") === "level_evaluation";
  const missingLevel = isEvaluation && !value("levelId");

  const num = (v: string): number | null => (v.trim() === "" ? null : Number(v));

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-4">
      <h2 className="text-sm font-semibold text-gray-700">Settings</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Kind</Label>
          <select
            value={value("kind")}
            disabled={disabled}
            onChange={(e) => set("kind", e.target.value as CMSQuiz["kind"])}
            className="w-full h-9 rounded-md border border-gray-200 bg-white px-3 text-sm"
          >
            <option value="practice">Practice — no effect on the student's level</option>
            <option value="level_evaluation">
              Level evaluation — passing promotes the student
            </option>
          </select>
        </div>

        <div className="space-y-1">
          <Label className="text-xs text-gray-500">
            Level {isEvaluation && <span className="text-red-500">*</span>}
          </Label>
          <select
            value={value("levelId") ?? ""}
            disabled={disabled}
            onChange={(e) => set("levelId", e.target.value ? Number(e.target.value) : null)}
            className={`w-full h-9 rounded-md border bg-white px-3 text-sm ${
              missingLevel ? "border-red-300" : "border-gray-200"
            }`}
          >
            <option value="">— none —</option>
            {levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code} — {l.name}
              </option>
            ))}
          </select>
          {missingLevel && (
            <p className="text-xs text-red-500">An evaluation must gate a level.</p>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Passing score %</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={value("passingScore") ?? 75}
            disabled={disabled}
            onChange={(e) => set("passingScore", Number(e.target.value))}
            className="text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Time limit (min)</Label>
          <Input
            type="number"
            min={1}
            placeholder="none"
            value={value("timeLimitSec") ? Math.round((value("timeLimitSec") as number) / 60) : ""}
            disabled={disabled}
            onChange={(e) => {
              const m = num(e.target.value);
              set("timeLimitSec", m === null ? null : m * 60);
            }}
            className="text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Max attempts</Label>
          <Input
            type="number"
            min={1}
            placeholder="unlimited"
            value={value("maxAttempts") ?? ""}
            disabled={disabled}
            onChange={(e) => set("maxAttempts", num(e.target.value))}
            className="text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Retry cooldown (h)</Label>
          <Input
            type="number"
            min={0}
            placeholder="none"
            value={value("cooldownHours") ?? ""}
            disabled={disabled || !isEvaluation}
            onChange={(e) => set("cooldownHours", num(e.target.value))}
            className="text-sm"
          />
        </div>
      </div>

      {isEvaluation && (
        <p className="text-xs text-gray-500">
          A cooldown sends a student who fails back to the lessons before they may retry.
          They are shown their weakest lessons in the meantime.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Instructions (Arabic)</Label>
          <Textarea
            rows={2}
            value={(value("instructionsAr") as string) ?? ""}
            disabled={disabled}
            onChange={(e) => set("instructionsAr", e.target.value)}
            className="text-sm"
            dir="rtl"
          />
        </div>
        <div className="space-y-1 flex flex-col justify-end gap-2">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={Boolean(value("shuffleBlocks"))}
              disabled={disabled}
              onCheckedChange={(v) => set("shuffleBlocks", v)}
            />
            <span className="text-gray-600">Shuffle questions</span>
          </label>
          <p className="text-xs text-gray-400">
            The order is fixed per student, so a reload does not reshuffle mid-attempt.
          </p>
        </div>
      </div>

      <Button
        size="sm"
        disabled={disabled || !dirty || missingLevel}
        onClick={() => {
          onSave(form);
          setForm({});
        }}
      >
        Save settings
      </Button>
    </div>
  );
}

// ─── Blocks ───────────────────────────────────────────────────────────────────

function AddBlock({ onAdd }: { onAdd: (type: string) => void }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-white p-4 space-y-3">
      <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
        <Plus className="h-4 w-4" /> Add a question
      </h3>
      {BLOCK_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <div>
            <span className="text-xs font-medium text-gray-600">{group.label}</span>
            <span className="text-xs text-gray-400"> — {group.hint}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.types.map((t) => (
              <button
                key={t}
                onClick={() => onAdd(t)}
                className="text-xs font-mono px-2.5 py-1 rounded-md border border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50"
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function BlockCard({
  block,
  index,
  total,
  disabled,
  onMove,
  onSave,
  onDelete,
}: {
  block: CMSQuizBlock;
  index: number;
  total: number;
  disabled: boolean;
  onMove: (delta: number) => void;
  onSave: (patch: Partial<CMSQuizBlock>) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<Partial<CMSQuizBlock>>({});
  const [config, setConfig] = useState<QuizBlockConfig>(block.config ?? {});
  const [configDirty, setConfigDirty] = useState(false);

  useEffect(() => {
    setDraft({});
    setConfig(block.config ?? {});
    setConfigDirty(false);
  }, [block.id, block.config]);

  const field = <K extends keyof CMSQuizBlock>(key: K): CMSQuizBlock[K] =>
    (draft[key] !== undefined ? draft[key] : block[key]) as CMSQuizBlock[K];
  const set = <K extends keyof CMSQuizBlock>(key: K, v: CMSQuizBlock[K]) =>
    setDraft((d) => ({ ...d, [key]: v }));

  const dirty = Object.keys(draft).length > 0 || configDirty;
  const options = config.options ?? [];
  const correct = new Set(config.correctOptionIds ?? []);
  const isSpeaking = block.type === "speaking_prompt";
  const noAnswerKey =
    CHOICE_TYPES.has(block.type) && (config.correctOptionIds ?? []).length === 0;

  const patchConfig = (next: Partial<QuizBlockConfig>) => {
    setConfig((c) => ({ ...c, ...next }));
    setConfigDirty(true);
  };

  const toggleCorrect = (id: string) => {
    const current = new Set(config.correctOptionIds ?? []);
    if (block.type === "mcq") {
      // Exactly one answer: picking a new one replaces the old.
      patchConfig({ correctOptionIds: current.has(id) ? [] : [id] });
      return;
    }
    if (current.has(id)) current.delete(id);
    else current.add(id);
    patchConfig({ correctOptionIds: [...current] });
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">#{index + 1}</span>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-gray-100 text-gray-600">
            {block.type}
          </span>
          {AUTO_GRADED.has(block.type) && (
            <span className="text-xs text-emerald-600 flex items-center gap-0.5">
              <Check className="h-3 w-3" /> auto
            </span>
          )}
          {noAnswerKey && (
            <span className="text-xs text-red-500 flex items-center gap-0.5">
              <AlertCircle className="h-3 w-3" /> no answer key
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onMove(-1)}
            disabled={disabled || index === 0}
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onMove(1)}
            disabled={disabled || index === total - 1}
            className="p-1 rounded hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              if (confirm("Delete this question?")) onDelete();
            }}
            disabled={disabled}
            className="p-1 rounded hover:bg-red-50 text-red-400 disabled:opacity-30"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Question / prompt (English)</Label>
          <Input
            value={(field("prompt") as string) ?? ""}
            disabled={disabled}
            onChange={(e) => set("prompt", e.target.value)}
            className="text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Question / prompt (Arabic)</Label>
          <Input
            value={(field("promptAr") as string) ?? ""}
            disabled={disabled}
            onChange={(e) => set("promptAr", e.target.value)}
            className="text-sm"
            dir="rtl"
          />
        </div>
      </div>

      {/* The image to describe, or the clip to listen to — without this these
          block types have no way to carry the media they are named for. */}
      {MEDIA_TYPES.has(block.type) && (
        <MediaPicker
          label={block.type === "image_describe" ? "Image to describe" : "Audio / video"}
          accept={block.type === "image_describe" ? "image" : "audio"}
          allowRecording={block.type !== "image_describe"}
          value={config.mediaKey ?? null}
          disabled={disabled}
          onChange={(key, mediaId) => {
            patchConfig({ mediaKey: key });
            set("referenceMediaId", mediaId);
          }}
        />
      )}

      {/* Choice options and the answer key */}
      {CHOICE_TYPES.has(block.type) && (
        <div className="space-y-2">
          <Label className="text-xs text-gray-500">
            Options — tick the correct {block.type === "mcq" ? "answer" : "answers"}
          </Label>
          {options.map((opt, i) => (
            <div key={opt.id} className="flex items-center gap-2">
              <button
                onClick={() => toggleCorrect(opt.id)}
                disabled={disabled}
                className={`h-6 w-6 rounded border-2 shrink-0 flex items-center justify-center ${
                  correct.has(opt.id)
                    ? "bg-emerald-500 border-emerald-500 text-white"
                    : "border-gray-300"
                }`}
                title="Mark as correct"
              >
                {correct.has(opt.id) && <Check className="h-3.5 w-3.5" />}
              </button>
              <span className="text-xs font-mono text-gray-400 w-4">{opt.id}</span>
              <Input
                value={opt.text}
                disabled={disabled}
                onChange={(e) => {
                  const next = [...options];
                  next[i] = { ...opt, text: e.target.value };
                  patchConfig({ options: next });
                }}
                className="text-sm"
              />
              <button
                onClick={() => {
                  patchConfig({
                    options: options.filter((o) => o.id !== opt.id),
                    correctOptionIds: (config.correctOptionIds ?? []).filter(
                      (c) => c !== opt.id,
                    ),
                  });
                }}
                disabled={disabled}
                className="p-1 rounded hover:bg-red-50 text-red-400"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || options.length >= 8}
            onClick={() => {
              const id = String.fromCharCode(97 + options.length); // a, b, c…
              patchConfig({ options: [...options, { id, text: "" }] });
            }}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Add option
          </Button>
        </div>
      )}

      {/* Spelling answer */}
      {block.type === "spelling" && (
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Expected spelling</Label>
          <Input
            value={config.keyPoints?.[0] ?? ""}
            disabled={disabled}
            onChange={(e) => patchConfig({ keyPoints: [e.target.value] })}
            className="text-sm font-mono"
          />
          <p className="text-xs text-gray-400">
            Compared ignoring case and surrounding space.
          </p>
        </div>
      )}

      {/* Written answers — the AI grader's rubric */}
      {WRITTEN_TYPES.has(block.type) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">
              Key points a good answer must cover
            </Label>
            <Textarea
              rows={3}
              value={(config.keyPoints ?? []).join("\n")}
              disabled={disabled}
              onChange={(e) =>
                patchConfig({
                  keyPoints: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean),
                })
              }
              placeholder={"One per line\na time of day\nat least one activity"}
              className="text-sm"
            />
            <p className="text-xs text-gray-400">
              Given to the AI as the rubric. Without these it judges relevance to the
              question alone.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Minimum words</Label>
            <Input
              type="number"
              min={0}
              value={config.minWords ?? ""}
              disabled={disabled}
              onChange={(e) =>
                patchConfig({
                  minWords: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
              className="text-sm"
            />
          </div>
        </div>
      )}

      {/* Speaking — the passage decides whether pronunciation can be scored */}
      {isSpeaking && (
        <div className="space-y-3 rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={Boolean(field("expectsReferenceReading"))}
              disabled={disabled}
              onCheckedChange={(v) => set("expectsReferenceReading", v)}
            />
            <span className="text-gray-700 flex items-center gap-1.5">
              <Mic className="h-3.5 w-3.5" /> Read a set passage aloud
            </span>
          </label>

          {field("expectsReferenceReading") ? (
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">
                The passage the student reads <span className="text-red-500">*</span>
              </Label>
              <Textarea
                rows={4}
                value={(field("content") as string) ?? ""}
                disabled={disabled}
                onChange={(e) => set("content", e.target.value)}
                className="text-sm"
                dir="ltr"
              />
              <p className="text-xs text-gray-500">
                Pronunciation is scored by comparing what was heard against this text, word
                by word. Without a passage only fluency can be measured.
              </p>
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              Open speaking. Only fluency — pace, pausing, hesitation — can be scored;
              there is nothing to check pronunciation against.
            </p>
          )}
        </div>
      )}

      {/* Explanation shown after marking */}
      {(CHOICE_TYPES.has(block.type) || block.type === "spelling") && (
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">
            Explanation shown after answering (Arabic)
          </Label>
          <Input
            value={config.explanationAr ?? ""}
            disabled={disabled}
            onChange={(e) => patchConfig({ explanationAr: e.target.value })}
            className="text-sm"
            dir="rtl"
          />
        </div>
      )}

      {/* Presentational content */}
      {["text", "explanation"].includes(block.type) && (
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Content (Arabic)</Label>
          <Textarea
            rows={3}
            value={(field("contentAr") as string) ?? ""}
            disabled={disabled}
            onChange={(e) => set("contentAr", e.target.value)}
            className="text-sm"
            dir="rtl"
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={disabled || !dirty}
          onClick={() => {
            onSave({ ...draft, ...(configDirty ? { config } : {}) });
            setDraft({});
            setConfigDirty(false);
          }}
        >
          Save question
        </Button>
        {config.points !== undefined && config.points !== 1 && (
          <span className="text-xs text-gray-400">worth {config.points} points</span>
        )}
      </div>
    </div>
  );
}
