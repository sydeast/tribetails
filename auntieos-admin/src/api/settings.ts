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
 * `mytribe/firestore.rules` (the `business_settings/{docId}` match block):
 * `allow read: if isAuntie() || isTestAdmin()`, `allow write: if isAuntie()`.
 * So this doc is ADMIN-ONLY on both sides — an ordinary signed-in kinfolk gets
 * permission-denied, and anything assuming this `getDoc` succeeds for them is
 * wrong. (This header used to cite "line 140-143: allow read: if signedIn()",
 * which was stale on both the line number and the predicate; a line-number
 * citation is not repeated here for the same reason it went stale.)
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
  /**
   * ISO instant of the last time an operator CLEARED this logo, or '' if one is
   * currently set or was never set. Server-written only, by
   * `confirmBrandAssetUpload`.
   *
   * It exists because `logoUrl === ''` alone cannot tell "I removed this" from
   * "this was never configured", and those want different words on screen: the
   * first is a state the operator chose, the second is a feature they have not
   * used yet. Without it, an operator who removes a logo sees the identical
   * empty panel a fresh install shows and cannot confirm the removal took.
   */
  logoRemovedAt: string;
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
/**
 * PR30: each processor's fee schedule — a percentage plus a fixed base,
 * stored as INTEGER basis points and INTEGER cents (`feeBps: 290` = 2.9%,
 * `feeFixedCents: 30` = $0.30). Never a float percentage: that is how
 * rounding errors get into money (see `mytribe/functions/src/lib/
 * paymentMoney.ts`).
 *
 * Mirrored from `mytribe/functions/src/lib/paymentMethods.ts`'s
 * `METHOD_SPECS`, not imported from it: this app and `mytribe/functions` are
 * not workspace members of each other (repo root `package.json` — Cloud
 * Functions deploy as a self-contained artifact), so the numbers are copied
 * here rather than shared.
 *
 * THIS IS A SCHEDULE, NOT A CHARGED FEE. It exists so a future recording
 * form can pre-fill an expected fee the operator can correct, and so this
 * settings panel can say what a rail costs. It must never be stored as
 * though it were the charged fee — the standing ruling (`paymentMoney.ts`)
 * is that the real fee is known at record time, read off the processor's own
 * site by the operator. A computed figure may SEED that field; it may never
 * silently become the recorded value, and it must never overwrite a figure
 * she typed.
 *
 * KINFOLK NEVER SEE FEES (standing ruling; `getMyInvoices.ts` correctly does
 * not select the field). This schedule is admin-only: it renders as a
 * caption on THIS settings panel, never anywhere the portal reads.
 */
export const PAYMENT_METHOD_FEE_SCHEDULE: Readonly<
  Record<'stripe' | 'venmo' | 'paypal' | 'cashapp', { feeBps: number; feeFixedCents: number }>
> = {
  stripe: { feeBps: 290, feeFixedCents: 30 },
  venmo: { feeBps: 190, feeFixedCents: 10 },
  paypal: { feeBps: 349, feeFixedCents: 49 },
  cashapp: { feeBps: 260, feeFixedCents: 15 },
};

/** "2.9% + $0.30" from a `PAYMENT_METHOD_FEE_SCHEDULE` entry. Display only — see the constant's own header. */
export function formatFeeSchedule(entry: { feeBps: number; feeFixedCents: number }): string {
  const pct = (entry.feeBps / 100).toFixed(2).replace(/\.?0+$/, '');
  const cents = (entry.feeFixedCents / 100).toFixed(2);
  return `${pct}% + $${cents}`;
}

