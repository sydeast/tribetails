import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily } from './setup';

/**
 * The admin/Auntie access boundary (issue #944, operator ruling 2026-09-22).
 * Spec: docs/superpowers/specs/2026-09-22-admin-auntie-access-design.md
 *
 * The ruling in one line: an Auntie is a contractor who sees household
 * information and no money, no dossiers, and who can see 411s.
 *
 * EVERY REFUSAL IN THIS FILE WAS PROVED TO DISCRIMINATE before it was
 * committed: the rule it tests was loosened, the suite re-run, the failure
 * read, and the loosening reverted. A refusal test that cannot fail is worse
 * than no test on a security boundary, because it reads as coverage. The PR
 * body records the red output for each one.
 */

type Env = Awaited<ReturnType<typeof getEnv>>;

/** The owner. `admin: true` and no staffRole: exactly the operator's token today. */
function asOwner(env: Env) {
  return env.authenticatedContext('owner-1', { admin: true });
}

/** An Auntie. staffRole only, deliberately NO admin claim. */
function asAuntie(env: Env, uid = 'auntie-1') {
  return env.authenticatedContext(uid, { staffRole: 'auntie' });
}

/**
 * An account carrying BOTH claims. Should never exist (grant-staff-role.mjs
 * refuses to make one), so this pins what happens if one is minted by hand.
 */
function asDoubleClaimed(env: Env) {
  return env.authenticatedContext('confused-1', { admin: true, staffRole: 'auntie' });
}

async function seed(path: string, data: Record<string, unknown>) {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(path).set(data);
  });
}

describe('rules: #944 the owner keeps everything it has today', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  /**
   * THE NO-LOCKOUT TEST. The operator is the only staff account that exists,
   * their token carries `admin: true` and no `staffRole`, and this change must
   * be invisible to them.
   *
   * This is not a formality. The first draft of isOwner() spelled the role
   * check `request.auth.token.staffRole != 'auntie'`, and because reading an
   * absent claim is an ERROR in Firestore rules rather than a null, that
   * spelling denied the operator every one of these. 47 existing tests caught
   * it. Weakening this test is how that ships next time.
   */
  it('an owner token with no staffRole still reads money, dossiers and households', async () => {
    const env = await getEnv();
    await seed('invoices/inv1', { kinfolkId: 'k1', amountMinor: 5000 });
    await seed('dossiers/k1', { rawSummary: 'x' });
    await seed('kinfolk/k1', { firstName: 'A', outstandingBalance: '42.50' });
    await seed('payments/p1', { kinfolkId: 'k1', amountMinor: 5000 });
    await seed('household_bank/k1', { tldr: 'x' });
    await seed('the_411/k1', { breed: 'tabby' });
    const db = asOwner(env).firestore();
    await assertSucceeds(db.doc('invoices/inv1').get());
    await assertSucceeds(db.doc('dossiers/k1').get());
    await assertSucceeds(db.doc('kinfolk/k1').get());
    await assertSucceeds(db.doc('payments/p1').get());
    await assertSucceeds(db.doc('household_bank/k1').get());
    await assertSucceeds(db.doc('the_411/k1').get());
  });

  it('an owner token with no staffRole still writes the records it wrote before', async () => {
    const env = await getEnv();
    await seed('dossiers/k1', { rawSummary: 'x' });
    const db = asOwner(env).firestore();
    await assertSucceeds(db.doc('dossiers/k1').set({ rawSummary: 'y' }, { merge: true }));
    await assertSucceeds(db.doc('the_411/k1').set({ breed: 'tabby' }));
    await assertSucceeds(db.doc('kin/kin1').set({ kinfolkId: 'k1', name: 'Mr Pickles' }));
  });
});

describe('rules: #944 an Auntie and money', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('cannot read an invoice', async () => {
    const env = await getEnv();
    await seed('invoices/inv1', { kinfolkId: 'k1', amountMinor: 5000 });
    await assertFails(asAuntie(env).firestore().doc('invoices/inv1').get());
  });

  it('cannot read a payment, and cannot write one', async () => {
    const env = await getEnv();
    await seed('payments/p1', { kinfolkId: 'k1', amountMinor: 5000 });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('payments/p1').get());
    await assertFails(db.doc('payments/p2').set({ kinfolkId: 'k1', amountMinor: 1 }));
    await assertFails(db.doc('payments/p1').delete());
  });

  it('cannot read the Stripe ledgers', async () => {
    const env = await getEnv();
    await seed('stripePayments/pi_1', { amountCents: 100 });
    await seed('stripeDisputes/dp_1', { amountCents: 100 });
    await seed('stripeEvents/evt_1', { type: 'x' });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('stripePayments/pi_1').get());
    await assertFails(db.doc('stripeDisputes/dp_1').get());
    await assertFails(db.doc('stripeEvents/evt_1').get());
  });

  /**
   * `families/{fid}` carries accountBalanceCents, the household's real credit
   * ledger (lib/accountCredit.ts:98). It is not declared on FamilyDoc in
   * lib/schema.ts, so nothing in TypeScript would have warned about this.
   */
  it('cannot read families/{fid}, which carries the household credit balance', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await assertFails(asAuntie(env).firestore().doc('families/f1').get());
  });

  it('cannot read enhanced_bookings, which is priced end to end', async () => {
    const env = await getEnv();
    await seed('enhanced_bookings/b1', { basePrice: 40, totalPrice: 55 });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('enhanced_bookings/b1').get());
    await assertFails(db.doc('enhanced_bookings/b2').set({ basePrice: 1 }));
  });

  it('cannot read business_settings, which holds serviceRates and the payment handles', async () => {
    const env = await getEnv();
    await seed('business_settings/business_settings', {
      timeZone: 'America/Chicago', serviceRates: { walk: '25.00' }, venmoHandle: '@x',
    });
    await assertFails(asAuntie(env).firestore().doc('business_settings/business_settings').get());
  });
  it('cannot write business_settings either', async () => {
    const env = await getEnv();
    await seed('business_settings/business_settings', { timeZone: 'America/Chicago' });
    await assertFails(asAuntie(env).firestore().doc('business_settings/business_settings')
      .set({ timeZone: 'UTC' }, { merge: true }));
  });
  /**
   * #947 (merged after this branch opened) put the daily notification cadence
   * on this same document: `householdNotificationHour`, `scheduleDigestHour`
   * and the `householdNotificationsLive` gate. Deciding when the business sends
   * to every household is not a caretaker's call, and a payload that satisfies
   * their new `validBusinessSettings()` validators must still be refused on the
   * role gate rather than sailing through because the shape is valid.
   *
   * Spelled out separately from the write test above because the two fail for
   * the same reason today and would stop doing so the moment anyone splits the
   * write rule per field.
   */
  it('cannot set the business notification cadence #947 added', async () => {
    const env = await getEnv();
    await seed('business_settings/business_settings', {
      timeZone: 'America/Chicago', householdNotificationHour: 9, scheduleDigestHour: 7,
    });
    const db = asAuntie(env).firestore();
    // Each of these is a VALID payload under validBusinessSettings(); only the
    // role gate stands between a caretaker and the send schedule.
    await assertFails(db.doc('business_settings/business_settings')
      .set({ householdNotificationHour: 3 }, { merge: true }));
    await assertFails(db.doc('business_settings/business_settings')
      .set({ scheduleDigestHour: null }, { merge: true }));
    await assertFails(db.doc('business_settings/business_settings')
      .set({ householdNotificationsLive: true }, { merge: true }));
  });
  /**
   * #2164 / #2182: her screens now get the few values her work needs through
   * two narrow callables. The documents themselves stay closed to her, with
   * every field on them, and stay open to the owner.
   */
  it('#2164: still cannot read any business_settings field, nor the Settings > Notifications store', async () => {
    const env = await getEnv();
    await seed('business_settings/business_settings', {
      timeZone: 'America/Denver', serviceRates: { walk: '25.00' }, serviceDurations: { walk: '30' },
      requireArrivalDepartureVerification: true, kinTaleRequired: true, businessPhone: '555-0142',
    });
    await seed('businessSettings/notifications', { byKey: { 'schedule.upcoming.digest': { enabled: false } } });
    for (const db of [asAuntie(env).firestore(), asDoubleClaimed(env).firestore()]) {
      await assertFails(db.doc('business_settings/business_settings').get());
      await assertFails(db.collection('business_settings').get());
      await assertFails(db.doc('businessSettings/notifications').get());
      await assertFails(db.doc('businessSettings/notifications').set({ byKey: {} }, { merge: true }));
    }
    const owner = asOwner(env).firestore();
    await assertSucceeds(owner.doc('business_settings/business_settings').get());
    await assertSucceeds(owner.doc('businessSettings/notifications').get());
  });
  /**
   * #2223: business notices go to the uids on `businessSettings/admins`. A
   * direct client write is how an Auntie or a household could put herself on
   * it without going through the owner-only callables; the rules refuse it.
   */
  it('cannot read or write the business admin list directly', async () => {
    const env = await getEnv();
    await seed('businessSettings/admins', { uids: ['owner-1'] });
    const household = env.authenticatedContext('kinfolk-1', { role: 'kinfolk', kinfolkId: 'k1' });
    for (const [uid, db] of [
      ['auntie-1', asAuntie(env).firestore()],
      ['confused-1', asDoubleClaimed(env).firestore()],
      ['kinfolk-1', household.firestore()],
    ] as const) {
      const ref = db.doc('businessSettings/admins');
      await assertFails(ref.get());
      await assertFails(ref.set({ uids: ['owner-1', uid] }));
      await assertFails(ref.set({ uids: ['owner-1', uid] }, { merge: true }));
      await assertFails(ref.update({ uids: ['owner-1', uid] }));
      await assertFails(ref.delete());
    }
    const owner = asOwner(env).firestore();
    await assertSucceeds(owner.doc('businessSettings/admins').get());
    await assertSucceeds(owner.doc('businessSettings/admins').update({ updatedAt: 'x' }));
  });
  /** #947's own run-marker collection is closed to everyone; confirm for a caretaker. */
  it('cannot touch scheduled_runs, the cron double-send guard', async () => {
    const env = await getEnv();
    await seed('scheduled_runs/householdDigest', { lastRunDayIso: '2026-09-22' });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('scheduled_runs/householdDigest').get());
    await assertFails(db.doc('scheduled_runs/householdDigest')
      .set({ lastRunDayIso: '2000-01-01' }, { merge: true }));
  });

  it('cannot read a payer record on clients/{uid}', async () => {
    const env = await getEnv();
    await seed('clients/u-prim', { email: 'a@b.com', stripeCustomerId: 'cus_1' });
    await assertFails(asAuntie(env).firestore().doc('clients/u-prim').get());
  });

  it('cannot read the pricing-adjacent admin collections', async () => {
    const env = await getEnv();
    await seed('promo_codes/pc1', { discountAmount: 10 });
    await seed('expenses/e1', { amountCents: 100 });
    await seed('coverage_package_config/cfg', { packages: [] });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('promo_codes/pc1').get());
    await assertFails(db.doc('expenses/e1').get());
    await assertFails(db.doc('coverage_package_config/cfg').get());
  });

  it('cannot write a pricing catalog', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('base_services/s1').set({ name: 'Walk', basePrice: 1 }));
    await assertFails(db.doc('surcharges/s1').set({ name: 'Holiday', amount: 1 }));
    await assertFails(db.doc('discounts/d1').set({ name: 'Loyal', amount: 1 }));
  });
});

