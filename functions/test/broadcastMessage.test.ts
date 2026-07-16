import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getAdmin: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  twilioCreate: vi.fn(),
  getTwilio: vi.fn(),
  getTwilioFromNumber: vi.fn(),
  multicast: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: mocks.getAdmin }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/twilio', () => ({ getTwilio: mocks.getTwilio, getTwilioFromNumber: mocks.getTwilioFromNumber }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { broadcastMessageHandler } from '../src/admin/broadcastMessage';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.sendTemplatedEmail.mockReset().mockResolvedValue('sg-1');
  mocks.twilioCreate.mockReset().mockResolvedValue({ sid: 'SM1' });
  mocks.getTwilio.mockReset().mockReturnValue({ messages: { create: mocks.twilioCreate } });
  mocks.getTwilioFromNumber.mockReset().mockReturnValue('+15550000000');
  mocks.multicast.mockReset().mockResolvedValue({ successCount: 1, responses: [{ success: true, messageId: 'fcm-1' }] });
  mocks.getAdmin.mockReset().mockReturnValue({ messaging: () => ({ sendEachForMulticast: mocks.multicast }) });
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as any) : undefined,
  } as unknown as CallableRequest<unknown>;
}

/** Two active kinfolk: full contact, plus one missing email + uid. */
function kinfolkDb(extra: Record<string, any> = {}) {
  return buildDbMock({
    docs: {},
    queryDocs: {
      kinfolk: [
        { id: 'k1', data: { status: 'active', tags: ['vip'], email: 'a@x.com', phoneNumber: '+14155552671', uid: 'u1' } },
        { id: 'k2', data: { status: 'active', tags: ['vip'], email: '', phoneNumber: '+14155559999', uid: '' } },
      ],
      fcm_tokens: [{ id: 'tok1', data: { uid: 'u1' } }],
      ...extra,
    },
  });
}

describe('broadcastMessage happy path', () => {
  it('fans out across all channels and tallies per-channel counts', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(
      req({ criteria: { kind: 'all' }, channels: ['inapp', 'email', 'sms', 'push'], subject: 'Hi', body: 'Body' }),
    );
    expect(res.ok).toBe(true);
    expect(res.recipientCount).toBe(2);
    // k1 has email; k2 has none -> 1 sent, 1 skipped
    expect(res.perChannel.email).toEqual({ sent: 1, skipped: 1, failed: 0 });
    // both have phones -> 2 sms sent
    expect(res.perChannel.sms).toEqual({ sent: 2, skipped: 0, failed: 0 });
    // k1 has uid -> inapp + push sent; k2 no uid -> skipped
    expect(res.perChannel.inapp).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(res.perChannel.push).toEqual({ sent: 1, skipped: 1, failed: 0 });
    // records a broadcasts doc + audit
    expect(ctx.adds.find((a) => a.collection === 'broadcasts')).toBeTruthy();
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ event: 'BROADCAST_SENT' }));
  });

  it('appends the unsubscribe footer on broadcast email but not sms', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['email', 'sms'], subject: 'S', body: 'B' }));
    expect(mocks.sendTemplatedEmail.mock.calls[0][0].bodyTemplate).toContain('reply STOP' /* footer text */);
    expect(mocks.twilioCreate.mock.calls[0][0].body).toBe('B');
  });

  it('writes an in-app notification doc with title + body and empty channels', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['inapp'], subject: 'T', body: 'B' }));
    const w = ctx.writes.find((x) => x.path.startsWith('notifications/'));
    expect(w?.data.title).toBe('T');
    expect(w?.data.body).toBe('B');
    expect(w?.data.channels).toEqual([]);
    expect(w?.data.recipientUid).toBe('u1');
    expect(w?.data.key).toBe('broadcast.message');
  });
});

describe('broadcastMessage suppression', () => {
  it('skips an opted-out email recipient', async () => {
    const id = encodeURIComponent('a@x.com');
    const ctx = buildDbMock({
      docs: { [`message_suppressions/${id}`]: { channel: 'email' } },
      queryDocs: {
        kinfolk: [{ id: 'k1', data: { status: 'active', email: 'a@x.com', phoneNumber: '', uid: '' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['email'], subject: 'S', body: 'B' }));
    expect(res.perChannel.email).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });
});

describe('broadcastMessage segment load', () => {
  it('resolves criteria from a saved segment doc', async () => {
    const ctx = buildDbMock({
      docs: { 'audience_segments/seg1': { criteria: { kind: 'status', statuses: ['active'] } } },
      queryDocs: { kinfolk: [{ id: 'k1', data: { status: 'active', phoneNumber: '+14155552671' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(req({ segmentId: 'seg1', channels: ['sms'], body: 'B' }));
    expect(res.recipientCount).toBe(1);
  });

  it('throws not-found for a missing segment', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { kinfolk: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      broadcastMessageHandler(req({ segmentId: 'missing', channels: ['sms'], body: 'B' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('broadcastMessage guards', () => {
  it('throws failed-precondition no_recipients when the segment is empty', async () => {
    const ctx = buildDbMock({ queryDocs: { kinfolk: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['sms'], body: 'B' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: 'no_recipients' });
  });

  it('throws unavailable when every send failed and nothing skipped', async () => {
    const ctx = buildDbMock({ queryDocs: { kinfolk: [{ id: 'k1', data: { status: 'active', phoneNumber: '+14155552671' } }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.twilioCreate.mockRejectedValue(new Error('Twilio down'));
    await expect(
      broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['sms'], body: 'B' })),
    ).rejects.toMatchObject({ code: 'unavailable', message: 'broadcast_all_failed' });
  });

  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(kinfolkDb().db);
    await expect(
      broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['sms'], body: 'B' }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects email channel without a subject (invalid-argument)', async () => {
    mocks.dbFn.mockReturnValue(kinfolkDb().db);
    await expect(
      broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['email'], body: 'B' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects when neither segmentId nor criteria is given', async () => {
    mocks.dbFn.mockReturnValue(kinfolkDb().db);
    await expect(
      broadcastMessageHandler(req({ channels: ['sms'], body: 'B' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an empty channel list', async () => {
    mocks.dbFn.mockReturnValue(kinfolkDb().db);
    await expect(
      broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: [], body: 'B' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});
