import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * The outbound mirror: `sendExternalMessage` writing an operator's reply into
 * `sms_messages` so the Inbox Channels thread reads as a conversation.
 *
 * The tests that matter here are the REFUSALS. Mirroring is guarded by a privacy
 * rule (an `sms_messages` row holds the number in the clear; every other write
 * this callable makes holds it redacted), and the guard is worth nothing if a
 * caller can defeat it by passing a flag. So: a number with no existing thread
 * must not be written even when the caller asks, and the audit entry must keep
 * carrying only the masked recipient either way.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  sendTemplatedEmail: vi.fn(),
  twilioCreate: vi.fn(),
  getTwilio: vi.fn(),
  getTwilioFromNumber: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/lib/email', () => ({ sendTemplatedEmail: mocks.sendTemplatedEmail }));
vi.mock('../src/lib/twilio', () => ({
  getTwilio: mocks.getTwilio,
  getTwilioFromNumber: mocks.getTwilioFromNumber,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { sendExternalMessageHandler } from '../src/admin/sendExternalMessage';
import {
  MIRROR_SKIPPED,
  buildOutboundMirrorDoc,
  resolveReconcileStatus,
} from '../src/lib/smsChannelMirror';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

const RECIPIENT = '+14155552671';

/** An existing inbound row, i.e. this person texted us first. */
const EXISTING_THREAD_ROW = {
  id: 'SMinbound',
  data: {
    counterpartNumber: RECIPIENT,
    direction: 'inbound',
    kinfolkId: 'kin-7',
    kinfolkName: 'Dana Reyes',
    threadId: 'thread-3',
    timestamp: '2026-07-24T10:00:00.000Z',
  },
};

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.sendTemplatedEmail.mockReset().mockResolvedValue('sg-msg-1');
  mocks.twilioCreate.mockReset().mockResolvedValue({ sid: 'SMreply1' });
  mocks.getTwilio.mockReset().mockReturnValue({ messages: { create: mocks.twilioCreate } });
  mocks.getTwilioFromNumber.mockReset().mockReturnValue('+15550000000');
  (writeAuditEntry as unknown as { mockClear: () => void }).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } } as never) : undefined,
  } as CallableRequest<unknown>;
}

/** Seeds the db mock. `thread` present means the number is a known counterpart. */
function seed(opts: { thread: boolean }) {
  const mock = buildDbMock({
    queryDocs: opts.thread ? { sms_messages: [EXISTING_THREAD_ROW] } : { sms_messages: [] },
  });
  mocks.dbFn.mockReturnValue(mock.db);
  return mock;
}

