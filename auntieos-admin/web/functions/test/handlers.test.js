// Handler-level tests for the four Cloud Functions whose EXPORTED handlers were
// previously untested: setAdminClaim (onCall) + signCloudinaryUpload / searchMapbox /
// sendMessage (onRequest). The existing test/*.js files cover only the pure helpers
// (validateUploadFolder, assertAdminRemovalAllowed, mergeAdminClaim, ...); this file
// drives the real exported handlers end to end with their dependencies mocked, so the
// AUTH GATES and orchestration are exercised without touching Firebase, Cloudinary,
// Mapbox, or n8n.
//
// Technique (matches the "mock the deps, keep the handler unchanged" note): no source
// refactor. We invoke the actual exports:
//   - onCall handler via `.run({ auth, data })` (firebase-functions test entry point).
//   - onRequest handlers by calling `handler(req, res)` directly with express-like
//     mocks. The v2 onRequest+cors wrapper resolves on the response `finish` event, so
//     `res` is a real EventEmitter that emits `finish` from .json()/.end().
// Dependencies are mocked by shadowing `admin.auth` / `admin.firestore` with own data
// properties (the inherited getters otherwise call the live SDK), by swapping
// `global.fetch`, and by setting the secret-backed env vars the handlers read via
// defineSecret(...).value().
//
// Run: cd web/functions && npm test   (=> node --test)

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const admin = require('firebase-admin');
const idx = require('../index.js'); // side effect: initializeApp() + registers handlers

// ---------------------------------------------------------------------------
// express-like req/res doubles
// ---------------------------------------------------------------------------
function makeRes() {
  const r = new EventEmitter();
  r.headers = {};
  r.setHeader = function setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; return this; };
  r.getHeader = function getHeader(k) { return this.headers[String(k).toLowerCase()]; };
  r.removeHeader = function removeHeader(k) { delete this.headers[String(k).toLowerCase()]; return this; };
  r.status = function status(code) { this.statusCode = code; return this; };
  r.json = function json(obj) { this.jsonBody = obj; this.emit('finish'); return this; };
  r.end = function end() { this.emit('finish'); return this; };
  return r;
}

function makeReq({ method = 'POST', headers = {}, body = {}, query = {}, ip = '203.0.113.7' } = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {
    method,
    headers: lower, // cors middleware reads req.headers.origin
    body,
    query,
    ip,
    get(name) { return lower[String(name).toLowerCase()]; },
  };
}

// ---------------------------------------------------------------------------
// dependency mocking: admin SDK, fetch, secret env vars
// ---------------------------------------------------------------------------
function installAdmin({ auth, firestore } = {}) {
  if (auth) {
    Object.defineProperty(admin, 'auth', { value: auth, configurable: true, writable: true });
  }
  if (firestore) {
    // setAdminClaim reaches for admin.firestore.FieldValue.serverTimestamp(); keep it.
    firestore.FieldValue = { serverTimestamp: () => 'MOCK_SERVER_TS' };
    Object.defineProperty(admin, 'firestore', { value: firestore, configurable: true, writable: true });
  }
}

// Deleting the own data property restores the inherited SDK getter.
function restoreAdmin() {
  delete admin.auth;
  delete admin.firestore;
}

const origFetch = global.fetch;
const SECRET_ENV = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'MAPBOX_ACCESS_TOKEN'];
const savedEnv = {};

