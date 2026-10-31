// #1247. The Admin SDK accessors this codebase calls, checked against the REAL
// installed firebase-admin with nothing shadowed.
//
// The handler tests (handlers.test.js) replace these accessors with doubles,
// which is right for testing handler logic and is also exactly why a
// firebase-admin major that dropped `admin.auth()` shipped with a green suite:
// no test ever called the real thing. These do, and need no network: getAuth()
// and getFirestore() build their clients lazily, and serverTimestamp() is a
// local sentinel.
//
// Run: cd web/functions && npm test   (=> node --test)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
require('../index.js'); // side effect: initializeApp(), which the accessors need
const sdk = require('../firebaseServices');

describe('firebaseServices (#1247)', () => {
  it('auth() is the real Auth service, with the calls the handlers make', () => {
    const auth = sdk.auth();
    for (const fn of ['verifyIdToken', 'getUser', 'setCustomUserClaims']) {
      assert.strictEqual(typeof auth[fn], 'function', `auth().${fn}`);
    }
  });

  it('firestore() is the real Firestore, with collection()', () => {
    assert.strictEqual(typeof sdk.firestore().collection, 'function');
  });

  it('serverTimestamp() is the real FieldValue sentinel', () => {
    const { FieldValue } = require('firebase-admin/firestore');
    assert.ok(sdk.serverTimestamp() instanceof FieldValue);
  });

  it('no source file calls the namespaced API that firebase-admin 14 removed', () => {
    const root = path.join(__dirname, '..');
    const offenders = fs
      .readdirSync(root)
      .filter((f) => f.endsWith('.js'))
      .flatMap((f) =>
        fs
          .readFileSync(path.join(root, f), 'utf8')
          .split('\n')
          .map((line, i) => ({ f, n: i + 1, line }))
          .filter(({ line }) => !/^\s*\/\//.test(line) && /\badmin\.(auth|firestore|storage|messaging)\b/.test(line)),
      )
      .map(({ f, n, line }) => `${f}:${n}: ${line.trim()}`);
    assert.deepStrictEqual(offenders, []);
  });
});
