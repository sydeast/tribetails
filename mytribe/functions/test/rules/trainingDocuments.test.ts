import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * `training_documents`, the Tribal Intel notes store.
 *
 * A note is the owner's own words about a household, a Kinfolk or a Kin. The
 * nightly reconcile folds each one into exactly one record: the household bank,
 * that Kinfolk's dossier, or that Kin's 411. The standing ruling is that an
 * Auntie sees households and 411s, never money or dossiers, and this
 * collection is the source text for all three records in one place. So the
 * read is the owner's alone, whatever a row targets, and an Auntie reads the
 * 411 a note about a Kin ends up in.
 *
 * The same collection holds writing kept for its style (`documentKind:
 * 'voice_example'`, no target). Those rows sit behind the same line.
 *
 * Every write is refused for everyone, the owner included: create, update and
 * delete go through the three callables on the Admin SDK.
 */

type Env = Awaited<ReturnType<typeof getEnv>>;
type Db = ReturnType<ReturnType<Env['authenticatedContext']>['firestore']>;

const HOUSEHOLD = 'kf-intel-1';
const KIN = 'kin-intel-1';

/** One row per target, a row from before targets existed, and a writing sample. */
const NOTES: Record<string, Record<string, unknown>> = {
  'note-household': {
    title: 'Gate',
    content: 'Side gate sticks, lift and push.',
    documentKind: 'note',
    targetType: 'HOUSEHOLD',
    targetKinfolkId: HOUSEHOLD,
    targetKinId: '',
    kinfolkRef: HOUSEHOLD,
    uploadedAt: '2026-11-01T10:00:00.000Z',
  },
  'note-kinfolk': {
    title: 'Contact',
    content: 'Prefers a text over a call.',
    documentKind: 'note',
    targetType: 'KINFOLK',
    targetKinfolkId: HOUSEHOLD,
    targetKinId: '',
    kinfolkRef: HOUSEHOLD,
    uploadedAt: '2026-11-02T10:00:00.000Z',
  },
  'note-kin': {
    title: 'Food',
    content: 'No chicken.',
    documentKind: 'note',
    targetType: 'KIN',
    targetKinfolkId: HOUSEHOLD,
    targetKinId: KIN,
    kinfolkRef: HOUSEHOLD,
    uploadedAt: '2026-11-03T10:00:00.000Z',
  },
  'note-untargeted': {
    title: 'Imported',
    content: 'Trash goes out Tuesday night.',
    kinfolkRef: HOUSEHOLD,
    uploadedAt: '2026-05-10',
  },
  'voice-example': {
    title: 'A visit recap',
    content: 'Hi there! Quick note from this afternoon.',
    documentKind: 'voice_example',
    communicationType: 'email',
    uploadedAt: '2026-11-04T10:00:00.000Z',
  },
};

const NOTE_IDS = Object.keys(NOTES);

/** The owner. `admin: true` and no staffRole. */
function asOwner(env: Env) {
  return env.authenticatedContext('owner-1', { admin: true });
}

/** An Auntie. staffRole only, no admin claim. */
function asAuntie(env: Env) {
  return env.authenticatedContext('auntie-1', { staffRole: 'auntie' });
}

/** A signed-in household member, of the household the seeded notes are about. */
function asKinfolk(env: Env) {
  return env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: HOUSEHOLD });
}

/** The screen's own listener: newest first, capped (`api/tribalIntel.ts`). */
function screenQuery(db: Db) {
  return db.collection('training_documents').orderBy('uploadedAt', 'desc').limit(200);
}

async function seedNotes(): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [id, note] of Object.entries(NOTES)) await db.doc(`training_documents/${id}`).set(note);
    await db.doc(`the_411/411_${KIN}`).set({ kinId: KIN, rawSummary: 'No chicken.' });
  });
}

/**
 * Every client write a caller could try: a new note, a new writing sample, and
 * an update (a merge and a field update) and a delete of every seeded row.
 */
async function expectNoClientWrite(db: Db): Promise<void> {
  const coll = db.collection('training_documents');
  await assertFails(
    coll.doc('new-note').set({
      title: 'x',
      content: 'y',
      documentKind: 'note',
      targetType: 'KIN',
      targetKinfolkId: HOUSEHOLD,
      targetKinId: KIN,
      uploadedAt: '2026-11-05T10:00:00.000Z',
    }),
  );
  await assertFails(
    coll.doc('new-voice-example').set({
      title: 'x',
      content: 'y',
      documentKind: 'voice_example',
      communicationType: 'email',
      uploadedAt: '2026-11-05T10:00:00.000Z',
    }),
  );
  await assertFails(coll.add({ title: 'x', documentKind: 'voice_example' }));
  for (const id of NOTE_IDS) {
    await assertFails(coll.doc(id).set({ content: 'changed' }, { merge: true }));
    await assertFails(coll.doc(id).update({ documentKind: 'voice_example' }));
    await assertFails(coll.doc(id).update({ targetType: 'KIN', targetKinId: KIN }));
    await assertFails(coll.doc(id).delete());
  }
}