describe('rules: #944 an Auntie and the household', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('reads the household record', async () => {
    const env = await getEnv();
    await seed('kinfolk/k1', { firstName: 'A', internalNotes: 'staff note' });
    await assertSucceeds(asAuntie(env).firestore().doc('kinfolk/k1').get());
  });

  it('reads the kin, and records care on them', async () => {
    const env = await getEnv();
    await seed('kin/kin1', { kinfolkId: 'k1', name: 'Mr Pickles' });
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc('kin/kin1').get());
    await assertSucceeds(db.doc('kin/kin1').set({ medications: 'none' }, { merge: true }));
    await assertSucceeds(db.doc('kin/kin2').set({ kinfolkId: 'k1', name: 'Biscuit' }));
  });

  it('reads home access, because she cannot get through the door without it', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await seed('families/f1/homeAccess/current', { gateCode: '1234' });
    await assertSucceeds(asAuntie(env).firestore().doc('families/f1/homeAccess/current').get());
  });

  it('reads household_data and the household subcollections', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await seed('household_data/k1', { vetClinicId: 'v1' });
    await seed('families/f1/kin/kin1', { name: 'Mr Pickles' });
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc('household_data/k1').get());
    await assertSucceeds(db.doc('families/f1/kin/kin1').get());
    await assertSucceeds(db.doc('families/f1/members/u-prim').get());
  });

  /** Rule 5's delete carve-out: an Auntie records care, she does not retire records. */
  it('cannot delete a household record, or create one', async () => {
    const env = await getEnv();
    await seed('kinfolk/k1', { firstName: 'A' });
    await seed('kin/kin1', { kinfolkId: 'k1', name: 'Mr Pickles' });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('kinfolk/k1').delete());
    await assertFails(db.doc('kin/kin1').delete());
    await assertFails(db.doc('kinfolk/k2').set({ firstName: 'New client' }));
  });

  /**
   * The named collision. She may update the household record, and may not move
   * the one money field on it.
   */
  it('updates the household record but cannot move outstandingBalance', async () => {
    const env = await getEnv();
    await seed('kinfolk/k1', { firstName: 'A', outstandingBalance: '42.50' });
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc('kinfolk/k1').set({ internalNotes: 'gate sticks' }, { merge: true }));
    await assertFails(db.doc('kinfolk/k1').set({ outstandingBalance: '0.00' }, { merge: true }));
  });
});

describe('rules: #944 dossiers, 411s and the household bank', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('cannot read a dossier', async () => {
    const env = await getEnv();
    await seed('dossiers/k1', { rawSummary: 'the household, summarised' });
    await assertFails(asAuntie(env).firestore().doc('dossiers/k1').get());
  });

  it('cannot write a dossier', async () => {
    const env = await getEnv();
    await seed('dossiers/k1', { rawSummary: 'x' });
    await assertFails(asAuntie(env).firestore().doc('dossiers/k1').set({ rawSummary: 'y' }, { merge: true }));
  });

  it('CAN read a 411', async () => {
    const env = await getEnv();
    await seed('the_411/k1', { breed: 'tabby', medical: 'thyroid' });
    await assertSucceeds(asAuntie(env).firestore().doc('the_411/k1').get());
  });

  /** The 411 feed is written by the nightly reconcile on the Admin SDK, never by her. */
  it('cannot write a 411 directly', async () => {
    const env = await getEnv();
    await seed('the_411/k1', { breed: 'tabby' });
    await assertFails(asAuntie(env).firestore().doc('the_411/k1').set({ breed: 'siamese' }, { merge: true }));
  });

  it('cannot read the household bank (unruled, so owner-only)', async () => {
    const env = await getEnv();
    await seed('household_bank/k1', { tldr: 'x' });
    await assertFails(asAuntie(env).firestore().doc('household_bank/k1').get());
  });
});

