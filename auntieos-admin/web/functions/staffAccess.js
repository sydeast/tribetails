// THE ADMIN/AUNTIE BOUNDARY FOR THIS CODEBASE, IN ONE LIST.
//
// Issue #944, operator ruling 2026-09-22. Spec:
// docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md
//
// WHY THIS FILE IS A SECOND COPY OF SOMETHING THAT ALREADY EXISTS.
// `mytribe/functions/src/lib/auntieAccess.ts` holds the same table for the
// other 135 callables, and `lib/staffGate.ts` the same three claim predicates.
// This is a SEPARATE Cloud Functions codebase: its own package.json, its own
// lockfile, its own deploy, and deliberately not a workspace member, because
// Cloud Functions ship as self-contained artifacts. It cannot import across
// the tree, so the boundary is restated rather than shared.
//
// The duplication is the cost of the split deploy and it is written down here
// so nobody "fixes" it with an import that breaks the deploy. What must not
// drift is the CLAIM SHAPE — `STAFF_ROLE_AUNTIE`, and owner meaning
// `admin === true` AND NOT the caretaker. The allowlists are different lists on
// purpose: they gate different endpoints.
//
// HOW TO DECIDE A NEW ENTRY. Same procedure as the rules walk and as
// `auntieAccess.ts`, first match wins:
//   1. Does it touch invoices, payments, credits, balances, payouts, pricing or
//      Stripe? Owner. This is the bright line and it has no exceptions.
//   2. Does it read or write a dossier, or household_bank? Owner.
//   3. Does it mint, revoke or list a claim, or edit staff/business config?
//      Owner.
//   4. Is it marketing, the business phone, security, or audit oversight? Owner.
//   5. Does the Auntie's job require it? Add it here.
//   6. Destructive (delete, archive, bulk mutate)? Owner, even under 5.
//   7. Anything else: leave it out, and say why in the PR that considered it.
//
// ABSENT MEANS REFUSED. A typo in the set below grants nothing rather than
// granting the wrong thing, and an endpoint added next month is owner-only
// until somebody opens it on purpose.

/**
 * The value of the `staffRole` custom claim that means "caretaker". The owner
 * carries `admin: true` and no `staffRole` at all.
 *
 * Must equal `mytribe/functions/src/lib/auntieAccess.ts#STAFF_ROLE_AUNTIE`,
 * `hasAuntieRole()` in `mytribe/firestore.rules`, and
 * `auntieos-admin/src/lib/gate.ts#STAFF_ROLE_AUNTIE`.
 */
const STAFF_ROLE_AUNTIE = 'auntie';

/**
 * Endpoints in THIS codebase a caretaker may reach. Everything else is
 * owner-only. Each entry carries the reason, because the reason is what a
 * reviewer is checking.
 */
const AUNTIE_ALLOWED_ENDPOINTS = new Set([
  // Signs the Cloudinary upload for a KinTale photo. Without it the role ships
  // with a broken camera: rules already grant her `media_files` create and
  // `kin_care_reports` write, and `saveMediaTags` / `setMediaProfilePhoto` are
  // already on the other codebase's allowlist, all of which are theoretical
  // until the bytes can be uploaded. Scoped by `validateUploadFolder`, which
  // pins a signature to exactly one entity's directory.
  'signCloudinaryUpload',

  // Mapbox address autocomplete for the desktop/wasm household edit screen.
  // She holds `kinfolk update` in the rules, so entering a household's address
  // is work she is granted; refusing here would break a field on a screen she
  // is allowed to use. It also protects nothing: the React admin reaches the
  // IDENTICAL suggest/retrieve through `mytribe/functions/src/portal/mapboxSearch.ts`,
  // which is `wrapCallable` and therefore open to ANY signed-in caller.
  'searchMapbox',
  'retrieveMapbox',
]);

