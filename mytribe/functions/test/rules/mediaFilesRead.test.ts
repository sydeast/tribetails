import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { getEnv, cleanup, shutdown } from './setup';

/**
 * `media_files`, the one collection every upload lands in.
 *
 * A file says what it hangs off in `entityType`, and the two staff roles do
 * not read the same set:
 *
 *   the owner    every file.
 *   an Auntie    the files of her own work: a visit's KinTale photos
 *                (VISIT_LOG), a Kin's photos (KIN) and a household's photos
 *                (KINFOLK), plus her own account photo by id. That is what her
 *                Gallery shows. Tribal Intel attachments, company media and
 *                every other kind are the owner's.
 *
 * Rules allow or refuse a list whole, so her list has to name the types it
 * wants; admin web adds that for her (`auntieos-admin/src/lib/caretakerScope.ts`).
 * The queries below are the ones the Gallery and the Media screen send.
 *
 * A Kinfolk reads nothing here from a client. The portal's photos come through
 * callables on the Admin SDK.
 */

type Env = Awaited<ReturnType<typeof getEnv>>;
type Db = ReturnType<ReturnType<Env['authenticatedContext']>['firestore']>;

const HOUSEHOLD = 'kf-media-1';
const KIN = 'kin-media-1';
const VISIT = 'visit-media-1';
const TEST_TRIBE = 'test-kinfolk-001';

/** The types an Auntie's list names, as admin web sends them. */
const HER_TYPES = ['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk'];

function file(entityType: unknown, entityId: string, day: string, extra: Record<string, unknown> = {}) {
  return {
    ...(entityType === undefined ? {} : { entityType }),
    entityId,
    fileType: 'IMAGE',
    storageUrl: `https://cdn.test/${entityId}-${day}.jpg`,
    originalFileName: `${day}.jpg`,
    description: '',
    isProfilePhoto: false,
    uploadedAt: `2026-11-${day}T10:00:00.000Z`,
    uploadedBy: 'owner-1',
    ...extra,
  };
}

/** One row per stored type and spelling, and the rows that carry no usable type. */
const HERS: Record<string, Record<string, unknown>> = {
  'visit-photo': file('VISIT_LOG', VISIT, '01'),
  'kin-photo': file('KIN', KIN, '02', { kinfolkId: HOUSEHOLD }),
  'kin-photo-desktop': file('kin', KIN, '03', { kinfolkId: HOUSEHOLD }),
  'household-photo': file('KINFOLK', HOUSEHOLD, '04', { kinfolkId: HOUSEHOLD }),
  'household-photo-desktop': file('kinfolk', HOUSEHOLD, '05', { kinfolkId: HOUSEHOLD }),
};
const OWNERS: Record<string, Record<string, unknown>> = {
  'intel-attachment': file('TRIBAL_INTEL', 'pending', '06'),
  'company-file': file('BUSINESS', 'business_settings', '07'),
  'owner-account-photo': file('USER', 'owner-1', '08'),
  'invoice-file': file('INVOICE', 'inv-1', '09'),
  'training-file': file('TRAINING', 'tr-1', '10'),
  'odd-case': file('Kin', KIN, '11', { kinfolkId: HOUSEHOLD }),
  'padded-type': file('KIN ', KIN, '12', { kinfolkId: HOUSEHOLD }),
  'number-type': file(7, KIN, '13', { kinfolkId: HOUSEHOLD }),
  'no-type': file(undefined, HOUSEHOLD, '14', { kinfolkId: HOUSEHOLD }),
  'new-kind': file('SOMETHING_NEW', 'x-1', '15'),
};
const AUNTIE_ACCOUNT_PHOTO = 'auntie-account-photo';
const SANDBOX_FILE = `${TEST_TRIBE}-media-1`;

const HER_IDS = Object.keys(HERS).sort();
/**
 * What her Gallery list returns: her five rows, and the sandbox household's
 * photo. That one is a household photo like any other (`KINFOLK`), so it is in
 * her list; the sandbox scope narrows the sandbox account, not her.
 */
const HER_GALLERY = [...HER_IDS, SANDBOX_FILE].sort();
const OWNER_IDS = Object.keys(OWNERS);

