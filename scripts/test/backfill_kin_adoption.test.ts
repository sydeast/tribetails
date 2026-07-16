import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  adoptedKinId,
  normalizeSpecies,
  parseAgeYears,
  buildFamilyKinDoc,
  buildFlatStamp,
  planAdoption,
  planRun,
  formatPlanTable,
  TEST_TRIBE_ID,
  AdoptionContext,
  FlatKinInput,
} from '../backfill_kin_adoption';
import {
  MIRROR_ORIGIN_FAMILY,
  MIRROR_ORIGIN_FLAT,
  PARENT_OWNED_FIELDS,
  STAFF_EDITABLE_FIELDS,
} from '../../functions/src/triggers/kinMirror';
import {
  buildFamilyProvisionDoc,
  PROVISIONED_BY_BACKFILL,
} from '../../functions/src/triggers/familyProvision';

const CTX_OK: AdoptionContext = { familyExists: true, existingFamilyKinId: null };

/** A full AuntieOS flat kin doc (shape per AuntieOS FirestoreClient.kt Kin). */
function fullFlatDoc(): Record<string, unknown> {
  return {
    _id: 'flat-abc',
    kinfolkId: '6',
    name: 'Waffles',
    species: 'dog',
    breed: 'Corgi',
    age: '4 years',
    sex: 'M',
    weight: '28 lbs',
    status: 'active',
    profilePictureUrl: 'https://example.com/waffles.jpg',
    colorMarkings: 'Red and white',
    spayedNeutered: true,
    routine: 'Two walks a day',
    trainingCommands: 'sit, stay',
    feedingBrand: 'Acme Kibble',
    vaccinations: 'Rabies 2026',
    medicationHealthNotes: 'None',
    vetInfo: 'Dr. Smith 555-0100',
    reactive: false,
    officeNotes: 'Escapes crates',
    // AuntieOS string defaults that must NOT leak into the family doc:
    checklist: '',
    ownerEmail: 'owner@example.com',
    ownerPhone: '+15550100',
    staysAs: '',
  };
}

describe('parseArgs', () => {
  it('defaults to dry-run with no scope filters', () => {
    const a = parseArgs([]);
    expect(a.mode).toBe('dry-run');
    expect(a.family).toBeNull();
    expect(a.limit).toBeNull();
  });

  it('--apply switches mode', () => {
    expect(parseArgs(['--apply']).mode).toBe('apply');
  });

  it('captures --family= and --limit=', () => {
    const a = parseArgs(['--family=6', '--limit=3']);
    expect(a.family).toBe('6');
    expect(a.limit).toBe(3);
  });

  it('--provision-families is off by default and captured when set', () => {
    expect(parseArgs([]).provisionFamilies).toBe(false);
    expect(parseArgs(['--provision-families']).provisionFamilies).toBe(true);
    expect(parseArgs(['--provision-families', '--apply']).mode).toBe('apply');
  });

  it('rejects a non-positive or non-integer --limit', () => {
    expect(() => parseArgs(['--limit=0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--limit=abc'])).toThrow(/positive integer/);
  });

  it('captures --project and throws on unknown args', () => {
    expect(parseArgs(['--project', 'auntieos-ttpc']).projectId).toBe('auntieos-ttpc');
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });
});

describe('normalizeSpecies (portal Title-Case convention)', () => {
  it('title-cases the AuntieOS value', () => {
    expect(normalizeSpecies('dog')).toBe('Dog');
    expect(normalizeSpecies('DOG')).toBe('Dog');
    expect(normalizeSpecies('Dog')).toBe('Dog');
    expect(normalizeSpecies('guinea pig')).toBe('Guinea Pig');
  });

  it('returns null for empty or non-string input', () => {
    expect(normalizeSpecies('')).toBeNull();
    expect(normalizeSpecies('   ')).toBeNull();
    expect(normalizeSpecies(undefined)).toBeNull();
    expect(normalizeSpecies(7)).toBeNull();
  });
});

describe('parseAgeYears (flat age is a string)', () => {
  it('parses plain and embedded numbers', () => {
    expect(parseAgeYears('4')).toBe(4);
    expect(parseAgeYears('4 years')).toBe(4);
    expect(parseAgeYears('4.5')).toBe(4.5);
    expect(parseAgeYears('about 12 yrs old')).toBe(12);
  });

  it('passes numbers through', () => {
    expect(parseAgeYears(7)).toBe(7);
  });

  it('omits unparseable, empty, negative, or absurd values', () => {
    expect(parseAgeYears('four')).toBeNull();
    expect(parseAgeYears('')).toBeNull();
    expect(parseAgeYears(undefined)).toBeNull();
    expect(parseAgeYears(-2)).toBeNull();
    // A birth-year string must not become ageYears.
    expect(parseAgeYears('2019')).toBeNull();
  });
});

