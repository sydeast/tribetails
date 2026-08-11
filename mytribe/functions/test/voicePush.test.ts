import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The "somebody is on the line" push.
 *
 * The payload shape is the whole test surface here, because three separate
 * properties of it are load-bearing and each was learned from an existing
 * sender that gets one of them wrong:
 *
 *   no `notificationKey`   AuntieFirebaseMessagingService branches on that key
 *                          and RETURNS before reaching the `type` switch, so a
 *                          key would route a call invite to the ordinary
 *                          notification path and never raise the call UI.
 *   no `notification` block  a notification block is displayed by the system
 *                          tray, and onMessageReceived never runs in the
 *                          background, which is the only place the full-screen
 *                          intent can be raised.
 *   android priority high  without it a dozing device may not deliver in time
 *                          to answer a ringing phone.
 */

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
  resolveBusinessAdminUids: vi.fn(),
  sendEachForMulticast: vi.fn(),
  deleted: [] as string[],
  tokenDocs: [] as string[],
  tokenQueryThrows: false,
}));

vi.mock('../src/lib/logger', () => ({ logEvent: (...a: unknown[]) => mocks.logEvent(...a) }));
vi.mock('../src/lib/businessAdmins', () => ({
  resolveBusinessAdminUids: (ctx: string) => mocks.resolveBusinessAdminUids(ctx),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({
  getAdmin: () => ({ messaging: () => ({ sendEachForMulticast: (m: unknown) => mocks.sendEachForMulticast(m) }) }),
  db: () => ({
    collection: (_c: string) => ({
      where: (_f: string, _op: string, _v: unknown) => ({
        get: () => {
          if (mocks.tokenQueryThrows) return Promise.reject(new Error('firestore boom'));
          return Promise.resolve({ docs: mocks.tokenDocs.map((id) => ({ id })) });
        },
      }),
      doc: (id: string) => ({
        delete: () => {
          mocks.deleted.push(id);
          return Promise.resolve();
        },
      }),
    }),
  }),
}));

const INVITE = { callSid: 'CA1', callerNumber: '+16195001530', transcript: 'Dana about Tuesday' };

beforeEach(() => {
  mocks.logEvent.mockReset();
  mocks.resolveBusinessAdminUids.mockReset();
  mocks.resolveBusinessAdminUids.mockResolvedValue(['uid-1']);
  mocks.sendEachForMulticast.mockReset();
  mocks.sendEachForMulticast.mockResolvedValue({ successCount: 1, responses: [{ success: true }] });
  mocks.deleted.length = 0;
  mocks.tokenDocs = ['tok-a'];
  mocks.tokenQueryThrows = false;
});

async function send(invite = INVITE) {
  const mod = await import('../src/twilio/voicePush');
  return mod.sendCallInvitePush(invite);
}

describe('sendCallInvitePush — payload', () => {
  it('is DATA-ONLY, with no notification block', async () => {
    await send();
    const msg = mocks.sendEachForMulticast.mock.calls[0][0];
    expect(msg).not.toHaveProperty('notification');
    expect(msg.data).toEqual({
      type: 'call_invite',
      callSid: 'CA1',
      callerNumber: '+16195001530',
      transcript: 'Dana about Tuesday',
    });
  });

  it('carries NO notificationKey, which would short-circuit the Android type switch', async () => {
    await send();
    expect(mocks.sendEachForMulticast.mock.calls[0][0].data).not.toHaveProperty('notificationKey');
  });

  it('sets android priority high, so a dozing phone still rings', async () => {
    await send();
    expect(mocks.sendEachForMulticast.mock.calls[0][0].android).toEqual({ priority: 'high' });
  });

  it('sends every value as a string, since FCM rejects anything else', async () => {
    await send({ ...INVITE, transcript: '' });
    const data = mocks.sendEachForMulticast.mock.calls[0][0].data;
    for (const v of Object.values(data)) expect(typeof v).toBe('string');
  });
});

describe('sendCallInvitePush — recipients', () => {
  it('targets the admin roster, not a hardcoded device', async () => {
    // The endpoint this replaces pushed to a single FCM_DEVICE_TOKEN env value.
    mocks.resolveBusinessAdminUids.mockResolvedValue(['uid-1', 'uid-2']);
    mocks.tokenDocs = ['tok-a', 'tok-b', 'tok-c'];
    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 3,
      responses: [{ success: true }, { success: true }, { success: true }],
    });
    const out = await send();
    expect(mocks.resolveBusinessAdminUids).toHaveBeenCalledWith('sendCallInvitePush');
    expect(mocks.sendEachForMulticast.mock.calls[0][0].tokens).toEqual(['tok-a', 'tok-b', 'tok-c']);
    expect(out).toMatchObject({ delivered: 3, attempted: 3 });
  });

  it('NEVER THROWS when the roster lookup throws, because a caller is on the line', async () => {
    mocks.resolveBusinessAdminUids.mockRejectedValue(new Error('roster empty'));
    await expect(send()).resolves.toEqual({ delivered: 0, attempted: 0, pruned: 0 });
    expect(mocks.sendEachForMulticast).not.toHaveBeenCalled();
  });

  it('never throws when the token read throws', async () => {
    mocks.tokenQueryThrows = true;
    await expect(send()).resolves.toMatchObject({ delivered: 0 });
  });

  it('never throws when the send itself throws', async () => {
    mocks.sendEachForMulticast.mockRejectedValue(new Error('fcm down'));
    await expect(send()).resolves.toMatchObject({ delivered: 0, attempted: 1 });
  });

  it('reports zero devices as an ERROR, because a call nobody hears about is an outage', async () => {
    mocks.tokenDocs = [];
    const out = await send();
    expect(out.attempted).toBe(0);
    expect(mocks.logEvent.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ severity: 'error', event: 'twilioVoice.push.no-devices' }),
    );
  });
});

describe('sendCallInvitePush — stale tokens', () => {
  it('prunes tokens FCM says are dead', async () => {
    mocks.tokenDocs = ['good', 'dead', 'bogus'];
    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 1,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/invalid-registration-token' } },
      ],
    });
    const out = await send();
    expect(mocks.deleted.sort()).toEqual(['bogus', 'dead']);
    expect(out).toMatchObject({ delivered: 1, attempted: 3, pruned: 2 });
  });

  it('keeps a token that failed for a TRANSIENT reason', async () => {
    mocks.tokenDocs = ['flaky'];
    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 0,
      responses: [{ success: false, error: { code: 'messaging/server-unavailable' } }],
    });
    await send();
    expect(mocks.deleted).toEqual([]);
  });

  it('logs an undelivered send at error even though it does not throw', async () => {
    mocks.sendEachForMulticast.mockResolvedValue({
      successCount: 0,
      responses: [{ success: false, error: { code: 'messaging/server-unavailable' } }],
    });
    await send();
    expect(mocks.logEvent.mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ severity: 'error', event: 'twilioVoice.push.undelivered' }),
    );
  });
});
