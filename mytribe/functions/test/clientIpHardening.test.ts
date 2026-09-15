import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';

/**
 * #908 review: `clientIpOf` fails safe when the hop count is wrong, and the
 * per-IP key cannot be dodged by rotating inside one IPv6 /64.
 *
 * 1. If the entry Google should have appended is private, loopback, link-local,
 *    unique-local, unspecified, not an IP at all, or a Google front end address,
 *    the hop count does not match what is in front of the function. Keying on
 *    it would put every caller in one bucket, silently. So it logs a structured
 *    error (range class only, never the address) and walks left.
 * 2. IPv6 is keyed on its /64, and an IPv4-mapped IPv6 address on its IPv4
 *    address. IPv4 keys hash exactly as before.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn(), docIds: [] as string[], sets: [] as unknown[] }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: vi.fn(async () => []) }));

import { clientIpOf, checkIpRateLimit, ipRateLimitKey } from '../src/auth/loginSecurity';

const NOW = Date.UTC(2026, 8, 14, 20, 0, 0);

function raw(xff: string | undefined, ip?: string) {
  return { headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip };
}

function errorEvents(event: string) {
  return mocks.logEvent.mock.calls.map(([f]) => f).filter((f) => f.event === event && f.severity === 'error');
}

beforeEach(() => {
  mocks.logEvent.mockReset();
  mocks.docIds.length = 0;
  mocks.sets.length = 0;
  mocks.dbFn.mockReset();
  mocks.dbFn.mockReturnValue({
    collection: () => ({
      doc: (id: string) => {
        mocks.docIds.push(id);
        return 'docRef';
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        get: async () => ({ data: () => ({ timestamps: [] }) }),
        set: (_ref: unknown, data: unknown) => {
          mocks.sets.push(data);
        },
      }),
  });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#908 an untrusted rightmost entry is skipped, logged by class, never by address', () => {
  const cases: Array<[string, string]> = [
    ['10.1.2.3', 'private'],
    ['172.20.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['169.254.10.20', 'linkLocal'],
    ['fe80::1', 'linkLocal'],
    ['febf::1', 'linkLocal'],
    ['fd12:3456::1', 'uniqueLocal'],
    ['fc00::1', 'uniqueLocal'],
    ['35.191.3.4', 'googleFrontEnd'],
    ['130.211.0.9', 'googleFrontEnd'],
    ['130.211.3.255', 'googleFrontEnd'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['not-an-ip', 'notAnIp'],
  ];
  for (const [rightmost, rangeClass] of cases) {
    it(`${rightmost} is ${rangeClass}: uses the entry to its left`, () => {
      expect(clientIpOf(raw(`198.51.100.1, 203.0.113.9, ${rightmost}`))).toBe('203.0.113.9');
      const logged = errorEvents('clientIp.untrustedRightmost');
      expect(logged).toHaveLength(1);
      expect(logged[0]!.extra).toMatchObject({ rangeClass, entryCount: 3, trustedHops: 1 });
      const text = JSON.stringify(logged[0]);
      expect(text, 'no address in the log').not.toContain('203.0.113.9');
      if (rangeClass !== 'unspecified') expect(text).not.toContain(rightmost);
    });
  }

  it('walks past several untrusted entries to the first trusted one', () => {
    expect(clientIpOf(raw('203.0.113.9, 10.0.0.1, 35.191.0.1'))).toBe('203.0.113.9');
    expect(errorEvents('clientIp.untrustedRightmost').map((e) => e.extra.rangeClass)).toEqual([
      'googleFrontEnd',
      'private',
    ]);
  });

  it('keeps the chosen entry, and logs, when nothing trusted is left', () => {
    expect(clientIpOf(raw('10.0.0.1'))).toBe('10.0.0.1');
    expect(errorEvents('clientIp.untrustedRightmost')).toHaveLength(1);
  });

  it('keeps public addresses just outside each range and logs nothing', () => {
    for (const ip of ['130.211.4.1', '172.32.0.1', '172.15.255.1', '35.192.0.1', '169.255.0.1', '2001:db8::1', 'fec0::1']) {
      expect(clientIpOf(raw(`192.0.2.1, ${ip}`)), ip).toBe(ip);
    }
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('logs an error when there are zero X-Forwarded-For entries', () => {
    expect(clientIpOf(raw(undefined, '10.9.9.9'))).toBe('10.9.9.9');
    expect(clientIpOf(raw(' , '))).toBe('unknown');
    const logged = errorEvents('clientIp.noForwardedFor');
    expect(logged).toHaveLength(2);
    expect(JSON.stringify(logged)).not.toContain('10.9.9.9');
  });

  it('takes the trusted hop count as a parameter, defaulting to 1', () => {
    expect(clientIpOf(raw('192.0.2.1, 203.0.113.9, 198.51.100.77'))).toBe('198.51.100.77');
    expect(clientIpOf(raw('192.0.2.1, 203.0.113.9, 198.51.100.77'), 2)).toBe('203.0.113.9');
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });
});

describe('#908 the per-IP key: IPv6 /64, IPv4-mapped IPv6 as IPv4, IPv4 unchanged', () => {
  it('two addresses in one IPv6 /64 share a bucket; another /64 does not', async () => {
    await checkIpRateLimit(raw('2001:db8:1:2::aaaa'));
    await checkIpRateLimit(raw('2001:0db8:0001:0002:ffff:1:2:3'));
    await checkIpRateLimit(raw('2001:db8:1:3::aaaa'));
    expect(mocks.docIds[0]).toBe(mocks.docIds[1]);
    expect(mocks.docIds[2]).not.toBe(mocks.docIds[0]);
    expect(ipRateLimitKey('2001:db8:1:2::aaaa')).toBe('2001:db8:1:2::/64');
  });

  it('an IPv4-mapped IPv6 address is the IPv4 address, for the key and the audit row', async () => {
    const mapped = await checkIpRateLimit(raw('::ffff:203.0.113.9'));
    await checkIpRateLimit(raw('203.0.113.9'));
    expect(mapped).toBe('203.0.113.9');
    expect(mocks.docIds[0]).toBe(mocks.docIds[1]);
    expect(clientIpOf(raw('192.0.2.1, ::FFFF:cb00:7109'))).toBe('203.0.113.9');
  });

  it('an IPv4 key hashes exactly as before #908, so stored IPv4 counters keep their meaning', async () => {
    await checkIpRateLimit(raw('203.0.113.9'));
    expect(mocks.docIds[0]).toBe(createHash('sha256').update('203.0.113.9').digest('hex').slice(0, 32));
  });

  it('writes expiresAt: the 5-minute window plus one hour', async () => {
    await checkIpRateLimit(raw('203.0.113.9'));
    const data = mocks.sets[0] as { expiresAt: Timestamp };
    expect(data.expiresAt).toBeInstanceOf(Timestamp);
    expect(data.expiresAt.toMillis()).toBe(NOW + 5 * 60_000 + 60 * 60_000);
  });
});
