import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown, asUser } from './setup';

/**
 * `kinfolk/{kinfolkId}` is the AuntieOS canonical household record, and the
 * document issue #379 was filed about.
 *
 * The rule used to grant a whole-document read to the household itself. That
 * document carries `internalNotes`, which is staff-only: the admin UI labels it
 * "Anything that doesn't belong on the dossier yet" and renders it to staff as
 * an Auntie note callout. Firestore cannot mask a field on read, so the read
 * branch was the leak, and the fix is to withhold the document from the
 * household rather than to try to trim it.
 *
 * Every seed below puts a real note in `internalNotes` on purpose. A fixture
 * that seeded a bland document would let the read-denied assertions pass while
 * saying nothing about the field the issue was filed over.
 */

const NOTE = 'Owner disputes every invoice. Do not discount again.';

/** An AuntieOS operator: the `admin: true` custom claim isAuntie() keys on. */
function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('staff-1', { admin: true });
}

/** A signed-in household. Claim shape is what setKinfolkClaim writes. */
function asKinfolk(env: Awaited<ReturnType<typeof getEnv>>, kinfolkId: string, uid = 'u-kin') {
  return env.authenticatedContext(uid, { role: 'kinfolk', kinfolkId });
}

async function seedKinfolk(id: string): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`kinfolk/${id}`).set({
      firstName: 'Dana',
      lastName: 'Mercer',
      emergencyContactName: 'Rae Mercer',
      emergencyContactPhone: '805-555-0101',
      internalNotes: NOTE,
    });
  });
}

describe('rules: /kinfolk/{kinfolkId}', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  // The regression guard for #379. Before the fix this assertion failed,
  // because the household could read its own document whole, notes included.
  it('a household cannot read its OWN kinfolk document', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertFails(asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-1').get());
  });

  it("a household cannot read another household's kinfolk document", async () => {
    const env = await getEnv();
    await seedKinfolk('kin-2');
    await assertFails(asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-2').get());
  });

  it('a signed-in user with no kinfolk claim cannot read a kinfolk document', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertFails(asUser(env, 'u-stranger').firestore().doc('kinfolk/kin-1').get());
  });

  it('an Auntie still reads the whole document, notes included', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertSucceeds(asAuntie(env).firestore().doc('kinfolk/kin-1').get());
  });

  // The read denial must not take the self-service contact edits with it.
  // `onlyAllowedKinfolkFields()` diffs against `resource.data`, which the rules
  // engine evaluates server-side regardless of whether the caller could have
  // read the document, so the write branch stands on its own.
  it('a household can still update its allowlisted contact fields', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertSucceeds(
      asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-1').update({
        preferredContactMethod: 'text',
        bestTimeToContact: 'Mornings',
      }),
    );
  });

  // #829: the callable `saveEmergencyContacts` is the only way in. A household
  // writing its own flat field would put a second, unvalidated copy beside the
  // array that nobody checks against household members.
  it('a household cannot write a flat Emergency Contact field', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertFails(
      asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-1').update({ emergencyContactPhone: '805-555-0199' }),
    );
  });

  it('a household cannot write the emergencyContacts array', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertFails(
      asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-1').update({
        emergencyContacts: [{ name: 'Rae Mercer', phone: '+18055550199', relationship: null }],
      }),
    );
  });

  it('a household cannot write internalNotes', async () => {
    const env = await getEnv();
    await seedKinfolk('kin-1');
    await assertFails(
      asKinfolk(env, 'kin-1').firestore().doc('kinfolk/kin-1').update({ internalNotes: 'lovely people' }),
    );
  });
});
