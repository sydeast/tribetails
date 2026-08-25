import { afterAll, afterEach, describe, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * Issue #577: `media_files` deletes are CALLABLE-ONLY.
 *
 * WHY THE RULE EXISTS. Deleting a media row is a two-collection invariant.
 * `setMediaProfilePhoto` stamps `kinfolk/{id}.profilePictureUrl`,
 * `kin/{id}.profilePictureUrl` or `users/{uid}.photoUrl` with the media doc's
 * own `storageUrl`. Drop the row from a client and the gallery forgets the
 * photo while the profile keeps rendering it, with no row left anywhere in the
 * app able to clear that field again, and no audit entry, at the one moment
 * the deleted row was the only record the file ever existed. The
 * `deleteMediaFile` callable (functions/src/admin/deleteMediaFile.ts) does both
 * writes in one batch, clears the photo field ONLY when it points at this file,
 * refuses a wrong-entity id, and writes the `MEDIA_FILE_DELETED` audit entry.
 * The admin SDK bypasses these rules, so denying `delete` here leaves exactly
 * one way in: the same stance `training_documents` already takes.
 *
 * PR #568 shipped the callable and repointed React and Android at it but
 * deliberately left this rule open, because the desktop admin
 * (`auntieos-admin/web/composeApp`) was still writing `media_files` from the
 * client. It no longer is, so the rule closes here, in the same change.
 *
 * WHAT MUST STILL WORK, and is pinned below so a future tightening cannot take
 * it away by accident:
 *   - `create`: the upload pipelines are all direct client `addDoc`s
 *     (`api/mediaUpload.ts`, `JvmMediaUpload`, Android's repository).
 *   - `update`: #397 S3 caption editing writes `description` straight from the
 *     client, and `taggedKinIds` stays server-bound (#447).
 */

/** An AuntieOS operator: the `admin: true` custom claim isAuntie() keys on. */
function asAuntie(env: Awaited<ReturnType<typeof getEnv>>) {
  return env.authenticatedContext('staff-1', { admin: true });
}

/** A Stage-0I test admin: testTribeId claim, deliberately NO admin claim. */
function asTestAdmin(env: Awaited<ReturnType<typeof getEnv>>, uid = 'test-admin-uid') {
  return env.authenticatedContext(uid, { testTribeId: 'test-kinfolk-001' });
}

const TEST_TRIBE = 'test-kinfolk-001';

async function seedMedia(env: Awaited<ReturnType<typeof getEnv>>, id: string, kinfolkId: string) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`media_files/${id}`).set({
      kinfolkId,
      entityId: 'kf-1',
      entityType: 'KINFOLK',
      storageUrl: 'https://cdn/x.jpg',
      description: 'Beach day',
      taggedKinIds: ['k1'],
    });
  });
}

describe('rules: media_files deletes are callable-only (#577)', () => {
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('an OPERATOR cannot delete a media_files doc from the client', async () => {
    const env = await getEnv();
    await seedMedia(env, 'mf-del-1', TEST_TRIBE);
    await assertFails(asAuntie(env).firestore().doc('media_files/mf-del-1').delete());
  });

  it('a sandbox test admin cannot delete its OWN media_files doc either', async () => {
    const env = await getEnv();
    await seedMedia(env, `${TEST_TRIBE}-mf-del-2`, TEST_TRIBE);
    await assertFails(
      asTestAdmin(env).firestore().doc(`media_files/${TEST_TRIBE}-mf-del-2`).delete(),
    );
  });

  it('a signed-in non-admin cannot delete one, as before', async () => {
    const env = await getEnv();
    await seedMedia(env, 'mf-del-3', TEST_TRIBE);
    await assertFails(
      env.authenticatedContext('kin-1').firestore().doc('media_files/mf-del-3').delete(),
    );
  });

  // ── the two client paths the delete rule must NOT take down ────────────────

  it('caption editing (#397 S3) still succeeds: an operator can update description', async () => {
    const env = await getEnv();
    await seedMedia(env, 'mf-cap-1', TEST_TRIBE);
    await assertSucceeds(
      asAuntie(env).firestore().doc('media_files/mf-cap-1').update({ description: 'Sandy nose' }),
    );
  });

  it('caption editing still succeeds for a sandbox test admin on its own doc', async () => {
    const env = await getEnv();
    await seedMedia(env, `${TEST_TRIBE}-mf-cap-2`, TEST_TRIBE);
    await assertSucceeds(
      asTestAdmin(env)
        .firestore()
        .doc(`media_files/${TEST_TRIBE}-mf-cap-2`)
        .update({ description: 'Sandy nose' }),
    );
  });

  it('taggedKinIds stays server-bound (#447): an operator update touching it is still refused', async () => {
    const env = await getEnv();
    await seedMedia(env, 'mf-tag-1', TEST_TRIBE);
    await assertFails(
      asAuntie(env).firestore().doc('media_files/mf-tag-1').update({ taggedKinIds: ['k9'] }),
    );
  });

  it('the upload pipelines still write: a client CREATE succeeds', async () => {
    const env = await getEnv();
    await assertSucceeds(
      asAuntie(env).firestore().doc('media_files/mf-new-1').set({
        kinfolkId: TEST_TRIBE,
        entityId: 'kf-1',
        entityType: 'KINFOLK',
        storageUrl: 'https://cdn/new.jpg',
        taggedKinIds: [],
      }),
    );
  });
});
