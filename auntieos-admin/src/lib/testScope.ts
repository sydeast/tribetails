import { type CollectionSpec, type Filter } from './firestore';

/**
 * Stage-0I sandbox scoping for every realtime collection query.
 *
 * A test admin holds a `testTribeId` claim and NOT `isAuntie`, so Firestore
 * rules deny a broad read of the operator collections. The android tree has
 * always constrained these queries (`AuntieRepository.scopedByKinfolk`); the
 * React port parsed the claim, rendered the sandbox banner from it, and never
 * carried the rule into the query layer. Result, verified live on 2026-07-20:
 * Home, Invoices and Directory all showed "Missing or insufficient permissions".
 *
 * The scope is applied CENTRALLY in `useCollection` rather than per screen, on
 * purpose. The defect was a screen forgetting to scope; a rule that each new
 * screen must remember would reproduce it. Here a screen cannot opt out.
 */

/**
 * Collections whose docs carry `kinfolkId` and are therefore scopeable to the
 * sandbox tribe. Mirrors `scopedByKinfolk` in android's AuntieRepository, which
 * went through the 2026-07-18 permission audit. Anything absent from this set is
 * either global config (templates, business hours, feature flags) or is handled
 * by rules alone — do NOT add a path here without checking the doc actually has
 * a `kinfolkId` field, or the query returns zero rows instead of denying, which
 * is the silent-empty failure this codebase is built to avoid.
 */
export const SCOPED_BY_KINFOLK: ReadonlySet<string> = new Set([
  'invoices',
  'kin',
  'kin_care_reports',
  'kin_care_sessions',
  'media_files',
  'payments',
  'visit_logs',
]);

/**
 * Collections a test admin can reach only by DOCUMENT ID, not by a field.
 * A `kinfolk` doc has no `kinfolkId` of its own — its doc id IS the tribe id —
 * so the sandbox constraint is `documentId() == testTribeId`. Android does the
 * same thing by collapsing to a single `.document(testTribeId).get()`.
 * Verified live 2026-07-20: without this, Directory's Kinfolk tab is denied
 * while its Kin tab (which does carry kinfolkId) loads fine.
 */
export const SCOPED_BY_DOC_ID: ReadonlySet<string> = new Set(['kinfolk']);

/** Sentinel field name meaning "the document id"; firestore.ts turns this into
 *  a `documentId()` FieldPath, which is the only way to filter on doc id. */
export const DOC_ID_FIELD = '__name__';

/**
 * Collections a test admin cannot read AT ALL and which carry no `kinfolkId` to
 * scope by, so there is nothing to constrain — the only correct behaviour is not
 * to query them and to show an empty result rather than an error.
 *
 * This mirrors the 2026-07-18 sandbox permission audit, where the android tree
 * SUPPRESSES busy blocks in test mode for exactly this reason. Verified live
 * 2026-07-20: Schedule rendered "Busy blocks: Missing or insufficient
 * permissions", which is a scary red banner for what is really "not applicable
 * to a sandbox account".
 */
export const SUPPRESSED_IN_TEST_MODE: ReadonlySet<string> = new Set([
  // Global availability config; no kinfolkId to scope by.
  'booking_time_slots',
  // Operator-wide, hash-chained audit trail. Deliberately unreadable by a
  // sandbox account, and it has no kinfolkId either, so there is nothing to
  // scope. Showing it empty is truer than a red permission error for data that
  // simply does not apply to this account type.
  'activity_log',
  // Tribal Intel. SUPPRESSED rather than scoped, for two independent reasons,
  // either of which alone would rule scoping out:
  //  1. The rule is `allow read: if isAuntie();` with NO isTestAdmin branch
  //     (web/firestore.rules:633, and MyTribe's identical copy at :632). A test
  //     admin does not hold isAuntie, so EVERY read of this collection is
  //     denied no matter what predicate the query carries. No filter can buy a
  //     permission the rule never grants. MyTribe's own rules suite already
  //     pins this: `assertFails(fs.doc('training_documents/t1').get())` for a
  //     test admin, functions/test/rules/testAdminSandbox.test.ts:238.
  //  2. There is no `kinfolkId` field to scope BY. The doc's household FKs are
  //     `targetKinfolkId`/`targetKinId` (spec-23 write-tool fields), and the
  //     pre-spec-23 migrated docs carry neither, so scoping on one would drop
  //     every legacy row on top of still being denied.
  // Left unsuppressed, a sandbox operator opening The Den's Tribal Intel got a
  // raw "Missing or insufficient permissions", which is the exact scary-banner
  // failure this set exists to convert into an honest empty state.
  'training_documents',
]);

/** True when this collection should resolve to an empty list instead of being
 *  queried, because the signed-in account is a sandbox test admin. */
export function isSuppressedInTestMode(path: string): boolean {
  return currentTestTribeId !== null && SUPPRESSED_IN_TEST_MODE.has(path);
}

const SCOPE_FIELD = 'kinfolkId';

/** Module-level because `useCollection` has no access to route context. Set once
 *  by the admin layout guard after it resolves the claim, cleared on sign-out. */
let currentTestTribeId: string | null = null;

/** Set (or clear, with null) the sandbox tribe every scoped query is pinned to. */
export function setTestScope(testTribeId: string | null): void {
  currentTestTribeId = testTribeId;
}

export function getTestScope(): string | null {
  return currentTestTribeId;
}

/**
 * Return `spec` constrained to the sandbox tribe when a test admin is signed in,
 * otherwise `spec` unchanged. Idempotent: applying twice cannot stack duplicate
 * predicates, since a re-render re-derives the spec.
 */
export function applyTestScope(spec: CollectionSpec): CollectionSpec {
  const tribe = currentTestTribeId;
  if (!tribe) return spec;

  const field = SCOPED_BY_KINFOLK.has(spec.path)
    ? SCOPE_FIELD
    : SCOPED_BY_DOC_ID.has(spec.path)
      ? DOC_ID_FIELD
      : null;
  if (!field) return spec;

  const existing = spec.filters ?? [];
  if (existing.some((f) => f[0] === field && f[2] === tribe)) return spec;

  const scope: Filter = [field, '==', tribe];
  return { ...spec, filters: [...existing, scope] };
}
