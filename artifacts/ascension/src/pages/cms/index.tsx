import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { cmsApi } from "@/lib/cms-api";
import { useCan } from "@/lib/permissions";
import { CMSLayout, StatusBadge } from "@/components/cms-layout";
import { Skeleton } from "@/components/ui/skeleton";

export default function CMSDashboard() {
  const can = useCan();
  const { data: stats, isLoading } = useQuery({
    queryKey: ["cms-stats"],
    queryFn: () => cmsApi.stats(),
  });

  return (
    <CMSLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">CMS Dashboard</h1>
          <p className="text-gray-500 text-sm mt-1">Content management overview</p>
        </div>

        {isLoading && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-lg" />
            ))}
          </div>
        )}

        {stats && (
          <>
            {/* Lesson status grid */}
            <div>
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Lessons by Status</h2>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {[
                  { key: "draft", label: "Draft", color: "bg-gray-50 border-gray-200" },
                  { key: "in_review", label: "In Review", color: "bg-yellow-50 border-yellow-200" },
                  { key: "approved", label: "Approved", color: "bg-blue-50 border-blue-200" },
                  { key: "published", label: "Published", color: "bg-green-50 border-green-200" },
                  { key: "archived", label: "Archived", color: "bg-red-50 border-red-200" },
                ].map(s => (
                  <Link key={s.key} href={`/cms/lessons?status=${s.key}`} className={`block rounded-lg border p-4 hover:shadow-sm transition-shadow ${s.color}`}>
                    <div className="text-2xl font-bold text-gray-900">{stats.lessons[s.key as keyof typeof stats.lessons]}</div>
                    <div className="text-xs text-gray-600 mt-0.5">{s.label}</div>
                  </Link>
                ))}
              </div>
            </div>

            {/* Catalog counts */}
            <div>
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Catalog</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: "Languages", value: stats.languages, href: "/cms/languages", catalog: true },
                  { label: "Curricula", value: stats.curricula, href: "/cms/curricula", catalog: true },
                  { label: "Levels", value: stats.levels, href: "/cms/levels", catalog: true },
                  { label: "Vocabulary", value: stats.vocabulary, href: "/cms/vocabulary", catalog: false },
                ].filter(c => !c.catalog || can("catalog.manage")).map(c => (
                  <Link key={c.label} href={c.href} className="block rounded-lg border border-gray-200 bg-white p-4 hover:border-indigo-300 transition-colors">
                    <div className="text-2xl font-bold text-gray-900">{c.value}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{c.label}</div>
                  </Link>
                ))}
              </div>
            </div>

            {/* Recently modified lessons */}
            {stats.recentLessons.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold text-gray-700 mb-3">Recently Modified</h2>
                <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
                  {stats.recentLessons.map(l => (
                    <Link key={l.id} href={`/cms/lessons/${l.id}/edit`} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{l.title}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {l.updatedAt ? new Date(l.updatedAt).toLocaleDateString() : ""}
                        </div>
                      </div>
                      <StatusBadge status={l.status} />
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </CMSLayout>
  );
}
