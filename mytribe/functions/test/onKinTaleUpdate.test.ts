import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
  writeAuditEntryFn: vi.fn().mockResolvedValue(undefined),
  trackerGet: vi.fn().mockResolvedValue({ data: () => undefined }),
  trackerSet: vi.fn().mockResolvedValue(undefined),
  claim: vi.fn().mockResolvedValue(true),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
// Only the Firestore-backed claim is mocked; `clientAlreadyAnnouncedSend` is a
// pure predicate and runs for real.
vi.mock('../src/lib/kinTalePublishClaim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/kinTalePublishClaim')>()),
  claimKinTalePublish: mocks.claim,
}));
// HWM tracker reads/writes kinTaleNotifications/{reportId} via db().
// Default mock returns "no prior notification" → trigger fires normally.
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: () => ({ get: mocks.trackerGet, set: mocks.trackerSet }),
  }),
}));

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.resolveUid.mockReset().mockResolvedValue('uid_kinfolk');
  mocks.writeAuditEntryFn.mockReset().mockResolvedValue(undefined);
  mocks.trackerGet.mockReset().mockResolvedValue({ data: () => undefined });
  mocks.trackerSet.mockReset().mockResolvedValue(undefined);
  mocks.claim.mockReset().mockResolvedValue(true);
});

import { onKinTaleUpdateHandler } from '../src/triggers/onKinTaleUpdate';

function makeEvent(before: any, after: any, reportId = 'r1') {
  return {
    params: { reportId },
    data: {
      before: { data: () => before },
      after: { data: () => after },
    },
  } as any;
}

/** Every key the handler enqueued, in order. */
function enqueuedKeys(): string[] {
  return mocks.enqueue.mock.calls.map((c) => (c[0] as { key: string }).key);
}

describe('onKinTaleUpdate trigger — the DRAFT → SENT publish', () => {
  it('HAPPY: the send fires kintale.published exactly once', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'narrative', status: 'DRAFT', mediaFileIds: ['m1'], sentVia: '' },
      { kinfolkId: 'fam1', bodyCopy: 'narrative', status: 'SENT', mediaFileIds: ['m1'], sentVia: 'pending' },
    ));

    expect(enqueuedKeys()).toEqual(['kintale.published']);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.published',
        recipientUid: 'uid_kinfolk',
        targetType: 'kintale',
        targetId: 'r1',
        data: expect.objectContaining({ kinfolkId: 'fam1', taleId: 'r1' }),
      }),
    );
  });

  it('HAPPY: the send that also grows the body still emits ONLY kintale.published', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'draft text', status: 'DRAFT', mediaFileIds: [] },
      { kinfolkId: 'fam1', bodyCopy: 'draft text, plus a final polish', status: 'SENT', mediaFileIds: ['m1'] },
    ));

    expect(enqueuedKeys()).toEqual(['kintale.published']);
  });

  it('SAD: the Android/wasm send tap already dispatched (sentVia=catalog), so the trigger stays silent', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'narrative', status: 'DRAFT', mediaFileIds: ['m1'], sentVia: '' },
      {
        kinfolkId: 'fam1',
        bodyCopy: 'narrative',
        status: 'SENT',
        mediaFileIds: ['m1'],
        sentVia: 'catalog',
        deliveryReceiptId: 'disp_1',
      },
    ));

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('SAD: a lost publish claim (trigger replay of the same send) does not re-notify', async () => {
    mocks.claim.mockResolvedValue(false);

    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'narrative', status: 'DRAFT', mediaFileIds: [] },
      { kinfolkId: 'fam1', bodyCopy: 'narrative', status: 'SENT', mediaFileIds: [] },
    ));

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('SAD: a send with no kinfolkId logs and returns without throwing', async () => {
    await expect(onKinTaleUpdateHandler(makeEvent(
      { bodyCopy: 'narrative', status: 'DRAFT', mediaFileIds: [] },
      { bodyCopy: 'narrative', status: 'SENT', mediaFileIds: [] },
    ))).resolves.toBeUndefined();

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('SAD: an unsend (SENT → DRAFT) fires nothing', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'a', status: 'SENT', mediaFileIds: [] },
      { kinfolkId: 'fam1', bodyCopy: 'a b c', status: 'DRAFT', mediaFileIds: [] },
    ));

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('onKinTaleUpdate trigger — post-publish notes', () => {
  it('HAPPY: post-publish bodyCopy edit fires kintale.note.added, never kintale.published', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'first note', status: 'SENT', mediaFileIds: [] },
      { kinfolkId: 'fam1', bodyCopy: 'first note. midway update.', status: 'SENT', mediaFileIds: [] },
    ));
    expect(enqueuedKeys()).toEqual(['kintale.note.added']);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.note.added',
        recipientUid: 'uid_kinfolk',
        data: expect.objectContaining({ kinfolkId: 'fam1', taleId: 'r1', bodyChanged: true, mediaAdded: false }),
      }),
    );
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'CONTENT_KINTALE_NOTE_ADDED', actorRole: 'AUNTIE' }),
    );
  });

  it('HAPPY: post-publish media addition fires kintale.note.added', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'same', status: 'SENT', mediaFileIds: ['m1'] },
      { kinfolkId: 'fam1', bodyCopy: 'same', status: 'SENT', mediaFileIds: ['m1', 'm2', 'm3'] },
    ));
    expect(enqueuedKeys()).toEqual(['kintale.note.added']);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.note.added',
        data: expect.objectContaining({ mediaAdded: true, addedMediaCount: 2, bodyChanged: false }),
      }),
    );
  });

  it('HAPPY: a note on a tale sent from Android (sentVia=catalog) still fires', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'first', status: 'SENT', mediaFileIds: [], sentVia: 'catalog' },
      { kinfolkId: 'fam1', bodyCopy: 'first, and more', status: 'SENT', mediaFileIds: [], sentVia: 'catalog' },
    ));
    expect(enqueuedKeys()).toEqual(['kintale.note.added']);
  });

  it('SAD: DRAFT-side updates do NOT fire (kinfolk only sees SENT)', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: '', status: 'DRAFT', mediaFileIds: [] },
      { kinfolkId: 'fam1', bodyCopy: 'auntie typing...', status: 'DRAFT', mediaFileIds: [] },
    ));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('SAD: status-only flip or unrelated edit does NOT fire', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'same', status: 'SENT', mediaFileIds: ['m1'], triageStatus: '' },
      { kinfolkId: 'fam1', bodyCopy: 'same', status: 'SENT', mediaFileIds: ['m1'], triageStatus: 'assigned' },
    ));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('SAD: missing kinfolkId logs warn but does not crash', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { bodyCopy: 'a', status: 'SENT', mediaFileIds: [] },
      { bodyCopy: 'b', status: 'SENT', mediaFileIds: [] },
    ));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
