import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), audit: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.audit }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));

import {
  getTemplateChannelsHandler,
  saveTemplateChannelsHandler,
  WORDING_REFUSAL,
} from '../src/admin/templateChannels';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';
import {
  PUSH_BODY_MAX,
  PUSH_TITLE_MAX,
  SMS_TEXT_MAX,
  channelSupportFor,
  pushWordingErrors,
  scanFields,
  smsWordingErrors,
} from '../src/lib/templateChannelWording';
import { planImport } from '../src/notifications/importPlanner';
import { parsePushTxt } from '../src/notifications/templateParsers';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.audit.mockReset();
  mocks.audit.mockResolvedValue('a1');
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

/** Sends email, text and push. */
const CONFIRM = 'kincare.booking.confirm';
/**
 * Listed in the catalog as email and push only. The catalog opens every
 * channel on every row at load (`normalizeAllChannels`), so it sends text too.
 */
const INVOICE = 'invoice.new';
/** Sent outside the dispatcher, so neither sender ever runs for it. */
const RESET = 'auth.password.reset';
/** A direct send: no catalog row, so neither text nor push. */
const INVITE = 'invite.primary';

const admin = <T>(data: T) => callableRequest(data, { uid: 'admin1', token: { admin: true } });

function seed(docs: Record<string, Record<string, unknown> | null>) {
  const ctx = buildDbMock({ docs });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

async function refusal(run: Promise<unknown>): Promise<{ code: string; message: string; details: any }> {
  try {
    await run;
  } catch (err) {
    const e = err as { code: string; message: string; details: unknown };
    return { code: e.code, message: e.message, details: e.details };
  }
  throw new Error('expected a refusal, and the call went through');
}

describe('getTemplateChannels', () => {
  it('HAPPY: returns the stored text and push wording, the fields and the limits', async () => {
    seed({
      [`smsTemplates/${CONFIRM}`]: { text: 'Booked for {{kinName}}.' },
      [`pushTemplates/${CONFIRM}`]: { title: 'Booked', body: 'Tap for {{kinName}}.', dataRoute: '/visits' },
    });
    const res = await getTemplateChannelsHandler(admin({ templateId: CONFIRM }));
    expect(res.notificationLabel).toBe('KinCare booking confirmed');
    expect(res.sms).toEqual({ supported: true, set: true, text: 'Booked for {{kinName}}.', maxLength: SMS_TEXT_MAX });
    expect(res.push).toEqual({
      supported: true,
      set: true,
      title: 'Booked',
      body: 'Tap for {{kinName}}.',
      titleMaxLength: PUSH_TITLE_MAX,
      bodyMaxLength: PUSH_BODY_MAX,
    });
    expect(res.fields).toContain('kinName');
    // The tap target is the app's business, not the operator's.
    expect(JSON.stringify(res)).not.toContain('/visits');
  });

  it('a channel the notification sends but nobody has written is "not set", and can be added', async () => {
    seed({});
    const res = await getTemplateChannelsHandler(admin({ templateId: CONFIRM }));
    expect(res.sms).toMatchObject({ supported: true, set: false, text: '' });
    expect(res.push).toMatchObject({ supported: true, set: false, title: '', body: '' });
  });

  it('a notification that is never sent by text or push says so, even when a copy is stored', async () => {
    seed({
      [`smsTemplates/${RESET}`]: { text: 'Stored by the importer, read by no sender.' },
      [`pushTemplates/${RESET}`]: { title: 'Reset', body: 'Stored, never sent.' },
    });
    const res = await getTemplateChannelsHandler(admin({ templateId: RESET }));
    expect(res.notificationLabel).not.toBeNull();
    expect(res.sms).toMatchObject({ supported: false, set: false, text: '' });
    expect(res.push).toMatchObject({ supported: false, set: false, title: '', body: '' });
  });
  it('every catalog notification can send all three, whatever its own row lists', async () => {
    seed({ [`smsTemplates/${INVOICE}`]: { text: 'Invoice ready.' } });
    const res = await getTemplateChannelsHandler(admin({ templateId: INVOICE }));
    expect(res.sms).toMatchObject({ supported: true, set: true, text: 'Invoice ready.' });
    expect(res.push).toMatchObject({ supported: true, set: false });
  });

  it('a template no notification sends has neither channel', async () => {
    seed({ [`emailTemplates/${INVITE}`]: { subject: 's' }, 'emailTemplates/my.own': { subject: 's' } });
    for (const templateId of [INVITE, 'my.own']) {
      const res = await getTemplateChannelsHandler(admin({ templateId }));
      expect(res.notificationLabel).toBeNull();
      expect(res.sms.supported).toBe(false);
      expect(res.push.supported).toBe(false);
      expect(res.fields).toEqual([]);
    }
  });

  it('SAD: an unknown template is not-found, in words', async () => {
    seed({});
    const r = await refusal(getTemplateChannelsHandler(admin({ templateId: 'ghost.template' })));
    expect(r.code).toBe('not-found');
    expect(r.message).toMatch(/no longer in the Template Bank/);
    expect(r.message).not.toContain('ghost.template');
  });

  it('SAD: a malformed id is invalid-argument, not an internal error', async () => {
    seed({});
    const r = await refusal(getTemplateChannelsHandler(admin({ templateId: 'a/b' })));
    expect(r.code).toBe('invalid-argument');
  });

  it('SAD: signed out is unauthenticated', async () => {
    seed({});
    const r = await refusal(getTemplateChannelsHandler(callableRequest({ templateId: CONFIRM })));
    expect(r.code).toBe('unauthenticated');
  });
});

describe('saveTemplateChannels', () => {
  it('HAPPY: saves the text message alone and leaves push untouched', async () => {
    const ctx = seed({
      [`smsTemplates/${CONFIRM}`]: { text: 'Old words.' },
      [`pushTemplates/${CONFIRM}`]: { title: 'Booked', body: 'Tap.' },
    });
    const res = await saveTemplateChannelsHandler(
      admin({ templateId: CONFIRM, sms: { text: '  New words for {{kinName}}.  ' } }),
    );
    expect(ctx.writes).toHaveLength(1);
    expect(ctx.writes[0]).toMatchObject({ path: `smsTemplates/${CONFIRM}`, merge: true });
    expect(ctx.writes[0]!.data).toMatchObject({ text: 'New words for {{kinName}}.', updatedBy: 'admin1' });
    expect(ctx.writes[0]!.data).not.toHaveProperty('createdAt');
    expect(res.sms).toMatchObject({ set: true, text: 'New words for {{kinName}}.' });
    expect(res.push).toMatchObject({ title: 'Booked', body: 'Tap.' });
  });

  it('HAPPY: saves push title and body by merge, never writing the tap target', async () => {
    const ctx = seed({
      [`pushTemplates/${CONFIRM}`]: { title: 'Booked', body: 'Tap.', dataRoute: '/visits' },
    });
    await saveTemplateChannelsHandler(
      admin({ templateId: CONFIRM, push: { title: 'All set', body: 'See {{kinName}} soon.' } }),
    );
    expect(ctx.writes).toHaveLength(1);
    const w = ctx.writes[0]!;
    expect(w).toMatchObject({ path: `pushTemplates/${CONFIRM}`, merge: true });
    expect(w.data).toMatchObject({ title: 'All set', body: 'See {{kinName}} soon.' });
    expect(w.data).not.toHaveProperty('dataRoute');
  });

  it('HAPPY: adding wording that was not set creates it and stamps who made it', async () => {
    const ctx = seed({});
    const res = await saveTemplateChannelsHandler(admin({ templateId: CONFIRM, sms: { text: 'Hello.' } }));
    expect(ctx.writes[0]!.data).toMatchObject({ text: 'Hello.', createdBy: 'admin1', updatedBy: 'admin1' });
    expect(res.sms.set).toBe(true);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { templateId: CONFIRM, channels: ['sms'], added: ['sms'] } }),
    );
  });

  it('AUDIT: writes one Activity Log line in words, without the wording', async () => {
    seed({ [`smsTemplates/${CONFIRM}`]: { text: 'Old.' }, [`pushTemplates/${CONFIRM}`]: { title: 'a', body: 'b' } });
    await saveTemplateChannelsHandler(
      admin({ templateId: CONFIRM, sms: { text: 'Secret new words.' }, push: { title: 'T', body: 'B' } }),
    );
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    const entry = mocks.audit.mock.calls[0]![0];
    expect(entry).toMatchObject({
      event: 'ADMIN_TEMPLATE_WORDING_UPDATED',
      status: 'SUCCESS',
      actorUid: 'admin1',
      description: 'Changed the text message and push notification wording for "KinCare booking confirmed"',
      payload: { templateId: CONFIRM, channels: ['sms', 'push'], added: [] },
    });
    expect(JSON.stringify(entry)).not.toContain('Secret new words');
  });

  it('a save that changes nothing writes nothing and logs nothing', async () => {
    const ctx = seed({ [`smsTemplates/${CONFIRM}`]: { text: 'Same.' } });
    await saveTemplateChannelsHandler(admin({ templateId: CONFIRM, sms: { text: ' Same. ' } }));
    expect(ctx.writes).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('SAD: every refused field gets its own sentence, and nothing is written', async () => {
    const ctx = seed({});
    const r = await refusal(
      saveTemplateChannelsHandler(
        admin({
          templateId: CONFIRM,
          sms: { text: '   ' },
          push: { title: 'x'.repeat(PUSH_TITLE_MAX + 1), body: 'Hi {{nopeVar}}' },
        }),
      ),
    );
    expect(r.code).toBe('invalid-argument');
    expect(r.details.reason).toBe(WORDING_REFUSAL);
    expect(r.details.fieldErrors.smsText).toBe('Text message cannot be empty.');
    expect(r.details.fieldErrors.pushTitle).toBe(
      `Title is ${PUSH_TITLE_MAX + 1} characters. The limit is ${PUSH_TITLE_MAX}.`,
    );
    expect(r.details.fieldErrors.pushBody).toMatch(/^\{\{nopeVar\}\} is not a field this notification fills in\./);
    expect(r.details.fieldErrors.pushBody).toContain('{{kinName}}');
    expect(ctx.writes).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it('SAD: a text message over the limit is refused with both numbers', async () => {
    seed({});
    const r = await refusal(
      saveTemplateChannelsHandler(admin({ templateId: CONFIRM, sms: { text: 'x'.repeat(SMS_TEXT_MAX + 1) } })),
    );
    expect(r.details.fieldErrors.smsText).toBe(
      `Text message is ${SMS_TEXT_MAX + 1} characters. The limit is ${SMS_TEXT_MAX}.`,
    );
  });

  it('SAD: three curly brackets and unclosed fields are refused in plain words', async () => {
    seed({});
    const triple = await refusal(
      saveTemplateChannelsHandler(admin({ templateId: CONFIRM, sms: { text: 'Hi {{{kinName}}}' } })),
    );
    expect(triple.details.fieldErrors.smsText).toMatch(/two curly brackets/);
    const open = await refusal(
      saveTemplateChannelsHandler(admin({ templateId: CONFIRM, sms: { text: 'Hi {{kinName' } })),
    );
    expect(open.details.fieldErrors.smsText).toMatch(/not written correctly/);
    for (const msg of [triple.message, open.message]) {
      expect(msg).not.toMatch(/Handlebars|stash|smsTemplates|Parse error/i);
    }
  });

  it('a field the stored copy already uses stays usable, a new unknown one does not', async () => {
    const ctx = seed({ [`smsTemplates/${CONFIRM}`]: { text: 'On {{bookingDate}}.' } });
    await saveTemplateChannelsHandler(
      admin({ templateId: CONFIRM, sms: { text: 'Booked on {{bookingDate}}.' } }),
    );
    expect(ctx.writes).toHaveLength(1);
    const r = await refusal(
      saveTemplateChannelsHandler(admin({ templateId: CONFIRM, sms: { text: 'On {{bookingDate}} {{other}}' } })),
    );
    expect(r.details.fieldErrors.smsText).toMatch(/^\{\{other\}\}/);
  });

  it('SAD: a channel the notification does not send cannot be added', async () => {
    const ctx = seed({ [`emailTemplates/${INVITE}`]: { subject: 's' } });
    const noSms = await refusal(saveTemplateChannelsHandler(admin({ templateId: RESET, sms: { text: 'Hi' } })));
    expect(noSms.code).toBe('failed-precondition');
    expect(noSms.message).toMatch(/not sent by text message/);
    const noPush = await refusal(
      saveTemplateChannelsHandler(admin({ templateId: INVITE, push: { title: 'a', body: 'b' } })),
    );
    expect(noPush.code).toBe('failed-precondition');
    expect(ctx.writes).toEqual([]);
  });

  it('SAD: an unknown template is not-found and nothing is written', async () => {
    const ctx = seed({});
    const r = await refusal(saveTemplateChannelsHandler(admin({ templateId: 'ghost.template', sms: { text: 'Hi' } })));
    expect(r.code).toBe('not-found');
    expect(ctx.writes).toEqual([]);
  });

  it('SAD: a save with no channel in it is refused', async () => {
    seed({});
    const r = await refusal(saveTemplateChannelsHandler(admin({ templateId: CONFIRM })));
    expect(r.code).toBe('invalid-argument');
  });
});

describe('who may call them', () => {
  const cases = [
    ['getTemplateChannels', getTemplateChannelsHandler, { templateId: CONFIRM }],
    ['saveTemplateChannels', saveTemplateChannelsHandler, { templateId: CONFIRM, sms: { text: 'Hi' } }],
  ] as const;

  for (const [name, handler, data] of cases) {
    it(`${name}: a signed-in household member is refused`, async () => {
      const ctx = seed({});
      const wrapped = wrapAdminCallable(name, handler as never);
      await expect(wrapped(callableRequest(data, { uid: 'kinfolk1', token: {} }) as never)).rejects.toMatchObject({
        code: 'permission-denied',
      });
      expect(ctx.writes).toEqual([]);
    });

    it(`${name}: the Auntie role is refused`, async () => {
      const ctx = seed({});
      const wrapped = wrapAdminCallable(name, handler as never);
      await expect(
        wrapped(callableRequest(data, { uid: 'auntie1', token: { staffRole: 'auntie' } }) as never),
      ).rejects.toMatchObject({ code: 'permission-denied' });
      expect(ctx.writes).toEqual([]);
      expect(AUNTIE_ALLOWED_CALLABLES.has(name)).toBe(false);
    });

    it(`${name}: signed out is refused`, async () => {
      seed({});
      const wrapped = wrapAdminCallable(name, handler as never);
      await expect(wrapped(callableRequest(data) as never)).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it(`${name}: an admin gets through the gate`, async () => {
      seed({});
      const wrapped = wrapAdminCallable(name, handler as never);
      await expect(
        wrapped(callableRequest(data, { uid: 'admin1', token: { admin: true } }) as never),
      ).resolves.toMatchObject({ templateId: CONFIRM });
    });
  }
});

describe('the wording rules', () => {
  it('reads plain fields, block subjects, and skips names inside a repeating list', () => {
    const scan = scanFields('{{a}} {{#each visits}}{{date}} {{this.time}}{{/each}} {{#if b.c}}x{{else}}{{d}}{{/if}}');
    expect(scan.problem).toBeNull();
    expect(scan.fields).toEqual(['a', 'visits', 'b.c', 'd']);
  });

  it('refuses a helper nothing registers, a partial, and a field with arguments', () => {
    expect(scanFields('{{#shout name}}x{{/shout}}').problem).toMatch(/not something a notification can use/);
    expect(scanFields('{{> footer}}').problem).not.toBeNull();
    expect(scanFields('{{upper name}}').problem).not.toBeNull();
  });

  it('a notification with no fields says so rather than listing nothing', () => {
    expect(smsWordingErrors('Hi {{x}}', []).smsText).toBe(
      '{{x}} is not a field this notification fills in. It has no fields to use.',
    );
  });

  it('checks push title and body separately', () => {
    expect(pushWordingErrors({ title: '', body: 'ok' }, [])).toEqual({ pushTitle: 'Title cannot be empty.' });
    expect(pushWordingErrors({ title: 'ok', body: 'x'.repeat(PUSH_BODY_MAX + 1) }, [])).toEqual({
      pushBody: `Message is ${PUSH_BODY_MAX + 1} characters. The limit is ${PUSH_BODY_MAX}.`,
    });
  });

  it('channel support follows the catalog row the senders read', () => {
    expect(channelSupportFor(CONFIRM)).toMatchObject({ smsId: CONFIRM, pushId: CONFIRM });
    expect(channelSupportFor(INVOICE)).toMatchObject({ smsId: INVOICE, pushId: INVOICE });
    // Sent outside the dispatcher, which is the only caller of the two senders.
    expect(channelSupportFor(RESET)).toMatchObject({ smsId: null, pushId: null });
    expect(channelSupportFor('my.own').def).toBeNull();
  });

  // The same wording reaches Firestore through Template Import. If a rule here
  // refused the copy that ships with the app, an operator could not save a
  // text they had only opened.
  it('every text and push the app ships with passes for the notification that sends it', () => {
    const failures: string[] = [];
    for (const def of Object.values(NOTIFICATION_CATALOG)) {
      const support = channelSupportFor(def.templates.email ?? def.key);
      const entry = SEED_CORPUS.find((e) => e.key === def.key);
      if (!entry) continue;
      if (support.smsId) {
        const errors = smsWordingErrors(entry.smsTxt, support.fields);
        if (errors.smsText) failures.push(`${def.key} sms: ${errors.smsText}`);
      }
      if (support.pushId) {
        const errors = pushWordingErrors(parsePushTxt(entry.pushTxt), support.fields);
        for (const e of Object.values(errors)) failures.push(`${def.key} push: ${e}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('Template Import after an edit made here', () => {
  const entry = SEED_CORPUS.find((e) => e.key === CONFIRM)!;
  const pushSeed = parsePushTxt(entry.pushTxt);
  const email = {
    subject: entry.emailSubject,
    headline: entry.emailHeadline,
    content: entry.emailContent,
    format: 'visual',
  };

  it('keeps an edited text message unless the operator ticks that template', async () => {
    const ctx = buildDbMock({
      docs: { [`smsTemplates/${CONFIRM}`]: { text: entry.smsTxt.trim() } },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await saveTemplateChannelsHandler(admin({ templateId: CONFIRM, sms: { text: 'My own words.' } }));
    const saved = ctx.writes[0]!.data as Record<string, unknown>;

    const existing = {
      [`emailTemplates/${CONFIRM}`]: email,
      [`smsTemplates/${CONFIRM}`]: { text: saved['text'] },
      [`pushTemplates/${CONFIRM}`]: { ...pushSeed },
    };
    const kept = planImport({ corpus: SEED_CORPUS, existing, onlyIds: [CONFIRM] });
    expect(kept.templates[0]!.channels.find((c) => c.channel === 'sms')!.outcome).toBe('skipped');
    const replaced = planImport({ corpus: SEED_CORPUS, existing, onlyIds: [CONFIRM], overwriteIds: [CONFIRM] });
    expect(replaced.templates[0]!.channels.find((c) => c.channel === 'sms')!.outcome).toBe('overwrite');
  });

  it('a copy saved back unedited still reads as unchanged', async () => {
    const ctx = seed({});
    await saveTemplateChannelsHandler(
      admin({ templateId: CONFIRM, sms: { text: entry.smsTxt }, push: { title: pushSeed.title, body: pushSeed.body } }),
    );
    const byPath = Object.fromEntries(ctx.writes.map((w) => [w.path, w.data as Record<string, unknown>]));
    const plan = planImport({
      corpus: SEED_CORPUS,
      existing: {
        [`emailTemplates/${CONFIRM}`]: email,
        [`smsTemplates/${CONFIRM}`]: { text: byPath[`smsTemplates/${CONFIRM}`]!['text'] },
        [`pushTemplates/${CONFIRM}`]: {
          title: byPath[`pushTemplates/${CONFIRM}`]!['title'],
          body: byPath[`pushTemplates/${CONFIRM}`]!['body'],
        },
      },
      onlyIds: [CONFIRM],
    });
    const outcomes = Object.fromEntries(plan.templates[0]!.channels.map((c) => [c.channel, c.outcome]));
    expect(outcomes['sms']).toBe('unchanged');
    expect(outcomes['push']).toBe('unchanged');
  });
});
