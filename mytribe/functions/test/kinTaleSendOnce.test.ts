import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * The Android / wasm send tap does TWO things: it calls the
 * `dispatchVisitNotification` callable (event `report_sent`), then flips the
 * report DRAFT → SENT with `sentVia: 'catalog'`. Both halves reach the
 * notification system. This suite runs them back to back against ONE shared
 * dispatcher spy and asserts the household is told once, not twice.
 *
 * The React web send tap does only the second half (`sentVia: 'pending'`),
 * which must still produce exactly one notification.
 */

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue(['disp_1']),
  resolveUid: vi.fn().mockResolvedValue('uid_kinfolk'),
  writeAuditEntryFn: vi.fn().mockResolvedValue(undefined),
  claim: vi.fn().mockResolvedValue(true),
  resolveKinCareRefFn: vi.fn(),
  dbFn: vi.fn(),
}));

vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('../src/notifications/dispatcher', async () => {
  const actual = await vi.importActual<typeof import('../src/notifications/dispatcher')>('../src/notifications/dispatcher');
  return { contentDedupeKey: actual.contentDedupeKey, enqueueNotification: mocks.enqueue };
});
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
// Only the Firestore-backed claim is mocked; `clientAlreadyAnnouncedSend` is a
// pure predicate and runs for real.
vi.mock('../src/lib/kinTalePublishClaim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/kinTalePublishClaim')>()),
  claimKinTalePublish: mocks.claim,
}));
vi.mock('../src/lib/resolveKinCareRef', () => ({ resolveKinCareRef: mocks.resolveKinCareRefFn }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));

import { onKinTaleUpdateHandler } from '../src/triggers/onKinTaleUpdate';
import { dispatchVisitNotificationHandler } from '../src/admin/dispatchVisitNotification';

const VISIT_PATH = 'bookings/batch1/kinCares/visit1';

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(['disp_1']);
  mocks.resolveUid.mockReset().mockResolvedValue('uid_kinfolk');
  mocks.writeAuditEntryFn.mockReset().mockResolvedValue(undefined);
  mocks.claim.mockReset().mockResolvedValue(true);

  const { db } = buildDbMock({
    docs: {
      [VISIT_PATH]: { serviceType: 'kincare', scheduledAtMs: 1, kinfolkId: 'fam1' },
      'families/fam1': { primaryUid: 'uid_kinfolk', displayName: 'The Rileys' },
      'clients/uid_kinfolk': { displayName: 'Dana' },
      'staff/uid_auntie': { displayName: 'TiTi' },
      // Tracker starts unclaimed.
      'kinTaleNotifications/r1': null,
    },
  });
  mocks.dbFn.mockReset().mockReturnValue(db);
  mocks.resolveKinCareRefFn.mockReset().mockResolvedValue({
    ref: db.doc(VISIT_PATH),
    batchId: 'batch1',
    visitId: 'visit1',
  });
});

/** One notification per household-visible event, keyed for readability. */
function enqueuedKeys(): string[] {
  return mocks.enqueue.mock.calls.map((c) => (c[0] as { key: string }).key);
}

async function androidSendTap(): Promise<void> {
  // 1. VisitNotifier → dispatchVisitNotification callable.
  await dispatchVisitNotificationHandler({
    data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'report_sent' },
    auth: { uid: 'uid_auntie', token: { name: 'TiTi' } },
  } as any);
  // 2. markReportSent → DRAFT → SENT with the catalog receipt stamped.
  await onKinTaleUpdateHandler({
    params: { reportId: 'r1' },
    data: {
      before: { data: () => ({ kinfolkId: 'fam1', bodyCopy: 'tale', status: 'DRAFT', mediaFileIds: [] }) },
      after: {
        data: () => ({
          kinfolkId: 'fam1',
          bodyCopy: 'tale',
          status: 'SENT',
          mediaFileIds: [],
          sentVia: 'catalog',
          deliveryReceiptId: 'disp_1',
        }),
      },
    },
  } as any);
}

describe('a KinTale send notifies the household exactly once', () => {
  it('Android/wasm: callable + trigger together produce ONE notification', async () => {
    await androidSendTap();

    expect(enqueuedKeys()).toEqual(['kincare.report.sent']);
  });

  it('React web: the trigger alone produces ONE notification', async () => {
    await onKinTaleUpdateHandler({
      params: { reportId: 'r1' },
      data: {
        before: { data: () => ({ kinfolkId: 'fam1', bodyCopy: 'tale', status: 'DRAFT', mediaFileIds: [] }) },
        after: {
          data: () => ({
            kinfolkId: 'fam1',
            bodyCopy: 'tale',
            status: 'SENT',
            mediaFileIds: [],
            sentVia: 'pending',
            deliveryReceiptId: '',
          }),
        },
      },
    } as any);

    expect(enqueuedKeys()).toEqual(['kintale.published']);
  });

  it('the Android send tap still gets its dispatch ids back for the delivery receipt', async () => {
    const res = await dispatchVisitNotificationHandler({
      data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'report_sent' },
      auth: { uid: 'uid_auntie', token: { name: 'TiTi' } },
    } as any);

    expect(res).toEqual({ ok: true, dispatchIds: ['disp_1'], suppressed: false });
  });
});
