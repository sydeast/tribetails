import { describe, it, expect } from 'vitest';
import {
  isChecklistItemVisible,
  applicableKinForChecklistItem,
  conditionAttributeCatalog,
  kinfolkAttributeCatalog,
  conditionSourceOptions,
  conditionUsesAttributeKey,
  conditionUsesValueInput,
  conditionSummary,
  type ConditionSession,
} from './engine';
import { makeChecklistItem, makeFieldCondition, type ChecklistItem, type FieldCondition } from './model';
import { mergeKinDetail } from '../../api/kinView';
import { mergeKinfolkProfile } from '../../api/kinfolkProfile';

/**
 * Pins the KinTale conditional-checklist engine. The first block mirrors the
 * Kotlin `KinTaleConditionEngineTest` case-for-case (if these drift, a kinfolk
 * gets a different report depending on which app sent it). The second block
 * covers the I7 household sources (KINFOLK_ATTRIBUTE / KINFOLK_TAG).
 */

// ── fixtures ─────────────────────────────────────────────────────────────────

function session(serviceType = 'Dog Walking'): ConditionSession {
  return { serviceType };
}

function item(conditions: FieldCondition[], scope = 'PER_PET'): ChecklistItem {
  return makeChecklistItem({ key: 'k', text: 't', scope, conditions });
}

function fc(over: Partial<FieldCondition>): FieldCondition {
  return makeFieldCondition(over);
}

const cat = mergeKinDetail('c', { species: 'Cat' });
const dog = mergeKinDetail('d', { species: 'Dog' });
const dogOnMeds = mergeKinDetail('dm', { species: 'Dog', medicationHealthNotes: 'insulin 2x/day' });

// ═══════════════════════════════════════════════════════════════════════════
// Ported cases (mirror KinTaleConditionEngineTest.kt)
// ═══════════════════════════════════════════════════════════════════════════

