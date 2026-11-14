import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { businessTimeZone } from '../lib/bookingTimeBlocks';
import { canonicalNotificationKey } from './catalog';
import { enrichTemplateData, SERVICE_FALLBACK_WORD } from './enrichTemplateData';
import {
  START_TIME_TO_BE_SET,
  formatBookingDate,
  formatBookingTime,
  requestedDateNoonUtcMs,
} from './visitDates';
import type { AudienceStream, NotificationDetail } from './types';

/**
 * Resolves the entity detail a notification CARD renders, and stamps it on the
 * notification document so no client ever has to go and find it.
 *
 * THE BUG THIS CLOSES (operator ruling R5, 2026-08-03). Verbatim: "I see the A
 * KinCare visit was assigned and the CTAs for the workflow but I do not see the
 * KinCare/Booking details. Who requested, For which kinfolk, what date, what
 * time, wheres the notes." Every one of those values was already being computed.
 * `enrichTemplateData` resolves the household, the pets, the service, the date
 * and the time from the booking and family documents, at channel fan-out time,
 * to substitute `{{tokens}}` into an outbound email. Then the enriched context
 * was handed to the sender and discarded. The card, which reads the notification
 * document and not the channel subdoc, never saw any of it and fell back to the
 * catalog label plus whatever household name the client could re-derive.
 *
 * So this asks the SAME enricher for the SAME fields and writes the answer down.
 *
 * WHY NOT REUSE THE CHANNEL-TIME RESULT. Two reasons. The card must exist for
 * notifications with no channels at all (a broadcast, or a recipient who has
 * turned every channel off, both of which still land in the inbox), and the
 * enricher must keep running at SEND time for the outbound copy: a scheduled
 * reminder enqueued on Monday and sent on Friday should quote Friday's booking
 * in the email. The card, by contrast, describes the event as it was when it
 * happened. Those are genuinely two resolutions of two different moments, so
 * they are two calls, not one cached value threaded through the pipeline.
 *
 * NEVER THROWS. A detail block is an enrichment of a notification, not a
 * precondition for one. If every entity read fails, the caller gets `undefined`
 * and the notification still dispatches with its catalog title and its CTAs
 * intact, exactly as it did before this existed.
 */

/**
 * The tokens a card wants, over and above whatever the key's own templates
 * reference. Passed to `enrichTemplateData` as `extraFields`, so a key whose
 * email happens to already use one of these pays for no extra read.
 *
 * `amount` / `dueDate` / `invoiceNumber` are in the list even though most
 * booking keys will resolve none of them: the enricher only fetches the entity
 * a wanted token actually needs (the invoice loader never fires without an
 * `invoiceId` in the merge bag), so naming the union here costs nothing and
 * means one code path serves invoice cards and booking cards alike.
 */
export const CARD_DETAIL_FIELDS: readonly string[] = [
  'kinfolkName',
  'kinName',
  'serviceType',
  'bookingDate',
  'bookingTime',
  'notes',
  'invoiceNumber',
  'amount',
  'dueDate',
];
/**
 * Detail fields that belong to the STAFF side of the card and are never written
 * onto a copy addressed to a household (issue #380).
 *
 * The booking/session `notes` FIELD is not kinfolk-facing. Any operator with
 * the auntie hat can type into it (`admin/createKinCareSession.ts`,
 * `admin/createMultiDateBookingRequest.ts`, the `isAuntie()` update branch in
 * `firestore.rules`), and `admin/transitionBookingStatus.ts` appends a
 * cancellation reason to it verbatim, so what it holds is internal remarks as
 * often as it is anything a household should read. Once it was copied into
 * `notifications/{id}.detail`, a kinfolk could read it straight off their own
 * inbox document, which `firestore.rules` grants them by `recipientUid`.
 *
 * This does NOT undo operator ruling R5 ("wheres the notes"). R5 was about the
 * ADMIN card, and staff- and business-stream copies still carry the field. What
 * changes is that the household's copy of the same event no longer does.
 *
 * If a kinfolk-facing template ever genuinely needs a message written by staff,
 * that is a separate, explicitly-labelled field on the booking, authored knowing
 * the household will read it. It is not this one.
 */