// OWNER-ONLY, AND WHY — the other six endpoints in index.js. Recorded here
// rather than only in a PR body, because "absent" alone does not say whether a
// thing was decided or missed.
//
//   setAdminClaim      Mints and revokes the owner claim. Procedure step 3, and
//                      the single most important refusal in the file: a
//                      contractor who could call it could make herself the
//                      owner. Spec §3 names it as the miss that would cost most.
//   listAdmins         Reads the admin roster. Account administration, step 3.
//   generateAuntieCopy Reads `dossiers/{kinfolkId}` and puts its rawSummary,
//                      communicationStyle, householdNotes and
//                      relationshipWithAuntie straight into the prompt and the
//                      returned draft (generate.js:216-221, :359). Dossiers are
//                      admin-only by the ruling, so opening this would launder a
//                      dossier past the boundary through the copy generator.
//                      Step 2, and it spends Anthropic credit besides.
//   writeDraft         The three n8n-era draft endpoints. Step 7: NO LIVE CALLER.
//   getDraft           n8n is retired and nothing in any client tree calls
//   getTrainingDoc     `/api/draft/write`, `/api/draft/get` or
//                      `/api/training-doc`; the composer reaches
//                      `generated_drafts` and `training_documents` as direct
//                      client reads and writes, which the rules already grant a
//                      caretaker (`isStaff()`, spec §8 lines 1050-1051, 1126).
//                      So this is "no caller", not "the ruling says no": she is
//                      not blocked from the data, only from three unused HTTP
//                      front doors that carry a shared rate-limit budget.
//                      Opening them would add reachable surface for zero gain.

/**
 * Does this decoded token carry the caretaker role?
 *
 * EXACT MATCH. Spec §3: an unknown future `staffRole` such as `'bookkeeper'` is
 * neither the owner nor the caretaker, and is refused everywhere until someone
 * writes rules for it. A truthiness test here would admit it.
 */
function isAuntieClaim(token) {
  return !!token && token.staffRole === STAFF_ROLE_AUNTIE;
}

/**
 * Does this decoded token carry the OWNER claim?
 *
 * Mirrors `mytribe/functions/src/lib/staffGate.ts#isOwnerClaim` and
 * `firestore.rules:isOwner()`. The `!isAuntieClaim` conjunct covers the account
 * that should not exist: it degrades to the caretaker boundary rather than
 * keeping the owner's. The three implementations must not be allowed to
 * disagree, because a client on one boundary and a server on another is the
 * disagreement the claim split exists to prevent.
 */
function isOwnerClaim(token) {
  return !!token && token.admin === true && !isAuntieClaim(token);
}

/** May a caretaker reach this endpoint? Unknown name means no. */
function auntieMayCall(name) {
  return AUNTIE_ALLOWED_ENDPOINTS.has(name);
}

/**
 * The `staffRole` a set of EXISTING custom claims carries, as a plain string.
 *
 * Returns `''` for an account carrying none. Deliberately does NOT narrow to
 * the caretaker: `setAdminClaim` refuses to mint the owner onto ANY staff role,
 * including one this codebase has never heard of, because a role nobody has
 * written rules for is exactly the account that must not be handed owner power.
 */
function staffRoleOf(existingClaims) {
  const raw = existingClaims && existingClaims.staffRole;
  return typeof raw === 'string' ? raw : '';
}

/**
 * Which role is this verified token acting as, for THIS endpoint?
 *
 * Returns `'owner' | 'caretaker' | 'testAdmin' | null`, and null means refuse.
 * Total, pure and order-significant:
 *
 *   1. owner      — `admin === true` and not the caretaker. Reaches everything.
 *   2. caretaker  — checked BEFORE the sandbox, so a double-claimed account
 *                   lands here rather than on the owner branch above (it fails
 *                   `isOwnerClaim`) or on the test-admin branch below.
 *   3. testAdmin  — only where the endpoint opted in with `allowTestAdmin`, and
 *                   the CALLER is then responsible for scoping the request to
 *                   the sandbox tribe. Unchanged from before #944; it is listed
 *                   last so that teaching this gate the caretaker cannot widen
 *                   it.
 *
 * A caretaker on an endpoint she is not allowlisted for returns null: she is
 * refused as a caretaker, not admitted as a test admin, even if her account
 * somehow also carries `testTribeId`.
 */
function resolveStaffRole(token, endpoint, { allowTestAdmin = false } = {}) {
  if (isOwnerClaim(token)) return 'owner';
  if (isAuntieClaim(token)) return auntieMayCall(endpoint) ? 'caretaker' : null;
  if (!allowTestAdmin) return null;
  const testTribeId = token && typeof token.testTribeId === 'string' ? token.testTribeId : '';
  return testTribeId.length > 0 ? 'testAdmin' : null;
}

module.exports = {
  STAFF_ROLE_AUNTIE,
  AUNTIE_ALLOWED_ENDPOINTS,
  isAuntieClaim,
  isOwnerClaim,
  auntieMayCall,
  staffRoleOf,
  resolveStaffRole,
};
