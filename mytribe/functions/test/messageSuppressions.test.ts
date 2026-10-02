import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import type { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));

vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
import {
  listMessageSuppressionsHandler,
  clearMessageSuppressionHandler,
} from '../src/admin/messageSuppressions';

import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockReset().mockResolvedValue('audit-1');
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const id = (s: string) => encodeURIComponent(s);
const BOUNCED = {
  channel: 'email',
  reason: 'hard_bounce',
  source: 'smtp2go',
  recipientRedacted: 'g***@example.com',
  suppressedAtMs: 3000,
  hardBounce: { eventId: 'evt-9', emailId: 'em-1', eventTime: '2026-10-01 10:00:00', host: 'mx', recordedAtMs: 3000 },
};

const OPTED_OUT = {
  channel: 'sms',
  recipientRedacted: '+1******2671',
  suppressedAtMs: 2000,
  actorUid: 'admin1',
};

const MERGED = {
  channel: 'email',
  recipientRedacted: 'm***@example.com',
  suppressedAtMs: 1000,
  actorUid: 'admin1',
  hardBounce: { eventId: 'evt-2', emailId: null, eventTime: null, host: null, recordedAtMs: 5000 },
};

function listDb() {
  return buildDbMock({
    docs: {
      [`message_suppressions/${id('gone@example.com')}`]: BOUNCED,
      [`message_suppressions/${id('+14155552671')}`]: OPTED_OUT,
      [`message_suppressions/${id('merged@example.com')}`]: MERGED,
    },
    queryDocs: {
      message_suppressions: [
        { id: id('gone@example.com'), data: BOUNCED },
        { id: id('+14155552671'), data: OPTED_OUT },
        { id: id('merged@example.com'), data: MERGED },
      ],
    },
  });
}

