import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyCaretakerScope,
  CARETAKER_FILTERS,
  CARETAKER_MEDIA_TYPES,
  isCaretakerScope,
  setCaretakerScope,
} from './caretakerScope';
import { applyTestScope, setTestScope } from './testScope';
import { GENERATED_DRAFTS_QUERY } from '../api/drafts';
import { GALLERY_QUERY } from '../api/gallery';
import { mediaTargetQuery } from '../api/media';
import { type CollectionSpec } from './firestore';

/**
 * An Auntie reads KinTale drafts only, and rules refuse a drafts list that does
 * not say so. Home's "KinTales pending" panel and the KinTales list both read
 * `GENERATED_DRAFTS_QUERY`, so the predicate is added to that one spec here.
 */
describe('applyCaretakerScope', () => {
  const KINTALE_DRAFTS = ['communication_type', '==', 'visit_report'];

  beforeEach(() => {
    setCaretakerScope(false);
    setTestScope(null);
  });

  it('HAPPY: an Auntie\'s drafts list names the KinTale type', () => {
    setCaretakerScope(true);
    expect(applyCaretakerScope(GENERATED_DRAFTS_QUERY)).toEqual({
      path: 'generated_drafts',
      order: ['createdOn', 'desc'],
      max: 50,
      filters: [KINTALE_DRAFTS],
    });
  });

  it('HAPPY: the owner\'s drafts list is left as it is, every type included', () => {
    expect(applyCaretakerScope(GENERATED_DRAFTS_QUERY)).toBe(GENERATED_DRAFTS_QUERY);
    expect(applyCaretakerScope(GENERATED_DRAFTS_QUERY).filters).toBeUndefined();
  });

  it('keeps a filter the screen supplied beside the type', () => {
    setCaretakerScope(true);
    const spec: CollectionSpec = { ...GENERATED_DRAFTS_QUERY, filters: [['kinfolk_id', '==', 'kf-1']] };
    expect(applyCaretakerScope(spec).filters).toEqual([['kinfolk_id', '==', 'kf-1'], KINTALE_DRAFTS]);
  });

  it('applied twice it adds the type once', () => {
    setCaretakerScope(true);
    expect(applyCaretakerScope(applyCaretakerScope(GENERATED_DRAFTS_QUERY)).filters).toEqual([KINTALE_DRAFTS]);
  });

  it('NEGATIVE: a filter for another type does not stand in for the KinTale type', () => {
    setCaretakerScope(true);
    const spec: CollectionSpec = { ...GENERATED_DRAFTS_QUERY, filters: [['communication_type', '==', 'push']] };
    expect(applyCaretakerScope(spec).filters).toEqual([['communication_type', '==', 'push'], KINTALE_DRAFTS]);
  });

  it('leaves every other collection alone for an Auntie', () => {
    setCaretakerScope(true);
    for (const path of ['kin_care_reports', 'kin_care_sessions', 'kinfolk', 'kin', 'visit_logs', 'kintale_templates']) {
      const spec: CollectionSpec = { path, order: ['createdAt', 'desc'], max: 200 };
      expect(applyCaretakerScope(spec)).toBe(spec);
    }
  });

  it('names exactly two collections: drafts by the generator\'s spelling of the type, media by its stored types', () => {
    expect([...CARETAKER_FILTERS.entries()]).toEqual([
      ['generated_drafts', KINTALE_DRAFTS],
      ['media_files', ['entityType', 'in', ['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk']]],
    ]);
  });

  it('switching back to the owner removes the type from the next query', () => {
    setCaretakerScope(true);
    expect(isCaretakerScope()).toBe(true);
    setCaretakerScope(false);
    expect(isCaretakerScope()).toBe(false);
    expect(applyCaretakerScope(GENERATED_DRAFTS_QUERY).filters).toBeUndefined();
  });

  it('a sandbox account keeps its own scope and gets no KinTale type', () => {
    setTestScope('test-kinfolk-001');
    expect(applyCaretakerScope(applyTestScope(GENERATED_DRAFTS_QUERY)).filters).toEqual([
      ['kinfolk_id', '==', 'test-kinfolk-001'],
    ]);
  });
});
/**
 * An Auntie reads the files of her own work: a visit's KinTale photos, a Kin's
 * photos and a household's photos. Rules refuse a media list that does not name
 * those types, so the Gallery's query and the Media screen's both get them here.
 */
