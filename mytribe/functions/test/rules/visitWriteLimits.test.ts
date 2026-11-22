import { afterAll, afterEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

/**
 * Who may change what on a visit and a booking.
 *
 * #2546 An Auntie's visit steps leave the visit's household and booking links
 *       as they were.
 * #2547 A household's booking or visit starts as Requested, and only the
 *       office moves it on.
 * #2548 No household member deletes a visit or a booking.
 *
 * Every refusal is paired with the same payload minus the refused change, which
 * lands, so a refusal here can only pass because of that change.
 */

type Env = Awaited<ReturnType<typeof getEnv>>;

const SESSION = 'kin_care_sessions/s1';
const ENVELOPE = 'families/f1/bookings/b1';
const VISIT = 'families/f1/bookings/b1/kinCares/v1';

const asOwner = (env: Env) => env.authenticatedContext('owner-1', { admin: true });
const asAuntie = (env: Env) => env.authenticatedContext('auntie-1', { staffRole: 'auntie' });

const LINKS: Record<string, string> = {
  kinfolkId: 'f1',
  sourceBookingId: 'eb-1',
  kinCareBatchId: 'b1',
  kinCareVisitId: 'v1',
};

const AT = '2026-11-21T10:00:00.000Z';

/** The real writes an Auntie's clients make on a visit, each from the status it starts at. */
const VISIT_STEPS: { name: string; from: string; write: Record<string, unknown> }[] = [
  {
    name: 'On my way',
    from: 'SCHEDULED',
    write: { status: 'ON_MY_WAY', onMyWayAt: AT, etaMinutesAway: 10, updatedAt: AT },
  },
  {
    name: 'Arrived',
    from: 'ON_MY_WAY',
    write: { status: 'ARRIVED', arrivedAt: AT, visitRouteId: 'route-1', updatedAt: AT },
  },
  {
    name: 'Departed',
    from: 'ARRIVED',
    write: { status: 'DEPARTED', departedAt: AT, updatedAt: AT },
  },
  {
    name: 'Undo arrival',
    from: 'ARRIVED',
    write: {
      status: 'ON_MY_WAY',
      arrivedAt: '',
      departedAt: '',
      arrivalDistanceMeters: '',
      arrivalAccuracyMeters: '',
      arrivalLocationCheckedAt: '',
      updatedAt: AT,
    },
  },
  {
    name: 'KinTale sent',
    from: 'DEPARTED',
    write: { reportIds: ['r1'], sentReportCount: 1, autoCompleteEligible: true, kinTaleDue: false, updatedAt: AT },
  },
];

async function seedSession(fields: Record<string, unknown>): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(SESSION).set(fields);
  });
}

describe("rules: #2546 an Auntie's visit steps keep the visit's links", () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  for (const step of VISIT_STEPS) {
    describe(step.name, () => {
      for (const key of Object.keys(LINKS)) {
        it(`keeps ${key}`, async () => {
          const env = await getEnv();
          await seedSession({ ...LINKS, status: step.from });
          const session = asAuntie(env).firestore().doc(SESSION);
          await assertFails(session.update({ ...step.write, [key]: 'other-1' }));
          await assertFails(session.update({ ...step.write, [key]: '' }));
          await assertFails(session.update({ ...step.write, [key]: null }));
          await assertFails(session.update({ ...step.write, [key]: firebase.firestore.FieldValue.delete() }));
          await assertFails(session.set({ ...step.write, [key]: 'other-1' }, { merge: true }));
          await assertSucceeds(session.update(step.write));
        });
      }

      it('lands when an older build sends the stored links back', async () => {
        const env = await getEnv();
        await seedSession({ ...LINKS, status: step.from });
        await assertSucceeds(
          asAuntie(env).firestore().doc(SESSION).set({ ...LINKS, ...step.write }, { merge: true }),
        );
      });

      it('lands on a visit with no booking links, sent back empty', async () => {
        const env = await getEnv();
        await seedSession({ kinfolkId: 'f1', status: step.from });
        await assertSucceeds(
          asAuntie(env).firestore().doc(SESSION).set(
            { ...step.write, kinfolkId: 'f1', sourceBookingId: '', kinCareBatchId: null, kinCareVisitId: null },
            { merge: true },
          ),
        );
      });

      it('lands for the owner', async () => {
        const env = await getEnv();
        await seedSession({ ...LINKS, status: step.from });
        await assertSucceeds(asOwner(env).firestore().doc(SESSION).update(step.write));
      });
    });
  }

  for (const key of ['sourceBookingId', 'kinCareBatchId', 'kinCareVisitId']) {
    it(`an Auntie does not fill an empty ${key}`, async () => {
      const env = await getEnv();
      await seedSession({ kinfolkId: 'f1', status: 'SCHEDULED' });
      const session = asAuntie(env).firestore().doc(SESSION);
      await assertFails(session.update({ status: 'ON_MY_WAY', onMyWayAt: AT, [key]: 'new-1' }));
      await assertSucceeds(session.update({ status: 'ON_MY_WAY', onMyWayAt: AT }));
    });
  }
});

const HOUSEHOLD = ['u-prim', 'u-sk-bill', 'u-sk'];

/** Every other status a visit or booking can hold, in the spellings stored data uses. */
const NOT_REQUESTED = [
  'confirmed',
  'active',
  'inProgress',
  'completed',
  'cancelled',
  'canceled',
  'rejected',
  'REQUESTED',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  '',
];

