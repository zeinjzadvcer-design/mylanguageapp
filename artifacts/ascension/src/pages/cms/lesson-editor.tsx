import { useState, useEffect, useRef } from "react";
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

/**
 * Types whose content lives on the block row itself — the word, the passage,
 * the audio clip — so a second item is a second block, linked to the first by
 * a `groupId` in `config`. MCQ, speaking and open-ended blocks are absent:
 * their items are exercises inside one block (ExerciseListEditor). A
 * vocabulary list is absent because it always shows the whole lesson's words.
 */
const GROUPABLE_TYPES = [
  "text", "explanation", "review", "pronunciation_guide",
  "audio_placeholder", "spelling", "dialogue",
];

function groupIdOf(block: CMSBlock): string | undefined {
  const id = (block.config as { groupId?: unknown } | null | undefined)?.groupId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * Consecutive blocks sharing a group id. Every block written before grouping
 * existed has none, so it is a group of one and looks exactly as it did.
 */
function groupBlocks(sorted: CMSBlock[]): CMSBlock[][] {
  const groups: CMSBlock[][] = [];
  for (const block of sorted) {
    const prev = groups[groups.length - 1];
    const id = groupIdOf(block);
    if (prev && id && groupIdOf(prev[prev.length - 1]) === id) prev.push(block);
    else groups.push([block]);
  }
  return groups;
}

function newGroupId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
      const clean = (lines?: string[] | null) =>
        lines ? lines.map(l => l.trim()).filter(Boolean) : lines;
      const payload = {
        ...form,
        objectives: clean(form.objectives),
        objectivesAr: clean(form.objectivesAr),
      };
      if (isNew) {
        const result = await cmsApi.lessons.create(payload);
        toast({ title: "Lesson created" });
        setLocation(`/cms/lessons/${result.id}/edit`);
      } else {
        await cmsApi.lessons.update(lessonId!, payload);
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
    // A reading block counts — it is read aloud by default (below), and a
    // student with no working microphone must still be able to get past it.
    const startsOptional =
      type === "speaking_prompt" || type === "pronunciation_guide" || type === "text";
    const block = await cmsApi.blocks.create(lessonId, {
      type,
      order: maxOrder + 1,
      isRequired: !startsOptional,
      isActive: true,
      // A reading block is read aloud and scored unless the author unticks it.
      ...(type === "text" ? { expectsReferenceReading: true } : {}),
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

  /** Moves a whole group, so its items stay together. */
  const moveGroup = async (groupIndex: number, dir: -1 | 1) => {
    if (!lessonId) return;
    const groups = groupBlocks([...blocks].sort((a, b) => a.order - b.order));
    const target = groupIndex + dir;
    if (target < 0 || target >= groups.length) return;
    [groups[groupIndex], groups[target]] = [groups[target], groups[groupIndex]];
    await cmsApi.blocks.reorder(lessonId, groups.flat().map(b => b.id));
    await refetchBlocks();
  };

  /**
   * Adds an item to a block: a new block of the same type, placed straight
   * after the group and linked to it. The first item is given a group id the
   * first time this happens, which is the only change made to an existing
   * block — its own content and settings are left as they were.
   *
   * The new item starts with the group's title and instructions, so the
   * student sees one activity; it takes Required from the last item, and
   * every item keeps its own Required / Active from then on.
   */
  const addItem = async (group: CMSBlock[]) => {
    if (!lessonId) return;
    const first = group[0];
    const last = group[group.length - 1];
    const baseConfig = (first.config && typeof first.config === "object" ? first.config : {}) as Record<string, unknown>;
    let groupId = groupIdOf(first);
    let createdId: number | null = null;
    try {
      if (!groupId) {
        groupId = newGroupId();
        await cmsApi.blocks.update(lessonId, first.id, { config: { ...baseConfig, groupId } });
      }
      const created = await cmsApi.blocks.create(lessonId, {
        type: first.type,
        order: last.order + 1,
        title: first.title, titleAr: first.titleAr,
        instructions: first.instructions, instructionsAr: first.instructionsAr,
        isRequired: last.isRequired,
        isActive: true,
        expectsReferenceReading: first.expectsReferenceReading,
        config: { ...baseConfig, groupId },
      });
      createdId = created.id;
      // Insert right after the group rather than at the end of the lesson.
      const ids = [...blocks].sort((a, b) => a.order - b.order).map(b => b.id);
      ids.splice(ids.indexOf(last.id) + 1, 0, created.id);
      await cmsApi.blocks.reorder(lessonId, ids);
      setExpandedBlocks(prev => new Set([...prev, created.id]));
      await refetchBlocks();
    } catch (e: any) {
      // Created but not placed: its order collides with the next block's, which
      // can split the group. Remove it rather than leave it half-placed.
      if (createdId !== null) {
        await cmsApi.blocks.delete(lessonId, createdId).catch(() => {});
      }
      toast({ title: "Could not add item", description: e.message, variant: "destructive" });
      await refetchBlocks();
    }
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
  const blockGroupList = groupBlocks(sortedBlocks);
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

              {/* Shown to the student before the first block, Arabic first.
                  Blank lines are kept while typing and dropped on save:
                  filtering them on every keystroke swallowed the Enter key,
                  so a second objective could not be typed at all. */}
              <Field label="Learning Objectives — English (one per line)">
                <Textarea rows={3} value={(form.objectives ?? []).join("\n")} onChange={e => setForm(f => ({ ...f, objectives: e.target.value.split("\n") }))} />
              </Field>
              <Field label="Learning Objectives — Arabic (one per line)">
                <Textarea rows={3} dir="rtl" value={(form.objectivesAr ?? []).join("\n")} onChange={e => setForm(f => ({ ...f, objectivesAr: e.target.value.split("\n") }))} />
              </Field>
              <p className="text-xs text-gray-400 -mt-1">
                Students see these first, before the lesson starts.
              </p>
            </div>
          </div>

          {/* Content blocks panel */}
          <div className="md:col-span-2 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">Content Blocks ({blockGroupList.length})</h2>
              {isContentManager && !isNew && (
                <BlockTypeMenu onSelect={addBlock} />
              )}
            </div>

            {!lessonId && (
              <div className="rounded-lg border-2 border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">
                Save lesson metadata first to add content blocks
              </div>
            )}

            {blockGroupList.map((group, gi) => {
              const typeLabel = BLOCK_TYPES.find(t => t.value === group[0].type)?.label ?? group[0].type;
              const addItemButton = isContentManager && GROUPABLE_TYPES.includes(group[0].type) && (
                <div className="flex items-center gap-3">
                  <Button size="sm" variant="outline" onClick={() => addItem(group)}>
                    <Plus className="mr-1 h-3.5 w-3.5" /> Add item
                  </Button>
                  <span className="text-xs text-gray-400">
                    Another {typeLabel.toLowerCase()} inside this same block.
                  </span>
                </div>
              );

              if (group.length === 1) {
                const block = group[0];
                return (
                  <BlockCard
                    key={block.id}
                    block={block}
                    index={gi}
                    canMoveUp={gi > 0}
                    canMoveDown={gi < blockGroupList.length - 1}
                    expanded={expandedBlocks.has(block.id)}
                    onToggle={() => toggleBlock(block.id)}
                    onMoveUp={() => moveGroup(gi, -1)}
                    onMoveDown={() => moveGroup(gi, 1)}
                    onDelete={() => removeBlock(block.id)}
                    onUpdate={(u: Partial<CMSBlock>) => updateBlock(block.id, u)}
                    lessonId={lessonId!}
                    isEditable={isContentManager}
                    qc={qc}
                    footer={addItemButton}
                  />
                );
              }

              return (
                <div key={group[0].id} className="rounded-lg border border-indigo-200 bg-white overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 bg-indigo-50 border-b border-indigo-200">
                    <span className="flex-1 text-sm font-medium text-gray-700">
                      <span className="text-xs text-gray-400 mr-1.5">#{gi + 1}</span>
                      {typeLabel}
                      <span className="ml-2 text-xs text-indigo-600">{group.length} items</span>
                    </span>
                    {isContentManager && (
                      <div className="flex items-center gap-0.5">
                        <button onClick={() => moveGroup(gi, -1)} disabled={gi === 0} className="p-1 rounded hover:bg-indigo-100 disabled:opacity-30" title="Move block up">
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button onClick={() => moveGroup(gi, 1)} disabled={gi === blockGroupList.length - 1} className="p-1 rounded hover:bg-indigo-100 disabled:opacity-30" title="Move block down">
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="p-3 space-y-2">
                    {group.map((block, ii) => (
                      <BlockCard
                        key={block.id}
                        block={block}
                        heading={`Item ${ii + 1}`}
                        canMoveUp={ii > 0}
                        canMoveDown={ii < group.length - 1}
                        expanded={expandedBlocks.has(block.id)}
                        onToggle={() => toggleBlock(block.id)}
                        // Within the group the neighbour is always a sibling.
                        onMoveUp={() => moveBlock(block.id, -1)}
                        onMoveDown={() => moveBlock(block.id, 1)}
                        onDelete={() => { if (confirm(`Delete item ${ii + 1}?`)) removeBlock(block.id); }}
                        onUpdate={(u: Partial<CMSBlock>) => updateBlock(block.id, u)}
                        lessonId={lessonId!}
                        isEditable={isContentManager}
                        qc={qc}
                      />
                    ))}
                    {addItemButton}
                  </div>
                </div>
              );
            })}

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

/**
 * One block, or one item of a grouped block when `heading` is given. Required
 * and Active are edited here per item, so a grouped block can mix them.
 */
function BlockCard({ block, index, heading, canMoveUp, canMoveDown, expanded, onToggle, onMoveUp, onMoveDown, onDelete, onUpdate, lessonId, isEditable, qc, footer }: any) {
  const label = heading ?? BLOCK_TYPES.find(t => t.value === block.type)?.label ?? block.type;
  const { toast } = useToast();

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200">
        <button onClick={onToggle} className="flex items-center gap-1.5 flex-1 text-left text-sm font-medium text-gray-700">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {heading === undefined && <span className="text-xs text-gray-400 mr-0.5">#{index + 1}</span>}
          {label}
          {!block.isRequired && <span className="text-xs text-gray-400 ml-1">(optional)</span>}
          {!block.isActive && <span className="text-xs text-red-400 ml-1">(inactive)</span>}
        </button>
        {isEditable && (
          <div className="flex items-center gap-0.5">
            <button onClick={onMoveUp} disabled={!canMoveUp} className="p-1 rounded hover:bg-gray-200 disabled:opacity-30">
              <ArrowUp className="h-3 w-3" />
            </button>
            <button onClick={onMoveDown} disabled={!canMoveDown} className="p-1 rounded hover:bg-gray-200 disabled:opacity-30">
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
      {footer && <div className="px-4 py-2 border-t border-gray-100">{footer}</div>}
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
  /** The server copy the form was last synced to — what "unsaved" is measured against. */
  const syncedBlock = useRef(block);

  // Adopt server state when this block changes underneath us (a reorder, or a
  // refetch after another edit) so the form never drifts from what was stored.
  //
  // Fields edited here but not yet saved are kept. Replacing the whole form
  // used to throw them away: saving a speaking prompt or attaching media
  // patches the block, the refetch landed here, and whatever else the author
  // had typed — or an image picked a moment earlier — vanished without a word.
  useEffect(() => {
    const previous = syncedBlock.current;
    syncedBlock.current = block;
    setLocalBlock((local: any) => {
      if (local.id !== block.id) return block;
      const merged: any = { ...block };
      for (const key of EDITABLE_BLOCK_FIELDS) {
        if (local[key] !== previous[key]) merged[key] = local[key];
      }
      return merged;
    });
  }, [block.id, block.order, block.updatedAt]);

  /**
   * Attach or remove illustration media, saved to the block at once.
   *
   * The picker uploads straight away and says "Media attached", so an author
   * reasonably took that as done — but the choice sat in this form until Save
   * Block, which speaking, open-ended and MCQ blocks hide below their own save
   * button. The image was in the library and on no block, and the preview, like
   * the student, never showed it.
   */
  const saveMedia = async (patch: Record<string, unknown>) => {
    setLocalBlock((b: any) => ({ ...b, ...patch }));
    try {
      await onUpdate(patch);
    } catch (e: any) {
      toast({ title: "Media not saved", description: e.message, variant: "destructive" });
    }
  };

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
          grading. Saved to the block as soon as it is attached or removed.
        </p>
        <MediaPicker
          label="Image"
          accept="image"
          allowRecording={false}
          value={localBlock.imageMediaKey}
          disabled={!isEditable}
          onChange={(key, mediaId) =>
            saveMedia({ imageMediaKey: key ?? "", imageMediaId: mediaId })
          }
        />
        <MediaPicker
          label="Audio"
          accept="audio"
          value={localBlock.audioMediaKey}
          disabled={!isEditable}
          onChange={(key, mediaId) =>
            saveMedia({ audioMediaKey: key ?? "", audioMediaId: mediaId })
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
          <p className="text-xs text-gray-400">
            Lists show as lists: start lines with "-" or "1.". Leave a blank line between paragraphs.
          </p>
          {/* Read-aloud scoring is a speech recogniser plus word matching
              against the English content — no language model marks it. */}
          {block.type === "text" && (
            <label className="flex items-start gap-2 rounded-md border border-gray-200 p-2">
              <Checkbox
                checked={!!localBlock.expectsReferenceReading}
                disabled={!isEditable}
                onCheckedChange={v => setLocalBlock((b: any) => ({ ...b, expectsReferenceReading: !!v }))}
              />
              <span className="text-xs text-gray-600">
                <strong>Student reads this text aloud, and is scored.</strong>{" "}
                The recording is transcribed and matched word by word against
                the English content above (no AI marking). Unticked, the text is
                only shown to read.
              </span>
            </label>
          )}
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
          {/* Both are shown to the student, Arabic first. */}
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Instructions (English)</Label>
            <Textarea rows={2} value={localBlock.instructions ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, instructions: e.target.value }))} className="text-sm" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-gray-500">Instructions (Arabic)</Label>
            <Textarea rows={2} dir="rtl" value={localBlock.instructionsAr ?? ""} onChange={e => setLocalBlock((b: any) => ({ ...b, instructionsAr: e.target.value }))} className="text-sm" />
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
        <ExerciseListEditor
          block={block}
          noun="question"
          onDelete={deleteExercise}
          isEditable={isEditable}
          renderEditor={(ex: any, _isFirst: boolean, onCreated?: () => void) => (
            <MCQEditor
              exercise={ex}
              options={ex?.options ?? []}
              blockId={block.id}
              onSave={async (data: any) => { await updateExercise(data, ex ? ex.id : null); onCreated?.(); }}
              saving={saving}
              isEditable={isEditable}
            />
          )}
        />
      )}

      {block.type === "speaking_prompt" && (
        <ExerciseListEditor
          block={block}
          noun="speaking prompt"
          startWithEditor
          onDelete={deleteExercise}
          // The first prompt is mirrored onto the block (see SpeakingEditor).
          // When it is deleted, the next one takes its place there, or the
          // student would keep seeing the prompt that was just removed.
          onFirstDeleted={(next: any) =>
            onUpdate({
              prompt: next.prompt ?? next.question ?? "",
              promptAr: next.promptAr ?? "",
              instructions: next.instructionsText ?? "",
              instructionsAr: next.instructionsAr ?? "",
            })
          }
          isEditable={isEditable}
          renderEditor={(ex: any, isFirst: boolean, onCreated?: () => void) => (
            <SpeakingEditor
              block={block}
              exercise={ex}
              isFirst={isFirst}
              onSave={async (data: any) => { await updateExercise(data, ex ? ex.id : null); onCreated?.(); }}
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
        <ExerciseListEditor
          block={block}
          noun="question"
          startWithEditor
          onDelete={deleteExercise}
          isEditable={isEditable}
          renderEditor={(ex: any, _isFirst: boolean, onCreated?: () => void) => (
            <OpenEndedEditor
              exercise={ex}
              onSave={async (data: any) => { await updateExercise(data, ex ? ex.id : null); onCreated?.(); }}
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
 * All the items on one block: MCQ questions, speaking prompts, open-ended
 * questions.
 *
 * A block used to hold exactly one, so a ten-question comprehension check
 * meant ten blocks, and three speaking prompts meant three speaking blocks in
 * a row. The server has always allowed many exercises per block — only the
 * editor and the player assumed one. Each item is one exercise; the student
 * works through them in order inside the same block.
 *
 * `startWithEditor`: a type whose single item used to be edited inline shows
 * that editor straight away when the block is empty, rather than an empty list
 * with an "Add" button — the way those blocks have always looked.
 */
function ExerciseListEditor({
  block, noun, renderEditor, onDelete, onFirstDeleted, isEditable, startWithEditor = false,
}: {
  block: any;
  noun: string;
  renderEditor: (exercise: any | null, isFirst: boolean, onCreated?: () => void) => React.ReactNode;
  onDelete: (exerciseId: number) => Promise<void> | void;
  onFirstDeleted?: (next: any) => Promise<unknown> | void;
  isEditable: boolean;
  startWithEditor?: boolean;
}) {
  // `exercises` is the full list; older payloads only carry `exercise`.
  const existing: any[] =
    block.exercises?.length
      ? block.exercises
      : block.exercise
        ? [{ ...block.exercise, options: block.options ?? [] }]
        : [];

  const [adding, setAdding] = useState(false);
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  if (existing.length === 0 && startWithEditor) {
    return <>{renderEditor(null, true)}</>;
  }

  const remove = async (index: number) => {
    if (!confirm(`Delete this ${noun}?`)) return;
    await onDelete(existing[index].id);
    if (index === 0 && existing[1]) await onFirstDeleted?.(existing[1]);
  };

  return (
    <div className="space-y-3">
      {existing.map((ex, i) => (
        <div key={ex.id} className="rounded-md border border-gray-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">{Noun} {i + 1}</span>
            {isEditable && existing.length > 1 && (
              <Button size="sm" variant="ghost" className="h-6 text-red-500" onClick={() => remove(i)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {renderEditor(ex, i === 0)}
        </div>
      ))}

      {adding && (
        <div className="rounded-md border border-dashed border-indigo-300 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-indigo-600">New {noun} {existing.length + 1}</span>
            <Button size="sm" variant="ghost" className="h-6 text-gray-500" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
          {renderEditor(null, existing.length === 0, () => setAdding(false))}
        </div>
      )}

      {isEditable && !adding && (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add {noun}
          </Button>
          <span className="text-xs text-gray-400">
            Students go through each {noun} in turn, inside this block.
          </span>
        </div>
      )}

      {existing.length === 0 && !adding && (
        <p className="text-xs text-gray-400">No {noun}s yet.</p>
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

/** Blank strings count as absent — the editor saves "" for untouched fields. */
function filled(value: string | null | undefined): string | null {
  return value && value.trim() !== "" ? value : null;
}

/**
 * One prompt on a speaking block.
 *
 * The FIRST prompt keeps its text in two places, and both are needed. The
 * player reads `prompt`/`promptAr` off the block for a single-prompt block,
 * the way it does for every other block type; the grader reads the exercise
 * row. Saving only the exercise — which this editor used to do — left the
 * student looking at a screen with no prompt on it at all. Later prompts live
 * only on their own exercise, which is where the player reads them from when a
 * block holds several.
 *
 * Every prompt's save also carries the shared block fields (Required / Active,
 * edited above), or those checkboxes would have no way to persist.
 */
function SpeakingEditor({ block, exercise, isFirst, onSave, onSaveBlock, saving, isEditable }: any) {
  // The exercise wins when it has text: after the first prompt is deleted the
  // block can still mirror the old one, and showing that here would put the
  // deleted prompt's words into the new first prompt's form.
  const initial = () => ({
    prompt: filled(exercise?.prompt) ?? (isFirst ? block.prompt : null) ?? "",
    promptAr: filled(exercise?.promptAr) ?? (isFirst ? block.promptAr : null) ?? "",
    instructions: filled(exercise?.instructionsText) ?? (isFirst ? block.instructions : null) ?? "",
    instructionsAr: filled(exercise?.instructionsAr) ?? (isFirst ? block.instructionsAr : null) ?? "",
    modelAnswer: exercise?.modelAnswer ?? "",
    expectedConcepts: exercise?.expectedConcepts ?? "",
  });
  const [fields, setFields] = useState(initial);
  /** The server values the form was last synced to — what "unsaved" is measured against. */
  const synced = useRef(fields);
  const set = (k: keyof ReturnType<typeof initial>) => (e: { target: { value: string } }) =>
    setFields(f => ({ ...f, [k]: e.target.value }));

  // Adopt server state when the block or prompt changes underneath us,
  // matching BlockEditor, so the form never shows a stale prompt after a
  // refetch — but keep what the author has typed and not yet saved. Every
  // save on this block (another prompt, an attached image) changes the block,
  // and replacing the whole form threw away the other prompts' typing.
  useEffect(() => {
    const next = initial();
    const previous = synced.current;
    synced.current = next;
    setFields(local => {
      const merged = { ...next };
      for (const key of Object.keys(next) as Array<keyof typeof next>) {
        if (local[key] !== previous[key]) merged[key] = local[key];
      }
      return merged;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.id, block.updatedAt, exercise?.id, exercise?.updatedAt, isFirst]);

  // Block first: if the exercise write fails, the student still sees a prompt.
  const submit = async () => {
    const { prompt, promptAr, instructions, instructionsAr, modelAnswer, expectedConcepts } = fields;
    await onSaveBlock(isFirst ? { prompt, promptAr, instructions, instructionsAr } : {});
    await onSave({
      exerciseType: "speaking", question: prompt, prompt, promptAr,
      instructionsText: instructions, instructionsAr, modelAnswer, expectedConcepts,
      correctOptionId: "_speaking_",
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Speaking Prompt</Label>
        <Textarea rows={3} value={fields.prompt} onChange={set("prompt")} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Prompt (Arabic)</Label>
        <Textarea rows={2} dir="rtl" value={fields.promptAr} onChange={set("promptAr")} className="text-sm" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Instructions for student (English)</Label>
          <Textarea rows={2} value={fields.instructions} onChange={set("instructions")} className="text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-gray-500">Instructions (Arabic)</Label>
          <Textarea rows={2} dir="rtl" value={fields.instructionsAr} onChange={set("instructionsAr")} className="text-sm" />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Model answer (for AI/reviewer evaluation)</Label>
        <Textarea rows={3} value={fields.modelAnswer} onChange={set("modelAnswer")} className="text-sm" />
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-gray-500">Key concepts / keywords (comma-separated)</Label>
        <Input value={fields.expectedConcepts} onChange={set("expectedConcepts")} className="text-sm" />
      </div>
      {isEditable && <Button size="sm" onClick={submit} disabled={saving}>{saving ? "Saving…" : exercise ? "Save Prompt" : "Add Prompt"}</Button>}
    </div>
  );
}

/** One question on an open-ended block. `exercise` is null for a new one. */
function OpenEndedEditor({ exercise, onSave, onSaveBlock, saving, isEditable }: any) {
  const [question, setQuestion] = useState(exercise?.question ?? "");
  const [questionAr, setQuestionAr] = useState(exercise?.questionAr ?? "");
  const [modelAnswer, setModelAnswer] = useState(exercise?.modelAnswer ?? "");
  const [expectedConcepts, setExpectedConcepts] = useState(exercise?.expectedConcepts ?? "");

  // Adopt server state when the question changes underneath us, so the form
  // does not keep showing a stale question after a refetch.
  useEffect(() => {
    setQuestion(exercise?.question ?? "");
    setQuestionAr(exercise?.questionAr ?? "");
    setModelAnswer(exercise?.modelAnswer ?? "");
    setExpectedConcepts(exercise?.expectedConcepts ?? "");
  }, [exercise?.id, exercise?.updatedAt]);

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