describe('buildFamilyKinDoc — full flat doc mapping', () => {
  const doc = buildFamilyKinDoc('flat-abc', '6', 'adopted-flat-abc', fullFlatDoc());

  it('maps identity fields with portal conventions', () => {
    expect(doc.name).toBe('Waffles');
    expect(doc.species).toBe('Dog'); // normalized from 'dog'
    expect(doc.breed).toBe('Corgi');
    expect(doc.ageYears).toBe(4); // parsed from '4 years'
    expect(doc.photoUrl).toBe('https://example.com/waffles.jpg'); // from profilePictureUrl
  });

  it('copies staff-editable fields and drops AuntieOS empty-string defaults', () => {
    expect(doc.sex).toBe('M');
    expect(doc.weight).toBe('28 lbs');
    expect(doc.vetInfo).toBe('Dr. Smith 555-0100');
    expect(doc.spayedNeutered).toBe(true);
    expect(doc.reactive).toBe(false);
    expect(doc.officeNotes).toBe('Escapes crates');
    // Not staff-editable / not parent-owned -> never copied.
    expect(doc).not.toHaveProperty('ownerEmail');
    expect(doc).not.toHaveProperty('ownerPhone');
    expect(doc).not.toHaveProperty('checklist');
    expect(doc).not.toHaveProperty('staysAs');
  });

  it('copies parent-owned care fields when the flat doc has them', () => {
    const withCare = buildFamilyKinDoc('flat-abc', '6', 'adopted-flat-abc', {
      ...fullFlatDoc(),
      feedingInstructions: 'One cup at 7am',
      allergies: 'Chicken',
    });
    expect(withCare.feedingInstructions).toBe('One cup at 7am');
    expect(withCare.allergies).toBe('Chicken');
    // Absent care fields are omitted, not written as null/''.
    expect(withCare).not.toHaveProperty('medications');
  });

  it('stamps status, links, mirror origin, and provenance', () => {
    expect(doc.status).toBe('active');
    expect(doc.kinfolkId).toBe('6');
    expect(doc.legacyKinId).toBe('flat-abc');
    expect(doc.familyKinPath).toBe('families/6/kin/adopted-flat-abc');
    // 'flat' origin: suppresses the pets.updated notification in
    // onFamilyKinWrite (flat-echo guard) — a backfill must not spam kinfolk.
    expect(doc._mirrorOrigin).toBe(MIRROR_ORIGIN_FLAT);
    expect(doc.backfilledFromFlat).toBe(true);
  });

  it('maps inactive/archived flat statuses to the portal noLongerWithUs vocab', () => {
    for (const s of ['inactive', 'archived', 'noLongerWithUs']) {
      const d = buildFamilyKinDoc('f1', '6', 'adopted-f1', { ...fullFlatDoc(), status: s });
      expect(d.status).toBe('noLongerWithUs');
    }
  });

  it('omits ageYears when the flat age is unparseable', () => {
    const d = buildFamilyKinDoc('f1', '6', 'adopted-f1', { ...fullFlatDoc(), age: 'unknown' });
    expect(d).not.toHaveProperty('ageYears');
  });

  it('prefers a numeric ageYears already on the flat doc over the age string', () => {
    const d = buildFamilyKinDoc('f1', '6', 'adopted-f1', {
      ...fullFlatDoc(),
      ageYears: 9,
      age: '4 years',
    });
    expect(d.ageYears).toBe(9);
  });

  it('never emits keys outside the mirror ownership lists + known doc scaffolding', () => {
    const allowed = new Set<string>([
      ...PARENT_OWNED_FIELDS,
      ...STAFF_EDITABLE_FIELDS,
      'status',
      'kinfolkId',
      'legacyKinId',
      'familyKinPath',
      '_mirrorOrigin',
      'backfilledFromFlat',
    ]);
    for (const key of Object.keys(doc)) {
      expect(allowed.has(key), `unexpected family kin field: ${key}`).toBe(true);
    }
  });
});

