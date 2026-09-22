import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * #910: the invite preview, invite signup claim and primary recovery callables
 * key their per-IP limits on `clientIpOf` (the entry Google appended to
 * X-Forwarded-For) through `ipRateLimitKey`, and each also has a per-target
 * limit that no address rotation escapes.
 *
 * Every request here sets `rawRequest.ip` to the FIRST X-Forwarded-For entry,
 * because that is what Express `trust proxy` gives the Functions Framework. So a
 * handler that went back to `rawRequest.ip` (or the first entry) would get a
 * fresh bucket per call and these tests would fail, not only the static scan.
 *
 * The real handlers and the real `enforceRateLimit` run against an in-memory
 * Firestore that refuses a document path with an odd number of segments, as
 * the SDK does, so an unhashed IPv6 `/64` key in a path would throw.
 */
const mocks = vi.hoisted(() => ({
  store: new Map<string, Record<string, unknown>>(),
  audits: [] as Array<Record<string, unknown>>,
  auth: {
    getUserByEmail: vi.fn(),
    createUser: vi.fn(),
    createCustomToken: vi.fn(),
  },
  autoId: 0,
}));

vi.mock('../src/lib/firestoreAdmin', () => {
  function checkedPath(path: string): string {
    const segments = path.split('/');
    if (segments.length % 2 !== 0 || segments.some((s) => s === '')) {
      throw new Error(`invalid document path: ${path}`);
    }
    return path;
  }
  function snap(path: string) {
    const data = mocks.store.get(path);
    return { exists: data !== undefined, data: () => data, id: path.split('/').pop() };
  }
  function docRef(path: string) {
    const p = checkedPath(path);
    return { path: p, get: async () => snap(p) };
  }
  const fakeDb = {
    doc: docRef,
    collection: (c: string) => ({
      doc: (id: string) => docRef(`${c}/${id}`),
      add: async (data: Record<string, unknown>) => {
        mocks.autoId += 1;
        mocks.store.set(`${c}/auto${mocks.autoId}`, data);
        return { id: `auto${mocks.autoId}` };
      },
    }),
    runTransaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const writes: Array<[string, Record<string, unknown>]> = [];
      const result = await fn({
        get: async (ref: { path: string }) => snap(ref.path),
        set: (ref: { path: string }, data: Record<string, unknown>) => {
          writes.push([ref.path, data]);
        },
      });
      for (const [p, d] of writes) mocks.store.set(p, d);
      return result;
    },
  };
  return { db: () => fakeDb, auth: () => mocks.auth, getAdmin: () => ({ auth: () => mocks.auth }) };
});
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/notifications', () => ({ enqueueNotification: vi.fn(async () => []) }));
vi.mock('../src/lib/sendFromTemplate', () => ({ sendFromTemplate: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn(async (args: Record<string, unknown>) => {
    mocks.audits.push(args);
    return 'audit-1';
  }),
}));

import { getInvitePreviewHandler, INVITE_PREVIEW_IP_LIMIT, INVITE_PREVIEW_PER_INVITE_LIMIT } from '../src/portal/getInvitePreview';
import { claimInviteSignupHandler } from '../src/membership/claimInviteSignup';
import {
  requestPrimaryRecoveryHandler,
  RECOVERY_PER_FAMILY_LIMIT,
  RECOVERY_PER_IP_FAMILY_LIMIT,
} from '../src/recovery/requestPrimaryRecovery';
import { RATE_LIMITED_MESSAGE } from '../src/lib/rateLimit';
import { UNTRUSTED_CLIENT_IP } from '../src/auth/loginSecurity';

const CLAIM_IP_LIMIT = 20;
const CLAIM_PER_INVITE_LIMIT = 10;

/** A callable request as the Functions Framework hands it over: `ip` is the first entry. */
function request(data: Record<string, unknown>, xff: string) {
  const first = xff.split(',')[0]!.trim();
  return { data, rawRequest: { ip: first, headers: { 'x-forwarded-for': xff } } } as never;
}

function seedValidInvite(id: string) {
  mocks.store.set(`inviteRequests/${id}`, {
    status: 'EMAIL_SENT',
    invitedEmail: 'kin@example.com',
    tribeId: 't1',
    expiresAt: { toMillis: () => Date.now() + 3_600_000 },
  });
}

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string } | 'ok'> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code ?? 'thrown', message: e.message ?? '' };
  }
}

function storedPaths(): string[] {
  return [...mocks.store.keys()];
}

