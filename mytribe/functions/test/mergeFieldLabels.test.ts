import { describe, it, expect } from 'vitest';
import { TEMPLATE_FIELDS } from '../src/notifications/enrichTemplateData';
import {
  MERGE_FIELD_LABELS,
  NOTIFICATION_EMITTERS,
  mergeFieldLabelsFor,
} from '../src/notifications/provenance';
/**
 * #1592: the gate's "What the body can carry" list printed raw keys. Every key
 * the server can put in that list must have words, so a key added to a template
 * or an emitter without a label fails here instead of reaching the operator as
 * `startTimeMsList`.
 */
describe('MERGE_FIELD_LABELS', () => {
  const everyKey = new Set<string>();
  for (const fields of Object.values(TEMPLATE_FIELDS)) for (const k of fields) everyKey.add(k);
  for (const emitters of Object.values(NOTIFICATION_EMITTERS)) {
    for (const e of emitters) for (const k of e.dataKeys) everyKey.add(k);
  }
  it('labels every merge field and every emitter data key', () => {
    const missing = [...everyKey].filter((k) => !MERGE_FIELD_LABELS[k]?.trim());
    expect(missing).toEqual([]);
  });
  it('writes labels as words, never as the key or a code', () => {
    for (const [key, label] of Object.entries(MERGE_FIELD_LABELS)) {
      expect(label, key).not.toBe(key);
      expect(label, key).toMatch(/^[A-Z]/);
      // "KinTale" is the product's own word; any other inner capital is a key.
      expect(label.replace(/KinTale/g, 'Kintale'), key).not.toMatch(/[._]|\bId\b|\bUid\b|Ms\b|[a-z][A-Z]/);
    }
  });
  it('returns only the keys it was asked about, and skips ones it has no words for', () => {
    expect(mergeFieldLabelsFor(['kinfolkId', 'notAKey'])).toEqual({ kinfolkId: 'Household reference' });
  });
});