describe('rules: #944 an Auntie writing a KinTale, and the feed downstream', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  /**
   * KinTales are a DIRECT CLIENT WRITE on all three admin clients
   * (api/kinTalesWrite.ts:182, KinCareRepository.kt:679,
   * FirestoreInterop.jvm.kt:424). There is no save callable, so these rules are
   * the only thing standing between an Auntie and her own core output.
   */
  it('creates and updates a KinTale', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc('kin_care_reports/r1').set({
      kinfolkId: 'k1', sessionId: 's1', title: 'Mr Pickles had a good day',
      bodyCopy: 'He ate.', status: 'DRAFT', authorId: 'auntie-1',
    }));
    await assertSucceeds(db.doc('kin_care_reports/r1').set({ bodyCopy: 'He ate well.' }, { merge: true }));
  });

  /**
   * The send batch. All three clients write these three fields onto the session
   * in the SAME batch that flips the report to SENT. If this refuses, sending a
   * KinTale is broken on every client, which is the one thing the ruling says
   * must keep working.
   */
  it('lands the send batch on the session, which is what makes the KinTale feed the records', async () => {
    const env = await getEnv();
    await seed('kin_care_sessions/s1', {
      kinfolkId: 'k1', status: 'DEPARTED', reportIds: [], sentReportCount: 0, invoiceId: 'inv1',
    });
    await seed('kin_care_reports/r1', { kinfolkId: 'k1', sessionId: 's1', status: 'DRAFT' });
    const db = asAuntie(env).firestore();
    const batch = db.batch();
    batch.update(db.doc('kin_care_reports/r1'), { status: 'SENT', sentVia: 'catalog' });
    batch.update(db.doc('kin_care_sessions/s1'), {
      reportIds: ['r1'], sentReportCount: 1, autoCompleteEligible: true,
    });
    await assertSucceeds(batch.commit());
  });

  /**
   * #2123: "KinTales to send" is the Auntie's task list, read from the visit's
   * `kinTaleDue` stamp with no settings read (she cannot read
   * `business_settings`). This is the admin web board's query, word for word
   * (`api/sessions.ts#KINTALES_DUE_QUERY`).
   */
  it("reads the visits stamped as owing a KinTale, the board's own query", async () => {
    const env = await getEnv();
    await seed('kin_care_sessions/s1', {
      kinfolkId: 'k1', status: 'COMPLETED', kinTaleDue: true, startTime: '2026-11-12T15:00:00Z',
    });
    await seed('kin_care_sessions/s2', { kinfolkId: 'k1', status: 'COMPLETED', kinTaleDue: false });
    const db = asAuntie(env).firestore();
    await assertSucceeds(
      db.collection('kin_care_sessions').where('kinTaleDue', '==', true).orderBy('startTime', 'desc').limit(100).get(),
    );
  });

  /** #2123: the send that ends the task lands on a visit the server already completed. */
  it('lands the send batch on a Completed visit owing its KinTale, clearing the stamp', async () => {
    const env = await getEnv();
    await seed('kin_care_sessions/s1', {
      kinfolkId: 'k1', status: 'COMPLETED', completedAt: '2026-11-12T15:30:00Z',
      kinTaleDue: true, reportIds: [], sentReportCount: 0,
    });
    await seed('kin_care_reports/r1', { kinfolkId: 'k1', sessionId: 's1', status: 'DRAFT' });
    const db = asAuntie(env).firestore();
    const batch = db.batch();
    batch.update(db.doc('kin_care_reports/r1'), { status: 'SENT', sentVia: 'catalog' });
    batch.update(db.doc('kin_care_sessions/s1'), {
      reportIds: ['r1'], sentReportCount: 1, autoCompleteEligible: true, kinTaleDue: false,
    });
    await assertSucceeds(batch.commit());
  });

  /**
   * The downstream feed itself is not tested here and cannot be: onKinTaleCreate
   * seeds reconcileStatus and the nightly Python reconcile writes the three
   * banks, both on the Admin SDK, which does not evaluate rules at all. What
   * these rules have to guarantee is that the Auntie's write LANDS, because
   * that write is what the trigger fires on. The two tests above are that
   * guarantee.
   *
   * The trigger half is already covered and is role-blind: test/
   * reconcileStatus.test.ts proves seedReconcileStatus enrols a fresh report,
   * and test/onKinTaleCreate.test.ts proves the trigger calls it on a create.
   * A Firestore event handler has no caller identity in scope, so it cannot
   * tell an Auntie from the owner and cannot behave differently for one.
   */
  it('cannot delete a KinTale', async () => {
    const env = await getEnv();
    await seed('kin_care_reports/r1', { kinfolkId: 'k1', status: 'SENT' });
    await assertFails(asAuntie(env).firestore().doc('kin_care_reports/r1').delete());
  });

  it('still cannot drive a visit to a terminal status outside transitionBookingStatus', async () => {
    const env = await getEnv();
    await seed('kin_care_sessions/s1', { kinfolkId: 'k1', status: 'DEPARTED' });
    await assertFails(asAuntie(env).firestore().doc('kin_care_sessions/s1')
      .set({ status: 'COMPLETED' }, { merge: true }));
  });

  // #2187 ruling, 2026-11-20 ("owner-only"): only the owner makes a New visit.
  it('#2187: is refused creating a visit, at a chosen id or a new one, in any open status', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    const visit = { kinfolkId: 'k1', startTime: '2026-12-01T15:00:00.000Z', serviceType: 'visit_30' };
    for (const status of ['SCHEDULED', 'PENDING', 'ON_THE_WAY', 'ARRIVED']) {
      await assertFails(db.doc(`kin_care_sessions/new-${status}`).set({ ...visit, status }));
    }
    await assertFails(db.doc('kin_care_sessions/no-status').set(visit));
    await assertFails(db.collection('kin_care_sessions').add({ ...visit, status: 'SCHEDULED' }));
    // A merge write to a visit that does not exist yet is a create too.
    await assertFails(db.doc('kin_care_sessions/merged').set({ ...visit, status: 'SCHEDULED' }, { merge: true }));
  });

  it('#2187: an account carrying both roles is refused creating a visit too', async () => {
    const env = await getEnv();
    await assertFails(
      asDoubleClaimed(env).firestore().doc('kin_care_sessions/new-1').set({ kinfolkId: 'k1', status: 'SCHEDULED' }),
    );
  });

  it('#2187: the owner still creates a visit, and an Auntie still works one the owner made', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asOwner(env).firestore().doc('kin_care_sessions/owners').set({ kinfolkId: 'k1', status: 'SCHEDULED' }),
    );
    await assertSucceeds(asAuntie(env).firestore().doc('kin_care_sessions/owners').get());
    await assertSucceeds(
      asAuntie(env).firestore().doc('kin_care_sessions/owners').update({ notes: 'Gate code changed' }),
    );
  });
});

describe('rules: #944 an Auntie and per-visit money on booking documents', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('writes a visit back but cannot move priceCents', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await seed('families/f1/bookings/b1/kinCares/v1', {
      familyId: 'f1', targetType: 'KIN', status: 'SCHEDULED', priceCents: 4000,
    });
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc('families/f1/bookings/b1/kinCares/v1')
      .set({ status: 'ARRIVED', auntieDisplayName: 'Rae' }, { merge: true }));
    await assertFails(db.doc('families/f1/bookings/b1/kinCares/v1')
      .set({ priceCents: 1 }, { merge: true }));
  });

  it('cannot move the booking envelope billing key', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await seed('families/f1/bookings/b1', { familyId: 'f1', targetType: 'KIN', status: 'REQUESTED' });
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc('families/f1/bookings/b1').set({ status: 'CONFIRMED' }, { merge: true }));
    await assertFails(db.doc('families/f1/bookings/b1')
      .set({ billing: { mode: 'new-invoice' } }, { merge: true }));
  });
});

describe('rules: #942 the retired nested invoice path', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  /**
   * The grant this closes was `allow create, update, delete: if isAuntie()` on
   * families/{fid}/invoices, while the live flat path forbids all three
   * (ADR-0002: every invoice write goes through a callable so the state
   * classifier stamps it). Nothing in test/rules/ covered it, which is how it
   * survived. These four are that coverage.
   */
  it('nobody creates on the nested path: not an Auntie, not the owner', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    const doc = 'families/f1/invoices/inv1';
    await assertFails(asAuntie(env).firestore().doc(doc).set({ amountMinor: 5000 }));
    await assertFails(asOwner(env).firestore().doc(doc).set({ amountMinor: 5000 }));
  });

  it('nobody updates or deletes on the nested path', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await seed('families/f1/invoices/inv1', { amountMinor: 5000 });
    const doc = 'families/f1/invoices/inv1';
    await assertFails(asAuntie(env).firestore().doc(doc).set({ amountMinor: 1 }, { merge: true }));
    await assertFails(asOwner(env).firestore().doc(doc).set({ amountMinor: 1 }, { merge: true }));
    await assertFails(asOwner(env).firestore().doc(doc).delete());
  });

  /** Read survives on purpose: the backfill has not proved the path is empty. */
  it('the owner can still read what is down there', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await seed('families/f1/invoices/inv1', { amountMinor: 5000 });
    await assertSucceeds(asOwner(env).firestore().doc('families/f1/invoices/inv1').get());
  });

  it('an Auntie cannot read it either, because it is an invoice', async () => {
    const env = await getEnv();
    await seedFamily({ fid: 'f1', primaryUid: 'u-prim' });
    await seed('families/f1/invoices/inv1', { amountMinor: 5000 });
    await assertFails(asAuntie(env).firestore().doc('families/f1/invoices/inv1').get());
  });
});

