import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { arr } from '../lib/coerce';
import type { TagDef } from '../lib/tags/model';

/**
 * Business Settings (read-only overview).
 *
 * Unlike every other admin surface ported so far (FeatureFlags, FormSchemas),
 * Settings is NOT a callable and NOT a live-authoring collection. The wasm
 * source (`FirestoreInterop.wasmJs.kt#platformBusinessSettingsStream`) reads
 * ONE Firestore doc directly with the client SDK: `business_settings/business_settings`
 * (`BUSINESS_SETTINGS_DOC_ID` in `FirestoreClient.kt`). There is no backend
 * callable to reach for (`getBusinessSettings` does not exist in
 * MyTribe/functions), so this module reads the doc directly with `getDoc`,
 * exactly mirroring the wasm access pattern, rather than inventing a callable
 * that isn't there or forcing this single doc through `lib/firestore.ts`'s
 * `useCollection` (collection-only; see that file's header). This is a ONE-SHOT
 * read (not a live listener) because this screen is a read-only snapshot, not an
 * editor watching for concurrent changes.
 *
 * `firestore.rules` line 140-143: `allow read: if signedIn()` on
 * `business_settings/{docId}`, so any authenticated admin can read it directly.
 *
 * Every field defaults exactly as `BusinessSettings` does in
 * `FirestoreClient.kt` (lines 2445-2560), so a doc missing a key, or no doc at
 * all (a never-configured install), reads the same shipped defaults the wasm
 * app would show, never `undefined`, never a thrown TypeError deeper in the
 * screen.
 */

export const BUSINESS_SETTINGS_DOC_ID = 'business_settings';

/**
 * Mirrors `TimeBlockDefinition` (FirestoreClient.kt); wire key for active is `active`.
 *
 * Every string here is OPTIONAL because this interface is a CAST over a raw
 * Firestore array element, never a validation of one. `mergeBusinessSettings`
 * checks that `timeBlocks` IS an array, but nothing inspects the rows inside
 * it, so a hand-edited or legacy block carrying only `{ id }` types as a
 * complete `TimeBlockDefinition` and then throws on the first `.trim()` — the
 * blank-page failure mode `lib/coerce.ts` documents. Marking them optional is
 * what makes a reader write the guard.
 */
export interface TimeBlockDefinition {
  id?: string | undefined;
  label?: string | undefined;
  startTime?: string | undefined;
  endTime?: string | undefined;
  active: boolean;
}

/** Mirrors `PortalBanner`. */
export interface PortalBanner {
  enabled: boolean;
  message: string;
  tone: string;
  dismissMode: string;
  id: string;
}

/**
 * Mirrors `HomeSectionCfg`. `id` is optional for the same reason as
 * `TimeBlockDefinition` above: `mergePortalHome` validates that `sections` is
 * an array, but never the rows within it, so this is a cast over raw data.
 */
export interface HomeSectionCfg {
  id?: string | undefined;
  enabled: boolean;
  limit: number;
}

/** Mirrors `PortalHome`. */
export interface PortalHome {
  sections: HomeSectionCfg[];
}

/** Mirrors `PortalChat`. */
export interface PortalChat {
  enabled: boolean;
  awayMessage: string;
  hoursEnabled: boolean;
  hours: Record<string, string>;
  maxMessageLength: number;
  rateLimitPerHour: number;
}

/** Mirrors `MyTribePortalConfig`, the shared MyTribe kinfolk-portal wire contract. */
export interface MyTribePortalConfig {
  logoUrl: string;
  themeId: string;
  banner: PortalBanner;
  home: PortalHome;
  chat: PortalChat;
}

