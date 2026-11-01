import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'htmlparser2';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1278 and #1280: the share page under the production CSP, the passcode by
 * POST plus an unlock cookie, and a guest note that actually saves.
 *
 * The older suite (getSharedKinTalePage.test.ts) renders the page without any
 * headers, which is how an inline script the hosting CSP refuses shipped
 * unnoticed. These tests read the real policy out of mytribe/firebase.json.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  argonVerify: vi.fn(async (h: string, p: string) => h === `h:${p}`),
  createAssessment: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('argon2', () => ({ default: { verify: mocks.argonVerify } }));
vi.mock('@google-cloud/recaptcha-enterprise', () => ({
  RecaptchaEnterpriseServiceClient: class {
    createAssessment = mocks.createAssessment;
  },
}));

import {
  getSharedKinTalePageHandler,
  GUEST_SCRIPT_PATH,
  GUEST_COMMENT_SCRIPT,
  SHARE_PAGE_CSP,
  SHARE_FONT_FILES,
  SHARE_FONT_PATH,
  type MinimalReq,
  type MinimalRes,
} from '../src/share/getSharedKinTalePage';
import { SHARE_UNLOCK_TTL_MS } from '../src/lib/shareUnlock';

const futureExpiry = { toMillis: () => Date.now() + 1e7 };

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}
function captureRes(): { res: MinimalRes; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: '' };
  const res: MinimalRes = {
    status(code) {
      captured.status = code;
      return res;
    },
    set(h, v) {
      captured.headers[h] = v;
      return res;
    },
    send(b) {
      captured.body = b;
    },
  };
  return { res, captured };
}
async function call(req: MinimalReq): Promise<Captured> {
  const { res, captured } = captureRes();
  await getSharedKinTalePageHandler(req, res);
  return captured;
}

function share(overrides: Record<string, unknown> = {}) {
  return {
    revoked: false,
    expiresAt: futureExpiry,
    passcodeHash: null,
    tribeId: 'f1',
    sourceKinTaleId: 'tale-1',
    scrubbedPayload: { authorDisplayName: 'Auntie Maya', body: 'Biscuit napped.', photos: [] },
    ...overrides,
  };
}

function useDb(shareDoc: Record<string, unknown>, comments: Array<Record<string, unknown>> = []) {
  const ctx = buildDbMock({
    docs: { 'sharedKinTales/s1': shareDoc },
    queryDocs: { 'kin_care_reports/tale-1/comments': comments.map((data, i) => ({ id: `c${i}`, data })) },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.argonVerify.mockClear();
  mocks.createAssessment.mockReset();
  mocks.createAssessment.mockResolvedValue([
    { tokenProperties: { valid: true, action: 'guest_comment' }, riskAnalysis: { score: 0.9 } },
  ]);
});

// ── CSP evaluation ─────────────────────────────────────────────────────────
function parseCsp(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out.set(name, values);
  }
  return out;
}
function allows(csp: Map<string, string[]>, directive: string, url: string): boolean {
  const sources = csp.get(directive) ?? csp.get('default-src') ?? [];
  if (!/^[a-z]+:/i.test(url)) return sources.includes("'self'");
  if (url.startsWith('data:')) return sources.includes('data:');
  const origin = new URL(url).origin;
  return sources.some((s) => s === origin);
}