/**
 * #2208, operator ruling 2026-11-14: an Auntie sees and works Supplies and
 * Expirations on Home. Both reads open to her; `expenses`, which shares their
 * rules block, is money and stays shut. Writes stay closed to every client:
 * her +1 restock goes through adjustSupply.
 */
describe('rules: #2208 an Auntie reads supplies and expirations', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('reads a supply and an expiration, one at a time and as a list', async () => {
    const env = await getEnv();
    await seed('supplies/s1', { name: 'Waste bags', onHand: 2, par: 10, unit: 'rolls' });
    await seed('expirations/x1', { label: 'Side gate code', dateIso: '2026-12-01', kind: 'gateCode', kinfolkId: 'k1' });
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc('supplies/s1').get());
    await assertSucceeds(db.doc('expirations/x1').get());
    await assertSucceeds(db.collection('supplies').get());
    await assertSucceeds(db.collection('expirations').get());
  });

  it('still cannot read an expense, the money collection in the same block', async () => {
    const env = await getEnv();
    await seed('expenses/e1', { kind: 'gas', amountCents: 4200 });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('expenses/e1').get());
    await assertFails(db.collection('expenses').get());
  });

  it('cannot write either collection directly: no create, update or delete', async () => {
    const env = await getEnv();
    await seed('supplies/s1', { name: 'Waste bags', onHand: 2, par: 10, unit: 'rolls' });
    await seed('expirations/x1', { label: 'Side gate code', dateIso: '2026-12-01', kind: 'gateCode' });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('supplies/s1').update({ onHand: 999 }));
    await assertFails(db.doc('supplies/s2').set({ name: 'Towels', onHand: 1, par: 1, unit: 'each' }));
    await assertFails(db.doc('supplies/s1').delete());
    await assertFails(db.doc('expirations/x1').update({ dateIso: '2099-01-01' }));
    await assertFails(db.doc('expirations/x2').set({ label: 'x', dateIso: '2026-12-01', kind: 'other' }));
    await assertFails(db.doc('expirations/x1').delete());
  });

  it('the owner still reads both, and still cannot write either directly', async () => {
    const env = await getEnv();
    await seed('supplies/s1', { name: 'Waste bags', onHand: 2, par: 10, unit: 'rolls' });
    await seed('expirations/x1', { label: 'Side gate code', dateIso: '2026-12-01', kind: 'gateCode' });
    const db = asOwner(env).firestore();
    await assertSucceeds(db.doc('supplies/s1').get());
    await assertSucceeds(db.doc('expirations/x1').get());
    await assertFails(db.doc('supplies/s1').update({ onHand: 999 }));
    await assertFails(db.doc('expirations/x1').update({ dateIso: '2099-01-01' }));
  });

  it('nobody else reads them: not a household, not an unknown staff role, not a signed-out caller', async () => {
    const env = await getEnv();
    await seed('supplies/s1', { name: 'Waste bags', onHand: 2, par: 10, unit: 'rolls' });
    await seed('expirations/x1', { label: 'Side gate code', dateIso: '2026-12-01', kind: 'gateCode', kinfolkId: 'k1' });
    const kinfolk = env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'k1' }).firestore();
    const unknown = env.authenticatedContext('future-1', { staffRole: 'bookkeeper' }).firestore();
    const signedOut = env.unauthenticatedContext().firestore();
    for (const db of [kinfolk, unknown, signedOut]) {
      await assertFails(db.doc('supplies/s1').get());
      await assertFails(db.doc('expirations/x1').get());
    }
  });
});

/**
 * #2215: an Auntie's Home layout lives on her own user record. She reads that
 * one record and no other, and writes none from a client (her layout save is
 * the saveDashboardLayout callable).
 */
describe('rules: #2215 an Auntie reads her own user record only', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('reads her own record, and one that does not exist yet', async () => {
    const env = await getEnv();
    await seed('users/auntie-1', { displayName: 'A', dashboardWidgets: ['stats:wide', 'supplies:compact'] });
    await assertSucceeds(asAuntie(env).firestore().doc('users/auntie-1').get());
    await assertSucceeds(asAuntie(env, 'auntie-new').firestore().doc('users/auntie-new').get());
  });

  it('cannot read the owner\'s record, another Auntie\'s, or the list of them', async () => {
    const env = await getEnv();
    await seed('users/owner-1', { displayName: 'O', dashboardWidgets: ['cashFlow:wide'] });
    await seed('users/auntie-2', { displayName: 'B' });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('users/owner-1').get());
    await assertFails(db.doc('users/auntie-2').get());
    await assertFails(db.collection('users').get());
  });

  it('cannot write her own record or anyone else\'s from a client', async () => {
    const env = await getEnv();
    await seed('users/auntie-1', { displayName: 'A' });
    await seed('users/owner-1', { displayName: 'O' });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('users/auntie-1').set({ dashboardWidgets: ['cashFlow:wide'] }, { merge: true }));
    await assertFails(db.doc('users/auntie-1').delete());
    await assertFails(db.doc('users/owner-1').set({ displayName: 'x' }, { merge: true }));
  });

  it('the owner still reads and writes user records', async () => {
    const env = await getEnv();
    await seed('users/owner-1', { displayName: 'O' });
    await seed('users/auntie-1', { displayName: 'A' });
    const db = asOwner(env).firestore();
    await assertSucceeds(db.doc('users/owner-1').get());
    await assertSucceeds(db.doc('users/auntie-1').get());
    await assertSucceeds(db.doc('users/owner-1').set({ displayName: 'O2' }, { merge: true }));
  });

  it('a household and a signed-out caller still read no user record, their own included', async () => {
    const env = await getEnv();
    await seed('users/u-kin', { displayName: 'K' });
    const kinfolk = env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'k1' }).firestore();
    await assertFails(kinfolk.doc('users/u-kin').get());
    await assertFails(env.unauthenticatedContext().firestore().doc('users/u-kin').get());
  });
});

