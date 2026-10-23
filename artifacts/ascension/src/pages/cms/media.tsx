import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cmsApi } from "@/lib/cms-api";
import { CMSLayout } from "@/components/cms-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Music, Image, Video, File, Upload, Play, Loader2 } from "lucide-react";

/**
 * Tolerates a missing type rather than throwing.
 *
 * An unguarded `mimeType.startsWith` took the whole page down with "Cannot read
 * properties of undefined" the moment one row arrived without a type — which is
 * exactly what a field-name mismatch produces. A missing icon is a cosmetic
 * problem; a blank page is not.
 */
function MimeIcon({ mimeType }: { mimeType?: string | null }) {
  const type = mimeType ?? "";
  if (type.startsWith("audio/")) return <Music className="h-4 w-4 text-indigo-500" />;
  if (type.startsWith("image/")) return <Image className="h-4 w-4 text-emerald-500" />;
  if (type.startsWith("video/")) return <Video className="h-4 w-4 text-orange-500" />;
  return <File className="h-4 w-4 text-gray-400" />;
}

export default function MediaPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<any>({ mimeType: "audio/mpeg" });

  const { data, isLoading } = useQuery({
    queryKey: ["cms-media", page],
    queryFn: () => cmsApi.media.list(page),
    placeholderData: (prev: any) => prev,
  });

  const createMut = useMutation({
    mutationFn: () => cmsApi.media.create(form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-media"] }); setForm({ mimeType: "audio/mpeg" }); setShowForm(false); toast({ title: "Media reference registered" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => cmsApi.media.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["cms-media"] }); toast({ title: "Deleted" }); },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  // ── Real file upload ────────────────────────────────────────────────────
  // The form below registers a key someone put in the bucket by hand. This
  // uploads the file itself, using the same three-step handshake the student
  // recorder uses: the server signs a PUT, the browser sends the bytes straight
  // to storage, and the server confirms they landed.
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadStage, setUploadStage] = useState<string | null>(null);

  const uploadMut = useMutation({
    mutationFn: (file: File) => cmsApi.media.upload(file, (stage) => setUploadStage(stage)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cms-media"] });
      toast({ title: "Uploaded" });
    },
    onError: (e: any) =>
      toast({
        title: "Upload failed",
        // 503 means storage is not configured on this deployment — a different
        // problem from a rejected file, and worth saying so.
        description: e.message,
        variant: "destructive",
      }),
    onSettled: () => {
      setUploadStage(null);
      if (fileInput.current) fileInput.current.value = "";
    },
  });

  const [preview, setPreview] = useState<{ id: number; url: string } | null>(null);
  const previewMut = useMutation({
    mutationFn: (id: number) => cmsApi.media.playbackUrl(id).then((r) => ({ id, url: r.url })),
    onSuccess: (r) => setPreview(r),
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalPages = data ? Math.ceil(data.total / 30) : 1;

  return (
    <CMSLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Media Assets</h1>
            <p className="text-sm text-gray-500 mt-0.5">Audio, image, and video references</p>
          </div>
          <div className="flex gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="audio/*,image/*,video/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadMut.mutate(file);
              }}
            />
            <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploadMut.isPending}>
              {uploadMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5 mr-1" />
              )}
              {uploadStage ? `${uploadStage}…` : "Upload File"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowForm(f => !f)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Register Key
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-xs text-indigo-700">
          <strong>Upload File</strong> sends the file straight to object storage and registers
          it here. <strong>Register Key</strong> is for a file already in the bucket, put
          there some other way. Uploading needs storage configured on the API server.
        </div>

        {preview && (
          <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-gray-600">Preview</span>
              <button
                onClick={() => setPreview(null)}
                className="text-xs text-gray-400 hover:text-gray-700"
              >
                Close
              </button>
            </div>
            <audio controls src={preview.url} className="w-full" />
            <p className="text-xs text-gray-400">
              This link is short-lived and only works for signed-in staff.
            </p>
          </div>
        )}

        {showForm && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">Register Media Reference</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1 col-span-2">
                <Label className="text-xs text-gray-500">Storage Key / URL *</Label>
                <Input value={form.key ?? ""} onChange={e => setForm((f: any) => ({ ...f, key: e.target.value }))} placeholder="audio/lessons/a1-1-intro.mp3 or https://…" className="text-sm font-mono" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Original Filename</Label>
                <Input value={form.originalName ?? ""} onChange={e => setForm((f: any) => ({ ...f, originalName: e.target.value }))} className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">MIME Type *</Label>
                <Input value={form.mimeType ?? ""} onChange={e => setForm((f: any) => ({ ...f, mimeType: e.target.value }))} placeholder="audio/mpeg, image/png…" className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Language</Label>
                <Input value={form.language ?? ""} onChange={e => setForm((f: any) => ({ ...f, language: e.target.value }))} placeholder="en" className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Speaker / Artist</Label>
                <Input value={form.speaker ?? ""} onChange={e => setForm((f: any) => ({ ...f, speaker: e.target.value }))} className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Duration (seconds)</Label>
                <Input type="number" value={form.durationSec ?? ""} onChange={e => setForm((f: any) => ({ ...f, durationSec: parseFloat(e.target.value) }))} className="text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Transcript</Label>
                <Input value={form.transcript ?? ""} onChange={e => setForm((f: any) => ({ ...f, transcript: e.target.value }))} className="text-sm" />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => createMut.mutate()} disabled={!form.key || !form.mimeType}>Register</Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          {isLoading ? (
            <div className="p-6 text-center text-gray-400 text-sm">Loading…</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Type</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Key</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden md:table-cell">MIME</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden lg:table-cell">Language</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden lg:table-cell">Added</th>
                  <th className="text-right px-4 py-2.5 font-medium text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(data?.items ?? []).map((m: any) => (
                  <tr key={m.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5"><MimeIcon mimeType={m.mimeType} /></td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-600 max-w-xs truncate">{m.key}</td>
                    <td className="px-4 py-2.5 hidden md:table-cell text-gray-400 text-xs">{m.mimeType ?? "—"}</td>
                    <td className="px-4 py-2.5 hidden lg:table-cell text-gray-400 text-xs">{m.language ?? "—"}</td>
                    <td className="px-4 py-2.5 hidden lg:table-cell text-gray-400 text-xs">{m.createdAt ? new Date(m.createdAt).toLocaleDateString() : "—"}</td>
                    <td className="px-4 py-2.5 text-right">
                      {String(m.mimeType ?? "").startsWith("audio/") && (
                        <button
                          onClick={() => previewMut.mutate(m.id)}
                          title="Listen"
                          className="p-1 rounded hover:bg-indigo-50 text-indigo-400"
                        >
                          <Play className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button onClick={() => { if (confirm("Delete this reference?")) deleteMut.mutate(m.id); }}
                        className="p-1 rounded hover:bg-red-50 text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
                    </td>
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
