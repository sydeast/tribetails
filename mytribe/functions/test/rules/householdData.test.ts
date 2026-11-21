import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser, asUnauth } from './setup';

/**
 * #2289: one `household_data` record per household.
 *
 * The office created its record under an auto id while the portal's vet pick
 * created one at `household_data/{householdId}`. Two creates at about the same
 * time left the household with two records, each side reading a different one.
 *
 * Every creator now uses the household id as the document id, and the rule
 * refuses a create anywhere else. That refusal is what holds for an installed
 * app that still creates the old way: its create is turned down instead of
 * making the second record.
 */

type Env = Awaited<ReturnType<typeof getEnv>>;

/** The owner: `admin: true`, no staffRole. */
function asOwner(env: Env) {
  return env.authenticatedContext('owner-1', { admin: true });
}

/** An Auntie: staffRole only. */
function asAuntie(env: Env) {
  return env.authenticatedContext('auntie-1', { staffRole: 'auntie' });
}

async function seed(path: string, data: Record<string, unknown>) {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(path).set(data);
  });
}

async function recordsFor(kinfolkId: string): Promise<string[]> {
  const env = await getEnv();
  let ids: string[] = [];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.firestore().collection('household_data').where('kinfolkId', '==', kinfolkId).get();
    ids = snap.docs.map((d) => d.id);
  });
  return ids;
}

describe('rules: #2289 a household record is created at the household id, and nowhere else', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  for (const [who, signIn] of [
    ['the owner', asOwner],
    ['an Auntie', asAuntie],
  ] as const) {
    it(`${who} creates the first record at the household id`, async () => {
      const env = await getEnv();
      const db = signIn(env).firestore();
      await assertSucceeds(
        db.doc('household_data/k1').set({ kinfolkId: 'k1', foodLocation: 'Pantry', updatedAt: '2026-11-20T10:00:00.000Z' }, { merge: true }),
      );
      expect(await recordsFor('k1')).toEqual(['k1']);
    });

    it(`${who} is refused a create under any other id`, async () => {
      const env = await getEnv();
      const db = signIn(env).firestore();
      await assertFails(db.collection('household_data').add({ kinfolkId: 'k1', foodLocation: 'Pantry' }));
      await assertFails(db.doc('household_data/some-other-id').set({ kinfolkId: 'k1', foodLocation: 'Pantry' }));
      expect(await recordsFor('k1')).toEqual([]);
    });
  }

  it('a create that names another household, or none, is refused', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    await assertFails(db.doc('household_data/k1').set({ kinfolkId: 'k2', foodLocation: 'Pantry' }));
    await assertFails(db.doc('household_data/k1').set({ foodLocation: 'Pantry' }));
  });

  /**
   * The issue's own sequence. The household picked a vet first, which made the
   * record at the household id (server side, past the rules). The office then
   * saves from a screen that loaded with no record.
   */
  it('the household picked a vet first: the office save lands in that record and the vet stands', async () => {
    await seed('household_data/k1', { kinfolkId: 'k1', primaryVetClinicId: 'c1', createdAt: '2026-11-20T09:00:00.000Z' });
    const env = await getEnv();
    const db = asOwner(env).firestore();

    // The old app: its own id. Refused, so no second record.
    await assertFails(db.collection('household_data').add({ kinfolkId: 'k1', primaryVetClinicId: '', foodLocation: 'Pantry' }));
    // The app now: the household id, only the fields it filled in, merged.
    await assertSucceeds(
      db.doc('household_data/k1').set({ kinfolkId: 'k1', foodLocation: 'Pantry', updatedAt: '2026-11-20T10:00:00.000Z' }, { merge: true }),
    );

    expect(await recordsFor('k1')).toEqual(['k1']);
    const after = await db.doc('household_data/k1').get();
    expect(after.data()).toMatchObject({ primaryVetClinicId: 'c1', foodLocation: 'Pantry', createdAt: '2026-11-20T09:00:00.000Z' });
  });

  it('a record made before this, under an auto id, is still read and edited', async () => {
    await seed('household_data/auto9', { kinfolkId: 'k1', foodLocation: 'Pantry' });
    const env = await getEnv();
    for (const signIn of [asOwner, asAuntie]) {
      const db = signIn(env).firestore();
      await assertSucceeds(db.doc('household_data/auto9').get());
      await assertSucceeds(db.doc('household_data/auto9').set({ foodLocation: 'Garage shelf' }, { merge: true }));
      await assertSucceeds(db.collection('household_data').where('kinfolkId', '==', 'k1').limit(1).get());
    }
  });

  it('a Kinfolk, and a visitor with no sign-in, can neither read nor create one', async () => {
    await seed('household_data/k1', { kinfolkId: 'k1', primaryVetClinicId: 'c1' });
    const env = await getEnv();
    const kinfolk = asUser(env, 'kinfolk-uid', { role: 'kinfolk', kinfolkId: 'k1' }).firestore();
    await assertFails(kinfolk.doc('household_data/k1').get());
    await assertFails(kinfolk.doc('household_data/k2').set({ kinfolkId: 'k2' }));
    const nobody = asUnauth(env).firestore();
    await assertFails(nobody.doc('household_data/k1').get());
    await assertFails(nobody.doc('household_data/k2').set({ kinfolkId: 'k2' }));
  });
});
