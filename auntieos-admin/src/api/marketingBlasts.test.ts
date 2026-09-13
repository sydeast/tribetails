import { describe, it, expect, vi } from 'vitest';

const { callMock } = vi.hoisted(() => ({ callMock: vi.fn() }));
vi.mock('../lib/fns', () => ({ call: callMock }));

import {
  blastAudienceArgs,
  cancelMarketingBlast,
  listMarketingBlasts,
  previewBlastAudience,
  scheduleBlast,
} from './marketingBlasts';

// `callMock.mockReset()` runs at the top of each test body rather than in a
// shared beforeEach, the same deliberate deviation `api/audienceSegments.test.ts`
// documents for a vi.hoisted mock of a local module.

describe('blastAudienceArgs', () => {
  it('sends a segmentId and nothing else in segment mode', () => {
    expect(blastAudienceArgs('seg1', { kind: 'all' }, ['u1'], 'segment')).toEqual({ segmentId: 'seg1' });
  });

  it('sends criteria and nothing else in criteria mode', () => {
    expect(blastAudienceArgs('seg1', { kind: 'all' }, ['u1'], 'criteria')).toEqual({
      criteria: { kind: 'all' },
    });
  });

  it('sends the uid list and nothing else in uids mode', () => {
    expect(blastAudienceArgs('seg1', { kind: 'all' }, ['u1', 'u2'], 'uids')).toEqual({
      audienceUids: ['u1', 'u2'],
    });
  });

  it('is null when the chosen mode has nothing in it, never a silent fallback to everyone', () => {
    expect(blastAudienceArgs(null, { kind: 'all' }, ['u1'], 'segment')).toBeNull();
    expect(blastAudienceArgs('seg1', null, ['u1'], 'criteria')).toBeNull();
    expect(blastAudienceArgs('seg1', { kind: 'all' }, [], 'uids')).toBeNull();
  });
});

describe('previewBlastAudience', () => {
  it('flattens the audience onto the payload beside the key', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({
      ok: true,
      description: 'All active kinfolk',
      matched: 10,
      noLinkedAccount: 2,
      suppressedByPrefs: 3,
      reachable: 5,
    });

    const reach = await previewBlastAudience('newsletter.announcement', { criteria: { kind: 'all' } });

    expect(callMock).toHaveBeenCalledWith('previewMarketingBlastAudience', {
      key: 'newsletter.announcement',
      criteria: { kind: 'all' },
    });
    expect(reach).toEqual({
      description: 'All active kinfolk',
      matched: 10,
      noLinkedAccount: 2,
      suppressedByPrefs: 3,
      reachable: 5,
    });
  });

  it('reads a missing count as 0 rather than rendering undefined', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    const reach = await previewBlastAudience('survey.event', { segmentId: 's1' });
    expect(reach).toEqual({
      description: '',
      matched: 0,
      noLinkedAccount: 0,
      suppressedByPrefs: 0,
      reachable: 0,
    });
  });
});

/** The shape `lib/sendIdempotency.ts` mints and the server's zod insists on. */
const KEY = 'blast_1757700000000_ab12cd';