/** Every resource a page pulls, plus the things a CSP without 'unsafe-inline' refuses. */
function audit(html: string) {
  const scripts: string[] = [];
  const styles: string[] = [];
  const fontUrls: string[] = [];
  const forms: Array<{ method: string; action: string | undefined }> = [];
  let inlineScripts = 0;
  let inlineHandlers = 0;
  let inScript = false;
  let inStyle = false;
  let scriptText = '';
  let styleText = '';
  const parser = new Parser({
    onopentag(name, attrs) {
      for (const k of Object.keys(attrs)) if (/^on/i.test(k)) inlineHandlers++;
      if (name === 'script') {
        inScript = true;
        scriptText = '';
        if (attrs.src) scripts.push(attrs.src);
      }
      if (name === 'style') {
        inStyle = true;
        styleText = '';
      }
      if (name === 'link' && /stylesheet/i.test(attrs.rel ?? '')) styles.push(attrs.href ?? '');
      if (name === 'form') forms.push({ method: (attrs.method ?? 'get').toLowerCase(), action: attrs.action });
    },
    ontext(t) {
      if (inScript) scriptText += t;
      if (inStyle) styleText += t;
    },
    onclosetag(name) {
      if (name === 'script') {
        inScript = false;
        if (scriptText.trim()) inlineScripts++;
      }
      if (name === 'style') {
        inStyle = false;
        for (const m of styleText.matchAll(/url\(([^)]+)\)/g)) fontUrls.push(m[1].replace(/["']/g, ''));
      }
    },
  });
  parser.write(html);
  parser.end();
  return { scripts, styles, fontUrls, forms, inlineScripts, inlineHandlers };
}

const firebaseJson = JSON.parse(readFileSync(join(__dirname, '..', '..', 'firebase.json'), 'utf8')) as {
  hosting: Array<{ target: string; rewrites: Array<Record<string, unknown>>; headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }> }>;
};
const hostingPolicies = firebaseJson.hosting.map((h) => {
  const csp = h.headers
    .filter((b) => b.source === '**' || b.source.startsWith('/share'))
    .flatMap((b) => b.headers)
    .find((x) => x.key === 'Content-Security-Policy');
  return { target: h.target, policy: csp?.value ?? '' };
});

function expectPageFitsPolicy(html: string, policy: string) {
  const csp = parseCsp(policy);
  const a = audit(html);
  // No inline script and no on*= handler: neither policy has 'unsafe-inline'.
  expect(csp.get('script-src')).not.toContain("'unsafe-inline'");
  expect(a.inlineScripts).toBe(0);
  expect(a.inlineHandlers).toBe(0);
  for (const src of a.scripts) expect(allows(csp, 'script-src', src), `script ${src}`).toBe(true);
  for (const href of a.styles) expect(allows(csp, 'style-src', href), `style ${href}`).toBe(true);
  for (const u of a.fontUrls) expect(allows(csp, 'font-src', u), `font ${u}`).toBe(true);
  // Every form posts to the page itself, never a GET (#1278, #1280).
  for (const f of a.forms) {
    expect(f.method).toBe('post');
    expect(f.action === undefined || allows(csp, 'form-action', f.action)).toBe(true);
  }
  // The script's own fetch and the reCAPTCHA loader it injects.
  expect(allows(csp, 'connect-src', '/share/s1')).toBe(true);
  expect(allows(csp, 'script-src', 'https://www.google.com/recaptcha/enterprise.js')).toBe(true);
  expect(allows(csp, 'script-src', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js')).toBe(true);
  expect(allows(csp, 'frame-src', 'https://www.google.com/recaptcha/api2/anchor')).toBe(true);
  return a;
}

describe('#1278 share page under the production CSP', () => {
  it('finds a CSP for both hosting targets in firebase.json', () => {
    expect(hostingPolicies.map((p) => p.target).sort()).toEqual(['kinfolk_portal', 'mytribe_beta']);
    for (const p of hostingPolicies) expect(p.policy).toContain('script-src');
  });

  it('renders an unlocked tale with the guest form that fits the hosting CSP and its own', async () => {
    useDb(share());
    const page = await call({ method: 'GET', path: '/share/s1' });
    expect(page.status).toBe(200);
    expect(page.body).toContain('id="guest-comment-form"');
    for (const { policy } of hostingPolicies) expectPageFitsPolicy(page.body, policy);
    const a = expectPageFitsPolicy(page.body, SHARE_PAGE_CSP);
    expect(a.scripts).toEqual([GUEST_SCRIPT_PATH]);
    // Fonts are same-origin copies, never Google Fonts.
    expect(page.body).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(a.fontUrls.length).toBeGreaterThan(0);
    for (const u of a.fontUrls) expect(u.startsWith(`${SHARE_FONT_PATH}/`)).toBe(true);
  });

  it('renders the passcode gate under the same policy', async () => {
    useDb(share({ passcodeHash: 'h:1234' }));
    const gate = await call({ method: 'GET', path: '/share/s1' });
    expect(gate.status).toBe(401);
    for (const { policy } of hostingPolicies) expectPageFitsPolicy(gate.body, policy);
    expectPageFitsPolicy(gate.body, SHARE_PAGE_CSP);
  });

  it.each([
    ['ready', share(), 200],
    ['gate', share({ passcodeHash: 'h:1234' }), 401],
    ['revoked', share({ revoked: true }), 410],
  ])('sends its own CSP and a no-store cache header on the %s page', async (_n, doc, status) => {
    useDb(doc);
    const page = await call({ method: 'GET', path: '/share/s1' });
    expect(page.status).toBe(status);
    expect(page.headers['Content-Security-Policy']).toBe(SHARE_PAGE_CSP);
    expect(page.headers['Cache-Control']).toBe('private, no-store');
    expect(page.headers['Vary']).toBe('Cookie');
  });

  it('has no directive looser than the hosting policy it is layered under', () => {
    const mine = parseCsp(SHARE_PAGE_CSP);
    for (const { policy } of hostingPolicies) {
      const host = parseCsp(policy);
      for (const [dir, sources] of mine) {
        const hostSources = host.get(dir) ?? host.get('default-src');
        if (!hostSources || dir === 'frame-ancestors') continue;
        for (const s of sources) expect(hostSources, `${dir} ${s}`).toContain(s);
      }
    }
  });

  it('serves the guest script as same-origin JavaScript', async () => {
    const js = await call({ method: 'GET', path: GUEST_SCRIPT_PATH });
    expect(js.status).toBe(200);
    expect(js.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
    expect(js.body).toBe(GUEST_COMMENT_SCRIPT);
    // It posts to the page's own path, with the reCAPTCHA token, as a form body.
    expect(GUEST_COMMENT_SCRIPT).toContain('fetch(window.location.pathname');
    expect(GUEST_COMMENT_SCRIPT).toContain("data.set('recaptchaToken', token)");
    expect(GUEST_COMMENT_SCRIPT).toContain("action: 'guest_comment'");
    expect(GUEST_COMMENT_SCRIPT).toContain('evt.preventDefault()');
    // Guest words go in with textContent, never innerHTML.
    expect(GUEST_COMMENT_SCRIPT).not.toContain('innerHTML');
    // It parses: a syntax error here is a form that silently GETs again.
    expect(() => new Function(GUEST_COMMENT_SCRIPT)).not.toThrow();
  });

  it('references only font files the web build copies', () => {
    const script = readFileSync(join(__dirname, '..', '..', 'web', 'scripts', 'copy-share-fonts.mjs'), 'utf8');
    expect(SHARE_FONT_FILES.length).toBe(14);
    for (const f of SHARE_FONT_FILES) expect(script, f).toContain(`'${f}'`);
  });

  it('routes POST to /share/** to this function on both hosting targets', () => {
    for (const h of firebaseJson.hosting) {
      const rw = h.rewrites.find((r) => r.source === '/share/**') as { function?: { functionId: string } } | undefined;
      expect(rw?.function?.functionId).toBe('getSharedKinTalePage');
    }
  });
});

describe('#1280 passcode by POST and an unlock cookie', () => {
  function cookieFrom(c: Captured): string {
    const set = c.headers['Set-Cookie'];
    expect(set).toBeDefined();
    return set.split(';')[0];
  }

  it('sets a short-lived HttpOnly, Secure, SameSite cookie and redirects to the clean URL', async () => {
    useDb(share({ passcodeHash: 'h:1234' }));
    const r = await call({ method: 'POST', path: '/share/s1', body: { intent: 'unlock', passcode: '1234' } });
    expect(r.status).toBe(303);
    expect(r.headers['Location']).toBe('/share/s1');
    const set = r.headers['Set-Cookie'];
    expect(set).toMatch(/^__session=v1\.\d+\.[A-Za-z0-9_-]+; /);
    expect(set).toContain('Path=/share/s1');
    expect(set).toContain(`Max-Age=${SHARE_UNLOCK_TTL_MS / 1000}`);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('Secure');
    expect(set).toContain('SameSite=Lax');
    // The passcode itself is never in the cookie or the Location.
    expect(set).not.toContain('1234');
    expect(r.headers['Location']).not.toContain('1234');
  });

  it('unlocks the tale on a later GET that carries only the cookie', async () => {
    useDb(share({ passcodeHash: 'h:1234' }));
    const unlock = await call({ method: 'POST', path: '/share/s1', body: { intent: 'unlock', passcode: '1234' } });
    mocks.argonVerify.mockClear();
    const page = await call({ method: 'GET', path: '/share/s1', cookie: `other=1; ${cookieFrom(unlock)}` });
    expect(page.status).toBe(200);
    expect(page.body).toContain('Biscuit napped.');
    // The cookie check is an HMAC, not another argon2 verify.
    expect(mocks.argonVerify).not.toHaveBeenCalled();
  });

  it('refuses a cookie minted for another share, a tampered one, or one under a changed passcode', async () => {
    useDb(share({ passcodeHash: 'h:1234' }));
    const unlock = await call({ method: 'POST', path: '/share/s1', body: { intent: 'unlock', passcode: '1234' } });
    const cookie = cookieFrom(unlock);

    const tampered = cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await call({ method: 'GET', path: '/share/s1', cookie: tampered })).status).toBe(401);
    expect((await call({ method: 'GET', path: '/share/s1', cookie: '__session=1234' })).status).toBe(401);

    useDb(share({ passcodeHash: 'h:9999' }));
    expect((await call({ method: 'GET', path: '/share/s1', cookie })).status).toBe(401);
  });

  it('refuses an expired cookie', async () => {
    useDb(share({ passcodeHash: 'h:1234' }));
    const unlock = await call({ method: 'POST', path: '/share/s1', body: { intent: 'unlock', passcode: '1234' } });
    const cookie = cookieFrom(unlock);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + SHARE_UNLOCK_TTL_MS + 1000);
    try {
      expect((await call({ method: 'GET', path: '/share/s1', cookie })).status).toBe(401);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('still pays one argon2 verify per passcode guess', async () => {
    useDb(share({ passcodeHash: 'h:1234' }));
    for (const guess of ['0000', '1111', '2222']) {
      const r = await call({ method: 'POST', path: '/share/s1', body: { intent: 'unlock', passcode: guess } });
      expect(r.status).toBe(401);
      expect(r.headers['Set-Cookie']).toBeUndefined();
    }
    expect(mocks.argonVerify).toHaveBeenCalledTimes(3);
  });

  it('turns an old ?passcode= link into a cookie and strips it from the URL', async () => {
    useDb(share({ passcodeHash: 'h:1234' }));
    const r = await call({ method: 'GET', path: '/share/s1', query: { passcode: '1234' } });
    expect(r.status).toBe(303);
    expect(r.headers['Location']).toBe('/share/s1');
    expect(r.headers['Set-Cookie']).toContain('__session=v1.');
  });

  it('strips a wrong ?passcode= from the URL too, without a cookie', async () => {
    useDb(share({ passcodeHash: 'h:1234' }));
    const r = await call({ method: 'GET', path: '/share/s1', query: { passcode: 'nope' } });
    expect(r.status).toBe(303);
    expect(r.headers['Location']).toBe('/share/s1');
    expect(r.headers['Set-Cookie']).toBeUndefined();
  });

  it('strips the old guest form GET fields from the URL without saving anything', async () => {
    const ctx = useDb(share());
    const r = await call({
      method: 'GET',
      path: '/share/s1',
      query: { guestName: 'Ann', guestEmail: 'catch@hanasamku.com', body: 'hi' },
    });
    expect(r.status).toBe(303);
    expect(r.headers['Location']).toBe('/share/s1');
    expect(ctx.adds).toHaveLength(0);
  });

  it('sets no cookie for a share with no passcode', async () => {
    useDb(share());
    const r = await call({ method: 'POST', path: '/share/s1', body: { intent: 'unlock', passcode: 'x' } });
    expect(r.status).toBe(303);
    expect(r.headers['Set-Cookie']).toBeUndefined();
  });
});

describe('#1278 guest note saves', () => {
  const note = {
    intent: 'comment',
    guestName: 'Ann',
    guestEmail: 'catch@hanasamku.com',
    body: 'What a good boy.',
    recaptchaToken: 'tok',
  };

  it('saves the note through reCAPTCHA to the comments collection, and the thread shows it', async () => {
    const ctx = useDb(share());
    const r = await call({ method: 'POST', path: '/share/s1', body: note, accept: 'application/json' });
    expect(r.status).toBe(200);
    expect(r.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(r.body).commentId).toBeTruthy();
    expect(mocks.createAssessment).toHaveBeenCalledTimes(1);
    expect(mocks.createAssessment.mock.calls[0][0].assessment.event.token).toBe('tok');

    const add = ctx.adds.find((a) => a.collection === 'kin_care_reports/tale-1/comments');
    expect(add?.data).toMatchObject({ authorRole: 'guest', guestName: 'Ann', body: 'What a good boy.', authorUid: null });
    // The raw address is never stored.
    expect(JSON.stringify(add?.data)).not.toContain('catch@hanasamku.com');

    // The stored row, read back, appears under "Notes for the Family".
    useDb(share(), [add!.data]);
    const page = await call({ method: 'GET', path: '/share/s1' });
    expect(page.body).toContain('<section class="glass card noteform" id="guest-notes">');
    expect(page.body).toContain('<span class="notename">Ann</span>');
    expect(page.body).toContain('What a good boy.');
  });

  it('never forwards skipRecaptchaForTest from a browser', async () => {
    const ctx = useDb(share());
    mocks.createAssessment.mockResolvedValue([{ tokenProperties: { valid: false, invalidReason: 'MALFORMED' } }]);
    const r = await call({
      method: 'POST',
      path: '/share/s1',
      body: { ...note, skipRecaptchaForTest: true },
      accept: 'application/json',
    });
    expect(r.status).toBe(403);
    expect(ctx.adds).toHaveLength(0);
  });

  it('refuses a note on a passcode-protected tale from a reader who has not unlocked it', async () => {
    const ctx = useDb(share({ passcodeHash: 'h:1234' }));
    const r = await call({ method: 'POST', path: '/share/s1', body: note, accept: 'application/json' });
    expect(r.status).toBe(401);
    expect(ctx.adds).toHaveLength(0);
    expect(mocks.createAssessment).not.toHaveBeenCalled();
  });

  it('accepts a note on a passcode-protected tale with the unlock cookie', async () => {
    const ctx = useDb(share({ passcodeHash: 'h:1234' }));
    const unlock = await call({ method: 'POST', path: '/share/s1', body: { intent: 'unlock', passcode: '1234' } });
    const cookie = unlock.headers['Set-Cookie'].split(';')[0];
    const r = await call({ method: 'POST', path: '/share/s1', body: note, accept: 'application/json', cookie });
    expect(r.status).toBe(200);
    expect(ctx.adds.some((a) => a.collection === 'kin_care_reports/tale-1/comments')).toBe(true);
  });

  it('keeps the comments-off refusal', async () => {
    const ctx = useDb(share({ allowGuestComments: false }));
    const r = await call({ method: 'POST', path: '/share/s1', body: note, accept: 'application/json' });
    expect(r.status).toBe(403);
    expect(ctx.adds).toHaveLength(0);
  });

  it('answers a no-script form post with the page and a reason, never a redirect carrying the fields', async () => {
    const ctx = useDb(share());
    const { recaptchaToken: _t, ...noToken } = note;
    const r = await call({ method: 'POST', path: '/share/s1', body: noToken });
    expect(r.status).toBe(400);
    expect(r.headers['Location']).toBeUndefined();
    expect(r.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(r.body).toContain('needs JavaScript');
    expect(ctx.adds).toHaveLength(0);
  });

  it('gives a guest the short error, not the validation dump', async () => {
    useDb(share());
    const r = await call({
      method: 'POST',
      path: '/share/s1',
      body: { ...note, guestEmail: 'not-an-email' },
      accept: 'application/json',
    });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: 'Invalid arguments.' });
  });
});
