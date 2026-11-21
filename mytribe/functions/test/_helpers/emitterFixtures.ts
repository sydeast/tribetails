import { buildVisitDateData, AUNTIE_SCHEDULE_URL, PORTAL_URL } from '../../src/notifications/visitDates';
import { VISIT_MS, WORLD } from './noticeWorld';
import type { AudienceStream } from '../../src/notifications/types';

/**
 * #2487: what each emitter really puts in `data`, one fixture per call site,
 * read off the call site (the comment on each names it). Values point at the
 * records in `noticeWorld.ts`. Keys are the call site's own; the sweep checks
 * every key is one the emitter's provenance row lists.
 *
 * A key with copies to both sides (a secondary resolver) has a fixture per copy,
 * because the enricher words a household's copy differently (`householdCopy`).
 */
export interface EmitterFixture {
  key: string;
  source: string;
  /** A second shape the same call site sends (a Kin added, a quote). */
  variant?: string;
  stream: AudienceStream;
  recipientUid: string;
  data: Record<string, unknown>;
  /** The notice is about Rex's own record, so the household's other Kin must not be named. */
  aboutRex: boolean;
  /** Tokens whose value is known exactly, when the template prints them. */
  expect?: Record<string, string>;
}

export function fixtureId(key: string, source: string): string {
  return `${key} <- ${source}`;
}

const TZ = 'America/Chicago';
const HOUSEHOLD = 'cli1';
const OWNER = 'owner1';
const AUNTIE = 'auntie1';

/** The structured dates the #536 emitters send, built by the emitters' own builder. */
function visitDates(linkUrl: string = PORTAL_URL): Record<string, unknown> {
  const d = buildVisitDateData([{ visitId: 'vis1', startTimeMs: VISIT_MS }], TZ, linkUrl);
  return { visits: d.visits, visitCount: d.visitCount, nextVisit: d.nextVisit, removed: d.removed, removedCount: d.removedCount, portalUrl: d.portalUrl };
}

const ABOUT_REX = { kinName: 'Rex' };
const ABOUT_INVOICE = { invoiceNumber: WORLD.invoiceNumber };

type Copy = { stream: AudienceStream; recipientUid: string };
const HOUSEHOLD_COPY: Copy = { stream: 'kinfolk', recipientUid: HOUSEHOLD };
const OFFICE_COPY: Copy = { stream: 'business', recipientUid: OWNER };
const AUNTIE_COPY: Copy = { stream: 'staff', recipientUid: AUNTIE };

function fx(
  key: string,
  source: string,
  copies: Copy[],
  data: Record<string, unknown>,
  opts: { aboutRex?: boolean; expect?: Record<string, string>; variant?: string } = {},
): EmitterFixture[] {
  return copies.map((c) => ({
    key,
    source,
    ...c,
    data,
    aboutRex: opts.aboutRex ?? false,
    ...(opts.expect ? { expect: opts.expect } : {}),
    ...(opts.variant ? { variant: opts.variant } : {}),
  }));
}


