import { afterAll, afterEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { cleanup, getEnv, shutdown } from './setup';

/**
 * #2037: `visit_step_notices/{id}` is the server's record of what a household
 * was told about one clock step. The admin clients read it for the sentence on
 * the visit card. Staff read it; a household never does; nobody but the server
 * writes it.
 */
const NOTICE = 'visit_step_notices/s1__arrived__1794348000000';
const RECORD = { sessionId: 's1', action: 'ARRIVED', event: 'arrived', atMs: 1794348000000, notified: true, reason: null };

async function seed() {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(NOTICE).set(RECORD);
  });
  return env;
}

describe('rules: visit_step_notices (#2037)', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the owner reads it', async () => {
    const env = await seed();
    await assertSucceeds(env.authenticatedContext('staff-1', { admin: true }).firestore().doc(NOTICE).get());
  });

  it('an Auntie reads it', async () => {
    const env = await seed();
    await assertSucceeds(env.authenticatedContext('auntie-1', { staffRole: 'auntie' }).firestore().doc(NOTICE).get());
  });

  it('a household cannot read it', async () => {
    const env = await seed();
    await assertFails(env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'f1' }).firestore().doc(NOTICE).get());
  });

  it('no account cannot read it', async () => {
    const env = await seed();
    await assertFails(env.unauthenticatedContext().firestore().doc(NOTICE).get());
  });

  it('no client writes it, the owner included', async () => {
    const env = await seed();
    const owner = env.authenticatedContext('staff-1', { admin: true }).firestore();
    await assertFails(owner.doc(NOTICE).set({ ...RECORD, notified: false }));
    await assertFails(owner.doc('visit_step_notices/new').set(RECORD));
    await assertFails(owner.doc(NOTICE).delete());
    await assertFails(env.authenticatedContext('auntie-1', { staffRole: 'auntie' }).firestore().doc(NOTICE).set(RECORD));
  });
});
