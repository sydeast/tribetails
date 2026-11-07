import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #1726: the desktop console's Save draft writes a DRAFT `kin_care_sessions`
 * row with no booking record. Approving it made a SCHEDULED visit that could
 * not be given an Auntie or notes ("This visit is not part of a booking
 * request"). The approval now writes the record #1575 / #1630 write, in the
 * same batch as the status change, and links the session to it.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { transitionBookingStatusHandler } from '../src/admin/transitionBookingStatus';

const START = '2026-08-24T15:30:00.000Z';
const ENVELOPE = 'families/kf1/bookings/ses_draft1';
const VISIT = 'families/kf1/bookings/ses_draft1/kinCares/ses_draft1';
const SESSION = 'kin_care_sessions/draft1';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-05-01T00:00:00.000Z'));
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});
afterEach(() => {
  vi.useRealTimers();
});

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } },
    rawRequest: {},
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** A desktop draft as Save draft writes it: no booking record. */
function seedDraft(session: Record<string, unknown> = {}) {
  const ctx = buildDbMock({
    docs: {
      [SESSION]: {
        kinfolkId: 'kf1',
        kinfolkName: 'Rivera Household',
        serviceType: 'Drop-in',
        startTime: START,
        status: 'DRAFT',
        notes: 'Key under the mat',
        kinfolkNotes: 'Biscuit gets his pill at noon',
        kinIds: [],
        ...session,
      },
    },
    queryDocs: { 'families/kf1/kin': [{ id: 'k1', data: { name: 'Biscuit' } }] },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

const writeAt = (ctx: ReturnType<typeof buildDbMock>, path: string) => ctx.writes.find((w) => w.path === path);

describe('transitionBookingStatus APPROVE writes the booking record a draft lacks (#1726)', () => {
  it('writes the envelope and visit and links the session to them', async () => {
    const ctx = seedDraft();
    const res = await transitionBookingStatusHandler(req({ sessionId: 'draft1', action: 'APPROVE' }));
    expect(res).toMatchObject({ status: 'SCHEDULED', changed: true });

    const session = writeAt(ctx, SESSION);
    expect(session?.merge).toBe(true);
    expect(session?.data).toMatchObject({
      status: 'SCHEDULED',
      kinCareBatchId: 'ses_draft1',
      kinCareVisitId: 'ses_draft1',
      sourceBookingId: 'ses_draft1',
      kinIds: ['k1'],
      kinNames: ['Biscuit'],
    });

    const envelope = writeAt(ctx, ENVELOPE);
    expect(envelope?.data).toMatchObject({
      familyId: 'kf1',
      envelopeStatus: 'confirmed',
      scheduledByOffice: true,
      visitIds: ['ses_draft1'],
      serviceName: 'Drop-in',
      // The household's note rides the envelope, as a request's does (#1579).
      notes: 'Biscuit gets his pill at noon',
      visitCount: 1,
      confirmedCount: 1,
    });
    expect((envelope?.data.firstStartTime as Timestamp).toMillis()).toBe(Date.parse(START));

    const visit = writeAt(ctx, VISIT);
    expect(visit?.data).toMatchObject({
      batchId: 'ses_draft1',
      familyId: 'kf1',
      status: 'confirmed',
      sessionId: 'draft1',
      serviceType: 'Drop-in',
      assignedAuntieUid: null,
      kinIds: ['k1'],
      // Stamped so onBookingsWrite sends no per-visit confirmation.
      seriesApprovedAt: '__TS__',
    });
    expect((visit?.data.startTime as Timestamp).toMillis()).toBe(Date.parse(START));
    // The office's note stays on the session; it is not the household's.
    expect(JSON.stringify(visit?.data)).not.toContain('Key under the mat');

    const entry = mocks.writeAuditEntryFn.mock.calls.at(-1)?.[0] as { payload: Record<string, unknown> };
    expect(entry.payload.bookingRecordCreated).toEqual({ batchId: 'ses_draft1', visitId: 'ses_draft1' });
  });

  it('also covers a PENDING row written straight to kin_care_sessions', async () => {
    const ctx = seedDraft({ status: 'PENDING', kinfolkNotes: '' });
    await transitionBookingStatusHandler(req({ sessionId: 'draft1', action: 'APPROVE' }));
    expect(writeAt(ctx, VISIT)?.data.status).toBe('confirmed');
    expect(writeAt(ctx, ENVELOPE)?.data.notes).toBeNull();
  });

  it('keeps the kin the draft named', async () => {
    const ctx = seedDraft({ kinIds: ['k1'] });
    await transitionBookingStatusHandler(req({ sessionId: 'draft1', action: 'APPROVE' }));
    expect(writeAt(ctx, SESSION)?.data.kinIds).toEqual(['k1']);
  });

  it('a session that already has its record gets no second one', async () => {
    const ctx = seedDraft({ kinCareBatchId: 'b1', kinCareVisitId: 'v1' });
    await transitionBookingStatusHandler(req({ sessionId: 'draft1', action: 'APPROVE' }));
    expect(ctx.writes.filter((w) => w.path.startsWith('families/'))).toHaveLength(0);
    expect(writeAt(ctx, SESSION)?.data).not.toHaveProperty('kinCareBatchId');
  });

  it('keeps a sourceBookingId the session already carries', async () => {
    const ctx = seedDraft({ sourceBookingId: 'enh-1' });
    await transitionBookingStatusHandler(req({ sessionId: 'draft1', action: 'APPROVE' }));
    expect(writeAt(ctx, SESSION)?.data).not.toHaveProperty('sourceBookingId');
    expect(writeAt(ctx, VISIT)).toBeDefined();
  });

  it('a draft with no readable start is approved as before, with no record', async () => {
    const ctx = seedDraft({ startTime: '' });
    await transitionBookingStatusHandler(req({ sessionId: 'draft1', action: 'APPROVE' }));
    expect(writeAt(ctx, SESSION)?.data.status).toBe('SCHEDULED');
    expect(ctx.writes.filter((w) => w.path.startsWith('families/'))).toHaveLength(0);
  });

  it('REJECT of a draft writes no record', async () => {
    const ctx = seedDraft();
    await transitionBookingStatusHandler(req({ sessionId: 'draft1', action: 'REJECT' }));
    expect(ctx.writes.filter((w) => w.path.startsWith('families/'))).toHaveLength(0);
  });
});
