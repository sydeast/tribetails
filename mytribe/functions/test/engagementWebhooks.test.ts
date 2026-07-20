import { describe, it, expect, vi, beforeEach } from 'vitest';

// WARNING-24/38: smtp2go webhook must FAIL CLOSED — reject when no shared secret
// is configured AND when the integrations_config read errors, instead of the old
// fail-open `{ ok: true, reason: 'disabled' }`. These tests drive the bare
// handler with a stubbed config doc + headers.

const mocks = vi.hoisted(() => ({
  configGet: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: (p: string) => {
      if (p === 'integrations_config/email') return { get: mocks.configGet };
      // applyEngagement collection/doc refs — not reached on the reject paths.
      return { get: vi.fn() };
    },
    collection: () => ({
      where: () => ({ limit: () => ({ get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) }) }),
    }),
    runTransaction: vi.fn(),
  }),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

beforeEach(() => {
  mocks.configGet.mockReset();
  delete process.env.SMTP2GO_WEBHOOK_SECRET;
});

interface CapturedRes {
  status: number;
  body: Record<string, unknown> | null;
  ended: boolean;
}
function captureRes(): { res: any; captured: CapturedRes } {
  const captured: CapturedRes = { status: 0, body: null, ended: false };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      captured.body = payload;
    },
    end() {
      captured.ended = true;
    },
  };
  return { res, captured };
}

function makeReq(opts: { headers?: Record<string, string>; rawBody?: string } = {}): any {
  const headers = opts.headers ?? {};
  return {
    method: 'POST',
    header: (name: string) => headers[name.toLowerCase()],
    rawBody: Buffer.from(opts.rawBody ?? '{}', 'utf8'),
  };
}

describe('smtp2goEventWebhookHandler — fail closed (WARNING-24/38)', () => {
  it('REJECTS 403 when no secret is configured (env unset + config doc empty)', async () => {
    mocks.configGet.mockResolvedValue({ data: () => ({}) });
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    await smtp2goEventWebhookHandler(makeReq({ headers: { 'x-webhook-secret': 'anything' } }), res);
    expect(captured.status).toBe(403);
  });

  it('REJECTS 403 when the integrations_config read throws (no fall-through to accept)', async () => {
    mocks.configGet.mockRejectedValue(new Error('firestore unavailable'));
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    await smtp2goEventWebhookHandler(makeReq({ headers: { 'x-webhook-secret': 'anything' } }), res);
    expect(captured.status).toBe(403);
  });

  it('REJECTS 403 when the presented header does not match the configured secret', async () => {
    mocks.configGet.mockResolvedValue({ data: () => ({ webhookSecret: 'real-secret' }) });
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    await smtp2goEventWebhookHandler(makeReq({ headers: { 'x-webhook-secret': 'wrong' } }), res);
    expect(captured.status).toBe(403);
  });

  it('REJECTS 403 when the secret is configured but the header is absent', async () => {
    mocks.configGet.mockResolvedValue({ data: () => ({ webhookSecret: 'real-secret' }) });
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    await smtp2goEventWebhookHandler(makeReq({ headers: {} }), res);
    expect(captured.status).toBe(403);
  });

  it('ACCEPTS (passes verify) when the env secret matches — proves it is not blanket-rejecting', async () => {
    process.env.SMTP2GO_WEBHOOK_SECRET = 'env-secret';
    // config read should not even be consulted when env provides the secret.
    mocks.configGet.mockRejectedValue(new Error('should not be called'));
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    // Empty JSON object body -> 0 events; verify passes -> 200 batch ack.
    await smtp2goEventWebhookHandler(
      makeReq({ headers: { 'x-webhook-secret': 'env-secret' }, rawBody: '{}' }),
      res,
    );
    expect(captured.status).toBe(200);
    expect(mocks.configGet).not.toHaveBeenCalled();
  });

  it('rejects non-POST with 405 before any verification', async () => {
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    await smtp2goEventWebhookHandler({ ...makeReq(), method: 'GET' }, res);
    expect(captured.status).toBe(405);
  });
});

describe('NOTE-58: smtp2go webhook rejects oversized input', () => {
  beforeEach(() => {
    // Verify passes via env secret so we reach the size/array caps.
    process.env.SMTP2GO_WEBHOOK_SECRET = 'env-secret';
  });

  it('REJECTS 413 when the events array exceeds the cap (>100)', async () => {
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    const tooMany = JSON.stringify(
      Array.from({ length: 101 }, (_, i) => ({ event: 'open', email_id: `e${i}`, id: `id${i}` })),
    );
    await smtp2goEventWebhookHandler(
      makeReq({ headers: { 'x-webhook-secret': 'env-secret' }, rawBody: tooMany }),
      res,
    );
    expect(captured.status).toBe(413);
    expect(captured.body).toMatchObject({ error: 'too-many-events' });
  });

  it('ACCEPTS an array exactly at the cap (100) — proves the cap is not off-by-one strict', async () => {
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    const atCap = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({ event: 'open', email_id: `e${i}`, id: `id${i}` })),
    );
    await smtp2goEventWebhookHandler(
      makeReq({ headers: { 'x-webhook-secret': 'env-secret' }, rawBody: atCap }),
      res,
    );
    // All unmatched (mock query returns empty) but the request is accepted.
    expect(captured.status).toBe(200);
  });

  it('REJECTS 413 when the raw body exceeds 1MB', async () => {
    const { smtp2goEventWebhookHandler } = await import('../src/admin/engagementWebhooks');
    const { res, captured } = captureRes();
    const huge = 'x'.repeat(1_000_001); // > 1MB; never even parsed
    await smtp2goEventWebhookHandler(
      makeReq({ headers: { 'x-webhook-secret': 'env-secret' }, rawBody: huge }),
      res,
    );
    expect(captured.status).toBe(413);
    expect(captured.body).toMatchObject({ error: 'payload-too-large' });
  });
});