/**
 * ISSUE #409: one row per payment option the operator can switch on.
 *
 * Mirrored from `mytribe/functions/src/lib/paymentMethods.ts`'s `METHOD_SPECS`
 * for the same reason `PAYMENT_METHOD_FEE_SCHEDULE` above is mirrored: this
 * app and `mytribe/functions` are not workspace members of each other (repo
 * root `package.json` — Cloud Functions deploy as a self-contained artifact),
 * so there is no import to share. `settings.paymentOptions.test.ts` asserts
 * the two agree, which is what keeps a mirror from becoming a fork.
 *
 * `kind` decides what the settings row shows:
 *   checkout      a toggle and nothing else. The card, Klarna and Affirm all
 *                 ride the operator's existing Stripe account and need
 *                 nothing typed here.
 *   link          a toggle and a handle box. The handle lives in the same
 *                 top-level field it always has (`venmoHandle` and friends),
 *                 untouched by this change.
 *   instructions  a toggle and a text box. There is no link to build, so the
 *                 operator's own words are the whole method.
 */
export type PaymentMethodKind = 'checkout' | 'link' | 'instructions';

export interface PaymentMethodRow {
  id: string;
  /** The settings row heading: "Venmo", not "Pay with Venmo". */
  label: string;
  kind: PaymentMethodKind;
  /** What an operator who has never touched this toggle gets. See the server registry for why. */
  defaultEnabled: boolean;
  /** The `BusinessSettings` field holding this method's handle, for `kind: 'link'` only. */
  handleField?: StringSettingKey;
  /** Placeholder for the instructions box. */
  instructionsPlaceholder?: string;
  /** Fee schedule, admin-only. Absent for the methods no processor charges for. */
  fee?: { feeBps: number; feeFixedCents: number };
  /** One line under the row explaining what turning this on does. */
  note?: string;
}

/** The `BusinessSettings` keys a payment row may write a handle into. */
export type StringSettingKey = 'venmoHandle' | 'paypalHandle' | 'cashappHandle';

export const PAYMENT_METHOD_CATALOGUE: readonly PaymentMethodRow[] = [
  {
    id: 'stripe',
    label: 'Credit card',
    kind: 'checkout',
    defaultEnabled: true,
    fee: PAYMENT_METHOD_FEE_SCHEDULE.stripe,
    note: 'Runs through Stripe. Kinfolk pay from the invoice and the balance clears itself.',
  },
  {
    id: 'venmo',
    label: 'Venmo',
    kind: 'link',
    defaultEnabled: true,
    handleField: 'venmoHandle',
    fee: PAYMENT_METHOD_FEE_SCHEDULE.venmo,
  },
  {
    id: 'paypal',
    label: 'PayPal',
    kind: 'link',
    defaultEnabled: true,
    handleField: 'paypalHandle',
    fee: PAYMENT_METHOD_FEE_SCHEDULE.paypal,
  },
  {
    id: 'cashapp',
    label: 'Cash App',
    kind: 'link',
    defaultEnabled: true,
    handleField: 'cashappHandle',
    fee: PAYMENT_METHOD_FEE_SCHEDULE.cashapp,
  },
  {
    id: 'klarna',
    label: 'Klarna',
    kind: 'checkout',
    defaultEnabled: false,
    fee: { feeBps: 599, feeFixedCents: 30 },
    note: 'Rides your Stripe account. Activate Klarna in Stripe first, or checkout falls back to card.',
  },
  {
    id: 'affirm',
    label: 'Affirm',
    kind: 'checkout',
    defaultEnabled: false,
    fee: { feeBps: 599, feeFixedCents: 30 },
    note: 'Rides your Stripe account. Activate Affirm in Stripe first, or checkout falls back to card.',
  },
  {
    id: 'zelle',
    label: 'Zelle',
    kind: 'instructions',
    defaultEnabled: false,
    instructionsPlaceholder: 'Zelle to (555) 555-0104, and put the invoice number in the note.',
  },
  {
    id: 'banktransfer',
    label: 'Bank transfer',
    kind: 'instructions',
    defaultEnabled: false,
    instructionsPlaceholder: 'Routing 000000000, account 000000000, Tribe Tails Care.',
  },
  {
    id: 'check',
    label: 'Check',
    kind: 'instructions',
    defaultEnabled: false,
    instructionsPlaceholder: 'Make it out to Tribe Tails Care and hand it over at pickup.',
  },
  {
    id: 'cash',
    label: 'Cash',
    kind: 'instructions',
    defaultEnabled: false,
    instructionsPlaceholder: 'Exact change, handed to your Auntie at pickup.',
  },
  {
    id: 'other',
    label: 'Other',
    kind: 'instructions',
    defaultEnabled: false,
    instructionsPlaceholder: 'Anything else you take, in your own words.',
  },
] as const;

