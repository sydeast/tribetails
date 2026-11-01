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
 * A SINGLE-PREFERENCE update (#1292). The portal saves each toggle the moment
 * it is flipped, so it cannot send the whole subtree: a whole-subtree replace
 * built from one device's screen state deletes whatever another device (or a
 * stale tab) had written since that screen loaded. A patch names only what the
 * tap changed and the server merges it into what is stored.
 *
 *   byCategory       channel -> boolean, merged per channel.
 *   byKey            channel -> boolean sets one override; channel -> null
 *                    CLEARS it (back to "follow the category"); a key -> null
 *                    clears every override on that key.
 *   marketingOptIn   category -> boolean, merged.
 */
export const PatchShape = z.object({
  byCategory: z.partialRecord(Category, ChannelMap).optional(),
  byKey: z.record(z.string(), z.partialRecord(Channel, z.boolean().nullable()).nullable()).optional(),
  marketingOptIn: z.partialRecord(MarketingCategory, z.boolean()).optional(),
});
export type PrefsPatch = z.infer<typeof PatchShape>;
/** The portal callable takes the whole object (legacy clients) or one patch, never both. */
export const PortalSaveArgs = z
  .object({ prefs: PrefsShape.optional(), patch: PatchShape.optional() })
  .refine((a) => (a.prefs === undefined) !== (a.patch === undefined), {
    message: 'Send either prefs or patch, not both and not neither.',
  });
type StoredChannels = Partial<Record<z.infer<typeof Channel>, boolean>>;
type StoredPrefs = z.infer<typeof PrefsShape>;
/**
 * Merge a patch into the stored prefs. Pure, so the merge rules are testable
 * without Firestore. Untouched categories, keys and channels come through
 * unchanged; that is the whole point of a patch.
 */
export function applyPrefsPatch(existing: StoredPrefs | undefined, patch: PrefsPatch): Required<StoredPrefs> {
  const byCategory: Record<string, StoredChannels | undefined> = { ...(existing?.byCategory ?? {}) };
  for (const [cat, channels] of Object.entries(patch.byCategory ?? {})) {
    if (!channels) continue;
    byCategory[cat] = { ...(byCategory[cat] ?? {}), ...channels };
  }
  const byKey: Record<string, StoredChannels | undefined> = { ...(existing?.byKey ?? {}) };
  for (const [key, channels] of Object.entries(patch.byKey ?? {})) {
    if (channels === null) {
      delete byKey[key];
      continue;
    }
    if (!channels) continue;
    const next: StoredChannels = { ...(byKey[key] ?? {}) };
    for (const [ch, value] of Object.entries(channels) as Array<[z.infer<typeof Channel>, boolean | null | undefined]>) {
      if (value === null) delete next[ch];
      else if (typeof value === 'boolean') next[ch] = value;
    }
    if (Object.keys(next).length === 0) delete byKey[key];
    else byKey[key] = next;
  }
  const marketingOptIn = { ...(existing?.marketingOptIn ?? {}), ...(patch.marketingOptIn ?? {}) };
  return { byCategory, byKey, marketingOptIn } as Required<StoredPrefs>;
}

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
 * Safe only while every client sends all three TOP-LEVEL maps on every save,
 * empty ones as `{}`. What a client omits is not left alone, it is deleted, so a
 * save that drops an empty `byCategory` erases whatever another device had put
 * there. All five senders now send the three unconditionally: portal web
 * (`NotificationSettings.tsx`), portal Compose (`PortalApi.kt`), admin React
 * (`api/myNotificationsWrite.ts`), admin Android
 * (`AuntieRepository.saveMyAdminNotificationPrefs`) and admin Compose-web
 * (`AdminNotificationPrefsRepository.encodePrefs`) — the last two were still
 * dropping empty maps when this was written and were changed to match. The maps
 * NESTED inside stay partial on purpose: an unset channel means "inherit the
 * default".
 *
 * Nothing enforces that. All three fields of `PrefsShape` are `.optional()`
 * (above), so the server accepts a partial object and writes it as the COMPLETE
 * subtree. They cannot be tightened until the clients already in the field age
 * out: APKs and wasm bundles still running the pre-fix encoders send partial
 * payloads, and a required field would reject those saves outright. Note what
 * that costs in the meantime, because it is the uncomfortable half: a stale
 * client does not merely get accepted, it DELETES the maps it omits. Keeping
 * these optional buys compatibility by letting old clients destroy data quietly
 * where a required field would have failed loud. Fixing the senders closed the
 * hole for updated clients only.
 *
 * Server-side normalization would not rescue a partial sender either, since
 * filling in `byKey: {}` for a client that omitted it produces the identical
 * delete. The invariant lives in the five clients and in nothing else, so
 * re-check the senders before trusting it.
 */
export function prefsSetOptions(): { mergeFields: string[] } {
  // A fresh array per call: the SDK's SetOptions takes a mutable string[], and
  // a shared module-level one would be reachable from every call site.
  return { mergeFields: ['notificationPrefs', 'notificationPrefsUpdatedAt'] };
}