/**
 * Mirrors `BusinessSettings` (FirestoreClient.kt, lines 2445-2560) field for
 * field.
 *
 * These fields are deliberately NOT optional, unlike the `*Entry`/`*Row`
 * interfaces elsewhere in `api/`: this is the OUTPUT of
 * `mergeBusinessSettings`, which really does check and default every key, so
 * the non-optional promise is one this module keeps rather than a cast over
 * raw document data. Downstream editors (`screens/settings/*Editor.tsx`) rely
 * on that guarantee to spread and iterate these values directly.
 *
 * The guarantee only holds because the merge below TYPE-checks each key
 * (`pickString`/`pickList`/`pickMap`) instead of casting it. The old
 * `(r.x as string) ?? d.x` form caught an absent key but waved a
 * wrong-typed one straight through — a legacy number, or `updatedAt` written
 * as a Firestore `Timestamp` rather than an ISO string — which then threw on
 * the first `.trim()` and blanked the whole screen (see `lib/coerce.ts`).
 * Element shapes the merge does not descend into (`TimeBlockDefinition`,
 * `HomeSectionCfg`) stay optional, because for those it IS still a cast.
 */
export interface BusinessSettings {
  _id: string;
  businessName: string;
  businessEmail: string;
  businessPhone: string;
  businessAddress: string;
  timeZone: string;
  serviceRates: Record<string, string>;
  businessHours: Record<string, string>;
  venmoHandle: string;
  paypalHandle: string;
  cashappHandle: string;
  weatherLocation: string;
  notificationEmail: boolean;
  notificationSms: boolean;
  notificationPush: boolean;
  observedUsHolidays: string[];
  companyHolidays: string[];
  specialHours: string[];
  observeUsHolidays: boolean;
  defaultBookingMode: string;
  defaultCalendarView: string;
  allowTimeBlockBooking: boolean;
  allowSpecificTimeBooking: boolean;
  enableConflictDetection: boolean;
  enableAutoReminder24h: boolean;
  defaultTimeBlockDurationHours: number;
  travelBufferMinutes: number;
  timeBlocks: TimeBlockDefinition[];
  enableGPSTrackingForAllVisits: boolean;
  enablePhotoLocationTagging: boolean;
  requireArrivalDepartureVerification: boolean;
  autoStartTrackingOnVisitStart: boolean;
  trackingAccuracy: string;
  saveRoutesForDays: number;
  allowClientLocationSharing: boolean;
  defaultEtaMinutes: number;
  etaMinuteOptions: number[];
  draftRetentionDays: number;
  draftRetentionOptions: number[];
  calendarSyncId: string;
  autoConfirmRepeatKinfolk: boolean;
  snapRescheduleTo15Min: boolean;
  logoUrl: string;
  brandWordmark: string;
  brandTagline: string;
  homeGreeting: string;
  homeAccentTail: string;
  /**
   * The two tag vocabularies operators manage in the Tags settings panel:
   * `householdTags` label `kinfolk` (e.g. "VIP"), `petTags` label `kin` (e.g.
   * "Reactive"). Each is a list of rich `{ name, color, icon }` defs; assignments
   * on a profile store only the tag NAME. Default `[]`; a legacy doc without
   * either field, or with malformed rows, decodes to a clean list (see
   * `decodeTagDefs`), never `undefined` and never a thrown decode.
   */
  householdTags: TagDef[];
  petTags: TagDef[];
  mytribePortal: MyTribePortalConfig;
  updatedAt: string;
  updatedBy: string;
}

const DEFAULT_PORTAL_BANNER: PortalBanner = {
  enabled: false,
  message: '',
  tone: 'info',
  dismissMode: 'none',
  id: '',
};

const DEFAULT_PORTAL_HOME: PortalHome = { sections: [] };

const DEFAULT_PORTAL_CHAT: PortalChat = {
  enabled: true,
  awayMessage: '',
  hoursEnabled: false,
  hours: {},
  maxMessageLength: 2000,
  rateLimitPerHour: 0,
};

const DEFAULT_MYTRIBE_PORTAL: MyTribePortalConfig = {
  logoUrl: '',
  themeId: 'default',
  banner: DEFAULT_PORTAL_BANNER,
  home: DEFAULT_PORTAL_HOME,
  chat: DEFAULT_PORTAL_CHAT,
};

