import { pgTable, text, serial, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { curriculaTable } from "./languages";
import { levelsTable } from "./levels";

/**
 * Every role an account can hold. What each one may do is defined in the API's
 * `services/access-policy.ts`, which will not compile until a role added here
 * has its definition there.
 *
 * The column is plain text, so adding a role needs no migration.
 */
export const USER_ROLES = [
  "student",
  "admin",
  "content_manager",
  "payments_manager",
] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: USER_ROLES }).notNull().default("student"),
  preferredLanguage: text("preferred_language", { enum: ["ar", "en"] }).notNull().default("ar"),
  country: text("country").notNull().default("SY"),
  /** How the student heard about the app. Asked at signup; drives the admin referral report. */
  referralSource: text("referral_source"),
  /** Free text when referralSource is "other" — kept separate so the enum stays reportable. */
  referralDetail: text("referral_detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true, createdAt: true, updatedAt: true, passwordHash: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

export const studentProfilesTable = pgTable("student_profiles", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  curriculumId: integer("curriculum_id").references(() => curriculaTable.id),
  currentLevelId: integer("current_level_id").references(() => levelsTable.id),
  streakDays: integer("streak_days").notNull().default(0),
  totalXp: integer("total_xp").notNull().default(0),
  placementCompleted: boolean("placement_completed").notNull().default(false),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).defaultNow(),
  bio: text("bio"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  userIdUnique: uniqueIndex("student_profiles_user_id_unique").on(table.userId),
}));

export type StudentProfile = typeof studentProfilesTable.$inferSelect;

/**
 * One-time password reset tokens.
 *
 * The token that was emailed is never stored — only its SHA-256 hash — so a
 * leaked database cannot be used to reset anybody's password. Same reasoning
 * that keeps `passwordHash` hashed.
 */
export const passwordResetTokensTable = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** SHA-256 hex of the emailed token. */
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Set when spent. A link works exactly once. */
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;
