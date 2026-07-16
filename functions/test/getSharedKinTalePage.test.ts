import { describe, it, expect, vi, beforeEach } from 'vitest';

const docGet = vi.fn();
const docUpdate = vi.fn();

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({ doc: () => ({ get: docGet, update: docUpdate }) }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('argon2', () => ({ default: { verify: async (h: string, p: string) => h === `h:${p}` } }));

beforeEach(() => {
  docGet.mockReset();
  docUpdate.mockReset();
});

interface CapturedRes {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function captureRes(): {
  res: import('../src/share/getSharedKinTalePage').MinimalRes;
  captured: CapturedRes;
} {
  const captured: CapturedRes = { status: 0, headers: {}, body: '' };
  const res: import('../src/share/getSharedKinTalePage').MinimalRes = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    set(header: string, value: string) {
      captured.headers[header] = value;
      return res;
    },
    send(body: string) {
      captured.body = body;
    },
  };
  return { res, captured };
}

async function callHandler(
  reqShape: { method: string; path: string; query?: Record<string, unknown> },
  res: ReturnType<typeof captureRes>['res'],
) {
  const { getSharedKinTalePageHandler } = await import('../src/share/getSharedKinTalePage');
  await getSharedKinTalePageHandler(reqShape, res);
}

const futureExpiry = { toMillis: () => Date.now() + 1e6 };
const pastExpiry = { toMillis: () => Date.now() - 1e6 };

describe('getSharedKinTalePage', () => {
  describe('Ready state', () => {
    it('emits correct og:title/og:description and og:image only for the https photo', async () => {
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({
          revoked: false,
          expiresAt: futureExpiry,
          passcodeHash: null,
          tribeId: 'f1',
          sourceKinTaleId: 'tale-1',
          scrubbedPayload: {
            authorDisplayName: 'Auntie Maya',
            body: 'A very good walk this morning.',
            photos: ['https://example.com/a.jpg', 'http://insecure.com/b.jpg'],
          },
        }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-1' }, res);

      expect(captured.status).toBe(200);
      expect(captured.headers['Content-Type']).toContain('text/html');
      expect(captured.body).toContain('<meta property="og:title" content="A KinTale from Auntie Maya">');
      expect(captured.body).toContain(
        '<meta property="og:description" content="A very good walk this morning.">',
      );
      expect(captured.body).toContain('<meta property="og:type" content="article">');
      // only the https:// photo may be used as og:image
      expect(captured.body).toContain('<meta property="og:image" content="https://example.com/a.jpg">');
      expect(captured.body).toContain('<meta name="twitter:card" content="summary_large_image">');
      // the insecure photo must never be emitted as a src
      expect(captured.body).not.toContain('http://insecure.com/b.jpg');
    });

    it('omits og:image and uses summary twitter:card when no photo exists', async () => {
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({
          revoked: false,
          expiresAt: futureExpiry,
          passcodeHash: null,
          tribeId: 'f1',
          sourceKinTaleId: 'tale-1',
          scrubbedPayload: { authorDisplayName: 'Auntie Maya', body: 'No photos this time.', photos: [] },
        }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-2' }, res);

      expect(captured.status).toBe(200);
      expect(captured.body).not.toContain('og:image');
      expect(captured.body).toContain('<meta name="twitter:card" content="summary">');
    });

    it('truncates a long body to ~200 chars with an ellipsis suffix in og:description', async () => {
      const longBody = 'x'.repeat(250);
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({
          revoked: false,
          expiresAt: futureExpiry,
          passcodeHash: null,
          tribeId: 'f1',
          sourceKinTaleId: 'tale-1',
          scrubbedPayload: { authorDisplayName: 'Auntie', body: longBody, photos: [] },
        }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-3' }, res);

      const match = captured.body.match(/og:description" content="([^"]*)"/);
      expect(match).not.toBeNull();
      const desc = match![1];
      expect(desc.endsWith('…')).toBe(true);
      expect(desc.length).toBeLessThan(longBody.length);
    });

    it('HTML-escapes authorDisplayName and body so injected markup never appears unescaped', async () => {
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({
          revoked: false,
          expiresAt: futureExpiry,
          passcodeHash: null,
          tribeId: 'f1',
          sourceKinTaleId: 'tale-1',
          scrubbedPayload: {
            authorDisplayName: '<script>alert(1)</script>',
            body: '<img src=x onerror=alert(2)>line one\nline two',
            photos: [],
          },
        }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-4' }, res);

      expect(captured.status).toBe(200);
      // the raw, unescaped payloads must never appear anywhere in the response
      expect(captured.body).not.toContain('<script>alert(1)</script>');
      expect(captured.body).not.toContain('<img src=x onerror=alert(2)>');
      // escaped forms must be present instead
      expect(captured.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(captured.body).toContain('&lt;img src=x onerror=alert(2)&gt;');
      // \n in body is rendered as <br>, not raw HTML injection
      expect(captured.body).toContain('line one<br>line two');
    });

    it('renders the guest-comment form using a single consistent reCAPTCHA site key', async () => {
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({
          revoked: false,
          expiresAt: futureExpiry,
          passcodeHash: null,
          tribeId: 'f1',
          sourceKinTaleId: 'tale-1',
          scrubbedPayload: { authorDisplayName: 'Auntie', body: 'hi', photos: [] },
        }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-5' }, res);

      const siteKey = '6Leix-ksAAAAAFwAl_Ua0n6ZFyPR8PQCZxc2VRIg';
      // declared once as a JS var, then reused by reference for both the
      // enterprise.js render= URL and the execute() call — proves ONE
      // consistent key drives both, rather than two independently-typed keys.
      expect(captured.body).toContain(`"${siteKey}"`);
      expect(captured.body).toContain("recaptcha/enterprise.js?render=' + RECAPTCHA_SITE_KEY");
      expect(captured.body).toContain('.execute(RECAPTCHA_SITE_KEY');
      expect(captured.body).toContain('grecaptcha.enterprise');
      expect(captured.body).toContain('addGuestKinTaleComment');
      expect(captured.body).toContain('id="guest-comment-form"');
    });
  });

  describe('PasscodeGate', () => {
    function passcodeDoc() {
      return {
        exists: true,
        ref: { update: docUpdate },
        data: () => ({
          revoked: false,
          expiresAt: futureExpiry,
          passcodeHash: 'h:1234',
          tribeId: 'f1',
          sourceKinTaleId: 'tale-1',
          scrubbedPayload: { authorDisplayName: 'Auntie', body: 'hi', photos: [] },
        }),
      };
    }

    it('renders a GET form and preserves 401 with no passcode supplied', async () => {
      docGet.mockResolvedValue(passcodeDoc());
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-6', query: {} }, res);

      expect(captured.status).toBe(401);
      expect(captured.body).toContain('<form method="GET">');
      expect(captured.body).toContain('name="passcode"');
      expect(captured.body).not.toContain("didn't work");
    });

    it('preserves 401 and shows an inline error with a wrong passcode', async () => {
      docGet.mockResolvedValue(passcodeDoc());
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-6', query: { passcode: 'wrong' } }, res);

      expect(captured.status).toBe(401);
      expect(captured.body).toContain("didn't work");
    });
  });

  describe('terminal states', () => {
    it('preserves 404 for not-found', async () => {
      docGet.mockResolvedValue({ exists: false });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-nope' }, res);

      expect(captured.status).toBe(404);
      expect(captured.body).toContain('Not found');
      expect(captured.body).toContain('share link');
    });

    it('preserves 410 for revoked', async () => {
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({ revoked: true, expiresAt: futureExpiry, scrubbedPayload: {}, tribeId: 'f1' }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-revoked' }, res);

      expect(captured.status).toBe(410);
      expect(captured.body).toContain('revoked');
    });

    it('preserves 410 for expired', async () => {
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({ revoked: false, expiresAt: pastExpiry, scrubbedPayload: {}, tribeId: 'f1' }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-expired' }, res);

      expect(captured.status).toBe(410);
      expect(captured.body).toContain('expired');
    });
  });
});