describe('listMessageSuppressions', () => {
  it('lists newest first with the full address, reason, time and source', async () => {
    mocks.dbFn.mockReturnValue(listDb().db);
    const res = await listMessageSuppressionsHandler(req({}));
    expect(res.items.map((i) => i.recipient)).toEqual(['gone@example.com', '+14155552671', 'merged@example.com']);
    expect(res.items[0]).toEqual({
      recipient: 'gone@example.com',
      recipientRedacted: 'g***@example.com',
      channel: 'email',
      reason: 'hard_bounce',
      source: 'smtp2go',
      suppressedAtMs: 3000,
      eventId: 'evt-9',
      optedOut: false,
    });
    expect(res.items[1]).toMatchObject({ reason: 'opt_out', source: 'admin', eventId: null, channel: 'sms', optedOut: true });
    expect(res.nextCursor).toBeNull();
  });

  it('reports an opt-out that later bounced as a hard bounce', async () => {
    mocks.dbFn.mockReturnValue(listDb().db);
    const res = await listMessageSuppressionsHandler(req({}));
    expect(res.items[2]).toMatchObject({ reason: 'hard_bounce', source: 'smtp2go', eventId: 'evt-2', optedOut: true });
  });

  it('filters by reason', async () => {
    mocks.dbFn.mockReturnValue(listDb().db);
    const bounced = await listMessageSuppressionsHandler(req({ reason: 'hard_bounce' }));
    expect(bounced.items.map((i) => i.recipient)).toEqual(['gone@example.com', 'merged@example.com']);
    const optOut = await listMessageSuppressionsHandler(req({ reason: 'opt_out' }));
    expect(optOut.items.map((i) => i.recipient)).toEqual(['+14155552671']);
  });

  it('pages with a cursor and does not repeat a row', async () => {
    mocks.dbFn.mockReturnValue(listDb().db);
    const first = await listMessageSuppressionsHandler(req({ limit: 2 }));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(id('+14155552671'));
    const second = await listMessageSuppressionsHandler(req({ limit: 2, cursor: first.nextCursor }));
    expect(second.items.map((i) => i.recipient)).toEqual(['merged@example.com']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects an unauthenticated caller and a bad limit', async () => {
    mocks.dbFn.mockReturnValue(listDb().db);
    await expect(listMessageSuppressionsHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(listMessageSuppressionsHandler(req({ limit: 0 }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('clearMessageSuppression', () => {
  it('deletes the doc and audits who cleared it, with the address redacted', async () => {
    const ctx = listDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await clearMessageSuppressionHandler(req({ recipient: ' Gone@Example.com ' }));
    expect(res).toEqual({ ok: true, channel: 'email', recipientRedacted: 'g***@example.com', optOutKept: false });
    expect(ctx.deletes).toEqual([`message_suppressions/${id('gone@example.com')}`]);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'EXTERNAL_SUPPRESSION_CLEARED',
        actorUid: 'admin1',
        targetCollection: 'message_suppressions',
        payload: expect.objectContaining({ channel: 'email', recipientRedacted: 'g***@example.com', reason: 'hard_bounce' }),
      }),
    );
    expect(JSON.stringify((writeAuditEntry as any).mock.calls[0][0])).not.toContain('gone@example.com');
  });

  it('refuses to clear an opt-out only row: the household chose it', async () => {
    const ctx = listDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(clearMessageSuppressionHandler(req({ recipient: '(415) 555-2671' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(ctx.deletes).toEqual([]);
    expect(ctx.writes).toEqual([]);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
  it('on a bounced AND opted-out address, strips only the bounce and keeps the opt-out', async () => {
    const ctx = listDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await clearMessageSuppressionHandler(req({ recipient: 'merged@example.com' }));
    expect(res).toEqual({ ok: true, channel: 'email', recipientRedacted: 'm***@example.com', optOutKept: true });
    expect(ctx.deletes).toEqual([]);
    const write = ctx.writes.find((w) => w.path === `message_suppressions/${id('merged@example.com')}`);
    expect(write).toBeTruthy();
    expect(Object.keys(write!.data).sort()).toEqual(['hardBounce', 'reason', 'source']);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'EXTERNAL_SUPPRESSION_CLEARED',
        payload: expect.objectContaining({ reason: 'hard_bounce', optOutKept: true }),
      }),
    );
  });
  it('also keeps the opt-out when an admin opted out a doc that was already hard-bounced', async () => {
    const both = { ...BOUNCED, actorUid: 'admin1' };
    const ctx = buildDbMock({ docs: { [`message_suppressions/${id('gone@example.com')}`]: both } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await clearMessageSuppressionHandler(req({ recipient: 'gone@example.com' }));
    expect(res.optOutKept).toBe(true);
    expect(ctx.deletes).toEqual([]);
  });
  it('refuses a redacted address and deletes nothing', async () => {
    const ctx = listDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(clearMessageSuppressionHandler(req({ recipient: 'g***@example.com' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(ctx.deletes).toEqual([]);
  });

  it('is not-found when the address is not suppressed', async () => {
    const ctx = listDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(clearMessageSuppressionHandler(req({ recipient: 'nobody@example.com' }))).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(ctx.deletes).toEqual([]);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(listDb().db);
    await expect(clearMessageSuppressionHandler(req({ recipient: 'a@b.com' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('still clears when the audit write fails', async () => {
    const ctx = listDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    (writeAuditEntry as any).mockRejectedValue(new Error('audit down'));
    const res = await clearMessageSuppressionHandler(req({ recipient: 'gone@example.com' }));
    expect(res.ok).toBe(true);
    expect(ctx.deletes).toHaveLength(1);
  });
});
describe('listMessageSuppressions scan ceiling', () => {
  it('hands back a resume cursor when a rare filter hits the scan ceiling without filling a page', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      id: id(`u${i}@example.com`),
      data: { channel: 'email', recipientRedacted: 'u***@example.com', suppressedAtMs: 5000 - i, actorUid: 'a' },
    }));
    const ctx = buildDbMock({ queryDocs: { message_suppressions: rows } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listMessageSuppressionsHandler(req({ reason: 'hard_bounce' }));
    expect(res.items).toEqual([]);
    expect(res.nextCursor).toBe(id('u999@example.com'));
  });
});