beforeEach(() => {
  mocks.store.clear();
  mocks.audits.length = 0;
  mocks.autoId = 0;
  mocks.auth.getUserByEmail.mockReset();
  mocks.auth.createUser.mockReset();
  mocks.auth.createCustomToken.mockReset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 8, 14, 20, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#910 getInvitePreview', () => {
  const preview = (inviteId: string, xff: string) => getInvitePreviewHandler(request({ inviteId }, xff));

  it('a rotating first X-Forwarded-For entry does not reset the per-IP limit', async () => {
    for (let n = 1; n <= INVITE_PREVIEW_IP_LIMIT; n += 1) {
      await expect(preview(`nope-${n}`, `198.51.100.${n % 250}, 203.0.113.9`)).resolves.toEqual({ status: 'not_found' });
    }
    await expect(preview('nope-last', '192.0.2.77, 203.0.113.9')).rejects.toMatchObject({
      code: 'resource-exhausted',
      message: RATE_LIMITED_MESSAGE,
    });
    expect(storedPaths().some((p) => p.includes('198.51.100') || p.includes('192.0.2.77'))).toBe(false);
  });

  it('rotating addresses inside one IPv6 /64 does not reset it; another /64 has its own budget', async () => {
    for (let n = 1; n <= INVITE_PREVIEW_IP_LIMIT; n += 1) {
      await preview(`nope-${n}`, `198.51.100.1, 2001:db8:1:2::${n.toString(16)}`);
    }
    await expect(preview('nope-x', '198.51.100.1, 2001:db8:1:2:ffff:ffff:ffff:ffff')).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    await expect(preview('nope-y', '198.51.100.1, 2001:db8:1:3::1')).resolves.toEqual({ status: 'not_found' });
  });

  it('an untrusted rightmost entry lands every caller in the one shared bucket', async () => {
    for (let n = 1; n <= INVITE_PREVIEW_IP_LIMIT; n += 1) {
      await preview(`nope-${n}`, `198.51.100.${n % 250}, 10.128.0.5`);
    }
    await expect(preview('nope-z', '203.0.113.200, 10.128.0.5')).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(storedPaths()).toContain(`rate_limits/invitePreview:${UNTRUSTED_CLIENT_IP}`);
  });

  it('one invite id is capped across addresses, before the invite is read', async () => {
    seedValidInvite('inv-1');
    for (let n = 1; n <= INVITE_PREVIEW_PER_INVITE_LIMIT; n += 1) {
      await expect(preview('inv-1', `198.51.100.1, 203.0.113.${n}`)).resolves.toMatchObject({ status: 'valid' });
    }
    const known = await codeOf(preview('inv-1', '198.51.100.1, 203.0.113.250'));
    for (let n = 1; n <= INVITE_PREVIEW_PER_INVITE_LIMIT; n += 1) {
      await preview('unknown-1', `198.51.100.1, 198.18.0.${n}`);
    }
    const unknown = await codeOf(preview('unknown-1', '198.51.100.1, 198.18.0.250'));
    expect(known).toEqual({ code: 'resource-exhausted', message: RATE_LIMITED_MESSAGE });
    expect(unknown, 'a refusal is identical for a real and an unknown invite').toEqual(known);
  });
});

