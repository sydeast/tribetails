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
    });

    expect(callMock).toHaveBeenCalledWith('scheduleMarketingBlast', {
      key: 'marketing.optin',
      fireAtMs: 123,
      criteria: { kind: 'all' },
      data: { headline: 'Hi' },
    });
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
    });
    expect(res).toEqual({
      blastId: 'b2',
      matched: 0,
      noLinkedAccount: 0,
      dispatched: 7,
      suppressed: 0,
      failed: 0,
    });
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
    callMock.mockResolvedValue({ ok: true, cancelled: 12 });
    await expect(cancelMarketingBlast('b1')).resolves.toBe(12);
    expect(callMock).toHaveBeenCalledWith('cancelMarketingBlast', { blastId: 'b1' });
  });

  it('lets the server rejection through rather than swallowing it', async () => {
    callMock.mockReset();
    callMock.mockRejectedValue(new Error('already_fired'));
    await expect(cancelMarketingBlast('b1')).rejects.toThrow('already_fired');
  });
});
