import {
  NOTIFICATION_CHANNELS,
  STREAM_BUSINESS,
  STREAM_KINFOLK,
  STREAM_STAFF,
  type AdminNotificationPrefs,
  type NotificationCatalogEntry,
  type NotificationChannel,
  type NotificationMatrix,
  type NotifStream,
} from '../api/myNotifications';

/**
 * Pure classification for the My Notifications screen, ported from the wasm
 * `NotificationOverridesRepository.kt` / `AdminNotificationPrefsRepository.kt`
 * free functions. Every predicate here answers a POSITIVE question ("is this
 * channel forced on", "is this notification visible on this stream"), never a
 * negation, so a caller reads the true/false directly instead of double-negating.
 *
 * The two only audiences this screen renders are Business ("As the owner") and
 * Staff ("As the Auntie"); Kinfolk-stream entries never reach here (that is the
 * families' own portal), matching the wasm screen's two stacked sections.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Flat + per-stream effective gate state (stream overlay wins, else the flat field)
// ─────────────────────────────────────────────────────────────────────────────

/** FLAT effective on/off for a whole notification key (override wins; default = on). */
export function flatEffectiveEnabled(matrix: NotificationMatrix, key: string): boolean {
  return matrix.overrides[key]?.enabled ?? true;
}

/** FLAT effective on/off for one channel of a key (override wins; default = on). */
export function flatEffectiveChannel(
  matrix: NotificationMatrix,
  key: string,
  channel: NotificationChannel,
): boolean {
  return matrix.overrides[key]?.channels[channel] ?? true;
}

/** FLAT: the business has pinned the whole-notification on/off. */
export function flatEffectiveLockedEnabled(matrix: NotificationMatrix, key: string): boolean {
  return matrix.overrides[key]?.lockedEnabled ?? false;
}

/** FLAT: the business has pinned this channel's on/off. */
export function flatEffectiveChannelLocked(
  matrix: NotificationMatrix,
  key: string,
  channel: NotificationChannel,
): boolean {
  return matrix.overrides[key]?.locked[channel] ?? false;
}

/** Effective on/off of `key` for `stream`'s recipients: stream gate wins, else flat. */
export function streamEffectiveEnabled(matrix: NotificationMatrix, key: string, stream: NotifStream): boolean {
  return matrix.overrides[key]?.streams[stream]?.enabled ?? flatEffectiveEnabled(matrix, key);
}

/** Effective on/off of one channel of `key` for `stream`: stream gate wins, else flat. */
export function streamEffectiveChannel(
  matrix: NotificationMatrix,
  key: string,
  stream: NotifStream,
  channel: NotificationChannel,
): boolean {
  return matrix.overrides[key]?.streams[stream]?.channels[channel] ?? flatEffectiveChannel(matrix, key, channel);
}

/** Effective whole-notification lock of `key` for `stream`: stream gate wins, else flat. */
export function streamEffectiveLockedEnabled(
  matrix: NotificationMatrix,
  key: string,
  stream: NotifStream,
): boolean {
  return matrix.overrides[key]?.streams[stream]?.lockedEnabled ?? flatEffectiveLockedEnabled(matrix, key);
}

/** Effective channel lock of `key` for `stream`: stream gate wins, else flat. */
export function streamEffectiveChannelLocked(
  matrix: NotificationMatrix,
  key: string,
  stream: NotifStream,
  channel: NotificationChannel,
): boolean {
  return (
    matrix.overrides[key]?.streams[stream]?.locked[channel] ?? flatEffectiveChannelLocked(matrix, key, channel)
  );
}

