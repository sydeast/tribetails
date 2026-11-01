import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1331 and #1332. A passcode-protected share is unlocked by a passcode sent
 * in a POST body (never a URL), and a guest note on such a share is refused on
 * every path unless the request proves the unlock: the HMAC token from
 * lib/shareUnlock.ts, or the passcode itself verified with argon2.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  argonVerify: vi.fn(async (h: string, p: string) => h === `h:${p}`),
  createAssessment: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('argon2', () => ({ default: { verify: mocks.argonVerify } }));
vi.mock('@google-cloud/recaptcha-enterprise', () => ({
  RecaptchaEnterpriseServiceClient: class {
    createAssessment = mocks.createAssessment;
  },
}));

import { getShareLinkHandler } from '../src/share/getShareLink';
import { addGuestKinTaleCommentHandler, type MinimalRes } from '../src/public/addGuestKinTaleComment';
import { mintShareUnlock, SHARE_UNLOCK_TTL_MS } from '../src/lib/shareUnlock';

const futureExpiry = { toMillis: () => Date.now() + 1e7 };

function share(overrides: Record<string, unknown> = {}) {
  return {
    revoked: false,
    expiresAt: futureExpiry,
    passcodeHash: 'h:1234',
    tribeId: 'f1',
    sourceKinTaleId: 'tale-1',
    scrubbedPayload: { body: 'Biscuit napped.' },
    ...overrides,
  };
}
function useDb(shareDoc: Record<string, unknown>) {
  const ctx = buildDbMock({ docs: { 'sharedKinTales/s1': shareDoc } });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.argonVerify.mockClear();
  mocks.logEvent.mockClear();
  mocks.createAssessment.mockReset();
  mocks.createAssessment.mockResolvedValue([
    { tokenProperties: { valid: true, action: 'guest_comment' }, riskAnalysis: { score: 0.9 } },
  ]);
});

// ── getShareLink (#1331) ────────────────────────────────────────────────────
interface JsonOut {
  status: number;
  body: Record<string, unknown>;
}
async function getShare(req: { method: string; path?: string; query?: Record<string, unknown>; body?: unknown }): Promise<JsonOut> {
  const out: JsonOut = { status: 0, body: {} };
  const res = {
    status(n: number) {
      out.status = n;
      return {
        json(b: unknown) {
          out.body = b as Record<string, unknown>;
        },
      };
    },
  };
  await getShareLinkHandler(
    { path: '/s1', query: {}, ...req } as unknown as Parameters<typeof getShareLinkHandler>[0],
    res,
  );
  return out;
}

describe('#1331 getShareLink takes the passcode in a POST body', () => {
  it('unlocks with the passcode in the body and returns an unlock token', async () => {
    useDb(share());
    const r = await getShare({ method: 'POST', body: { passcode: '1234' } });
    expect(r.status).toBe(200);
    expect(r.body.body).toBe('Biscuit napped.');
    expect(r.body.sourceKinTaleId).toBe('tale-1');
    expect(typeof r.body.unlockToken).toBe('string');
    expect(String(r.body.unlockToken)).not.toContain('1234');
    expect(mocks.argonVerify).toHaveBeenCalledTimes(1);
  });

  it('refuses a wrong passcode in the body with 401 and no token', async () => {
    useDb(share());
    const r = await getShare({ method: 'POST', body: { passcode: '9999' } });
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'passcode-required' });
  });

  it('re-reads with an unlock token and mints no new one, without argon2', async () => {
    useDb(share());
    const token = mintShareUnlock('s1', 'h:1234');
    const r = await getShare({ method: 'POST', body: { unlockToken: token } });
    expect(r.status).toBe(200);
    expect(r.body.unlockToken).toBeUndefined();
    expect(mocks.argonVerify).not.toHaveBeenCalled();
  });

  it('refuses a token minted for another share or a changed passcode', async () => {
    useDb(share());
    for (const token of [mintShareUnlock('other', 'h:1234'), mintShareUnlock('s1', 'h:0000')]) {
      const r = await getShare({ method: 'POST', body: { unlockToken: token } });
      expect(r.status).toBe(401);
    }
  });

  it('refuses ?passcode= in the URL before reading the share or running argon2, and never echoes it', async () => {
    useDb(share());
    for (const method of ['GET', 'POST']) {
      const r = await getShare({ method, query: { passcode: '1234' } });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'passcode-in-url' });
      expect(JSON.stringify(r.body)).not.toContain('1234');
    }
    // An empty `?passcode=` is still a passcode in the URL.
    expect((await getShare({ method: 'GET', query: { passcode: '' } })).status).toBe(400);
    expect(mocks.dbFn).not.toHaveBeenCalled();
    expect(mocks.argonVerify).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.logEvent.mock.calls)).not.toContain('1234');
  });

  it('keeps a plain GET working: 401 for a protected share, the payload for an open one', async () => {
    useDb(share());
    expect((await getShare({ method: 'GET' })).status).toBe(401);
    useDb(share({ passcodeHash: null }));
    const open = await getShare({ method: 'GET' });
    expect(open.status).toBe(200);
    expect(open.body).toEqual({ body: 'Biscuit napped.', sourceKinTaleId: 'tale-1' });
  });

  it('ignores a passcode in a GET body (only POST reads the body)', async () => {
    useDb(share());
    expect((await getShare({ method: 'GET', body: { passcode: '1234' } })).status).toBe(401);
    expect(mocks.argonVerify).not.toHaveBeenCalled();
  });

  it('costs one argon2 verify per POSTed guess, as before', async () => {
    useDb(share());
    for (const guess of ['0000', '1111', '2222']) {
      expect((await getShare({ method: 'POST', body: { passcode: guess } })).status).toBe(401);
    }
    expect(mocks.argonVerify).toHaveBeenCalledTimes(3);
  });
});

