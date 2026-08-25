// Tests for the pure helpers exported by web/functions/index.js. Uses Node's
// built-in test runner (node:test) so the deployed function carries ZERO
// dev-dependency tree. Requiring index.js calls admin.initializeApp() (which is
// inert without credentials) and registers the Cloud Functions by side effect;
// these tests only exercise the pure, exported helpers (no network, no key, no
// HTTP). The HTTP/auth handlers and the Firestore-backed setAdminClaim lockout
// guards are integration-tested against the emulator elsewhere.
//
// Covers:
//   resolveAnthropicModel — NOTE-48 allowlist (existing)
//   validateUploadFolder  — WARNING-12 folder security boundary (new)
//   assertAdminRemovalAllowed — NOTE-51 self-de-admin + last-admin guards (new)
//
// Run: cd web/functions && npm test   (=> node --test)

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const idx = require('../index.js');

describe('resolveAnthropicModel (NOTE-48 allowlist)', () => {
  const original = process.env.ANTHROPIC_MODEL;
  afterEach(() => {
    if (original === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = original;
  });

  it('defaults to claude-sonnet-4-5 when the env var is unset', () => {
    delete process.env.ANTHROPIC_MODEL;
    assert.strictEqual(idx.resolveAnthropicModel(), idx.ANTHROPIC_MODEL_DEFAULT);
    assert.strictEqual(idx.ANTHROPIC_MODEL_DEFAULT, 'claude-sonnet-4-5');
  });

  it('honors an allowlisted override', () => {
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5';
    assert.strictEqual(idx.resolveAnthropicModel(), 'claude-sonnet-4-5');
  });

  it('falls back to the default for a non-allowlisted (e.g. costly) model', () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-4-1';
    assert.strictEqual(idx.resolveAnthropicModel(), idx.ANTHROPIC_MODEL_DEFAULT);
  });

  it('falls back to the default for an empty or junk override', () => {
    process.env.ANTHROPIC_MODEL = '';
    assert.strictEqual(idx.resolveAnthropicModel(), idx.ANTHROPIC_MODEL_DEFAULT);
    process.env.ANTHROPIC_MODEL = 'not-a-real-model; rm -rf /';
    assert.strictEqual(idx.resolveAnthropicModel(), idx.ANTHROPIC_MODEL_DEFAULT);
  });

  it('never returns a value outside the allowlist', () => {
    for (const candidate of ['', 'gpt-4', 'claude-3-opus', 'claude-sonnet-4-5', undefined]) {
      if (candidate === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = candidate;
      assert.ok(idx.ALLOWED_ANTHROPIC_MODELS.has(idx.resolveAnthropicModel()));
    }
  });
});

// ---------------------------------------------------------------------------
// validateUploadFolder (WARNING-12) — CWE-22 path-traversal guard
// ---------------------------------------------------------------------------
// The helper throws a plain Error (not HttpsError) so that signCloudinaryUpload
// can map it to a 400 response. These tests are fully hermetic: no network,
// no Firebase Admin, no Cloudinary.

describe('validateUploadFolder (WARNING-12 folder security boundary)', () => {
  const { validateUploadFolder } = idx;

  // ---- legitimate real-client folders PASS --------------------------------

  it('accepts tribetails/entity/<id>  (web FirestoreInterop / JvmMediaUpload)', () => {
    const id = 'abc123';
    const result = validateUploadFolder(`tribetails/entity/${id}`, 'entity', id);
    assert.strictEqual(result, `tribetails/entity/${id}`);
  });

  it('accepts tribetails/visit_log/<sessionId>', () => {
    const id = 'sess_XyZ-99';
    const result = validateUploadFolder(`tribetails/visit_log/${id}`, 'visit_log', id);
    assert.strictEqual(result, `tribetails/visit_log/${id}`);
  });

  it('accepts tribetails/kin/<id>  (android lowercases entityType to "kin")', () => {
    const id = 'kin_007';
    const result = validateUploadFolder(`tribetails/kin/${id}`, 'kin', id);
    assert.strictEqual(result, `tribetails/kin/${id}`);
  });

  it('returns the folder string unchanged on success', () => {
    const folder = 'tribetails/entity/id42';
    assert.strictEqual(validateUploadFolder(folder, 'entity', 'id42'), folder);
  });

  // ---- path traversal REJECTED --------------------------------------------

  it('rejects a folder that tries to escape via tribetails/../secrets', () => {
    assert.throws(
      () => validateUploadFolder('tribetails/../secrets', 'entity', 'secrets'),
      /\.\./,
    );
  });

  it('rejects a mid-path traversal: tribetails/kin/../other', () => {
    assert.throws(
      () => validateUploadFolder('tribetails/kin/../other', 'kin', 'other'),
      /\.\.|traversal|relative/i,
    );
  });

  it('rejects a folder containing a backslash', () => {
    // Use a string that starts with the required prefix but embeds a backslash
    // so the backslash check fires (not the startsWith check).
    // In JS source 'tribetails/kin\\id1' is the literal string tribetails/kin\id1.
    assert.throws(
      () => validateUploadFolder('tribetails/kin\\id1', 'kin', 'id1'),
      /backslash/i,
    );
  });

  it('rejects an empty folder', () => {
    assert.throws(
      () => validateUploadFolder('', 'entity', 'id1'),
      /folder/i,
    );
  });

  it('rejects a folder that does not start with tribetails/', () => {
    assert.throws(
      () => validateUploadFolder('other/entity/id1', 'entity', 'id1'),
      /tribetails/i,
    );
  });

  it('rejects when the final segment does not match entityId', () => {
    assert.throws(
      () => validateUploadFolder('tribetails/entity/id_A', 'entity', 'id_B'),
      /entityId/i,
    );
  });

  it('rejects empty path segments (e.g. double slash)', () => {
    assert.throws(
      () => validateUploadFolder('tribetails//entity/id1', 'entity', 'id1'),
      /empty|segment/i,
    );
  });

  // ---- non-slug entityId REJECTED -----------------------------------------

  it('rejects entityId containing a slash', () => {
    assert.throws(
      () => validateUploadFolder('tribetails/entity/a/b', 'entity', 'a/b'),
      /slug/i,
    );
  });

  it('rejects entityId containing spaces', () => {
    assert.throws(
      () => validateUploadFolder('tribetails/entity/bad id', 'entity', 'bad id'),
      /slug/i,
    );
  });

  it('rejects entityId containing shell-special chars', () => {
    assert.throws(
      () => validateUploadFolder('tribetails/entity/$(cmd)', 'entity', '$(cmd)'),
      /slug/i,
    );
  });

  it('rejects an empty entityId', () => {
    assert.throws(
      () => validateUploadFolder('tribetails/entity/', 'entity', ''),
      /slug/i,
    );
  });
});

// ---------------------------------------------------------------------------
// assertAdminRemovalAllowed (NOTE-51) — lockout guards
// ---------------------------------------------------------------------------
// The helper throws HttpsError (firebase-functions) on a lockout condition.
// In tests we check for the 'failed-precondition' code on the error object;
// no Firestore or Auth calls are made here.

describe('assertAdminRemovalAllowed (NOTE-51 lockout guards)', () => {
  const { assertAdminRemovalAllowed } = idx;

  // ---- self-de-admin REJECTED ---------------------------------------------

  it('throws when an admin tries to revoke their own claim (uid === callerUid)', () => {
    assert.throws(
      () => assertAdminRemovalAllowed('alice', 'alice', false, 5),
      (e) => e.code === 'failed-precondition' && /own admin/i.test(e.message),
    );
  });

  // ---- last-admin removal REJECTED ----------------------------------------

  it('throws when removing the last admin (adminCount === 1)', () => {
    assert.throws(
      () => assertAdminRemovalAllowed('bob', 'alice', false, 1),
      (e) => e.code === 'failed-precondition' && /last admin/i.test(e.message),
    );
  });

  it('throws when adminCount is 0 (degenerate, belt-and-suspenders)', () => {
    assert.throws(
      () => assertAdminRemovalAllowed('bob', 'alice', false, 0),
      (e) => e.code === 'failed-precondition',
    );
  });

  // ---- removing a non-last admin PASSES -----------------------------------

  it('does not throw when removing a non-self admin with adminCount === 2', () => {
    assert.doesNotThrow(() => assertAdminRemovalAllowed('bob', 'alice', false, 2));
  });

  it('does not throw when removing a non-self admin with many admins', () => {
    assert.doesNotThrow(() => assertAdminRemovalAllowed('carol', 'alice', false, 10));
  });

  // ---- granting (isAdmin=true) ALWAYS PASSES ------------------------------

  it('does not throw when granting admin to self', () => {
    // Granting your own claim is not a lockout; caller is already admin.
    assert.doesNotThrow(() => assertAdminRemovalAllowed('alice', 'alice', true, 1));
  });

  it('does not throw when granting admin with adminCount=0 (recovery path)', () => {
    assert.doesNotThrow(() => assertAdminRemovalAllowed('alice', 'alice', true, 0));
  });

  it('does not throw when granting admin to another user', () => {
    assert.doesNotThrow(() => assertAdminRemovalAllowed('bob', 'alice', true, 3));
  });
});

// ---------------------------------------------------------------------------
// mergeAdminClaim — claim preservation
// ---------------------------------------------------------------------------
// setAdminClaim used to call setCustomUserClaims(uid, { admin: isAdmin }),
// which REPLACES the whole claim object. AuntieOS and the MyTribe portal share
// one Firebase project (auntieos-ttpc), so they share auth users: granting
// admin to a uid that held kinfolkId/role/testTribeId silently destroyed those
// claims, signing the person out of the portal and breaking their test-mode
// scoping. MyTribe's equivalent (functions/src/lib/kinfolkClaim.ts) merges and
// documents the rule: "Preserve any other claim (e.g. admin), never replace
// wholesale." This helper is that rule for the admin side.
//
// Semantics deliberately unchanged from the old code: revoke writes
// admin:false rather than deleting the key. firestore.rules gates on
// `admin == true`, so false and absent are equivalent to the rules, and
// keeping the write shape identical means this fix cannot change gating.

describe('mergeAdminClaim (claim preservation)', () => {
  const { mergeAdminClaim } = idx;

  it('preserves kinfolkId and role when granting admin', () => {
    assert.deepStrictEqual(
      mergeAdminClaim({ role: 'kinfolk', kinfolkId: 'kf_123' }, true),
      { role: 'kinfolk', kinfolkId: 'kf_123', admin: true },
    );
  });

  it('preserves testTribeId when revoking admin (Stage 0I sandbox scoping)', () => {
    assert.deepStrictEqual(
      mergeAdminClaim({ testTribeId: 'tribe_0I' }, false),
      { testTribeId: 'tribe_0I', admin: false },
    );
  });

  it('sets admin on an empty claim object', () => {
    assert.deepStrictEqual(mergeAdminClaim({}, true), { admin: true });
  });

  it('treats undefined/null existing claims as empty (new user)', () => {
    assert.deepStrictEqual(mergeAdminClaim(undefined, true), { admin: true });
    assert.deepStrictEqual(mergeAdminClaim(null, false), { admin: false });
  });

  it('overwrites a stale admin value rather than duplicating it', () => {
    assert.deepStrictEqual(
      mergeAdminClaim({ admin: true, kinfolkId: 'kf_9' }, false),
      { admin: false, kinfolkId: 'kf_9' },
    );
  });

  it('does not mutate the caller-supplied claims object', () => {
    const existing = { kinfolkId: 'kf_1' };
    mergeAdminClaim(existing, true);
    assert.deepStrictEqual(existing, { kinfolkId: 'kf_1' });
  });

  it('is the regression guard for the wholesale-replace bug', () => {
    // The old line was: setCustomUserClaims(uid, { admin: isAdmin })
    // i.e. exactly { admin: true }. If this ever equals that again for a user
    // who had other claims, the bug is back.
    const out = mergeAdminClaim({ role: 'kinfolk', kinfolkId: 'kf_123' }, true);
    assert.notDeepStrictEqual(out, { admin: true });
    assert.strictEqual(out.kinfolkId, 'kf_123');
  });
});

// ---------------------------------------------------------------------------
// projectN8nDocResponse (AO-32 / W11) — getTrainingDoc & getDraft must return
// ONLY the fields the n8n "Update Profiles" workflow consumes, never the whole
// Firestore document (which carries operator raw_notes, createdBy uid,
// attachment storage URLs, kinfolk PII, model/source metadata, etc.).
// ---------------------------------------------------------------------------
describe('projectN8nDocResponse (AO-32 field projection)', () => {
  const { projectN8nDocResponse, N8N_DOC_RESPONSE_FIELDS } = idx;

  it('projects only the whitelisted generated_drafts fields the consumer reads', () => {
    // Real generated_drafts shape (web/functions/generate.js:325-336).
    const draft = {
      communication_type: 'text',
      recipient: 'Jane Doe',
      kinfolk_id: 'kf_1',
      kinfolk_name: 'Jane Doe',
      raw_notes: 'operator private notes',
      generated_copy: 'Hi there!',
      model: 'claude-sonnet-4-5',
      status: 'generated',
      source: 'function:generate',
      generated_at: '2026-07-16T00:00:00.000Z',
    };
    const out = projectN8nDocResponse('draft_1', draft);
    assert.deepStrictEqual(out, {
      id: 'draft_1',
      generated_copy: 'Hi there!',
      communication_type: 'text',
    });
    // Sensitive / internal fields must NOT leak.
    for (const leaked of ['raw_notes', 'kinfolk_id', 'kinfolk_name', 'recipient', 'model', 'source', 'status', 'generated_at']) {
      assert.ok(!(leaked in out), `${leaked} must not be in the response`);
    }
  });

  it('projects only the whitelisted training_documents fields the consumer reads', () => {
    // Real training_documents shape (MyTribe createTrainingDocument.ts:77-92).
    const doc = {
      title: 'Vet visit',
      content: 'Bella saw Dr. Smith.',
      notes: 'internal reviewer notes',
      communicationType: 'note',
      targetType: 'KINFOLK',
      targetKinfolkId: 'kf_1',
      targetKinId: '',
      kinfolkRef: 'kf_1',
      attachments: [{ storageUrl: 'https://…', cloudinaryPublicId: 'abc' }],
      reconcileStatus: 'pending',
      reconcileNotes: '',
      reconciledAt: '',
      uploadedAt: '2026-07-16T00:00:00.000Z',
      createdBy: 'uid_admin',
    };
    const out = projectN8nDocResponse('td_1', doc);
    assert.deepStrictEqual(out, {
      id: 'td_1',
      content: 'Bella saw Dr. Smith.',
      communicationType: 'note',
      title: 'Vet visit',
    });
    for (const leaked of ['notes', 'attachments', 'createdBy', 'targetKinfolkId', 'kinfolkRef', 'reconcileNotes', 'reconcileStatus', 'uploadedAt']) {
      assert.ok(!(leaked in out), `${leaked} must not be in the response`);
    }
  });

  it('always includes the doc id and never emits keys absent on the source', () => {
    const out = projectN8nDocResponse('x', { generated_copy: 'c' });
    assert.strictEqual(out.id, 'x');
    assert.strictEqual(out.generated_copy, 'c');
    // Whitelisted-but-absent keys must not appear as undefined.
    assert.ok(!('content' in out));
    assert.ok(!('title' in out));
    assert.strictEqual(Object.keys(out).length, 2);
  });

  it('tolerates missing / empty data without throwing', () => {
    assert.deepStrictEqual(projectN8nDocResponse('x', undefined), { id: 'x' });
    assert.deepStrictEqual(projectN8nDocResponse('x', {}), { id: 'x' });
  });

  it('the whitelist is exactly the fields Build Update Prompts references', () => {
    // Guard against silent widening of the projection.
    assert.deepStrictEqual([...N8N_DOC_RESPONSE_FIELDS].sort(), [
      'communicationType',
      'communication_type',
      'content',
      'generated_copy',
      'title',
    ]);
  });
});
// ---------------------------------------------------------------------------
// cloudinaryCredentialsValid — fail loud on a WRONG secret, not just a MISSING
// one.
//
// Regression guard for 2026-07-19: CLOUDINARY_API_SECRET was replaced with an
// invalid value, the signer kept returning HTTP 200 because it only checked the
// secrets were non-empty, and every signature it issued died downstream at
// api.cloudinary.com, which writes nothing to Cloud Run logs. Photo upload was
// broken for a day while the backend looked healthy.
//
// fetch is injected so these stay hermetic: no network, no key.
// ---------------------------------------------------------------------------
describe('cloudinaryCredentialsValid (fail loud on an invalid secret)', () => {
  const { cloudinaryCredentialsValid, __resetCloudinaryCredentialCache } = idx;
  afterEach(() => {
    __resetCloudinaryCredentialCache();
  });
  const okFetch = async () => ({ status: 200 });
  const rejectFetch = async () => ({ status: 401 });
  it('accepts credentials Cloudinary answers 200 for', async () => {
    const result = await cloudinaryCredentialsValid('tribetails', 'key', 'good', okFetch);
    assert.strictEqual(result.ok, true);
  });
  it('rejects credentials Cloudinary answers 401 for, and says why', async () => {
    const result = await cloudinaryCredentialsValid('tribetails', 'key', 'wrong', rejectFetch);
    assert.strictEqual(result.ok, false);
    assert.match(result.detail, /401/);
  });
  it('sends HTTP basic auth built from the key and secret', async () => {
    let seenUrl = '';
    let seenAuth = '';
    await cloudinaryCredentialsValid('tribetails', 'key', 'secret', async (url, init) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization;
      return { status: 200 };
    });
    assert.match(seenUrl, /api\.cloudinary\.com\/v1_1\/tribetails\/ping$/);
    assert.strictEqual(seenAuth, `Basic ${Buffer.from('key:secret').toString('base64')}`);
  });
  it('caches a success so the ping does not run on every upload', async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return { status: 200 };
    };
    await cloudinaryCredentialsValid('tribetails', 'key', 'good', counting);
    await cloudinaryCredentialsValid('tribetails', 'key', 'good', counting);
    assert.strictEqual(calls, 1);
  });
  it('does NOT cache a failure, so re-setting the secret recovers without a redeploy', async () => {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      return { status: 401 };
    };
    await cloudinaryCredentialsValid('tribetails', 'key', 'wrong', failing);
    await cloudinaryCredentialsValid('tribetails', 'key', 'wrong', failing);
    assert.strictEqual(calls, 2);
  });
  it('re-pings when the secret VALUE changes even if the cached one passed', async () => {
    let calls = 0;
    const counting = async () => {
      calls += 1;
      return { status: 200 };
    };
    await cloudinaryCredentialsValid('tribetails', 'key', 'first', counting);
    await cloudinaryCredentialsValid('tribetails', 'key', 'second', counting);
    assert.strictEqual(calls, 2);
  });
  it('reports a network failure as transient rather than claiming the secret is bad', async () => {
    const exploding = async () => {
      throw new Error('ECONNRESET');
    };
    const result = await cloudinaryCredentialsValid('tribetails', 'key', 'good', exploding);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.transient, true);
    assert.match(result.detail, /ECONNRESET/);
  });
});
// ---------------------------------------------------------------------------
// uploadTransformationFor (#583) — the metadata strip is decided server-side
// ---------------------------------------------------------------------------
// Photos never pass through these functions, so the signature is the only
// lever on what Cloudinary stores. This helper decides WHICH incoming
// transformation gets signed; `handlers.test.js` proves the value it returns
// actually reaches the signature base and the response.
describe('uploadTransformationFor (#583 EXIF strip decision)', () => {
  const { uploadTransformationFor, STRIP_METADATA_TRANSFORMATION } = idx;
  it('is fl_force_strip, Cloudinary\'s documented clear-all-image-metadata flag', () => {
    assert.strictEqual(STRIP_METADATA_TRANSFORMATION, 'fl_force_strip');
  });
  it('strips for an explicit image upload', () => {
    assert.strictEqual(uploadTransformationFor('image'), 'fl_force_strip');
  });
  // The privacy default has to be "strip". A client that omits the hint is a
  // photo uploader that predates this parameter, and a missing field must
  // never be the thing that quietly turns location stripping back off.
  it('strips when the kind is omitted entirely (undefined)', () => {
    assert.strictEqual(uploadTransformationFor(undefined), 'fl_force_strip');
  });
  it('strips when the kind is null or blank', () => {
    assert.strictEqual(uploadTransformationFor(null), 'fl_force_strip');
    assert.strictEqual(uploadTransformationFor(''), 'fl_force_strip');
  });
  // fl_force_strip is an IMAGE flag, and any incoming transformation on a
  // video means re-encoding the whole file inside the upload request.
  it('signs NO transformation for video', () => {
    assert.strictEqual(uploadTransformationFor('video'), '');
  });
  it('signs NO transformation for raw (documents, audio)', () => {
    assert.strictEqual(uploadTransformationFor('raw'), '');
  });
  // Fail loud rather than sign something Cloudinary would reject later, and
  // rather than silently treating an unknown word as "don't strip".
  it('throws on an unrecognized kind', () => {
    assert.throws(() => uploadTransformationFor('IMAGE'), /resourceKind/i);
    assert.throws(() => uploadTransformationFor('photo'), /resourceKind/i);
    assert.throws(() => uploadTransformationFor(7), /resourceKind/i);
    assert.throws(() => uploadTransformationFor({}), /resourceKind/i);
  });
});
