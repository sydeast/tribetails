import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { listRecentSendsHandler, mergeRecentSends, replyRow } from '../src/admin/listRecentSends';

const req = { data: {}, auth: { uid: 'admin1', token: { admin: true } } } as unknown as CallableRequest<unknown>;

beforeEach(() => mocks.dbFn.mockReset());

describe('listRecentSends (#1610)', () => {
  it('lists Inbox replies and broadcasts, not only 1:1 external sends', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          external_messages: [
            { id: 'e1', data: { channel: 'email', recipientRedacted: 'c***@hanasamku.com', subject: 'Hi', sentAtMs: 100, counts: { delivered: 1 } } },
          ],
          broadcasts: [
            { id: 'b1', data: { channels: ['email', 'sms'], subject: 'Holiday hours', criteriaDescription: 'All active kinfolk', recipientCount: 12, sentAtMs: 300 } },
          ],
          conversations: [
            { id: 'kf1', data: { kinfolkName: 'Dre East', lastSenderRole: 'auntie', lastMessagePreview: 'See you Tuesday', lastMessageAtMs: 200 } },
            { id: 'kf2', data: { kinfolkName: 'Sam Rowan', lastSenderRole: 'kinfolk', lastMessagePreview: 'Thanks!', lastMessageAtMs: 400 } },
          ],
        },
      }).db,
    );
    const { sends } = await listRecentSendsHandler(req);
    expect(sends.map((s) => [s.kind, s.id])).toEqual([
      ['broadcast', 'broadcast_b1'],
      ['reply', 'reply_kf1'],
      ['external', 'e1'],
    ]);
    const reply = sends.find((s) => s.kind === 'reply');
    expect(reply).toMatchObject({ channel: 'message', recipientRedacted: 'Dre East', preview: 'See you Tuesday', sentAtMs: 200 });
    const bc = sends.find((s) => s.kind === 'broadcast');
    expect(bc).toMatchObject({ channel: 'broadcast', recipientCount: 12, channels: ['email', 'sms'], subject: 'Holiday hours' });
    expect(sends.find((s) => s.kind === 'external')?.counts.delivered).toBe(1);
  });

  it('is empty only when nothing at all was sent', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ queryDocs: {} }).db);
    expect((await listRecentSendsHandler(req)).sends).toEqual([]);
  });

  it('a thread the household answered last is not a send', () => {
    expect(replyRow('kf', { lastSenderRole: 'kinfolk', lastMessageAtMs: 1 })).toBeNull();
  });

  it('merges newest first and caps the list', () => {
    const rows = [5, 1, 9].map((t) => ({ ...replyRow(`k${t}`, { lastSenderRole: 'auntie', lastMessageAtMs: t })! }));
    expect(mergeRecentSends(rows, 2).map((r) => r.sentAtMs)).toEqual([9, 5]);
  });
});
