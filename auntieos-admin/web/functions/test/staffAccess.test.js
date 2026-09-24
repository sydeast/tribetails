// The admin/Auntie boundary for THIS Cloud Functions codebase, tested where it
// is decided: `staffAccess.js`, which is pure, total and side-effect free, so
// every question about who may reach what is answerable without a token, a
// network, or a Firebase project.
//
// Issue #944 / #948 follow-up. Spec:
// docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md
//
// The handler-level half — that `requireStaffToken` actually consults this, and
// that each of the eight endpoints lands on the side decided here — lives in
// test/handlers.test.js, which drives the real exported handlers.
//
// Run: cd auntieos-admin/web/functions && npm test   (=> node --test)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  STAFF_ROLE_AUNTIE,
  AUNTIE_ALLOWED_ENDPOINTS,
  isAuntieClaim,
  isOwnerClaim,
  auntieMayCall,
  staffRoleOf,
  resolveStaffRole,
} = require('../staffAccess');

const OWNER = { uid: 'owner-1', admin: true };
const CARETAKER = { uid: 'auntie-1', staffRole: 'auntie' };
const DOUBLE_CLAIMED = { uid: 'both-1', admin: true, staffRole: 'auntie' };
const TEST_ADMIN = { uid: 'test-1', testTribeId: 'kf_test' };
const STRANGER = { uid: 'kin-1', role: 'kinfolk', kinfolkId: 'kf_9' };

describe('the claim shape', () => {
  it('the caretaker role string matches the other three copies of it', () => {
    // mytribe/functions/src/lib/auntieAccess.ts, mytribe/firestore.rules and
    // auntieos-admin/src/lib/gate.ts all spell it the same. Four copies exist
    // because the two functions codebases deploy separately and the rules are a
    // third language; drift here means this codebase admits nobody, which is
    // the safe side, but it would still be a silent outage.
    assert.strictEqual(STAFF_ROLE_AUNTIE, 'auntie');
  });

  it('isAuntieClaim: the exact role, nothing adjacent', () => {
    assert.strictEqual(isAuntieClaim(CARETAKER), true);
    assert.strictEqual(isAuntieClaim(OWNER), false);
    assert.strictEqual(isAuntieClaim(STRANGER), false);
    assert.strictEqual(isAuntieClaim(undefined), false);
    assert.strictEqual(isAuntieClaim({}), false);
  });

  it('isAuntieClaim: an unknown future staff role is NOT the caretaker', () => {
    // Spec §3. `staffRole: 'bookkeeper'` is neither role and is refused
    // everywhere until someone writes rules for it. A truthiness test on
    // `token.staffRole` would have admitted it to the caretaker's grants.
    assert.strictEqual(isAuntieClaim({ uid: 'b', staffRole: 'bookkeeper' }), false);
    assert.strictEqual(isAuntieClaim({ uid: 'b', staffRole: 'Auntie' }), false);
    assert.strictEqual(isAuntieClaim({ uid: 'b', staffRole: ' auntie ' }), false);
  });

  it('isOwnerClaim: the owner, and nobody wearing the caretaker role', () => {
    assert.strictEqual(isOwnerClaim(OWNER), true);
    assert.strictEqual(isOwnerClaim(CARETAKER), false);
    assert.strictEqual(isOwnerClaim(TEST_ADMIN), false);
    assert.strictEqual(isOwnerClaim(STRANGER), false);
    assert.strictEqual(isOwnerClaim(undefined), false);
  });

  it('isOwnerClaim: a double-claimed account DEGRADES to the caretaker', () => {
    // The account that should not exist. `grant-staff-role.mjs` refuses to mint
    // it and `setAdminClaim` now refuses the other direction, but if one is
    // made by hand it must fail toward LESS access, identically to
    // firestore.rules:isOwner() and mytribe/functions/src/lib/staffGate.ts.
    assert.strictEqual(isOwnerClaim(DOUBLE_CLAIMED), false);
    assert.strictEqual(isAuntieClaim(DOUBLE_CLAIMED), true);
  });

  it('isOwnerClaim: an owner carrying an unknown staff role is still the owner', () => {
    // Only the literal caretaker role subtracts. A typo'd or future role must
    // not lock the sole operator out of their own admin claim.
    assert.strictEqual(isOwnerClaim({ uid: 'o', admin: true, staffRole: 'bookkeeper' }), true);
  });

  it('isOwnerClaim: does not coerce a non-true admin claim', () => {
    assert.strictEqual(isOwnerClaim({ uid: 'o', admin: 'true' }), false);
    assert.strictEqual(isOwnerClaim({ uid: 'o', admin: 1 }), false);
  });
});

