#!/usr/bin/env node
/**
 * Seed the baseline data a student needs in order to get anywhere.
 *
 * Without this, a fresh database is a dead end: `student_profiles.current_level_id`
 * is null, the only way to set it is the placement test, and the placement test
 * has no questions — so every level and lesson stays LOCKED forever.
 *
 * Seeds (idempotent — safe to re-run, keyed on natural identifiers):
 *   - 3 subscription plans
 *   - 2 languages + 1 CEFR curriculum
 *   - 12 CEFR levels (A1.1 → C2.2)
 *   - 15 placement questions across grammar, vocabulary, reading,
 *     comprehension and writing, tagged by skill and difficulty
 *
 * Usage: DATABASE_URL=postgresql://... node scripts/seed.mjs
 */
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL must be set.');
  process.exit(1);
}

/**
 * The two paid plans are mutually exclusive CONTENT TRACKS, not tiers: neither
 * is a superset of the other, and `lessonTrack` is matched for equality against
 * `lessons.lesson_type`. A general subscriber never sees professional lessons
 * and vice versa.
 *
 * `freeLessonQuota` is how many distinct lessons may be STARTED; null is
 * unlimited. The free plan's 1 is the single trial lesson a student gets after
 * the placement test, before everything locks.
 */
const PLANS = [
  {
    code: 'free', name: 'Free', nameAr: 'مجاني',
    priceUsd: 0, lessonTrack: 'general', freeLessonQuota: 1,
    description: 'Placement test and one free lesson',
    descriptionAr: 'اختبار تحديد المستوى ودرس مجاني واحد',
  },
  {
    code: 'general_english', name: 'General English', nameAr: 'الإنجليزية العامة',
    priceUsd: 2, lessonTrack: 'general', freeLessonQuota: null,
    description: 'Full access to the general track, A1–C2',
    descriptionAr: 'وصول كامل لمسار اللغة العامة من A1 إلى C2',
  },
  {
    code: 'professional_english', name: 'Professional English', nameAr: 'الإنجليزية المهنية',
    priceUsd: 4, lessonTrack: 'professional', freeLessonQuota: null,
    description: 'Full access to the professional track, A1–C2',
    descriptionAr: 'وصول كامل لمسار اللغة المهنية من A1 إلى C2',
  },
];

const LEVELS = [
  ['A1.1', 'Beginner 1', 'مبتدئ ١'],
  ['A1.2', 'Beginner 2', 'مبتدئ ٢'],
  ['A2.1', 'Elementary 1', 'أساسي ١'],
  ['A2.2', 'Elementary 2', 'أساسي ٢'],
  ['B1.1', 'Intermediate 1', 'متوسط ١'],
  ['B1.2', 'Intermediate 2', 'متوسط ٢'],
  ['B2.1', 'Upper Intermediate 1', 'فوق المتوسط ١'],
  ['B2.2', 'Upper Intermediate 2', 'فوق المتوسط ٢'],
  ['C1.1', 'Advanced 1', 'متقدم ١'],
  ['C1.2', 'Advanced 2', 'متقدم ٢'],
  ['C2.1', 'Proficient 1', 'متمكن ١'],
  ['C2.2', 'Proficient 2', 'متمكن ٢'],
];

/** 10 questions, ascending difficulty. `c` marks the correct option. */
/**
 * The placement test.
 *
 * Each question is tagged with the skill it tests and roughly the level it sits
 * at. Both matter: the skill tag is what makes a per-skill breakdown possible
 * at all, and the difficulty is what separates a strong beginner from a weak
 * intermediate — both score about half on an untagged test.
 *
 * Ordered easiest to hardest so a student meets something they can answer
 * first, which matters more for a beginner's nerve than for the scoring.
 */
