import { call } from '../lib/fns';

/**
 * Wire types + wrapper functions for the Notification Settings screen's
 * callables, plus the pure category/channel display logic the screen needs.
 * Kept in a self-contained file (session S3 convention, see
 * docs/DEVELOPMENT_PLAN_2026-07-10.md) instead of api/portal.ts / api/types.ts
 * to avoid merge conflicts with parallel screen ports. Field names/types
 * transcribed from the backend handlers; each block cites its source.
 */

export type Channel = 'email' | 'sms' | 'push';
export type MarketingCategory = 'newsletter' | 'survey' | 'marketing';

// ── getNotificationCatalog (functions/src/notifications/getNotificationCatalog.ts) ──

export interface NotificationKeyDto {
  key: string;
  title: string;
  description: string;
  allowedChannels: Channel[];
  required: Channel[];
  /** Channels the operator (or the catalog's `required`) decides; render read-only. Already computed server-side. */
  lockedChannels: Channel[];
  /**
   * What the dispatcher will actually do with each locked channel (#491).
   * Locked means the household does not decide it, NOT that it is on: a channel
   * locked by `lockedEnabled` that the operator never set resolves off for sms
   * and push. Ships with the lock so this client does not re-derive it.
   *
   * OPTIONAL, and it has to stay optional. This app deploys on its own
   * schedule and the functions fleet deploys in an operator-run batch, so
   * there is a window where a browser running this code is talking to a
   * callable that has never heard of the field. Absent reads as ON below,
   * which is the pre-#491 behaviour, so the skew window degrades to the old
   * rendering instead of throwing on `undefined[ch]` and taking the whole
   * settings screen down. The Compose portal makes the same allowance.
   */
  lockedChannelValues?: Partial<Record<Channel, boolean>>;
  marketingCategory: MarketingCategory | null;
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
  schemaVersion: 1;
}

/** Auth: any signed-in caller; no payload (functions/src/notifications/getNotificationCatalog.ts). */
export function getNotificationCatalog(): Promise<GetNotificationCatalogResult> {
  return call<Record<string, never>, GetNotificationCatalogResult>('getNotificationCatalog', {});
}

// ── getMyNotificationPrefs / saveMyNotificationPrefs (functions/src/portal/notificationPrefs.ts) ──

/**
 * Matches notifications/types.ts `UserNotificationPrefs`. Both callables are
 * uid-scoped only — getMyNotificationPrefsHandler reads `clients/{req.auth.uid}`
 * directly and saveMyNotificationPrefsHandler's zod `SaveArgs` (notifications/
 * prefsSchema.ts) has no kinfolkId field, so neither wrapper takes one (unlike
 * most of api/portal.ts's kinfolkId-threaded calls).
 */
export interface UserNotificationPrefs {
  byCategory?: Partial<Record<string, Partial<Record<Channel, boolean>>>>;
  byKey?: Record<string, Partial<Record<Channel, boolean>>>;
  marketingOptIn?: Partial<Record<MarketingCategory, boolean>>;
}

export interface GetMyNotificationPrefsResult {
  prefs: UserNotificationPrefs;
  updatedAtMs: number | null;
}

export function getMyNotificationPrefs(): Promise<GetMyNotificationPrefsResult> {
  return call<Record<string, never>, GetMyNotificationPrefsResult>('getMyNotificationPrefs', {});
}

export interface SaveMyNotificationPrefsRequest {
  prefs: UserNotificationPrefs;
}

export interface SaveMyNotificationPrefsResult {
  ok: true;
}

export function saveMyNotificationPrefs(prefs: UserNotificationPrefs): Promise<SaveMyNotificationPrefsResult> {
  return call<SaveMyNotificationPrefsRequest, SaveMyNotificationPrefsResult>('saveMyNotificationPrefs', { prefs });
}

// ── pure category/channel display logic ─────────────────────────────────
//
// The mockup (ui-ideas/mytribe-notifications-2026-05-31.html) renders one row
// per CHANNEL within a category card (Push/Email/SMS), not one row per
// notification key the way the Compose screen's expand panel does. These
// helpers project the catalog's per-key allowedChannels/lockedChannels into
// that per-category-per-channel shape so the screen can stay a thin renderer.
// See NotificationSettings.tsx's file comment for the write-semantics this
// feeds (byCategory only; this screen never writes byKey).

/** Canonical row order, matches the mockup (Push, Email, SMS). */
export const CHANNEL_ORDER: Channel[] = ['push', 'email', 'sms'];

/** Channels the category renders a row for: the union of every key's allowedChannels, in canonical order. */
export function categoryChannels(cat: CategoryDto): Channel[] {
  const present = new Set<Channel>();
  for (const k of cat.keys) for (const ch of k.allowedChannels) present.add(ch);
  return CHANNEL_ORDER.filter((ch) => present.has(ch));
}

/**
 * Channels at least one key in the category leaves free to toggle
 * (allowedChannels minus lockedChannels, unioned across keys). A channel in
 * categoryChannels() but absent here is locked for the whole category —
 * every key that offers it also pins it on — so the row renders read-only.
 */
export function categoryToggleableChannels(cat: CategoryDto): Channel[] {
  const free = new Set<Channel>();
  for (const k of cat.keys) {
    for (const ch of k.allowedChannels) {
      if (!k.lockedChannels.includes(ch)) free.add(ch);
    }
  }
  return CHANNEL_ORDER.filter((ch) => free.has(ch));
}

