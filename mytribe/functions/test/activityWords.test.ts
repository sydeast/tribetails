import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  accountCreditGivenWords,
  aiTitlesAppliedWords,
  arrivalCheckWords,
  calendarSyncWords,
  invoicePdfDownloadedWords,
  invoicePdfMadeWords,
  invoiceSentence,
  kinArchivedWords,
  notificationChannelFailedWords,
  notificationChannelSkippedWords,
  notificationChannelsOffWords,
  notificationDeliveredWords,
  notificationDispatchedWords,
  notificationHeldWords,
  notificationNoAccountWords,
  notificationTurnedOffWords,
  quoteRevisedWords,
  triageAssignedWords,
  triageBadDataWords,
  vetClinicNotFoundWords,
  visitEditedWords,
  visitIllegalWords,
  visitMissingStepsWords,
  visitNoopWords,
  visitNotFoundWords,
  visitsCreatedWords,
  visitTransitionWords,
} from '../src/lib/activityWords';
import { notificationName } from '../src/notifications/notificationName';

/**
 * #1752: Activity Log descriptions say what happened in words. The ids stay on
 * the entry as its target, household and payload. These are the sentences the
 * admin clients also read OLD stored rows as (`activityWords.ts` /
 * `ActivityWords.kt`), so the expected strings here are copied verbatim into
 * those tests.
 */
