import { describe, it, expect } from 'vitest';
import type { NotificationEntry } from '../api/notifications';
import {
  hasNotificationDetail,
  notificationDetailRows,
  notificationDetailSummary,
} from './notificationDetail';

function entry(over: Partial<NotificationEntry> = {}): NotificationEntry {
  return { _id: 'n1', key: 'assignment.assigned', ...over };
}

/**
 * The display half of the R5 card detail. The RESOLUTION half is server-side
 * (mytribe/functions/src/notifications/buildNotificationDetail.ts) and has its
 * own tests; nothing here resolves anything, which is the property under test as
 * much as any assertion below.
 */
describe('notificationDetailRows', () => {
  it('answers the operator’s questions in the operator’s order', () => {
    const rows = notificationDetailRows(
      entry({
        detail: {
          notes: 'Gate code 4417.',
          bookingTime: '2:30 PM',
          bookingDate: 'Mon, Jun 15',
          kinName: 'Rex',
          kinfolkName: 'The Rivera Home',
          requestedBy: 'Dana Ruiz',
          serviceType: 'Drop-in visit',
        },
      }),
    );

    // Field ORDER is the assertion, not just membership: the card reads as an
    // answer to "who, for whom, what, when" and a shuffled order reads as a dump.
    expect(rows.map((r) => r.label)).toEqual([
      'Requested by',
      'Household',
      'Kin',
      'Service',
      'Date',
      'Time',
      'Notes',
    ]);
    expect(rows.map((r) => r.value)).toEqual([
      'Dana Ruiz',
      'The Rivera Home',
      'Rex',
      'Drop-in visit',
      'Mon, Jun 15',
      '2:30 PM',
      'Gate code 4417.',
    ]);
  });

  it('renders invoice figures for an invoice-class notification', () => {
    const rows = notificationDetailRows(
      entry({ detail: { invoiceNumber: 'TT-1001', amount: '$120.00', dueDate: 'Jul 5, 2026' } }),
    );
    expect(rows.map((r) => r.label)).toEqual(['Invoice', 'Amount', 'Due']);
  });

  it('drops absent and blank fields rather than printing a labelled blank', () => {
    const rows = notificationDetailRows(
      entry({ detail: { kinName: 'Rex', bookingDate: '', notes: '   ' } }),
    );
    expect(rows.map((r) => r.label)).toEqual(['Kin']);
  });

  it('marks notes as multiline, because it is the only field that wraps', () => {
    const rows = notificationDetailRows(entry({ detail: { notes: 'Long note.', kinName: 'Rex' } }));
    expect(rows.find((r) => r.field === 'notes')?.multiline).toBe(true);
    expect(rows.find((r) => r.field === 'kinName')?.multiline).toBeUndefined();
  });

  it('is empty for a notification with no detail at all', () => {
    expect(notificationDetailRows(entry())).toEqual([]);
  });

  /**
   * `NotificationEntry` is a CAST over raw Firestore data, so a hand-seeded or
   * legacy doc can put anything at `detail`. Property access on a string yields
   * undefined per key and would render an empty card; property access on null
   * throws and blanks the screen through React's error boundary. Reading through
   * `rec` makes both cases a no-detail row.
   */
  it('survives a malformed `detail` on the wire', () => {
    expect(notificationDetailRows(entry({ detail: 'nope' as never }))).toEqual([]);
    expect(notificationDetailRows(entry({ detail: null as never }))).toEqual([]);
    expect(notificationDetailRows(entry({ detail: [1, 2] as never }))).toEqual([]);
    expect(notificationDetailRows(entry({ detail: { kinName: 42 as never } }))).toEqual([]);
  });
});

describe('hasNotificationDetail', () => {
  it('is false when opening the card would show nothing', () => {
    expect(hasNotificationDetail(entry())).toBe(false);
    expect(hasNotificationDetail(entry({ detail: {} }))).toBe(false);
    expect(hasNotificationDetail(entry({ detail: { kinName: '' } }))).toBe(false);
  });

  it('is true as soon as one field resolved', () => {
    expect(hasNotificationDetail(entry({ detail: { requestedBy: 'Dana Ruiz' } }))).toBe(true);
  });
});

describe('notificationDetailSummary', () => {
  it('is kin · date · time, the three values that tell two visits apart', () => {
    expect(
      notificationDetailSummary(
        entry({ detail: { kinName: 'Rex', bookingDate: 'Mon, Jun 15', bookingTime: '2:30 PM' } }),
      ),
    ).toBe('Rex · Mon, Jun 15 · 2:30 PM');
  });

  /**
   * The household is deliberately absent. The collapsed row already prints it as
   * its own context chip, and repeating it would push the distinguishing values
   * off the end of a one-line summary.
   */
  it('leaves the household out, because the row already shows it', () => {
    expect(
      notificationDetailSummary(entry({ detail: { kinfolkName: 'The Rivera Home', kinName: 'Rex' } })),
    ).toBe('Rex');
  });

  it('joins only what resolved, with no dangling separators', () => {
    expect(notificationDetailSummary(entry({ detail: { bookingDate: 'Mon, Jun 15' } }))).toBe(
      'Mon, Jun 15',
    );
    expect(notificationDetailSummary(entry({ detail: { kinName: 'Rex', bookingTime: '2:30 PM' } }))).toBe(
      'Rex · 2:30 PM',
    );
  });

  it('is empty when there is nothing worth summarising', () => {
    expect(notificationDetailSummary(entry())).toBe('');
    expect(notificationDetailSummary(entry({ detail: { requestedBy: 'Dana Ruiz' } }))).toBe('');
  });
});