describe('buildFlatStamp', () => {
  it('stamps the symmetric link with family mirror origin so onFlatKinWrite skips it', () => {
    const stamp = buildFlatStamp('flat-abc', '6', 'adopted-flat-abc');
    expect(stamp.path).toBe('kin/flat-abc');
    expect(stamp.merge).toBe(true);
    expect(stamp.data).toEqual({
      familyKinPath: 'families/6/kin/adopted-flat-abc',
      legacyKinId: 'flat-abc',
      _mirrorOrigin: MIRROR_ORIGIN_FAMILY,
    });
  });
});

describe('planAdoption', () => {
  it('adopts a resolvable AuntieOS-only pet with deterministic paths', () => {
    const d = planAdoption({ flatDocId: 'flat-abc', data: fullFlatDoc() }, CTX_OK);
    expect(d.action).toBe('adopt');
    if (d.action !== 'adopt') throw new Error('expected adopt');
    expect(d.familyId).toBe('6');
    expect(d.newKinId).toBe('adopted-flat-abc');
    expect(d.familyWrite.path).toBe('families/6/kin/adopted-flat-abc');
    expect(d.familyWrite.merge).toBe(true);
    expect(d.flatStamp.path).toBe('kin/flat-abc');
  });

  it('is deterministic: replanning the same doc yields an identical plan', () => {
    const input: FlatKinInput = { flatDocId: 'flat-abc', data: fullFlatDoc() };
    expect(planAdoption(input, CTX_OK)).toEqual(planAdoption(input, CTX_OK));
    expect(adoptedKinId('flat-abc')).toBe('adopted-flat-abc');
  });

  it('skips flat docs already carrying familyKinPath (already adopted)', () => {
    const d = planAdoption(
      { flatDocId: 'flat-abc', data: { ...fullFlatDoc(), familyKinPath: 'families/6/kin/x' } },
      CTX_OK,
    );
    expect(d).toMatchObject({ action: 'skip', reason: 'already_adopted' });
  });

  it('skips unresolvable families (no portal account yet), never guesses', () => {
    const d = planAdoption(
      { flatDocId: 'flat-abc', data: fullFlatDoc() },
      { familyExists: false, existingFamilyKinId: null },
    );
    expect(d).toMatchObject({ action: 'skip', reason: 'family_not_provisioned', kinfolkId: '6' });
  });

  it('skips flat docs with no kinfolkId', () => {
    const data = { ...fullFlatDoc() };
    delete (data as Record<string, unknown>).kinfolkId;
    const d = planAdoption({ flatDocId: 'flat-abc', data }, CTX_OK);
    expect(d).toMatchObject({ action: 'skip', reason: 'no_kinfolk_id' });
  });

  it('excludes isTestData docs and the test-kinfolk-001 sandbox tribe', () => {
    const byFlag = planAdoption(
      { flatDocId: 'flat-abc', data: { ...fullFlatDoc(), isTestData: true } },
      CTX_OK,
    );
    expect(byFlag).toMatchObject({ action: 'skip', reason: 'test_data' });

    const byTribe = planAdoption(
      { flatDocId: 'flat-abc', data: { ...fullFlatDoc(), kinfolkId: TEST_TRIBE_ID } },
      CTX_OK,
    );
    expect(byTribe).toMatchObject({ action: 'skip', reason: 'test_data' });

    // Sandbox flat mirrors are keyed test-kinfolk-001-kin-N (seed_test_sandbox).
    const byDocId = planAdoption(
      { flatDocId: `${TEST_TRIBE_ID}-kin-1`, data: fullFlatDoc() },
      CTX_OK,
    );
    expect(byDocId).toMatchObject({ action: 'skip', reason: 'test_data' });
  });

  it('downgrades to stamp-only when a family kin doc with this legacyKinId exists', () => {
    const d = planAdoption(
      { flatDocId: 'flat-abc', data: fullFlatDoc() },
      { familyExists: true, existingFamilyKinId: 'portal-kin-9' },
    );
    expect(d.action).toBe('stamp-only');
    if (d.action !== 'stamp-only') throw new Error('expected stamp-only');
    // The repair stamp points at the EXISTING family doc, not adopted-*.
    expect(d.newKinId).toBe('portal-kin-9');
    expect(d.flatStamp.data.familyKinPath).toBe('families/6/kin/portal-kin-9');
  });
});

