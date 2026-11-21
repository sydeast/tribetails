import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CARETAKER_MEDIA_TYPES, caretakerMayUseMedia } from '../src/lib/caretakerMedia';

/** Which stored media files an Auntie works with, read exactly as stored. */
describe('caretakerMayUseMedia', () => {
  it('HAPPY: a visit, a Kin and a household file, in each stored spelling', () => {
    for (const entityType of ['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk']) {
      expect(caretakerMayUseMedia({ entityType, entityId: 'e1' }, 'auntie-1')).toBe(true);
    }
  });

  it('HAPPY: her own account photo', () => {
    expect(caretakerMayUseMedia({ entityType: 'USER', entityId: 'auntie-1' }, 'auntie-1')).toBe(true);
  });

  it('NEGATIVE: another account photo is not hers, and neither is one with no owner on it', () => {
    expect(caretakerMayUseMedia({ entityType: 'USER', entityId: 'owner-1' }, 'auntie-1')).toBe(false);
    expect(caretakerMayUseMedia({ entityType: 'USER' }, 'auntie-1')).toBe(false);
    expect(caretakerMayUseMedia({ entityType: 'USER', entityId: '' }, '')).toBe(false);
    expect(caretakerMayUseMedia({ entityType: 'user', entityId: 'auntie-1' }, 'auntie-1')).toBe(false);
  });

  it('NEGATIVE: every other kind is the owner\'s', () => {
    for (const entityType of ['TRIBAL_INTEL', 'BUSINESS', 'INVOICE', 'TRAINING', 'HOUSEHOLD', 'household', 'SOMETHING_NEW']) {
      expect(caretakerMayUseMedia({ entityType, entityId: 'e1' }, 'auntie-1')).toBe(false);
    }
  });

  it('NEGATIVE: the type is compared as stored, with no trimming or case folding', () => {
    for (const entityType of ['Kin', 'Kinfolk', 'visit_log', 'Visit_Log', ' KIN', 'KIN ', 'KIN\n', '']) {
      expect(caretakerMayUseMedia({ entityType, entityId: 'e1' }, 'auntie-1')).toBe(false);
    }
  });

  it('NEGATIVE: a file with no type, or a type that is not a string, is the owner\'s', () => {
    expect(caretakerMayUseMedia({ entityId: 'e1' }, 'auntie-1')).toBe(false);
    expect(caretakerMayUseMedia({ entityType: null, entityId: 'e1' }, 'auntie-1')).toBe(false);
    expect(caretakerMayUseMedia({ entityType: 7, entityId: 'e1' }, 'auntie-1')).toBe(false);
    expect(caretakerMayUseMedia({ entityType: ['KIN'], entityId: 'e1' }, 'auntie-1')).toBe(false);
  });

  it('SAD: no document at all is not hers', () => {
    expect(caretakerMayUseMedia(undefined, 'auntie-1')).toBe(false);
    expect(caretakerMayUseMedia(null, 'auntie-1')).toBe(false);
  });
});

/**
 * The same five values are written down in three places that cannot import one
 * another: `firestore.rules` (twice: the `list` rule spells them out), this
 * package, and admin web's query scope. A value in one and not the others is
 * either a list rules refuse whole or a file one layer hands her and another
 * does not, so each copy is read back here.
 */
describe('the media types an Auntie reads are the same everywhere they are written', () => {
  const repoFile = (path: string) => readFileSync(resolve(__dirname, '../../..', path), 'utf8');
  const quoted = (list: string) => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);

  it('in the rules helper', () => {
    const rules = repoFile('mytribe/firestore.rules');
    const helper = /function caretakerMediaType\(t\) \{\s*return t in \[([^\]]*)\];/.exec(rules);
    expect(helper).not.toBeNull();
    expect(quoted(helper![1]!)).toEqual([...CARETAKER_MEDIA_TYPES]);
  });

  it('in the rules list grant', () => {
    const rules = repoFile('mytribe/firestore.rules');
    const media = rules.slice(rules.indexOf('match /media_files/{id} {'));
    const list = /allow list:[^;]*resource\.data\.entityType in \[([^\]]*)\]/.exec(media.slice(0, media.indexOf('allow delete')));
    expect(list).not.toBeNull();
    expect(quoted(list![1]!)).toEqual([...CARETAKER_MEDIA_TYPES]);
  });

  it('in the admin web query scope', () => {
    const scope = repoFile('auntieos-admin/src/lib/caretakerScope.ts');
    const list = /CARETAKER_MEDIA_TYPES: readonly string\[\] = \[([^\]]*)\]/.exec(scope);
    expect(list).not.toBeNull();
    expect(quoted(list![1]!)).toEqual([...CARETAKER_MEDIA_TYPES]);
  });
});

/**
 * An Auntie's two media lists filter on the type and sort by `uploadedAt`
 * (`auntieos-admin/src/lib/caretakerScope.ts`): the Gallery, and one
 * household's or Kin's Media screen, which also filters on `entityId`.
 * Firestore serves each only from a composite index, and the emulator the
 * rules tests run on does not check for one, so this does.
 */
describe('the indexes behind an Auntie\'s media lists', () => {
  const indexes = JSON.parse(readFileSync(resolve(__dirname, '../../firestore.indexes.json'), 'utf8')) as {
    indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string }[] }[];
  };

  it('the Gallery: type, newest first', () => {
    expect(indexes.indexes).toContainEqual({
      collectionGroup: 'media_files',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'entityType', order: 'ASCENDING' },
        { fieldPath: 'uploadedAt', order: 'DESCENDING' },
      ],
    });
  });

  it('one household\'s or Kin\'s media: its id, type, newest first', () => {
    expect(indexes.indexes).toContainEqual({
      collectionGroup: 'media_files',
      queryScope: 'COLLECTION',
      fields: [
        { fieldPath: 'entityId', order: 'ASCENDING' },
        { fieldPath: 'entityType', order: 'ASCENDING' },
        { fieldPath: 'uploadedAt', order: 'DESCENDING' },
      ],
    });
  });
});
