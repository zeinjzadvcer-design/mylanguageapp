import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { cmsApi, type CMSLesson, type CMSBlock, type CMSExercise, type CMSOption } from "@/lib/cms-api";
import { CMSLayout, StatusBadge } from "@/components/cms-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { MediaPicker } from "@/components/media-picker";
import { useToast } from "@/hooks/use-toast";
import { useGetMe } from "@workspace/api-client-react";
import {
  ArrowUp, ArrowDown, Trash2, Plus, Eye, Send,
  CheckCircle, XCircle, Globe, Archive, RotateCcw, ChevronDown, ChevronRight,
} from "lucide-react";

const BLOCK_TYPES = [
  { value: "text", label: "Reading / Text" },
  { value: "vocabulary_list", label: "Vocabulary List" },
  { value: "mcq", label: "Multiple Choice (MCQ)" },
  { value: "speaking_prompt", label: "Speaking Activity" },
  { value: "pronunciation_guide", label: "Pronunciation" },
  { value: "audio_placeholder", label: "Listening / Audio" },
  { value: "open_ended", label: "Open-Ended Question" },
  { value: "dialogue", label: "Dialogue / Conversation" },
  { value: "explanation", label: "Explanation" },
  { value: "spelling", label: "Spelling" },
  { value: "review", label: "Review" },
];

const LESSON_TYPES = ["general", "reading", "pronunciation", "speaking", "vocabulary", "grammar", "conversation", "assessment"];
const DIFFICULTIES = ["beginner", "elementary", "intermediate", "upper_intermediate", "advanced"];

interface Props { lessonId?: number }