beforeEach(() => {
  for (const k of SECRET_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  restoreAdmin();
  global.fetch = origFetch;
  for (const k of SECRET_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const authReturning = (decoded) => () => ({ verifyIdToken: async () => decoded });
const authThrowing = (err) => () => ({ verifyIdToken: async () => { throw err; } });
const ADMIN_BEARER = { Authorization: 'Bearer good-token' };

// ===========================================================================
// setAdminClaim (onCall)
// ===========================================================================
describe('setAdminClaim handler (onCall)', () => {
  it('rejects an unauthenticated caller (unauthenticated)', async () => {
    await assert.rejects(
      () => idx.setAdminClaim.run({ auth: null, data: { uid: 'target', isAdmin: true } }),
      (e) => e.code === 'unauthenticated',
    );
  });

  it('rejects a signed-in caller WITHOUT the admin claim (no bootstrap escalation)', async () => {
    await assert.rejects(
      () => idx.setAdminClaim.run({ auth: { uid: 'u1', token: {} }, data: { uid: 'target', isAdmin: true } }),
      (e) => e.code === 'permission-denied',
    );
  });

  it('rejects a non-string uid (invalid-argument)', async () => {
    await assert.rejects(
      () => idx.setAdminClaim.run({ auth: { uid: 'u1', token: { admin: true } }, data: { uid: 123, isAdmin: true } }),
      (e) => e.code === 'invalid-argument',
    );
  });

  it('rejects a non-boolean isAdmin (invalid-argument)', async () => {
    await assert.rejects(
      () => idx.setAdminClaim.run({ auth: { uid: 'u1', token: { admin: true } }, data: { uid: 'target', isAdmin: 'yes' } }),
      (e) => e.code === 'invalid-argument',
    );
  });

  it('happy path grant: merges existing claims, writes admins doc, returns ok', async () => {
    const setClaims = [];
    const docWrites = [];
    installAdmin({
      auth: () => ({
        getUser: async () => ({ customClaims: { role: 'kinfolk', kinfolkId: 'kf_9' } }),
        setCustomUserClaims: async (uid, claims) => { setClaims.push({ uid, claims }); },
      }),
      firestore: () => ({
        collection: (name) => {
          assert.strictEqual(name, 'admins');
          return {
            count: () => ({ get: async () => ({ data: () => ({ count: 5 }) }) }),
            doc: (id) => ({
              set: async (obj) => { docWrites.push({ op: 'set', id, obj }); },
              delete: async () => { docWrites.push({ op: 'delete', id }); },
            }),
          };
        },
      }),
    });

    const out = await idx.setAdminClaim.run({
      auth: { uid: 'caller-admin', token: { admin: true } },
      data: { uid: 'target', isAdmin: true },
    });

    assert.deepStrictEqual(out, { ok: true, uid: 'target', isAdmin: true });
    // claim merge preserved the portal claims (never wholesale-replaced).
    assert.deepStrictEqual(setClaims[0], {
      uid: 'target',
      claims: { role: 'kinfolk', kinfolkId: 'kf_9', admin: true },
    });
    // admins/{uid} doc written, attributed to the caller, no delete on a grant.
    assert.strictEqual(docWrites.length, 1);
    assert.strictEqual(docWrites[0].op, 'set');
    assert.strictEqual(docWrites[0].id, 'target');
    assert.strictEqual(docWrites[0].obj.grantedBy, 'caller-admin');
  });

  it('error/edge: revoking the LAST admin is blocked and never touches Auth', async () => {
    let authTouched = false;
    installAdmin({
      auth: () => ({
        getUser: async () => { authTouched = true; return { customClaims: {} }; },
        setCustomUserClaims: async () => { authTouched = true; },
      }),
      firestore: () => ({
        collection: () => ({
          count: () => ({ get: async () => ({ data: () => ({ count: 1 }) }) }),
          doc: () => ({ set: async () => {}, delete: async () => {} }),
        }),
      }),
    });

    await assert.rejects(
      () => idx.setAdminClaim.run({
        auth: { uid: 'caller-admin', token: { admin: true } },
        data: { uid: 'someone-else', isAdmin: false },
      }),
      (e) => e.code === 'failed-precondition' && /last admin/i.test(e.message),
    );
    assert.strictEqual(authTouched, false, 'lockout guard must fire before any Auth mutation');
  });
});

// ===========================================================================
// signCloudinaryUpload (onRequest)
// ===========================================================================
describe('signCloudinaryUpload handler (onRequest)', () => {
  function configureCloudinary({ pingStatus = 200 } = {}) {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
    process.env.CLOUDINARY_API_KEY = 'demo-key';
    process.env.CLOUDINARY_API_SECRET = 'demo-secret';
    // The handler verifies the credentials against Cloudinary's /ping before it
    // signs, so a WRONG secret fails here instead of silently downstream. Stub
    // that ping, and clear the per-instance cache so each test starts cold.
    idx.__resetCloudinaryCredentialCache();
    global.fetch = async () => ({ status: pingStatus });
  }

  it('405 on a non-POST method', async () => {
    const res = makeRes();
    await idx.signCloudinaryUpload(makeReq({ method: 'GET' }), res);
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.jsonBody.error, 'method_not_allowed');
  });

  it('401 when the bearer token is missing', async () => {
    const res = makeRes();
    await idx.signCloudinaryUpload(makeReq({ headers: {} }), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonBody.error, 'missing_bearer_token');
  });

  it('403 when the token is valid but lacks the admin claim', async () => {
    installAdmin({ auth: authReturning({ uid: 'u1', admin: false }) });
    const res = makeRes();
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body: {} }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonBody.error, 'admin_required');
  });

  it('401 when verifyIdToken throws (expired / forged token)', async () => {
    installAdmin({ auth: authThrowing(new Error('token expired')) });
    const res = makeRes();
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body: {} }), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonBody.error, 'invalid_bearer_token');
  });

  it('happy path: returns an entity-scoped Cloudinary signature and never leaks the secret', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    const res = makeRes();
    const body = { folder: 'tribetails/entity/ent_1', entityType: 'entity', entityId: 'ent_1' };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);

    assert.strictEqual(res.statusCode, 200);
    const out = res.jsonBody;
    assert.strictEqual(out.cloudName, 'demo-cloud');
    assert.strictEqual(out.apiKey, 'demo-key');
    assert.strictEqual(out.folder, 'tribetails/entity/ent_1');
    assert.strictEqual(out.signedBy, 'admin-1');
    // #583: with no resourceKind in the body the signer defaults to image, so
    // the signed set is folder + timestamp + transformation, alphabetically.
    const base = `folder=${out.folder}&timestamp=${out.timestamp}&transformation=fl_force_strip` + 'demo-secret';
    assert.strictEqual(out.signature, crypto.createHash('sha1').update(base).digest('hex'));
    // the api secret must never cross the wire.
    assert.ok(!('apiSecret' in out));
    assert.ok(!JSON.stringify(out).includes('demo-secret'));
  });

  it('Stage-0I test-admin (testTribeId, no admin) may sign an upload PINNED to its own tribe', async () => {
    configureCloudinary();
    // no admin claim; carries a non-empty testTribeId sandbox claim.
    installAdmin({ auth: authReturning({ uid: 'test-1', testTribeId: 'kf_test' }) });
    const res = makeRes();
    const body = { folder: 'tribetails/kinfolk/kf_test', entityType: 'kinfolk', entityId: 'kf_test' };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);

    assert.strictEqual(res.statusCode, 200);
    const out = res.jsonBody;
    assert.strictEqual(out.folder, 'tribetails/kinfolk/kf_test');
    assert.strictEqual(out.signedBy, 'test-1');
    // signature signs folder+timestamp+transformation with the secret appended.
    const base = `folder=${out.folder}&timestamp=${out.timestamp}&transformation=fl_force_strip` + 'demo-secret';
    assert.strictEqual(out.signature, crypto.createHash('sha1').update(base).digest('hex'));
  });

  it('403 test_scope_denied when a test-admin signs an upload OUTSIDE its tribe', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'test-1', testTribeId: 'kf_test' }) });
    const res = makeRes();
    // entityId (kf_other) != testTribeId (kf_test) -> out of sandbox scope.
    const body = { folder: 'tribetails/kinfolk/kf_other', entityType: 'kinfolk', entityId: 'kf_other' };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonBody.error, 'test_scope_denied');
  });

  it('403 admin_required for a signed-in caller with NEITHER admin NOR testTribeId', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'nobody' }) });
    const res = makeRes();
    const body = { folder: 'tribetails/kinfolk/kf_test', entityType: 'kinfolk', entityId: 'kf_test' };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonBody.error, 'admin_required');
  });

  it('400 when the folder attempts path traversal (validateUploadFolder enforced)', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    const res = makeRes();
    const body = { folder: 'tribetails/entity/../secrets', entityType: 'entity', entityId: 'secrets' };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.jsonBody.error, /\.\.|backslash|relative|segment/i);
  });

  // ── #583: the metadata strip is IN the signature, not just in the response ──
  //
  // Cloudinary recomputes the signature over the params it RECEIVES. So the
  // only thing that actually forces a client to strip is the transformation
  // being part of the signature base: a client that drops it gets "Invalid
  // Signature" rather than a coordinate-bearing original. These tests
  // recompute sha1 by hand from the base string, so they fail if the value
  // stops reaching the base even while the response field still says the
  // right thing.
  it('#583 image upload: signs transformation=fl_force_strip INTO the signature base', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    const res = makeRes();
    const body = {
      folder: 'tribetails/kinfolk/kf_1', entityType: 'kinfolk', entityId: 'kf_1',
      resourceKind: 'image',
    };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 200);
    const out = res.jsonBody;
    // the response tells the client what to post ...
    assert.strictEqual(out.transformation, 'fl_force_strip');
    // ... and the signature is genuinely computed over it, in alphabetical
    // order (folder < timestamp < transformation), per Cloudinary's recipe.
    const base = `folder=tribetails/kinfolk/kf_1&timestamp=${out.timestamp}&transformation=fl_force_strip` + 'demo-secret';
    assert.strictEqual(out.signature, crypto.createHash('sha1').update(base).digest('hex'));
    // and it is NOT merely a returned constant: the same request without the
    // transformation in the base produces a different signature.
    const withoutStrip = `folder=tribetails/kinfolk/kf_1&timestamp=${out.timestamp}` + 'demo-secret';
    assert.notStrictEqual(out.signature, crypto.createHash('sha1').update(withoutStrip).digest('hex'));
  });
  it('#583/#593 video upload: NO transformation, but tags=needs-gps-strip, both in the signature', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    const res = makeRes();
    const body = {
      folder: 'tribetails/kinfolk/kf_1', entityType: 'kinfolk', entityId: 'kf_1',
      resourceKind: 'video',
    };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 200);
    const out = res.jsonBody;
    // #583: a blank transformation still tells the client to post no
    // transformation field at all. `fl_force_strip` is image-only, and an
    // incoming transformation on a video means re-encoding it inside the
    // upload request. That has not changed.
    assert.strictEqual(out.transformation, '');
    // #593: what HAS changed is that a video now carries a pending-strip tag
    // from the moment it lands, so the account itself lists every video whose
    // coordinates are still in place -- including one whose upload succeeded
    // and whose Firestore row never got written.
    assert.strictEqual(out.tags, 'needs-gps-strip');
    // Alphabetical base: folder < tags < timestamp. The tag is genuinely IN the
    // signature, so a client cannot drop it and cannot add one of its own.
    const base = `folder=tribetails/kinfolk/kf_1&tags=needs-gps-strip&timestamp=${out.timestamp}` + 'demo-secret';
    assert.strictEqual(out.signature, crypto.createHash('sha1').update(base).digest('hex'));
    // and it is NOT merely a returned constant: the same request without the
    // tag in the base produces a different signature, so a video posted
    // without it is refused by Cloudinary rather than stored untagged.
    const withoutTag = `folder=tribetails/kinfolk/kf_1&timestamp=${out.timestamp}` + 'demo-secret';
    assert.notStrictEqual(out.signature, crypto.createHash('sha1').update(withoutTag).digest('hex'));
  });
  it('#593 image upload: signs NO tags -- a pending-strip tag on a photo would be a lie', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    const res = makeRes();
    const body = {
      folder: 'tribetails/kinfolk/kf_1', entityType: 'kinfolk', entityId: 'kf_1',
      resourceKind: 'image',
    };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 200);
    // A photo is stripped BEFORE Cloudinary stores it (#583), so it is never
    // pending anything, and the base stays exactly what #583 fixed it at.
    assert.strictEqual(res.jsonBody.tags, '');
    const base = `folder=tribetails/kinfolk/kf_1&timestamp=${res.jsonBody.timestamp}&transformation=fl_force_strip` + 'demo-secret';
    assert.strictEqual(res.jsonBody.signature, crypto.createHash('sha1').update(base).digest('hex'));
  });
  it('#583 raw upload (documents/audio): signs NO transformation', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    const res = makeRes();
    const body = {
      folder: 'tribetails/tribal_intel/pending', entityType: 'tribal_intel', entityId: 'pending',
      resourceKind: 'raw',
    };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 200);
    const out = res.jsonBody;
    assert.strictEqual(out.transformation, '');
    // #593: raw is documents and audio, neither of which carries a location
    // atom this repo strips, so it gets no pending-strip tag either.
    assert.strictEqual(out.tags, '');
    const base = `folder=tribetails/tribal_intel/pending&timestamp=${out.timestamp}` + 'demo-secret';
    assert.strictEqual(out.signature, crypto.createHash('sha1').update(base).digest('hex'));
  });
  it('#583 400 on an unrecognized resourceKind, never a silently unstripped upload', async () => {
    configureCloudinary();
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    const res = makeRes();
    const body = {
      folder: 'tribetails/kinfolk/kf_1', entityType: 'kinfolk', entityId: 'kf_1',
      resourceKind: 'photo',
    };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.jsonBody.error, /resourceKind/i);
    assert.ok(!('signature' in res.jsonBody));
  });
  it('500 when the Cloudinary secrets are not configured (fail loud, no signature)', async () => {
    // env deliberately left unset by beforeEach.
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    const res = makeRes();
    const body = { folder: 'tribetails/entity/ent_1', entityType: 'entity', entityId: 'ent_1' };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.jsonBody.error, 'cloudinary_signing_not_configured');
  });
});

