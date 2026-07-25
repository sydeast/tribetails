import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, updateDocMock, callMock, authState } = vi.hoisted(() => ({
  calls: [] as string[],
  updateDocMock: vi.fn(),
  callMock: vi.fn(),
  authState: { currentUser: null as null | { uid: string } },
}));

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, coll: string, id: string) => ({ _path: `${coll}/${id}` }),
  updateDoc: updateDocMock,
}));
vi.mock('../lib/firebase', () => ({ db: {}, auth: authState }));
vi.mock('../lib/fns', () => ({ call: callMock }));

import { approveGeneratedDraft, ApproveDraftError, ApproveDeliveryError } from './communicateApprove';

beforeEach(() => {
  calls.length = 0;
  updateDocMock.mockReset();
  callMock.mockReset();
  authState.currentUser = { uid: 'admin-1' };

  updateDocMock.mockImplementation(() => {
    calls.push('write');
    return Promise.resolve();
  });
  callMock.mockImplementation((name: string) => {
    calls.push(`callable:${name}`);
    return Promise.resolve({ ok: true, entryId: 'e1' });
  });
});

function args(over: Record<string, unknown> = {}) {
  return {
    draftId: 'd1',
    editedCopy: 'Nova had a wonderful day.',
    kinfolkId: 'kf1',
    subject: null,
    ...over,
  };
}

describe('approveGeneratedDraft ordering', () => {
  it('writes the draft, then audits, then delivers, in that order', async () => {
    const deliver = vi.fn().mockImplementation(() => {
      calls.push('deliver');
      return Promise.resolve('provider-9');
    });

    const result = await approveGeneratedDraft({ ...args(), deliver });

    expect(calls).toEqual(['write', 'callable:logActivity', 'deliver']);
    expect(result).toEqual({ ok: true, auditWarning: null, providerId: 'provider-9', delivered: true });
  });

  it('delivers nothing and audits nothing when the Firestore write fails', async () => {
    updateDocMock.mockImplementation(() => {
      calls.push('write');
      return Promise.reject(new Error('PERMISSION_DENIED'));
    });
    const deliver = vi.fn().mockImplementation(() => {
      calls.push('deliver');
      return Promise.resolve(null);
    });

    await expect(approveGeneratedDraft({ ...args(), deliver })).rejects.toThrow(ApproveDraftError);

    expect(calls).toEqual(['write']);
    expect(deliver).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalled();
  });

  it('names the Firestore failure rather than swallowing it', async () => {
    updateDocMock.mockRejectedValue(new Error('PERMISSION_DENIED'));
    await expect(approveGeneratedDraft(args())).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it('still delivers when the audit entry fails, and reports the audit failure', async () => {
    callMock.mockImplementation(() => {
      calls.push('callable:logActivity');
      return Promise.reject(new Error('audit chain busy'));
    });
    const deliver = vi.fn().mockImplementation(() => {
      calls.push('deliver');
      return Promise.resolve('provider-9');
    });

    const result = await approveGeneratedDraft({ ...args(), deliver });

    expect(calls).toEqual(['write', 'callable:logActivity', 'deliver']);
    expect(result.auditWarning).toBe('audit chain busy');
    expect(result.delivered).toBe(true);
  });

  it('throws a delivery-specific error when the send fails, so the copy says the draft IS approved', async () => {
    const deliver = vi.fn().mockRejectedValue(new Error('twilio 21610'));
    await expect(approveGeneratedDraft({ ...args(), deliver })).rejects.toThrow(ApproveDeliveryError);
    await expect(approveGeneratedDraft({ ...args(), deliver })).rejects.toThrow(/twilio 21610/);
  });

  it('reports delivered:false when there is nothing to deliver, and never claims a send', async () => {
    const result = await approveGeneratedDraft(args());
    expect(result).toEqual({ ok: true, auditWarning: null, providerId: null, delivered: false });
    expect(calls).toEqual(['write', 'callable:logActivity']);
  });
});

describe('approveGeneratedDraft payloads', () => {
  it('promotes the draft in place, on the doc the generate returned', async () => {
    await approveGeneratedDraft(args());
    const [ref, patch] = updateDocMock.mock.calls[0] as [{ _path: string }, Record<string, unknown>];
    expect(ref._path).toBe('generated_drafts/d1');
    expect(patch['status']).toBe('approved');
    expect(patch['generatedCopy']).toBe('Nova had a wonderful day.');
    expect(patch['approvedBy']).toBe('admin-1');
    expect(typeof patch['approvedAt']).toBe('string');
  });

  it('persists the subject when one exists, and omits the field entirely when it does not', async () => {
    await approveGeneratedDraft(args({ subject: 'Nova and Otis' }));
    expect((updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>])[1]['subject']).toBe('Nova and Otis');

    updateDocMock.mockClear();
    await approveGeneratedDraft(args({ subject: null }));
    expect('subject' in (updateDocMock.mock.calls[0] as [unknown, Record<string, unknown>])[1]).toBe(false);
  });

  it('writes a DRAFT_APPROVED audit entry naming the draft and the household', async () => {
    await approveGeneratedDraft(args());
    const [name, payload] = callMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(name).toBe('logActivity');
    expect(payload['actionType']).toBe('DRAFT_APPROVED');
    expect(payload['targetId']).toBe('d1');
    expect(payload['targetCollection']).toBe('generated_drafts');
    expect(payload['status']).toBe('SUCCESS');
    expect(String(payload['description'])).toContain('d1');
    expect(String(payload['description'])).toContain('kf1');
  });

  it('says so plainly in the audit entry when there was no household', async () => {
    await approveGeneratedDraft(args({ kinfolkId: null }));
    const payload = (callMock.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(String(payload['description'])).toContain('no kinfolk');
  });

  it('refuses a blank draft id instead of patching a doc path that is a bare collection', async () => {
    await expect(approveGeneratedDraft(args({ draftId: '  ' }))).rejects.toThrow(ApproveDraftError);
    expect(updateDocMock).not.toHaveBeenCalled();
  });
});