describe('staffRoleOf (the setAdminClaim guard reads this)', () => {
  it('reports the role a target account already holds', () => {
    assert.strictEqual(staffRoleOf({ staffRole: 'auntie' }), 'auntie');
    assert.strictEqual(staffRoleOf({ staffRole: 'bookkeeper' }), 'bookkeeper');
  });

  it('reports "" for an account holding none, including undefined claims', () => {
    assert.strictEqual(staffRoleOf({ admin: true }), '');
    assert.strictEqual(staffRoleOf({}), '');
    assert.strictEqual(staffRoleOf(undefined), '');
    assert.strictEqual(staffRoleOf(null), '');
  });

  it('a non-string staffRole reads as no role rather than throwing', () => {
    assert.strictEqual(staffRoleOf({ staffRole: 42 }), '');
  });
});

describe('the allowlist', () => {
  it('names exactly the three endpoints a caretaker may reach', () => {
    // Pinned as a whole set, not one membership at a time. An endpoint added
    // here without a decision recorded beside it fails this assertion, which is
    // the point: the set IS the boundary, so growing it must be deliberate.
    assert.deepStrictEqual(
      [...AUNTIE_ALLOWED_ENDPOINTS].sort(),
      ['retrieveMapbox', 'searchMapbox', 'signCloudinaryUpload'],
    );
  });

  it('every name in the set is an endpoint this codebase actually exports', () => {
    // The `auntieAccess.ts` property, restated here: the set must not rot into
    // strings that gate nothing. A typo'd entry grants nothing (absent means
    // refused), but it also means the endpoint it MEANT to open is still shut,
    // and that failure is otherwise invisible until an Auntie reports it.
    const idx = require('../index.js');
    for (const name of AUNTIE_ALLOWED_ENDPOINTS) {
      assert.strictEqual(
        typeof idx[name],
        'function',
        `${name} is on the caretaker allowlist but is not exported by index.js`,
      );
    }
  });

  it('the money and owner endpoints are NOT on it', () => {
    // Stated positively rather than left to the deepStrictEqual above, because
    // these five are the ones whose absence carries a ruling behind it.
    for (const name of ['setAdminClaim', 'listAdmins', 'generateAuntieCopy', 'writeDraft', 'getDraft', 'getTrainingDoc']) {
      assert.strictEqual(auntieMayCall(name), false, `${name} must stay owner-only`);
    }
  });

  it('an endpoint nobody has thought about is refused', () => {
    assert.strictEqual(auntieMayCall('someEndpointAddedNextMonth'), false);
    assert.strictEqual(auntieMayCall(''), false);
  });
});

