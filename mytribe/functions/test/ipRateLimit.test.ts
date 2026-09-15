import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  txGet: vi.fn(),
  txSet: vi.fn(),
  docIds: [] as string[],
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: vi.fn(async () => []) }));

function makeDbWithTimestamps(timestamps: number[]) {
  mocks.txGet.mockResolvedValue({ data: () => ({ timestamps }) });
  mocks.txSet.mockResolvedValue(undefined);

  mocks.dbFn.mockReturnValue({
    collection: () => ({
      doc: (id: string) => {
        mocks.docIds.push(id);
        return 'docRef';
      },
    }),
    runTransaction: vi.fn(async (fn: (tx: any) => Promise<void>) => {
      const tx = { get: mocks.txGet, set: mocks.txSet };
      await fn(tx);
    }),
  });
}

/** What a callable hands the handler: headers plus Express's `req.ip`. */
function raw(headers: Record<string, string>, ip?: string) {
  return { headers, ip };
}

beforeEach(() => {
  vi.resetModules();
  mocks.txGet.mockReset();
  mocks.txSet.mockReset();
  mocks.dbFn.mockReset();
  mocks.docIds.length = 0;
});

describe('checkIpRateLimit', () => {
  it('HAPPY: under limit, passes and returns the key it counted', async () => {
    makeDbWithTimestamps([]);
    const { checkIpRateLimit } = await import('../src/auth/loginSecurity');
    await expect(checkIpRateLimit(raw({ 'x-forwarded-for': '1.2.3.4' }))).resolves.toBe('1.2.3.4');
  });

  it('SAD: at limit (30 recent calls), throws resource-exhausted', async () => {
    const now = Date.now();
    const recent = Array.from({ length: 30 }, (_, i) => now - i * 1000);
    makeDbWithTimestamps(recent);
    const { checkIpRateLimit } = await import('../src/auth/loginSecurity');
    await expect(checkIpRateLimit(raw({ 'x-forwarded-for': '1.2.3.4' }))).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
  });

  it('EDGE: expired timestamps do not count, passes when 30 old + 0 recent', async () => {
    const expired = Array.from({ length: 30 }, (_, i) => Date.now() - 10 * 60 * 1000 - i * 1000);
    makeDbWithTimestamps(expired);
    const { checkIpRateLimit } = await import('../src/auth/loginSecurity');
    await expect(checkIpRateLimit(raw({ 'x-forwarded-for': '1.2.3.4' }))).resolves.toBe('1.2.3.4');
  });
});

describe('#891 the IP limit is keyed on the entry Google appended, not the one the caller wrote', () => {
  it('a forged first X-Forwarded-For entry does not change the bucket', async () => {
    makeDbWithTimestamps([]);
    const { checkIpRateLimit } = await import('../src/auth/loginSecurity');
    await checkIpRateLimit(raw({ 'x-forwarded-for': '203.0.113.99' }, '203.0.113.99'));
    await checkIpRateLimit(raw({ 'x-forwarded-for': '192.0.2.1, 203.0.113.99' }, '192.0.2.1'));
    await checkIpRateLimit(raw({ 'x-forwarded-for': '198.51.100.7,192.0.2.2,203.0.113.99' }, '198.51.100.7'));
    expect(mocks.docIds).toHaveLength(3);
    expect(new Set(mocks.docIds).size, 'three calls from one real client share one bucket').toBe(1);
  });

  it('a rotating forged first entry is still refused once the real client has spent the limit', async () => {
    const now = Date.now();
    makeDbWithTimestamps(Array.from({ length: 30 }, (_, i) => now - i * 1000));
    const { checkIpRateLimit } = await import('../src/auth/loginSecurity');
    await expect(
      checkIpRateLimit(raw({ 'x-forwarded-for': '192.0.2.200, 203.0.113.99' }, '192.0.2.200')),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('ignores rawRequest.ip whenever the header is present (trust proxy makes it the first, forgeable entry)', async () => {
    const { clientIpOf } = await import('../src/auth/loginSecurity');
    expect(clientIpOf(raw({ 'x-forwarded-for': '192.0.2.1, 203.0.113.99' }, '192.0.2.1'))).toBe('203.0.113.99');
  });

  it('trims whitespace and skips empty entries left by a trailing comma', async () => {
    const { clientIpOf } = await import('../src/auth/loginSecurity');
    expect(clientIpOf(raw({ 'x-forwarded-for': ' 192.0.2.1 ,  203.0.113.99 , ' }))).toBe('203.0.113.99');
  });

  it('reads the last value when the header arrives as an array', async () => {
    const { clientIpOf } = await import('../src/auth/loginSecurity');
    const req = { headers: { 'x-forwarded-for': ['192.0.2.1', '203.0.113.99'] } };
    expect(clientIpOf(req as unknown as Parameters<typeof clientIpOf>[0])).toBe('203.0.113.99');
  });

  it('falls back to rawRequest.ip when the header is missing or blank', async () => {
    const { clientIpOf } = await import('../src/auth/loginSecurity');
    expect(clientIpOf(raw({}, '10.0.0.5'))).toBe('10.0.0.5');
    expect(clientIpOf(raw({ 'x-forwarded-for': ' , ' }, '10.0.0.5'))).toBe('10.0.0.5');
  });

  it("falls back to 'unknown' when there is neither a header nor a socket address", async () => {
    const { clientIpOf } = await import('../src/auth/loginSecurity');
    expect(clientIpOf(raw({}))).toBe('unknown');
    expect(clientIpOf(undefined)).toBe('unknown');
  });
});
