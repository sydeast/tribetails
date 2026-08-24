import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  commentTimeOf,
  commentDayKey,
  commentWhen,
  commentMachineTime,
  commentAuthorRole,
  commentAuthorLabel,
  loveSummaryLabel,
  kinTaleMediaKindOf,
  buildCommentThread,
  shareLinkPreflightError,
  kinfolkPreviewHeadline,
  kinfolkPreviewBody,
} from './kinTaleDetailFormat';
import type { KinTaleComment } from '../api/kinTaleDetail';

// TZ pinned to a west-of-UTC zone so the AO-18 (local, never UTC-slice)
// assertions below are meaningful on any CI runner, the identical rationale
// as sessionFormat.test.ts / kinTaleFormat.test.ts / inboxFormat.test.ts.
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('commentTimeOf (AO-18: local, never a raw UTC slice)', () => {
  it('degrades honestly on null/non-finite/non-positive/NaN input, never fabricating a date', () => {
    expect(commentTimeOf(null)).toBeNull();
    expect(commentTimeOf(0)).toBeNull();
    expect(commentTimeOf(-1)).toBeNull();
    expect(commentTimeOf(Number.NaN)).toBeNull();
    expect(commentTimeOf(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('groups a late-evening UTC instant under its LOCAL day, not the UTC-next day', () => {
    // 2026-07-16 23:30 America/Chicago (CDT, UTC-5) == 2026-07-17 04:30 UTC.
    const ms = Date.parse('2026-07-17T04:30:00.000Z');
    expect(commentDayKey(ms)).toBe('2026-07-16');
  });
});

describe('commentWhen', () => {
  it('formats LOCAL "MM-DD HH:mm"', () => {
    const ms = Date.parse('2026-07-16T19:32:00.000Z'); // 14:32 CDT
    expect(commentWhen(ms)).toBe('07-16 14:32');
  });

  it('falls back to "Date TBD", never "(no time)", for a missing/unparseable value', () => {
    expect(commentWhen(null)).toBe('Date TBD');
    expect(commentWhen(Number.NaN)).toBe('Date TBD');
  });
});

describe('commentMachineTime', () => {
  it('returns a LOCAL machine-readable datetime for a real value', () => {
    const ms = Date.parse('2026-07-16T19:32:00.000Z');
    expect(commentMachineTime(ms)).toBe('2026-07-16T14:32');
  });

  it('returns undefined for a missing value, never a fabricated attribute', () => {
    expect(commentMachineTime(null)).toBeUndefined();
  });
});

describe('commentAuthorRole (positive enumeration, no negation)', () => {
  it('classifies the two real values the backend writes', () => {
    expect(commentAuthorRole('admin')).toBe('admin');
    expect(commentAuthorRole('kinfolk')).toBe('kinfolk');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(commentAuthorRole(' ADMIN ')).toBe('admin');
  });

  it('buckets any other text as unknown, never guessing a side', () => {
    expect(commentAuthorRole('')).toBe('unknown');
    expect(commentAuthorRole('robot')).toBe('unknown');
  });
});

describe('commentAuthorLabel', () => {
  it('labels staff as Auntie', () => {
    expect(commentAuthorLabel({ authorRole: 'admin', guestName: null })).toBe('Auntie');
  });

  it('labels a kinfolk reply with the real guestName when present', () => {
    expect(commentAuthorLabel({ authorRole: 'kinfolk', guestName: 'Jamie' })).toBe('Jamie');
  });

  it('falls back to "Kinfolk" for a blank/absent guestName, never a fabricated name', () => {
    expect(commentAuthorLabel({ authorRole: 'kinfolk', guestName: null })).toBe('Kinfolk');
    expect(commentAuthorLabel({ authorRole: 'kinfolk', guestName: '   ' })).toBe('Kinfolk');
  });

  it('labels an unrecognized role "Someone", never guessing which side', () => {
    expect(commentAuthorLabel({ authorRole: 'robot', guestName: null })).toBe('Someone');
  });
});

describe('loveSummaryLabel', () => {
  it('reports no reactions honestly', () => {
    expect(loveSummaryLabel(false, 0)).toBe('No reactions yet.');
  });

  it('singular, self-reacted', () => {
    expect(loveSummaryLabel(true, 1)).toBe('You loved this.');
  });

  it('singular, someone else reacted (never claims "you")', () => {
    expect(loveSummaryLabel(false, 1)).toBe('1 person loved this.');
  });

  it('plural, self + others, correct pluralization at exactly one other', () => {
    expect(loveSummaryLabel(true, 2)).toBe('You and 1 other loved this.');
  });

  it('plural, self + several others', () => {
    expect(loveSummaryLabel(true, 4)).toBe('You and 3 others loved this.');
  });

  it('plural, none of them you', () => {
    expect(loveSummaryLabel(false, 3)).toBe('3 people loved this.');
  });
});

describe('kinTaleMediaKindOf (positive enumeration, no negation)', () => {
  it('classifies image/* and video/* MIME types', () => {
    expect(kinTaleMediaKindOf('image/jpeg')).toBe('image');
    expect(kinTaleMediaKindOf('video/mp4')).toBe('video');
  });

  it('is case-insensitive', () => {
    expect(kinTaleMediaKindOf('IMAGE/PNG')).toBe('image');
  });

  it('buckets null/other MIME types as "other", never guessing a preview', () => {
    expect(kinTaleMediaKindOf(null)).toBe('other');
    expect(kinTaleMediaKindOf('application/pdf')).toBe('other');
  });
});

// ── issue #397 S6: reply-to-a-comment threading ───────────────────────────

function comment(over: Partial<KinTaleComment> & { id: string }): KinTaleComment {
  return {
    authorRole: 'kinfolk',
    authorUid: 'kf-uid',
    guestName: null,
    body: 'body',
    parentCommentId: null,
    createdAtMs: 1_000,
    ...over,
  };
}

describe('buildCommentThread', () => {
  it('puts each reply directly under its own parent, in time order', () => {
    const rows = buildCommentThread([
      comment({ id: 'b', createdAtMs: 2_000 }),
      comment({ id: 'a', createdAtMs: 1_000 }),
      comment({ id: 'a2', parentCommentId: 'a', createdAtMs: 3_000 }),
      comment({ id: 'a1', parentCommentId: 'a', createdAtMs: 1_500 }),
    ]);
    expect(rows.map((r) => r.comment.id)).toEqual(['a', 'a1', 'a2', 'b']);
    expect(rows.map((r) => r.isReply)).toEqual([false, true, true, false]);
  });

  it('promotes an orphan reply to its own row rather than dropping it, so no comment ever disappears', () => {
    const rows = buildCommentThread([
      comment({ id: 'a', createdAtMs: 1_000 }),
      comment({ id: 'orphan', parentCommentId: 'deleted', createdAtMs: 2_000 }),
    ]);
    expect(rows.map((r) => r.comment.id)).toEqual(['a', 'orphan']);
    expect(rows.every((r) => !r.isReply)).toBe(true);
  });

  it('treats a blank parentCommentId as top-level, not as an orphan', () => {
    const rows = buildCommentThread([comment({ id: 'a', parentCommentId: '  ' })]);
    expect(rows).toEqual([{ comment: expect.objectContaining({ id: 'a' }), isReply: false }]);
  });

  it('sorts an undated comment first rather than inventing a timestamp for it', () => {
    const rows = buildCommentThread([
      comment({ id: 'dated', createdAtMs: 5_000 }),
      comment({ id: 'undated', createdAtMs: null }),
    ]);
    expect(rows.map((r) => r.comment.id)).toEqual(['undated', 'dated']);
  });

  it('returns nothing for an empty thread', () => {
    expect(buildCommentThread([])).toEqual([]);
  });

  it('does not mutate the caller list', () => {
    const input = [comment({ id: 'b', createdAtMs: 2_000 }), comment({ id: 'a', createdAtMs: 1_000 })];
    buildCommentThread(input);
    expect(input.map((c) => c.id)).toEqual(['b', 'a']);
  });
});

// ── issue #397 S4: share-link preflight ───────────────────────────────────

describe('shareLinkPreflightError', () => {
  it('passes a saved, sent report that names its household', () => {
    expect(shareLinkPreflightError({ id: 'tale1', status: 'SENT', kinfolkId: 'kf1' })).toBeNull();
  });

  it('accepts the status case-insensitively, the way every other status read on this collection does', () => {
    expect(shareLinkPreflightError({ id: 'tale1', status: 'sent', kinfolkId: 'kf1' })).toBeNull();
  });

  it('refuses a draft, naming what to do about it', () => {
    expect(shareLinkPreflightError({ id: 'tale1', status: 'DRAFT', kinfolkId: 'kf1' })).toBe(
      'Send this KinTale first. Only a sent KinTale can be shared.',
    );
  });

  it('refuses an unsaved report', () => {
    expect(shareLinkPreflightError({ id: '', status: 'SENT', kinfolkId: 'kf1' })).toBe(
      'Cannot share: this KinTale has not been saved yet.',
    );
  });

  it('refuses a report with no household to route the link to', () => {
    expect(shareLinkPreflightError({ id: 'tale1', status: 'SENT', kinfolkId: '  ' })).toBe(
      'Cannot share: this KinTale has no kinfolk to route the link to.',
    );
  });
});

// ── issue #397 S5: view-as-kinfolk preview ────────────────────────────────

describe('kinfolkPreviewHeadline', () => {
  const base = { title: '', bodyCopy: '', authorDisplayName: 'Auntie Jo', kinfolkName: 'The Whitfields' };

  it('prefers the authored title', () => {
    expect(kinfolkPreviewHeadline({ ...base, title: 'A great day at the park' })).toBe('A great day at the park');
  });

  it('falls back to the cover line when the report has no title', () => {
    expect(kinfolkPreviewHeadline(base)).toBe('From Auntie Jo for The Whitfields');
  });

  it('names neither party falsely when the report records neither', () => {
    expect(kinfolkPreviewHeadline({ title: '  ', bodyCopy: '', authorDisplayName: '', kinfolkName: '' })).toBe(
      'From Auntie for your kinfolk',
    );
  });
});

describe('kinfolkPreviewBody', () => {
  it('shows the narrative verbatim, whitespace and all', () => {
    expect(kinfolkPreviewBody({ bodyCopy: 'Biscuit had a wonderful time.\n\nHe napped after.' })).toBe(
      'Biscuit had a wonderful time.\n\nHe napped after.',
    );
  });

  it('states that nothing was written rather than inventing prose', () => {
    expect(kinfolkPreviewBody({ bodyCopy: '   ' })).toBe('No narrative was written for this visit.');
  });
});
