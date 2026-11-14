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
      // The sibling scan filters on entityId + entityType + isProfilePhoto, so
      // a fixture carrying only the flag is a doc real Firestore would never
      // return for this query.
      siblings: [
        { id: 'm0', data: { entityId: 'fam1', entityType: 'KINFOLK', isProfilePhoto: true } },
        { id: 'm1', data: { entityId: 'fam1', entityType: 'KINFOLK', isProfilePhoto: true } },
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
/**
 * #2287: an Auntie changes her Account photo through this callable. A staff
 * photo change applies only to the caller's own profile; the owner keeps the
 * reach he had.
 */
describe('#2287 setMediaProfilePhoto: a staff photo change applies to the caller own profile', () => {
  function staffReq(data: unknown, auth: { uid: string; token: Record<string, unknown> }) {
    return { data, auth, rawRequest: {}, acceptsStreaming: false } as unknown as CallableRequest<unknown>;
  }
  const auntie = { uid: 'auntie-1', token: { staffRole: 'auntie' } };
  it('HAPPY: an Auntie sets her own photo, and the line says she is the Auntie', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/me.jpg', entityId: 'auntie-1', entityType: 'USER' },
      siblings: [{ id: 'm0', data: { entityId: 'auntie-1', entityType: 'USER', isProfilePhoto: true } }],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await setMediaProfilePhotoHandler(
      staffReq({ mediaFileId: 'm1', entityType: 'USER', entityId: 'auntie-1' }, auntie),
    );
    expect(res.photoUrl).toBe('https://cdn/me.jpg');
    expect(ctx.writes.find((w) => w.path === 'users/auntie-1')!.data.photoUrl).toBe('https://cdn/me.jpg');
    expect(ctx.writes.find((w) => w.path === 'media_files/m0')!.data.isProfilePhoto).toBe(false);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'PROFILE_UPDATED',
        actorUid: 'auntie-1',
        payload: expect.objectContaining({ entityType: 'USER', entityId: 'auntie-1', admin: false, staffRole: 'auntie' }),
      }),
    );
  });
  it('NEGATIVE: an Auntie naming another user record is refused before anything is read or written', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/x.jpg', entityId: 'owner-1', entityType: 'USER' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    for (const entityType of ['USER', 'user', 'User']) {
      await expect(
        setMediaProfilePhotoHandler(staffReq({ mediaFileId: 'm1', entityType, entityId: 'owner-1' }, auntie)),
      ).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'You can change only your own account photo.',
      });
    }
    expect(ctx.writes).toHaveLength(0);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
  it('NEGATIVE: an account carrying both claims is held to the same rule', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/x.jpg', entityId: 'owner-1', entityType: 'USER' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const both = { uid: 'confused-1', token: { admin: true, staffRole: 'auntie' } };
    await expect(
      setMediaProfilePhotoHandler(staffReq({ mediaFileId: 'm1', entityType: 'USER', entityId: 'owner-1' }, both)),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });
  it('HAPPY: an Auntie still sets a household and a Kin photo', async () => {
    const household = ctxFor({});
    mocks.dbFn.mockReturnValue(household.db);
    await setMediaProfilePhotoHandler(
      staffReq({ mediaFileId: 'm1', entityType: 'KINFOLK', entityId: 'fam1' }, auntie),
    );
    expect(household.writes.find((w) => w.path === 'kinfolk/fam1')!.data.profilePictureUrl).toBe('https://cdn/full.jpg');
    const kin = ctxFor({ chosen: { storageUrl: 'https://cdn/pet.jpg', entityId: 'pet1', entityType: 'KIN' } });
    mocks.dbFn.mockReturnValue(kin.db);
    await setMediaProfilePhotoHandler(staffReq({ mediaFileId: 'm1', entityType: 'KIN', entityId: 'pet1' }, auntie));
    expect(kin.writes.find((w) => w.path === 'kin/pet1')!.data.profilePictureUrl).toBe('https://cdn/pet.jpg');
  });
  it('HAPPY: the owner sets a photo on a staff record that is not his own, as before', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/a.jpg', entityId: 'auntie-1', entityType: 'USER' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setMediaProfilePhotoHandler(
      staffReq({ mediaFileId: 'm1', entityType: 'USER', entityId: 'auntie-1' }, { uid: 'owner-1', token: { admin: true } }),
    );
    expect(ctx.writes.find((w) => w.path === 'users/auntie-1')!.data.photoUrl).toBe('https://cdn/a.jpg');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ admin: true, staffRole: null }) }),
    );
  });
  it('ERROR: a failed write surfaces and leaves no Activity Log line', async () => {
    const ctx = ctxFor({
      chosen: { storageUrl: 'https://cdn/me.jpg', entityId: 'auntie-1', entityType: 'USER' },
    });
    const commit = vi.fn().mockRejectedValue(new Error('firestore unavailable'));
    const realBatch = ctx.db.batch.bind(ctx.db);
    (ctx.db as { batch: unknown }).batch = () => ({ ...realBatch(), commit });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setMediaProfilePhotoHandler(staffReq({ mediaFileId: 'm1', entityType: 'USER', entityId: 'auntie-1' }, auntie)),
    ).rejects.toThrow('firestore unavailable');
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});
