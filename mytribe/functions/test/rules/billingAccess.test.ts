import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

/**
 * #1005. Operator ruling 2026-09-27: billing access is the business owner or
 * admin, the PRIMARY, and a SECONDARY only when the PRIMARY granted
 * `billing_full`. An Auntie never sees money.
 *
 * Three rule paths carry money:
 *   families/{fid}             accountBalanceCents
 *   invoices/{id}              every bill
 *   families/{fid}/invoices    the retired nested bills
 *
 * Each is pinned for PK, SK with billing, SK without billing, Auntie and owner.
 *
 * #1906: household reads match what the portal shows. The two invoice paths
 * have no household read at all now; bills reach a household only through
 * `getMyInvoices`, which leaves out every invoice the office has not sent and
 * asks billing access itself (test/draftInvoiceHidden.test.ts,
 * test/billingAccessGate.test.ts).
 */

type Env = Awaited<ReturnType<typeof getEnv>>;

const asOwner = (env: Env) => env.authenticatedContext('owner-1', { admin: true });
const asAuntie = (env: Env) =>
  env.authenticatedContext('auntie-1', { staffRole: 'auntie', role: 'kinfolk', kinfolkId: 'f1' });
/** A household member signed in to the portal: the claim `syncKinfolkClaim` mints. */
const asKin = (env: Env, uid: string) => asUser(env, uid, { role: 'kinfolk', kinfolkId: 'f1' });

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
  await seed('families/f1', { displayName: 'Test Tribe', accountBalanceCents: 1500 });
  await seed('invoices/inv1', { kinfolkId: 'f1', status: 'open', amountMinor: 5000 });
  await seed('invoices/draft1', { kinfolkId: 'f1', status: 'draft', amountMinor: 2800 });
  await seed('families/f1/invoices/old1', { amountMinor: 2500 });
}

describe('rules: #1005 families/{fid} carries the balance', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the PRIMARY reads it', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asUser(env, 'u-prim').firestore().doc('families/f1').get());
  });

  it('a SECONDARY granted billing reads it', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asUser(env, 'u-sk-bill').firestore().doc('families/f1').get());
  });

  it('a SECONDARY without billing is refused it, and still reads the member roster', async () => {
    const env = await getEnv();
    await household();
    const fs = asUser(env, 'u-sk-none').firestore();
    await assertFails(fs.doc('families/f1').get());
    await assertSucceeds(fs.doc('families/f1/members/u-prim').get());
  });

  it('a suspended SECONDARY that once held billing is refused', async () => {
    const env = await getEnv();
    await seedFamily({
      fid: 'f1',
      primaryUid: 'u-prim',
      secondaries: [{ uid: 'u-sk-gone', perms: { billing_full: true }, status: 'SUSPENDED' }],
    });
    await assertFails(asUser(env, 'u-sk-gone').firestore().doc('families/f1').get());
  });

  it('an Auntie is refused', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asAuntie(env).firestore().doc('families/f1').get());
  });

  it('the owner reads it', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asOwner(env).firestore().doc('families/f1').get());
  });
});

describe('rules: #1906 invoices/{id} has no household read', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  it('the PRIMARY reads neither a sent bill nor an unsent draft directly', async () => {
    const env = await getEnv();
    await household();
    const fs = asKin(env, 'u-prim').firestore();
    await assertFails(fs.doc('invoices/inv1').get());
    await assertFails(fs.doc('invoices/draft1').get());
  });
  it('a SECONDARY granted billing is refused the same', async () => {
    const env = await getEnv();
    await household();
    const fs = asKin(env, 'u-sk-bill').firestore();
    await assertFails(fs.doc('invoices/inv1').get());
    await assertFails(fs.doc('invoices/draft1').get());
  });
  it('a SECONDARY without billing is refused, though the claim names the household', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asKin(env, 'u-sk-none').firestore().doc('invoices/inv1').get());
  });
  it('no household member can list them, billing or not', async () => {
    const env = await getEnv();
    await household();
    for (const uid of ['u-prim', 'u-sk-bill', 'u-sk-none', 'u-legacy']) {
      await assertFails(
        asKin(env, uid).firestore().collection('invoices').where('kinfolkId', '==', 'f1').get(),
      );
    }
  });
  it('a legacy primary with no member doc is refused too', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asKin(env, 'u-legacy').firestore().doc('invoices/inv1').get());
  });
  it('an Auntie holding the household claim is refused', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asAuntie(env).firestore().doc('invoices/inv1').get());
  });
  it('the owner reads every bill, drafts included, and lists them', async () => {
    const env = await getEnv();
    await household();
    const fs = asOwner(env).firestore();
    await assertSucceeds(fs.doc('invoices/inv1').get());
    await assertSucceeds(fs.doc('invoices/draft1').get());
    await assertSucceeds(fs.collection('invoices').where('kinfolkId', '==', 'f1').get());
  });
  it('no one writes a bill directly, the owner included', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asOwner(env).firestore().doc('invoices/inv1').update({ amountMinor: 1 }));
    await assertFails(asKin(env, 'u-prim').firestore().doc('invoices/inv1').update({ amountMinor: 1 }));
  });
});
describe('rules: #1906 the retired nested invoice path has no household read', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());
  it('neither the PRIMARY nor a SECONDARY, billing or not, reads it', async () => {
    const env = await getEnv();
    await household();
    for (const uid of ['u-prim', 'u-sk-bill', 'u-sk-none']) {
      await assertFails(asUser(env, uid).firestore().doc('families/f1/invoices/old1').get());
    }
  });
  it('an Auntie is refused and the owner reads it', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asAuntie(env).firestore().doc('families/f1/invoices/old1').get());
    await assertSucceeds(asOwner(env).firestore().doc('families/f1/invoices/old1').get());
  });
});
