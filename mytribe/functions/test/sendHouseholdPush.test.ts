import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  getAdmin: vi.fn(),
  multicast: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: mocks.getAdmin }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { ...actual.FieldValue, serverTimestamp: () => '__TS__' } };
});

import { sendHouseholdPushHandler, householdPushNoticeId } from '../src/admin/sendHouseholdPush';

/**
 * #2061: an approved Push draft for one household is sent, or the screen is
 * told exactly why not. The send gate and the household's own settings apply.
 */

const ACTIVE_PRIMARY = { role: 'PRIMARY', status: 'ACTIVE' };
const HOUSEHOLD = {
  'kinfolk/fam1': { uid: 'uid_kin', firstName: 'Test', lastName: 'One' },
  'families/fam1/members/uid_kin': ACTIVE_PRIMARY,
};
/** The household opted in to pushes for messages from the business. */
const PUSH_ON = { 'clients/uid_kin': { notificationPrefs: { byKey: { 'message.reply': { push: true } } } } };
const TOKENS = { fcm_tokens: [{ id: 'tok-1', data: { uid: 'uid_kin' } }] };

function req(data: Record<string, unknown> = {}, uid: string | null = 'uid_admin'): CallableRequest<unknown> {
  return {
    data: { kinfolkId: 'fam1', draftId: 'draft1', body: 'Biscuit had a great walk today.', ...data },
    auth: uid ? { uid, token: { admin: true } as any } : undefined,
    rawRequest: {} as any,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(docs: Record<string, Record<string, unknown> | null>, queryDocs: Record<string, any[]> = TOKENS) {
  const store: Record<string, Record<string, unknown> | null> = { ...docs };
  const ctx = buildDbMock({ docs: store, queryDocs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ...ctx, docs: store };
}

const noticePath = `notifications/${householdPushNoticeId('draft1')}`;

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.multicast.mockReset().mockResolvedValue({ successCount: 1, responses: [{ success: true, messageId: 'fcm-1' }] });
  mocks.getAdmin.mockReset().mockReturnValue({ messaging: () => ({ sendEachForMulticast: mocks.multicast }) });
});

describe('sendHouseholdPush (#2061)', () => {
  it('HAPPY: pushes the approved line to the household and puts it on their notifications list', async () => {
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, 'business_settings/business_settings': { householdNotificationsLive: true, businessName: 'The Office' } });

    const res = await sendHouseholdPushHandler(req());

    expect(res).toEqual({ ok: true, outcome: 'sent', reason: null });
    expect(mocks.multicast).toHaveBeenCalledWith({
      tokens: ['tok-1'],
      notification: { title: 'The Office', body: 'Biscuit had a great walk today.' },
      data: { notificationKey: 'message.reply' },
    });
    const notice = ctx.writes.find((w) => w.path === noticePath);
    expect(notice?.data).toMatchObject({
      key: 'message.reply',
      recipientUid: 'uid_kin',
      description: 'Biscuit had a great walk today.',
      targetType: 'kinfolk',
      targetId: 'fam1',
    });
  });

  it('SAD: the send gate is shut, so nothing is written or pushed and the reason says so', async () => {
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, 'business_settings/business_settings': { householdNotificationsLive: false } });

    const res = await sendHouseholdPushHandler(req());

    expect(res).toEqual({ ok: true, outcome: 'held', reason: 'household_notices_off' });
    expect(mocks.multicast).not.toHaveBeenCalled();
    expect(ctx.writes).toEqual([]);
  });

  it('SAD: the gate absent (the pre-launch default) holds the push too', async () => {
    seed({ ...HOUSEHOLD, ...PUSH_ON, 'business_settings/business_settings': { businessName: 'The Office' } });
    expect((await sendHouseholdPushHandler(req())).reason).toBe('household_notices_off');
    expect(mocks.multicast).not.toHaveBeenCalled();
  });

  it('SAD: a household nobody has signed in to is named first, before the gate', async () => {
    const ctx = seed({ 'kinfolk/fam1': { firstName: 'Test' }, 'business_settings/business_settings': { householdNotificationsLive: false } });
    const res = await sendHouseholdPushHandler(req());
    expect(res).toEqual({ ok: true, outcome: 'held', reason: 'household_has_no_portal_account' });
    expect(ctx.writes).toEqual([]);
  });

  it('SAD: the operator turned household message notices off, so nothing is written', async () => {
    const ctx = seed({
      ...HOUSEHOLD,
      ...PUSH_ON,
      'businessSettings/notifications': { byKey: { 'message.reply': { enabled: false } } },
    });
    const res = await sendHouseholdPushHandler(req());
    expect(res).toEqual({ ok: true, outcome: 'held', reason: 'notice_turned_off' });
    expect(ctx.writes).toEqual([]);
    expect(mocks.multicast).not.toHaveBeenCalled();
  });

  it('SAD: the household keeps push off (the default), so it is listed and not pushed', async () => {
    const ctx = seed({ ...HOUSEHOLD });
    const res = await sendHouseholdPushHandler(req());
    expect(res).toEqual({ ok: true, outcome: 'listed', reason: 'household_push_off' });
    expect(mocks.multicast).not.toHaveBeenCalled();
    // The notice, then its pushOutcome stamp: nothing else is written.
    expect([...new Set(ctx.writes.map((w) => w.path))]).toEqual([noticePath]);
  });

  it('SAD: no device signed in for push, so it is listed and not pushed', async () => {
    seed({ ...HOUSEHOLD, ...PUSH_ON }, {});
    expect(await sendHouseholdPushHandler(req())).toEqual({ ok: true, outcome: 'listed', reason: 'no_device' });
    expect(mocks.multicast).not.toHaveBeenCalled();
  });

  it('ERROR: every device refuses, so it says the push did not go through and prunes the dead token', async () => {
    mocks.multicast.mockResolvedValue({
      successCount: 0,
      responses: [{ success: false, error: { code: 'messaging/registration-token-not-registered' } }],
    });
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON });
    expect(await sendHouseholdPushHandler(req())).toEqual({ ok: true, outcome: 'listed', reason: 'push_failed' });
    expect(ctx.deletes).toContain('fcm_tokens/tok-1');
  });

  it('ERROR: the push service throwing is reported, never a crash', async () => {
    mocks.multicast.mockRejectedValue(new Error('fcm down'));
    seed({ ...HOUSEHOLD, ...PUSH_ON });
    expect(await sendHouseholdPushHandler(req())).toEqual({ ok: true, outcome: 'listed', reason: 'push_failed' });
  });

  it('NEGATIVE: a second attempt at the same draft pushes nothing new', async () => {
    seed({ ...HOUSEHOLD, ...PUSH_ON });
    expect((await sendHouseholdPushHandler(req())).outcome).toBe('sent');
    expect(await sendHouseholdPushHandler(req())).toEqual({ ok: true, outcome: 'already_sent', reason: null });
    expect(mocks.multicast).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: a push that did not go out is tried again on the next attempt, with no second notice', async () => {
    const ctx = seed({ ...HOUSEHOLD });
    expect(await sendHouseholdPushHandler(req())).toEqual({ ok: true, outcome: 'listed', reason: 'household_push_off' });
    expect(ctx.docs[noticePath]).toMatchObject({ pushOutcome: 'listed', pushReason: 'household_push_off' });
    // The household turns pushes on; the operator tries again.
    ctx.docs['clients/uid_kin'] = PUSH_ON['clients/uid_kin'];
    expect(await sendHouseholdPushHandler(req())).toEqual({ ok: true, outcome: 'sent', reason: null });
    expect(mocks.multicast).toHaveBeenCalledTimes(1);
    expect(ctx.writes.filter((w) => w.path === noticePath && w.merge === false)).toHaveLength(1);
    // And a third attempt, after it went out, sends nothing new.
    expect((await sendHouseholdPushHandler(req())).outcome).toBe('already_sent');
    expect(mocks.multicast).toHaveBeenCalledTimes(1);
  });
  it('NEGATIVE: markup never reaches the lock screen', async () => {
    seed({ ...HOUSEHOLD, ...PUSH_ON });
    await sendHouseholdPushHandler(req({ body: '<b>Hi</b> there' }));
    expect(mocks.multicast.mock.calls[0]![0].notification.body).toBe('Hi there');
  });

  it('NEGATIVE: refuses an unsigned caller, an empty line and a malformed draft id', async () => {
    seed({ ...HOUSEHOLD, ...PUSH_ON });
    await expect(sendHouseholdPushHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(sendHouseholdPushHandler(req({ body: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(sendHouseholdPushHandler(req({ body: '<p></p>' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(sendHouseholdPushHandler(req({ draftId: '../x' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(mocks.multicast).not.toHaveBeenCalled();
  });
});
