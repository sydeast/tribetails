// Hermetic unit tests for the two guards the draft endpoints depend on:
// the windowed rate limiter and the input validators. No Firestore, no HTTP.
//
// The handler-level tests in handlers.test.js prove the guards are WIRED. These
// prove they are CORRECT, which is a different question: a limiter that always
// allows is wired just as thoroughly as one that counts.

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { windowKeyFor, evaluateWindowedRateLimit, enforceWindowedRateLimit } = require('../rateLimit');
const {
  validateDocId,
  validateDraftPayload,
  MAX_DRAFT_KEYS,
  MAX_DRAFT_BYTES,
  MAX_DRAFT_DEPTH,
} = require('../draftValidation');

describe('windowed rate limiter', () => {
  it('two calls inside the same window share a bucket; the next window is a fresh one', () => {
    const w = 60_000;
    assert.strictEqual(windowKeyFor(0, w), windowKeyFor(59_999, w));
    assert.notStrictEqual(windowKeyFor(59_999, w), windowKeyFor(60_000, w));
  });

  it('allows up to the cap and refuses the one after', () => {
    const key = 7;
    const at = (count) => evaluateWindowedRateLimit({ window: key, count }, key, 3);
    assert.strictEqual(at(0).allowed, true);
    assert.strictEqual(at(2).allowed, true);
    assert.strictEqual(at(3).allowed, false);
    assert.strictEqual(at(99).allowed, false);
  });

  it('a refused call does NOT advance the counter', () => {
    // Otherwise a caller hammering while blocked pushes its own bucket further
    // out, and the stored count stops meaning "requests served".
    const blocked = evaluateWindowedRateLimit({ window: 7, count: 3 }, 7, 3);
    assert.strictEqual(blocked.nextState.count, 3);
    const allowed = evaluateWindowedRateLimit({ window: 7, count: 2 }, 7, 3);
    assert.strictEqual(allowed.nextState.count, 3);
  });

  it('a bucket from an earlier window resets rather than carrying over', () => {
    const d = evaluateWindowedRateLimit({ window: 6, count: 999 }, 7, 3);
    assert.strictEqual(d.allowed, true);
    assert.deepStrictEqual(d.nextState, { window: 7, count: 1 });
  });

  it('an absent bucket is treated as an empty one, not as an error', () => {
    const d = evaluateWindowedRateLimit(undefined, 7, 3);
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(d.priorCount, 0);
  });

  it('stores two numbers, never a growing list (the AO-33 shape)', () => {
    // The limiter this replaced appended a timestamp per request forever.
    const d = evaluateWindowedRateLimit({ window: 7, count: 1 }, 7, 60);
    assert.deepStrictEqual(Object.keys(d.nextState).sort(), ['count', 'window']);
    for (const v of Object.values(d.nextState)) assert.strictEqual(typeof v, 'number');
  });

  it('enforce throws a 429 and leaves the bucket untouched when over cap', async () => {
    const writes = [];
    const db = {
      collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ window: windowKeyFor(1_000, 60_000), count: 5 }) }) }) }),
      runTransaction: async (fn) => fn({
        get: (ref) => ref.get(),
        set: (_ref, data) => writes.push(data),
      }),
    };
    await assert.rejects(
      () => enforceWindowedRateLimit(db, { collection: 'b', uid: 'u1', nowMs: 1_000, windowMs: 60_000, cap: 5 }),
      (e) => e.status === 429 && e.message === 'rate_limit_exceeded',
    );
    assert.strictEqual(writes.length, 0);
  });

  it('enforce consumes exactly one unit when allowed', async () => {
    const writes = [];
    const db = {
      collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) }),
      runTransaction: async (fn) => fn({
        get: (ref) => ref.get(),
        set: (_ref, data) => writes.push(data),
      }),
    };
    const d = await enforceWindowedRateLimit(db, { collection: 'b', uid: 'u1', nowMs: 1_000, windowMs: 60_000, cap: 5 });
    assert.strictEqual(d.allowed, true);
    assert.strictEqual(writes.length, 1);
    assert.strictEqual(writes[0].count, 1);
  });
});