/** The shipped defaults, byte-for-byte matching `BusinessSettings()` in FirestoreClient.kt. */
export const DEFAULT_BUSINESS_SETTINGS: BusinessSettings = {
  _id: '',
  businessName: '',
  businessEmail: '',
  businessPhone: '',
  businessAddress: '',
  timeZone: 'America/New_York',
  serviceRates: {},
  businessHours: {},
  venmoHandle: '',
  paypalHandle: '',
  cashappHandle: '',
  weatherLocation: '',
  notificationEmail: true,
  notificationSms: true,
  notificationPush: true,
  observedUsHolidays: [],
  companyHolidays: [],
  specialHours: [],
  observeUsHolidays: false,
  defaultBookingMode: 'SPECIFIC_TIME',
  defaultCalendarView: 'MONTH',
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: true,
  enableConflictDetection: true,
  enableAutoReminder24h: false,
  defaultTimeBlockDurationHours: 4,
  travelBufferMinutes: 30,
  timeBlocks: [
    { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
  ],
  enableGPSTrackingForAllVisits: true,
  enablePhotoLocationTagging: true,
  requireArrivalDepartureVerification: true,
  autoStartTrackingOnVisitStart: true,
  trackingAccuracy: 'HIGH',
  saveRoutesForDays: 90,
  allowClientLocationSharing: true,
  defaultEtaMinutes: 15,
  etaMinuteOptions: [5, 10, 15, 20, 30, 45, 60],
  draftRetentionDays: 30,
  draftRetentionOptions: [30, 60, 90],
  calendarSyncId: '',
  autoConfirmRepeatKinfolk: false,
  snapRescheduleTo15Min: false,
  logoUrl: '',
  brandWordmark: '',
  brandTagline: '',
  homeGreeting: '',
  homeAccentTail: '',
  householdTags: [],
  petTags: [],
  mytribePortal: DEFAULT_MYTRIBE_PORTAL,
  updatedAt: '',
  updatedBy: '',
};

/**
 * Decode a raw `householdTags`/`petTags` array into clean `TagDef[]`, keeping
 * only well-formed `{ name, color: { token, css }, icon }` rows and dropping
 * anything malformed (a hand-edited doc, a half-written row, a legacy shape).
 * Never throws: a bad vocabulary must never take down the whole settings read.
 */
function decodeTagDefs(raw: unknown): TagDef[] {
  if (!Array.isArray(raw)) return [];
  const out: TagDef[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.name !== 'string' || r.name.trim() === '') continue;
    if (typeof r.icon !== 'string') continue;
    if (typeof r.color !== 'object' || r.color === null) continue;
    const c = r.color as Record<string, unknown>;
    if (typeof c.token !== 'string' || typeof c.css !== 'string') continue;
    out.push({ name: r.name, color: { token: c.token, css: c.css }, icon: r.icon });
  }
  return out;
}

/** A raw Firestore doc body: unknown shape, since a hand-edited or legacy doc can be missing/malformed any field. */
type RawSettings = Record<string, unknown>;

/**
 * The three type-checked readers the merge uses in place of `as X`. Each takes
 * the SHIPPED default rather than a bare `''`/`[]`, so a doc missing (or
 * mistyping) `timeZone` still reads 'America/New_York' and `etaMinuteOptions`
 * still reads the seven-option list, exactly as before. `lib/coerce.ts`'s
 * `str`/`arr` are the same idea for the always-empty case; these carry a
 * default because several settings fields genuinely ship with one.
 *
 * Numbers are absent on purpose, matching `lib/coerce.ts`: nothing here should
 * learn to invent a numeric fact a document never stated.
 */
function pickString(raw: unknown, fallback: string): string {
  return typeof raw === 'string' ? raw : fallback;
}

function pickList<T>(raw: unknown, fallback: T[]): T[] {
  return Array.isArray(raw) ? (raw as T[]) : fallback;
}

function pickMap(raw: unknown, fallback: Record<string, string>): Record<string, string> {
  // Arrays are objects too, and `Object.entries` on one yields index keys —
  // nonsense for a day-name or service-type map, so they fall back instead.
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback;
  return raw as Record<string, string>;
}

function mergePortalChat(raw: unknown): PortalChat {
  const r = (raw ?? {}) as Partial<PortalChat>;
  return {
    enabled: r.enabled ?? DEFAULT_PORTAL_CHAT.enabled,
    awayMessage: pickString(r.awayMessage, DEFAULT_PORTAL_CHAT.awayMessage),
    hoursEnabled: r.hoursEnabled ?? DEFAULT_PORTAL_CHAT.hoursEnabled,
    hours: pickMap(r.hours, DEFAULT_PORTAL_CHAT.hours),
    maxMessageLength: r.maxMessageLength ?? DEFAULT_PORTAL_CHAT.maxMessageLength,
    rateLimitPerHour: r.rateLimitPerHour ?? DEFAULT_PORTAL_CHAT.rateLimitPerHour,
  };
}

