import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { isOwner } from './staffGate';

/**
 * Server-side twin of the Stage 0I test-admin sandbox.
 *
 * The CLIENT half lives in `auntieos-admin/android/.../domain/TestMode.kt` and
 * the RULES half in `firestore.rules` (`testOwnsExisting` / `testOwnsIncoming`,
 * ~:106-131). All three read the same signal: a test admin signs in as a normal
 * Firebase user carrying the custom claim `testTribeId` (a string kinfolk doc
 * id) and does NOT carry `admin: true`. Rules restrict that account to records
 * where `kinfolkId == testTribeId`.
 *
 * WHY THE SERVER NEEDS ITS OWN COPY NOW. ADR-0002
 * (docs/adr/0002-callable-only-invoice-writes.md) funnels every invoice write,
 * production and sandbox alike, through callables, precisely so TestMode stays
 * a faithful rehearsal of the production write path. `wrapAdminCallable`
 * refuses a test admin (no `admin` claim), so the invoice-write callables gate
 * through [resolveInvoiceWriteActor] instead: staff pass unscoped, a test
 * admin passes SCOPED, everyone else is refused. The scoping repeats the rules'
 * semantics rather than inventing new ones:
 *
 *   - incoming docs are STAMPED with `kinfolkId = testTribeId`
 *     ([scopedKinfolkId], the twin of `TestMode.scopedKinfolkId` on Android and
 *     `testOwnsIncoming()` in rules), so a sandbox client cannot mint a record
 *     into live data no matter what kinfolkId it sends;
 *   - existing docs must already CARRY `kinfolkId == testTribeId`
 *     ([testOwnsDoc], the twin of `testOwnsExisting()`), so a sandbox client
 *     cannot read or mutate a live household's record by guessing its id.
 *
 * PRECEDENCE mirrors the rules expression `isAuntie() || testOwns*()`: a caller
 * with BOTH the admin claim and a stray test claim is staff, unscoped. The
 * rules already grant that account full access, so scoping it here would only
 * make the callable disagree with what the same token can do directly.
 */
export interface TestModeClaim {
  /** True iff the token carries a non-blank string `testTribeId` claim. */
  active: boolean;
  /** The sandbox kinfolk doc id from the claim; '' when not in test mode. */
  testTribeId: string;
}

export const TEST_MODE_OFF: TestModeClaim = { active: false, testTribeId: '' };

/**
 * Derive the claim from a decoded token. Active iff `testTribeId` is present,
 * a string, and non-blank after trimming. Any other shape (missing, null,
 * non-string, blank) reads as OFF, so a malformed claim never half-enables
 * sandbox scoping: the same rule as `TestMode.fromClaims` on Android.
 */
export function testModeOf(token: Record<string, unknown> | undefined): TestModeClaim {
  const raw = token?.['testTribeId'];
  const id = typeof raw === 'string' ? raw.trim() : '';
  return id.length > 0 ? { active: true, testTribeId: id } : TEST_MODE_OFF;
}

/**
 * The `kinfolkId` an incoming (created) doc must carry. In test mode the
 * sandbox id, regardless of what the caller sent; otherwise the caller's own
 * value. Twin of Android's `TestMode.scopedKinfolkId`, which today does this
 * client-side; moving it here is what makes the stamp unforgeable.
 */
export function scopedKinfolkId(mode: TestModeClaim, fallback: string): string {
  return mode.active ? mode.testTribeId : fallback;
}

/**
 * Whether an EXISTING doc is inside the caller's sandbox. Not in test mode:
 * everything is in scope (the staff path). Twin of the rules'
 * `testOwnsExisting()`.
 */
export function testOwnsDoc(mode: TestModeClaim, kinfolkId: unknown): boolean {
  return !mode.active || kinfolkId === mode.testTribeId;
}

export interface InvoiceWriteActor {
  uid: string;
  /** OFF for staff (staff are never scoped); active for a sandbox caller. */
  testMode: TestModeClaim;
}

/**
 * The gate for the invoice-write callables (ADR-0002). Staff (admin claim or
 * the logged env-allowlist fallback, via `isOwner`) pass unscoped; a test
 * admin passes scoped to their sandbox; anyone else is refused. See the module
 * header for why this exists beside `wrapAdminCallable` instead of replacing
 * it.
 */
export function resolveInvoiceWriteActor(
  req: CallableRequest<unknown>,
  functionName: string,
): InvoiceWriteActor {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  if (isOwner(uid, req.auth?.token?.admin === true, functionName)) {
    return { uid, testMode: TEST_MODE_OFF };
  }
  const mode = testModeOf(req.auth?.token as Record<string, unknown> | undefined);
  if (mode.active) return { uid, testMode: mode };
  throw new HttpsError('permission-denied', 'Admin claim required.');
}
