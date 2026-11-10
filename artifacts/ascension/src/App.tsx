import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ProtectedRoute } from '@/components/protected-route';
import { ServerWakeBanner } from '@/components/server-wake-banner';
import { I18nProvider } from '@/lib/i18n';

import Landing from '@/pages/landing';
import Login from '@/pages/login';
import Register from '@/pages/register';
import Dashboard from '@/pages/dashboard';
import Placement from '@/pages/placement';
import Learn from '@/pages/learn';
import Level from '@/pages/level';
import Lesson from '@/pages/lesson';
import Quiz from '@/pages/quiz';
import Quizzes from '@/pages/quizzes';
import { ForgotPassword, ResetPassword } from '@/pages/password-reset';
import Vocabulary from '@/pages/vocabulary';
import Practice from '@/pages/practice';
import Subscription from '@/pages/subscription';
import Profile from '@/pages/profile';
import AdminDashboard from '@/pages/admin/dashboard';
import AdminStudents from '@/pages/admin/students';
import AdminLessons from '@/pages/admin/lessons';
import AdminAiSettings from '@/pages/admin/ai-settings';
import AdminPayments from '@/pages/admin/payments';
import AdminStaff from '@/pages/admin/staff';

// CMS pages
import CMSDashboard from '@/pages/cms/index';
import CMSLessonsList from '@/pages/cms/lessons-list';
import LessonEditor from '@/pages/cms/lesson-editor';
import LessonPreviewPage from '@/pages/cms/lesson-preview';
import { LanguagesPage, CurriculaPage, LevelsPage } from '@/pages/cms/catalog';
import VocabularyPage from '@/pages/cms/vocabulary';
import CMSPlacement from '@/pages/cms/placement';
import MediaPage from '@/pages/cms/media';
import ReviewsPage from '@/pages/cms/reviews';
import CMSQuizzesList from '@/pages/cms/quizzes-list';
import CMSGradingQueue from '@/pages/cms/grading';
import CMSQuizEditor from '@/pages/cms/quiz-editor';
import AuditLogPage from '@/pages/cms/audit';
import CMSPracticeReports from '@/pages/cms/practice-reports';

/**
 * A 4xx is an answer, not a failure.
 *
 * TanStack Query retries three times with backoff by default, which is right
 * for a dropped connection and wrong for a verdict: a 403 from the paywall or
 * a 404 for a missing lesson is as true on the fourth attempt as the first.
 * Retrying them spent about seven seconds re-asking a settled question, and
 * the student watched a loading skeleton the whole time before being told
 * their free lesson was used.
 *
 * So client errors (except 408 and 429, which genuinely mean "try again")
 * surface immediately, and everything else keeps the default retries.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        const status = (error as { status?: number } | null)?.status;
        if (status != null && status >= 400 && status < 500) {
          return status === 408 || status === 429 ? failureCount < 2 : false;
        }
        return failureCount < 3;
      },
    },
    mutations: {
      // Mutations are not retried at all by default; a failed POST may have
      // been applied, and re-sending a payment submission is worse than
      // showing the error.
      retry: false,
    },
  },
});

/** Adapter: pulls route param and passes to component as a plain prop */
function LessonEditorRoute({ params }: { params: { id?: string } }) {
  const id = params.id ? parseInt(params.id) : undefined;
  return <LessonEditor lessonId={id} />;
}

function LessonPreviewRoute({ params }: { params: { id: string } }) {
  return <LessonPreviewPage lessonId={parseInt(params.id)} />;
}

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/login" component={Login} />
        <Route path="/register" component={Register} />
        <Route path="/forgot-password" component={ForgotPassword} />
        <Route path="/reset-password" component={ResetPassword} />

        {/* Student routes */}
        <ProtectedRoute path="/dashboard" component={Dashboard} />
        <ProtectedRoute path="/placement" component={Placement} />
        <ProtectedRoute path="/learn" component={Learn} />
        <ProtectedRoute path="/learn/:levelId" component={Level} />
        <ProtectedRoute path="/lesson/:lessonId" component={Lesson} />
        <ProtectedRoute path="/quiz/:quizId" component={Quiz} />
        <ProtectedRoute path="/quizzes" component={Quizzes} />
        <ProtectedRoute path="/vocabulary" component={Vocabulary} />
        <ProtectedRoute path="/practice" component={Practice} />
        <ProtectedRoute path="/subscription" component={Subscription} />
        <ProtectedRoute path="/profile" component={Profile} />

        {/* Admin routes */}
        <ProtectedRoute path="/admin" component={AdminDashboard} permission="students.manage" />
        <ProtectedRoute path="/admin/students" component={AdminStudents} permission="students.manage" />
        <ProtectedRoute path="/admin/lessons" component={AdminLessons} permission="content.publish" />
        <ProtectedRoute path="/admin/ai" component={AdminAiSettings} permission="settings.manage" />
        <ProtectedRoute path="/admin/payments" component={AdminPayments} permission="payments.review" />
        <ProtectedRoute path="/admin/staff" component={AdminStaff} permission="staff.manage" />

        {/* CMS routes */}
        <ProtectedRoute path="/cms" component={CMSDashboard} permission="content.view" cms />
        <ProtectedRoute path="/cms/lessons" component={CMSLessonsList} permission="content.view" cms />
        <ProtectedRoute path="/cms/lessons/new" component={LessonEditorRoute} permission="content.edit" cms />
        <ProtectedRoute path="/cms/lessons/:id/edit" component={LessonEditorRoute} permission="content.view" cms />
        <ProtectedRoute path="/cms/lessons/:id/preview" component={LessonPreviewRoute} permission="content.view" cms />
        <ProtectedRoute path="/cms/languages" component={LanguagesPage} permission="catalog.manage" cms />
        <ProtectedRoute path="/cms/curricula" component={CurriculaPage} permission="catalog.manage" cms />
        <ProtectedRoute path="/cms/levels" component={LevelsPage} permission="catalog.manage" cms />
        <ProtectedRoute path="/cms/quizzes" component={CMSQuizzesList} permission="content.view" cms />
        <ProtectedRoute path="/cms/quizzes/:id" component={CMSQuizEditor} permission="content.view" cms />
        <ProtectedRoute path="/cms/placement" component={CMSPlacement} permission="content.view" cms />
        <ProtectedRoute path="/cms/vocabulary" component={VocabularyPage} permission="content.view" cms />
        <ProtectedRoute path="/cms/media" component={MediaPage} permission="content.view" cms />
        <ProtectedRoute path="/cms/grading" component={CMSGradingQueue} permission="grading.manage" cms />
        <ProtectedRoute path="/cms/practice-reports" component={CMSPracticeReports} permission="practice_reports.manage" cms />
        <ProtectedRoute path="/cms/reviews" component={ReviewsPage} permission="content.view" cms />
        <ProtectedRoute path="/cms/audit" component={AuditLogPage} permission="content.view" cms />

        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster />
          <ServerWakeBanner />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

export default App;