describe('rules: #944 claim-shape edge cases', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  /**
   * An account should never hold both claims: grant-staff-role.mjs refuses to
   * make one. If one is minted by hand anyway, it must fail toward LESS access.
   */
  it('a token holding both admin and staffRole gets the Auntie boundary', async () => {
    const env = await getEnv();
    await seed('invoices/inv1', { kinfolkId: 'k1', amountMinor: 5000 });
    await seed('dossiers/k1', { rawSummary: 'x' });
    await seed('kinfolk/k1', { firstName: 'A' });
    const db = asDoubleClaimed(env).firestore();
    await assertFails(db.doc('invoices/inv1').get());
    await assertFails(db.doc('dossiers/k1').get());
    await assertSucceeds(db.doc('kinfolk/k1').get());
  });

  /** An unrecognised staffRole is neither role and gets nothing. */
  it('an unknown staffRole value is refused everywhere', async () => {
    const env = await getEnv();
    await seed('kinfolk/k1', { firstName: 'A' });
    await seed('the_411/k1', { breed: 'tabby' });
    const db = env.authenticatedContext('future-1', { staffRole: 'bookkeeper' }).firestore();
    await assertFails(db.doc('kinfolk/k1').get());
    await assertFails(db.doc('the_411/k1').get());
  });

  /** A kinfolk is not staff, and the new claim must not have changed that. */
  it('a kinfolk token gains nothing from the new helpers', async () => {
    const env = await getEnv();
    await seed('kinfolk/k1', { firstName: 'A' });
    await seed('the_411/k1', { breed: 'tabby' });
    const db = env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'k1' }).firestore();
    await assertFails(db.doc('kinfolk/k1').get());
    await assertFails(db.doc('the_411/k1').get());
  });
});
describe('rules: #984 an Auntie assigned a tribe is still not kinfolk', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  /**
   * Operator ruling 2026-09-27: an Auntie may be assigned tribes through
   * `clients/{uid}.kinfolkIds`. With exactly one, `syncKinfolkClaim` mints
   * `role: 'kinfolk'` and `kinfolkId` on top of her `staffRole`. Without the
   * `!hasAuntieRole()` conjunct in `isKinfolk()`, that token read the
   * household's invoices through the kinfolk branch of `match /invoices`.
   * #1906 removed that branch (household reads match what the portal shows),
   * so the refusal below now holds twice over.
   */
  it('refuses her the assigned household invoices', async () => {
    const env = await getEnv();
    await seed('invoices/inv1', { kinfolkId: 'k1', amountMinor: 5000 });
    const db = env
      .authenticatedContext('auntie-1', { staffRole: 'auntie', role: 'kinfolk', kinfolkId: 'k1' })
      .firestore();
    await assertFails(db.doc('invoices/inv1').get());
  });
  it('still lets her read the household record, through isStaff', async () => {
    const env = await getEnv();
    await seed('kinfolk/k1', { firstName: 'A' });
    await seed('kin/kin1', { kinfolkId: 'k1', name: 'Biscuit' });
    const db = env
      .authenticatedContext('auntie-1', { staffRole: 'auntie', role: 'kinfolk', kinfolkId: 'k1' })
      .firestore();
    await assertSucceeds(db.doc('kinfolk/k1').get());
    await assertSucceeds(db.doc('kin/kin1').get());
  });
  it('#1906 a real kinfolk reads their bills through getMyInvoices, not the document', async () => {
    const env = await getEnv();
    await seed('invoices/inv1', { kinfolkId: 'k1', amountMinor: 5000 });
    const db = env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'k1' }).firestore();
    await assertFails(db.doc('invoices/inv1').get());
  });
});
/**
 * #1580, operator ruling 2026-11-05: two kinds of internal visit note, shared
 * and admin-only; Aunties see only shared ones. The kinds are two paths, so the
 * boundary is the rule on each path.
 */
