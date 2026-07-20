import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

describe('rules: /families/{fid}/bookings/{batchId}/kinCares/{visitId}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('SECONDARY without billing_full cannot set invoice fields on a kinCare', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b1/kinCares/v1').set({
        familyId: 'f1', targetType: 'KIN',
        amountMinor: 12000, currency: 'USD',
      }),
    );
  });

  it('SECONDARY without billing_full can create a non-billing kinCare', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b1/kinCares/v1').set({
        familyId: 'f1', targetType: 'KIN',
        title: 'Walk', status: 'requested',
      }),
    );
  });

  it('SECONDARY with billing_full can update invoice keys on a kinCare', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: { billing_full: true } }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/bookings/b1/kinCares/v1').set({
        familyId: 'f1', targetType: 'KIN', amountMinor: 0,
      });
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b1/kinCares/v1').update({ amountMinor: 100 }),
    );
  });

  it('kinfolk can diffOnly(status,notes,title,window,updatedAt) on a kinCare', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/bookings/b1/kinCares/v1').set({
        familyId: 'f1', targetType: 'KIN',
        title: 'Walk', status: 'requested',
        auntieDisplayName: null,
      });
    });
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b1/kinCares/v1').update({
        status: 'cancelled',
        notes: 'please skip',
        title: 'Evening walk',
        window: '17:00-18:00',
        updatedAt: new Date(),
      }),
    );
  });

  it('kinfolk cannot change auntieDisplayName on a kinCare', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/bookings/b1/kinCares/v1').set({
        familyId: 'f1', targetType: 'KIN',
        title: 'Walk', status: 'requested',
        auntieDisplayName: null,
      });
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b1/kinCares/v1').update({
        auntieDisplayName: 'Auntie Bee',
        updatedAt: new Date(),
      }),
    );
  });

  it('isAuntie() can write back status, auntieDisplayName and sourceBookingId on a kinCare', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/bookings/b1/kinCares/v1').set({
        familyId: 'f1', targetType: 'KIN',
        title: 'Walk', status: 'requested',
        auntieDisplayName: null, sourceBookingId: null,
      });
    });
    const auntie = env.authenticatedContext('staff-1', { admin: true });
    await assertSucceeds(
      auntie.firestore().doc('families/f1/bookings/b1/kinCares/v1').update({
        status: 'active',
        visitProgress: 'active',
        auntieDisplayName: 'Auntie Bee',
        sourceBookingId: 'aos-booking-9',
        sessionId: 'sess-9',
        updatedAt: new Date(),
      }),
    );
  });

  // 2026-06-08 prod regression: the AuntieOS Booking screen runs
  // collectionGroup('kinCares').where('status','==','REQUESTED') to list new
  // requests across every family. The depth-specific kinCare rule alone does
  // NOT authorize a collection-group query, so Firestore denied it with
  // "Missing or insufficient permissions". The recursive-wildcard read rule
  // `match /{path=**}/kinCares/{visitId} { allow read: if isAuntie(); }` fixes it.
  it('isAuntie() can run a collectionGroup(kinCares) query', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/bookings/b1/kinCares/v1').set({
        familyId: 'f1', targetType: 'KIN', title: 'Walk', status: 'REQUESTED',
      });
    });
    const auntie = env.authenticatedContext('staff-1', { admin: true });
    await assertSucceeds(
      auntie.firestore().collectionGroup('kinCares').where('status', '==', 'REQUESTED').get(),
    );
  });

  it('a non-admin signed-in user cannot run the collectionGroup(kinCares) query', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('families/f1/bookings/b1/kinCares/v1').set({
        familyId: 'f1', targetType: 'KIN', title: 'Walk', status: 'REQUESTED',
      });
    });
    // u-prim is a member of f1 but the cross-family collection-group query is
    // not authorized for them (no isAuntie); the recursive rule grants admins only.
    await assertFails(
      asUser(env, 'u-prim').firestore()
        .collectionGroup('kinCares').where('status', '==', 'REQUESTED').get(),
    );
  });

  it('envelope create requires familyId==fid and a valid targetType', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    // Wrong familyId fails.
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b1').set({
        familyId: 'f2', targetType: 'KIN', requestBatchId: 'b1',
      }),
    );
    // Bad targetType fails.
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b2').set({
        familyId: 'f1', targetType: 'NOPE', requestBatchId: 'b2',
      }),
    );
    // Correct envelope succeeds.
    await assertSucceeds(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b3').set({
        familyId: 'f1', targetType: 'KINFOLK', requestBatchId: 'b3',
        envelopeStatus: 'requested',
      }),
    );
  });

  it('kinfolk cannot directly write notes or internalNotes on a kinCare', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sec', perms: {} }],
    });
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b1/kinCares/v1/notes/n1').set({
        text: 'hi', authorRole: 'kinfolk',
      }),
    );
    await assertFails(
      asUser(env, 'u-sec').firestore().doc('families/f1/bookings/b1/kinCares/v1/internalNotes/n1').set({
        text: 'internal',
      }),
    );
  });

  it('auntie cannot directly write notes or internalNotes on a kinCare', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    const auntie = env.authenticatedContext('staff-1', { admin: true });
    const db = auntie.firestore();
    await assertFails(
      db.doc('families/f1/bookings/b1/kinCares/v1/notes/n1').set({
        text: 'hi', authorRole: 'auntie',
      }),
    );
    await assertFails(
      db.doc('families/f1/bookings/b1/kinCares/v1/internalNotes/n1').set({
        text: 'internal',
      }),
    );
  });
});
