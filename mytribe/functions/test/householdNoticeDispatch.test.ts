import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_OPEN } from './_helpers/mockDb';

/**
 * #1831, #1913: the household's copy of a notice is STORED with the line built
 * from its own facts, not the Notification settings sentence. Drives the real
 * dispatcher, enricher and detail builder over an in-memory Firestore.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/operatorAllowlist', () => ({
  isAuntieOperator: () => true,
  requireAuntieOperator: vi.fn(),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__' },
  };
});

beforeEach(() => mocks.dbFn.mockReset());

import { enqueueNotification } from '../src/notifications/dispatcher';
import { getNotificationDef } from '../src/notifications/catalog';
import { enrichTemplateData } from '../src/notifications/enrichTemplateData';

const SETTINGS = { ...HOUSEHOLD_GATE_OPEN, timeZone: 'America/New_York' };
// 2026-06-15T18:30:00Z is 2:30 PM in New York.
const START_MS = Date.UTC(2026, 5, 15, 18, 30);

async function householdCopy(key: string, data: Record<string, unknown>, docs: Record<string, Record<string, unknown>>, extra = {}) {
  const ctx = buildDbMock({ docs: { 'business_settings/business_settings': SETTINGS, ...docs } });
  mocks.dbFn.mockReturnValue(ctx.db);
  await enqueueNotification({ key, recipientUid: 'uid_household', data, ...extra });
  const written = ctx.writes.find((w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_household');
  expect(written, `${key} wrote no household copy`).toBeTruthy();
  return written!.data as Record<string, unknown>;
}

describe('the household copy is stored with its facts, not the settings words', () => {
  it('#1831: "Your Auntie has arrived" names the KinCare, the Kin, the date and the time', async () => {
    const doc = await householdCopy(
      'kincare.auntie.arrived',
      // The shape `admin/dispatchVisitNotification.ts` sends.
      {
        familyId: 'fam1',
        batchId: 'b1',
        visitId: 'v1',
        bookingId: 'v1',
        event: 'arrived',
        serviceType: 'Drop-in visit',
        scheduledAtMs: START_MS,
      },
      {
        'families/fam1': { displayName: 'The Rivera Home' },
        'families/fam1/bookings/b1/kinCares/v1': { kinNames: ['Rex', 'Mochi'], startTime: { toMillis: () => START_MS } },
      },
    );
    expect(doc.title).toBe('Your Auntie has arrived');
    expect(doc.description).toBe('Drop-in visit for Rex and Mochi on Mon, Jun 15 at 2:30 PM');
    expect(doc.householdLine).toBe(doc.description);
    expect(doc.description).not.toBe(getNotificationDef('kincare.auntie.arrived').householdDescription);
    expect(doc.targetType).toBe('booking');
    expect(doc.targetId).toBe('v1');
  });

  it('#1913: the Kin removal decline names the Kin and carries the office reason', async () => {
    const doc = await householdCopy(
      'kin.removal.declined',
      { kinfolkId: 'fam1', kinId: 'k2', kinName: 'Mochi', note: 'Mochi still has a visit booked.', requestId: 'rq1' },
      { 'families/fam1': { displayName: 'The Rivera Home' } },
      { targetType: 'kinfolk', targetId: 'fam1' },
    );
    expect(doc.title).toBe('Your Kin removal request was declined');
    expect(doc.description).toBe('Mochi is staying on your profile');
    expect((doc.detail as Record<string, unknown>).householdNote).toBe('Mochi still has a visit booked.');
  });

  it('#1831: a published KinTale names the tale and the Kin on its visit, not the whole household', async () => {
    const doc = await householdCopy(
      'kintale.published',
      { kinfolkId: 'fam1', taleId: 't1', authorDisplayName: 'Sam' },
      {
        'kin_care_reports/t1': { kinfolkId: 'fam1', title: 'Park day', sessionId: 's1' },
        'kin_care_sessions/s1': { kinNames: ['Rex'] },
      },
      { targetType: 'kintale', targetId: 't1' },
    );
    expect(doc.title).toBe('Your KinTale is ready');
    expect(doc.description).toBe('“Park day” about Rex');
  });

  it('a notice with no facts is stored with no line at all, and the list shows its title alone', async () => {
    const doc = await householdCopy('auth.account.locked', { email: 'catch@hanasamku.com' }, {});
    expect(doc.title).toBe('Your account was locked');
    expect(doc.description).toBe('');
    expect(doc.householdLine).toBe('');
  });
});
describe('#1863: in Time Blocks mode the stored line names the window, never the clock', () => {
  const BLOCKS_SETTINGS = {
    ...HOUSEHOLD_GATE_OPEN,
    timeZone: 'America/Chicago',
    allowTimeBlockBooking: true,
    allowSpecificTimeBooking: false,
    defaultBookingMode: 'TIME_BLOCK',
    timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
  };
  // 2026-11-17 12:30 PM in Chicago (UTC-6).
  const MIDDAY_MS = Date.UTC(2026, 10, 17, 18, 30);
  async function blocksCopy(key: string, data: Record<string, unknown>, docs: Record<string, Record<string, unknown>> = {}) {
    const ctx = buildDbMock({ docs: { 'business_settings/business_settings': BLOCKS_SETTINGS, ...docs } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await enqueueNotification({ key, recipientUid: 'uid_household', data });
    const written = ctx.writes.find((w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_household');
    expect(written, `${key} wrote no household copy`).toBeTruthy();
    return written!.data as Record<string, unknown>;
  }

  it('"Your Auntie has arrived" reads the visit\'s block', async () => {
    const doc = await blocksCopy(
      'kincare.auntie.arrived',
      { familyId: 'fam1', batchId: 'b1', visitId: 'v1', bookingId: 'v1', event: 'arrived', serviceType: 'Drop-in visit', scheduledAtMs: MIDDAY_MS },
      {
        'families/fam1': { displayName: 'The Rivera Home' },
        'families/fam1/bookings/b1/kinCares/v1': { kinNames: ['Rex'], timeBlockId: 'midday', startTime: { toMillis: () => MIDDAY_MS } },
      },
    );
    expect(doc.description).toBe('Drop-in visit for Rex on Tue, Nov 17 at Midday (11 AM to 3 PM)');
    expect(String(doc.description)).not.toContain('12:30');
  });

  it('the confirmation of several visits reads the first visit\'s block, not the clock the emitter also sent', async () => {
    const doc = await blocksCopy('kincare.booking.confirm', {
      kinfolkId: 'fam1',
      batchId: 'b1',
      bookingId: 'b1',
      startTimeMs: MIDDAY_MS,
      visitCount: 3,
      // The shape `approveBookingSeriesCore` sends: the clock for the office,
      // the household's own words beside it.
      nextVisit: { weekday: 'Tue', date: 'Nov 17', time: '12:30 PM', householdTime: 'Midday (11 AM to 3 PM)' },
      bookingTime: '12:30 PM',
      householdBookingTime: 'Midday (11 AM to 3 PM)',
    });
    expect(doc.description).toContain('3 visits starting Tue, Nov 17 at Midday (11 AM to 3 PM)');
    expect(String(doc.description)).not.toContain('12:30');
  });
});
describe('#1898: the comment digest email and push name the Kin', () => {
  it('reads the household off the digest, so "{{kinName}}\'s KinTale" is never "\'s KinTale"', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': SETTINGS },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    // The shape notificationBatchSweep promotes a household digest with.
    const digest = { kinfolkId: 'fam1', taleId: 't1', items: [{ taleId: 't1', kinfolkId: 'fam1' }], itemCount: 1 };
    const out = await enrichTemplateData('kintale.comment.added', 'uid_household', digest);
    expect(out.kinName).toBe('Rex');
  });
});

