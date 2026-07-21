import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("users_email_uidx").on(t.email),
]);

export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("sessions_token_hash_uidx").on(t.tokenHash),
  index("sessions_user_idx").on(t.userId),
]);

export const magicLinks = pgTable("magic_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  uniqueIndex("magic_links_token_hash_uidx").on(t.tokenHash),
]);

export const watches = pgTable("watches", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  cssSelector: text("css_selector"),
  monitorMode: text("monitor_mode").notNull().default("text_changed"),
  targetText: text("target_text"),
  intervalMinutes: integer("interval_minutes").notNull().default(360),
  webhookUrl: text("webhook_url"),
  notifyEmail: boolean("notify_email").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastChangedAt: timestamp("last_changed_at", { withTimezone: true }),
  lastManualCheckAt: timestamp("last_manual_check_at", { withTimezone: true }),
  lastStatus: text("last_status").notNull().default("ok"),
  lastError: text("last_error"),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  nextCheckAt: timestamp("next_check_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("watches_user_idx").on(t.userId),
  index("watches_next_check_idx").on(t.nextCheckAt),
]);

export const snapshots = pgTable("snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  watchId: uuid("watch_id").notNull().references(() => watches.id, { onDelete: "cascade" }),
  contentHash: text("content_hash").notNull(),
  contentText: text("content_text").notNull(),
  httpStatus: integer("http_status"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("snapshots_watch_fetched_idx").on(t.watchId, t.fetchedAt),
]);

export const changeEvents = pgTable("change_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  watchId: uuid("watch_id").notNull().references(() => watches.id, { onDelete: "cascade" }),
  oldSnapshotId: uuid("old_snapshot_id").references(() => snapshots.id, { onDelete: "set null" }),
  newSnapshotId: uuid("new_snapshot_id").references(() => snapshots.id, { onDelete: "set null" }),
  diffSummary: text("diff_summary").notNull(),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("change_events_watch_idx").on(t.watchId),
]);

export const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  anonymousId: text("anonymous_id"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  sessionId: text("session_id"),
  name: text("name").notNull(),
  props: jsonb("props").$type<Record<string, unknown>>().notNull().default({}),
  ipHash: text("ip_hash"),
  uaHash: text("ua_hash"),
}, (t) => [
  index("events_name_occurred_idx").on(t.name, t.occurredAt),
  index("events_user_idx").on(t.userId),
  index("events_occurred_idx").on(t.occurredAt),
]);

export type User = typeof users.$inferSelect;
export type Watch = typeof watches.$inferSelect;
export type Snapshot = typeof snapshots.$inferSelect;
export type ChangeEvent = typeof changeEvents.$inferSelect;
export type AnalyticsEvent = typeof events.$inferSelect;
