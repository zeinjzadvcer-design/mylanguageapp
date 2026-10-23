/**
 * CMS API utilities
 * Typed fetch wrappers for all CMS endpoints.
 * Uses the Vite BASE_URL so paths work when the app is served under a sub-path.
 */

const base = () => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const r = await fetch(`${base()}${path}`, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = `${method} ${path} → ${r.status}`;
    try { const e = await r.json(); msg = e.error ?? JSON.stringify(e); } catch {}
    throw new Error(msg);
  }
  return r.json();
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

// ─── Types ────────────────────────────────────────────────────────────────

export type QuizKind = "practice" | "level_evaluation";

export interface CMSQuiz {
  id: number;
  title: string;
  titleAr: string;
  description?: string | null;
  descriptionAr?: string | null;
  instructions?: string | null;
  instructionsAr?: string | null;
  /** practice has no effect on a student's level; level_evaluation gates it. */
  kind: QuizKind;
  levelId?: number | null;
  timeLimitSec?: number | null;
  maxAttempts?: number | null;
  passingScore: number;
  xpReward: number;
  shuffleBlocks: boolean;
  revealAnswers: string;
  /** Hours a student waits after failing before retrying an evaluation. */
  cooldownHours?: number | null;
  status: LessonStatus;
  contentVersion?: number;
  blockCount?: number;
  updatedAt?: string;
}

export interface CMSQuizBlock {
  id: number;
  quizId: number;
  type: string;
  order: number;
  title?: string | null;
  titleAr?: string | null;
  instructions?: string | null;
  instructionsAr?: string | null;
  content?: string | null;
  contentAr?: string | null;
  prompt?: string | null;
  promptAr?: string | null;
  isRequired: boolean;
  isActive: boolean;
  /** Read-aloud: pronunciation can only be scored when there is a set passage. */
  expectsReferenceReading?: boolean;
  referenceMediaId?: number | null;
  /**
   * Optional illustration media, on any block type. The id is what the student
   * resolves to a signed URL; the key is what the CMS picker displays.
   */
  imageMediaId?: number | null;
  audioMediaId?: number | null;
  imageMediaKey?: string | null;
  audioMediaKey?: string | null;
  config?: QuizBlockConfig | null;
}

/** One piece of work waiting on a human. */
export interface GradingQueueItem {
  id: number;
  kind: "quiz_response" | "lesson_activity";
  attemptId: number;
  blockType: string;
  prompt: string | null;
  /** True when the student was reading a set passage. */
  expectsReferenceReading: boolean | null;
  /** The passage, when there is one — what the recording should match. */
  referenceText: string | null;
  response: unknown;
  transcript: string | null;
  mediaAssetId: number | null;
  gradingAttempts: number;
  lastGradingError: string | null;
  submittedAt: string | null;
  studentName: string;
  studentId: number;
  /** The quiz or lesson it belongs to. */
  context: string;
}

export interface GradedAttempt {
  id: number;
  status: string;
  score: number | null;
  passed: boolean | null;
  pendingReviewCount: number;
}

/** The answer key and options, as authored. Never sent to a student verbatim. */
export interface QuizBlockConfig {
  options?: Array<{ id: string; text: string; textAr?: string | null }>;
  correctOptionIds?: string[];
  explanation?: string | null;
  explanationAr?: string | null;
  /** What a good written answer must mention — the AI grader's rubric. */
  keyPoints?: string[];
  minWords?: number;
  mediaKey?: string | null;
  points?: number;
}


/** A placement question as the CMS sees it — answer keys included. */
export interface CMSPlacementOption {
  id?: number;
  optionId: string;
  text: string;
  textAr?: string | null;
  isCorrect?: boolean;
}

export interface CMSPlacementQuestion {
  id: number;
  questionText: string;
  questionTextAr: string;
  type: string;
  skill: string;
  difficulty: string;
  passage?: string | null;
  mediaId?: number | null;
  isActive: boolean;
  order: number;
  options: CMSPlacementOption[];
}

export type LessonStatus = "draft" | "in_review" | "approved" | "published" | "archived";

export interface CMSLesson {
  id: number; levelId: number; levelCode?: string; curriculumId?: number;
  title: string; titleAr: string; subtitle?: string | null;
  description?: string | null; status: LessonStatus;
  lessonType: string; estimatedMinutes: number; order: number;
  xpReward: number; passingScore: number; difficulty?: string | null;
  tags?: string[] | null; objectives?: string[] | null;
  objectivesAr?: string[] | null; teacherNotes?: string | null;
  contentVersion?: number; createdAt?: string; updatedAt?: string;
}

