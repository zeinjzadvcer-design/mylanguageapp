/**
 * Working out where a new student belongs.
 *
 * Spec section 2: assess across skills, determine an approximate starting
 * level, and identify strengths, weaknesses and where to put effort.
 *
 * WHY THE LEVEL IS ARITHMETIC
 * ────────────────────────────
 * The spec says the AI determines the level. Taken literally that would mean a
 * model's unaudited guess decides which lessons a student can reach — a number
 * that changes between runs, cannot be explained to the student, and cannot be
 * defended when they ask why they were put in A1 and their friend in B1.
 *
 * So the level is computed here from the answers, and the model is given a
 * bounded say: it may move the result by at most one sub-level, and only with a
 * stated reason that is recorded. That keeps what the spec is reaching for — a
 * judgement that accounts for an uneven profile — without letting a
 * hallucination put a beginner in C2.
 *
 * WHAT DIFFICULTY IS FOR
 * ───────────────────────
 * Percentage correct alone cannot separate a strong beginner from a weak
 * intermediate: both score around half. Weighting each question by the level it
 * was written for can — getting the B2 questions right means something that
 * getting more A1 questions right does not.
 */

export const PLACEMENT_SKILLS = [
  "reading",
  "listening",
  "vocabulary",
  "grammar",
  "comprehension",
  "writing",
] as const;

export type PlacementSkill = (typeof PLACEMENT_SKILLS)[number];

export type Difficulty = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

/** One answered question. */
export interface AnsweredQuestion {
  skill: PlacementSkill;
  difficulty: Difficulty;
  correct: boolean;
}

export interface SkillScore {
  skill: PlacementSkill;
  /** 0–100, or null when the test asked nothing about this skill. */
  score: number | null;
  answered: number;
}

export interface PlacementOutcome {
  /** 0–100 overall, weighted by question difficulty. */
  overall: number;
  skills: SkillScore[];
  /** Band the student placed into, e.g. "A2". */
  band: Difficulty;
  /** Which half of the band — 1 or 2. */
  half: 1 | 2;
  /** e.g. "A2.1". */
  levelCode: string;
  strengths: PlacementSkill[];
  weaknesses: PlacementSkill[];
}

/**
 * What a question is worth.
 *
 * A correct B2 answer is evidence of more than a correct A1 answer, so it
 * counts for more. The steps are deliberately gentle: making the hard questions
 * worth many times the easy ones would let two lucky guesses at the end
 * dominate everything before them.
 */
const DIFFICULTY_WEIGHT: Record<Difficulty, number> = {
  A1: 1.0,
  A2: 1.3,
  B1: 1.7,
  B2: 2.2,
  C1: 2.8,
  C2: 3.5,
};

const BANDS: Difficulty[] = ["A1", "A2", "B1", "B2", "C1", "C2"];

/**
 * Where a weighted score places a student.
 *
 * The top of the scale is deliberately unreachable from a short test. A
 * twenty-question quiz is not evidence that someone belongs in C2, and placing
 * them there would strand them in material they cannot follow with no way back
 * but an administrator. Under-placing is recoverable — they pass the level
 * evaluation quickly and move up. Over-placing is not.
 */
const BAND_THRESHOLDS: Array<{ min: number; band: Difficulty; half: 1 | 2 }> = [
  { min: 92, band: "C1", half: 1 },
  { min: 85, band: "B2", half: 2 },
  { min: 76, band: "B2", half: 1 },
  { min: 67, band: "B1", half: 2 },
  { min: 58, band: "B1", half: 1 },
  { min: 48, band: "A2", half: 2 },
  { min: 38, band: "A2", half: 1 },
  { min: 22, band: "A1", half: 2 },
  { min: 0, band: "A1", half: 1 },
];

/** At or below this a skill needs work; at or above the other it is a strength. */
const WEAK_BELOW = 55;
const STRONG_AT = 80;
/** Fewer answers than this and a skill is not called strong or weak. */
const MIN_QUESTIONS_PER_SKILL = 2;

// ─── Rules an administrator may change ────────────────────────────────────────

/** Every level placement can assign, lowest first. */
export const PLACEMENT_LEVEL_CODES = [
  "A1.1", "A1.2", "A2.1", "A2.2", "B1.1", "B1.2",
  "B2.1", "B2.2", "C1.1", "C1.2", "C2.1", "C2.2",
] as const;
export type PlacementLevelCode = (typeof PLACEMENT_LEVEL_CODES)[number];

/**
 * How answers become a level, set at /admin/placement-rules.
 *
 * The defaults are the constants above, so a site that never opens the page
 * places students exactly as before. What stays out of reach on purpose: the
 * AI's one-step limit (`applyLevelAdjustment`), which is what stops a model's
 * mistake from putting a beginner in B2.
 */