describe('scheduleBlast', () => {
  it('omits a blank title, which the server would reject as an empty string', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, blastId: 'b1', dispatched: 4, suppressed: 1, failed: 0 });

    await scheduleBlast({
      key: 'marketing.optin',
      fireAtMs: 123,
      audience: { criteria: { kind: 'all' } },
      data: { headline: 'Hi' },
      title: '   ',
      idempotencyKey: KEY,
    });

    expect(callMock).toHaveBeenCalledWith(
      'scheduleMarketingBlast',
      {
        key: 'marketing.optin',
        fireAtMs: 123,
        criteria: { kind: 'all' },
        data: { headline: 'Hi' },
        idempotencyKey: KEY,
      },
      // #814: the retry, and it is only safe because of the key above.
      { idempotent: true },
    );
  });

  it('sends a real title trimmed', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, blastId: 'b1' });
    await scheduleBlast({
      key: 'newsletter.announcement',
      fireAtMs: 9,
      audience: { audienceUids: ['u1'] },
      data: {},
      title: ' June ',
      idempotencyKey: KEY,
    });
    expect(callMock.mock.calls[0]?.[1]).toMatchObject({ title: 'June', audienceUids: ['u1'] });
  });

  it('returns the counts, defaulting a missing one to 0', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, blastId: 'b2', dispatched: 7 });
    const res = await scheduleBlast({
      key: 'survey.event',
      fireAtMs: 1,
      audience: { segmentId: 's1' },
      data: {},
      idempotencyKey: KEY,
    });
    expect(res).toEqual({
      blastId: 'b2',
      matched: 0,
      noLinkedAccount: 0,
      dispatched: 7,
      suppressed: 0,
      failed: 0,
      deduped: false,
      pending: false,
      // #823. A backend that sends neither reads as a fan-out with nothing
      // measured rather than one that finished, which is what `pending: false`
      // beside it already says.
      queued: 0,
      audienceSize: 0,
    });
  });
  /**
   * #814. The guard is on the seam that turns the RETRY on, so it has to refuse
   * an unkeyed payload rather than trust every caller to remember: a retry
   * without the key is a second marketing email to every household in the
   * audience, and it cannot be recalled.
   */
  it('refuses to send at all without an idempotency key', async () => {
    callMock.mockReset();
    await expect(
      scheduleBlast({
        key: 'survey.event',
        fireAtMs: 1,
        audience: { segmentId: 's1' },
        data: {},
        idempotencyKey: '',
      }),
    ).rejects.toThrow(/idempotencyKey/);
    expect(callMock).not.toHaveBeenCalled();
  });
  it('reports a deduped reply as a deduped reply, not as a fresh send', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({
      ok: true,
      blastId: KEY,
      dispatched: 4,
      suppressed: 1,
      failed: 0,
      deduped: true,
      pending: true,
    });
    const res = await scheduleBlast({
      key: 'survey.event',
      fireAtMs: 1,
      audience: { segmentId: 's1' },
      data: {},
      idempotencyKey: KEY,
    });
    expect(res.deduped).toBe(true);
    expect(res.pending).toBe(true);
  });
});

describe('listMarketingBlasts', () => {
  it('returns rows newest fire time first', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({
      ok: true,
      blasts: [
        { id: 'b1', key: 'survey.event', fireAtMs: 100, status: 'sent' },
        { id: 'b2', key: 'newsletter.announcement', fireAtMs: 900, status: 'scheduled' },
      ],
    });
    const rows = await listMarketingBlasts();
    expect(rows.map((r) => r.id)).toEqual(['b2', 'b1']);
  });

  it('drops a row with no id, which could never be cancelled', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, blasts: [{ id: '', key: 'x' }, { id: 'b1', key: 'y' }] });
    const rows = await listMarketingBlasts();
    expect(rows.map((r) => r.id)).toEqual(['b1']);
  });

  it('reads an unknown status as scheduled, so the row keeps a Cancel button', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, blasts: [{ id: 'b1', status: 'something-new' }] });
    const rows = await listMarketingBlasts();
    expect(rows[0]?.status).toBe('scheduled');
  });

  it('passes a limit through only when one was asked for', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, blasts: [] });
    await listMarketingBlasts();
    expect(callMock).toHaveBeenCalledWith('listMarketingBlasts', {});
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, blasts: [] });
    await listMarketingBlasts(5);
    expect(callMock).toHaveBeenCalledWith('listMarketingBlasts', { limit: 5 });
  });
});

describe('cancelMarketingBlast', () => {
  it('returns how many queued notifications were removed', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, cancelled: 12, stopped: true, neverQueued: 0 });
    await expect(cancelMarketingBlast('b1')).resolves.toEqual({
      cancelled: 12,
      stopped: true,
      neverQueued: 0,
    });
    expect(callMock).toHaveBeenCalledWith('cancelMarketingBlast', { blastId: 'b1' });
  });
  /**
   * #823. A cancel that lands mid fan-out cannot prove the worker stopped, so
   * the server says so and this must carry that through rather than flattening
   * it back to a count the screen would announce as final.
   */
  it('carries through that a mid fan-out cancel has not finished stopping', async () => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, cancelled: 120, stopped: false, neverQueued: 780 });
    await expect(cancelMarketingBlast('b1')).resolves.toEqual({
      cancelled: 120,
      stopped: false,
      neverQueued: 780,
    });
  });
  it('reads a reply with no stop fields as a cancel that DID finish', async () => {
    // A backend older than #823 really did finish the cancel synchronously, so
    // `stopped` defaults true rather than false. Defaulting the other way would
    // put "It finishes stopping within a minute" under every cancel on a
    // deployment where nothing is left to stop.
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true, cancelled: 4 });
    await expect(cancelMarketingBlast('b1')).resolves.toEqual({
      cancelled: 4,
      stopped: true,
      neverQueued: 0,
    });
  });

  it('lets the server rejection through rather than swallowing it', async () => {
    callMock.mockReset();
    callMock.mockRejectedValue(new Error('already_fired'));
    await expect(cancelMarketingBlast('b1')).rejects.toThrow('already_fired');
  });
});
