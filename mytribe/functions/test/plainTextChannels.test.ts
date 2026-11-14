import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2321: a text message and a push are plain text. The senders rendered their
 * templates with web-page escaping, so `O'Malley` reached the phone as
 * `O&#x27;Malley` and `Bob & Sue` as `Bob &amp; Sue`.
 *
 * Over the REAL senders and the real template engine: each test reads what was
 * handed to Twilio or to FCM.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getAdminFn: vi.fn(),
  multicast: vi.fn(),
  messagesCreate: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, getAdmin: mocks.getAdminFn, auth: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/twilio', () => ({
  getTwilio: () => ({ messages: { create: mocks.messagesCreate } }),
  getTwilioFromNumber: () => '+15555550000',
}));

import { sendSmsChannel } from '../src/notifications/senders/smsChannel';
import { sendPushChannel } from '../src/notifications/senders/pushChannel';
import { renderEmailParts } from '../src/lib/email';
import {
  HOUSEHOLD_NOTICE_ROUTE,
  HOUSEHOLD_SHORT_LINE_MAX,
  HOUSEHOLD_SMS_LINK_LABEL,
  renderPlainText,
} from '../src/notifications/templateParsers';
import { PORTAL_URL } from '../src/notifications/visitDates';
import { messagePreview, plainTextToMessageBody, sanitizeMessageBody } from '../src/lib/richText';
import type { AudienceStream, NotificationDef } from '../src/notifications/types';

const LINK = `${HOUSEHOLD_SMS_LINK_LABEL} ${PORTAL_URL}${HOUSEHOLD_NOTICE_ROUTE}`;
/** Any code a web page would use for a character. None belongs on a phone. */
const ENTITY = /&(?:#x?[0-9a-f]+|amp|lt|gt|quot|apos);/i;
/** The first half of a two-part character with no second half after it. */
const BROKEN_CHARACTER = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;

function def(channel: 'sms' | 'push'): NotificationDef {
  return {
    key: 't.k',
    label: 'Test notification',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: [channel],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { [channel]: 't.k' },
    description: 'test',
  } as NotificationDef;
}

async function text(template: string, data: Record<string, unknown>, stream?: AudienceStream): Promise<string> {
  const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text: template }, 'clients/u1': { phone: '+15555551111' } } });
  mocks.dbFn.mockReturnValue(ctx.db);
  mocks.messagesCreate.mockReset().mockResolvedValue({ sid: 'SM_1' });
  await sendSmsChannel({ def: def('sms'), recipientUid: 'u1', data, stream });
  return (mocks.messagesCreate.mock.calls[0]![0] as { body: string }).body;
}

async function push(
  template: { title: string; body: string; dataRoute?: string },
  data: Record<string, unknown>,
  stream?: AudienceStream,
): Promise<{ notification: { title: string; body: string }; data: Record<string, string> }> {
  const ctx = buildDbMock({
    docs: { 'pushTemplates/t.k': template },
    queryDocs: { fcm_tokens: [{ id: 'tok-1', data: { uid: 'u1' } }] },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  mocks.multicast.mockReset().mockResolvedValue({ successCount: 1, responses: [{ success: true, messageId: 'm-1' }] });
  mocks.getAdminFn.mockReturnValue({ messaging: () => ({ sendEachForMulticast: mocks.multicast }) });
  await sendPushChannel({ def: def('push'), recipientUid: 'u1', data, stream });
  return mocks.multicast.mock.calls[0]![0];
}

const TYPED = { kinName: "O'Malley", kinfolkName: 'Bob & Sue', note: 'Key is under the <blue> mat, "not" the red one' };

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getAdminFn.mockReset();
});

describe('#2321: a text message carries the characters as typed', () => {
  const TEMPLATE = '{{kinfolkName}}: {{kinName}} is booked. {{note}}';
  const WHOLE = `Bob & Sue: O'Malley is booked. Key is under the <blue> mat, "not" the red one`;

  it('a staff or business copy: apostrophe, ampersand, angle brackets and quote mark', async () => {
    const sent = await text(TEMPLATE, TYPED, 'staff');
    expect(sent).toBe(WHOLE);
    expect(sent).not.toMatch(ENTITY);
    expect(await text(TEMPLATE, TYPED, 'business')).toBe(WHOLE);
  });

  it('a copy with no audience on its work order (written before the stamp) is the same', async () => {
    expect(await text(TEMPLATE, TYPED)).toBe(WHOLE);
  });

  it("a household's copy: the same characters, then the link", async () => {
    const sent = await text(TEMPLATE, TYPED, 'kinfolk');
    expect(sent).toBe(`${WHOLE} ${LINK}`);
    expect(sent).not.toMatch(ENTITY);
  });

  it('a message that fits in 200 characters is not cut because of its punctuation', async () => {
    // 196 characters as typed. Escaped for a web page it ran past 300, so it
    // was cut, and the cut could land inside a code.
    const note = `${"O'Malley & Sue's ".repeat(12).slice(0, 195)}.`;
    expect(note.length).toBe(196);
    const sent = await text('{{note}}', { note }, 'kinfolk');
    expect(sent).toBe(`${note} ${LINK}`);
    expect(sent).not.toContain('...');
  });

  it('a long message is cut on the typed text: never inside a code, never through an emoji', async () => {
    // The emoji sits across the cut (characters 197 and 198 of the typed text).
    const head = "Bob & Sue's ".repeat(17).slice(0, 196);
    const note = `${head}\u{1F436}\u{1F436} and then the rest of a long note about O'Malley & the side gate`;
    const sent = await text('{{note}}', { note }, 'kinfolk');
    expect(sent.endsWith(`... ${LINK}`)).toBe(true);
    const line = sent.slice(0, -` ${LINK}`.length);
    expect(line.length).toBeLessThanOrEqual(HOUSEHOLD_SHORT_LINE_MAX);
    expect(line).not.toMatch(ENTITY);
    expect(line).not.toMatch(BROKEN_CHARACTER);
    expect(note.startsWith(line.slice(0, -3).trimEnd())).toBe(true);
  });

  it('a leftover merge token is still blanked', async () => {
    expect(await text("Hi {{kinName}}{{nope}}, it's on", TYPED, 'staff')).toBe("Hi O'Malley, it's on");
  });
});

