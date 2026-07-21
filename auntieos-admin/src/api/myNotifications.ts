import { call } from '../lib/fns';
import { arr, str } from '../lib/coerce';

/**
 * The operator's OWN notification settings ("My Notifications", account
 * area, wasm `MyNotificationsScreen.kt`): what reaches THEM, and how, within
 * whatever channels the business gate even offers. Distinct from the admin
 * `Notifications` screen (`api/notifications.ts`), which is the whole-collection
 * dispatch audit. This module ports two data sources the wasm screen reads,
 * verbatim against the deployed MyTribe callables (do not change the backend):
 *
 *   - getBusinessNotificationOverrides -> the SAME catalog + business gate
 *     matrix the Settings gate matrix uses (MyTribe/functions/src/admin/
 *     notificationOverrides.ts). Decides which channels each notification even
 *     OFFERS, and whether the business locked any of them.
 *   - getMyAdminNotificationPrefs -> the operator's own receive prefs at
 *     `staff/{uid}.notificationPrefs` (MyTribe/functions/src/admin/
 *     myAdminNotificationPrefs.ts). Their choice, within the offered channels,
 *     of what they actually receive.
 *
 * Both are OFFICIAL onCall callables (admin-gated via wrapAdminCallable), not
 * client Firestore queries: neither reads a collection with a `where`, so this
 * is a plain one-shot `call()` round-trip, no `useCollection` stream, no
 * composite index to provision. The uid is never sent by the client; each
 * callable derives it server-side from `req.auth.uid`, so there is no
 * uid-filter for this module to get wrong.
 *
 * This port is READ-ONLY: it fetches and decodes; it deliberately does not
 * wire `saveMyAdminNotificationPrefs` or the override-save/delete callables.
 * Editing is the deferred surface, exactly like `Settings.tsx`'s read-only
 * overview.
 */

export type NotificationChannel = 'email' | 'sms' | 'push';

/** The fixed channel order the gate matrix and these prefs share. */
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['email', 'sms', 'push'];

/** The three recipient streams the catalog can serve. */
export const STREAM_BUSINESS = 'business';
export const STREAM_STAFF = 'staff';
export const STREAM_KINFOLK = 'kinfolk';
export type NotifStream = typeof STREAM_BUSINESS | typeof STREAM_STAFF | typeof STREAM_KINFOLK;

type ChannelMap = Partial<Record<NotificationChannel, boolean>>;

/**
 * One notification type from the server catalog.
 *
 * Unlike the `*Entry` / `*Row` interfaces elsewhere in `api/`, this one is NOT
 * a cast over raw document data: nothing constructs it except
 * `decodeCatalogEntry`, which defaults every field below from the all-optional
 * `RawCatalogEntry` wire shape. So these fields are required ON PURPOSE, and
 * must stay that way — they are a post-decode guarantee, and callers
 * (`lib/myNotificationsFormat.ts`, `lib/notificationGateEdit.ts`) rely on it to
 * call `.trim()` / `.size` / `.includes()` without a guard at every use.
 *
 * The decoder is therefore the ONLY place this shape can be violated, which is
 * why it coerces by TYPE (`str` / `arr`) and not just by presence: `?? ''`
 * catches an absent `label`, but a catalog doc that seeded `label` as a number
 * sails straight through it and blows up later on `.trim()` — one bad row
 * blanking the whole screen via the error boundary, the exact failure that took
 * down Invoices and Bookings on 2026-07-20.
 */
export interface NotificationCatalogEntry {
  key: string;
  label: string;
  category: string;
  /** Legacy single-audience field; superseded by `audiences` when present. */
  audience: string;
  /** The recipient streams this notification serves (subset of business/staff/kinfolk). */
  audiences: ReadonlySet<NotifStream>;
  allowedChannels: readonly NotificationChannel[];
  /** channel -> true when that channel is catalog-required (locked on). */
  required: ChannelMap;
  alwaysEnabled: boolean;
  /** Streams `alwaysEnabled` applies to; empty = every stream the key serves. */
  alwaysEnabledStreams: ReadonlySet<NotifStream>;
  kinfolkFacing: boolean;
  deliveryMode: string;
  description: string;
  marketingCategory?: string;
}

