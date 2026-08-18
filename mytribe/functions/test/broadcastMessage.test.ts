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

/**
 * A `clients/{uid}` doc carrying nothing but this household's per-key choice
 * for the broadcast row.
 *
 * #386: broadcasts now resolve through `resolveChannels` like every other send,
 * and the platform-wide defaults are email ON, SMS and push OFF until the
 * household opts in. So a test that wants SMS or push to actually go out must
 * say so, exactly as a real household would have to.
 */
function prefsDoc(channels: { email?: boolean; sms?: boolean; push?: boolean }) {
  return { notificationPrefs: { byKey: { 'broadcast.message': channels } } };
}

/** Two active kinfolk: full contact, plus one missing email + uid. */
function kinfolkDb(extra: Record<string, any> = {}, docs: Record<string, any> = {}) {
  return buildDbMock({
    // u1 opts into every channel, so this fixture exercises a full fan-out; the
    // uid-less k2 has no prefs document at all and rides the catalog defaults.
    docs: { 'clients/u1': prefsDoc({ email: true, sms: true, push: true }), ...docs },
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
    // Both have phones, but only k1 opted into SMS. k2 has no linked account
    // and therefore no prefs, so it rides the catalog default of SMS off (#386,
    // this row used to read `{ sent: 2 }`, the bug).
    expect(res.perChannel.sms).toEqual({ sent: 1, skipped: 1, failed: 0 });
    // k1 has uid -> inapp + push sent; k2 no uid -> skipped
    expect(res.perChannel.inapp).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(res.perChannel.push).toEqual({ sent: 1, skipped: 1, failed: 0 });
    // Reach is per HOUSEHOLD: both were targeted, k1 heard it, k2 heard nothing
    // (no email, no account) but was not silenced by preferences: email is on
    // for them, they simply have no address on file.
    expect(res.reach).toEqual({ targeted: 2, reached: 1, suppressedByPrefs: 0 });
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

  /**
   * R5: a broadcast writes an inbox document and NO work order.
   *
   * It used to write `channels: []` onto the notification so the fan-out trigger
   * would stamp it 'no-channels'. That was delivery state on a card, used to
   * express "do not deliver this". The ABSENCE of a `notificationDispatch` doc
   * now says the same thing, in the collection that owns the question, so this
   * asserts absence rather than an empty array.
   */
  it('writes an in-app notification doc with title + body and NO dispatch work order', async () => {
    const ctx = kinfolkDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['inapp'], subject: 'T', body: 'B' }));
    const w = ctx.writes.find((x) => x.path.startsWith('notifications/'));
    expect(w?.data.title).toBe('T');
    expect(w?.data.body).toBe('B');
    // Mirrored onto `description`, the field every card renderer already reads.
    // `body` alone was written by this callable and read by nothing, so a
    // broadcast landed in the inbox as a bare subject line.
    expect(w?.data.description).toBe('B');
    expect(w?.data.channels).toBeUndefined();
    expect(w?.data.status).toBeUndefined();
    expect(w?.data.mode).toBeUndefined();
    expect(w?.data.recipientUid).toBe('u1');
    expect(w?.data.key).toBe('broadcast.message');
    // #386: the CATALOG row's category. It used to say 'broadcast', a bucket in
    // no catalog, so no catalog-driven screen could file the card.
    expect(w?.data.category).toBe('messages');
    expect(ctx.writes.some((x) => x.path.startsWith('notificationDispatch/'))).toBe(false);
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

/**
 * #386: a broadcast is a notification, and it now passes through the same
 * preference resolution as every other send: the operator's gate row for
 * `broadcast.message`, then the household's own choice within it. Before this,
 * `broadcastMessage` consulted `message_suppressions` and nothing else, so a
 * household that had switched off email, SMS, push AND in-app still got all
 * four.
 */
describe('broadcastMessage notification preferences', () => {
  /** One kinfolk with every contact detail and a linked account. */
  function oneKinfolkDb(docs: Record<string, any>) {
    return buildDbMock({
      docs,
      queryDocs: {
        kinfolk: [
          { id: 'k1', data: { status: 'active', email: 'a@x.com', phoneNumber: '+14155552671', uid: 'u1' } },
        ],
        fcm_tokens: [{ id: 'tok1', data: { uid: 'u1' } }],
      },
    });
  }

  it('sends NOTHING to a household that switched every channel off', async () => {
    const ctx = oneKinfolkDb({ 'clients/u1': prefsDoc({ email: false, sms: false, push: false }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(
      req({ criteria: { kind: 'all' }, channels: ['inapp', 'email', 'sms', 'push'], subject: 'Hi', body: 'B' }),
    );
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(mocks.twilioCreate).not.toHaveBeenCalled();
    expect(mocks.multicast).not.toHaveBeenCalled();
    // In-app rides the same gate: no channels means no inbox card either, the
    // same call `enqueueNotification` makes.
    expect(ctx.writes.some((w) => w.path.startsWith('notifications/'))).toBe(false);
    for (const ch of ['inapp', 'email', 'sms', 'push'] as const) {
      expect(res.perChannel[ch], ch).toEqual({ sent: 0, skipped: 1, failed: 0 });
    }
    expect(res.reach).toEqual({ targeted: 1, reached: 0, suppressedByPrefs: 1 });
  });

  it('sends on exactly the one channel the household left on', async () => {
    const ctx = oneKinfolkDb({ 'clients/u1': prefsDoc({ email: false, sms: true, push: false }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(
      req({ criteria: { kind: 'all' }, channels: ['email', 'sms', 'push'], subject: 'Hi', body: 'B' }),
    );
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(mocks.multicast).not.toHaveBeenCalled();
    expect(res.perChannel.sms).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(res.perChannel.email).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(res.perChannel.push).toEqual({ sent: 0, skipped: 1, failed: 0 });
    // Reached on one channel is still reached, and nobody was fully silenced.
    expect(res.reach).toEqual({ targeted: 1, reached: 1, suppressedByPrefs: 0 });
  });

  it('honors the operator gate: the kinfolk stream disabled silences the broadcast', async () => {
    const ctx = oneKinfolkDb({
      'businessSettings/notifications': {
        byKey: { 'broadcast.message': { enabled: true, channels: {}, streams: { kinfolk: { enabled: false } } } },
      },
      'clients/u1': prefsDoc({ email: true, sms: true, push: true }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(
      req({ criteria: { kind: 'all' }, channels: ['email', 'sms', 'push'], subject: 'Hi', body: 'B' }),
    );
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    expect(mocks.twilioCreate).not.toHaveBeenCalled();
    expect(res.reach).toEqual({ targeted: 1, reached: 0, suppressedByPrefs: 1 });
  });

  it('lets the operator force SMS on for a household that never opted in', async () => {
    // The gate's LOCK is the operator's remedy for the SMS/push default being
    // off: locking the channel with an explicit true pins it on for everyone.
    const ctx = oneKinfolkDb({
      'businessSettings/notifications': {
        byKey: { 'broadcast.message': { enabled: true, channels: { sms: true }, locked: { sms: true } } },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['sms'], body: 'B' }));
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
    expect(res.perChannel.sms).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(res.reach).toEqual({ targeted: 1, reached: 1, suppressedByPrefs: 0 });
  });

  it('checks message_suppressions ON TOP of preferences, not instead of them', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': prefsDoc({ email: true }),
        [`message_suppressions/${encodeURIComponent('a@x.com')}`]: { channel: 'email' },
      },
      queryDocs: { kinfolk: [{ id: 'k1', data: { status: 'active', email: 'a@x.com', uid: 'u1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['email'], subject: 'S', body: 'B' }));
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
    // Preferences said yes, the unsubscribe list said no. Nobody was silenced by
    // PREFERENCES, so the reach breakdown must not claim they were.
    expect(res.perChannel.email).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(res.reach).toEqual({ targeted: 1, reached: 0, suppressedByPrefs: 0 });
  });

  it('records reach in the broadcasts doc and the audit entry', async () => {
    const ctx = oneKinfolkDb({ 'clients/u1': prefsDoc({ email: false, sms: false, push: false }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['email'], subject: 'S', body: 'B' }));
    const stored = ctx.adds.find((a) => a.collection === 'broadcasts');
    expect(stored?.data.reach).toEqual({ targeted: 1, reached: 0, suppressedByPrefs: 1 });
    const audit = (writeAuditEntry as any).mock.calls[0][0];
    expect(audit.payload.reach).toEqual({ targeted: 1, reached: 0, suppressedByPrefs: 1 });
    expect(audit.description).toContain('1 silenced by notification preferences');
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
    // The recipient must have SMS switched ON, or the send is never attempted
    // and the failure this asserts cannot happen (#386).
    const ctx = buildDbMock({
      docs: { 'clients/u1': prefsDoc({ sms: true }) },
      queryDocs: { kinfolk: [{ id: 'k1', data: { status: 'active', phoneNumber: '+14155552671', uid: 'u1' } }] },
    });
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
