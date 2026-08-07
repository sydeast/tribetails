import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
  claim: vi.fn().mockResolvedValue(true),
  seedReconcile: vi.fn().mockResolvedValue('seeded'),
}));
vi.mock('../src/lib/reconcileStatus', () => ({ seedReconcileStatus: mocks.seedReconcile }));
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
  mocks.claim.mockReset().mockResolvedValue(true);
  mocks.seedReconcile.mockReset().mockResolvedValue('seeded');
  // Default: an empty Firestore double. Tests that care about the thumbs
  // write (media docs, `.writes`, `.getAll` call count) build their own
  // `buildDbMock` fixture and override this return value.
  mocks.dbFn.mockReset().mockReturnValue(buildDbMock({}).db);
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

  it('enrols a DRAFT create in the reconcile pipeline, which is the case the notification path skips', async () => {
    // Both admin clients create a draft first, so gating enrolment on SENT
    // would leave the normal KinTale out of the pipeline entirely.
    await onKinTaleCreateHandler(makeEvent({ kinfolkId: 'fam3', status: 'DRAFT' }, 'r-draft'));

    expect(mocks.seedReconcile).toHaveBeenCalledWith('r-draft');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('still announces the send when enrolment throws', async () => {
    mocks.seedReconcile.mockRejectedValue(new Error('firestore unavailable'));
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');

    await onKinTaleCreateHandler(makeEvent({ kinfolkId: 'fam3', status: 'SENT', bodyCopy: 'tale' }));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});

/**
 * Denormalized feed thumbnails (task-24a): `onKinTaleCreate` stamps
 * `kin_care_reports.thumbs` from `mediaFileIds` at create time so
 * `getMyKinTales` never resolves media docs on the hot path. Runs before the
 * SENT/notification gates — both admin clients create a DRAFT first, and a
 * draft's photos need thumbs just as much as a straight-to-SENT create's do.
 */
describe('onKinTaleCreate trigger — thumbs denormalization (task-24a)', () => {
  function mediaFixture(ids: string[]) {
    const docs: Record<string, Record<string, unknown>> = {};
    ids.forEach((id) => {
      docs[`media_files/${id}`] = { storageUrl: `https://cdn/${id}.jpg`, mimeType: 'image/jpeg' };
    });
    return docs;
  }

  function thumbsWrite(ctx: ReturnType<typeof buildDbMock>, reportId = 'r1') {
    return ctx.writes.find((w) => w.path === `kin_care_reports/${reportId}`);
  }

  it('a create with 12 media stores exactly 8 thumbs, in media order, via one batched read', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
    const ctx = buildDbMock({ docs: mediaFixture(ids) });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleCreateHandler(
      makeEvent({ kinfolkId: 'fam3', status: 'DRAFT', bodyCopy: 'draft', mediaFileIds: ids }),
    );

    const write = thumbsWrite(ctx);
    expect(write?.merge).toBe(true);
    expect(write?.data['thumbs']).toEqual(
      ids.slice(0, 8).map((id) => ({ id, url: `https://cdn/${id}.jpg`, contentType: 'image/jpeg' })),
    );
    expect(ctx.db.getAll).toHaveBeenCalledTimes(1);
  });

  it('a media doc that is missing or has no storageUrl contributes no entry and no placeholder', async () => {
    const ctx = buildDbMock({
      docs: {
        'media_files/ok1': { storageUrl: 'https://cdn/ok1.jpg', mimeType: 'image/jpeg' },
        'media_files/nourl1': { mimeType: 'image/jpeg' },
        // media_files/missing1 intentionally absent — a deleted doc.
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleCreateHandler(
      makeEvent({
        kinfolkId: 'fam3',
        status: 'DRAFT',
        bodyCopy: 'draft',
        mediaFileIds: ['ok1', 'missing1', 'nourl1'],
      }),
    );

    expect(thumbsWrite(ctx)?.data['thumbs']).toEqual([
      { id: 'ok1', url: 'https://cdn/ok1.jpg', contentType: 'image/jpeg' },
    ]);
  });

  it('a create with no media still stamps thumbs: [] so the feed-read fallback never has to run for it', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleCreateHandler(makeEvent({ kinfolkId: 'fam3', status: 'SENT', bodyCopy: 'no photos' }));

    expect(thumbsWrite(ctx)?.data['thumbs']).toEqual([]);
    expect(ctx.db.getAll).not.toHaveBeenCalled();
  });

  it('a thumbs-stamp failure is logged and does not block the send notification', async () => {
    mocks.resolveUid.mockResolvedValue('uid_kinfolk');
    const ctx = buildDbMock({});
    const originalDoc = ctx.db.doc.bind(ctx.db);
    ctx.db.doc = (path: string) => {
      const ref = originalDoc(path);
      if (path.startsWith('kin_care_reports/')) ref.set = vi.fn().mockRejectedValue(new Error('boom'));
      return ref;
    };
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleCreateHandler(
      makeEvent({ kinfolkId: 'fam3', status: 'SENT', bodyCopy: 'tale', mediaFileIds: ['m1'] }),
    );

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
