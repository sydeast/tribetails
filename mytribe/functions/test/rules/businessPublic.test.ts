import { afterAll, afterEach, describe, it } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { cleanup, getEnv, shutdown } from './setup';

/**
 * #1321: `business_public/card` is the sign-in screen's source for the business
 * name, read before there is a user. Anyone may read it; no client may write
 * it, the owner included, because the only honest writer is the
 * `onBusinessSettingsWrite` trigger, and a client write here would put a name
 * of its choosing on every household's sign-in screen.
 */
const CARD = 'business_public/card';
const PUBLIC_CARD = {
  name: 'Sunny Paws',
  phone: '555-0142',
  hours: { Monday: '09:00-17:00', Tuesday: '', Wednesday: '', Thursday: '', Friday: '', Saturday: '', Sunday: '' },
  privacyPolicyUrl: '',
};

async function seedCard() {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(CARD).set(PUBLIC_CARD);
  });
  return env;
}

describe('rules: business_public/card (#1321)', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('is readable with no account at all', async () => {
    const env = await seedCard();
    await assertSucceeds(env.unauthenticatedContext().firestore().doc(CARD).get());
  });

  it('is readable by a signed-in household member', async () => {
    const env = await seedCard();
    await assertSucceeds(env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'f1' }).firestore().doc(CARD).get());
  });

  it('cannot be written anonymously', async () => {
    const env = await seedCard();
    await assertFails(env.unauthenticatedContext().firestore().doc(CARD).set({ ...PUBLIC_CARD, name: 'Not Them' }));
  });

  it('cannot be written by a household', async () => {
    const env = await seedCard();
    await assertFails(
      env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'f1' }).firestore().doc(CARD).set({ ...PUBLIC_CARD, name: 'Not Them' }),
    );
  });

  it('cannot be written by the owner either: the trigger is the only writer', async () => {
    const env = await seedCard();
    await assertFails(env.authenticatedContext('staff-1', { admin: true }).firestore().doc(CARD).update({ name: 'Renamed' }));
    await assertFails(env.authenticatedContext('staff-1', { admin: true }).firestore().doc(CARD).delete());
  });

  it('a second document in the collection is readable too, so #1411 can add one without a rules change', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('business_public/about').set({ name: 'Sunny Paws' });
    });
    await assertSucceeds(env.unauthenticatedContext().firestore().doc('business_public/about').get());
  });

  it('business_settings itself stays closed to the public', async () => {
    const env = await getEnv();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('business_settings/business_settings').set({ businessName: 'Sunny Paws' });
    });
    await assertFails(env.unauthenticatedContext().firestore().doc('business_settings/business_settings').get());
    await assertFails(env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: 'f1' }).firestore().doc('business_settings/business_settings').get());
  });
});
