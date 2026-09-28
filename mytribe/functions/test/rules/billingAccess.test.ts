import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, seedFamily, asUser } from './setup';

/**
 * #1005. Operator ruling 2026-09-27: billing access is the business owner or
 * admin, the PRIMARY, and a SECONDARY only when the PRIMARY granted
 * `billing_full`. An Auntie never sees money.
 *
 * Three rule paths carry money a household member could read directly:
 *   families/{fid}             accountBalanceCents
 *   invoices/{id}              every bill, through the kinfolk claim branch
 *   families/{fid}/invoices    the retired nested bills, still readable
 *
 * Each is pinned for PK, SK with billing, SK without billing, Auntie and owner.
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
  await seed('invoices/inv1', { kinfolkId: 'f1', amountMinor: 5000 });
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

describe('rules: #1005 invoices/{id} through the kinfolk claim', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the PRIMARY reads the household bill', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asKin(env, 'u-prim').firestore().doc('invoices/inv1').get());
  });

  it('a SECONDARY granted billing reads it', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asKin(env, 'u-sk-bill').firestore().doc('invoices/inv1').get());
  });

  it('a SECONDARY without billing is refused, though the claim names the household', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asKin(env, 'u-sk-none').firestore().doc('invoices/inv1').get());
  });

  it('a SECONDARY without billing cannot list them either', async () => {
    const env = await getEnv();
    await household();
    await assertFails(
      asKin(env, 'u-sk-none').firestore().collection('invoices').where('kinfolkId', '==', 'f1').get(),
    );
  });

  it('the PRIMARY can list them', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(
      asKin(env, 'u-prim').firestore().collection('invoices').where('kinfolkId', '==', 'f1').get(),
    );
  });

  it('a legacy primary with no member doc keeps reading them', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asKin(env, 'u-legacy').firestore().doc('invoices/inv1').get());
  });

  it('an Auntie holding the household claim is refused', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asAuntie(env).firestore().doc('invoices/inv1').get());
  });

  it('the owner reads it', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asOwner(env).firestore().doc('invoices/inv1').get());
  });
});

describe('rules: #1005 the retired nested invoice path', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the PRIMARY and a SECONDARY granted billing read it', async () => {
    const env = await getEnv();
    await household();
    await assertSucceeds(asUser(env, 'u-prim').firestore().doc('families/f1/invoices/old1').get());
    await assertSucceeds(asUser(env, 'u-sk-bill').firestore().doc('families/f1/invoices/old1').get());
  });

  it('a SECONDARY without billing is refused', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asUser(env, 'u-sk-none').firestore().doc('families/f1/invoices/old1').get());
  });

  it('an Auntie is refused and the owner reads it', async () => {
    const env = await getEnv();
    await household();
    await assertFails(asAuntie(env).firestore().doc('families/f1/invoices/old1').get());
    await assertSucceeds(asOwner(env).firestore().doc('families/f1/invoices/old1').get());
  });
});
