import { db } from '../lib/firestoreAdmin';
import { getNotificationDef } from './catalog';
import type {
  AudienceStream,
  BusinessNotificationOverride,
  Channel,
  NotificationDef,
  ResolvedChannels,
  UserNotificationPrefs,
} from './types';

const ALL_CHANNELS: Channel[] = ['email', 'sms', 'push'];

/**
 * Audience revamp 2026-07: computes the stream-effective view of a business
 * override. The operator's flat fields stay the business-wide default; an
 * optional `streams.{kinfolk|business|staff}` overlay refines them per stream
 * with FIELD-level fallback:
 *   enabled / lockedEnabled , overlay value ?? flat value
 *   channels / locked       , PER-CHANNEL merge (overlay[ch] ?? flat[ch])
 *   lockReason              , always flat (per-notification, not per-stream)
 * No streams block (or no overlay for this stream) = flat behavior exactly,
 * so pre-revamp override docs resolve identically (zero-migration guarantee).
 */
export function overrideForStream(
  override: BusinessNotificationOverride | null,
  stream: AudienceStream,
): BusinessNotificationOverride | null {
  if (!override) return null;
  const overlay = override.streams?.[stream];

  const channels: Partial<ResolvedChannels> = {};
  const locked: Partial<Record<Channel, true>> = {};
  for (const ch of ALL_CHANNELS) {
    const chValue = overlay?.channels?.[ch] ?? override.channels?.[ch];
    if (typeof chValue === 'boolean') channels[ch] = chValue;
    if ((overlay?.locked?.[ch] ?? override.locked?.[ch]) === true) locked[ch] = true;
  }

  const effective: BusinessNotificationOverride = {
    enabled: overlay?.enabled ?? override.enabled,
    channels,
  };
  const lockedEnabled = overlay?.lockedEnabled ?? override.lockedEnabled;
  if (typeof lockedEnabled === 'boolean') effective.lockedEnabled = lockedEnabled;
  if (Object.keys(locked).length > 0) effective.locked = locked;
  if (typeof override.lockReason === 'string') effective.lockReason = override.lockReason;
  return effective;
}

/**
 * Maps a resolved recipient to the audience stream their copy rides on:
 * clients/ recipients are the kinfolk stream; staff/ recipients ride the staff
 * stream when the key serves staff, else the business (owner-hat) stream.
 * Single source of truth for the dispatcher AND computeEffectiveChannels.
 */
export function streamForRecipient(
  def: NotificationDef,
  recipientCollection: 'clients' | 'staff',
): AudienceStream {
  if (recipientCollection === 'clients') return 'kinfolk';
  return def.audiences.staff ? 'staff' : 'business';
}

/**
 * Reads the recipient's per-user notification prefs from either
 * `clients/{uid}` (kinfolk) or `staff/{uid}` (auntie/admin).
 *
 * Caller passes `recipientCollection` because role lookup happens upstream
 * in the recipient resolver, splitting concerns keeps this pure.
 */
export async function loadUserPrefs(
  uid: string,
  recipientCollection: 'clients' | 'staff',
): Promise<UserNotificationPrefs> {
  const snap = await db().collection(recipientCollection).doc(uid).get();
  const data = snap.data();
  if (!data) return {};
  const raw = data['notificationPrefs'] as UserNotificationPrefs | undefined;
  return raw ?? {};
}

/** Reads the business admin override for a given notification key. */
export async function loadBusinessOverride(
  key: string,
): Promise<BusinessNotificationOverride | null> {
  const snap = await db().collection('businessSettings').doc('notifications').get();
  if (!snap.exists) return null;
  const data = snap.data() as { byKey?: Record<string, BusinessNotificationOverride> } | undefined;
  return data?.byKey?.[key] ?? null;
}

