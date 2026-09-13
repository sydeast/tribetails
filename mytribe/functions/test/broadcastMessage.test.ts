import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { getBroadcastProgressHandler, stopBroadcastHandler } from '../src/admin/broadcastProgress';
import { outboundFanoutSweepCore } from '../src/scheduled/outboundFanoutSweep';
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

/**
 * Writes to the broadcast ROW itself, excluding its subcollections (#823).
 *
 * `broadcasts/{id}` now has children — `fanoutChunks` holds the frozen roster
 * and `fanoutRecipients` holds one claim marker per household — so a bare
 * `path.startsWith('broadcasts/')` matches those too. Three digits of path is
 * the difference between "the handler wrote the row twice" and "the handler
 * wrote the row twice and a hundred markers".
 */
function rowWrites(ctx: { writes: Array<{ path: string; data: any; merge: boolean }> }) {
  return ctx.writes.filter((w) => w.path.split('/').length === 2 && w.path.startsWith('broadcasts/'));
}

/** Two active kinfolk: full contact, plus one missing email + uid. */
function kinfolkDb(extra: Record<string, any> = {}, docs: Record<string, any> = {}) {
  return buildDbMock({ writeThrough: true,
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
    // records a broadcasts doc + audit. #814: the row is a doc().set() written
    // BEFORE the fan-out and merged with the counts afterwards, rather than the
    // single add() it used to be once the sending was over.
    // #823 made it four, and naming them is the point: the CLAIM, the roster
    // arming, the counts merged in when the fan-out's one chunk closed, and the
    // lease release that marks it complete. The claim is still first and still
    // happens before anything is sent, which is the property this asserts.
    expect(rowWrites(ctx)).toHaveLength(4);
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
    const ctx = buildDbMock({ writeThrough: true,
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
    return buildDbMock({ writeThrough: true,
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
    const ctx = buildDbMock({ writeThrough: true,
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
    // The counts land on the row the handler claimed before sending (#814), so
    // the reach is in a MERGE write rather than in a single add().
    const stored = rowWrites(ctx)
      .filter((w) => w.data.reach !== undefined)
      .at(-1);
    expect(stored?.merge).toBe(true);
    expect(stored?.data.reach).toEqual({ targeted: 1, reached: 0, suppressedByPrefs: 1 });
    const audit = (writeAuditEntry as any).mock.calls[0][0];
    expect(audit.payload.reach).toEqual({ targeted: 1, reached: 0, suppressedByPrefs: 1 });
    expect(audit.description).toContain('1 silenced by notification preferences');
  });
});

describe('broadcastMessage segment load', () => {
  it('resolves criteria from a saved segment doc', async () => {
    const ctx = buildDbMock({ writeThrough: true,
      docs: { 'audience_segments/seg1': { criteria: { kind: 'status', statuses: ['active'] } } },
      queryDocs: { kinfolk: [{ id: 'k1', data: { status: 'active', phoneNumber: '+14155552671' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(req({ segmentId: 'seg1', channels: ['sms'], body: 'B' }));
    expect(res.recipientCount).toBe(1);
  });

  it('throws not-found for a missing segment', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {}, queryDocs: { kinfolk: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      broadcastMessageHandler(req({ segmentId: 'missing', channels: ['sms'], body: 'B' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('broadcastMessage guards', () => {
  it('throws failed-precondition no_recipients when the segment is empty', async () => {
    const ctx = buildDbMock({ writeThrough: true, queryDocs: { kinfolk: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      broadcastMessageHandler(req({ criteria: { kind: 'all' }, channels: ['sms'], body: 'B' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', message: 'no_recipients' });
  });

  it('throws unavailable when every send failed and nothing skipped', async () => {
    // The recipient must have SMS switched ON, or the send is never attempted
    // and the failure this asserts cannot happen (#386).
    const ctx = buildDbMock({ writeThrough: true,
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
/**
 * #814: two attempts at one broadcast must send ONE copy.
 *
 * `broadcastMessage` had the same shape the marketing blast did, and is already
 * reachable from the Communicate screen: it minted its `broadcasts/{id}`
 * server-side AFTER the fan-out, so while a send was running there was nothing
 * for a second attempt to collide with, the exact window in which a duplicate
 * arrives, because it is when the client's 20-second budget expires and the
 * operator presses Send again. Here it sends real email and SMS, so the
 * duplicate is unrecallable.
 *
 * `writeThrough` is what makes these assertions mean anything: the claim is that
 * the SECOND attempt sees what the first one wrote.
 */
describe('broadcastMessage idempotency (#814)', () => {
  const KEY_A = 'bcast_1757700000000_ab12cd';
  const KEY_B = 'bcast_1757700000001_ef34gh';
  /** One household with an email and every channel opted in. */
  function liveDb(docs: Record<string, any> = {}) {
    return buildDbMock({ writeThrough: true,
      writeThrough: true,
      docs: { 'clients/u1': prefsDoc({ email: true, sms: true, push: true }), ...docs },
      queryDocs: {
        kinfolk: [
          { id: 'k1', data: { status: 'active', email: 'a@x.com', phoneNumber: '+14155552671', uid: 'u1' } },
        ],
      },
    });
  }
  const send = (over: Record<string, unknown> = {}) => ({
    criteria: { kind: 'all' },
    channels: ['email'],
    subject: 'Hi',
    body: 'Body',
    ...over,
  });
  function broadcastRowIds(ctx: ReturnType<typeof liveDb>): string[] {
    return Array.from(
      new Set(ctx.writes.filter((w) => w.path.startsWith('broadcasts/')).map((w) => w.path.split('/')[1])),
    );
  }
  it('sends once for two calls with the same key', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const first = await broadcastMessageHandler(req(send({ idempotencyKey: KEY_A })));
    const second = await broadcastMessageHandler(req(send({ idempotencyKey: KEY_A })));
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(broadcastRowIds(ctx)).toEqual([KEY_A]);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.broadcastId).toBe(KEY_A);
    // The stored counts, so the reply still describes what went out.
    expect(second.perChannel.email).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(second.reach).toEqual({ targeted: 1, reached: 1, suppressedByPrefs: 0 });
    // One audit row: the second call sent nothing to audit.
    expect((writeAuditEntry as any).mock.calls).toHaveLength(1);
  });
  it('sends twice for two different keys', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await broadcastMessageHandler(req(send({ idempotencyKey: KEY_A })));
    await broadcastMessageHandler(req(send({ idempotencyKey: KEY_B })));
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(2);
    expect(broadcastRowIds(ctx)).toEqual([KEY_A, KEY_B]);
  });
  it('lets only one of two simultaneous attempts send', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const [a, b] = await Promise.all([
      broadcastMessageHandler(req(send({ idempotencyKey: KEY_A }))),
      broadcastMessageHandler(req(send({ idempotencyKey: KEY_A }))),
    ]);
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(1);
    expect(broadcastRowIds(ctx)).toEqual([KEY_A]);
    expect([a.deduped, b.deduped].sort()).toEqual([false, true]);
  });
  it('refuses a key that belongs to a different operator', async () => {
    const ctx = liveDb({ 'broadcasts/bcast_1757700000000_ab12cd': { actorUid: 'someone-else', fanoutState: 'complete' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      broadcastMessageHandler(req(send({ idempotencyKey: KEY_A }))),
    ).rejects.toMatchObject({ code: 'already-exists' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });
  it('re-runs a same-key attempt whose every send failed, because nobody heard anything', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.sendTemplatedEmail.mockRejectedValueOnce(new Error('smtp down'));
    await expect(
      broadcastMessageHandler(req(send({ idempotencyKey: KEY_A }))),
    ).rejects.toMatchObject({ code: 'unavailable' });
    // The row is kept, stamped failed, rather than left at 'running' where a
    // retry would be refused for a send that reached no one.
    const afterFailure = ctx.writes.filter((w) => w.path === `broadcasts/${KEY_A}`).at(-1);
    expect(afterFailure?.data.fanoutState).toBe('failed');
    const retry = await broadcastMessageHandler(req(send({ idempotencyKey: KEY_A })));
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(2);
    expect(retry.deduped).toBe(false);
    expect(retry.perChannel.email.sent).toBe(1);
    expect(broadcastRowIds(ctx)).toEqual([KEY_A]);
  });
  it('keeps the old behaviour exactly when no key is sent', async () => {
    const ctx = liveDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const first = await broadcastMessageHandler(req(send()));
    const second = await broadcastMessageHandler(req(send()));
    expect(mocks.sendTemplatedEmail).toHaveBeenCalledTimes(2);
    expect(broadcastRowIds(ctx)).toHaveLength(2);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(false);
  });
  it('refuses a key that is not the shape the server mints', async () => {
    mocks.dbFn.mockReturnValue(liveDb().db);
    await expect(
      broadcastMessageHandler(req(send({ idempotencyKey: 'blast_1757700000000_ab12cd' }))),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mocks.sendTemplatedEmail).not.toHaveBeenCalled();
  });
});
/**
 * #823: a broadcast too large to finish in one invocation.
 *
 * `broadcastMessage` carries the same 540-second ceiling and the same
 * per-recipient cost as a marketing blast, so the same wall applies — and here
 * the fan-out is real email and SMS rather than queued copies, which makes
 * "reached exactly once" the load-bearing property rather than a nicety.
 *
 * The clock is stubbed and each send advances it, so "the budget ran out
 * half-way through the roster" is stated rather than approximated.
 */
describe('broadcastMessage fan-out that outlives its invocation (#823)', () => {
  const START = 1_760_000_000_000;
  let clock = START;
  beforeEach(() => {
    clock = START;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    // 400ms a household: the email send plus the prefs and suppression reads.
    mocks.sendTemplatedEmail.mockImplementation(async () => {
      clock += 400;
      return 'sg-1';
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  /**
   * `n` active households, each with an email on file.
   *
   * The households are in BOTH `queryDocs` (so the audience resolver's
   * collection scan finds them) and `docs` (so the resumed leg can read one back
   * by id). That is not fixture duplication, it is the resume path: the roster
   * holds kinfolk IDS and never their contact details, because this callable's
   * contract is that no plaintext recipient is stored. A sweep tick has to go
   * and fetch the address, and a fixture that only answered the scan would make
   * the resumed leg silently reach nobody.
   */
  function bigDb(n: number) {
    const docs: Record<string, any> = {};
    for (let i = 0; i < n; i += 1) {
      docs[`clients/u${i}`] = prefsDoc({ email: true, sms: false, push: false });
      docs[`kinfolk/k${i}`] = {
        status: 'active',
        tags: [],
        email: `k${i}@x.com`,
        phoneNumber: '',
        uid: `u${i}`,
      };
    }
    return buildDbMock({
      writeThrough: true,
      docs,
      queryDocs: {
        kinfolk: Array.from({ length: n }, (_, i) => ({
          id: `k${i}`,
          data: { status: 'active', tags: [], email: `k${i}@x.com`, phoneNumber: '', uid: `u${i}` },
        })),
      },
    });
  }
  function addressed(): string[] {
    return mocks.sendTemplatedEmail.mock.calls.map((c: any[]) => c[0].to);
  }
  it('hands off part-way and the sweep emails every household exactly once', async () => {
    const ctx = bigDb(120);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(
      req({ criteria: { kind: 'all' }, channels: ['email'], subject: 'S', body: 'B' }),
    );
    // 15 seconds of budget at 400ms a household is ~37, well short of 120.
    expect(res.pending).toBe(true);
    expect(res.audienceSize).toBe(120);
    expect(res.sent).toBeLessThan(120);
    expect(addressed().length).toBeLessThan(120);
    for (let i = 0; i < 20; i += 1) {
      const row = await ctx.db.collection('broadcasts').doc(res.broadcastId).get();
      if (row.data()?.fanoutState === 'complete') break;
      clock += 1_000;
      await outboundFanoutSweepCore({ nowMs: clock, budgetMs: 30_000 });
    }
    const finished = (await ctx.db.collection('broadcasts').doc(res.broadcastId).get()).data();
    expect(finished.fanoutState).toBe('complete');
    expect(finished.fanoutProcessed).toBe(120);
    // THE PROPERTY: 120 households, 120 emails, no address twice, across a
    // callable and several sweep ticks.
    const to = addressed();
    expect(to).toHaveLength(120);
    expect(new Set(to).size).toBe(120);
    // And the per-channel tally survived the hand-off, because it is derived
    // from the markers at each chunk close rather than kept in a worker's
    // memory. A resumed leg has no memory of the one before it.
    expect(finished.perChannel.email).toEqual({ sent: 120, skipped: 0, failed: 0 });
    expect(finished.reach).toEqual({ targeted: 120, reached: 120, suppressedByPrefs: 0 });
  });
  it('stops the remainder when the operator asks, and says what already went', async () => {
    const ctx = bigDb(120);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(
      req({ criteria: { kind: 'all' }, channels: ['email'], subject: 'S', body: 'B' }),
    );
    expect(res.pending).toBe(true);
    const sentBefore = addressed().length;
    const stop = await stopBroadcastHandler(req({ broadcastId: res.broadcastId }));
    expect(stop.sent + stop.neverSent).toBe(120);
    expect(stop.neverSent).toBeGreaterThan(0);
    // The sweep refuses to resume a send the operator stopped, however many
    // ticks go by.
    for (let i = 0; i < 5; i += 1) {
      clock += 1_000;
      await outboundFanoutSweepCore({ nowMs: clock, budgetMs: 30_000 });
    }
    expect(addressed().length).toBe(sentBefore);
    // Asked twice is refused rather than answered with a second cheerful count.
    await expect(stopBroadcastHandler(req({ broadcastId: res.broadcastId }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
  it('reports progress for a send that is still going', async () => {
    const ctx = bigDb(120);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await broadcastMessageHandler(
      req({ criteria: { kind: 'all' }, channels: ['email'], subject: 'Spring', body: 'B' }),
    );
    const progress = await getBroadcastProgressHandler(req({ broadcastId: res.broadcastId }));
    expect(progress.fanoutState).toBe('running');
    expect(progress.audienceSize).toBe(120);
    expect(progress.subject).toBe('Spring');
    expect(progress.stopRequested).toBe(false);
    expect(progress.sent).toBeLessThan(120);
  });
});
