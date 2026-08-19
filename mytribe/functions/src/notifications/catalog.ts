import type { Category, Channel, NotificationDef } from './types';

/**
 * Notification catalog, single source of truth.
 *
 * Adding a new notification:
 * 1. Pick a unique dotted key under an appropriate namespace.
 * 2. Add a row below; pick `audience`, `audiences` (stream taxonomy: kinfolk /
 *    business / staff; at least one, never business AND staff), `category`,
 *    `allowedChannels`, `required`, `kinfolkFacing`, `alwaysEnabled`,
 *    `deliveryMode`, `recipientResolver`, and `templates`.
 * 3. Seed template docs in Firestore: `emailTemplates/{templates.email}`,
 *    `smsTemplates/{templates.sms}`, `pushTemplates/{templates.push}`.
 *
 * Mode quick-reference:
 *   trigger   , fire immediately on enqueue. Default.
 *   debounced , collapse rapid changes; emit once inactive (debounceMs).
 *   batched   , append items; scheduler emits digest every batchWindowMs.
 *   scheduled , fire at explicit fireAt timestamp (caller-provided).
 *
 * Required vs alwaysEnabled — READ THIS BEFORE WORDING ANY UI (#451):
 *   required.email = true       → email is on unless the OPERATOR turns the
 *                                 channel off in the gate. A recipient's own
 *                                 pref cannot turn it off; the operator's can
 *                                 (resolveChannels step 2 beats step 3).
 *   alwaysEnabled = true        → ADVISORY ONLY. Nothing enforces it. Ruling #7
 *                                 (2026-06-08, warn-but-allow-off) deliberately
 *                                 removed enforcement, and resolveChannels has
 *                                 no alwaysEnabled check at all, so the operator
 *                                 can silence any of these rows and it will then
 *                                 genuinely stop sending to everyone.
 *   kinfolkFacing = false       → hidden from kinfolk prefs UI (still sent).
 *
 * So no surface may caption either flag "Always on" or "Required" full stop.
 * The settled words are "Meant to stay on" for alwaysEnabled and, on a
 * recipient's own screen, "Set by your business" / "Set by Tribe Tails Pet
 * Care" for a channel that recipient cannot change.
 */

const DEBOUNCE_30_MIN = 30 * 60 * 1000;
const BATCH_5_MIN = 5 * 60 * 1000;

