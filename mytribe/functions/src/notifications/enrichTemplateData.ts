import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { isInactiveKinStatus } from '../lib/kinStatus';
import { getNotificationDef } from './catalog';
import type { Audience } from './types';

/**
 * Central template-data enrichment.
 *
 * THE PROBLEM: notification templates (emailTemplates/smsTemplates/pushTemplates)
 * reference merge fields like {{kinfolkName}}, {{invoiceNumber}}, {{amount}},
 * {{kinName}}, {{bookingDate}}, but most emitters call enqueueNotification with
 * only IDs (kinfolkId/invoiceId/bookingId). Handlebars then renders those fields
 * blank, so customers got "Hi , your invoice  for  is due".
 *
 * THE FIX: this runs once at fan-out time (onNotificationChannelCreate, the single
 * choke point every delivery mode passes through) and hydrates the standard
 * entities by id, merging their fields into the substitution context under the
 * exact token spellings the templates use.
 *
 * Invariants:
 *   - Emitter-provided values ALWAYS win (we only fill missing/blank tokens).
 *   - Fetch lazily: only the entities a key's template actually needs, once each.
 *   - Never throws: a missing/erroring entity is logged and the field is left
 *     blank so the message still reads sensibly (the senders also scrub any
 *     residual {{token}} so a raw token can never reach a customer).
 */

/**
 * Display timezone for booking date/time formatting. Sourced from the operator's
 * `business_settings/business_settings.timeZone` at runtime; this is the fallback
 * when that doc/field is absent. America/New_York is both the value the operator
 * currently has configured and the zone the schedulers already run in.
 */
const DEFAULT_TIME_ZONE = 'America/New_York';

/**
 * The exact `{{token}}` set each catalog key's templates reference, mirrored from
 * seeds/notificationTemplates/<key>/{email.html,email.txt,sms.txt,push.txt}. A
 * unit test (enrichTemplateData.test.ts) cross-checks this map against the
 * on-disk seeds so the two can never drift. Only the subset the enricher knows
 * how to hydrate (see ENRICHABLE) is fetched; the rest are emitter-supplied
 * (link, score, count, incidentId, ip, ...).
 */
export const TEMPLATE_FIELDS: Record<string, readonly string[]> = {
  'assignment.assigned': ['bookingDate', 'bookingTime', 'kinName', 'serviceType'],
  'assignment.changed': ['bookingDate', 'kinName', 'serviceType'],
  'account.welcome.kinfolk': ['kinfolkName'],
  'auth.account.locked': ['email'],
  'auth.failedLogin.attempts': ['attemptsInWindow', 'email'],
  'auth.password.reset': ['displayName', 'link'],
  'invite.expired': ['invitedEmail'],
  'invoice.charge.failed': ['invoiceNumber', 'kinfolkName'],
  'invoice.new': ['amount', 'dueDate', 'invoiceNumber', 'kinfolkName', 'kinName'],
  'invoice.overdue': ['bookingDate', 'kinfolkName', 'kinName'],
  'invoice.payment.applied': ['invoiceNumber'],
  // `disputeAmount` / `disputeReason` / `disputeStatus` are emitter-supplied by
  // `billing/stripeDispute.ts`, like `link` / `score` / `incidentId`: they come
  // off the Stripe Dispute object and there is no local entity to hydrate them
  // from. `invoiceNumber` is the one the enricher fills, and it renders blank
  // on an unattributed dispute — which is the honest output, not a defect.
  'invoice.payment.disputed': ['disputeAmount', 'disputeReason', 'disputeStatus', 'invoiceNumber'],
  'invoice.receipt': ['amount', 'invoiceNumber', 'kinfolkName'],
  'invoice.reminder': ['amount', 'invoiceNumber', 'kinName'],
  'invoice.updated': ['invoiceNumber', 'kinName'],
  'kincare.auntie.arrived': ['serviceType'],
  'kincare.auntie.departed': ['serviceType'],
  'kincare.auntie.on_my_way': ['serviceType'],
  'kincare.booking.cancel': ['bookingDate', 'kinfolkName', 'kinName', 'serviceType'],
  'kincare.booking.confirm': ['bookingDate', 'bookingTime', 'kinfolkName', 'kinName', 'serviceType'],
  'kincare.cancel.requested': ['bookingDate', 'kinfolkName', 'kinName', 'serviceType'],
  'kincare.changed': ['bookingDate', 'kinfolkName', 'kinName', 'serviceType'],
  'kincare.note.auntie': ['kinName'],
  'kincare.note.kinfolk': ['kinName'],
  'kincare.report.sent': ['kinfolkName', 'kinName'],
  'kincare.requested': ['bookingDate', 'kinfolkName', 'kinName', 'serviceType'],
  'kincare.reschedule.requested': ['bookingDate', 'bookingTime', 'kinfolkName', 'kinName', 'serviceType'],
  'kincare.unavailable': ['bookingDate', 'kinfolkName', 'serviceType'],
  'kincare.upcoming.reminder': ['bookingDate', 'bookingTime', 'kinfolkName', 'kinName', 'serviceType'],
  'kintale.comment.added': ['kinName'],
  'kintale.note.added': ['kinName'],
  'kintale.published': ['kinfolkName', 'kinName'],
  'marketing.optin': [],
  'message.received': ['kinfolkName', 'preview'],
  'newsletter.announcement': [],
  'pet.marked.inactive': ['kinName'],
  'pets.updated': ['kinName'],
  'profile.updated': [],
  'quote.accepted': ['kinName'],
  'quote.denied': [],
  'rating.submitted.bad': ['score'],
  'rating.submitted.good': ['score'],
  'schedule.upcoming.digest': ['count'],
  'security.breach_attempt.kinfolk': ['incidentId', 'ip', 'kinfolkEmail', 'timestampIso', 'userAgent'],
  'survey.event': [],
};

