/**
 * ACTIVITY LOG DESCRIPTIONS, IN WORDS (#1752, after #1747).
 *
 * The Activity Log shows an entry's `description` as written. Writers used to
 * put a session id, a household id, a notification's catalog key or an
 * invoice id into that sentence ("COMPLETE on session <id>: SCHEDULED ->
 * COMPLETED", "Account credit of 2500 cents given to household <id>",
 * "Notification kincare.booking.confirm delivered via email"). The ids belong
 * on the entry as its target, household and payload, which is where the
 * evidence log keeps them; the sentence says what happened.
 *
 * Every sentence a writer builds comes from here, so the words are one set.
 * The admin clients read rows stored before this change as the same words at
 * display time (`auntieos-admin/src/lib/activityWords.ts`, Android and desktop
 * `ActivityWords.kt`); stored rows are evidence and are never rewritten.
 */

import { invoiceLeadName, invoiceName } from './invoiceNaming';

/** `account.welcome.kinfolk` as "Account welcome kinfolk": the last resort for a key with no label. */
export function humanizeKey(raw: string): string {
  const words = raw
    .trim()
    .split(/[._\-\s]+/)
    .filter((w) => w !== '')
    .join(' ')
    .toLowerCase();
  return words === '' ? '' : words.charAt(0).toUpperCase() + words.slice(1);
}

/** How a channel reads in a sentence. */
const CHANNEL_WORDS: Record<string, string> = {
  email: 'email',
  sms: 'text message',
  push: 'push notification',
};

export function channelWords(channel: string): string {
  const c = channel.trim();
  return CHANNEL_WORDS[c.toLowerCase()] ?? humanizeKey(c).toLowerCase();
}

/** A notification's name in quotes, or "a notification" when there is none. */
function quotedName(name: string): string {
  const n = name.trim();
  return n === '' ? 'a notification' : `"${n}"`;
}

/** ` to Dre East`, or nothing when the writer could not say who. */
function toWhom(to: string): string {
  const t = to.trim();
  return t === '' ? '' : ` to ${t}`;
}
/** `email and text message`, or '' for none. */
function channelListWords(channels: readonly string[]): string {
  const words = channels.map(channelWords).filter((c) => c !== '');
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}
/** `Delivered "KinCare booking confirmed" to Dre East by email`. `to` is a name or "the office", never an id. */
export function notificationDeliveredWords(name: string, channel: string, to = ''): string {
  return `Delivered ${quotedName(name)}${toWhom(to)} by ${channelWords(channel)}`;
}
/**
 * #1819, #1905: A NOTICE THAT DID NOT GO OUT, OR NOT ON EVERY CHANNEL.
 *
 * The Activity Log said "Notification dispatched" with status SUCCESS for a
 * notice the household send switch had held back, and "Sent ... by email"
 * without saying to whom, on a notice whose household copy had email turned
 * off. Each sentence below says who the copy was for and why it did not go,
 * per channel where the reason is a channel's. `to` is the person's name, "the
 * household" or "the office", never an email address or an id.
 */
/** The send switch in Settings is off: `Held back "Auntie on the way" for Dre East: notices to households are turned off`. */
export function notificationHeldWords(name: string, to: string): string {
  const t = to.trim();
  return `Held back ${quotedName(name)}${t === '' ? '' : ` for ${t}`}: notices to households are turned off`;
}
/**
 * The send switch could not be read, so the copy was held to be safe
 * (`householdSendGate.ts` fails closed). Not "turned off": nobody turned it off.
 */
export function notificationHeldUnreadWords(name: string, to: string): string {
  const t = to.trim();
  return `Held back ${quotedName(name)}${t === '' ? '' : ` for ${t}`}: the setting for notices to households could not be read`;
}
/**
 * #2331: what a timed job's held notices are called, one and many. A key with
 * no entry reads as its own name: `3 "Payment received" notices`, or as
 * `3 notices` when it has no name either.
 */
