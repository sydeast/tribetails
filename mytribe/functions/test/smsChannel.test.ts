import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  twilioFn: vi.fn(),
  fromNumber: vi.fn(() => '+15555550000'),
  messagesCreate: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/twilio', () => ({
  getTwilio: () => ({ messages: { create: mocks.messagesCreate } }),
  getTwilioFromNumber: mocks.fromNumber,
}));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.messagesCreate.mockReset();
  mocks.logEvent.mockReset();
});

import { sendSmsChannel } from '../src/notifications/senders/smsChannel';
import type { NotificationDef } from '../src/notifications/types';

function def(overrides: Partial<NotificationDef> = {}): NotificationDef {
  return {
    key: 't.k',
    label: 'Test notification',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['sms'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { sms: 't.k' },
    description: 'test',
    ...overrides,
  };
}

describe('sendSmsChannel', () => {
  it('renders + sends via Twilio with rendered body + provider sid', async () => {
    const ctx = buildDbMock({
      docs: {
        'smsTemplates/t.k': { text: 'Hi {{kinfolkFirstName}}, code {{code}}' },
        'clients/u1': { phone: '+15555551111' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.messagesCreate.mockResolvedValue({ sid: 'SM_xyz' });

    const res = await sendSmsChannel({
      def: def(),
      recipientUid: 'u1',
      data: { kinfolkFirstName: 'Sam', code: 'A4' },
    });

    expect(res.providerMessageId).toBe('SM_xyz');
    expect(mocks.messagesCreate).toHaveBeenCalledWith({
      from: '+15555550000',
      to: '+15555551111',
      body: 'Hi Sam, code A4',
    });
  });

  it('#2093: a quote with no Kin still reads whole in an SMS template stored before re-import', async () => {
    const send = async (text: string) => {
      const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text }, 'clients/u1': { phone: '+15555551111' } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.messagesCreate.mockReset();
      mocks.messagesCreate.mockResolvedValue({ sid: 'SM_q' });
      await sendSmsChannel({
        def: def(),
        recipientUid: 'u1',
        data: { actorName: 'Jamie', kinName: '', quoteHouseholdKinNames: 'Rex, Mo' },
      });
      return (mocks.messagesCreate.mock.calls[0][0] as { body: string }).body;
    };
    expect(await send('{{actorName}} accepted the quote for {{kinName}}, woohoo!')).toBe(
      'Jamie accepted the quote for Rex, Mo, woohoo!',
    );
    expect(await send('{{actorName}} accepted the quote{{#if kinName}} for {{kinName}}{{/if}}, woohoo!')).toBe(
      'Jamie accepted the quote, woohoo!',
    );
  });

  it('SKIPS rather than throwing when the template is not authored yet', async () => {
    // Operator ruling 2026-08-23: SMS gets no generic fallback, because a
    // segment costs money and "there's an update, sign in" is not worth paying
    // for. Email carries the generic copy instead. Skipped, not thrown, because
    // unauthored copy is a content gap no retry can fix.
    const ctx = buildDbMock({ docs: { 'clients/u1': { phone: '+15555551111' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res).toEqual({ skipped: true, skipReason: 'template_missing' });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });
  it('SKIPS when the template exists but its text is empty', async () => {
    const ctx = buildDbMock({
      docs: { 'clients/u1': { phone: '+15555551111' }, 'smsTemplates/t.k': { text: '' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res).toEqual({ skipped: true, skipReason: 'template_text_empty' });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });
  it('still THROWS when the catalog row has no sms template id at all', async () => {
    // A misconfigured catalog row is a developer bug, not a content gap. No
    // amount of authoring fixes it, so it must stay loud.
    const ctx = buildDbMock({ docs: { 'clients/u1': { phone: '+15555551111' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendSmsChannel({
        def: def({ templates: {} as never }),
        recipientUid: 'u1',
        data: {},
      }),
    ).rejects.toThrow(/catalog has no sms template id/);
  });

  it('SKIPS rather than throwing when phone is missing from both clients/ and staff/', async () => {
    // MYTRIBE-FUNCTIONS-C: a household that never gave us a number is a normal
    // data state. This used to throw, which raised 19 Sentry events nobody can
    // act on and stamped the channel row `failed`. Same fail-soft shape
    // emailChannel uses for a recipient with no email.
    const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text: 'hi' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res).toEqual({ skipped: true, skipReason: 'recipient_no_phone' });
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
  });

  it('falls back to staff/ when clients/ has no phone', async () => {
    const ctx = buildDbMock({
      docs: {
        'smsTemplates/t.k': { text: 'hello {{name}}' },
        'staff/u1': { phone: '+15555552222' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.messagesCreate.mockResolvedValue({ sid: 'SM_y' });
    await sendSmsChannel({ def: def(), recipientUid: 'u1', data: { name: 'A' } });
    expect(mocks.messagesCreate.mock.calls[0]![0].to).toBe('+15555552222');
  });

  it('a Twilio rejection rethrows with the HTTP status and code in the message, fields and cause kept (#1524)', async () => {
    // wrapTrigger logs the thrown message alone, and the real-services
    // classifier reads `HTTP NNN` off that line. Twilio's RestException keeps
    // the status in `err.status` and the code in `err.code`, so a bare rethrow
    // logged "Service Unavailable" with no number and no vendor name.
    const ctx = buildDbMock({
      docs: { 'smsTemplates/t.k': { text: 'hi' }, 'clients/u1': { phone: '+15555551111' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const twilioErr = Object.assign(new Error('Service Unavailable'), { status: 503, code: 20500 });
    mocks.messagesCreate.mockRejectedValue(twilioErr);
    const thrown = await sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} }).catch((e) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toBe('Twilio send failed (HTTP 503, code 20500): Service Unavailable');
    expect(thrown).toMatchObject({ status: 503, code: 20500 });
    expect(thrown.cause).toBe(twilioErr);
  });

  it('masks the recipient number out of Twilio text that quotes it (#1524)', async () => {
    const ctx = buildDbMock({
      docs: { 'smsTemplates/t.k': { text: 'hi' }, 'clients/u1': { phone: '+15555551111' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.messagesCreate.mockRejectedValue(
      Object.assign(new Error("The 'To' number +15555551111 is not a valid phone number."), { status: 400, code: 21211 }),
    );
    const thrown = await sendSmsChannel({ def: def(), recipientUid: 'u1', data: {} }).catch((e) => e);
    expect(thrown.message).toBe(
      "Twilio send failed (HTTP 400, code 21211): The 'To' number +1******1111 is not a valid phone number.",
    );
  });
  describe('#2280: a household text message is short and links into MyTribe', () => {
    const LINK = 'More in MyTribe: https://kinfolk.tribetails.com/notifications';
    const longNote = 'Please leave the side gate unlatched. '.repeat(14).trim();
    const send = async (text: string, data: Record<string, unknown>, stream?: 'kinfolk' | 'business' | 'staff') => {
      const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text }, 'clients/u1': { phone: '+15555551111' } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.messagesCreate.mockReset();
      mocks.messagesCreate.mockResolvedValue({ sid: 'SM_h' });
      await sendSmsChannel({ def: def(), recipientUid: 'u1', data, ...(stream ? { stream } : {}) });
      return mocks.messagesCreate.mock.calls[0]![0].body as string;
    };
    it('puts the link after a short message that had none', async () => {
      expect(await send("It's Auntie. I updated invoice {{n}}.", { n: 'INV-2027' }, 'kinfolk')).toBe(
        `It's Auntie. I updated invoice INV-2027. ${LINK}`,
      );
    });
    it("cuts a 500-character note short, in plain dots, and keeps the link whole", async () => {
      const body = await send('Tribe Tails: we could not take the Drop-In for Biscuit. {{note}}', { note: longNote }, 'kinfolk');
      expect(longNote.length).toBeGreaterThan(400);
      expect(body.endsWith(` ${LINK}`)).toBe(true);
      const line = body.slice(0, -LINK.length - 1);
      expect(line.length).toBeLessThanOrEqual(200);
      expect(line.endsWith('...')).toBe(true);
      expect(body.length).toBeLessThanOrEqual(200 + 1 + LINK.length);
      // One character outside the basic alphabet would triple the cost.
      expect(body).not.toContain('…');
    });
    it('sends a message that already links to MyTribe as written', async () => {
      const text = "It's Auntie. {{kinName}}'s visit is locked in. Every date: {{portalUrl}}";
      expect(await send(text, { kinName: 'Biscuit', portalUrl: 'https://kinfolk.tribetails.com' }, 'kinfolk')).toBe(
        "It's Auntie. Biscuit's visit is locked in. Every date: https://kinfolk.tribetails.com",
      );
    });
    it('never ends in half an address when a linked message runs long', async () => {
      const text = '{{note}} Every date: {{portalUrl}}';
      const body = await send(text, { note: longNote, portalUrl: 'https://kinfolk.tribetails.com' }, 'kinfolk');
      expect(body.endsWith(` ${LINK}`)).toBe(true);
      expect(body.match(/https:\/\//g)).toHaveLength(1);
      expect(body.length).toBeLessThanOrEqual(200 + 1 + LINK.length);
    });
    it.each(['business', 'staff', undefined] as const)('a %s copy is sent as written', async (stream) => {
      expect(await send('Tribe Tails: {{note}}', { note: longNote }, stream)).toBe(`Tribe Tails: ${longNote}`);
    });
  });
  describe('#2371: the link opens the notice entry, which holds a cut message whole', () => {
    const ENTRY = '/notifications?entry=n1';
    const ENTRY_LINK = `More in MyTribe: https://kinfolk.tribetails.com${ENTRY}`;
    const longNote = 'Please leave the side gate unlatched. '.repeat(14).trim();
    const send = async (text: string, data: Record<string, unknown>, entryId?: string) => {
      const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text }, 'clients/u1': { phone: '+15555551111' } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.messagesCreate.mockReset();
      mocks.messagesCreate.mockResolvedValue({ sid: 'SM_e' });
      await sendSmsChannel({
        def: def(),
        recipientUid: 'u1',
        data,
        stream: 'kinfolk',
        open: { data: {}, readInList: { route: entryId ? ENTRY : '/notifications', ...(entryId ? { entryId } : {}) } },
      });
      return { body: mocks.messagesCreate.mock.calls[0]![0].body as string, ctx };
    };
    it('a cut message links to its entry and is written whole onto it', async () => {
      const { body, ctx } = await send('Tribe Tails: we could not take it. {{note}}', { note: longNote }, 'n1');
      expect(body.endsWith(`... ${ENTRY_LINK}`)).toBe(true);
      expect(ctx.writes.filter((w) => w.path === 'notifications/n1')).toEqual([
        { path: 'notifications/n1', data: { householdTextMessage: `Tribe Tails: we could not take it. ${longNote}` }, merge: true },
      ]);
    });
    it('a message that fits links to its entry and writes nothing', async () => {
      const { body, ctx } = await send('Your Auntie arrived.', {}, 'n1');
      expect(body).toBe(`Your Auntie arrived. ${ENTRY_LINK}`);
      expect(ctx.writes.some((w) => w.path.startsWith('notifications/'))).toBe(false);
    });
    it('with no entry named it links to the list and writes nothing', async () => {
      const { body, ctx } = await send('Tribe Tails: {{note}}', { note: longNote });
      expect(body.endsWith('... More in MyTribe: https://kinfolk.tribetails.com/notifications')).toBe(true);
      expect(ctx.writes.some((w) => w.path.startsWith('notifications/'))).toBe(false);
    });
    it('the message is on the entry before the text is sent', async () => {
      const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text: '{{note}}' }, 'clients/u1': { phone: '+15555551111' } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      let keptAtSend = -1;
      mocks.messagesCreate.mockImplementation(async () => {
        keptAtSend = ctx.writes.filter((w) => w.path === 'notifications/n1').length;
        return { sid: 'SM_o' };
      });
      await sendSmsChannel({
        def: def(),
        recipientUid: 'u1',
        data: { note: longNote },
        stream: 'kinfolk',
        open: { data: {}, readInList: { route: ENTRY, entryId: 'n1' } },
      });
      expect(keptAtSend).toBe(1);
    });
    it('a refused write is logged and the text still goes, with its link to the entry', async () => {
      const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text: '{{note}}' }, 'clients/u1': { phone: '+15555551111' } } });
      const collection = ctx.db.collection;
      ctx.db.collection = (path: string) => {
        const real = collection(path);
        if (path !== 'notifications') return real;
        return { ...real, doc: () => ({ update: async () => { throw new Error('5 NOT_FOUND: no entity to update'); } }) };
      };
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.messagesCreate.mockResolvedValue({ sid: 'SM_r' });
      await sendSmsChannel({
        def: def(),
        recipientUid: 'u1',
        data: { note: longNote },
        stream: 'kinfolk',
        open: { data: {}, readInList: { route: ENTRY, entryId: 'n1' } },
      });
      expect((mocks.messagesCreate.mock.calls[0]![0].body as string).endsWith(`... ${ENTRY_LINK}`)).toBe(true);
      expect(mocks.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'error',
          function: 'smsChannel',
          event: 'notification.sms.message_not_kept',
          extra: expect.objectContaining({ key: 't.k', entryId: 'n1' }),
        }),
      );
    });
    it.each(['business', 'staff'] as const)('a %s copy is sent as written and writes nothing', async (stream) => {
      const ctx = buildDbMock({ docs: { 'smsTemplates/t.k': { text: '{{note}}' }, 'clients/u1': { phone: '+15555551111' }, 'users/u1': { phone: '+15555551111' } } });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.messagesCreate.mockResolvedValue({ sid: 'SM_s' });
      await sendSmsChannel({
        def: def({ audience: 'both', audiences: { kinfolk: true, business: true } }),
        recipientUid: 'u1',
        data: { note: longNote },
        stream,
        open: { data: {} },
      });
      expect(mocks.messagesCreate.mock.calls[0]![0].body).toBe(longNote);
      expect(ctx.writes.some((w) => w.path.startsWith('notifications/'))).toBe(false);
    });
  });
});
