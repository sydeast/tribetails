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
});
