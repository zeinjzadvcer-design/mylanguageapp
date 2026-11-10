import { useState, type FormEvent } from "react";
import {
  useCreateStaffAccount,
  useListStaffAccounts,
  useRevokeStaffAccess,
  useSetStaffPassword,
  useUpdateStaffRole,
  type StaffMember,
  type StaffRoleOption,
} from "@workspace/api-client-react";
import { format } from "date-fns";
import { Loader2, UserPlus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/lib/i18n";

type ApiErr = {
  data?: { error?: string; code?: string; details?: { message: string }[] } | null;
};

/** The most specific thing the server said about a refusal. */
function serverMessage(err: unknown): string | undefined {
  const data = (err as ApiErr).data;
  return data?.details?.[0]?.message ?? data?.error;
}

export default function AdminStaff() {
  const { t, dateLocale, pick } = useI18n();
  const st = t.admin.staff;
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [passwordFor, setPasswordFor] = useState<StaffMember | null>(null);

  const { data, isLoading, error, refetch } = useListStaffAccounts();
  const updateRole = useUpdateStaffRole();
  const revoke = useRevokeStaffAccess();

  const refused = (err: unknown) =>
    toast({ variant: "destructive", title: st.failed, description: serverMessage(err) });

  const changeRole = (member: StaffMember, role: string) =>
    updateRole.mutate(
      { id: member.id, data: { role } },
      {
        onSuccess: () => {
          toast({ title: st.roleChanged });
          void refetch();
        },
        onError: refused,
      },
    );

  const removeAccess = (member: StaffMember) =>
    revoke.mutate(
      { id: member.id },
      {
        onSuccess: () => {
          toast({ title: st.revoked });
          void refetch();
        },
        onError: refused,
      },
    );

  if (isLoading) {
    return (
      <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
        <Skeleton className="h-10 w-48 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }

  if (error || !data) {
    return <div className="p-8 text-center text-destructive">{st.loadError}</div>;
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">{st.title}</h1>
          <p className="text-muted-foreground mt-1">{st.subtitle}</p>
        </div>
        <Button className="gap-2" onClick={() => setAdding(true)}>
          <UserPlus className="h-4 w-4" />
          {st.add}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-start">{st.name}</TableHead>
                <TableHead className="text-start">{st.email}</TableHead>
                <TableHead className="text-start">{st.role}</TableHead>
                <TableHead className="text-start">{st.added}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.staff.map((member) => (
                <TableRow key={member.id}>
                  <TableCell className="font-medium">{member.name}</TableCell>
                  <TableCell className="text-muted-foreground font-mono" dir="ltr">
                    {member.email}
                  </TableCell>
                  <TableCell>
                    {member.editable ? (
                      <Select
                        value={member.role}
                        disabled={updateRole.isPending}
                        onValueChange={(role) => changeRole(member, role)}
                      >
                        <SelectTrigger className="w-52" aria-label={st.role}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {data.roles.map((option) => (
                            <SelectItem key={option.role} value={option.role}>
                              {pick(option.labelAr, option.label)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="secondary">{pick(member.roleLabelAr, member.roleLabel)}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {format(new Date(member.createdAt), "d MMM yyyy", { locale: dateLocale })}
                  </TableCell>
                  <TableCell className="text-end">
                    {member.editable && (
                      <Button variant="ghost" size="sm" onClick={() => setPasswordFor(member)}>
                        {st.setPassword}
                      </Button>
                    )}
                    {member.editable ? (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="sm" className="text-destructive">
                            {st.revoke}
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{st.revokeTitle(member.name)}</AlertDialogTitle>
                            <AlertDialogDescription>{st.revokeBody}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{st.cancel}</AlertDialogCancel>
                            <AlertDialogAction onClick={() => removeAccess(member)}>
                              {st.revoke}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    ) : (
                      <span className="text-xs text-muted-foreground">{st.admin}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {data.staff.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    {st.empty}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {passwordFor && (
        <SetPasswordDialog member={passwordFor} onClose={() => setPasswordFor(null)} />
      )}

      {adding && (
        <AddStaffDialog
          roles={data.roles}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void refetch();
          }}
        />
      )}
    </div>
  );
}

function SetPasswordDialog({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const { t } = useI18n();
  const st = t.admin.staff;
  const { toast } = useToast();
  const change = useSetStaffPassword();
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    change.mutate(
      { id: member.id, data: { password } },
      {
        onSuccess: () => {
          toast({ title: st.passwordChanged });
          onClose();
        },
        onError: (err) => setProblem(serverMessage(err) ?? st.failed),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{st.setPasswordTitle(member.name)}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="staff-new-password">{st.password}</Label>
            <PasswordInput
              id="staff-new-password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {problem && (
            <p role="alert" className="rounded-lg bg-destructive/10 text-destructive text-sm p-3">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {st.cancel}
            </Button>
            <Button type="submit" disabled={change.isPending}>
              {st.setPassword}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddStaffDialog({
  roles,
  onClose,
  onCreated,
}: {
  roles: StaffRoleOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t, pick } = useI18n();
  const st = t.admin.staff;
  const { toast } = useToast();
  const create = useCreateStaffAccount();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState(roles[0]?.role ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [canPromote, setCanPromote] = useState(false);

  const selected = roles.find((r) => r.role === role);

  const submit = (promoteExisting: boolean) => {
    setProblem(null);
    create.mutate(
      {
        data: {
          name,
          email,
          role,
          ...(promoteExisting ? { promoteExisting: true } : { password }),
        },
      },
      {
        onSuccess: () => {
          toast({ title: st.created });
          onCreated();
        },
        onError: (err) => {
          const code = (err as ApiErr).data?.code;
          setCanPromote(code === "EMAIL_IS_STUDENT");
          setProblem(
            code === "EMAIL_IS_STUDENT"
              ? st.isStudent
              : code === "ALREADY_STAFF"
                ? st.alreadyStaff
                : (serverMessage(err) ?? st.failed),
          );
        },
      },
    );
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(false);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{st.add}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="staff-name">{st.name}</Label>
            <Input id="staff-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="staff-email">{st.email}</Label>
            <Input
              id="staff-email"
              type="email"
              dir="ltr"
              autoComplete="off"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setCanPromote(false);
                setProblem(null);
              }}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label>{st.role}</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger aria-label={st.role}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((option) => (
                  <SelectItem key={option.role} value={option.role}>
                    {pick(option.labelAr, option.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && (
              <p className="text-sm text-muted-foreground">
                {pick(selected.descriptionAr, selected.description)}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="staff-password">{st.password}</Label>
            <PasswordInput
              id="staff-password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">{st.passwordHint}</p>
          </div>

          {problem && (
            <div role="alert" className="rounded-lg bg-destructive/10 text-destructive text-sm p-3 space-y-2">
              <p>{problem}</p>
              {canPromote && (
                <Button type="button" size="sm" disabled={create.isPending} onClick={() => submit(true)}>
                  {st.promote}
                </Button>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {st.cancel}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin me-2" />}
              {st.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