/** Per-stream overlay on a `NotificationOverride`. A missing field falls back to the flat one. */
export interface StreamGate {
  enabled?: boolean;
  channels: ChannelMap;
  lockedEnabled?: boolean;
  locked: ChannelMap;
}

/** Stored business-gate deviation from the catalog default for one notification key. */
export interface NotificationOverride {
  enabled: boolean;
  channels: ChannelMap;
  lockedEnabled: boolean;
  locked: ChannelMap;
  lockReason?: string;
  /** Per-stream gate overlays keyed by stream name. */
  streams: Partial<Record<NotifStream, StreamGate>>;
}

/** Full gate-matrix snapshot: the catalog plus any saved business overrides. */
export interface NotificationMatrix {
  catalog: NotificationCatalogEntry[];
  overrides: Record<string, NotificationOverride>;
  updatedAtMs: number | null;
}

/** Partial per-channel choice: absent = unset (inherit the default). */
export type ChannelPrefs = ChannelMap;

/** The operator's own notification prefs doc (`staff/{uid}.notificationPrefs`). */
export interface AdminNotificationPrefs {
  byKey: Record<string, ChannelPrefs>;
  byCategory: Record<string, ChannelPrefs>;
  marketingOptIn: Record<string, boolean>;
}

const EMPTY_PREFS: AdminNotificationPrefs = { byKey: {}, byCategory: {}, marketingOptIn: {} };

// ─────────────────────────────────────────────────────────────────────────────
// Wire shapes (exactly what the two callables return; see the MyTribe handlers)
// ─────────────────────────────────────────────────────────────────────────────

interface RawCatalogEntry {
  key?: string;
  label?: string;
  category?: string;
  audience?: string;
  audiences?: Partial<Record<NotifStream, true>>;
  allowedChannels?: string[];
  required?: Record<string, boolean>;
  alwaysEnabled?: boolean;
  alwaysEnabledStreams?: Partial<Record<NotifStream, true>>;
  kinfolkFacing?: boolean;
  deliveryMode?: string;
  description?: string;
  marketingCategory?: string;
}

interface RawStreamGate {
  enabled?: boolean;
  channels?: ChannelMap;
  lockedEnabled?: boolean;
  locked?: ChannelMap;
}

interface RawOverride {
  enabled?: boolean;
  channels?: ChannelMap;
  lockedEnabled?: boolean;
  locked?: ChannelMap;
  lockReason?: string;
  streams?: Partial<Record<NotifStream, RawStreamGate>>;
}

interface RawGetOverridesResult {
  catalog?: RawCatalogEntry[];
  overrides?: Record<string, RawOverride>;
  updatedAtMs?: number | null;
}

interface RawPrefsDto {
  prefs?: {
    byKey?: Record<string, ChannelMap>;
    byCategory?: Record<string, ChannelMap>;
    marketingOptIn?: Record<string, boolean>;
  };
  updatedAtMs?: number | null;
}

const ALL_STREAMS: readonly NotifStream[] = [STREAM_BUSINESS, STREAM_STAFF, STREAM_KINFOLK];

/**
 * Legacy single-audience -> streams mapping, used only when the backend has
 * not sent a non-empty `audiences` object (mirrors wasm `legacyAudienceStreams`
 * in NotificationOverridesRepository.kt). Unknown values fall back to kinfolk
 * so an entry is never dropped from the UI; the legacy field never maps to
 * staff, staff only arrives via the real `audiences` object.
 */
function legacyAudienceStreams(audience: string): Set<NotifStream> {
  switch (audience.trim().toLowerCase()) {
    case 'business':
      return new Set([STREAM_BUSINESS]);
    case 'kinfolk':
      return new Set([STREAM_KINFOLK]);
    case 'both':
      return new Set([STREAM_KINFOLK, STREAM_BUSINESS]);
    default:
      return new Set([STREAM_KINFOLK]);
  }
}

function decodeStreamSet(raw: Partial<Record<NotifStream, true>> | undefined): Set<NotifStream> {
  const streams = ALL_STREAMS.filter((s) => raw?.[s] === true);
  return new Set(streams);
}

function decodeAudiences(raw: Partial<Record<NotifStream, true>> | undefined, audience: string): Set<NotifStream> {
  const decoded = decodeStreamSet(raw);
  return decoded.size > 0 ? decoded : legacyAudienceStreams(audience);
}

