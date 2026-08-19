import { call } from '../lib/fns';
import { arr, str } from '../lib/coerce';

/**
 * The operator's OWN notification settings ("My Notifications", account
 * area, wasm `MyNotificationsScreen.kt`): what reaches THEM, and how, within
 * whatever channels the business gate even offers. Distinct from the admin
 * `Notifications` screen (`api/notifications.ts`), which is the whole-collection
 * dispatch audit. This module ports two data sources the wasm screen reads,
 * verbatim against the deployed MyTribe callables. That used to carry a "do not
 * change the backend" rule, which held for the wasm port and no longer holds:
 * #396 widened `getBusinessNotificationOverrides` deliberately, because the
 * facts the operator needed (who a notification reaches, what fires it, which
 * template renders it) had to come from the server or the web and Android
 * clients would each hand-maintain their own copy and drift. Every added field
 * is additive and every decoder below defaults it, so either side can deploy
 * first. Read them:
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
 * This module is the READ half only. The writes it once deferred now ship in
 * their own modules: `api/myNotificationsWrite.ts`
 * (`saveMyAdminNotificationPrefs`, used by `screens/MyNotificationsEdit.tsx`)
 * and `api/notificationOverridesWrite.ts` (the override save/delete, used by
 * `screens/NotificationGate.tsx`).
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
export interface NotificationEmitter {
  /** What happens in the business to set this off, in plain words. */
  trigger: string;
  /** Where it lives, relative to mytribe/functions/. */
  source: string;
  /** The keys that call site puts in the merge bag. This is the leak surface. */
  dataKeys: readonly string[];
  /** Set when the listed keys are not the whole story. */
  dataNote?: string;
}
/** One outbound email the notification gate does NOT govern. */
export interface UngatedSend {
  templateId: string;
  trigger: string;
  source: string;
}
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
  // ── #396 provenance, projected as finished English by the callable ──────
  /** Who it reaches, one sentence per resolver in play. Never a bare enum. */
  whoReceives: readonly string[];
  recipientResolver: string;
  secondaryResolver?: string;
  /** Every call site that dispatches this key. Empty when nothing does. */
  emitters: readonly NotificationEmitter[];
  /** True when NO code fires this key, so its toggles control nothing. */
  neverFires: boolean;
  /**
   * channel -> the `${channel}Templates/{id}` document that ACTUALLY renders it.
   * Email is the EFFECTIVE id after `notificationTemplateBindings`, not the
   * catalog default, because this screen can retarget an email and naming the
   * catalog document on a retargeted row would report the wrong body.
   */
  templates: Readonly<Record<string, string>>;
  /** The catalog default email template, when a binding has moved email off it. */
  emailTemplateRetargetedFrom?: string;
  /** Merge fields the server hydrates for this key's templates. */
  mergeFields: readonly string[];
  /** True when an outside system delivers it and this gate controls nothing. */
  external: boolean;
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
  /** Mail the platform sends that this gate does NOT govern (#396). */
  ungated: UngatedSend[];
  /** How many people a `businessAdmins` row reaches now. Null = unreadable. */
  businessAdminCount: number | null;
  /** Where that roster lives, so the number is checkable. */
  businessAdminRosterPath: string;
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
  whoReceives?: string[];
  recipientResolver?: string;
  secondaryResolver?: string;
  emitters?: Array<{ trigger?: string; source?: string; dataKeys?: string[]; dataNote?: string }>;
  neverFires?: boolean;
  templates?: Record<string, string>;
  emailTemplateRetargetedFrom?: string;
  mergeFields?: string[];
  external?: boolean;
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

interface RawUngatedSend {
  templateId?: string;
  trigger?: string;
  source?: string;
}
interface RawGetOverridesResult {
  catalog?: RawCatalogEntry[];
  overrides?: Record<string, RawOverride>;
  ungated?: RawUngatedSend[];
  businessAdminCount?: number | null;
  businessAdminRosterPath?: string;
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

/**
 * #396 provenance decoders. Same rule as everything else in this module: coerce
 * by TYPE, not by presence. A backend that has not shipped the projection yet
 * sends none of these fields, and the screen must render "not recorded" rather
 * than throw on `.map` of an absent array — the two sides deploy separately.
 */
function decodeEmitters(raw: RawCatalogEntry['emitters']): NotificationEmitter[] {
  return arr<Record<string, unknown>>(raw).map((e) => ({
    trigger: str(e.trigger),
    source: str(e.source),
    dataKeys: arr<unknown>(e.dataKeys).map((k) => str(k)),
    ...(typeof e.dataNote === 'string' ? { dataNote: e.dataNote } : {}),
  }));
}
function decodeStringList(raw: unknown): string[] {
  return arr<unknown>(raw).map((v) => str(v));
}
function decodeTemplates(raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const channel of NOTIFICATION_CHANNELS) {
    const id = raw?.[channel];
    if (typeof id === 'string' && id !== '') out[channel] = id;
  }
  return out;
}
function decodeUngated(raw: RawUngatedSend[] | undefined): UngatedSend[] {
  return arr<RawUngatedSend>(raw).map((u) => ({
    templateId: str(u.templateId),
    trigger: str(u.trigger),
    source: str(u.source),
  }));
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
    whoReceives: decodeStringList(raw.whoReceives),
    recipientResolver: str(raw.recipientResolver),
    ...(typeof raw.secondaryResolver === 'string' ? { secondaryResolver: raw.secondaryResolver } : {}),
    emitters: decodeEmitters(raw.emitters),
    neverFires: raw.neverFires === true,
    templates: decodeTemplates(raw.templates),
    ...(typeof raw.emailTemplateRetargetedFrom === 'string'
      ? { emailTemplateRetargetedFrom: raw.emailTemplateRetargetedFrom }
      : {}),
    mergeFields: decodeStringList(raw.mergeFields),
    external: raw.external === true,
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
  return {
    catalog,
    overrides,
    ungated: decodeUngated(raw.ungated),
    businessAdminCount: typeof raw.businessAdminCount === 'number' ? raw.businessAdminCount : null,
    businessAdminRosterPath: str(raw.businessAdminRosterPath),
    updatedAtMs: raw.updatedAtMs ?? null,
  };
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