const CATALOG_LIST: NotificationDef[] = [
  // ─────────────────────────────────────────────────────────
  // VISIT (KinCare lifecycle)
  // ─────────────────────────────────────────────────────────
  {
    key: 'kincare.booking.confirm',
    label: 'KinCare booking confirmed',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    alwaysEnabledStreams: { kinfolk: true },
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    secondaryResolver: 'businessAdmins',
    templates: { email: 'kincare.booking.confirm', sms: 'kincare.booking.confirm', push: 'kincare.booking.confirm' },
    description: 'KinCare booking confirmed.',
  },
  {
    key: 'kincare.booking.cancel',
    label: 'KinCare booking canceled',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    alwaysEnabledStreams: { kinfolk: true },
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    secondaryResolver: 'businessAdmins',
    templates: { email: 'kincare.booking.cancel', sms: 'kincare.booking.cancel', push: 'kincare.booking.cancel' },
    description: 'KinCare booking canceled.',
  },
  {
    key: 'kincare.auntie.on_my_way',
    label: 'Your Auntie is on the way',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'kincare.auntie.on_my_way', sms: 'kincare.auntie.on_my_way', push: 'kincare.auntie.on_my_way' },
    description: 'Auntie en route to KinCare (optional ETA).',
  },
  {
    key: 'kincare.auntie.arrived',
    label: 'Your Auntie has arrived',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'kincare.auntie.arrived', sms: 'kincare.auntie.arrived', push: 'kincare.auntie.arrived' },
    description: 'Auntie arrived at KinCare.',
  },
  {
    key: 'kincare.auntie.departed',
    label: 'Your Auntie has departed',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'kincare.auntie.departed', sms: 'kincare.auntie.departed', push: 'kincare.auntie.departed' },
    description: 'Auntie departed KinCare.',
  },
  // NOTE (2026-07-24): `kincare.report.sent` used to live here, a second row
  // for the same real-world moment as `kintale.published`. It is now an alias
  // (see NOTIFICATION_KEY_ALIASES below), not a catalog row.
  {
    key: 'kincare.unavailable',
    label: 'KinCare marked unavailable',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'kincare.unavailable', sms: 'kincare.unavailable', push: 'kincare.unavailable' },
    description: 'KinCare marked unavailable (typically blocked home access).',
  },
  {
    key: 'kincare.requested',
    label: 'Kinfolk requested a KinCare visit',
    audience: 'business',
    audiences: { business: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'kincare.requested', sms: 'kincare.requested', push: 'kincare.requested' },
    description: 'Kinfolk requested a KinCare visit.',
  },
  {
    // Run-4 #13 audit: in BOTH bucket lists ("updates/deletes/requests changes to KinCare").
    key: 'kincare.changed',
    label: 'KinCare updated or change requested',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    alwaysEnabledStreams: { kinfolk: true },
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    // Run-4 #13: in BOTH buckets -> also notify the kinfolk their KinCare changed.
    // onBookingsWrite passes recipientUid (the kinfolk account uid); a missing uid
    // resolves to [] (tryResolve catches), so business-only still works.
    secondaryResolver: 'kinfolkAcct',
    templates: { email: 'kincare.changed', sms: 'kincare.changed', push: 'kincare.changed' },
    description: 'Kinfolk/Auntie updated, deleted, or requested changes to KinCare.',
  },
  {
    key: 'kincare.note.kinfolk',
    label: 'Kinfolk added a note to a KinCare',
    audience: 'business',
    audiences: { staff: true },
    category: 'visit',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'kincare.note.kinfolk', push: 'kincare.note.kinfolk' },
    description: 'Kinfolk added a note to the kinfolk-facing note box on a KinCare.',
  },
  {
    // Vendor-parity (2026-07-02): the office hears when a kinfolk asks to cancel
    // a visit. NOT a status change; requestBookingCancellation stamps
    // cancelRequestedAt on the kinCares doc and onBookingsWrite fires this.
    key: 'kincare.cancel.requested',
    label: 'Kinfolk requested a cancellation',
    audience: 'business',
    audiences: { business: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'kincare.cancel.requested', sms: 'kincare.cancel.requested', push: 'kincare.cancel.requested' },
    description: 'A kinfolk asked to cancel a KinCare visit.',
  },
  {
    // #399 item 2: the office hears when a kinfolk proposes a new time for a
    // visit. NOT a status change and NOT a move; requestBookingReschedule
    // stamps rescheduleRequestedAt on the kinCares doc and onBookingsWrite
    // fires this. The visit only moves when an operator accepts, through
    // admin/resolveBookingRescheduleRequest, and the household hears about
    // THAT through the existing kincare.changed key.
    key: 'kincare.reschedule.requested',
    label: 'Kinfolk proposed a new visit time',
    audience: 'business',
    audiences: { business: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: {
      email: 'kincare.reschedule.requested',
      sms: 'kincare.reschedule.requested',
      push: 'kincare.reschedule.requested',
    },
    description: 'A kinfolk asked to move a KinCare visit to a different time.',
  },
  {
    // Vendor-parity (2026-07-02): the office hears when an Auntie writes a visit
    // note. Mirrors kincare.note.kinfolk but for staff-authored notes; emitted by
    // the same onBookingNoteCreate trigger.
    key: 'kincare.note.auntie',
    label: 'Auntie added a note to a KinCare',
    audience: 'business',
    audiences: { business: true },
    category: 'visit',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'kincare.note.auntie', sms: 'kincare.note.auntie', push: 'kincare.note.auntie' },
    description: 'An Auntie added a note to a KinCare visit.',
  },

  // ─────────────────────────────────────────────────────────
  // KINTALE
  // ─────────────────────────────────────────────────────────
  {
    // 2026-07-24: absorbed the old `kincare.report.sent` row. A KinTale IS the
    // visit report, so the household had two switches for one thing.
    key: 'kintale.published',
    label: 'KinTale (visit report) published',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'kintale',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'kintale.published', sms: 'kintale.published', push: 'kintale.published' },
    description: 'Your Auntie published a KinTale, the written report from a KinCare visit.',
  },
  {
    // Run-4 #13 audit: in BOTH bucket lists ("Comment is added to a KinTale").
    key: 'kintale.comment.added',
    label: 'New comment on a KinTale (comment box)',
    audience: 'both',
    audiences: { kinfolk: true, staff: true },
    category: 'kintale',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'batched',
    batchKey: 'kintale-comments',
    batchWindowMs: BATCH_5_MIN,
    recipientResolver: 'kinfolkAcct',
    // Run-4 #13: in BOTH buckets -> also notify the business of the new comment.
    secondaryResolver: 'businessAdmins',
    templates: { email: 'kintale.comment.added', push: 'kintale.comment.added' },
    description:
      'Someone posted in the comment box under a KinTale. Collected into one message every 5 minutes.',
  },
  {
    // The trigger is onKinTaleUpdate: an ALREADY-SENT KinTale gains more body
    // text or more photos. That is the KinTale itself, not the comment box.
    key: 'kintale.note.added',
    label: 'Auntie added to a KinTale after sending',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'kintale',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'kintale.note.added', push: 'kintale.note.added' },
    description:
      'Your Auntie added more words or more photos to a KinTale you already received.',
  },
  // ─────────────────────────────────────────────────────────
  // INVOICE / QUOTE / PAYMENT
  // ─────────────────────────────────────────────────────────
  {
    key: 'invoice.new',
    label: 'New invoice or quote issued',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'invoice',
    allowedChannels: ['email', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    alwaysEnabledStreams: { kinfolk: true },
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    secondaryResolver: 'businessAdmins',
    templates: { email: 'invoice.new', push: 'invoice.new' },
    description: 'New invoice/quote issued.',
  },
  {
    key: 'invoice.updated',
    label: 'Invoice or quote updated',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'invoice',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    secondaryResolver: 'businessAdmins',
    templates: { email: 'invoice.updated', push: 'invoice.updated' },
    description: 'Invoice/quote updated.',
  },
  {
    key: 'invoice.receipt',
    label: 'Receipt issued for an invoice',
    audience: 'kinfolk',
    audiences: { kinfolk: true, business: true },
    category: 'invoice',
    allowedChannels: ['email', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    alwaysEnabledStreams: { kinfolk: true },
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    secondaryResolver: 'businessAdmins',
    templates: { email: 'invoice.receipt', push: 'invoice.receipt' },
    description: 'Receipt issued for an invoice.',
  },
  {
    key: 'invoice.reminder',
    label: 'Invoice payment reminder',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'invoice',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'scheduled',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'invoice.reminder', sms: 'invoice.reminder', push: 'invoice.reminder' },
    description: 'Invoice payment reminder.',
  },
  {
    key: 'invoice.overdue',
    label: 'Invoice overdue notice',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'invoice',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    kinfolkFacing: false,
    deliveryMode: 'scheduled',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'invoice.overdue', sms: 'invoice.overdue', push: 'invoice.overdue' },
    description: 'Invoice overdue notice.',
  },
  {
    key: 'invoice.charge.failed',
    label: 'Invoice charge or payment failed',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'invoice',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    alwaysEnabledStreams: { kinfolk: true },
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    secondaryResolver: 'businessAdmins',
    templates: { email: 'invoice.charge.failed', sms: 'invoice.charge.failed', push: 'invoice.charge.failed' },
    description: 'Invoice charge or payment attempt failed.',
  },
  {
    // Run-4 #13 audit: Kinfolk sees "Payment/credit applied"; Business sees "Invoice Paid".
    key: 'invoice.payment.applied',
    label: 'Payment or credit applied to an invoice',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'invoice',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    // Run-4 #13: in BOTH buckets -> "Invoice Paid" also notifies the business.
    secondaryResolver: 'businessAdmins',
    templates: { email: 'invoice.payment.applied', push: 'invoice.payment.applied' },
    description: 'Payment or credit applied to an invoice.',
  },
  {
    // A chargeback: the cardholder's bank pulled a settled card payment back.
    // BUSINESS-ONLY, and that is the deliberate part. The household is not
    // told, for two reasons: they already know (their own bank did it on their
    // instruction), and every honest thing this system could say to them
    // depends on a decision the operator has not made yet — the invoice keeps
    // reading paid on purpose (see `billing/stripeDispute.ts`), so a household
    // message would either contradict their own invoice or imply a debt the
    // operator may never assert. One key covers open AND close, because the
    // operator wants both halves of the same money event and would not
    // sensibly silence one while keeping the other.
    key: 'invoice.payment.disputed',
    label: 'Card payment disputed (chargeback)',
    audience: 'business',
    audiences: { business: true },
    category: 'invoice',
    allowedChannels: ['email', 'push'],
    required: { email: true },
    // Not silenceable: this is the only push notification the operator gets for
    // money leaving the account, and disputes carry a response deadline.
    alwaysEnabled: true,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'invoice.payment.disputed', push: 'invoice.payment.disputed' },
    description: 'A card payment was disputed with the cardholder’s bank, or that dispute closed.',
  },
  {
    key: 'quote.accepted',
    label: 'Kinfolk accepted a quote',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'invoice',
    allowedChannels: ['email', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    alwaysEnabledStreams: { kinfolk: true },
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    secondaryResolver: 'businessAdmins',
    templates: { email: 'quote.accepted', push: 'quote.accepted' },
    description: 'Quote accepted confirmation.',
  },
  {
    key: 'quote.denied',
    label: 'Kinfolk denied a quote',
    audience: 'business',
    audiences: { business: true },
    category: 'invoice',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'quote.denied', sms: 'quote.denied', push: 'quote.denied' },
    description: 'Kinfolk denied a quote.',
  },

  // ─────────────────────────────────────────────────────────
  // SCHEDULE
  // ─────────────────────────────────────────────────────────
  {
    key: 'kincare.upcoming.reminder',
    label: 'Upcoming KinCare reminder',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'schedule',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'scheduled',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'kincare.upcoming.reminder', sms: 'kincare.upcoming.reminder', push: 'kincare.upcoming.reminder' },
    description: 'Upcoming KinCare reminder (default 24-48 hours before).',
  },
  {
    key: 'schedule.upcoming.digest',
    label: 'Daily schedule digest',
    audience: 'business',
    audiences: { staff: true },
    category: 'schedule',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'scheduled',
    recipientResolver: 'businessAdmins',
    templates: { email: 'schedule.upcoming.digest', push: 'schedule.upcoming.digest' },
    description: 'Upcoming schedule digest for business.',
  },
  {
    // Vendor-parity (2026-07-02): staff assignment notifications. Emitted by
    // onBookingsWrite when a visit's assignedAuntieUid is first set; the resolver
    // reads assignedAuntieUid from the dispatch data.
    key: 'assignment.assigned',
    label: 'A KinCare visit was assigned to you',
    audience: 'business',
    audiences: { staff: true },
    category: 'schedule',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'auntieAssignedToKincare',
    templates: { email: 'assignment.assigned', sms: 'assignment.assigned', push: 'assignment.assigned' },
    description: 'A KinCare visit was assigned to an Auntie.',
  },
  {
    // Vendor-parity (2026-07-02): fired to the affected Auntie when their assigned
    // visit is reassigned, canceled, or has its details changed.
    key: 'assignment.changed',
    label: 'Your KinCare assignment changed',
    audience: 'business',
    audiences: { staff: true },
    category: 'schedule',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'auntieAssignedToKincare',
    templates: { email: 'assignment.changed', sms: 'assignment.changed', push: 'assignment.changed' },
    description: 'An assigned KinCare visit was changed, reassigned, or canceled.',
  },

  // ─────────────────────────────────────────────────────────
  // MESSAGES (inbox)
  // ─────────────────────────────────────────────────────────
  {
    // Vendor-parity (2026-07-02): the office hears when a kinfolk sends a 1:1
    // message from the portal. Emitted by sendKinfolkMessage.
    key: 'message.received',
    label: 'New message from a kinfolk',
    audience: 'business',
    audiences: { business: true },
    category: 'messages',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'message.received', sms: 'message.received', push: 'message.received' },
    description: 'A kinfolk sent your business a message.',
  },
  {
    // The other direction of `message.received`: the office writes one message
    // and sends it to a whole audience segment (admin/broadcastMessage.ts,
    // Communicate step 6).
    //
    // WHY THIS ROW EXISTS (#386). broadcastMessage does its own fan-out (it
    // never calls `enqueueNotification`, because there is no template for
    // ad-hoc operator-authored copy), but it stamps this key on the
    // `notifications/{id}` inbox doc it writes, and it now resolves each
    // recipient's channels through `resolveChannels` like every other send. A
    // key with no catalog row cannot be gated by the operator and cannot be
    // silenced by a household, which is exactly the bug. The templates below
    // are therefore never looked up; they exist because every row carries a
    // full set (see normalizeAllChannels).
    //
    // NOT marketing-class ON PURPOSE. A broadcast is the operational channel
    // (closures, weather, schedule changes), and `marketingCategory` is an
    // opt-IN gate that `resolveChannels` puts beyond the operator's reach.
    // Real campaigns have their own path: scheduleMarketingBlast over
    // newsletter.announcement / survey.event / marketing.optin. Broadcast keeps
    // the opt-OUT compliance it already ships: `message_suppressions` on email
    // and SMS, plus the shared unsubscribe footer on every broadcast email.
    key: 'broadcast.message',
    label: 'Announcements from the office',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'messages',
    allowedChannels: ['email', 'sms', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'broadcast.message', sms: 'broadcast.message', push: 'broadcast.message' },
    description: 'One-off announcements the office sends to a group of households.',
  },

  // ─────────────────────────────────────────────────────────
  // HOME (pets / profile / home access)
  // ─────────────────────────────────────────────────────────
  {
    key: 'pets.updated',
    label: 'Pets updated or added',
    audience: 'both',
    audiences: { kinfolk: true, staff: true },
    category: 'home',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'debounced',
    debounceMs: DEBOUNCE_30_MIN,
    debounceStrategy: 'snapshot',
    recipientResolver: 'businessAdmins',
    secondaryResolver: 'kinfolkAcct',
    templates: { email: 'pets.updated', push: 'pets.updated' },
    description: 'Kinfolk/Auntie updated or added Pets (30-min inactive debounce).',
  },
  {
    key: 'profile.updated',
    label: 'Profile updated',
    audience: 'both',
    audiences: { kinfolk: true, staff: true },
    category: 'home',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'debounced',
    debounceMs: DEBOUNCE_30_MIN,
    debounceStrategy: 'snapshot',
    recipientResolver: 'businessAdmins',
    secondaryResolver: 'kinfolkAcct',
    templates: { email: 'profile.updated', push: 'profile.updated' },
    description: 'Kinfolk/Auntie updated Profile (30-min inactive debounce).',
  },

  // ─────────────────────────────────────────────────────────
  // ACCOUNT / AUTH SECURITY
  // ─────────────────────────────────────────────────────────
  {
    key: 'account.welcome.kinfolk',
    label: 'Welcome to MyTribe',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'account',
    allowedChannels: ['email'],
    required: { email: true },
    alwaysEnabled: true,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'specificUid',
    templates: { email: 'account.welcome.kinfolk' },
    description: 'Welcome email to kinfolk on account creation (invite redemption).',
  },
  // `account.welcome.business` used to sit here, between the kinfolk welcome and
  // the invite-expired row. It is retired: see RETIRED_NOTIFICATION_KEYS below.
  {
    // Run-4: "Kinfolk's MyTribe Invite Expired" (Business bucket). Emitted by the
    // expireStaleInvites cron when a pending invite passes its expiresAt.
    key: 'invite.expired',
    label: 'A MyTribe invite expired',
    audience: 'business',
    audiences: { business: true },
    category: 'account',
    allowedChannels: ['email'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'invite.expired' },
    description: "A kinfolk's MyTribe invite expired before they accepted it.",
  },
  {
    key: 'auth.password.reset',
    label: 'Password reset link',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'account',
    allowedChannels: ['email'],
    required: { email: true },
    alwaysEnabled: true,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'specificUid',
    templates: { email: 'auth.password.reset' },
    description: 'Password reset link, generated server-side via Admin SDK, delivered by SendGrid dispatcher.',
  },
  {
    // Run-4 #13 audit: in BOTH bucket lists ("repeated fail login attempts").
    key: 'auth.failedLogin.attempts',
    label: 'Repeated failed login attempts',
    audience: 'both',
    audiences: { kinfolk: true, business: true },
    category: 'account',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'specificUid',
    // Run-4 #13: in BOTH buckets -> the business is also told about repeated fails.
    secondaryResolver: 'businessAdmins',
    templates: { email: 'auth.failedLogin.attempts', sms: 'auth.failedLogin.attempts', push: 'auth.failedLogin.attempts' },
    description: 'Repeated failed login attempts detected (5 in 10 min).',
  },
  {
    key: 'auth.account.locked',
    label: 'Account locked after failed logins',
    audience: 'both',
    audiences: { kinfolk: true },
    category: 'account',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: true,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'specificUid',
    templates: { email: 'auth.account.locked', sms: 'auth.account.locked', push: 'auth.account.locked' },
    description: 'Account locked after 10 failed login attempts in 20 min.',
  },

  // ─────────────────────────────────────────────────────────
  // SECURITY
  // ─────────────────────────────────────────────────────────
  {
    key: 'security.breach_attempt.kinfolk',
    label: 'Unsolicited password reset attempt',
    audience: 'business',
    audiences: { business: true },
    category: 'security',
    allowedChannels: ['email', 'push'],
    required: { email: true, push: true },
    alwaysEnabled: true,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: {
      email: 'security.breach_attempt.kinfolk',
      push: 'security.breach_attempt.kinfolk',
    },
    // Fired by /account/secure-reset; also files a securityIncidents audit doc and
    // lands in the in-app inbox via the dispatcher write to notifications/.
    description:
      "Someone tried to reset a kinfolk's password without asking. A security incident record is filed automatically.",
  },

  // ─────────────────────────────────────────────────────────
  // RATINGS / PET STATE
  // ─────────────────────────────────────────────────────────
  {
    key: 'rating.submitted.bad',
    label: 'Kinfolk left a low rating (1-3 stars)',
    audience: 'business',
    audiences: { business: true },
    category: 'ratings',
    allowedChannels: ['email', 'sms', 'push'],
    required: { email: true },
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'rating.submitted.bad', sms: 'rating.submitted.bad', push: 'rating.submitted.bad' },
    description: 'Kinfolk submitted a low rating (1-3 stars).',
  },
  {
    key: 'rating.submitted.good',
    label: 'Kinfolk left a positive rating (4-5 stars)',
    audience: 'business',
    audiences: { business: true },
    category: 'ratings',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'rating.submitted.good', push: 'rating.submitted.good' },
    description: 'Kinfolk submitted a positive rating (4-5 stars).',
  },
  {
    key: 'pet.marked.inactive',
    label: 'Kinfolk marked a pet as inactive',
    audience: 'business',
    audiences: { business: true },
    category: 'ratings',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: false,
    deliveryMode: 'trigger',
    recipientResolver: 'businessAdmins',
    templates: { email: 'pet.marked.inactive', push: 'pet.marked.inactive' },
    description: 'Kinfolk marked a pet as inactive.',
  },

  // ─────────────────────────────────────────────────────────
  // MARKETING
  // ─────────────────────────────────────────────────────────
  {
    key: 'newsletter.announcement',
    label: 'Newsletters and announcements',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'marketing',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'scheduled',
    recipientResolver: 'specificUid',
    templates: { email: 'newsletter.announcement', push: 'newsletter.announcement' },
    marketingCategory: 'newsletter',
    description: 'Newsletters & announcements.',
  },
  {
    key: 'survey.event',
    label: 'Surveys and community events',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'marketing',
    allowedChannels: ['email', 'push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'scheduled',
    recipientResolver: 'specificUid',
    templates: { email: 'survey.event', push: 'survey.event' },
    marketingCategory: 'survey',
    description: 'Surveys & community events.',
  },
  {
    key: 'marketing.optin',
    label: 'General marketing updates',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'marketing',
    allowedChannels: ['email'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'scheduled',
    recipientResolver: 'specificUid',
    templates: { email: 'marketing.optin' },
    marketingCategory: 'marketing',
    description: 'General marketing opt-in (must include unsubscribe footer).',
  },
];

const ALL_CHANNELS: Channel[] = ['email', 'sms', 'push'];

/**
 * New model (2026-06-25): the Business Settings per-notification matrix is the GATE.
 * Every notification exposes all three channels (Email/SMS/Push); the operator
 * enables/disables/locks each channel, and users (admin + kinfolk) choose, in their
 * own settings, which enabled channels they actually receive. So no catalog entry may
 * pre-restrict its channels: we force allowedChannels to all three, and fill a template
 * id for every channel (default = the key; a per-entry custom id still wins) so any
 * channel the operator enables can resolve a template and deliver.
 */
function normalizeAllChannels(def: NotificationDef): NotificationDef {
  const templates: Partial<Record<Channel, string>> = { ...def.templates };
  for (const ch of ALL_CHANNELS) {
    if (!templates[ch]) templates[ch] = def.key;
  }
  return { ...def, allowedChannels: [...ALL_CHANNELS], templates };
}

export const NOTIFICATION_CATALOG: Readonly<Record<string, NotificationDef>> = Object.freeze(
  Object.fromEntries(CATALOG_LIST.map((def) => [def.key, normalizeAllChannels(def)])),
);

/**
 * Whether [def] renders always-on/required for [stream]'s copy. `alwaysEnabledStreams`
 * scopes the legacy flat `alwaysEnabled` to specific streams (e.g. a booking confirm
 * stays required for the kinfolk while the owner may silence their own copy); absent,
 * `alwaysEnabled` applies to every stream the key serves.
 */
export function alwaysEnabledForStream(
  def: NotificationDef,
  stream: 'kinfolk' | 'business' | 'staff',
): boolean {
  if (!def.alwaysEnabled) return false;
  if (!def.alwaysEnabledStreams) return true;
  return def.alwaysEnabledStreams[stream] === true;
}

/**
 * A retired key that now resolves to a canonical catalog row.
 *
 * Aliases are how a catalog row gets merged into another WITHOUT stranding the
 * preferences and business overrides already stored against the old key. The
 * old key keeps working everywhere a key is accepted (dispatch, template
 * resolution, stored prefs, stored overrides); it just no longer appears in the
 * catalog, so the settings UI shows one switch instead of two.
 *
 * Deleting an alias entry is a data-loss event: every kinfolk and operator who
 * set a preference under that key silently reverts to defaults. Aliases stay.
 */
export interface NotificationKeyAlias {
  /** The catalog row this legacy key now resolves to. */
  canonical: string;
  /**
   * The category the legacy row used to sit in. Preference resolution falls
   * back to it, so a household that muted the whole legacy category row does
   * not silently start receiving the merged notification.
   */
  legacyCategory: Category;
}

/**
 * 2026-07-24: `kincare.report.sent` and `kintale.published` were two switches
 * for one event. A KinTale IS the visit report:
 *   - `kincare.report.sent` was dispatched by the `dispatchVisitNotification`
 *     callable (event `report_sent`) when an Auntie taps Send on a KinTale.
 *   - `kintale.published` is dispatched by the `onKinTaleCreate` trigger on the
 *     same `kin_care_reports` document.
 * Both told the same household the same thing, and both linked to the same
 * KinTale. `kintale.published` is the canonical key; the old one is an alias.
 */
export const NOTIFICATION_KEY_ALIASES: Readonly<Record<string, NotificationKeyAlias>> =
  Object.freeze({
    'kincare.report.sent': { canonical: 'kintale.published', legacyCategory: 'visit' },
  });

/**
 * A key that was withdrawn outright, with nothing taking its place.
 *
 * This is the OTHER way a catalog row ends, and it is not an alias. An alias
 * says "that notification is still sent, under a different name"; a retirement
 * says "that notification is not sent any more, by anyone". There is no
 * canonical key to point at, so putting one of these in
 * NOTIFICATION_KEY_ALIASES would be a lie with teeth: `canonicalNotificationKey`
 * would redirect it, and every preference and business override stored under
 * the retired key would silently start governing some unrelated notification.
 *
 * What an entry here buys is the one thing the alias list also buys, and the
 * only one that still applies: an admin who reaches for the key they remember
 * gets told it was retired on purpose, instead of "unknown key", which reads
 * like a typo they should correct rather than a decision someone made.
 */
export interface RetiredNotificationKey {
  /** ISO date the row came out of the catalog. */
  retiredOn: string;
  /** Why, in the words an admin should hear when they ask for the key. */
  reason: string;
}

/**
 * 2026-08-18: `account.welcome.business` told the office that an invited
 * kinfolk had finished setting up their MyTribe account. It was emitted from
 * `membership/acceptInvite.ts` and `admin/setKinfolkClaim.ts`.
 *
 * The operator deleted its template during the 2026-08-17 admin walk and then
 * ruled on it directly: "that was my doing I did not need that type of
 * notification. I should be able to delete templates without being yelled at."
 *
 * So the row is gone rather than left to throw. Nothing enqueues the key, no
 * seed recreates its template, and it is no longer a live catalog key, which
 * means `deleteTemplate` has nothing left to warn about if a document under
 * that name ever reappears.
 */
export const RETIRED_NOTIFICATION_KEYS: Readonly<Record<string, RetiredNotificationKey>> =
  Object.freeze({
    'account.welcome.business': {
      retiredOn: '2026-08-18',
      reason:
        'The office no longer wants to be told when an invited kinfolk finishes ' +
        'account setup. Retired at the operator’s request; nothing replaces it.',
    },
  });

/** True when [key] was a catalog row that has since been withdrawn outright. */
export function isRetiredNotificationKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETIRED_NOTIFICATION_KEYS, key);
}

