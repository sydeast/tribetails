import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { canDeleteKinTaleDraft, deleteKinTaleReportDraft } from './kinTaleReportDraftDelete';

beforeEach(() => {
  call.mockReset().mockResolvedValue({ ok: true, reportId: 'r1' });
});

/**
 * #1631: an unsent KinTale report draft had no delete on any client. The gate
 * mirrors the server's refusals so Delete is never offered where it can only
 * be refused.
 */
describe('canDeleteKinTaleDraft', () => {
  const draft = { _id: 'r1', status: 'DRAFT', sentAt: '', sentVia: '', kinfolkId: 'kf1' };

  it('offers Delete on an unsent draft, whatever the status casing', () => {
    expect(canDeleteKinTaleDraft(draft)).toBe(true);
    expect(canDeleteKinTaleDraft({ ...draft, status: 'draft' })).toBe(true);
  });

  it('never on a sent KinTale, nor on a draft that carries a send time', () => {
    expect(canDeleteKinTaleDraft({ ...draft, status: 'SENT', sentAt: '2026-11-04T19:00:00Z' })).toBe(false);
    expect(canDeleteKinTaleDraft({ ...draft, sentAt: '2026-11-04T19:00:00Z' })).toBe(false);
    expect(canDeleteKinTaleDraft({ ...draft, status: 'FAILED' })).toBe(false);
  });

  it('never on an untriaged migration orphan, which belongs to Needs triage', () => {
    expect(canDeleteKinTaleDraft({ ...draft, kinfolkId: '', sentVia: 'legacy_orphan' })).toBe(false);
    expect(canDeleteKinTaleDraft({ ...draft, kinfolkId: '', sentVia: 'legacy_visit_logs' })).toBe(false);
    // Triaged, it is an ordinary draft again.
    expect(canDeleteKinTaleDraft({ ...draft, kinfolkId: '', sentVia: 'legacy_orphan', triageStatus: 'ASSIGNED' })).toBe(
      true,
    );
  });

  it('never on a row with no id (an unsaved draft has nothing to delete)', () => {
    expect(canDeleteKinTaleDraft({ ...draft, _id: '' })).toBe(false);
    expect(canDeleteKinTaleDraft({ status: 'DRAFT' })).toBe(false);
  });
});

describe('deleteKinTaleReportDraft', () => {
  it('calls the server with the bare report id', async () => {
    await deleteKinTaleReportDraft(' r1 ');
    expect(call).toHaveBeenCalledWith('deleteKinTaleReportDraft', { reportId: 'r1' });
  });
});
