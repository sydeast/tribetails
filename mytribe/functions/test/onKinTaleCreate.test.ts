import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.resolveUid.mockReset();
  mocks.dbFn.mockReset();
});

import { onKinTaleCreateHandler } from '../src/triggers/onKinTaleCreate';

describe('onKinTaleCreate trigger', () => {
  it('reads kinfolkId from doc data and dispatches kintale.published', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler({
      params: { reportId: 'r1' },
      data: {
        data: () => ({
          kinfolkId: 'fam3',
          bodyCopy: 'Great visit!',
          authorDisplayName: 'TiTi',
        }),
      },
    } as any);

    expect(mocks.resolveUid).toHaveBeenCalledWith('fam3');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.published',
        recipientUid: 'uid_kinfolk',
        data: expect.objectContaining({ kinfolkId: 'fam3', taleId: 'r1' }),
      }),
    );
  });

  it('skips dispatch when kinfolkId missing from doc', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler({
      params: { reportId: 'r1' },
      data: { data: () => ({ bodyCopy: 'tale' }) },
    } as any);

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