const QUESTIONS = [
  // Grammar
  {
    skill: 'grammar', difficulty: 'A1',
    q: 'She ____ to school every day.',
    ar: 'She ____ to school every day.',
    opts: [['a', 'go', false], ['b', 'goes', true], ['c', 'going', false], ['d', 'gone', false]],
  },
  {
    skill: 'grammar', difficulty: 'A2',
    q: 'I ____ my homework before dinner yesterday.',
    ar: 'I ____ my homework before dinner yesterday.',
    opts: [['a', 'finish', false], ['b', 'finishes', false], ['c', 'finished', true], ['d', 'finishing', false]],
  },
  {
    skill: 'grammar', difficulty: 'B1',
    q: 'If it ____ tomorrow, we will stay at home.',
    ar: 'If it ____ tomorrow, we will stay at home.',
    opts: [['a', 'rains', true], ['b', 'will rain', false], ['c', 'rained', false], ['d', 'raining', false]],
  },
  {
    skill: 'grammar', difficulty: 'B2',
    q: 'She insisted on ____ the bill herself.',
    ar: 'She insisted on ____ the bill herself.',
    opts: [['a', 'pay', false], ['b', 'to pay', false], ['c', 'paying', true], ['d', 'paid', false]],
  },
  {
    skill: 'grammar', difficulty: 'C1',
    q: 'Had she known, she ____ differently.',
    ar: 'Had she known, she ____ differently.',
    opts: [
      ['a', 'would act', false],
      ['b', 'would have acted', true],
      ['c', 'will act', false],
      ['d', 'acted', false],
    ],
  },

  // Vocabulary
  {
    skill: 'vocabulary', difficulty: 'A1',
    q: 'What do you use to write?',
    ar: 'ما الذي تستخدمه للكتابة؟',
    opts: [['a', 'A pen', true], ['b', 'A plate', false], ['c', 'A chair', false], ['d', 'A door', false]],
  },
  {
    skill: 'vocabulary', difficulty: 'A2',
    q: 'The opposite of "expensive" is ____.',
    ar: 'عكس كلمة "expensive" هو ____.',
    opts: [['a', 'cheap', true], ['b', 'heavy', false], ['c', 'quiet', false], ['d', 'early', false]],
  },
  {
    skill: 'vocabulary', difficulty: 'B1',
    q: 'Which word means "very tired"?',
    ar: 'أي كلمة تعني "متعب جداً"؟',
    opts: [['a', 'Exhausted', true], ['b', 'Excited', false], ['c', 'Enormous', false], ['d', 'Efficient', false]],
  },
  {
    skill: 'vocabulary', difficulty: 'B2',
    q: 'Choose the best formal alternative to "get in touch with".',
    ar: 'اختر البديل الرسمي الأنسب لعبارة "get in touch with".',
    opts: [['a', 'Reach out', false], ['b', 'Contact', true], ['c', 'Ring up', false], ['d', 'Catch', false]],
  },

  // Reading — two questions on one passage, so this tests comprehension of a
  // text rather than recognition of a single sentence.
  {
    skill: 'reading', difficulty: 'A2',
    passage: 'Omar works at a bakery in Damascus. He starts at five in the morning and finishes at one. On Fridays the bakery is closed, so he visits his grandmother.',
    q: 'What time does Omar finish work?',
    ar: 'متى ينتهي عمر من عمله؟',
    opts: [['a', 'At five', false], ['b', 'At one', true], ['c', 'On Friday', false], ['d', 'In the evening', false]],
  },
  {
    skill: 'reading', difficulty: 'B1',
    passage: 'Omar works at a bakery in Damascus. He starts at five in the morning and finishes at one. On Fridays the bakery is closed, so he visits his grandmother.',
    q: 'Why does Omar visit his grandmother on Fridays?',
    ar: 'لماذا يزور عمر جدته يوم الجمعة؟',
    opts: [
      ['a', 'Because she is ill', false],
      ['b', 'Because the bakery is closed', true],
      ['c', 'Because he works nearby', false],
      ['d', 'Because she bakes bread', false],
    ],
  },

  // Comprehension
  {
    skill: 'comprehension', difficulty: 'A1',
    q: 'Which is a polite way to greet someone in the morning?',
    ar: 'ما هي الطريقة المهذبة لتحية شخص في الصباح؟',
    opts: [['a', 'Good morning', true], ['b', 'Good night', false], ['c', 'Goodbye', false], ['d', 'See you', false]],
  },
  {
    skill: 'comprehension', difficulty: 'B1',
    q: 'Your friend says "I could not agree more." What do they mean?',
    ar: 'قال صديقك "I could not agree more." ماذا يقصد؟',
    opts: [
      ['a', 'They completely agree', true],
      ['b', 'They disagree', false],
      ['c', 'They are unsure', false],
      ['d', 'They want to change the subject', false],
    ],
  },
  {
    skill: 'comprehension', difficulty: 'B2',
    q: 'A colleague writes "Let us circle back on this next week." What are they suggesting?',
    ar: 'كتب زميل "Let us circle back on this next week." بماذا يقترح؟',
    opts: [
      ['a', 'Discussing it again later', true],
      ['b', 'Cancelling the project', false],
      ['c', 'Meeting in a circle', false],
      ['d', 'Finishing it today', false],
    ],
  },

  // Writing — graded by the same AI grader lessons and quizzes use. If AI is
  // unavailable this goes unscored and the rest of the test still stands.
  {
    skill: 'writing', difficulty: 'A2', type: 'written',
    q: 'Write three or four sentences about your daily routine. What time do you wake up, and what do you do first?',
    ar: 'اكتب ثلاث أو أربع جمل عن روتينك اليومي. متى تستيقظ؟ وماذا تفعل أولاً؟',
    opts: [],
  },
];