/** The operator's own lock reason for `key` (always flat; blank means none). */
export function lockReasonFor(matrix: NotificationMatrix, key: string): string | undefined {
  const reason = matrix.overrides[key]?.lockReason;
  return reason !== undefined && reason.trim() !== '' ? reason : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog-entry predicates
// ─────────────────────────────────────────────────────────────────────────────

/** A channel toggle is catalog-required (locked on) when the catalog marks it so. */
export function channelRequired(entry: NotificationCatalogEntry, channel: NotificationChannel): boolean {
  return entry.required[channel] === true;
}

/** The row title: label, else description, else the raw key (never blank). */
export function displayTitle(entry: NotificationCatalogEntry): string {
  if (entry.label.trim() !== '') return entry.label;
  if (entry.description.trim() !== '') return entry.description;
  return entry.key;
}

// ─────────────────────────────────────────────────────────────────────────────
// The two screen-facing queries
// ─────────────────────────────────────────────────────────────────────────────

/** Channels the business gate currently OFFERS `entry` on `stream` (allowed AND stream-enabled). */
export function adminGateEnabledChannels(
  matrix: NotificationMatrix,
  entry: NotificationCatalogEntry,
  stream: NotifStream,
): NotificationChannel[] {
  return NOTIFICATION_CHANNELS.filter(
    (c) => entry.allowedChannels.includes(c) && streamEffectiveChannel(matrix, entry.key, stream, c),
  );
}

/**
 * The notifications the operator can receive on `stream`: the entry serves
 * that stream, the stream's gate is on, and at least one channel is offered on
 * it. Drives the "As the owner" (business) and "As the Auntie" (staff) sections.
 */
export function adminVisibleNotifications(
  matrix: NotificationMatrix,
  stream: NotifStream,
): NotificationCatalogEntry[] {
  return matrix.catalog.filter(
    (entry) =>
      entry.audiences.has(stream) &&
      streamEffectiveEnabled(matrix, entry.key, stream) &&
      adminGateEnabledChannels(matrix, entry, stream).length > 0,
  );
}

/**
 * True when a channel is forced on for `stream`'s recipients and the operator
 * cannot change it: the business locked it for that stream (or flat), or the
 * catalog requires it outright.
 */
export function adminChannelForced(
  matrix: NotificationMatrix,
  entry: NotificationCatalogEntry,
  stream: NotifStream,
  channel: NotificationChannel,
): boolean {
  return (
    channelRequired(entry, channel) ||
    streamEffectiveLockedEnabled(matrix, entry.key, stream) ||
    streamEffectiveChannelLocked(matrix, entry.key, stream, channel)
  );
}

/**
 * Plain-language reason a forced channel is read-only: the operator's own
 * lock reason when one was written, else the stock line for catalog-required
 * versus business-locked.
 */
export function adminChannelReason(
  matrix: NotificationMatrix,
  entry: NotificationCatalogEntry,
  channel: NotificationChannel,
): string {
  const ownReason = lockReasonFor(matrix, entry.key);
  if (ownReason !== undefined) return ownReason;
  return channelRequired(entry, channel)
    ? 'Always on for this notification.'
    : 'Locked on by your business settings.';
}

/**
 * The operator's editable receive choice for one (non-forced) channel: byKey
 * wins, then byCategory, then the catalog default (email on; sms/push off).
 * Mirrors the dispatcher's resolveChannels precedence for non-locked channels.
 */
export function userChannelChoice(
  prefs: AdminNotificationPrefs,
  key: string,
  category: string,
  channel: NotificationChannel,
): boolean {
  const byKey = prefs.byKey[key]?.[channel];
  if (byKey !== undefined) return byKey;
  const byCategory = prefs.byCategory[category]?.[channel];
  if (byCategory !== undefined) return byCategory;
  return channel === 'email';
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow sections (the ONE taxonomy for both notification surfaces)
//
// This My Notifications screen only renders Business + Staff, but the same
// bucketing is the single source of truth for the business gate matrix
// (`screens/NotificationGate.tsx`), whose Kinfolk tab needs its own sections.
// So `notifSections` covers all three streams (matching the Kotlin
// `notifSections` in NotificationOverridesRepository.kt); `adminVisibleNotifications`
// is what keeps Kinfolk-stream rows off THIS screen, not the section list.
// ─────────────────────────────────────────────────────────────────────────────

export interface NotifSection {
  title: string;
  categories: readonly string[];
}

const NOTIF_SECTION_OTHER: NotifSection = { title: 'Other', categories: [] };

/** The ordered workflow sections for one stream, phrased for that stream's day. */
export function notifSections(stream: NotifStream): NotifSection[] {
  switch (stream) {
    case STREAM_BUSINESS:
      return [
        { title: 'Bookings and visits', categories: ['visit'] },
        { title: 'Messages', categories: ['messages'] },
        { title: 'Billing and payments', categories: ['invoice'] },
        { title: 'Ratings and pets', categories: ['ratings'] },
        { title: 'Account and security', categories: ['account', 'security'] },
      ];
    case STREAM_STAFF:
      return [
        { title: 'Assignments and schedule', categories: ['schedule'] },
        { title: 'Visit workflow', categories: ['visit'] },
        { title: 'KinTales and comments', categories: ['kintale'] },
        { title: 'Pets and profiles', categories: ['home'] },
      ];
    case STREAM_KINFOLK:
      return [
        { title: 'Visit updates', categories: ['visit'] },
        { title: 'Upcoming care', categories: ['schedule'] },
        { title: 'KinTales', categories: ['kintale'] },
        // #386: the household's copy of the `messages` bucket. Its only row is
        // `broadcast.message`, the announcement the office sends to a whole
        // audience segment; without this section that row falls into the
        // trailing "Other" catch-all, which is where a gate row goes to be
        // overlooked.
        { title: 'Messages', categories: ['messages'] },
        { title: 'Billing and payments', categories: ['invoice'] },
        { title: 'Home and pets', categories: ['home'] },
        { title: 'Account and security', categories: ['account', 'security'] },
        { title: 'Newsletters and community', categories: ['marketing'] },
      ];
    default:
      return [];
  }
}

/**
 * Buckets `entries` into `stream`'s workflow sections, preserving the incoming
 * (catalog) order within each. Unmatched categories land in a trailing "Other"
 * section; empty sections are dropped so a stream with nothing to show under
 * a heading never renders it.
 */
export function sectionedNotifications(
  entries: NotificationCatalogEntry[],
  stream: NotifStream,
): [NotifSection, NotificationCatalogEntry[]][] {
  const sections = notifSections(stream);
  const claimed = new Set(sections.flatMap((s) => s.categories));
  const grouped: [NotifSection, NotificationCatalogEntry[]][] = [
    ...sections.map((section): [NotifSection, NotificationCatalogEntry[]] => [
      section,
      entries.filter((e) => section.categories.includes(e.category)),
    ]),
    [NOTIF_SECTION_OTHER, entries.filter((e) => !claimed.has(e.category))],
  ];
  return grouped.filter(([, rows]) => rows.length > 0);
}

/** Human label for a channel key. */
export function channelLabel(channel: NotificationChannel): string {
  switch (channel) {
    case 'email':
      return 'Email';
    case 'sms':
      return 'Text (SMS)';
    case 'push':
      return 'Push';
  }
}
