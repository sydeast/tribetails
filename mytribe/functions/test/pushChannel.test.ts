import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getAdminFn: vi.fn(),
  multicast: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  getAdmin: mocks.getAdminFn,
  auth: vi.fn(),
}));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.getAdminFn.mockReset();
  mocks.multicast.mockReset();
  mocks.getAdminFn.mockReturnValue({ messaging: () => ({ sendEachForMulticast: mocks.multicast }) });
});

import { sendPushChannel } from '../src/notifications/senders/pushChannel';
import type { NotificationDef } from '../src/notifications/types';

function def(overrides: Partial<NotificationDef> = {}): NotificationDef {
  return {
    key: 't.k',
    label: 'Test notification',
    audience: 'kinfolk',
    audiences: { kinfolk: true },
    category: 'visit',
    allowedChannels: ['push'],
    required: {},
    alwaysEnabled: false,
    kinfolkFacing: true,
    deliveryMode: 'trigger',
    recipientResolver: 'kinfolkAcct',
    templates: { push: 't.k' },
    description: 'test',
    ...overrides,
  };
}

/** Bespoke Firestore mock: doc fetch + filtered collection query for fcm_tokens. */
function buildPushDbMock(opts: {
  template?: { title?: string; body?: string; dataRoute?: string } | null;
  tokens?: string[];
  deletes?: string[];
  /** #2368: every `update` made, in order, with the path it was made to. */
  updates?: Array<{ path: string; patch: Record<string, unknown> }>;
  /** #2368: an `update` that throws (the entry was taken back, or Firestore refused it). */
  updateFails?: Error;
}) {
  const deletes: string[] = opts.deletes ?? [];
  const updates = opts.updates ?? [];

  const docMock = (path: string) => ({
    get: vi.fn(async () => {
      if (path === 'pushTemplates/t.k') {
        return { exists: !!opts.template, data: () => opts.template ?? undefined };
      }
      return { exists: false, data: () => undefined };
    }),
    delete: vi.fn(async () => {
      deletes.push(path);
    }),
    update: vi.fn(async (patch: Record<string, unknown>) => {
      if (opts.updateFails) throw opts.updateFails;
      updates.push({ path, patch });
    }),
  });

  const fcmCollection = {
    where: vi.fn(() => fcmCollection),
    get: vi.fn(async () => ({
      docs: (opts.tokens ?? []).map((id) => ({
        id,
        data: () => ({ uid: 'u1', token: id }),
      })),
    })),
    doc: (id: string) => docMock(`fcm_tokens/${id}`),
  } as any;

  const db = {
    doc: (path: string) => docMock(path),
    collection: (path: string) => {
      if (path === 'fcm_tokens') return fcmCollection;
      return { doc: (id: string) => docMock(`${path}/${id}`) };
    },
  };

  return { db, deletes, updates };
}

