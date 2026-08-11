import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';

/**
 * Accept or reject a screened call.
 *
 * The endpoint this replaces returned the plain string `'OK'` to a caller that
 * parsed it with `r.json()`, so a SUCCESSFUL reject surfaced to the operator as
 * "Network error. Check your connection." Its Android caller then ignored the
 * response entirely and reported success unconditionally. Between them, the
 * result shown to the operator was uncorrelated with what actually happened in
 * either direction.
 *
 * So these tests are about the RETURN VALUE being truthful.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
  endConference: vi.fn(),
}));

vi.mock('../src/lib/logger', () => ({ logEvent: (...a: unknown[]) => mocks.logEvent(...a) }));
vi.mock('../src/twilio/twilioVoice', () => ({
  conferenceName: (sid: string) => `conf_${sid}`,
  endConference: (name: string, reason: string) => mocks.endConference(name, reason),
}));

beforeEach(() => {
  mocks.logEvent.mockReset();
  mocks.endConference.mockReset();
  mocks.endConference.mockResolvedValue(true);
});

async function loadHandler() {
  const mod = await import('../src/admin/screenCallAction');
  return mod.screenCallActionHandler;
}

function adminReq(data: unknown): CallableRequest<unknown> {
  return { data, auth: { uid: 'admin-1', token: { admin: true } } } as unknown as CallableRequest<unknown>;
}

describe('screenCallAction', () => {
  it('reject ends the conference for that call', async () => {
    const handler = await loadHandler();
    const out = await handler(adminReq({ callSid: 'CA1', action: 'reject' }));
    expect(mocks.endConference).toHaveBeenCalledWith('conf_CA1', 'rejected-by:admin-1');
    expect(out).toEqual({ action: 'reject', conferenceEnded: true });
  });

  it('accept does NOTHING server-side, because the device answers', async () => {
    // Doing something here would be a second mechanism racing the SDK, which is
    // the exact flaw in the enqueue-then-inject design this replaced.
    const handler = await loadHandler();
    const out = await handler(adminReq({ callSid: 'CA1', action: 'accept' }));
    expect(mocks.endConference).not.toHaveBeenCalled();
    expect(out).toEqual({ action: 'accept', conferenceEnded: false });
  });

  it('reports conferenceEnded FALSE when the caller already hung up', async () => {
    // Not a failure, and the client must not present it as one. The call is off
    // either way, which is what the operator asked for.
    mocks.endConference.mockResolvedValue(false);
    const handler = await loadHandler();
    const out = await handler(adminReq({ callSid: 'CA1', action: 'reject' }));
    expect(out).toEqual({ action: 'reject', conferenceEnded: false });
  });

  it.each([
    [{}],
    [{ callSid: 'CA1' }],
    [{ action: 'reject' }],
    [{ callSid: '', action: 'reject' }],
    [{ callSid: 'CA1', action: 'explode' }],
    [{ callSid: 'CA1', action: 'ACCEPT' }],
  ])('REFUSES invalid arguments: %j', async (data) => {
    const handler = await loadHandler();
    await expect(handler(adminReq(data))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mocks.endConference).not.toHaveBeenCalled();
  });

  it('records who rejected the call, not merely that it was rejected', async () => {
    const handler = await loadHandler();
    await handler(adminReq({ callSid: 'CA1', action: 'reject' }));
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        function: 'screenCallAction',
        event: 'screenCallAction.rejected',
        uid: 'admin-1',
        extra: expect.objectContaining({ sid: 'CA1', conferenceEnded: true }),
      }),
    );
  });

  it('logs an accept too, so the timeline shows what she chose', async () => {
    const handler = await loadHandler();
    await handler(adminReq({ callSid: 'CA1', action: 'accept' }));
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'screenCallAction.accepted', uid: 'admin-1' }),
    );
  });
});