describe('planRun', () => {
  const inputs: FlatKinInput[] = [
    { flatDocId: 'b-flat', data: fullFlatDoc() },
    { flatDocId: 'a-flat', data: { ...fullFlatDoc(), kinfolkId: '3', name: 'Mochi' } },
    { flatDocId: 'c-flat', data: { ...fullFlatDoc(), kinfolkId: '99', name: 'Ghost' } },
    { flatDocId: 'd-test', data: { ...fullFlatDoc(), isTestData: true } },
  ];
  const ctx = new Map<string, AdoptionContext>([
    ['a-flat', CTX_OK],
    ['b-flat', CTX_OK],
    ['c-flat', { familyExists: false, existingFamilyKinId: null }], // no portal account
    ['d-test', CTX_OK],
  ]);

  it('plans deterministically (sorted by flat id) and counts skips by reason', () => {
    const plan = planRun(inputs, ctx, { family: null, limit: null });
    expect(plan.decisions.map((d) => d.flatDocId)).toEqual(['a-flat', 'b-flat', 'c-flat', 'd-test']);
    expect(plan.summary).toEqual({
      scanned: 4,
      adopt: 2,
      stampOnly: 0,
      provision: 0,
      skipped: { family_not_provisioned: 1, test_data: 1 },
    });
  });

  it('--family narrows the run without counting filtered docs as skips', () => {
    const plan = planRun(inputs, ctx, { family: '3', limit: null });
    expect(plan.summary.scanned).toBe(1);
    expect(plan.summary.adopt).toBe(1);
    expect(plan.filteredOut).toBe(3);
  });

  it('--limit caps mutating actions; overflow candidates surface as limit_reached', () => {
    const plan = planRun(inputs, ctx, { family: null, limit: 1 });
    expect(plan.summary.adopt).toBe(1);
    expect(plan.summary.skipped.limit_reached).toBe(1);
    // Deterministic order means a-flat (first sorted) wins the slot.
    const adopted = plan.decisions.find((d) => d.action === 'adopt');
    expect(adopted?.flatDocId).toBe('a-flat');
  });

  it('renders the plan table with the required columns', () => {
    const plan = planRun(inputs, ctx, { family: null, limit: null });
    const table = formatPlanTable(plan.decisions);
    expect(table).toContain('flat id');
    expect(table).toContain('pet name');
    expect(table).toContain('kinfolkId');
    expect(table).toContain('familyId / SKIP reason');
    expect(table).toContain('SKIP: family_not_provisioned');
    expect(table).toContain('adopted-a-flat');
  });
});

