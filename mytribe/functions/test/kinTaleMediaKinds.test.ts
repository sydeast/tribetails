import { describe, it, expect } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { computeThumbs, maintainThumbs, mediaDocToThumb, taleShowsMedia } from '../src/lib/kinTaleThumbs';
import { CARETAKER_MEDIA_TYPES } from '../src/lib/caretakerMedia';

const URL = 'https://res.cloudinary.com/tribetails/image/upload/v1/a.jpg';
const file = (entityType?: unknown) =>
  entityType === undefined
    ? { storageUrl: URL, mimeType: 'image/jpeg' }
    : { storageUrl: URL, mimeType: 'image/jpeg', entityType };

/** The stored kinds a tale never shows: the three written today, and ones nobody writes yet. */
const OTHER_KINDS = ['TRIBAL_INTEL', 'BUSINESS', 'USER', 'INVOICE', 'TRAINING', 'HOUSEHOLD', 'SOMETHING_NEW'];

/** Which stored media files a KinTale shows, read exactly as stored. */
describe('taleShowsMedia', () => {
  it("HAPPY: a visit's, a Kin's and a household's file, in each stored spelling", () => {
    expect([...CARETAKER_MEDIA_TYPES]).toEqual(['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk']);
    for (const kind of CARETAKER_MEDIA_TYPES) expect(taleShowsMedia(file(kind))).toBe(true);
  });

  it('HAPPY: a file with no stored kind, an older or seeded row, still shows', () => {
    expect(taleShowsMedia(file())).toBe(true);
    expect(taleShowsMedia(file(null))).toBe(true);
    expect(taleShowsMedia(file(''))).toBe(true);
  });

  it('NEGATIVE: a file stored as any other kind does not', () => {
    for (const kind of OTHER_KINDS) expect(taleShowsMedia(file(kind))).toBe(false);
  });

  it('NEGATIVE: the kind is compared as stored, with no trimming or case folding', () => {
    for (const kind of ['Kin', 'Kinfolk', 'visit_log', ' KIN', 'KIN ', ' ']) {
      expect(taleShowsMedia(file(kind))).toBe(false);
    }
  });

  it('NEGATIVE: a kind that is not a string does not', () => {
    expect(taleShowsMedia(file(7))).toBe(false);
    expect(taleShowsMedia(file(['KIN']))).toBe(false);
    expect(taleShowsMedia(file(false))).toBe(false);
  });

  it('SAD: no document at all does not', () => {
    expect(taleShowsMedia(undefined)).toBe(false);
  });
});

describe('mediaDocToThumb', () => {
  it('HAPPY: a tale photo becomes a thumbnail, with or without a stored kind', () => {
    const thumb = { id: 'm1', url: URL, contentType: 'image/jpeg' };
    expect(mediaDocToThumb('m1', file('VISIT_LOG'))).toEqual(thumb);
    expect(mediaDocToThumb('m1', file())).toEqual(thumb);
  });

  it('NEGATIVE: a file of another kind is no thumbnail, even with an address on it', () => {
    for (const kind of OTHER_KINDS) expect(mediaDocToThumb('m1', file(kind))).toBeNull();
  });

  it('SAD: a tale photo with no address is still no thumbnail', () => {
    expect(mediaDocToThumb('m1', { entityType: 'VISIT_LOG', storageUrl: '' })).toBeNull();
    expect(mediaDocToThumb('m1', undefined)).toBeNull();
  });
});

/** The stored preview on the tale, which both admin clients and the portal read. */
describe("a tale's stored thumbnails", () => {
  const docs = {
    'media_files/visit': file('VISIT_LOG'),
    'media_files/kin': file('kin'),
    'media_files/older': file(),
    'media_files/intel': file('TRIBAL_INTEL'),
    'media_files/company': file('BUSINESS'),
    'media_files/account': file('USER'),
  };

  it('HAPPY: computeThumbs keeps the tale photos in order and leaves the other kinds out', async () => {
    const ctx = buildDbMock({ docs });
    const thumbs = await computeThumbs(ctx.db as never, ['intel', 'visit', 'company', 'kin', 'account', 'older', 'gone']);
    expect(thumbs.map((t) => t.id)).toEqual(['visit', 'kin', 'older']);
    expect(thumbs.every((t) => t.url === URL)).toBe(true);
  });

  it('NEGATIVE: a tale whose ids are all another kind stores an empty preview, not their addresses', async () => {
    const ctx = buildDbMock({ docs: { ...docs, 'kin_care_reports/r1': { mediaFileIds: [] } } });
    const ref = ctx.db.doc('kin_care_reports/r1');
    const outcome = await maintainThumbs(
      ctx.db as never,
      ref as never,
      { mediaFileIds: [] },
      { mediaFileIds: ['intel', 'company', 'account'] },
    );
    expect(outcome).toBe('written');
    const write = ctx.writes.find((w) => w.path === 'kin_care_reports/r1');
    expect(write?.data['thumbs']).toEqual([]);
    expect(JSON.stringify(ctx.writes)).not.toContain(URL);
  });
});