describe('KinTale engine (ported cases)', () => {
  it('empty conditions are always visible', () => {
    expect(isChecklistItemVisible(item([]), session(), [dog])).toBe(true);
  });

  it('KIN_SPECIES equals matches cat, hides dog', () => {
    const litter = item([fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'Cat' })]);
    expect(isChecklistItemVisible(litter, session(), [cat])).toBe(true);
    expect(isChecklistItemVisible(litter, session(), [dog])).toBe(false);
  });

  it('KIN_SPECIES equals is case-insensitive', () => {
    const litter = item([fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'cat' })]);
    expect(isChecklistItemVisible(litter, session(), [cat])).toBe(true);
  });

  it('KIN_ATTRIBUTE exists (medication)', () => {
    const meds = item([fc({ source: 'KIN_ATTRIBUTE', op: 'EXISTS', attributeKey: 'medicationHealthNotes' })]);
    expect(isChecklistItemVisible(meds, session(), [dogOnMeds])).toBe(true);
    expect(isChecklistItemVisible(meds, session(), [dog])).toBe(false);
  });

  it('SERVICE_TYPE contains (walk)', () => {
    const postWalk = item([fc({ source: 'SERVICE_TYPE', op: 'CONTAINS', value: 'walk' })]);
    expect(isChecklistItemVisible(postWalk, session('Dog Walking'), [dog])).toBe(true);
    expect(isChecklistItemVisible(postWalk, session('Overnight Boarding'), [dog])).toBe(false);
  });

  it('NOT_EQUALS hides when equal', () => {
    const notCat = item([fc({ source: 'KIN_SPECIES', op: 'NOT_EQUALS', value: 'Cat' })]);
    expect(isChecklistItemVisible(notCat, session(), [dog])).toBe(true);
    expect(isChecklistItemVisible(notCat, session(), [cat])).toBe(false);
  });

  it('multiple conditions are ANDed', () => {
    const dogAndMeds = item([
      fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'Dog' }),
      fc({ source: 'KIN_ATTRIBUTE', op: 'EXISTS', attributeKey: 'medicationHealthNotes' }),
    ]);
    expect(isChecklistItemVisible(dogAndMeds, session(), [dogOnMeds])).toBe(true);
    // dog without meds fails the second condition
    expect(isChecklistItemVisible(dogAndMeds, session(), [dog])).toBe(false);
    // cat on meds fails the first condition
    const catOnMeds = mergeKinDetail('cm', { species: 'Cat', medicationHealthNotes: 'thyroid' });
    expect(isChecklistItemVisible(dogAndMeds, session(), [catOnMeds])).toBe(false);
  });

  it('PER_PET is visible if ANY kin matches', () => {
    const litter = item([fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'Cat' })], 'PER_PET');
    // mixed household: one cat, one dog -> visible because the cat matches
    expect(isChecklistItemVisible(litter, session(), [dog, cat])).toBe(true);
    // dog-only household -> hidden
    expect(isChecklistItemVisible(litter, session(), [dog])).toBe(false);
  });

  it('applicableKin filters to matching kin only', () => {
    const litter = item([fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'Cat' })], 'PER_PET');
    expect(applicableKinForChecklistItem(litter, session(), [dog, cat])).toEqual([cat]);
  });

  it('applicableKin with empty conditions returns all kin', () => {
    expect(applicableKinForChecklistItem(item([]), session(), [dog, cat])).toEqual([dog, cat]);
  });

  it('PER_VISIT evaluates against the first kin', () => {
    const catVisit = item([fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'Cat' })], 'PER_VISIT');
    expect(isChecklistItemVisible(catVisit, session(), [cat, dog])).toBe(true);
    expect(isChecklistItemVisible(catVisit, session(), [dog, cat])).toBe(false);
  });

  it('PER_VISIT service-type condition works with no kin', () => {
    const postWalk = item([fc({ source: 'SERVICE_TYPE', op: 'CONTAINS', value: 'walk' })], 'PER_VISIT');
    expect(isChecklistItemVisible(postWalk, session('Dog Walking'), [])).toBe(true);
  });

  it('unknown source is safely visible (fail-open)', () => {
    const garbage = item([fc({ source: 'FROM_THE_FUTURE', op: 'EQUALS', value: 'x' })]);
    expect(isChecklistItemVisible(garbage, session(), [dog])).toBe(true);
  });

  it('unknown op is safely visible (fail-open)', () => {
    const garbage = item([fc({ source: 'KIN_SPECIES', op: 'REGEX_MATCH', value: 'x' })]);
    expect(isChecklistItemVisible(garbage, session(), [dog])).toBe(true);
  });

  it('conditionSummary: species equals is readable', () => {
    expect(conditionSummary(fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'Cat' }))).toBe(
      "Only show when the pet's species is Cat",
    );
  });

  it('conditionSummary: attribute exists is readable', () => {
    expect(
      conditionSummary(fc({ source: 'KIN_ATTRIBUTE', op: 'EXISTS', attributeKey: 'medicationHealthNotes' })),
    ).toBe('Only show when the pet has Medication / health notes');
  });

  it('conditionSummary: service contains is readable', () => {
    expect(conditionSummary(fc({ source: 'SERVICE_TYPE', op: 'CONTAINS', value: 'walk' }))).toBe(
      'Only show when the service type contains walk',
    );
  });

  it('usesAttributeKey only for attribute sources', () => {
    expect(conditionUsesAttributeKey('KIN_ATTRIBUTE')).toBe(true);
    expect(conditionUsesAttributeKey('KIN_SPECIES')).toBe(false);
    expect(conditionUsesAttributeKey('SERVICE_TYPE')).toBe(false);
  });

  it('usesValueInput false for EXISTS, true for comparisons', () => {
    expect(conditionUsesValueInput('EXISTS')).toBe(false);
    expect(conditionUsesValueInput('EQUALS')).toBe(true);
    expect(conditionUsesValueInput('NOT_EQUALS')).toBe(true);
    expect(conditionUsesValueInput('CONTAINS')).toBe(true);
  });

  it('every KIN attribute in the catalog resolves on the engine', () => {
    // A kin with every catalogued attribute populated must satisfy EXISTS for
    // each catalogued key; if readAttribute misses a key the editor offers,
    // this fails, which is exactly the drift to catch at build time.
    const loaded = mergeKinDetail('L', {
      species: 'Dog',
      colorMarkings: 'tan',
      spayedNeutered: true,
      routine: 'am/pm',
      trainingCommands: 'sit',
      feedingBrand: 'Acme',
      vaccinations: 'current',
      medicationHealthNotes: 'insulin',
      vetInfo: 'Dr Paws',
      checklist: 'x',
      reactive: true,
      officeNotes: 'vip',
    });
    for (const attr of conditionAttributeCatalog) {
      const cond = item([fc({ source: 'KIN_ATTRIBUTE', op: 'EXISTS', attributeKey: attr.key })]);
      expect(isChecklistItemVisible(cond, session(), [loaded])).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// I7: household condition sources (KINFOLK_ATTRIBUTE / KINFOLK_TAG)
// ═══════════════════════════════════════════════════════════════════════════

describe('KinTale engine (I7 household sources)', () => {
  const withGate = mergeKinfolkProfile('h1', { gateCode: '4417' });
  const noGate = mergeKinfolkProfile('h2', {});
  const vipHome = mergeKinfolkProfile('h3', { tags: ['VIP', 'new-2026'] });
  const plainHome = mergeKinfolkProfile('h4', { tags: [] });

  it('KINFOLK_ATTRIBUTE equals: matching vs non-matching household', () => {
    const gateIs4417 = item([fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EQUALS', value: '4417', attributeKey: 'gateCode' })], 'PER_VISIT');
    expect(isChecklistItemVisible(gateIs4417, session(), [dog], withGate)).toBe(true);
    expect(isChecklistItemVisible(gateIs4417, session(), [dog], noGate)).toBe(false);
  });

  it('KINFOLK_ATTRIBUTE exists: gate code set vs unset', () => {
    const hasGate = item([fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EXISTS', attributeKey: 'gateCode' })], 'PER_VISIT');
    expect(isChecklistItemVisible(hasGate, session(), [dog], withGate)).toBe(true);
    expect(isChecklistItemVisible(hasGate, session(), [dog], noGate)).toBe(false);
    // no household supplied at all -> reads blank -> not visible
    expect(isChecklistItemVisible(hasGate, session(), [dog])).toBe(false);
  });

  it('KINFOLK_TAG contains: tagged vs untagged household (case-insensitive)', () => {
    const isVip = item([fc({ source: 'KINFOLK_TAG', op: 'CONTAINS', value: 'vip' })], 'PER_VISIT');
    expect(isChecklistItemVisible(isVip, session(), [dog], vipHome)).toBe(true);
    expect(isChecklistItemVisible(isVip, session(), [dog], plainHome)).toBe(false);
    // a different tag is not present
    const isGold = item([fc({ source: 'KINFOLK_TAG', op: 'CONTAINS', value: 'gold' })], 'PER_VISIT');
    expect(isChecklistItemVisible(isGold, session(), [dog], vipHome)).toBe(false);
  });

  it('KINFOLK_TAG exists: any tag vs none', () => {
    const hasAnyTag = item([fc({ source: 'KINFOLK_TAG', op: 'EXISTS' })], 'PER_VISIT');
    expect(isChecklistItemVisible(hasAnyTag, session(), [dog], vipHome)).toBe(true);
    expect(isChecklistItemVisible(hasAnyTag, session(), [dog], plainHome)).toBe(false);
    // blank-only tags do not count as "any tag"
    const blankTags = mergeKinfolkProfile('h5', { tags: ['', '  '] });
    expect(isChecklistItemVisible(hasAnyTag, session(), [dog], blankTags)).toBe(false);
  });

  it('PER_PET item can AND a kin condition with a household tag', () => {
    const catInVipHome = item([
      fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'Cat' }),
      fc({ source: 'KINFOLK_TAG', op: 'CONTAINS', value: 'VIP' }),
    ], 'PER_PET');
    expect(isChecklistItemVisible(catInVipHome, session(), [cat], vipHome)).toBe(true);
    // kin matches, household does not
    expect(isChecklistItemVisible(catInVipHome, session(), [cat], plainHome)).toBe(false);
    // household matches, kin does not
    expect(isChecklistItemVisible(catInVipHome, session(), [dog], vipHome)).toBe(false);
  });

  it('adding a kinfolk arg does not change a kin-only evaluation', () => {
    const litter = item([fc({ source: 'KIN_SPECIES', op: 'EQUALS', value: 'Cat' })]);
    // same verdict with or without a household supplied
    expect(isChecklistItemVisible(litter, session(), [cat])).toBe(true);
    expect(isChecklistItemVisible(litter, session(), [cat], vipHome)).toBe(true);
    expect(isChecklistItemVisible(litter, session(), [cat], plainHome)).toBe(true);
    expect(isChecklistItemVisible(litter, session(), [dog], vipHome)).toBe(false);
  });

  it('every KINFOLK attribute in the catalog resolves on the engine', () => {
    const loadedHome = mergeKinfolkProfile('HH', {
      serviceAddress: '1 Bark Ave',
      gateCode: '4417',
      parkingInstructions: 'driveway',
      entryNotes: 'side door',
      emergencyContactName: 'Sam',
      emergencyContactPhone: '555-0199',
      vetClinicName: 'Paws Clinic',
    });
    for (const attr of kinfolkAttributeCatalog) {
      const cond = item([fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EXISTS', attributeKey: attr.key })], 'PER_VISIT');
      expect(isChecklistItemVisible(cond, session(), [], loadedHome)).toBe(true);
    }
  });

  /**
   * #829, controller ruling: `emergencyContactName`/`emergencyContactPhone`
   * were briefly removed from this catalog on the (wrong) theory that a list
   * has no single value to resolve. Android and Kotlin web still resolve both
   * keys off the FIRST (called-first) contact, and a persisted template
   * condition has to keep meaning the same thing on every client. Restored,
   * resolved through Task 5's `emergencyContactsOf` (array first, legacy flat
   * fallback) so a legacy household resolves identically here and everywhere
   * else `emergencyContactsOf` is the reader.
   */
  it('KINFOLK_ATTRIBUTE resolves the first Emergency Contact, array shape and legacy flat shape alike', () => {
    const arrayShape = mergeKinfolkProfile('h6', {
      emergencyContacts: [
        { name: 'Rae Halbrook', phone: '+15125559090', relationship: 'Sister' },
        { name: 'Lee Park', phone: '+15125550177', relationship: null },
      ],
    });
    const legacyFlatShape = mergeKinfolkProfile('h7', {
      emergencyContactName: 'Priya Shah',
      emergencyContactPhone: '805-555-0199',
    });
    const noContact = mergeKinfolkProfile('h8', {});

    const nameEqualsRae = item(
      [fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EQUALS', value: 'Rae Halbrook', attributeKey: 'emergencyContactName' })],
      'PER_VISIT',
    );
    const phoneEqualsRae = item(
      [fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EQUALS', value: '+15125559090', attributeKey: 'emergencyContactPhone' })],
      'PER_VISIT',
    );
    // Array shape: resolves the FIRST contact, not the second.
    expect(isChecklistItemVisible(nameEqualsRae, session(), [dog], arrayShape)).toBe(true);
    expect(isChecklistItemVisible(phoneEqualsRae, session(), [dog], arrayShape)).toBe(true);

    const nameEqualsPriya = item(
      [fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EQUALS', value: 'Priya Shah', attributeKey: 'emergencyContactName' })],
      'PER_VISIT',
    );
    const phoneEqualsPriya = item(
      [fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EQUALS', value: '805-555-0199', attributeKey: 'emergencyContactPhone' })],
      'PER_VISIT',
    );
    // Legacy flat shape resolves through the same fallback `emergencyContactsOf` uses everywhere.
    expect(isChecklistItemVisible(nameEqualsPriya, session(), [dog], legacyFlatShape)).toBe(true);
    expect(isChecklistItemVisible(phoneEqualsPriya, session(), [dog], legacyFlatShape)).toBe(true);

    const hasEmergencyContactName = item(
      [fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EXISTS', attributeKey: 'emergencyContactName' })],
      'PER_VISIT',
    );
    expect(isChecklistItemVisible(hasEmergencyContactName, session(), [dog], noContact)).toBe(false);
  });

  it('conditionSummary: household attribute exists is readable', () => {
    expect(conditionSummary(fc({ source: 'KINFOLK_ATTRIBUTE', op: 'EXISTS', attributeKey: 'gateCode' }))).toBe(
      "Only show when the household's Gate code is set",
    );
  });

  it('conditionSummary: household tag is readable', () => {
    expect(conditionSummary(fc({ source: 'KINFOLK_TAG', op: 'CONTAINS', value: 'VIP' }))).toBe(
      'Only show when the household is tagged VIP',
    );
    expect(conditionSummary(fc({ source: 'KINFOLK_TAG', op: 'EXISTS' }))).toBe(
      'Only show when the household has any tags',
    );
  });

  it('usesAttributeKey is true for KINFOLK_ATTRIBUTE, false for KINFOLK_TAG', () => {
    expect(conditionUsesAttributeKey('KINFOLK_ATTRIBUTE')).toBe(true);
    expect(conditionUsesAttributeKey('KINFOLK_TAG')).toBe(false);
  });

  it('the editor source list offers all five sources in order', () => {
    expect(conditionSourceOptions.map((o) => o.source)).toEqual([
      'KIN_SPECIES',
      'KIN_ATTRIBUTE',
      'SERVICE_TYPE',
      'KINFOLK_ATTRIBUTE',
      'KINFOLK_TAG',
    ]);
  });
});
