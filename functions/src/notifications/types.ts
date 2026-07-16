/**
 * Notification system types.
 *
 * The catalog (catalog.ts) is the single source of truth for every auto-notification
 * the platform can emit. Each entry declares: who hears it, on which channels,
 * which channels are forced on, how it's delivered, and how it groups in UI.
 *
 * Dispatcher consumes a NotificationDef to compute effective channels for a
 * given recipient, merging catalog defaults, admin business overrides, and
 * recipient per-key/per-category preferences.
 */

export type Channel = 'email' | 'sms' | 'push';

export type DeliveryMode =
  | 'trigger'    // immediate; write notifications/{id} doc → channel fan-out
  | 'debounced'  // collapse rapid repeats; scheduler promotes after fireAfter
  | 'batched'    // append to batch; scheduler emits digest at cadence
  | 'scheduled'; // fire at explicit fireAt timestamp

export type Audience = 'kinfolk' | 'business' | 'both';

export type Category =
  | 'visit'
  | 'kintale'
  | 'invoice'
  | 'schedule'
  | 'home'
  | 'account'
  | 'ratings'
  | 'marketing'
  | 'security'
  | 'messages';

/**
 * Marketing-class notifications must share a single global opt-out per the
 * Settings UI. CAN-SPAM / CASL also require unsubscribe footers on every email
 * carrying a `marketingCategory`.
 */
export type MarketingCategory = 'newsletter' | 'survey' | 'marketing';

/**
 * Resolves a notification dispatch to the actual recipient uid(s).
 * 'specificUid'             , caller passes uid directly.
 * 'kinfolkAcct'             , caller passes kinfolk uid (no resolution).
 * 'businessAdmins'          , reads businessSettings/admins.uids, dispatches per admin.
 * 'auntieAssignedToKincare' , reads kincare.assignedAuntieUid from data payload.
 */
export type RecipientResolver =
  | 'specificUid'
  | 'kinfolkAcct'
  | 'businessAdmins'
  | 'auntieAssignedToKincare';

/** Audience stream a notification copy is resolved for (audience revamp 2026-07). */
export type AudienceStream = 'kinfolk' | 'business' | 'staff';

export interface NotificationDef {
  /** Unique catalog key (dotted namespace, e.g. 'kincare.booking.confirm'). */
  key: string;
  /** Short human title rendered as the row name in every settings UI. */
  label: string;
  /** Who the notification targets, affects UI visibility split. */
  audience: Audience;
  /** Which audience streams receive this notification. A key may serve several.
   *  business = owner-hat ops (bookings, invoices, payments, security, ratings).
   *  staff    = auntie-hat workflow (visit notes, KinTale chatter, assignments).
   *  kinfolk  = the client household's own copy.
   *  Invariant: at least one set; never business AND staff on the same key. */
  audiences: { kinfolk?: true; business?: true; staff?: true };
  /** Category bucket for the UI "select-all by row" grouping. */
  category: Category;
  /** Channels available to this notification. SMS/push may be off until E3. */
  allowedChannels: Channel[];
  /** Channels forced ON regardless of admin/user prefs (e.g. legal/security). */
  required: Partial<Record<Channel, true>>;
  /** When true, admin cannot disable the entire notification. */
  alwaysEnabled: boolean;
  /**
   * Scopes `alwaysEnabled` to specific audience streams. When set, only the
   * listed streams render as always-on/required; the key's other streams are
   * freely gateable by the operator. Absent = `alwaysEnabled` applies to every
   * stream the key serves (legacy behavior). Must be a subset of `audiences`
   * and only meaningful when `alwaysEnabled` is true.
   */
  alwaysEnabledStreams?: { kinfolk?: true; business?: true; staff?: true };
  /** When false, hidden from kinfolk prefs UI (system-mandatory or business-only). */
  kinfolkFacing: boolean;
  /** Delivery routing. */
  deliveryMode: DeliveryMode;
  /** For 'debounced': inactivity window before emit (ms). Default 30min. */
  debounceMs?: number;
  /** For 'debounced': how to handle repeated enqueues in the window. */
  debounceStrategy?: 'snapshot' | 'collapse';
  /** For 'batched': stable bucket key + emission cadence (ms). */
  batchKey?: string;
  batchWindowMs?: number;
  /** Resolves dispatch payload to recipient uid(s). */
  recipientResolver: RecipientResolver;
  /**
   * Optional second resolver. When set, dispatcher fans out to both resolvers
   * and dedupes by uid. Use for `audience: 'both'` keys where one event must
   * notify both kinfolk and business sides automatically (e.g. invoice.new
   * → kinfolkAcct + businessAdmins).
   */
  secondaryResolver?: RecipientResolver;
  /** Template ID per channel; lookups `${ch}Templates/{templateId}`. */
  templates: Partial<Record<Channel, string>>;
  /** Marketing-class flag, drives unsubscribe footer + global opt-out grouping. */
  marketingCategory?: MarketingCategory;
  /**
   * If true, dispatcher logs and returns instead of fanning out to channels;
   * the notification is delivered by an external system (e.g., Firebase Auth
   * Console sends password.reset emails). The catalog row is kept for
   * documentation/cross-reference purposes only, no template lookup occurs.
   */
  external?: boolean;
  /** Human description shown in admin UI for clarity. */
  description: string;
}