export default function LessonEditor({ lessonId }: Props) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: user } = useGetMe();
  const role = user?.role as string | undefined;
  const isAdmin = role === "admin";
  const isReviewer = role === "content_reviewer" || role === "admin";
  const isContentManager = role === "admin" || role === "content_manager";
  const isNew = !lessonId;

  // Lesson metadata form state
  const [form, setForm] = useState<Partial<CMSLesson>>({
    lessonType: "general", estimatedMinutes: 35, order: 1,
    xpReward: 50, passingScore: 75, difficulty: "intermediate",
    status: "draft",
  });
  const [levels, setLevels] = useState<any[]>([]);
  const [curricula, setCurricula] = useState<any[]>([]);
  const [selectedCurriculum, setSelectedCurriculum] = useState<number | null>(null);
  const [blocks, setBlocks] = useState<CMSBlock[]>([]);
  const [expandedBlocks, setExpandedBlocks] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  // Load existing lesson
  const { data: lesson } = useQuery({
    queryKey: ["cms-lesson", lessonId],
    queryFn: () => cmsApi.lessons.get(lessonId!),
    enabled: !!lessonId,
  });

  // Load blocks
  const { data: blocksData, refetch: refetchBlocks } = useQuery({
    queryKey: ["cms-blocks", lessonId],
    queryFn: () => cmsApi.blocks.list(lessonId!),
    enabled: !!lessonId,
  });

  useEffect(() => {
    if (lesson) {
      setForm(lesson);
      if (lesson.curriculumId) setSelectedCurriculum(lesson.curriculumId);
    }
  }, [lesson]);

  useEffect(() => {
    if (blocksData) setBlocks(blocksData);
  }, [blocksData]);

  // Load curricula + levels
  useEffect(() => {
    cmsApi.curricula.list().then(setCurricula);
  }, []);

  useEffect(() => {
    if (selectedCurriculum) {
      cmsApi.levels.list(selectedCurriculum).then(setLevels);
    }
  }, [selectedCurriculum]);

  // Save lesson metadata
  const saveMeta = async () => {
    setSaving(true);
    try {
      if (isNew) {
        const result = await cmsApi.lessons.create(form);
        toast({ title: "Lesson created" });
        setLocation(`/cms/lessons/${result.id}/edit`);
      } else {
        await cmsApi.lessons.update(lessonId!, form);
        qc.invalidateQueries({ queryKey: ["cms-lesson", lessonId] });
        toast({ title: "Saved" });
      }
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  // Status transitions
  const transition = async (action: string, label: string, notes?: string) => {
    if (!lessonId) return;
    try {
      const fn = (cmsApi.lessons as any)[action];
      await fn(lessonId, notes);
      qc.invalidateQueries({ queryKey: ["cms-lesson", lessonId] });
      toast({ title: label });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  };

  // Block operations
  const addBlock = async (type: string) => {
    if (!lessonId) { toast({ description: "Save lesson metadata first" }); return; }
    const maxOrder = blocks.length > 0 ? Math.max(...blocks.map(b => b.order)) : 0;
    // Recording blocks start optional: required + unconfigured strands the student.
    const startsOptional = type === "speaking_prompt" || type === "pronunciation_guide";
    const block = await cmsApi.blocks.create(lessonId, {
      type,
      order: maxOrder + 1,
      isRequired: !startsOptional,
      isActive: true,
    });
    setBlocks(prev => [...prev, block]);
    setExpandedBlocks(prev => new Set([...prev, block.id]));
  };

  const removeBlock = async (id: number) => {
    if (!lessonId) return;
    await cmsApi.blocks.delete(lessonId, id);
    setBlocks(prev => prev.filter(b => b.id !== id));
  };

  const moveBlock = async (id: number, dir: -1 | 1) => {
    if (!lessonId) return;
    const sorted = [...blocks].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex(b => b.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= sorted.length) return;
    [sorted[idx], sorted[newIdx]] = [sorted[newIdx], sorted[idx]];
    const ids = sorted.map(b => b.id);
    await cmsApi.blocks.reorder(lessonId, ids);
    await refetchBlocks();
  };

  const updateBlock = async (id: number, update: Partial<CMSBlock>) => {
    if (!lessonId) return;
    const updated = await cmsApi.blocks.update(lessonId, id, update);
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, ...updated } : b));
  };

  const toggleBlock = (id: number) => {
    setExpandedBlocks(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const sortedBlocks = [...blocks].sort((a, b) => a.order - b.order);
  const currentStatus = form.status ?? lesson?.status ?? "draft";

  return (
    <CMSLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-gray-900">
                {isNew ? "New Lesson" : form.title || "Edit Lesson"}
              </h1>
              {!isNew && <StatusBadge status={currentStatus} />}
            </div>
            {!isNew && <p className="text-xs text-gray-500 mt-0.5">ID: {lessonId}</p>}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap">
            {!isNew && (
              <Button variant="outline" size="sm" onClick={() => setLocation(`/cms/lessons/${lessonId}/preview`)}>
                <Eye className="h-3.5 w-3.5 mr-1.5" /> Preview
              </Button>
            )}
            {isContentManager && (
              <Button size="sm" onClick={saveMeta} disabled={saving}>
                {saving ? "Saving…" : "Save Draft"}
              </Button>
            )}
            {isContentManager && !isNew && currentStatus === "draft" && (
              <Button size="sm" variant="outline" onClick={() => transition("submit", "Submitted for review")}>
                <Send className="h-3.5 w-3.5 mr-1.5" /> Submit for Review
              </Button>
            )}
            {isReviewer && !isNew && currentStatus === "in_review" && (
              <>
                <Button size="sm" className="bg-green-600 hover:bg-green-700"
                  onClick={() => transition("approve", "Lesson approved")}>
                  <CheckCircle className="h-3.5 w-3.5 mr-1.5" /> Approve
                </Button>
                <Button size="sm" variant="outline"
                  onClick={() => { const notes = window.prompt("Rejection notes (optional):") ?? ""; transition("reject", "Lesson rejected", notes); }}>
                  <XCircle className="h-3.5 w-3.5 mr-1.5" /> Reject
                </Button>
              </>
            )}
            {isAdmin && !isNew && ["draft", "approved"].includes(currentStatus) && (
              <Button size="sm" className="bg-indigo-600 hover:bg-indigo-700"
                onClick={() => transition("publish", "Published!")}>
                <Globe className="h-3.5 w-3.5 mr-1.5" /> Publish
              </Button>
            )}
            {isAdmin && !isNew && currentStatus === "published" && (
              <Button size="sm" variant="outline" onClick={() => transition("unpublish", "Unpublished")}>
                Unpublish
              </Button>
            )}
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Metadata panel */}
          <div className="md:col-span-1 space-y-4">
            <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
              <h2 className="text-sm font-semibold text-gray-700">Lesson Details</h2>

              <Field label="Title (English)" required>
                <Input value={form.title ?? ""} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
              </Field>
              <Field label="Title (Arabic)" required>
                <Input dir="rtl" value={form.titleAr ?? ""} onChange={e => setForm(f => ({ ...f, titleAr: e.target.value }))} />
              </Field>
              <Field label="Subtitle">
                <Input value={form.subtitle ?? ""} onChange={e => setForm(f => ({ ...f, subtitle: e.target.value }))} />
              </Field>
              <Field label="Description">
                <Textarea rows={2} value={form.description ?? ""} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </Field>

              <Field label="Curriculum" required>
                <Select value={selectedCurriculum?.toString() ?? ""} onValueChange={v => { setSelectedCurriculum(parseInt(v)); setForm(f => ({ ...f, levelId: undefined })); }}>
                  <SelectTrigger className="text-sm"><SelectValue placeholder="Select curriculum" /></SelectTrigger>
                  <SelectContent>
                    {curricula.map(c => <SelectItem key={c.id} value={c.id.toString()}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Level" required>
                <Select value={form.levelId?.toString() ?? ""} onValueChange={v => setForm(f => ({ ...f, levelId: parseInt(v) }))}>
                  <SelectTrigger className="text-sm"><SelectValue placeholder="Select level" /></SelectTrigger>
                  <SelectContent>
                    {levels.map(l => <SelectItem key={l.id} value={l.id.toString()}>{l.code} — {l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label="Order">
                  <Input type="number" value={form.order ?? 1} onChange={e => setForm(f => ({ ...f, order: parseInt(e.target.value) }))} />
                </Field>
                <Field label="Duration (min)">
                  <Input type="number" value={form.estimatedMinutes ?? 35} onChange={e => setForm(f => ({ ...f, estimatedMinutes: parseInt(e.target.value) }))} />
                </Field>
              </div>

              <Field label="Lesson Type">
                <Select value={form.lessonType ?? "general"} onValueChange={v => setForm(f => ({ ...f, lessonType: v }))}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LESSON_TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Difficulty">
                <Select value={form.difficulty ?? "intermediate"} onValueChange={v => setForm(f => ({ ...f, difficulty: v }))}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DIFFICULTIES.map(d => <SelectItem key={d} value={d} className="capitalize">{d.replace("_", " ")}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label="XP Reward">
                  <Input type="number" value={form.xpReward ?? 50} onChange={e => setForm(f => ({ ...f, xpReward: parseInt(e.target.value) }))} />
                </Field>
                <Field label="Pass Score %">
                  <Input type="number" value={form.passingScore ?? 75} onChange={e => setForm(f => ({ ...f, passingScore: parseInt(e.target.value) }))} />
                </Field>
              </div>

              <Field label="Teacher Notes">
                <Textarea rows={2} placeholder="Internal notes — not shown to students" value={form.teacherNotes ?? ""} onChange={e => setForm(f => ({ ...f, teacherNotes: e.target.value }))} />
              </Field>

              <Field label="Learning Objectives (one per line)">
                <Textarea rows={3} value={(form.objectives ?? []).join("\n")} onChange={e => setForm(f => ({ ...f, objectives: e.target.value.split("\n").filter(Boolean) }))} />
              </Field>
            </div>
          </div>

          {/* Content blocks panel */}
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Content Blocks ({sortedBlocks.length})</h2>
              {isContentManager && !isNew && (
                <BlockTypeMenu onSelect={addBlock} />
              )}
            </div>

            {!lessonId && (
              <div className="rounded-lg border-2 border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">
                Save lesson metadata first to add content blocks
              </div>
            )}

            {sortedBlocks.map((block, idx) => (
              <BlockCard
                key={block.id}
                block={block}
                index={idx}
                total={sortedBlocks.length}
                expanded={expandedBlocks.has(block.id)}
                onToggle={() => toggleBlock(block.id)}
                onMoveUp={() => moveBlock(block.id, -1)}
                onMoveDown={() => moveBlock(block.id, 1)}
                onDelete={() => removeBlock(block.id)}
                onUpdate={(u: Partial<CMSBlock>) => updateBlock(block.id, u)}
                lessonId={lessonId!}
                isEditable={isContentManager}
                qc={qc}
              />
            ))}

            {lessonId && sortedBlocks.length === 0 && (
              <div className="rounded-lg border-2 border-dashed border-gray-200 p-8 text-center text-sm text-gray-400">
                No content blocks yet. Add your first block above.
              </div>
            )}
          </div>
        </div>
      </div>
    </CMSLayout>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-gray-600">{label}{required && <span className="text-red-500 ml-0.5">*</span>}</Label>
      {children}
    </div>
  );
}

function BlockTypeMenu({ onSelect }: { onSelect: (type: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="sm" variant="outline" onClick={() => setOpen(o => !o)}>
        <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Block
      </Button>
      {open && (
        <div className="absolute right-0 top-8 z-10 rounded-lg border border-gray-200 bg-white shadow-lg w-56 py-1">
          {BLOCK_TYPES.map(t => (
            <button key={t.value} onClick={() => { onSelect(t.value); setOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 transition-colors">
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BlockCard({ block, index, total, expanded, onToggle, onMoveUp, onMoveDown, onDelete, onUpdate, lessonId, isEditable, qc }: any) {
  const label = BLOCK_TYPES.find(t => t.value === block.type)?.label ?? block.type;
  const { toast } = useToast();

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200">
        <button onClick={onToggle} className="flex items-center gap-1.5 flex-1 text-left text-sm font-medium text-gray-700">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="text-xs text-gray-400 mr-0.5">#{index + 1}</span>
          {label}
          {!block.isRequired && <span className="text-xs text-gray-400 ml-1">(optional)</span>}
          {!block.isActive && <span className="text-xs text-red-400 ml-1">(inactive)</span>}
        </button>
        {isEditable && (
          <div className="flex items-center gap-0.5">
            <button onClick={onMoveUp} disabled={index === 0} className="p-1 rounded hover:bg-gray-200 disabled:opacity-30">
              <ArrowUp className="h-3 w-3" />
            </button>
            <button onClick={onMoveDown} disabled={index === total - 1} className="p-1 rounded hover:bg-gray-200 disabled:opacity-30">
              <ArrowDown className="h-3 w-3" />
            </button>
            <button onClick={onDelete} className="p-1 rounded hover:bg-red-50 text-red-400">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="p-4 space-y-3">
          <BlockEditor block={block} onUpdate={onUpdate} lessonId={lessonId} isEditable={isEditable} qc={qc} />
        </div>
      )}
    </div>
  );
}

/**
 * Fields this editor owns. Everything else on a block — notably `order`, which
 * the reorder arrows manage independently — must never be written from here, or
 * saving stale local state would silently undo a reorder made while the block
 * was expanded.
 */
const EDITABLE_BLOCK_FIELDS = [
  "title", "titleAr", "instructions", "instructionsAr",
  "content", "contentAr", "audioNote", "prompt", "promptAr",
  "exampleAudio", "isRequired", "isActive", "estimatedMinutes", "config",
  "referenceMediaId", "expectsReferenceReading",
  // Optional illustration media, offered on every block type.
  "imageMediaId", "audioMediaId", "imageMediaKey", "audioMediaKey",
] as const;

function BlockEditor({ block, onUpdate, lessonId, isEditable, qc }: any) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [localBlock, setLocalBlock] = useState(block);

  // Adopt server state when this block changes underneath us (a reorder, or a
  // refetch after another edit) so the form never drifts from what was stored.
  useEffect(() => {
    setLocalBlock(block);
  }, [block.id, block.order, block.updatedAt]);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of EDITABLE_BLOCK_FIELDS) {
        if (key in localBlock) patch[key] = localBlock[key];
      }
      await onUpdate(patch);
      toast({ title: "Block saved" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  /** Saves one question. `exerciseId` null creates a new one on this block. */
  const updateExercise = async (
    exerciseData: Partial<CMSExercise> & { options?: CMSOption[] },
    exerciseId?: number | null,
  ) => {
    setSaving(true);
    try {
      const id = exerciseId === undefined ? block.exercise?.id : exerciseId;
      if (id) {
        await cmsApi.blocks.updateExercise(lessonId, id, exerciseData);
      } else {
        await cmsApi.blocks.createExercise(lessonId, block.id, exerciseData);
      }
      qc.invalidateQueries({ queryKey: ["cms-blocks", lessonId] });
      toast({ title: "Exercise saved" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  const deleteExercise = async (exerciseId: number) => {
    setSaving(true);
    try {
      await cmsApi.blocks.deleteExercise(lessonId, exerciseId);
      qc.invalidateQueries({ queryKey: ["cms-blocks", lessonId] });
      toast({ title: "Question deleted" });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
    setSaving(false);
  };

  const commonFields = (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Block title</Label>
        <Input value={localBlock.title ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, title: e.target.value }))} placeholder="Optional display title" className="text-sm" />
      </div>
      <div className="flex items-center gap-4 pt-5">
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <Checkbox checked={localBlock.isRequired} onCheckedChange={v => setLocalBlock((b: any) => ({ ...b, isRequired: !!v }))} />
          Required
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <Checkbox checked={localBlock.isActive} onCheckedChange={v => setLocalBlock((b: any) => ({ ...b, isActive: !!v }))} />
          Active
        </label>
      </div>
    </div>
  );

  /**
   * Optional illustration media, offered on EVERY block type.
   *
   * Separate from the per-type media fields below it: a pronunciation block's
   * "Reference audio" is the model recording its score is measured against,
   * whereas these two are simply shown to the student and carry no grading
   * meaning. Keeping them apart stops an author attaching a picture and
   * accidentally changing how the block is marked.
   *
   * The picker returns a storage key and an asset id; only the id is stored,
   * because the key is not fetchable on its own — the server signs a URL per
   * asset at playback time.
   */
  const illustrationFields = (
    <details className="rounded-md border border-gray-200">
      <summary className="cursor-pointer px-3 py-2 text-xs text-gray-600">
        Image / audio for the student{" "}
        {(localBlock.imageMediaKey || localBlock.audioMediaKey) && (
          <span className="ml-1 text-emerald-600">• attached</span>
        )}
      </summary>
      <div className="space-y-3 border-t border-gray-200 p-3">
        <p className="text-xs text-gray-500">
          Optional. Shown to the student when taking the lesson. Does not affect
          grading.
        </p>
        <MediaPicker
          label="Image"
          accept="image"
          allowRecording={false}
          value={localBlock.imageMediaKey}
          disabled={!isEditable}
          onChange={(key, mediaId) =>
            setLocalBlock((b: any) => ({
              ...b,
              imageMediaKey: key ?? "",
              imageMediaId: mediaId,
            }))
          }
        />
        <MediaPicker
          label="Audio"
          accept="audio"
          value={localBlock.audioMediaKey}
          disabled={!isEditable}
          onChange={(key, mediaId) =>
            setLocalBlock((b: any) => ({
              ...b,
              audioMediaKey: key ?? "",
              audioMediaId: mediaId,
            }))
          }
        />
      </div>
    </details>
  );

  return (
    <div className="space-y-3">
      {commonFields}
      {illustrationFields}

      {(block.type === "text" || block.type === "explanation" || block.type === "review") && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Content (English)</Label>
            <Textarea rows={5} value={localBlock.content ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, content: e.target.value }))} placeholder="Enter text content…" className="text-sm" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Content (Arabic)</Label>
            <Textarea rows={5} dir="rtl" value={localBlock.contentAr ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, contentAr: e.target.value }))} className="text-sm" />
          </div>
        </>
      )}

      {block.type === "dialogue" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Dialogue (English)</Label>
            <Textarea rows={6} value={localBlock.content ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, content: e.target.value }))} placeholder="Person A: Hello!&#10;Person B: Hi there!" className="text-sm font-mono" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Arabic translation</Label>
            <Textarea rows={4} dir="rtl" value={localBlock.contentAr ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, contentAr: e.target.value }))} className="text-sm" />
          </div>
        </>
      )}

      {block.type === "audio_placeholder" && (
        <>
          <MediaPicker
            label="Listening audio"
            accept="audio"
            value={localBlock.audioNote}
            disabled={!isEditable}
            onChange={(key, mediaId) =>
              setLocalBlock((b: any) => ({ ...b, audioNote: key ?? "", referenceMediaId: mediaId }))
            }
          />
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Instructions</Label>
            <Textarea rows={2} value={localBlock.instructions ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, instructions: e.target.value }))} className="text-sm" />
          </div>
        </>
      )}

      {block.type === "vocabulary_list" && (
        <p className="text-xs text-gray-400 bg-gray-50 rounded p-2">
          Vocabulary items are managed separately in the Vocabulary section and linked to this lesson.
          This block will display all vocabulary associated with this lesson.
        </p>
      )}

      {block.type === "mcq" && (
        <MCQListEditor
          block={block}
          onSave={updateExercise}
          onDelete={deleteExercise}
          saving={saving}
          isEditable={isEditable}
        />
      )}

      {(block.type === "speaking_prompt") && (
        <SpeakingEditor
          block={block}
          onSave={updateExercise}
          // Carries the shared Required / Active checkboxes edited above, which
          // this type's own Save button is otherwise the only way to persist.
          onSaveBlock={(patch: Record<string, unknown>) =>
            onUpdate({
              isRequired: localBlock.isRequired,
              isActive: localBlock.isActive,
              ...patch,
            })
          }
          saving={saving}
          isEditable={isEditable}
        />
      )}

      {block.type === "pronunciation_guide" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Word / Phrase</Label>
              <Input value={localBlock.prompt ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, prompt: e.target.value }))} className="text-sm" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-gray-500">Phonetic / IPA</Label>
              <Input value={localBlock.content ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, content: e.target.value }))} placeholder="/ˈwɜːrd/" className="text-sm font-mono" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Pronunciation notes (Arabic guidance)</Label>
            <Textarea rows={2} dir="rtl" value={localBlock.contentAr ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, contentAr: e.target.value }))} className="text-sm" />
          </div>
          {/* Without this the recording is scored on fluency alone — there is
              nothing to align the transcript against, so no accuracy score. */}
          <label className="flex items-start gap-2 rounded-md border border-gray-200 p-2">
            <Checkbox
              checked={!!localBlock.expectsReferenceReading}
              disabled={!isEditable}
              onCheckedChange={v => setLocalBlock((b: any) => ({ ...b, expectsReferenceReading: !!v }))}
            />
            <span className="text-xs text-gray-600">
              <strong>Score accuracy against the text above.</strong> Tick when
              "Phonetic / IPA" holds the words to read aloud, not a phonetic
              transcription — the student's words are matched against it.
              Unticked, only fluency is scored.
            </span>
          </label>
          <MediaPicker
            label="Reference audio (the model pronunciation)"
            accept="audio"
            value={localBlock.audioNote}
            disabled={!isEditable}
            onChange={(key, mediaId) =>
              setLocalBlock((b: any) => ({ ...b, audioNote: key ?? "", referenceMediaId: mediaId }))
            }
          />
        </>
      )}

      {block.type === "open_ended" && (
        <OpenEndedEditor
          block={block}
          onSave={updateExercise}
          // Carries the shared Required / Active checkboxes, which live on the
          // block rather than on the exercise this editor saves.
          onSaveBlock={(patch: Record<string, unknown>) =>
            onUpdate({
              isRequired: localBlock.isRequired,
              isActive: localBlock.isActive,
              ...patch,
            })
          }
          saving={saving}
          isEditable={isEditable}
        />
      )}

      {block.type === "spelling" && (
        <>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Word to spell</Label>
            <Input value={localBlock.prompt ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, prompt: e.target.value }))} className="text-sm" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Instructions</Label>
            <Textarea rows={2} value={localBlock.instructions ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, instructions: e.target.value }))} className="text-sm" />
          </div>
        </>
      )}

      {/* Shown for EVERY block type.

          This used to be hidden for mcq, speaking_prompt and open_ended, on the
          reasoning that those types have their own Save button. But their own
          button saves the EXERCISE, and the checkboxes above it — Required,
          Active — and the illustration media live on the BLOCK. So on those
          three types there was no way to persist them at all: a content manager
          could untick "Required", press the only Save button on screen, and the
          block stayed required with no error shown.

          `save` only writes EDITABLE_BLOCK_FIELDS, and the reorder arrows manage
          `order` separately, so an extra Save Block here cannot clobber
          anything the per-type editors own. */}
      {isEditable && (
        <div className="pt-1">
          <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Block"}</Button>
        </div>
      )}
    </div>
  );
}