describe('sendPushChannel', () => {
  it('renders + multicasts to all uid tokens; returns first successful message id', async () => {
    const ctx = buildPushDbMock({
      template: { title: 'Hi {{name}}', body: '{{msg}}', dataRoute: '/kc/{{id}}' },
      tokens: ['t1', 't2'],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 2,
      failureCount: 0,
      responses: [
        { success: true, messageId: 'm-1' },
        { success: true, messageId: 'm-2' },
      ],
    });

    const res = await sendPushChannel({
      def: def(),
      recipientUid: 'u1',
      data: { name: 'Sam', msg: 'hi', id: 'kc123' },
    });

    expect(res.providerMessageId).toBe('m-1');
    const call = mocks.multicast.mock.calls[0]![0];
    expect(call.tokens).toEqual(['t1', 't2']);
    expect(call.notification).toEqual({ title: 'Hi Sam', body: 'hi' });
    expect(call.data).toEqual({ notificationKey: 't.k', route: '/kc/kc123' });
  });

  it('#2093: a quote with no Kin still reads whole in a push template stored before re-import', async () => {
    const push = async (template: { title: string; body: string }) => {
      const ctx = buildPushDbMock({ template, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockReset();
      mocks.multicast.mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true, messageId: 'm' }] });
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: { kinName: '', quoteHouseholdKinNames: 'Rex, Mo' } });
      return mocks.multicast.mock.calls[0]![0].notification as { title: string; body: string };
    };
    expect(await push({ title: 'Quote accepted', body: "You're all set for {{kinName}}'s care." })).toEqual({
      title: 'Quote accepted',
      body: "You're all set for Rex, Mo's care.",
    });
    expect(await push({ title: 'Quote accepted', body: "You're all set{{#if kinName}} for {{kinName}}'s care{{/if}}." })).toEqual({
      title: 'Quote accepted',
      body: "You're all set.",
    });
  });

  it('prunes invalid tokens reported by FCM', async () => {
    const ctx = buildPushDbMock({
      template: { title: 't', body: 'b' },
      tokens: ['live', 'dead'],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true, messageId: 'ok' },
        { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'gone' } },
      ],
    });
    await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(ctx.deletes).toContain('fcm_tokens/dead');
    expect(ctx.deletes).not.toContain('fcm_tokens/live');
  });

  it('throws when all sends fail', async () => {
    const ctx = buildPushDbMock({
      template: { title: 't', body: 'b' },
      tokens: ['t1'],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: { code: 'messaging/internal-error', message: 'oops' } }],
    });
    await expect(
      sendPushChannel({ def: def(), recipientUid: 'u1', data: {} }),
    ).rejects.toThrow(/all 1 sends failed/);
  });

  it('throws when recipient has no tokens', async () => {
    const ctx = buildPushDbMock({
      template: { title: 't', body: 'b' },
      tokens: [],
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      sendPushChannel({ def: def(), recipientUid: 'u1', data: {} }),
    ).rejects.toThrow(/no registered fcm tokens/);
  });

  it('sends GENERIC wording when the template has no body, rather than throwing', async () => {
    const ctx = buildPushDbMock({ template: { title: 't' }, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'm1' }],
    });
    const res = await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res.usedFallback).toBe(true);
    expect(res.fallbackReason).toBe('pushTemplates/t.k');
    expect(mocks.multicast.mock.calls[0]![0].notification).toEqual({
      title: 'An update about your care',
      body: 'Tap to see it.',
    });
  });
  it('sends GENERIC wording when the template document does not exist', async () => {
    // The whole point: a new catalog key must not be dead in prod until someone
    // writes public-facing copy, and mass-deleting the template set must not
    // take the notification system down.
    const ctx = buildPushDbMock({ template: null, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'm1' }],
    });
    const res = await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res.usedFallback).toBe(true);
    expect(mocks.multicast.mock.calls[0]![0].notification.title).toBe('An update about your care');
  });
  it('#2251: sends GENERIC wording when the stored wording cannot be filled in, rather than throwing', async () => {
    const ctx = buildPushDbMock({ template: { title: '{{#if isQuote}}Quote', body: 'Ready' }, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true, messageId: 'm1' }] });
    const res = await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res).toEqual({ providerMessageId: 'm1', usedFallback: true, fallbackReason: 'pushTemplates/t.k' });
    expect(mocks.multicast.mock.calls[0]![0].notification).toEqual({ title: 'An update about your care', body: 'Tap to see it.' });
  });
  it('#2251: a stored route that cannot be filled in is dropped; good wording still goes as written', async () => {
    const ctx = buildPushDbMock({ template: { title: 'Hi', body: 'Ready', dataRoute: '/visits/{{#if id}}x' }, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({ successCount: 1, failureCount: 0, responses: [{ success: true, messageId: 'm1' }] });
    const res = await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res.usedFallback).toBeUndefined();
    const sent = mocks.multicast.mock.calls[0]![0];
    expect(sent.notification.title).toBe('Hi');
    expect(String(sent.data.route ?? '')).not.toContain('{{');
  });
  it('points an office-facing key at AuntieOS, not the household portal', async () => {
    const ctx = buildPushDbMock({ template: null, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'm1' }],
    });
    const res = await sendPushChannel({
      def: def({ audience: 'business', audiences: { business: true }, kinfolkFacing: false }),
      recipientUid: 'u1',
      data: {},
    });
    expect(res.usedFallback).toBe(true);
    expect(mocks.multicast.mock.calls[0]![0].notification.title).toBe('An update in AuntieOS');
  });
  it('does NOT flag a fallback when the template is fully authored', async () => {
    const ctx = buildPushDbMock({ template: { title: 'Hi', body: 'there' }, tokens: ['t1'] });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.multicast.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'm1' }],
    });
    const res = await sendPushChannel({ def: def(), recipientUid: 'u1', data: {} });
    expect(res.usedFallback).toBeUndefined();
    expect(mocks.multicast.mock.calls[0]![0].notification).toEqual({ title: 'Hi', body: 'there' });
  });
  describe('#2280: a household push is short and opens MyTribe', () => {
    const ok = { successCount: 1, failureCount: 0, responses: [{ success: true, messageId: 'm1' }] };
    const sent = () => mocks.multicast.mock.calls[0]![0] as { notification: { title: string; body: string }; data: Record<string, string> };
    const longNote = 'Please leave the side gate unlatched. '.repeat(14).trim();
    it('cuts a long line to 200 characters with an ellipsis and carries the notifications route', async () => {
      const ctx = buildPushDbMock({ template: { title: 'Care request declined', body: 'We could not take it. {{note}}' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: { note: longNote }, stream: 'kinfolk' });
      const { notification, data } = sent();
      expect(longNote.length).toBeGreaterThan(400);
      expect(notification.body.length).toBeLessThanOrEqual(200);
      expect(notification.body.endsWith('…')).toBe(true);
      expect(notification.body.startsWith('We could not take it. Please leave the side gate')).toBe(true);
      expect(data).toEqual({ notificationKey: 't.k', route: '/notifications' });
    });
    it('leaves a short line as written and still carries the route', async () => {
      const ctx = buildPushDbMock({ template: { title: 'Visit coming up', body: 'Tap for details.' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: {}, stream: 'kinfolk' });
      expect(sent().notification).toEqual({ title: 'Visit coming up', body: 'Tap for details.' });
      expect(sent().data['route']).toBe('/notifications');
    });
    it("keeps the template's own route when it names one", async () => {
      const ctx = buildPushDbMock({ template: { title: 'A', body: 'B', dataRoute: '/kincare/{{id}}' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: { id: 'v9' }, stream: 'kinfolk' });
      expect(sent().data['route']).toBe('/kincare/v9');
    });
    it('the generic wording for a missing template carries the route too', async () => {
      const ctx = buildPushDbMock({ template: null, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: {}, stream: 'kinfolk' });
      expect(sent().data['route']).toBe('/notifications');
    });
    it('#2259: opens the thing the notice is about, and carries its target for the Android app', async () => {
      const ctx = buildPushDbMock({ template: { title: 'Auntie has arrived', body: 'Tap for details.' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def(),
        recipientUid: 'u1',
        data: {},
        stream: 'kinfolk',
        open: { route: '/schedule/v1', data: { targetType: 'booking', targetId: 'v1', visitId: 'v1' } },
      });
      expect(sent().data).toEqual({
        notificationKey: 't.k',
        route: '/schedule/v1',
        targetType: 'booking',
        targetId: 'v1',
        visitId: 'v1',
      });
      // The wording and the short line are untouched.
      expect(sent().notification).toEqual({ title: 'Auntie has arrived', body: 'Tap for details.' });
    });
    it('#2259: a notice with nothing to open still lands on the notifications list', async () => {
      const ctx = buildPushDbMock({ template: { title: 'A', body: 'B' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({ def: def(), recipientUid: 'u1', data: {}, stream: 'kinfolk', open: { data: {} } });
      expect(sent().data).toEqual({ notificationKey: 't.k', route: '/notifications' });
    });
    it("#2259: the template's own route still wins over the target's", async () => {
      const ctx = buildPushDbMock({ template: { title: 'A', body: 'B', dataRoute: '/kintales' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def(),
        recipientUid: 'u1',
        data: {},
        stream: 'kinfolk',
        open: { route: '/schedule/v1', data: { targetType: 'booking', targetId: 'v1' } },
      });
      expect(sent().data['route']).toBe('/kintales');
    });
    it('#2259: target data can never replace the notification key or the route', async () => {
      const ctx = buildPushDbMock({ template: { title: 'A', body: 'B' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def(),
        recipientUid: 'u1',
        data: {},
        stream: 'kinfolk',
        open: { route: '/schedule/v1', data: { notificationKey: 'other.key', route: 'https://evil.example' } },
      });
      expect(sent().data).toEqual({ notificationKey: 't.k', route: '/schedule/v1' });
    });
    it.each(['business', 'staff'] as const)('#2100: a %s copy carries its target and still no route', async (stream) => {
      const ctx = buildPushDbMock({ template: { title: 'Visit changed', body: 'B' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def({ audience: 'both', audiences: { kinfolk: true, business: true } }),
        recipientUid: 'u1',
        data: {},
        stream,
        open: { data: { targetType: 'booking', targetId: 'v1', visitId: 'v1', kinfolkId: 'fam1' } },
      });
      expect(sent().data).toEqual({ notificationKey: 't.k', targetType: 'booking', targetId: 'v1', visitId: 'v1', kinfolkId: 'fam1' });
    });
    it.each(['business', 'staff', undefined] as const)('a %s copy is sent as written, with no route added', async (stream) => {
      const ctx = buildPushDbMock({ template: { title: 'Care request', body: '{{note}}' }, tokens: ['t1'] });
      mocks.dbFn.mockReturnValue(ctx.db);
      mocks.multicast.mockResolvedValue(ok);
      await sendPushChannel({
        def: def({ audience: 'both', audiences: { kinfolk: true, business: true } }),
        recipientUid: 'u1',
        data: { note: longNote },
        ...(stream ? { stream } : {}),
      });
      expect(sent().notification.body).toBe(longNote);
      expect(sent().data).toEqual({ notificationKey: 't.k' });
    });
    /**
     * #2368: the entry a cut push opens shows the rest of the message. The
     * sender keeps the message as rendered on that entry, before the push goes.
     */
    describe('the whole message is kept on the entry a cut push opens', () => {
      const visit = { route: '/schedule/v1', data: { targetType: 'booking', targetId: 'v1', visitId: 'v1', batchId: 'b1' } };
      const entry = { readInList: { route: '/notifications?entry=n1', entryId: 'n1' }, officeNote: false };
      async function send(
        template: { title: string; body: string },
        args: Record<string, unknown>,
        db: { updateFails?: Error } = {},
      ) {
        const order: string[] = [];
        const updates: Array<{ path: string; patch: Record<string, unknown> }> = [];
        const ctx = buildPushDbMock({ template, tokens: ['t1'], updates, ...db });
        mocks.dbFn.mockReturnValue(ctx.db);
        mocks.multicast.mockImplementation(async () => {
          order.push(`send after ${updates.length} update(s)`);
          return ok;
        });
        await sendPushChannel({ def: def(), recipientUid: 'u1', data: {}, stream: 'kinfolk', ...args } as never);
        return { updates, order };
      }
      it('a cut line writes the message as rendered onto its entry, one field, before the push is sent', async () => {
        const body = `We could not take it.\n\n{{note}}`;
        const { updates, order } = await send({ title: 'Declined', body }, { data: { note: longNote }, open: { ...visit, ...entry } });
        expect(updates).toEqual([
          { path: 'notifications/n1', patch: { householdMessage: `We could not take it.\n\n${longNote}` } },
        ]);
        expect(order).toEqual(['send after 1 update(s)']);
        expect(sent().notification.body.length).toBe(200);
        expect(sent().data['route']).toBe('/notifications?entry=n1');
      });
      it('keeps what was typed as typed: no escaping, no decoding, a tag stays text', async () => {
        const note = `O'Malley & Rex <b>loved</b> it, 5 > 3 &amp; all. ${'More words here. '.repeat(14)}`.trim();
        const { updates } = await send({ title: 'Declined', body: '{{note}}' }, { data: { note }, open: { ...visit, ...entry } });
        expect(updates[0]!.patch['householdMessage']).toBe(note);
      });
      it('a line that was not cut writes nothing, with or without the office note', async () => {
        expect((await send({ title: 'A', body: 'x'.repeat(200) }, { open: { ...visit, ...entry } })).updates).toEqual([]);
        mocks.multicast.mockClear();
        const noted = await send({ title: 'A', body: 'Tap for details.' }, { open: { ...visit, ...entry, officeNote: true } });
        expect(noted.updates).toEqual([]);
        expect(sent().data['route']).toBe('/notifications?entry=n1');
      });
      it('a work order that names no entry writes nothing and still opens the plain list', async () => {
        const { updates } = await send(
          { title: 'A', body: '{{note}}' },
          { data: { note: longNote }, open: { ...visit, readInList: { route: '/notifications' }, officeNote: false } },
        );
        expect(updates).toEqual([]);
        expect(sent().data['route']).toBe('/notifications');
      });
      it.each(['business', 'staff'] as const)('a %s copy is never written to, however long', async (stream) => {
        const { updates } = await send({ title: 'A', body: '{{note}}' }, { stream, data: { note: longNote }, open: { ...visit, ...entry } });
        expect(updates).toEqual([]);
      });
      it('a refused write is logged and the push still goes, opening the entry', async () => {
        const { order } = await send(
          { title: 'A', body: '{{note}}' },
          { data: { note: longNote }, open: { ...visit, ...entry } },
          { updateFails: new Error('5 NOT_FOUND: no entity to update') },
        );
        expect(order).toEqual(['send after 0 update(s)']);
        expect(sent().data['route']).toBe('/notifications?entry=n1');
      });
    });
    /**
     * Ruling 2026-11-14: the short line links to the full message. A cut line,
     * or a notice with the office's note on it, opens the notifications list at
     * its own entry; any other opens the thing it is about.
     */
    describe('where the tap lands when the full message is on the list', () => {
      const visit = { route: '/schedule/v1', data: { targetType: 'booking', targetId: 'v1', visitId: 'v1', batchId: 'b1' } };
      const list = { readInList: { route: '/notifications?entry=n1' } };
      async function send(template: { title: string; body: string; dataRoute?: string }, args: Record<string, unknown>) {
        mocks.dbFn.mockReturnValue(buildPushDbMock({ template, tokens: ['t1'] }).db);
        mocks.multicast.mockResolvedValue(ok);
        await sendPushChannel({ def: def(), recipientUid: 'u1', data: {}, stream: 'kinfolk', ...args } as never);
        return sent();
      }
      it('a cut line opens the list at its entry, and carries no target for the Android app to open instead', async () => {
        const { notification, data } = await send(
          { title: 'Care request declined', body: 'We could not take it. {{note}}' },
          { data: { note: longNote }, open: { ...visit, ...list, officeNote: false } },
        );
        expect(notification.body.endsWith('…')).toBe(true);
        expect(data).toEqual({ notificationKey: 't.k', route: '/notifications?entry=n1' });
      });
      it("a short line on a notice with the office's note opens the list at its entry", async () => {
        const { notification, data } = await send(
          { title: 'Booking confirmed', body: 'Tap for details.' },
          { open: { ...visit, ...list, officeNote: true } },
        );
        expect(notification.body).toBe('Tap for details.');
        expect(data).toEqual({ notificationKey: 't.k', route: '/notifications?entry=n1' });
      });
      it('a short line with no note opens the thing it is about', async () => {
        const { data } = await send(
          { title: 'Auntie has arrived', body: 'Tap for details.' },
          { open: { ...visit, ...list, officeNote: false } },
        );
        expect(data).toEqual({ notificationKey: 't.k', ...visit.data, route: '/schedule/v1' });
      });
      it('a line of exactly 200 characters was not cut, and one of 201 was', async () => {
        const at = await send({ title: 'A', body: 'x'.repeat(200) }, { open: { ...visit, ...list, officeNote: false } });
        expect(at.notification.body).toBe('x'.repeat(200));
        expect(at.data['route']).toBe('/schedule/v1');
        mocks.multicast.mockClear();
        const over = await send({ title: 'A', body: 'x'.repeat(201) }, { open: { ...visit, ...list, officeNote: false } });
        expect(over.notification.body.length).toBe(200);
        expect(over.data['route']).toBe('/notifications?entry=n1');
      });
      it('line breaks folded into spaces are not a cut', async () => {
        const body = `${'x'.repeat(99)}\n\n\n\n${'y'.repeat(99)}`;
        const { notification, data } = await send({ title: 'A', body }, { open: { ...visit, ...list, officeNote: false } });
        expect(notification.body).toBe(`${'x'.repeat(99)} ${'y'.repeat(99)}`);
        expect(data['route']).toBe('/schedule/v1');
      });
      it("the list wins over the template's own route too, when the line was cut", async () => {
        const { data } = await send(
          { title: 'A', body: '{{note}}', dataRoute: '/kintales' },
          { data: { note: longNote }, open: { ...visit, ...list, officeNote: false } },
        );
        expect(data).toEqual({ notificationKey: 't.k', route: '/notifications?entry=n1' });
      });
      it('a cut line with no entry to name opens the plain list', async () => {
        const { data } = await send(
          { title: 'A', body: '{{note}}' },
          { data: { note: longNote }, open: { ...visit, readInList: { route: '/notifications' }, officeNote: false } },
        );
        expect(data).toEqual({ notificationKey: 't.k', route: '/notifications' });
      });
      it.each(['business', 'staff'] as const)('a %s copy opens its target however long it is and whatever note it carries', async (stream) => {
        const office = { data: { targetType: 'booking', targetId: 'v1', visitId: 'v1', kinfolkId: 'fam1' } };
        const { notification, data } = await send(
          { title: 'Care request', body: '{{note}}' },
          // Even handed the household's fields by mistake, an office copy is never sent to the list.
          { stream, data: { note: longNote }, open: { ...office, ...list, officeNote: true } },
        );
        expect(notification.body).toBe(longNote);
        expect(data).toEqual({ notificationKey: 't.k', ...office.data });
      });
    });
  });
});
