import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({
  secretValues: {
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'key123',
    CLOUDINARY_API_SECRET: 'secret456',
  } as Record<string, string>,
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({ value: () => mocks.secretValues[name] }),
}));
const saved = process.env['GCLOUD_PROJECT'];
beforeEach(() => {
  delete process.env['AUNTIE_OPERATOR_UIDS'];
  delete process.env['GCLOUD_PROJECT'];
});
afterEach(() => {
  if (saved === undefined) delete process.env['GCLOUD_PROJECT'];
  else process.env['GCLOUD_PROJECT'] = saved;
});
describe('signKinfolkAvatarHandler', () => {
  it('rejects unauthenticated', async () => {
    const { signKinfolkAvatarHandler } = await import('../src/portal/signKinfolkAvatar');
    await expect(signKinfolkAvatarHandler({ data: {}, auth: undefined } as any)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });
  it('signs the uid-locked avatar folder', async () => {
    const { signKinfolkAvatarHandler } = await import('../src/portal/signKinfolkAvatar');
    const res = await signKinfolkAvatarHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.folder).toBe('tribetails/kinfolks/u1/avatars');
  });
  it('#1202: under demo-auntieos-e2e the avatar folder gains the e2e/ prefix', async () => {
    process.env['GCLOUD_PROJECT'] = 'demo-auntieos-e2e';
    const { signKinfolkAvatarHandler } = await import('../src/portal/signKinfolkAvatar');
    const res = await signKinfolkAvatarHandler({ data: {}, auth: { uid: 'u1' } } as any);
    expect(res.folder).toBe('e2e/tribetails/kinfolks/u1/avatars');
  });
});