/** The owner. `admin: true` and no staffRole. */
function asOwner(env: Env) {
  return env.authenticatedContext('owner-1', { admin: true });
}

/** An Auntie. staffRole only, no admin claim. */
function asAuntie(env: Env, uid = 'auntie-1') {
  return env.authenticatedContext(uid, { staffRole: 'auntie' });
}

/** A signed-in member of the household the seeded photos belong to. */
function asKinfolk(env: Env) {
  return env.authenticatedContext('u-kin', { role: 'kinfolk', kinfolkId: HOUSEHOLD });
}

/** A sandbox test admin: testTribeId, no admin claim. */
function asTestAdmin(env: Env) {
  return env.authenticatedContext('test-admin-uid', { testTribeId: TEST_TRIBE });
}

/** The Gallery's listener as the owner sends it: newest first, capped (`api/gallery.ts`). */
function galleryQuery(db: Db) {
  return db.collection('media_files').orderBy('uploadedAt', 'desc').limit(500);
}

/** The Gallery's listener as an Auntie's session sends it: the same, naming her types. */
function auntieGalleryQuery(db: Db) {
  return db.collection('media_files').where('entityType', 'in', HER_TYPES).orderBy('uploadedAt', 'desc').limit(500);
}

/** One household's or Kin's Media screen as the owner sends it (`api/media.ts`). */
function mediaScreenQuery(db: Db, entityId: string) {
  return db.collection('media_files').where('entityId', '==', entityId).orderBy('uploadedAt', 'desc').limit(500);
}

/** The same screen from an Auntie's session. */
function auntieMediaScreenQuery(db: Db, entityId: string) {
  return db
    .collection('media_files')
    .where('entityId', '==', entityId)
    .where('entityType', 'in', HER_TYPES)
    .orderBy('uploadedAt', 'desc')
    .limit(500);
}

async function ids(query: { get: () => Promise<{ docs: { id: string }[] }> }): Promise<string[]> {
  return (await query.get()).docs.map((d) => d.id).sort();
}

async function seedFiles(): Promise<void> {
  const env = await getEnv();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [id, data] of Object.entries({ ...HERS, ...OWNERS })) await db.doc(`media_files/${id}`).set(data);
    await db.doc(`media_files/${AUNTIE_ACCOUNT_PHOTO}`).set(file('USER', 'auntie-1', '16', { uploadedBy: 'auntie-1' }));
    await db.doc(`media_files/${SANDBOX_FILE}`).set(file('KINFOLK', TEST_TRIBE, '17', { kinfolkId: TEST_TRIBE }));
  });
}

describe('rules: media_files, the owner reads every file', () => {
  beforeEach(async () => seedFiles());
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('the owner reads every file by id, whatever it hangs off', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    for (const id of [...HER_IDS, ...OWNER_IDS, AUNTIE_ACCOUNT_PHOTO, SANDBOX_FILE]) {
      await assertSucceeds(db.doc(`media_files/${id}`).get());
    }
  });

  it('the owner lists the Gallery with no type named, and gets every file', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    const listed = await ids(galleryQuery(db));
    expect(listed).toEqual([...HER_IDS, ...OWNER_IDS, AUNTIE_ACCOUNT_PHOTO, SANDBOX_FILE].sort());
    await assertSucceeds(db.collection('media_files').get());
  });

  it('the owner lists one household, one Kin and the Tribal Intel attachments by what they hang off', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    expect(await ids(mediaScreenQuery(db, HOUSEHOLD))).toEqual(['household-photo', 'household-photo-desktop', 'no-type']);
    expect(await ids(mediaScreenQuery(db, 'pending'))).toEqual(['intel-attachment']);
    await assertSucceeds(db.collection('media_files').where('entityType', '==', 'TRIBAL_INTEL').get());
  });

  it('the owner reads an id with no file behind it as missing, not refused', async () => {
    const env = await getEnv();
    const snap = await assertSucceeds(asOwner(env).firestore().doc('media_files/no-such-file').get());
    expect(snap.exists).toBe(false);
  });

  it('the owner uploads and captions any kind of file, as before', async () => {
    const env = await getEnv();
    const db = asOwner(env).firestore();
    await assertSucceeds(db.collection('media_files').add(file('TRIBAL_INTEL', 'pending', '20')));
    await assertSucceeds(db.collection('media_files').add(file('BUSINESS', 'business_settings', '20')));
    await assertSucceeds(db.collection('media_files').add(file('VISIT_LOG', VISIT, '20')));
    await assertSucceeds(db.doc('media_files/intel-attachment').update({ description: 'Gate code photo' }));
    await assertSucceeds(db.doc('media_files/no-type').update({ description: 'Front porch' }));
  });
});

