/**
 * Placement test authoring.
 *
 * The placement test decides every student's starting level, and it was the one
 * piece of curriculum with no screen at all — editable only with SQL. Spec
 * section 1 puts "Evaluation tests" under the curriculum team's ownership, so
 * this is that ownership made real.
 *
 * Skills are tagged per question because the per-skill breakdown a student sees
 * after placement is built from that tag alone: an untagged question can only
 * contribute to a total.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cmsApi, type CMSPlacementQuestion, type CMSPlacementOption } from "@/lib/cms-api";
import { CMSLayout } from "@/components/cms-layout";
import { useCan } from "@/lib/permissions";
import { MediaPicker } from "@/components/media-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronDown, ChevronRight } from "lucide-react";

const SKILLS = ["reading", "listening", "vocabulary", "grammar", "comprehension", "writing"];
const TYPES = ["mcq", "fill_blank", "written"];
const DIFFICULTIES = ["A1", "A2", "B1", "B2", "C1", "C2"];

const BLANK_OPTIONS: CMSPlacementOption[] = [
  { optionId: "a", text: "", isCorrect: true },
  { optionId: "b", text: "" },
  { optionId: "c", text: "" },
  { optionId: "d", text: "" },
];

function QuestionEditor({
  question,
  index,
  total,
  onSave,
  onDelete,
  onMove,
  saving,
  readOnly,
}: {
  question: CMSPlacementQuestion;
  index: number;
  total: number;
  onSave: (patch: Partial<CMSPlacementQuestion>) => void;
  onDelete: () => void;
  onMove: (delta: number) => void;
  saving: boolean;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CMSPlacementQuestion>(question);

  const set = (patch: Partial<CMSPlacementQuestion>) =>
    setDraft((d) => ({ ...d, ...patch }));

  const setOption = (i: number, patch: Partial<CMSPlacementOption>) =>
    setDraft((d) => ({
      ...d,
      options: d.options.map((o, j) => (j === i ? { ...o, ...patch } : o)),
    }));

  // Exactly one correct answer: picking a new one clears the rest.
  const markCorrect = (i: number) =>
    setDraft((d) => ({
      ...d,
      options: d.options.map((o, j) => ({ ...o, isCorrect: j === i })),
    }));

  const isWritten = draft.type === "written";

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-center gap-2 p-3">
        <button onClick={() => setOpen((o) => !o)} className="text-gray-400 hover:text-gray-700">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="text-xs text-gray-400 w-6">#{index + 1}</span>
        <span className="flex-1 truncate text-sm">
          {draft.questionText || <span className="text-gray-400">Untitled question</span>}
        </span>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{draft.skill}</span>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{draft.difficulty}</span>
        {!draft.isActive && (
          <span className="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-700">inactive</span>
        )}
        {!readOnly && <>
        <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" disabled={index === total - 1} onClick={() => onMove(1)}>
          <ArrowDown className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="text-red-500" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
        </>}
      </div>

      {open && (
        <fieldset disabled={readOnly} className="min-w-0 space-y-3 border-t border-gray-100 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Question (English)</Label>
              <Input value={draft.questionText} onChange={(e) => set({ questionText: e.target.value })} className="text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Question (Arabic)</Label>
              <Input dir="rtl" value={draft.questionTextAr} onChange={(e) => set({ questionTextAr: e.target.value })} className="text-sm" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Type</Label>
              <Select value={draft.type} onValueChange={(v) => set({ type: v })}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Skill tested</Label>
              <Select value={draft.skill} onValueChange={(v) => set({ skill: v })}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SKILLS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Difficulty</Label>
              <Select value={draft.difficulty} onValueChange={(v) => set({ difficulty: v })}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DIFFICULTIES.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Passage (reading and listening questions)</Label>
            <Textarea rows={3} value={draft.passage ?? ""} onChange={(e) => set({ passage: e.target.value })} className="text-sm" />
          </div>

          {draft.skill === "listening" && (
            <MediaPicker
              label="Audio clip"
              accept="audio"
              value={draft.mediaId ? String(draft.mediaId) : null}
              onChange={(_key, mediaId) => set({ mediaId })}
            />
          )}

          {isWritten ? (
            <p className="rounded bg-gray-50 p-2 text-xs text-gray-500">
              A written question has no options. The answer is stored and assessed
              separately; it does not contribute to the objective score.
            </p>
          ) : (
            <div className="space-y-2">
              <Label className="text-xs font-medium text-gray-700">
                Options — click the circle to mark the correct answer
              </Label>
              {draft.options.map((opt, i) => (
                <div
                  key={opt.optionId}
                  className={`flex items-center gap-2 rounded-md border p-2 ${
                    opt.isCorrect ? "border-green-500 bg-green-50" : "border-transparent hover:border-gray-200"
                  }`}
                >
                  <input
                    type="radio"
                    name={`correct-${draft.id}`}
                    checked={!!opt.isCorrect}
                    onChange={() => markCorrect(i)}
                    title="Mark as the correct answer"
                    className="h-5 w-5 shrink-0 cursor-pointer accent-green-600"
                  />
                  <span className="w-4 font-mono text-xs text-gray-500">{opt.optionId})</span>
                  <Input value={opt.text} onChange={(e) => setOption(i, { text: e.target.value })} placeholder={`Option ${opt.optionId}`} className="flex-1 text-sm" />
                  <Input dir="rtl" value={opt.textAr ?? ""} onChange={(e) => setOption(i, { textAr: e.target.value })} placeholder="Arabic" className="flex-1 text-sm" />
                </div>
              ))}
            </div>
          )}

          <label className="flex items-center gap-2">
            <Checkbox checked={draft.isActive} onCheckedChange={(v) => set({ isActive: !!v })} />
            <span className="text-xs text-gray-600">Active — included in the test students take</span>
          </label>

          {!readOnly && (
            <Button size="sm" disabled={saving} onClick={() => onSave(draft)}>
              {saving ? "Saving…" : "Save question"}
            </Button>
          )}
        </fieldset>
      )}
    </div>
  );
}

export default function PlacementPage() {
  const { toast } = useToast();
  const canEdit = useCan()("content.edit");
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["cms-placement"],
    queryFn: () => cmsApi.placement.list(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["cms-placement"] });
  const fail = (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" });

  const createMut = useMutation({
    mutationFn: () =>
      cmsApi.placement.create({
        questionText: "",
        questionTextAr: "",
        type: "mcq",
        skill: "grammar",
        difficulty: "A1",
        isActive: true,
        options: BLANK_OPTIONS,
      }),
    onSuccess: () => { invalidate(); toast({ title: "Question added" }); },
    onError: fail,
  });

  const updateMut = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<CMSPlacementQuestion> }) =>
      cmsApi.placement.update(id, patch),
    onSuccess: () => { invalidate(); toast({ title: "Saved" }); },
    onError: fail,
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => cmsApi.placement.delete(id),
    onSuccess: () => { invalidate(); toast({ title: "Deleted" }); },
    onError: fail,
  });

  const reorderMut = useMutation({
    mutationFn: (ids: number[]) => cmsApi.placement.reorder(ids),
    onSuccess: invalidate,
    onError: fail,
  });

  const questions = data?.questions ?? [];

  const move = (index: number, delta: number) => {
    const next = [...questions];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorderMut.mutate(next.map((q) => q.id));
  };

  // What the student actually sits, and how the per-skill breakdown will split.
  const active = questions.filter((q) => q.isActive);
  const bySkill = SKILLS.map((s) => ({ skill: s, count: active.filter((q) => q.skill === s).length }));

  return (
    <CMSLayout>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Placement Test</h1>
            <p className="mt-0.5 text-sm text-gray-500">
              Every new student takes this before any lesson unlocks. {active.length} active
              of {questions.length}.
            </p>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add question
            </Button>
          )}
        </div>

        <div className="flex flex-wrap gap-2 rounded-lg border border-gray-200 bg-white p-3">
          {bySkill.map(({ skill, count }) => (
            <span
              key={skill}
              className={`rounded-full px-3 py-1 text-xs ${
                count === 0 ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600"
              }`}
            >
              {skill}: {count}
            </span>
          ))}
          <span className="self-center text-xs text-gray-400">
            A skill with no active questions cannot be scored or reported on.
          </span>
        </div>

        {isLoading ? (
          <div className="p-6 text-center text-sm text-gray-400">Loading…</div>
        ) : questions.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-gray-400">
            No questions yet. Without any, placement cannot assign a level and every
            lesson stays locked.
          </div>
        ) : (
          <div className="space-y-2">
            {questions.map((q, i) => (
              <QuestionEditor
                key={q.id}
                question={q}
                index={i}
                total={questions.length}
                saving={updateMut.isPending}
                onSave={(patch) => updateMut.mutate({ id: q.id, patch })}
                onDelete={() => { if (confirm("Delete this question?")) deleteMut.mutate(q.id); }}
                onMove={(d) => move(i, d)}
                readOnly={!canEdit}
              />
            ))}
          </div>
        )}
      </div>
    </CMSLayout>
  );
}