/** Effective per-channel resolution returned by the prefs merger. */
export interface ResolvedChannels {
  email: boolean;
  sms: boolean;
  push: boolean;
}

/**
 * The kind of entity a notification points at, so a client can deep-link the
 * notification to the originating record and offer quick approve/deny actions.
 * '' means the dispatch carried no resolvable entity.
 */
export type NotificationTargetType =
  | 'booking'
  | 'invoice'
  | 'kintale'
  | 'kinfolk'
  | '';

/** Caller-side input to enqueueNotification. */
export interface EnqueueArgs {
  key: string;
  /** When resolver is 'specificUid' or 'kinfolkAcct'. */
  recipientUid?: string;
  /** Arbitrary template data + resolver hints (e.g. { kincareId, assignedAuntieUid }). */
  data: Record<string, unknown>;
  /** Uid that triggered the notification, if any (for audit). */
  actorUid?: string;
  /** Override fireAt for 'scheduled' mode (ms epoch). */
  fireAtMs?: number;
  /**
   * Originating entity kind. When omitted the dispatcher derives it from common
   * id keys in `data` (invoiceId/taleId/bookingId/...), defaulting to ''.
   * Persisted on the notification doc as `targetType` for open-linked +
   * quick approve/deny in the client.
   */
  targetType?: NotificationTargetType;
  /** Originating entity id. When omitted the dispatcher derives it from `data`. */
  targetId?: string;
}

/** Per-user prefs document shape (stored on clients/{uid} or staff/{uid}). */
export interface UserNotificationPrefs {
  byCategory?: Partial<Record<Category, Partial<ResolvedChannels>>>;
  byKey?: Record<string, Partial<ResolvedChannels>>;
  marketingOptIn?: Partial<Record<MarketingCategory, boolean>>;
}

/** Per-business admin override doc shape (businessSettings/notifications/{key}). */
export interface BusinessNotificationOverride {
  enabled: boolean;
  channels: Partial<ResolvedChannels>;
  /**
   * Run-4 #13: admin-set LOCKS. When `lockedEnabled` is true the whole-notification
   * on/off cannot be changed by the kinfolk; a `locked[channel]` true pins that
   * channel's on/off for the kinfolk. Distinct from the catalog's `alwaysEnabled` /
   * `required` (code-mandated): these are operator choices made in Business Settings.
   */
  lockedEnabled?: boolean;
  locked?: Partial<Record<Channel, true>>;
  /** Operator-authored reason shown to users on locked/required rows. */
  lockReason?: string;
  /** Per-audience-stream gate overlays. Field-level fallback to the flat fields. */
  streams?: Partial<Record<'business' | 'staff' | 'kinfolk', {
    enabled?: boolean;
    channels?: Partial<Record<Channel, boolean>>;
    lockedEnabled?: boolean;
    locked?: Partial<Record<Channel, true>>;
  }>>;
}
