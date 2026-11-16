/**
 * Admin announcements: who they can reach, a count before sending, and the
 * record of what was sent. The server enforces every rule; this is transport.
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class AnnouncementsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AnnouncementsError";
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let message = `Request failed (${r.status})`;
    try {
      message = ((await r.json()) as { error?: string }).error ?? message;
    } catch {
      // Not JSON; the status will have to do.
    }
    throw new AnnouncementsError(message, r.status);
  }
  return (await r.json()) as T;
}

/** Every student, or only those on these plans ("free" included). */
export type Audience = { kind: "all" } | { kind: "plans"; planCodes: string[] };

export interface AudiencePlan {
  code: string;
  name: string;
  nameAr: string;
  /** "general" or "professional". The free plan is "general". */
  track: string;
}

export interface SentAnnouncement {
  id: number;
  title: string | null;
  titleAr: string | null;
  body: string | null;
  bodyAr: string | null;
  link: string | null;
  /** Null means every student. */
  planCodes: string[] | null;
  recipientCount: number;
  createdAt: string;
  sentByName: string | null;
}

export interface NewAnnouncement {
  title: string | null;
  titleAr: string | null;
  body: string | null;
  bodyAr: string | null;
  link: string | null;
  audience: Audience;
}

export const announcementsApi = {
  list: () => request<{ items: SentAnnouncement[]; plans: AudiencePlan[] }>("GET", "/admin/announcements"),
  preview: (audience: Audience) =>
    request<{ recipients: number }>("POST", "/admin/announcements/preview", { audience }),
  send: (input: NewAnnouncement) =>
    request<{ id: number; recipients: number }>("POST", "/admin/announcements", input),
};