/**
 * Compute effective channels for a notification dispatch.
 *
 * Audience revamp 2026-07: the caller names which audience `stream` this copy
 * rides on (kinfolk / business / staff). Step 0 collapses the override to its
 * stream-effective view (overrideForStream); the precedence below then applies
 * unchanged to that view.
 *
 * Precedence (highest wins):
 *   1. business override .enabled = false         , entire notification suppressed (#7: even alwaysEnabled)
 *   2. business override .channels.{ch} = false   , channel suppressed (#7: even a required channel)
 *   3. catalog.required.{ch} = true               , channel defaults ON (unless disabled in 2)
 *   4. user prefs byKey.{ch}                      , granular override
 *   5. user prefs byCategory.{cat}.{ch}           , category default
 *   6. catalog allowedChannels                    , final fallback
 *      (email defaults ON; sms/push default OFF until user opts in)
 *
 * Marketing-class notifications require an explicit marketingOptIn for the
 * marketingCategory; absence of opt-in = all channels off (CAN-SPAM/CASL).
 *
 * Returns `{ email:false, sms:false, push:false }` when fully suppressed ,
 * caller should skip dispatch in that case.
 */
export function resolveChannels(
  def: NotificationDef,
  userPrefs: UserNotificationPrefs,
  rawBusinessOverride: BusinessNotificationOverride | null,
  stream: AudienceStream,
): ResolvedChannels {
  const businessOverride = overrideForStream(rawBusinessOverride, stream);
  const out: ResolvedChannels = { email: false, sms: false, push: false };

  // #7 (2026-06-08): warn-but-allow-off. The operator may disable any notification,
  // including alwaysEnabled ones (the admin UI warns first). Honoring it here keeps
  // the dispatch layer truthful with what the admin matrix shows (no UI/send divergence).
  // Marketing opt-in (below) is a separate legal gate the operator cannot override.
  if (businessOverride && businessOverride.enabled === false) {
    return out;
  }

  if (def.marketingCategory) {
    const optedIn = userPrefs.marketingOptIn?.[def.marketingCategory] === true;
    if (!optedIn) return out;
  }

  for (const ch of ALL_CHANNELS) {
    if (!def.allowedChannels.includes(ch)) continue;

    // #7: an explicit operator disable wins, even over a catalog-required channel
    // (warn-but-allow-off). The admin UI flags the risk; the operator stays in control.
    if (businessOverride?.channels?.[ch] === false) {
      out[ch] = false;
      continue;
    }

    // Run-4 #13: a LOCKED channel (or the whole notification locked) pins the business
    // setting; the kinfolk's per-key/per-category pref is ignored. The authoritative
    // value is the admin's explicit channel choice, else the catalog default
    // (required -> on, otherwise email-on). An explicit admin OFF is already handled
    // above, so here the locked value is the admin's ON or the catalog default.
    if (businessOverride?.locked?.[ch] === true || businessOverride?.lockedEnabled === true) {
      out[ch] = businessOverride?.channels?.[ch] ?? (def.required[ch] === true || ch === 'email');
      continue;
    }

    // Catalog-required channels default ON unless the operator disabled them above.
    if (def.required[ch] === true) {
      out[ch] = true;
      continue;
    }

    const userKeyPref = userPrefs.byKey?.[def.key]?.[ch];
    if (typeof userKeyPref === 'boolean') {
      out[ch] = userKeyPref;
      continue;
    }

    const userCatPref = userPrefs.byCategory?.[def.category]?.[ch];
    if (typeof userCatPref === 'boolean') {
      out[ch] = userCatPref;
      continue;
    }

    out[ch] = ch === 'email';
  }

  return out;
}

/** Convenience for tests / dispatcher: loads + resolves in one call. */
export async function computeEffectiveChannels(
  notificationKey: string,
  recipientUid: string,
  recipientCollection: 'clients' | 'staff',
): Promise<ResolvedChannels> {
  const def = getNotificationDef(notificationKey);
  const [userPrefs, businessOverride] = await Promise.all([
    loadUserPrefs(recipientUid, recipientCollection),
    loadBusinessOverride(notificationKey),
  ]);
  // Audience revamp 2026-07: derive the stream exactly like the dispatcher does.
  return resolveChannels(
    def,
    userPrefs,
    businessOverride,
    streamForRecipient(def, recipientCollection),
  );
}
