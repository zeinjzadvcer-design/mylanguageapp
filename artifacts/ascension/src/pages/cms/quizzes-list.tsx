/**
 * Quizzes and level evaluations.
 *
 * The two live in one list on purpose: a level evaluation *is* a quiz with a
 * `kind` that gates promotion, and showing them separately would suggest two
 * different things to learn. The badge is what tells them apart.
 */

import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cmsApi, type CMSQuiz } from "@/lib/cms-api";
import { CMSLayout } from "@/components/cms-layout";
import { useCan } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Plus, GraduationCap, ListChecks, AlertCircle } from "lucide-react";

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-gray-100 text-gray-600",
  in_review: "bg-amber-100 text-amber-700",
  approved: "bg-blue-100 text-blue-700",
  published: "bg-emerald-100 text-emerald-700",
  archived: "bg-gray-100 text-gray-400",
};

export default function QuizzesList() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<string>("");
  const canEdit = useCan()("content.edit");
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [titleAr, setTitleAr] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["cms-quizzes", status],
    queryFn: () => cmsApi.quizzes.list(status || undefined),
  });

  const createMut = useMutation({
    mutationFn: () => cmsApi.quizzes.create({ title, titleAr }),
    onSuccess: (quiz) => {
      qc.invalidateQueries({ queryKey: ["cms-quizzes"] });
      setShowForm(false);
      setTitle("");
      setTitleAr("");
      // Straight into the editor: a quiz with no blocks cannot be published,
      // so the list is never where the work happens.
      setLocation(`/cms/quizzes/${quiz.id}`);
    },
    onError: (e: Error) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const quizzes = data?.quizzes ?? [];

  return (
    <CMSLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Quizzes &amp; Evaluations</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Practice quizzes, and the evaluations that gate a student's level
            </p>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setShowForm((f) => !f)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New Quiz
            </Button>
          )}
        </div>

        <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-xs text-indigo-700 flex gap-2">
          <AlertCircle className="h-4 w-4 shrink-0 mt-px" />
          <span>
            A <strong>level evaluation</strong> is the test a student must pass to move up.
            Set its kind and level in the editor. A level can have only one published
            evaluation at a time.
          </span>
        </div>

        {showForm && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">New quiz</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Title (English) *</Label>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-gray-500">Title (Arabic) *</Label>
                <Input
                  value={titleAr}
                  onChange={(e) => setTitleAr(e.target.value)}
                  className="text-sm"
                  dir="rtl"
                />
              </div>
            </div>
            <p className="text-xs text-gray-500">
              Everything else — kind, level, passing score, questions — is set in the editor.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => createMut.mutate()}
                disabled={!title.trim() || !titleAr.trim() || createMut.isPending}
              >
                Create &amp; edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="flex gap-1.5 flex-wrap">
          {["", "draft", "in_review", "approved", "published", "archived"].map((s) => (
            <button
              key={s || "all"}
              onClick={() => setStatus(s)}
              className={`text-xs px-2.5 py-1 rounded-md border ${
                status === s
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
              }`}
            >
              {s === "" ? "All" : s.replace("_", " ")}
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          {isLoading ? (
            <div className="p-6 text-center text-gray-400 text-sm">Loading…</div>
          ) : quizzes.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              No quizzes yet.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Kind</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Title</th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden md:table-cell">
                    Pass
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600 hidden lg:table-cell">
                    Questions
                  </th>
                  <th className="text-left px-4 py-2.5 font-medium text-gray-600">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {quizzes.map((q: CMSQuiz) => (
                  <tr key={q.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      {q.kind === "level_evaluation" ? (
                        <span
                          title="Passing this promotes the student"
                          className="inline-flex items-center gap-1 text-xs text-amber-700"
                        >
                          <GraduationCap className="h-3.5 w-3.5" /> evaluation
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                          <ListChecks className="h-3.5 w-3.5" /> practice
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link href={`/cms/quizzes/${q.id}`}>
                        <span className="font-medium text-gray-800 hover:text-indigo-600 cursor-pointer">
                          {q.title}
                        </span>
                      </Link>
                      <div className="text-xs text-gray-400" dir="rtl">
                        {q.titleAr}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 hidden md:table-cell text-gray-500 text-xs">
                      {q.passingScore}%
                    </td>
                    <td className="px-4 py-2.5 hidden lg:table-cell text-gray-500 text-xs">
                      {q.blockCount ?? "—"}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          STATUS_STYLES[q.status] ?? "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {q.status.replace("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </CMSLayout>
  );
}
