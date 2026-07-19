import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
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

/** Mirrors `TimeBlockDefinition` (FirestoreClient.kt); wire key for active is `active`. */
export interface TimeBlockDefinition {
  id: string;
  label: string;
  startTime: string;
  endTime: string;
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

/** Mirrors `HomeSectionCfg`. */
export interface HomeSectionCfg {
  id: string;
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
 * field. Every field is read defensively (`??`/merge with defaults below), so a
 * partial or legacy doc never produces `undefined` here.
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

function mergePortalChat(raw: unknown): PortalChat {
  const r = (raw ?? {}) as Partial<PortalChat>;
  return {
    enabled: r.enabled ?? DEFAULT_PORTAL_CHAT.enabled,
    awayMessage: r.awayMessage ?? DEFAULT_PORTAL_CHAT.awayMessage,
    hoursEnabled: r.hoursEnabled ?? DEFAULT_PORTAL_CHAT.hoursEnabled,
    hours: r.hours ?? DEFAULT_PORTAL_CHAT.hours,
    maxMessageLength: r.maxMessageLength ?? DEFAULT_PORTAL_CHAT.maxMessageLength,
    rateLimitPerHour: r.rateLimitPerHour ?? DEFAULT_PORTAL_CHAT.rateLimitPerHour,
  };
}

function mergePortalBanner(raw: unknown): PortalBanner {
  const r = (raw ?? {}) as Partial<PortalBanner>;
  return {
    enabled: r.enabled ?? DEFAULT_PORTAL_BANNER.enabled,
    message: r.message ?? DEFAULT_PORTAL_BANNER.message,
    tone: r.tone ?? DEFAULT_PORTAL_BANNER.tone,
    dismissMode: r.dismissMode ?? DEFAULT_PORTAL_BANNER.dismissMode,
    id: r.id ?? DEFAULT_PORTAL_BANNER.id,
  };
}

function mergePortalHome(raw: unknown): PortalHome {
  const r = (raw ?? {}) as Partial<PortalHome>;
  return { sections: r.sections ?? DEFAULT_PORTAL_HOME.sections };
}

function mergeMyTribePortal(raw: unknown): MyTribePortalConfig {
  const r = (raw ?? {}) as Partial<MyTribePortalConfig>;
  return {
    logoUrl: r.logoUrl ?? DEFAULT_MYTRIBE_PORTAL.logoUrl,
    themeId: r.themeId ?? DEFAULT_MYTRIBE_PORTAL.themeId,
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
    _id: (r._id as string) ?? d._id,
    businessName: (r.businessName as string) ?? d.businessName,
    businessEmail: (r.businessEmail as string) ?? d.businessEmail,
    businessPhone: (r.businessPhone as string) ?? d.businessPhone,
    businessAddress: (r.businessAddress as string) ?? d.businessAddress,
    timeZone: (r.timeZone as string) ?? d.timeZone,
    serviceRates: (r.serviceRates as Record<string, string>) ?? d.serviceRates,
    businessHours: (r.businessHours as Record<string, string>) ?? d.businessHours,
    venmoHandle: (r.venmoHandle as string) ?? d.venmoHandle,
    paypalHandle: (r.paypalHandle as string) ?? d.paypalHandle,
    cashappHandle: (r.cashappHandle as string) ?? d.cashappHandle,
    weatherLocation: (r.weatherLocation as string) ?? d.weatherLocation,
    notificationEmail: (r.notificationEmail as boolean) ?? d.notificationEmail,
    notificationSms: (r.notificationSms as boolean) ?? d.notificationSms,
    notificationPush: (r.notificationPush as boolean) ?? d.notificationPush,
    observedUsHolidays: (r.observedUsHolidays as string[]) ?? d.observedUsHolidays,
    companyHolidays: (r.companyHolidays as string[]) ?? d.companyHolidays,
    specialHours: (r.specialHours as string[]) ?? d.specialHours,
    observeUsHolidays: (r.observeUsHolidays as boolean) ?? d.observeUsHolidays,
    defaultBookingMode: (r.defaultBookingMode as string) ?? d.defaultBookingMode,
    defaultCalendarView: (r.defaultCalendarView as string) ?? d.defaultCalendarView,
    allowTimeBlockBooking: (r.allowTimeBlockBooking as boolean) ?? d.allowTimeBlockBooking,
    allowSpecificTimeBooking: (r.allowSpecificTimeBooking as boolean) ?? d.allowSpecificTimeBooking,
    enableConflictDetection: (r.enableConflictDetection as boolean) ?? d.enableConflictDetection,
    enableAutoReminder24h: (r.enableAutoReminder24h as boolean) ?? d.enableAutoReminder24h,
    defaultTimeBlockDurationHours:
      (r.defaultTimeBlockDurationHours as number) ?? d.defaultTimeBlockDurationHours,
    travelBufferMinutes: (r.travelBufferMinutes as number) ?? d.travelBufferMinutes,
    timeBlocks: (r.timeBlocks as TimeBlockDefinition[]) ?? d.timeBlocks,
    enableGPSTrackingForAllVisits:
      (r.enableGPSTrackingForAllVisits as boolean) ?? d.enableGPSTrackingForAllVisits,
    enablePhotoLocationTagging:
      (r.enablePhotoLocationTagging as boolean) ?? d.enablePhotoLocationTagging,
    requireArrivalDepartureVerification:
      (r.requireArrivalDepartureVerification as boolean) ?? d.requireArrivalDepartureVerification,
    autoStartTrackingOnVisitStart:
      (r.autoStartTrackingOnVisitStart as boolean) ?? d.autoStartTrackingOnVisitStart,
    trackingAccuracy: (r.trackingAccuracy as string) ?? d.trackingAccuracy,
    saveRoutesForDays: (r.saveRoutesForDays as number) ?? d.saveRoutesForDays,
    allowClientLocationSharing: (r.allowClientLocationSharing as boolean) ?? d.allowClientLocationSharing,
    defaultEtaMinutes: (r.defaultEtaMinutes as number) ?? d.defaultEtaMinutes,
    etaMinuteOptions: (r.etaMinuteOptions as number[]) ?? d.etaMinuteOptions,
    draftRetentionDays: (r.draftRetentionDays as number) ?? d.draftRetentionDays,
    draftRetentionOptions: (r.draftRetentionOptions as number[]) ?? d.draftRetentionOptions,
    calendarSyncId: (r.calendarSyncId as string) ?? d.calendarSyncId,
    autoConfirmRepeatKinfolk: (r.autoConfirmRepeatKinfolk as boolean) ?? d.autoConfirmRepeatKinfolk,
    snapRescheduleTo15Min: (r.snapRescheduleTo15Min as boolean) ?? d.snapRescheduleTo15Min,
    logoUrl: (r.logoUrl as string) ?? d.logoUrl,
    brandWordmark: (r.brandWordmark as string) ?? d.brandWordmark,
    brandTagline: (r.brandTagline as string) ?? d.brandTagline,
    homeGreeting: (r.homeGreeting as string) ?? d.homeGreeting,
    homeAccentTail: (r.homeAccentTail as string) ?? d.homeAccentTail,
    householdTags: decodeTagDefs(r.householdTags),
    petTags: decodeTagDefs(r.petTags),
    mytribePortal: mergeMyTribePortal(r.mytribePortal),
    updatedAt: (r.updatedAt as string) ?? d.updatedAt,
    updatedBy: (r.updatedBy as string) ?? d.updatedBy,
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
