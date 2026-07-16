import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  createFn: vi.fn(),
  enforceRateLimitFn: vi.fn(),
  readThreadFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/rateLimit', () => ({ enforceRateLimit: mocks.enforceRateLimitFn }));
vi.mock('../src/lib/conversations', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  readThread: mocks.readThreadFn,
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mocks.createFn },
  })),
}));

import { generateHandler } from '../src/portal/generate';
import { resetAnthropicClientForTest } from '../src/lib/aiCopy';

function req(data: unknown, uid: string | null = 'u1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid !== null ? { uid, token: {} as any } : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** Anthropic Messages-API-shaped success response containing one text block. */
function aiText(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' };
}

/**
 * Fixture rule: clients/{uid}.kinfolkIds is what resolveKinfolkAccess actually
 * reads; kinfolk_members is what requireKinfolkPerm reads. Shapes mirror the
 * real writers (see resolveKinfolkAccess.ts / memberGate.ts), not invented.
 */
function memberDb() {
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['f1'] },
      'kinfolk/f1': { firstName: 'Rosa', lastName: 'Alvarez' },
      // Real member path is families/{kinfolkId}/members/{uid}; status is
      // uppercase 'ACTIVE' (memberGate.ts) — fixture mirrors the real writer.
      'families/f1/members/u1': { role: 'PRIMARY', status: 'ACTIVE', permissions: { messaging_direct: true } },
    },
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.createFn.mockReset();
  mocks.enforceRateLimitFn.mockReset().mockResolvedValue(undefined);
  mocks.readThreadFn.mockReset();
  resetAnthropicClientForTest();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('generate (O-8) — polish mode', () => {
  it('HAPPY: polishes a draft, returns sanitized html + plain text', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    mocks.createFn.mockResolvedValue(aiText('<p>Hi Auntie, could you visit at <b>3 pm</b> tomorrow?</p>'));

    const res = await generateHandler(req({ mode: 'polish', body: '<p>hi cn u come 3 tmrw</p>' }));

    expect(res.ok).toBe(true);
    expect(res.mode).toBe('polish');
    expect(res.html).toBe('<p>Hi Auntie, could you visit at <b>3 pm</b> tomorrow?</p>');
    expect(res.text).toContain('Hi Auntie');
    // The draft reached the model sanitized, inside the user turn.
    const call = mocks.createFn.mock.calls[0][0];
    expect(call.model).toBe('claude-opus-4-8');
    expect(call.messages[0].content).toContain('hi cn u come 3 tmrw');
    // Stable system prompt carries the cache breakpoint.
    expect(call.system[0].cache_control).toEqual({ type: 'ephemeral' });
    // Both cost caps enforced: per-uid AND per-household (review finding 4).
    expect(mocks.enforceRateLimitFn).toHaveBeenCalledWith('aiGenerate', 'u1', 30, 3600);
    expect(mocks.enforceRateLimitFn).toHaveBeenCalledWith('aiGenerateKinfolk', 'f1', 60, 3600);
  });

  it('ERROR: household rate limit exceeded blocks even a fresh uid', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    const { HttpsError } = await import('firebase-functions/v2/https');
    mocks.enforceRateLimitFn.mockImplementation(async (scope: string) => {
      if (scope === 'aiGenerateKinfolk') throw new HttpsError('resource-exhausted', 'rate_limited');
    });
    await expect(generateHandler(req({ mode: 'polish', body: 'hello' }))).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    expect(mocks.createFn).not.toHaveBeenCalled();
  });

  it('SAD: strips disallowed markup from the model output before returning', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    mocks.createFn.mockResolvedValue(aiText('<p>ok</p><script>alert(1)</script><img src=x>'));

    const res = await generateHandler(req({ mode: 'polish', body: 'hello there friend' }));
    expect(res.html).not.toContain('script');
    expect(res.html).not.toContain('img');
    expect(res.html).toContain('<p>ok</p>');
  });

  it('NEGATIVE: rejects an empty-after-sanitize draft without calling the model', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    await expect(
      generateHandler(req({ mode: 'polish', body: '<script>x</script>' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mocks.createFn).not.toHaveBeenCalled();
  });

  it('NEGATIVE: unauthenticated is rejected before any work', async () => {
    await expect(generateHandler(req({ mode: 'polish', body: 'x' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(mocks.enforceRateLimitFn).not.toHaveBeenCalled();
  });

  it('NEGATIVE: non-member of the requested kinfolk is denied', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    await expect(
      generateHandler(req({ mode: 'polish', body: 'hello', kinfolkId: 'other-house' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(mocks.createFn).not.toHaveBeenCalled();
  });

  it('NEGATIVE: unknown mode fails Zod validation', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    await expect(generateHandler(req({ mode: 'write_my_novel' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('ERROR: rate limit exceeded surfaces resource-exhausted, model never called', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    const { HttpsError } = await import('firebase-functions/v2/https');
    mocks.enforceRateLimitFn.mockRejectedValue(new HttpsError('resource-exhausted', 'rate_limited'));
    await expect(generateHandler(req({ mode: 'polish', body: 'hello' }))).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    expect(mocks.createFn).not.toHaveBeenCalled();
  });

  it('ERROR: Anthropic failure maps to a retryable `unavailable`, not internal', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    mocks.createFn.mockRejectedValue(new Error('529 overloaded'));
    await expect(generateHandler(req({ mode: 'polish', body: 'hello' }))).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});

describe('generate (O-8) — suggest_reply mode', () => {
  it('HAPPY: builds context from the last thread messages, oldest first', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    // ThreadMessage shape as readThread returns it (senderRole/body are what
    // the handler consumes).
    mocks.readThreadFn.mockResolvedValue([
      { id: 'm1', senderRole: 'kinfolk', senderUid: 'u1', body: '<p>How was Biscuit today?</p>', createdAtMs: 1 },
      { id: 'm2', senderRole: 'auntie', senderUid: 'a1', body: '<p>Great! Does 4 pm work Friday?</p>', createdAtMs: 2 },
    ]);
    mocks.createFn.mockResolvedValue(aiText('<p>Yes, 4 pm Friday works for us. Thank you!</p>'));

    const res = await generateHandler(req({ mode: 'suggest_reply' }));

    expect(res.html).toContain('4 pm Friday');
    const prompt = mocks.createFn.mock.calls[0][0].messages[0].content as string;
    expect(prompt.indexOf('Kinfolk: How was Biscuit today?')).toBeLessThan(
      prompt.indexOf('Auntie: Great! Does 4 pm work Friday?'),
    );
    expect(mocks.readThreadFn).toHaveBeenCalledWith('f1');
  });

  it('SAD: empty thread is failed-precondition, model never called', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    mocks.readThreadFn.mockResolvedValue([]);
    await expect(generateHandler(req({ mode: 'suggest_reply' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(mocks.createFn).not.toHaveBeenCalled();
  });

  it('ERROR: model returning only whitespace maps to unavailable', async () => {
    mocks.dbFn.mockReturnValue(memberDb().db);
    mocks.readThreadFn.mockResolvedValue([
      { id: 'm1', senderRole: 'auntie', senderUid: 'a1', body: 'Hello!', createdAtMs: 1 },
    ]);
    mocks.createFn.mockResolvedValue(aiText('   '));
    await expect(generateHandler(req({ mode: 'suggest_reply' }))).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
