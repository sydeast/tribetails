import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  secretValues: {
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'key123',
    CLOUDINARY_API_SECRET: 'secret456',
  } as Record<string, string>,
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: vi.fn(),
  auth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-functions/params', () => ({
  defineSecret: (name: string) => ({ value: () => mocks.secretValues[name] }),
}));

function mkRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  return { status, json };
}

async function callHandler(reqShape: {
  method?: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
}) {
  const { signCloudinaryUploadHandler } = await import('../src/admin/signCloudinaryUpload');
  const res = mkRes();
  await signCloudinaryUploadHandler(reqShape as any, res as any);
  return res;
}

beforeEach(() => {
  mocks.verifyIdToken.mockReset();
  delete process.env.AUNTIE_OPERATOR_UIDS;
  mocks.secretValues = {
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'key123',
    CLOUDINARY_API_SECRET: 'secret456',
  };
});

describe('signCloudinaryUploadHandler', () => {
  it('rejects a request with no Authorization header', async () => {
    const res = await callHandler({ headers: {}, body: { entityType: 'KIN', entityId: 'k1' } });
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid/expired bearer token', async () => {
    mocks.verifyIdToken.mockRejectedValue(new Error('bad token'));
    const res = await callHandler({
      headers: { authorization: 'Bearer garbage' },
      body: { entityType: 'KIN', entityId: 'k1' },
    });
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects a valid token that is not an admin/staff uid', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'stranger', admin: false });
    const res = await callHandler({
      headers: { authorization: 'Bearer good' },
      body: { entityType: 'KIN', entityId: 'k1' },
    });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects a missing entityId', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'admin1', admin: true });
    const res = await callHandler({
      headers: { authorization: 'Bearer good' },
      body: { entityType: 'KIN' },
    });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a missing entityType', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'admin1', admin: true });
    const res = await callHandler({
      headers: { authorization: 'Bearer good' },
      body: { entityId: 'k1' },
    });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a non-POST method', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'admin1', admin: true });
    const res = await callHandler({
      method: 'GET',
      headers: { authorization: 'Bearer good' },
      body: {},
    });
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('rejects when Cloudinary secrets are unset', async () => {
    mocks.secretValues.CLOUDINARY_API_SECRET = '';
    mocks.verifyIdToken.mockResolvedValue({ uid: 'admin1', admin: true });
    const res = await callHandler({
      headers: { authorization: 'Bearer good' },
      body: { entityType: 'KIN', entityId: 'k1' },
    });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'cloudinary_signing_not_configured' });
  });

  it('happy path (admin claim): returns a signature scoped to the canonical entity folder', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'admin1', admin: true });
    const res = await callHandler({
      headers: { authorization: 'Bearer good' },
      body: { entityType: 'KIN', entityId: 'k1', folder: 'whatever-the-client-guessed' },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.cloudName).toBe('demo');
    expect(payload.apiKey).toBe('key123');
    expect(payload.folder).toBe('tribetails/kin/k1');
    expect(payload.entityType).toBe('KIN');
    expect(payload.entityId).toBe('k1');
    expect(payload.signature).toMatch(/^[a-f0-9]{40}$/);
    expect(typeof payload.timestamp).toBe('number');
  });

  it('happy path (AUNTIE_OPERATOR_UIDS allowlist fallback, no admin claim): still signs', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op1';
    mocks.verifyIdToken.mockResolvedValue({ uid: 'op1', admin: false });
    const res = await callHandler({
      headers: { authorization: 'Bearer good' },
      body: { entityType: 'VISIT_LOG', entityId: 'session42' },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    const payload = res.json.mock.calls[0][0];
    expect(payload.folder).toBe('tribetails/visit_log/session42');
  });
});
