import { describe, it, expect } from 'vitest';
import {
  mediaKindOf,
  mediaKindHasPreview,
  mediaPreviewUrl,
  mediaCaption,
  mediaMetaLine,
  mediaDurationLabel,
  filterGalleryMedia,
  galleryMonths,
  galleryKinfolkIds,
  galleryFileTypes,
  GALLERY_FILTER_DEFAULT,
  type GalleryFilter,
  type GalleryRow,
} from './mediaFormat';

describe('mediaKindOf (positive enumeration, never by negation)', () => {
  it('matches every real fileType code any writer sets, case-insensitively', () => {
    expect(mediaKindOf('IMAGE')).toBe('image');
    expect(mediaKindOf('image')).toBe('image');
    expect(mediaKindOf('VIDEO')).toBe('video');
    expect(mediaKindOf('DOCUMENT')).toBe('document');
    expect(mediaKindOf('AUDIO')).toBe('audio');
  });

  it('an unrecognized or blank fileType is honestly "other", never silently folded into "document"', () => {
    expect(mediaKindOf('')).toBe('other');
    expect(mediaKindOf('some_future_type')).toBe('other');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(mediaKindOf('  video  ')).toBe('video');
  });
});

describe('mediaKindHasPreview', () => {
  it('is true only for image/video, the two kinds with a visual frame', () => {
    expect(mediaKindHasPreview('image')).toBe(true);
    expect(mediaKindHasPreview('video')).toBe(true);
    expect(mediaKindHasPreview('document')).toBe(false);
    expect(mediaKindHasPreview('audio')).toBe(false);
    expect(mediaKindHasPreview('other')).toBe(false);
  });
});

describe('mediaPreviewUrl', () => {
  it('prefers thumbnailUrl over storageUrl', () => {
    expect(mediaPreviewUrl({ thumbnailUrl: 'https://thumb', storageUrl: 'https://full' })).toBe(
      'https://thumb',
    );
  });

  it('falls back to storageUrl when thumbnailUrl is blank', () => {
    expect(mediaPreviewUrl({ thumbnailUrl: '', storageUrl: 'https://full' })).toBe('https://full');
    expect(mediaPreviewUrl({ thumbnailUrl: '   ', storageUrl: 'https://full' })).toBe('https://full');
  });

  it('is undefined when neither is set: never a fabricated URL', () => {
    expect(mediaPreviewUrl({ thumbnailUrl: '', storageUrl: '' })).toBeUndefined();
  });
});

describe('mediaCaption', () => {
  it('prefers description over originalFileName', () => {
    expect(mediaCaption({ description: 'Rufus at the park', originalFileName: 'IMG_0192.jpg' })).toBe(
      'Rufus at the park',
    );
  });

  it('falls back to originalFileName when description is blank', () => {
    expect(mediaCaption({ description: '', originalFileName: 'IMG_0192.jpg' })).toBe('IMG_0192.jpg');
    expect(mediaCaption({ description: '   ', originalFileName: 'IMG_0192.jpg' })).toBe('IMG_0192.jpg');
  });

  it('is "" when both are blank: never a fabricated placeholder caption', () => {
    expect(mediaCaption({ description: '', originalFileName: '' })).toBe('');
  });
});

describe('mediaMetaLine', () => {
  it('joins a real date and a real author with " · "', () => {
    expect(mediaMetaLine('2026-07-16T09:03:00.000Z', 'Jamie')).toBe('2026-07-16 · Jamie');
  });

  it('drops the author when it is blank', () => {
    expect(mediaMetaLine('2026-07-16T09:03:00.000Z', '')).toBe('2026-07-16');
    expect(mediaMetaLine('2026-07-16T09:03:00.000Z', '   ')).toBe('2026-07-16');
  });

  it('drops the placeholder "auntie" author, case-insensitively, same as the wasm source', () => {
    expect(mediaMetaLine('2026-07-16T09:03:00.000Z', 'auntie')).toBe('2026-07-16');
    expect(mediaMetaLine('2026-07-16T09:03:00.000Z', 'AUNTIE')).toBe('2026-07-16');
  });

  it('drops the date when uploadedAt is unparseable: never fabricates one', () => {
    expect(mediaMetaLine('not a date', 'Jamie')).toBe('Jamie');
  });

  it('is "" when nothing real remains', () => {
    expect(mediaMetaLine('', '')).toBe('');
    expect(mediaMetaLine('garbage', 'auntie')).toBe('');
  });
});