// ===========================================================================
// writeDraft / getDraft / getTrainingDoc (onRequest)
//
// These three carried the n8n shared secret (`x-auntie-key`) until n8n was
// retired and the secret destroyed. They now take the same Bearer admin token
// as generateAuntieCopy, the generator they serve. The gate is the thing that
// changed, so the gate is what these pin: an unauthenticated caller must not
// reach Firestore, and a signed-in non-admin must not either.
// ===========================================================================
describe('draft endpoints: admin-token gate', () => {
  const ENDPOINTS = [
    { name: 'writeDraft', call: (req, res) => idx.writeDraft(req, res), body: { draft: { copy: 'hi' } } },
    { name: 'getDraft', call: (req, res) => idx.getDraft(req, res), query: { id: 'd1' } },
    { name: 'getTrainingDoc', call: (req, res) => idx.getTrainingDoc(req, res), query: { communication_type: 'sms' } },
  ];

  for (const ep of ENDPOINTS) {
    it(`${ep.name}: 401 when the bearer token is missing`, async () => {
      // A firestore that throws proves the gate ran BEFORE any read/write: if
      // the handler reached Firestore the test fails on the throw, not the code.
      installAdmin({ firestore: () => { throw new Error(`${ep.name} reached Firestore unauthenticated`); } });
      const res = makeRes();
      await ep.call(makeReq({ method: ep.query ? 'GET' : 'POST', headers: {}, body: ep.body ?? {}, query: ep.query ?? {} }), res);
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.jsonBody.error, 'missing_bearer_token');
    });

    it(`${ep.name}: 403 when the caller is signed in but not an admin`, async () => {
      installAdmin({
        auth: authReturning({ uid: 'u1', admin: false }),
        firestore: () => { throw new Error(`${ep.name} reached Firestore without the admin claim`); },
      });
      const res = makeRes();
      await ep.call(makeReq({ method: ep.query ? 'GET' : 'POST', headers: ADMIN_BEARER, body: ep.body ?? {}, query: ep.query ?? {} }), res);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.jsonBody.error, 'admin_required');
    });

    it(`${ep.name}: 401 when the token is expired or forged`, async () => {
      installAdmin({
        auth: authThrowing(new Error('token expired')),
        firestore: () => { throw new Error(`${ep.name} reached Firestore on a bad token`); },
      });
      const res = makeRes();
      await ep.call(makeReq({ method: ep.query ? 'GET' : 'POST', headers: ADMIN_BEARER, body: ep.body ?? {}, query: ep.query ?? {} }), res);
      assert.strictEqual(res.statusCode, 401);
      assert.strictEqual(res.jsonBody.error, 'invalid_bearer_token');
    });
  }

  // A Firestore double that serves BOTH collections these handlers touch: the
  // draft collection and the rate-limit bucket. `bucket` seeds the caller's
  // current budget state; `transactionError` makes the limiter itself fail.
  function fakeFirestore({ bucket, transactionError } = {}) {
    const writes = [];
    const store = { bucket };
    const makeDoc = (collection, id) => ({
      id,
      _collection: collection,
      get: async () => ({
        exists: collection === 'draft_rate_limits' && store.bucket !== undefined,
        data: () => store.bucket,
      }),
      set: async (data, opts) => { writes.push({ collection, id, data, opts }); },
    });
    const db = () => ({
      collection: (name) => ({ doc: (id) => makeDoc(name, id ?? 'generated-id') }),
      runTransaction: async (fn) => {
        if (transactionError) throw transactionError;
        return fn({
          get: (ref) => ref.get(),
          set: (ref, data, opts) => {
            if (ref._collection === 'draft_rate_limits') store.bucket = { ...(store.bucket || {}), ...data };
            writes.push({ collection: ref._collection, id: ref.id, data, opts });
          },
        });
      },
    });
    return { db, writes, store, drafts: () => writes.filter((w) => w.collection === 'generated_drafts') };
  }

  const CURRENT_WINDOW = () => Math.floor(Date.now() / 60000);

  it('writeDraft: an admin write lands in generated_drafts and returns its id', async () => {
    const fs = fakeFirestore();
    installAdmin({ auth: authReturning({ uid: 'admin1', admin: true }), firestore: fs.db });
    const res = makeRes();
    await idx.writeDraft(makeReq({ headers: ADMIN_BEARER, body: { docId: 'd7', draft: { copy: 'Buddy had a great walk.' } } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { ok: true, id: 'd7' });
    const drafts = fs.drafts();
    assert.strictEqual(drafts.length, 1);
    assert.strictEqual(drafts[0].data.copy, 'Buddy had a great walk.');
    assert.deepStrictEqual(drafts[0].opts, { merge: true });
    // The call consumed budget, so the meter reflects served traffic.
    assert.strictEqual(fs.store.bucket.count, 1);
  });

  it('429 once the caller has spent its window budget, and nothing is written', async () => {
    // The regression this guards: moving these endpoints onto admin tokens
    // deleted the old per-IP limiter. A verified identity does not bound
    // volume, so a leaked token or a looping client would have had free rein.
    const fs = fakeFirestore({ bucket: { window: CURRENT_WINDOW(), count: 60 } });
    installAdmin({ auth: authReturning({ uid: 'admin1', admin: true }), firestore: fs.db });
    const res = makeRes();
    await idx.writeDraft(makeReq({ headers: ADMIN_BEARER, body: { draft: { copy: 'x' } } }), res);
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.jsonBody.error, 'rate_limit_exceeded');
    assert.strictEqual(fs.drafts().length, 0);
    // A blocked caller does not advance its own counter.
    assert.strictEqual(fs.store.bucket.count, 60);
  });

  it('the budget is shared, so a loop cannot rotate between the three endpoints', async () => {
    const fs = fakeFirestore({ bucket: { window: CURRENT_WINDOW(), count: 60 } });
    installAdmin({ auth: authReturning({ uid: 'admin1', admin: true }), firestore: fs.db });
    for (const call of [
      (r) => idx.getDraft(makeReq({ method: 'GET', headers: ADMIN_BEARER, query: { id: 'd1' } }), r),
      (r) => idx.getTrainingDoc(makeReq({ method: 'GET', headers: ADMIN_BEARER, query: { id: 't1' } }), r),
    ]) {
      const res = makeRes();
      await call(res);
      assert.strictEqual(res.statusCode, 429);
    }
  });

  it('503 when the limiter itself is broken: no meter, no service', async () => {
    // Fail closed. An unmetered endpoint is the exact thing the limiter exists
    // to prevent, so a broken meter must not degrade to unlimited access.
    const fs = fakeFirestore({ transactionError: new Error('firestore unavailable') });
    installAdmin({ auth: authReturning({ uid: 'admin1', admin: true }), firestore: fs.db });
    const res = makeRes();
    await idx.writeDraft(makeReq({ headers: ADMIN_BEARER, body: { draft: { copy: 'x' } } }), res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.jsonBody.error, 'rate_limiter_unavailable');
    assert.strictEqual(fs.drafts().length, 0);
  });

  it('rejects a docId that is a PATH, so a write cannot land in a subcollection', async () => {
    // `collection('generated_drafts').doc('a/b/c')` resolves to
    // generated_drafts/a/b/c, a document no query over the collection sees.
    const fs = fakeFirestore();
    installAdmin({ auth: authReturning({ uid: 'admin1', admin: true }), firestore: fs.db });
    const res = makeRes();
    await idx.writeDraft(makeReq({ headers: ADMIN_BEARER, body: { docId: 'a/b/c', draft: { copy: 'x' } } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.jsonBody.error, /must not contain/);
    assert.strictEqual(fs.drafts().length, 0);
    // Budget is spent before validation on purpose: a flood of malformed
    // requests is traffic worth capping, not free CPU.
    assert.strictEqual(fs.store.bucket.count, 1);
  });

  it('rejects a draft that tries to forge the server-written _writtenAt field', async () => {
    const fs = fakeFirestore();
    installAdmin({ auth: authReturning({ uid: 'admin1', admin: true }), firestore: fs.db });
    const res = makeRes();
    await idx.writeDraft(makeReq({ headers: ADMIN_BEARER, body: { draft: { _writtenAt: 'yesterday' } } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.jsonBody.error, /reserved/);
    assert.strictEqual(fs.drafts().length, 0);
  });

  it('getDraft rejects a path id too, and never reads', async () => {
    const fs = fakeFirestore();
    installAdmin({ auth: authReturning({ uid: 'admin1', admin: true }), firestore: fs.db });
    const res = makeRes();
    await idx.getDraft(makeReq({ method: 'GET', headers: ADMIN_BEARER, query: { id: 'x/y/z' } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.jsonBody.error, /must not contain/);
  });

  it('still reports a missing id as a missing id, not as a malformed one', async () => {
    const fs = fakeFirestore();
    installAdmin({ auth: authReturning({ uid: 'admin1', admin: true }), firestore: fs.db });
    const res = makeRes();
    await idx.getTrainingDoc(makeReq({ method: 'GET', headers: ADMIN_BEARER, query: {} }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonBody.error, 'id query param required');
  });
});

// ===========================================================================
// searchMapbox (onRequest)
// ===========================================================================
describe('searchMapbox handler (onRequest)', () => {
  it('405 on a non-POST method', async () => {
    const res = makeRes();
    await idx.searchMapbox(makeReq({ method: 'GET' }), res);
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.jsonBody.error, 'method_not_allowed');
  });

  it('401 when the bearer token is missing', async () => {
    const res = makeRes();
    await idx.searchMapbox(makeReq({ headers: {} }), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonBody.error, 'missing_bearer_token');
  });

  it('403 when the token lacks the admin claim', async () => {
    installAdmin({ auth: authReturning({ uid: 'u1', admin: false }) });
    const res = makeRes();
    await idx.searchMapbox(makeReq({ headers: ADMIN_BEARER, body: { query: 'x', sessionToken: 's' } }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonBody.error, 'admin_required');
  });

  it('happy path: proxies suggestions upstream with the secret token, returns only suggestions', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'sk.mapbox-secret';
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    let calledUrl;
    global.fetch = async (url) => {
      calledUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ suggestions: [{ name: 'Main St' }] }) };
    };
    const res = makeRes();
    await idx.searchMapbox(makeReq({ headers: ADMIN_BEARER, body: { query: '123 Main', sessionToken: 'sess-1' } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody.suggestions, [{ name: 'Main St' }]);
    assert.strictEqual(res.jsonBody.signedBy, 'admin-1');
    // the secret token is attached server-side to the upstream request...
    assert.ok(calledUrl.includes('access_token=sk.mapbox-secret'));
    assert.ok(calledUrl.includes('session_token=sess-1'));
    // ...but never handed back to the browser caller.
    assert.ok(!JSON.stringify(res.jsonBody).includes('sk.mapbox-secret'));
  });

  it('400 when the query is missing (before any upstream call)', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'sk.mapbox-secret';
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    let fetched = false;
    global.fetch = async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; };
    const res = makeRes();
    await idx.searchMapbox(makeReq({ headers: ADMIN_BEARER, body: { sessionToken: 'sess-1' } }), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonBody.error, 'query is required');
    assert.strictEqual(fetched, false);
  });

  it('502 when Mapbox returns an upstream error', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'sk.mapbox-secret';
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limited' });
    const res = makeRes();
    await idx.searchMapbox(makeReq({ headers: ADMIN_BEARER, body: { query: '123 Main', sessionToken: 'sess-1' } }), res);
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.jsonBody.error, 'mapbox_upstream_error');
    assert.strictEqual(res.jsonBody.status, 429);
  });
});