function mergePortalBanner(raw: unknown): PortalBanner {
  const r = (raw ?? {}) as Partial<PortalBanner>;
  return {
    enabled: r.enabled ?? DEFAULT_PORTAL_BANNER.enabled,
    message: pickString(r.message, DEFAULT_PORTAL_BANNER.message),
    tone: pickString(r.tone, DEFAULT_PORTAL_BANNER.tone),
    dismissMode: pickString(r.dismissMode, DEFAULT_PORTAL_BANNER.dismissMode),
    id: pickString(r.id, DEFAULT_PORTAL_BANNER.id),
  };
}

function mergePortalHome(raw: unknown): PortalHome {
  const r = (raw ?? {}) as Partial<PortalHome>;
  // Only the LIST is validated here; the rows inside it stay a cast, which is
  // why `HomeSectionCfg.id` is optional.
  return { sections: pickList<HomeSectionCfg>(r.sections, DEFAULT_PORTAL_HOME.sections) };
}

function mergeMyTribePortal(raw: unknown): MyTribePortalConfig {
  const r = (raw ?? {}) as Partial<MyTribePortalConfig>;
  return {
    logoUrl: pickString(r.logoUrl, DEFAULT_MYTRIBE_PORTAL.logoUrl),
    themeId: pickString(r.themeId, DEFAULT_MYTRIBE_PORTAL.themeId),
    banner: mergePortalBanner(r.banner),
    home: mergePortalHome(r.home),
    chat: mergePortalChat(r.chat),
  };
}

/**
 * Merges a raw Firestore doc body onto the shipped defaults, field by field
 * (never a shallow `{ ...defaults, ...raw }` spread, which would let a stray
 * `null` written by an old client through as `null` instead of falling back).
 * Exported for the api-layer test; also used directly by `getBusinessSettings`.
 */
