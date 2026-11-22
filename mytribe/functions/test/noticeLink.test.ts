import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ADMIN_URL,
  AUNTIE_REFUSED_SLUGS,
  OFFICE_NOTICE_LIST_PATH,
  noticeLink,
  officeRouteFor,
} from '../src/notifications/noticeLink';
import { noticeOpenTarget } from '../src/notifications/noticeOpenTarget';
import { PORTAL_URL } from '../src/notifications/visitDates';

/**
 * #2487: `{{link}}`, the address a notice's email button and text open.
 *
 * The office half is a copy of the admin client's Open (`notificationOpenRoute`
 * with `applicableNotificationActions`'s Auntie rules). The cases are shared
 * with the admin's own test (`auntieos-admin/src/lib/officeNoticeRoutes.test.ts`)
 * through one file, so a change to either side that the other does not make
 * is red on both.
 */
interface Case {
  name: string;
  entry: { key: string; targetType: string; targetId: string; data: Record<string, unknown> };
  auntie: boolean;
  path: string | null;
}
const CASES = (
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/officeNoticeRoutes.json'), 'utf8')) as { cases: Case[] }
).cases;

describe('officeRouteFor: the same place Open goes in AuntieOS', () => {
  it('has the shared cases', () => {
    expect(CASES.length).toBeGreaterThan(10);
  });
  for (const c of CASES) {
    it(c.name, () => {
      expect(officeRouteFor({ ...c.entry, auntie: c.auntie })).toBe(c.path ?? OFFICE_NOTICE_LIST_PATH);
    });
  }
});

function household(key: string, data: Record<string, unknown>, targetType: string, targetId: string): string {
  const open = noticeOpenTarget({ key, stream: 'kinfolk', data, targetType, targetId, notificationId: 'n1' });
  return noticeLink({ key, stream: 'kinfolk', data, targetType, targetId, open });
}

describe("noticeLink: a household's copy opens its item in MyTribe", () => {
  it('a visit', () => {
    expect(household('kincare.auntie.arrived', { kinfolkId: 'fam1', visitId: 'v1' }, 'booking', 'v1')).toBe(
      `${PORTAL_URL}/schedule/v1`,
    );
  });

  it('#1865: a whole booking request, the confirmation the household gets when it is approved', () => {
    expect(
      household('kincare.booking.confirm', { kinfolkId: 'fam1', batchId: 'b1', bookingId: 'b1' }, 'booking', 'b1'),
    ).toBe(`${PORTAL_URL}/schedule/booking/b1`);
  });

  it('a KinTale', () => {
    expect(household('kintale.published', { kinfolkId: 'fam1', taleId: 't1' }, 'kintale', 't1')).toBe(
      `${PORTAL_URL}/kintales?tale=t1`,
    );
  });
  it('an invoice', () => {
    expect(household('invoice.new', { kinfolkId: 'fam1', invoiceId: 'i1' }, 'invoice', 'i1')).toBe(
      `${PORTAL_URL}/invoices/i1`,
    );
  });
  it('a message', () => {
    expect(household('message.reply', { kinfolkId: 'fam1' }, 'conversation', 'fam1')).toBe(`${PORTAL_URL}/messages`);
  });
  it('a notice that names nothing to open links to its own entry on the notifications list', () => {
    expect(household('auth.account.locked', {}, '', '')).toBe(`${PORTAL_URL}/notifications?entry=n1`);
  });
  it("never the office's household record, whatever the dispatcher stamped", () => {
    const link = household('profile.updated', { kinfolkId: 'fam1' }, 'kinfolk', 'fam1');
    expect(link.startsWith(`${PORTAL_URL}/`)).toBe(true);
    expect(link).not.toContain('directory');
  });
  it('an id cannot add a path part, a query key or another site', () => {
    const link = household('invoice.new', { kinfolkId: 'fam1', invoiceId: '../x?y=1&https://evil' }, 'invoice', '../x?y=1&https://evil');
    expect(new URL(link).origin).toBe(PORTAL_URL);
    expect(new URL(link).pathname.split('/').filter((p) => p !== '')).toHaveLength(2);
    expect(new URL(link).search).toBe('');
  });
});

describe("an Auntie's refused screens are the admin's owner-only screens", () => {
  it('AUNTIE_REFUSED_SLUGS is exactly the ownerOnly slugs of auntieos-admin/src/lib/nav.ts', () => {
    const nav = readFileSync(resolve(__dirname, '../../../auntieos-admin/src/lib/nav.ts'), 'utf8');
    const ownerOnly = new Set<string>();
    // One nav entry per `{ ... }`; the ones marked ownerOnly name their slug.
    for (const m of nav.matchAll(/\{[^{}]*?\bslug:\s*'([^']+)'[^{}]*?\}/g)) {
      if (/\bownerOnly:\s*true\b/.test(m[0])) ownerOnly.add(m[1]!);
    }
    expect(ownerOnly.size).toBeGreaterThan(5);
    expect([...AUNTIE_REFUSED_SLUGS].sort()).toEqual([...ownerOnly].sort());
  });
});

describe("noticeLink: an office or Auntie copy opens its item in AuntieOS", () => {
  it("the office's copy", () => {
    expect(
      noticeLink({ key: 'invoice.new', stream: 'business', data: { kinfolkId: 'fam1' }, targetType: 'invoice', targetId: 'i1' }),
    ).toBe(`${ADMIN_URL}/invoices?invoiceId=i1`);
  });
  it("an Auntie's copy of an owner-only screen links to her notifications list", () => {
    expect(
      noticeLink({ key: 'invoice.new', stream: 'staff', auntie: true, data: { kinfolkId: 'fam1' }, targetType: 'invoice', targetId: 'i1' }),
    ).toBe(`${ADMIN_URL}${OFFICE_NOTICE_LIST_PATH}`);
  });
  it("the owner's copy on the staff stream is still the owner's: it opens the invoice", () => {
    expect(
      noticeLink({ key: 'invoice.new', stream: 'staff', data: { kinfolkId: 'fam1' }, targetType: 'invoice', targetId: 'i1' }),
    ).toBe(`${ADMIN_URL}/invoices?invoiceId=i1`);
  });
  it('a work order with no stream stamped is treated as the office, never as a household', () => {
    expect(noticeLink({ key: 'kincare.cancel.requested', data: {}, targetType: 'booking', targetId: 'v1' })).toBe(
      `${ADMIN_URL}/bookings?bookingId=vis_v1`,
    );
  });
  it('an older row that stored a number id reads it as its digits', () => {
    expect(noticeLink({ key: 'invoice.new', stream: 'business', data: {}, targetType: 'invoice', targetId: 42 })).toBe(
      `${ADMIN_URL}/invoices?invoiceId=42`,
    );
  });
});
