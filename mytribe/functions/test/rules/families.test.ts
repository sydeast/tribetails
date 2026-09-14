import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser, asUnauth } from './setup';

describe('rules: /families/{fid}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('member reads own family', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertSucceeds(asUser(env, 'u-prim').firestore().doc('families/f1').get());
  });

  it('non-member denied read', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertFails(asUser(env, 'u-stranger').firestore().doc('families/f1').get());
  });

  it('unauth denied read', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertFails(asUnauth(env).firestore().doc('families/f1').get());
  });

  it('PRIMARY can update displayName only', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertSucceeds(
      asUser(env, 'u-prim').firestore().doc('families/f1').update({ displayName: 'X', updatedAt: new Date() }),
    );
  });

  it('PRIMARY cannot mutate flags via client', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1').update({ 'flags.tribePinSet': true, updatedAt: new Date() }),
    );
  });

  it('SECONDARY cannot update displayName', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1').update({ displayName: 'X', updatedAt: new Date() }),
    );
  });

  it('SUSPENDED member denied read', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {}, status: 'SUSPENDED' }],
    });
    await assertFails(asUser(env, 'u-sec').firestore().doc('families/f1').get());
  });

  it('client cannot create family doc', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-x').firestore().doc('families/new').set({ displayName: 'X' }),
    );
  });

  // ── isOperator() removed from these two read gates (2026-07-23) ───────────
  // The helper did an exists() on a retired `operators` collection that nothing
  // reads, writes or seeds, and it sat between activeMember() and isAuntie() -
  // three billed document reads before an admin's request could be admitted.
  // Both remaining branches are pinned here so the removal cannot have quietly
  // taken the operator path with it.

  it('the operator can still read a family and its member docs', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    const fs = env.authenticatedContext('staff-1', { admin: true }).firestore();
    await assertSucceeds(fs.doc('families/f1').get());
    await assertSucceeds(fs.doc('families/f1/members/u-prim').get());
  });

  it('an active member can still read the family and its member docs', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1', primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    const fs = asUser(env, 'u-sec').firestore();
    await assertSucceeds(fs.doc('families/f1').get());
    await assertSucceeds(fs.doc('families/f1/members/u-prim').get());
  });

  it('a signed-in non-member is still denied both, with no operators back door', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      // Even holding an `operators/{uid}` doc grants nothing now.
      await ctx.firestore().doc('operators/u-stranger').set({ email: 's@x.com' });
    });
    const fs = asUser(env, 'u-stranger').firestore();
    await assertFails(fs.doc('families/f1').get());
    await assertFails(fs.doc('families/f1/members/u-prim').get());
  });

  // #829: families/{fid}/legacyEcServed/{uid} records which Emergency Contact
  // getMyTribeProfile served each caller, so saveTribeProfile can tell an old
  // client's echo from an edit. Written and read only by the Admin SDK. It has
  // no match block, so every client is denied, including the member it is about
  // and staff through the SDK; a member who can read families/{fid} still cannot
  // reach it.
  it('the served-contact record is closed to every client, the member it is about included', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim', secondaries: [{ uid: 'u-sec', perms: {} }] });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/legacyEcServed/u-prim').set({ served: [{ key: 'abc', at: new Date() }] });
    });
    const clients = [
      asUser(env, 'u-prim').firestore(),
      asUser(env, 'u-sec').firestore(),
      env.authenticatedContext('staff-1', { admin: true }).firestore(),
    ];
    for (const fs of clients) {
      await assertFails(fs.doc('families/f1/legacyEcServed/u-prim').get());
      await assertFails(fs.collection('families/f1/legacyEcServed').get());
      await assertFails(fs.doc('families/f1/legacyEcServed/u-prim').set({ served: [] }));
      await assertFails(fs.doc('families/f1/legacyEcServed/u-sec').set({ served: [{ key: 'forged', at: new Date() }] }));
    }
  });
});
