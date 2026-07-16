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

import { setMediaProfilePhotoHandler } from '../src/admin/setMediaProfilePhoto';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** Builds the mock with the chosen media doc + optional sibling profile doc. */
function ctxFor(opts: {
  chosen?: Record<string, unknown> | null;
  siblings?: Array<{ id: string; data: Record<string, unknown> }>;
}) {
  const chosen = opts.chosen === undefined
    ? { storageUrl: 'https://cdn/full.jpg', entityId: 'fam1', entityType: 'KINFOLK', isProfilePhoto: false }
    : opts.chosen;
  return buildDbMock({
    docs: { 'media_files/m1': chosen },
    queryDocs: { media_files: opts.siblings ?? [] },
  });
}

describe('setMediaProfilePhoto validation', () => {
  it('rejects missing uid (unauthenticated)', async () => {
    const ctx = ctxFor({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1' }, null)),
    ).rejects.toThrow(/Sign-in/);
  });

  it('rejects blank mediaFileId (invalid-argument)', async () => {
    const ctx = ctxFor({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setMediaProfilePhotoHandler(req({ mediaFileId: '', entityType: 'KINFOLK', entityId: 'fam1' })),
    ).rejects.toThrow(/validation failed/);
  });

  it('404 not-found when the media doc is absent', async () => {
    const ctx = ctxFor({ chosen: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1' })),
    ).rejects.toThrow(/not found/);
  });

  it('failed-precondition when the doc belongs to a different entity', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/full.jpg', entityId: 'OTHER', entityType: 'KINFOLK' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1' })),
    ).rejects.toThrow(/different entity/);
  });

  it('failed-precondition when the doc has no storageUrl', async () => {
    const ctx = ctxFor({ chosen: { entityId: 'fam1', entityType: 'KINFOLK' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1' })),
    ).rejects.toThrow(/no storageUrl/);
  });
});

describe('setMediaProfilePhoto effects', () => {
  it('KINFOLK: marks chosen, clears sibling, stamps kinfolk.profilePictureUrl', async () => {
    const ctx = ctxFor({
      siblings: [
        { id: 'm0', data: { isProfilePhoto: true } },
        { id: 'm1', data: { isProfilePhoto: true } },
      ],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await setMediaProfilePhotoHandler(
      req({ mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1' }),
    );
    expect(res.ok).toBe(true);
    expect(res.photoUrl).toBe('https://cdn/full.jpg');

    const chosenWrite = ctx.writes.find((w) => w.path === 'media_files/m1');
    expect(chosenWrite!.data.isProfilePhoto).toBe(true);
    const sibWrite = ctx.writes.find((w) => w.path === 'media_files/m0');
    expect(sibWrite!.data.isProfilePhoto).toBe(false);
    // chosen is not also cleared
    expect(ctx.writes.filter((w) => w.path === 'media_files/m1' && w.data.isProfilePhoto === false))
      .toHaveLength(0);

    const entWrite = ctx.writes.find((w) => w.path === 'kinfolk/fam1');
    expect(entWrite!.data.profilePictureUrl).toBe('https://cdn/full.jpg');
    expect(entWrite!.data.updatedAt).toBe('__TS__');
  });

  it('KIN: stamps kin.profilePictureUrl', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/pet.jpg', entityId: 'pet1', entityType: 'KIN' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'KIN', entityId: 'pet1' }));
    const entWrite = ctx.writes.find((w) => w.path === 'kin/pet1');
    expect(entWrite!.data.profilePictureUrl).toBe('https://cdn/pet.jpg');
  });

  it('USER: stamps users/{uid}.photoUrl (not profilePictureUrl)', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/me.jpg', entityId: 'u1', entityType: 'USER' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'USER', entityId: 'u1' }));
    const entWrite = ctx.writes.find((w) => w.path === 'users/u1');
    expect(entWrite!.data.photoUrl).toBe('https://cdn/me.jpg');
    expect(entWrite!.data.profilePictureUrl).toBeUndefined();
  });

  it('accepts lowercase entityType casing and still stamps the entity', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/full.jpg', entityId: 'fam1', entityType: 'kinfolk' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'kinfolk', entityId: 'fam1' }));
    const entWrite = ctx.writes.find((w) => w.path === 'kinfolk/fam1');
    expect(entWrite!.data.profilePictureUrl).toBe('https://cdn/full.jpg');
  });

  it('unknown entityType: flips the flag but writes NO entity doc', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/x.jpg', entityId: 'k1', entityType: 'KINTALE' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'KINTALE', entityId: 'k1' }));
    expect(ctx.writes.find((w) => w.path === 'media_files/m1')!.data.isProfilePhoto).toBe(true);
    expect(ctx.writes.some((w) => !w.path.startsWith('media_files/'))).toBe(false);
  });

  it('writes a PROFILE_UPDATED audit entry', async () => {
    const ctx = ctxFor({});
    mocks.dbFn.mockReturnValue(ctx.db);
    await setMediaProfilePhotoHandler(req({ mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROFILE_UPDATED',
        actorUid: 'admin1',
        payload: expect.objectContaining({ mediaFileId: 'm1', entityId: 'fam1', entityType: 'KINFOLK' }),
      }),
    );
  });
});
