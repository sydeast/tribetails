const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { runGenerate } = require('./generate');
const { enforceGenerateRateLimit } = require('./generateRateLimit');
const { enforceWindowedRateLimit } = require('./rateLimit');
const { validateDocId, validateDraftPayload } = require('./draftValidation');

admin.initializeApp();

// NOTE-51: pure lockout-guard helper for setAdminClaim. Tests the two revocation
// guards without touching Firestore or Firebase Auth, so they can be verified
// hermetically. Called by setAdminClaim before touching any external service.
//
// Parameters:
//   uid       — target uid being granted / revoked
//   callerUid — uid of the authenticated caller
//   isAdmin   — the requested new state (true = grant, false = revoke)
//   adminCount — current count of docs in the admins collection (ignored when
//               isAdmin=true; caller is responsible for fetching this before
//               invoking when isAdmin=false)
//
// Throws HttpsError('failed-precondition', ...) on a lockout condition.
// Returns undefined (no-op) when the action is safe to proceed.
//
// Exported for hermetic unit tests; called by setAdminClaim.
function assertAdminRemovalAllowed(uid, callerUid, isAdmin, adminCount) {
  if (isAdmin) return; // granting is always safe
  if (uid === callerUid) {
    throw new HttpsError(
      'failed-precondition',
      'You cannot revoke your own admin claim. Ask another admin to do it.',
    );
  }
  if (adminCount <= 1) {
    throw new HttpsError(
      'failed-precondition',
      'Cannot remove the last admin. Grant another admin first.',
    );
  }
}

// Build the next custom-claim object for a uid, preserving every claim we do
// not own. AuntieOS and the MyTribe portal share one Firebase project, so a
// uid can legitimately hold role/kinfolkId (portal) and testTribeId (Stage 0I
// sandbox) alongside admin. setCustomUserClaims REPLACES the object, so writing
// { admin } wholesale silently destroyed those. Mirrors MyTribe's
// functions/src/lib/kinfolkClaim.ts, which merges for the same reason.
//
// Exported for hermetic unit tests; called by setAdminClaim.
function mergeAdminClaim(existingClaims, isAdmin) {
  return { ...(existingClaims ?? {}), admin: isAdmin };
}

