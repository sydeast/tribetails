import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { deleteMediaFileHandler } from '../src/admin/deleteMediaFile';
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

const MEDIA = {
  storageUrl: 'https://cdn/full.jpg',
  thumbnailUrl: 'https://cdn/thumb.jpg',
  entityId: 'fam1',
  entityType: 'KINFOLK',
  originalFileName: 'porch.jpg',
  isProfilePhoto: true,
};

/** Media doc under `media_files/m1`, plus whatever the owning entity currently holds. */
function ctxFor(opts: {
  media?: Record<string, unknown> | null;
  entity?: Record<string, unknown> | null;
  entityPath?: string;
} = {}) {
  const media = opts.media === undefined ? MEDIA : opts.media;
  const docs: Record<string, Record<string, unknown> | null> = { 'media_files/m1': media };
  if (opts.entity !== undefined) docs[opts.entityPath ?? 'kinfolk/fam1'] = opts.entity;
  return buildDbMock({ docs });
}

describe('deleteMediaFile validation', () => {
  it('rejects a missing uid (unauthenticated)', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(deleteMediaFileHandler(req({ mediaFileId: 'm1' }, null))).rejects.toThrow(/Sign-in/);
  });

  it('rejects a blank mediaFileId (invalid-argument)', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(deleteMediaFileHandler(req({ mediaFileId: '' }))).rejects.toThrow(/validation failed/);
    expect(ctx.deletes).toHaveLength(0);
  });

  it('not-found when the media doc is absent, and deletes nothing', async () => {
    const ctx = ctxFor({ media: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(deleteMediaFileHandler(req({ mediaFileId: 'm1' }))).rejects.toThrow(/not found/);
    expect(ctx.deletes).toHaveLength(0);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('failed-precondition when the scoped caller names a different entity', async () => {
    const ctx = ctxFor();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      deleteMediaFileHandler(req({ mediaFileId: 'm1', entityId: 'someone-else' })),
    ).rejects.toThrow(/different entity/);
    // The refusal must be total: no row deleted, no profile field touched.
    expect(ctx.deletes).toHaveLength(0);
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('deleteMediaFile effects', () => {
  it('deletes the row and clears kinfolk.profilePictureUrl when it points at this doc', async () => {
    const ctx = ctxFor({ entity: { profilePictureUrl: 'https://cdn/full.jpg' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteMediaFileHandler(req({ mediaFileId: 'm1', entityId: 'fam1' }));

    expect(res.ok).toBe(true);
    expect(res.clearedProfilePhoto).toBe(true);
    expect(ctx.deletes).toContain('media_files/m1');
    const write = ctx.writes.find((w) => w.path === 'kinfolk/fam1');
    expect(write!.data.profilePictureUrl).toBe('');
    expect(write!.data.updatedAt).toBe('__TS__');
  });

  it('clears on a THUMBNAIL match too (some writers stamp the thumbnail URL)', async () => {
    const ctx = ctxFor({ entity: { profilePictureUrl: 'https://cdn/thumb.jpg' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteMediaFileHandler(req({ mediaFileId: 'm1' }));
    expect(res.clearedProfilePhoto).toBe(true);
    expect(ctx.writes.find((w) => w.path === 'kinfolk/fam1')!.data.profilePictureUrl).toBe('');
  });

  it('leaves a profile picture set from somewhere else alone', async () => {
    const ctx = ctxFor({ entity: { profilePictureUrl: 'https://cdn/some-other-photo.jpg' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteMediaFileHandler(req({ mediaFileId: 'm1' }));
    expect(res.clearedProfilePhoto).toBe(false);
    expect(ctx.deletes).toContain('media_files/m1');
    expect(ctx.writes.some((w) => w.path === 'kinfolk/fam1')).toBe(false);
  });

  it('never promotes a replacement photo', async () => {
    const ctx = ctxFor({ entity: { profilePictureUrl: 'https://cdn/full.jpg' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await deleteMediaFileHandler(req({ mediaFileId: 'm1' }));
    const write = ctx.writes.find((w) => w.path === 'kinfolk/fam1');
    expect(write!.data.profilePictureUrl).toBe('');
    // Only the clear + its timestamp; nothing that looks like a promoted URL.
    expect(Object.keys(write!.data).sort()).toEqual(['profilePictureUrl', 'updatedAt']);
  });

  it('KIN media clears kin/{id}.profilePictureUrl', async () => {
    const ctx = ctxFor({
      media: { ...MEDIA, entityId: 'pet1', entityType: 'KIN' },
      entity: { profilePictureUrl: 'https://cdn/full.jpg' },
      entityPath: 'kin/pet1',
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteMediaFileHandler(req({ mediaFileId: 'm1', entityId: 'pet1' }));
    expect(res.clearedProfilePhoto).toBe(true);
    expect(ctx.writes.find((w) => w.path === 'kin/pet1')!.data.profilePictureUrl).toBe('');
  });

  it('USER media clears users/{uid}.photoUrl, not profilePictureUrl', async () => {
    const ctx = ctxFor({
      media: { ...MEDIA, entityId: 'u1', entityType: 'USER' },
      entity: { photoUrl: 'https://cdn/full.jpg' },
      entityPath: 'users/u1',
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await deleteMediaFileHandler(req({ mediaFileId: 'm1', entityId: 'u1' }));
    const write = ctx.writes.find((w) => w.path === 'users/u1');
    expect(write!.data.photoUrl).toBe('');
    expect(write!.data.profilePictureUrl).toBeUndefined();
  });

  it('lower-case entityType still resolves the owning entity', async () => {
    const ctx = ctxFor({
      media: { ...MEDIA, entityType: 'kinfolk' },
      entity: { profilePictureUrl: 'https://cdn/full.jpg' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteMediaFileHandler(req({ mediaFileId: 'm1', entityId: 'fam1' }));
    expect(res.clearedProfilePhoto).toBe(true);
    expect(ctx.writes.find((w) => w.path === 'kinfolk/fam1')!.data.profilePictureUrl).toBe('');
  });

  it('BUSINESS media deletes the row and invents no entity doc to write to', async () => {
    const ctx = ctxFor({ media: { ...MEDIA, entityId: 'business_settings', entityType: 'BUSINESS' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteMediaFileHandler(req({ mediaFileId: 'm1' }));
    expect(res.clearedProfilePhoto).toBe(false);
    expect(ctx.deletes).toContain('media_files/m1');
    expect(ctx.writes).toHaveLength(0);
  });

  it('writes a MEDIA_FILE_DELETED audit entry carrying the storageUrl', async () => {
    const ctx = ctxFor({ entity: { profilePictureUrl: 'https://cdn/full.jpg' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await deleteMediaFileHandler(req({ mediaFileId: 'm1', entityId: 'fam1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'MEDIA_FILE_DELETED',
        actorUid: 'admin1',
        payload: expect.objectContaining({
          mediaFileId: 'm1',
          entityId: 'fam1',
          entityType: 'KINFOLK',
          storageUrl: 'https://cdn/full.jpg',
          originalFileName: 'porch.jpg',
          clearedProfilePhoto: true,
        }),
      }),
    );
  });
});
