import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #891: a locked account can still reset its password.
 *
 * Portal Android and portal desktop reset through `requestPasswordReset`, which
 * sent at most 3 resets per email per 24 hours. Anyone who knows an email could
 * lock it (the server trusts the client's failed-login report) and then spend
 * those 3, leaving the owner without a reset for the rest of the lock.
 *
 * Now an account inside an unexpired lock is exempt from the daily cap and has
 * its own cap of 10 per lock instead, and resets sent during a lock do not use
 * up the daily budget. Over either cap the call still answers `{ ok: true }`
 * and sends nothing, so known, unknown, locked and capped emails all answer the
 * same. A 429 here told a caller "this email is locked" on the 4th request.
 *
 * Drives the REAL handler and the REAL `checkIpRateLimit` and lock read on one
 * write-through mock. Only Firebase Auth, the dispatcher, the logger and the
 * audit writer are faked.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getUserByEmail: vi.fn(),
  generatePasswordResetLink: vi.fn(),
  enqueueNotification: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: () => ({
    getUserByEmail: mocks.getUserByEmail,
    generatePasswordResetLink: mocks.generatePasswordResetLink,
  }),
  getAdmin: vi.fn(),
}));
vi.mock('../src/notifications', () => ({ enqueueNotification: mocks.enqueueNotification }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn(async () => 'audit-1') }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn() }));

import { requestPasswordResetHandler } from '../src/auth/requestPasswordReset';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const KIN_EMAIL = 'pat@household.test';
const GHOST_EMAIL = 'nobody@household.test';
const SECURITY_DOC = 'clients/kin1/security/loginAttempts';
const LOCK_MS = 30 * 60 * 1000;

function lockedDoc(lockStartedAtMs: number) {
  return { attempts: [], lockStartedAtMs, lockedUntilMs: lockStartedAtMs + LOCK_MS, updatedAtMs: lockStartedAtMs };
}

let ipCounter = 0;
/** A different real client per call, so the per-IP limit never gets in the way. */
async function reset(email: string, atMs: number) {
  vi.setSystemTime(atMs);
  ipCounter += 1;
  return requestPasswordResetHandler(
    callableRequest({ email }, { headers: { 'x-forwarded-for': `198.51.100.${ipCounter % 250}` } }),
  );
}

/** Reset emails actually handed to the dispatcher. */
function sends(): number {
  return mocks.enqueueNotification.mock.calls.filter(([a]) => a.key === 'auth.password.reset').length;
}

