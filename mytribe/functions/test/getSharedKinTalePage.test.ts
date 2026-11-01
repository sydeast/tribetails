import { describe, it, expect, vi, beforeEach } from 'vitest';

const docGet = vi.fn();
const docUpdate = vi.fn();

/** #624: the comment thread read. Empty unless a test says otherwise. */
const commentsGet = vi.fn();
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: () => ({
    doc: () => ({ get: docGet, update: docUpdate }),
    collection: () => ({ orderBy: () => ({ limit: () => ({ get: commentsGet }) }) }),
  }),
}));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn() }));
vi.mock('argon2', () => ({ default: { verify: async (h: string, p: string) => h === `h:${p}` } }));

beforeEach(() => {
  docGet.mockReset();
  docUpdate.mockReset();
  commentsGet.mockReset();
  commentsGet.mockResolvedValue({ docs: [] });
});

/** A stored comment document, as `addGuestKinTaleComment` writes one. */
function commentDoc(data: Record<string, unknown>) {
  return { data: () => data };
}

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
  reqShape: import('../src/share/getSharedKinTalePage').MinimalReq,
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
      // #1278: the key rides on ONE data- attribute, and the external script
      // reads that one value for both the enterprise.js render= URL and the
      // execute() call, so the two can never drift apart.
      expect(captured.body).toContain(`data-recaptcha-site-key="${siteKey}"`);
      expect(captured.body.split(siteKey)).toHaveLength(2);
      const { GUEST_COMMENT_SCRIPT } = await import('../src/share/getSharedKinTalePage');
      expect(GUEST_COMMENT_SCRIPT).toContain("getAttribute('data-recaptcha-site-key')");
      expect(GUEST_COMMENT_SCRIPT).toContain("enterprise.js?render=' + encodeURIComponent(siteKey)");
      expect(GUEST_COMMENT_SCRIPT).toContain('.execute(siteKey');
      expect(captured.body).toContain('<script src="/share/_assets/guest-comment.js" defer></script>');
      expect(captured.body).toContain('id="guest-comment-form" method="post"');
    });
    it('omits the whole comment section when the share has guest comments off', async () => {
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({
          revoked: false,
          expiresAt: futureExpiry,
          passcodeHash: null,
          tribeId: 'f1',
          sourceKinTaleId: 'tale-1',
          allowGuestComments: false,
          scrubbedPayload: { authorDisplayName: 'Auntie', body: 'hi', photos: [] },
        }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-6' }, res);
      // ISSUE #625: the callable 403s this share, so offering the form asked a
      // guest to type a note that could only ever be refused on submit.
      expect(captured.status).toBe(200);
      expect(captured.body).not.toContain('id="guest-comment-form"');
      expect(captured.body).not.toContain('Leave a Note for the Family');
      expect(captured.body).not.toContain('guest-comment.js');
      expect(captured.body).not.toContain('data-recaptcha-site-key');
      // The tale itself still renders in full.
      expect(captured.body).toContain('A KinTale from Auntie');
      expect(captured.body).toContain('hi');
    });
    it('renders the thread above the form, escaping every stranger-written value', async () => {
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
      commentsGet.mockResolvedValue({
        docs: [
          commentDoc({
            authorRole: 'guest',
            guestName: '<img src=x onerror=alert(1)>',
            body: 'What a <b>sweet</b> pup',
            guestEmailHash: 'ab12cd34',
            createdAtMs: 1_780_000_000_000,
          }),
          commentDoc({ authorRole: 'kinfolk', authorUid: 'uid-abc', body: 'Thank you!' }),
        ],
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-8' }, res);
      expect(captured.body).toContain('Notes for the Family');
      // Escaped, never live markup, and never the raw attacker string.
      expect(captured.body).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(captured.body).not.toContain('<img src=x onerror=alert(1)>');
      expect(captured.body).toContain('What a &lt;b&gt;sweet&lt;/b&gt; pup');
      // A household member is the family, never a name and never a uid.
      expect(captured.body).toContain('The family');
      expect(captured.body).not.toContain('uid-abc');
      // The email hash is a stable cross-tale identifier. It never ships.
      expect(captured.body).not.toContain('ab12cd34');
      // Thread precedes the form, so a guest who just posted scrolls into it.
      expect(captured.body.indexOf('Notes for the Family')).toBeLessThan(
        captured.body.indexOf('Leave a Note for the Family'),
      );
    });
    it('shows no thread section at all when nobody has commented', async () => {
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
      await callHandler({ method: 'GET', path: '/share-9' }, res);
      // An empty heading over nothing reads as a broken page, so the section is
      // drawn `hidden` (#1278: the script reveals it when the first note lands).
      expect(captured.body).toContain('<section class="glass card noteform" id="guest-notes" hidden>');
      expect(captured.body).toContain('Leave a Note for the Family');
    });
    it('says so out loud when the thread cannot be read, and still renders the tale', async () => {
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
      commentsGet.mockRejectedValue(new Error('firestore unavailable'));
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-10' }, res);
      // A failed read and an empty thread must not look the same: the guest who
      // just posted would read the silent version as their note having vanished.
      expect(captured.status).toBe(200);
      expect(captured.body).toContain('could not be loaded');
      expect(captured.body).toContain('A KinTale from Auntie');
      // The failure is stated, never the underlying error.
      expect(captured.body).not.toContain('firestore unavailable');
    });
    it('reads no thread at all for a share with guest comments off', async () => {
      docGet.mockResolvedValue({
        exists: true,
        ref: { update: docUpdate },
        data: () => ({
          revoked: false,
          expiresAt: futureExpiry,
          passcodeHash: null,
          tribeId: 'f1',
          sourceKinTaleId: 'tale-1',
          allowGuestComments: false,
          scrubbedPayload: { authorDisplayName: 'Auntie', body: 'hi', photos: [] },
        }),
      });
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-11' }, res);
      // No comment surface at all, so the query is work nobody would see.
      expect(commentsGet).not.toHaveBeenCalled();
      expect(captured.body).not.toContain('Notes for the Family');
      expect(captured.body).not.toContain('id="guest-comment-form"');
    });
    it('keeps the form on a share written before allowGuestComments existed', async () => {
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
      await callHandler({ method: 'GET', path: '/share-7' }, res);
      // Absent is not the same as false, and the callable agrees: it refuses
      // only on an explicit `=== false`. An older share keeps accepting notes.
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

    it('renders a POST form and preserves 401 with no passcode supplied', async () => {
      docGet.mockResolvedValue(passcodeDoc());
      const { res, captured } = captureRes();
      await callHandler({ method: 'GET', path: '/share-6', query: {} }, res);

      expect(captured.status).toBe(401);
      // #1280: never GET, so the passcode can never land in the URL.
      expect(captured.body).toContain('<form method="post">');
      expect(captured.body).not.toMatch(/method="get"/i);
      expect(captured.body).toContain('name="passcode"');
      expect(captured.body).not.toContain("didn't work");
    });

    it('preserves 401 and shows an inline error with a wrong passcode POSTed', async () => {
      docGet.mockResolvedValue(passcodeDoc());
      const { res, captured } = captureRes();
      await callHandler({ method: 'POST', path: '/share/share-6', body: { intent: 'unlock', passcode: 'wrong' } }, res);

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