// ===========================================================================
// The stored secret is trimmed before it reaches Mapbox (MYTRIBE-FUNCTIONS-D)
//
// `gcloud secrets versions add --data-file=-` fed by `echo` stores a trailing
// newline, and Secret Manager returns the bytes exactly as stored. `URL`
// percent-encodes it to %0A, so Mapbox is handed a token it never issued and
// answers 401 on a credential that is otherwise perfectly valid. These assert
// on the token that went OUT, because with the upstream stubbed the handler
// answers 200 either way and the newline is invisible in the response.
// ===========================================================================
describe('Mapbox proxies trim the stored secret', () => {
  const tokenOn = (url) => new URL(url).searchParams.get('access_token');
  it('searchMapbox strips a trailing newline from the secret', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'sk.mapbox-secret\n';
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    let calledUrl;
    global.fetch = async (url) => {
      calledUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ suggestions: [] }) };
    };
    const res = makeRes();
    await idx.searchMapbox(makeReq({ headers: ADMIN_BEARER, body: { query: '123 Main', sessionToken: 'sess-1' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(tokenOn(calledUrl), 'sk.mapbox-secret');
    assert.ok(!calledUrl.includes('%0A'), 'the newline reached Mapbox percent-encoded');
  });
  it('retrieveMapbox strips a trailing newline from the secret', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'sk.mapbox-secret\n';
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    let calledUrl;
    global.fetch = async (url) => {
      calledUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ features: [{ properties: {} }] }) };
    };
    const res = makeRes();
    await idx.retrieveMapbox(makeReq({ headers: ADMIN_BEARER, body: { mapboxId: 'dXJuOm1ieA', sessionToken: 'sess-1' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(tokenOn(calledUrl), 'sk.mapbox-secret');
    assert.ok(!calledUrl.includes('%0A'), 'the newline reached Mapbox percent-encoded');
  });
  it('a whitespace-only secret reads as unconfigured rather than being sent upstream', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = '\n';
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    let fetched = false;
    global.fetch = async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; };
    const res = makeRes();
    await idx.searchMapbox(makeReq({ headers: ADMIN_BEARER, body: { query: '123 Main', sessionToken: 'sess-1' } }), res);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.jsonBody.error, 'mapbox_access_token_not_configured');
    assert.strictEqual(fetched, false);
  });
});

