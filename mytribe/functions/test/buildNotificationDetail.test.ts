import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * The R5 write-back: the entity detail a notification CARD renders.
 *
 * The operator's complaint was specific: "I see the A KinCare visit was
 * assigned and the CTAs for the workflow but I do not see the KinCare/Booking
 * details. Who requested, For which kinfolk, what date, what time, wheres the
 * notes." Every one of those five was already resolvable from the same entities
 * `enrichTemplateData` reads for outbound email; none of them reached the card.
 * So these tests are written against the operator's list, one assertion per
 * question, because that list is the acceptance criterion.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

import { buildNotificationDetail, CARD_DETAIL_FIELDS } from '../src/notifications/buildNotificationDetail';

/** A booking-assignment fixture: envelope + session + family + pets. */
function assignmentDb() {
  return buildDbMock({
    docs: {
      'business_settings/business_settings': { timeZone: 'America/New_York' },
      'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' },
      'families/fam1/bookings/batch1': {
        notes: 'Gate code is 4417, Rex is shy with strangers.',
        requestedByUid: 'cli1',
      },
      'families/fam1/bookings/batch1/kinCares/v1': {
        serviceName: 'Drop-in visit',
        // 2026-06-15T18:30:00Z == 2:30 PM America/New_York
        startTime: { toMillis: () => Date.UTC(2026, 5, 15, 18, 30) },
        kinNames: ['Rex'],
      },
    },
  });
}

describe('buildNotificationDetail answers the operator’s five questions', () => {
  it('resolves who requested it, for which kinfolk, which kin, the date, the time and the notes', async () => {
    mocks.dbFn.mockReturnValue(assignmentDb().db);

    const detail = await buildNotificationDetail(
      'assignment.assigned',
      'auntie1',
      { kinfolkId: 'fam1', batchId: 'batch1', visitId: 'v1' },
      'Dana Ruiz',
    );

    expect(detail).toBeDefined();
    expect(detail!.requestedBy).toBe('Dana Ruiz'); // who requested
    expect(detail!.kinfolkName).toBe('The Rivera Home'); // for which kinfolk
    expect(detail!.kinName).toBe('Rex'); // which kin
    expect(detail!.bookingDate).toBe('Mon, Jun 15'); // what date
    expect(detail!.bookingTime).toBe('2:30 PM'); // what time
    expect(detail!.notes).toBe('Gate code is 4417, Rex is shy with strangers.'); // the notes
    expect(detail!.serviceType).toBe('Drop-in visit');
  });

  /**
   * The notes live on the ENVELOPE, not the visit session. A dispatch carrying
   * `{batchId, visitId}` resolves the session, finds no `notes` there, and has
   * to walk up. Without that walk this field is blank for every real booking
   * notification, which is precisely the "wheres the notes" complaint.
   */
  it('reads notes from the booking envelope when the visit session carries none', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/fam1': { displayName: 'The Rivera Home' },
        'families/fam1/bookings/batch1': { notes: 'Leave the porch light on.' },
        'families/fam1/bookings/batch1/kinCares/v1': { serviceName: 'Walk' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const detail = await buildNotificationDetail(
      'assignment.assigned',
      'auntie1',
      { kinfolkId: 'fam1', batchId: 'batch1', visitId: 'v1' },
      'Dana Ruiz',
    );

    expect(detail!.notes).toBe('Leave the porch light on.');
  });

  it('prefers a value the emitter already supplied over anything it could read', async () => {
    mocks.dbFn.mockReturnValue(assignmentDb().db);

    const detail = await buildNotificationDetail(
      'assignment.assigned',
      'auntie1',
      { kinfolkId: 'fam1', batchId: 'batch1', visitId: 'v1', kinName: 'Rex and Willow' },
      'Dana Ruiz',
    );

    expect(detail!.kinName).toBe('Rex and Willow');
  });

  /**
   * ABSENT, NOT BLANK. A renderer must be able to tell "no detail" from "detail
   * whose every field is empty" without inspecting each key, and a blank string
   * on a card reads as a fact the system knows and is refusing to say.
   */
  it('omits fields it cannot resolve rather than writing blanks', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);

    const detail = await buildNotificationDetail('assignment.assigned', 'auntie1', {}, 'Dana Ruiz');

    expect(detail).toEqual({ requestedBy: 'Dana Ruiz' });
    expect('bookingDate' in detail!).toBe(false);
    expect('notes' in detail!).toBe(false);
  });

  it('returns undefined, not an empty object, when nothing at all resolved', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);

    // No actor either: a system-emitted notification with unresolvable entities.
    const detail = await buildNotificationDetail('assignment.assigned', '', {}, null);

    expect(detail).toBeUndefined();
  });

  /**
   * A card detail is an enrichment, never a precondition. If the entity reads
   * blow up entirely the notification must still dispatch with its catalog
   * title and its CTAs; the operator loses the extra lines, not the alert.
   */
  it('degrades to the actor and never throws when the entity reads fail', async () => {
    mocks.dbFn.mockImplementation(() => {
      throw new Error('firestore is down');
    });

    const detail = await buildNotificationDetail(
      'assignment.assigned',
      'auntie1',
      { kinfolkId: 'fam1' },
      'Dana Ruiz',
    );

    expect(detail).toEqual({ requestedBy: 'Dana Ruiz' });
    expect(mocks.logEventFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'detail.enrich.failed', severity: 'warn' }),
    );
  });

  it('asks for exactly the card fields, so a token added here is a token resolved', () => {
    // Guards the pairing between the requested set and what the projection
    // reads: a field added to one and not the other is silently never resolved.
    expect([...CARD_DETAIL_FIELDS].sort()).toEqual(
      [
        'amount',
        'bookingDate',
        'bookingTime',
        'dueDate',
        'invoiceNumber',
        'kinName',
        'kinfolkName',
        'notes',
        'serviceType',
      ].sort(),
    );
  });
});

describe('buildNotificationDetail on invoice-class keys', () => {
  it('resolves the invoice number, amount and due date', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { invoiceNumber: 'TT-1001', amountDue: 120, dueDate: 'Jul 5, 2026' },
        'families/fam1': { displayName: 'The Rivera Home' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const detail = await buildNotificationDetail(
      'invoice.new',
      'cli1',
      { invoiceId: 'inv1', kinfolkId: 'fam1' },
      'Auntie Syd',
    );

    expect(detail).toMatchObject({
      invoiceNumber: 'TT-1001',
      amount: '$120.00',
      dueDate: 'Jul 5, 2026',
      kinfolkName: 'The Rivera Home',
      requestedBy: 'Auntie Syd',
    });
  });
});