describe('#910 claimInviteSignup', () => {
  const claim = (inviteId: string, xff: string) =>
    claimInviteSignupHandler(request({ inviteId, password: 'longenough' }, xff));

  it('a rotating first X-Forwarded-For entry does not reset the per-IP limit', async () => {
    for (let n = 1; n <= CLAIM_IP_LIMIT; n += 1) {
      await expect(claim(`nope-${n}`, `198.51.100.${n}, 203.0.113.9`)).rejects.toMatchObject({ code: 'not-found' });
    }
    await expect(claim('nope-last', '192.0.2.77, 203.0.113.9')).rejects.toMatchObject({
      code: 'resource-exhausted',
      message: RATE_LIMITED_MESSAGE,
    });
  });

  it('rotating addresses inside one IPv6 /64 does not reset it', async () => {
    for (let n = 1; n <= CLAIM_IP_LIMIT; n += 1) {
      await expect(claim(`nope-${n}`, `198.51.100.1, 2001:db8:aa:bb::${n.toString(16)}`)).rejects.toMatchObject({
        code: 'not-found',
      });
    }
    await expect(claim('nope-x', '198.51.100.1, 2001:DB8:AA:BB:1:2:3:4')).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    await expect(claim('nope-y', '198.51.100.1, 2001:db8:aa:bc::1')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('an untrusted rightmost entry lands every caller in the one shared bucket', async () => {
    for (let n = 1; n <= CLAIM_IP_LIMIT; n += 1) {
      await expect(claim(`nope-${n}`, `198.51.100.${n}, 35.191.0.9`)).rejects.toMatchObject({ code: 'not-found' });
    }
    await expect(claim('nope-z', '203.0.113.200, 35.191.0.9')).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(storedPaths()).toContain(`rate_limits/claimSignup:${UNTRUSTED_CLIENT_IP}`);
  });

  it('one invite id is capped across addresses', async () => {
    for (let n = 1; n <= CLAIM_PER_INVITE_LIMIT; n += 1) {
      await expect(claim('nope-1', `198.51.100.1, 203.0.113.${n}`)).rejects.toMatchObject({ code: 'not-found' });
    }
    await expect(claim('nope-1', '198.51.100.1, 203.0.113.250')).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  it('still mints the account through the lazy admin accessor (#912)', async () => {
    seedValidInvite('inv-2');
    mocks.auth.getUserByEmail.mockRejectedValue({ code: 'auth/user-not-found' });
    mocks.auth.createUser.mockResolvedValue({ uid: 'new-uid' });
    mocks.auth.createCustomToken.mockResolvedValue('tok');
    await expect(claim('inv-2', '198.51.100.1, 203.0.113.9')).resolves.toEqual({ token: 'tok' });
  });
});

describe('#910 requestPrimaryRecovery', () => {
  const recover = (familyId: string, xff: string) =>
    requestPrimaryRecoveryHandler(request({ familyId, contactMethod: 'email', newContact: 'new@example.com' }, xff));

  it('a rotating first X-Forwarded-For entry does not reset the limit, and the audit row has the real address', async () => {
    for (let n = 1; n <= RECOVERY_PER_IP_FAMILY_LIMIT; n += 1) {
      await expect(recover('f1', `198.51.100.${n}, 203.0.113.9`)).resolves.toEqual({ ok: true });
    }
    await expect(recover('f1', '192.0.2.77, 203.0.113.9')).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(mocks.audits.map((a) => (a.payload as { ip: string }).ip)).toEqual(
      Array(RECOVERY_PER_IP_FAMILY_LIMIT).fill('203.0.113.9'),
    );
  });

  it('rotating addresses inside one IPv6 /64 does not reset it; the audit address is canonical', async () => {
    for (let n = 1; n <= RECOVERY_PER_IP_FAMILY_LIMIT; n += 1) {
      await recover('f1', `198.51.100.1, 2001:0DB8:0001:0002::${n.toString(16).toUpperCase()}`);
    }
    await expect(recover('f1', '198.51.100.1, 2001:db8:1:2::ffff')).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect((mocks.audits[0]!.payload as { ip: string }).ip).toBe('2001:db8:1:2::1');
    await expect(recover('f1', '198.51.100.1, 2001:db8:1:3::1')).resolves.toEqual({ ok: true });
  });

  it('an untrusted rightmost entry shares one bucket and the audit row records the sentinel', async () => {
    for (let n = 1; n <= RECOVERY_PER_IP_FAMILY_LIMIT; n += 1) {
      await recover('f1', `198.51.100.${n}, fd00::1`);
    }
    await expect(recover('f1', '203.0.113.200, fd00::1')).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(mocks.audits.map((a) => (a.payload as { ip: string }).ip)).toEqual(
      Array(RECOVERY_PER_IP_FAMILY_LIMIT).fill(UNTRUSTED_CLIENT_IP),
    );
    expect(JSON.stringify(mocks.audits)).not.toContain('198.51.100');
  });

  it('one household is capped across addresses, with the same refusal as the per-address limit', async () => {
    for (let n = 1; n <= RECOVERY_PER_FAMILY_LIMIT; n += 1) {
      await expect(recover('f2', `198.51.100.1, 203.0.113.${n}`)).resolves.toEqual({ ok: true });
    }
    const perFamily = await codeOf(recover('f2', '198.51.100.1, 203.0.113.250'));
    for (let n = 1; n <= RECOVERY_PER_IP_FAMILY_LIMIT; n += 1) await recover('f3', '198.51.100.1, 198.18.0.1');
    const perAddress = await codeOf(recover('f3', '198.51.100.1, 198.18.0.1'));
    expect(perFamily).toEqual({ code: 'resource-exhausted', message: 'rate-limited' });
    expect(perAddress).toEqual(perFamily);
    // Another household is not affected by f2's cap.
    await expect(recover('f4', '198.51.100.1, 203.0.113.250')).resolves.toEqual({ ok: true });
  });

  it('a refused call spends neither counter', async () => {
    for (let n = 1; n <= RECOVERY_PER_IP_FAMILY_LIMIT; n += 1) await recover('f5', '198.51.100.1, 203.0.113.9');
    for (let n = 0; n < 5; n += 1) await codeOf(recover('f5', '198.51.100.1, 203.0.113.9'));
    // Three more from new addresses fit under the household's cap of 6.
    for (let n = 1; n <= RECOVERY_PER_FAMILY_LIMIT - RECOVERY_PER_IP_FAMILY_LIMIT; n += 1) {
      await expect(recover('f5', `198.51.100.1, 198.18.1.${n}`)).resolves.toEqual({ ok: true });
    }
  });

  it('a familyId holding a slash cannot move the ledger document', async () => {
    await expect(recover('a/b/c', '198.51.100.1, 2001:db8::1')).resolves.toEqual({ ok: true });
    expect(storedPaths().filter((p) => p.startsWith('recoveryRateLimit/')).every((p) => p.split('/').length === 2)).toBe(true);
  });
});
