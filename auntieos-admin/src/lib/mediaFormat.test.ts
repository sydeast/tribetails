import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mediaKindOf,
  mediaKindHasPreview,
  mediaPreviewUrl,
  mediaViewerUrl,
  mediaCaption,
  mediaMetaLine,
  mediaDurationLabel,
  filterGalleryMedia,
  galleryMonths,
  galleryKinfolkIds,
  galleryFileTypes,
  galleryHasUnattachedMedia,
  mediaTaggedKinIds,
  mediaGpsStripState,
  taggedKinNames,
  taggableKin,
  type TaggableKin,
  UNATTACHED_KINFOLK_ID,
  GALLERY_FILTER_DEFAULT,
  type GalleryFilter,
  type GalleryRow,
  mediaLocalDay,
  mediaLocalMonth,
} from './mediaFormat';

// File-scope TZ pin: the date-keyed suites assert LOCAL day/month keys derived
// from UTC instants; without a fixed zone they pass on a UTC runner and silently
// stop testing AO-18. Pin to a US zone so the local-vs-UTC divergence is real.
let fileOriginalTz: string | undefined;
beforeAll(() => {
  fileOriginalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (fileOriginalTz === undefined) delete process.env.TZ;
  else process.env.TZ = fileOriginalTz;
});

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