describe('rules: training_documents is read by the owner only', () => {
  beforeEach(async () => seedNotes());

  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the owner reads every row, whatever it targets', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    for (const id of NOTE_IDS) await assertSucceeds(db.doc(`training_documents/${id}`).get());
  });

  it('the owner lists the collection the way the Tribal Intel screen does', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    await assertSucceeds(screenQuery(db).get());
    await assertSucceeds(db.collection('training_documents').get());
  });

  it('an Auntie reads no row: not a household, Kinfolk, Kin or untargeted note, nor a writing sample', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    for (const id of NOTE_IDS) await assertFails(db.doc(`training_documents/${id}`).get());
  });

  it('an Auntie reads no row that is not there either', async () => {
    const env = await getEnv();
    await assertFails(asAuntie(env).firestore().doc('training_documents/no-such-note').get());
  });

  it('an Auntie cannot list the collection, with the screen query or bare', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    await assertFails(screenQuery(db).get());
    await assertFails(db.collection('training_documents').get());
  });

  it('an Auntie cannot list it narrowed to one target, one household, one Kin or one kind', async () => {
    const env = await getEnv();
    const coll = asAuntie(env).firestore().collection('training_documents');
    await assertFails(coll.where('targetType', '==', 'KIN').get());
    await assertFails(coll.where('targetKinfolkId', '==', HOUSEHOLD).get());
    await assertFails(coll.where('targetType', '==', 'KIN').where('targetKinId', '==', KIN).get());
    await assertFails(coll.where('documentKind', '==', 'voice_example').get());
  });

  it('an Auntie still reads the 411 a note about a Kin ends up in', async () => {
    const env = await getEnv();
    await assertSucceeds(asAuntie(env).firestore().doc(`the_411/411_${KIN}`).get());
  });

  it('a token holding both admin and staffRole gets the Auntie boundary', async () => {
    const env = await getEnv();
    const db = env.authenticatedContext('confused-1', { admin: true, staffRole: 'auntie' }).firestore();
    for (const id of NOTE_IDS) await assertFails(db.doc(`training_documents/${id}`).get());
    await assertFails(screenQuery(db).get());
  });

  it("a Kinfolk reads no row, their own household's included, one at a time or as a list", async () => {
    const env = await getEnv();
    const db = asKinfolk(env).firestore();
    for (const id of NOTE_IDS) await assertFails(db.doc(`training_documents/${id}`).get());
    await assertFails(db.collection('training_documents').get());
    await assertFails(db.collection('training_documents').where('targetKinfolkId', '==', HOUSEHOLD).get());
  });

  it('nobody else reads them: not an unknown staff role, a test admin or a signed-out caller', async () => {
    const env = await getEnv();
    const unknown = env.authenticatedContext('future-1', { staffRole: 'bookkeeper' }).firestore();
    const testAdmin = env.authenticatedContext('test-admin-uid', { testTribeId: HOUSEHOLD }).firestore();
    const signedOut = env.unauthenticatedContext().firestore();
    for (const db of [unknown, testAdmin, signedOut]) {
      await assertFails(db.doc('training_documents/note-kin').get());
      await assertFails(db.collection('training_documents').get());
    }
  });
});

describe('rules: training_documents takes no client write', () => {
  beforeEach(async () => seedNotes());

  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the owner cannot create, update or delete a row from a client', async () => {
    const env = await getEnv();
    await expectNoClientWrite(asOwner(env).firestore());
  });

  it('an Auntie cannot create, update or delete a row', async () => {
    const env = await getEnv();
    await expectNoClientWrite(asAuntie(env).firestore());
  });

  it("a Kinfolk cannot create, update or delete a row, their own household's included", async () => {
    const env = await getEnv();
    await expectNoClientWrite(asKinfolk(env).firestore());
  });

  it('nobody else can either: not a double-claimed account, an unknown staff role, a test admin or a signed-out caller', async () => {
    const env = await getEnv();
    await expectNoClientWrite(env.authenticatedContext('confused-1', { admin: true, staffRole: 'auntie' }).firestore());
    await expectNoClientWrite(env.authenticatedContext('future-1', { staffRole: 'bookkeeper' }).firestore());
    await expectNoClientWrite(env.authenticatedContext('test-admin-uid', { testTribeId: HOUSEHOLD }).firestore());
    await expectNoClientWrite(env.unauthenticatedContext().firestore());
  });

  it('a refused write leaves every row as it was and creates none', async () => {
    const env = await getEnv();
    await expectNoClientWrite(asOwner(env).firestore());
    await expectNoClientWrite(asAuntie(env).firestore());
    await expectNoClientWrite(asKinfolk(env).firestore());
    await env.withSecurityRulesDisabled(async (ctx) => {
      const snap = await ctx.firestore().collection('training_documents').get();
      const stored = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
      expect(stored).toEqual(NOTES);
    });
  });
});
