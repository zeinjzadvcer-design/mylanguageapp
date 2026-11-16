/**
 * Admin placement rules: read, preview and save. The server checks every rule
 * again; this is transport.
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export class PlacementRulesError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PlacementRulesError";
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
    throw new PlacementRulesError(message, r.status);
  }
  return (await r.json()) as T;
}

export const DIFFICULTIES = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export interface PlacementRules {
  difficultyWeights: Record<Difficulty, number>;
  /** Lowest weighted score per level code; null: never assigned. */
  levelThresholds: Record<string, number | null>;
  writingWeight: number;
  weakBelow: number;
  strongAt: number;
}

export interface PlacementRulesState {
  rules: PlacementRules;
  defaults: PlacementRules;
  levelCodes: string[];
  updatedAt: string | null;
  updatedByName: string | null;
  aiAdjustmentEnabled: boolean;
  questions: { choice: number; written: number };
}

export interface PlacementScenario {
  key: string;
  overall: number;
  levelCode: string;
}

export const placementRulesApi = {
  get: () => request<PlacementRulesState>("GET", "/admin/placement-rules"),
  preview: (rules: PlacementRules, writingScore: number | null) =>
    request<{ problems: string[]; scenarios: PlacementScenario[] }>(
      "POST",
      "/admin/placement-rules/preview",
      { rules, writingScore },
    ),
  save: (rules: PlacementRules) =>
    request<{ rules: PlacementRules }>("PUT", "/admin/placement-rules", { rules }),
};
