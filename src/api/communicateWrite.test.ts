import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { sendBroadcast, describeAudience, channelCountsOf, type SendBroadcastResult } from './communicateWrite';

beforeEach(() => call.mockReset());

describe('communicateWrite api', () => {
  describe('sendBroadcast', () => {
    it('calls broadcastMessage with the criteria/channels/subject/body payload verbatim', async () => {
      const result: SendBroadcastResult = {
        ok: true,
        broadcastId: 'b1',
        recipientCount: 3,
        perChannel: { email: { sent: 3, skipped: 0, failed: 0 } },
      };
      call.mockResolvedValue(result);

      const args = {
        criteria: { kind: 'all' as const },
        channels: ['email' as const],
        subject: 'Hi kinfolk',
        body: 'The Den has news.',
      };
      const out = await sendBroadcast(args);

      expect(call).toHaveBeenCalledWith('broadcastMessage', args);
      expect(out).toEqual(result);
    });

    it('propagates a rejected call rather than swallowing it (fail loud)', async () => {
      call.mockRejectedValueOnce(new Error('no_recipients'));
      await expect(
        sendBroadcast({ criteria: { kind: 'all' }, channels: ['email'], subject: 'x', body: 'y' }),
      ).rejects.toThrow('no_recipients');
    });

    it('propagates broadcast_all_failed the same way (no silent partial success)', async () => {
      call.mockRejectedValueOnce(new Error('broadcast_all_failed'));
      await expect(
        sendBroadcast({ criteria: { kind: 'all' }, channels: ['sms'], body: 'y' }),
      ).rejects.toThrow('broadcast_all_failed');
    });
  });

  describe('describeAudience', () => {
    it('describes "all" as every active kinfolk', () => {
      expect(describeAudience({ kind: 'all' })).toBe('All active kinfolk');
    });

    it('describes a status criteria with its joined status list', () => {
      expect(describeAudience({ kind: 'status', statuses: ['active', 'prospect'] })).toBe(
        'Status: active, prospect',
      );
    });

    it('describes a tags criteria including the match mode', () => {
      expect(describeAudience({ kind: 'tags', tags: ['vip'], tagMatch: 'any' })).toBe('Tags (any): vip');
      expect(describeAudience({ kind: 'tags', tags: ['vip', 'newsletter'], tagMatch: 'all' })).toBe(
        'Tags (all): vip, newsletter',
      );
    });
  });

  describe('channelCountsOf', () => {
    it('reads a present channel entry', () => {
      expect(
        channelCountsOf({ email: { sent: 2, skipped: 1, failed: 0 } }, 'email'),
      ).toEqual({ sent: 2, skipped: 1, failed: 0 });
    });

    it('defaults every counter to 0 for a missing channel entry (defensive read)', () => {
      expect(channelCountsOf({ email: { sent: 2, skipped: 1, failed: 0 } }, 'sms')).toEqual({
        sent: 0,
        skipped: 0,
        failed: 0,
      });
    });

    it('defaults to all-zero for a null/undefined perChannel map', () => {
      expect(channelCountsOf(null, 'email')).toEqual({ sent: 0, skipped: 0, failed: 0 });
      expect(channelCountsOf(undefined, 'sms')).toEqual({ sent: 0, skipped: 0, failed: 0 });
    });
  });
});