async function seedHousehold(): Promise<void> {
  await seedFamily({
    fid: 'f1',
    primaryUid: 'u-prim',
    secondaries: [
      { uid: 'u-sk-bill', perms: { billing_full: true } },
      { uid: 'u-sk', perms: {} },
    ],
  });
}

async function seedBooking(visitStatus = 'requested', envelopeStatus = 'requested'): Promise<void> {
  const env = await getEnv();
  await seedHousehold();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(ENVELOPE).set({
      familyId: 'f1',
      targetType: 'KIN',
      requestBatchId: 'b1',
      envelopeStatus,
      notes: '',
    });
    await ctx.firestore().doc(VISIT).set({
      familyId: 'f1',
      targetType: 'KIN',
      status: visitStatus,
      title: 'Walk',
      notes: '',
    });
  });
}

describe('rules: #2547 a booking or visit starts as Requested and the office moves it on', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  const visitBase = { familyId: 'f1', targetType: 'KIN', title: 'Walk' };
  const envelopeBase = { familyId: 'f1', targetType: 'KIN', requestBatchId: 'b1' };

  for (const uid of HOUSEHOLD) {
    it(`${uid} creates a visit only as Requested`, async () => {
      const env = await getEnv();
      await seedHousehold();
      const db = asUser(env, uid).firestore();
      for (const status of NOT_REQUESTED) {
        await assertFails(db.doc(VISIT).set({ ...visitBase, status }));
      }
      await assertFails(db.doc(VISIT).set(visitBase));
      await assertSucceeds(db.doc(VISIT).set({ ...visitBase, status: 'requested' }));
    });

    it(`${uid} creates a booking only as Requested`, async () => {
      const env = await getEnv();
      await seedHousehold();
      const db = asUser(env, uid).firestore();
      for (const envelopeStatus of NOT_REQUESTED) {
        await assertFails(db.doc(ENVELOPE).set({ ...envelopeBase, envelopeStatus }));
      }
      await assertFails(db.doc(ENVELOPE).set(envelopeBase));
      for (const status of NOT_REQUESTED) {
        await assertFails(db.doc(ENVELOPE).set({ ...envelopeBase, envelopeStatus: 'requested', status }));
      }
      await assertSucceeds(db.doc(ENVELOPE).set({ ...envelopeBase, envelopeStatus: 'requested' }));
    });

    it(`${uid} cannot change a visit's status, and its edit lands`, async () => {
      const env = await getEnv();
      await seedBooking();
      const visit = asUser(env, uid).firestore().doc(VISIT);
      const edit = { notes: 'Side gate is open', updatedAt: new Date() };
      for (const status of NOT_REQUESTED) {
        await assertFails(visit.update({ ...edit, status }));
      }
      await assertSucceeds(visit.update({ ...edit, status: 'requested' }));
      await assertSucceeds(visit.update(edit));
    });

    it(`${uid} cannot put a confirmed visit back to Requested`, async () => {
      const env = await getEnv();
      await seedBooking('confirmed');
      const visit = asUser(env, uid).firestore().doc(VISIT);
      const edit = { notes: 'Side gate is open', updatedAt: new Date() };
      await assertFails(visit.update({ ...edit, status: 'requested' }));
      await assertSucceeds(visit.update({ ...edit, status: 'confirmed' }));
    });

    it(`${uid} cannot change a booking's status, and its note lands`, async () => {
      const env = await getEnv();
      await seedBooking();
      const envelope = asUser(env, uid).firestore().doc(ENVELOPE);
      const edit = { notes: 'Side gate is open', updatedAt: new Date() };
      for (const value of NOT_REQUESTED) {
        await assertFails(envelope.update({ ...edit, envelopeStatus: value }));
        await assertFails(envelope.update({ ...edit, status: value }));
      }
      await assertSucceeds(envelope.update({ ...edit, envelopeStatus: 'requested' }));
      await assertSucceeds(envelope.update(edit));
    });
  }

  for (const [name, who] of [['the owner', asOwner], ['an Auntie', asAuntie]] as const) {
    it(`${name} still moves a visit and a booking on`, async () => {
      const env = await getEnv();
      await seedBooking();
      const db = who(env).firestore();
      await assertSucceeds(db.doc(VISIT).update({ status: 'confirmed', updatedAt: AT }));
      await assertSucceeds(db.doc(ENVELOPE).update({ envelopeStatus: 'confirmed', updatedAt: AT }));
    });
  }
});

describe('rules: #2548 no household member deletes a visit or a booking', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  for (const uid of HOUSEHOLD) {
    it(`${uid} cannot delete a visit or a booking, and can still edit them`, async () => {
      const env = await getEnv();
      await seedBooking();
      const db = asUser(env, uid).firestore();
      await assertFails(db.doc(VISIT).delete());
      await assertFails(db.doc(ENVELOPE).delete());
      await assertSucceeds(db.doc(VISIT).update({ notes: 'Side gate is open' }));
      await assertSucceeds(db.doc(ENVELOPE).update({ notes: 'Side gate is open' }));
    });
  }

  for (const [name, who] of [['the owner', asOwner], ['an Auntie', asAuntie]] as const) {
    it(`${name} deletes neither from a client, as before`, async () => {
      const env = await getEnv();
      await seedBooking();
      const db = who(env).firestore();
      await assertFails(db.doc(VISIT).delete());
      await assertFails(db.doc(ENVELOPE).delete());
    });
  }
});