describe('rules: media_files, an Auntie reads the files of her own work', () => {
  beforeEach(async () => seedFiles());
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('HAPPY: she reads a visit, a Kin and a household photo by id, in each stored spelling', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    for (const id of HER_IDS) await assertSucceeds(db.doc(`media_files/${id}`).get());
  });

  it('HAPPY: her Gallery list names her types and comes back with exactly her files', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    expect(await ids(auntieGalleryQuery(db))).toEqual(HER_GALLERY);
  });

  it('HAPPY: her Media screen for one household or one Kin lists that one\'s photos', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    expect(await ids(auntieMediaScreenQuery(db, HOUSEHOLD))).toEqual(['household-photo', 'household-photo-desktop']);
    expect(await ids(auntieMediaScreenQuery(db, KIN))).toEqual(['kin-photo', 'kin-photo-desktop']);
    expect(await ids(auntieMediaScreenQuery(db, VISIT))).toEqual(['visit-photo']);
  });

  it('HAPPY: a list naming some of her types, or one of them, is allowed too', async () => {
    const env = await getEnv();
    const coll = asAuntie(env).firestore().collection('media_files');
    expect(await ids(coll.where('entityType', 'in', ['VISIT_LOG', 'KIN']))).toEqual(['kin-photo', 'visit-photo']);
    for (const type of HER_TYPES) await assertSucceeds(coll.where('entityType', '==', type).get());
  });

  it('SAD: her Media screen for something with none of her files is an empty list, not a refusal', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    expect(await ids(auntieMediaScreenQuery(db, 'pending'))).toEqual([]);
    expect(await ids(auntieMediaScreenQuery(db, 'nobody'))).toEqual([]);
  });

  it('NEGATIVE: she reads no file that is the owner\'s by id', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    for (const id of OWNER_IDS) await assertFails(db.doc(`media_files/${id}`).get());
  });

  it('NEGATIVE: an id with no file behind it is refused her, the same as a file that is not hers', async () => {
    const env = await getEnv();
    await assertFails(asAuntie(env).firestore().doc('media_files/no-such-file').get());
  });

  it('NEGATIVE: a list that names no type is refused whole, the Gallery\'s and the Media screen\'s alike', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    await assertFails(galleryQuery(db).get());
    await assertFails(db.collection('media_files').get());
    await assertFails(mediaScreenQuery(db, HOUSEHOLD).get());
    await assertFails(mediaScreenQuery(db, 'pending').get());
    await assertFails(db.collection('media_files').where('kinfolkId', '==', HOUSEHOLD).get());
    await assertFails(db.collection('media_files').where('uploadedBy', '==', 'auntie-1').get());
  });

  it('NEGATIVE: a list that names a type outside hers is refused whole, alone or beside hers', async () => {
    const env = await getEnv();
    const coll = asAuntie(env).firestore().collection('media_files');
    for (const type of ['TRIBAL_INTEL', 'BUSINESS', 'USER', 'INVOICE', 'Kin', 'household']) {
      await assertFails(coll.where('entityType', '==', type).get());
      await assertFails(coll.where('entityType', 'in', [type]).get());
      await assertFails(coll.where('entityType', 'in', [...HER_TYPES, type]).get());
    }
    await assertFails(coll.where('entityType', '==', 'TRIBAL_INTEL').where('entityId', '==', 'pending').get());
  });

  it('NEGATIVE: a list that names what to leave out, instead of what to read, is refused', async () => {
    const env = await getEnv();
    const coll = asAuntie(env).firestore().collection('media_files');
    await assertFails(coll.where('entityType', '!=', 'TRIBAL_INTEL').get());
    await assertFails(coll.where('entityType', 'not-in', ['TRIBAL_INTEL', 'BUSINESS', 'USER']).get());
    await assertFails(coll.where('entityType', '>=', 'KIN').get());
  });

  it('her own account photo: read by id, never listed, and nobody else\'s', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    await assertSucceeds(db.doc(`media_files/${AUNTIE_ACCOUNT_PHOTO}`).get());
    await assertFails(db.doc('media_files/owner-account-photo').get());
    await assertFails(
      db.collection('media_files').where('entityType', '==', 'USER').where('entityId', '==', 'auntie-1').get(),
    );
    const other = asAuntie(env, 'auntie-2').firestore();
    await assertFails(other.doc(`media_files/${AUNTIE_ACCOUNT_PHOTO}`).get());
  });

  it('HAPPY: she uploads a visit, a Kin and a household photo, and her own account photo', async () => {
    const env = await getEnv();
    const coll = asAuntie(env).firestore().collection('media_files');
    await assertSucceeds(coll.add(file('VISIT_LOG', VISIT, '21', { uploadedBy: 'auntie-1' })));
    await assertSucceeds(coll.add(file('KIN', KIN, '21', { uploadedBy: 'auntie-1', kinfolkId: HOUSEHOLD })));
    await assertSucceeds(coll.add(file('KINFOLK', HOUSEHOLD, '21', { uploadedBy: 'auntie-1', kinfolkId: HOUSEHOLD })));
    await assertSucceeds(coll.add(file('USER', 'auntie-1', '21', { uploadedBy: 'auntie-1' })));
  });

  it('NEGATIVE: she uploads no other kind of file, no file without a type, and no other account\'s photo', async () => {
    const env = await getEnv();
    const coll = asAuntie(env).firestore().collection('media_files');
    await assertFails(coll.add(file('TRIBAL_INTEL', 'pending', '22', { uploadedBy: 'auntie-1' })));
    await assertFails(coll.add(file('BUSINESS', 'business_settings', '22', { uploadedBy: 'auntie-1' })));
    await assertFails(coll.add(file('INVOICE', 'inv-1', '22', { uploadedBy: 'auntie-1' })));
    await assertFails(coll.add(file('USER', 'owner-1', '22', { uploadedBy: 'auntie-1' })));
    await assertFails(coll.add(file(undefined, HOUSEHOLD, '22', { uploadedBy: 'auntie-1' })));
    await assertFails(coll.add(file(7, KIN, '22', { uploadedBy: 'auntie-1' })));
  });

  it('HAPPY: she captions a photo she reads, her own account photo included', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    for (const id of HER_IDS) await assertSucceeds(db.doc(`media_files/${id}`).update({ description: 'Beach day' }));
    await assertSucceeds(db.doc(`media_files/${AUNTIE_ACCOUNT_PHOTO}`).update({ description: 'Me' }));
  });

  it('NEGATIVE: she changes no file that is the owner\'s', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    for (const id of OWNER_IDS) {
      await assertFails(db.doc(`media_files/${id}`).update({ description: 'changed' }));
      await assertFails(db.doc(`media_files/${id}`).set({ description: 'changed' }, { merge: true }));
    }
  });

  it('NEGATIVE: an update moves a file neither into her types nor out of them', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('media_files/intel-attachment').update({ entityType: 'KIN' }));
    await assertFails(db.doc('media_files/no-type').update({ entityType: 'KINFOLK' }));
    await assertFails(db.doc('media_files/owner-account-photo').update({ entityId: 'auntie-1' }));
    await assertFails(db.doc('media_files/kin-photo').update({ entityType: 'TRIBAL_INTEL' }));
    await assertFails(db.doc('media_files/kin-photo').update({ entityType: 'USER', entityId: 'owner-1' }));
    await assertFails(db.doc(`media_files/${AUNTIE_ACCOUNT_PHOTO}`).update({ entityId: 'owner-1' }));
  });

  it('NEGATIVE: which Kin are in a photo still goes through the server, and a delete too', async () => {
    const env = await getEnv();
    const db = asAuntie(env).firestore();
    await assertFails(db.doc('media_files/kin-photo').update({ taggedKinIds: [KIN] }));
    for (const id of [...HER_IDS, ...OWNER_IDS]) await assertFails(db.doc(`media_files/${id}`).delete());
  });
});

