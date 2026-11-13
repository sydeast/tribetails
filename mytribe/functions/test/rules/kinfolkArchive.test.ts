import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * #2161, operator ruling 2026-11-13: only the owner archives or restores a
 * Kinfolk household, and every archive and restore writes its Activity Log
 * line. The owner-only `setKinfolkArchived` callable is the one writer of the
 * archive fields, so no client may change them directly: not an Auntie, not
 * the household, not the sandbox test admin, and not the owner either (the
 * owner's archive goes through the callable, which writes the line).
 *
 * The other edits stay open: staff still move a household between active,
 * prospect and inactive, and still edit an archived household's other fields.
 */

type Env = Awaited<ReturnType<typeof getEnv>>;

const TEST_TRIBE = 'sandbox-tribe';

function asOwner(env: Env) {
  return env.authenticatedContext('owner-1', { admin: true });
}
function asAuntie(env: Env) {
  return env.authenticatedContext('auntie-1', { staffRole: 'auntie' });
}
function asDoubleClaimed(env: Env) {
  return env.authenticatedContext('confused-1', { admin: true, staffRole: 'auntie' });
}
function asKinfolk(env: Env, kinfolkId = 'kf1') {
  return env.authenticatedContext('household-1', { role: 'kinfolk', kinfolkId });
}
function asTestAdmin(env: Env) {
  return env.authenticatedContext('test-admin-uid', { testTribeId: TEST_TRIBE });
}

const ACTIVE = { firstName: 'Dre', lastName: 'East', status: 'active', archivedAt: '', archivedReason: '', archivedBy: '' };
const ARCHIVED = {
  firstName: 'Dre',
  lastName: 'East',
  status: 'archived',
  archivedAt: '2026-11-01T10:00:00.000Z',
  archivedReason: 'moved away',
  archivedBy: 'owner-1',
};
/** A household written before the archive fields existed: no status, no archive keys. */
const BARE = { firstName: 'Dre', lastName: 'East' };

async function seed(id: string, data: Record<string, unknown>) {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`kinfolk/${id}`).set(data);
  });
}

const ARCHIVE_PATCH = { status: 'archived', archivedAt: '2026-11-13T10:00:00.000Z', archivedReason: 'x', archivedBy: 'u' };
const RESTORE_PATCH = { status: 'active', archivedAt: '', archivedReason: '', archivedBy: '' };

describe('rules: #2161 no client archives a Kinfolk household directly', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('an Auntie cannot archive: status to archived alone', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    await assertFails(asAuntie(env).firestore().doc('kinfolk/kf1').update({ status: 'archived' }));
  });

  it('an Auntie cannot archive: the full archive write', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    await assertFails(asAuntie(env).firestore().doc('kinfolk/kf1').update(ARCHIVE_PATCH));
  });

  it('an Auntie cannot archive through a merge set', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    await assertFails(asAuntie(env).firestore().doc('kinfolk/kf1').set({ status: 'archived' }, { merge: true }));
  });

  it('an Auntie cannot archive with another spelling of archived', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    const ref = asAuntie(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ status: 'Archived' }));
    await assertFails(ref.update({ status: 'ARCHIVED' }));
    await assertFails(ref.update({ status: ' archived ' }));
  });

  it('an Auntie cannot archive a household that has no status on file', async () => {
    const env = await getEnv();
    await seed('kf1', BARE);
    await assertFails(asAuntie(env).firestore().doc('kinfolk/kf1').update({ status: 'archived' }));
  });

  it('an Auntie cannot write archivedAt, archivedReason or archivedBy on their own', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    const ref = asAuntie(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ archivedAt: '2026-11-13T10:00:00.000Z' }));
    await assertFails(ref.update({ archivedReason: 'moved away' }));
    await assertFails(ref.update({ archivedBy: 'auntie-1' }));
  });

  it('an account carrying both claims cannot archive', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    await assertFails(asDoubleClaimed(env).firestore().doc('kinfolk/kf1').update(ARCHIVE_PATCH));
  });

  it('a household cannot archive itself', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    await assertFails(asKinfolk(env).firestore().doc('kinfolk/kf1').update({ status: 'archived' }));
  });

  it('the owner archives through setKinfolkArchived, not a direct write', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    const ref = asOwner(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ status: 'archived' }));
    await assertFails(ref.update(ARCHIVE_PATCH));
    await assertFails(ref.update({ archivedReason: 'moved away' }));
  });

  it('the sandbox test admin cannot archive its own household directly', async () => {
    const env = await getEnv();
    await seed(TEST_TRIBE, ACTIVE);
    await assertFails(asTestAdmin(env).firestore().doc(`kinfolk/${TEST_TRIBE}`).update({ status: 'archived' }));
  });
});

