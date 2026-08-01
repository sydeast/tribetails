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

  /**
   * RULING: "Primary kinfolk is allowed to set the permissions of the secondary,
   * including billing if they want. having household access is another main
   * reason to have a secondary (THE OTHER PET PARENT). besides admin, primary
   * kinfolk can set permissions for the secondary."
   *
   * This file previously asserted the opposite for billing_full, and the rule
   * pinned home_access too, which also contradicted `updateSecondaryPermissions`:
   * the same grant succeeded through a Function and failed through the SDK.
   */
  it('PRIMARY CAN grant billing_full directly (ruling: billing is theirs to give)', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertSucceeds(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        'permissions.billing_full': true,
        updatedAt: new Date(),
      }),
    );
  });

  it('PRIMARY CAN revoke billing_full again', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { billing_full: true } }],
    });
    await assertSucceeds(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        'permissions.billing_full': false,
        updatedAt: new Date(),
      }),
    );
  });

  it('PRIMARY CAN grant home_access, matching updateSecondaryPermissions', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertSucceeds(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        'permissions.home_access': true,
        updatedAt: new Date(),
      }),
    );
  });

  it('PRIMARY can move billing_full and home_access in one write', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertSucceeds(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        'permissions.billing_full': true,
        'permissions.home_access': true,
        'permissions.messaging_direct': true,
        secondaryLabel: 'The Other Pet Parent',
        updatedAt: new Date(),
      }),
    );
  });

  /**
   * kintales_only is a PRODUCT INVARIANT, not an authority boundary. Every mint
   * path force-sets it true, `setMemberPermissions` omits it from its schema, and
   * both admin clients render it locked. Nobody turns it off, primary included.
   */
  it('PRIMARY still cannot turn kintales_only off', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        'permissions.kintales_only': false,
        updatedAt: new Date(),
      }),
    );
  });

  it('PRIMARY cannot smuggle kintales_only off alongside a permitted grant', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        'permissions.billing_full': true,
        'permissions.kintales_only': false,
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

  /**
   * THE BOUNDARY THAT SURVIVES THE RELAXATION.
   *
   * Widening which permission FLAGS a primary may move must not widen who they
   * may become. `role` and `status` are outside the affectedKeys allowlist, there
   * is no `admin` member permission to grant, and admin authority is the `admin`
   * custom claim, which lives outside Firestore entirely.
   */
  it('BOUNDARY: PRIMARY cannot promote a SECONDARY even while granting billing', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        'permissions.billing_full': true,
        role: 'PRIMARY',
        updatedAt: new Date(),
      }),
    );
  });

  it('BOUNDARY: PRIMARY cannot write an admin permission onto a SECONDARY', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    // There is no `admin` key in MemberPermissions. Even if a client invents one,
    // the pinned-invariant clause reads permissions.kintales_only off a map the
    // write replaces wholesale, and role/status stay unwritable, so this buys
    // nothing. Asserted so a future permission added to the map is thought about.
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        permissions: { admin: true },
        updatedAt: new Date(),
      }),
    );
  });

  it('BOUNDARY: PRIMARY cannot change a member status (no reinstating a suspension)', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {}, status: 'SUSPENDED' }],
    });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f1/members/u-sec').update({
        status: 'ACTIVE',
        updatedAt: new Date(),
      }),
    );
  });

  it('BOUNDARY: a SECONDARY holding billing_full still cannot edit permissions', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { billing_full: true, home_access: true } }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/members/u-sec').update({
        'permissions.kin_edit': true,
        updatedAt: new Date(),
      }),
    );
  });

  it('BOUNDARY: a PRIMARY of one family cannot touch another family', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim', secondaries: [{ uid: 'u-sec', perms: {} }] });
    await seedFamily({ fid: 'f2', primaryUid: 'other-prim', secondaries: [{ uid: 'u-other', perms: {} }] });
    await assertFails(
      asUser(env, 'u-prim').firestore().doc('families/f2/members/u-other').update({
        'permissions.billing_full': true,
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