describe('mediaDurationLabel', () => {
  it('formats under an hour as m:ss', () => {
    expect(mediaDurationLabel(75)).toBe('1:15');
    expect(mediaDurationLabel(9)).toBe('0:09');
  });

  it('formats an hour or more as h:mm:ss', () => {
    expect(mediaDurationLabel(3725)).toBe('1:02:05');
  });

  it('is undefined for zero, negative, or non-finite input: never fabricates "0:00" for a photo', () => {
    expect(mediaDurationLabel(0)).toBeUndefined();
    expect(mediaDurationLabel(-5)).toBeUndefined();
    expect(mediaDurationLabel(NaN)).toBeUndefined();
    expect(mediaDurationLabel(Infinity)).toBeUndefined();
  });
});

function row(over: Partial<GalleryRow>): GalleryRow {
  return { kinfolkId: '', fileType: 'IMAGE', uploadedAt: '2026-07-01T00:00:00.000Z', ...over };
}

describe('filterGalleryMedia', () => {
  it('GALLERY_FILTER_DEFAULT (all null) passes every row through unchanged, in order', () => {
    const rows = [row({ kinfolkId: 'a' }), row({ kinfolkId: 'b' })];
    expect(filterGalleryMedia(rows, GALLERY_FILTER_DEFAULT)).toEqual(rows);
  });

  it('filters by kinfolkId', () => {
    const rows = [row({ kinfolkId: 'a' }), row({ kinfolkId: 'b' })];
    const filter: GalleryFilter = { kinfolkId: 'b', fileType: null, monthPrefix: null };
    expect(filterGalleryMedia(rows, filter)).toEqual([row({ kinfolkId: 'b' })]);
  });

  it('filters by fileType, case-insensitively', () => {
    const rows = [row({ fileType: 'IMAGE' }), row({ fileType: 'VIDEO' })];
    const filter: GalleryFilter = { kinfolkId: null, fileType: 'video', monthPrefix: null };
    expect(filterGalleryMedia(rows, filter)).toEqual([row({ fileType: 'VIDEO' })]);
  });

  it('filters by monthPrefix', () => {
    const rows = [
      row({ uploadedAt: '2026-06-15T00:00:00.000Z' }),
      row({ uploadedAt: '2026-07-01T00:00:00.000Z' }),
    ];
    const filter: GalleryFilter = { kinfolkId: null, fileType: null, monthPrefix: '2026-07' };
    expect(filterGalleryMedia(rows, filter)).toEqual([row({ uploadedAt: '2026-07-01T00:00:00.000Z' })]);
  });

  it('does not re-sort: the caller\'s stream order is preserved', () => {
    const rows = [row({ kinfolkId: 'z' }), row({ kinfolkId: 'a' })];
    const result = filterGalleryMedia(rows, GALLERY_FILTER_DEFAULT);
    expect(result.map((r) => r.kinfolkId)).toEqual(['z', 'a']);
  });
});

describe('galleryMonths', () => {
  it('returns distinct YYYY-MM buckets, newest first', () => {
    const rows = [
      row({ uploadedAt: '2026-05-01T00:00:00.000Z' }),
      row({ uploadedAt: '2026-07-01T00:00:00.000Z' }),
      row({ uploadedAt: '2026-07-15T00:00:00.000Z' }),
    ];
    expect(galleryMonths(rows)).toEqual(['2026-07', '2026-05']);
  });

  it('drops an unparseable uploadedAt rather than a fabricated bucket', () => {
    expect(galleryMonths([row({ uploadedAt: 'not a date' })])).toEqual([]);
  });

  it('is empty for no rows', () => {
    expect(galleryMonths([])).toEqual([]);
  });
});

describe('galleryKinfolkIds', () => {
  it('returns distinct, non-blank kinfolkIds', () => {
    const rows = [row({ kinfolkId: 'a' }), row({ kinfolkId: '' }), row({ kinfolkId: 'a' }), row({ kinfolkId: 'b' })];
    expect(galleryKinfolkIds(rows)).toEqual(['a', 'b']);
  });
});

describe('galleryFileTypes', () => {
  it('returns distinct, non-blank fileTypes, alphabetical', () => {
    const rows = [row({ fileType: 'VIDEO' }), row({ fileType: 'IMAGE' }), row({ fileType: 'VIDEO' })];
    expect(galleryFileTypes(rows)).toEqual(['IMAGE', 'VIDEO']);
  });
});
