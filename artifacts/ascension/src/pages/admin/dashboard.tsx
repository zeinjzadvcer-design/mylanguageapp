import { Link } from "wouter";
import { useGetAdminStats } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Users, CreditCard, BookOpen, TrendingUp, ChevronLeft } from "lucide-react";

export default function AdminDashboard() {
  const { data: stats, isLoading, error } = useGetAdminStats();

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <div className="grid md:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-32 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="p-8 text-center text-destructive">
        حدث خطأ أثناء تحميل إحصائيات الإدارة
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold text-foreground">لوحة الإدارة</h1>
        <p className="text-muted-foreground mt-2">
          نظرة عامة على أداء المنصة والطلاب.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-100 shadow-sm">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                <Users className="h-5 w-5 text-blue-600" />
              </div>
            </div>
            <div className="text-3xl font-bold text-blue-700">{stats.totalStudents}</div>
            <p className="text-sm font-medium text-blue-600/80">إجمالي الطلاب</p>
            {stats.newStudentsThisWeek && (
              <p className="text-xs text-blue-600 mt-2 font-bold">+{stats.newStudentsThisWeek} هذا الأسبوع</p>
            )}
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-100 shadow-sm">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center">
                <CreditCard className="h-5 w-5 text-emerald-600" />
              </div>
            </div>
            <div className="text-3xl font-bold text-emerald-700">{stats.activeSubscriptions}</div>
            <p className="text-sm font-medium text-emerald-600/80">الاشتراكات النشطة</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-fuchsia-50 border-purple-100 shadow-sm">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 rounded-full bg-purple-100 flex items-center justify-center">
                <BookOpen className="h-5 w-5 text-purple-600" />
              </div>
            </div>
            <div className="text-3xl font-bold text-purple-700">{stats.lessonsCompleted}</div>
            <p className="text-sm font-medium text-purple-600/80">الدروس المنجزة</p>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-amber-50 to-orange-50 border-amber-100 shadow-sm">
          <CardContent className="p-6">
            <div className="flex justify-between items-start mb-4">
              <div className="h-10 w-10 rounded-full bg-amber-100 flex items-center justify-center">
                <TrendingUp className="h-5 w-5 text-amber-600" />
              </div>
            </div>
            <div className="text-3xl font-bold text-amber-700" dir="ltr">{stats.avgScore}%</div>
            <p className="text-sm font-medium text-amber-600/80">متوسط العلامات</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <Card className="hover:border-primary/50 transition-colors">
          <Link href="/admin/students" className="block h-full">
            <CardHeader>
              <CardTitle className="flex justify-between items-center text-xl">
                <span>إدارة الطلاب</span>
                <ChevronLeft className="h-5 w-5 text-muted-foreground" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">استعرض قائمة الطلاب، وحالة اشتراكاتهم، ومستوى تقدمهم.</p>
            </CardContent>
          </Link>
        </Card>

        <Card className="hover:border-primary/50 transition-colors">
          <Link href="/admin/lessons" className="block h-full">
            <CardHeader>
              <CardTitle className="flex justify-between items-center text-xl">
                <span>إدارة المنهج والدروس</span>
                <ChevronLeft className="h-5 w-5 text-muted-foreground" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">استعرض الدروس الحالية، وقم بتعديل أو إضافة محتوى جديد للمنهج.</p>
            </CardContent>
          </Link>
        </Card>

        <Card className="hover:border-primary/50 transition-colors">
          <Link href="/admin/payments" className="block h-full">
            <CardHeader>
              <CardTitle className="flex justify-between items-center text-xl">
                <span>المدفوعات والاشتراكات</span>
                <ChevronLeft className="h-5 w-5 text-muted-foreground" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">راجع إثباتات الدفع وفعّل الاشتراكات، وأعدّ حساب شام كاش ورمز الاستلام.</p>
            </CardContent>
          </Link>
        </Card>

        <Card className="hover:border-primary/50 transition-colors">
          <Link href="/admin/ai" className="block h-full">
            <CardHeader>
              <CardTitle className="flex justify-between items-center text-xl">
                <span>إعدادات الذكاء الاصطناعي</span>
                <ChevronLeft className="h-5 w-5 text-muted-foreground" />
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">المزوّد ومفتاح الـ API والنماذج والحدود اليومية لكل خطة — تُعدَّل مباشرة دون إعادة نشر.</p>
            </CardContent>
          </Link>
        </Card>
      </div>
    </div>
  );
}
