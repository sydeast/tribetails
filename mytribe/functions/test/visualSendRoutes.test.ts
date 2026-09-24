import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { sendFromTemplate } from '../src/lib/sendFromTemplate';
import { sendEmailChannel } from '../src/notifications/senders/emailChannel';
import { renderEmailParts } from '../src/lib/email';
import { sendPartsFor } from '../src/lib/emailFrame';
import type { NotificationDef } from '../src/notifications/types';

const LINK = 'https://kinfolk.tribetails.com/account/secure-reset?mode=resetPassword&oobCode=a-1&continueUrl=https%3A%2F%2Fkinfolk.tribetails.com%2Fsignin';
const VISUAL = { subject: 'Hi {{displayName}}', format: 'visual' as const, headline: 'Reset', content: '<p>Hello {{displayName}}</p><p><a href="{{link}}" class="button">Go</a></p>' };
const OLD = { subject: 'Old', body: 'Body {{link}}', html: "<p><a href='{{link}}'>x</a></p>" };

/** A minimal but real NotificationDef, the shape `emailChannelFallback.test.ts` builds. */
function def(overrides: Partial<NotificationDef> = {}): NotificationDef {
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
    ...overrides,
  };
}

function sentBody() {
  return JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SMTP2GO_API_KEY', 'k');
  vi.stubEnv('EMAIL_FROM', 'auntie@tribetails.com');
  vi.stubEnv('SEND_SUPPRESS', '');
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: { succeeded: 1, email_id: 'e1' } }) });
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('visual templates on every route', () => {
  it('the link survives a real render of a visual template', () => {
    const out = renderEmailParts({ ...sendPartsFor(VISUAL), data: { link: LINK, displayName: 'Pat' } });
    expect(out.html).toContain(`href="${LINK}"`);
    expect(out.text).toContain(`Go: ${LINK}`);
    expect(out.subject).toBe('Hi Pat');
  });

  for (const [name, doc] of [['visual', VISUAL], ['old', OLD]] as const) {
    it(`sendFromTemplate sends a ${name} template`, async () => {
      mocks.dbFn.mockReturnValue(buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': doc } }).db);
      await sendFromTemplate('k', 'pat@x.test', { link: LINK, displayName: 'Pat' });
      const b = sentBody();
      expect(b.text_body).toContain(LINK);
      if (name === 'visual') expect(b.html_body).toContain('<div class="header"><h2>Reset</h2></div>');
      else expect(b.html_body).toBe(`<p><a href='${LINK}'>x</a></p>`);
    });

    it(`the notification email channel sends a ${name} template`, async () => {
      mocks.dbFn.mockReturnValue(
        buildDbMock({ writeThrough: true, docs: { 'emailTemplates/k': doc, 'clients/u1': { email: 'pat@x.test' } } }).db,
      );
      await sendEmailChannel({ def: def(), recipientUid: 'u1', data: { link: LINK, displayName: 'Pat' } });
      expect(sentBody().text_body).toContain(LINK);
    });
  }
});
