import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * #1951. A household's phone and email are checked on every direct update,
 * the same shapes `createKinfolk` checks on create and every admin form checks
 * before it sends. The admin clients write `kinfolk/{id}` directly on an edit,
 * so these rules are the server path that holds it. Only a changed value is
 * checked: a household saved before #1951 with a bad value still takes an
 * edit to any other field.
 */

type Env = Awaited<ReturnType<typeof getEnv>>;

function asOwner(env: Env) {
  return env.authenticatedContext('owner-1', { admin: true });
}
function asAuntie(env: Env) {
  return env.authenticatedContext('auntie-1', { staffRole: 'auntie' });
}
function asKinfolk(env: Env) {
  return env.authenticatedContext('household-1', { role: 'kinfolk', kinfolkId: 'kf1' });
}

const GOOD = {
  firstName: 'Dre',
  lastName: 'East',
  status: 'active',
  phoneNumber: '(805) 555-0134',
  secondaryPhone: '',
  email: 'catch@hanasamku.com',
  secondaryEmail: '',
};

async function seed(data: Record<string, unknown>) {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc('kinfolk/kf1').set(data);
  });
}

describe('rules: #1951 household phone and email shapes on update', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('refuses letters for a phone number', async () => {
    const env = await getEnv();
    await seed(GOOD);
    await assertFails(asOwner(env).firestore().doc('kinfolk/kf1').update({ phoneNumber: 'abc' }));
    await assertFails(asAuntie(env).firestore().doc('kinfolk/kf1').update({ secondaryPhone: 'xyz' }));
  });

  it('refuses a phone number with too few or too many digits', async () => {
    const env = await getEnv();
    await seed(GOOD);
    const ref = asOwner(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ phoneNumber: '555-0134' }));
    await assertFails(ref.update({ phoneNumber: '805 555 01345' }));
    await assertFails(ref.update({ phoneNumber: '2 805 555 0134' }));
  });

  it('refuses an email with no @ sign or no domain', async () => {
    const env = await getEnv();
    await seed(GOOD);
    const ref = asOwner(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ email: 'catch' }));
    await assertFails(ref.update({ email: 'catch@hanasamku' }));
    await assertFails(ref.update({ email: 'catch@hanasamku..com' }));
    await assertFails(ref.update({ secondaryEmail: 'pawsome' }));
  });

  it('takes a 10 digit, an 11 digit and an E.164 phone, and a blank one', async () => {
    const env = await getEnv();
    await seed(GOOD);
    const ref = asOwner(env).firestore().doc('kinfolk/kf1');
    await assertSucceeds(ref.update({ phoneNumber: '805-555-0135' }));
    await assertSucceeds(ref.update({ phoneNumber: '1 (805) 555-0136' }));
    await assertSucceeds(ref.update({ phoneNumber: '+18055550137' }));
    await assertSucceeds(ref.update({ secondaryPhone: '' }));
  });

  it('takes a real address and a blank one', async () => {
    const env = await getEnv();
    await seed(GOOD);
    const ref = asAuntie(env).firestore().doc('kinfolk/kf1');
    await assertSucceeds(ref.update({ email: 'pawsome@hanasamku.com' }));
    await assertSucceeds(ref.update({ secondaryEmail: '' }));
  });

  it('a household saved with a bad phone before #1951 still takes an edit to another field', async () => {
    const env = await getEnv();
    await seed({ ...GOOD, phoneNumber: 'abc', email: 'catch' });
    await assertSucceeds(asOwner(env).firestore().doc('kinfolk/kf1').update({ gateCode: '1234' }));
    await assertSucceeds(asOwner(env).firestore().doc('kinfolk/kf1').set({ ...GOOD, phoneNumber: 'abc', email: 'catch', entryNotes: 'Side door' }));
  });

  it('every legacy contact field, secondary ones included, re-sent unchanged by an Auntie still saves', async () => {
    const env = await getEnv();
    const LEGACY = { ...GOOD, phoneNumber: '555-0134 ext 2', secondaryPhone: 'call me', email: 'catch', secondaryEmail: 'pawsome' };
    await seed(LEGACY);
    const ref = asAuntie(env).firestore().doc('kinfolk/kf1');
    await assertSucceeds(ref.update({ ...LEGACY, gateCode: '4321' }));
    // A changed legacy value is checked: to another bad one fails, to a good one saves.
    await assertFails(ref.update({ secondaryPhone: 'call me later' }));
    await assertFails(ref.update({ secondaryEmail: 'pawsome2' }));
    await assertSucceeds(ref.update({ secondaryPhone: '(805) 555-0139', secondaryEmail: 'pawsome@hanasamku.com' }));
  });

  it('a household with no contact keys on file, or null ones, still takes an ordinary edit', async () => {
    const env = await getEnv();
    await seed({ firstName: 'Dre', lastName: 'East', status: 'active', phoneNumber: null });
    const ref = asOwner(env).firestore().doc('kinfolk/kf1');
    await assertSucceeds(ref.update({ entryNotes: 'Side door' }));
    await assertSucceeds(ref.update({ secondaryEmail: '' }));
  });

  it('the household is held to the same shapes on its own contact fields', async () => {
    const env = await getEnv();
    await seed(GOOD);
    const ref = asKinfolk(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ secondaryPhone: 'call me' }));
    await assertFails(ref.update({ secondaryEmail: 'pawsome' }));
    await assertSucceeds(ref.update({ secondaryPhone: '(805) 555-0138' }));
    await assertSucceeds(ref.update({ secondaryEmail: 'pawsome@hanasamku.com' }));
  });
});
