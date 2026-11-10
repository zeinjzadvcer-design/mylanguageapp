import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cmsApi } from "@/lib/cms-api";
import { CMSLayout } from "@/components/cms-layout";
import { useCan } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagsInput } from "@/components/tags-input";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Search, Check, X } from "lucide-react";

const COMMON_TAGS = ["business", "travel", "academic", "daily life", "technology", "health", "food", "finance"];
const PARTS_OF_SPEECH = ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "interjection", "phrase"];

export default function VocabularyPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const canEdit = useCan()("content.edit");
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<any>({ levelId: "" });
  const [editForm, setEditForm] = useState<any>({});

  const { data: levels } = useQuery({ queryKey: ["cms-levels"], queryFn: () => cmsApi.levels.list() });

  const { data, isLoading } = useQuery({
    queryKey: ["cms-vocab", page, search],
    queryFn: () => cmsApi.vocabulary.list({ page, limit: 30, search: search || undefined }),
    placeholderData: (prev: any) => prev,
  });

  const createMut = useMutation({
    mutationFn: () => cmsApi.vocabulary.create(form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-vocab"] }); setForm({ levelId: "" }); setShowForm(false); toast({ title: "Vocabulary item created" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: any) => cmsApi.vocabulary.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-vocab"] }); setEditId(null); toast({ title: "Updated" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => cmsApi.vocabulary.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-vocab"] }); toast({ title: "Deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalPages = data ? Math.ceil(data.total / 30) : 1;

  return (
    <CMSLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Vocabulary</h1>
            <p className="text-sm text-gray-500 mt-0.5">{data?.total ?? "—"} items</p>
          </div>
          {canEdit && <Button size="sm" onClick={() => setShowForm(f => !f)}><Plus className="h-3.5 w-3.5 mr-1" /> Add Item</Button>}
        </div>

        {/* Create form */}
        {showForm && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">New Vocabulary Item</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Word / Phrase *</Label>
                <Input value={form.word ?? ""} onChange={e => setForm((f: any) => ({ ...f, word: e.target.value }))} className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Translation (Arabic) *</Label>
                <Input dir="rtl" value={form.translation ?? ""} onChange={e => setForm((f: any) => ({ ...f, translation: e.target.value }))} className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Level *</Label>
                <Select value={form.levelId?.toString() ?? ""} onValueChange={v => setForm((f: any) => ({ ...f, levelId: parseInt(v) }))}>
                  <SelectTrigger className="text-sm"><SelectValue placeholder="Select level" /></SelectTrigger>
                  <SelectContent>
                    {(levels ?? []).map((l: any) => <SelectItem key={l.id} value={l.id.toString()}>{l.code} — {l.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Part of Speech</Label>
                <Select value={form.partOfSpeech ?? ""} onValueChange={v => setForm((f: any) => ({ ...f, partOfSpeech: v }))}>
                  <SelectTrigger className="text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {PARTS_OF_SPEECH.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Example Sentence</Label>
                <Input value={form.exampleSentence ?? ""} onChange={e => setForm((f: any) => ({ ...f, exampleSentence: e.target.value }))} className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Example (Arabic)</Label>
                <Input dir="rtl" value={form.exampleSentenceAr ?? ""} onChange={e => setForm((f: any) => ({ ...f, exampleSentenceAr: e.target.value }))} className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Pronunciation</Label>
                <Input value={form.pronunciation ?? ""} onChange={e => setForm((f: any) => ({ ...f, pronunciation: e.target.value }))} placeholder="/ˈwɜːrd/" className="text-sm font-mono" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Difficulty</Label>
                <Select value={form.difficulty ?? ""} onValueChange={v => setForm((f: any) => ({ ...f, difficulty: v }))}>
                  <SelectTrigger className="text-sm"><SelectValue placeholder="—" /></SelectTrigger>
                  <SelectContent>
                    {["beginner", "elementary", "intermediate", "advanced"].map(d => <SelectItem key={d} value={d} className="capitalize">{d}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {/* The explanation of the word, as opposed to its one-word
                  translation. The column and the API accepted it already; only
                  the form never offered anywhere to type it. */}
              <div className="col-span-2 md:col-span-4 space-y-1">
                <Label className="text-xs text-gray-500">Explanation / definition</Label>
                <Textarea
                  rows={2}
                  value={form.definition ?? ""}
                  onChange={e => setForm((f: any) => ({ ...f, definition: e.target.value }))}
                  placeholder="What the word means, in the student's own level of English"
                  className="text-sm"
                />
              </div>
              <div className="col-span-2 md:col-span-4">
                <TagsInput
                  value={form.tags}
                  suggestions={COMMON_TAGS}
                  onChange={tags => setForm((f: any) => ({ ...f, tags }))}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => createMut.mutate()} disabled={!form.word || !form.translation || !form.levelId}>Add Item</Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </div>
        )}

        {/* Search */}
        <div className="relative max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <Input placeholder="Search words…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} className="pl-8 text-sm" />
        </div>

        {/* Table */}
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          {isLoading ? (
            <div className="p-6 text-center text-gray-400 text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Word</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Translation</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden md:table-cell">PoS</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden lg:table-cell">Pronunciation</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden lg:table-cell">Categories</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.items ?? []).map((v: any) => (
                  <tr key={v.id} className="hover:bg-gray-50">
                    {editId === v.id ? (
                      <>
                        <td className="px-4 py-2 space-y-1">
                          <Input value={editForm.word} onChange={e => setEditForm((f: any) => ({ ...f, word: e.target.value }))} className="text-sm h-7" />
                          <Input value={editForm.definition ?? ""} placeholder="Explanation"
                            onChange={e => setEditForm((f: any) => ({ ...f, definition: e.target.value }))}
                            className="text-xs h-7" />
                        </td>
                        <td className="px-4 py-2"><Input dir="rtl" value={editForm.translation} onChange={e => setEditForm((f: any) => ({ ...f, translation: e.target.value }))} className="text-sm h-7" /></td>
                        <td className="px-4 py-2 hidden md:table-cell"><Input value={editForm.partOfSpeech ?? ""} onChange={e => setEditForm((f: any) => ({ ...f, partOfSpeech: e.target.value }))} className="text-sm h-7 w-24" /></td>
                        <td className="px-4 py-2 hidden lg:table-cell"><Input value={editForm.pronunciation ?? ""} onChange={e => setEditForm((f: any) => ({ ...f, pronunciation: e.target.value }))} className="text-sm h-7 font-mono" /></td>
                        <td className="px-4 py-2 hidden lg:table-cell">
                          <TagsInput label="" value={editForm.tags} suggestions={COMMON_TAGS}
                            onChange={tags => setEditForm((f: any) => ({ ...f, tags }))} />
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button onClick={() => updateMut.mutate({ id: v.id, data: editForm })} className="p-1 rounded hover:bg-green-50 text-green-600"><Check className="h-3.5 w-3.5" /></button>
                          <button onClick={() => setEditId(null)} className="p-1 rounded hover:bg-red-50 text-red-400 ml-1"><X className="h-3.5 w-3.5" /></button>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-gray-800">{v.word}</div>
                          {v.definition && (
                            <div className="text-xs text-gray-500 mt-0.5">{v.definition}</div>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-gray-600">{v.translation}</td>
                        <td className="px-4 py-2.5 hidden md:table-cell text-gray-400 text-xs capitalize">{v.part_of_speech ?? "—"}</td>
                        <td className="px-4 py-2.5 hidden lg:table-cell font-mono text-gray-400 text-xs">{v.pronunciation ?? "—"}</td>
                        <td className="px-4 py-2.5 hidden lg:table-cell">
                          <div className="flex flex-wrap gap-1">
                            {(v.tags ?? []).length === 0
                              ? <span className="text-xs text-gray-300">—</span>
                              : (v.tags as string[]).map(t => (
                                  <span key={t} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[11px] text-indigo-700">{t}</span>
                                ))}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {canEdit && <button onClick={() => { setEditId(v.id); setEditForm({ word: v.word, translation: v.translation, partOfSpeech: v.part_of_speech, pronunciation: v.pronunciation, exampleSentence: v.example_sentence, exampleSentenceAr: v.example_sentence_ar, definition: v.definition, tags: v.tags ?? [] }); }}
                            className="p-1 rounded hover:bg-gray-100 text-gray-500 mr-0.5"><Pencil className="h-3.5 w-3.5" /></button>}
                          {canEdit && <button onClick={() => { if (confirm(`Delete "${v.word}"?`)) deleteMut.mutate(v.id); }}
                            className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>Previous</Button>
              <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</Button>
            </div>
          </div>
        )}
      </div>
    </CMSLayout>
  );
}
