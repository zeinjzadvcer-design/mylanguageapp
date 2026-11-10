import { useEffect } from "react";
import { useLocation, Route } from "wouter";
import { useGetMe, type Permission } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { AppLayout } from "./layout";
import { holds, refusedPath, usesStudentApp } from "@/lib/permissions";

export function ProtectedRoute({
  component: Component,
  permission,
  cms,
  path,
}: {
  component: any;
  /** Who may open it. A page with none is part of the student app. */
  permission?: Permission;
  /** The page brings its own layout (CMSLayout). */
  cms?: boolean;
  path: string;
}) {
  const { data: user, isLoading, error } = useGetMe();
  const [, setLocation] = useLocation();

  const allowed =
    !!user && (permission ? holds(user, permission) : usesStudentApp(user));

  useEffect(() => {
    if (isLoading) return;
    if (error || !user) setLocation("/login");
    else if (!allowed) setLocation(refusedPath(user));
  }, [isLoading, error, user, allowed, setLocation]);

  if (isLoading || !user) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!allowed) return null;

  if (cms) {
    return (
      <Route path={path}>
        {(params) => <Component params={params} />}
      </Route>
    );
  }

  return (
    <Route path={path}>
      {(params) => (
        <AppLayout>
          <Component params={params} />
        </AppLayout>
      )}
    </Route>
  );
}
