import { z } from 'zod';

/**
 * Shared zod schema for user notification preferences (the hybrid
 * byCategory / byKey / marketingOptIn shape in notifications/types.ts
 * UserNotificationPrefs). Used by BOTH the kinfolk portal callables
 * (clients/{uid}.notificationPrefs) and the admin callables
 * (staff/{uid}.notificationPrefs) so the two cannot drift.
 */
const Channel = z.enum(['email', 'sms', 'push']);
const Category = z.enum([
  'visit',
  'kintale',
  'invoice',
  'schedule',
  'home',
  'account',
  'ratings',
  'marketing',
  // Bug fix (audience revamp 2026-07): types.ts Category always included
  // 'security' but this enum omitted it, rejecting valid security-row prefs.
  'security',
  // Vendor-parity (2026-07-02): inbox message notifications.
  'messages',
]);
const MarketingCategory = z.enum(['newsletter', 'survey', 'marketing']);

const ChannelMap = z.partialRecord(Channel, z.boolean()).optional();

export const PrefsShape = z.object({
  byCategory: z.partialRecord(Category, ChannelMap).optional(),
  byKey: z.record(z.string(), ChannelMap).optional(),
  marketingOptIn: z.partialRecord(MarketingCategory, z.boolean()).optional(),
});

export const SaveArgs = z.object({ prefs: PrefsShape });

/**
 * The set options both prefs-save handlers must use.
 *
 * `set(..., { merge: true })` cannot express a DELETION. It derives the update
 * mask from the payload itself, and DocumentMask.fromObject
 * (@google-cloud/firestore/build/src/document.js:607-643) pushes only LEAF
 * paths into it, so a `byKey` entry the client deliberately left out is absent
 * from the mask and the server keeps the stale one. Clearing a per-key override
 * — the whole point of the portal's "follow the category" state — then reported
 * success for a write that never happened.
 *
 * Naming the PARENT path in `mergeFields` puts `notificationPrefs` itself in the
 * mask (write-batch.js:271-291 builds the mask from this list, not from the
 * payload), which replaces the whole subtree, so an omitted entry is really
 * gone. `set` still creates the document when it is missing, which `update()`
 * would not, and the serverTimestamp transform is stripped from the mask by
 * `documentMask.removeFields(transform.fields)` exactly as it is under merge.
 *
 * Safe only because every client does a full read-modify-write of the whole
 * prefs object: the portal web screen seeds its edit state from
 * `prefs.data.prefs`, the portal Compose screen seeds all three maps from
 * `getMyNotificationPrefs()`, and all three admin clients hold the decoded
 * prefs and save them back whole. A client that ever sends a PARTIAL prefs
 * object would turn this from a lost revert into lost preferences.
 */
export function prefsSetOptions(): { mergeFields: string[] } {
  // A fresh array per call: the SDK's SetOptions takes a mutable string[], and
  // a shared module-level one would be reachable from every call site.
  return { mergeFields: ['notificationPrefs', 'notificationPrefsUpdatedAt'] };
}