/**
 * Tokens the enricher can hydrate from standard entities by id.
 *
 * A SUPERSET of the tokens any template references, and deliberately so since
 * R5: `buildNotificationDetail` asks this same enricher for the fields a CARD
 * needs, passing them as `extraFields`. `notes` is the first such token, no
 * email or SMS body references it, but "wheres the notes" was one of the four
 * things the operator could not see on a notification. Adding a card-only token
 * here does not affect the TEMPLATE_FIELDS/seed drift guard, which cross-checks
 * TEMPLATE_FIELDS against the on-disk seeds and never reads this set.
 *
 * That `notes` is enrichable does NOT make it publishable. It is asked for only
 * by staff- and business-stream card details now; see STAFF_ONLY_DETAIL_FIELDS
 * in `buildNotificationDetail.ts` and issue #380.
 */
const ENRICHABLE: ReadonlySet<string> = new Set([
  'kinfolkName',
  'kinName',
  'serviceType',
  'bookingDate',
  'bookingTime',
  'invoiceNumber',
  'amount',
  'dueDate',
  'email',
  'kinfolkEmail',
  'displayName',
  'notes',
]);

type Doc = Record<string, unknown> | null;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function hasValue(v: unknown): boolean {
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'number') return Number.isFinite(v);
  return false;
}
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const p = parseFloat(v);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}
function usd(n: number): string {
  return `$${Math.abs(n).toFixed(2)}`;
}
function joinNames(v: unknown): string {
  if (!Array.isArray(v)) return '';
  return v.map((x) => str(x)).filter((s) => s.length > 0).join(', ');
}

/**
 * Hydrates the template context for one notification. Returns a NEW object: the
 * emitter's data plus any standard entity fields it was missing. Never mutates
 * the input, never throws.
 */
