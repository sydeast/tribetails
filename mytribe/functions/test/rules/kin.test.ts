import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser, asUnauth } from './setup';

describe('rules: /families/{fid}/kin/{kinId}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('SECONDARY without kin_edit cannot create kin', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/kin/k-new').set({ name: 'Kai' }),
    );
  });

  it('SECONDARY with kin_edit can create kin', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { kin_edit: true } }],
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/kin/k-new').set({ name: 'Kai' }),
    );
  });

  it('SECONDARY without kin_edit can edit allowlisted care fields', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/kin/k1').set({ name: 'Kai', feedingInstructions: '' });
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/kin/k1').update({
        feedingInstructions: '2 cups AM',
        updatedAt: new Date(),
      }),
    );
  });

  it('SECONDARY without kin_edit cannot edit non-allowlisted fields', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/kin/k1').set({ name: 'Kai' });
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/kin/k1').update({ name: 'Renamed' }),
    );
  });

  it('SECONDARY without kin_edit can edit the descriptive facts shared with the admin (#1310)', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim', secondaries: [{ uid: 'u-sec', perms: {} }] });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/kin/k1').set({ name: 'Kai', sex: '', weight: '' });
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/kin/k1').update({
        sex: 'Male',
        weight: '52 lbs',
        colorMarkings: 'Black',
        spayedNeutered: true,
        vetInfo: 'Riverside Animal Hospital',
        updatedAt: new Date(),
      }),
    );
  });
  it('a kin_edit holder can edit the portal fields', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim', secondaries: [{ uid: 'u-sec', perms: { kin_edit: true } }] });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/kin/k1').set({ name: 'Kai' });
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/kin/k1').update({
        name: 'Kai II',
        breed: 'Lab',
        weight: '60 lbs',
        updatedAt: new Date(),
        updatedByUid: 'u-sec',
      }),
    );
  });
  it('nobody in the household, kin_edit or PRIMARY, can write the staff-only fields the mirror copies onto the doc (#1310)', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim', secondaries: [{ uid: 'u-sec', perms: { kin_edit: true } }] });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/kin/k1').set({ name: 'Kai', officeNotes: 'staff', reactive: false });
    });
    for (const uid of ['u-sec', 'u-prim']) {
      for (const field of [{ officeNotes: 'edited' }, { reactive: true }, { routine: 'x' }, { vaccinations: 'x' }, { tags: ['x'] }]) {
        await assertFails(asUser(env, uid).firestore().doc('families/f1/kin/k1').update(field));
      }
    }
  });

  // #1282: the portals now LIST this subcollection directly (web
  // lib/kinDirectRead.ts, KMP portal/KinDirectRead.kt) instead of waiting on a
  // cold `getMyKin`. These pin who that query works for, and who it refuses,
  // so the client fallback to the callable is only ever the legacy case.
  describe('direct roster read (#1282)', () => {
    async function seedRoster(): Promise<void> {
      const env = await getEnv();
      await seedFamily({
        fid: 'f1',
        primaryUid: 'u-prim',
        secondaries: [
          { uid: 'u-sec', perms: {} },
          { uid: 'u-invited', perms: {}, status: 'INVITED' },
        ],
      });
      await seedFamily({ fid: 'f2', primaryUid: 'u-other' });
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('families/f1/kin/k1').set({ name: 'Kai', status: 'active' });
        await ctx.firestore().doc('families/f1/kin/k2').set({ name: 'Bo', status: 'noLongerWithUs' });
      });
    }
    it('the PRIMARY lists the household roster', async () => {
      const env = await getEnv();
      await seedRoster();
      const snap = await assertSucceeds(asUser(env, 'u-prim').firestore().collection('families/f1/kin').get());
      expect(snap.docs.map((d) => d.id).sort()).toEqual(['k1', 'k2']);
    });
    it('a SECONDARY with no permissions at all still lists it', async () => {
      const env = await getEnv();
      await seedRoster();
      await assertSucceeds(asUser(env, 'u-sec').firestore().collection('families/f1/kin').get());
    });
    it('an operator (admin claim) stepping into the household lists it', async () => {
      const env = await getEnv();
      await seedRoster();
      await assertSucceeds(asUser(env, 'u-op', { admin: true }).firestore().collection('families/f1/kin').get());
    });
    it('an INVITED member who has not accepted is refused', async () => {
      const env = await getEnv();
      await seedRoster();
      await assertFails(asUser(env, 'u-invited').firestore().collection('families/f1/kin').get());
    });
    it('a member of another household is refused', async () => {
      const env = await getEnv();
      await seedRoster();
      await assertFails(asUser(env, 'u-other').firestore().collection('families/f1/kin').get());
    });
    it('a signed-in account with no member doc is refused (the callable fallback case)', async () => {
      const env = await getEnv();
      await seedRoster();
      await assertFails(
        asUser(env, 'u-legacy', { role: 'kinfolk', kinfolkId: 'f1' }).firestore().collection('families/f1/kin').get(),
      );
    });
    it('a signed-out caller is refused', async () => {
      const env = await getEnv();
      await seedRoster();
      await assertFails(asUnauth(env).firestore().collection('families/f1/kin').get());
    });
  });
});
/**
 * #1335 / #1344: staff-only pet fields (officeNotes, reactive, routine...) must
 * be unreadable by a household everywhere. A rule gates a document, never a
 * field, so the two halves are proved differently:
 *
 *   - the flat `kin/{docId}` doc carries them, so a household cannot read that
 *     document at all (these tests);
 *   - the family `families/{fid}/kin/{kinId}` doc stays household-readable (the
 *     portal reads it), so it must never carry them. That half is proved by the
 *     mirror unit tests (test/onFlatKinWrite.test.ts) and the backfill emulator
 *     test (scripts/test/stripFamilyKinStaffFields.emulator.test.ts).
 */