describe('validateDocId', () => {
  it('accepts an ordinary Firestore id', () => {
    assert.strictEqual(validateDocId('abc123'), null);
    assert.strictEqual(validateDocId('draft_2026-07-30'), null);
  });

  it('rejects a path, which is the escape that matters', () => {
    // Firestore treats the argument to .doc() as a PATH. 'a/b/c' lands the doc
    // in a subcollection that no query over the parent collection can see.
    assert.match(validateDocId('a/b/c'), /must not contain/);
    assert.match(validateDocId('/leading'), /must not contain/);
    assert.match(validateDocId('trailing/'), /must not contain/);
  });

  it('rejects the ids Firestore itself refuses, as a 400 rather than a 500', () => {
    assert.match(validateDocId('.'), /"\." or "\.\."/);
    assert.match(validateDocId('..'), /"\." or "\.\."/);
    assert.match(validateDocId('__name__'), /reserved/);
  });

  it('rejects empty, non-string, and oversized ids', () => {
    assert.match(validateDocId(''), /non-empty string/);
    assert.match(validateDocId(undefined), /non-empty string/);
    assert.match(validateDocId(42), /non-empty string/);
    assert.match(validateDocId('x'.repeat(1501)), /at most 1500 bytes/);
  });

  it('counts BYTES, not characters, so multi-byte ids are measured honestly', () => {
    // 750 two-byte characters is 1500 bytes: at the limit, not over it.
    assert.strictEqual(validateDocId('é'.repeat(750)), null);
    assert.match(validateDocId('é'.repeat(751)), /at most 1500 bytes/);
  });
});

describe('validateDraftPayload', () => {
  it('accepts the shape generateAuntieCopy itself writes', () => {
    assert.strictEqual(validateDraftPayload({
      communication_type: 'sms',
      recipient: 'Jamie',
      generated_copy: 'Buddy had a great walk.',
      status: 'generated',
    }), null);
  });

  it('accepts a field it has never heard of', () => {
    // Deliberate. These endpoints have callers outside this repo, and an
    // allowlist would be a guess about them. Structure is validated; vocabulary
    // is not.
    assert.strictEqual(validateDraftPayload({ some_future_field: 'value' }), null);
  });

  it('rejects the underscore namespace the server writes into', () => {
    assert.match(validateDraftPayload({ _writtenAt: 'forged' }), /reserved/);
    assert.match(validateDraftPayload({ _anything: 1 }), /reserved/);
  });

  it('rejects a key containing a dot, which Firestore reads as a field path', () => {
    assert.match(validateDraftPayload({ 'a.b': 1 }), /must not contain/);
  });

  it('rejects non-objects, arrays and empties', () => {
    assert.match(validateDraftPayload(undefined), /draft \(object\) required/);
    assert.match(validateDraftPayload('a string'), /draft \(object\) required/);
    assert.match(validateDraftPayload([1, 2]), /draft \(object\) required/);
    assert.match(validateDraftPayload(null), /draft \(object\) required/);
    assert.match(validateDraftPayload({}), /must not be empty/);
  });

  it('bounds key count, byte size and nesting depth', () => {
    const wide = {};
    for (let i = 0; i <= MAX_DRAFT_KEYS; i += 1) wide[`k${i}`] = 1;
    assert.match(validateDraftPayload(wide), new RegExp(`at most ${MAX_DRAFT_KEYS} keys`));

    assert.match(validateDraftPayload({ big: 'x'.repeat(MAX_DRAFT_BYTES + 1) }), new RegExp(`at most ${MAX_DRAFT_BYTES} bytes`));

    let deep = 'leaf';
    for (let i = 0; i < MAX_DRAFT_DEPTH + 2; i += 1) deep = { nested: deep };
    assert.match(validateDraftPayload(deep), /must not nest deeper/);
  });

  it('allows nesting up to the limit, so the guard is a ceiling and not a ban', () => {
    let ok = 'leaf';
    for (let i = 0; i < MAX_DRAFT_DEPTH - 1; i += 1) ok = { nested: ok };
    assert.strictEqual(validateDraftPayload(ok), null);
  });
});