describe('#2321: a push carries the characters as typed', () => {
  const TEMPLATE = { title: "{{kinName}}'s visit", body: '{{kinfolkName}}: {{note}}' };

  it('a staff copy: title and body, apostrophe, ampersand, angle brackets and quote mark', async () => {
    const sent = await push(TEMPLATE, TYPED, 'staff');
    expect(sent.notification).toEqual({
      title: "O'Malley's visit",
      body: 'Bob & Sue: Key is under the <blue> mat, "not" the red one',
    });
  });

  it("a household's copy is the same words, and opens the notifications list", async () => {
    const sent = await push(TEMPLATE, TYPED, 'kinfolk');
    expect(sent.notification.title).toBe("O'Malley's visit");
    expect(sent.notification.body).toBe('Bob & Sue: Key is under the <blue> mat, "not" the red one');
    expect(sent.data['route']).toBe(HOUSEHOLD_NOTICE_ROUTE);
  });

  it('a long household push is cut on the typed text: never inside a code, never through an emoji', async () => {
    // The emoji sits across the cut (characters 199 and 200 of the typed text).
    const head = "Bob & Sue's ".repeat(17).slice(0, 198);
    const note = `${head}\u{1F436}\u{1F436} and the rest of a long note about O'Malley`;
    const sent = await push({ title: 'A note', body: '{{note}}' }, { note }, 'kinfolk');
    const body = sent.notification.body;
    expect(body.endsWith('…')).toBe(true);
    expect(body.length).toBeLessThanOrEqual(HOUSEHOLD_SHORT_LINE_MAX);
    expect(body).not.toMatch(ENTITY);
    expect(body).not.toMatch(BROKEN_CHARACTER);
    expect(note.startsWith(body.slice(0, -1))).toBe(true);
  });

  it('a route keeps its question mark, equals sign and ampersand', async () => {
    const sent = await push(
      { title: 'Invoice', body: 'Ready', dataRoute: '/invoices/{{invoiceId}}?{{query}}' },
      { invoiceId: 'inv1', query: 'a=1&b=2' },
      'staff',
    );
    expect(sent.data['route']).toBe('/invoices/inv1?a=1&b=2');
  });
});

describe('#2321: a stored message body is turned back into text once, where the notice is raised', () => {
  // A conversation message is stored with `&`, `<` and `>` as codes (#2144).
  // `messagePreview` gives the notice the text as typed; the senders add
  // nothing and take nothing away.
  const stored = (typed: string) => sanitizeMessageBody(plainTextToMessageBody(typed));
  const TEMPLATE = 'New message: "{{preview}}"';

  it('a stored body reads as typed in the text message and the push', async () => {
    const typed = "Tom & Jerry's key is under the <side gate> mat";
    const body = stored(typed);
    expect(body).toBe("Tom &amp; Jerry's key is under the &lt;side gate&gt; mat");
    const preview = messagePreview(body, 200);
    expect(await text(TEMPLATE, { preview }, 'staff')).toBe(`New message: "${typed}"`);
    expect((await push({ title: 'Message', body: '{{preview}}' }, { preview }, 'kinfolk')).notification.body).toBe(typed);
  });

  it('a code someone typed on purpose stays a code: it is never decoded twice into markup', async () => {
    const typed = 'type &lt;b&gt; for bold, &amp; for and';
    const preview = messagePreview(stored(typed), 200);
    expect(preview).toBe(typed);
    const sent = await text(TEMPLATE, { preview }, 'staff');
    expect(sent).toBe(`New message: "${typed}"`);
    expect(sent).not.toContain('<b>');
    expect((await push({ title: 'Message', body: '{{preview}}' }, { preview }, 'staff')).notification.body).toBe(typed);
  });
});

describe('#2321: only the plain-text channels changed', () => {
  const data = { kinName: "O'Malley", note: '<script>alert(1)</script> & <a href="x">tap</a>' };

  it("the email's html part still escapes every merge value", () => {
    const out = renderEmailParts({
      subjectTemplate: '{{kinName}}',
      bodyTemplate: '{{kinName}}: {{note}}',
      htmlTemplate: '<p>{{kinName}}: {{note}}</p>',
      data,
    });
    expect(out.subject).toBe("O'Malley");
    expect(out.text).toBe(`O'Malley: ${data.note}`);
    expect(out.html).toBe(
      '<p>O&#x27;Malley: &lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;a href&#x3D;&quot;x&quot;&gt;tap&lt;/a&gt;</p>',
    );
  });

  it('the plain-text renderer hands back what was typed, so its result is never a page', () => {
    expect(renderPlainText('{{kinName}}: {{note}}', data)).toBe(`O'Malley: ${data.note}`);
  });
});
