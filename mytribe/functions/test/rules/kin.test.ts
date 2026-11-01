import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

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
});