describe('sendExternalMessage outbound channel mirror', () => {
  it('writes an outbound row when the number already has a thread', async () => {
    const mock = seed({ thread: true });

    const res = await sendExternalMessageHandler(
      req({ channel: 'sms', to: RECIPIENT, body: 'On my way', transactional: true, mirrorToChannel: true }),
    );

    expect(res.mirrored).toBe(true);
    expect(res.mirrorSkippedReason).toBeNull();

    // Keyed by the Twilio SID, exactly as twilioInboundSms keys its own, so a
    // retried send upserts one row instead of duplicating the reply.
    const write = mock.writes.find((w) => w.path === 'sms_messages/SMreply1');
    expect(write, 'the mirror row must be keyed by the provider message id').toBeDefined();
    expect(write?.merge).toBe(true);
    expect(write?.data).toMatchObject({
      counterpartNumber: RECIPIENT,
      direction: 'outbound',
      subType: 'sms',
      body: 'On my way',
      status: 'sent',
      twilioMessageSid: 'SMreply1',
      // Linkage is INHERITED from the thread, not re-derived.
      kinfolkId: 'kin-7',
      kinfolkName: 'Dana Reyes',
      threadId: 'thread-3',
      mirroredFrom: 'sendExternalMessage',
      actorUid: 'admin1',
    });
  });

  it('REFUSES to mirror a number with no existing thread, even though the caller asked', async () => {
    // The privacy guard. A one-off contact must never reach `sms_messages` in
    // the clear just because a client passed the flag.
    const mock = seed({ thread: false });

    const res = await sendExternalMessageHandler(
      req({ channel: 'sms', to: RECIPIENT, body: 'Hello', transactional: true, mirrorToChannel: true }),
    );

    expect(res.mirrored).toBe(false);
    expect(res.mirrorSkippedReason).toBe(MIRROR_SKIPPED.NO_EXISTING_THREAD);
    expect(mock.writes.filter((w) => w.path.startsWith('sms_messages/'))).toEqual([]);
  });

  it('does not mirror when the caller did not ask, which is what keeps one-off sends out of the list', async () => {
    const mock = seed({ thread: true });

    const res = await sendExternalMessageHandler(
      req({ channel: 'sms', to: RECIPIENT, body: 'One off', transactional: true }),
    );

    expect(res.mirrored).toBe(false);
    expect(res.mirrorSkippedReason).toBe(MIRROR_SKIPPED.NOT_REQUESTED);
    expect(mock.writes.filter((w) => w.path.startsWith('sms_messages/'))).toEqual([]);
    // The send itself still happened.
    expect(mocks.twilioCreate).toHaveBeenCalledTimes(1);
  });

  it('reports a failed mirror WITHOUT failing the send, because a resend is worse', async () => {
    const mock = seed({ thread: true });
    // The send succeeds; only the mirror write breaks (an undeployed composite
    // index looks exactly like this).
    const collection = mock.db.collection;
    mock.db.collection = (path: string) => {
      const real = collection(path);
      if (path !== 'sms_messages') return real;
      return { ...real, doc: () => ({ set: async () => { throw new Error('index missing'); } }) };
    };

    const res = await sendExternalMessageHandler(
      req({ channel: 'sms', to: RECIPIENT, body: 'Running late', transactional: true, mirrorToChannel: true }),
    );

    expect(res.ok).toBe(true);
    expect(res.providerMessageId).toBe('SMreply1');
    expect(res.mirrored).toBe(false);
    expect(res.mirrorSkippedReason).toBe(MIRROR_SKIPPED.WRITE_FAILED);
  });

  it('leaves the audit trail redacted, mirror or not', async () => {
    seed({ thread: true });

    await sendExternalMessageHandler(
      req({ channel: 'sms', to: RECIPIENT, body: 'Hi', transactional: true, mirrorToChannel: true }),
    );

    const entry = (writeAuditEntry as unknown as { mock: { calls: Array<[Record<string, never>]> } }).mock
      .calls[0][0] as unknown as { payload: Record<string, unknown>; description: string };
    // The mirror records THAT a row was written, never who it went to. The
    // plaintext number must not appear anywhere in the audit entry.
    expect(entry.payload.mirrored).toBe(true);
    expect(entry.payload.recipientRedacted).toBe('+1******2671');
    expect(JSON.stringify(entry)).not.toContain(RECIPIENT);
  });

  it('rejects mirrorToChannel on the email channel rather than ignoring it', async () => {
    seed({ thread: true });
    await expect(
      sendExternalMessageHandler(
        req({ channel: 'email', to: 'a@example.com', subject: 'Hi', body: 'Hi', mirrorToChannel: true }),
      ),
    ).rejects.toThrow(/validation failed/i);
  });
});

describe('mirror row construction', () => {
  it('skips reconcile for a row that inherited a kinfolk link, and pends one that did not', () => {
    // 'pending' is what reconcile_comms.py claims. A row we already linked has
    // nothing for it to derive; an unlinked one must still reach the dossier.
    expect(resolveReconcileStatus('kin-7')).toBe('skipped');
    expect(resolveReconcileStatus(null)).toBe('pending');
  });

  it('stamps an ISO STRING timestamp, because every reader range-queries it lexically', () => {
    const doc = buildOutboundMirrorDoc({
      counterpartNumber: RECIPIENT,
      body: 'text',
      providerMessageId: 'SM1',
      actorUid: 'admin1',
      thread: { kinfolkId: null, kinfolkName: '', threadId: '' },
      nowIso: '2026-07-25T12:00:00.000Z',
    });
    // A Timestamp here would sort after every string and silently strand the
    // operator's own replies away from the thread they belong to.
    expect(typeof doc.timestamp).toBe('string');
    expect(doc.timestamp).toBe('2026-07-25T12:00:00.000Z');
    expect(doc.reconcileStatus).toBe('pending');
  });

  it('carries the same field set the inbound webhook writes', () => {
    // The Inbox readers, android's observeSmsMessages and reconcile_comms.py all
    // parse ONE shape. A mirror row missing a key reads as a malformed row.
    const doc = buildOutboundMirrorDoc({
      counterpartNumber: RECIPIENT,
      body: 'text',
      providerMessageId: 'SM1',
      actorUid: 'admin1',
      thread: { kinfolkId: 'kin-7', kinfolkName: 'Dana Reyes', threadId: 't1' },
      nowIso: '2026-07-25T12:00:00.000Z',
    });
    for (const key of [
      'counterpartNumber', 'direction', 'subType', 'body', 'mediaUrls', 'timestamp',
      'status', 'twilioMessageSid', 'kinfolkId', 'kinfolkName', 'threadId',
      'reconcileStatus', 'reconciledAt', 'reconcileNotes',
    ]) {
      expect(doc, `${key} is part of the inbound schema and must be present`).toHaveProperty(key);
    }
  });
});
