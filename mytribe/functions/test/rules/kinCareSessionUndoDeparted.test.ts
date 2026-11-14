import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * #2250, operator ruling 2026-11-14: "Undo departed" puts a visit back to
 * Arrived for a few minutes after Departed. Only the `setVisitLifecycle`
 * callable does it: it holds the time limit, puts the household's copy back
 * and writes the Activity Log line. These rules are what make that the only
 * way: no client, the owner's included, writes a Departed or Completed visit
 * back to Arrived, and an Auntie's client cannot move the stamp that says when
 * the undo closes.
 *
 * The Admin SDK bypasses rules, so the callable is unaffected by all of this.
 */

const OWNER = { admin: true };
const AUNTIE = { staffRole: 'auntie' };
const SESSION = 'kin_care_sessions/s1';

const DEPARTED = {
  status: 'DEPARTED',
  arrivedAt: '2026-11-14T15:00:00Z',
  departedAt: '2026-11-14T15:30:00Z',
  undoDepartedUntil: '2026-11-14T15:35:00.000Z',
};
const COMPLETED = { ...DEPARTED, status: 'COMPLETED', completedAt: '2026-11-14T15:30:00Z' };

async function seed(session: Record<string, unknown>): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(SESSION).set({ kinfolkId: 'kf1', ...session });
  });
}

async function as(uid: string, claims: Record<string, unknown>) {
  return (await getEnv()).authenticatedContext(uid, claims).firestore().doc(SESSION);
}

describe('rules: only the callable takes a departure back', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('a Completed visit cannot be written back to Arrived, by an Auntie or by the owner', async () => {
    for (const [uid, claims] of [['auntie1', AUNTIE], ['owner1', OWNER]] as const) {
      await seed(COMPLETED);
      await assertFails((await as(uid, claims)).set({ status: 'ARRIVED', departedAt: '' }, { merge: true }));
    }
  });

  it('a Departed visit cannot be written back to Arrived either, whatever the arrival switch says', async () => {
    for (const [uid, claims] of [['auntie1', AUNTIE], ['owner1', OWNER]] as const) {
      await seed(DEPARTED);
      await assertFails((await as(uid, claims)).set({ status: 'ARRIVED', departedAt: '' }, { merge: true }));
      await assertFails((await as(uid, claims)).set({ status: ' arrived ' }, { merge: true }));
    }
  });

  it("an Auntie's client cannot move when the undo closes, nor what the household copy read", async () => {
    await seed(COMPLETED);
    const doc = await as('auntie1', AUNTIE);
    await assertFails(doc.set({ undoDepartedUntil: '2099-01-01T00:00:00.000Z' }, { merge: true }));
    await assertFails(doc.set({ householdStatusBeforeCompletion: 'requested' }, { merge: true }));
  });

  it('Undo arrival on a Departed visit still writes directly, as before', async () => {
    await seed(DEPARTED);
    await assertSucceeds(
      (await as('auntie1', AUNTIE)).set({ status: 'SCHEDULED', arrivedAt: '', departedAt: '' }, { merge: true }),
    );
  });

  it('an ordinary arrival and departure still write directly', async () => {
    await seed({ status: 'SCHEDULED' });
    const doc = await as('auntie1', AUNTIE);
    await assertSucceeds(doc.set({ status: 'ARRIVED', arrivedAt: '2026-11-14T15:00:00Z' }, { merge: true }));
    await assertSucceeds(doc.set({ status: 'DEPARTED', departedAt: '2026-11-14T15:30:00Z' }, { merge: true }));
  });

  it('a Completed visit still takes a patch that leaves those fields alone', async () => {
    await seed(COMPLETED);
    await assertSucceeds((await as('auntie1', AUNTIE)).set({ sentReportCount: 1 }, { merge: true }));
  });
});