function setup(docs: Record<string, Record<string, unknown>> = {}) {
  const ctx = buildDbMock({ writeThrough: true, docs: { 'clients/kin1': { email: KIN_EMAIL }, ...docs } });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getUserByEmail.mockReset();
  mocks.getUserByEmail.mockImplementation(async (email: string) => {
    if (email === KIN_EMAIL) return { uid: 'kin1', displayName: 'Pat' };
    throw new Error('auth/user-not-found');
  });
  mocks.generatePasswordResetLink.mockReset();
  mocks.generatePasswordResetLink.mockImplementation(async (email: string) => {
    if (email === KIN_EMAIL) return 'https://example.test/reset?oobCode=x';
    throw new Error('auth/user-not-found');
  });
  mocks.enqueueNotification.mockReset();
  mocks.enqueueNotification.mockResolvedValue(['n1']);
  vi.stubEnv('PASSWORD_RESET_CONSTANT_WORK_MS', '0');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('#891 an unlocked account keeps the 3-per-day cap', () => {
  it('sends 3 resets, then answers the 4th the same way and sends nothing', async () => {
    setup();
    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push(await reset(KIN_EMAIL, NOW + i * 1000));
    expect(sends()).toBe(3);
    expect(answers.map((a) => JSON.stringify(a))).toEqual(Array(4).fill('{"ok":true}'));
  });
});

describe('#891 a locked account can still reset', () => {
  it('sends resets past 3 while the lock is unexpired, up to 10 for that lock', async () => {
    setup({ [SECURITY_DOC]: lockedDoc(NOW - 60_000) });
    for (let i = 0; i < 12; i += 1) await reset(KIN_EMAIL, NOW + i * 1000);
    expect(sends(), '10 per lock window, then silent').toBe(10);
  });

  it('is exempt even when the daily budget was already spent before the lock', async () => {
    const ctx = setup();
    for (let i = 0; i < 3; i += 1) await reset(KIN_EMAIL, NOW + i * 1000);
    expect(sends()).toBe(3);
    // Same stored budget, now with a lock on the account.
    await ctx.db.doc(SECURITY_DOC).set(lockedDoc(NOW + 5000));
    for (let i = 0; i < 3; i += 1) await reset(KIN_EMAIL, NOW + 10_000 + i * 1000);
    await reset(KIN_EMAIL, NOW + 20_000);
    expect(sends()).toBe(3 + 4);
  });

  it('an attacker spending 3 resets during the lock leaves the owner their full budget after it', async () => {
    setup({ [SECURITY_DOC]: lockedDoc(NOW) });
    for (let i = 0; i < 3; i += 1) await reset(KIN_EMAIL, NOW + i * 1000);
    expect(sends()).toBe(3);
    // The lock has expired. Resets during the lock did not use the daily cap.
    const after = NOW + LOCK_MS + 60_000;
    for (let i = 0; i < 4; i += 1) await reset(KIN_EMAIL, after + i * 1000);
    expect(sends(), '3 during the lock + 3 after it, the 4th after it capped').toBe(6);
  });

  it('a new lock gets a fresh cap of 10', async () => {
    const ctx = setup({ [SECURITY_DOC]: lockedDoc(NOW) });
    for (let i = 0; i < 11; i += 1) await reset(KIN_EMAIL, NOW + i * 1000);
    expect(sends()).toBe(10);
    const second = NOW + LOCK_MS + 5 * 60_000;
    await ctx.db.doc(SECURITY_DOC).set(lockedDoc(second));
    for (let i = 0; i < 11; i += 1) await reset(KIN_EMAIL, second + 1000 + i * 1000);
    expect(sends()).toBe(20);
  });

  it('an expired lock is not exempt', async () => {
    setup({ [SECURITY_DOC]: lockedDoc(NOW - LOCK_MS - 1000) });
    for (let i = 0; i < 5; i += 1) await reset(KIN_EMAIL, NOW + i * 1000);
    expect(sends()).toBe(3);
  });
});

describe('#891 nothing in the answer tells the three kinds of email apart', () => {
  it('known, unknown, locked and capped calls all answer byte-identical { ok: true }', async () => {
    setup({ [SECURITY_DOC]: lockedDoc(NOW) });
    const bodies = new Set<string>();
    for (let i = 0; i < 12; i += 1) bodies.add(JSON.stringify(await reset(KIN_EMAIL, NOW + i * 1000)));
    for (let i = 0; i < 12; i += 1) bodies.add(JSON.stringify(await reset(GHOST_EMAIL, NOW + i * 1000)));
    const unlocked = 'sam@household.test';
    for (let i = 0; i < 5; i += 1) bodies.add(JSON.stringify(await reset(unlocked, NOW + i * 1000)));
    expect([...bodies]).toEqual(['{"ok":true}']);
  });

  it('an unknown email over its cap is refused no differently from a known one', async () => {
    setup();
    for (let i = 0; i < 4; i += 1) {
      await expect(reset(GHOST_EMAIL, NOW + i * 1000)).resolves.toEqual({ ok: true });
    }
    expect(sends()).toBe(0);
  });

  it('writes no undefined field while counting', async () => {
    const ctx = setup({ [SECURITY_DOC]: lockedDoc(NOW) });
    for (let i = 0; i < 4; i += 1) await reset(KIN_EMAIL, NOW + i * 1000);
    await reset(GHOST_EMAIL, NOW);
    const hasUndefined = (v: unknown): boolean =>
      v === undefined ||
      (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.values(v).some(hasUndefined)) ||
      (Array.isArray(v) && v.some(hasUndefined));
    const bad = (ctx.writes as { path: string; data: Record<string, unknown> }[]).filter((w) => hasUndefined(w.data));
    expect(bad.map((w) => w.path)).toEqual([]);
  });
});

describe('#891 the per-IP limit still throws for everyone alike', () => {
  it('the 31st reset from one client in 5 minutes is resource-exhausted', async () => {
    setup();
    const req = () =>
      requestPasswordResetHandler(
        callableRequest({ email: GHOST_EMAIL }, { headers: { 'x-forwarded-for': `192.0.2.${ipCounter++}, 203.0.113.9` } }),
      );
    for (let i = 0; i < 30; i += 1) await req();
    await expect(req()).rejects.toMatchObject({ code: 'resource-exhausted' });
  });
});