describe('activity words', () => {
  it('names a notification by its catalog label, never its key', () => {
    expect(notificationName('kincare.booking.confirm')).toBe('KinCare booking confirmed');
    expect(notificationName('retired.key.gone')).toBe('Retired key gone');
    expect(notificationName(undefined)).toBe('');
    expect(notificationDeliveredWords('KinCare booking confirmed', 'email')).toBe(
      'Delivered "KinCare booking confirmed" by email',
    );
    expect(notificationDeliveredWords('', 'sms')).toBe('Delivered a notification by text message');
    expect(notificationDispatchedWords('KinCare booking confirmed', ['email', 'push'])).toBe(
      'Sending "KinCare booking confirmed" by email and push notification',
    );
  });

  /**
   * #1905: a payment notice goes to the household and to the office. The two
   * lines read alike, so the office's email looked like one sent against the
   * household's switch. Each line names who the copy is for.
   */
  it('names who a copy is for, by name or "the office", on the sending and delivered lines', () => {
    expect(notificationDispatchedWords('Payment or credit applied to an invoice', ['email'], 'the office')).toBe(
      'Sending "Payment or credit applied to an invoice" to the office by email',
    );
    expect(notificationDispatchedWords('Your Auntie has arrived', ['email', 'sms', 'push'], 'Dre East')).toBe(
      'Sending "Your Auntie has arrived" to Dre East by email, text message and push notification',
    );
    expect(notificationDeliveredWords('Your Auntie has arrived', 'sms', 'Dre East')).toBe(
      'Delivered "Your Auntie has arrived" to Dre East by text message',
    );
    // A work order from before the audience was stored names nobody, and says nothing false.
    expect(notificationDispatchedWords('Your Auntie has arrived', ['email'], '  ')).toBe(
      'Sending "Your Auntie has arrived" by email',
    );
    expect(notificationDispatchedWords('', [])).toBe('Sending a notification');
  });

  /** #1819, #1905: every way a notice does not go out has its own sentence. */
  it('says why a notice did not go out, per channel where the reason is a channel', () => {
    expect(notificationHeldWords('Your Auntie is on the way', 'Dre East')).toBe(
      'Held back "Your Auntie is on the way" for Dre East: notices to households are turned off',
    );
    expect(notificationHeldWords('Your Auntie is on the way', '')).toBe(
      'Held back "Your Auntie is on the way": notices to households are turned off',
    );
    expect(notificationTurnedOffWords('Your Auntie is on the way', 'Dre East')).toBe(
      'Did not send "Your Auntie is on the way" to Dre East: this notification is turned off in Settings',
    );
    expect(notificationChannelsOffWords('Payment or credit applied to an invoice', 'Dre East', ['email'])).toBe(
      'Did not send "Payment or credit applied to an invoice" to Dre East by email: they turned that off in their notification settings',
    );
    expect(notificationChannelsOffWords('Invoice sent', 'Dre East', ['email', 'push'])).toBe(
      'Did not send "Invoice sent" to Dre East by email and push notification: they turned that off in their notification settings',
    );
    expect(notificationNoAccountWords('Your Auntie has arrived', 'The Rivera Home')).toBe(
      'Did not send "Your Auntie has arrived" to The Rivera Home: nobody in the household has a MyTribe sign-in',
    );
    expect(notificationNoAccountWords('Your Auntie has arrived', '')).toBe(
      'Did not send "Your Auntie has arrived": nobody in the household has a MyTribe sign-in',
    );
    expect(notificationChannelSkippedWords('Invoice sent', 'Dre East', 'sms', 'recipient_no_phone')).toBe(
      'Could not send "Invoice sent" to Dre East by text message: no mobile number on file',
    );
    expect(notificationChannelSkippedWords('Invoice sent', 'Dre East', 'email', 'recipient_no_email')).toBe(
      'Could not send "Invoice sent" to Dre East by email: no email address on file',
    );
    // #2251: stored wording the sender could not fill in.
    expect(notificationChannelSkippedWords('Invoice sent', 'Dre East', 'sms', 'template_broken')).toBe(
      'Could not send "Invoice sent" to Dre East by text message: its text message wording cannot be filled in, so fix it in Templates',
    );
    expect(notificationChannelSkippedWords('Invoice sent', 'the office', 'email', 'business_email_unset')).toBe(
      'Could not send "Invoice sent" to the office by email: no business email is set in Settings',
    );
    // A reason this file has no words for is never printed as its stored key.
    expect(notificationChannelSkippedWords('Invoice sent', 'Dre East', 'push', 'some_new_reason')).toBe(
      'Could not send "Invoice sent" to Dre East by push notification: it could not go out this way',
    );
    expect(notificationChannelFailedWords('Invoice sent', 'Dre East', 'email')).toBe(
      'Could not send "Invoice sent" to Dre East by email: the send failed',
    );
  });

  it('says a visit transition in words', () => {
    expect(visitTransitionWords('COMPLETE', 'SCHEDULED', 'COMPLETED')).toBe(
      'Completed the visit: scheduled to completed',
    );
    expect(visitTransitionWords('ARRIVED', 'ON_MY_WAY', 'ARRIVED')).toBe(
      'Marked the arrival: on the way to arrived',
    );
    expect(visitNoopWords('COMPLETE', 'COMPLETED')).toBe(
      'Did not complete the visit: the visit was already completed',
    );
    expect(visitNotFoundWords('COMPLETE')).toBe(
      'Could not complete the visit: the visit was not found',
    );
    expect(visitIllegalWords('APPROVE', 'CANCELLED')).toBe(
      'Could not approve the visit: the visit is cancelled',
    );
    expect(visitMissingStepsWords(['arrival', 'departure'])).toBe(
      'Could not complete the visit: no arrival or departure recorded',
    );
  });

  it('says money, visits and KinTales in words', () => {
    expect(accountCreditGivenWords(2500)).toBe('Gave $25.00 account credit');
    expect(visitsCreatedWords(4, 'weekly')).toBe('Created 4 visits (weekly)');
    expect(visitsCreatedWords(1, 'individual')).toBe('Created 1 visit (individual dates)');
    expect(triageAssignedWords('The Rivera Home')).toBe(
      'Assigned a KinTale from Needs triage to The Rivera Home',
    );
    expect(triageBadDataWords('test row')).toBe(
      'Archived a KinTale from Needs triage as bad data: test row',
    );
    expect(arrivalCheckWords('outside')).toBe(
      'Arrival location check: outside the household radius',
    );
    expect(visitEditedWords(['serviceType', 'kinIds', 'kinNames'])).toBe(
      'Edited a visit: service, kin',
    );
    expect(calendarSyncWords('updated')).toBe('Synced a visit to Google Calendar (updated)');
    expect(aiTitlesAppliedWords(3, 1, 0)).toBe(
      'Applied AI KinTale titles (3 applied, 1 skipped, 0 errored)',
    );
    expect(vetClinicNotFoundWords('archive')).toBe(
      'Vet clinic archive refused: the clinic was not found',
    );
  });

  it('names an invoice by its number, and never by its id', () => {
    expect(invoicePdfMadeWords('INV-2027-0001')).toBe('Made the PDF for invoice INV-2027-0001');
    expect(invoicePdfDownloadedWords(undefined)).toBe(
      'Household downloaded the PDF for an invoice with no number',
    );
    expect(invoiceSentence('INV-2027-0001', 'edited')).toBe('Invoice INV-2027-0001 edited');
    expect(invoiceSentence(null, 'edited')).toBe('Invoice with no number edited');
    expect(kinArchivedWords(true, 'Biscuit')).toBe('Archived kin Biscuit');
    expect(kinArchivedWords(false, undefined)).toBe('Restored a kin');
    expect(quoteRevisedWords('')).toBe('Declined quote with no number revised and sent again');
  });
});