describe('rules: media_files, every other caller', () => {
  beforeEach(async () => seedFiles());
  afterEach(async () => cleanup());
  afterAll(async () => shutdown());

  it('a token holding both admin and staffRole gets the Auntie boundary', async () => {
    const env = await getEnv();
    const db = env.authenticatedContext('confused-1', { admin: true, staffRole: 'auntie' }).firestore();
    for (const id of OWNER_IDS) await assertFails(db.doc(`media_files/${id}`).get());
    await assertFails(galleryQuery(db).get());
    expect(await ids(auntieGalleryQuery(db))).toEqual(HER_GALLERY);
    await assertFails(db.collection('media_files').add(file('TRIBAL_INTEL', 'pending', '23')));
  });

  it('an unknown staffRole value reads and writes nothing', async () => {
    const env = await getEnv();
    const db = env.authenticatedContext('future-1', { staffRole: 'bookkeeper' }).firestore();
    for (const id of [...HER_IDS, ...OWNER_IDS]) await assertFails(db.doc(`media_files/${id}`).get());
    await assertFails(galleryQuery(db).get());
    await assertFails(auntieGalleryQuery(db).get());
    await assertFails(db.collection('media_files').add(file('KIN', KIN, '23')));
  });

  it("a Kinfolk reads no file, their own household's included, one at a time or as a list", async () => {
    const env = await getEnv();
    const db = asKinfolk(env).firestore();
    for (const id of [...HER_IDS, ...OWNER_IDS]) await assertFails(db.doc(`media_files/${id}`).get());
    await assertFails(galleryQuery(db).get());
    await assertFails(auntieGalleryQuery(db).get());
    await assertFails(auntieMediaScreenQuery(db, HOUSEHOLD).get());
    await assertFails(db.collection('media_files').where('kinfolkId', '==', HOUSEHOLD).get());
  });

  it('a Kinfolk writes no file', async () => {
    const env = await getEnv();
    const db = asKinfolk(env).firestore();
    await assertFails(db.collection('media_files').add(file('KIN', KIN, '24', { kinfolkId: HOUSEHOLD })));
    await assertFails(db.doc('media_files/household-photo').update({ description: 'changed' }));
    await assertFails(db.doc('media_files/household-photo').delete());
  });

  it('a signed-in account with no role, and a signed-out caller, read and write nothing', async () => {
    const env = await getEnv();
    for (const db of [env.authenticatedContext('nobody-1', {}).firestore(), env.unauthenticatedContext().firestore()]) {
      for (const id of [...HER_IDS, ...OWNER_IDS]) await assertFails(db.doc(`media_files/${id}`).get());
      await assertFails(galleryQuery(db).get());
      await assertFails(auntieGalleryQuery(db).get());
      await assertFails(db.collection('media_files').add(file('KIN', KIN, '25')));
    }
  });

  it('a sandbox test admin keeps its own tribe\'s files and no others, as before', async () => {
    const env = await getEnv();
    const db = asTestAdmin(env).firestore();
    await assertSucceeds(db.doc(`media_files/${SANDBOX_FILE}`).get());
    expect(
      await ids(db.collection('media_files').where('kinfolkId', '==', TEST_TRIBE).orderBy('uploadedAt', 'desc').limit(500)),
    ).toEqual([SANDBOX_FILE]);
    await assertSucceeds(
      db.collection('media_files').add(file('KINFOLK', TEST_TRIBE, '26', { kinfolkId: TEST_TRIBE })),
    );
    await assertSucceeds(db.doc(`media_files/${SANDBOX_FILE}`).update({ description: 'Sandbox porch' }));
    for (const id of [...HER_IDS, ...OWNER_IDS]) await assertFails(db.doc(`media_files/${id}`).get());
    await assertFails(galleryQuery(db).get());
    await assertFails(auntieGalleryQuery(db).get());
  });
});
