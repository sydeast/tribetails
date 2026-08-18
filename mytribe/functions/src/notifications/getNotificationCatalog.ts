import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { NOTIFICATION_CATALOG, alwaysEnabledForStream } from './catalog';
import { overrideForStream } from './prefs';
import type {
  Channel,
  MarketingCategory,
  BusinessNotificationOverride,
  NotificationDef,
} from './types';
import { db } from '../lib/firestoreAdmin';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';

/**
 * Returns the kinfolk-facing notification catalog at runtime, closes the
 * long-standing TODO(E5b) in MyTribe `src/commonMain/.../notifications/
 * NotificationCatalog.kt` where the client mirrored the catalog by hand
 * and silently drifted whenever a new kinfolk-facing key landed.
 *
 * Filter rules (audience revamp 2026-07):
 *   - `audiences.kinfolk === true`   (business/staff-only keys hidden)
 *   - alwaysEnabled keys ARE included, presented fully locked, so the
 *     household can see what it will always receive (they were hidden before).
 *   - gate reads use the KINFOLK stream-effective override view; a key whose
 *     kinfolk stream the operator disabled (or gated to zero channels) hides.
 *
 * Projected shape mirrors `KINFOLK_CATEGORIES` + `NotificationKey` in the
 * client so the consumer can swap the static const for a dynamic fetch
 * with zero rendering changes.
 *
 * Auth: any signed-in caller. Catalog is non-sensitive product config ,
 * not a leak vector, but we still require auth to keep crawler/replay
 * traffic off the function.
 */

export interface CategoryDescriptor {
  id: string;
  title: string;
  description: string;
}

const CATEGORY_DESCRIPTORS: Record<string, CategoryDescriptor> = {
  visit: {
    id: 'visit',
    title: 'Visit Updates',
    description: 'Real-time status as your Auntie arrives, departs, or marks a visit unavailable.',
  },
  kintale: {
    id: 'kintale',
    title: 'KinTales',
    description: 'Daily stories, photos, and notes from your Auntie.',
  },
  invoice: {
    id: 'invoice',
    title: 'Invoices & Payments',
    description: 'Invoice updates, reminders, and payment confirmations.',
  },
  schedule: {
    id: 'schedule',
    title: 'Upcoming Care',
    description: 'Reminders for KinCare visits coming up on your calendar.',
  },
  home: {
    id: 'home',
    title: 'Home & Pets',
    description: 'Acknowledgements when your home information or pet records change.',
  },
  account: {
    id: 'account',
    title: 'Account',
    description: 'Account changes, security notices, and recovery messages.',
  },
  ratings: {
    id: 'ratings',
    title: 'Ratings & Feedback',
    description: 'Requests for feedback after a visit.',
  },
  marketing: {
    id: 'marketing',
    title: 'Newsletters & Community',
    description: 'Opt-in announcements, surveys, and promotions. Disable any anytime.',
  },
  security: {
    id: 'security',
    title: 'Security',
    description: 'Alerts about your account security.',
  },
  messages: {
    id: 'messages',
    title: 'Messages',
    // #386: this bucket now also carries `broadcast.message`, the announcement
    // the office sends to a group of households at once, so the sentence names
    // both kinds of message rather than only the 1:1 thread.
    description: 'Messages and announcements from Tribe Tails.',
  },
};

export interface NotificationKeyDto {
  key: string;
  /** Default title, client should overlay locale if/when localisation lands. */
  title: string;
  description: string;
  allowedChannels: Channel[];
  required: Channel[];
  /**
   * Run-4 #13: channels the admin has LOCKED. The kinfolk can see these but must not
   * change them (render read-only); the dispatcher enforces the lock server-side too,
   * so a stale client that ignores this still can't override. `lockedEnabled` locks
   * every allowed channel. Audience revamp 2026-07: alwaysEnabled keys and
   * catalog-required channels also surface here, they are user-immutable in
   * resolveChannels, so from the household's seat they ARE locked.
   */
  lockedChannels: Channel[];
  marketingCategory: MarketingCategory | null;
  /** Operator-authored reason shown on locked/required rows (trimmed), null when unset. */
  lockReason: string | null;
}

export interface CategoryDto {
  id: string;
  title: string;
  description: string;
  keys: NotificationKeyDto[];
}

export interface GetNotificationCatalogResult {
  categories: CategoryDto[];
  /** Catalog version stamp, bump when shape changes; client can warn on mismatch. */
  schemaVersion: 1;
}

function titleCaseFromKey(key: string): string {
  // Default human title from dotted key when not specified elsewhere.
  // 'kincare.auntie.on_my_way' → 'On My Way'. Last segment, underscores → spaces.
  const tail = key.split('.').pop() ?? key;
  return tail
    .split('_')
    .map((s) => (s.length ? s[0].toUpperCase() + s.slice(1) : s))
    .join(' ');
}

