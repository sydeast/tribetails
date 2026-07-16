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
});
