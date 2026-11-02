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
const SETTINGS_PATH = 'business_settings/business_settings';
const STORED_FRAME = { accentColor: '#123456', footerText: 'Stored footer line' };
/**
 * #1399: the settings the footer is composed from. The name carries a brace
 * so every route proves, through the real Handlebars render, that a business
 * fact lands as text and never as a merge field.
 */
const SETTINGS = {
  businessName: 'Test {Pets} Business',
  businessPhone: '+15125550142',
  businessHours: { Monday: '08:00-18:00', Saturday: '09:00-13:00' },
  privacyPolicyUrl: 'https://tribetails.com/privacy',
};
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
  // The composed block from settings, then the operator's extra line. The
  // brace reaches the inbox as an entity, so Handlebars never saw a merge field.
  expect(html).toContain('<strong>Test &#123;Pets&#125; Business</strong>');
  expect(html).toContain('Hours: Monday 8:00 AM to 6:00 PM · Tuesday Closed · Wednesday Closed · Thursday Closed · Friday Closed · Saturday 9:00 AM to 1:00 PM · Sunday Closed');
  expect(html).toContain('Phone: (512) 555-0142');
  expect(html).toContain('<a href="https://tribetails.com/privacy"');
  expect(html).toContain('<div style="margin: 0 0 4px 0;">Stored footer line</div></div>');
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
    setup({ 'emailTemplates/k': VISUAL, [FRAME_PATH]: STORED_FRAME, [SETTINGS_PATH]: SETTINGS });
    await sendFromTemplate('k', 'pat@tribetails.com', {});
    expectStoredFrame(sentHtml());
  });

  it('the notification email channel', async () => {
    setup({
      'emailTemplates/k': VISUAL,
      'clients/u1': { email: 'pat@tribetails.com' },
      [FRAME_PATH]: STORED_FRAME,
      [SETTINGS_PATH]: SETTINGS,
    });
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
      [SETTINGS_PATH]: SETTINGS,
    });
    await sendPrimaryInviteEmails({
      inviteId: 'inv1',
      invitedEmail: 'sec@tribetails.com',
      claimBaseUrl: 'https://kinfolk.tribetails.com/claim',
      authorName: 'Pat',
      secondaryLabel: 'Partner',
      tribeName: 'Doe',
      expiresInDays: 7,
      proposedPermissions: {},
      auntieNotify: { email: 'owner@tribetails.com', reviewBaseUrl: 'https://admin.tribetails.com' },
      primaryEmail: 'pat@tribetails.com',
    } as never);
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    for (const i of [0, 1, 2]) expectStoredFrame(sentHtml(i));
    const frameReads = ctx.db.doc(FRAME_PATH).get as unknown as { mock: { calls: unknown[] } };
    expect(frameReads.mock.calls).toHaveLength(1);
    // #1399: and the settings document, for the footer, once as well.
    const settingsReads = ctx.db.doc(SETTINGS_PATH).get as unknown as { mock: { calls: unknown[] } };
    expect(settingsReads.mock.calls).toHaveLength(1);
  });

  it('the template editor preview', async () => {
    setup({ [FRAME_PATH]: STORED_FRAME, [SETTINGS_PATH]: SETTINGS });
    const res = await previewEmailTemplateHandler({
      data: { subject: 'S', headline: 'H', content: '<p>c</p>' },
      auth: { uid: 'owner-1', token: { admin: true } },
    } as never);
    expectStoredFrame(res.html);
  });

  it('still sends, in the default frame with the settings footer, when the frame read fails', async () => {
    const base = buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': VISUAL, [SETTINGS_PATH]: SETTINGS } }).db;
    mocks.dbFn.mockReturnValue({
      ...base,
      doc: (path: string) =>
        path === FRAME_PATH ? { get: async () => { throw new Error('UNAVAILABLE'); } } : base.doc(path),
      collection: base.collection,
    });
    await sendFromTemplate('k', 'pat@tribetails.com', {});
    const html = sentHtml();
    expect(html).toContain('border-top: 8px solid #df8431');
    expect(html).toContain('<strong>Test &#123;Pets&#125; Business</strong>');
    expect(html).toContain('Phone: (512) 555-0142');
    expect(html).not.toContain('Stored footer line');
  });

  it('#1399: a business that never opened the frame editor still sends a complete footer', async () => {
    setup({ 'emailTemplates/k': VISUAL, [SETTINGS_PATH]: SETTINGS });
    await sendFromTemplate('k', 'pat@tribetails.com', {});
    const html = sentHtml();
    expect(html).toContain('<strong>Test &#123;Pets&#125; Business</strong>');
    expect(html).toContain('Hours: Monday 8:00 AM to 6:00 PM');
    expect(html).toContain('Phone: (512) 555-0142');
    expect(html).toContain('<a href="https://tribetails.com/privacy"');
    expect(html).not.toContain('Tribe Tails');
  });

  it('#1399: still sends, with an empty footer block, when the settings read fails too', async () => {
    const base = buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': VISUAL } }).db;
    mocks.dbFn.mockReturnValue({
      ...base,
      doc: (path: string) =>
        path === SETTINGS_PATH ? { get: async () => { throw new Error('UNAVAILABLE'); } } : base.doc(path),
      collection: base.collection,
    });
    await sendFromTemplate('k', 'pat@tribetails.com', {});
    expect(sentHtml()).toContain('<div class="footer"></div>');
  });
});
