import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #957: the operator's email frame. The schema, the fail-safe read, the three
 * owner-only callables and the audit entry. Send routes are in
 * `emailFrameSendRoutes.test.ts`.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEvent: vi.fn(), writeAuditEntry: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntry }));
vi.mock('../src/lib/sentry', () => ({ captureFunctionError: vi.fn().mockReturnValue('s1'), initSentry: () => {} }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

import {
  DEFAULT_EMAIL_FRAME,
  EMAIL_FRAME_FIELDS,
  parseStoredFrame,
  resolveEmailFrame,
} from '../src/lib/emailFrameConfig';
import { frameHtml, sendPartsFor } from '../src/lib/emailFrame';
import { loadEmailFrame } from '../src/lib/emailFrameStore';
import {
  getEmailFrameHandler,
  saveEmailFrameHandler,
  previewEmailFrameHandler,
} from '../src/admin/emailFrameSettings';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';

const PATH = 'business_settings/email_frame';
const LOGO = 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/logo.png';

let ctx: ReturnType<typeof buildDbMock>;
function setup(docs: Record<string, Record<string, unknown>> = {}) {
  ctx = buildDbMock({ writeThrough: true, docs });
  mocks.dbFn.mockReturnValue(ctx.db);
}

const owner = (data: unknown) => ({ data, auth: { uid: 'owner-1', token: { admin: true } } }) as never;

function lastWrite(): Record<string, unknown> {
  const w = ctx.writes.filter((x: { path: string }) => x.path === PATH).at(-1) as { data: Record<string, unknown> } | undefined;
  if (!w) throw new Error('no write to the frame doc');
  return w.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails');
  vi.stubEnv('AUNTIE_OPERATOR_UIDS', '');
  mocks.writeAuditEntry.mockResolvedValue('audit-1');
  setup();
});
afterEach(() => vi.unstubAllEnvs());

describe('the default frame', () => {
  // The frame exactly as it was before it was editable (pre-#957
  // `FRAME_STYLE` and `FOOTER`). With nothing stored, every email must be
  // byte-identical to what it was.
  const OLD_STYLE = `
        body { background-color: #fbfbf9; color: #11131f; font-family: 'Segoe UI', Tahoma, sans-serif; line-height: 1.6; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 20px auto; background: #ffffff; border-top: 8px solid #df8431; border-bottom: 4px solid #11131f; }
        .header { padding: 30px 40px 10px 40px; }
        .header h2 { color: #11131f; margin: 0; }
        .content { padding: 10px 40px 30px 40px; font-size: 16px; }
        .footer { padding: 20px 40px; background-color: #11131f; color: #fbfbf9; font-size: 12px; text-align: center; }
        .button { display: inline-block; padding: 14px 28px; background: #df8431; color: #ffffff; text-decoration: none; border-radius: 4px; font-weight: bold; margin: 20px 0; }
        blockquote { background-color: #fff5f5; border-left: 4px solid #df8431; padding: 15px 20px; margin: 20px 0; border-radius: 0 4px 4px 0; }`;
  const OLD = [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `    <style>${OLD_STYLE}`,
    '    </style>',
    '</head>',
    '<body>',
    '    <div class="container">',
    '        <div class="header"><h2>Hello</h2></div>',
    '        <div class="content"><p>Body</p></div>',
    `        <div class="footer">Tribe Tails Pet Care. Your Kin's Favorite Auntie.</div>`,
    '    </div>',
    '</body>',
    '</html>',
  ].join('\n');

  it('renders byte-identical to the frame before it was editable', () => {
    expect(frameHtml('Hello', '<p>Body</p>')).toBe(OLD);
    expect(frameHtml('Hello', '<p>Body</p>', resolveEmailFrame({}))).toBe(OLD);
  });
});

describe('a stored frame renders', () => {
  it('puts every color, the header line, the logo and the footer where they belong', () => {
    const f = resolveEmailFrame({
      pageBackground: '#000001',
      cardBackground: '#000002',
      textColor: '#000003',
      headlineColor: '#000004',
      accentColor: '#000005',
      buttonTextColor: '#000006',
      calloutBackground: '#000007',
      footerBackground: '#000008',
      footerTextColor: '#000009',
      headerText: 'Tribe Tails',
      footerText: 'Thanks for trusting us',
      logoUrl: LOGO,
    });
    const html = frameHtml('H', '<p>c</p>', f);
    expect(html).toContain('body { background-color: #000001; color: #000003;');
    expect(html).toContain('background: #000002; border-top: 8px solid #000005; border-bottom: 4px solid #000008;');
    expect(html).toContain('.header h2 { color: #000004;');
    expect(html).toContain('background: #000005; color: #000006;');
    expect(html).toContain('blockquote { background-color: #000007; border-left: 4px solid #000005;');
    expect(html).toContain('.footer { padding: 20px 40px; background-color: #000008; color: #000009;');
    expect(html).toContain(`<img src="${LOGO}" alt="Tribe Tails" width="160"`);
    expect(html).toContain('>Tribe Tails</p><h2>H</h2>');
    expect(html).toContain('<div class="footer">Thanks for trusting us</div>');
  });

  it('escapes markup and braces in the text fields, so neither can become HTML or a merge field', () => {
    // Values that would never pass the save schema, rendered anyway to prove
    // the render itself is safe (defense in depth for a hand-edited document).
    const f = { ...DEFAULT_EMAIL_FRAME, footerText: '<script>x</script> {{link}}', headerText: 'A & B' };
    const html = frameHtml('H', '<p>c</p>', f);
    expect(html).toContain('<div class="footer">&lt;script&gt;x&lt;/script&gt; &#123;&#123;link&#125;&#125;</div>');
    expect(html).toContain('>A &amp; B</p>');
  });

  it('only a visual template is framed; an old-format template keeps its own html', () => {
    const f = resolveEmailFrame({ accentColor: '#123456' });
    expect(sendPartsFor({ subject: 's', body: 'b', html: '<p>own</p>' }, f).htmlTemplate).toBe('<p>own</p>');
  });
});

describe('the schema', () => {
  const bad: [string, unknown][] = [
    ['accentColor', 'red'],
    ['accentColor', '#fff'],
    ['accentColor', '#12345g'],
    ['accentColor', '#123456; } body { display: none'],
    ['footerText', 'x'.repeat(301)],
    ['headerText', 'x'.repeat(81)],
    ['footerText', 'line one\nline two'],
    ['footerText', 'Hi {{displayName}}'],
    ['headerText', 'close }} this'],
    ['logoUrl', 'https://evil.example.com/logo.png'],
    ['logoUrl', 'http://res.cloudinary.com/tribetails/image/upload/a.png'],
    ['logoUrl', 'https://res.cloudinary.com/tribetails/image/upload/a.png" onerror="x'],
    ['footerText', 42],
  ];
  for (const [field, value] of bad) {
    it(`drops a stored ${field} of ${JSON.stringify(value).slice(0, 40)}`, () => {
      const { stored, dropped } = parseStoredFrame({ [field]: value });
      expect(stored).toEqual({});
      expect(dropped).toEqual([field]);
    });
  }

  it('keeps good values, lowercases colors, trims text and ignores non-frame keys', () => {
    const { stored, dropped } = parseStoredFrame({
      accentColor: '#ABCDEF',
      footerText: '  Hi there  ',
      logoUrl: LOGO,
      updatedAt: '2026-09-28T00:00:00.000Z',
      somethingElse: 1,
    });
    expect(dropped).toEqual([]);
    expect(stored).toEqual({ accentColor: '#abcdef', footerText: 'Hi there', logoUrl: LOGO });
  });

  it('treats a blank text field as the default, not as a value', () => {
    expect(parseStoredFrame({ footerText: '   ' })).toEqual({ stored: {}, dropped: [] });
  });
});

describe('loadEmailFrame (the send-time read)', () => {
  it('returns the default frame when nothing is stored', async () => {
    await expect(loadEmailFrame('test')).resolves.toEqual(DEFAULT_EMAIL_FRAME);
  });

  it('returns the stored fields over the defaults', async () => {
    setup({ [PATH]: { accentColor: '#123456', footerText: 'Bye' } });
    await expect(loadEmailFrame('test')).resolves.toEqual({ ...DEFAULT_EMAIL_FRAME, accentColor: '#123456', footerText: 'Bye' });
  });

  it('falls back to the default frame, with a log line, when the read fails', async () => {
    mocks.dbFn.mockReturnValue({
      doc: () => ({ get: async () => { throw new Error('UNAVAILABLE'); } }),
    });
    await expect(loadEmailFrame('emailChannel')).resolves.toEqual(DEFAULT_EMAIL_FRAME);
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warn', function: 'emailChannel', event: 'email.frame.read_failed', errorMessage: 'UNAVAILABLE' }),
    );
  });

  it('falls back field by field, with a log line, when a stored value is bad', async () => {
    setup({ [PATH]: { accentColor: 'red; } body {', footerText: 'Kept' } });
    const frame = await loadEmailFrame('test');
    expect(frame.accentColor).toBe(DEFAULT_EMAIL_FRAME.accentColor);
    expect(frame.footerText).toBe('Kept');
    expect(mocks.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'email.frame.field_dropped', extra: expect.objectContaining({ fields: ['accentColor'] }) }),
    );
  });
});

