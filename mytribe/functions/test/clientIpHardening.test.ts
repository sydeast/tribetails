import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { Timestamp } from 'firebase-admin/firestore';

/**
 * #908 review: `clientIpOf` fails CLOSED when the hop count is wrong, and the
 * per-IP key cannot be dodged by rotating inside one IPv6 /64 or by respelling
 * one address.
 *
 * 1. If the entry at the trusted hop is private, loopback, link-local,
 *    unique-local, IPv4-compatible IPv6, unspecified, not an IP at all, or a
 *    Google front end address, the hop count does not match what is in front
 *    of the function. Every entry to its left was written by the caller, so none
 *    of them can be trusted either. It logs a structured error (range class
 *    only, never the address) and returns the sentinel `'untrusted'`: every such
 *    call shares one bucket, and the audit row records the sentinel.
 * 2. IPv6 is keyed on its /64, an IPv4-mapped IPv6 address on its IPv4 address,
 *    and every spelling of one address (brackets and port, case, leading zeros,
 *    zone id) on the same canonical form. IPv4 keys hash exactly as before.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn(), docIds: [] as string[], sets: [] as unknown[] }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: vi.fn(async () => []) }));

import { clientIpOf, checkIpRateLimit, ipRateLimitKey, UNTRUSTED_CLIENT_IP } from '../src/auth/loginSecurity';

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

describe('#908 an untrusted entry at the trusted hop fails closed, logged by class, never by address', () => {
  it('the sentinel is the fixed string "untrusted"', () => {
    expect(UNTRUSTED_CLIENT_IP).toBe('untrusted');
  });

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
    ['2600:2d00:1:b029::7', 'googleFrontEnd'],
    ['2600:2d00:1:1::7', 'googleFrontEnd'],
    ['::203.0.113.9', 'ipv4Compatible'],
    ['::cb00:7109', 'ipv4Compatible'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['not-an-ip', 'notAnIp'],
  ];
  for (const [rightmost, rangeClass] of cases) {
    it(`${rightmost} is ${rangeClass}: the sentinel, never the entry to its left`, () => {
      expect(clientIpOf(raw(`198.51.100.1, 203.0.113.9, ${rightmost}`))).toBe(UNTRUSTED_CLIENT_IP);
      const logged = errorEvents('clientIp.untrustedRightmost');
      expect(logged).toHaveLength(1);
      expect(logged[0]!.extra).toMatchObject({ rangeClass, entryCount: 3, trustedHops: 1 });
      const text = JSON.stringify(logged[0]);
      expect(text, 'no address in the log').not.toContain('203.0.113.9');
      if (rangeClass !== 'unspecified' && rangeClass !== 'ipv4Compatible') expect(text).not.toContain(rightmost);
    });
  }

  it('several untrusted entries in a row still give the sentinel, not the forged address beyond them', () => {
    expect(clientIpOf(raw('203.0.113.9, 10.0.0.1, 35.191.0.1'))).toBe(UNTRUSTED_CLIENT_IP);
    expect(clientIpOf(raw('198.51.100.7, 10.0.0.1, 10.0.0.2, 10.0.0.3, 10.0.0.4, 10.0.0.5'))).toBe(UNTRUSTED_CLIENT_IP);
    const logged = errorEvents('clientIp.untrustedRightmost');
    expect(logged.map((e) => e.extra.rangeClass)).toEqual(['googleFrontEnd', 'private']);
    expect(JSON.stringify(logged)).not.toContain('198.51.100.7');
  });

  it('a single untrusted entry with nothing to its left gives the sentinel and logs', () => {
    expect(clientIpOf(raw('10.0.0.1'))).toBe(UNTRUSTED_CLIENT_IP);
    expect(errorEvents('clientIp.untrustedRightmost')).toHaveLength(1);
  });

  it('a rotating forged entry to the left of a private rightmost shares ONE bucket, and the audit row gets the sentinel', async () => {
    const returned = new Set<string>();
    for (let n = 1; n <= 5; n += 1) returned.add(await checkIpRateLimit(raw(`198.51.100.${n}, 10.128.0.5`)));
    for (let n = 1; n <= 3; n += 1) returned.add(await checkIpRateLimit(raw(`2001:db8:${n}::1, fd00::1`)));
    expect([...returned]).toEqual([UNTRUSTED_CLIENT_IP]);
    expect(mocks.docIds).toHaveLength(8);
    expect(new Set(mocks.docIds).size, 'every forged entry lands in the same bucket').toBe(1);
  });

  it('keeps public addresses just outside each range and logs nothing', () => {
    const neighbours: Array<[string, string]> = [
      ['130.211.4.1', '130.211.4.1'],
      ['172.32.0.1', '172.32.0.1'],
      ['172.15.255.1', '172.15.255.1'],
      ['35.192.0.1', '35.192.0.1'],
      ['169.255.0.1', '169.255.0.1'],
      ['2001:db8::1', '2001:db8::1'],
      ['fec0::1', 'fec0::1'],
      ['2600:2d00:1:2::1', '2600:2d00:1:2::1'],
      ['2600:2d00:1:b028::1', '2600:2d00:1:b028::1'],
      ['2600:2d00:2:1::1', '2600:2d00:2:1::1'],
      // Outside ::/96: a nonzero group before the embedded IPv4 part.
      ['1::203.0.113.9', '1::cb00:7109'],
    ];
    for (const [ip, expected] of neighbours) {
      expect(clientIpOf(raw(`192.0.2.1, ${ip}`)), ip).toBe(expected);
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
    // With 2 hops the entry at the trusted position is checked, not the rightmost.
    expect(clientIpOf(raw('192.0.2.1, 10.0.0.9, 198.51.100.77'), 2)).toBe(UNTRUSTED_CLIENT_IP);
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

  it('every spelling of one IPv6 address lands in one bucket and returns one canonical address', async () => {
    const spellings = ['[2001:db8::1]:443', '2001:DB8::1', '2001:0db8:0000:0000::0001', '2001:db8::1%eth0', '[2001:db8::1]'];
    const returned = [];
    for (const s of spellings) returned.push(await checkIpRateLimit(raw(`192.0.2.1, ${s}`)));
    expect(mocks.docIds).toHaveLength(spellings.length);
    expect(new Set(mocks.docIds).size).toBe(1);
    expect(returned).toEqual(Array(spellings.length).fill('2001:db8::1'));
    expect(mocks.logEvent).not.toHaveBeenCalled();
  });

  it('ipRateLimitKey, called directly, keys every spelling on the same /64 (#910 will call it on raw input)', () => {
    for (const s of ['[2001:db8:1:2::aaaa]:443', '[2001:db8:1:2::aaaa]', '2001:DB8:1:2::AAAA', '2001:0db8:0001:0002::aaaa%eth0']) {
      expect(ipRateLimitKey(s), s).toBe('2001:db8:1:2::/64');
    }
    expect(ipRateLimitKey('[::ffff:203.0.113.9]:443')).toBe('203.0.113.9');
  });

  it('a bracketed address with a port is keyed on its /64, not on a whole-address string', async () => {
    await checkIpRateLimit(raw('[2001:db8:1:2::aaaa]:443'));
    await checkIpRateLimit(raw('2001:db8:1:2::bbbb'));
    expect(mocks.docIds[0]).toBe(mocks.docIds[1]);
    expect(mocks.docIds[0]).toBe(createHash('sha256').update('2001:db8:1:2::/64').digest('hex').slice(0, 32));
  });

  it('the audit address is canonical: lowercase, no leading zeros, longest zero run compressed, no zone id', async () => {
    expect(await checkIpRateLimit(raw('2001:0DB8:0000:0000:0000:0000:0000:0001%eth0'))).toBe('2001:db8::1');
    expect(clientIpOf(raw('2001:db8:0:0:1:0:0:1'))).toBe('2001:db8::1:0:0:1');
    expect(clientIpOf(raw('2001:db8:0:1:1:1:1:1'))).toBe('2001:db8:0:1:1:1:1:1');
    expect(clientIpOf(raw('2001:0:0:1:0:0:0:1'))).toBe('2001:0:0:1::1');
    expect(clientIpOf(raw('fe80:0:0:0:0:0:0:0'), 1)).toBe(UNTRUSTED_CLIENT_IP);
    expect(clientIpOf(raw('2001:db8:0:0:0:0:0:0'))).toBe('2001:db8::');
    expect(clientIpOf(raw('0:0:0:0:0:0:0:2001'))).toBe(UNTRUSTED_CLIENT_IP);
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
