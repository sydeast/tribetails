import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';
/** An AuntieOS operator: the `admin: true` custom claim isAuntie() keys on. */
function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('staff-1', { admin: true });
}

/**
 * ISSUE #519: `business_settings.allowClientLocationSharing` at the one
 * kinfolk-facing coordinate path that does NOT go through a callable.
 *
 * MyTribe subscribes to `kin_care_sessions/{id}/breadcrumbs` directly for live
 * tracking (`mytribe/web/src/lib/breadcrumbs.ts:18`), so gating only the two
 * portal callables would have left the live map streaming coordinates the
 * operator had switched off. Rules are the only place that read can be refused.
 *
 * These cases fail against the old rule, which had no `business_settings` check
 * at all: on it, the "switched off" case succeeds.
 */
describe('rules: breadcrumbs honour allowClientLocationSharing', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  /** One session owned by `k1`, one ping under it, and a settings doc. */
  async function seed(sharing: boolean | undefined): Promise<void> {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc('kin_care_sessions/s1').set({ kinfolkId: 'k1', status: 'ARRIVED' });
      await db.doc('kin_care_sessions/s1/breadcrumbs/b1').set({ lat: 30.1, lng: -97.7, timestamp: Date.now() });
      const settings: Record<string, unknown> = { businessName: 'Tribe Tails' };
      if (sharing !== undefined) settings['allowClientLocationSharing'] = sharing;
      await db.doc('business_settings/business_settings').set(settings);
    });
  }

  const KINFOLK_CLAIM = { role: 'kinfolk', kinfolkId: 'k1' };
  const CRUMB = 'kin_care_sessions/s1/breadcrumbs/b1';

  it('a kinfolk CAN read their own breadcrumbs when sharing is on', async () => {
    const env = await getEnv();
    await seed(true);
    await assertSucceeds(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(CRUMB).get());
  });

  it('a kinfolk CAN read them when the key is absent, so no deploy blanks a live map', async () => {
    const env = await getEnv();
    await seed(undefined);
    await assertSucceeds(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(CRUMB).get());
  });

  it('a kinfolk CANNOT read them once the operator switches sharing off', async () => {
    const env = await getEnv();
    await seed(false);
    await assertFails(asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().doc(CRUMB).get());
  });

  it('the collection listing is refused too, not just the single doc', async () => {
    const env = await getEnv();
    await seed(false);
    await assertFails(
      asUser(env, 'u-kin', KINFOLK_CLAIM).firestore().collection('kin_care_sessions/s1/breadcrumbs').get(),
    );
  });

  /** The switch is about what KINFOLK see. The operator's own read is untouched. */
  it('the operator can still read breadcrumbs with sharing off', async () => {
    const env = await getEnv();
    await seed(false);
    await assertSucceeds(asAuntie(env).firestore().doc(CRUMB).get());
  });

  it('a kinfolk still cannot read ANOTHER household breadcrumbs with sharing on', async () => {
    const env = await getEnv();
    await seed(true);
    await assertFails(
      asUser(env, 'u-other', { role: 'kinfolk', kinfolkId: 'k2' }).firestore().doc(CRUMB).get(),
    );
  });
});