export const STAFF_ONLY_DETAIL_FIELDS: readonly string[] = ['notes'];
/**
 * #2030: the keys whose `data.note` is the office's own words TO the household,
 * typed into a box labelled for them ("Note for the household", "Anything to
 * add for the household") and sent with the answer to their request. That is
 * the "separate, explicitly-labelled field" the #380 note above asks for, so it
 * rides on the card as `householdNote`, on every copy. It is read from the
 * emitter's merge bag only, never from an entity, so nothing staff-only can
 * reach it by way of the enricher.
 */
export const HOUSEHOLD_NOTE_KEYS: ReadonlySet<string> = new Set([
  'kincare.booking.confirm',
  'kincare.request.declined',
  // #1913: the office's reason, typed when it answers a household's request to
  // remove a Kin or cancel a visit. Each already reaches the household in the
  // text message (`{{note}}`) and on the Kin's own screen.
  'kincare.cancel.declined',
  'kin.removal.declined',
  'kin.removal.archived',
]);
/**
 * The detail fields to resolve for one copy, given the audience stream that copy
 * is addressed to.
 *
 * Dropping a staff-only field from the REQUEST is the cheap half: the enricher
 * skips the entity read it would have needed. The half that actually closes the
 * leak is the projection guard in `buildNotificationDetail`, because the
 * enricher's context starts as a spread of the emitter's own merge bag, so a
 * caller that ever passed `data.notes` would put the value in the context
 * without the enricher fetching anything.
 */
export function cardDetailFieldsFor(stream: AudienceStream): readonly string[] {
  if (stream !== 'kinfolk') return CARD_DETAIL_FIELDS;
  return [...CARD_DETAIL_FIELDS.filter((f) => !STAFF_ONLY_DETAIL_FIELDS.includes(f)), ...HOUSEHOLD_ONLY_DETAIL_FIELDS];
}
/**
 * #1831: tokens only a household's copy asks for, because only its content
 * line uses them. `bookingDates` is a whole request's dates in one phrase
 * ("4 visits, Sep 4 to Sep 7"), for the answer to a request.
 */
export const HOUSEHOLD_ONLY_DETAIL_FIELDS: readonly string[] = ['bookingDates'];

