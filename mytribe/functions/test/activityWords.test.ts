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
  notificationDeliveredWords,
  notificationDispatchedWords,
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
      'Sent "KinCare booking confirmed" by email and push notification',
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
      'Household downloaded the PDF for an invoice',
    );
    expect(invoiceSentence('INV-2027-0001', 'edited')).toBe('Invoice INV-2027-0001 edited');
    expect(invoiceSentence(null, 'edited')).toBe('An invoice edited');
    expect(kinArchivedWords(true, 'Biscuit')).toBe('Archived kin Biscuit');
    expect(kinArchivedWords(false, undefined)).toBe('Restored a kin');
    expect(quoteRevisedWords('')).toBe('A declined quote revised and sent again');
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
