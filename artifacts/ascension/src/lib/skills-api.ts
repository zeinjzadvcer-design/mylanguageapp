/**
 * The student's skill profile.
 *
 * Hand-written for the same reason as the other clients here: not in
 * `openapi.yaml`.
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export type Skill =
  | "pronunciation"
  | "fluency"
  | "vocabulary"
  | "grammar"
  | "comprehension"
  | "writing"
  | "speaking";

export type Confidence = "none" | "low" | "medium" | "high";
export type Trend = "improving" | "steady" | "declining" | "unknown";

export interface SkillSummary {
  skill: Skill;
  score: number | null;
  sampleCount: number;
  confidence: Confidence;
  trend: Trend;
  lastObservedAt: string | null;
}

export interface Recommendation {
  kind: "reread_lesson" | "repeat_pronunciation" | "practise_words" | "redo_lesson";
  skill: Skill;
  lessonId: number | null;
  lessonTitle: string | null;
  lessonTitleAr: string | null;
  words?: string[];
  reasonAr: string;
}

export interface SkillReport {
  profile: {
    skills: SkillSummary[];
    strengths: Skill[];
    weaknesses: Skill[];
    totalEvidence: number;
  };
  focus: Skill | null;
  recommendations: Recommendation[];
  advice: string | null;
  /** True when there is too little history to say anything useful. */
  insufficientEvidence: boolean;
}

export async function getSkillReport(withAdvice = false): Promise<SkillReport> {
  const r = await fetch(`${base()}/review/skills${withAdvice ? "?advice=true" : ""}`, {
    credentials: "include",
  });
  if (!r.ok) throw new Error(`skills → ${r.status}`);
  return r.json();
}