/**
 * Effective checked state for one channel row.
 *
 * A channel locked across the whole category reads what the dispatcher will
 * send on it, and only reads ON when EVERY key that locks it resolves on
 * (#491). It used to read `true` unconditionally, which is where this screen
 * told a household an sms channel was on and beyond their control while
 * `resolveChannels` was sending nothing on it. One key resolving off is enough
 * to make "on" a lie for this aggregate row, so the row shows off.
 *
 * Otherwise the saved byCategory value wins, falling back to email-on/others-off
 * — the same default NotificationSettingsScreen.kt's channelChipState uses.
 */
export function channelChecked(cat: CategoryDto, ch: Channel, byCategory: Partial<Record<Channel, boolean>> | undefined): boolean {
  if (!categoryToggleableChannels(cat).includes(ch)) {
    const lockedHere = cat.keys.filter((k) => k.lockedChannels.includes(ch));
    // `!== false` rather than `=== true`: a server that has not shipped the
    // values yet leaves them absent, and absent means on.
    return lockedHere.length > 0 && lockedHere.every((k) => k.lockedChannelValues?.[ch] !== false);
  }
  const saved = byCategory?.[ch];
  return saved !== undefined ? saved : ch === 'email';
}

/**
 * Master-switch checked state: on when every toggleable channel in the
 * category currently reads on. A category with nothing left to toggle
 * (every channel locked) always reads on — it's "always on" for the whole
 * household, matching NotificationLockDisplay.kt's categoryAlwaysOnNote.
 */
export function categoryMasterChecked(cat: CategoryDto, byCategory: Partial<Record<Channel, boolean>> | undefined): boolean {
  const toggleable = categoryToggleableChannels(cat);
  if (toggleable.length === 0) return true;
  return toggleable.every((ch) => channelChecked(cat, ch, byCategory));
}

/**
 * Distinct marketingCategory values a category's keys reference. Only the
 * 'marketing' category has these in practice; falls back to 'marketing' when
 * the category has keys but none declare one, so its master switch always
 * has somewhere in marketingOptIn to write.
 */
export function categoryMarketingCategories(cat: CategoryDto): MarketingCategory[] {
  const found = new Set<MarketingCategory>();
  for (const k of cat.keys) if (k.marketingCategory) found.add(k.marketingCategory);
  if (found.size === 0 && cat.keys.length > 0) found.add('marketing');
  return [...found];
}

/**
 * The marketing category's master-switch checked state: on only when every
 * marketingCategory it references is opted in. The per-channel rows under
 * this card are always-off/disabled placeholders in the mockup (CAN-SPAM /
 * CASL opt-in-by-default-off; see NotificationSettings.tsx's file comment),
 * so this master switch is the only interactive control for the category —
 * it writes marketingOptIn directly rather than byCategory.
 */
export function marketingMasterChecked(cat: CategoryDto, marketingOptIn: Partial<Record<MarketingCategory, boolean>> | undefined): boolean {
  const mcs = categoryMarketingCategories(cat);
  if (mcs.length === 0) return false;
  return mcs.every((mc) => marketingOptIn?.[mc] === true);
}

// ── per-key channel logic (P7: per-key notification toggles) ────────────
//
// Everything above projects the catalog's per-key data into a per-category
// row (the mockup's original control surface). The mockup's own filename,
// "justNeedsExpansionForEachSectionForGranularModification", is the spec
// for what's below: each category's expanded card also lists its keys, each
// with its own channel toggles that write byKey and inherit byCategory when
// untouched. See prefs.ts:132-146 (explicitUserChoice) for the server-side
// precedence these helpers mirror client-side: byKey wins, byCategory is the
// fallback, catalog default (email-on) is the last resort.

/**
 * Channels this key alone pins read-only. lockedChannels already folds in
 * catalog.required server-side (see NotificationKeyDto's doc comment above),
 * so no separate `required` union is needed here: this is deliberately a
 * per-key read, not categoryToggleableChannels' cross-key aggregate, because
 * the server locks/unlocks per notification key, not per category.
 */
export function keyLockedChannels(key: NotificationKeyDto): Channel[] {
  return key.allowedChannels.filter((ch) => key.lockedChannels.includes(ch));
}

/**
 * Effective checked state for one key's channel row.
 *
 * A locked channel reads the value the catalog reports for it (#491), not a
 * flat `true`: locked says the household is not the one who decides, and what
 * was decided can perfectly well be off — an sms channel under `lockedEnabled`
 * that the operator never switched on resolves off, and this screen used to
 * draw it on and read-only.
 *
 * Otherwise this key's own byKey entry wins when present, falling back to the
 * category's byCategory value, falling back to email-on/others-off: the same
 * three-step fallback explicitUserChoice documents server-side
 * (byKey.{ch} -> byCategory.{ch} -> allowedChannels).
 */
export function keyChannelChecked(
  key: NotificationKeyDto,
  ch: Channel,
  byKeyForKey: Partial<Record<Channel, boolean>> | undefined,
  byCategoryForCat: Partial<Record<Channel, boolean>> | undefined,
): boolean {
  if (keyLockedChannels(key).includes(ch)) return key.lockedChannelValues?.[ch] !== false;
  const own = byKeyForKey?.[ch];
  if (own !== undefined) return own;
  const fromCategory = byCategoryForCat?.[ch];
  if (fromCategory !== undefined) return fromCategory;
  return ch === 'email';
}

/**
 * True when the kinfolk has explicitly set this channel for this key;
 * false means the row is still following the category default. Drives the
 * "Following category" / "Overridden" indicator; a key with no byKey entry
 * at all is `false` for every channel, which is exactly the state a freshly
 * loaded, never-touched key should be in.
 */
export function keyChannelOverridden(byKeyForKey: Partial<Record<Channel, boolean>> | undefined, ch: Channel): boolean {
  return byKeyForKey?.[ch] !== undefined;
}