function decodeChannelList(raw: string[] | undefined): NotificationChannel[] {
  // `arr` not `?? []`: a non-array `allowedChannels` would throw on `.filter`
  // here, before any caller gets the chance to guard it.
  return arr<unknown>(raw).filter((c): c is NotificationChannel =>
    NOTIFICATION_CHANNELS.includes(c as NotificationChannel),
  );
}

function decodeCatalogEntry(raw: RawCatalogEntry): NotificationCatalogEntry {
  // `audience` is coerced before anything else because `legacyAudienceStreams`
  // calls `.trim()` on it during THIS decode — a non-string there takes out the
  // whole catalog, not just this row.
  const audience = str(raw.audience);
  return {
    key: str(raw.key),
    label: str(raw.label),
    category: str(raw.category),
    audience,
    audiences: decodeAudiences(raw.audiences, audience),
    allowedChannels: decodeChannelList(raw.allowedChannels),
    required: raw.required ?? {},
    alwaysEnabled: raw.alwaysEnabled ?? false,
    alwaysEnabledStreams: decodeStreamSet(raw.alwaysEnabledStreams),
    kinfolkFacing: raw.kinfolkFacing ?? false,
    deliveryMode: str(raw.deliveryMode),
    description: str(raw.description),
    // Only carried when it really is a string: the field is declared `string`,
    // and spreading a number through would make the interface lie.
    ...(typeof raw.marketingCategory === 'string' ? { marketingCategory: raw.marketingCategory } : {}),
  };
}

function decodeStreamGate(raw: RawStreamGate | undefined): StreamGate {
  return {
    ...(raw?.enabled !== undefined ? { enabled: raw.enabled } : {}),
    channels: raw?.channels ?? {},
    ...(raw?.lockedEnabled !== undefined ? { lockedEnabled: raw.lockedEnabled } : {}),
    locked: raw?.locked ?? {},
  };
}

function decodeOverride(raw: RawOverride): NotificationOverride {
  const streams: Partial<Record<NotifStream, StreamGate>> = {};
  for (const s of ALL_STREAMS) {
    const g = raw.streams?.[s];
    if (g !== undefined) streams[s] = decodeStreamGate(g);
  }
  return {
    enabled: raw.enabled ?? true,
    channels: raw.channels ?? {},
    lockedEnabled: raw.lockedEnabled ?? false,
    locked: raw.locked ?? {},
    ...(raw.lockReason !== undefined ? { lockReason: raw.lockReason } : {}),
    streams,
  };
}

function decodeMatrix(raw: RawGetOverridesResult): NotificationMatrix {
  // `arr` not `?? []`: a non-array `catalog` throws on `.map` and blanks the
  // screen, and this is the one read every notification surface depends on.
  const catalog = arr<RawCatalogEntry>(raw.catalog).map(decodeCatalogEntry);
  const overrides: Record<string, NotificationOverride> = {};
  for (const [key, o] of Object.entries(raw.overrides ?? {})) {
    overrides[key] = decodeOverride(o);
  }
  return { catalog, overrides, updatedAtMs: raw.updatedAtMs ?? null };
}

function decodePrefs(raw: RawPrefsDto['prefs']): AdminNotificationPrefs {
  if (!raw) return EMPTY_PREFS;
  return {
    byKey: raw.byKey ?? {},
    byCategory: raw.byCategory ?? {},
    marketingOptIn: raw.marketingOptIn ?? {},
  };
}

/**
 * The business gate matrix: catalog (every notification type this business
 * can send) plus any saved overrides. Same callable and same doc the Settings
 * gate matrix panel reads, so a channel this screen shows as "Required" always
 * agrees with what Settings shows as locked.
 */
export async function getNotificationMatrix(): Promise<NotificationMatrix> {
  const raw = await call<Record<string, never>, RawGetOverridesResult>(
    'getBusinessNotificationOverrides',
    {},
  );
  return decodeMatrix(raw);
}

/** The operator's own receive prefs, plus when they were last saved. */
export async function getMyNotificationPrefs(): Promise<{
  prefs: AdminNotificationPrefs;
  updatedAtMs: number | null;
}> {
  const raw = await call<Record<string, never>, RawPrefsDto>('getMyAdminNotificationPrefs', {});
  return { prefs: decodePrefs(raw.prefs), updatedAtMs: raw.updatedAtMs ?? null };
}
