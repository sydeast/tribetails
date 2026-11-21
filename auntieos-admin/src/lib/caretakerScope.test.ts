import { beforeEach, describe, expect, it } from 'vitest';
import { applyCaretakerScope, CARETAKER_FILTERS, isCaretakerScope, setCaretakerScope } from './caretakerScope';
import { applyTestScope, setTestScope } from './testScope';
import { GENERATED_DRAFTS_QUERY } from '../api/drafts';
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
    for (const path of ['kin_care_reports', 'kin_care_sessions', 'kinfolk', 'kin', 'media_files', 'kintale_templates']) {
      const spec: CollectionSpec = { path, order: ['createdAt', 'desc'], max: 200 };
      expect(applyCaretakerScope(spec)).toBe(spec);
    }
  });

  it('names exactly one collection, with the generator\'s spelling of the type', () => {
    expect([...CARETAKER_FILTERS.entries()]).toEqual([['generated_drafts', KINTALE_DRAFTS]]);
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