// setAdminClaim: mint or revoke admin custom claim on a target uid.
// Authorization rules:
//   1. Caller must be authenticated.
//   2. Caller MUST already have admin custom claim.
//   3. There is NO bootstrap mode. If every existing admin is accidentally
//      deleted, the recovery path is to mint a new admin claim via the
//      Firebase Admin SDK from a server-side context that has the service-
//      account credential (e.g. one-off Cloud Shell or a `gcloud` script):
//
//        firebase functions:shell
//        > auth().setCustomUserClaims('<target-uid>', { admin: true })
//
//      then run setAdminClaim once authenticated with that uid to mirror
//      the claim into the admins/{uid} Firestore doc. This removes the prior
//      bootstrap-mode exploit (CWE-1188): empty admins collection no longer
//      lets the first signed-in user escalate themselves to admin.
//
// Args: { uid: string, isAdmin: boolean }
// Returns: { ok: true, uid, isAdmin }
exports.setAdminClaim = onCall(async (req) => {
  const callerUid = req.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }

  const callerHasAdmin = req.auth?.token?.admin === true;
  if (!callerHasAdmin) {
    throw new HttpsError(
      'permission-denied',
      'Caller is not an admin. Bootstrap-mode removed; mint the first admin claim via Firebase Admin SDK (see function source for steps).',
    );
  }

  const { uid, isAdmin } = req.data || {};
  if (typeof uid !== 'string' || !uid) {
    throw new HttpsError('invalid-argument', 'uid (string) is required.');
  }
  if (typeof isAdmin !== 'boolean') {
    throw new HttpsError('invalid-argument', 'isAdmin (boolean) is required.');
  }

  const db = admin.firestore();

  // NOTE-51: lockout guards. Delegate to the exported pure helper so the same
  // rules are tested hermetically. We only fetch the admin count when actually
  // revoking (isAdmin=false) because granting is always safe.
  if (!isAdmin) {
    const countSnap = await db.collection('admins').count().get();
    const adminCount = countSnap.data().count;
    assertAdminRemovalAllowed(uid, callerUid, isAdmin, adminCount); // throws on lockout
  }

  // Read-modify-write: preserve portal (role/kinfolkId) and sandbox
  // (testTribeId) claims. setCustomUserClaims replaces the whole object.
  const target = await admin.auth().getUser(uid);
  await admin.auth().setCustomUserClaims(uid, mergeAdminClaim(target.customClaims, isAdmin));

  if (isAdmin) {
    await db.collection('admins').doc(uid).set({
      uid,
      grantedBy: callerUid,
      grantedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else {
    await db.collection('admins').doc(uid).delete();
  }

  return { ok: true, uid, isAdmin };
});

// MIGRATED: setKinfolkClaim + revokeKinfolkClaim moved to MyTribe/functions/
//   src/admin/setKinfolkClaim.ts + src/admin/revokeKinfolkClaim.ts.
// Deploy both Functions codebases together to avoid an export name collision
// across codebases. Callers using httpsCallable('setKinfolkClaim') /
// httpsCallable('revokeKinfolkClaim') auto-resolve to the MyTribe codebase
// once that codebase is deployed.

// listAdmins: return uids of current admins. Admin-only.
exports.listAdmins = onCall(async (req) => {
  if (req.auth?.token?.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  const snap = await admin.firestore().collection('admins').get();
  return { admins: snap.docs.map((d) => ({ uid: d.id, ...d.data() })) };
});

// Draft persistence for the copy generator. `generateAuntieCopy` writes its own
// draft inline; these endpoints are the out-of-band way to write one, re-read
// one, and fetch the training doc that shapes the prompt.
//
// POST /writeDraft
// Headers: { "Authorization": "Bearer <Firebase ID token, admin === true>" }
// Body: { docId?: string, draft: { ... } }
// Response: { ok: true, id: string }
const { defineSecret } = require('firebase-functions/params');
const CLOUDINARY_CLOUD_NAME = defineSecret('CLOUDINARY_CLOUD_NAME');
const CLOUDINARY_API_KEY = defineSecret('CLOUDINARY_API_KEY');
const CLOUDINARY_API_SECRET = defineSecret('CLOUDINARY_API_SECRET');

// Mapbox secret access token. Held server-side so the public web bundle
// never ships a Mapbox key. The /api/mapbox/sign-search rewrite proxies
// admin-authenticated lookups through this function.
const MAPBOX_ACCESS_TOKEN = defineSecret('MAPBOX_ACCESS_TOKEN');

// Anthropic API key for the Auntie copy generator (`generate`), replacing the
// n8n Claude call. Set via `firebase functions:secrets:set ANTHROPIC_API_KEY`.
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// The draft endpoints below used to authenticate with the `N8N_SHARED_SECRET`
// header (`x-auntie-key`) plus a per-IP bucket in `n8nIpRateLimits`, because
// their only caller was an n8n workflow that could not hold a Firebase identity.
// n8n is retired and that secret is gone, so they now take the same Bearer
// Firebase ID token as `generateAuntieCopy`, the generator they serve.
//
// That also retires AO-33 on its own terms rather than by hardening: the
// timing-unsafe secret compare and the unbounded `n8nIpAllowed.timestamps`
// array are both gone with the code that held them, and `requireAdminToken`
// verifies a signed token instead of comparing a string.
//
// The RATE LIMIT survives the move, re-keyed from source IP to verified uid
// (see rateLimit.js). Dropping it along with the secret would have been a
// straight regression: identity and volume are different questions, and a
// leaked admin token or a runaway client loop is precisely the case where the
// identity question has a good answer and the damage happens anyway. One
// bucket is shared across all three endpoints, so a loop that rotates between
// them is capped by the same budget it would hit on any one of them.
const DRAFT_RATE_COLLECTION = 'draft_rate_limits';
const DRAFT_RATE_WINDOW_MS = 60 * 1000;
const DRAFT_RATE_LIMIT = 60;

/**
 * Auth, then budget, then input. Consuming budget BEFORE validating the body is
 * deliberate: a caller flooding malformed requests is exactly the traffic worth
 * capping, and validating first would let it spend our CPU for free.
 *
 * @returns {string|null} the caller uid, or null when a response was sent.
 */
async function requireAdminWithDraftBudget(req, res, scope) {
  const decoded = await requireAdminToken(req, res, scope);
  if (!decoded) return null;
  try {
    await enforceWindowedRateLimit(admin.firestore(), {
      collection: DRAFT_RATE_COLLECTION,
      uid: decoded.uid,
      nowMs: Date.now(),
      windowMs: DRAFT_RATE_WINDOW_MS,
      cap: DRAFT_RATE_LIMIT,
    });
  } catch (err) {
    if (err && err.status === 429) {
      console.warn('%s: rate-limited uid=%s', scope, decoded.uid);
      res.status(429).json({ error: 'rate_limit_exceeded' });
      return null;
    }
    // The limiter itself failed (Firestore unavailable). Fail CLOSED: an
    // unmetered endpoint is the thing this function exists to prevent, so a
    // broken meter means no service rather than unlimited service.
    console.error('%s: rate limiter failed', scope, err);
    res.status(503).json({ error: 'rate_limiter_unavailable' });
    return null;
  }
  return decoded.uid;
}

// Verifies the Bearer Firebase ID token and enforces the caller is a real admin
// (`admin === true`). When `allowTestAdmin` is set, a Stage-0I sandbox test-admin
// — a real Auth user that carries a non-empty `testTribeId` custom claim instead
// of `admin` — is ALSO accepted; the CALLER is then responsible for scoping the
// request to that test tribe (see signCloudinaryUpload). All other endpoints keep
// the admin-only gate (allowTestAdmin defaults false).
async function requireAdminToken(req, res, scope, { allowTestAdmin = false } = {}) {
  const authHeader = req.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing_bearer_token' });
    return null;
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(authHeader.slice('Bearer '.length).trim(), true);
    const isAdmin = decodedToken.admin === true;
    const testTribeId = typeof decodedToken.testTribeId === 'string' ? decodedToken.testTribeId : '';
    const isTestAdmin = testTribeId.length > 0;
    if (!isAdmin && !(allowTestAdmin && isTestAdmin)) {
      res.status(403).json({ error: 'admin_required' });
      return null;
    }
    return decodedToken;
  } catch (err) {
    console.error('%s: verifyIdToken failed', scope, err);
    res.status(401).json({ error: 'invalid_bearer_token' });
    return null;
  }
}

exports.writeDraft = onRequest({ cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!(await requireAdminWithDraftBudget(req, res, 'writeDraft'))) return;
  const { docId, draft } = req.body || {};
  if (docId !== undefined) {
    const idError = validateDocId(docId);
    if (idError) {
      res.status(400).json({ error: idError });
      return;
    }
  }
  const draftError = validateDraftPayload(draft);
  if (draftError) {
    res.status(400).json({ error: draftError });
    return;
  }
  try {
    const col = admin.firestore().collection('generated_drafts');
    const ref = docId ? col.doc(docId) : col.doc();
    await ref.set(
      { ...draft, _writtenAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    res.status(200).json({ ok: true, id: ref.id });
  } catch (err) {
    console.error('writeDraft failed', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
});

// AO-32 (W11): getTrainingDoc / getDraft used to return the ENTIRE Firestore
// document on shared-secret auth alone. That leaked internal/sensitive fields
// the caller never needs — operator raw_notes, createdBy uid, attachment storage
// URLs / cloudinaryPublicId, kinfolk PII (kinfolk_id/kinfolk_name/recipient),
// model/source/status metadata, reconcile bookkeeping, etc.
//
// The ONLY consumer is the n8n "Update Profiles" workflow's "Build Update
// Prompts" node, which reads exactly these fields off the returned row
// (create_n8n_workflows.py:834-835, and patch_update_profiles_firestore.py:140
// which adds the camelCase communicationType variant):
//   new_content  = row.generated_copy || row.content
//   content_type = row.communicationType || row.communication_type || row.title
// (the trigger's kinfolk_id / row_id come from the workflow's own trigger body,
// not from this response.)
//
// So project ONLY those fields (plus the doc id) — nothing else crosses the
// boundary. Keys absent on a given collection simply don't appear in the
// response. Exported for hermetic unit tests.
const N8N_DOC_RESPONSE_FIELDS = [
  'generated_copy', // generated_drafts: draft body -> new_content
  'content', // training_documents: doc body -> new_content
  'communicationType', // training_documents: content_type (camelCase)
  'communication_type', // generated_drafts: content_type (snake_case)
  'title', // both: content_type fallback
];

function projectN8nDocResponse(id, data) {
  const out = { id };
  const src = data || {};
  for (const key of N8N_DOC_RESPONSE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(src, key)) out[key] = src[key];
  }
  return out;
}

// Same shape but reads a single training document. Used by Update Profiles n8n workflow.
exports.getTrainingDoc = onRequest({ cors: false }, async (req, res) => {
  if (!(await requireAdminWithDraftBudget(req, res, 'getTrainingDoc'))) return;
  const id = (req.query.id || '').toString();
  const idError = validateDocId(id);
  if (idError) {
    res.status(400).json({ error: id ? idError : 'id query param required' });
    return;
  }
  try {
    const snap = await admin.firestore().collection('training_documents').doc(id).get();
    if (!snap.exists) {
      res.status(404).json({ error: `training_documents/${id} not found` });
      return;
    }
    res.status(200).json(projectN8nDocResponse(snap.id, snap.data()));
  } catch (err) {
    console.error('getTrainingDoc failed', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
});

// Same shape but reads a single draft. Used by Update Profiles n8n workflow.
exports.getDraft = onRequest({ cors: false }, async (req, res) => {
  if (!(await requireAdminWithDraftBudget(req, res, 'getDraft'))) return;
  const id = (req.query.id || '').toString();
  const idError = validateDocId(id);
  if (idError) {
    res.status(400).json({ error: id ? idError : 'id query param required' });
    return;
  }
  try {
    const snap = await admin.firestore().collection('generated_drafts').doc(id).get();
    if (!snap.exists) {
      res.status(404).json({ error: `generated_drafts/${id} not found` });
      return;
    }
    res.status(200).json(projectN8nDocResponse(snap.id, snap.data()));
  } catch (err) {
    console.error('getDraft failed', err);
    res.status(500).json({ error: err.message || 'internal error' });
  }
});

// sendMessage (REMOVED 2026-07-23). It was a bare HTTP proxy to
// https://n8n.tribetails.com/webhook/auntie-send-message. n8n was retired, so
// the route pointed at a host that no longer answers and every AuntieOS
// Personalize send failed in prod. The admin now calls MyTribe's
// `sendExternalMessage` onCall (Twilio + smtp2go, consent gate, external_messages
// ledger), which the broadcast path was already using. The /api/send-message
// hosting rewrite is deleted from both firebase.json files in the same change.

// WARNING-12: pure folder-validation helper.
// Enforces the security boundary that scopes a signed Cloudinary grant to one
// entity's directory. The three clients build the folder as
// `tribetails/<bucket>/<entityId>` where <bucket> is `entity`, `visit_log`,
// or the lowercased entityType (web FirestoreInterop / JvmMediaUpload /
// android CloudinaryConfig.getFolderPath). Those bucket names don't map 1:1
// to entityType, so we do NOT re-derive the folder server-side; we ENFORCE
// the boundary on the supplied value:
//   1. entityId must be a plain slug (no path injection via the id itself).
//   2. folder must stay under tribetails/  (cannot escape the namespace).
//   3. No '..' / backslash / empty / '.' segments (CWE-22 path traversal).
//   4. The FINAL segment of folder must equal entityId (grant is pinned to
//      exactly one entity; a signature for entity A cannot write into B).
//
// Returns the validated folder string on success. Throws a plain Error with a
// human-readable message on any violation. The HTTP handler converts the Error
// to a 400 response.
//
// Exported for hermetic unit tests; called by signCloudinaryUpload.
function validateUploadFolder(folder, entityType, entityId) {
  const SAFE_SLUG = /^[A-Za-z0-9._-]+$/;
  if (typeof entityId !== 'string' || !entityId || !SAFE_SLUG.test(entityId)) {
    throw new Error('entityId must be a plain slug (letters, digits, . _ -)');
  }
  if (typeof folder !== 'string' || !folder) {
    throw new Error('folder is required');
  }
  if (!folder.startsWith('tribetails/')) {
    throw new Error('folder must stay under tribetails/');
  }
  if (folder.includes('..') || folder.includes('\\')) {
    throw new Error('folder must not contain ".." or backslashes');
  }
  const segments = folder.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error('folder must not contain empty or relative path segments');
  }
  if (segments[segments.length - 1] !== entityId) {
    throw new Error('folder must end with the entityId segment');
  }
  return folder;
}

// ── #583: photo location metadata is stripped at upload ─────────────────────
//
// Photos never pass through these functions; a client posts the bytes straight
// to api.cloudinary.com. So the ONLY place we can dictate what Cloudinary does
// with the file is the signature: Cloudinary recomputes the signature over the
// params it RECEIVES, so a param we sign is a param the client is forced to
// send verbatim, and a param we do not sign cannot be added by the client at
// all. Signing the strip instruction is therefore the one change that covers
// web, Android, desktop and any client written later.
//
// `fl_force_strip` is Cloudinary's own flag for this and is documented against
// exactly this use: "Instructs Cloudinary to clear all image metadata (IPTC,
// Exif and XMP) while applying an incoming transformation"
// (transformation_reference_fl_flag_force_strip). Passed as the `transformation`
// upload param it becomes an INCOMING transformation, which the upload docs
// define as "applied before storing the asset in Cloudinary" — so the STORED
// ORIGINAL is the stripped file, not a stripped copy of a coordinate-bearing
// original.
//
// IT IS ALL-OR-NOTHING. There is no GPS-only option in the Upload API; this
// discards capture time, camera/lens, IPTC and XMP along with the coordinates,
// and re-encodes the image to do it. Cloudinary auto-rotates from the EXIF
// orientation tag before stripping (its documented default), so a phone photo
// does not come back sideways.
//
// IMAGES ONLY. `fl_force_strip` is an image flag, and any incoming
// transformation on a video means re-encoding the whole file inside the upload
// request. Video/raw uploads are signed WITHOUT it — see the PR for #583, and
// see UPLOAD_PENDING_STRIP_TAG below for what video gets instead (#593).
const STRIP_METADATA_TRANSFORMATION = 'fl_force_strip';
const UPLOAD_RESOURCE_KINDS = ['image', 'video', 'raw'];

// ── #593: every uploaded video is tagged as not-yet-stripped ────────────────
//
// Video cannot be stripped inside the upload the way a photo is; the operator
// ruling on #593 is to strip asynchronously afterwards and accept a window.
// The strip itself lives in mytribe/functions (an `onDocumentCreated` trigger
// on `media_files`, plus a sweep). This tag is what makes that job's coverage
// checkable INDEPENDENTLY of our own database.
//
// The tag rides in on the signature for the same reason the photo strip does:
// Cloudinary recomputes the signature over the params it receives, so a param
// we sign is a param the client is forced to send verbatim, and a param we do
// not sign it cannot add. So from the instant a video lands in the account it
// carries `needs-gps-strip`, on every client, including any client written
// later, whether or not that client remembers to write a Firestore row.
//
// Only a verified strip removes it (the overwrite posts an empty `tags`). So
// `GET /resources/video/tags/needs-gps-strip` is a live, account-side list of
// every video whose coordinates are still in place — including the ones our
// Firestore-driven job can never see, because the upload succeeded and the
// client died before writing the `media_files` doc.
//
// Images do not get it: they are already stripped before storage, so a
// pending-strip tag on a photo would be a lie.
const UPLOAD_PENDING_STRIP_TAG = 'needs-gps-strip';

// Which transformation to sign for a client-declared resource kind. Absent or
// blank means IMAGE: the default has to fail toward stripping, because the
// clients that predate this parameter are all photo/gallery uploaders and a
// missing hint must never quietly turn the privacy behaviour off.
//
// Throws a plain Error on an unrecognized kind; the HTTP handler turns that
// into a 400 rather than signing something Cloudinary would reject later.
//
// Exported for hermetic unit tests; called by signCloudinaryUpload.
function uploadTransformationFor(resourceKind) {
  return normalizeResourceKind(resourceKind) === 'image' ? STRIP_METADATA_TRANSFORMATION : '';
}

// #593. Which tags to sign for a client-declared resource kind. Video gets the
// pending-strip tag; image and raw get none. Blank string means "sign no tags
// and post none", exactly like a blank transformation.
//
// Exported for hermetic unit tests; called by signCloudinaryUpload.
function uploadTagsFor(resourceKind) {
  return normalizeResourceKind(resourceKind) === 'video' ? UPLOAD_PENDING_STRIP_TAG : '';
}

// Shared by both of the above so a resource kind is validated once and cannot
// mean one thing to the transformation decision and another to the tag one.
function normalizeResourceKind(resourceKind) {
  const kind = resourceKind === undefined || resourceKind === null || resourceKind === ''
    ? 'image'
    : resourceKind;
  if (typeof kind !== 'string' || !UPLOAD_RESOURCE_KINDS.includes(kind)) {
    throw new Error(`resourceKind must be one of ${UPLOAD_RESOURCE_KINDS.join('/')}`);
  }
  return kind;
}

// Fail loud on a WRONG secret, not just a MISSING one.
//
// On 2026-07-19 CLOUDINARY_API_SECRET was replaced with an invalid value. This
// signer kept returning HTTP 200 because it only checked the secrets were
// non-empty, so every signature it issued was computed with the wrong key and
// died later at api.cloudinary.com, which writes nothing to Cloud Run logs. The
// backend looked healthy for a day while no photo could be uploaded.
//
// Cloudinary's /ping authenticates the key+secret pair without side effects, so
// we verify once per instance and cache. A bad credential now surfaces here, as
// a 500 naming the cause, instead of as a silent "Invalid Signature" the
// operator only sees in the client.
const CREDENTIAL_RECHECK_MS = 10 * 60 * 1000;
let cloudinaryCredentialCheck = null;

async function cloudinaryCredentialsValid(cloudName, apiKey, apiSecret, fetchImpl = fetch) {
  const fingerprint = `${cloudName}:${apiKey}:${apiSecret}`;
  const cached = cloudinaryCredentialCheck;
  if (cached && cached.fingerprint === fingerprint && cached.ok && Date.now() - cached.checkedAt < CREDENTIAL_RECHECK_MS) {
    return { ok: true };
  }

  let ok = false;
  let detail = '';
  try {
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    const resp = await fetchImpl(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/ping`, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
    });
    ok = resp.status === 200;
    if (!ok) detail = `cloudinary /ping returned HTTP ${resp.status}`;
  } catch (e) {
    // A network failure is not proof the credential is bad, so do not cache it
    // as a failure, but do not pretend it passed either.
    return { ok: false, detail: `cloudinary /ping unreachable: ${e.message}`, transient: true };
  }

  cloudinaryCredentialCheck = { fingerprint, ok, checkedAt: Date.now() };
  return { ok, detail };
}

exports.signCloudinaryUpload = onRequest(
  { secrets: [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET], cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    // allowTestAdmin: the Stage-0I sandbox test-admin (testTribeId claim, no
    // admin) may upload media too, but only pinned to its own test tribe (see
    // the entityId === testTribeId check below).
    const decodedToken = await requireAdminToken(req, res, 'signCloudinaryUpload', { allowTestAdmin: true });
    if (!decodedToken) return;

    const cloudName = CLOUDINARY_CLOUD_NAME.value();
    const apiKey = CLOUDINARY_API_KEY.value();
    const apiSecret = CLOUDINARY_API_SECRET.value();
    if (!cloudName || !apiKey || !apiSecret) {
      res.status(500).json({ error: 'cloudinary_signing_not_configured' });
      return;
    }


    const { folder, entityType, entityId, resourceKind } = req.body || {};
    if (typeof folder !== 'string' || !folder) {
      res.status(400).json({ error: 'folder is required' });
      return;
    }
    if (typeof entityType !== 'string' || !entityType || typeof entityId !== 'string' || !entityId) {
      res.status(400).json({ error: 'entityType and entityId are required' });
      return;
    }

    // #583: what Cloudinary must do to the bytes before storing them.
    // #593: and how the asset must be labelled once it is stored.
    let transformation;
    let tags;
    try {
      transformation = uploadTransformationFor(resourceKind);
      tags = uploadTagsFor(resourceKind);
    } catch (e) {
      res.status(400).json({ error: e.message });
      return;
    }

    // WARNING-12: delegate to the exported pure helper so the same rules are
    // tested hermetically and enforced consistently.
    let signFolder;
    try {
      signFolder = validateUploadFolder(folder, entityType, entityId);
    } catch (e) {
      res.status(400).json({ error: e.message });
      return;
    }

    // Stage-0I sandbox scope: a test-admin (no admin claim, non-empty
    // testTribeId) may ONLY sign uploads pinned to its own test tribe. This
    // mirrors the media_files firestore rule (testOwnsIncoming: the persisted
    // doc's kinfolkId must == testTribeId, and the clients stamp
    // kinfolkId=entityId only for the KINFOLK entity). So the folder's pinned
    // entityId (already forced to be the folder's last segment by
    // validateUploadFolder) must equal testTribeId; any other entity is out of
    // scope and denied. A real admin (admin===true) is unrestricted.
    if (decodedToken.admin !== true) {
      const testTribeId = typeof decodedToken.testTribeId === 'string' ? decodedToken.testTribeId : '';
      if (!testTribeId || entityId !== testTribeId) {
        res.status(403).json({ error: 'test_scope_denied' });
        return;
      }
    }

    // Last gate before signing: a WRONG secret must fail here, loudly, rather
    // than downstream at api.cloudinary.com where it writes no Cloud Run log.
    // Deliberately after validation and the test-scope check, so a malformed or
    // unauthorized request still gets its own 400/403 and we do not ping
    // Cloudinary on its behalf.
    const credential = await cloudinaryCredentialsValid(cloudName, apiKey, apiSecret);
    if (!credential.ok) {
      console.error('signCloudinaryUpload: cloudinary credentials rejected', {
        event: 'cloudinary.credentials_invalid',
        detail: credential.detail,
        transient: credential.transient === true,
      });
      res.status(500).json({
        error: 'cloudinary_credentials_invalid',
        detail: credential.detail,
      });
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    // Sign EXACTLY the params the clients POST to Cloudinary: folder + timestamp.
    // Both the web bridge (firebase-bridge.js) and android MediaUploadManager send
    // only file/api_key/timestamp/signature/folder. Cloudinary recomputes the
    // signature over the params it RECEIVES; signing anything extra (public_id,
    // context) that the client does not send yields "Invalid Signature" (the bug
    // we hit 2026-06-09). We sign the VALIDATED folder above (under tribetails/,
    // no traversal, last segment == entityId), so the signature is scoped to
    // exactly one entity's folder and cannot be reused for a different entity.
    // Cloudinary auto-assigns a unique public_id per file, so multi-file uploads
    // (gallery, KinTale) no longer collide on one public_id.
    //
    // #583 adds ONE more signed param, `transformation`, for image uploads.
    // The rule above still holds in both directions: the clients now send it
    // whenever this response carries it, and they omit it when it is blank
    // (video/raw), which is why `transformation` is only put in `signedParams`
    // when it is non-empty. A blank value signed but not sent — or sent but not
    // signed — is the same "Invalid Signature" as any other mismatch.
    //
    // #593 adds `tags` on exactly the same terms, for video uploads. The two
    // are disjoint by construction (image gets a transformation and no tags,
    // video gets tags and no transformation), but nothing here assumes that:
    // each is signed if and only if it is non-empty, and posted on the same
    // condition.
    const signedParams = {
      folder: signFolder,
      timestamp: String(timestamp),
      ...(transformation ? { transformation } : {}),
      ...(tags ? { tags } : {}),
    };
    const signatureBase = Object.keys(signedParams)
      .sort()
      .map((k) => `${k}=${signedParams[k]}`)
      .join('&') + apiSecret;
    const signature = crypto.createHash('sha1').update(signatureBase).digest('hex');

    res.status(200).json({
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder: signFolder,
      // Blank for video/raw. Clients MUST post this field verbatim when it is
      // non-empty and MUST NOT post it when it is empty.
      transformation,
      // #593. Blank for image/raw, `needs-gps-strip` for video. Same contract
      // as `transformation`: post it verbatim when non-empty, omit it entirely
      // when empty.
      tags,
      entityType,
      entityId,
      signedBy: decodedToken.uid,
    });
  }
);

/**
 * Mapbox Search Box autocomplete proxy. The browser posts a partial query
 * + per-user session_token; this function adds the secret access token
 * server-side and returns the suggestions JSON. Keeps the Mapbox token off
 * the public web bundle and gates all calls behind an admin Firebase ID
 * token. Mapbox session_token billing groups suggest+retrieve into a single
 * "search session" so the caller is responsible for reusing the same token
 * across keystrokes until the user picks a result.
 *
 * Body: { query: string, sessionToken: string, country?: string, limit?: number }
 * Response: { suggestions: Array<{ name, full_address, mapbox_id, ... }> }
 */
exports.searchMapbox = onRequest(
  { secrets: [MAPBOX_ACCESS_TOKEN], cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const decodedToken = await requireAdminToken(req, res, 'searchMapbox');
    if (!decodedToken) return;

    const accessToken = MAPBOX_ACCESS_TOKEN.value();
    if (!accessToken) {
      res.status(500).json({ error: 'mapbox_access_token_not_configured' });
      return;
    }

    const { query, sessionToken, country, limit } = req.body || {};
    if (typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ error: 'query is required' });
      return;
    }
    if (typeof sessionToken !== 'string' || !sessionToken.trim()) {
      res.status(400).json({ error: 'sessionToken is required' });
      return;
    }
    const safeQuery = query.trim().slice(0, 256);
    const safeSession = sessionToken.trim().slice(0, 128);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 10);
    const safeCountry = typeof country === 'string' && /^[a-zA-Z]{2}$/.test(country)
      ? country.toLowerCase()
      : 'us';

    const url = new URL('https://api.mapbox.com/search/searchbox/v1/suggest');
    url.searchParams.set('q', safeQuery);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('session_token', safeSession);
    url.searchParams.set('language', 'en');
    url.searchParams.set('limit', String(safeLimit));
    url.searchParams.set('country', safeCountry);
    url.searchParams.set('types', 'address,street,place,postcode');

    try {
      const upstream = await fetch(url.toString());
      if (!upstream.ok) {
        const text = await upstream.text();
        console.error('searchMapbox upstream %d: %s', upstream.status, text);
        res.status(502).json({ error: 'mapbox_upstream_error', status: upstream.status });
        return;
      }
      const body = await upstream.json();
      res.status(200).json({
        suggestions: Array.isArray(body && body.suggestions) ? body.suggestions : [],
        signedBy: decodedToken.uid,
      });
    } catch (err) {
      console.error('searchMapbox failed', err);
      res.status(500).json({ error: 'mapbox_search_failed' });
    }
  }
);

/**
 * Mapbox Search Box retrieve. Once the user picks a suggestion the client
 * calls this with `mapboxId` (from the suggestion) + the same `sessionToken`
 * used during /api/mapbox/sign-search. We return the resolved feature
 * (street address + lng/lat) so the form can fill in the canonical address.
 *
 * Body: { mapboxId: string, sessionToken: string }
 * Response: { feature: { full_address, name, coordinates: { lng, lat }, ... } }
 */
exports.retrieveMapbox = onRequest(
  { secrets: [MAPBOX_ACCESS_TOKEN], cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const decodedToken = await requireAdminToken(req, res, 'retrieveMapbox');
    if (!decodedToken) return;

    const accessToken = MAPBOX_ACCESS_TOKEN.value();
    if (!accessToken) {
      res.status(500).json({ error: 'mapbox_access_token_not_configured' });
      return;
    }

    const { mapboxId, sessionToken } = req.body || {};
    if (typeof mapboxId !== 'string' || !mapboxId.trim()) {
      res.status(400).json({ error: 'mapboxId is required' });
      return;
    }
    if (typeof sessionToken !== 'string' || !sessionToken.trim()) {
      res.status(400).json({ error: 'sessionToken is required' });
      return;
    }

    const safeId = encodeURIComponent(mapboxId.trim().slice(0, 256));
    const safeSession = sessionToken.trim().slice(0, 128);
    const url = new URL(`https://api.mapbox.com/search/searchbox/v1/retrieve/${safeId}`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('session_token', safeSession);

    try {
      const upstream = await fetch(url.toString());
      if (!upstream.ok) {
        const text = await upstream.text();
        console.error('retrieveMapbox upstream %d: %s', upstream.status, text);
        res.status(502).json({ error: 'mapbox_upstream_error', status: upstream.status });
        return;
      }
      const body = await upstream.json();
      const feature = Array.isArray(body && body.features) ? body.features[0] : null;
      res.status(200).json({
        feature,
        signedBy: decodedToken.uid,
      });
    } catch (err) {
      console.error('retrieveMapbox failed', err);
      res.status(500).json({ error: 'mapbox_retrieve_failed' });
    }
  }
);


// generateAuntieCopy: Auntie copy generator. Replaces the n8n `auntie-generate`
// webhook (workflow SIg2KsWn0oyRkSzR). Admin-only (Firebase ID token), reads
// admin-only Firestore context (dossiers / kin / the_411 / visit_logs), builds
// the prompt from the consolidated Voice Bible + exemplars (web/functions/voice),
// calls Claude, writes a draft, and returns a byte-compatible GenerateResponse.
// Exposed at POST /api/generate via the web/firebase.json rewrite.
//
// NAME: this function is DELIBERATELY named `generateAuntieCopy`, not `generate`.
// The MyTribe kinfolk-portal codebase (same Firebase project) exports an ONCALL
// callable named `generate` (functions/src/portal/generate.ts). Two codebases
// cannot share a function id, and the /api/generate Hosting rewrite was resolving
// to that callable — a plain HTTP POST (no `{data:...}` envelope) hit the
// callable protocol and came back 400 {"error":{...,"status":"INVALID_ARGUMENT"}}
// (Sentry AUNTIEOS-ADMIN-Q/P). Renaming this onRequest breaks the collision; the
// rewrite SOURCE path stays /api/generate so android + web clients are unchanged.
//
// Body: { communication_type, recipient, raw_notes, tone_hint?, max_length?, avoid_opening? }
// Returns (GenerateResponse):
//   { generated_copy, communication_type, kinfolk_name, kinfolk_id, model,
//     draft_id, draftWriteFailed, warnings, error? }
//   - draft_id:         id of the persisted generated_drafts doc, or null if the
//                       draft write failed (the copy is still returned).
//   - draftWriteFailed: true when the Firestore draft write failed. HTTP is still
//                       200 (the copy is the valuable output) but this flag lets
//                       the client render a fail-loud "draft NOT saved" banner so
//                       the failure is never silently swallowed (WARNING-13).
//   - warnings:         array of human-readable non-fatal warning strings (e.g.
//                       the draft-write failure detail). Empty on the happy path.
//   - error:            present ONLY on the error response shape (5xx/4xx), where
//                       generated_copy is '' and the call failed outright.
const ANTHROPIC_MODEL_DEFAULT = 'claude-sonnet-4-5';

// NOTE-48: pin the model to a server-side allowlist. The runtime can override the
// default via the ANTHROPIC_MODEL env var, but only to a value we explicitly
// allow, so a bad/leaked env can't silently route generations to an unintended
// (e.g. far more expensive) model. Anything not in the list falls back to the
// default rather than being passed through to the API.
const ALLOWED_ANTHROPIC_MODELS = new Set(['claude-sonnet-4-5']);

function resolveAnthropicModel() {
  const requested = process.env.ANTHROPIC_MODEL;
  return ALLOWED_ANTHROPIC_MODELS.has(requested) ? requested : ANTHROPIC_MODEL_DEFAULT;
}

exports.generateAuntieCopy = onRequest({ secrets: [ANTHROPIC_API_KEY], cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const decodedToken = await requireAdminToken(req, res, 'generateAuntieCopy');
  if (!decodedToken) return;

  const commType = (req.body && req.body.communication_type) || '';
  const apiKey = ANTHROPIC_API_KEY.value();
  if (!apiKey) {
    res.status(500).json({ generated_copy: '', communication_type: commType, error: 'anthropic_api_key_not_configured' });
    return;
  }

  // NOTE-48: bound paid-LLM spend per admin per UTC day (defense-in-depth on an
  // already admin-gated endpoint — a runaway client loop or a leaked admin token
  // could otherwise drive unbounded Anthropic cost). Over the cap → explicit 429.
  try {
    await enforceGenerateRateLimit(admin.firestore(), decodedToken.uid, Date.now());
  } catch (rlErr) {
    if (rlErr && rlErr.status === 429) {
      res.status(429).json({ generated_copy: '', communication_type: commType, error: 'generate_rate_limit_exceeded' });
      return;
    }
    console.error('generate rate-limit check failed', rlErr);
    res.status(500).json({ generated_copy: '', communication_type: commType, error: 'rate_limit_check_failed' });
    return;
  }

  const model = resolveAnthropicModel();
  const anthropic = new Anthropic({ apiKey });

  try {
    const result = await runGenerate({ db: admin.firestore(), anthropic, model }, req.body || {});
    res.status(200).json(result);
  } catch (err) {
    // Byte-compatible error shape: always returns a full GenerateResponse so both
    // clients deserialize cleanly; the `error` field surfaces the failure (fail-loud).
    const status = err && err.status ? err.status : 500;
    if (status >= 500) console.error('generate failed', err);
    res.status(status).json({
      generated_copy: '',
      communication_type: commType,
      error: err && err.message ? err.message : 'generate_failed',
    });
  }
});

// Exported for unit tests (pure helpers; the onCall/onRequest handlers above are
// the real entry points and are registered by side effect on require).
module.exports.resolveAnthropicModel = resolveAnthropicModel;
module.exports.ALLOWED_ANTHROPIC_MODELS = ALLOWED_ANTHROPIC_MODELS;
module.exports.ANTHROPIC_MODEL_DEFAULT = ANTHROPIC_MODEL_DEFAULT;
module.exports.validateUploadFolder = validateUploadFolder;
module.exports.uploadTransformationFor = uploadTransformationFor;
module.exports.STRIP_METADATA_TRANSFORMATION = STRIP_METADATA_TRANSFORMATION;
module.exports.uploadTagsFor = uploadTagsFor;
module.exports.UPLOAD_PENDING_STRIP_TAG = UPLOAD_PENDING_STRIP_TAG;
module.exports.cloudinaryCredentialsValid = cloudinaryCredentialsValid;
module.exports.__resetCloudinaryCredentialCache = () => {
  cloudinaryCredentialCheck = null;
};
module.exports.assertAdminRemovalAllowed = assertAdminRemovalAllowed;
module.exports.mergeAdminClaim = mergeAdminClaim;
module.exports.projectN8nDocResponse = projectN8nDocResponse;
module.exports.N8N_DOC_RESPONSE_FIELDS = N8N_DOC_RESPONSE_FIELDS;
