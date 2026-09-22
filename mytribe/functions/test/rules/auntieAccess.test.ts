import { afterAll, afterEach, describe, it } from 'vitest';
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
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('business_settings/business_settings').get());
    await assertFails(db.doc('business_settings/business_settings').set({ timeZone: 'UTC' }, { merge: true }));
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
   * The downstream feed itself is not tested here and cannot be: onKinTaleCreate
   * seeds reconcileStatus and the nightly Python reconcile writes the three
   * banks, both on the Admin SDK, which does not evaluate rules at all. What
   * these rules have to guarantee is that the Auntie's write LANDS, because
   * that write is what the trigger fires on. The two tests above are that
   * guarantee. test/kinTaleFeedAuntie.emulator.test.ts carries the trigger half.
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