/**
 * All the questions on one MCQ block.
 *
 * A block used to hold exactly one question, so a ten-question comprehension
 * check meant ten blocks. The server has always allowed many exercises per
 * block — only the editor and the player assumed one.
 */
function MCQListEditor({ block, onSave, onDelete, saving, isEditable }: any) {
  // `exercises` is the full list; older payloads only carry `exercise`.
  const existing: any[] =
    block.exercises?.length
      ? block.exercises
      : block.exercise
        ? [{ ...block.exercise, options: block.options ?? [] }]
        : [];

  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      {existing.map((ex, i) => (
        <div key={ex.id} className="rounded-md border border-gray-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">Question {i + 1}</span>
            {isEditable && existing.length > 1 && (
              <Button size="sm" variant="ghost" className="h-6 text-red-500"
                onClick={() => { if (confirm("Delete this question?")) onDelete(ex.id); }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <MCQEditor
            exercise={ex}
            options={ex.options ?? []}
            blockId={block.id}
            onSave={(data: any) => onSave(data, ex.id)}
            saving={saving}
            isEditable={isEditable}
          />
        </div>
      ))}

      {adding && (
        <div className="rounded-md border border-dashed border-indigo-300 p-3">
          <div className="mb-2 text-xs font-medium text-indigo-600">
            New question {existing.length + 1}
          </div>
          <MCQEditor
            exercise={null}
            options={[]}
            blockId={block.id}
            onSave={async (data: any) => { await onSave(data, null); setAdding(false); }}
            saving={saving}
            isEditable={isEditable}
          />
        </div>
      )}

      {isEditable && !adding && (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add question
        </Button>
      )}

      {existing.length === 0 && !adding && (
        <p className="text-xs text-gray-400">No questions yet.</p>
      )}
    </div>
  );
}

function MCQEditor({ exercise, options: initialOptions, blockId, onSave, saving, isEditable }: any) {
  const [question, setQuestion] = useState(exercise?.question ?? "");
  const [questionAr, setQuestionAr] = useState(exercise?.questionAr ?? "");
  const [options, setOptions] = useState<CMSOption[]>(
    initialOptions?.length ? initialOptions : [
      { optionId: "a", text: "", textAr: "" },
      { optionId: "b", text: "", textAr: "" },
      { optionId: "c", text: "", textAr: "" },
      { optionId: "d", text: "", textAr: "" },
    ]
  );
  const [correct, setCorrect] = useState(exercise?.correctOptionId ?? "a");
  const [explanation, setExplanation] = useState(exercise?.explanation ?? "");
  const block = { id: blockId };

  const submit = () => onSave({ exerciseType: "mcq", question, questionAr, correctOptionId: correct, explanation, options });

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Question</Label>
        <Input value={question} onChange={e => setQuestion(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Question (Arabic)</Label>
        <Input dir="rtl" value={questionAr} onChange={e => setQuestionAr(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-2">
        <Label className="text-xs font-medium text-gray-700">
          Options — click the circle to mark the correct answer
        </Label>
        {options.map((opt, i) => (
          <div
            key={opt.optionId}
            className={`flex items-center gap-2 rounded-md border p-2 transition-colors ${
              correct === opt.optionId
                ? "border-green-500 bg-green-50"
                : "border-transparent hover:border-gray-200"
            }`}
          >
            <input type="radio" name={`correct-${block.id}`} checked={correct === opt.optionId}
              onChange={() => setCorrect(opt.optionId)}
              title="Mark as the correct answer"
              className="h-5 w-5 shrink-0 cursor-pointer accent-green-600" />
            <span className="text-xs font-mono text-gray-500 w-4">{opt.optionId})</span>
            <Input value={opt.text} onChange={e => setOptions(o => o.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} placeholder={`Option ${opt.optionId}`} className="text-sm flex-1" />
            <Input dir="rtl" value={opt.textAr ?? ""} onChange={e => setOptions(o => o.map((x, j) => j === i ? { ...x, textAr: e.target.value } : x))} placeholder="Arabic" className="text-sm flex-1" />
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Explanation (shown after answering)</Label>
        <Textarea rows={2} value={explanation} onChange={e => setExplanation(e.target.value)} className="text-sm" />
      </div>
      {isEditable && <Button size="sm" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save MCQ"}</Button>}
    </div>
  );
}

/**
 * A speaking block keeps its text in two places, and both are needed.
 *
 * The player reads `prompt`/`promptAr` off the block, the way it does for every
 * other block type; the grader reads the exercise row. Saving only the exercise
 * — which this editor used to do — left the student looking at a screen with no
 * prompt on it at all.
 *
 * This editor replaces the generic "Save Block" button for this type, so its
 * save has to carry the shared block fields too (Required / Active, edited
 * above) or those checkboxes would have no way to persist.
 */
function SpeakingEditor({ block, onSave, onSaveBlock, saving, isEditable }: any) {
  const [prompt, setPrompt] = useState(block.prompt ?? block.exercise?.prompt ?? "");
  const [promptAr, setPromptAr] = useState(block.promptAr ?? block.exercise?.promptAr ?? "");
  const [instructions, setInstructions] = useState(
    block.instructions ?? block.exercise?.instructionsText ?? "",
  );
  const [modelAnswer, setModelAnswer] = useState(block.exercise?.modelAnswer ?? "");
  const [expectedConcepts, setExpectedConcepts] = useState(block.exercise?.expectedConcepts ?? "");

  // Adopt server state when the block changes underneath us, matching
  // BlockEditor — otherwise the form keeps showing a stale prompt after a
  // refetch.
  useEffect(() => {
    setPrompt(block.prompt ?? block.exercise?.prompt ?? "");
    setPromptAr(block.promptAr ?? block.exercise?.promptAr ?? "");
    setInstructions(block.instructions ?? block.exercise?.instructionsText ?? "");
    setModelAnswer(block.exercise?.modelAnswer ?? "");
    setExpectedConcepts(block.exercise?.expectedConcepts ?? "");
  }, [block.id, block.updatedAt]);

  // Block first: if the exercise write fails, the student still sees a prompt.
  const submit = async () => {
    await onSaveBlock({ prompt, promptAr, instructions });
    await onSave({
      exerciseType: "speaking", question: prompt, prompt, promptAr,
      instructionsText: instructions, modelAnswer, expectedConcepts,
      correctOptionId: "_speaking_",
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Speaking Prompt</Label>
        <Textarea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Prompt (Arabic)</Label>
        <Textarea rows={2} dir="rtl" value={promptAr} onChange={e => setPromptAr(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Instructions for student</Label>
        <Textarea rows={2} value={instructions} onChange={e => setInstructions(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Model answer (for AI/reviewer evaluation)</Label>
        <Textarea rows={3} value={modelAnswer} onChange={e => setModelAnswer(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Key concepts / keywords (comma-separated)</Label>
        <Input value={expectedConcepts} onChange={e => setExpectedConcepts(e.target.value)} className="text-sm" />
      </div>
      {isEditable && <Button size="sm" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save Speaking Block"}</Button>}
    </div>
  );
}

function OpenEndedEditor({ block, onSave, onSaveBlock, saving, isEditable }: any) {
  const [question, setQuestion] = useState(block.exercise?.question ?? "");
  const [questionAr, setQuestionAr] = useState(block.exercise?.questionAr ?? "");
  const [modelAnswer, setModelAnswer] = useState(block.exercise?.modelAnswer ?? "");
  const [expectedConcepts, setExpectedConcepts] = useState(block.exercise?.expectedConcepts ?? "");

  // Adopt server state when the block changes underneath us, so the form does
  // not keep showing a stale question after a refetch.
  useEffect(() => {
    setQuestion(block.exercise?.question ?? "");
    setQuestionAr(block.exercise?.questionAr ?? "");
    setModelAnswer(block.exercise?.modelAnswer ?? "");
    setExpectedConcepts(block.exercise?.expectedConcepts ?? "");
  }, [block.id, block.updatedAt]);

  /**
   * Block first, then the exercise.
   *
   * The question lives on the exercise, but Required/Active live on the block —
   * and this button was the only one on screen for this type, so unticking
   * "Required" and pressing Save did nothing at all. Saving the block first
   * means a failure in the exercise write still persists the flags the author
   * just changed.
   */
  const submit = async () => {
    await onSaveBlock?.({});
    await onSave({
      exerciseType: "open_ended", question, questionAr,
      modelAnswer, expectedConcepts, correctOptionId: "_open_",
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Question</Label>
        <Textarea rows={3} value={question} onChange={e => setQuestion(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Question (Arabic)</Label>
        <Textarea rows={2} dir="rtl" value={questionAr} onChange={e => setQuestionAr(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Model answer</Label>
        <Textarea rows={3} value={modelAnswer} onChange={e => setModelAnswer(e.target.value)} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Key concepts / keywords</Label>
        <Input value={expectedConcepts} onChange={e => setExpectedConcepts(e.target.value)} className="text-sm" />
      </div>
      {isEditable && <Button size="sm" onClick={submit} disabled={saving}>{saving ? "Saving…" : "Save Question"}</Button>}
    </div>
  );
}
