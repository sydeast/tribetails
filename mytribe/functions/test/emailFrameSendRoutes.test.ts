import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #957: every route that sends a visual email renders it in the operator's
 * stored frame, and the template editor's preview does too. Real frame, real
 * renderer, real transport call; only the network and Firestore are faked.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { sendFromTemplate } from '../src/lib/sendFromTemplate';
import { sendPrimaryInviteEmails } from '../src/lib/inviteEmails';
import { sendEmailChannel } from '../src/notifications/senders/emailChannel';
import { previewEmailTemplateHandler } from '../src/admin/previewEmailTemplate';
import type { NotificationDef } from '../src/notifications/types';

const FRAME_PATH = 'business_settings/email_frame';
const STORED_FRAME = { accentColor: '#123456', footerText: 'Stored footer line' };
const VISUAL = { subject: 'Hi', format: 'visual' as const, headline: 'Head', content: '<p>Hello</p>' };

function def(): NotificationDef {
  return {
    key: 'k',
    label: 'Test',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['email'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { email: 'k' },
    description: 'test',
  };
}

function sentHtml(i = -1): string {
  return JSON.parse(mocks.fetch.mock.calls.at(i)![1].body).html_body;
}

function expectStoredFrame(html: string) {
  expect(html).toContain('border-top: 8px solid #123456');
  expect(html).toContain('<div class="footer">Stored footer line</div>');
}

let ctx: ReturnType<typeof buildDbMock>;
function setup(docs: Record<string, Record<string, unknown>>) {
  ctx = buildDbMock({ writeThrough: true, docs });
  mocks.dbFn.mockReturnValue(ctx.db);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SMTP2GO_API_KEY', 'k');
  vi.stubEnv('EMAIL_FROM', 'auntie@tribetails.com');
  vi.stubEnv('SEND_SUPPRESS', '');
  vi.stubEnv('CLOUDINARY_CLOUD_NAME', 'tribetails');
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: { succeeded: 1, email_id: 'e1' } }) });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllEnvs());

describe('the stored frame reaches every send route', () => {
  it('sendFromTemplate (invites, recovery)', async () => {
    setup({ 'emailTemplates/k': VISUAL, [FRAME_PATH]: STORED_FRAME });
    await sendFromTemplate('k', 'pat@x.test', {});
    expectStoredFrame(sentHtml());
  });

  it('the notification email channel', async () => {
    setup({ 'emailTemplates/k': VISUAL, 'clients/u1': { email: 'pat@x.test' }, [FRAME_PATH]: STORED_FRAME });
    await sendEmailChannel({ def: def(), recipientUid: 'u1', data: {} });
    expectStoredFrame(sentHtml());
  });

  it('the invite set reads the frame once for all three emails', async () => {
    vi.stubEnv('PORTAL_BASE_URL', 'https://kinfolk.tribetails.com');
    setup({
      'emailTemplates/invite.secondary': VISUAL,
      'emailTemplates/invite.auntie-notify': VISUAL,
      'emailTemplates/invite.primary-receipt': VISUAL,
      [FRAME_PATH]: STORED_FRAME,
    });
    await sendPrimaryInviteEmails({
      inviteId: 'inv1',
      invitedEmail: 'sec@x.test',
      claimBaseUrl: 'https://kinfolk.tribetails.com/claim',
      authorName: 'Pat',
      secondaryLabel: 'Partner',
      tribeName: 'Doe',
      expiresInDays: 7,
      proposedPermissions: {},
      auntieNotify: { email: 'owner@x.test', reviewBaseUrl: 'https://admin.tribetails.com' },
      primaryEmail: 'pat@x.test',
    } as never);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    for (const i of [0, 1, 2]) expectStoredFrame(sentHtml(i));
    const frameReads = ctx.db.doc(FRAME_PATH).get as unknown as { mock: { calls: unknown[] } };
    expect(frameReads.mock.calls).toHaveLength(1);
  });

  it('the template editor preview', async () => {
    setup({ [FRAME_PATH]: STORED_FRAME });
    const res = await previewEmailTemplateHandler({
      data: { subject: 'S', headline: 'H', content: '<p>c</p>' },
      auth: { uid: 'owner-1', token: { admin: true } },
    } as never);
    expectStoredFrame(res.html);
  });

  it('still sends, in the default frame, when the frame read fails', async () => {
    const base = buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': VISUAL } }).db;
    mocks.dbFn.mockReturnValue({
      ...base,
      doc: (path: string) =>
        path === FRAME_PATH ? { get: async () => { throw new Error('UNAVAILABLE'); } } : base.doc(path),
      collection: base.collection,
    });
    await sendFromTemplate('k', 'pat@x.test', {});
    const html = sentHtml();
    expect(html).toContain('border-top: 8px solid #df8431');
    expect(html).toContain("<div class=\"footer\">Tribe Tails Pet Care. Your Kin's Favorite Auntie.</div>");
  });
});