export interface PlacementRules {
  /** What a correct answer at each difficulty is worth. */
  difficultyWeights: Record<Difficulty, number>;
  /**
   * The lowest weighted score, 0–100, that places a student at each level.
   * Null: never assigned by placement. The lowest level in use must be 0, so
   * every student lands somewhere.
   */
  levelThresholds: Record<PlacementLevelCode, number | null>;
  /** What each marked written answer is worth, as a question weight. 0 shows it without counting it. */
  writingWeight: number;
  /** A skill at or below this is a weakness. */
  weakBelow: number;
  /** A skill at or above this is a strength. */
  strongAt: number;
}

function defaultThresholds(): Record<PlacementLevelCode, number | null> {
  const out = Object.fromEntries(PLACEMENT_LEVEL_CODES.map((c) => [c, null])) as Record<
    PlacementLevelCode,
    number | null
  >;
  for (const t of BAND_THRESHOLDS) out[`${t.band}.${t.half}` as PlacementLevelCode] = t.min;
  return out;
}

export const DEFAULT_PLACEMENT_RULES: PlacementRules = {
  difficultyWeights: { ...DIFFICULTY_WEIGHT },
  levelThresholds: defaultThresholds(),
  // Weighted as a B1 question: producing language is worth more than
  // recognising it, but one prompt should not swing the whole result.
  writingWeight: DIFFICULTY_WEIGHT.B1,
  weakBelow: WEAK_BELOW,
  strongAt: STRONG_AT,
};

/**
 * What is wrong with a set of rules, in words an administrator can act on.
 * Empty when they are usable. The shape (numbers in range) is checked by the
 * route's schema; this is the part a schema cannot say.
 */
export function placementRulesProblems(rules: PlacementRules): string[] {
  const problems: string[] = [];
  const used = PLACEMENT_LEVEL_CODES.filter((c) => rules.levelThresholds[c] !== null);

  if (used.length === 0) {
    problems.push("At least one level must have a minimum score.");
  } else {
    if (rules.levelThresholds[used[0]] !== 0) {
      problems.push(`The lowest level in use (${used[0]}) must start at 0, so every student is placed.`);
    }
    for (let i = 1; i < used.length; i++) {
      const prev = rules.levelThresholds[used[i - 1]] as number;
      const cur = rules.levelThresholds[used[i]] as number;
      if (cur <= prev) {
        problems.push(`${used[i]} must need a higher score than ${used[i - 1]} (${cur} is not above ${prev}).`);
      }
    }
  }

  if (rules.weakBelow >= rules.strongAt) {
    problems.push("The weakness cut-off must be below the strength cut-off.");
  }
  if (Object.values(rules.difficultyWeights).some((w) => !(w > 0))) {
    problems.push("Every difficulty must be worth more than 0.");
  }
  return problems;
}

/** The level a weighted score earns under these rules. */
export function levelForScore(overall: number, rules: PlacementRules): PlacementLevelCode {
  for (let i = PLACEMENT_LEVEL_CODES.length - 1; i >= 0; i--) {
    const code = PLACEMENT_LEVEL_CODES[i];
    const min = rules.levelThresholds[code];
    if (min !== null && overall >= min) return code;
  }
  // Only reachable with rules that failed validation; the floor is the safe answer.
  return PLACEMENT_LEVEL_CODES[0];
}

const clamp = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;

/**
 * Score a completed placement test.
 *
 * `writing` is the open-answer grader's score for each written answer that
 * could be marked — one number, or one per written question. It is folded in
 * as its own skill rather than averaged into the total blind, so a student who
 * writes well but guesses badly at grammar shows up as exactly that.
 */
export function scorePlacement(
  answers: AnsweredQuestion[],
  writing?: number | number[] | null,
  rules: PlacementRules = DEFAULT_PLACEMENT_RULES,
): PlacementOutcome {
  const weightOf = (d: Difficulty) => rules.difficultyWeights[d] ?? 1;
  const writingScores = (writing == null ? [] : Array.isArray(writing) ? writing : [writing]).map(clamp);

  const skills: SkillScore[] = PLACEMENT_SKILLS.map((skill) => {
    if (skill === "writing" && writingScores.length > 0) {
      const mean = writingScores.reduce((a, b) => a + b, 0) / writingScores.length;
      return { skill, score: Math.round(mean), answered: writingScores.length };
    }

    const rows = answers.filter((a) => a.skill === skill);
    if (rows.length === 0) return { skill, score: null, answered: 0 };

    let earned = 0;
    let possible = 0;
    for (const row of rows) {
      const weight = weightOf(row.difficulty);
      possible += weight;
      if (row.correct) earned += weight;
    }

    return {
      skill,
      score: possible > 0 ? Math.round((earned / possible) * 100) : null,
      answered: rows.length,
    };
  });

  // The overall figure is weighted the same way, over every question at once —
  // not an average of the per-skill percentages, which would give a skill with
  // two questions the same say as one with ten.
  let earned = 0;
  let possible = 0;
  for (const row of answers) {
    const weight = weightOf(row.difficulty);
    possible += weight;
    if (row.correct) earned += weight;
  }
  for (const score of writingScores) {
    possible += rules.writingWeight;
    earned += (score / 100) * rules.writingWeight;
  }

  const overall = possible > 0 ? Math.round((earned / possible) * 100) : 0;

  const levelCode = levelForScore(overall, rules);
  const [band, half] = levelCode.split(".") as [Difficulty, string];

  const reportable = skills.filter(
    (s) => s.score !== null && s.answered >= MIN_QUESTIONS_PER_SKILL,
  );

  return {
    overall,
    skills,
    band,
    half: half === "2" ? 2 : 1,
    levelCode,
    strengths: reportable
      .filter((s) => (s.score as number) >= rules.strongAt)
      .sort((a, b) => (b.score as number) - (a.score as number))
      .map((s) => s.skill),
    weaknesses: reportable
      .filter((s) => (s.score as number) <= rules.weakBelow)
      .sort((a, b) => (a.score as number) - (b.score as number))
      .map((s) => s.skill),
  };
}