// ── addGuestKinTaleComment (#1332) ──────────────────────────────────────────
async function postNote(body: Record<string, unknown>): Promise<JsonOut> {
  const out: JsonOut = { status: 0, body: {} };
  const res: MinimalRes = {
    status(code) {
      out.status = code;
      return res;
    },
    json(payload) {
      out.body = payload;
    },
  };
  await addGuestKinTaleCommentHandler({ method: 'POST', body }, res);
  return out;
}
const note = {
  shareToken: 's1',
  taleId: 'tale-1',
  guestName: 'Ann',
  guestEmail: 'catch@hanasamku.com',
  body: 'What a good boy.',
  recaptchaToken: 'tok',
};
function commentAdds(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.adds.filter((a) => a.collection === 'kin_care_reports/tale-1/comments');
}
function rateWrites(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.filter((w) => w.path.startsWith('guestCommentRateLimits/'));
}

describe('#1332 addGuestKinTaleComment needs proof of unlock on a protected share', () => {
  it('refuses a note with no proof, before reCAPTCHA and the rate limit', async () => {
    const ctx = useDb(share());
    const r = await postNote(note);
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: 'passcode-required' });
    expect(commentAdds(ctx)).toHaveLength(0);
    expect(rateWrites(ctx)).toHaveLength(0);
    expect(mocks.createAssessment).not.toHaveBeenCalled();
  });

  it('accepts a note with a valid unlock token, without argon2', async () => {
    const ctx = useDb(share());
    const r = await postNote({ ...note, unlockToken: mintShareUnlock('s1', 'h:1234') });
    expect(r.status).toBe(200);
    expect(commentAdds(ctx)).toHaveLength(1);
    // The rate bucket is visible to `rateWrites`, so the refusals' zero is real.
    expect(rateWrites(ctx).length).toBeGreaterThan(0);
    expect(mocks.createAssessment).toHaveBeenCalledTimes(1);
    expect(mocks.argonVerify).not.toHaveBeenCalled();
  });

  it('accepts a note with the right passcode in the body (one argon2 verify)', async () => {
    const ctx = useDb(share());
    const r = await postNote({ ...note, passcode: '1234' });
    expect(r.status).toBe(200);
    expect(commentAdds(ctx)).toHaveLength(1);
    expect(mocks.argonVerify).toHaveBeenCalledTimes(1);
  });

  it('falls back to the passcode when the token is bad', async () => {
    const ctx = useDb(share());
    const r = await postNote({ ...note, unlockToken: 'v1.123.forged', passcode: '1234' });
    expect(r.status).toBe(200);
    expect(commentAdds(ctx)).toHaveLength(1);
  });

  it('refuses a wrong passcode, a forged token, an expired token, another share\'s token and a stale-passcode token', async () => {
    const ctx = useDb(share());
    const expired = mintShareUnlock('s1', 'h:1234', Date.now() - SHARE_UNLOCK_TTL_MS - 1000);
    const proofs = [
      { passcode: '9999' },
      { unlockToken: 'v1.99999999999999.forged' },
      { unlockToken: expired },
      { unlockToken: mintShareUnlock('other', 'h:1234') },
      { unlockToken: mintShareUnlock('s1', 'h:0000') },
    ];
    for (const proof of proofs) {
      const r = await postNote({ ...note, ...proof });
      expect(r.status).toBe(401);
    }
    expect(commentAdds(ctx)).toHaveLength(0);
    expect(rateWrites(ctx)).toHaveLength(0);
    expect(mocks.createAssessment).not.toHaveBeenCalled();
  });

  it('refuses even when the test-only reCAPTCHA skip is set', async () => {
    const ctx = useDb(share());
    const r = await postNote({ ...note, skipRecaptchaForTest: true });
    expect(r.status).toBe(401);
    expect(commentAdds(ctx)).toHaveLength(0);
  });

  it('keeps an open share working with no proof at all', async () => {
    const ctx = useDb(share({ passcodeHash: null }));
    const r = await postNote(note);
    expect(r.status).toBe(200);
    expect(commentAdds(ctx)).toHaveLength(1);
    expect(mocks.argonVerify).not.toHaveBeenCalled();
  });

  it('keeps the revoked, comments-off and reCAPTCHA refusals ahead of or beside the proof', async () => {
    const token = mintShareUnlock('s1', 'h:1234');
    useDb(share({ revoked: true }));
    expect((await postNote({ ...note, unlockToken: token })).status).toBe(403);
    useDb(share({ allowGuestComments: false }));
    expect((await postNote({ ...note, unlockToken: token })).status).toBe(403);
    const ctx = useDb(share());
    mocks.createAssessment.mockResolvedValue([{ tokenProperties: { valid: false, invalidReason: 'MALFORMED' } }]);
    expect((await postNote({ ...note, unlockToken: token })).status).toBe(403);
    expect(commentAdds(ctx)).toHaveLength(0);
  });

  it('a token from getShareLink is accepted by addGuestKinTaleComment', async () => {
    const ctx = useDb(share());
    const unlocked = await getShare({ method: 'POST', body: { passcode: '1234' } });
    const r = await postNote({ ...note, unlockToken: unlocked.body.unlockToken });
    expect(r.status).toBe(200);
    expect(commentAdds(ctx)).toHaveLength(1);
  });
});