describe('rules: #2161 no client restores a Kinfolk household directly', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('an Auntie cannot restore: status off archived alone', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    await assertFails(asAuntie(env).firestore().doc('kinfolk/kf1').update({ status: 'active' }));
  });

  it('an Auntie cannot restore to prospect or inactive either', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    const ref = asAuntie(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ status: 'prospect' }));
    await assertFails(ref.update({ status: 'inactive' }));
  });

  it('an Auntie cannot restore a household stored as Archived', async () => {
    const env = await getEnv();
    await seed('kf1', { ...ARCHIVED, status: 'Archived' });
    await assertFails(asAuntie(env).firestore().doc('kinfolk/kf1').update({ status: 'active' }));
  });

  it('an Auntie cannot restore: the full restore write', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    await assertFails(asAuntie(env).firestore().doc('kinfolk/kf1').update(RESTORE_PATCH));
  });

  it('an Auntie cannot clear the archive record of an archived household', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    const ref = asAuntie(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ archivedAt: '' }));
    await assertFails(ref.update({ archivedReason: '' }));
    await assertFails(ref.update({ archivedBy: '' }));
  });

  it('a household cannot restore itself', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    await assertFails(asKinfolk(env).firestore().doc('kinfolk/kf1').update({ status: 'active' }));
  });

  it('the owner restores through setKinfolkArchived, not a direct write', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    const ref = asOwner(env).firestore().doc('kinfolk/kf1');
    await assertFails(ref.update({ status: 'active' }));
    await assertFails(ref.update(RESTORE_PATCH));
  });
});

describe('rules: #2161 every other household edit still works', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the owner and an Auntie still move a household between active, prospect and inactive', async () => {
    const env = await getEnv();
    await seed('kf1', ACTIVE);
    await assertSucceeds(asOwner(env).firestore().doc('kinfolk/kf1').update({ status: 'prospect' }));
    await assertSucceeds(asAuntie(env).firestore().doc('kinfolk/kf1').update({ status: 'inactive' }));
    await assertSucceeds(asAuntie(env).firestore().doc('kinfolk/kf1').update({ status: 'active' }));
  });

  it('a household with no status on file can still be given one', async () => {
    const env = await getEnv();
    await seed('kf1', BARE);
    await assertSucceeds(asAuntie(env).firestore().doc('kinfolk/kf1').update({ status: 'active' }));
  });

  it('an Auntie still edits the other fields of an archived household', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    await assertSucceeds(asAuntie(env).firestore().doc('kinfolk/kf1').update({ gateCode: '1234', status: 'archived' }));
  });

  it('the owner still edits the other fields of an archived household', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    await assertSucceeds(asOwner(env).firestore().doc('kinfolk/kf1').update({ entryNotes: 'Side door' }));
  });

  it('a household still writes its own contact fields while archived', async () => {
    const env = await getEnv();
    await seed('kf1', ARCHIVED);
    await assertSucceeds(asKinfolk(env).firestore().doc('kinfolk/kf1').update({ secondaryPhone: '555-0100' }));
  });

  it('a household with no archive keys on file still takes an ordinary edit', async () => {
    const env = await getEnv();
    await seed('kf1', BARE);
    await assertSucceeds(asOwner(env).firestore().doc('kinfolk/kf1').update({ firstName: 'Andre' }));
  });
});
