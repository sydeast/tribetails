import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__SERVER_TS__' } };
});
beforeEach(() => mocks.dbFn.mockReset());

import {
  mirrorFamilyKinToFlat,
  buildFlatMirrorPayload,
  onFamilyKinWrite,
} from '../src/triggers/onFamilyKinWrite';
import { MIRROR_ORIGIN_FAMILY } from '../src/triggers/kinMirror';

const KINFOLK = 'kf1';
const KIN_ID = 'pet1';
const FAMILY_PATH = `families/${KINFOLK}/kin/${KIN_ID}`;

describe('onFamilyKinWrite: exports', () => {
  it('exports the trigger', () => {
    expect(onFamilyKinWrite).toBeDefined();
  });
});

describe('buildFlatMirrorPayload: projects parent-owned and household-shared fields only', () => {
  it('copies the household-shared descriptive fields (#1310) and nothing else staff keeps', () => {
    const payload = buildFlatMirrorPayload({
      name: 'Rex',
      sex: 'Male',
      weight: '68 lbs',
      colorMarkings: 'Yellow',
      spayedNeutered: true,
      vetInfo: 'Riverside Animal Hospital',
      // staff-only, mirrored onto the family doc by the reverse trigger; must not bounce back:
      officeNotes: 'bites',
      reactive: true,
      routine: 'morning walk',
      vaccinations: 'Rabies 2027',
    } as any);
    expect(payload).toEqual({
      name: 'Rex',
      sex: 'Male',
      weight: '68 lbs',
      colorMarkings: 'Yellow',
      spayedNeutered: true,
      vetInfo: 'Riverside Animal Hospital',
    });
  });
  it('copies name/species/breed/photoUrl + care instructions, drops staff fields', () => {
    const payload = buildFlatMirrorPayload({
      name: 'Rex',
      species: 'Dog',
      breed: 'Lab',
      photoUrl: 'https://cdn/rex.jpg',
      feedingInstructions: 'twice daily',
      // staff-owned / non-projected fields must NOT appear:
      routine: 'morning walk',
      officeNotes: 'staff only',
      status: 'active',
    } as any);
    expect(payload).toEqual({
      name: 'Rex',
      species: 'Dog',
      breed: 'Lab',
      photoUrl: 'https://cdn/rex.jpg',
      feedingInstructions: 'twice daily',
    });
    expect(payload).not.toHaveProperty('routine');
    expect(payload).not.toHaveProperty('officeNotes');
    expect(payload).not.toHaveProperty('status');
  });
});

