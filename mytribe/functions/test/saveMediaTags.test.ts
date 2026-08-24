import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
// #557: this suite drives handlers through the wrapper, which now checks session
// revocation. Stub it out — see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));

import { saveMediaTagsHandler, MAX_TAGGED_KIN } from '../src/admin/saveMediaTags';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * One household photo (`fam1`), two kin of that household, and one kin of a
 * DIFFERENT household. That last one is the fixture the whole household-scope
 * rule exists for: before this callable it was a perfectly legal write.
 */
function ctxFor(
  opts: { media?: Record<string, unknown> | null; kin?: Record<string, Record<string, unknown> | null> } = {},
) {
  const media =
    opts.media === undefined
      ? { kinfolkId: 'fam1', storageUrl: 'https://cdn/full.jpg', taggedKinIds: ['k1'] }
      : opts.media;
  const kin = opts.kin ?? {
    'kin/k1': { kinfolkId: 'fam1', name: 'Waddles' },
    'kin/k2': { kinfolkId: 'fam1', name: 'Biscuit' },
    'kin/other': { kinfolkId: 'fam9', name: 'Stranger' },
  };
  return buildDbMock({ docs: { 'media_files/m1': media, ...kin } });
}

function tagWrite(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.find((w) => w.path === 'media_files/m1');
}

// ── authorisation ───────────────────────────────────────────────────────────

describe('saveMediaTags authorisation', () => {
  it('ALLOWS a caller carrying the admin claim', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    const guarded = wrapAdminCallable('saveMediaTags', saveMediaTagsHandler);

    const res = await guarded({
      data: { mediaFileId: 'm1', taggedKinIds: ['k1', 'k2'] },
      auth: { uid: 'admin1', token: { admin: true } },
    } as unknown as CallableRequest<unknown>);

    expect(res).toMatchObject({ ok: true, taggedKinIds: ['k1', 'k2'] });
    expect(tagWrite(ctx)!.data.taggedKinIds).toEqual(['k1', 'k2']);
  });

  it('DENIES a signed-in caller without the admin claim, and writes nothing', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    const guarded = wrapAdminCallable('saveMediaTags', saveMediaTagsHandler);

    await expect(
      guarded({
        data: { mediaFileId: 'm1', taggedKinIds: ['k1'] },
        auth: { uid: 'kinfolk-9', token: {} },
      } as unknown as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(ctx.writes).toHaveLength(0);
  });

  it('DENIES an unauthenticated caller, and writes nothing', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    const guarded = wrapAdminCallable('saveMediaTags', saveMediaTagsHandler);

    await expect(
      guarded({ data: { mediaFileId: 'm1', taggedKinIds: [] } } as unknown as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    expect(ctx.writes).toHaveLength(0);
  });

  it('the bare handler still refuses a request with no uid', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: [] }, null)),
    ).rejects.toThrow(/Sign-in/);
  });
});

// ── validation ──────────────────────────────────────────────────────────────

describe('saveMediaTags validation', () => {
  it('rejects a blank mediaFileId', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(saveMediaTagsHandler(req({ mediaFileId: '', taggedKinIds: [] }))).rejects.toThrow(
      /validation failed/,
    );
    expect(ctx.writes).toHaveLength(0);
  });

  it('rejects a taggedKinIds that is not an array', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: 'k1' })),
    ).rejects.toThrow(/validation failed/);
  });

  it('rejects a list longer than MAX_TAGGED_KIN', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    const tooMany = Array.from({ length: MAX_TAGGED_KIN + 1 }, (_, i) => `k${i}`);
    await expect(
      saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: tooMany })),
    ).rejects.toThrow(/validation failed/);
    expect(ctx.writes).toHaveLength(0);
  });

  it('names the offending field in the error details', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: [''] })),
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      details: { validationErrors: [expect.objectContaining({ path: 'taggedKinIds.0' })] },
    });
  });

  it('404s when the media doc no longer exists', async () => {
    const ctx = ctxFor({ media: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: ['k1'] })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('404s, naming the id, when a tagged kin does not exist', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: ['k1', 'ghost'] })),
    ).rejects.toThrow(/ghost/);
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a kin from a DIFFERENT household than the photo', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: ['other'] })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('allows ANY kin when the photo has no household (company/unattached media)', async () => {
    const ctx = ctxFor({ media: { storageUrl: 'https://cdn/company.jpg' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: ['other'] }));
    expect(res.taggedKinIds).toEqual(['other']);
    expect(tagWrite(ctx)!.data.taggedKinIds).toEqual(['other']);
  });
});

// ── effects ─────────────────────────────────────────────────────────────────

describe('saveMediaTags effects', () => {
  it('writes taggedKinIds as a MERGE of that one field, never a rebuilt doc', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: ['k2'] }));

    const w = tagWrite(ctx)!;
    expect(w.merge).toBe(true);
    expect(Object.keys(w.data)).toEqual(['taggedKinIds']);
    expect(w.data.taggedKinIds).toEqual(['k2']);
  });

  it('an empty list clears every tag (untagging is a real edit, not a no-op)', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: [] }));
    expect(res.taggedKinIds).toEqual([]);
    expect(tagWrite(ctx)!.data.taggedKinIds).toEqual([]);
  });

  it('de-duplicates and trims, keeping first-seen order', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await saveMediaTagsHandler(
      req({ mediaFileId: 'm1', taggedKinIds: ['k2', ' k1 ', 'k2'] }),
    );
    expect(res.taggedKinIds).toEqual(['k2', 'k1']);
    expect(tagWrite(ctx)!.data.taggedKinIds).toEqual(['k2', 'k1']);
  });

  it('writes a MEDIA_TAGS_UPDATED audit entry carrying the before AND after lists', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: ['k2'] }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'MEDIA_TAGS_UPDATED',
        actorUid: 'admin1',
        payload: expect.objectContaining({
          mediaFileId: 'm1',
          kinfolkId: 'fam1',
          taggedKinIds: ['k2'],
          previousTaggedKinIds: ['k1'],
        }),
      }),
    );
  });

  it('reads a malformed stored taggedKinIds as empty rather than throwing', async () => {
    const ctx = ctxFor({ media: { kinfolkId: 'fam1', taggedKinIds: 'k1' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveMediaTagsHandler(req({ mediaFileId: 'm1', taggedKinIds: ['k1'] }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ previousTaggedKinIds: [] }) }),
    );
  });
});
