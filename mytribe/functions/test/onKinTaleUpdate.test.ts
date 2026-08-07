import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn(),
  writeAuditEntryFn: vi.fn().mockResolvedValue(undefined),
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
// db() backs BOTH the HWM tracker (kinTaleNotifications/{reportId}) and the
// task-24a thumbs write-back (kin_care_reports/{reportId} + media_files
// getAll). Default fixture has no tracker doc ("no prior notification" -> the
// note-added path fires normally) and no media docs. Tests that care about
// the thumbs write build their own `buildDbMock` fixture.
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.resolveUid.mockReset().mockResolvedValue('uid_kinfolk');
  mocks.writeAuditEntryFn.mockReset().mockResolvedValue(undefined);
  mocks.claim.mockReset().mockResolvedValue(true);
  mocks.dbFn.mockReset().mockReturnValue(buildDbMock({}).db);
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

/**
 * Denormalized feed thumbnails (task-24a): `onKinTaleUpdate` keeps
 * `kin_care_reports.thumbs` in sync with `mediaFileIds` on every update, not
 * just the SENT moment — media routinely changes while a tale is still a
 * DRAFT, and thumbs has to track that. This is the read-cost fix's actual
 * write path.
 */
describe('onKinTaleUpdate trigger — thumbs denormalization (task-24a)', () => {
  function mediaFixture(entries: Record<string, { url: string; contentType: string }>) {
    const docs: Record<string, Record<string, unknown>> = {};
    for (const [id, { url, contentType }] of Object.entries(entries)) {
      docs[`media_files/${id}`] = { storageUrl: url, mimeType: contentType };
    }
    return docs;
  }

  function thumbsWrite(ctx: ReturnType<typeof buildDbMock>, reportId = 'r1') {
    return ctx.writes.find((w) => w.path === `kin_care_reports/${reportId}`);
  }

  it('adding a photo to an existing tale updates thumbs', async () => {
    const ctx = buildDbMock({
      docs: mediaFixture({
        m1: { url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
        m2: { url: 'https://cdn/m2.jpg', contentType: 'image/jpeg' },
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', status: 'DRAFT', mediaFileIds: ['m1'], thumbs: [{ id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' }] },
      { kinfolkId: 'fam1', status: 'DRAFT', mediaFileIds: ['m1', 'm2'] },
    ));

    expect(thumbsWrite(ctx)?.data['thumbs']).toEqual([
      { id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
      { id: 'm2', url: 'https://cdn/m2.jpg', contentType: 'image/jpeg' },
    ]);
  });

  it('removing a photo removes it from thumbs — the stale-URL case', async () => {
    const ctx = buildDbMock({
      docs: mediaFixture({
        m1: { url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
        m3: { url: 'https://cdn/m3.jpg', contentType: 'image/jpeg' },
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const before = {
      kinfolkId: 'fam1',
      status: 'SENT',
      mediaFileIds: ['m1', 'm2', 'm3'],
      thumbs: [
        { id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
        { id: 'm2', url: 'https://cdn/m2.jpg', contentType: 'image/jpeg' },
        { id: 'm3', url: 'https://cdn/m3.jpg', contentType: 'image/jpeg' },
      ],
    };
    const after = { kinfolkId: 'fam1', status: 'SENT', mediaFileIds: ['m1', 'm3'] };

    await onKinTaleUpdateHandler(makeEvent(before, after));

    expect(thumbsWrite(ctx)?.data['thumbs']).toEqual([
      { id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
      { id: 'm3', url: 'https://cdn/m3.jpg', contentType: 'image/jpeg' },
    ]);
  });

  it('reordering media without adding or removing any recomputes thumbs in the new order', async () => {
    const ctx = buildDbMock({
      docs: mediaFixture({
        m1: { url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
        m2: { url: 'https://cdn/m2.jpg', contentType: 'image/jpeg' },
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const before = {
      kinfolkId: 'fam1',
      status: 'DRAFT',
      mediaFileIds: ['m1', 'm2'],
      thumbs: [
        { id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
        { id: 'm2', url: 'https://cdn/m2.jpg', contentType: 'image/jpeg' },
      ],
    };
    const after = { kinfolkId: 'fam1', status: 'DRAFT', mediaFileIds: ['m2', 'm1'] };

    await onKinTaleUpdateHandler(makeEvent(before, after));

    expect(thumbsWrite(ctx)?.data['thumbs']).toEqual([
      { id: 'm2', url: 'https://cdn/m2.jpg', contentType: 'image/jpeg' },
      { id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
    ]);
  });

  it('media changing during a DRAFT (before any send) still stamps thumbs, not just the SENT moment', async () => {
    const ctx = buildDbMock({
      docs: mediaFixture({ m1: { url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' } }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', status: 'DRAFT', mediaFileIds: [] },
      { kinfolkId: 'fam1', status: 'DRAFT', mediaFileIds: ['m1'] },
    ));

    expect(thumbsWrite(ctx)?.data['thumbs']).toEqual([
      { id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' },
    ]);
    // Still a DRAFT throughout: the kinfolk-facing notification path stays silent.
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('writing thumbs back does NOT re-trigger the update trigger: unchanged media + already-stamped thumbs is a zero-Firestore-call no-op', async () => {
    const ctx = buildDbMock({
      docs: mediaFixture({ m1: { url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' } }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    // This is exactly the before/after pair the trigger's own thumbs write
    // produces on re-entry: mediaFileIds unchanged, thumbs now present.
    const stamped = {
      kinfolkId: 'fam1',
      status: 'DRAFT',
      mediaFileIds: ['m1'],
      thumbs: [{ id: 'm1', url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' }],
    };

    await onKinTaleUpdateHandler(makeEvent(stamped, stamped));

    expect(thumbsWrite(ctx)).toBeUndefined();
    expect(ctx.db.getAll).not.toHaveBeenCalled();
  });

  it('the loop terminates end to end: the write from a real media change does not itself cause a second write', async () => {
    const ctx = buildDbMock({
      docs: mediaFixture({ m1: { url: 'https://cdn/m1.jpg', contentType: 'image/jpeg' } }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    // Invocation 1: a real media change.
    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', status: 'DRAFT', mediaFileIds: [] },
      { kinfolkId: 'fam1', status: 'DRAFT', mediaFileIds: ['m1'] },
    ));
    const firstWrite = thumbsWrite(ctx);
    expect(firstWrite).toBeDefined();
    expect(ctx.writes.filter((w) => w.path === 'kin_care_reports/r1')).toHaveLength(1);

    // Invocation 2: the re-entrant call Firestore fires from that write —
    // mediaFileIds unchanged, thumbs now carries what invocation 1 wrote.
    const selfTriggered = { kinfolkId: 'fam1', status: 'DRAFT', mediaFileIds: ['m1'], thumbs: firstWrite!.data['thumbs'] };
    await onKinTaleUpdateHandler(makeEvent(selfTriggered, selfTriggered));

    expect(ctx.writes.filter((w) => w.path === 'kin_care_reports/r1')).toHaveLength(1);
  });

  it('a thumbs-stamp failure is logged and does not block the post-publish note notification', async () => {
    const ctx = buildDbMock({
      docs: mediaFixture({ m2: { url: 'https://cdn/m2.jpg', contentType: 'image/jpeg' } }),
    });
    const originalDoc = ctx.db.doc.bind(ctx.db);
    ctx.db.doc = (path: string) => {
      const ref = originalDoc(path);
      if (path.startsWith('kin_care_reports/')) ref.set = vi.fn().mockRejectedValue(new Error('boom'));
      return ref;
    };
    mocks.dbFn.mockReturnValue(ctx.db);

    await onKinTaleUpdateHandler(makeEvent(
      { kinfolkId: 'fam1', bodyCopy: 'same', status: 'SENT', mediaFileIds: ['m1'] },
      { kinfolkId: 'fam1', bodyCopy: 'same', status: 'SENT', mediaFileIds: ['m1', 'm2'] },
    ));

    expect(enqueuedKeys()).toEqual(['kintale.note.added']);
  });
});
