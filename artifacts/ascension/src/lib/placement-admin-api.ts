/**
 * Reviewing and overriding a student's placement (spec section 2).
 *
 * Hand-written for the same reason as the other admin clients here: not in
 * `openapi.yaml`.
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class PlacementAdminError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PlacementAdminError";
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
    let payload: { error?: string } = {};
    try {
      payload = await r.json();
    } catch {
      // Non-JSON body; the status is all there is.
    }
    throw new PlacementAdminError(payload.error ?? `${method} ${path} → ${r.status}`, r.status);
  }
  return r.json();
}

export interface PlacementLevel {
  id: number;
  code: string;
  name: string;
  nameAr: string;
}

export interface PlacementRecord {
  completedAt: string;
  score: number;
  total: number;
  percentage: number;
  assignedLevelCode: string;
  /** What the arithmetic produced before any AI adjustment. */
  computedLevelCode: string | null;
  adjustmentReason: string | null;
  skillScores: Record<string, number> | null;
  strengths: string[] | null;
  weaknesses: string[] | null;
  analysisAr: string | null;
  writingSample: string | null;
  writingScore: number | null;
}

export interface ProgressionEntry {
  id: number;
  reason: "placement" | "evaluation" | "admin_override";
  note: string | null;
  createdAt: string;
  fromLevel: PlacementLevel | null;
  toLevel: PlacementLevel | null;
}

export interface PlacementReview {
  placement: PlacementRecord | null;
  currentLevelId: number | null;
  placementCompleted: boolean;
  levels: PlacementLevel[];
  history: ProgressionEntry[];
}

export const getPlacementReview = (studentId: number) =>
  request<PlacementReview>("GET", `/admin/students/${studentId}/placement`);

/** A note is required — an unexplained level change is indistinguishable from a mistake. */
export const overrideLevel = (studentId: number, levelId: number, note: string) =>
  request<{ toLevelCode: string; toLevelNameAr: string }>(
    "POST",
    `/admin/students/${studentId}/level`,
    { levelId, note },
  );