// sendMessage (onRequest) tests REMOVED 2026-07-23 with the handler.
//
// Worth recording why, because the suite was actively misleading. Five tests
// covered a proxy to https://n8n.tribetails.com/webhook/auntie-send-message
// with `global.fetch` stubbed, so they reported a working message pipeline
// against a host that had already been retired. One of them asserted that an
// ECONNREFUSED from the upstream produced a 503 `infra_failure`, which is
// exactly what prod was doing on every send, filed as a passing case. Coverage
// went up while correctness went to zero.
//
// The send now goes through MyTribe's `sendExternalMessage` onCall, which is
// covered in mytribe/functions/test/sendExternalMessage.test.ts against the
// real handler rather than a mocked upstream.

// ===========================================================================
// #944: the caretaker at the gate, endpoint by endpoint
// ===========================================================================
//
// `test/staffAccess.test.js` proves the TABLE. This proves the HANDLERS consult
// it: that a real Auntie token driven through the real exported handler is
// admitted where the table says and refused where it does not, and that nothing
// reaches Firestore, Cloudinary or Mapbox on a refusal.
//
// The caretaker token is the shape `grant-staff-role.mjs` mints: `staffRole:
// 'auntie'` and NO `admin` claim, deliberately, so any site nobody revisited
// refuses her instead of granting owner power.
const AUNTIE_TOKEN = { uid: 'auntie-1', staffRole: 'auntie' };
const DOUBLE_CLAIMED_TOKEN = { uid: 'both-1', admin: true, staffRole: 'auntie' };