describe('resolveStaffRole, the precedence', () => {
  it('the owner reaches an owner-only endpoint', () => {
    assert.strictEqual(resolveStaffRole(OWNER, 'listAdmins'), 'owner');
    assert.strictEqual(resolveStaffRole(OWNER, 'generateAuntieCopy'), 'owner');
  });

  it('the owner reaches an allowlisted endpoint as the OWNER, not as a caretaker', () => {
    // The distinction matters at exactly one site: signCloudinaryUpload's
    // sandbox scope check keys on the role, and mislabelling the owner would
    // pin her uploads to a test tribe she does not have.
    assert.strictEqual(resolveStaffRole(OWNER, 'signCloudinaryUpload'), 'owner');
  });

  it('a caretaker reaches an allowlisted endpoint', () => {
    assert.strictEqual(resolveStaffRole(CARETAKER, 'signCloudinaryUpload'), 'caretaker');
    assert.strictEqual(resolveStaffRole(CARETAKER, 'searchMapbox'), 'caretaker');
    assert.strictEqual(resolveStaffRole(CARETAKER, 'retrieveMapbox'), 'caretaker');
  });

  it('a caretaker is REFUSED on every owner-only endpoint', () => {
    for (const name of ['setAdminClaim', 'listAdmins', 'generateAuntieCopy', 'writeDraft', 'getDraft', 'getTrainingDoc']) {
      assert.strictEqual(resolveStaffRole(CARETAKER, name), null, `${name} must refuse a caretaker`);
    }
  });

  it('a double-claimed account is resolved as the CARETAKER, never the owner', () => {
    assert.strictEqual(resolveStaffRole(DOUBLE_CLAIMED, 'signCloudinaryUpload'), 'caretaker');
    assert.strictEqual(resolveStaffRole(DOUBLE_CLAIMED, 'generateAuntieCopy'), null);
  });

  it('a refused caretaker does not fall through to the sandbox, even carrying testTribeId', () => {
    // The branch order in resolveStaffRole. A caretaker whose account also
    // carries a sandbox claim must be refused AS A CARETAKER on an owner-only
    // endpoint, not admitted as a test admin on one that opted in.
    const both = { uid: 'a', staffRole: 'auntie', testTribeId: 'kf_test' };
    assert.strictEqual(resolveStaffRole(both, 'getDraft', { allowTestAdmin: true }), null);
    assert.strictEqual(resolveStaffRole(both, 'signCloudinaryUpload', { allowTestAdmin: true }), 'caretaker');
  });

  it('the Stage-0I test admin is unchanged: only where the endpoint opted in', () => {
    assert.strictEqual(resolveStaffRole(TEST_ADMIN, 'signCloudinaryUpload', { allowTestAdmin: true }), 'testAdmin');
    assert.strictEqual(resolveStaffRole(TEST_ADMIN, 'signCloudinaryUpload'), null);
    assert.strictEqual(resolveStaffRole(TEST_ADMIN, 'searchMapbox', { allowTestAdmin: true }), 'testAdmin');
  });

  it('a blank testTribeId is not a sandbox account', () => {
    const blank = { uid: 't', testTribeId: '' };
    assert.strictEqual(resolveStaffRole(blank, 'signCloudinaryUpload', { allowTestAdmin: true }), null);
  });

  it('an unknown future staff role reaches NOTHING', () => {
    // Not the caretaker's grants, and not the owner's. Spec §3.
    const bookkeeper = { uid: 'b', staffRole: 'bookkeeper' };
    assert.strictEqual(resolveStaffRole(bookkeeper, 'signCloudinaryUpload', { allowTestAdmin: true }), null);
    assert.strictEqual(resolveStaffRole(bookkeeper, 'listAdmins'), null);
  });

  it('a kinfolk with portal credentials reaches nothing', () => {
    assert.strictEqual(resolveStaffRole(STRANGER, 'signCloudinaryUpload', { allowTestAdmin: true }), null);
    assert.strictEqual(resolveStaffRole(STRANGER, 'listAdmins'), null);
  });
});

describe('every endpoint in this codebase is decided, not merely unmentioned', () => {
  // The audit this PR owes: #948 left the whole codebase behind one
  // `admin === true` gate, so "we taught signCloudinaryUpload about staffRole"
  // is only half an answer. This walks index.js for its exported handlers and
  // asserts each one appears in the decision below, so an endpoint added later
  // cannot slip past the boundary review by being new.
  const DECISIONS = {
    setAdminClaim: 'owner', // mints the owner claim; the one refusal that matters most
    listAdmins: 'owner', // account administration
    writeDraft: 'owner', // n8n-era, no live caller
    getTrainingDoc: 'owner', // n8n-era, no live caller
    getDraft: 'owner', // n8n-era, no live caller
    signCloudinaryUpload: 'caretaker', // the KinTale photo
    searchMapbox: 'caretaker', // household address entry
    retrieveMapbox: 'caretaker', // the retrieve half of the same session
    generateAuntieCopy: 'owner', // reads dossiers into the prompt
  };

  it('index.js exports exactly the nine endpoints this table decides', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const exported = [...source.matchAll(/^exports\.([A-Za-z0-9_]+)\s*=/gm)].map((m) => m[1]);
    assert.deepStrictEqual(
      exported.sort(),
      Object.keys(DECISIONS).sort(),
      'an endpoint was added or removed: decide it in DECISIONS and in staffAccess.js',
    );
  });

  it('each endpoint sits on the side the table says', () => {
    for (const [name, side] of Object.entries(DECISIONS)) {
      assert.strictEqual(
        auntieMayCall(name),
        side === 'caretaker',
        `${name} is decided "${side}" but the allowlist disagrees`,
      );
    }
  });
});