/**
 * One method's saved configuration on `business_settings.paymentOptions`.
 *
 * ABSENT IS NOT OFF. A method with no entry falls back to its
 * `defaultEnabled`, which is how every settings doc written before this panel
 * existed keeps offering exactly what it offered before. Only an explicit
 * `false` turns a method off. The server registry
 * (`mytribe/functions/src/lib/paymentMethods.ts`) is the authority on that
 * rule; this mirror follows it.
 */
export interface PaymentOptionSetting {
  enabled?: boolean;
  instructions?: string;
}

/**
 * How long a method's instructions may run.
 *
 * Mirrors `MAX_INSTRUCTIONS_LENGTH` in
 * `mytribe/functions/src/lib/paymentMethods.ts`, which ENFORCES it: the
 * server refuses over-length instructions outright rather than truncating
 * payment details into something that looks valid and is not. This constant
 * exists so the textarea stops the operator at the same figure, where she
 * can see it happening, instead of letting her write past it and discover
 * later that the method never appeared on an invoice.
 */
export const MAX_PAYMENT_INSTRUCTIONS_LENGTH = 500;

export interface BusinessSettings {
  _id: string;
  businessName: string;
  businessEmail: string;
  businessPhone: string;
  businessAddress: string;
  timeZone: string;
  serviceRates: Record<string, string>;
  /**
   * Minutes each KinCare type runs, keyed by the SAME name `serviceRates` is
   * keyed by, as a string ("30", "360") because every map on this doc stores
   * strings and a half-typed field is not a number.
   *
   * Added because the duration used to live INSIDE the name and was read back
   * out with a regex (`serviceDurationMinutes`), so "Half-Day 6Hrs" sorted
   * correctly and "Consultation" had no length at all. Mark 15 of the
   * 2026-08-17 walk: "we create a third attribute to the kincare: duration. so
   * kincare will have a name/title, duration, and price".
   *
   * SPARSE AND OPTIONAL BY DESIGN. Nothing backfills it, no existing document
   * has it, and every reader still falls back to parsing the name, so a type
   * saved before this field existed keeps the length it always had. An entry
   * here is the operator stating the length outright, which is the one thing
   * the parse can never do.
   */
  serviceDurations: Record<string, string>;
  businessHours: Record<string, string>;
  venmoHandle: string;
  paypalHandle: string;
  cashappHandle: string;
  /**
   * ISSUE #409: which payment options are offered, keyed by the catalogue ids
   * above. The three handles keep their own top-level fields and are still
   * read from them by the invoice PDF and the portal; this map says whether
   * each method is OFFERED, and carries the written instructions for the
   * methods that are a sentence rather than a link.
   *
   * SPARSE, and absent on every doc written before this panel shipped. A
   * method with no entry here reads as its `defaultEnabled`, so nothing is
   * backfilled and no invoice changes under anybody.
   */
  paymentOptions: Record<string, PaymentOptionSetting>;
  weatherLocation: string;
  /**
   * ISSUE #519: `notificationEmail` / `notificationSms` / `notificationPush`
   * USED TO BE DECLARED HERE and are deliberately gone.
   *
   * They were three booleans this module declared, defaulted and decoded, that
   * no screen rendered and — the part that decided it — that no dispatcher read.
   * A repo-wide sweep found zero occurrences in `mytribe/functions`, zero in
   * `mytribe/web`, zero in `auntieos-admin/web/functions`, and none on the
   * Android model at all. Every channel decision is made by
   * `mytribe/functions/src/notifications/prefs.ts#resolveChannels`, off the
   * per-notification gate matrix stored on a DIFFERENT document
   * (`businessSettings/notifications`, camel-case, edited by `NotificationGate`).
   * The near-identical collection names are why these three read as live.
   *
   * They are removed from the MODEL, not from any document: nothing deletes the
   * keys, so a doc that carries them keeps them, inert, exactly as it is today.
   * The alternative — giving an operator an Email/SMS/Push switch that changes
   * nothing while the real gate sits one tab away — is the defect this issue is
   * about, pointed in the opposite direction.
   */
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
  /**
   * ISSUE #582: how close to the household counts as arrived, in metres. Only
   * meaningful while `requireArrivalDepartureVerification` is on — it is that
   * switch's threshold, not a second switch, so there is no "off" value here.
   */
  arrivalRadiusMeters: number;
  autoStartTrackingOnVisitStart: boolean;
  trackingAccuracy: string;
  saveRoutesForDays: number;
  allowClientLocationSharing: boolean;
  defaultEtaMinutes: number;
  etaMinuteOptions: number[];
  draftRetentionDays: number;
  draftRetentionOptions: number[];
  calendarSyncId: string;
  /**
   * The last-run receipt the `syncGoogleCalendarBusyEvents` callable merges onto
   * this doc after EVERY run, success or failure (see `CALLABLE_CONTRACT.md`).
   * Server-written only: nothing in this app writes these, because a client
   * cannot know whether a sync happened.
   *
   * They are read rather than derived because the callable's return value dies
   * with the page. Without them the panel cannot tell a sync that worked from
   * one that never ran, which is a Run Sync button the operator presses twice.
   * A doc predating the feature reads blank / 'ok' / 0, which
   * `calendarSyncRunLabel` renders as "never run", not as a zero-import success.
   */
  calendarSyncLastRunAt: string;
  calendarSyncLastStatus: string;
  calendarSyncLastImported: number;
  calendarSyncLastError: string;
  autoConfirmRepeatKinfolk: boolean;
  snapRescheduleTo15Min: boolean;
  /**
   * ISSUE #397: whether the phone line offers "press 3 to talk to me right
   * now".
   *
   * DEFAULTS TRUE, unlike every other boolean on this document, and the
   * exception is deliberate. The live connect path has been in the deployed
   * `twilioVoice` handler since PR #351 and no settings document has ever
   * carried this field, so defaulting it false would read as "the operator
   * turned it off" and withdraw the offer without anybody asking.
   * `mytribe/functions/src/lib/businessHours.ts`'s `resolveLiveTransferEnabled`
   * is the server-side authority and applies the identical rule: only an
   * explicit `false` turns it off.
   *
   * It records INTENT, not reachability. Whether a caller pressing 3 actually
   * gets through also needs the Twilio Voice credentials and the number's
   * "A call comes in" webhook, neither of which this app can read. See
   * `PhoneLineSection`, which says so on the screen.
   */
  voiceLiveTransferEnabled: boolean;
  /**
   * PHASE 1's PRE-LAUNCH SEND GATE: whether anything at all reaches a household.
   *
   * DEFAULTS FALSE, and only the literal boolean `true` opens it, which is the
   * opposite of `voiceLiveTransferEnabled` two fields up and for the opposite
   * reason. The product is not live, production data is about to be deleted and
   * re-uploaded, and a value we cannot read as `true` is not evidence the
   * operator opened the product.
   * `mytribe/functions/src/notifications/householdSendGate.ts` is the
   * server-side authority and applies the identical rule. It shipped in PR #943
   * with no control anywhere; `NotificationScheduleSection` is its first one.
   */
  householdNotificationsLive: boolean;
  /**
   * When `invoiceRemindersCron` and `invoiceOverdueCron` send, as an hour 0..23
   * on the business's own clock, or `null` for "not scheduled".
   *
   * NULL IS NOT A MISSING VALUE TO BE DEFAULTED, it is the answer. Operator
   * ruling 2026-09-22: no job runs until they switch it on here, and the cadence
   * is theirs to choose. The 09:00 and 09:30 these crons used to be pinned to
   * were never anybody's decision, so this app does not offer them back as
   * defaults. `mytribe/functions/src/lib/notificationSchedule.ts` reads it the
   * same way.
   */
  householdNotificationHour: number | null;
  /** The same, for `scheduleDigestCron`. Its own field because it is the operator's own brief, not a household's notice. */
  scheduleDigestHour: number | null;
  logoUrl: string;
  /** ISO instant of the last clear of `logoUrl`, or ''. See `MyTribePortalConfig.logoRemovedAt` for why this exists. */
  logoRemovedAt: string;
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
  logoRemovedAt: '',
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
  serviceDurations: {},
  businessHours: {},
  venmoHandle: '',
  paypalHandle: '',
  cashappHandle: '',
  paymentOptions: {},
  weatherLocation: '',
  observedUsHolidays: [],
  companyHolidays: [],
  specialHours: [],
  observeUsHolidays: false,
  defaultBookingMode: 'SPECIFIC_TIME',
  defaultCalendarView: 'MONTH',
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: true,
  enableConflictDetection: true,
  // ISSUE #519 flipped this from `false`. `kincareReminderCron` has always
  // enqueued `kincare.upcoming.reminder` for every confirmed booking 24-48h out,
  // unconditionally, so `false` was never what the product did. The server now
  // gates on the field (`mytribe/functions/src/lib/autoReminder.ts`) and reads
  // absent as ON; this default is what the models should always have said.
  enableAutoReminder24h: true,
  defaultTimeBlockDurationHours: 4,
  travelBufferMinutes: 30,
  timeBlocks: [
    { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
  ],
  enableGPSTrackingForAllVisits: true,
  enablePhotoLocationTagging: true,
  requireArrivalDepartureVerification: true,
  // 150 m. Android's dormant geofence constants are 50 m and 100 m, which are
  // too tight for a fix taken indoors, where an Auntie usually is when she
  // presses the button. See ARRIVAL_RADIUS_DEFAULT_METERS in
  // `functions/src/lib/arrivalVerification.ts`, which is the value the server
  // falls back to and must stay in step with this one.
  arrivalRadiusMeters: 150,
  autoStartTrackingOnVisitStart: true,
  trackingAccuracy: 'HIGH',
  saveRoutesForDays: 90,
  allowClientLocationSharing: true,
  defaultEtaMinutes: 15,
  etaMinuteOptions: [5, 10, 15, 20, 30, 45, 60],
  draftRetentionDays: 30,
  draftRetentionOptions: [30, 60, 90],
  calendarSyncId: '',
  calendarSyncLastRunAt: '',
  calendarSyncLastStatus: '',
  calendarSyncLastImported: 0,
  calendarSyncLastError: '',
  autoConfirmRepeatKinfolk: false,
  snapRescheduleTo15Min: false,
  // TRUE by design; see the field's comment on the interface.
  voiceLiveTransferEnabled: true,
  // FALSE and NULL by design; see their comments on the interface. Nothing sends
  // and nothing is scheduled until the operator says so on the Notifications tab.
  householdNotificationsLive: false,
  householdNotificationHour: null,
  scheduleDigestHour: null,
  logoUrl: '',
  logoRemovedAt: '',
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

/**
 * A send hour, or null for "not scheduled".
 *
 * The one numeric reader in this file, and it is here rather than as a general
 * `pickNumber` for the reason the note above gives: nothing should learn to
 * invent a numeric fact a document never stated. This one invents nothing. It
 * has no fallback to invent, because null is a real answer rather than a
 * missing one, and anything that is not an integer 0..23 reads as null.
 *
 * It matches `resolveSendHour` in
 * `mytribe/functions/src/lib/notificationSchedule.ts` value for value, so the
 * picker and the cron never disagree about whether a job is scheduled.
 */
function pickHour(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 23) return null;
  return raw;
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

/**
 * Reads `business_settings.paymentOptions` into a shape the panel can render.
 *
 * Only rows for methods IN THE CATALOGUE are kept, and only the two fields
 * this app knows about: a stale key left by an older build, or a typo made in
 * the Firestore console, cannot put a payment option on screen that no
 * invoice will ever offer. An absent or malformed map reads as `{}`, which is
 * "nothing configured" and resolves every method to its default.
 */
function mergePaymentOptions(raw: unknown): Record<string, PaymentOptionSetting> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const rows = raw as Record<string, unknown>;
  const out: Record<string, PaymentOptionSetting> = {};
  for (const method of PAYMENT_METHOD_CATALOGUE) {
    const entry = rows[method.id];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const option: PaymentOptionSetting = {};
    if (typeof e.enabled === 'boolean') option.enabled = e.enabled;
    if (typeof e.instructions === 'string') option.instructions = e.instructions;
    out[method.id] = option;
  }
  return out;
}

/** Is this method offered? Absent is not off; see `PaymentOptionSetting`. */
export function isPaymentMethodEnabled(
  options: Record<string, PaymentOptionSetting>,
  method: PaymentMethodRow,
): boolean {
  return options[method.id]?.enabled ?? method.defaultEnabled;
}

function mergeMyTribePortal(raw: unknown): MyTribePortalConfig {
  const r = (raw ?? {}) as Partial<MyTribePortalConfig>;
  return {
    logoUrl: pickString(r.logoUrl, DEFAULT_MYTRIBE_PORTAL.logoUrl),
    logoRemovedAt: pickString(r.logoRemovedAt, DEFAULT_MYTRIBE_PORTAL.logoRemovedAt),
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
    serviceDurations: pickMap(r.serviceDurations, d.serviceDurations),
    businessHours: pickMap(r.businessHours, d.businessHours),
    venmoHandle: pickString(r.venmoHandle, d.venmoHandle),
    paypalHandle: pickString(r.paypalHandle, d.paypalHandle),
    cashappHandle: pickString(r.cashappHandle, d.cashappHandle),
    paymentOptions: mergePaymentOptions(r.paymentOptions),
    weatherLocation: pickString(r.weatherLocation, d.weatherLocation),
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
    arrivalRadiusMeters: (r.arrivalRadiusMeters as number) ?? d.arrivalRadiusMeters,
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
    calendarSyncLastRunAt: pickString(r.calendarSyncLastRunAt, d.calendarSyncLastRunAt),
    calendarSyncLastStatus: pickString(r.calendarSyncLastStatus, d.calendarSyncLastStatus),
    // Checked inline rather than through the `as number` cast the older numeric
    // fields use, and without adding a general `pickNumber` (the note above
    // this block explains why numbers are deliberately absent from the helper
    // set). This one value is interpolated straight into a sentence the
    // operator reads as fact, so a non-number must land on 0, which the panel
    // only ever shows next to a real `calendarSyncLastRunAt`.
    calendarSyncLastImported:
      typeof r.calendarSyncLastImported === 'number' && Number.isFinite(r.calendarSyncLastImported)
        ? r.calendarSyncLastImported
        : d.calendarSyncLastImported,
    calendarSyncLastError: pickString(r.calendarSyncLastError, d.calendarSyncLastError),
    autoConfirmRepeatKinfolk: (r.autoConfirmRepeatKinfolk as boolean) ?? d.autoConfirmRepeatKinfolk,
    snapRescheduleTo15Min: (r.snapRescheduleTo15Min as boolean) ?? d.snapRescheduleTo15Min,
    // `!== false` rather than the `?? default` the booleans above use, so this
    // mirrors the server exactly: `resolveLiveTransferEnabled` turns the line
    // off for an explicit boolean false and for nothing else. A stray string
    // or number in this field must read as ON in the admin UI too, or the
    // switch would show off while the phone still offered the transfer.
    // `=== true` rather than the `?? default` the booleans above use, mirroring
    // `resolveHouseholdSendGate` exactly: a `'true'` string or a `1` left by a
    // hand edit is not the operator opening the product, and a toggle that
    // showed ON while the server held every household copy back would be the
    // worst possible lie for this particular switch.
    householdNotificationsLive: r.householdNotificationsLive === true,
    householdNotificationHour: pickHour(r.householdNotificationHour),
    scheduleDigestHour: pickHour(r.scheduleDigestHour),
    voiceLiveTransferEnabled: r.voiceLiveTransferEnabled !== false,
    logoUrl: pickString(r.logoUrl, d.logoUrl),
    logoRemovedAt: pickString(r.logoRemovedAt, d.logoRemovedAt),
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
