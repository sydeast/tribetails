import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
  writeAuditEntryFn: vi.fn().mockResolvedValue(undefined),
  trackerGet: vi.fn().mockResolvedValue({ data: () => undefined }),
  trackerSet: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: Function) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
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

describe('onKinTaleUpdate trigger', () => {
  it('HAPPY: post-publish bodyCopy edit fires kintale.note.added', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'first note', status: 'SENT', mediaFileIds: [] },
      { kinfolkId: 'fam1', bodyCopy: 'first note. midway update.', status: 'SENT', mediaFileIds: [] },
    ));
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
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.note.added',
        data: expect.objectContaining({ mediaAdded: true, addedMediaCount: 2, bodyChanged: false }),
      }),
    );
  });

  it('SAD: DRAFT-side updates do NOT fire (kinfolk only sees SENT)', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: '', status: 'DRAFT', mediaFileIds: [] },
      { kinfolkId: 'fam1', bodyCopy: 'auntie typing...', status: 'DRAFT', mediaFileIds: [] },
    ));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('SAD: initial DRAFT → SENT transition does NOT fire (covered by kintale.published)', async () => {
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'narrative', status: 'DRAFT', mediaFileIds: ['m1'] },
      { kinfolkId: 'fam1', bodyCopy: 'narrative', status: 'SENT', mediaFileIds: ['m1'] },
    ));
    expect(mocks.enqueue).not.toHaveBeenCalled();
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