describe('rules: #1580 admin-only visit notes are the owner\'s alone', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  const VISIT = 'families/f1/bookings/b1/kinCares/v1';
  it('the owner reads both kinds', async () => {
    const env = await getEnv();
    await seed(`${VISIT}/internalNotes/n1`, { body: 'shared', visibility: 'shared' });
    await seed(`${VISIT}/adminNotes/n2`, { body: 'admin only', visibility: 'adminOnly' });
    const db = asOwner(env).firestore();
    await assertSucceeds(db.doc(`${VISIT}/internalNotes/n1`).get());
    await assertSucceeds(db.doc(`${VISIT}/adminNotes/n2`).get());
  });
  it('an Auntie reads the shared kind and is refused the admin-only one', async () => {
    const env = await getEnv();
    await seed(`${VISIT}/internalNotes/n1`, { body: 'shared', visibility: 'shared' });
    await seed(`${VISIT}/adminNotes/n2`, { body: 'admin only', visibility: 'adminOnly' });
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc(`${VISIT}/internalNotes/n1`).get());
    await assertFails(db.doc(`${VISIT}/adminNotes/n2`).get());
    await assertFails(db.collection(`${VISIT}/adminNotes`).get());
  });
  it('a double-claimed account degrades to the Auntie and is refused', async () => {
    const env = await getEnv();
    await seed(`${VISIT}/adminNotes/n2`, { body: 'admin only', visibility: 'adminOnly' });
    await assertFails(asDoubleClaimed(env).firestore().doc(`${VISIT}/adminNotes/n2`).get());
  });
  it('a household member is refused it', async () => {
    const env = await getEnv();
    await seed(`${VISIT}/adminNotes/n2`, { body: 'admin only', visibility: 'adminOnly' });
    const db = env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'f1' }).firestore();
    await assertFails(db.doc(`${VISIT}/adminNotes/n2`).get());
  });
  it('no client writes it, not even the owner', async () => {
    const env = await getEnv();
    await assertFails(asOwner(env).firestore().doc(`${VISIT}/adminNotes/n3`).set({ body: 'x' }));
    await assertFails(asAuntie(env).firestore().doc(`${VISIT}/adminNotes/n3`).set({ body: 'x' }));
  });
});
describe('rules: generated drafts are the owner\'s to make and remove; an Auntie works KinTale drafts only', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  const PUSH = 'generated_drafts/push-1';
  const EMAIL = 'generated_drafts/email-1';
  const TALE = 'generated_drafts/tale-1';
  const OLDER = 'generated_drafts/older-1';
  const base = { kinfolk_id: 'f1', generated_copy: 'Words', raw_notes: 'Notes', status: 'generated' };
  const push = { ...base, communication_type: 'push', createdOn: '2026-11-01T10:00:00.000Z' };
  const email = { ...base, communication_type: 'email', createdOn: '2026-11-02T10:00:00.000Z' };
  const tale = { ...base, communication_type: 'visit_report', createdOn: '2026-11-03T10:00:00.000Z' };
  /** #2443: a KinTale draft she made. The generator stamps the maker's uid as `createdBy`. */
  const mine = { ...tale, createdBy: 'auntie-1' };
  /** A migrated draft: the older spelling only. */
  const older = { kinfolkId: 'f1', generatedCopy: 'Words', communicationType: 'visit_report', status: 'pending', createdOn: '2026-05-23T10:00:00.000Z' };
  /** Types that are not exactly `visit_report` and not exactly `push`. */
  const INEXACT_TYPES: unknown[] = [
    ' push', 'push ', 'Push', 'PUSH', 'push\t', '\u00a0push', 'push\u00a0', 'push\u2028', '\u2029push', '\u3000push', '\ufeffpush',
    ' visit_report', 'visit_report ', 'Visit_Report', 'visit_report\u00a0', '\u3000visit_report', '\ufeffvisit_report',
    '', 7, null, true, ['visit_report'],
  ];
  const draftsQuery = (db: ReturnType<ReturnType<typeof asAuntie>['firestore']>) =>
    db
      .collection('generated_drafts')
      .where('communication_type', '==', 'visit_report')
      .where('createdBy', '==', 'auntie-1')
      .orderBy('createdOn', 'desc')
      .limit(50);
  async function seedAll() {
    await seed(PUSH, push);
    await seed(EMAIL, email);
    await seed(TALE, mine);
    await seed(OLDER, older);
  }
  // ── The owner ─────────────────────────────────────────────────────────────
  it('the owner creates, reads, approves and deletes a draft of every type', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    for (const [path, draft] of [[PUSH, push], [TALE, tale], [OLDER, older]] as const) {
      await assertSucceeds(db.doc(path).set(draft));
      await assertSucceeds(db.doc(path).get());
      await assertSucceeds(db.doc(path).update({ status: 'approved', generatedCopy: 'Final words', approvedBy: 'owner-1' }));
      await assertSucceeds(db.doc(path).delete());
    }
    // An Email or Text nobody has approved is edited and deleted like the rest.
    await assertSucceeds(db.doc(EMAIL).set(email));
    await assertSucceeds(db.doc(EMAIL).get());
    await assertSucceeds(db.doc(EMAIL).update({ generatedCopy: 'Edited words' }));
    await assertSucceeds(db.doc(EMAIL).delete());
  });
  // ── #2428: an Email or Text goes out once, and a sent draft is kept ────────
  const APPROVE = { status: 'approved', generatedCopy: 'Final words', approvedAt: '2026-11-20T10:00:00.000Z', approvedBy: 'owner-1' };
  it('#2428: an installed client approves an Email or Text draft once, and is refused the second approve that would send it again', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    for (const [i, typeField] of [
      { communication_type: 'email' },
      { communication_type: 'sms' },
      { communicationType: 'email' },
      { communicationType: 'sms' },
    ].entries()) {
      const path = `generated_drafts/msg-${String(i)}`;
      await seed(path, { ...base, ...typeField, createdOn: '2026-11-02T10:00:00.000Z' });
      // The write every client before #2428 made, then sent the message itself.
      await assertSucceeds(db.doc(path).update(APPROVE));
      // The same draft opened again: the approve write is the gate, and it is shut.
      await assertFails(db.doc(path).update({ ...APPROVE, generatedCopy: 'Words to send again' }));
      await assertFails(db.doc(path).update({ generatedCopy: 'Edited after it went' }));
      await assertFails(db.doc(path).update({ status: 'generated' }));
      await assertFails(db.doc(path).set({ ...base, ...typeField, status: 'approved' }));
      await assertFails(db.doc(path).delete());
    }
  });
  it('#2428: a draft sendGeneratedDraft has claimed or stamped is not the client\'s to change or delete', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    const states: Record<string, unknown>[] = [
      { status: 'approved', sendClaimedAt: '2026-11-20T10:00:00.000Z' },
      { status: 'approved', sentAt: '2026-11-20T10:00:01.000Z', sentChannel: 'email' },
      // The stamp alone keeps it, whatever the status reads.
      { status: 'generated', sentAt: '2026-11-20T10:00:01.000Z' },
    ];
    for (const [i, state] of states.entries()) {
      const path = `generated_drafts/claimed-${String(i)}`;
      await seed(path, { ...email, ...state });
      await assertSucceeds(db.doc(path).get());
      await assertFails(db.doc(path).update(APPROVE));
      await assertFails(db.doc(path).delete());
    }
  });
  it('#2428: an Email whose send the provider refused is unsent again, and is approved or deleted like any other', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    await seed(EMAIL, { ...email, sendFailedAt: '2026-11-20T10:00:01.000Z' });
    await assertSucceeds(db.doc(EMAIL).update(APPROVE));
    await seed('generated_drafts/email-2', { ...email, sendFailedAt: '2026-11-20T10:00:01.000Z' });
    await assertSucceeds(db.doc('generated_drafts/email-2').delete());
  });
  it('#2428: a draft a household was sent is not deleted directly: a sent KinTale, and a Push on their list or their phone', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    await seed('generated_drafts/sent-tale', { ...tale, status: 'published', publishedReportId: 'r1' });
    await seed('generated_drafts/sent-push', { ...push, status: 'approved', pushOutcome: 'sent' });
    await seed('generated_drafts/listed-push', { ...push, status: 'approved', pushOutcome: 'listed' });
    await seed('generated_drafts/older-push', { ...older, communicationType: 'push', status: 'approved', pushOutcome: 'sent' });
    for (const path of ['generated_drafts/sent-tale', 'generated_drafts/sent-push', 'generated_drafts/listed-push', 'generated_drafts/older-push']) {
      await assertFails(db.doc(path).delete());
    }
  });
  it('#2428: a Push the household was sent is not approved again with new words by a client', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    await seed('generated_drafts/sent-push', { ...push, status: 'approved', pushOutcome: 'sent' });
    await seed('generated_drafts/listed-push', { ...push, status: 'approved', pushOutcome: 'listed', pushReason: 'no_device' });
    await seed('generated_drafts/older-push', { ...older, communicationType: 'push', status: 'approved', pushOutcome: 'listed' });
    for (const path of ['generated_drafts/sent-push', 'generated_drafts/listed-push', 'generated_drafts/older-push']) {
      await assertSucceeds(db.doc(path).get());
      // The approve write an installed client makes before it calls the push again.
      await assertFails(db.doc(path).update({ ...APPROVE, generatedCopy: 'New words for a notice they already have' }));
      await assertFails(db.doc(path).update({ generatedCopy: 'Edited after it went' }));
    }
  });
  it('#2428: a Push that reached nobody is still the owner\'s to approve again and to delete', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    // Held by the send gate, and one whose send never answered (#2381).
    await seed('generated_drafts/held-push', { ...push, status: 'approved', pushOutcome: 'held', pushReason: 'household_notices_off' });
    await seed('generated_drafts/unanswered-push', { ...push, status: 'approved' });
    for (const path of ['generated_drafts/held-push', 'generated_drafts/unanswered-push']) {
      await assertSucceeds(db.doc(path).update(APPROVE));
      await assertSucceeds(db.doc(path).delete());
    }
    // A Social, Blog or General draft is sent by nothing, so approving it twice sends nothing twice.
    await seed('generated_drafts/blog-1', { ...base, communication_type: 'blog_post', status: 'approved' });
    await assertSucceeds(db.doc('generated_drafts/blog-1').update(APPROVE));
    await assertSucceeds(db.doc('generated_drafts/blog-1').delete());
  });
  it('the owner lists every draft with no type on the query', async () => {
    const env = await getEnv();
    await seedAll();
    await assertSucceeds(asOwner(env).firestore().collection('generated_drafts').orderBy('createdOn', 'desc').limit(50).get());
  });
  // ── An Auntie never creates or deletes ────────────────────────────────────
  it('an Auntie is refused creating a draft of any type, a KinTale draft included', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    await assertFails(db.doc(TALE).set(tale));
    await assertFails(db.doc(PUSH).set({ ...push, status: 'approved' }));
    await assertFails(db.doc(EMAIL).set(email));
    await assertFails(db.doc(OLDER).set(older));
    await assertFails(db.doc('generated_drafts/untyped-1').set(base));
    await assertFails(db.collection('generated_drafts').add(tale));
  });
  it('an Auntie is refused creating a draft whose type is not exactly a known one, in either spelling', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    for (const [i, type] of INEXACT_TYPES.entries()) {
      await assertFails(db.doc(`generated_drafts/new-a-${String(i)}`).set({ ...base, communication_type: type, status: 'approved' }));
      await assertFails(db.doc(`generated_drafts/new-b-${String(i)}`).set({ ...base, communicationType: type, status: 'approved' }));
    }
  });
  it('an Auntie is refused deleting a draft of any type, a KinTale draft included', async () => {
    const env = await getEnv();
    await seedAll();
    await seed('generated_drafts/sent-1', { ...mine, status: 'published', publishedReportId: 'r1' });
    const db = asAuntie(env).firestore();
    for (const path of [TALE, PUSH, EMAIL, OLDER, 'generated_drafts/sent-1']) {
      await assertFails(db.doc(path).delete());
    }
  });
  // ── What an Auntie reads ──────────────────────────────────────────────────
  it('an Auntie reads a KinTale draft she made', async () => {
    const env = await getEnv();
    await seed(TALE, mine);
    await seed('generated_drafts/tale-2', { ...mine, communicationType: 'visit_report' });
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc(TALE).get());
    await assertSucceeds(db.doc('generated_drafts/tale-2').get());
  });
  it('an Auntie is refused reading a Communicate draft: push, email or any other type', async () => {
    const env = await getEnv();
    await seedAll();
    for (const type of ['sms', 'social_post', 'blog_post', 'general']) {
      await seed(`generated_drafts/${type}-1`, { ...base, communication_type: type, createdBy: 'auntie-1' });
    }
    const db = asAuntie(env).firestore();
    for (const path of [PUSH, EMAIL, 'generated_drafts/sms-1', 'generated_drafts/social_post-1', 'generated_drafts/blog_post-1', 'generated_drafts/general-1']) {
      await assertFails(db.doc(path).get());
    }
  });
  it('an Auntie is refused reading a draft whose type is not exactly visit_report', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    for (const [i, type] of INEXACT_TYPES.entries()) {
      const path = `generated_drafts/odd-${String(i)}`;
      await seed(path, { ...base, communication_type: type, createdBy: 'auntie-1' });
      await assertFails(db.doc(path).get());
    }
    await seed('generated_drafts/untyped-1', { ...base, createdBy: 'auntie-1' });
    await assertFails(db.doc('generated_drafts/untyped-1').get());
  });
  it('an Auntie is refused reading a draft whose older type field is missing its partner or says something else', async () => {
    const env = await getEnv();
    await seed(OLDER, { ...older, createdBy: 'auntie-1' });
    await seed('generated_drafts/mixed-1', { ...mine, communicationType: 'push' });
    await seed('generated_drafts/mixed-2', { ...mine, communicationType: ' visit_report' });
    await seed('generated_drafts/mixed-3', { ...mine, communicationType: '' });
    const db = asAuntie(env).firestore();
    for (const path of [OLDER, 'generated_drafts/mixed-1', 'generated_drafts/mixed-2', 'generated_drafts/mixed-3']) {
      await assertFails(db.doc(path).get());
    }
  });
  it('an Auntie lists KinTale drafts when her query names the type', async () => {
    const env = await getEnv();
    await seedAll();
    const db = asAuntie(env).firestore();
    await assertSucceeds(draftsQuery(db).get());
    await assertSucceeds(
      db.collection('generated_drafts').where('communication_type', '==', 'visit_report').where('createdBy', '==', 'auntie-1').get(),
    );
  });
  it('an Auntie is refused a list that does not name the KinTale type', async () => {
    const env = await getEnv();
    await seedAll();
    const db = asAuntie(env).firestore();
    const col = db.collection('generated_drafts');
    await assertFails(col.get());
    await assertFails(col.orderBy('createdOn', 'desc').limit(50).get());
    await assertFails(col.where('kinfolk_id', '==', 'f1').get());
    await assertFails(col.where('communication_type', '==', 'push').get());
    await assertFails(col.where('communication_type', '==', 'email').get());
    await assertFails(col.where('communication_type', 'in', ['visit_report', 'push']).get());
    await assertFails(col.where('communication_type', '>=', 'push').get());
    await assertFails(col.where('communicationType', '==', 'visit_report').get());
    await assertFails(col.where('status', '==', 'generated').get());
  });
  // ── An Auntie writes no draft here; her edits travel with the send ────────
  /** The words and the title of a draft, in both spellings. */
  const WORD_FIELDS = ['generatedCopy', 'generated_copy', 'generatedTitle', 'generated_title', 'subject'] as const;
  const SENT = 'generated_drafts/sent-1';
  const sent = { ...mine, status: 'published', publishedReportId: 'r1', publishedAt: '2026-11-04T00:00:00.000Z' };
  it('an Auntie is refused changing the words or the title of a KinTale draft, one field at a time', async () => {
    const env = await getEnv();
    await seed(TALE, { ...mine, generated_title: 'A visit', subject: 'A visit' });
    await seed('generated_drafts/tale-2', { ...mine, communicationType: 'visit_report', generatedCopy: 'Words', generatedTitle: 'A visit' });
    const db = asAuntie(env).firestore();
    for (const path of [TALE, 'generated_drafts/tale-2']) {
      for (const field of WORD_FIELDS) {
        await assertFails(db.doc(path).update({ [field]: 'Her words' }));
      }
    }
  });
  it('an Auntie is refused changing the words and the title of a KinTale draft together', async () => {
    const env = await getEnv();
    await seed(TALE, { ...mine, generated_title: 'A visit' });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc(TALE).update({ generated_copy: 'Her words', generated_title: 'Her title' }));
    await assertFails(db.doc(TALE).update({ generatedTitle: 'Her title', subject: 'Her title' }));
    await assertFails(db.doc(TALE).update(Object.fromEntries(WORD_FIELDS.map((f) => [f, 'Her words']))));
    await assertFails(db.doc(TALE).set({ generated_copy: 'Her words' }, { merge: true }));
  });
  it('an Auntie is refused changing the words or the title of a draft already sent', async () => {
    const env = await getEnv();
    await seed(SENT, sent);
    const db = asAuntie(env).firestore();
    for (const field of WORD_FIELDS) {
      await assertFails(db.doc(SENT).update({ [field]: 'Her words' }));
    }
  });
  it('an account carrying both roles is refused changing the words or the title of a KinTale draft', async () => {
    const env = await getEnv();
    await seed(TALE, mine);
    await seed(SENT, sent);
    const db = asDoubleClaimed(env).firestore();
    for (const path of [TALE, SENT]) {
      for (const field of WORD_FIELDS) {
        await assertFails(db.doc(path).update({ [field]: 'Her words' }));
      }
    }
  });
  it('the owner changes the words and the title of a draft, unsent or sent, one field at a time', async () => {
    const env = await getEnv();
    await seedAll();
    await seed(SENT, sent);
    const db = asOwner(env).firestore();
    for (const path of [TALE, PUSH, EMAIL, OLDER, SENT]) {
      for (const field of WORD_FIELDS) {
        await assertSucceeds(db.doc(path).update({ [field]: 'Final words' }));
      }
    }
  });
  it('an Auntie is refused approving a KinTale draft or changing its status at all', async () => {
    const env = await getEnv();
    await seed(TALE, mine);
    const db = asAuntie(env).firestore();
    await assertFails(db.doc(TALE).update({ status: 'approved' }));
    await assertFails(db.doc(TALE).update({ status: 'approved', generatedCopy: 'Her words' }));
    await assertFails(db.doc(TALE).update({ status: 'published' }));
    await assertFails(db.doc(TALE).update({ status: 'pending' }));
    await assertFails(db.doc(TALE).update({ approvedAt: '2026-11-20T00:00:00.000Z', approvedBy: 'auntie-1' }));
  });
  it('an Auntie is refused moving a KinTale draft to another household, in either spelling', async () => {
    const env = await getEnv();
    await seed(TALE, mine);
    const db = asAuntie(env).firestore();
    await assertFails(db.doc(TALE).update({ kinfolk_id: 'f2' }));
    await assertFails(db.doc(TALE).update({ kinfolkId: 'f2' }));
    await assertFails(db.doc(TALE).update({ kinfolk_id: 'f2', generatedCopy: 'Her words' }));
    await assertFails(db.doc(TALE).update({ kinfolk_name: 'Someone else' }));
    await assertFails(db.doc(TALE).update({ recipient: 'Someone else' }));
  });
  it('an Auntie is refused changing whether or how a draft was sent', async () => {
    const env = await getEnv();
    await seed(TALE, mine);
    await seed('generated_drafts/sent-1', { ...mine, status: 'published', publishedReportId: 'r1', publishedAt: '2026-11-04T00:00:00.000Z' });
    const db = asAuntie(env).firestore();
    await assertFails(db.doc(TALE).update({ publishedReportId: 'r9' }));
    await assertFails(db.doc(TALE).update({ publishedAt: '2026-11-20T00:00:00.000Z' }));
    await assertFails(db.doc(TALE).update({ pushOutcome: 'held' }));
    await assertFails(db.doc(TALE).update({ pushReason: 'household_notices_off' }));
    await assertFails(db.doc(TALE).update({ pushAttemptedAt: '2026-11-20T00:00:00.000Z' }));
    await assertFails(db.doc('generated_drafts/sent-1').update({ publishedReportId: '' }));
    await assertFails(db.doc('generated_drafts/sent-1').update({ status: 'generated' }));
  });
  it('an Auntie is refused changing the type of a KinTale draft, in either spelling', async () => {
    const env = await getEnv();
    await seed(TALE, mine);
    const db = asAuntie(env).firestore();
    await assertFails(db.doc(TALE).update({ communication_type: 'push' }));
    await assertFails(db.doc(TALE).update({ communication_type: 'email', generatedCopy: 'Her words' }));
    await assertFails(db.doc(TALE).update({ communicationType: 'push' }));
    await assertFails(db.doc(TALE).update({ communicationType: 'visit_report' }));
    for (const type of INEXACT_TYPES) {
      await assertFails(db.doc(TALE).update({ communication_type: type }));
      await assertFails(db.doc(TALE).update({ communicationType: type }));
    }
  });
  it('an Auntie is refused changing anything else on a KinTale draft, or replacing it', async () => {
    const env = await getEnv();
    await seed(TALE, mine);
    const db = asAuntie(env).firestore();
    await assertFails(db.doc(TALE).update({ raw_notes: 'Other notes' }));
    await assertFails(db.doc(TALE).update({ createdOn: '2027-01-01T00:00:00.000Z' }));
    await assertFails(db.doc(TALE).update({ model: 'x', source: 'x' }));
    await assertFails(db.doc(TALE).update({ anythingNew: true }));
    await assertFails(db.doc(TALE).set({ communication_type: 'visit_report', generated_copy: 'Her words' }));
  });
  it('an Auntie is refused editing a draft that is not exactly a KinTale draft, the words included', async () => {
    const env = await getEnv();
    await seedAll();
    await seed('generated_drafts/mixed-1', { ...mine, communicationType: 'push' });
    const db = asAuntie(env).firestore();
    for (const path of [PUSH, EMAIL, OLDER, 'generated_drafts/mixed-1']) {
      await assertFails(db.doc(path).update({ generatedCopy: 'Her words' }));
      await assertFails(db.doc(path).update({ generated_copy: 'Her words' }));
      await assertFails(db.doc(path).update({ status: 'approved' }));
    }
    for (const [i, type] of INEXACT_TYPES.entries()) {
      const path = `generated_drafts/odd-${String(i)}`;
      await seed(path, { ...base, communication_type: type });
      await assertFails(db.doc(path).update({ generatedCopy: 'Her words' }));
      await assertFails(db.doc(path).update({ status: 'approved' }));
    }
  });
  // ── #2443 ruling: an Auntie works only the KinTale drafts she made ─────────
  it('#2443: an Auntie is refused reading a KinTale draft another Auntie or the owner made, or one with no maker', async () => {
    const env = await getEnv();
    await seed('generated_drafts/hers-2', { ...tale, createdBy: 'auntie-2' });
    await seed('generated_drafts/owners', { ...tale, createdBy: 'owner-1' });
    await seed('generated_drafts/unstamped', tale);
    const db = asAuntie(env).firestore();
    for (const path of ['generated_drafts/hers-2', 'generated_drafts/owners', 'generated_drafts/unstamped']) {
      await assertFails(db.doc(path).get());
    }
    // The other Auntie reads her own.
    await assertSucceeds(asAuntie(env, 'auntie-2').firestore().doc('generated_drafts/hers-2').get());
  });
  it('#2443: a maker stamp that only looks like hers is not hers', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    for (const [i, stamp] of ['', ' auntie-1', 'auntie-1 ', 'AUNTIE-1', 7, null, ['auntie-1']].entries()) {
      const path = `generated_drafts/stamp-${String(i)}`;
      await seed(path, { ...tale, createdBy: stamp });
      await assertFails(db.doc(path).get());
    }
  });
  it('#2443: an Auntie lists only when her query says the drafts are hers', async () => {
    const env = await getEnv();
    await seedAll();
    await seed('generated_drafts/hers-2', { ...tale, createdBy: 'auntie-2' });
    await seed('generated_drafts/unstamped', tale);
    const db = asAuntie(env).firestore();
    const col = db.collection('generated_drafts');
    const kinTales = col.where('communication_type', '==', 'visit_report');
    await assertSucceeds(draftsQuery(db).get());
    // The type alone was enough before the ruling. It is not now.
    await assertFails(kinTales.get());
    await assertFails(kinTales.orderBy('createdOn', 'desc').limit(50).get());
    // Another maker's drafts, the owner's, and every maker but her.
    await assertFails(kinTales.where('createdBy', '==', 'auntie-2').get());
    await assertFails(kinTales.where('createdBy', '==', 'owner-1').get());
    await assertFails(kinTales.where('createdBy', 'in', ['auntie-1', 'auntie-2']).get());
    await assertFails(kinTales.where('createdBy', '!=', 'auntie-2').get());
    // Hers, but not only KinTale drafts.
    await assertFails(col.where('createdBy', '==', 'auntie-1').get());
  });
  it('#2443: what her list returns is her own KinTale drafts and nothing else', async () => {
    const env = await getEnv();
    await seedAll();
    await seed('generated_drafts/hers-2', { ...tale, createdBy: 'auntie-2' });
    await seed('generated_drafts/her-push', { ...push, createdBy: 'auntie-1' });
    const snap = await draftsQuery(asAuntie(env).firestore()).get();
    expect(snap.docs.map((d) => d.id)).toEqual(['tale-1']);
  });
  it('#2443: the owner reads and lists every draft whoever made it', async () => {
    const env = await getEnv();
    await seed('generated_drafts/hers-2', { ...tale, createdBy: 'auntie-2' });
    await seed(TALE, mine);
    await seed('generated_drafts/unstamped', tale);
    const db = asOwner(env).firestore();
    for (const path of [TALE, 'generated_drafts/hers-2', 'generated_drafts/unstamped']) {
      await assertSucceeds(db.doc(path).get());
    }
    const snap = await db.collection('generated_drafts').orderBy('createdOn', 'desc').limit(50).get();
    expect(snap.size).toBe(3);
  });
  it('#2443: a draft is created stamped with its maker or with no stamp, never with somebody else\'s uid', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    await assertSucceeds(db.doc('generated_drafts/new-own').set({ ...tale, createdBy: 'owner-1' }));
    await assertSucceeds(db.doc('generated_drafts/new-none').set(tale));
    await assertFails(db.doc('generated_drafts/new-hers').set({ ...tale, createdBy: 'auntie-1' }));
    await assertFails(db.doc('generated_drafts/new-blank').set({ ...tale, createdBy: '' }));
    await assertFails(db.doc('generated_drafts/new-null').set({ ...tale, createdBy: null }));
    await assertFails(db.collection('generated_drafts').add({ ...tale, createdBy: 'auntie-1' }));
  });
  it('#2443: nobody hands a draft to an Auntie, or takes one from her, by changing its maker', async () => {
    const env = await getEnv();
    await seed(TALE, mine);
    await seed('generated_drafts/unstamped', tale);
    const owner = asOwner(env).firestore();
    await assertFails(owner.doc('generated_drafts/unstamped').update({ createdBy: 'auntie-1' }));
    await assertFails(owner.doc(TALE).update({ createdBy: 'owner-1' }));
    await assertFails(owner.doc(TALE).update({ createdBy: 'auntie-2', generatedCopy: 'Final words' }));
    await assertFails(owner.doc(TALE).set({ ...tale, createdBy: 'auntie-2' }));
    // The owner's own edits leave the maker where it was and still go through.
    await assertSucceeds(owner.doc(TALE).update({ generatedCopy: 'Final words' }));
    await assertSucceeds(owner.doc(TALE).update({ createdBy: 'auntie-1', status: 'approved' }));
    const auntie = asAuntie(env).firestore();
    await assertFails(auntie.doc('generated_drafts/unstamped').update({ createdBy: 'auntie-1' }));
    await assertFails(auntie.doc(TALE).update({ createdBy: 'auntie-2' }));
  });
  // ── Everyone else ─────────────────────────────────────────────────────────
  it('an account carrying both roles is held to what an Auntie may do', async () => {
    const env = await getEnv();
    await seedAll();
    await seed('generated_drafts/tale-confused', { ...tale, createdBy: 'confused-1' });
    const db = asDoubleClaimed(env).firestore();
    await assertSucceeds(db.doc('generated_drafts/tale-confused').get());
    await assertFails(db.doc(TALE).get());
    await assertFails(db.doc(PUSH).get());
    await assertFails(db.doc('generated_drafts/new-1').set(tale));
    await assertFails(db.doc(TALE).update({ status: 'approved' }));
    await assertFails(db.doc(TALE).delete());
    await assertFails(db.collection('generated_drafts').get());
  });
  it('a household member and a signed-out visitor read and write no draft', async () => {
    const env = await getEnv();
    await seedAll();
    const kin = env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'f1' }).firestore();
    const out = env.unauthenticatedContext().firestore();
    for (const db of [kin, out]) {
      await assertFails(db.doc(TALE).get());
      await assertFails(db.collection('generated_drafts').where('communication_type', '==', 'visit_report').get());
      await assertFails(db.collection('generated_drafts').where('kinfolk_id', '==', 'f1').get());
      await assertFails(db.doc(TALE).update({ generatedCopy: 'x' }));
      await assertFails(db.doc('generated_drafts/new-1').set(tale));
      await assertFails(db.doc(TALE).delete());
    }
  });
});