describe('#944 caretaker: the endpoints she MAY reach', () => {
  it('signCloudinaryUpload: an Auntie signs a KinTale photo upload, UNSCOPED', async () => {
    // The second of the two blockers. Without this she signs in (blocker one,
    // closed in src/lib/access.ts) and every photo she attaches to a KinTale
    // fails at the signer.
    process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
    process.env.CLOUDINARY_API_KEY = 'demo-key';
    process.env.CLOUDINARY_API_SECRET = 'demo-secret';
    idx.__resetCloudinaryCredentialCache();
    global.fetch = async () => ({ status: 200 });
    installAdmin({ auth: authReturning(AUNTIE_TOKEN) });

    const res = makeRes();
    // VISIT_LOG: the KinTale composer's photo strip, whose entityId is the
    // kin_care_sessions doc id. The folder is Android's and the desktop's
    // shared convention, so a photo attached to a visit on any platform lands
    // in one Cloudinary folder.
    const body = {
      folder: 'tribetails/visit_log/sess_77',
      entityType: 'VISIT_LOG',
      entityId: 'sess_77',
    };
    await idx.signCloudinaryUpload(makeReq({ headers: ADMIN_BEARER, body }), res);

    assert.strictEqual(res.statusCode, 200, `expected a signature, got ${JSON.stringify(res.jsonBody)}`);
    assert.strictEqual(res.jsonBody.folder, 'tribetails/visit_log/sess_77');
    assert.strictEqual(res.jsonBody.signedBy, 'auntie-1');
    // The signature is real, not a stub: recomputing it from the returned
    // params and the secret must match, or the upload would be rejected by
    // Cloudinary and this test would be asserting a 200 that does not work.
    const base =
      `folder=${res.jsonBody.folder}&timestamp=${res.jsonBody.timestamp}` +
      '&transformation=fl_force_strip' +
      'demo-secret';
    assert.strictEqual(res.jsonBody.signature, crypto.createHash('sha1').update(base).digest('hex'));
  });

  it('signCloudinaryUpload: she is NOT pinned to a sandbox tribe', async () => {
    // The trap this PR had to step over. The sandbox scope check used to key on
    // `decodedToken.admin !== true`, and a caretaker carries no admin claim
    // either, so the obvious way to admit her would have dropped her into the
    // test-admin branch and answered `test_scope_denied` on every upload: role
    // reachable, camera still broken. It keys on the resolved role now.
    process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
    process.env.CLOUDINARY_API_KEY = 'demo-key';
    process.env.CLOUDINARY_API_SECRET = 'demo-secret';
    idx.__resetCloudinaryCredentialCache();
    global.fetch = async () => ({ status: 200 });
    installAdmin({ auth: authReturning(AUNTIE_TOKEN) });

    const res = makeRes();
    await idx.signCloudinaryUpload(
      makeReq({
        headers: ADMIN_BEARER,
        // An entityId that is nobody's testTribeId: a real household.
        body: { folder: 'tribetails/entity/kf_real', entityType: 'entity', entityId: 'kf_real' },
      }),
      res,
    );
    assert.notStrictEqual(res.jsonBody && res.jsonBody.error, 'test_scope_denied');
    assert.strictEqual(res.statusCode, 200);
  });

  it('searchMapbox: an Auntie may look up a household address', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'mb-secret';
    installAdmin({ auth: authReturning(AUNTIE_TOKEN) });
    global.fetch = async () => ({ ok: true, json: async () => ({ suggestions: [{ name: 'Bark House' }] }) });

    const res = makeRes();
    await idx.searchMapbox(
      makeReq({ headers: ADMIN_BEARER, body: { query: '123 Bark Ave', sessionToken: 'sess-1' } }),
      res,
    );
    assert.strictEqual(res.statusCode, 200, `got ${JSON.stringify(res.jsonBody)}`);
    assert.strictEqual(res.jsonBody.signedBy, 'auntie-1');
  });

  it('retrieveMapbox: and complete the same billed search session', async () => {
    process.env.MAPBOX_ACCESS_TOKEN = 'mb-secret';
    installAdmin({ auth: authReturning(AUNTIE_TOKEN) });
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ features: [{ properties: { full_address: '123 Bark Ave' } }] }),
    });

    const res = makeRes();
    await idx.retrieveMapbox(
      makeReq({ headers: ADMIN_BEARER, body: { mapboxId: 'mb-1', sessionToken: 'sess-1' } }),
      res,
    );
    assert.strictEqual(res.statusCode, 200, `got ${JSON.stringify(res.jsonBody)}`);
  });
});

