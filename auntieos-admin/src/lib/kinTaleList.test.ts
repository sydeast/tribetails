import { describe, it, expect } from 'vitest';
import {
  draftBody,
  draftCreatedAt,
  draftHousehold,
  draftKinfolkId,
  draftStatusAsKinTaleStatus,
  draftTitle,
  draftTypeLabel,
  draftsInWindow,
  kinTaleListRows,
  mergeByCreatedDesc,
  rowFromDraft,
  rowFromReport,
  type KinTaleListRow,
} from './kinTaleList';
import { kinTaleState } from './kinTaleFormat';
import type { KinTaleEntry } from '../api/kinTales';
import type { GeneratedDraftRow } from '../api/drafts';

function report(over: Partial<KinTaleEntry> = {}): KinTaleEntry {
  return {
    _id: 'r1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    status: 'SENT',
    createdAt: '2026-07-16T12:00:00.000Z',
    ...over,
  };
}

/** A migrated / n8n-era draft: camelCase, `createdOn`. */
function draft(over: Partial<GeneratedDraftRow> = {}): GeneratedDraftRow {
  return {
    _id: 'd1',
    kinfolk_id: 'kf1',
    kinfolkName: 'The Whitfields',
    communicationType: 'visit_report',
    generatedCopy: 'Biscuit napped in the sun for an hour.',
    status: 'generated',
    createdOn: '2026-07-16T12:00:00.000Z',
    ...over,
  };
}

/** A generate.js draft: snake_case, `generated_at`, no camelCase field at all. */
function snakeDraft(over: Partial<GeneratedDraftRow> = {}): GeneratedDraftRow {
  return {
    _id: 'd2',
    kinfolk_id: 'kf2',
    kinfolk_name: 'The Okafors',
    communication_type: 'visit_report',
    generated_copy: 'Mabel ate every crumb.',
    generated_title: 'A clean bowl',
    status: 'generated',
    generated_at: '2026-07-16T12:00:00.000Z',
    ...over,
  };
}

describe('reading a generated_drafts doc, which has two writers', () => {
  it('reads the camelCase spelling the migrated docs carry', () => {
    const d = draft();
    expect(draftHousehold(d)).toBe('The Whitfields');
    expect(draftBody(d)).toBe('Biscuit napped in the sun for an hour.');
    expect(draftTypeLabel(d)).toBe('visit report');
    expect(draftCreatedAt(d)).toBe('2026-07-16T12:00:00.000Z');
  });

  it('reads the snake_case spelling generate.js writes, rather than rendering a blank row', () => {
    const d = snakeDraft();
    expect(draftHousehold(d)).toBe('The Okafors');
    expect(draftBody(d)).toBe('Mabel ate every crumb.');
    expect(draftTitle(d)).toBe('A clean bowl');
    expect(draftTypeLabel(d)).toBe('visit report');
    expect(draftKinfolkId(d)).toBe('kf2');
    expect(draftCreatedAt(d)).toBe('2026-07-16T12:00:00.000Z');
  });

  it('prefers the camelCase value when a doc somehow carries both', () => {
    expect(draftHousehold(draft({ kinfolk_name: 'Wrong' }))).toBe('The Whitfields');
  });

  it('treats a blank camelCase field as absent rather than as a real empty value', () => {
    expect(draftHousehold(draft({ kinfolkName: '   ', kinfolk_name: 'The Okafors' }))).toBe(
      'The Okafors',
    );
  });

  it('reports a genuinely undated draft as blank, never a fabricated instant', () => {
    expect(draftCreatedAt(draft({ createdOn: '' }))).toBe('');
  });
});

describe('mapping a draft status into the list vocabulary', () => {
  it.each(['generated', 'pending', 'PENDING', '', '   '])(
    'counts %o as a draft, positively',
    (status) => {
      expect(kinTaleState(draftStatusAsKinTaleStatus(status))).toBe('draft');
    },
  );

  it('refuses to call an approved draft SENT, because nothing on the doc proves a delivery', () => {
    // approveGeneratedDraft stamps 'approved' BEFORE the send and stamps nothing
    // after it, so 'approved' is equally consistent with a delivery that threw.
    expect(kinTaleState(draftStatusAsKinTaleStatus('approved'))).toBe('unknown');
  });

  it('gives an unrecognised status its own bucket rather than folding it into Drafts', () => {
    expect(kinTaleState(draftStatusAsKinTaleStatus('some_new_code'))).toBe('unknown');
  });
});

describe('a draft as a list row', () => {
  it('is a DRAFT, carries the household, the copy and its own created instant', () => {
    const row = rowFromDraft(draft());
    expect(row.source).toBe('generated_drafts');
    expect(kinTaleState(row.status ?? '')).toBe('draft');
    expect(row.kinfolkName).toBe('The Whitfields');
    expect(row.bodyCopy).toBe('Biscuit napped in the sun for an hour.');
    expect(row.createdAt).toBe('2026-07-16T12:00:00.000Z');
    expect(row.draftType).toBe('visit report');
  });

  it('namespaces the id, so a draft and a report sharing a document id are two rows', () => {
    const rows = kinTaleListRows([report({ _id: 'same' })], [draft({ _id: 'same' })], {
      startIso: null,
    });
    expect(rows.map((r) => r._id)).toEqual(['same', 'generated_drafts/same']);
  });

  it('leaves sentVia ABSENT, so a draft never shows the misleading "imported" pip', () => {
    expect(rowFromDraft(draft()).sentVia).toBeUndefined();
  });

  it('claims no service type, no media and no session: a draft is not attached to a visit', () => {
    const row = rowFromDraft(draft());
    expect(row.serviceType).toBeUndefined();
    expect(row.mediaFileIds).toBeUndefined();
    expect(row.sessionId).toBeUndefined();
  });

  it('omits the type pip entirely when the draft carries no communication type', () => {
    expect(rowFromDraft(draft({ communicationType: '' })).draftType).toBeUndefined();
  });

  it('tags a report row without rewriting a single field of it', () => {
    const r = report();
    expect(rowFromReport(r)).toEqual({ ...r, source: 'kin_care_reports' });
  });
});

