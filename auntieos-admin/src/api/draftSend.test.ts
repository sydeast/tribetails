import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #2428: the wire for approving an Email or Text draft. One server call
 * approves, sends and marks the draft sent; this module adds the Activity Log
 * entry after a real send and keeps a second tap from making a second request.
 */

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));
const { logActivity } = vi.hoisted(() => ({ logActivity: vi.fn() }));
vi.mock('./activityLog', () => ({ logActivity }));

import { sendGeneratedDraft } from './draftSend';

beforeEach(() => {
  call.mockReset().mockResolvedValue({ ok: true, outcome: 'sent', channel: 'email' });
  logActivity.mockReset().mockResolvedValue(undefined);
});

const ARGS = { draftId: ' gd1 ', kinfolkId: 'kf1', body: '  Nova is booked for Friday.  ', subject: ' Friday ' };

describe('sendGeneratedDraft', () => {
  it('HAPPY: sends the draft, the household and the words, trimmed, and no address', async () => {
    const res = await sendGeneratedDraft(ARGS);
    expect(res).toEqual({ outcome: 'sent', auditWarning: null });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'sendGeneratedDraft',
      { draftId: 'gd1', kinfolkId: 'kf1', body: 'Nova is booked for Friday.', subject: 'Friday' },
      { idempotent: true },
    );
    expect(Object.keys(call.mock.calls[0]![1] as object)).not.toContain('to');
  });

  it('HAPPY: a Text carries no subject', async () => {
    await sendGeneratedDraft({ draftId: 'gd2', kinfolkId: 'kf1', body: 'See you Friday.' });
    expect(call.mock.calls[0]![1]).toEqual({ draftId: 'gd2', kinfolkId: 'kf1', body: 'See you Friday.' });
  });

  it('HAPPY: the Activity Log entry is written after the send, for this draft and household', async () => {
    const order: string[] = [];
    call.mockImplementation(async () => {
      order.push('send');
      return { ok: true, outcome: 'sent' };
    });
    logActivity.mockImplementation(async () => {
      order.push('audit');
    });
    await sendGeneratedDraft(ARGS);
    expect(order).toEqual(['send', 'audit']);
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'DRAFT_APPROVED',
        status: 'SUCCESS',
        targetId: 'gd1',
        targetCollection: 'generated_drafts',
        familyId: 'kf1',
      }),
    );
  });

  it('SAD: a failed Activity Log entry is reported beside the send, never instead of it', async () => {
    logActivity.mockRejectedValue(new Error('audit chain busy'));
    await expect(sendGeneratedDraft(ARGS)).resolves.toEqual({ outcome: 'sent', auditWarning: 'audit chain busy' });
  });

  it('NEGATIVE: a draft that had already gone is not logged as approved again', async () => {
    call.mockResolvedValue({ ok: true, outcome: 'already_sent' });
    await expect(sendGeneratedDraft(ARGS)).resolves.toEqual({ outcome: 'already_sent', auditWarning: null });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an answer this client cannot read is never claimed as a send', async () => {
    call.mockResolvedValue({ ok: true });
    await expect(sendGeneratedDraft(ARGS)).resolves.toEqual({ outcome: 'already_sent', auditWarning: null });
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('ERROR: a refusal reaches the caller with the server words, and nothing is logged', async () => {
    call.mockRejectedValue(new Error('This draft was written for a different household.'));
    await expect(sendGeneratedDraft(ARGS)).rejects.toThrow('This draft was written for a different household.');
    expect(logActivity).not.toHaveBeenCalled();
  });

  it('ERROR: a draft that was never saved is refused before anything is dialled', async () => {
    await expect(sendGeneratedDraft({ ...ARGS, draftId: '  ' })).rejects.toThrow(/was not saved/);
    expect(call).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a second tap while the first is sending makes no second request, and both get the one answer', async () => {
    let answer: (r: { ok: true; outcome: string }) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const first = sendGeneratedDraft(ARGS);
    const second = sendGeneratedDraft({ ...ARGS, body: 'Tapped again.' });
    expect(call).toHaveBeenCalledTimes(1);
    answer({ ok: true, outcome: 'sent' });
    expect(await first).toEqual({ outcome: 'sent', auditWarning: null });
    expect(await second).toEqual({ outcome: 'sent', auditWarning: null });
    expect(call).toHaveBeenCalledTimes(1);
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: an old screen sending the same draft again after it went asks the server, which decides', async () => {
    await sendGeneratedDraft(ARGS);
    call.mockResolvedValue({ ok: true, outcome: 'already_sent' });
    await expect(sendGeneratedDraft(ARGS)).resolves.toMatchObject({ outcome: 'already_sent' });
    expect(call).toHaveBeenCalledTimes(2);
    expect(logActivity).toHaveBeenCalledTimes(1);
  });

  it('HAPPY: two different drafts send side by side', async () => {
    await Promise.all([sendGeneratedDraft(ARGS), sendGeneratedDraft({ ...ARGS, draftId: 'gd9' })]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('ERROR: after a refusal the same draft can be sent again', async () => {
    call.mockRejectedValueOnce(new Error('smtp2go send failed'));
    await expect(sendGeneratedDraft(ARGS)).rejects.toThrow('smtp2go send failed');
    await expect(sendGeneratedDraft(ARGS)).resolves.toMatchObject({ outcome: 'sent' });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