describe('rules: staff-only pet fields are unreadable by the household (#1335, #1344)', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  const STAFF_FLAT_KIN = {
    kinfolkId: 'f1',
    familyKinPath: 'families/f1/kin/k1',
    name: 'Kai',
    officeNotes: 'bit the last sitter',
    reactive: true,
    routine: 'morning walk',
    vaccinations: 'Rabies 2027',
    tags: ['Reactive'],
  };
  const KINFOLK = { role: 'kinfolk', kinfolkId: 'f1' };
  async function seedFlatAndFamily(): Promise<void> {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim', secondaries: [{ uid: 'u-sec', perms: { kin_edit: true } }] });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('kin/flat1').set(STAFF_FLAT_KIN);
      await ctx.firestore().doc('families/f1/kin/k1').set({ name: 'Kai', sex: 'Male', legacyKinId: 'flat1' });
    });
  }
  it('the household PRIMARY and SECONDARY, holding the kinfolk claim, cannot read the flat doc', async () => {
    const env = await getEnv();
    await seedFlatAndFamily();
    for (const uid of ['u-prim', 'u-sec']) {
      await assertFails(asUser(env, uid, KINFOLK).firestore().doc('kin/flat1').get());
      await assertFails(
        asUser(env, uid, KINFOLK).firestore().collection('kin').where('kinfolkId', '==', 'f1').get(),
      );
    }
  });
  it('a household member without the claim cannot read the flat doc either', async () => {
    const env = await getEnv();
    await seedFlatAndFamily();
    await assertFails(asUser(env, 'u-sec').firestore().doc('kin/flat1').get());
  });
  it('staff still read the flat doc: the owner and an Auntie', async () => {
    const env = await getEnv();
    await seedFlatAndFamily();
    await assertSucceeds(asUser(env, 'staff-1', { admin: true }).firestore().doc('kin/flat1').get());
    await assertSucceeds(
      asUser(env, 'auntie-1', { staffRole: 'auntie' }).firestore().doc('kin/flat1').get(),
    );
    await assertSucceeds(
      asUser(env, 'staff-1', { admin: true }).firestore().collection('kin').where('kinfolkId', '==', 'f1').get(),
    );
  });
  it('the household still reads its family kin doc, which the portal depends on', async () => {
    const env = await getEnv();
    await seedFlatAndFamily();
    await assertSucceeds(asUser(env, 'u-sec', KINFOLK).firestore().doc('families/f1/kin/k1').get());
    await assertSucceeds(asUser(env, 'staff-1', { admin: true }).firestore().doc('families/f1/kin/k1').get());
  });
});
