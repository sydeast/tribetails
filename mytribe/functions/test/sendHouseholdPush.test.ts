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
import { toNotificationListItem } from '../src/portal/listMyNotifications';

/**
 * #2061: an approved Push draft for one household is sent, or the screen is
 * told exactly why not. The send gate and the household's own settings apply.
 */

const ACTIVE_PRIMARY = { role: 'PRIMARY', status: 'ACTIVE' };
/** The approved Push draft the office is sending, written for fam1 (generate.js spelling). */
const DRAFT = { communication_type: 'push', kinfolk_id: 'fam1', status: 'approved', generated_copy: 'Biscuit had a great walk today.' };
const draftPath = 'generated_drafts/draft1';
const HOUSEHOLD = {
  [draftPath]: DRAFT,
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
      data: { notificationKey: 'message.reply', route: '/notifications' },
    });
    const notice = ctx.writes.find((w) => w.path === noticePath);
    expect(notice?.data).toMatchObject({
      key: 'message.reply',
      recipientUid: 'uid_kin',
      description: 'Biscuit had a great walk today.',
      householdLine: 'Biscuit had a great walk today.',
      targetType: 'kinfolk',
      targetId: 'fam1',
    });
  });

  it('SAD: the send gate is shut, so nothing is written or pushed and the reason says so', async () => {
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, 'business_settings/business_settings': { householdNotificationsLive: false } });

    const res = await sendHouseholdPushHandler(req());

    expect(res).toEqual({ ok: true, outcome: 'held', reason: 'household_notices_off' });
    expect(mocks.multicast).not.toHaveBeenCalled();
    // Nothing for the household; the draft remembers the answer (#2293).
    expect(ctx.writes.map((w) => w.path)).toEqual([draftPath]);
    expect(ctx.docs[draftPath]).toMatchObject({ pushOutcome: 'held', pushReason: 'household_notices_off' });
  });

  it('SAD: the gate absent (the pre-launch default) holds the push too', async () => {
    seed({ ...HOUSEHOLD, ...PUSH_ON, 'business_settings/business_settings': { businessName: 'The Office' } });
    expect((await sendHouseholdPushHandler(req())).reason).toBe('household_notices_off');
    expect(mocks.multicast).not.toHaveBeenCalled();
  });

  it('SAD: a household nobody has signed in to is named first, before the gate', async () => {
    const ctx = seed({ [draftPath]: DRAFT, 'kinfolk/fam1': { firstName: 'Test' }, 'business_settings/business_settings': { householdNotificationsLive: false } });
    const res = await sendHouseholdPushHandler(req());
    expect(res).toEqual({ ok: true, outcome: 'held', reason: 'household_has_no_portal_account' });
    expect(ctx.writes.map((w) => w.path)).toEqual([draftPath]);
  });

  it('SAD: the operator turned household message notices off, so nothing is written', async () => {
    const ctx = seed({
      ...HOUSEHOLD,
      ...PUSH_ON,
      'businessSettings/notifications': { byKey: { 'message.reply': { enabled: false } } },
    });
    const res = await sendHouseholdPushHandler(req());
    expect(res).toEqual({ ok: true, outcome: 'held', reason: 'notice_turned_off' });
    expect(ctx.writes.map((w) => w.path)).toEqual([draftPath]);
    expect(mocks.multicast).not.toHaveBeenCalled();
  });

  it('SAD: the household keeps push off (the default), so it is listed and not pushed', async () => {
    const ctx = seed({ ...HOUSEHOLD });
    const res = await sendHouseholdPushHandler(req());
    expect(res).toEqual({ ok: true, outcome: 'listed', reason: 'household_push_off' });
    expect(mocks.multicast).not.toHaveBeenCalled();
    // The notice, its pushOutcome stamp, and the draft's: nothing else is written.
    expect([...new Set(ctx.writes.map((w) => w.path))]).toEqual([noticePath, draftPath]);
    expect(ctx.docs[draftPath]).toMatchObject({ pushOutcome: 'listed', pushReason: 'household_push_off' });
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
  it('HAPPY: the household reads the words on their notifications list, push on or off', async () => {
    // The list draws a household row through `toNotificationListItem`. A
    // `message.reply` row with no line of its own showed the title alone.
    const ctx = seed({ ...HOUSEHOLD, 'business_settings/business_settings': { householdNotificationsLive: true, businessName: 'The Office' } });
    const res = await sendHouseholdPushHandler(req());
    expect(res).toEqual({ ok: true, outcome: 'listed', reason: 'household_push_off' });
    const notice = ctx.writes.find((w) => w.path === noticePath);
    const row = toNotificationListItem(householdPushNoticeId('draft1'), notice!.data as Record<string, unknown>, 'The Office');
    expect(row.title).toBe('New message from The Office');
    expect(row.description).toBe('Biscuit had a great walk today.');
  });
  it('HAPPY: a long message is pushed short, opens the notifications list, and is whole on that list', async () => {
    const long = `${'Biscuit had a great walk today. '.repeat(20)}See you Friday.`;
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, 'business_settings/business_settings': { householdNotificationsLive: true } });
    const res = await sendHouseholdPushHandler(req({ body: long }));
    expect(res.outcome).toBe('sent');
    const sent = mocks.multicast.mock.calls[0]![0];
    expect(sent.notification.body.length).toBe(200);
    expect(sent.notification.body.endsWith('…')).toBe(true);
    expect(long.startsWith(sent.notification.body.slice(0, -1))).toBe(true);
    expect(sent.data.route).toBe('/notifications');
    const notice = ctx.writes.find((w) => w.path === noticePath);
    expect((notice!.data as Record<string, unknown>)['householdLine']).toBe(long);
  });
  it('NEGATIVE: markup never reaches the lock screen', async () => {
    seed({ ...HOUSEHOLD, ...PUSH_ON });
    await sendHouseholdPushHandler(req({ body: '<b>Hi</b> there' }));
    expect(mocks.multicast.mock.calls[0]![0].notification.body).toBe('Hi there');
  });

  it("#2321: an apostrophe, an ampersand and a quote mark reach the phone and the list as typed", async () => {
    const typed = `O'Malley & Sue said "see you Friday"`;
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, 'business_settings/business_settings': { householdNotificationsLive: true } });
    const res = await sendHouseholdPushHandler(req({ body: typed, title: "Bob & Sue's Auntie" }));
    expect(res.outcome).toBe('sent');
    expect(mocks.multicast.mock.calls[0]![0].notification).toEqual({ title: "Bob & Sue's Auntie", body: typed });
    const notice = ctx.writes.find((w) => w.path === noticePath);
    expect((notice!.data as Record<string, unknown>)['householdLine']).toBe(typed);
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
describe('sendHouseholdPush checks its draft (#2295)', () => {
  const LIVE = { 'business_settings/business_settings': { householdNotificationsLive: true } };
  async function refused(draft: Record<string, unknown> | null, code: string, data: Record<string, unknown> = {}) {
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, ...LIVE, [draftPath]: draft });
    await expect(sendHouseholdPushHandler(req(data))).rejects.toMatchObject({ code });
    // A refusal leaves nothing behind: no notice, no push, no write of any kind.
    expect(ctx.writes).toEqual([]);
    expect(ctx.docs[noticePath]).toBeUndefined();
    expect(mocks.multicast).not.toHaveBeenCalled();
  }
  it('NEGATIVE: refuses a draft written for another household', async () => {
    await refused({ ...DRAFT, kinfolk_id: 'fam2' }, 'permission-denied');
  });
  it('NEGATIVE: refuses a draft written for another household in the older spelling', async () => {
    await refused({ communication_type: 'push', kinfolkId: 'fam2', status: 'approved' }, 'permission-denied');
  });
  it('NEGATIVE: refuses a draft whose two household fields disagree', async () => {
    await refused({ ...DRAFT, kinfolkId: 'fam2' }, 'permission-denied');
  });
  it('NEGATIVE: refuses a draft with no household on it', async () => {
    await refused({ ...DRAFT, kinfolk_id: '' }, 'permission-denied');
  });
  it('NEGATIVE: refuses a draft that is not there', async () => {
    await refused(null, 'not-found');
  });
  it('NEGATIVE: refuses a draft that is not a push', async () => {
    await refused({ ...DRAFT, communication_type: 'visit_report' }, 'failed-precondition');
  });
  /** Types that are not exactly `push`. */
  const NOT_EXACTLY_PUSH: unknown[] = [
    'Push', 'PUSH', ' push', 'push ', 'push\t', '\u00a0push', 'push\u2028', '\u3000push', '\ufeffpush', '', 7, null,
  ];
  it('NEGATIVE: refuses a draft whose type is not exactly push, in either spelling', async () => {
    const { communication_type: _dropped, ...rest } = DRAFT;
    for (const type of NOT_EXACTLY_PUSH) {
      await refused({ ...DRAFT, communication_type: type }, 'failed-precondition');
      await refused({ ...rest, communicationType: type }, 'failed-precondition');
    }
  });
  it('NEGATIVE: refuses a draft with no type on it', async () => {
    const { communication_type: _dropped, ...rest } = DRAFT;
    await refused(rest, 'failed-precondition');
  });
  it('NEGATIVE: refuses a draft whose two type fields disagree, whichever says push', async () => {
    await refused({ ...DRAFT, communicationType: 'visit_report' }, 'failed-precondition');
    await refused({ ...DRAFT, communication_type: 'visit_report', communicationType: 'push' }, 'failed-precondition');
    await refused({ ...DRAFT, communicationType: ' push' }, 'failed-precondition');
    await refused({ ...DRAFT, communicationType: '' }, 'failed-precondition');
  });
  it('HAPPY: both type fields saying push sends', async () => {
    seed({ ...HOUSEHOLD, ...PUSH_ON, ...LIVE, [draftPath]: { ...DRAFT, communicationType: 'push' } });
    expect((await sendHouseholdPushHandler(req())).outcome).toBe('sent');
  });
  it('NEGATIVE: refuses a push draft nobody approved', async () => {
    await refused({ ...DRAFT, status: 'generated' }, 'failed-precondition');
  });
  it('NEGATIVE: refuses a push draft whose status is not exactly approved', async () => {
    const { status: _dropped, ...rest } = DRAFT;
    await refused(rest, 'failed-precondition');
    for (const status of ['Approved', ' approved', 'approved\u00a0', true, null]) {
      await refused({ ...rest, status }, 'failed-precondition');
    }
  });
  it('HAPPY: the older camelCase spelling of the same household sends', async () => {
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, ...LIVE, [draftPath]: { communicationType: 'push', kinfolkId: 'fam1', status: 'approved' } });
    expect((await sendHouseholdPushHandler(req())).outcome).toBe('sent');
    expect(ctx.docs[draftPath]).toMatchObject({ pushOutcome: 'sent', pushReason: '' });
  });
  it('HAPPY: the notice names the draft it was sent from', async () => {
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, ...LIVE });
    await sendHouseholdPushHandler(req());
    expect(ctx.docs[noticePath]).toMatchObject({ data: { kinfolkId: 'fam1', draftId: 'draft1' } });
  });
  it('HAPPY (#2293): a held push is stamped held on its draft, then sent on a later try', async () => {
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, 'business_settings/business_settings': { householdNotificationsLive: false } });
    expect((await sendHouseholdPushHandler(req())).outcome).toBe('held');
    expect(ctx.docs[draftPath]).toMatchObject({ status: 'approved', pushOutcome: 'held', pushReason: 'household_notices_off' });
    expect(typeof ctx.docs[draftPath]!['pushAttemptedAt']).toBe('string');
    ctx.docs['business_settings/business_settings'] = { householdNotificationsLive: true };
    expect((await sendHouseholdPushHandler(req())).outcome).toBe('sent');
    expect(ctx.docs[draftPath]).toMatchObject({ pushOutcome: 'sent', pushReason: '' });
    // A third try finds it sent and the draft still reads sent, never null.
    expect((await sendHouseholdPushHandler(req())).outcome).toBe('already_sent');
    expect(ctx.docs[draftPath]).toMatchObject({ pushOutcome: 'sent', pushReason: '' });
  });
  it('ERROR: a draft stamp that fails never changes the answer', async () => {
    const ctx = seed({ ...HOUSEHOLD, ...PUSH_ON, ...LIVE });
    const realCollection = ctx.db.collection.bind(ctx.db);
    const refusedSet = vi.fn(async () => {
      throw new Error('write refused');
    });
    vi.spyOn(ctx.db, 'collection').mockImplementation(((name: string) => {
      const col = realCollection(name);
      if (name !== 'generated_drafts') return col;
      return {
        ...col,
        doc: (id: string) => {
          const ref = col.doc(id);
          return { ...ref, get: ref.get, set: refusedSet };
        },
      };
    }) as any);
    expect(await sendHouseholdPushHandler(req())).toEqual({ ok: true, outcome: 'sent', reason: null });
    expect(refusedSet).toHaveBeenCalledTimes(1);
    expect(ctx.docs[draftPath]!['pushOutcome']).toBeUndefined();
  });
});