describe('mediaViewerUrl (the tile prefers the thumbnail; the viewer wants the original)', () => {
  it('prefers storageUrl over thumbnailUrl, the reverse of mediaPreviewUrl', () => {
    expect(mediaViewerUrl({ thumbnailUrl: 'https://thumb', storageUrl: 'https://full' })).toBe(
      'https://full',
    );
  });

  it('falls back to thumbnailUrl when storageUrl is blank', () => {
    expect(mediaViewerUrl({ thumbnailUrl: 'https://thumb', storageUrl: '' })).toBe('https://thumb');
    expect(mediaViewerUrl({ thumbnailUrl: 'https://thumb', storageUrl: '   ' })).toBe('https://thumb');
  });

  it('is undefined when neither is set: never a fabricated URL', () => {
    expect(mediaViewerUrl({ thumbnailUrl: '', storageUrl: '' })).toBeUndefined();
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

describe('AO-18: local day/month keys, never a raw UTC slice', () => {
  // TZ pinned to America/Chicago at file scope. 01:00 UTC is the PREVIOUS
  // calendar day at 7pm local; a raw .slice(0,10)/.slice(0,7) would bucket it
  // under the UTC (next) day/month, the exact bug the wasm shipped.
  it('keys an evening-local upload under the LOCAL day/month, not the UTC-next', () => {
    expect(mediaLocalDay('2026-07-17T01:00:00.000Z')).toBe('2026-07-16');
    expect(mediaLocalMonth('2026-07-01T01:00:00.000Z')).toBe('2026-06');
  });

  it('degrades honestly on blank/unparseable input, never fabricating a date', () => {
    expect(mediaLocalDay('')).toBe('');
    expect(mediaLocalDay('nope')).toBe('');
    expect(mediaLocalMonth('')).toBeNull();
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
  return { kinfolkId: '', fileType: 'IMAGE', uploadedAt: '2026-07-01T12:00:00.000Z', ...over };
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
      row({ uploadedAt: '2026-06-15T12:00:00.000Z' }),
      row({ uploadedAt: '2026-07-01T12:00:00.000Z' }),
    ];
    const filter: GalleryFilter = { kinfolkId: null, fileType: null, monthPrefix: '2026-07' };
    expect(filterGalleryMedia(rows, filter)).toEqual([row({ uploadedAt: '2026-07-01T12:00:00.000Z' })]);
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
      row({ uploadedAt: '2026-05-01T12:00:00.000Z' }),
      row({ uploadedAt: '2026-07-01T12:00:00.000Z' }),
      row({ uploadedAt: '2026-07-15T12:00:00.000Z' }),
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

describe('galleryHasUnattachedMedia (Company / no household facet)', () => {
  it('is true when at least one row has no resolvable kinfolkId', () => {
    expect(galleryHasUnattachedMedia([row({ kinfolkId: 'a' }), row({ kinfolkId: '' })])).toBe(true);
  });

  it('is false when every row already has a household', () => {
    expect(galleryHasUnattachedMedia([row({ kinfolkId: 'a' }), row({ kinfolkId: 'b' })])).toBe(false);
  });

  it('is false for no rows: never a fabricated facet', () => {
    expect(galleryHasUnattachedMedia([])).toBe(false);
  });

  it('UNATTACHED_KINFOLK_ID filters to exactly the unattached rows via filterGalleryMedia', () => {
    const rows = [row({ kinfolkId: 'a' }), row({ kinfolkId: '' })];
    const filter: GalleryFilter = { kinfolkId: UNATTACHED_KINFOLK_ID, fileType: null, monthPrefix: null };
    expect(filterGalleryMedia(rows, filter)).toEqual([row({ kinfolkId: '' })]);
  });
});

// ── kin tagging (#447) ──────────────────────────────────────────────────────

function kin(over: Partial<TaggableKin> & { _id: string }): TaggableKin {
  return { kinfolkId: 'fam1', name: 'Waddles', ...over };
}

describe('mediaTaggedKinIds (the normalisation point for a raw Firestore field)', () => {
  it('reads the ids a document actually carries', () => {
    expect(mediaTaggedKinIds({ taggedKinIds: ['k1', 'k2'] })).toEqual(['k1', 'k2']);
  });

  it('reads an ABSENT field as no tags, never throwing', () => {
    // The field is missing on every doc written before tagging existed, and on
    // every doc the upload pipeline creates. A throw here is a blank gallery.
    expect(mediaTaggedKinIds({})).toEqual([]);
  });

  it('reads a null or wrong-typed field as no tags', () => {
    expect(mediaTaggedKinIds({ taggedKinIds: null as unknown as string[] })).toEqual([]);
    expect(mediaTaggedKinIds({ taggedKinIds: 'k1' as unknown as string[] })).toEqual([]);
  });

  it('drops non-string, blank and duplicate entries, keeping first-seen order', () => {
    const raw = ['k2', '', ' k1 ', 7, 'k2', null] as unknown as string[];
    expect(mediaTaggedKinIds({ taggedKinIds: raw })).toEqual(['k2', 'k1']);
  });
});

describe('taggedKinNames', () => {
  const byId = new Map<string, TaggableKin>([
    ['k1', kin({ _id: 'k1', name: 'Waddles' })],
    ['k2', kin({ _id: 'k2', name: 'Biscuit' })],
    ['blank', kin({ _id: 'blank', name: '  ' })],
  ]);

  it('resolves ids to names in the order they are tagged', () => {
    expect(taggedKinNames({ taggedKinIds: ['k2', 'k1'] }, byId)).toEqual(['Biscuit', 'Waddles']);
  });

  it('DROPS an id with no matching kin rather than rendering "Unknown"', () => {
    expect(taggedKinNames({ taggedKinIds: ['k1', 'ghost'] }, byId)).toEqual(['Waddles']);
  });

  it('drops a kin whose name is blank', () => {
    expect(taggedKinNames({ taggedKinIds: ['blank'] }, byId)).toEqual([]);
  });

  it('is empty while the roster is still empty, never a list of ids', () => {
    expect(taggedKinNames({ taggedKinIds: ['k1'] }, new Map())).toEqual([]);
  });
});

describe('taggableKin (the same scope rule the saveMediaTags callable enforces)', () => {
  const roster = [
    kin({ _id: 'k1', kinfolkId: 'fam1' }),
    kin({ _id: 'k2', kinfolkId: 'fam1' }),
    kin({ _id: 'k9', kinfolkId: 'fam9' }),
  ];

  it("offers only the photo's own household's kin", () => {
    expect(taggableKin({ kinfolkId: 'fam1' }, roster).map((k) => k._id)).toEqual(['k1', 'k2']);
  });

  it('offers the WHOLE roster for media with no household (company / unattached)', () => {
    expect(taggableKin({ kinfolkId: '' }, roster)).toHaveLength(3);
    expect(taggableKin({}, roster)).toHaveLength(3);
  });

  it('offers nothing when the household has no kin, rather than falling back to everyone', () => {
    expect(taggableKin({ kinfolkId: 'fam-empty' }, roster)).toEqual([]);
  });
});
describe('mediaGpsStripState (#593, the normalisation point for the async video strip)', () => {
  it('reads the three states the job writes', () => {
    expect(mediaGpsStripState({ gpsStripStatus: 'PENDING' })).toBe('pending');
    expect(mediaGpsStripState({ gpsStripStatus: 'STRIPPED' })).toBe('stripped');
    expect(mediaGpsStripState({ gpsStripStatus: 'FAILED' })).toBe('failed');
  });
  it('is case- and whitespace-insensitive: the field is raw Firestore free text', () => {
    expect(mediaGpsStripState({ gpsStripStatus: ' failed ' })).toBe('failed');
    expect(mediaGpsStripState({ gpsStripStatus: 'Stripped' })).toBe('stripped');
  });
  it('reads an ABSENT field as unknown, never as clean', () => {
    // Absent means "no async strip applies here": every image, and every video
    // that predates #593. Reporting those as `stripped` would put a clean bill
    // of health on a video nobody has ever checked.
    expect(mediaGpsStripState({})).toBe('unknown');
    expect(mediaGpsStripState({ gpsStripStatus: undefined })).toBe('unknown');
    expect(mediaGpsStripState({ gpsStripStatus: '' })).toBe('unknown');
  });
  it('reads a value it does not recognise as unknown rather than throwing', () => {
    expect(mediaGpsStripState({ gpsStripStatus: 'RUNNING' })).toBe('unknown');
    expect(mediaGpsStripState({ gpsStripStatus: null as unknown as string })).toBe('unknown');
    expect(mediaGpsStripState({ gpsStripStatus: 7 as unknown as string })).toBe('unknown');
  });
});
