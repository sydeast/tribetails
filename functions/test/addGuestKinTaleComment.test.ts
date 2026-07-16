import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

import {
  addGuestKinTaleCommentHandler,
  MinimalReq,
  MinimalRes,
} from '../src/public/addGuestKinTaleComment';

interface CapturedRes {
  status: number;
  body: Record<string, unknown>;
}

function captureRes(): { res: MinimalRes; captured: CapturedRes } {
  const captured: CapturedRes = { status: 0, body: {} };
  const res: MinimalRes = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      captured.body = payload;
    },
  };
  return { res, captured };
}

function req(body: unknown, method = 'POST'): MinimalReq {
  return { method, body };
}

const futureExpiry = { toMillis: () => Date.now() + 24 * 60 * 60 * 1000 };
const pastExpiry = { toMillis: () => Date.now() - 60 * 1000 };

const validBody = {
  shareToken: 'tok1',
  taleId: 't1',
  guestName: 'Alice',
  guestEmail: 'alice@example.com',
  body: 'lovely tale',
  // Skip reCAPTCHA in unit tests — production call sites always include a token,
  // verified server-side via Cloud reCAPTCHA Enterprise.
  skipRecaptchaForTest: true,
};

describe('addGuestKinTaleCommentHandler', () => {
  it('HAPPY: writes guest comment with authorRole=guest + emailHash, increments rate bucket', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(200);
    expect(captured.body.commentId).toMatch(/^auto-/);
    const add = ctx.adds.find((a) => a.collection.endsWith('/comments'));
    expect(add).toBeDefined();
    expect(add?.data.authorRole).toBe('guest');
    expect(add?.data.guestName).toBe('Alice');
    expect(add?.data.guestEmailHash).toMatch(/^[a-f0-9]{64}$/);
    expect(add?.data.authorUid).toBeNull();
    // rate bucket merged
    const rateWrite = ctx.writes.find((w) => w.path.startsWith('guestCommentRateLimits/'));
    expect(rateWrite).toBeDefined();
    expect((rateWrite!.data as any).count).toBe(1);
  });

  it('strips injected markup from an unauthenticated guest comment body and name', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(
      req({
        ...validBody,
        guestName: '<img src=x onerror="evil()">Mallory',
        body: '<svg onload="alert(1)"></svg>lovely tale',
      }),
      res,
    );
    expect(captured.status).toBe(200);
    const add = ctx.adds.find((a) => a.collection.endsWith('/comments'));
    expect(add?.data.guestName).toBe('Mallory');
    expect(add?.data.body).toBe('lovely tale');
  });

  it('SAD: 400 when the guest comment body is only markup (empty after sanitizing)', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(
      req({ ...validBody, body: '<script>alert(1)</script>' }),
      res,
    );
    expect(captured.status).toBe(400);
  });

  it('HAPPY: reply with parentCommentId persists the link', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
        'kin_care_reports/t1/comments/parentC': { body: 'parent' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req({ ...validBody, parentCommentId: 'parentC' }), res);
    expect(captured.status).toBe(200);
    const add = ctx.adds.find((a) => a.collection.endsWith('/comments'));
    expect(add?.data.parentCommentId).toBe('parentC');
  });

  it('SAD: method not POST returns 405', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody, 'GET'), res);
    expect(captured.status).toBe(405);
  });

  it('SAD: invalid body returns 400', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req({ shareToken: 'tok1' }), res);
    expect(captured.status).toBe(400);
  });

  it('SAD: bad email format returns 400', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(
      req({ ...validBody, guestEmail: 'not-an-email' }),
      res,
    );
    expect(captured.status).toBe(400);
  });

  it('SAD: share not found returns 404', async () => {
    const ctx = buildDbMock({});
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(404);
    expect(captured.body.error).toBe('Share link not found.');
  });

  it('SAD: revoked share returns 403', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: true,
          expiresAt: futureExpiry,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(403);
    expect(captured.body.error).toBe('Share link revoked.');
  });

  it('SAD: expired share returns 403', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: pastExpiry,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(403);
    expect(captured.body.error).toBe('Share link expired.');
  });

  it('SAD: allowGuestComments=false returns 403', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
          allowGuestComments: false,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(403);
    expect(captured.body.error).toBe('Comments disabled for this share link.');
  });

  it('SAD: taleId mismatch returns 400', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 'OTHER',
          revoked: false,
          expiresAt: futureExpiry,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(400);
  });

  it('SAD: parentCommentId missing returns 404', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req({ ...validBody, parentCommentId: 'ghost' }), res);
    expect(captured.status).toBe(404);
    expect(captured.body.error).toBe('Parent comment not found.');
  });

  it('SAD: rate-limited at 6th post within window returns 429 with quoted message', async () => {
    // Pre-populate rate bucket with 5 recent posts.
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
        // emailHash of 'alice@example.com' (sha256, lowercase) — we use the same
        // hashing as the handler so the bucket matches.
        'guestCommentRateLimits/ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976':
          { count: 5, firstAtMs: Date.now() - 60_000 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(429);
    expect(captured.body.error).toBe("You've reached the comment limit. Try again later.");
  });

  it('HAPPY: stale rate bucket (firstAtMs older than 1hr) resets count to 1', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
        'guestCommentRateLimits/ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976':
          { count: 99, firstAtMs: Date.now() - 7200_000 }, // 2hr old
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(200);
    const rateWrite = ctx.writes.find((w) => w.path.startsWith('guestCommentRateLimits/'));
    expect((rateWrite!.data as any).count).toBe(1);
  });

  it('WARNING-23/26: 6th post in-window is 429 (cap enforced atomically in-tx)', async () => {
    // Pre-populate the bucket to the cap (5) so the next post crosses it. The
    // check now lives inside runTransaction; buildDbMock's tx shim reads this
    // doc, so the in-tx guard returns the 429 without writing.
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          tribeId: 'f1',
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
        'guestCommentRateLimits/ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976':
          { count: 5, firstAtMs: Date.now() - 60_000 },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(429);
    // No comment written when over the cap.
    expect(ctx.adds.find((a) => a.collection.endsWith('/comments'))).toBeUndefined();
    // No rate-bucket write either (the tx returned early before tx.set).
    expect(ctx.writes.find((w) => w.path.startsWith('guestCommentRateLimits/'))).toBeUndefined();
  });

  it('WARNING-23/26: concurrent posts cannot exceed the cap (atomic tx on a shared store)', async () => {
    // Mirror the redeemCredit race test: a mutable shared store + a serializing
    // runTransaction. With the non-atomic read-then-write bug, N parallel requests
    // all read count=0 and all write count=1, so all N would pass. The tx fix makes
    // them contend so only GUEST_RATE_LIMIT_PER_HOUR (5) succeed.
    const store: Record<string, Record<string, unknown> | null> = {
      'sharedKinTales/tok1': {
        tribeId: 'f1',
        sourceKinTaleId: 't1',
        revoked: false,
        expiresAt: futureExpiry,
      },
    };
    function makeRef(path: string): any {
      return {
        path,
        id: path.split('/').pop(),
        get: async () => ({
          exists: store[path] != null,
          data: () => store[path] ?? undefined,
        }),
        set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
          store[path] = opts?.merge ? { ...(store[path] ?? {}), ...data } : data;
        },
      };
    }
    let txnTail: Promise<unknown> = Promise.resolve();
    let added = 0;
    const customDb: any = {
      doc: (path: string) => makeRef(path),
      collection: (path: string) => ({
        add: async (data: Record<string, unknown>) => {
          added += 1;
          const id = `auto-${added}`;
          store[`${path}/${id}`] = data;
          return { id };
        },
      }),
      runTransaction: async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
        const prev = txnTail;
        let release: () => void = () => {};
        txnTail = new Promise<void>((r) => (release = r));
        await prev;
        try {
          const tx = {
            get: async (ref: any) => ({
              exists: store[ref.path] != null,
              data: () => store[ref.path] ?? undefined,
            }),
            set: (ref: any, data: Record<string, unknown>, opts?: { merge?: boolean }) => {
              store[ref.path] = opts?.merge ? { ...(store[ref.path] ?? {}), ...data } : data;
            },
          };
          return await fn(tx);
        } finally {
          release();
        }
      },
    };
    mocks.dbFn.mockReturnValue(customDb);

    const fire = async () => {
      const { res, captured } = captureRes();
      await addGuestKinTaleCommentHandler(req(validBody), res);
      return captured.status;
    };
    // 8 concurrent guests, cap is 5.
    const results = await Promise.all(Array.from({ length: 8 }, () => fire()));
    expect(results.filter((s) => s === 200)).toHaveLength(5);
    expect(results.filter((s) => s === 429)).toHaveLength(3);
    // The committed bucket count never exceeds the cap.
    const bucket = Object.entries(store).find(([k]) => k.startsWith('guestCommentRateLimits/'));
    expect((bucket![1] as any).count).toBe(5);
    // Only 5 comments were actually written.
    expect(added).toBe(5);
  });

  it('SAD: share doc missing tribeId returns 500', async () => {
    const ctx = buildDbMock({
      docs: {
        'sharedKinTales/tok1': {
          sourceKinTaleId: 't1',
          revoked: false,
          expiresAt: futureExpiry,
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { res, captured } = captureRes();
    await addGuestKinTaleCommentHandler(req(validBody), res);
    expect(captured.status).toBe(500);
  });
});
