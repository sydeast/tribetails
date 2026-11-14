import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * #2279, operator ruling 2026-11-14: with "Verify arrival and departure" on, an
 * Auntie cannot start a visit outside the range of the household. The distance
 * is measured by the `setVisitLifecycle` callable; a rule cannot measure one.
 * What the rule does is refuse an Auntie's own direct write of the two start
 * statuses while the switch is on, so the callable is her only way to start.
 *
 * The Admin SDK bypasses rules, so the callable is unaffected by all of this.
 */

const OWNER = { admin: true };
const AUNTIE = { staffRole: 'auntie' };
const SESSION = 'kin_care_sessions/s1';
const SETTINGS = 'business_settings/business_settings';

async function seed(opts: {
  session: Record<string, unknown>;
  /** `undefined` seeds no settings document at all. */
  settings?: Record<string, unknown>;
}): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(SESSION).set({ kinfolkId: 'kf1', ...opts.session });
    if (opts.settings !== undefined) await ctx.firestore().doc(SETTINGS).set(opts.settings);
  });
}

const RULE_ON = { requireArrivalDepartureVerification: true };

async function as(uid: string, claims: Record<string, unknown>) {
  return (await getEnv()).authenticatedContext(uid, claims).firestore().doc(SESSION);
}

describe('rules: an Auntie cannot start a visit by direct write while arrival verification is on', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('refuses her On my way', async () => {
    await seed({ session: { status: 'SCHEDULED' }, settings: RULE_ON });
    await assertFails(
      (await as('auntie1', AUNTIE)).set({ status: 'ON_MY_WAY', onMyWayAt: '2026-11-14T09:00:00Z' }, { merge: true }),
    );
  });

  it('refuses her Arrived, from Scheduled and from On my way', async () => {
    await seed({ session: { status: 'SCHEDULED' }, settings: RULE_ON });
    await assertFails(
      (await as('auntie1', AUNTIE)).set({ status: 'ARRIVED', arrivedAt: '2026-11-14T09:10:00Z' }, { merge: true }),
    );
    await seed({ session: { status: 'ON_MY_WAY', onMyWayAt: '2026-11-14T09:00:00Z' }, settings: RULE_ON });
    await assertFails(
      (await as('auntie1', AUNTIE)).set({ status: 'ARRIVED', arrivedAt: '2026-11-14T09:10:00Z' }, { merge: true }),
    );
  });

  it('still lets her depart a visit that was started', async () => {
    await seed({ session: { status: 'ARRIVED', arrivedAt: '2026-11-14T09:10:00Z' }, settings: RULE_ON });
    await assertSucceeds(
      (await as('auntie1', AUNTIE)).set({ status: 'DEPARTED', departedAt: '2026-11-14T09:40:00Z' }, { merge: true }),
    );
  });

  it('still lets her undo an arrival, back to Scheduled and back to On my way', async () => {
    await seed({ session: { status: 'ARRIVED', arrivedAt: '2026-11-14T09:10:00Z' }, settings: RULE_ON });
    await assertSucceeds((await as('auntie1', AUNTIE)).set({ status: 'SCHEDULED', arrivedAt: '' }, { merge: true }));
    await seed({
      session: { status: 'ARRIVED', onMyWayAt: '2026-11-14T09:00:00Z', arrivedAt: '2026-11-14T09:10:00Z' },
      settings: RULE_ON,
    });
    await assertSucceeds((await as('auntie1', AUNTIE)).set({ status: 'ON_MY_WAY', arrivedAt: '' }, { merge: true }));
  });

  it('still lets her write the fields a KinTale send writes', async () => {
    await seed({ session: { status: 'ARRIVED' }, settings: RULE_ON });
    await assertSucceeds((await as('auntie1', AUNTIE)).set({ reportIds: ['r1'], sentReportCount: 1 }, { merge: true }));
  });

  it('never lets her write the fields that mark an owner arrival outside the range', async () => {
    await seed({ session: { status: 'ARRIVED', arrivalDistanceMeters: 2000 }, settings: RULE_ON });
    await assertFails((await as('auntie1', AUNTIE)).set({ arrivalCheckedByOwner: true }, { merge: true }));
    await assertFails((await as('auntie1', AUNTIE)).set({ completedOutsideRange: true }, { merge: true }));
  });

  it('refuses those two fields from her with the switch off as well', async () => {
    await seed({ session: { status: 'ARRIVED' }, settings: { requireArrivalDepartureVerification: false } });
    await assertFails((await as('auntie1', AUNTIE)).set({ arrivalCheckedByOwner: true }, { merge: true }));
  });
});

describe('rules: what the start rule leaves alone', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the owner starts by direct write with the switch on (the offline queue still works)', async () => {
    await seed({ session: { status: 'SCHEDULED' }, settings: RULE_ON });
    const owner = await as('owner1', OWNER);
    await assertSucceeds(owner.set({ status: 'ON_MY_WAY', onMyWayAt: '2026-11-14T09:00:00Z' }, { merge: true }));
    await assertSucceeds(owner.set({ status: 'ARRIVED', arrivedAt: '2026-11-14T09:10:00Z' }, { merge: true }));
  });

  it('an Auntie starts by direct write with the switch off', async () => {
    await seed({ session: { status: 'SCHEDULED' }, settings: { requireArrivalDepartureVerification: false } });
    const auntie = await as('auntie1', AUNTIE);
    await assertSucceeds(auntie.set({ status: 'ON_MY_WAY', onMyWayAt: '2026-11-14T09:00:00Z' }, { merge: true }));
    await assertSucceeds(auntie.set({ status: 'ARRIVED', arrivedAt: '2026-11-14T09:10:00Z' }, { merge: true }));
  });

  it('an Auntie starts by direct write when the switch was never saved (absent means off)', async () => {
    await seed({ session: { status: 'SCHEDULED' }, settings: { businessName: 'Test Tribe' } });
    await assertSucceeds(
      (await as('auntie1', AUNTIE)).set({ status: 'ARRIVED', arrivedAt: '2026-11-14T09:10:00Z' }, { merge: true }),
    );
  });

  it('an Auntie starts by direct write when there is no settings document at all', async () => {
    await seed({ session: { status: 'SCHEDULED' } });
    await assertSucceeds(
      (await as('auntie1', AUNTIE)).set({ status: 'ARRIVED', arrivedAt: '2026-11-14T09:10:00Z' }, { merge: true }),
    );
  });
});