describe('#944 caretaker: the endpoints that must keep REFUSING her', () => {
  it('setAdminClaim: an Auntie cannot mint herself the owner claim', async () => {
    // The refusal the spec calls the one that costs the most. She carries no
    // `admin` claim, so this is refused by construction rather than by a line
    // anyone had to write — which is the entire argument for splitting the
    // claim instead of adding a field beside a shared `admin: true`.
    installAdmin({
      auth: () => ({
        getUser: async () => {
          throw new Error('setAdminClaim reached Firebase Auth for a caretaker caller');
        },
        setCustomUserClaims: async () => {
          throw new Error('setAdminClaim wrote a claim for a caretaker caller');
        },
      }),
      firestore: () => {
        throw new Error('setAdminClaim reached Firestore for a caretaker caller');
      },
    });
    await assert.rejects(
      () =>
        idx.setAdminClaim.run({
          auth: { uid: 'auntie-1', token: AUNTIE_TOKEN },
          data: { uid: 'auntie-1', isAdmin: true },
        }),
      (e) => e.code === 'permission-denied',
    );
  });

  it('setAdminClaim: a DOUBLE-CLAIMED caller is refused too', async () => {
    // The account that should not exist degrades to the caretaker everywhere,
    // and this is the callable where letting it keep the owner's reach would
    // let a contractor mint herself a clean owner account and leave the
    // boundary behind entirely.
    installAdmin({
      auth: () => ({
        getUser: async () => {
          throw new Error('setAdminClaim reached Firebase Auth for a double-claimed caller');
        },
        setCustomUserClaims: async () => {
          throw new Error('setAdminClaim wrote a claim for a double-claimed caller');
        },
      }),
      firestore: () => {
        throw new Error('setAdminClaim reached Firestore for a double-claimed caller');
      },
    });
    await assert.rejects(
      () =>
        idx.setAdminClaim.run({
          auth: { uid: 'both-1', token: DOUBLE_CLAIMED_TOKEN },
          data: { uid: 'target', isAdmin: true },
        }),
      (e) => e.code === 'permission-denied',
    );
  });

  it('listAdmins: an Auntie cannot read the admin roster', async () => {
    installAdmin({
      firestore: () => {
        throw new Error('listAdmins reached Firestore for a caretaker');
      },
    });
    await assert.rejects(
      () => idx.listAdmins.run({ auth: { uid: 'auntie-1', token: AUNTIE_TOKEN } }),
      (e) => e.code === 'permission-denied',
    );
  });

  it('listAdmins: a double-claimed caller is refused too', async () => {
    installAdmin({
      firestore: () => {
        throw new Error('listAdmins reached Firestore for a double-claimed caller');
      },
    });
    await assert.rejects(
      () => idx.listAdmins.run({ auth: { uid: 'both-1', token: DOUBLE_CLAIMED_TOKEN } }),
      (e) => e.code === 'permission-denied',
    );
  });

  it('generateAuntieCopy: refused, so no dossier is laundered into a draft', async () => {
    // `runGenerate` reads dossiers/{kinfolkId} and puts its rawSummary,
    // communicationStyle, householdNotes and relationshipWithAuntie into the
    // prompt and the returned draft. Dossiers are admin-only by the ruling, so
    // the leak would have arrived as generated prose rather than as a read.
    installAdmin({
      auth: authReturning(AUNTIE_TOKEN),
      firestore: () => {
        throw new Error('generateAuntieCopy reached Firestore for a caretaker');
      },
    });
    const res = makeRes();
    await idx.generateAuntieCopy(
      makeReq({ headers: ADMIN_BEARER, body: { kinfolk_id: 'kf_1', communication_type: 'sms' } }),
      res,
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonBody.error, 'admin_required');
  });

  const DRAFT_ENDPOINTS = [
    { name: 'writeDraft', call: (req, res) => idx.writeDraft(req, res), body: { draft: { copy: 'hi' } } },
    { name: 'getDraft', call: (req, res) => idx.getDraft(req, res), query: { id: 'd1' } },
    { name: 'getTrainingDoc', call: (req, res) => idx.getTrainingDoc(req, res), query: { id: 'td1' } },
  ];

  for (const ep of DRAFT_ENDPOINTS) {
    it(`${ep.name}: refused, and never spends the shared draft budget`, async () => {
      // These three are owner-only because nothing calls them (n8n is retired),
      // not because the ruling denies her the data: the rules already grant a
      // caretaker `generated_drafts` and `training_documents` as direct client
      // reads. The Firestore throw also pins that the gate runs BEFORE the rate
      // limiter, so a refused caller cannot burn the budget the owner shares.
      installAdmin({
        auth: authReturning(AUNTIE_TOKEN),
        firestore: () => {
          throw new Error(`${ep.name} reached Firestore for a caretaker`);
        },
      });
      const res = makeRes();
      await ep.call(
        makeReq({
          method: ep.query ? 'GET' : 'POST',
          headers: ADMIN_BEARER,
          body: ep.body ?? {},
          query: ep.query ?? {},
        }),
        res,
      );
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.jsonBody.error, 'admin_required');
    });
  }

  it('an unknown future staff role reaches NOTHING, not even the allowlisted endpoints', async () => {
    // Spec §3. `staffRole: 'bookkeeper'` is neither the owner nor the
    // caretaker, and the caretaker's grants are the ones it would be easiest to
    // hand it by accident with a `token.staffRole !== undefined` test.
    installAdmin({ auth: authReturning({ uid: 'bk-1', staffRole: 'bookkeeper' }) });
    const res = makeRes();
    await idx.signCloudinaryUpload(
      makeReq({
        headers: ADMIN_BEARER,
        body: { folder: 'tribetails/entity/kf_1', entityType: 'entity', entityId: 'kf_1' },
      }),
      res,
    );
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonBody.error, 'admin_required');
  });
});

