import { db } from '../lib/firestoreAdmin';
import {
  NOTIFICATION_CATALOG,
  canonicalNotificationKey,
  getNotificationDef,
  legacyCategoriesFor,
  legacyKeysFor,
  lockedOnForStream,
} from './catalog';
import type {
  AudienceStream,
  BusinessNotificationOverride,
  Category,
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
 * Ruling on #2382 (2026-11-20): payment, invoice, KinTale and booking
 * confirmations are required on and cannot be disabled. For a key whose
 * `lockedOnStreams` lists [stream], a stored operator OFF for the whole
 * notification or for its email channel is dropped from the stream-effective
 * view, so the notification stays on and email falls through to the catalog's
 * `required.email`. Text and push are untouched: the operator may still gate
 * them, and the household still chooses them.
 *
 * Old settings docs can hold such an off from before the ruling (warn-but-allow-
 * off, #7), and the save handler now refuses a new one. Reading through this
 * view rather than trusting the stored value is what keeps the send, the
 * household's settings screen and the owner's gate in agreement.
 *
 * `effectiveOverride` must already be [stream]'s view (overrideForStream). The
 * household launch switch (`householdNotificationsLive`) is a separate gate and
 * still holds these until launch.
 */
export function withConfirmationLock(
  def: NotificationDef,
  effectiveOverride: BusinessNotificationOverride | null,
  stream: AudienceStream,
): BusinessNotificationOverride | null {
  if (!effectiveOverride || !lockedOnForStream(def, stream)) return effectiveOverride;
  const offWhole = effectiveOverride.enabled === false;
  const offEmail = effectiveOverride.channels?.email === false;
  if (!offWhole && !offEmail) return effectiveOverride;
  const channels: Partial<ResolvedChannels> = { ...(effectiveOverride.channels ?? {}) };
  delete channels.email;
  return { ...effectiveOverride, enabled: true, channels };
}

/**
 * The override exactly as the send reads it for [stream]: the stream overlay
 * (overrideForStream) with the confirmation lock applied (withConfirmationLock).
 * Every reader that decides what a recipient on [stream] gets, or draws it,
 * goes through this one view.
 */
export function gateViewFor(
  def: NotificationDef,
  rawBusinessOverride: BusinessNotificationOverride | null,
  stream: AudienceStream,
): BusinessNotificationOverride | null {
  return withConfirmationLock(def, overrideForStream(rawBusinessOverride, stream), stream);
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

/**
 * Picks the stored override row that governs [key], following key aliases.
 *
 * An override row is authored as a unit (enabled + channels + locks), so this
 * picks ONE row rather than merging fields across rows: the canonical row if
 * the operator has one, otherwise the row left behind under a retired key.
 */
export function resolveOverrideForKey(
  byKey: Record<string, BusinessNotificationOverride>,
  key: string,
): BusinessNotificationOverride | null {
  const canonical = canonicalNotificationKey(key);
  const own = byKey[canonical];
  if (own) return own;
  for (const legacy of legacyKeysFor(canonical)) {
    const stale = byKey[legacy];
    if (stale) return stale;
  }
  return null;
}

/** Reads the business admin override for a given notification key. */
export async function loadBusinessOverride(
  key: string,
): Promise<BusinessNotificationOverride | null> {
  const snap = await db().collection('businessSettings').doc('notifications').get();
  if (!snap.exists) return null;
  const data = snap.data() as { byKey?: Record<string, BusinessNotificationOverride> } | undefined;
  return resolveOverrideForKey(data?.byKey ?? {}, key);
}

/**
 * The user's explicit choice for [ch] on [def], or undefined when they never
 * expressed one.
 *
 * Alias-aware, canonical-first at each precedence level:
 *   byKey[canonical] → byKey[legacy] → byCategory[canonical] → byCategory[legacy]
 *
 * Canonical-first matters: the merged switch in the settings UI writes the
 * canonical key, so a household's newest deliberate choice always wins over
 * whatever was left under the retired key. Without that, the UI would show ON
 * while the dispatcher stayed OFF. Legacy-next matters just as much: a
 * household that opted out before the merge stays opted out.
 */
function explicitUserChoice(
  def: NotificationDef,
  userPrefs: UserNotificationPrefs,
  ch: Channel,
): boolean | undefined {
  for (const key of [def.key, ...legacyKeysFor(def.key)]) {
    const v = userPrefs.byKey?.[key]?.[ch];
    if (typeof v === 'boolean') return v;
  }
  for (const category of [def.category, ...legacyCategoriesFor(def.key)]) {
    const v = userPrefs.byCategory?.[category]?.[ch];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/**
 * The same prefs, with every alias-inherited choice written out under the
 * canonical key and category a client actually reads (#501).
 *
 * `explicitUserChoice` above walks aliases; no client does. A household that
 * turned a channel off before two keys were merged has that choice stored
 * under the retired key, so `resolveChannels` finds it and sends nothing,
 * while every settings screen looks up the canonical key, finds nothing, falls
 * back to the catalog default, and draws the switch ON. They are opted out and
 * the screen says they are opted in, which is the worse direction of the two:
 * it is the case where somebody is waiting for a notification that is never
 * coming.
 *
 * The fix belongs in one place rather than in each of the four clients, and
 * this is the narrowest place that is genuinely one: both prefs callables
 * return what this produces, so every screen resolves the canonical key and
 * gets the honest answer without knowing aliases exist.
 *
 * PER CHANNEL, not per entry, because that is how `explicitUserChoice` walks:
 * a canonical entry that sets only `sms` does not shadow a retired entry's
 * `email`. Canonical always wins where it has an opinion, so materialising
 * only the gaps cannot change what the dispatcher does.
 *
 * ADDITIVE. Retired entries are left exactly where they are rather than
 * folded away, which keeps this a view instead of a migration. It matters
 * because the clients send the whole prefs object back on save: if this
 * dropped the retired entry, the first save after any edit would delete a
 * choice `explicitUserChoice` still honors, and clearing a canonical override
 * later would silently stop meaning what the household asked for. Leaving it
 * means a cleared override falls back to the retired choice on the next read,
 * on screen and in the dispatcher alike, which is what the alias list says
 * should happen.
 */
export function withAliasedChoicesResolved(prefs: UserNotificationPrefs): UserNotificationPrefs {
  const byKey: Record<string, Partial<ResolvedChannels>> = { ...(prefs.byKey ?? {}) };
  const byCategory: Partial<Record<Category, Partial<ResolvedChannels>>> = {
    ...(prefs.byCategory ?? {}),
  };
  let changed = false;
  for (const def of Object.values(NOTIFICATION_CATALOG)) {
    const legacyKeys = legacyKeysFor(def.key);
    const legacyCategories = legacyCategoriesFor(def.key);
    if (legacyKeys.length === 0 && legacyCategories.length === 0) continue;
    for (const ch of ALL_CHANNELS) {
      if (typeof byKey[def.key]?.[ch] !== 'boolean') {
        for (const legacy of legacyKeys) {
          const inherited = prefs.byKey?.[legacy]?.[ch];
          if (typeof inherited === 'boolean') {
            byKey[def.key] = { ...byKey[def.key], [ch]: inherited };
            changed = true;
            break;
          }
        }
      }
      // Categories are shared: several keys sit in one, and only the keys with
      // an alias contribute a legacy category to it. Iterating the catalog in
      // declaration order and skipping a channel that already has a value
      // makes the result deterministic if two aliased keys ever land in the
      // same canonical category with different legacy ones.
      if (typeof byCategory[def.category]?.[ch] !== 'boolean') {
        for (const legacyCategory of legacyCategories) {
          const inherited = prefs.byCategory?.[legacyCategory]?.[ch];
          if (typeof inherited === 'boolean') {
            byCategory[def.category] = { ...byCategory[def.category], [ch]: inherited };
            changed = true;
            break;
          }
        }
      }
    }
  }
  if (!changed) return prefs;
  return { ...prefs, byKey, byCategory };
}
/**
 * Why a notification is switched OFF for this recipient as a whole, before any
 * channel is looked at, or null when it is on and the channels decide.
 *
 *   'operator'   the business override disables the notification on this
 *                stream (#7, warn-but-allow-off: even an alwaysEnabled row),
 *                but never a confirmation locked on for the stream (#2382).
 *   'marketing'  the key is marketing-class and the recipient has not opted
 *                in (CAN-SPAM/CASL), a legal gate the operator cannot lift.
 *
 * These are the only two reasons `resolveChannels` answers all-off without
 * consulting a single channel, and since #1505 they are the only two reasons
 * the dispatcher writes NO notifications record. A recipient who leaves the
 * notification on but turns every delivery channel off is not disabled: the
 * record is written for their notifications list and nothing is sent.
 */
export type NotificationDisabledReason = 'operator' | 'marketing';

export function notificationDisabledFor(
  def: NotificationDef,
  userPrefs: UserNotificationPrefs,
  rawBusinessOverride: BusinessNotificationOverride | null,
  stream: AudienceStream,
): NotificationDisabledReason | null {
  const businessOverride = gateViewFor(def, rawBusinessOverride, stream);

  // #7 (2026-06-08): warn-but-allow-off. The operator may disable any notification,
  // including alwaysEnabled ones (the admin UI warns first). Honoring it here keeps
  // the dispatch layer truthful with what the admin matrix shows (no UI/send divergence).
  // Exception (#2382, 2026-11-20): a confirmation locked on for this stream
  // (`lockedOnStreams`) ignores a stored off; `gateViewFor` has already dropped it.
  // Marketing opt-in (below) is a separate legal gate the operator cannot override.
  if (businessOverride && businessOverride.enabled === false) {
    return 'operator';
  }

  if (def.marketingCategory) {
    const optedIn = userPrefs.marketingOptIn?.[def.marketingCategory] === true;
    if (!optedIn) return 'marketing';
  }

  return null;
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
 *   0b. confirmation lock (#2382, 2026-11-20)     , on a `lockedOnStreams` stream a stored
 *                                                   enabled=false or channels.email=false is
 *                                                   dropped before steps 1 and 2 (gateViewFor)
 *   1. business override .enabled = false         , entire notification suppressed (#7: even alwaysEnabled)
 *   2. business override .channels.{ch} = false   , channel suppressed (#7: even a required channel)
 *   3. catalog.required.{ch} = true               , channel defaults ON (unless disabled in 2)
 *   4. user prefs byKey.{ch}                      , granular override
 *   5. user prefs byCategory.{cat}.{ch}           , category default
 *      (4 and 5 follow key aliases, canonical first, then any retired key
 *       merged into it, so pre-merge choices keep being honored)
 *   6. catalog allowedChannels                    , final fallback
 *      (email defaults ON; sms/push default OFF until user opts in)
 *
 * Marketing-class notifications require an explicit marketingOptIn for the
 * marketingCategory; absence of opt-in = all channels off (CAN-SPAM/CASL).
 *
 * Returns `{ email:false, sms:false, push:false }` when nothing is to be
 * delivered. That alone does not mean "skip" any more (#1505): the dispatcher
 * asks `notificationDisabledFor` whether the notification itself is off, and
 * only then writes nothing. All-off channels on a notification that is ON
 * still produce the notifications record, with no delivery behind it.
 */
export function resolveChannels(
  def: NotificationDef,
  userPrefs: UserNotificationPrefs,
  rawBusinessOverride: BusinessNotificationOverride | null,
  stream: AudienceStream,
): ResolvedChannels {
  // Step 0 + 0b: the stream overlay, then the confirmation lock (#2382).
  const businessOverride = gateViewFor(def, rawBusinessOverride, stream);
  const out: ResolvedChannels = { email: false, sms: false, push: false };

  // Steps 1 and the marketing gate: the notification as a whole is off, so no
  // channel is consulted. Shared with the dispatcher through
  // `notificationDisabledFor`, which needs the same answer for a different
  // reason (#1505): these are the only two cases in which it writes nothing.
  if (notificationDisabledFor(def, userPrefs, rawBusinessOverride, stream) !== null) {
    return out;
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

    // Steps 4+5, alias-aware: per-key then per-category, canonical before any
    // retired key that was merged into this one (see explicitUserChoice).
    const userChoice = explicitUserChoice(def, userPrefs, ch);
    if (typeof userChoice === 'boolean') {
      out[ch] = userChoice;
      continue;
    }

    out[ch] = ch === 'email';
  }

  return out;
}

/**
 * #1905: the channels THIS RECIPIENT switched off for [def]: the ones that
 * would have gone out had they made no choice of their own, and do not because
 * of it. Decided by asking `resolveChannels` twice, with and without their
 * per-notification and per-category choices, so it can never disagree with the
 * send.
 *
 * So it is not a channel that is off by default (text message and push start
 * off, and a saved "off" for one changes nothing), not one the operator turned
 * off or locked, and not one the catalog requires. The Activity Log names
 * these, so a household's copy that went to their notifications list alone
 * says why no email followed.
 */
export function channelsSwitchedOffByRecipient(
  def: NotificationDef,
  userPrefs: UserNotificationPrefs,
  rawBusinessOverride: BusinessNotificationOverride | null,
  stream: AudienceStream,
): Channel[] {
  const withTheirs = resolveChannels(def, userPrefs, rawBusinessOverride, stream);
  const withoutTheirs = resolveChannels(
    def,
    { ...userPrefs, byKey: {}, byCategory: {} },
    rawBusinessOverride,
    stream,
  );
  return ALL_CHANNELS.filter((ch) => withoutTheirs[ch] && !withTheirs[ch]);
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