const S = {
  envelope: 'src/triggers/onBookingEnvelopeCreate.ts',
  approve: 'src/admin/approveBookingSeriesCore.ts',
  bookingsWrite: 'src/triggers/onBookingsWrite.ts',
  householdNotice: 'src/notifications/householdNotice.ts',
  addKin: 'src/admin/addKinToUpcomingVisits.ts',
  manageSeries: 'src/admin/manageBookingSeries.ts',
  kinWrites: 'src/portal/kinWrites.ts',
  kinRemoval: 'src/admin/kinRemovalRequests.ts',
  visitStep: 'src/admin/dispatchVisitNotification.ts',
  noteCreate: 'src/triggers/onBookingNoteCreate.ts',
  reminderCron: 'src/scheduled/kincareReminderCron.ts',
  digest: 'src/scheduled/scheduleDigestCron.ts',
  taleCreate: 'src/triggers/onKinTaleCreate.ts',
  taleUpdate: 'src/triggers/onKinTaleUpdate.ts',
  taleComment: 'src/triggers/onKinTaleCommentCreate.ts',
  createInvoice: 'src/admin/createInvoice.ts',
  resendQuote: 'src/admin/resendQuote.ts',
  reviewDraft: 'src/admin/reviewAndSendDraftInvoice.ts',
  receipt: 'src/admin/generateReceipt.ts',
  sendReminder: 'src/admin/sendInvoiceReminder.ts',
  invoiceCron: 'src/scheduled/invoiceRemindersCron.ts',
  recordPayment: 'src/admin/recordPayment.ts',
  stripeWebhook: 'src/billing/stripeWebhook.ts',
  accountCredit: 'src/lib/accountCredit.ts',
  invoicesWrite: 'src/triggers/onInvoicesWrite.ts',
  dispute: 'src/billing/stripeDispute.ts',
  quoteDecision: 'src/portal/quoteDecision.ts',
  kinfolkMessage: 'src/portal/sendKinfolkMessage.ts',
  conversations: 'src/admin/conversations.ts',
  householdPush: 'src/admin/sendHouseholdPush.ts',
  familyKin: 'src/triggers/onFamilyKinWrite.ts',
  profileWrite: 'src/triggers/onFamilyProfileWrite.ts',
  acceptInvite: 'src/membership/acceptInvite.ts',
  expireInvites: 'src/scheduled/expireStaleInvites.ts',
  rating: 'src/triggers/onRatingCreate.ts',
  passwordReset: 'src/auth/requestPasswordReset.ts',
  loginSecurity: 'src/auth/loginSecurity.ts',
  secureReset: 'src/security/confirmSecureReset.ts',
  blast: 'src/admin/scheduleMarketingBlast.ts',
} as const;
/** onBookingsWrite's per-visit base (`bookingId` is the visit's id there). */
const VISIT_BASE = {
  kinfolkId: 'fam1',
  batchId: 'bat1',
  bookingId: 'vis1',
  visitId: 'vis1',
  serviceName: WORLD.serviceName,
  startTimeMs: VISIT_MS,
};
/** onBookingNoteCreate's base: the visit's ids, no service or time. */
const NOTE_BASE = { kinfolkId: 'fam1', batchId: 'bat1', bookingId: 'vis1', visitId: 'vis1' };
/** The whole-request base the approve core and the decline send (`bookingId` is the request). */
const REQUEST_BASE = {
  kinfolkId: 'fam1',
  batchId: 'bat1',
  bookingId: 'bat1',
  serviceName: WORLD.serviceName,
  startTimeMs: VISIT_MS,
};
/** The single-visit spellings the #536 emitters still send for older stored templates. */
const OLD_DATE_TOKENS = { bookingDate: 'Thu, Dec 3', bookingTime: '9:00 AM' };
/** dispatchVisitNotification's step data (`bookingId` is the visit). */
function stepData(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    familyId: 'fam1',
    batchId: 'bat1',
    bookingId: 'vis1',
    visitId: 'vis1',
    event,
    serviceType: WORLD.serviceName,
    scheduledAtMs: null,
    auntieDisplayName: 'June',
    recipientDisplayName: WORLD.primaryName,
    ...extra,
  };
}
const INVOICE_BASE = { kinfolkId: 'fam1', invoiceId: 'inv1' };
const REMINDER = { ...INVOICE_BASE, invoiceDueDate: 'Dec 10, 2026', amountMinor: 6800, currency: 'usd' };
const KIN_ADDED = {
  kinfolkId: 'fam1',
  kinId: 'k1',
  kinName: 'Rex',
  kinAdded: true,
  addedKinName: 'Rex',
  changedFields: ['kinIds', 'kinNames'],
  serviceName: WORLD.serviceName,
  startTimeMs: VISIT_MS,
  ...OLD_DATE_TOKENS,
};
const OPERATOR_HOUSEHOLD = { kinfolkUid: 'cli1', kinfolkEmail: WORLD.primaryEmail, kinfolkName: WORLD.primaryName };
const REX = { aboutRex: true, expect: ABOUT_REX };
const BILL = { aboutRex: true, expect: ABOUT_INVOICE };
export const EMITTER_FIXTURES: EmitterFixture[] = [
  // ── Visits ────────────────────────────────────────────────────────────────
  ...fx('kincare.requested', S.envelope, [OFFICE_COPY], {
    ...REQUEST_BASE,
    startTimeMsList: [VISIT_MS],
    requestedDateList: [],
    visitCount: 1,
  }, REX),
  ...fx('kincare.booking.confirm', S.approve, [HOUSEHOLD_COPY, OFFICE_COPY], {
    ...REQUEST_BASE, ...visitDates(), ...OLD_DATE_TOKENS, note: null,
  }, REX),
  ...fx('kincare.booking.confirm', S.approve, [HOUSEHOLD_COPY], {
    ...REQUEST_BASE, ...visitDates(), ...OLD_DATE_TOKENS, note: 'The side gate is open.',
  }, { ...REX, variant: 'with the office note' }),
  ...fx('kincare.booking.confirm', S.bookingsWrite, [HOUSEHOLD_COPY, OFFICE_COPY], {
    ...VISIT_BASE, ...visitDates(), ...OLD_DATE_TOKENS,
  }, REX),
  ...fx('kincare.booking.confirm', S.householdNotice, [HOUSEHOLD_COPY, OFFICE_COPY], {
    ...REQUEST_BASE, ...visitDates(), ...OLD_DATE_TOKENS, note: null,
  }, REX),
  ...fx('kincare.booking.cancel', S.bookingsWrite, [HOUSEHOLD_COPY, OFFICE_COPY], VISIT_BASE, REX),
  ...fx('kincare.booking.cancel', S.householdNotice, [HOUSEHOLD_COPY, OFFICE_COPY], VISIT_BASE, REX),
  ...fx('kincare.unavailable', S.bookingsWrite, [HOUSEHOLD_COPY], VISIT_BASE, REX),
  ...fx('kincare.changed', S.bookingsWrite, [HOUSEHOLD_COPY, OFFICE_COPY], { ...VISIT_BASE, changedFields: ['startTime'] }, REX),
  ...fx('kincare.changed', S.householdNotice, [HOUSEHOLD_COPY, OFFICE_COPY], { ...VISIT_BASE, changedFields: ['startTime'] }, REX),
  ...fx('kincare.changed', S.addKin, [HOUSEHOLD_COPY, OFFICE_COPY], { ...KIN_ADDED, ...visitDates() }, REX),
  ...fx('kincare.reschedule.requested', S.bookingsWrite, [OFFICE_COPY], { ...VISIT_BASE, reason: 'We will be away.' }, REX),
  ...fx('kincare.cancel.requested', S.bookingsWrite, [OFFICE_COPY], { ...VISIT_BASE, reason: 'We will be away.' }, REX),
  ...fx('kincare.cancel.declined', S.bookingsWrite, [HOUSEHOLD_COPY], {
    ...VISIT_BASE, reason: 'We will be away.', note: 'It is too close to the day.',
  }, REX),
  ...fx('kincare.cancel.declined', S.bookingsWrite, [HOUSEHOLD_COPY], { ...VISIT_BASE, reason: null, note: null }, { ...REX, variant: 'no note' }),
  ...fx('kincare.request.declined', S.manageSeries, [HOUSEHOLD_COPY], {
    ...REQUEST_BASE, startTimeMsList: [VISIT_MS], requestedDateList: [], visitCount: 1, note: 'That week is full.',
  }, REX),
  ...fx('kincare.request.declined', S.manageSeries, [HOUSEHOLD_COPY], {
    ...REQUEST_BASE, startTimeMsList: [VISIT_MS], requestedDateList: [], visitCount: 1, note: null,
  }, { ...REX, variant: 'no note' }),
  ...fx('kin.removal.requested', S.kinWrites, [OFFICE_COPY], {
    kinfolkId: 'fam1', kinId: 'k1', flatKinId: 'k1', kinName: 'Rex', reason: 'Rex moved in with family.', requestId: 'req1',
  }, REX),
  ...fx('kin.removal.requested', S.kinWrites, [OFFICE_COPY], {
    kinfolkId: 'fam1', kinId: 'k1', flatKinId: 'k1', kinName: 'Rex', reason: null, requestId: 'req1',
  }, { ...REX, variant: 'no reason' }),
  ...fx('kin.removal.archived', S.kinRemoval, [HOUSEHOLD_COPY], { kinfolkId: 'fam1', kinId: 'k1', kinName: 'Rex', note: null, requestId: 'req1' }, { ...REX, variant: 'no note' }),
  ...fx('kin.removal.declined', S.kinRemoval, [HOUSEHOLD_COPY], { kinfolkId: 'fam1', kinId: 'k1', kinName: 'Rex', note: 'He has visits booked.', requestId: 'req1' }, REX),
  ...fx('kin.removal.declined', S.kinRemoval, [HOUSEHOLD_COPY], { kinfolkId: 'fam1', kinId: 'k1', kinName: 'Rex', note: null, requestId: 'req1' }, { ...REX, variant: 'no note' }),
  ...fx('kin.removal.archived', S.kinRemoval, [HOUSEHOLD_COPY], { kinfolkId: 'fam1', kinId: 'k1', kinName: 'Rex', note: 'Thank you for telling us.', requestId: 'req1' }, REX),
  ...fx('kincare.auntie.on_my_way', S.visitStep, [HOUSEHOLD_COPY], stepData('on_my_way', { etaMinutes: 10 }), REX),
  ...fx('kincare.auntie.arrived', S.visitStep, [HOUSEHOLD_COPY], stepData('arrived'), REX),
  ...fx('kincare.auntie.departed', S.visitStep, [HOUSEHOLD_COPY], stepData('departed'), REX),
  ...fx('kincare.note.kinfolk', S.noteCreate, [OFFICE_COPY], {
    ...NOTE_BASE, noteId: 'n1', authorUid: 'cli1', preview: 'Please top up the water bowl.',
  }, REX),
  ...fx('kincare.note.auntie', S.noteCreate, [OFFICE_COPY], {
    ...NOTE_BASE, noteId: 'n1', authorUid: 'auntie1', preview: 'All good today.',
  }, REX),
  ...fx('kincare.upcoming.reminder', S.reminderCron, [HOUSEHOLD_COPY], {
    kinfolkId: 'fam1', bookingId: 'bat1', serviceName: WORLD.serviceName, startTimeMs: VISIT_MS, timeBlockId: null, serviceId: null,
  }, REX),
  ...fx('assignment.assigned', S.approve, [AUNTIE_COPY], {
    ...REQUEST_BASE, assignedAuntieUid: AUNTIE, ...visitDates(AUNTIE_SCHEDULE_URL), ...OLD_DATE_TOKENS,
  }, REX),
  ...fx('assignment.assigned', S.bookingsWrite, [AUNTIE_COPY], {
    ...VISIT_BASE, assignedAuntieUid: AUNTIE, ...visitDates(AUNTIE_SCHEDULE_URL), ...OLD_DATE_TOKENS,
  }, REX),
  ...fx('assignment.changed', S.bookingsWrite, [AUNTIE_COPY], { ...VISIT_BASE, assignedAuntieUid: AUNTIE, changeKind: 'reassigned' }, REX),
  ...fx('assignment.changed', S.addKin, [AUNTIE_COPY], {
    ...KIN_ADDED, assignedAuntieUid: AUNTIE, changeKind: 'updated', ...visitDates(AUNTIE_SCHEDULE_URL),
  }, REX),
  ...fx('schedule.upcoming.digest', S.digest, [OFFICE_COPY], {
    windowStartMs: VISIT_MS, windowEndMs: VISIT_MS + 86_400_000, count: 3,
    items: [{ bookingId: 'vis1', kinfolkId: 'fam1', serviceName: WORLD.serviceName, auntieDisplayName: 'June', startTimeMs: VISIT_MS }],
  }),
  // ── KinTales ──────────────────────────────────────────────────────────────
  ...fx('kintale.published', S.taleCreate, [HOUSEHOLD_COPY], { kinfolkId: 'fam1', taleId: 'tale1', authorDisplayName: 'June' }, REX),
  ...fx('kintale.published', S.taleUpdate, [HOUSEHOLD_COPY], { kinfolkId: 'fam1', taleId: 'tale1', authorDisplayName: 'June' }, REX),
  ...fx('kintale.published', S.visitStep, [HOUSEHOLD_COPY], stepData('report_sent'), REX),
  ...fx('kintale.note.added', S.taleUpdate, [HOUSEHOLD_COPY], {
    kinfolkId: 'fam1', taleId: 'tale1', authorDisplayName: 'June', bodyChanged: true, mediaAdded: false, addedMediaCount: 0,
  }, REX),
  ...fx('kintale.comment.added', S.taleComment, [HOUSEHOLD_COPY, OFFICE_COPY], {
    kinfolkId: 'fam1', taleId: 'tale1', commentId: 'c1', authorUid: 'cli1', authorRole: 'kinfolk', authorName: 'Maya', taleTitle: 'A sunny walk', preview: 'He looks so happy.',
  }, REX),
  // ── Money ─────────────────────────────────────────────────────────────────
  ...fx('invoice.new', S.createInvoice, [HOUSEHOLD_COPY, OFFICE_COPY], INVOICE_BASE, BILL),
  ...fx('invoice.new', S.resendQuote, [HOUSEHOLD_COPY, OFFICE_COPY], { ...INVOICE_BASE, isQuote: true, resent: true }, BILL),
  ...fx('invoice.new', S.reviewDraft, [HOUSEHOLD_COPY], INVOICE_BASE, BILL),
  ...fx('invoice.new', S.reviewDraft, [HOUSEHOLD_COPY], { ...INVOICE_BASE, isQuote: true }, { ...BILL, variant: 'a quote' }),
  ...fx('invoice.receipt', S.receipt, [HOUSEHOLD_COPY, OFFICE_COPY], INVOICE_BASE, BILL),
  ...fx('invoice.reminder', S.sendReminder, [HOUSEHOLD_COPY], REMINDER, BILL),
  ...fx('invoice.reminder', S.invoiceCron, [HOUSEHOLD_COPY], REMINDER, BILL),
  ...fx('invoice.overdue', S.invoiceCron, [HOUSEHOLD_COPY], { ...REMINDER, daysPastDue: 3 }, BILL),
  ...fx('invoice.payment.applied', S.recordPayment, [HOUSEHOLD_COPY, OFFICE_COPY], { ...INVOICE_BASE, paymentId: 'p1' }, BILL),
  ...fx('invoice.payment.applied', S.stripeWebhook, [HOUSEHOLD_COPY, OFFICE_COPY], { ...INVOICE_BASE, stripeEventId: 'evt1' }, BILL),
  ...fx('invoice.payment.applied', S.accountCredit, [HOUSEHOLD_COPY, OFFICE_COPY], {
    ...INVOICE_BASE, amountDue: 0, currency: 'usd', dueDate: 'Dec 10, 2026', paymentId: 'p1',
  }, BILL),
  ...fx('invoice.payment.applied', S.invoicesWrite, [HOUSEHOLD_COPY, OFFICE_COPY], {
    ...INVOICE_BASE, amountDue: 0, currency: 'usd', dueDate: 'Dec 10, 2026',
  }, BILL),
  ...fx('invoice.charge.failed', S.stripeWebhook, [HOUSEHOLD_COPY, OFFICE_COPY], { ...INVOICE_BASE, stripeEventId: 'evt1' }, BILL),
  ...fx('invoice.payment.disputed', S.dispute, [OFFICE_COPY], {
    ...INVOICE_BASE, disputeId: 'dp1', disputeStatus: 'needs response', disputeReason: 'fraudulent', disputeAmount: '$68.00', stripeEventId: 'evt1',
  }, BILL),
  // stripeDispute names the invoice and household only when Stripe's charge carries them.
  ...fx('invoice.payment.disputed', S.dispute, [OFFICE_COPY], {
    disputeId: 'dp1', disputeStatus: 'needs response', disputeReason: 'not stated', disputeAmount: 'an unknown amount', stripeEventId: 'evt1',
  }, { variant: 'no invoice on the charge' }),
  ...fx('invoice.payment.unapplied', S.stripeWebhook, [OFFICE_COPY], {
    ...INVOICE_BASE, stripeEventId: 'evt1', unappliedAmount: '$20.00', unappliedReason: 'The invoice was already paid',
  }, BILL),
  ...fx('quote.accepted', S.quoteDecision, [HOUSEHOLD_COPY, OFFICE_COPY], {
    ...INVOICE_BASE, invoiceNumber: WORLD.invoiceNumber, actorName: 'Maya', actorUid: 'cli1',
  }, BILL),
  ...fx('quote.denied', S.quoteDecision, [OFFICE_COPY], {
    ...INVOICE_BASE, invoiceNumber: WORLD.invoiceNumber, actorName: 'Maya', actorUid: 'cli1',
  }, BILL),
  // ── Household, account, messages ──────────────────────────────────────────
  ...fx('message.received', S.kinfolkMessage, [OFFICE_COPY], {
    kinfolkId: 'fam1', kinfolkName: WORLD.primaryName, messageId: 'm1', preview: 'Can you come at noon?',
  }),
  ...fx('message.received', S.kinfolkMessage, [OFFICE_COPY], {
    kinfolkId: 'fam1', kinfolkName: '', messageId: 'm1', preview: 'Can you come at noon?',
  }, { variant: 'no name on the kinfolk record' }),
  ...fx('message.reply', S.conversations, [HOUSEHOLD_COPY], {
    kinfolkId: 'fam1', kinfolkName: WORLD.primaryName, messageId: 'm2', preview: 'Noon works.',
  }),
  ...fx('pets.updated', S.familyKin, [HOUSEHOLD_COPY, OFFICE_COPY], { kinfolkId: 'fam1', kinId: 'k1' }),
  ...fx('pet.marked.inactive', S.familyKin, [OFFICE_COPY], { kinfolkId: 'fam1', kinId: 'k1', kinName: 'Rex', status: 'memorial' }, REX),
  ...fx('profile.updated', S.profileWrite, [HOUSEHOLD_COPY, OFFICE_COPY], { kinfolkId: 'fam1' }),
  ...fx('account.welcome.kinfolk', S.acceptInvite, [HOUSEHOLD_COPY], { kinfolkId: 'fam1', invitedEmail: WORLD.primaryEmail, role: 'PRIMARY' }),
  ...fx('invite.expired', S.expireInvites, [OFFICE_COPY], { kinfolkId: 'fam1', inviteId: 'i1', invitedEmail: WORLD.primaryEmail }),
  ...fx('rating.submitted.bad', S.rating, [OFFICE_COPY], {
    kinfolkId: 'fam1', ratingId: 'r1', bookingId: 'vis1', score: 2, comment: null, submittedByUid: 'cli1',
  }),
  ...fx('rating.submitted.good', S.rating, [OFFICE_COPY], {
    kinfolkId: 'fam1', ratingId: 'r1', bookingId: 'vis1', score: 5, comment: 'Lovely', submittedByUid: 'cli1',
  }),
  // ── Security and sign-in ──────────────────────────────────────────────────
  ...fx('auth.password.reset', S.passwordReset, [HOUSEHOLD_COPY], {
    link: 'https://kinfolk.tribetails.com/account/secure-reset?oobCode=abc', email: WORLD.primaryEmail, displayName: WORLD.primaryName,
    business: WORLD.businessName, Business: WORLD.businessName,
  }),
  ...fx('auth.failedLogin.attempts', S.loginSecurity, [HOUSEHOLD_COPY], { email: WORLD.primaryEmail, attemptsInWindow: 5 }),
  ...fx('auth.account.locked', S.loginSecurity, [HOUSEHOLD_COPY], { email: WORLD.primaryEmail, lockStartedAtMs: VISIT_MS }),
  ...fx('security.failedLogin.attempts.operator', S.loginSecurity, [OFFICE_COPY], {
    ...OPERATOR_HOUSEHOLD, attemptsInWindow: 5, warnStartedAtMs: VISIT_MS,
  }),
  ...fx('security.account.locked.operator', S.loginSecurity, [OFFICE_COPY], { ...OPERATOR_HOUSEHOLD, lockStartedAtMs: VISIT_MS }),
  ...fx('security.failedLogin.budgetExhausted.operator', S.loginSecurity, [OFFICE_COPY], {
    ...OPERATOR_HOUSEHOLD, reportLimit: 10, budgetExhaustedAtMs: VISIT_MS,
  }),
  ...fx('security.account.locked.spike.operator', S.loginSecurity, [OFFICE_COPY], {
    lockedAccounts: 4, windowMinutes: 15, spikeStartedAtMs: VISIT_MS,
  }),
  ...fx('security.breach_attempt.kinfolk', S.secureReset, [OFFICE_COPY], {
    kinfolkEmail: WORLD.primaryEmail, timestampIso: '2026-12-03T15:00:00.000Z', ip: '203.0.113.7', userAgent: 'Firefox on Mac', incidentId: 'inc1',
  }),
  ...fx('security.breach_attempt.staff', S.secureReset, [OFFICE_COPY], {
    staffEmail: 'e2e-admin@tribetails.com', timestampIso: '2026-12-03T15:00:00.000Z', ip: '203.0.113.7', userAgent: 'Firefox on Mac', incidentId: 'inc1',
  }),
  ...fx('newsletter.announcement', S.blast, [HOUSEHOLD_COPY], { audienceUid: HOUSEHOLD, blastId: 'b1' }),
  ...fx('survey.event', S.blast, [HOUSEHOLD_COPY], { audienceUid: HOUSEHOLD, blastId: 'b1' }),
  ...fx('marketing.optin', S.blast, [HOUSEHOLD_COPY], { audienceUid: HOUSEHOLD, blastId: 'b1' }),
];
/**
 * Call sites that send a catalog key WITHOUT rendering its stored template,
 * with the reason. They still need an entry, so the table above stays complete.
 */
export const NOT_TEMPLATE_RENDERS: Record<string, string> = {
  [fixtureId('message.reply', S.householdPush)]:
    "writes the household's notice and pushes the office's approved words itself; no template is read",
};
