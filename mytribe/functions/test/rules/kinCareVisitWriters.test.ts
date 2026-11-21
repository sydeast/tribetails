import { afterAll, afterEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

/**
 * Each app writes only the fields it owns on the household's copy of a visit,
 * `families/{fid}/bookings/{batchId}/kinCares/{visitId}`, and no client writes
 * a field the Cloud Functions own.
 *
 * The client writes below are the real ones (see the rule's own comment for
 * where each is read from). Every refusal is paired, in the same test, with a
 * success on the identical payload minus the refused key, so a refusal here
 * can only pass because of that key.
 */

type Env = Awaited<ReturnType<typeof getEnv>>;

const VISIT = 'families/f1/bookings/b1/kinCares/v1';

/** Written by the Cloud Functions only. */
const SERVER_ONLY: Record<string, unknown> = {
  officeNoticeStamp: 'client-made',
  kinAddedStamp: 'client-made',
  seriesApprovedAt: new Date('2026-11-21T10:00:00Z'),
  requestDeclinedAt: new Date('2026-11-21T10:00:00Z'),
};

const asOwner = (env: Env) => env.authenticatedContext('owner-1', { admin: true });
const asAuntie = (env: Env) => env.authenticatedContext('auntie-1', { staffRole: 'auntie' });

/** admin Android `writeBackKinCareApproval`: the six fields, `updatedAt` as an ISO string. */
function androidWriteBack(): Record<string, unknown> {
  return {
    status: 'confirmed',
    auntieDisplayName: 'Auntie Rae',
    auntieAvatarUrl: '',
    sourceBookingId: 'eb-1',
    sessionId: 'sess-1',
    updatedAt: new Date().toISOString(),
  };
}

function householdEdit(): Record<string, unknown> {
  return { notes: 'Side gate is open', updatedAt: new Date() };
}

async function seedVisit(extra: Record<string, unknown> = {}): Promise<void> {
  const env = await getEnv();
  await seedFamily({
    fid: 'f1',
    primaryUid: 'u-prim',
    secondaries: [
      { uid: 'u-sk-bill', perms: { billing_full: true } },
      { uid: 'u-sk', perms: {} },
    ],
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(VISIT).set({
      familyId: 'f1',
      targetType: 'KIN',
      status: 'requested',
      title: 'Walk',
      notes: '',
      kinIds: ['biscuit'],
      kinNames: ['Biscuit'],
      priceCents: 4000,
      ...extra,
    });
  });
}

type Writer = {
  name: string;
  db: (env: Env) => ReturnType<ReturnType<typeof asOwner>['firestore']>;
  realWrite: () => Record<string, unknown>;
};

const WRITERS: Writer[] = [
  { name: 'the owner', db: (env) => asOwner(env).firestore(), realWrite: androidWriteBack },
  { name: 'an Auntie', db: (env) => asAuntie(env).firestore(), realWrite: androidWriteBack },
  { name: 'the PRIMARY', db: (env) => asUser(env, 'u-prim').firestore(), realWrite: householdEdit },
  { name: 'a SECONDARY with billing access', db: (env) => asUser(env, 'u-sk-bill').firestore(), realWrite: householdEdit },
  { name: 'a SECONDARY without billing access', db: (env) => asUser(env, 'u-sk').firestore(), realWrite: householdEdit },
];

describe('rules: each app writes only the fields it owns on a KinCare visit', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  for (const w of WRITERS) {
    describe(w.name, () => {
      it('makes its real write', async () => {
        const env = await getEnv();
        await seedVisit();
        await assertSucceeds(w.db(env).doc(VISIT).update(w.realWrite()));
      });

      for (const [key, value] of Object.entries(SERVER_ONLY)) {
        it(`cannot write ${key} beside its real write`, async () => {
          const env = await getEnv();
          await seedVisit();
          const db = w.db(env);
          await assertFails(db.doc(VISIT).update({ ...w.realWrite(), [key]: value }));
          await assertFails(db.doc(VISIT).set({ [key]: value }, { merge: true }));
          await assertSucceeds(db.doc(VISIT).update(w.realWrite()));
        });

        it(`cannot move ${key} once the server has written it`, async () => {
          const env = await getEnv();
          await seedVisit({ [key]: value });
          const db = w.db(env);
          const moved = typeof value === 'string' ? 'client-moved' : new Date('2026-11-22T10:00:00Z');
          await assertFails(db.doc(VISIT).update({ ...w.realWrite(), [key]: moved }));
          // The real write alone leaves the server's value as it is, and lands.
          await assertSucceeds(db.doc(VISIT).update(w.realWrite()));
        });
      }

      it('cannot write a field that is not on its list', async () => {
        const env = await getEnv();
        await seedVisit();
        const db = w.db(env);
        await assertFails(db.doc(VISIT).update({ ...w.realWrite(), kinIds: ['biscuit', 'mochi'] }));
        await assertFails(db.doc(VISIT).update({ ...w.realWrite(), assignedAuntieUid: 'auntie-2' }));
        await assertSucceeds(db.doc(VISIT).update(w.realWrite()));
      });
    });
  }

  it('the owner and an Auntie can still write visitProgress, as older installed builds may', async () => {
    const env = await getEnv();
    await seedVisit();
    await assertSucceeds(asOwner(env).firestore().doc(VISIT).update({ status: 'active', visitProgress: 'active' }));
    await assertSucceeds(asAuntie(env).firestore().doc(VISIT).update({ status: 'active', visitProgress: 'ended' }));
  });

  it('an Auntie still cannot move the price, and the owner no longer can either', async () => {
    const env = await getEnv();
    await seedVisit();
    await assertFails(asAuntie(env).firestore().doc(VISIT).update({ ...androidWriteBack(), priceCents: 1 }));
    await assertFails(asOwner(env).firestore().doc(VISIT).update({ ...androidWriteBack(), priceCents: 1 }));
    await assertSucceeds(asOwner(env).firestore().doc(VISIT).update(androidWriteBack()));
  });

  it('a member with billing access keeps the invoice keys, and a member without it does not', async () => {
    const env = await getEnv();
    await seedVisit({ amountMinor: 0 });
    await assertFails(asUser(env, 'u-sk').firestore().doc(VISIT).update({ amountMinor: 100 }));
    await assertSucceeds(asUser(env, 'u-sk-bill').firestore().doc(VISIT).update({ amountMinor: 100 }));
    await assertSucceeds(asUser(env, 'u-prim').firestore().doc(VISIT).update({ amountMinor: 200 }));
  });

  it('household members keep status, notes, title and window', async () => {
    const env = await getEnv();
    await seedVisit();
    for (const uid of ['u-prim', 'u-sk-bill', 'u-sk']) {
      await assertSucceeds(
        asUser(env, uid).firestore().doc(VISIT).update({
          status: 'requested',
          notes: `from ${uid}`,
          title: 'Evening walk',
          window: '17:00-18:00',
          updatedAt: new Date(),
        }),
      );
    }
  });

  it('a household member cannot write the staff write-back fields', async () => {
    const env = await getEnv();
    await seedVisit();
    for (const uid of ['u-prim', 'u-sk-bill', 'u-sk']) {
      const db = asUser(env, uid).firestore();
      await assertFails(db.doc(VISIT).update({ sessionId: 'sess-9', updatedAt: new Date() }));
      await assertFails(db.doc(VISIT).update({ auntieDisplayName: 'Auntie Bee', updatedAt: new Date() }));
      await assertSucceeds(db.doc(VISIT).update({ updatedAt: new Date() }));
    }
  });

  it('a signed-in stranger writes nothing', async () => {
    const env = await getEnv();
    await seedVisit();
    await assertFails(asUser(env, 'u-stranger').firestore().doc(VISIT).update(householdEdit()));
    await assertFails(asUser(env, 'u-stranger').firestore().doc(VISIT).update(androidWriteBack()));
  });
});

describe('rules: no client creates a KinCare visit carrying a server-only field', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  const base = { familyId: 'f1', targetType: 'KIN', title: 'Walk', status: 'requested' };

  for (const [key, value] of Object.entries(SERVER_ONLY)) {
    it(`refuses a create carrying ${key}`, async () => {
      const env = await getEnv();
      await seedFamily({
        fid: 'f1',
        primaryUid: 'u-prim',
        secondaries: [{ uid: 'u-sk', perms: {} }],
      });
      for (const uid of ['u-prim', 'u-sk']) {
        const db = asUser(env, uid).firestore();
        await assertFails(db.doc(`families/f1/bookings/b1/kinCares/${uid}`).set({ ...base, [key]: value }));
        await assertSucceeds(db.doc(`families/f1/bookings/b1/kinCares/${uid}`).set(base));
      }
    });
  }
});
