import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';
/**
 * D-2026-09-28-VISIT-PRICES-ARE-BILLING (#1037). Operator ruling 2026-09-28:
 * "visit prices are billing information; hide them from members without
 * billing access."
 *
 * Two rule paths let a household member read a visit price straight from the
 * SDK:
 *   families/{fid}/bookings/{batchId}/kinCares/{visitId}   priceCents
 *   base_services, supplemental_services, surcharges, discounts   the price list
 *
 * The envelope `families/{fid}/bookings/{batchId}` carries no amount and stays
 * readable by every active member; it is pinned here so it does not tighten by
 * accident.
 */
type Env = Awaited<ReturnType<typeof getEnv>>;
const asOwner = (env: Env) => env.authenticatedContext('owner-1', { admin: true });
const asAuntie = (env: Env) =>
  env.authenticatedContext('auntie-1', { staffRole: 'auntie', role: 'kinfolk', kinfolkId: 'f1' });
const VISIT = 'families/f1/bookings/b1/kinCares/v1';
const ENVELOPE = 'families/f1/bookings/b1';
const PRICED_CATALOG = ['base_services', 'supplemental_services', 'surcharges', 'discounts'];
async function seed(path: string, data: Record<string, unknown>) {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(path).set(data);
  });
}
async function household() {
  await seedFamily({
    fid: 'f1',
    primaryUid: 'u-prim',
    secondaries: [
      { uid: 'u-sk-bill', perms: { billing_full: true } },
      { uid: 'u-sk-none', perms: { billing_full: false } },
    ],
  });
  await seed(ENVELOPE, { familyId: 'f1', targetType: 'KIN', envelopeStatus: 'requested' });
  await seed(VISIT, { familyId: 'f1', targetType: 'KIN', status: 'requested', priceCents: 2500 });
  for (const col of PRICED_CATALOG) await seed(`${col}/doc1`, { name: 'Walk', priceCents: 2500 });
  await seed('business_hours/doc1', { open: '08:00' });
}
describe('rules: #1037 a visit document carries its price', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  it('the PRIMARY reads the visit', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asUser(env, 'u-prim').firestore().doc(VISIT).get());
  });
  it('a SECONDARY granted billing reads the visit', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asUser(env, 'u-sk-bill').firestore().doc(VISIT).get());
  });
  it('a SECONDARY without billing is refused the visit, and still reads the envelope', async () => {
    const env = await getEnv();
    await household();
    const fs = asUser(env, 'u-sk-none').firestore();
    await assertFails(fs.doc(VISIT).get());
    await assertSucceeds(fs.doc(ENVELOPE).get());
  });
  it('a SECONDARY without billing cannot list the visits either', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asUser(env, 'u-sk-none').firestore().collection(`${ENVELOPE}/kinCares`).get());
  });
  it('a SECONDARY without billing can still move a visit it may move (writes do not need the read)', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(
      asUser(env, 'u-sk-none').firestore().doc(VISIT).update({ notes: 'Side gate', updatedAt: new Date() }),
    );
  });
  it('the owner and the Auntie read the visit (staff)', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asOwner(env).firestore().doc(VISIT).get());
    await assertSucceeds(asAuntie(env).firestore().doc(VISIT).get());
  });
  it('a stranger is refused the visit', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asUser(env, 'u-stranger').firestore().doc(VISIT).get());
  });
});
describe('rules: #1037 the price-carrying catalog collections are staff reads', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  it('no household member reads them, billing or not; they come through getServiceCatalog', async () => {
    const env = await getEnv();
    await household();
    for (const uid of ['u-prim', 'u-sk-bill', 'u-sk-none']) {
      const fs = asUser(env, uid, { role: 'kinfolk', kinfolkId: 'f1' }).firestore();
      for (const col of PRICED_CATALOG) await assertFails(fs.doc(`${col}/doc1`).get());
    }
  });
  it('the owner and the Auntie read them', async () => {
    const env = await getEnv();
    await household();
    for (const col of PRICED_CATALOG) {
      await assertSucceeds(asOwner(env).firestore().doc(`${col}/doc1`).get());
      await assertSucceeds(asAuntie(env).firestore().doc(`${col}/doc1`).get());
    }
  });
  it('the Stage-0I test admin reads them', async () => {
    const env = await getEnv();
    await household();
    const fs = env.authenticatedContext('test-admin', { testTribeId: 'f1' }).firestore();
    for (const col of PRICED_CATALOG) await assertSucceeds(fs.doc(`${col}/doc1`).get());
  });
  it('business_hours carries no price and stays readable by any signed-in account', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asUser(env, 'u-sk-none').firestore().doc('business_hours/doc1').get());
  });
});