/**
 * Audience revamp 2026-07: which of the gate-surviving channels render locked
 * (read-only) for the kinfolk.
 *   alwaysEnabled            → every surviving channel (cannot silence the key at all)
 *   effective lockedEnabled  → every surviving channel (operator pinned the row)
 *   otherwise                → operator per-channel locks UNION catalog-required
 *                              channels (required forces the channel on in
 *                              resolveChannels unless the operator disabled it,
 *                              and a disabled channel never survives the gate,
 *                              so a surviving required channel is user-immutable).
 * `effectiveOverride` must already be the kinfolk stream-effective view.
 */
export function lockedChannelsFor(
  def: NotificationDef,
  effectiveOverride: BusinessNotificationOverride | null,
  survivingChannels: Channel[],
): Channel[] {
  if (alwaysEnabledForStream(def, 'kinfolk')) return [...survivingChannels];
  if (effectiveOverride?.lockedEnabled) return [...survivingChannels];
  return survivingChannels.filter(
    (ch) => effectiveOverride?.locked?.[ch] === true || def.required[ch] === true,
  );
}

export async function getNotificationCatalogHandler(
  req: CallableRequest<unknown>,
): Promise<GetNotificationCatalogResult> {
  if (!req.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required to read notification catalog.');
  }

  // #6: apply the admin's business-side overrides so a kinfolk only sees the notification
  // types + channels the business ENABLED. Missing doc = catalog defaults (fail-open; the
  // dispatcher still enforces the matrix at send time). A type the admin disabled, or one
  // whose channels the admin all disabled, is hidden from the kinfolk entirely.
  const overridesSnap = await db().collection('businessSettings').doc('notifications').get();
  const byKey = (overridesSnap.data()?.byKey ?? {}) as Record<string, BusinessNotificationOverride>;

  // Group filtered entries by category, preserving catalog declaration order.
  const grouped = new Map<string, NotificationKeyDto[]>();
  for (const def of Object.values(NOTIFICATION_CATALOG)) {
    // Audience revamp 2026-07: surface every key whose audiences include the
    // kinfolk stream (was kinfolkFacing); alwaysEnabled keys are no longer
    // skipped, they render fully locked via lockedChannelsFor below.
    if (!def.audiences.kinfolk) continue;
    // All gate reads use the KINFOLK stream-effective override view.
    const ov = overrideForStream(byKey[def.key] ?? null, 'kinfolk');
    if (ov && ov.enabled === false) continue; // admin disabled this type for the kinfolk stream
    const required: Channel[] = (Object.keys(def.required) as Channel[]).filter(
      (c) => def.required[c] === true,
    );
    // Drop any channel the admin disabled (explicit false in the override). #7
    // (2026-06-08): required channels are no longer force-kept — the operator may
    // turn off even a required channel business-wide, and that propagates here.
    const allowedChannels: Channel[] = def.allowedChannels.filter(
      (ch) => !(ov?.channels && ov.channels[ch] === false),
    );
    if (allowedChannels.length === 0) continue; // nothing left to choose -> hide it
    // Run-4 #13 + audience revamp 2026-07: surface everything the kinfolk must
    // render read-only (admin locks, alwaysEnabled keys, required channels).
    const lockedChannels: Channel[] = lockedChannelsFor(def, ov, allowedChannels);
    // lockReason is flat (per-notification, never per-stream); trim, empty -> null.
    const rawLockReason = byKey[def.key]?.lockReason;
    const lockReason =
      typeof rawLockReason === 'string' && rawLockReason.trim() !== ''
        ? rawLockReason.trim()
        : null;
    const dto: NotificationKeyDto = {
      key: def.key,
      title: def.label || titleCaseFromKey(def.key),
      description: def.description,
      allowedChannels,
      required,
      lockedChannels,
      marketingCategory: def.marketingCategory ?? null,
      lockReason,
    };
    if (!grouped.has(def.category)) grouped.set(def.category, []);
    grouped.get(def.category)!.push(dto);
  }

  const categories: CategoryDto[] = [];
  for (const [catId, keys] of grouped.entries()) {
    const descriptor = CATEGORY_DESCRIPTORS[catId] ?? {
      id: catId,
      title: catId,
      description: '',
    };
    categories.push({ ...descriptor, keys });
  }

  return { categories, schemaVersion: 1 };
}

export const getNotificationCatalog = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: ['SENTRY_DSN'],
  },
  wrapCallable('getNotificationCatalog', getNotificationCatalogHandler),
);
