import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1351. `skipRecaptchaForTest` is a unit-test switch on the handler. The
 * deployed `addGuestKinTaleComment` function must never honor it from a
 * request body, or anyone could post a guest note with no reCAPTCHA.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), createAssessment: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('@google-cloud/recaptcha-enterprise', () => ({
  RecaptchaEnterpriseServiceClient: class {
    createAssessment = mocks.createAssessment;
  },
}));

import { addGuestKinTaleComment, publicRequestBody } from '../src/public/addGuestKinTaleComment';

const note = {
  shareToken: 's1',
  taleId: 'tale-1',
  guestName: 'Ann',
  guestEmail: 'catch@hanasamku.com',
  body: 'What a good boy.',
};

function useDb() {
  const ctx = buildDbMock({
    docs: {
      'sharedKinTales/s1': {
        revoked: false,
        expiresAt: { toMillis: () => Date.now() + 1e7 },
        tribeId: 'f1',
        sourceKinTaleId: 'tale-1',
      },
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

/** Drives the exported onRequest function the way the Functions runtime does. */
async function callDeployed(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const out = { status: 200, json: {} as Record<string, unknown> };
  const headers: Record<string, string> = {};
  await new Promise<void>((resolve, reject) => {
    const req = {
      method: 'POST',
      url: '/',
      headers: { 'content-type': 'application/json' },
      body,
      get: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : undefined),
      header: (h: string) => (h.toLowerCase() === 'content-type' ? 'application/json' : undefined),
    };
    const res = {
      statusCode: 200,
      status(code: number) {
        out.status = code;
        this.statusCode = code;
        return this;
      },
      json(payload: Record<string, unknown>) {
        out.json = payload;
        resolve();
        return this;
      },
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
      },
      getHeader(k: string) {
        return headers[k.toLowerCase()];
      },
      set(k: string, v: string) {
        headers[k.toLowerCase()] = v;
        return this;
      },
      end() {
        resolve();
      },
      on() {
        return this;
      },
    };
    Promise.resolve(
      (addGuestKinTaleComment as unknown as (q: unknown, r: unknown) => unknown)(req, res),
    ).catch(reject);
  });
  return out;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.createAssessment.mockReset();
});

describe('#1351 the public function never honors skipRecaptchaForTest', () => {
  it('drops the flag and keeps every other field', () => {
    expect(publicRequestBody({ ...note, skipRecaptchaForTest: true })).toEqual(note);
    expect(publicRequestBody(undefined)).toBeUndefined();
    expect(publicRequestBody('x')).toBe('x');
  });

  it('a direct request carrying the flag and no token is refused, nothing written', async () => {
    const ctx = useDb();
    const r = await callDeployed({ ...note, skipRecaptchaForTest: true });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('reCAPTCHA token required.');
    expect(ctx.adds).toHaveLength(0);
  });

  it('a direct request carrying the flag still has its token verified', async () => {
    const ctx = useDb();
    mocks.createAssessment.mockResolvedValue([{ tokenProperties: { valid: false, invalidReason: 'MALFORMED' } }]);
    const r = await callDeployed({ ...note, recaptchaToken: 'bad', skipRecaptchaForTest: true });
    expect(r.status).toBe(403);
    expect(mocks.createAssessment).toHaveBeenCalledTimes(1);
    expect(ctx.adds).toHaveLength(0);
  });

  it('a valid token still posts through the deployed function', async () => {
    const ctx = useDb();
    mocks.createAssessment.mockResolvedValue([
      { tokenProperties: { valid: true, action: 'guest_comment' }, riskAnalysis: { score: 0.9 } },
    ]);
    const r = await callDeployed({ ...note, recaptchaToken: 'ok' });
    expect(r.status).toBe(200);
    expect(ctx.adds.some((a) => a.collection === 'kin_care_reports/tale-1/comments')).toBe(true);
  });
});
