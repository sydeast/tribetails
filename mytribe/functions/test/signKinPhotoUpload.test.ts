import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  secretValues: {
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'key123',
    CLOUDINARY_API_SECRET: 'secret456',
  } as Record<string, string>,
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({ value: () => mocks.secretValues[name] }),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});

beforeEach(() => {
  mocks.dbFn.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
  mocks.secretValues = {
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'key123',
    CLOUDINARY_API_SECRET: 'secret456',
  };
});

function ctxWithKin() {
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['3'] },
      'families/3/kin/k1': { name: 'Buddy' },
    },
  });
}

const KINTALES_ONLY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: { billing_full: false, messaging_direct: false, messaging_group: false, kin_edit: false, kintales_only: true },
};

describe('signKinPhotoUploadHandler', () => {
  it('rejects unauthenticated', async () => {
    const { signKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      signKinPhotoUploadHandler({ data: { kinId: 'k1' }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('CRITICAL-4: denies a kintales_only secondary before ever signing', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/kin/k1': { name: 'Buddy' },
        'families/3/members/u1': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { signKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      signKinPhotoUploadHandler({ data: { kinfolkId: '3', kinId: 'k1' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('404s when the kin doc does not exist', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { signKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      signKinPhotoUploadHandler({ data: { kinfolkId: '3', kinId: 'ghost' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects wrong-tribe kinfolkId', async () => {
    const ctx = ctxWithKin();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { signKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      signKinPhotoUploadHandler({ data: { kinfolkId: '999', kinId: 'k1' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('throws failed-precondition when Cloudinary secrets are unset', async () => {
    mocks.secretValues.CLOUDINARY_API_SECRET = '';
    const ctx = ctxWithKin();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { signKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      signKinPhotoUploadHandler({ data: { kinfolkId: '3', kinId: 'k1' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('happy path: returns a signature scoped to this kin\'s own folder', async () => {
    const ctx = ctxWithKin();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { signKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    const res = await signKinPhotoUploadHandler({
      data: { kinfolkId: '3', kinId: 'k1' },
      auth: { uid: 'u1' },
    } as any);
    expect(res.cloudName).toBe('demo');
    expect(res.apiKey).toBe('key123');
    expect(res.folder).toBe('tribetails/kinfolks/3/kin/k1');
    expect(res.signature).toMatch(/^[a-f0-9]{40}$/);
    // #583: the callable hands the client the strip instruction it must echo,
    // so a kin photo's stored original carries no EXIF GPS. cloudinary.test.ts
    // proves this value is inside the signature base, not beside it.
    expect(res.transformation).toBe('fl_force_strip');
  });

  it('MULTIPLE linked households, kinfolkId omitted -> refuses to guess (PR28b)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3', '5'] },
        'families/3/kin/k1': { name: 'Buddy' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { signKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      signKinPhotoUploadHandler({ data: { kinId: 'k1' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it("MULTIPLE linked households, kinfolkId '' -> refuses to guess ('' pinned as omitted)", async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3', '5'] },
        'families/3/kin/k1': { name: 'Buddy' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { signKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      signKinPhotoUploadHandler({ data: { kinfolkId: '', kinId: 'k1' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('confirmKinPhotoUploadHandler', () => {
  const goodUrl = 'https://res.cloudinary.com/demo/image/upload/v1/tribetails/kinfolks/3/kin/k1/photo.jpg';

  it('rejects unauthenticated', async () => {
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      confirmKinPhotoUploadHandler({ data: { kinId: 'k1', secureUrl: goodUrl }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('CRITICAL-4: denies a kintales_only secondary and writes nothing', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'families/3/kin/k1': { name: 'Buddy' },
        'families/3/members/u1': KINTALES_ONLY_MEMBER,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      confirmKinPhotoUploadHandler({
        data: { kinfolkId: '3', kinId: 'k1', secureUrl: goodUrl },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('rejects a secureUrl from a different Cloudinary account', async () => {
    const ctx = ctxWithKin();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      confirmKinPhotoUploadHandler({
        data: {
          kinfolkId: '3',
          kinId: 'k1',
          secureUrl: 'https://res.cloudinary.com/someone-elses-cloud/image/upload/v1/tribetails/kinfolks/3/kin/k1/photo.jpg',
        },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('rejects a secureUrl outside the signed folder (cross-kin write attempt)', async () => {
    const ctx = ctxWithKin();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      confirmKinPhotoUploadHandler({
        data: {
          kinfolkId: '3',
          kinId: 'k1',
          secureUrl: 'https://res.cloudinary.com/demo/image/upload/v1/tribetails/kinfolks/3/kin/OTHER_KIN/photo.jpg',
        },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('rejects a non-Cloudinary URL (e.g. an attacker-supplied external URL)', async () => {
    const ctx = ctxWithKin();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      confirmKinPhotoUploadHandler({
        data: { kinfolkId: '3', kinId: 'k1', secureUrl: 'https://evil.example/photo.jpg' },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('404s when the kin doc does not exist', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      confirmKinPhotoUploadHandler({
        data: { kinfolkId: '3', kinId: 'ghost', secureUrl: goodUrl },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('happy path: merges photoUrl onto the kin doc', async () => {
    const ctx = ctxWithKin();
    mocks.dbFn.mockReturnValue(ctx.db);
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    const res = await confirmKinPhotoUploadHandler({
      data: { kinfolkId: '3', kinId: 'k1', secureUrl: goodUrl },
      auth: { uid: 'u1' },
    } as any);
    expect(res.photoUrl).toBe(goodUrl);
    const w = ctx.writes.find((w) => w.path === 'families/3/kin/k1');
    expect(w).toBeDefined();
    expect(w!.merge).toBe(true);
    expect(w!.data.photoUrl).toBe(goodUrl);
    expect(w!.data.updatedByUid).toBe('u1');
  });

  it('MULTIPLE linked households, kinfolkId omitted -> refuses to guess and writes nothing (PR28b)', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3', '5'] },
        'families/3/kin/k1': { name: 'Buddy' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      confirmKinPhotoUploadHandler({
        data: { kinId: 'k1', secureUrl: goodUrl },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });

  it("MULTIPLE linked households, kinfolkId '' -> refuses to guess and writes nothing ('' pinned as omitted)", async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3', '5'] },
        'families/3/kin/k1': { name: 'Buddy' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { confirmKinPhotoUploadHandler } = await import('../src/portal/signKinPhotoUpload');
    await expect(
      confirmKinPhotoUploadHandler({
        data: { kinfolkId: '', kinId: 'k1', secureUrl: goodUrl },
        auth: { uid: 'u1' },
      } as any),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(ctx.writes).toHaveLength(0);
  });
});
