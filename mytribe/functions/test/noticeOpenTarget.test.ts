import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));

import { householdNoticeEntryRoute, householdRouteFor, noticeOpenTarget } from '../src/notifications/noticeOpenTarget';
import { toNotificationListItem } from '../src/portal/listMyNotifications';
import { HOUSEHOLD_NOTE_KEYS, HOUSEHOLD_NOTICE_RULES } from '../src/notifications/buildNotificationDetail';

/**
 * #2259, #2100: a tap on a push opens what the notice is about. The route and
 * the target fields are built from the same work-order fields the
 * notifications list reads off the row, so the two cannot land apart.
 */

describe('noticeOpenTarget, a household copy (#2259)', () => {
  const household = (key: string, targetType: string, targetId: string, data: Record<string, unknown> = {}) =>
    noticeOpenTarget({ key, stream: 'kinfolk', data, targetType, targetId });

  it('a visit notice opens that visit', () => {
    const open = household('kincare.auntie.arrived', 'booking', 'v1', { visitId: 'v1', batchId: 'b1' });
    expect(open.route).toBe('/schedule/v1');
    expect(open.data).toEqual({ targetType: 'booking', targetId: 'v1', visitId: 'v1', batchId: 'b1' });
  });

  it('#1865: a notice about a whole request opens that request on the web and names it for Android', () => {
    const open = household('kincare.request.declined', 'booking', 'b7', { batchId: 'b7' });
    expect(open.route).toBe('/schedule/booking/b7');
    expect(open.data).toEqual({ targetType: 'booking', targetId: 'b7', batchId: 'b7' });
    const confirmed = household('kincare.booking.confirm', 'booking', 'b8', { kinfolkId: 'fam1', batchId: 'b8', bookingId: 'b8' });
    expect(confirmed.route).toBe('/schedule/booking/b8');
  });

  it('a booking notice that names neither a visit nor a request still opens Schedule', () => {
    expect(household('kincare.request.declined', 'booking', 'b7').route).toBe('/schedule');
  });

  it('#1865: a request id stays one path part', () => {
    expect(householdRouteFor('booking', '', '', '../account?x=1')).toBe('/schedule/booking/..%2Faccount%3Fx%3D1');
  });

  it('a KinTale notice opens that KinTale, and comments across several open the KinTales list', () => {
    expect(household('kintale.published', 'kintale', 't1').route).toBe('/kintales?tale=t1');
    const several = household('kintale.comment.added', '', '', { items: [{ taleId: 't1' }, { taleId: 't2' }] });
    expect(several.route).toBe('/kintales');
    expect(several.data).toEqual({ targetType: 'kintale' });
  });

  it('an invoice notice opens that invoice', () => {
    expect(household('invoice.new', 'invoice', 'inv1').route).toBe('/invoices/inv1');
    // The dispatcher resolved the household, the notice names the invoice in its data.
    expect(household('invoice.receipt', 'kinfolk', 'fam1', { invoiceId: 'inv2' }).route).toBe('/invoices/inv2');
  });

  it('a Kin notice opens the Kin, and one about a Kin no longer listed opens the Kin list', () => {
    expect(household('kin.removal.declined', 'kinfolk', 'fam1', { kinId: 'k1' }).route).toBe('/kin/k1');
    expect(household('kin.removal.archived', 'kinfolk', 'fam1', { kinId: 'k1' }).route).toBe('/kin');
  });

  it('a reply from the office opens Messages', () => {
    expect(household('message.reply', 'conversation', 'c1').route).toBe('/messages');
  });

  it('a notice that names nothing to open carries no route, so the sender falls back to the list', () => {
    expect(household('broadcast.message', 'kinfolk', 'fam1').route).toBeUndefined();
    expect(household('invoice.new', '', '').route).toBeUndefined();
  });

  it("never names the office's household record, whatever the dispatcher resolved", () => {
    for (const key of Object.keys(HOUSEHOLD_NOTICE_RULES)) {
      const open = household(key, 'kinfolk', 'fam1', { kinfolkId: 'fam1', requestId: 'r1', stripeEventId: 'evt_1' });
      expect(open.data['targetType'], key).not.toBe('kinfolk');
      expect(open.data['kinfolkId'], key).toBeUndefined();
      expect(open.data['requestId'], key).toBeUndefined();
      expect(open.data['stripeEventId'], key).toBeUndefined();
    }
  });

  it('opens what the same notice opens from the notifications list, for every household key', () => {
    const data = { visitId: 'v1', batchId: 'b1', invoiceId: 'inv1', taleId: 't1', kinId: 'k1' };
    for (const key of Object.keys(HOUSEHOLD_NOTICE_RULES)) {
      for (const [targetType, targetId] of [['booking', 'v1'], ['invoice', 'inv1'], ['kintale', 't1'], ['kinfolk', 'fam1'], ['', '']] as const) {
        const item = toNotificationListItem('n1', { key, data, targetType, targetId });
        const open = household(key, targetType, targetId, data);
        expect(open.data['targetType'] ?? '', `${key} ${targetType}`).toBe(item.targetType);
        expect(open.data['targetId'] ?? '', `${key} ${targetType}`).toBe(item.targetId);
        expect(open.route, `${key} ${targetType}`).toBe(
          householdRouteFor(item.targetType, item.targetId, item.visitId ?? '', item.batchId ?? ''),
        );
      }
    }
  });
});