const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query('BEGIN');

  // ── Subscription plans ────────────────────────────────────────────────────
  for (const p of PLANS) {
    await client.query(
      // Access columns and copy are UPDATEd on conflict rather than left alone.
      // Migration 021 backfills lesson_track and free_lesson_quota, but the old
      // descriptions ("Access to A1.1 only", "Full access plus business
      // vocabulary") describe a model the product no longer sells, and an
      // existing database would keep showing them to students. Price is left
      // untouched on purpose: it is an admin's to set, not the seed's to reset.
      `INSERT INTO subscription_plans
         (code, name, name_ar, price_usd, lesson_track, free_lesson_quota,
          description, description_ar)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO UPDATE SET
         lesson_track      = EXCLUDED.lesson_track,
         free_lesson_quota = EXCLUDED.free_lesson_quota,
         description       = EXCLUDED.description,
         description_ar    = EXCLUDED.description_ar`,
      [p.code, p.name, p.nameAr, p.priceUsd, p.lessonTrack, p.freeLessonQuota,
       p.description, p.descriptionAr],
    );
  }
  console.log(`Subscription plans: ${PLANS.length} ensured.`);

  // ── Languages ─────────────────────────────────────────────────────────────
  await client.query(
    `INSERT INTO languages (code, name, name_native, rtl)
     VALUES ('en','English','English',false), ('ar','Arabic','العربية',true)
     ON CONFLICT (code) DO NOTHING`,
  );

  // ── Curriculum ────────────────────────────────────────────────────────────
  let { rows: cur } = await client.query(
    `SELECT id FROM curricula
      WHERE target_language_code = 'en' AND learner_language_code = 'ar'
      LIMIT 1`,
  );
  if (cur.length === 0) {
    ({ rows: cur } = await client.query(
      `INSERT INTO curricula
         (target_language_code, learner_language_code, name, name_in_learner_language, level_framework)
       VALUES ('en','ar','CEFR English','الإنجليزية حسب الإطار الأوروبي','CEFR')
       RETURNING id`,
    ));
  }
  const curriculumId = cur[0].id;
  console.log(`Curriculum id ${curriculumId}.`);

  // ── Levels ────────────────────────────────────────────────────────────────
  // The placement test maps a score across however many levels exist, so all 12
  // must be present for the assignment spread to be meaningful.
  for (const [i, [code, name, nameAr]] of LEVELS.entries()) {
    await client.query(
      `INSERT INTO levels (curriculum_id, code, name, name_ar, "order")
       SELECT $1,$2,$3,$4,$5
       WHERE NOT EXISTS (
         SELECT 1 FROM levels WHERE curriculum_id = $1 AND code = $2
       )`,
      [curriculumId, code, name, nameAr, i + 1],
    );
  }
  console.log(`Levels: ${LEVELS.length} ensured.`);

  // ── Placement test ────────────────────────────────────────────────────────
  for (const [i, item] of QUESTIONS.entries()) {
    const order = i + 1;
    const { rows: existing } = await client.query(
      `SELECT id FROM placement_questions WHERE "order" = $1 LIMIT 1`,
      [order],
    );
    if (existing.length > 0) continue;

    const { rows: [q] } = await client.query(
      `INSERT INTO placement_questions
         (question_text, question_text_ar, type, skill, difficulty, passage, "order")
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [item.q, item.ar, item.type ?? 'mcq', item.skill, item.difficulty, item.passage ?? null, order],
    );
    for (const [optionId, text, isCorrect] of item.opts) {
      await client.query(
        `INSERT INTO placement_options (question_id, option_id, text, is_correct)
         VALUES ($1,$2,$3,$4)`,
        [q.id, optionId, text, isCorrect],
      );
    }
  }
  console.log(`Placement questions: ${QUESTIONS.length} ensured.`);

  await client.query('COMMIT');
  console.log('Seed complete.');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}
