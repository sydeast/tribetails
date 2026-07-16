import { describe, expect, it } from 'vitest';
import {
  commentAuthorLabel,
  commentAvatarVariant,
  commentBadge,
  filterTales,
  initialOf,
  loveLine,
  nextTalesCursor,
  shortTimestamp,
  taleMetaLabel,
  threadComments,
  type KinTaleCommentDto,
} from './kinTalesApi';
import type { KinTaleDto } from './types';

function tale(overrides: Partial<KinTaleDto>): KinTaleDto {
  return {
    id: 't1',
    title: '',
    body: 'A fine walk.',
    authorDisplayName: 'Maya',
    mediaIds: [],
    sentAtMs: null,
    shared: false,
    ...overrides,
  };
}

function comment(overrides: Partial<KinTaleCommentDto>): KinTaleCommentDto {
  return {
    id: 'c1',
    authorRole: 'kinfolk',
    authorUid: 'uid-1',
    guestName: null,
    body: 'Nice!',
    parentCommentId: null,
    createdAtMs: 1000,
    ...overrides,
  };
}

describe('filterTales', () => {
  const tales = [tale({ id: 'a', mediaIds: ['m1'] }), tale({ id: 'b', mediaIds: [] })];

  it('all returns everything', () => {
    expect(filterTales(tales, 'all')).toEqual(tales);
  });

  it('lore keeps only tales with no media', () => {
    expect(filterTales(tales, 'lore').map((t) => t.id)).toEqual(['b']);
  });

  it('gallery keeps only tales with media', () => {
    expect(filterTales(tales, 'gallery').map((t) => t.id)).toEqual(['a']);
  });
});

describe('nextTalesCursor', () => {
  it('returns the last tale sentAtMs', () => {
    const tales = [tale({ id: 'a', sentAtMs: 500 }), tale({ id: 'b', sentAtMs: 200 })];
    expect(nextTalesCursor(tales)).toBe(200);
  });

  it('returns undefined for an empty list', () => {
    expect(nextTalesCursor([])).toBeUndefined();
  });

  it('returns undefined when the last tale has no sentAtMs', () => {
    expect(nextTalesCursor([tale({ sentAtMs: null })])).toBeUndefined();
  });
});

describe('threadComments', () => {
  it('splits top-level vs one level of replies, each sorted oldest-first', () => {
    const comments = [
      comment({ id: 'reply-b', parentCommentId: 'top-1', createdAtMs: 300 }),
      comment({ id: 'top-2', createdAtMs: 200 }),
      comment({ id: 'top-1', createdAtMs: 100 }),
      comment({ id: 'reply-a', parentCommentId: 'top-1', createdAtMs: 150 }),
    ];
    const { topLevel, repliesByParent } = threadComments(comments);
    expect(topLevel.map((c) => c.id)).toEqual(['top-1', 'top-2']);
    expect(repliesByParent['top-1']!.map((c) => c.id)).toEqual(['reply-a', 'reply-b']);
    expect(repliesByParent['top-2']).toBeUndefined();
  });

  it('treats missing createdAtMs as 0 for sorting', () => {
    const comments = [comment({ id: 'x', createdAtMs: null }), comment({ id: 'y', createdAtMs: 5 })];
    expect(threadComments(comments).topLevel.map((c) => c.id)).toEqual(['x', 'y']);
  });
});

describe('commentAuthorLabel', () => {
  it('labels admin comments as Auntie', () => {
    expect(commentAuthorLabel(comment({ authorRole: 'admin' }), null)).toBe('Auntie');
  });

  it('labels guest comments with their name', () => {
    expect(commentAuthorLabel(comment({ guestName: 'Grandma Rose' }), null)).toBe('Grandma Rose (Guest)');
  });

  it('labels the current user’s own comment as You', () => {
    expect(commentAuthorLabel(comment({ authorUid: 'me' }), 'me')).toBe('You');
  });

  it('falls back to the generic Kinfolk label', () => {
    expect(commentAuthorLabel(comment({ authorUid: 'someone-else' }), 'me')).toBe('Kinfolk');
  });
});

describe('commentBadge', () => {
  it('badges admins and kinfolk as kin', () => {
    expect(commentBadge(comment({ authorRole: 'admin' }))).toEqual({ label: 'Auntie', tone: 'kin' });
    expect(commentBadge(comment({ authorRole: 'kinfolk' }))).toEqual({ label: 'Kinfolk', tone: 'kin' });
  });

  it('badges guests distinctly', () => {
    expect(commentBadge(comment({ guestName: 'Grandma Rose' }))).toEqual({ label: 'Guest', tone: 'guest' });
  });
});

describe('commentAvatarVariant', () => {
  it('cycles c1/c2/c3', () => {
    expect([0, 1, 2, 3, 4].map(commentAvatarVariant)).toEqual(['c1', 'c2', 'c3', 'c1', 'c2']);
  });
});

describe('initialOf', () => {
  it('uppercases the first character', () => {
    expect(initialOf('jordan')).toBe('J');
  });

  it('falls back to ? for blank input', () => {
    expect(initialOf('   ')).toBe('?');
    expect(initialOf('')).toBe('?');
  });
});

describe('shortTimestamp', () => {
  it('combines relative day + time, uppercased', () => {
    const now = new Date(2026, 5, 10, 9, 31).getTime();
    expect(shortTimestamp(now, now)).toBe('TODAY, 9:31 AM');
  });

  it('returns empty string for null', () => {
    expect(shortTimestamp(null)).toBe('');
  });
});

describe('taleMetaLabel', () => {
  it('combines photo count and timestamp', () => {
    const sentAtMs = new Date(2026, 5, 10, 9, 14).getTime();
    expect(taleMetaLabel(tale({ mediaIds: ['a', 'b'], sentAtMs }), sentAtMs)).toBe('2 PHOTOS · TODAY, 9:14 AM');
  });

  it('uses singular PHOTO for exactly one', () => {
    expect(taleMetaLabel(tale({ mediaIds: ['a'], sentAtMs: null }))).toBe('1 PHOTO');
  });

  it('is empty when there is no media and no timestamp', () => {
    expect(taleMetaLabel(tale({ mediaIds: [], sentAtMs: null }))).toBe('');
  });
});

describe('loveLine', () => {
  it('matches the mockup exactly: loved by me + 2 others', () => {
    expect(loveLine({ loved: true, loveCount: 3 })).toBe('You and 2 others loved this');
  });

  it('singular "other" for exactly one other', () => {
    expect(loveLine({ loved: true, loveCount: 2 })).toBe('You and 1 other loved this');
  });

  it('just "You loved this" when nobody else has', () => {
    expect(loveLine({ loved: true, loveCount: 1 })).toBe('You loved this');
  });

  it('"N people loved this" when others loved it but not me', () => {
    expect(loveLine({ loved: false, loveCount: 3 })).toBe('3 people loved this');
  });

  it('singular "person" for exactly one other', () => {
    expect(loveLine({ loved: false, loveCount: 1 })).toBe('1 person loved this');
  });

  it('invites the first love when nobody has reacted', () => {
    expect(loveLine({ loved: false, loveCount: 0 })).toBe('Be the first to love this');
  });
});