describe('noticeOpenTarget, a route is always an in-app path', () => {
  it.each([
    ['https://evil.example/x', '/schedule/https%3A%2F%2Fevil.example%2Fx'],
    ['//evil.example', '/schedule/%2F%2Fevil.example'],
    ['../../account', '/schedule/..%2F..%2Faccount'],
    ['v1?redirect=/x#y', '/schedule/v1%3Fredirect%3D%2Fx%23y'],
    ['javascript:alert(1)', '/schedule/javascript%3Aalert(1)'],
  ])('an id of %s stays one path part', (visitId, route) => {
    const open = noticeOpenTarget({
      key: 'kincare.changed',
      stream: 'kinfolk',
      data: { visitId },
      targetType: 'booking',
      targetId: visitId,
    });
    expect(open.route).toBe(route);
    expect(new URL(open.route!, 'https://kinfolk.tribetails.com').origin).toBe('https://kinfolk.tribetails.com');
  });

  it('a KinTale id cannot add a second query key', () => {
    expect(householdRouteFor('kintale', 't1&tab=x', '')).toBe('/kintales?tale=t1%26tab%3Dx');
  });

  it('an unknown target type builds no route', () => {
    expect(householdRouteFor('kinfolk', 'fam1', '')).toBeUndefined();
    expect(householdRouteFor('https://evil.example', 'x', '')).toBeUndefined();
  });
});

describe('noticeOpenTarget, an office copy (#2100)', () => {
  it.each(['business', 'staff', undefined] as const)('a %s copy carries its target and no route', (stream) => {
    const open = noticeOpenTarget({
      key: 'kincare.changed',
      ...(stream ? { stream } : {}),
      data: { visitId: 'v1', batchId: 'b1', kinfolkId: 'fam1' },
      targetType: 'booking',
      targetId: 'v1',
    });
    expect(open.route).toBeUndefined();
    expect(open.data).toEqual({ targetType: 'booking', targetId: 'v1', visitId: 'v1', batchId: 'b1', kinfolkId: 'fam1' });
  });

  it('carries what Open reads for a Kin removal request and an unapplied payment', () => {
    expect(
      noticeOpenTarget({ key: 'kin.removal.requested', stream: 'business', data: { kinfolkId: 'fam1', requestId: 'r1' }, targetType: 'kinfolk', targetId: 'fam1' }).data,
    ).toEqual({ targetType: 'kinfolk', targetId: 'fam1', kinfolkId: 'fam1', requestId: 'r1' });
    expect(
      noticeOpenTarget({ key: 'invoice.payment.unapplied', stream: 'business', data: { familyId: 'fam1', stripeEventId: 'evt_1' }, targetType: 'invoice', targetId: 'inv1' }).data,
    ).toEqual({ targetType: 'invoice', targetId: 'inv1', kinfolkId: 'fam1', stripeEventId: 'evt_1' });
  });

  it('a work order written before the target was stamped carries no target, and nothing invented', () => {
    expect(noticeOpenTarget({ key: 'kincare.changed', stream: 'business', data: {} })).toEqual({ data: {} });
  });

  it('every value is a string: a number id is its digits and anything else is left out', () => {
    const open = noticeOpenTarget({
      key: 'kincare.changed',
      stream: 'business',
      data: { visitId: 42, batchId: { nested: true }, kinfolkId: null },
      targetType: 'booking',
      targetId: 42,
    });
    expect(open.data).toEqual({ targetType: 'booking', targetId: '42', visitId: '42' });
  });
});

