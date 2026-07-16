import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

describe('rules: /families/{fid}/homeAccess', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // --- READ gating (home_access perm required) ---

  it('PRIMARY can read homeAccess', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/homeAccess/current').set({ gateCode: '1234' });
    });
    await assertSucceeds(
      asUser(env, 'u-prim').firestore().doc('families/f1/homeAccess/current').get(),
    );
  });

  it('SECONDARY with home_access=true can read homeAccess', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-ha', perms: { home_access: true } }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/homeAccess/current').set({ gateCode: '1234' });
    });
    await assertSucceeds(
      asUser(env, 'u-ha').firestore().doc('families/f1/homeAccess/current').get(),
    );
  });

  it('SECONDARY with kintales_only (home_access=false) CANNOT read homeAccess', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-ko', perms: { kintales_only: true, home_access: false } }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/homeAccess/current').set({ gateCode: '1234' });
    });
    await assertFails(
      asUser(env, 'u-ko').firestore().doc('families/f1/homeAccess/current').get(),
    );
  });

  it('SECONDARY with kin_edit=true but home_access=false CANNOT read homeAccess', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-ke', perms: { kin_edit: true, home_access: false } }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/homeAccess/current').set({ gateCode: '1234' });
    });
    await assertFails(
      asUser(env, 'u-ke').firestore().doc('families/f1/homeAccess/current').get(),
    );
  });

  it('unauthenticated user CANNOT read homeAccess', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/homeAccess/current').set({ gateCode: '1234' });
    });
    const { asUnauth } = await import('./setup');
    await assertFails(
      asUnauth(env).firestore().doc('families/f1/homeAccess/current').get(),
    );
  });

  // --- WRITE gating (unchanged, already correct) ---

  it('SECONDARY with home_access=true can write homeAccess', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { home_access: true } }],
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/homeAccess/active').set({ wifiSsid: 'Z' }),
    );
  });

  it('SECONDARY with kin_edit=true but home_access=false cannot write homeAccess', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { kin_edit: true, home_access: false } }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/homeAccess/active').set({ wifiSsid: 'Y' }),
    );
  });

  it('SECONDARY without home_access cannot write homeAccess', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/homeAccess/active').set({ wifiSsid: 'Y' }),
    );
  });
});
