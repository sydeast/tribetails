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

  // --- WRITE gating: callable-only as of 2026-07-23 ---
  //
  // Lockbox codes, key location and Wi-Fi password. saveHomeAccess.ts is the
  // only writer: it re-checks membership and the home_access perm, validates
  // with zod, stamps updatedByUid and logs portal.homeAccess.saved, all through
  // the Admin SDK (which bypasses these rules). The direct client path bought
  // nothing and skipped every one of those steps, so it is closed to everyone -
  // permission holder, PRIMARY and operator alike. Reads are untouched above.

  it('SECONDARY with home_access=true CANNOT write homeAccess directly (callable-only)', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { home_access: true } }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/homeAccess/active').set({ wifiSsid: 'Z' }),
    );
  });

  it('PRIMARY CANNOT write homeAccess directly either', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/homeAccess/current').set({ gateCode: '9999' }),
    );
  });

  it('a home_access holder cannot update or delete an existing homeAccess doc', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-ha', perms: { home_access: true } }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/homeAccess/current').set({ gateCode: '1234' });
    });
    const fs = asUser(env, 'u-ha').firestore();
    await assertFails(fs.doc('families/f1/homeAccess/current').update({ gateCode: '4321' }));
    await assertFails(fs.doc('families/f1/homeAccess/current').delete());
  });

  it('the operator cannot write homeAccess from a client either', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertFails(
      env.authenticatedContext('staff-1', { admin: true }).firestore()
        .doc('families/f1/homeAccess/current').set({ gateCode: '0000' }),
    );
  });

  it('the operator can still READ homeAccess (write closure did not touch reads)', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/homeAccess/current').set({ gateCode: '1234' });
    });
    await assertSucceeds(
      env.authenticatedContext('staff-1', { admin: true }).firestore()
        .doc('families/f1/homeAccess/current').get(),
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