/** A resolved, non-blank string, or undefined. Blank is never a value here. */
function present(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Builds the card detail for one notification copy.
 *
 * Returns `undefined` rather than an empty object when nothing resolved, so the
 * dispatcher can omit the field entirely: an absent `detail` and a `detail` full
 * of blanks read the same to a human but not to a client, and only one of them
 * lets a renderer say "there is nothing to show here" without inspecting every
 * key.
 *
 * @param key           catalog key, decides which entities are reachable
 * @param recipientUid  the copy's recipient, for recipient-scoped fallbacks
 * @param data          the emitter's merge bag (ids, mostly)
 * @param actorName     the already-resolved actor, threaded in rather than
 *                      re-resolved: `enqueueNotification` resolves the actor
 *                      ONCE for the whole dispatch, and re-reading them per
 *                      recipient here would undo that. `null` for a
 *                      system-emitted notification with no human behind it.
 * @param stream        the audience stream THIS COPY is addressed to, which is
 *                      what decides whether staff-only fields are included.
 *                      Deliberately required and deliberately per-copy: an
 *                      `audience: 'both'` key such as `kincare.changed` fans one
 *                      event out to the operator AND to the household, so the
 *                      key's own audience cannot answer this question. The
 *                      dispatcher already derives the stream per recipient for
 *                      channel resolution (`streamForRecipient`); redaction
 *                      rides the same answer so the two can never disagree.
 */
export async function buildNotificationDetail(
  key: string,
  recipientUid: string,
  data: Record<string, unknown>,
  actorName: string | null,
  stream: AudienceStream,
): Promise<NotificationDetail | undefined> {
  const staffSide = stream !== 'kinfolk';
  let ctx: Record<string, unknown>;
  try {
    ctx = await enrichTemplateData(key, recipientUid, data, cardDetailFieldsFor(stream), stream === 'kinfolk');
  } catch (err) {
    // enrichTemplateData documents itself as never-throwing, but it is a large
    // surface over live Firestore reads and this is the one caller that must
    // not take a notification down with it. Log and degrade to the actor alone.
    logEvent({
      severity: 'warn',
      function: 'buildNotificationDetail',
      event: 'detail.enrich.failed',
      extra: { key, err: (err as Error)?.message ?? String(err) },
    });
    ctx = {};
  }

  const detail: NotificationDetail = {};
  const assign = (field: keyof NotificationDetail, value: string | undefined): void => {
    if (value !== undefined) detail[field] = value;
  };

  assign('kinfolkName', present(ctx.kinfolkName));
  assign('kinName', present(ctx.kinName));
  // #1749: the KinCare's name, resolved by the enricher. The fallback word it
  // puts in a template for an unplaceable code is not a service, so no row.
  const service = present(ctx.serviceType);
  assign('serviceType', service === SERVICE_FALLBACK_WORD ? undefined : service);
  assign('bookingDate', present(ctx.bookingDate));
  assign('bookingTime', present(ctx.bookingTime));
  // Staff-only, per issue #380. Guarded on the WRITE and not only on the
  // request, because `ctx` begins life as the emitter's own merge bag.
  if (staffSide) assign('notes', present(ctx.notes));
  // #2030: the office's words to the household, from the emitter alone.
  if (HOUSEHOLD_NOTE_KEYS.has(key)) assign('householdNote', present(data?.['note']));
  assign('invoiceNumber', present(ctx.invoiceNumber));
  assign('amount', present(ctx.amount));
  assign('dueDate', present(ctx.dueDate));
  // "Who requested" in the operator's words. A system-emitted notification has
  // no actor, and then the card shows no requester rather than "System", which
  // would be a claim about a person nobody made.
  assign('requestedBy', present(actorName));
  // #1831: the facts only the household's content line reads.
  if (!staffSide) {
    assign('bookingDates', present(ctx.bookingDates));
    const extra = await householdOnlyFacts(key, data ?? {});
    assign('taleTitle', extra.taleTitle);
    assign('taleKinNames', extra.taleKinNames);
    assign('lockedAt', extra.lockedAt);
  }

  return Object.keys(detail).length > 0 ? detail : undefined;
}

/** The KinTale keys whose line names the tale itself. */
const TALE_KEYS: ReadonlySet<string> = new Set(['kintale.published', 'kintale.note.added']);

/**
 * #1831: facts the enricher has no token for, read only for a household's copy
 * and only for the keys whose line uses them. Never throws: a failed read
 * leaves the fact out, and the line says less.
 *
 * - A KinTale's own title, and the Kin on the visit it is about. The enricher's
 *   `kinName` for a tale is the household's whole roster, which is not who the
 *   tale is about, so the line reads the tale's visit instead.
 * - When an account was locked, on the business clock.
 */
async function householdOnlyFacts(
  key: string,
  data: Record<string, unknown>,
): Promise<{ taleTitle?: string; taleKinNames?: string; lockedAt?: string }> {
  try {
    if (TALE_KEYS.has(key)) {
      const taleId = present(data.taleId) ?? present(data.reportId);
      if (!taleId) return {};
      const tale = (await db().doc(`kin_care_reports/${taleId}`).get()).data() as Record<string, unknown> | undefined;
      const out: { taleTitle?: string; taleKinNames?: string } = { taleTitle: present(tale?.title) };
      const sessionId = present(tale?.sessionId);
      if (sessionId) {
        const session = (await db().doc(`kin_care_sessions/${sessionId}`).get()).data() as
          | Record<string, unknown>
          | undefined;
        const names = Array.isArray(session?.kinNames)
          ? session.kinNames.map((n) => present(n)).filter((n): n is string => n !== undefined)
          : [];
        if (names.length > 0) out.taleKinNames = names.join(', ');
      }
      return out;
    }
    if (key === 'auth.account.locked' && typeof data.lockStartedAtMs === 'number') {
      const settings = (await db().doc('business_settings/business_settings').get()).data();
      const tz = businessTimeZone(settings);
      const ms = data.lockStartedAtMs;
      return { lockedAt: `${formatBookingDate(ms, tz)} at ${formatBookingTime(ms, tz)}` };
    }
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'buildNotificationDetail',
      event: 'detail.household_facts.failed',
      extra: { key, err: (err as Error)?.message ?? String(err) },
    });
  }
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// THE HOUSEHOLD'S CONTENT LINE AND WHERE A TAP GOES (#1831, #1898, #1913)
// ─────────────────────────────────────────────────────────────────────────────
//
// The line under a household notice's title used to be words about the
// notification itself: the operator's description ("Auntie en route to KinCare
// (optional ETA).") and, since #2239, the household's Notification settings
// wording ("When your Auntie arrives for a KinCare visit."). Neither said which
// Kin, which KinCare or when. The line is now built from the notice's own facts,
// the ones `buildNotificationDetail` already writes on the copy and the ids the
// emitter put in `data`. It is built once, when the copy is written, and stored
// as `householdLine`. The notifications list works out the tap target again on
// read but never rebuilds the line: a row stored before this has no
// `householdLine` and shows its title alone, never the words it was stored with.
//
// One table, keyed by catalog key, holds the line and the target for every key
// a household can receive (`HOUSEHOLD_NOTICE_RULES`). A test walks the catalog
// and fails on a household key with no entry.