/**
 * Operator ruling 2026-11-14 (#2030): a household's push is a short line with
 * a way to the full message. When the line was cut, or the office wrote a note
 * on the notice, the full message is the notice's entry on the notifications
 * list. This file says where that is; the push sender decides whether to use it.
 */
describe('noticeOpenTarget, where a household reads the whole message', () => {
  const household = (key: string, data: Record<string, unknown>, notificationId?: unknown) =>
    noticeOpenTarget({ key, stream: 'kinfolk', data, targetType: 'booking', targetId: 'b1', notificationId });
  it('names the notifications list at the entry the work order is for', () => {
    expect(household('kincare.auntie.arrived', { visitId: 'v1' }, 'n1').readInList).toEqual({
      route: '/notifications?entry=n1',
      // #2368: the entry the push sender keeps the whole message on.
      entryId: 'n1',
    });
  });
  it('a work order with no entry id names the plain list', () => {
    expect(household('kincare.auntie.arrived', { visitId: 'v1' }).readInList).toEqual({ route: '/notifications' });
    expect(household('kincare.auntie.arrived', { visitId: 'v1' }, '   ').readInList).toEqual({ route: '/notifications' });
    expect(household('kincare.auntie.arrived', { visitId: 'v1' }, { id: 'n1' }).readInList).toEqual({ route: '/notifications' });
  });
  it.each([
    ['n1&tab=x', '/notifications?entry=n1%26tab%3Dx'],
    ['n1#frag', '/notifications?entry=n1%23frag'],
    ['../../account', '/notifications?entry=..%2F..%2Faccount'],
    ['https://evil.example', '/notifications?entry=https%3A%2F%2Fevil.example'],
  ])('an entry id of %s cannot add a path part, a second query key or another site', (id, route) => {
    expect(householdNoticeEntryRoute(id)).toBe(route);
    const url = new URL(route, 'https://kinfolk.tribetails.com');
    expect(url.origin).toBe('https://kinfolk.tribetails.com');
    expect(url.pathname).toBe('/notifications');
    expect([...url.searchParams.keys()]).toEqual(['entry']);
    expect(url.searchParams.get('entry')).toBe(id);
  });
  it.each([...HOUSEHOLD_NOTE_KEYS])("%s with the office's note on it is flagged", (key) => {
    expect(household(key, { note: 'We are away that week.' }, 'n1').officeNote).toBe(true);
  });
  it.each([...HOUSEHOLD_NOTE_KEYS])('%s with no note, or a blank one, is not flagged', (key) => {
    expect(household(key, {}, 'n1').officeNote).toBe(false);
    expect(household(key, { note: '   ' }, 'n1').officeNote).toBe(false);
    expect(household(key, { note: null }, 'n1').officeNote).toBe(false);
  });
  it("a `note` on any other notice is not the office's note to the household", () => {
    expect(household('kincare.auntie.arrived', { note: 'gate code 1234' }, 'n1').officeNote).toBe(false);
    expect(household('kincare.changed', { note: 'staff note' }, 'n1').officeNote).toBe(false);
  });
  it.each(['business', 'staff', undefined] as const)('a %s copy always opens its target: it is offered no list', (stream) => {
    const open = noticeOpenTarget({
      key: 'kincare.request.declined',
      ...(stream ? { stream } : {}),
      data: { batchId: 'b1', note: 'We are away that week.' },
      targetType: 'booking',
      targetId: 'b1',
      notificationId: 'n1',
    });
    expect(open.readInList).toBeUndefined();
    expect(open.officeNote).toBeUndefined();
    expect(open.data['targetType']).toBe('booking');
  });
});
