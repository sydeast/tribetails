import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';
/**
 * #1583. Age and weight on a Kin are numbers. The flat `kin/{id}` doc (written
 * by staff straight from the admin web and Android) and the household's
 * `families/{fid}/kin/{kinId}` doc both refuse non-numeric values, and neither
 * refuses a value the write does not change, so a record that already holds old
 * free text stays editable.
 */
describe('rules: kin age and weight are numbers (#1583)', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  async function staffDb() {
    const env = await getEnv();
    return { env, db: env.authenticatedContext('staff-1', { admin: true }).firestore() };
  }

  describe('flat kin/{id} (staff)', () => {
    it('creates with a numeric age and a weight with a unit, or with neither', async () => {
      const { db } = await staffDb();
      await assertSucceeds(db.doc('kin/a').set({ name: 'Pup', kinfolkId: 'k1', age: '5', weight: '45 lb' }));
      await assertSucceeds(db.doc('kin/b').set({ name: 'Pup', kinfolkId: 'k1', age: '0.5', weight: '12.5kg' }));
      await assertSucceeds(db.doc('kin/c').set({ name: 'Pup', kinfolkId: 'k1' }));
      await assertSucceeds(db.doc('kin/d').set({ name: 'Pup', kinfolkId: 'k1', age: '', weight: '' }));
    });

    it('refuses text in age or weight on create', async () => {
      const { db } = await staffDb();
      await assertFails(db.doc('kin/a').set({ name: 'Pup', kinfolkId: 'k1', age: 'abc-5' }));
      await assertFails(db.doc('kin/b').set({ name: 'Pup', kinfolkId: 'k1', age: '5 yrs' }));
      await assertFails(db.doc('kin/c').set({ name: 'Pup', kinfolkId: 'k1', age: '101' }));
      await assertFails(db.doc('kin/d').set({ name: 'Pup', kinfolkId: 'k1', weight: 'heavy-ish' }));
      await assertFails(db.doc('kin/e').set({ name: 'Pup', kinfolkId: 'k1', weight: '0 lb' }));
      await assertFails(db.doc('kin/f').set({ name: 'Pup', kinfolkId: 'k1', weight: '45 stone' }));
    });

    it('refuses text on update, and accepts a correction', async () => {
      const { env, db } = await staffDb();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('kin/a').set({ name: 'Pup', kinfolkId: 'k1', age: '5', weight: '40' });
      });
      await assertFails(db.doc('kin/a').update({ age: 'abc-5' }));
      await assertFails(db.doc('kin/a').update({ weight: 'heavy-ish' }));
      await assertSucceeds(db.doc('kin/a').update({ age: '6', weight: '41.5 lbs' }));
    });

    it('lets a record that already holds old free text be saved without touching it', async () => {
      const { env, db } = await staffDb();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('kin/legacy').set({ name: 'Pup', kinfolkId: 'k1', age: 'abc-5', weight: 'heavy-ish' });
      });
      // An unrelated edit, and a write that re-sends the same legacy values.
      await assertSucceeds(db.doc('kin/legacy').update({ colorMarkings: 'Brindle' }));
      await assertSucceeds(db.doc('kin/legacy').update({ age: 'abc-5', weight: 'heavy-ish', name: 'Pup 2' }));
      // Changing it to more text is refused; correcting it is accepted.
      await assertFails(db.doc('kin/legacy').update({ age: 'abc-6' }));
      await assertSucceeds(db.doc('kin/legacy').update({ age: '5', weight: '40 lb' }));
    });

    it('does not widen who may write: a signed-in non-staff user is still refused', async () => {
      const env = await getEnv();
      await assertFails(asUser(env, 'u-x').firestore().doc('kin/a').set({ name: 'Pup', kinfolkId: 'k1', age: '5' }));
    });
  });

  describe('families/{fid}/kin/{kinId} (household)', () => {
    async function household() {
      const env = await getEnv();
      await seedFamily({ fid: 'f1', primaryUid: 'u-prim', secondaries: [] });
      return { env, db: asUser(env, 'u-prim').firestore() };
    }

    it('accepts a numeric ageYears and a weight with a unit', async () => {
      const { db } = await household();
      await assertSucceeds(db.doc('families/f1/kin/a').set({ name: 'Kai', ageYears: 5, weight: '40 lb' }));
    });

    it('refuses a negative or huge ageYears and a non-numeric weight', async () => {
      const { db } = await household();
      await assertFails(db.doc('families/f1/kin/a').set({ name: 'Kai', ageYears: -1 }));
      await assertFails(db.doc('families/f1/kin/b').set({ name: 'Kai', ageYears: 400 }));
      await assertFails(db.doc('families/f1/kin/c').set({ name: 'Kai', weight: 'heavy-ish' }));
    });

    it('refuses editing weight to text but lets an unchanged legacy weight ride along', async () => {
      const { env, db } = await household();
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('families/f1/kin/k1').set({ name: 'Kai', weight: 'heavy-ish' });
      });
      await assertFails(db.doc('families/f1/kin/k1').update({ weight: 'very heavy' }));
      await assertSucceeds(db.doc('families/f1/kin/k1').update({ weight: 'heavy-ish', feedingInstructions: '2 cups' }));
      await assertSucceeds(db.doc('families/f1/kin/k1').update({ weight: '40 lb' }));
      expect(true).toBe(true);
    });
  });
});
