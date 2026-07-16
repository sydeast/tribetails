import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: Function) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.resolveUid.mockReset();
  mocks.dbFn.mockReset();
});

import { onKinTaleCommentCreateHandler } from '../src/triggers/onKinTaleCommentCreate';

describe('onKinTaleCommentCreate trigger', () => {
  it('reads kinfolkId from parent report and dispatches kintale.comment.added for admin authors', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/r1': { kinfolkId: 'fam3' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCommentCreateHandler({
      params: { reportId: 'r1', commentId: 'c1' },
      data: {
        data: () => ({ authorUid: 'admin1', authorRole: 'admin', body: 'Great job!' }),
      },
    } as any);

    expect(mocks.resolveUid).toHaveBeenCalledWith('fam3');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.comment.added',
        recipientUid: 'uid_kinfolk',
        data: expect.objectContaining({ kinfolkId: 'fam3', taleId: 'r1', commentId: 'c1' }),
      }),
    );
  });

  it('dispatches kintale.comment.added for kinfolk-authored comments', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/r1': { kinfolkId: 'fam3' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCommentCreateHandler({
      params: { reportId: 'r1', commentId: 'cKin' },
      data: {
        data: () => ({ authorUid: 'kinUid', authorRole: 'kinfolk', body: 'thanks!' }),
      },
    } as any);

    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.comment.added',
        recipientUid: 'uid_kinfolk',
      }),
    );
  });

  it('skips dispatch when parent report has no kinfolkId', async () => {
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/r1': {} },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleCommentCreateHandler({
      params: { reportId: 'r1', commentId: 'c1' },
      data: { data: () => ({ body: 'hi' }) },
    } as any);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
