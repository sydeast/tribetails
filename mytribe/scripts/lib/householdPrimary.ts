/**
 * householdPrimary.ts (#2096)
 *
 * The test-login scripts (`seedDemoKinfolk --link-uid`, `qa_enable_sandbox_login`)
 * and `backfillHouseholdMembers` attach a login to a household. A real sign-up
 * (`acceptInvite`) leaves an ACTIVE member record behind, and since #1840 a
 * household notice goes only to a login that has one. These two functions are
 * how a script does the same: decide with the functions' own rule
 * (`functions/src/lib/householdMember.ts`), then write the functions' own shape.
 *
 * Handles are injected (the caller's guarded `./firebaseAdmin` Firestore and
 * Auth), and the caller passes its own `FieldValue.serverTimestamp()`, for the
 * reason `householdMember.ts` gives.
 */

import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import {
  decidePrimaryLink,
  primaryLinkRefusalText,
  primaryMemberRecord,
  readPrimaryLinkFacts,
  type PrimaryLinkDecision,
  type PrimaryLinkFacts,
} from '../../functions/src/lib/householdMember';

export interface PrimaryLinkPlan {
  decision: PrimaryLinkDecision;
  facts: PrimaryLinkFacts;
}

/** READS ONLY. What linking `uid` to `familyId` as its PRIMARY would do. */
export async function planPrimaryLink(
  deps: { db: Firestore; auth: Auth },
  familyId: string,
  uid: string,
): Promise<PrimaryLinkPlan> {
  const facts = await readPrimaryLinkFacts(deps, familyId, uid);
  return { decision: decidePrimaryLink(uid, facts), facts };
}

/** Throws a plain-words Error when the plan is a refusal; returns otherwise. */
export function assertPrimaryLinkAllowed(plan: PrimaryLinkPlan): void {
  if (plan.decision.action !== 'refuse') return;
  throw new Error(`Refusing to link this login: ${primaryLinkRefusalText(plan.decision.why)}.`);
}

/**
 * Writes the member record when the plan says to create one, and nothing
 * otherwise. `create`, never `set`: a record that appeared since the plan was
 * read is left alone and the write fails loudly. `extra` carries the script's
 * own marker (`_demo`, `isTestData`) so its clean-up tools can find the row.
 * Returns whether a record was written.
 */
export async function writePrimaryMember(
  db: Firestore,
  familyId: string,
  uid: string,
  plan: PrimaryLinkPlan,
  stamp: unknown,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  assertPrimaryLinkAllowed(plan);
  if (plan.decision.action !== 'create_primary') return false;
  await db
    .doc(`families/${familyId}/members/${uid}`)
    .create({ ...primaryMemberRecord(uid, plan.facts.email, stamp), ...extra });
  return true;
}