export interface CMSBlock {
  id: number; lessonId: number; type: string; order: number;
  title?: string | null; titleAr?: string | null;
  instructions?: string | null; instructionsAr?: string | null;
  content?: string | null; contentAr?: string | null;
  audioNote?: string | null; prompt?: string | null; promptAr?: string | null;
  exampleAudio?: string | null; isRequired: boolean;
  estimatedMinutes?: number | null; isActive: boolean; config?: unknown;
  exercise?: CMSExercise | null; options?: CMSOption[];
  /** Every question on this block. `exercise`/`options` describe the first. */
  exercises?: Array<CMSExercise & { options: CMSOption[] }>;
}

export interface CMSExercise {
  id: number; lessonId: number; contentBlockId?: number | null;
  exerciseType: string; question: string; questionAr?: string | null;
  correctOptionId: string; explanation?: string | null;
  prompt?: string | null; promptAr?: string | null;
  modelAnswer?: string | null; modelAnswerAr?: string | null;
  expectedConcepts?: string | null; difficulty?: string | null; points?: number;
}

export interface CMSOption {
  id?: number; exerciseId?: number; optionId: string; text: string; textAr?: string | null;
}

export interface CMSVocabItem {
  id: number; levelId: number; lessonId?: number | null;
  word: string; translation: string; definition?: string | null;
  partOfSpeech?: string | null; exampleSentence?: string | null;
  exampleSentenceAr?: string | null; pronunciation?: string | null;
  difficulty?: string | null; tags?: string[] | null;
}

export interface CMSStats {
  languages: number; curricula: number; levels: number; vocabulary: number;
  lessons: { draft: number; in_review: number; approved: number; published: number; archived: number; total: number };
  recentLessons: CMSLesson[];
}

// ─── Dashboard ────────────────────────────────────────────────────────────

