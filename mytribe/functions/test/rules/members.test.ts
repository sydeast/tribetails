import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

describe('rules: /families/{fid}/members/{uid}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('PRIMARY edits secondaryLabel + non-billing perms', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertSucceeds(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        secondaryLabel: 'Co-Parent',
        'permissions.kin_edit': true,
        updatedAt: new Date(),
      }),
    );
  });

  it('PRIMARY cannot grant billing_full directly via rule', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        'permissions.billing_full': true,
        updatedAt: new Date(),
      }),
    );
  });

  it('PRIMARY cannot change role to PRIMARY', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        role: 'PRIMARY',
        updatedAt: new Date(),
      }),
    );
  });

  it('SECONDARY cannot edit own permissions', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/members/u-sec').update({
        'permissions.kin_edit': true,
        updatedAt: new Date(),
      }),
    );
  });

  it('client cannot create member doc directly', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-new').set({
        uid: 'u-new', role: 'SECONDARY', status: 'ACTIVE', permissions: {}, updatedAt: new Date(),
      }),
    );
  });
});
