import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

// Security regression tests for /clients/{uid}.
//
// The portal's entire tenant boundary trusts clients/{uid}.kinfolkIds (and
// familyIds): resolveKinfolkAccess() / resolveKinfolkId() authorize a request by
// checking the requested kinfolkId is contained in that array, and onClientsWrite
// mints the custom claim kinfolkId = kinfolkIds[0]. Those arrays must therefore be
// writable ONLY by Cloud Functions (Admin SDK bypasses rules, e.g. acceptInvite's
// arrayUnion). A signed-in client must never be able to self-assign them, on
// create or update, or it can read every other tribe's data.

async function seedClient(uid: string, data: Record<string, unknown>): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`clients/${uid}`).set(data);
  });
}

describe('rules: /clients/{uid}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('owner can update an allowed profile field', async () => {
    const env = await getEnv();
    await seedClient('u-a', { email: 'a@x.com', displayName: 'A', kinfolkIds: ['tribe-a'] });
    await assertSucceeds(
      asUser(env, 'u-a').firestore().doc('clients/u-a').update({ displayName: 'A2' }),
    );
  });

  it('owner CANNOT self-assign kinfolkIds (tenant-boundary tamper)', async () => {
    const env = await getEnv();
    await seedClient('u-a', { email: 'a@x.com', kinfolkIds: ['tribe-a'] });
    await assertFails(
      asUser(env, 'u-a').firestore().doc('clients/u-a').update({ kinfolkIds: ['victim-tribe'] }),
    );
  });

  it('owner CANNOT add a foreign tribe to kinfolkIds via arrayUnion-style write', async () => {
    const env = await getEnv();
    await seedClient('u-a', { email: 'a@x.com', kinfolkIds: ['tribe-a'] });
    await assertFails(
      asUser(env, 'u-a').firestore().doc('clients/u-a')
        .update({ kinfolkIds: ['tribe-a', 'victim-tribe'] }),
    );
  });

  it('owner CANNOT self-assign familyIds', async () => {
    const env = await getEnv();
    await seedClient('u-a', { email: 'a@x.com', familyIds: ['fam-a'] });
    await assertFails(
      asUser(env, 'u-a').firestore().doc('clients/u-a').update({ familyIds: ['victim-fam'] }),
    );
  });

  it('owner CANNOT smuggle kinfolkIds alongside an allowed field', async () => {
    const env = await getEnv();
    await seedClient('u-a', { email: 'a@x.com' });
    await assertFails(
      asUser(env, 'u-a').firestore().doc('clients/u-a')
        .update({ displayName: 'A2', kinfolkIds: ['victim-tribe'] }),
    );
  });

  it('owner can create their own clients doc with just email', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asUser(env, 'u-new').firestore().doc('clients/u-new').set({ email: 'new@x.com' }),
    );
  });

  it('owner CANNOT create their clients doc pre-loaded with kinfolkIds', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-new').firestore().doc('clients/u-new')
        .set({ email: 'new@x.com', kinfolkIds: ['victim-tribe'] }),
    );
  });

  it('owner CANNOT create their clients doc pre-loaded with familyIds', async () => {
    const env = await getEnv();
    await assertFails(
      asUser(env, 'u-new').firestore().doc('clients/u-new')
        .set({ email: 'new@x.com', familyIds: ['victim-fam'] }),
    );
  });

  it('a stranger cannot write someone else clients doc', async () => {
    const env = await getEnv();
    await seedClient('u-a', { email: 'a@x.com' });
    await assertFails(
      asUser(env, 'u-stranger').firestore().doc('clients/u-a').update({ displayName: 'hax' }),
    );
  });
});