describe('applyCaretakerScope: media', () => {
  const HER_MEDIA = ['entityType', 'in', ['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk']];
  beforeEach(() => {
    setCaretakerScope(false);
    setTestScope(null);
  });
  it('HAPPY: an Auntie\'s Gallery list names her types, still sorted and capped', () => {
    setCaretakerScope(true);
    expect(applyCaretakerScope(GALLERY_QUERY)).toEqual({
      path: 'media_files',
      order: ['uploadedAt', 'desc'],
      max: 500,
      filters: [HER_MEDIA],
    });
  });
  it('HAPPY: her Media screen keeps its household or Kin and names her types beside it', () => {
    setCaretakerScope(true);
    expect(applyCaretakerScope(mediaTargetQuery('kin_7')).filters).toEqual([['entityId', '==', 'kin_7'], HER_MEDIA]);
  });
  it('HAPPY: the owner\'s Gallery and Media lists are left as they are, every type included', () => {
    expect(applyCaretakerScope(GALLERY_QUERY)).toBe(GALLERY_QUERY);
    expect(applyCaretakerScope(GALLERY_QUERY).filters).toBeUndefined();
    expect(applyCaretakerScope(mediaTargetQuery('kin_7')).filters).toEqual([['entityId', '==', 'kin_7']]);
  });
  it('the types are the five stored spellings, and no others', () => {
    expect([...CARETAKER_MEDIA_TYPES]).toEqual(['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk']);
    for (const type of ['TRIBAL_INTEL', 'BUSINESS', 'USER', 'INVOICE', 'TRAINING', 'HOUSEHOLD']) {
      expect(CARETAKER_MEDIA_TYPES).not.toContain(type);
    }
  });
  it('applied twice it names the types once', () => {
    setCaretakerScope(true);
    expect(applyCaretakerScope(applyCaretakerScope(GALLERY_QUERY)).filters).toEqual([HER_MEDIA]);
  });
  it('applied to a copy of its own result it still names the types once', () => {
    setCaretakerScope(true);
    const copy = JSON.parse(JSON.stringify(applyCaretakerScope(GALLERY_QUERY))) as CollectionSpec;
    expect(applyCaretakerScope(copy).filters).toEqual([HER_MEDIA]);
  });
  it('NEGATIVE: a filter for one type, or for a type outside hers, does not stand in for her types', () => {
    setCaretakerScope(true);
    for (const type of ['KIN', 'TRIBAL_INTEL']) {
      const spec: CollectionSpec = { ...GALLERY_QUERY, filters: [['entityType', '==', type]] };
      expect(applyCaretakerScope(spec).filters).toEqual([['entityType', '==', type], HER_MEDIA]);
    }
    const wider: CollectionSpec = {
      ...GALLERY_QUERY,
      filters: [['entityType', 'in', [...CARETAKER_MEDIA_TYPES, 'TRIBAL_INTEL']]],
    };
    expect(applyCaretakerScope(wider).filters).toHaveLength(2);
    expect(applyCaretakerScope(wider).filters?.[1]).toEqual(HER_MEDIA);
  });
  it('NEGATIVE: the blank-target Media query stays pinned to its sentinel and gains the types', () => {
    setCaretakerScope(true);
    const filters = applyCaretakerScope(mediaTargetQuery('  ')).filters ?? [];
    expect(filters).toHaveLength(2);
    expect(filters[0]?.[0]).toBe('entityId');
    expect(filters[1]).toEqual(HER_MEDIA);
  });
  it('a sandbox account keeps its own scope and gets no media types', () => {
    setTestScope('test-kinfolk-001');
    expect(applyCaretakerScope(applyTestScope(GALLERY_QUERY)).filters).toEqual([['kinfolkId', '==', 'test-kinfolk-001']]);
  });
  it('switching back to the owner removes the types from the next query', () => {
    setCaretakerScope(true);
    expect(applyCaretakerScope(GALLERY_QUERY).filters).toEqual([HER_MEDIA]);
    setCaretakerScope(false);
    expect(applyCaretakerScope(GALLERY_QUERY).filters).toBeUndefined();
  });
});
