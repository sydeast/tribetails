import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #2030: the office's note to the household on Accept and on Decline of a
 * booking request reaches the household.
 *
 * Before: admin web dropped the accept note on the client, the APPROVE path had
 * nowhere to put one, and the decline note was stored on the visit but nothing
 * the household reads ever returned it. These tests pin the server half: the
 * note is stamped where `getBookingNotes` reads it, and it rides on the answer's
 * one notification as `data.note`, which the card turns into `householdNote`.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DELETE__' } };
});

import { manageBookingSeriesHandler } from '../src/admin/manageBookingSeries';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-05-01T00:00:00.000Z'));
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset();
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.resolveKinfolkUid.mockReset();
  mocks.resolveKinfolkUid.mockResolvedValue('uid-kinfolk');
});
afterEach(() => {
  vi.useRealTimers();
});

const PARENT = 'families/fam1/bookings/req_1';

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'owner1', token: { admin: true } } as never,
    rawRequest: {} as never,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function envelope(visits: Array<{ id: string; data: Record<string, unknown> }>) {
  const ctx = buildDbMock({
    docs: {
      [PARENT]: { envelopeStatus: 'requested', kinfolkName: 'The Rivera Home', serviceName: 'Dog Walk' },
      'business_settings/business_settings': { timeZone: 'America/New_York' },
    },
    queryDocs: { [`${PARENT}/kinCares`]: visits },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

const VISIT = (id: string, status = 'requested', day = 4) => ({
  id,
  data: {
    status,
    startTime: `2026-09-0${day}T16:00:00Z`,
    endTime: `2026-09-0${day}T17:00:00Z`,
    serviceType: 'Dog Walk',
    kinIds: ['k1'],
  },
});

/** The last write the handler made to one visit document. */
function lastVisitWrite(ctx: ReturnType<typeof buildDbMock>, id: string): Record<string, unknown> | undefined {
  const all = ctx.writes.filter((w) => w.path === `${PARENT}/kinCares/${id}`);
  return all[all.length - 1]?.data as Record<string, unknown> | undefined;
}

describe('#2030 APPROVE carries the note for the household', () => {
  it('stamps the note, its time and who wrote it on every visit it books', async () => {
    const ctx = envelope([VISIT('v1'), VISIT('v2', 'requested', 5)]);
    const res = await manageBookingSeriesHandler(
      req({ action: 'APPROVE', kinfolkId: 'fam1', batchId: 'req_1', note: '  Booked. Bring the spare key.  ' }),
    );
    expect(res.newlyConfirmed).toBe(2);
    for (const id of ['v1', 'v2']) {
      expect(lastVisitWrite(ctx, id)).toMatchObject({
        status: 'confirmed',
        requestAcceptNote: 'Booked. Bring the spare key.',
        requestAcceptedAt: '__TS__',
        requestAcceptedBy: 'owner1',
      });
    }
  });

  it('puts the note on the one confirmation the household gets', async () => {
    envelope([VISIT('v1'), VISIT('v2', 'requested', 5)]);
    await manageBookingSeriesHandler(
      req({ action: 'APPROVE', kinfolkId: 'fam1', batchId: 'req_1', note: 'See you Friday.' }),
    );
    const confirms = mocks.enqueue.mock.calls.map((c) => c[0]).filter((a) => a.key === 'kincare.booking.confirm');
    expect(confirms).toHaveLength(1);
    expect(confirms[0].data.note).toBe('See you Friday.');
  });

  it('stamps nothing and sends a null note when the office left none', async () => {
    const ctx = envelope([VISIT('v1')]);
    await manageBookingSeriesHandler(req({ action: 'APPROVE', kinfolkId: 'fam1', batchId: 'req_1' }));
    expect(lastVisitWrite(ctx, 'v1')).not.toHaveProperty('requestAcceptNote');
    const confirm = mocks.enqueue.mock.calls.map((c) => c[0]).find((a) => a.key === 'kincare.booking.confirm');
    expect(confirm.data.note).toBeNull();
  });

  it('does not stamp a visit that was already confirmed: a re-approve is not a new answer', async () => {
    const ctx = envelope([VISIT('v1', 'confirmed'), VISIT('v2', 'requested', 5)]);
    await manageBookingSeriesHandler(
      req({ action: 'APPROVE', kinfolkId: 'fam1', batchId: 'req_1', note: 'Second answer' }),
    );
    expect(lastVisitWrite(ctx, 'v1')).not.toHaveProperty('requestAcceptNote');
    expect(lastVisitWrite(ctx, 'v2')).toMatchObject({ requestAcceptNote: 'Second answer' });
  });

  it('never overwrites an accept note a visit already carries, whatever its status', async () => {
    const first = { id: 'v1', data: { ...VISIT('v1').data, requestAcceptNote: 'First answer', requestAcceptedBy: 'owner1' } };
    const ctx = envelope([first, VISIT('v2', 'requested', 5)]);
    await manageBookingSeriesHandler(
      req({ action: 'APPROVE', kinfolkId: 'fam1', batchId: 'req_1', note: 'Second answer' }),
    );
    expect(lastVisitWrite(ctx, 'v1')).toMatchObject({ status: 'confirmed' });
    expect(lastVisitWrite(ctx, 'v1')).not.toHaveProperty('requestAcceptNote');
    expect(lastVisitWrite(ctx, 'v1')).not.toHaveProperty('requestAcceptedBy');
    expect(lastVisitWrite(ctx, 'v2')).toMatchObject({ requestAcceptNote: 'Second answer' });
  });

  it('a retry after a partial failure stamps only the visits it now books, once', async () => {
    // First pass: v1 booked and stamped, v2 failed. The retry finds v1 confirmed.
    const v1 = { id: 'v1', data: { ...VISIT('v1', 'confirmed').data, requestAcceptNote: 'See you then.', requestAcceptedBy: 'owner1' } };
    const ctx = envelope([v1, VISIT('v2', 'requested', 5)]);
    await manageBookingSeriesHandler(
      req({ action: 'APPROVE', kinfolkId: 'fam1', batchId: 'req_1', note: 'See you then.' }),
    );
    expect(lastVisitWrite(ctx, 'v1')).not.toHaveProperty('requestAcceptNote');
    expect(lastVisitWrite(ctx, 'v2')).toMatchObject({ requestAcceptNote: 'See you then.', requestAcceptedBy: 'owner1' });
  });

  it('refuses a note longer than the box allows', async () => {
    envelope([VISIT('v1')]);
    await expect(
      manageBookingSeriesHandler(req({ action: 'APPROVE', kinfolkId: 'fam1', batchId: 'req_1', note: 'x'.repeat(501) })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('#2030 a decline carries the note for the household', () => {
  it('stamps the note and who wrote it, and puts it on the decline notice', async () => {
    const ctx = envelope([VISIT('v1'), VISIT('v2', 'requested', 5)]);
    await manageBookingSeriesHandler(
      req({ action: 'CANCEL', kinfolkId: 'fam1', batchId: 'req_1', note: 'We are full that week.' }),
    );
    for (const id of ['v1', 'v2']) {
      expect(lastVisitWrite(ctx, id)).toMatchObject({
        status: 'cancelled',
        requestDeclinedAt: '__TS__',
        requestDeclineNote: 'We are full that week.',
        requestDeclinedBy: 'owner1',
      });
    }
    const declined = mocks.enqueue.mock.calls.map((c) => c[0]).filter((a) => a.key === 'kincare.request.declined');
    expect(declined).toHaveLength(1);
    expect(declined[0].data.note).toBe('We are full that week.');
  });

  it('never stamps an accept note on a decline', async () => {
    const ctx = envelope([VISIT('v1')]);
    await manageBookingSeriesHandler(req({ action: 'CANCEL', kinfolkId: 'fam1', batchId: 'req_1', note: 'No room.' }));
    expect(lastVisitWrite(ctx, 'v1')).not.toHaveProperty('requestAcceptNote');
  });
});