describe('planRun --provision-families', () => {
  /** Kinfolk doc shape per seed_test_sandbox KinfolkDoc. */
  const kinfolk99: Record<string, unknown> = {
    _id: '99',
    businessName: '',
    displayName: '',
    firstName: 'Ghost',
    lastName: 'Owner',
    email: 'ghost@example.com',
  };
  const NO_FAMILY: AdoptionContext = { familyExists: false, existingFamilyKinId: null };

  it('provisions the missing family once, then adopts every pet of that family', () => {
    const inputs: FlatKinInput[] = [
      { flatDocId: 'p1', data: { ...fullFlatDoc(), kinfolkId: '99', name: 'Ghost' } },
      { flatDocId: 'p2', data: { ...fullFlatDoc(), kinfolkId: '99', name: 'Shadow' } },
    ];
    const ctx = new Map<string, AdoptionContext>([
      ['p1', { ...NO_FAMILY, kinfolkDoc: kinfolk99 }],
      ['p2', { ...NO_FAMILY, kinfolkDoc: kinfolk99 }],
    ]);
    const plan = planRun(inputs, ctx, { family: null, limit: null, provisionFamilies: true });

    // One provision row (deduped), immediately before its first adopt row.
    expect(plan.decisions.map((d) => d.action)).toEqual(['provision', 'adopt', 'adopt']);
    expect(plan.summary).toEqual({
      scanned: 2,
      adopt: 2,
      stampOnly: 0,
      provision: 1,
      skipped: {},
    });

    const prov = plan.decisions[0];
    if (prov.action !== 'provision') throw new Error('expected provision');
    expect(prov.familyId).toBe('99');
    expect(prov.flatDocId).toBe('p1'); // the pet that triggered it
    expect(prov.familyCreate.path).toBe('families/99');
    // Same envelope shape as the onKinfolkCreate trigger, backfill provenance.
    expect(prov.familyCreate.data).toEqual(
      buildFamilyProvisionDoc('99', kinfolk99, PROVISIONED_BY_BACKFILL),
    );
    expect(prov.familyCreate.data).toEqual({
      displayName: 'Ghost Owner',
      primaryUid: '',
      themeConfigRef: 'families/99/themeConfig/active',
      flags: { tribePinSet: false, tribePinChangePending: false, unverified: false },
      provisionedBy: 'backfill_kin_adoption',
    });

    // Adoptions land in the newly provisioned tree.
    const adopts = plan.decisions.filter((d) => d.action === 'adopt');
    expect(adopts).toHaveLength(2);
    for (const a of adopts) {
      if (a.action !== 'adopt') continue;
      expect(a.familyId).toBe('99');
      expect(a.familyWrite.path.startsWith('families/99/kin/adopted-')).toBe(true);
    }
  });

  it('kinfolk doc absent -> skip kinfolk_missing, no provision row', () => {
    const inputs: FlatKinInput[] = [
      { flatDocId: 'p1', data: { ...fullFlatDoc(), kinfolkId: '99' } },
    ];
    const ctx = new Map<string, AdoptionContext>([['p1', { ...NO_FAMILY, kinfolkDoc: null }]]);
    const plan = planRun(inputs, ctx, { family: null, limit: null, provisionFamilies: true });
    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]).toMatchObject({ action: 'skip', reason: 'kinfolk_missing' });
    expect(plan.summary.provision).toBe(0);
  });

  it('kinfolk doc marked isTestData -> skip kinfolk_test_data, never provisioned', () => {
    const inputs: FlatKinInput[] = [
      { flatDocId: 'p1', data: { ...fullFlatDoc(), kinfolkId: '99' } },
    ];
    const ctx = new Map<string, AdoptionContext>([
      ['p1', { ...NO_FAMILY, kinfolkDoc: { ...kinfolk99, isTestData: true } }],
    ]);
    const plan = planRun(inputs, ctx, { family: null, limit: null, provisionFamilies: true });
    expect(plan.decisions[0]).toMatchObject({ action: 'skip', reason: 'kinfolk_test_data' });
    expect(plan.summary.provision).toBe(0);
    expect(plan.summary.adopt).toBe(0);
  });

  it('idempotence: family already exists -> no provision row, plain adopt', () => {
    const inputs: FlatKinInput[] = [
      { flatDocId: 'p1', data: { ...fullFlatDoc(), kinfolkId: '6' } },
    ];
    const ctx = new Map<string, AdoptionContext>([['p1', CTX_OK]]);
    const plan = planRun(inputs, ctx, { family: null, limit: null, provisionFamilies: true });
    expect(plan.decisions.map((d) => d.action)).toEqual(['adopt']);
    expect(plan.summary.provision).toBe(0);
  });

  it('without the flag, behavior is unchanged even when the kinfolk doc is known', () => {
    const inputs: FlatKinInput[] = [
      { flatDocId: 'p1', data: { ...fullFlatDoc(), kinfolkId: '99' } },
    ];
    const ctx = new Map<string, AdoptionContext>([
      ['p1', { ...NO_FAMILY, kinfolkDoc: kinfolk99 }],
    ]);
    const plan = planRun(inputs, ctx, { family: null, limit: null });
    expect(plan.decisions[0]).toMatchObject({ action: 'skip', reason: 'family_not_provisioned' });
    expect(plan.summary.provision).toBe(0);
  });

  it('provision rows count toward --limit; the capped adoption surfaces as limit_reached', () => {
    const inputs: FlatKinInput[] = [
      { flatDocId: 'p1', data: { ...fullFlatDoc(), kinfolkId: '99' } },
    ];
    const ctx = new Map<string, AdoptionContext>([
      ['p1', { ...NO_FAMILY, kinfolkDoc: kinfolk99 }],
    ]);
    const plan = planRun(inputs, ctx, { family: null, limit: 1, provisionFamilies: true });
    expect(plan.decisions.map((d) => d.action)).toEqual(['provision', 'skip']);
    expect(plan.summary.skipped.limit_reached).toBe(1);
  });

  it('renders provision rows in the plan table', () => {
    const inputs: FlatKinInput[] = [
      { flatDocId: 'p1', data: { ...fullFlatDoc(), kinfolkId: '99', name: 'Ghost' } },
    ];
    const ctx = new Map<string, AdoptionContext>([
      ['p1', { ...NO_FAMILY, kinfolkDoc: kinfolk99 }],
    ]);
    const plan = planRun(inputs, ctx, { family: null, limit: null, provisionFamilies: true });
    const table = formatPlanTable(plan.decisions);
    expect(table).toContain('provision');
    expect(table).toContain('adopted-p1');
  });
});