/** A question as the preview needs it: what it is worth and how easy it is to guess. */
export interface PreviewQuestion {
  type: "choice" | "written";
  difficulty: Difficulty;
  /** Choices offered; a guess is right one time in this many. */
  optionCount: number;
}

export interface PlacementScenario {
  /** "guess", "none", or "upTo:B1" — every choice question up to B1 right, the rest wrong. */
  key: string;
  overall: number;
  levelCode: PlacementLevelCode;
}

/**
 * What typical students would be placed at under a set of rules, on the
 * questions actually in the test — so an administrator sees the effect of a
 * change before any student does. Written answers are taken at
 * `writingScore` in every scenario, or left unmarked when it is null.
 */
export function placementScenarios(
  questions: PreviewQuestion[],
  rules: PlacementRules,
  writingScore: number | null,
): PlacementScenario[] {
  const choice = questions.filter((q) => q.type === "choice");
  const writing = writingScore === null ? [] : questions.filter((q) => q.type === "written").map(() => writingScore);
  const answers = (right: (q: PreviewQuestion) => boolean): AnsweredQuestion[] =>
    choice.map((q) => ({ skill: "grammar", difficulty: q.difficulty, correct: right(q) }));
  const scenario = (key: string, overall: number): PlacementScenario => ({
    key,
    overall,
    levelCode: levelForScore(overall, rules),
  });

  // Guessing is an expectation, not a set of answers: each choice question is
  // worth its weight divided by the number of choices.
  let possible = 0;
  let expected = 0;
  for (const q of choice) {
    const w = rules.difficultyWeights[q.difficulty];
    possible += w;
    expected += w / Math.max(1, q.optionCount);
  }
  for (const s of writing) {
    possible += rules.writingWeight;
    expected += (clamp(s) / 100) * rules.writingWeight;
  }

  const out = [
    scenario("guess", possible > 0 ? Math.round((expected / possible) * 100) : 0),
    scenario("none", scorePlacement(answers(() => false), writing, rules).overall),
  ];
  for (const band of BANDS) {
    if (!choice.some((q) => q.difficulty === band)) continue;
    const upTo = BANDS.indexOf(band);
    out.push(
      scenario(
        `upTo:${band}`,
        scorePlacement(answers((q) => BANDS.indexOf(q.difficulty) <= upTo), writing, rules).overall,
      ),
    );
  }
  return out;
}

/**
 * Apply the AI's suggested adjustment, refusing anything it should not be
 * allowed to do.
 *
 * At most one sub-level in either direction. A model that returns "C2.2" for a
 * student who scored 30% is not making a judgement about an uneven profile; it
 * is wrong, and the arithmetic should win. Returning the computed level
 * unchanged is always a safe answer.
 */
export function applyLevelAdjustment(
  computed: PlacementOutcome,
  suggestedLevelCode: string | null | undefined,
  orderedLevelCodes: string[],
): { levelCode: string; adjusted: boolean } {
  if (!suggestedLevelCode) return { levelCode: computed.levelCode, adjusted: false };

  const computedIndex = orderedLevelCodes.indexOf(computed.levelCode);
  const suggestedIndex = orderedLevelCodes.indexOf(suggestedLevelCode);

  // A suggestion naming a level this curriculum does not have is not a
  // judgement about the student.
  if (computedIndex === -1 || suggestedIndex === -1) {
    return { levelCode: computed.levelCode, adjusted: false };
  }

  if (Math.abs(suggestedIndex - computedIndex) > 1) {
    return { levelCode: computed.levelCode, adjusted: false };
  }

  return {
    levelCode: suggestedLevelCode,
    adjusted: suggestedIndex !== computedIndex,
  };
}

export { DIFFICULTY_WEIGHT, BAND_THRESHOLDS, WEAK_BELOW, STRONG_AT, BANDS };
