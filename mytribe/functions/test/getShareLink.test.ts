import { describe, it, expect, vi, beforeEach } from 'vitest';

const docGet = vi.fn();
const docUpdate = vi.fn();

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: docGet, update: docUpdate }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('argon2', () => ({ default: { verify: async (h: string, p: string) => h === `h:${p}` } }));

beforeEach(() => {
  docGet.mockReset();
  docUpdate.mockReset();
});

function mkRes() {
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  return { status, json, end: vi.fn() };
}

async function callHandler(reqShape: { method: string; path: string; query?: Record<string, unknown> }, res: ReturnType<typeof mkRes>) {
  const { getShareLinkHandler } = await import('../src/share/getShareLink');
  // Both arguments are narrowed the same way the production entry point in
  // src/share/getShareLink.ts does it: the handler's ReqShape is
  // Pick<express.Request, 'method' | 'path' | 'query'>, and `query` is a full
  // ParsedQs there, not the plain object a test wants to hand it.
  await getShareLinkHandler(
    reqShape as unknown as Parameters<typeof getShareLinkHandler>[0],
    res as unknown as Parameters<typeof getShareLinkHandler>[1],
  );
}

describe('getShareLink (handler shape)', () => {
  it('returns 404 when not found', async () => {
    docGet.mockResolvedValue({ exists: false });
    const res = mkRes();
    await callHandler({ method: 'GET', path: '/share-1', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 410 when revoked', async () => {
    docGet.mockResolvedValue({
      exists: true,
      data: () => ({ revoked: true, expiresAt: { toMillis: () => Date.now() + 1e6 }, scrubbedPayload: {}, tribeId: 'f1' }),
    });
    const res = mkRes();
    await callHandler({ method: 'GET', path: '/share-1', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(410);
  });

  it('returns 401 when passcode required', async () => {
    docGet.mockResolvedValue({
      exists: true,
      ref: { update: docUpdate },
      data: () => ({
        revoked: false,
        expiresAt: { toMillis: () => Date.now() + 1e6 },
        passcodeHash: 'h:1234',
        scrubbedPayload: { body: 'x' },
        tribeId: 'f1',
      }),
    });
    const res = mkRes();
    await callHandler({ method: 'GET', path: '/share-1', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 200 with scrubbed payload (no passcode)', async () => {
    docGet.mockResolvedValue({
      exists: true,
      ref: { update: docUpdate },
      data: () => ({
        revoked: false,
        expiresAt: { toMillis: () => Date.now() + 1e6 },
        passcodeHash: null,
        scrubbedPayload: { body: 'x' },
        tribeId: 'f1',
      }),
    });
    const res = mkRes();
    await callHandler({ method: 'GET', path: '/share-1', query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ body: 'x', sourceKinTaleId: null });
  });
});