/**
 * The guard: no Activity Log description in `src` interpolates an id or a
 * catalog key. It reads the source, so a new writer that puts
 * `${args.sessionId}` into a description fails here rather than in the
 * operator's Activity Log.
 */
describe('no description carries an id (#1752)', () => {
  const SRC = join(__dirname, '../src');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  // `description: \`...${x.fooId}...\`` or `${...key}` on one line.
  const ID_IN_DESCRIPTION = /description:\s*`[^`]*\$\{[^}]*(?:Id|Uid|\.id|\.key|\bid)\b[^}]*\}/;

  it('finds none', () => {
    const offenders = files(SRC)
      // A calendar event body, not an Activity Log entry.
      .filter((f) => !f.endsWith('googleCalendarVisitSync.ts'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ line, at: `${relative(SRC, f)}:${i + 1}` }))
          .filter(({ line }) => ID_IN_DESCRIPTION.test(line))
          .map(({ at, line }) => `${at}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});
describe('#1818, #1881: lines that had no sentence, and brand words', () => {
  it('names the change in words, never a key or an id', async () => {
    const w = await import('../src/lib/activityWords');
    expect(w.bookingSeriesApprovedWords(3, 0)).toBe('Approved a visit request: 3 visits');
    expect(w.bookingSeriesApprovedWords(1, 0)).toBe('Approved a visit request: 1 visit');
    expect(w.bookingSeriesApprovedWords(2, 1)).toBe('Approved a visit request: 2 of 3 visits; 1 could not be changed');
    expect(w.bookingSeriesCancelledWords(4, 0)).toBe('Cancelled a visit series: 4 visits');
    expect(w.visitCreatedWords(false)).toBe('Created a visit');
    expect(w.visitCreatedWords(true)).toBe('Recorded a past visit');
    expect(w.visitsRequestedWords(1, 'individual')).toBe('Kinfolk asked for 1 visit (individual dates)');
    expect(w.visitsRequestedWords(2, 'weekly')).toBe('Kinfolk asked for 2 visits (weekly)');
    expect(w.invoiceCreatedWords('1042')).toBe('Created invoice 1042');
    expect(w.cardPaymentWords('1042')).toBe('Invoice 1042 paid by card');
    expect(w.cardPaymentFailedWords('1042')).toBe('A card payment failed on invoice 1042');
    expect(w.shareLinkExpiredWords()).toBe('A KinTale share link expired');
  });
  it('an invoice with no number is said in words, not left blank', async () => {
    const w = await import('../src/lib/activityWords');
    expect(w.invoiceCreatedWords('')).not.toMatch(/undefined|null|\s$/);
    expect(w.cardPaymentWords(undefined)).not.toMatch(/undefined|null/);
  });
  it('a key with no label keeps the brand words in their casing', async () => {
    const w = await import('../src/lib/activityWords');
    const e = await import('../src/lib/auditEvents');
    expect(w.humanizeKey('kincare.booking.confirm')).toBe('KinCare booking confirm');
    expect(e.auditEventWords('CREATE_KINCARE_SESSION')).toBe('Create KinCare session');
    expect(e.auditEventWords('KINTALE_DRAFT_DELETED')).toBe('KinTale draft deleted');
    expect(e.auditEventWords('AI_TALE_TITLES_APPLIED')).toBe('AI tale titles applied');
    expect(e.auditEventWords('UPDATE_KINFOLK')).toBe('Kinfolk updated');
    expect(e.auditEventWords('CONTENT_KINTALE_SENT')).toBe('KinTale sent');
  });
});