describe('buildFlatMirrorPayload: a cleared field the admin decodes as non-null (#1370)', () => {
  it('writes "" for a null species or breed, so the admin Kin decode never sees null', () => {
    const payload = buildFlatMirrorPayload({ name: 'Rex', species: null, breed: null } as any);
    expect(payload).toEqual({ name: 'Rex', species: '', breed: '' });
  });
  it('keeps null for the cleared fields the admin model does not declare', () => {
    const payload = buildFlatMirrorPayload({ name: 'Rex', medications: null, ageYears: null } as any);
    expect(payload).toEqual({ name: 'Rex', medications: null, ageYears: null });
  });
  it('leaves an absent field absent', () => {
    expect(buildFlatMirrorPayload({ name: 'Rex' } as any)).toEqual({ name: 'Rex' });
  });
});
describe('mirrorFamilyKinToFlat: CREATE', () => {
  it('creates a flat mirror, copies parent fields, stamps the symmetric link on BOTH docs', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const after = {
      name: 'Rex',
      species: 'Dog',
      breed: 'Lab',
      photoUrl: 'https://cdn/rex.jpg',
      feedingInstructions: 'twice daily',
      status: 'active',
    };
    const res = await mirrorFamilyKinToFlat(KINFOLK, KIN_ID, undefined, after as any);
    expect(res.action).toBe('created');
    const flatDocId = res.flatDocId!;
    expect(flatDocId).toBeTruthy();

    // Flat mirror write: parent fields + kinfolkId + symmetric link + guard.
    const flatWrite = ctx.writes.find((w) => w.path === `kin/${flatDocId}`);
    expect(flatWrite).toBeTruthy();
    expect(flatWrite!.data.name).toBe('Rex');
    expect(flatWrite!.data.species).toBe('Dog');
    expect(flatWrite!.data.breed).toBe('Lab');
    expect(flatWrite!.data.photoUrl).toBe('https://cdn/rex.jpg');
    expect(flatWrite!.data.feedingInstructions).toBe('twice daily');
    expect(flatWrite!.data.kinfolkId).toBe(KINFOLK);
    expect(flatWrite!.data.familyKinPath).toBe(FAMILY_PATH);
    expect(flatWrite!.data.legacyKinId).toBe(flatDocId);
    expect(flatWrite!.data._mirrorOrigin).toBe(MIRROR_ORIGIN_FAMILY);

    // Symmetric link stamped back onto the family doc.
    const familyWrite = ctx.writes.find((w) => w.path === FAMILY_PATH);
    expect(familyWrite).toBeTruthy();
    expect(familyWrite!.data.legacyKinId).toBe(flatDocId);
    expect(familyWrite!.data.familyKinPath).toBe(FAMILY_PATH);

    // Never touches the_411.
    expect(ctx.writes.some((w) => w.path.startsWith('the_411/'))).toBe(false);
  });

  it('adopts an existing flat doc found by familyKinPath instead of duplicating', async () => {
    const ctx = buildDbMock({
      docs: {},
      queryDocs: { kin: [{ id: 'existingFlat', data: { familyKinPath: FAMILY_PATH } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await mirrorFamilyKinToFlat(KINFOLK, KIN_ID, undefined, {
      name: 'Rex',
      status: 'active',
    } as any);
    expect(res.flatDocId).toBe('existingFlat');
    // Update path (existing doc), not create.
    expect(res.action).toBe('updated');
    const flatWrite = ctx.writes.find((w) => w.path === 'kin/existingFlat');
    expect(flatWrite).toBeTruthy();
    expect(flatWrite!.data._mirrorOrigin).toBe(MIRROR_ORIGIN_FAMILY);
  });
});

describe('mirrorFamilyKinToFlat: UPDATE merges parent fields into existing flat doc', () => {
  it('merges changed parent fields, keeps the guard + link, leaves the_411 alone', async () => {
    const FLAT_ID = 'flat1';
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const before = { name: 'Rex', legacyKinId: FLAT_ID, familyKinPath: FAMILY_PATH, status: 'active' };
    const after = { name: 'Rexy', legacyKinId: FLAT_ID, familyKinPath: FAMILY_PATH, status: 'active' };
    const res = await mirrorFamilyKinToFlat(KINFOLK, KIN_ID, before as any, after as any);
    expect(res.action).toBe('updated');

    const flatWrite = ctx.writes.find((w) => w.path === `kin/${FLAT_ID}`);
    expect(flatWrite).toBeTruthy();
    expect(flatWrite!.merge).toBe(true);
    expect(flatWrite!.data.name).toBe('Rexy');
    expect(flatWrite!.data._mirrorOrigin).toBe(MIRROR_ORIGIN_FAMILY);
    expect(flatWrite!.data.familyKinPath).toBe(FAMILY_PATH);
  });

  it('SKIPS the mirror write when no parent-owned field changed (loop guard)', async () => {
    const FLAT_ID = 'flat1';
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    // Only the link/guard fields differ (e.g. the echo of our own create stamp).
    const before = { name: 'Rex', legacyKinId: FLAT_ID, familyKinPath: FAMILY_PATH, status: 'active' };
    const after = {
      name: 'Rex',
      legacyKinId: FLAT_ID,
      familyKinPath: FAMILY_PATH,
      status: 'active',
      _mirrorOrigin: 'flat',
    };
    const res = await mirrorFamilyKinToFlat(KINFOLK, KIN_ID, before as any, after as any);
    expect(res.action).toBe('skipped');
    expect(ctx.writes.filter((w) => w.path === `kin/${FLAT_ID}`)).toHaveLength(0);
  });
});

describe('mirrorFamilyKinToFlat: ARCHIVE soft-marks the flat mirror', () => {
  it('sets status inactive on the flat doc (no hard delete, no field clobber)', async () => {
    const FLAT_ID = 'flat1';
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const before = { name: 'Rex', legacyKinId: FLAT_ID, familyKinPath: FAMILY_PATH, status: 'active' };
    const after = { name: 'Rex', legacyKinId: FLAT_ID, familyKinPath: FAMILY_PATH, status: 'noLongerWithUs' };
    const res = await mirrorFamilyKinToFlat(KINFOLK, KIN_ID, before as any, after as any);
    expect(res.action).toBe('archived');

    const flatWrite = ctx.writes.find((w) => w.path === `kin/${FLAT_ID}`);
    expect(flatWrite).toBeTruthy();
    expect(flatWrite!.merge).toBe(true);
    expect(flatWrite!.data.status).toBe('inactive');
    // Does NOT re-write descriptive fields on archive.
    expect(flatWrite!.data).not.toHaveProperty('name');
    // Never hard-deletes.
    expect(ctx.deletes).toHaveLength(0);
  });
});

// #1291: AuntieOS screens read the flat doc's `profilePictureUrl`, so a
// household-uploaded photo has to land there too, without an unrelated
// parent edit clobbering a portrait an Auntie set from the gallery.
describe('mirrorFamilyKinToFlat: household photo reaches the admin portrait field (#1291)', () => {
  const FLAT_ID = 'flat1';
  const URL_A = 'https://res.cloudinary.com/demo/image/upload/v1/tribetails/kinfolks/kf1/kin/pet1/a.jpg';
  const URL_B = 'https://res.cloudinary.com/demo/image/upload/v1/tribetails/kinfolks/kf1/kin/pet1/b.jpg';
  const linked = { legacyKinId: FLAT_ID, familyKinPath: FAMILY_PATH, status: 'active', name: 'Rex' };

  it('buildAdminPortraitStamp: create with a photo stamps it; create without one stamps nothing', async () => {
    const { buildAdminPortraitStamp } = await import('../src/triggers/onFamilyKinWrite');
    expect(buildAdminPortraitStamp(undefined, { photoUrl: URL_A })).toEqual({ profilePictureUrl: URL_A });
    expect(buildAdminPortraitStamp(undefined, { name: 'Rex' })).toEqual({});
  });

  it('create: the flat mirror carries profilePictureUrl alongside photoUrl', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await mirrorFamilyKinToFlat(KINFOLK, KIN_ID, undefined, { name: 'Rex', status: 'active', photoUrl: URL_A } as any);
    const flatWrite = ctx.writes.find((w) => w.path === `kin/${res.flatDocId}`);
    expect(flatWrite!.data.photoUrl).toBe(URL_A);
    expect(flatWrite!.data.profilePictureUrl).toBe(URL_A);
  });

  it('replace: a changed photoUrl overwrites profilePictureUrl on the flat doc', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await mirrorFamilyKinToFlat(KINFOLK, KIN_ID, { ...linked, photoUrl: URL_A } as any, { ...linked, photoUrl: URL_B } as any);
    expect(res.action).toBe('updated');
    const flatWrite = ctx.writes.find((w) => w.path === `kin/${FLAT_ID}`);
    expect(flatWrite!.data.photoUrl).toBe(URL_B);
    expect(flatWrite!.data.profilePictureUrl).toBe(URL_B);
  });

  it('remove: a cleared photoUrl clears profilePictureUrl to the empty string', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await mirrorFamilyKinToFlat(KINFOLK, KIN_ID, { ...linked, photoUrl: URL_A } as any, { ...linked, photoUrl: null } as any);
    const flatWrite = ctx.writes.find((w) => w.path === `kin/${FLAT_ID}`);
    expect(flatWrite!.data.photoUrl).toBeNull();
    expect(flatWrite!.data.profilePictureUrl).toBe('');
  });

  it('an unrelated parent edit leaves profilePictureUrl alone (an Auntie-set portrait survives)', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await mirrorFamilyKinToFlat(
      KINFOLK,
      KIN_ID,
      { ...linked, photoUrl: URL_A } as any,
      { ...linked, name: 'Rexy', photoUrl: URL_A } as any,
    );
    const flatWrite = ctx.writes.find((w) => w.path === `kin/${FLAT_ID}`);
    expect(flatWrite!.data.name).toBe('Rexy');
    expect(flatWrite!.data).not.toHaveProperty('profilePictureUrl');
  });
});
