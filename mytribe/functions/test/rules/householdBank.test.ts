import { afterAll, afterEach, beforeEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser, asUnauth } from './setup';

/**
 * `household_bank`, the third reconciled record (issue #461).
 *
 * The bank is the peer of a kinfolk dossier and a kin 411, and it inherits their
 * standing ruling word for word: DOSSIERS AND 411s ARE ADMIN-ONLY, KINFOLK NEVER
 * SEE THEM. A household bank holds gate codes, alarm details and where the spare
 * key is, so the rule matters more here than on either peer, and it is pinned
 * rather than assumed.
 *
 * The rule mirrors `/dossiers`: `isAuntie()` reads and writes, plus a single
 * sandbox read branch keyed on the DOC ID matching the test admin's tribe. That
 * doc-id branch is why `upsert_household_bank` writes at an id equal to the
 * household id rather than a prefixed one; the cases below fail if either half
 * of that pairing moves.
 */

const HOUSEHOLD = 'kf-hb-1';
const OTHER_HOUSEHOLD = 'kf-hb-2';

/** An AuntieOS operator: the `admin: true` custom claim isAuntie() keys on. */
function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('staff-1', { admin: true });
}

/** A Stage-0I test admin: the testTribeId claim, deliberately NO admin claim. */
function asTestAdmin(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('test-admin-uid', { testTribeId: HOUSEHOLD });
}

/** A signed-in household member. The role the portal runs as, and the one this rule exists to refuse. */
function asKinfolk(env: Awaited<ReturnType<typeof getEnv>>) {
  return asUser(env, 'kinfolk-uid', { role: 'kinfolk', kinfolkId: HOUSEHOLD });
}

describe('rules: household_bank is admin-only', () => {
  beforeEach(async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      for (const id of [HOUSEHOLD, OTHER_HOUSEHOLD]) {
        await db.doc(`household_bank/${id}`).set({
          householdId: id,
          rawSummary: 'Side gate code is 4321.',
          accessAndEntry: 'Lockbox on the hose bib.',
        });
      }
    });
  });

  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('an admin reads and writes a household bank', async () => {
    const env = await getEnv();
    const fs = asAuntie(env).firestore();
    await assertSucceeds(fs.doc(`household_bank/${HOUSEHOLD}`).get());
    await assertSucceeds(fs.doc(`household_bank/${HOUSEHOLD}`).set({ tldr: 'Side gate.' }, { merge: true }));
  });

  it('a signed-in kinfolk is DENIED reading their own household bank', async () => {
    // The whole point: this record is written FOR the admin, about the home. A
    // household reading it would be reading staff notes about themselves.
    const env = await getEnv();
    await assertFails(asKinfolk(env).firestore().doc(`household_bank/${HOUSEHOLD}`).get());
  });

  it('a signed-in kinfolk is DENIED writing a household bank', async () => {
    const env = await getEnv();
    await assertFails(
      asKinfolk(env).firestore().doc(`household_bank/${HOUSEHOLD}`).set({ accessAndEntry: 'x' }, { merge: true }),
    );
  });

  it('a kinfolk is DENIED listing the collection, which is the way around a doc rule', async () => {
    const env = await getEnv();
    await assertFails(asKinfolk(env).firestore().collection('household_bank').get());
    await assertFails(
      asKinfolk(env).firestore().collection('household_bank').where('householdId', '==', HOUSEHOLD).get(),
    );
  });

  it('a signed-out caller is DENIED entirely', async () => {
    const env = await getEnv();
    await assertFails(asUnauth(env).firestore().doc(`household_bank/${HOUSEHOLD}`).get());
  });

  it('a sandbox test admin reads its OWN bank, because the doc id is the household id', async () => {
    const env = await getEnv();
    await assertSucceeds(asTestAdmin(env).firestore().doc(`household_bank/${HOUSEHOLD}`).get());
  });

  it('a sandbox test admin is DENIED another household’s bank', async () => {
    const env = await getEnv();
    await assertFails(asTestAdmin(env).firestore().doc(`household_bank/${OTHER_HOUSEHOLD}`).get());
  });

  it('a sandbox test admin is DENIED writing even its own bank', async () => {
    // Writes stay admin-only on all three records; the nightly job writes through
    // the Admin SDK, which does not evaluate rules at all.
    const env = await getEnv();
    await assertFails(
      asTestAdmin(env).firestore().doc(`household_bank/${HOUSEHOLD}`).set({ tldr: 'y' }, { merge: true }),
    );
  });
});