/** What a tapped household notice opens. */
export type HouseholdNoticeTarget =
  /** The visit (`targetType: 'booking'`, with `visitId` on the row). */
  | 'visit'
  /** A whole booking request (`booking`, with `batchId` and no `visitId`). */
  | 'request'
  /** The KinTale, or the KinTales list when the notice spans several. */
  | 'kintale'
  /** The Kin, or the Kin list when the Kin is gone. */
  | 'kin'
  | 'kinList'
  | 'invoice'
  | 'messages'
  /** The household's own profile (Tribe). */
  | 'household'
  /** Nothing to open: the line says it all. */
  | 'none';

/** The stored row, as far as the line and the target read it. */
export interface HouseholdNoticeRow {
  key: string;
  recipientUid?: string;
  /** The stored description: the line only for a broadcast, whose body it is. */
  description?: string;
  /** `NotificationDetail` on a fresh copy; whatever an older row stored, read loosely. */
  detail?: object;
  data?: Record<string, unknown>;
  targetType?: string;
  targetId?: string;
}

interface Facts {
  key: string;
  recipientUid: string;
  description: string;
  detail: Record<string, unknown>;
  data: Record<string, unknown>;
}

interface HouseholdNoticeRule {
  line: (f: Facts) => string;
  target: HouseholdNoticeTarget;
  /**
   * Never written to the notifications list: the key is sent straight to its
   * channel and no `notifications/{id}` row exists for it.
   */
  neverListed?: true;
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** "Rex", "Rex and Mochi", "Rex, Mochi and Pip" from a comma-joined or listed set of names. */
export function joinKinNames(v: unknown): string {
  const names = (Array.isArray(v) ? v.map(text) : text(v).split(','))
    .map((n) => n.trim())
    .filter((n, i, all) => n !== '' && all.indexOf(n) === i);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A household's name, or '' when what is stored there is an email address: a
 * name that is really an email is not a name to print (#2030).
 */
function nameNotEmail(v: unknown): string {
  const name = text(v);
  return name.includes('@') ? '' : name;
}
function capitalize(s: string): string {
  return s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Tue, Nov 17 at 9:00 AM", "Tue, Nov 17 at Midday (11 AM to 3 PM)", or the date alone. */
function whenOf(date: string, time: string): string {
  if (date === '') return '';
  if (time === '') return date;
  return time === START_TIME_TO_BE_SET ? `${date}, ${time}` : `${date} at ${time}`;
}

/** "Drop-in visit for Rex", or whichever half is known. */
function visitSubject(f: Facts): string {
  const service = text(f.detail.serviceType);
  const kin = joinKinNames(f.detail.kinName);
  if (service && kin) return `${service} for ${kin}`;
  return service || kin;
}

/** One visit: "Drop-in visit for Rex on Tue, Nov 17 at 9:00 AM". */
function visitLine(f: Facts): string {
  const subject = visitSubject(f);
  const when = whenOf(text(f.detail.bookingDate), text(f.detail.bookingTime));
  if (subject && when) return `${subject} on ${when}`;
  return subject || (when ? `On ${when}` : '');
}

/** The confirmation: one visit as above, several as a count and the first. */
function confirmLine(f: Facts): string {
  const count = typeof f.data.visitCount === 'number' ? f.data.visitCount : 0;
  const next = (f.data.nextVisit ?? null) as Record<string, unknown> | null;
  if (count > 1 && next) {
    const day = [text(next.weekday), text(next.date)].filter((s) => s !== '').join(', ');
    const when = whenOf(day, text(next.time));
    const subject = visitSubject(f);
    const tail = when ? `${count} visits starting ${when}` : `${count} visits`;
    return subject ? `${subject}, ${tail}` : capitalize(tail);
  }
  return visitLine(f);
}

/** The answer to a request: its dates in one phrase ("4 visits, Sep 4 to Sep 7"). */
function requestLine(f: Facts): string {
  const subject = visitSubject(f);
  const dates = text(f.detail.bookingDates);
  if (!dates) return visitLine(f);
  const joiner = /^\d/.test(dates) ? ', ' : ' on ';
  return subject ? `${subject}${joiner}${dates}` : capitalize(dates);
}

function onMyWayLine(f: Facts): string {
  const base = visitLine(f);
  const eta = typeof f.data.etaMinutes === 'number' && f.data.etaMinutes > 0 ? Math.round(f.data.etaMinutes) : 0;
  if (eta === 0) return base;
  const away = `about ${eta} ${eta === 1 ? 'minute' : 'minutes'} away`;
  return base ? `${base}, ${away}` : capitalize(away);
}

/** "“A sunny walk” about Rex", or whichever half is known. */
function taleLine(f: Facts): string {
  const title = text(f.detail.taleTitle);
  const kin = joinKinNames(f.detail.taleKinNames);
  if (title && kin) return `“${title}” about ${kin}`;
  if (title) return `“${title}”`;
  return kin ? `About ${kin}` : '';
}

/**
 * #1898: who commented and on which KinTale. A digest carries one item per
 * comment (`data.items`); a single comment carries its own fields on `data`.
 */
function commentLine(f: Facts): string {
  const items = Array.isArray(f.data.items)
    ? (f.data.items as unknown[]).filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    : [f.data];
  if (items.length === 0) return '';
  const who = joinKinNames(
    items.map((i) => (f.recipientUid !== '' && text(i.authorUid) === f.recipientUid ? 'You' : text(i.authorName))),
  );
  const taleIds = [...new Set(items.map((i) => text(i.taleId)).filter((id) => id !== ''))];
  const titles = [...new Set(items.map((i) => text(i.taleTitle)).filter((t) => t !== ''))];
  let onWhat = 'your KinTale';
  if (taleIds.length > 1) onWhat = `${taleIds.length} KinTales`;
  else if (titles.length === 1) onWhat = `“${titles[0]}”`;
  if (who) return `${who} commented on ${onWhat}`;
  return `${items.length} new ${items.length === 1 ? 'comment' : 'comments'} on ${onWhat}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** An invoice's stored `YYYY-MM-DD` day as "Nov 20, 2026"; any other spelling as written. */
function invoiceDay(v: unknown): string {
  const raw = text(v);
  const ms = requestedDateNoonUtcMs(raw);
  if (ms == null) return raw;
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * "Invoice 1042 for $120.00, due Nov 20, 2026". A zero amount is left out: on a
 * paid invoice the enricher reads the balance, and "$0.00" is not what it was for.
 */
function invoiceLine(f: Facts, opts: { due?: 'due' | 'was due' } = {}): string {
  const quote = f.key.startsWith('quote.') || f.data.isQuote === true;
  const number = text(f.detail.invoiceNumber).replace(/^#/, '');
  const amount = text(f.detail.amount);
  const ref = number ? `${quote ? 'Quote' : 'Invoice'} ${number}` : '';
  let line = ref;
  if (amount && !/^\$?0(\.00)?$/.test(amount)) line = ref ? `${ref} for ${amount}` : amount;
  const due = opts.due && !quote ? invoiceDay(f.detail.dueDate) : '';
  if (due) line = line ? `${line}, ${opts.due} ${due}` : capitalize(`${opts.due} ${due}`);
  return line;
}

/** "Invoice 1042", and nothing about money. */
function invoiceNumberLine(f: Facts): string {
  const number = text(f.detail.invoiceNumber).replace(/^#/, '');
  return number ? `Invoice ${number}` : '';
}
/** The first words of a message, on one line. */
function previewLine(v: unknown, max = 140): string {
  const flat = text(v).replace(/\s+/g, ' ');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function kinOf(f: Facts): string {
  return joinKinNames(text(f.data.kinName) || f.detail.kinName);
}

/**
 * Every key a household can receive. Kept beside the detail it reads so a fact
 * added there is one screen away from the line that uses it.
 */
export const HOUSEHOLD_NOTICE_RULES: Readonly<Record<string, HouseholdNoticeRule>> = {
  'kincare.booking.confirm': { line: confirmLine, target: 'request' },
  'kincare.booking.cancel': { line: visitLine, target: 'visit' },
  'kincare.auntie.on_my_way': { line: onMyWayLine, target: 'visit' },
  'kincare.auntie.arrived': { line: visitLine, target: 'visit' },
  'kincare.auntie.departed': { line: visitLine, target: 'visit' },
  'kincare.unavailable': { line: visitLine, target: 'visit' },
  'kincare.changed': { line: visitLine, target: 'visit' },
  'kincare.cancel.declined': { line: visitLine, target: 'visit' },
  'kincare.request.declined': { line: requestLine, target: 'request' },
  'kincare.upcoming.reminder': { line: visitLine, target: 'visit' },
  'kintale.published': { line: taleLine, target: 'kintale' },
  'kintale.comment.added': { line: commentLine, target: 'kintale' },
  'kintale.note.added': { line: taleLine, target: 'kintale' },
  'invoice.new': { line: (f) => invoiceLine(f, { due: 'due' }), target: 'invoice' },
  // The number only, as for a payment below: with no amount from the emitter
  // the enricher reads the invoice's BALANCE, and on a part-paid invoice "for
  // $40.00" would claim the invoice (or the receipt) was for its balance.
  'invoice.updated': { line: invoiceNumberLine, target: 'invoice' },
  'invoice.receipt': { line: invoiceNumberLine, target: 'invoice' },
  'invoice.reminder': { line: (f) => invoiceLine(f, { due: 'due' }), target: 'invoice' },
  'invoice.overdue': { line: (f) => invoiceLine(f, { due: 'was due' }), target: 'invoice' },
  'invoice.charge.failed': { line: (f) => invoiceLine(f), target: 'invoice' },
  // The number only: the stored amount is the payment's or the balance's
  // depending on the emitter, and "for $X" would claim it was the invoice's.
  'invoice.payment.applied': { line: invoiceNumberLine, target: 'invoice' },
  'quote.accepted': { line: (f) => invoiceLine(f), target: 'invoice' },
  'message.reply': { line: (f) => previewLine(f.data.preview), target: 'messages' },
  // The broadcast writes its own row: the subject is its title and the body,
  // as the office wrote it, is its line.
  'broadcast.message': { line: (f) => f.description, target: 'none' },
  'pets.updated': {
    line: (f) => {
      const kin = kinOf(f);
      return kin ? `Changes to ${kin}'s profile` : '';
    },
    target: 'kin',
  },
  'profile.updated': {
    line: (f) => {
      const household = nameNotEmail(f.detail.kinfolkName);
      return household ? `Household profile for ${household}` : '';
    },
    target: 'household',
  },
  'account.welcome.kinfolk': {
    line: (f) => {
      const household = nameNotEmail(f.detail.kinfolkName);
      return household ? `Your MyTribe account for ${household} is ready` : '';
    },
    target: 'household',
  },
  'auth.password.reset': { line: () => '', target: 'none', neverListed: true },
  'auth.failedLogin.attempts': {
    line: (f) => {
      const n = typeof f.data.attemptsInWindow === 'number' ? f.data.attemptsInWindow : 0;
      return n > 0 ? `${n} failed sign-in ${n === 1 ? 'attempt' : 'attempts'} on your account` : '';
    },
    target: 'none',
  },
  'auth.account.locked': {
    line: (f) => {
      const at = text(f.detail.lockedAt);
      return at ? `Locked on ${at}` : '';
    },
    target: 'none',
  },
  'kin.removal.archived': {
    line: (f) => {
      const kin = kinOf(f);
      return kin ? `${kin} is no longer on your profile` : '';
    },
    target: 'kinList',
  },
  'kin.removal.declined': {
    line: (f) => {
      const kin = kinOf(f);
      return kin ? `${kin} is staying on your profile` : '';
    },
    target: 'kin',
  },
  // A blast's own headline, when the office wrote one.
  'newsletter.announcement': { line: (f) => previewLine(f.data.headline), target: 'none' },
  'survey.event': { line: (f) => previewLine(f.data.headline), target: 'none' },
  'marketing.optin': { line: (f) => previewLine(f.data.headline), target: 'none' },
};

/**
 * The rule for a stored key. A row kept under a retired alias
 * (`kincare.report.sent`) reads its canonical key's rule.
 */
export function householdNoticeRuleFor(key: string): HouseholdNoticeRule | undefined {
  return HOUSEHOLD_NOTICE_RULES[canonicalNotificationKey(key)];
}
function factsOf(row: HouseholdNoticeRow): Facts {
  const obj = (v: unknown): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    key: canonicalNotificationKey(row.key),
    recipientUid: text(row.recipientUid),
    description: text(row.description),
    detail: obj(row.detail),
    data: obj(row.data),
  };
}

/**
 * The line under a household notice's title, from the row's own facts, or ''
 * when it has none (the row then shows its title alone). Never the settings
 * wording, never a template's description, never an id or an email: every
 * fragment is a name, a date, a time, an amount or words someone wrote for
 * the household.
 */
export function householdNoticeLine(row: HouseholdNoticeRow): string {
  const rule = householdNoticeRuleFor(row.key);
  if (!rule) return '';
  return rule.line(factsOf(row)).trim();
}

/**
 * The `{ targetType, targetId }` a household client opens for this row, from
 * the key's rule and the ids the row carries. Rows written before a key had a
 * target (the comment digest, a Kin notice) open the right thing too.
 *
 * Two values are new to the clients: `kin` (the Kin, or the Kin list when
 * `targetId` is '') and `household` (the Tribe page). `kintale` with an empty
 * id opens the KinTales list.
 */
export function householdNoticeTarget(row: HouseholdNoticeRow): { targetType: string; targetId: string } {
  const rule = householdNoticeRuleFor(row.key);
  const storedType = text(row.targetType);
  const storedId = text(row.targetId);
  if (!rule) return { targetType: storedType, targetId: storedId };
  const data = factsOf(row).data;
  switch (rule.target) {
    case 'visit':
    case 'request':
      return { targetType: 'booking', targetId: storedType === 'booking' ? storedId : '' };
    case 'invoice': {
      const id = storedType === 'invoice' && storedId !== '' ? storedId : text(data.invoiceId);
      return id ? { targetType: 'invoice', targetId: id } : { targetType: '', targetId: '' };
    }
    case 'kintale': {
      if (storedType === 'kintale' && storedId !== '') return { targetType: 'kintale', targetId: storedId };
      const items = Array.isArray(data.items) ? (data.items as Array<Record<string, unknown>>) : [data];
      const ids = [...new Set(items.map((i) => text(i?.taleId) || text(i?.reportId)).filter((id) => id !== ''))];
      return { targetType: 'kintale', targetId: ids.length === 1 ? ids[0]! : '' };
    }
    case 'kin':
      return { targetType: 'kin', targetId: text(data.kinId) };
    case 'kinList':
      return { targetType: 'kin', targetId: '' };
    case 'messages':
      return { targetType: 'conversation', targetId: storedId };
    case 'household':
      return { targetType: 'household', targetId: '' };
    case 'none':
      return { targetType: '', targetId: '' };
  }
}
