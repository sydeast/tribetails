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

/** `Delivered "KinCare booking confirmed" by email`. */
export function notificationDeliveredWords(name: string, channel: string): string {
  return `Delivered ${quotedName(name)} by ${channelWords(channel)}`;
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
  const n = (invoiceNumber ?? '').trim();
  return `Applied ${dollars(amountCents)} account credit to ${n === '' ? 'an invoice' : `invoice ${n}`}`;
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

/** "invoice INV-2027-0001", or "an invoice" when the invoice has no number yet. Never its id. */
export function invoiceWords(invoiceNumber: unknown): string {
  return typeof invoiceNumber === 'string' && invoiceNumber.trim() !== ''
    ? `invoice ${invoiceNumber.trim()}`
    : 'an invoice';
}
function capitalised(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** `Made the PDF for invoice INV-2027-0001`. */
export function invoicePdfMadeWords(invoiceNumber: unknown): string {
  return `Made the PDF for ${invoiceWords(invoiceNumber)}`;
}
/** `Household downloaded the PDF for invoice INV-2027-0001`. */
export function invoicePdfDownloadedWords(invoiceNumber: unknown): string {
  return `Household downloaded the PDF for ${invoiceWords(invoiceNumber)}`;
}
/** The invoice sentences that already named the number, with "an invoice" where the id used to stand in. */
export function invoiceSentence(invoiceNumber: unknown, rest: string): string {
  return `${capitalised(invoiceWords(invoiceNumber))} ${rest}`;
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

/** The vet clinic callables, when the clinic named is not there. */
export function vetClinicNotFoundWords(verb: 'update' | 'archive'): string {
  return `Vet clinic ${verb} refused: the clinic was not found`;
}
/** `Sent "KinCare booking confirmed" by email and push notification`. */
export function notificationDispatchedWords(name: string, channels: readonly string[]): string {
  const words = channels.map(channelWords).filter((c) => c !== '');
  const by =
    words.length === 0
      ? ''
      : words.length === 1
        ? ` by ${words[0]}`
        : ` by ${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `Sent ${quotedName(name)}${by}`;
}
/** `Declined quote INV-2027-0001 revised and sent again`. */
export function quoteRevisedWords(invoiceNumber: unknown): string {
  const n = typeof invoiceNumber === 'string' ? invoiceNumber.trim() : '';
  return n === ''
    ? 'A declined quote revised and sent again'
    : `Declined quote ${n} revised and sent again`;
}
/**
 * #1839: what an Auntie opened on a household, by the callable that opened it.
 * The owner's own looks write no line at all (operator ruling 2026-11-12); an
 * Auntie's still do, in these words. A callable not named here reads "opened".
 */
const HOUSEHOLD_LOOK_WORDS: Record<string, string> = {
  listMembers: 'looked at the members of',
  listEmergencyContacts: 'looked at the emergency contacts of',
  saveEmergencyContacts: 'changed the emergency contacts of',
  getMyKinTaleMedia: 'looked at KinTale photos of',
  listSecondaryKinfolk: 'looked at the secondary Kinfolk of',
  saveSecondaryKinfolk: 'saved a secondary Kinfolk for',
};
/**
 * `Jane looked at the members of Kinfolk Dre East`. "An Auntie" when she has no
 * name on record (an email is never used as a name), "a Kinfolk household" when
 * the household has none.
 */
export function auntieHouseholdLookWords(auntieName: unknown, functionName: string, householdName: unknown): string {
  const raw = typeof auntieName === 'string' ? auntieName.trim() : '';
  const who = raw === '' || raw.includes('@') ? 'An Auntie' : raw;
  const name = typeof householdName === 'string' ? householdName.trim() : '';
  const household = name === '' ? 'a Kinfolk household' : `Kinfolk ${name}`;
  const what = HOUSEHOLD_LOOK_WORDS[functionName] ?? 'opened';
  return `${who} ${what} ${household}`;
}