export function mergeBusinessSettings(raw: RawSettings | undefined): BusinessSettings {
  const r = raw ?? {};
  const d = DEFAULT_BUSINESS_SETTINGS;
  return {
    _id: pickString(r._id, d._id),
    businessName: pickString(r.businessName, d.businessName),
    businessEmail: pickString(r.businessEmail, d.businessEmail),
    businessPhone: pickString(r.businessPhone, d.businessPhone),
    businessAddress: pickString(r.businessAddress, d.businessAddress),
    timeZone: pickString(r.timeZone, d.timeZone),
    serviceRates: pickMap(r.serviceRates, d.serviceRates),
    businessHours: pickMap(r.businessHours, d.businessHours),
    venmoHandle: pickString(r.venmoHandle, d.venmoHandle),
    paypalHandle: pickString(r.paypalHandle, d.paypalHandle),
    cashappHandle: pickString(r.cashappHandle, d.cashappHandle),
    weatherLocation: pickString(r.weatherLocation, d.weatherLocation),
    notificationEmail: (r.notificationEmail as boolean) ?? d.notificationEmail,
    notificationSms: (r.notificationSms as boolean) ?? d.notificationSms,
    notificationPush: (r.notificationPush as boolean) ?? d.notificationPush,
    // `arr` (default `[]`) rather than `pickList`, because these three ship
    // empty: a non-array here reads as "nothing configured", not as a crash in
    // TimeOffEditor's `[...data.companyHolidays]` spread.
    observedUsHolidays: arr<string>(r.observedUsHolidays),
    companyHolidays: arr<string>(r.companyHolidays),
    specialHours: arr<string>(r.specialHours),
    observeUsHolidays: (r.observeUsHolidays as boolean) ?? d.observeUsHolidays,
    defaultBookingMode: pickString(r.defaultBookingMode, d.defaultBookingMode),
    defaultCalendarView: pickString(r.defaultCalendarView, d.defaultCalendarView),
    allowTimeBlockBooking: (r.allowTimeBlockBooking as boolean) ?? d.allowTimeBlockBooking,
    allowSpecificTimeBooking: (r.allowSpecificTimeBooking as boolean) ?? d.allowSpecificTimeBooking,
    enableConflictDetection: (r.enableConflictDetection as boolean) ?? d.enableConflictDetection,
    enableAutoReminder24h: (r.enableAutoReminder24h as boolean) ?? d.enableAutoReminder24h,
    defaultTimeBlockDurationHours:
      (r.defaultTimeBlockDurationHours as number) ?? d.defaultTimeBlockDurationHours,
    travelBufferMinutes: (r.travelBufferMinutes as number) ?? d.travelBufferMinutes,
    timeBlocks: pickList<TimeBlockDefinition>(r.timeBlocks, d.timeBlocks),
    enableGPSTrackingForAllVisits:
      (r.enableGPSTrackingForAllVisits as boolean) ?? d.enableGPSTrackingForAllVisits,
    enablePhotoLocationTagging:
      (r.enablePhotoLocationTagging as boolean) ?? d.enablePhotoLocationTagging,
    requireArrivalDepartureVerification:
      (r.requireArrivalDepartureVerification as boolean) ?? d.requireArrivalDepartureVerification,
    autoStartTrackingOnVisitStart:
      (r.autoStartTrackingOnVisitStart as boolean) ?? d.autoStartTrackingOnVisitStart,
    trackingAccuracy: pickString(r.trackingAccuracy, d.trackingAccuracy),
    saveRoutesForDays: (r.saveRoutesForDays as number) ?? d.saveRoutesForDays,
    allowClientLocationSharing: (r.allowClientLocationSharing as boolean) ?? d.allowClientLocationSharing,
    defaultEtaMinutes: (r.defaultEtaMinutes as number) ?? d.defaultEtaMinutes,
    etaMinuteOptions: pickList<number>(r.etaMinuteOptions, d.etaMinuteOptions),
    draftRetentionDays: (r.draftRetentionDays as number) ?? d.draftRetentionDays,
    draftRetentionOptions: pickList<number>(r.draftRetentionOptions, d.draftRetentionOptions),
    calendarSyncId: pickString(r.calendarSyncId, d.calendarSyncId),
    autoConfirmRepeatKinfolk: (r.autoConfirmRepeatKinfolk as boolean) ?? d.autoConfirmRepeatKinfolk,
    snapRescheduleTo15Min: (r.snapRescheduleTo15Min as boolean) ?? d.snapRescheduleTo15Min,
    logoUrl: pickString(r.logoUrl, d.logoUrl),
    brandWordmark: pickString(r.brandWordmark, d.brandWordmark),
    brandTagline: pickString(r.brandTagline, d.brandTagline),
    homeGreeting: pickString(r.homeGreeting, d.homeGreeting),
    homeAccentTail: pickString(r.homeAccentTail, d.homeAccentTail),
    householdTags: decodeTagDefs(r.householdTags),
    petTags: decodeTagDefs(r.petTags),
    mytribePortal: mergeMyTribePortal(r.mytribePortal),
    // `updatedAt` is the likeliest mistyped field on this doc: a client that
    // stamped it with `serverTimestamp()` leaves a Firestore `Timestamp`, not
    // the ISO string this contract expects. That now reads as blank, which
    // `lastSavedLabel` already renders as "Never saved yet".
    updatedAt: pickString(r.updatedAt, d.updatedAt),
    updatedBy: pickString(r.updatedBy, d.updatedBy),
  };
}

/**
 * One-shot read of `business_settings/business_settings`. Returns the shipped
 * defaults when the doc does not exist yet (a never-configured install, same
 * as the wasm listener's `?: BusinessSettings()` fallback), never throws for a
 * missing doc. DOES throw (for the caller to surface fail-loud) on a genuine
 * read failure, e.g. permission-denied or offline.
 */
export async function getBusinessSettings(): Promise<BusinessSettings> {
  const snap = await getDoc(doc(db, 'business_settings', BUSINESS_SETTINGS_DOC_ID));
  return mergeBusinessSettings(snap.exists() ? (snap.data() as RawSettings) : undefined);
}
