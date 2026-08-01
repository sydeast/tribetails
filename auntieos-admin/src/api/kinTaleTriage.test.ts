import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import {
  listOrphanReports,
  assignKinfolkToOrphanReport,
  markOrphanReportAsDuplicate,
  archiveOrphanReportAsBadData,
  TriageValidationError,
  type OrphanReportEntry,
} from './kinTaleTriage';

beforeEach(() => call.mockReset());

describe('listOrphanReports', () => {
  it('calls the callable with no arguments and unwraps the { reports } envelope', async () => {
    const reports: OrphanReportEntry[] = [
      { _id: 'legacy_79', bodyCopy: 'A visit note.', sentVia: 'legacy_visit_logs', createdAt: '2026-05-17T10:00:00.000Z' },
    ];
    call.mockResolvedValue({ reports, scanned: 1 });
    const result = await listOrphanReports();
    expect(call).toHaveBeenCalledWith('listOrphanReports', {});
    expect(result).toEqual(reports);
  });

  it('defaults to [] when the callable returns no reports field, rather than throwing on a shape mismatch', async () => {
    call.mockResolvedValue({ scanned: 0 });
    expect(await listOrphanReports()).toEqual([]);
  });

  it('propagates a rejected call rather than swallowing it (fail loud)', async () => {
    call.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(listOrphanReports()).rejects.toThrow('permission-denied');
  });
});

describe('assignKinfolkToOrphanReport', () => {
  it('sends the ASSIGN action with the trimmed ids and the supplied name', async () => {
    call.mockResolvedValue({ ok: true, action: 'ASSIGN', reportId: 'legacy_79' });
    const result = await assignKinfolkToOrphanReport(' legacy_79 ', ' kf1 ', ' Loretta Wall ');
    expect(call).toHaveBeenCalledWith('triageOrphanReport', {
      action: 'ASSIGN',
      reportId: 'legacy_79',
      kinfolkId: 'kf1',
      suppliedName: 'Loretta Wall',
    });
    expect(result).toEqual({ ok: true, action: 'ASSIGN', reportId: 'legacy_79' });
  });

  it('omits suppliedName entirely when not given, rather than sending a blank string', async () => {
    call.mockResolvedValue({ ok: true, action: 'ASSIGN', reportId: 'legacy_79' });
    await assignKinfolkToOrphanReport('legacy_79', 'kf1');
    expect(call).toHaveBeenCalledWith('triageOrphanReport', {
      action: 'ASSIGN',
      reportId: 'legacy_79',
      kinfolkId: 'kf1',
    });
  });

  it('rejects a blank reportId before any network call', async () => {
    await expect(assignKinfolkToOrphanReport('  ', 'kf1')).rejects.toThrow(TriageValidationError);
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects a blank kinfolkId before any network call', async () => {
    await expect(assignKinfolkToOrphanReport('legacy_79', '  ')).rejects.toThrow(TriageValidationError);
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates a server rejection rather than claiming success', async () => {
    call.mockRejectedValueOnce(new Error('kinfolk/kf1 not found or has no displayable name'));
    await expect(assignKinfolkToOrphanReport('legacy_79', 'kf1')).rejects.toThrow(
      'kinfolk/kf1 not found',
    );
  });
});

describe('markOrphanReportAsDuplicate', () => {
  it('sends the DUPLICATE action with both trimmed ids', async () => {
    call.mockResolvedValue({ ok: true, action: 'DUPLICATE', reportId: 'legacy_79' });
    await markOrphanReportAsDuplicate(' legacy_79 ', ' report_1 ');
    expect(call).toHaveBeenCalledWith('triageOrphanReport', {
      action: 'DUPLICATE',
      reportId: 'legacy_79',
      duplicateOfReportId: 'report_1',
    });
  });

  it('refuses a report marked as a duplicate of itself before any network call', async () => {
    await expect(markOrphanReportAsDuplicate('legacy_79', 'legacy_79')).rejects.toThrow(
      TriageValidationError,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects a blank duplicateOfReportId before any network call', async () => {
    await expect(markOrphanReportAsDuplicate('legacy_79', '  ')).rejects.toThrow(TriageValidationError);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('archiveOrphanReportAsBadData', () => {
  it('sends the ARCHIVE action with the trimmed reason', async () => {
    call.mockResolvedValue({ ok: true, action: 'ARCHIVE', reportId: 'legacy_79' });
    await archiveOrphanReportAsBadData('legacy_79', '  test data from the May 10 migration  ');
    expect(call).toHaveBeenCalledWith('triageOrphanReport', {
      action: 'ARCHIVE',
      reportId: 'legacy_79',
      reason: 'test data from the May 10 migration',
    });
  });

  it('rejects a reason shorter than 5 characters before any network call, mirroring the server bound', async () => {
    await expect(archiveOrphanReportAsBadData('legacy_79', 'bad')).rejects.toThrow(TriageValidationError);
    expect(call).not.toHaveBeenCalled();
  });

  it('rejects a whitespace-only reason', async () => {
    await expect(archiveOrphanReportAsBadData('legacy_79', '     ')).rejects.toThrow(TriageValidationError);
    expect(call).not.toHaveBeenCalled();
  });
});
