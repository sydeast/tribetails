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
    // signature is sha1(folder=..&timestamp=.. + apiSecret) over exactly folder+timestamp.
    const base = `folder=${out.folder}&timestamp=${out.timestamp}` + 'demo-secret';
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
    // signature still signs exactly folder+timestamp with the secret appended.
    const base = `folder=${out.folder}&timestamp=${out.timestamp}` + 'demo-secret';
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
// sendMessage (onRequest)
// ===========================================================================
describe('sendMessage handler (onRequest)', () => {
  it('405 on a non-POST method', async () => {
    const res = makeRes();
    await idx.sendMessage(makeReq({ method: 'GET' }), res);
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.jsonBody.error, 'method_not_allowed');
  });

  it('401 when the bearer token is missing', async () => {
    const res = makeRes();
    await idx.sendMessage(makeReq({ headers: {} }), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonBody.error, 'missing_bearer_token');
  });

  it('403 when the token lacks the admin claim', async () => {
    installAdmin({ auth: authReturning({ uid: 'u1', admin: false }) });
    const res = makeRes();
    await idx.sendMessage(makeReq({ headers: ADMIN_BEARER, body: { channel: 'sms' } }), res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonBody.error, 'admin_required');
  });

  it('happy path: forwards the body to n8n and returns the parsed JSON with the upstream status', async () => {
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    let sent;
    global.fetch = async (url, opts) => {
      sent = { url: String(url), opts };
      return { status: 200, text: async () => JSON.stringify({ ok: true, sid: 'MSG_1' }) };
    };
    const res = makeRes();
    const body = { channel: 'sms', message_body: 'hi', recipient_phone: '+15550000000' };
    await idx.sendMessage(makeReq({ headers: ADMIN_BEARER, body }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.jsonBody, { ok: true, sid: 'MSG_1' });
    assert.ok(sent.url.includes('auntie-send-message'));
    assert.strictEqual(sent.opts.method, 'POST');
    assert.deepStrictEqual(JSON.parse(sent.opts.body), body);
  });

  it('normalizes a Cloudflare-rewritten non-JSON 5xx body to structured JSON', async () => {
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    global.fetch = async () => ({ status: 502, text: async () => 'error code: 502' });
    const res = makeRes();
    await idx.sendMessage(makeReq({ headers: ADMIN_BEARER, body: { channel: 'sms' } }), res);
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.jsonBody.error, 'upstream_provider_failure');
    assert.strictEqual(res.jsonBody.provider_error, 'cf_body_rewritten');
    assert.strictEqual(res.jsonBody.raw, 'error code: 502');
  });

  it('503 infra_failure when the upstream fetch throws', async () => {
    installAdmin({ auth: authReturning({ uid: 'admin-1', admin: true }) });
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const res = makeRes();
    await idx.sendMessage(makeReq({ headers: ADMIN_BEARER, body: { channel: 'sms' } }), res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.jsonBody.error, 'infra_failure');
    assert.strictEqual(res.jsonBody.stage, 'proxy_fetch');
  });
});