describe('the window and the facet, applied to drafts client-side', () => {
  const bound = '2026-07-10T00:00:00.000Z';

  it('keeps a draft created inside the window', () => {
    expect(draftsInWindow([draft({ createdOn: '2026-07-16T12:00:00.000Z' })], { startIso: bound }))
      .toHaveLength(1);
  });

  it('drops a draft older than the window, matching what the server did to the reports', () => {
    expect(draftsInWindow([draft({ createdOn: '2026-06-01T12:00:00.000Z' })], { startIso: bound }))
      .toHaveLength(0);
  });

  it('KEEPS an undated draft rather than hiding a real row for a reason nobody can see', () => {
    expect(draftsInWindow([draft({ createdOn: '' })], { startIso: bound })).toHaveLength(1);
  });

  it('windows on the free-text dates the migration actually wrote, not just ISO', () => {
    // "September 3, 2025 2:02pm" is the majority format in this data; a bare
    // `new Date()` rejects it and would call the row undated.
    const rows = draftsInWindow([draft({ createdOn: 'September 3, 2025 2:02pm' })], {
      startIso: '2026-01-01T00:00:00.000Z',
    });
    expect(rows).toHaveLength(0);
  });

  it('applies no bound at all for the archive', () => {
    expect(draftsInWindow([draft({ createdOn: '2019-01-01T00:00:00.000Z' })], { startIso: null }))
      .toHaveLength(1);
  });

  it('narrows to the chosen household, on either spelling of the FK', () => {
    const rows = draftsInWindow([draft({ kinfolk_id: 'kf1' }), snakeDraft({ kinfolk_id: 'kf2' })], {
      startIso: null,
      kinfolkId: 'kf2',
    });
    expect(rows.map((d) => d._id)).toEqual(['d2']);
  });

  it('offers every household when the facet is blank', () => {
    expect(
      draftsInWindow([draft(), snakeDraft()], { startIso: null, kinfolkId: '' }),
    ).toHaveLength(2);
  });
});

describe('merging the two lists newest-first', () => {
  const row = (id: string, createdAt: string, source: 'kin_care_reports' | 'generated_drafts') =>
    ({ _id: id, createdAt, source }) as KinTaleListRow;

  it('interleaves by created instant', () => {
    const reports = [
      row('r-new', '2026-07-20T00:00:00.000Z', 'kin_care_reports'),
      row('r-old', '2026-07-10T00:00:00.000Z', 'kin_care_reports'),
    ];
    const drafts = [row('d-mid', '2026-07-15T00:00:00.000Z', 'generated_drafts')];
    expect(mergeByCreatedDesc(reports, drafts).map((r) => r._id)).toEqual([
      'r-new',
      'd-mid',
      'r-old',
    ]);
  });

  it('NEVER reorders the reports among themselves, whatever the merge decides', () => {
    // The server ordered these by comparing createdAt as STRINGS. These two
    // free-text values parse to instants in the opposite order to their string
    // order, so a naive combined sort would silently reshuffle a paged list
    // against its own cursor. The merge must leave them exactly as they came.
    const reports = [
      row('r1', 'September 3, 2025 2:02pm', 'kin_care_reports'),
      row('r2', '2026-07-20T00:00:00.000Z', 'kin_care_reports'),
    ];
    expect(mergeByCreatedDesc(reports, []).map((r) => r._id)).toEqual(['r1', 'r2']);
  });

  it('keeps the drafts in the order the server gave them, too', () => {
    const drafts = [
      row('d1', '2026-07-20T00:00:00.000Z', 'generated_drafts'),
      row('d2', '2026-07-19T00:00:00.000Z', 'generated_drafts'),
    ];
    expect(mergeByCreatedDesc([], drafts).map((r) => r._id)).toEqual(['d1', 'd2']);
  });

  it('sorts an undated row after everything dated, and never drops it', () => {
    const reports = [row('r-dated', '2026-07-20T00:00:00.000Z', 'kin_care_reports')];
    const drafts = [row('d-undated', '', 'generated_drafts')];
    expect(mergeByCreatedDesc(reports, drafts).map((r) => r._id)).toEqual(['r-dated', 'd-undated']);
  });

  it('returns the other list whole when one side is empty', () => {
    const reports = [row('r1', '2026-07-20T00:00:00.000Z', 'kin_care_reports')];
    expect(mergeByCreatedDesc(reports, []).map((r) => r._id)).toEqual(['r1']);
    expect(mergeByCreatedDesc([], reports).map((r) => r._id)).toEqual(['r1']);
    expect(mergeByCreatedDesc([], [])).toEqual([]);
  });
});

describe('kinTaleListRows, the whole join', () => {
  it('puts a draft and a report in one list, each keeping its own state', () => {
    const rows = kinTaleListRows([report()], [draft()], { startIso: null });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => kinTaleState(r.status ?? '')).sort()).toEqual(['draft', 'sent']);
  });

  it('is exactly the reports when no draft survives the window', () => {
    const rows = kinTaleListRows([report()], [draft({ createdOn: '2019-01-01T00:00:00.000Z' })], {
      startIso: '2026-01-01T00:00:00.000Z',
    });
    expect(rows.map((r) => r.source)).toEqual(['kin_care_reports']);
  });
});