describe('getEmailFrame', () => {
  it('returns the stored fields and the defaults separately', async () => {
    setup({ [PATH]: { accentColor: '#123456', updatedAt: '2026-09-28T01:00:00.000Z', updatedBy: 'owner-1' } });
    const res = await getEmailFrameHandler(owner({}));
    expect(res.stored).toEqual({ accentColor: '#123456' });
    expect(res.defaults).toEqual(DEFAULT_EMAIL_FRAME);
    expect(res.updatedAt).toBe('2026-09-28T01:00:00.000Z');
    expect(res.updatedBy).toBe('owner-1');
  });

  it('returns nothing stored, and every default, before the first save', async () => {
    const res = await getEmailFrameHandler(owner({}));
    expect(res).toEqual({ stored: {}, defaults: DEFAULT_EMAIL_FRAME, updatedAt: null, updatedBy: null });
  });
});

describe('saveEmailFrame', () => {
  it('writes the change, keeps fields the request did not name, and audits', async () => {
    setup({ [PATH]: { footerText: 'Old footer', cardBackground: '#eeeeee' } });
    const res = await saveEmailFrameHandler(owner({ changes: { accentColor: '#ABCDEF', logoUrl: LOGO } }));
    expect(res.stored).toEqual({ footerText: 'Old footer', cardBackground: '#eeeeee', accentColor: '#abcdef', logoUrl: LOGO });
    expect(lastWrite()).toMatchObject({ footerText: 'Old footer', cardBackground: '#eeeeee', accentColor: '#abcdef', logoUrl: LOGO, updatedBy: 'owner-1' });
    expect(mocks.writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: AUDIT_EVENTS.EMAIL_FRAME_UPDATED,
        actorUid: 'owner-1',
        payload: { resetAll: false, fields: { accentColor: '#abcdef', logoUrl: LOGO } },
      }),
    );
  });

  it('null or blank resets that one field to its default', async () => {
    setup({ [PATH]: { footerText: 'Old footer', accentColor: '#123456', headerText: 'Hi' } });
    const res = await saveEmailFrameHandler(owner({ changes: { footerText: null, headerText: '  ' } }));
    expect(res.stored).toEqual({ accentColor: '#123456' });
    expect(lastWrite()).not.toHaveProperty('footerText');
    expect(lastWrite()).not.toHaveProperty('headerText');
    expect(mocks.writeAuditEntry.mock.calls[0]![0].payload).toEqual({ resetAll: false, fields: { footerText: null, headerText: null } });
  });

  it('resetAll removes every frame field', async () => {
    setup({ [PATH]: { footerText: 'Old footer', accentColor: '#123456' } });
    const res = await saveEmailFrameHandler(owner({ resetAll: true }));
    expect(res.stored).toEqual({});
    const written = lastWrite();
    for (const f of EMAIL_FRAME_FIELDS) expect(written).not.toHaveProperty(f);
    expect(mocks.writeAuditEntry.mock.calls[0]![0].payload).toEqual({ resetAll: true, fields: {} });
  });

  const refused: [string, unknown][] = [
    ['a bad color', { changes: { accentColor: 'orange' } }],
    ['a merge field in the footer', { changes: { footerText: 'Hi {{displayName}}' } }],
    ['an unknown field', { changes: { fontFamily: 'Comic Sans' } }],
    ['a logo on another host', { changes: { logoUrl: 'https://evil.example.com/a.png' } }],
    [
      'a logo outside the business folder',
      { changes: { logoUrl: 'https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/kinfolks/kf1/a.png' } },
    ],
    ['a logo on another Cloudinary account', { changes: { logoUrl: 'https://res.cloudinary.com/other/image/upload/tribetails/business/business_settings/a.png' } }],
    ['an empty save', {}],
    ['a reset and a change together', { resetAll: true, changes: { accentColor: '#123456' } }],
    ['an unknown top-level key', { changes: { accentColor: '#123456' }, extra: 1 }],
  ];
  for (const [label, data] of refused) {
    it(`refuses ${label}, and writes and audits nothing`, async () => {
      await expect(saveEmailFrameHandler(owner(data))).rejects.toMatchObject({ code: 'invalid-argument' });
      expect(ctx.writes.filter((w: { path: string }) => w.path === PATH)).toHaveLength(0);
      expect(mocks.writeAuditEntry).not.toHaveBeenCalled();
    });
  }

  it('refuses a logo when the server has no Cloudinary cloud name', async () => {
    vi.stubEnv('CLOUDINARY_CLOUD_NAME', '');
    await expect(saveEmailFrameHandler(owner({ changes: { logoUrl: LOGO } }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});

describe('previewEmailFrame', () => {
  it('renders the sample through the real frame with the draft values', async () => {
    const res = await previewEmailFrameHandler(owner({ frame: { accentColor: '#123456', footerText: 'Draft footer' } }));
    expect(res.html).toContain('border-top: 8px solid #123456');
    expect(res.html).toContain('<div class="footer">Draft footer</div>');
    expect(res.html).toContain('class="button"');
    expect(res.html).toContain('<blockquote>');
    expect(res.subject).toBeTruthy();
    expect(res.text).toContain('View the visit: https://kinfolk.tribetails.com/sample');
  });

  it('renders the default frame for an empty draft, and writes nothing', async () => {
    const res = await previewEmailFrameHandler(owner({ frame: {} }));
    expect(res.html).toContain(`<div class="footer">${DEFAULT_EMAIL_FRAME.footerText}</div>`);
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a draft the save would refuse', async () => {
    await expect(previewEmailFrameHandler(owner({ frame: { accentColor: 'red' } }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });
});

describe('owner only', () => {
  const NAMES = ['getEmailFrame', 'saveEmailFrame', 'previewEmailFrame'] as const;
  const handlers = {
    getEmailFrame: getEmailFrameHandler,
    saveEmailFrame: saveEmailFrameHandler,
    previewEmailFrame: previewEmailFrameHandler,
  };

  it('none of the three is on the Auntie allowlist', () => {
    for (const n of NAMES) expect(AUNTIE_ALLOWED_CALLABLES.has(n)).toBe(false);
  });

  for (const name of NAMES) {
    it(`${name} refuses an Auntie and a kinfolk, and lets the owner in`, async () => {
      const wrapped = wrapAdminCallable(name, handlers[name] as never) as (req: unknown) => Promise<unknown>;
      const data = name === 'saveEmailFrame' ? { changes: { accentColor: '#123456' } } : name === 'previewEmailFrame' ? { frame: {} } : {};
      await expect(wrapped({ data, auth: { uid: 'auntie-1', token: { staffRole: 'auntie' } }, rawRequest: { headers: {} } })).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(wrapped({ data, auth: { uid: 'kin-1', token: {} }, rawRequest: { headers: {} } })).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(wrapped({ data, auth: { uid: 'owner-1', token: { admin: true } }, rawRequest: { headers: {} } })).resolves.toBeTruthy();
    });
  }
});
