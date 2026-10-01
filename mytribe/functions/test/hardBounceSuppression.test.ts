import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1077: a HARD bounce reported by the smtp2go event webhook writes the
 * address to `message_suppressions` (reason `hard_bounce`, the time, and the
 * smtp2go event reference), so every send path that honours suppressions
 * skips it. Soft bounces keep counting only. Replays are idempotent.
 *
 * Payload fields (developers.smtp2go.com/docs/webhooks-overview): `event`
 * ('bounce'), `bounce` ('hard' | 'soft'), `rcpt` (the address the email was
 * sent to), `id` (the webhook event id), `email_id`, `time`, `host`.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: { serverTimestamp: () => '__TS__', increment: (n: number) => ({ __inc: n }) },
  };
});

import { smtp2goEventWebhookHandler } from '../src/admin/engagementWebhooks';

const SECRET = 'env-secret';
const ADDR = 'gone@example.com';
const SUPP_PATH = `message_suppressions/${encodeURIComponent(ADDR)}`;

beforeEach(() => {
  process.env.SMTP2GO_WEBHOOK_SECRET = SECRET;
  mocks.dbFn.mockReset();
});

function captureRes() {
  const captured: { status: number; body: any } = { status: 0, body: null };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
    },
    end() {},
  };
  return { res, captured };
}

function post(body: unknown): any {
  return {
    method: 'POST',
    header: (name: string) => (name.toLowerCase() === 'x-webhook-secret' ? SECRET : undefined),
    rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
  };
}

async function deliver(body: unknown) {
  const { res, captured } = captureRes();
  await smtp2goEventWebhookHandler(post(body), res);
  return captured;
}

function hardBounce(overrides: Record<string, unknown> = {}) {
  return {
    event: 'bounce',
    bounce: 'hard',
    rcpt: ADDR,
    id: 'evt-1',
    email_id: 'em-1',
    time: '2026-09-30T10:00:00Z',
    host: 'mx.example.com [203.0.113.5]',
    ...overrides,
  };
}

describe('smtp2go webhook: hard bounce suppresses the address (#1077)', () => {
  it('a hard bounce creates the suppression with reason, time and the smtp2go event reference', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await deliver(hardBounce());

    expect(out.status).toBe(200);
    const w = ctx.writes.find((x) => x.path === SUPP_PATH);
    expect(w).toBeTruthy();
    expect(w!.data).toMatchObject({
      channel: 'email',
      reason: 'hard_bounce',
      source: 'smtp2go',
      recipientRedacted: 'g***@example.com',
      createdAt: '__TS__',
      hardBounce: {
        eventId: 'evt-1',
        emailId: 'em-1',
        eventTime: '2026-09-30T10:00:00Z',
        host: 'mx.example.com [203.0.113.5]',
      },
    });
    expect(typeof w!.data.suppressedAtMs).toBe('number');
    expect(typeof (w!.data.hardBounce as any).recordedAtMs).toBe('number');
  });

  it('suppresses even when no external_messages send matches the email_id (dispatcher, broadcast and invite sends are not in that ledger)', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {}, queryDocs: { external_messages: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await deliver(hardBounce({ email_id: 'not-a-1to1-send' }));

    expect(ctx.writes.some((x) => x.path === SUPP_PATH)).toBe(true);
  });

  it('suppresses even when the event carries no email_id at all', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ev = hardBounce();
    delete (ev as Record<string, unknown>).email_id;
    await deliver(ev);

    expect(ctx.writes.some((x) => x.path === SUPP_PATH)).toBe(true);
  });

  it('keys the suppression on the normalized address the send paths read (trimmed, lowercased)', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await deliver(hardBounce({ rcpt: '  Gone@Example.COM ' }));

    expect(ctx.writes.some((x) => x.path === SUPP_PATH)).toBe(true);
  });

  it('a soft bounce does NOT suppress', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await deliver(hardBounce({ bounce: 'soft' }));

    expect(ctx.writes.some((x) => x.path.startsWith('message_suppressions/'))).toBe(false);
  });

  it('a bounce with no hard/soft classification does NOT suppress', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const ev = hardBounce();
    delete (ev as Record<string, unknown>).bounce;
    await deliver(ev);

    expect(ctx.writes.some((x) => x.path.startsWith('message_suppressions/'))).toBe(false);
  });

  it('a reject event does NOT suppress (it is not an address verdict)', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await deliver(hardBounce({ event: 'reject' }));

    expect(ctx.writes.some((x) => x.path.startsWith('message_suppressions/'))).toBe(false);
  });

  it('a replayed hard-bounce event is idempotent: one write, first event reference kept', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await deliver(hardBounce());
    await deliver(hardBounce());
    // A later, different hard bounce for the same address leaves the
    // original record alone too.
    await deliver(hardBounce({ id: 'evt-2', email_id: 'em-2', time: '2026-10-01T00:00:00Z' }));

    const suppWrites = ctx.writes.filter((x) => x.path === SUPP_PATH);
    expect(suppWrites).toHaveLength(1);
    expect((suppWrites[0]!.data.hardBounce as any).eventId).toBe('evt-1');
    expect((suppWrites[0]!.data.hardBounce as any).eventTime).toBe('2026-09-30T10:00:00Z');
  });

  it('an existing opt-out keeps its record and gains the hard-bounce reference', async () => {
    const optOut = { channel: 'email', recipientRedacted: 'g***@example.com', suppressedAtMs: 111, actorUid: 'admin1' };
    const ctx = buildDbMock({ writeThrough: true, docs: { [SUPP_PATH]: { ...optOut } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await deliver(hardBounce());
    await deliver(hardBounce());

    const suppWrites = ctx.writes.filter((x) => x.path === SUPP_PATH);
    expect(suppWrites).toHaveLength(1);
    // Only the hard-bounce fields are written, so the opt-out's own fields
    // (no `reason`, its suppressedAtMs and actor) are untouched.
    expect(suppWrites[0]!.merge).toBe(true);
    expect(Object.keys(suppWrites[0]!.data)).toEqual(['hardBounce']);
    expect((suppWrites[0]!.data.hardBounce as any).eventId).toBe('evt-1');
  });

  it('still bumps the bounced counter on a matched 1:1 send', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'external_messages/s1': { providerMessageId: 'em-1' } },
      queryDocs: { external_messages: [{ id: 's1', data: { providerMessageId: 'em-1' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await deliver(hardBounce());

    expect(out.body).toMatchObject({ ok: true, applied: 1 });
    const bump = ctx.writes.find((x) => x.path === 'external_messages/s1');
    expect(bump?.data).toMatchObject({ lastEvent: 'bounced' });
    expect(ctx.writes.some((x) => x.path === SUPP_PATH)).toBe(true);
  });
});
