// NOTE-48: per-admin daily cap on the paid `generate` endpoint. Uses node:test
// so the deployed function carries zero dev-deps. Covers the pure decision
// (evaluateGenerateRateLimit / dayKeyUtc) and the transactional enforcer against
// an in-memory fake Firestore, incl. the 429 path and the day-boundary reset.
//
// Run: cd web/functions && npm test   (=> node --test)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_DAILY_GENERATE_CAP,
  dayKeyUtc,
  evaluateGenerateRateLimit,
  enforceGenerateRateLimit,
} = require('../generateRateLimit.js');

describe('dayKeyUtc', () => {
  it('returns the UTC YYYY-MM-DD for a timestamp', () => {
    // 2026-07-16T23:30:00Z
    assert.strictEqual(dayKeyUtc(Date.UTC(2026, 6, 16, 23, 30, 0)), '2026-07-16');
  });
});

describe('evaluateGenerateRateLimit (pure)', () => {
  it('allows and increments from a fresh counter', () => {
    const d = evaluateGenerateRateLimit(undefined, '2026-07-16', 3);
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.priorCount, 0);
    assert.deepStrictEqual(d.nextState, { date: '2026-07-16', count: 1 });
  });

  it('resets when the stored doc is from a previous day', () => {
    const d = evaluateGenerateRateLimit({ date: '2026-07-15', count: 999 }, '2026-07-16', 3);
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.priorCount, 0);
    assert.deepStrictEqual(d.nextState, { date: '2026-07-16', count: 1 });
  });

  it('allows up to but not including the cap', () => {
    assert.strictEqual(evaluateGenerateRateLimit({ date: 'd', count: 2 }, 'd', 3).allowed, true);
    assert.strictEqual(evaluateGenerateRateLimit({ date: 'd', count: 3 }, 'd', 3).allowed, false);
  });

  it('does NOT advance the counter when blocked', () => {
    const d = evaluateGenerateRateLimit({ date: 'd', count: 5 }, 'd', 3);
    assert.strictEqual(d.allowed, false);
    assert.deepStrictEqual(d.nextState, { date: 'd', count: 5 });
  });

  it('defaults the cap to DEFAULT_DAILY_GENERATE_CAP', () => {
    const d = evaluateGenerateRateLimit({ date: 'd', count: DEFAULT_DAILY_GENERATE_CAP - 1 }, 'd');
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(
      evaluateGenerateRateLimit({ date: 'd', count: DEFAULT_DAILY_GENERATE_CAP }, 'd').allowed,
      false,
    );
  });
});

// ── in-memory fake Firestore with a real runTransaction ──────────────────────
function fakeDb(initialByUid = {}) {
  const store = new Map(Object.entries(initialByUid)); // uid -> data
  const writes = [];
  const ref = (uid) => ({
    _uid: uid,
    get: () => {},
  });
  const db = {
    collection: (name) => {
      assert.strictEqual(name, 'generate_rate_limits');
      return { doc: (uid) => ref(uid) };
    },
    runTransaction: async (fn) => {
      const tx = {
        get: async (r) => {
          const data = store.get(r._uid);
          return { exists: data !== undefined, data: () => data };
        },
        set: (r, data) => {
          store.set(r._uid, { ...(store.get(r._uid) || {}), ...data });
          writes.push({ uid: r._uid, data });
        },
      };
      return fn(tx);
    },
  };
  return { db, store, writes };
}

describe('enforceGenerateRateLimit (transactional)', () => {
  it('consumes budget and writes the incremented counter', async () => {
    const { db, store, writes } = fakeDb();
    const now = Date.UTC(2026, 6, 16, 10, 0, 0);
    const d = await enforceGenerateRateLimit(db, 'admin-1', now, 5);
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(writes.length, 1);
    assert.deepStrictEqual(store.get('admin-1'), { date: '2026-07-16', count: 1 });
  });

  it('throws 429 at the cap and does NOT write', async () => {
    const { db, writes } = fakeDb({ 'admin-1': { date: '2026-07-16', count: 5 } });
    const now = Date.UTC(2026, 6, 16, 10, 0, 0);
    await assert.rejects(
      () => enforceGenerateRateLimit(db, 'admin-1', now, 5),
      (err) => err.status === 429 && err.message === 'generate_rate_limit_exceeded',
    );
    assert.strictEqual(writes.length, 0, 'a rejected call must not mutate the counter');
  });

  it('resets across the UTC day boundary', async () => {
    const { db, store } = fakeDb({ 'admin-1': { date: '2026-07-15', count: 5 } });
    const now = Date.UTC(2026, 6, 16, 0, 5, 0);
    const d = await enforceGenerateRateLimit(db, 'admin-1', now, 5);
    assert.strictEqual(d.allowed, true);
    assert.deepStrictEqual(store.get('admin-1'), { date: '2026-07-16', count: 1 });
  });
});