/** The canonical key for [key]; returns [key] unchanged when it is not an alias. */
export function canonicalNotificationKey(key: string): string {
  return NOTIFICATION_KEY_ALIASES[key]?.canonical ?? key;
}

/** Every retired key that resolves to [canonicalKey], in declaration order. */
export function legacyKeysFor(canonicalKey: string): string[] {
  return Object.entries(NOTIFICATION_KEY_ALIASES)
    .filter(([, alias]) => alias.canonical === canonicalKey)
    .map(([key]) => key);
}

/** The categories the retired keys for [canonicalKey] used to live under. */
export function legacyCategoriesFor(canonicalKey: string): Category[] {
  return Object.values(NOTIFICATION_KEY_ALIASES)
    .filter((alias) => alias.canonical === canonicalKey)
    .map((alias) => alias.legacyCategory);
}

/**
 * Resolves a key (canonical OR alias) to its catalog row. Throws on anything
 * else, naming the key exactly as the caller passed it, so a typo stays loud.
 */
export function getNotificationDef(key: string): NotificationDef {
  const def = NOTIFICATION_CATALOG[canonicalNotificationKey(key)];
  if (!def) throw new Error(`notificationCatalog: unknown key '${key}'`);
  return def;
}

export function listNotificationKeys(): string[] {
  return Object.keys(NOTIFICATION_CATALOG);
}