export async function enrichTemplateData(
  key: string,
  recipientUid: string,
  data: Record<string, unknown>,
  /**
   * Tokens to hydrate IN ADDITION to the ones this key's templates reference.
   *
   * The card detail (`buildNotificationDetail`) wants a consistent set of
   * entity fields regardless of which merge fields a given key's email happens
   * to use: an assignment notification's template needs `bookingDate` but not
   * `kinfolkName`, and the card needs both. Rather than widening TEMPLATE_FIELDS
   * (which is seed-mirrored and must keep describing the templates exactly),
   * the caller names what it additionally wants. Unknown or non-ENRICHABLE
   * names are ignored, same as they are in TEMPLATE_FIELDS.
   */
  extraFields: readonly string[] = [],
): Promise<Record<string, unknown>> {
  const ctx: Record<string, unknown> = { ...data };
  const fields = [...(TEMPLATE_FIELDS[key] ?? []), ...extraFields];
  const want = new Set(fields.filter((f) => ENRICHABLE.has(f) && !hasValue(ctx[f])));
  if (want.size === 0) return ctx;

  let audience: Audience = 'kinfolk';
  try {
    audience = getNotificationDef(key).audience;
  } catch {
    // Unknown key (should not happen; dispatcher validates). Default to kinfolk
    // so the recipient-as-client fallback stays available.
  }

  const firestore = db();
  const familyId = str(data.kinfolkId) || str(data.familyId);
  const invoiceId = str(data.invoiceId);

  function logMiss(entity: string, id: string): void {
    logEvent({
      severity: 'info',
      function: 'enrichTemplateData',
      event: 'enrich.entity.not_found',
      extra: { key, entity, id },
    });
  }
  function logErr(entity: string, id: string, err: unknown): void {
    logEvent({
      severity: 'warn',
      function: 'enrichTemplateData',
      event: 'enrich.entity.load_failed',
      extra: { key, entity, id, err: (err as Error)?.message ?? String(err) },
    });
  }

  // ── lazy, memoized loaders ────────────────────────────────────────────────
  let invoiceLoaded = false;
  let invoice: Doc = null;
  async function loadInvoice(): Promise<Doc> {
    if (invoiceLoaded) return invoice;
    invoiceLoaded = true;
    if (!invoiceId) return (invoice = null);
    try {
      const flat = await firestore.doc(`invoices/${invoiceId}`).get();
      if (flat.exists) return (invoice = (flat.data() as Doc) ?? null);
      if (familyId) {
        const sub = await firestore.doc(`families/${familyId}/invoices/${invoiceId}`).get();
        if (sub.exists) return (invoice = (sub.data() as Doc) ?? null);
      }
      logMiss('invoice', invoiceId);
    } catch (err) {
      logErr('invoice', invoiceId, err);
    }
    return (invoice = null);
  }

  let familyLoaded = false;
  let family: Doc = null;
  async function loadFamily(): Promise<Doc> {
    if (familyLoaded) return family;
    familyLoaded = true;
    if (!familyId) return (family = null);
    try {
      const snap = await firestore.doc(`families/${familyId}`).get();
      if (snap.exists) return (family = (snap.data() as Doc) ?? null);
      logMiss('family', familyId);
    } catch (err) {
      logErr('family', familyId, err);
    }
    return (family = null);
  }

  const clientCache = new Map<string, Doc>();
  async function loadClient(uid: string): Promise<Doc> {
    if (!uid) return null;
    if (clientCache.has(uid)) return clientCache.get(uid) ?? null;
    let out: Doc = null;
    try {
      const snap = await firestore.doc(`clients/${uid}`).get();
      if (snap.exists) out = (snap.data() as Doc) ?? null;
    } catch (err) {
      logErr('client', uid, err);
    }
    clientCache.set(uid, out);
    return out;
  }

  const staffCache = new Map<string, Doc>();
  async function loadStaff(uid: string): Promise<Doc> {
    if (!uid) return null;
    if (staffCache.has(uid)) return staffCache.get(uid) ?? null;
    let out: Doc = null;
    try {
      const snap = await firestore.doc(`staff/${uid}`).get();
      if (snap.exists) out = (snap.data() as Doc) ?? null;
    } catch (err) {
      logErr('staff', uid, err);
    }
    staffCache.set(uid, out);
    return out;
  }

  let bookingLoaded = false;
  let booking: Doc = null;
  async function loadBooking(): Promise<Doc> {
    if (bookingLoaded) return booking;
    bookingLoaded = true;
    if (!familyId) return (booking = null);
    const batchId = str(data.batchId);
    const visitId = str(data.visitId) || str(data.bookingId);
    const bookingId = str(data.bookingId);
    try {
      if (batchId && visitId) {
        const snap = await firestore
          .doc(`families/${familyId}/bookings/${batchId}/kinCares/${visitId}`)
          .get();
        if (snap.exists) return (booking = (snap.data() as Doc) ?? null);
      }
      if (bookingId) {
        const snap = await firestore.doc(`families/${familyId}/bookings/${bookingId}`).get();
        if (snap.exists) return (booking = (snap.data() as Doc) ?? null);
      }
    } catch (err) {
      logErr('booking', visitId || bookingId, err);
    }
    return (booking = null);
  }

  /**
   * The booking ENVELOPE (`families/{fid}/bookings/{batchId}`), as distinct from
   * the visit session `loadBooking` prefers.
   *
   * `notes` is an envelope-level field: `writeEnvelope` stamps the requester's
   * free text once for the whole request, not once per visit. So a notification
   * carrying `{ batchId, visitId }` resolves its session through `loadBooking`
   * and finds no notes there; they are one level up. Loaded lazily and only when
   * the `notes` token is actually wanted, so no key pays for this read unless it
   * is building a card detail.
   */
  let envelopeLoaded = false;
  let envelope: Doc = null;
  async function loadBookingEnvelope(): Promise<Doc> {
    if (envelopeLoaded) return envelope;
    envelopeLoaded = true;
    const batchId = str(data.batchId) || str(data.bookingId);
    if (!familyId || !batchId) return (envelope = null);
    try {
      const snap = await firestore.doc(`families/${familyId}/bookings/${batchId}`).get();
      if (snap.exists) return (envelope = (snap.data() as Doc) ?? null);
    } catch (err) {
      logErr('bookingEnvelope', batchId, err);
    }
    return (envelope = null);
  }

  async function loadKinName(): Promise<string> {
    if (str(data.kinId) && familyId) {
      try {
        const snap = await firestore.doc(`families/${familyId}/kin/${str(data.kinId)}`).get();
        if (snap.exists) {
          const name = str((snap.data() as Doc)?.name);
          if (name) return name;
        }
      } catch (err) {
        logErr('kin', str(data.kinId), err);
      }
    }
    const b = await loadBooking();
    const fromBooking = joinNames(b?.kinNames);
    if (fromBooking) return fromBooking;
    return loadFamilyPetsName();
  }

  async function loadFamilyPetsName(): Promise<string> {
    if (!familyId) return '';
    try {
      const snap = await firestore.collection('kin').where('kinfolkId', '==', familyId).get();
      const all = snap.docs.map((d) => d.data() as Record<string, unknown>);
      // Statuses that mean "not in active care", memorial included; see
      // `lib/kinStatus.ts` for the one shared definition. A pet with NO status
      // counts as active, so it still contributes its name here.
      const active = all.filter((d) => !isInactiveKinStatus(d.status));
      const names = (active.length > 0 ? active : all)
        .map((d) => str(d.name))
        .filter((s) => s.length > 0);
      return names.join(', ');
    } catch (err) {
      logErr('familyPets', familyId, err);
      return '';
    }
  }

  let tzLoaded = false;
  let timeZone = DEFAULT_TIME_ZONE;
  async function loadTimeZone(): Promise<string> {
    if (tzLoaded) return timeZone;
    tzLoaded = true;
    try {
      const snap = await firestore.doc('business_settings/business_settings').get();
      const v = str((snap.data() as Doc)?.timeZone);
      if (v) timeZone = v;
    } catch {
      // keep default
    }
    return timeZone;
  }

  function fill(token: string, value: string): void {
    if (!want.has(token)) return;
    if (hasValue(ctx[token])) return;
    if (value && value.trim().length > 0) ctx[token] = value;
  }

  function bookingStartMs(b: Doc): number | null {
    if (!b) return null;
    const st = b.startTime as { toMillis?: () => number } | null | undefined;
    if (st && typeof st.toMillis === 'function') {
      try {
        return st.toMillis();
      } catch {
        // fall through
      }
    }
    return num(b.scheduledAtMs) ?? num(b.startTimeMs);
  }
  function formatDate(ms: number, tz: string): string {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: tz,
    }).format(new Date(ms));
  }
  // Invoice-style date ("Jun 15, 2026") — matches the pre-formatted `date`
  // strings AuntieOS writes on invoice docs, unlike the weekday-led booking
  // format above ("Mon, Jun 15").
  function formatInvoiceDate(ms: number, tz: string): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: tz,
    }).format(new Date(ms));
  }
  function formatTime(ms: number, tz: string): string {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    }).format(new Date(ms));
  }

  // ── resolution (only the wanted tokens; loaders fire lazily) ──────────────
  if (want.has('serviceType')) {
    let v = str(data.serviceType) || str(data.serviceName);
    if (!v) {
      const b = await loadBooking();
      v = str(b?.serviceType) || str(b?.serviceName) || str(b?.title);
    }
    fill('serviceType', v);
  }

  if (want.has('bookingDate') || want.has('bookingTime')) {
    let ms = num(data.startTimeMs) ?? num(data.scheduledAtMs);
    if (ms == null) ms = bookingStartMs(await loadBooking());
    if (ms != null) {
      const tz = await loadTimeZone();
      if (want.has('bookingDate')) fill('bookingDate', formatDate(ms, tz));
      if (want.has('bookingTime')) fill('bookingTime', formatTime(ms, tz));
    }
    // Invoice-origin keys (invoice.overdue) carry no timestamp; the service date
    // lives on the invoice doc as a pre-formatted string. Legacy invoice docs
    // (pre-`date` field) fall through every string, so the final fallback formats
    // the doc's createdAt Timestamp: the issue date reads sensibly in "for your
    // visit on {{bookingDate}}" copy and beats a blank.
    if (want.has('bookingDate') && !hasValue(ctx.bookingDate)) {
      const inv = await loadInvoice();
      const fromStrings =
        str(inv?.date) || str(inv?.dueDate) || str(inv?.invoiceDueDate) || str(data.invoiceDueDate);
      if (fromStrings) {
        fill('bookingDate', fromStrings);
      } else {
        const created = inv?.createdAt as { toMillis?: () => number } | null | undefined;
        if (created && typeof created.toMillis === 'function') {
          try {
            fill('bookingDate', formatInvoiceDate(created.toMillis(), await loadTimeZone()));
          } catch {
            // Malformed timestamp: leave blank, senders scrub the residual token.
          }
        }
      }
    }
  }

  if (want.has('invoiceNumber')) {
    const inv = await loadInvoice();
    fill('invoiceNumber', str(inv?.invoiceNumber));
  }
  if (want.has('amount')) {
    let amt = '';
    const minor = num(data.amountMinor);
    if (minor != null) amt = usd(minor / 100);
    if (!amt) {
      const inv = await loadInvoice();
      const dollars =
        num(inv?.amountDue) ??
        num(inv?.total) ??
        (num(inv?.amountMinor) != null ? num(inv?.amountMinor)! / 100 : null);
      if (dollars != null) amt = usd(dollars);
    }
    fill('amount', amt);
  }
  if (want.has('dueDate')) {
    const inv = await loadInvoice();
    fill('dueDate', str(inv?.dueDate) || str(inv?.invoiceDueDate) || str(data.invoiceDueDate));
  }

  if (want.has('kinfolkName')) {
    let v = str(data.recipientDisplayName);
    if (!v) v = str((await loadInvoice())?.kinfolkName);
    if (!v) {
      const fam = await loadFamily();
      v = str(fam?.displayName) || str(fam?.name);
    }
    if (!v) {
      const puid = str((await loadFamily())?.primaryUid);
      if (puid) {
        const c = await loadClient(puid);
        v = str(c?.displayName) || str(c?.name);
      }
    }
    // Recipient-as-client fallback ONLY when the recipient IS the kinfolk
    // (kinfolk-audience keys). For business/both keys the recipient may be a
    // staff admin, whose name must never stand in for the kinfolk's.
    if (!v && audience === 'kinfolk' && recipientUid) {
      const c = await loadClient(recipientUid);
      v = str(c?.displayName) || str(c?.name);
    }
    fill('kinfolkName', v);
  }

  if (want.has('displayName') && recipientUid) {
    const c = await loadClient(recipientUid);
    let v = str(c?.displayName) || str(c?.name);
    if (!v) {
      const s = await loadStaff(recipientUid);
      v = str(s?.displayName) || str(s?.name);
    }
    fill('displayName', v);
  }

  if (want.has('email') && recipientUid) {
    const c = await loadClient(recipientUid);
    let v = str(c?.email);
    if (!v) v = str((await loadStaff(recipientUid))?.email);
    fill('email', v);
  }

  if (want.has('kinfolkEmail')) {
    let v = str((await loadFamily())?.email);
    if (!v) {
      const puid = str((await loadFamily())?.primaryUid);
      if (puid) v = str((await loadClient(puid))?.email);
    }
    if (!v && audience === 'kinfolk' && recipientUid) {
      v = str((await loadClient(recipientUid))?.email);
    }
    fill('kinfolkEmail', v);
  }

  if (want.has('kinName')) {
    let v = str(data.kinName) || joinNames(data.kinNames);
    if (!v) v = await loadKinName();
    fill('kinName', v);
  }

  // Card-only token (see ENRICHABLE). Session first, then the envelope that
  // actually owns the field, so a `{batchId, visitId}` dispatch still finds it.
  //
  // Every source below is admin-writable, which is why `buildNotificationDetail`
  // stops asking for this token on a kinfolk-stream copy and refuses to write it
  // even when the emitter supplied it (#380). Nothing here decides that: this
  // resolves the value, the caller decides who may see it.
  if (want.has('notes')) {
    let v = str(data.notes);
    if (!v) v = str((await loadBooking())?.notes);
    if (!v) v = str((await loadBookingEnvelope())?.notes);
    fill('notes', v);
  }

  return ctx;
}
