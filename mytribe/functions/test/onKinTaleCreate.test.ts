import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
  claim: vi.fn().mockResolvedValue(true),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
// Only the Firestore-backed claim is mocked; `clientAlreadyAnnouncedSend` is a
// pure predicate and runs for real.
vi.mock('../src/lib/kinTalePublishClaim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/kinTalePublishClaim')>()),
  claimKinTalePublish: mocks.claim,
}));

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.resolveUid.mockReset();
  mocks.dbFn.mockReset();
  mocks.claim.mockReset().mockResolvedValue(true);
});

import { onKinTaleCreateHandler } from '../src/triggers/onKinTaleCreate';

function makeEvent(data: Record<string, unknown>, reportId = 'r1') {
  return { params: { reportId }, data: { data: () => data } } as any;
}

describe('onKinTaleCreate trigger', () => {
  it('HAPPY: a report created straight to SENT dispatches kintale.published once', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler(
      makeEvent({
        kinfolkId: 'fam3',
        status: 'SENT',
        bodyCopy: 'Great visit!',
        authorDisplayName: 'TiTi',
      }),
    );

    expect(mocks.resolveUid).toHaveBeenCalledWith('fam3');
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.published',
        recipientUid: 'uid_kinfolk',
        data: expect.objectContaining({ kinfolkId: 'fam3', taleId: 'r1' }),
      }),
    );
  });

  it('SAD: a DRAFT create is silent — the household must not hear about a tale it cannot open', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler(
      makeEvent({ kinfolkId: 'fam3', status: 'DRAFT', bodyCopy: 'auntie typing...' }),
    );

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('SAD: a create with no status at all is treated as not-yet-published', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler(makeEvent({ kinfolkId: 'fam3', bodyCopy: 'tale' }));

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('SAD: a SENT create the client already dispatched (sentVia=catalog) does not double-notify', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler(
      makeEvent({ kinfolkId: 'fam3', status: 'SENT', sentVia: 'catalog', bodyCopy: 'tale' }),
    );

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('SAD: a lost publish claim (trigger replay) does not re-notify', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');
    mocks.claim.mockResolvedValue(false);

    await onKinTaleCreateHandler(
      makeEvent({ kinfolkId: 'fam3', status: 'SENT', bodyCopy: 'tale' }),
    );

    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('SAD: a SENT report missing kinfolkId logs and returns without throwing', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await expect(
      onKinTaleCreateHandler(makeEvent({ status: 'SENT', bodyCopy: 'tale' })),
    ).resolves.toBeUndefined();

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