const HELD_KIND_WORDS: Record<string, readonly [string, string]> = {
  'kincare.upcoming.reminder': ['visit reminder', 'visit reminders'],
  'invoice.reminder': ['invoice reminder', 'invoice reminders'],
  'invoice.overdue': ['overdue invoice notice', 'overdue invoice notices'],
  // #2340: the three marketing blast keys (`MARKETING_KEYS`).
  'newsletter.announcement': ['notice from a marketing blast', 'notices from a marketing blast'],
  'survey.event': ['notice from a marketing blast', 'notices from a marketing blast'],
  'marketing.optin': ['notice from a marketing blast', 'notices from a marketing blast'],
};
/** One kind a timed job held back: its key, its name (`notificationName`) and how many copies. */
export interface HeldKind {
  key: string;
  name: string;
  count: number;
}
function heldKindWords(kind: HeldKind): string {
  const words = HELD_KIND_WORDS[kind.key];
  if (words !== undefined) return `${kind.count} ${kind.count === 1 ? words[0] : words[1]}`;
  const name = kind.name.trim();
  return `${kind.count} ${name === '' ? '' : `"${name}" `}${kind.count === 1 ? 'notice' : 'notices'}`;
}
function heldKindsWords(kinds: readonly HeldKind[]): string {
  const parts = kinds.filter((k) => k.count > 0).map(heldKindWords);
  return parts.length === 0
    ? 'notices'
    : parts.length === 1
      ? (parts[0] as string)
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
/**
 * #2331: ONE LINE FOR A WHOLE RUN OF A TIMED JOB.
 * `Held back 14 visit reminders: notices to households are turned off`.
 * A count and a kind, no household, no id. `unreadable` is the run whose copies
 * were held because the switch could not be read, which is not "turned off".
 */
export function notificationsHeldSummaryWords(kinds: readonly HeldKind[], unreadable = false): string {
  const why = unreadable
    ? 'the setting for notices to households could not be read'
    : 'notices to households are turned off';
  return `Held back ${heldKindsWords(kinds)}: ${why}`;
}
/**
 * #2341: ONE LINE FOR A RUN'S COPIES OF A NOTIFICATION TURNED OFF IN SETTINGS.
 * `Did not send 14 invoice reminders: this notification is turned off in Settings`.
 * The per-notice line it stands for is `notificationTurnedOffWords`.
 */
export function notificationsTurnedOffSummaryWords(kinds: readonly HeldKind[]): string {
  const many = kinds.filter((k) => k.count > 0).length > 1;
  return `Did not send ${heldKindsWords(kinds)}: ${many ? 'these notifications are' : 'this notification is'} turned off in Settings`;
}
/** The notification as a whole is switched off in Settings. */
export function notificationTurnedOffWords(name: string, to: string): string {
  return `Did not send ${quotedName(name)}${toWhom(to)}: this notification is turned off in Settings`;
}
/** The household turned these channels off themselves. The record is still on their notifications list. */
export function notificationChannelsOffWords(name: string, to: string, channels: readonly string[]): string {
  const by = channelListWords(channels);
  return `Did not send ${quotedName(name)}${toWhom(to)}${by === '' ? '' : ` by ${by}`}: they turned that off in their notification settings`;
}
/** Nobody in the household can sign in to MyTribe, so there is nobody to address. `household` is its name or ''. */
export function notificationNoAccountWords(name: string, household: string): string {
  const h = household.trim();
  return `Did not send ${quotedName(name)}${h === '' ? '' : ` to ${h}`}: nobody in the household has a MyTribe sign-in`;
}
/** Why a channel's sender stood down, by the reason it reported (`senders/*Channel.ts`). */
const CHANNEL_SKIP_WORDS: Record<string, string> = {
  recipient_no_email: 'no email address on file',
  recipient_no_phone: 'no mobile number on file',
  recipient_hard_bounced: 'an earlier email to this address bounced',
  business_email_unset: 'no business email is set in Settings',
  template_text_empty: 'this notification has no text message wording',
  template_missing: 'this notification has no text message wording',
};
/** `Could not send "Invoice sent" to Dre East by text message: no mobile number on file`. */
export function notificationChannelSkippedWords(name: string, to: string, channel: string, skipReason: string): string {
  const why = CHANNEL_SKIP_WORDS[skipReason.trim()] ?? 'it could not go out this way';
  return `Could not send ${quotedName(name)}${toWhom(to)} by ${channelWords(channel)}: ${why}`;
}
/** The provider refused it or the send threw. */
export function notificationChannelFailedWords(name: string, to: string, channel: string): string {
  return `Could not send ${quotedName(name)}${toWhom(to)} by ${channelWords(channel)}: the send failed`;
}
export function notificationArchivedWords(name: string): string {
  return `Archived ${quotedName(name)}`;
}
export function notificationRestoredWords(name: string): string {
  return `Restored ${quotedName(name)} to the notifications list`;
}
export function notificationViewedWords(name: string): string {
  return `Viewed ${quotedName(name)}`;
}
export function notificationUnreadWords(name: string): string {
  return `Marked ${quotedName(name)} unread`;
}

/** A visit status in words. Unknown and legacy spellings (`CANCELED`) read as their own words. */
const STATUS_WORDS: Record<string, string> = {
  DRAFT: 'draft',
  PENDING: 'requested',
  SCHEDULED: 'scheduled',
  ON_MY_WAY: 'on the way',
  ARRIVED: 'arrived',
  DEPARTED: 'departed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

export function visitStatusWords(status: string): string {
  const s = status.trim();
  return STATUS_WORDS[s.toUpperCase()] ?? humanizeKey(s).toLowerCase();
}

/** Each visit action as a thing done ("Completed the visit") and a thing tried ("complete the visit"). */
const ACTION_WORDS: Record<string, { done: string; attempt: string }> = {
  APPROVE: { done: 'Approved the visit', attempt: 'approve the visit' },
  REJECT: { done: 'Declined the visit', attempt: 'decline the visit' },
  CANCEL: { done: 'Cancelled the visit', attempt: 'cancel the visit' },
  COMPLETE: { done: 'Completed the visit', attempt: 'complete the visit' },
  ON_MY_WAY: { done: 'Marked the visit on the way', attempt: 'mark the visit on the way' },
  ARRIVED: { done: 'Marked the arrival', attempt: 'mark the arrival' },
  DEPARTED: { done: 'Marked the departure', attempt: 'mark the departure' },
  UNDO_ARRIVAL: { done: 'Undid the arrival', attempt: 'undo the arrival' },
  UNDO_DEPARTED: { done: 'Undid the departure', attempt: 'undo the departure' },
};

function actionWords(action: string): { done: string; attempt: string } {
  const a = action.trim();
  const known = ACTION_WORDS[a.toUpperCase()];
  if (known) return known;
  const words = humanizeKey(a);
  return { done: words, attempt: words.toLowerCase() };
}

/** `Completed the visit: scheduled to completed`. */
export function visitTransitionWords(action: string, from: string, to: string): string {
  return `${actionWords(action).done}: ${visitStatusWords(from)} to ${visitStatusWords(to)}`;
}
/** #2038: an undone arrival's notice came off the household's notifications list. Nothing was sent. */
export function arrivalNoticeWithdrawnWords(): string {
  return "Took the arrival notice off the household's notifications list. No message was sent about the undo";
}
/** #2038: a real arrival after an undone one. The household was told once, so the entry went back and nothing was sent. */
export function arrivalNoticeRestoredWords(): string {
  return "Put the arrival notice back on the household's notifications list. They were told once already, so no second message was sent";
}
/** #2348: the "has left" notice of an undone arrival came off the household's notifications list. Nothing was sent. */
export function departureNoticeWithdrawnWords(): string {
  return "Took the departure notice off the household's notifications list. No message was sent about the undo";
}
/** #2348: a real departure after an undone one, the same day. The household was told once, so the entry went back and nothing was sent. */
export function departureNoticeRestoredWords(): string {
  return "Put the departure notice back on the household's notifications list. They were told once already, so no second message was sent";
}
/** #2357: an arrival announced on a later business day. The earlier day's entry came off the list; the new one is the household's. */
export function arrivalNoticeReplacedWords(): string {
  return "Took the earlier arrival notice off the household's notifications list. The new one replaces it";
}
/** #2357: the same for a departure announced on a later business day, after an "Undo departed" left the first one listed. */
export function departureNoticeReplacedWords(): string {
  return "Took the earlier departure notice off the household's notifications list. The new one replaces it";
}
/** A repeat of a step already taken: nothing was written. */
export function visitNoopWords(action: string, at: string): string {
  return `Did not ${actionWords(action).attempt}: the visit was already ${visitStatusWords(at)}`;
}
export function visitNotFoundWords(action: string): string {
  return `Could not ${actionWords(action).attempt}: the visit was not found`;
}
export function visitStatusUnreadableWords(action: string): string {
  return `Could not ${actionWords(action).attempt}: the visit's status could not be read`;
}
export function visitIllegalWords(action: string, from: string): string {
  return `Could not ${actionWords(action).attempt}: the visit is ${visitStatusWords(from)}`;
}
/** `missing` is `missingVisitSteps`' list: `arrival`, `departure`. */
export function visitMissingStepsWords(missing: readonly string[]): string {
  return `Could not complete the visit: no ${missing.join(' or ')} recorded`;
}
export function visitOutsideRadiusWords(distanceMeters: number, radiusMeters: number): string {
  return `Could not complete the visit: arrival was recorded ${distanceMeters}m from the household (radius ${radiusMeters}m)`;
}
/** #2279: the owner started a visit from outside the range, which only the owner may do. */
export function ownerArrivedOutsideRangeWords(distanceMeters: number, radiusMeters: number): string {
  return `Owner arrived outside the range: ${distanceMeters}m from the household (range ${radiusMeters}m)`;
}
/** #2279: that visit, completed. The owner may complete outside the range, and the log says so. */
export function visitCompletedOutsideRangeWords(from: string, distanceMeters: number, radiusMeters: number): string {
  return `Completed the visit outside the range: ${visitStatusWords(from)} to completed, arrival ${distanceMeters}m from the household (range ${radiusMeters}m)`;
}
/** #2279: an Auntie's start, refused. `why` is `auntieStartDecision`'s. */
export function auntieStartRefusedWords(action: string, why: string): string {
  return `Could not ${actionWords(action).attempt}: ${why}`;
}
/** #2279: an Auntie's start that no range could be checked for (the household has no map location). */
export function auntieStartUncheckedWords(action: string): string {
  return `${actionWords(action).done} with no range check: the household's location is not set`;
}
/** A refusal whose reason is already a sentence (the schedule guard's message). */
export function visitRefusedWords(action: string, reason: string): string {
  return `Could not ${actionWords(action).attempt}: ${reason}`;
}

const ARRIVAL_CHECK_WORDS: Record<string, string> = {
  within: 'within the household radius',
  outside: 'outside the household radius',
  unverified: 'location not verified',
  household_location_unknown: "the household's location is not set",
};

/** `Arrival location check: outside the household radius`. */
export function arrivalCheckWords(status: string): string {
  const s = status.trim();
  return `Arrival location check: ${ARRIVAL_CHECK_WORDS[s] ?? humanizeKey(s).toLowerCase()}`;
}

/** `$25.00` from cents. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** `Gave $25.00 account credit`. The household is the entry's `familyId`. */
export function accountCreditGivenWords(amountCents: number): string {
  return `Gave ${dollars(amountCents)} account credit`;
}

/** `Applied $25.00 account credit to invoice 1026`. The household is the entry's `familyId`. */
export function accountCreditAppliedWords(amountCents: number, invoiceNumber: string | null): string {
  return `Applied ${dollars(amountCents)} account credit to ${invoiceName(invoiceNumber)}`;
}
const PATTERN_WORDS: Record<string, string> = { individual: 'individual dates', weekly: 'weekly' };

/** `Created 4 visits (weekly)`. The household is the entry's `familyId`. */
export function visitsCreatedWords(count: number, pattern: string): string {
  const p = pattern.trim();
  const words = PATTERN_WORDS[p] ?? humanizeKey(p).toLowerCase();
  return `Created ${count} ${count === 1 ? 'visit' : 'visits'}${words === '' ? '' : ` (${words})`}`;
}

/** The KinTale triage callables. The KinTale is the entry's target. */
export function triageAssignedWords(householdName: string): string {
  const name = householdName.trim();
  return name === ''
    ? 'Assigned a KinTale from Needs triage'
    : `Assigned a KinTale from Needs triage to ${name}`;
}
export function triageDuplicateWords(): string {
  return 'Marked a KinTale in Needs triage as a duplicate';
}
export function triageBadDataWords(reason: string): string {
  const r = reason.trim();
  return `Archived a KinTale from Needs triage as bad data${r === '' ? '' : `: ${r}`}`;
}

/**
 * "invoice INV-2027-0001", or "an invoice with no number". Never its id.
 * The words are `invoiceNaming.ts`'s (#2453), shared with the refusals.
 */
export function invoiceWords(invoiceNumber: unknown): string {
  return invoiceName(invoiceNumber);
}
/** `Made the PDF for invoice INV-2027-0001`. */
export function invoicePdfMadeWords(invoiceNumber: unknown): string {
  return `Made the PDF for ${invoiceWords(invoiceNumber)}`;
}
/** `Household downloaded the PDF for invoice INV-2027-0001`. */
export function invoicePdfDownloadedWords(invoiceNumber: unknown): string {
  return `Household downloaded the PDF for ${invoiceWords(invoiceNumber)}`;
}
/** `Invoice 1042 archived`, or `Invoice with no number archived`. Never its id. */
export function invoiceSentence(invoiceNumber: unknown, rest: string): string {
  return `${invoiceLeadName(invoiceNumber)} ${rest}`;
}

/** `Quote 1026 sent to the household`, or `Quote with no number ...`. Never its id. */
export function quoteSentence(invoiceNumber: unknown, rest: string): string {
  return `${invoiceLeadName(invoiceNumber, 'quote')} ${rest}`;
}
/** `Draft invoice 1042 reviewed and sent`, or `Draft invoice with no number ...`. */
export function draftInvoiceSentWords(invoiceNumber: unknown): string {
  return `Draft ${lowerFirst(invoiceLeadName(invoiceNumber))} reviewed and sent`;
}
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
/** `Invoice 1042 settled by a manually-recorded payment`, or the partial line while a balance is still owed (#2453). */
export function manualPaymentWords(invoiceNumber: unknown, settled: boolean): string {
  return settled
    ? `${invoiceLeadName(invoiceNumber)} settled by a manually-recorded payment`
    : `Partial payment recorded against ${invoiceName(invoiceNumber)}; a balance is still owed`;
}
/** `Payment row recorded against invoice 1042` (#2453). */
export function paymentRowRecordedWords(invoiceNumber: unknown): string {
  return `Payment row recorded against ${invoiceName(invoiceNumber)}`;
}
/** The sweep finishing a payment the app paid off but never wrote a row for (#2453). */
export function ledgerRowBackfilledWords(invoiceNumber: unknown): string {
  return (
    `Payment ledger row recorded for ${invoiceName(invoiceNumber)}: ` +
    'the app stopped after paying it off and before recording the row'
  );
}
/**
 * #2453: what the owner decided about a held card payment, in dollars, naming
 * only the parts that got money: `Held card payment of $40.00 decided: $25.00
 * to account credit, $10.00 to invoice 1042 and $5.00 kept as recorded`. The
 * payment's id and the invoice's id stay in the entry's payload.
 */
export function unappliedPaymentDecidedWords(d: {
  paymentCents: number;
  creditedCents: number;
  appliedCents: number;
  keptCents: number;
  appliedInvoiceNumber: unknown;
}): string {
  const parts: string[] = [];
  if (d.creditedCents > 0) parts.push(`${dollars(d.creditedCents)} to account credit`);
  if (d.appliedCents > 0) parts.push(`${dollars(d.appliedCents)} to ${invoiceName(d.appliedInvoiceNumber)}`);
  if (d.keptCents > 0) parts.push(`${dollars(d.keptCents)} kept as recorded`);
  const lead = `Held card payment of ${dollars(d.paymentCents)} decided`;
  if (parts.length === 0) return lead;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${lead}: ${list}`;
}

/** `updateKinCareSession`'s field names as the operator reads them. */
const SESSION_FIELD_WORDS: Record<string, string> = {
  serviceType: 'service',
  notes: 'notes',
  serviceDurationMinutes: 'length',
  kinIds: 'kin',
  kinNames: 'kin',
};

/** `Edited a visit: service, notes`. */
export function visitEditedWords(fields: readonly string[]): string {
  const words = [
    ...new Set(
      fields
        .map((f) => f.trim())
        .filter((f) => f !== '')
        .map(
          (f) =>
            SESSION_FIELD_WORDS[f] ??
            humanizeKey(f.replace(/([a-z])([A-Z])/g, '$1 $2')).toLowerCase(),
        ),
    ),
  ];
  return words.length === 0 ? 'Edited a visit' : `Edited a visit: ${words.join(', ')}`;
}

/** `Synced a visit to Google Calendar (updated)`. */
export function calendarSyncWords(action: string): string {
  const a = action.trim();
  return `Synced a visit to Google Calendar${a === '' ? '' : ` (${a})`}`;
}

/** `Archived kin Biscuit`, or "a kin" when the name is unknown. */
export function kinArchivedWords(archived: boolean, kinName: unknown): string {
  const name = typeof kinName === 'string' && kinName.trim() !== '' ? kinName.trim() : '';
  return `${archived ? 'Archived' : 'Restored'} ${name === '' ? 'a kin' : `kin ${name}`}`;
}

/**
 * #2161. `Archived Kinfolk Dre East (reason: moved away)`, `Restored Kinfolk
 * Dre East`, or "a Kinfolk household" when the name is unknown.
 */
export function kinfolkArchivedWords(archived: boolean, name: unknown, reason: unknown = ''): string {
  const who = typeof name === 'string' && name.trim() !== '' ? `Kinfolk ${name.trim()}` : 'a Kinfolk household';
  const why = archived && typeof reason === 'string' && reason.trim() !== '' ? ` (reason: ${reason.trim()})` : '';
  return `${archived ? 'Archived' : 'Restored'} ${who}${why}`;
}

/** The AI title batch. The batch id is in the payload. */
export function aiTitlesAppliedWords(applied: number, skipped: number, errored: number): string {
  return `Applied AI KinTale titles (${applied} applied, ${skipped} skipped, ${errored} errored)`;
}

/** An invite whose Auntie notice could not be sent. `missingVar` is the setting's name. */
export function inviteNoticeSkippedWords(missingVar: string): string {
  return `An invite was sent, but the Auntie notice was not: ${missingVar} is not configured.`;
}

/** The payment-applied notice that gave up. The invoice is the entry's target. */
export function paymentNoticeGaveUpWords(attempts: number): string {
  return `A payment notification was not delivered after ${attempts} retries`;
}

/**
 * #2300: a payment row with no settlement id, recorded for an invoice whose
 * payoff already has a ledger row, and large enough to be that payoff. It is
 * kept as its own payment; the owner decides whether it is a duplicate. The
 * invoice's number only, never an id.
 */
export function paymentPossibleDuplicateWords(invoiceNumber: string): string {
  const which = invoiceNumber.trim() === '' ? `${invoiceName('')} that` : `${invoiceName(invoiceNumber)}, which`;
  return `A payment was recorded for ${which} was already settled. Check for a duplicate.`;
}
/** The vet clinic callables, when the clinic named is not there. */
export function vetClinicNotFoundWords(verb: 'update' | 'archive'): string {
  return `Vet clinic ${verb} refused: the clinic was not found`;
}
/**
 * `Sending "KinCare booking confirmed" to Dre East by email and push notification`.
 *
 * "Sending", not "Sent" (#1905): this line is written when the copy is handed
 * to its channels, before any of them has answered. Each channel then writes
 * its own line: delivered, or could not be sent and why.
 */
export function notificationDispatchedWords(name: string, channels: readonly string[], to = ''): string {
  const by = channelListWords(channels);
  return `Sending ${quotedName(name)}${toWhom(to)}${by === '' ? '' : ` by ${by}`}`;
}
/** `Declined quote INV-2027-0001 revised and sent again`. */
export function quoteRevisedWords(invoiceNumber: unknown): string {
  return `Declined ${lowerFirst(invoiceLeadName(invoiceNumber, 'quote'))} revised and sent again`;
}
/**
 * #1839: an Auntie's look at a household, `Jane Rivers looked at Kinfolk Dre
 * East`. The owner's own looks write no line at all (operator ruling
 * 2026-11-12). One line stands for every read in a short window (one screen
 * open fires several), so it names the household and not which part of it she
 * read. "An Auntie" when she has no name on record (an email is never used as a
 * name), "a Kinfolk household" when the household has none.
 */
export function auntieHouseholdLookWords(auntieName: unknown, householdName: unknown): string {
  const raw = typeof auntieName === 'string' ? auntieName.trim() : '';
  const who = raw === '' || raw.includes('@') ? 'An Auntie' : raw;
  const name = typeof householdName === 'string' ? householdName.trim() : '';
  const household = name === '' ? 'a Kinfolk household' : `Kinfolk ${name}`;
  return `${who} looked at ${household}`;
}

/**
 * #2344: a card was declined on an invoice the household no longer has to pay
 * by card: the invoice was already paid, or the payment from that same
 * checkout has gone through. No "charge failed" notice is sent for it, and the
 * line says so. `invoice-paid`, `payment-landed`, `invoice-cancelled`,
 * `invoice-written-off`, `invoice-not-found` and `invoice-other-household` are
 * the reasons the Stripe webhook stores.
 */
export function cardDeclinedAfterPaymentWords(invoiceNumber: unknown, reason: string): string {
  const sent = 'No notice was sent to the household.';
  // The checkout named an invoice that is not there, so there is no number to give.
  if (reason === 'invoice-not-found') return `A card was declined on an invoice that could not be found. ${sent}`;
  const n = typeof invoiceNumber === 'string' ? invoiceNumber.trim() : '';
  const invoice = invoiceName(invoiceNumber);
  // #2361: a cancelled or written-off invoice asks nothing of the household
  // either. Nor does one that is another household's than the checkout's.
  const state =
    reason === 'invoice-cancelled'
      ? 'was cancelled'
      : reason === 'invoice-written-off'
        ? 'was written off'
        : reason === 'invoice-other-household'
          ? 'belongs to a different household'
          : 'was already paid';
  const why =
    reason === 'payment-landed'
      ? ', and the payment from the same checkout went through'
      : n === ''
        ? ` that ${state}`
        : `, which ${state}`;
  return `A card was declined on ${invoice}${why}. ${sent}`;
}
/**
 * #2345: a card payment put on an invoice that was not in a state to be paid.
 * It is recorded (the card is charged and there are no refunds) and the owner
 * is told why the invoice should be looked at. `reason` is the
 * `cardApplyFallback` code the Stripe webhook stores; the sentence never shows
 * it. Since the lead ruling of 2026-11-17 such a payment is held for the owner
 * and never put on the invoice, so this line is written only for one an
 * earlier build applied, when a retry finds its line unwritten.
 */
export function cardPaymentNotPayableWords(invoiceNumber: unknown, reason: string, amountCents: number): string {
  const amount = amountCents > 0 ? ` of ${dollars(amountCents)}` : '';
  if (reason === 'apply_invoice_not_found') {
    return `A card payment${amount} was recorded for an invoice that could not be found.`;
  }
  const invoice = invoiceName(invoiceNumber);
  const why =
    reason === 'apply_invoice_not_sent'
      ? 'the invoice was a draft or a quote when the payment arrived'
      : reason === 'apply_wrong_household'
        ? 'the checkout was for a different household'
        : reason === 'no_recorded_balance'
          ? "nothing was owed on the invoice's total"
          : 'the invoice could not take a payment when it arrived';
  return `A card payment${amount} was put on ${invoice}, but ${why}.`;
}
