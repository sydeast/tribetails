import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

/**
 * #957: `business_settings/email_frame` is server-only. Its values go into
 * every email's markup, so the only way in is the owner-only getEmailFrame /
 * saveEmailFrame callables, which validate each field. The exclusion lives on
 * the `business_settings/{docId}` wildcard itself, because a separate deny
 * block would be overridden by the wildcard's allow.
 */

function asOwner(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('owner-1', { admin: true });
}

function asAuntieRole(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('auntie-1', { staffRole: 'auntie' });
}

function asTestAdmin(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('test-admin-uid', { testTribeId: 'test-kinfolk-001' });
}

async function seedFrame(): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc('business_settings/email_frame').set({
      accentColor: '#123456',
      updatedAt: '2026-09-28T00:00:00.000Z',
      updatedBy: 'owner-1',
    });
  });
}

describe('rules: business_settings/email_frame', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the owner cannot read it directly', async () => {
    const env = await getEnv();
    await seedFrame();
    await assertFails(asOwner(env).firestore().doc('business_settings/email_frame').get());
  });

  it('the owner cannot write it directly, which would skip validation', async () => {
    const env = await getEnv();
    await assertFails(
      asOwner(env).firestore().doc('business_settings/email_frame').set({ accentColor: 'red; } body { x' }),
    );
  });

  it('an Auntie, the test admin and a kinfolk are all refused', async () => {
    const env = await getEnv();
    await seedFrame();
    await assertFails(asAuntieRole(env).firestore().doc('business_settings/email_frame').get());
    await assertFails(asTestAdmin(env).firestore().doc('business_settings/email_frame').get());
    await assertFails(asUser(env, 'u-kinfolk').firestore().doc('business_settings/email_frame').get());
    await assertFails(
      asAuntieRole(env).firestore().doc('business_settings/email_frame').set({ accentColor: '#000000' }),
    );
  });

  it('the owner still reads and writes the main settings document', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asOwner(env).firestore().doc('business_settings/business_settings').set({ timeZone: 'America/Los_Angeles' }),
    );
    await assertSucceeds(asOwner(env).firestore().doc('business_settings/business_settings').get());
    await assertSucceeds(
      asOwner(env).firestore().doc('business_settings/feature_flags').set({ flags: {} }),
    );
  });
});