describe('#944 setAdminClaim will not mint the owner onto a staff account', () => {
  // Reported by #948 and closed here. The degrade (both isOwner()
  // implementations subtract the caretaker) is a good last resort and a bad
  // ONLY resort: it means the account exists, and every gate not yet taught the
  // subtraction is one line away from granting it owner power.
  function ownerCallerAgainst(existingClaims, sink) {
    installAdmin({
      auth: () => ({
        getUser: async () => ({ customClaims: existingClaims }),
        setCustomUserClaims: async (uid, claims) => {
          sink.push({ uid, claims });
        },
      }),
      firestore: () => ({
        collection: () => ({
          count: () => ({ get: async () => ({ data: () => ({ count: 5 }) }) }),
          doc: () => ({
            set: async () => {
              sink.push({ wroteAdminsDoc: true });
            },
            delete: async () => {
              sink.push({ deletedAdminsDoc: true });
            },
          }),
        }),
      }),
    });
  }

  it('refuses to grant admin to an account already holding staffRole: auntie', async () => {
    const sink = [];
    ownerCallerAgainst({ staffRole: 'auntie' }, sink);
    await assert.rejects(
      () =>
        idx.setAdminClaim.run({
          auth: { uid: 'owner-1', token: { admin: true } },
          data: { uid: 'auntie-1', isAdmin: true },
        }),
      (e) => e.code === 'failed-precondition' && /staffRole "auntie"/.test(e.message),
    );
    assert.deepStrictEqual(sink, [], 'the refusal must land before any claim or roster write');
  });

  it('refuses an UNKNOWN staff role too, not just the caretaker', async () => {
    // An account nobody has written rules for is exactly the one that must not
    // be handed the owner claim.
    const sink = [];
    ownerCallerAgainst({ staffRole: 'bookkeeper' }, sink);
    await assert.rejects(
      () =>
        idx.setAdminClaim.run({
          auth: { uid: 'owner-1', token: { admin: true } },
          data: { uid: 'bk-1', isAdmin: true },
        }),
      (e) => e.code === 'failed-precondition' && /staffRole "bookkeeper"/.test(e.message),
    );
    assert.deepStrictEqual(sink, []);
  });

  it('the message names the remedy, because the operator reads it in a dialog', async () => {
    const sink = [];
    ownerCallerAgainst({ staffRole: 'auntie' }, sink);
    await assert.rejects(
      () =>
        idx.setAdminClaim.run({
          auth: { uid: 'owner-1', token: { admin: true } },
          data: { uid: 'auntie-1', isAdmin: true },
        }),
      (e) => /grant-staff-role\.mjs/.test(e.message),
    );
  });

  it('STILL REVOKES admin from a double-claimed account: that is the repair', async () => {
    // The guard must not fire on revoke. Refusing here would leave the one
    // account that must be fixed unfixable through this path.
    const sink = [];
    ownerCallerAgainst({ admin: true, staffRole: 'auntie' }, sink);
    const out = await idx.setAdminClaim.run({
      auth: { uid: 'owner-1', token: { admin: true } },
      data: { uid: 'both-1', isAdmin: false },
    });
    assert.deepStrictEqual(out, { ok: true, uid: 'both-1', isAdmin: false });
    assert.deepStrictEqual(sink[0], {
      uid: 'both-1',
      // The staff role survives; only `admin` comes off. mergeAdminClaim
      // preserves every claim this function does not own.
      claims: { admin: false, staffRole: 'auntie' },
    });
    assert.deepStrictEqual(sink[1], { deletedAdminsDoc: true });
  });

  it('a clean grant onto an account with no staff role is untouched', async () => {
    // The no-regression half. The operator's normal path must still work.
    const sink = [];
    ownerCallerAgainst({ role: 'kinfolk', kinfolkId: 'kf_9' }, sink);
    const out = await idx.setAdminClaim.run({
      auth: { uid: 'owner-1', token: { admin: true } },
      data: { uid: 'target', isAdmin: true },
    });
    assert.deepStrictEqual(out, { ok: true, uid: 'target', isAdmin: true });
    assert.deepStrictEqual(sink[0].claims, { role: 'kinfolk', kinfolkId: 'kf_9', admin: true });
  });
});