export const cmsApi = {
  stats: () => get<CMSStats>("/cms/stats"),

  // Lessons
  lessons: {
    list: (params?: Record<string, string | number | undefined>) => {
      const q = new URLSearchParams();
      if (params) Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)));
      return get<{ lessons: CMSLesson[]; total: number; page: number; limit: number }>(`/cms/lessons?${q}`);
    },
    get: (id: number) => get<CMSLesson>(`/cms/lessons/${id}`),
    create: (body: Partial<CMSLesson>) => post<{ id: number; status: string }>("/cms/lessons", body),
    update: (id: number, body: Partial<CMSLesson>) => patch<{ id: number }>(`/cms/lessons/${id}`, body),
    duplicate: (id: number) => post<{ id: number; status: string }>(`/cms/lessons/${id}/duplicate`),
    submit: (id: number) => post<{ id: number; status: string }>(`/cms/lessons/${id}/submit`),
    approve: (id: number) => post<{ id: number; status: string }>(`/cms/lessons/${id}/approve`),
    reject: (id: number, notes?: string) => post<{ id: number; status: string }>(`/cms/lessons/${id}/reject`, { notes }),
    publish: (id: number) => post<{ id: number; status: string }>(`/cms/lessons/${id}/publish`),
    unpublish: (id: number) => post<{ id: number; status: string }>(`/cms/lessons/${id}/unpublish`),
    archive: (id: number) => post<{ id: number; status: string }>(`/cms/lessons/${id}/archive`),
    restore: (id: number) => post<{ id: number; status: string }>(`/cms/lessons/${id}/restore`),
    delete: (id: number) => del<{ deleted: boolean }>(`/cms/lessons/${id}`),
    preview: (id: number) => get<{ isPreview: boolean; lesson: CMSLesson; contentBlocks: CMSBlock[]; vocabulary: CMSVocabItem[] }>(`/cms/lessons/${id}/preview`),
  },

  // Blocks
  blocks: {
    list: (lessonId: number) => get<CMSBlock[]>(`/cms/lessons/${lessonId}/blocks`),
    create: (lessonId: number, body: Partial<CMSBlock>) => post<CMSBlock>(`/cms/lessons/${lessonId}/blocks`, body),
    update: (lessonId: number, blockId: number, body: Partial<CMSBlock>) => patch<CMSBlock>(`/cms/lessons/${lessonId}/blocks/${blockId}`, body),
    delete: (lessonId: number, blockId: number) => del<{ deleted: boolean }>(`/cms/lessons/${lessonId}/blocks/${blockId}`),
    reorder: (lessonId: number, blockIds: number[]) => post<{ reordered: boolean }>(`/cms/lessons/${lessonId}/blocks/reorder`, { blockIds }),
    createExercise: (lessonId: number, blockId: number, body: Partial<CMSExercise> & { options?: CMSOption[] }) =>
      post<CMSExercise>(`/cms/lessons/${lessonId}/blocks/${blockId}/exercise`, body),
    updateExercise: (lessonId: number, exerciseId: number, body: Partial<CMSExercise> & { options?: CMSOption[] }) =>
      patch<CMSExercise>(`/cms/lessons/${lessonId}/exercises/${exerciseId}`, body),
    deleteExercise: (lessonId: number, exerciseId: number) =>
      del<{ deleted: boolean }>(`/cms/lessons/${lessonId}/exercises/${exerciseId}`),
  },

  // Catalog
  languages: {
    list: () => get<any[]>("/cms/languages"),
    create: (body: any) => post<any>("/cms/languages", body),
    update: (id: number, body: any) => patch<any>(`/cms/languages/${id}`, body),
  },
  curricula: {
    list: () => get<any[]>("/cms/curricula"),
    create: (body: any) => post<any>("/cms/curricula", body),
    update: (id: number, body: any) => patch<any>(`/cms/curricula/${id}`, body),
  },
  levels: {
    list: (curriculumId?: number) => get<any[]>(`/cms/levels${curriculumId ? `?curriculumId=${curriculumId}` : ""}`),
    create: (body: any) => post<any>("/cms/levels", body),
    update: (id: number, body: any) => patch<any>(`/cms/levels/${id}`, body),
    reorder: (levelIds: number[]) => post<any>("/cms/levels/reorder", { levelIds }),
  },

  // Vocabulary
  vocabulary: {
    list: (params?: Record<string, string | number | undefined>) => {
      const q = new URLSearchParams();
      if (params) Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)));
      return get<{ items: CMSVocabItem[]; total: number; page: number; limit: number }>(`/cms/vocabulary?${q}`);
    },
    create: (body: Partial<CMSVocabItem>) => post<CMSVocabItem>("/cms/vocabulary", body),
    update: (id: number, body: Partial<CMSVocabItem>) => patch<CMSVocabItem>(`/cms/vocabulary/${id}`, body),
    delete: (id: number) => del<{ deleted: boolean }>(`/cms/vocabulary/${id}`),
  },

  // Quizzes and level evaluations
  quizzes: {
    list: (status?: string) =>
      get<{ quizzes: CMSQuiz[]; total: number }>(
        `/cms/quizzes${status ? `?status=${status}` : ""}`,
      ),
    get: (id: number) => get<CMSQuiz & { blocks: CMSQuizBlock[] }>(`/cms/quizzes/${id}`),
    create: (body: Partial<CMSQuiz>) => post<CMSQuiz>("/cms/quizzes", body),
    update: (id: number, body: Partial<CMSQuiz>) => patch<CMSQuiz>(`/cms/quizzes/${id}`, body),
    delete: (id: number) => del<{ deleted: boolean }>(`/cms/quizzes/${id}`),
    blockTypes: () => get<{ types: string[] }>("/cms/quiz-block-types"),
    addBlock: (quizId: number, body: Partial<CMSQuizBlock>) =>
      post<CMSQuizBlock>(`/cms/quizzes/${quizId}/blocks`, body),
    updateBlock: (quizId: number, blockId: number, body: Partial<CMSQuizBlock>) =>
      patch<CMSQuizBlock>(`/cms/quizzes/${quizId}/blocks/${blockId}`, body),
    deleteBlock: (quizId: number, blockId: number) =>
      del<{ deleted: boolean }>(`/cms/quizzes/${quizId}/blocks/${blockId}`),
    reorderBlocks: (quizId: number, blockIds: number[]) =>
      post<{ reordered: boolean }>(`/cms/quizzes/${quizId}/blocks/reorder`, { blockIds }),
    /** submit | approve | reject | publish | unpublish | archive | restore */
    transition: (quizId: number, action: string) =>
      post<{ id: number; status: string }>(`/cms/quizzes/${quizId}/${action}`, {}),
  },

  // Media
  media: {
    list: (page = 1) => get<{ items: any[]; total: number }>(`/cms/media?page=${page}`),
    create: (body: any) => post<any>("/cms/media", body),
    delete: (id: number) => del<any>(`/cms/media/${id}`),

    /**
     * Upload a file, rather than registering a key someone put in the bucket by
     * hand. Same three-step handshake the student recorder uses: the server
     * picks the key and signs a PUT, the browser uploads straight to storage,
     * and the server confirms the bytes landed before the asset is usable.
     */
    upload: async (
      file: File,
      onProgress?: (stage: "signing" | "uploading" | "confirming") => void,
    ) => {
      onProgress?.("signing");
      const begun = await post<{
        mediaId: number;
        key: string;
        upload: { url: string; headers: Record<string, string> };
      }>("/cms/media/uploads", {
        // A MediaRecorder file carries its codec ("audio/webm;codecs=opus").
        // The server signs the bare type, and the browser's PUT header has to
        // match that signature exactly — so send the bare type here too.
        contentType: (file.type || "application/octet-stream").split(";")[0].trim(),
        sizeBytes: file.size,
        originalName: file.name,
      });

      onProgress?.("uploading");
      const put = await fetch(begun.upload.url, {
        method: "PUT",
        body: file,
        headers: begun.upload.headers,
        // The bucket is a different origin and needs no session cookie;
        // sending one only breaks the CORS preflight.
        credentials: "omit",
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);

      onProgress?.("confirming");
      // Confirmation goes to the student endpoint: it checks the uploader owns
      // the pending row, which is true for staff uploads too.
      const done = await post<{ mediaId: number; status: string; sizeBytes: number | null }>(
        `/media/uploads/${begun.mediaId}/complete`,
        {},
      );
      // The key comes from the signing step; the confirmation does not repeat it.
      return { ...done, key: begun.key };
    },

    /** A short-lived playback URL, for previewing an asset in the CMS. */
    playbackUrl: (mediaId: number) => get<{ url: string }>(`/media/${mediaId}/url`),
  },

  // The marking queue — work AI could not finish
  grading: {
    queue: (all = false) =>
      get<{
        items: GradingQueueItem[];
        counts: { quizResponses: number; activities: number; exhausted: number };
        maxAttempts: number;
        showingOnlyExhausted: boolean;
      }>(`/cms/grading/queue${all ? "?all=true" : ""}`),
    mediaUrl: (mediaId: number) => get<{ url: string }>(`/cms/grading/media/${mediaId}`),
    markQuizResponse: (id: number, body: { score: number; feedbackAr?: string }) =>
      post<{ marked: boolean; attempt: GradedAttempt | null }>(
        `/cms/grading/quiz-responses/${id}`,
        body,
      ),
    markActivity: (id: number, body: { score: number; feedbackAr?: string }) =>
      post<{ marked: boolean }>(`/cms/grading/activities/${id}`, body),
    sweep: () =>
      post<{
        quizAttemptsRetried: number;
        activitiesRetried: number;
        counts: { quizResponses: number; activities: number; exhausted: number };
      }>("/cms/grading/sweep", {}),
    retry: (kind: string, id: number) =>
      post<{ reset: boolean }>(`/cms/grading/retry/${kind}/${id}`, {}),
  },

  // Reviews + audit
  reviews: {
    queue: () => get<any[]>("/cms/reviews"),
    forLesson: (lessonId: number) => get<any[]>(`/cms/reviews/lesson/${lessonId}`),
  },
  audit: {
    list: (params?: Record<string, string | number | undefined>) => {
      const q = new URLSearchParams();
      if (params) Object.entries(params).forEach(([k, v]) => v !== undefined && q.set(k, String(v)));
      return get<{ logs: any[]; total: number; page: number; limit: number }>(`/cms/audit?${q}`);
    },
  },
  // Placement test — the questions every new student is scored on
  placement: {
    list: () => get<{ questions: CMSPlacementQuestion[] }>("/cms/placement/questions"),
    create: (body: Partial<CMSPlacementQuestion>) =>
      post<CMSPlacementQuestion>("/cms/placement/questions", body),
    update: (id: number, body: Partial<CMSPlacementQuestion>) =>
      patch<CMSPlacementQuestion>(`/cms/placement/questions/${id}`, body),
    delete: (id: number) => del<{ deleted: boolean }>(`/cms/placement/questions/${id}`),
    reorder: (questionIds: number[]) =>
      post<{ reordered: boolean }>("/cms/placement/questions/reorder", { questionIds }),
  },
};

