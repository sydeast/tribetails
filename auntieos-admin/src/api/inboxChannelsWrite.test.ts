import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updateDocMock } = vi.hoisted(() => ({ updateDocMock: vi.fn() }));

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, coll: string, id: string) => ({ _path: `${coll}/${id}` }),
  updateDoc: updateDocMock,
}));
vi.mock('../lib/firebase', () => ({ db: {} }));

import { markVoicemail, MarkVoicemailError } from './inboxChannelsWrite';

beforeEach(() => {
  updateDocMock.mockReset().mockResolvedValue(undefined);
});

describe('markVoicemail', () => {
  it('stamps replied with the provider message id and an ISO repliedAt', async () => {
    await markVoicemail({ voicemailId: 'vm1', status: 'replied', replyLogId: 'SM123' });
    const [ref, patch] = updateDocMock.mock.calls[0] as [{ _path: string }, Record<string, string>];
    expect(ref._path).toBe('voicemails/vm1');
    expect(patch['replyStatus']).toBe('replied');
    expect(patch['replyLogId']).toBe('SM123');
    // ISO-8601, the same shape every timestamp on these collections carries.
    expect(patch['repliedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('leaves repliedAt blank for a read mark, because reading is not replying', async () => {
    await markVoicemail({ voicemailId: 'vm2', status: 'read' });
    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, string>];
    expect(patch).toEqual({ replyStatus: 'read', repliedAt: '', replyLogId: '' });
  });

  it('writes a blank replyLogId rather than inventing a link the send never returned', async () => {
    await markVoicemail({ voicemailId: 'vm3', status: 'replied', replyLogId: null });
    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, string>];
    expect(patch['replyLogId']).toBe('');
  });

  it('trims the id and refuses a blank one before touching Firestore', async () => {
    await markVoicemail({ voicemailId: '  vm4  ', status: 'read' });
    const [ref] = updateDocMock.mock.calls[0] as [{ _path: string }];
    expect(ref._path).toBe('voicemails/vm4');

    updateDocMock.mockClear();
    await expect(markVoicemail({ voicemailId: '   ', status: 'read' })).rejects.toBeInstanceOf(
      MarkVoicemailError,
    );
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it('propagates a Firestore failure instead of resolving as though it worked', async () => {
    updateDocMock.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(markVoicemail({ voicemailId: 'vm5', status: 'read' })).rejects.toThrow(
      'permission-denied',
    );
  });

  /**
   * `updateDoc`, not `setDoc`. A voicemail document carries the transcript, the
   * audio URL, the Twilio SIDs and the python reconcile pipeline's provenance
   * fields; a merge-less overwrite would destroy all of it to record that
   * somebody pressed Mark read.
   */
  it('patches exactly three keys and never rewrites the document', async () => {
    await markVoicemail({ voicemailId: 'vm6', status: 'replied', replyLogId: 'SM9' });
    const [, patch] = updateDocMock.mock.calls[0] as [unknown, Record<string, string>];
    expect(Object.keys(patch).sort()).toEqual(['repliedAt', 'replyLogId', 'replyStatus']);
  });
});
