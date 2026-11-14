import { describe, it, expect, vi } from 'vitest';

/**
 * #1831, #1898, #1913: what a household notice says under its title, and what
 * a tap on it opens.
 *
 * The line used to be words about the KIND of notice: the operator's catalog
 * description ("Auntie en route to KinCare (optional ETA).") and, after #2239,
 * the Notification settings sentence ("When your Auntie arrives for a KinCare
 * visit."). It is now built from the notice's own facts. These tests walk the
 * catalog, so a household key added later without a line fails here.
 */

vi.mock('../src/lib/firestoreAdmin', () => ({ db: vi.fn(), auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';
import {
  HOUSEHOLD_NOTICE_RULES,
  householdNoticeLine,
  householdNoticeTarget,
  joinKinNames,
} from '../src/notifications/buildNotificationDetail';
import { toNotificationListItem } from '../src/portal/listMyNotifications';

/** Every fact any household key can carry, with ids and an email that must never be printed. */
const DETAIL = {
  kinfolkName: 'The Rivera Home',
  kinName: 'Rex, Mochi',
  serviceType: 'Drop-in visit',
  bookingDate: 'Tue, Nov 17',
  bookingTime: 'Midday (11 AM to 3 PM)',
  bookingDates: '4 visits, Nov 17 to Dec 8',
  taleTitle: 'A sunny walk',
  taleKinNames: 'Rex',
  lockedAt: 'Tue, Nov 17 at 3:15 PM',
  invoiceNumber: '1042',
  amount: '$120.00',
  dueDate: '2026-11-20',
  householdNote: 'Rex still has visits booked this month.',
};
const IDS = ['fam_9f2', 'kin_77a', 'vis_123', 'bat_456', 'inv_789', 'tale_abc', 'msg_1', 'uid_guest'];
const EMAIL = 'catch@hanasamku.com';
const DATA = {
  kinfolkId: 'fam_9f2',
  familyId: 'fam_9f2',
  kinId: 'kin_77a',
  visitId: 'vis_123',
  batchId: 'bat_456',
  invoiceId: 'inv_789',
  taleId: 'tale_abc',
  messageId: 'msg_1',
  kinName: 'Rex',
  preview: 'See you Tuesday! Rex can have two treats.',
  headline: 'Holiday hours',
  attemptsInWindow: 3,
  etaMinutes: 15,
  visitCount: 4,
  nextVisit: { weekday: 'Tue', date: 'Nov 17', time: 'Midday (11 AM to 3 PM)' },
  items: [{ taleId: 'tale_abc', taleTitle: 'A sunny walk', authorName: 'Jamie', authorUid: 'uid_guest' }],
  email: EMAIL,
  invitedEmail: EMAIL,
};
const BROADCAST_BODY = 'We are closed Thursday for the holiday.';

/** The line each household key reads with every fact present. */
const EXPECTED: Record<string, string> = {
  'kincare.booking.confirm': 'Drop-in visit for Rex and Mochi, 4 visits starting Tue, Nov 17 at Midday (11 AM to 3 PM)',
  'kincare.booking.cancel': 'Drop-in visit for Rex and Mochi on Tue, Nov 17 at Midday (11 AM to 3 PM)',
  'kincare.auntie.on_my_way':
    'Drop-in visit for Rex and Mochi on Tue, Nov 17 at Midday (11 AM to 3 PM), about 15 minutes away',
  'kincare.auntie.arrived': 'Drop-in visit for Rex and Mochi on Tue, Nov 17 at Midday (11 AM to 3 PM)',
  'kincare.auntie.departed': 'Drop-in visit for Rex and Mochi on Tue, Nov 17 at Midday (11 AM to 3 PM)',
  'kincare.unavailable': 'Drop-in visit for Rex and Mochi on Tue, Nov 17 at Midday (11 AM to 3 PM)',
  'kincare.changed': 'Drop-in visit for Rex and Mochi on Tue, Nov 17 at Midday (11 AM to 3 PM)',
  'kincare.cancel.declined': 'Drop-in visit for Rex and Mochi on Tue, Nov 17 at Midday (11 AM to 3 PM)',
  'kincare.request.declined': 'Drop-in visit for Rex and Mochi, 4 visits, Nov 17 to Dec 8',
  'kincare.upcoming.reminder': 'Drop-in visit for Rex and Mochi on Tue, Nov 17 at Midday (11 AM to 3 PM)',
  'kintale.published': '“A sunny walk” about Rex',
  'kintale.comment.added': 'Jamie commented on “A sunny walk”',
  'kintale.note.added': '“A sunny walk” about Rex',
  'invoice.new': 'Invoice 1042 for $120.00, due Nov 20, 2026',
  'invoice.updated': 'Invoice 1042 for $120.00',
  'invoice.receipt': 'Invoice 1042 for $120.00',
  'invoice.reminder': 'Invoice 1042 for $120.00, due Nov 20, 2026',
  'invoice.overdue': 'Invoice 1042 for $120.00, was due Nov 20, 2026',
  'invoice.charge.failed': 'Invoice 1042 for $120.00',
  'invoice.payment.applied': 'Invoice 1042',
  'quote.accepted': 'Quote 1042 for $120.00',
  'message.reply': 'See you Tuesday! Rex can have two treats.',
  'broadcast.message': BROADCAST_BODY,
  'pets.updated': "Changes to Rex's profile",
  'profile.updated': 'Household profile for The Rivera Home',
  'account.welcome.kinfolk': 'Your MyTribe account for The Rivera Home is ready',
  'auth.failedLogin.attempts': '3 failed sign-in attempts on your account',
  'auth.account.locked': 'Locked on Tue, Nov 17 at 3:15 PM',
  'kin.removal.archived': 'Rex is no longer on your profile',
  'kin.removal.declined': 'Rex is staying on your profile',
  'newsletter.announcement': 'Holiday hours',
  'survey.event': 'Holiday hours',
  'marketing.optin': 'Holiday hours',
};

/**
 * What a tap on each household key opens, with every id present. Spelled out
 * per key, not derived from the rule table, so a key given the wrong target
 * fails. Nothing to open: the sign-in warnings, the marketing blasts and a
 * broadcast, whose row holds the whole message.
 */
const EXPECTED_TARGET: Record<string, { targetType: string; targetId: string }> = {
  'kincare.booking.confirm': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.booking.cancel': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.auntie.on_my_way': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.auntie.arrived': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.auntie.departed': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.unavailable': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.changed': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.cancel.declined': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.request.declined': { targetType: 'booking', targetId: 'vis_123' },
  'kincare.upcoming.reminder': { targetType: 'booking', targetId: 'vis_123' },
  'kintale.published': { targetType: 'kintale', targetId: 'tale_abc' },
  'kintale.comment.added': { targetType: 'kintale', targetId: 'tale_abc' },
  'kintale.note.added': { targetType: 'kintale', targetId: 'tale_abc' },
  'invoice.new': { targetType: 'invoice', targetId: 'inv_789' },
  'invoice.updated': { targetType: 'invoice', targetId: 'inv_789' },
  'invoice.receipt': { targetType: 'invoice', targetId: 'inv_789' },
  'invoice.reminder': { targetType: 'invoice', targetId: 'inv_789' },
  'invoice.overdue': { targetType: 'invoice', targetId: 'inv_789' },
  'invoice.charge.failed': { targetType: 'invoice', targetId: 'inv_789' },
  'invoice.payment.applied': { targetType: 'invoice', targetId: 'inv_789' },
  'quote.accepted': { targetType: 'invoice', targetId: 'inv_789' },
  'message.reply': { targetType: 'conversation', targetId: 'fam_9f2' },
  'broadcast.message': { targetType: '', targetId: '' },
  'pets.updated': { targetType: 'kin', targetId: 'kin_77a' },
  'profile.updated': { targetType: 'household', targetId: '' },
  'account.welcome.kinfolk': { targetType: 'household', targetId: '' },
  'auth.failedLogin.attempts': { targetType: '', targetId: '' },
  'auth.account.locked': { targetType: '', targetId: '' },
  'kin.removal.archived': { targetType: 'kin', targetId: '' },
  'kin.removal.declined': { targetType: 'kin', targetId: 'kin_77a' },
  'newsletter.announcement': { targetType: '', targetId: '' },
  'survey.event': { targetType: '', targetId: '' },
  'marketing.optin': { targetType: '', targetId: '' },
};

const householdKeys = Object.values(NOTIFICATION_CATALOG)
  .filter((def) => def.audiences?.kinfolk === true)
  .map((def) => def.key);

function rowFor(key: string) {
  const rule = HOUSEHOLD_NOTICE_RULES[key]!;
  const targetType =
    rule.target === 'visit' || rule.target === 'request'
      ? 'booking'
      : rule.target === 'messages'
        ? 'conversation'
        : rule.target === 'invoice'
          ? 'invoice'
          : 'kinfolk';
  const targetId =
    targetType === 'booking' ? 'vis_123' : targetType === 'invoice' ? 'inv_789' : 'fam_9f2';
  return {
    key,
    recipientUid: 'uid_household',
    description: key === 'broadcast.message' ? BROADCAST_BODY : '',
    detail: DETAIL,
    data: DATA,
    targetType,
    targetId,
  };
}

describe('every household key has a content line and a target', () => {
  it('reads at least the 30 household keys off the catalog', () => {
    expect(householdKeys.length).toBeGreaterThanOrEqual(30);
  });

  it.each(householdKeys)('%s has a rule', (key) => {
    expect(HOUSEHOLD_NOTICE_RULES[key], `no household notice rule for ${key}`).toBeDefined();
  });

  it('has no rule for a key a household never receives', () => {
    for (const key of Object.keys(HOUSEHOLD_NOTICE_RULES)) {
      expect(householdKeys, `${key} is not a household key`).toContain(key);
    }
  });

  const listed = householdKeys.filter((k) => HOUSEHOLD_NOTICE_RULES[k]?.neverListed !== true);

  it.each(listed)('%s builds its line from the notice facts', (key) => {
    const line = householdNoticeLine(rowFor(key));
    expect(line).toBe(EXPECTED[key]);
    const def = NOTIFICATION_CATALOG[key]!;
    // Never the words about the kind of notice.
    expect(line).not.toBe(def.description);
    expect(line).not.toBe(def.householdDescription);
    // Never an id, an email, a template token or a developer note.
    for (const id of IDS) expect(line).not.toContain(id);
    expect(line).not.toContain('@');
    expect(line).not.toMatch(/\{\{|\}\}|debounce|optional ETA|comment box|visit report/i);
    expect(line).not.toContain('—');
  });

  it.each(listed)('%s opens its target', (key) => {
    expect(householdNoticeTarget(rowFor(key))).toEqual(EXPECTED_TARGET[key]);
  });

  it('marks only the password reset as never listed (it is sent straight to email)', () => {
    expect(householdKeys.filter((k) => HOUSEHOLD_NOTICE_RULES[k]?.neverListed === true)).toEqual([
      'auth.password.reset',
    ]);
  });
});

describe('a notice with fewer facts says less, never something wrong', () => {
  it('a visit with no Kin or KinCare still names when', () => {
    expect(
      householdNoticeLine({ key: 'kincare.auntie.arrived', detail: { bookingDate: 'Tue, Nov 17', bookingTime: '9:00 AM' } }),
    ).toBe('On Tue, Nov 17 at 9:00 AM');
  });

  it('a night still to be timed reads "start time to be set"', () => {
    expect(
      householdNoticeLine({
        key: 'kincare.changed',
        detail: { kinName: 'Rex', bookingDate: 'Fri, Nov 20', bookingTime: 'start time to be set' },
      }),
    ).toBe('Rex on Fri, Nov 20, start time to be set');
  });

  it('a one-visit confirmation reads as a visit', () => {
    expect(
      householdNoticeLine({
        key: 'kincare.booking.confirm',
        detail: { kinName: 'Rex', serviceType: 'Walk', bookingDate: 'Tue, Nov 17', bookingTime: '9:00 AM' },
        data: { visitCount: 1, nextVisit: { weekday: 'Tue', date: 'Nov 17', time: '9:00 AM' } },
      }),
    ).toBe('Walk for Rex on Tue, Nov 17 at 9:00 AM');
  });

  it('a quote has no due date and says quote', () => {
    expect(
      householdNoticeLine({
        key: 'invoice.new',
        detail: { invoiceNumber: '1026', amount: '$80.00', dueDate: '2026-11-20' },
        data: { isQuote: true },
      }),
    ).toBe('Quote 1026 for $80.00');
  });

  it('a paid invoice never claims it was for $0.00', () => {
    expect(householdNoticeLine({ key: 'invoice.receipt', detail: { invoiceNumber: '1042', amount: '$0.00' } })).toBe(
      'Invoice 1042',
    );
  });

  it('a digest names every commenter once, and "You" for the reader', () => {
    expect(
      householdNoticeLine({
        key: 'kintale.comment.added',
        recipientUid: 'me',
        data: {
          items: [
            { taleId: 't1', taleTitle: 'Park day', authorName: 'Jamie' },
            { taleId: 't1', taleTitle: 'Park day', authorName: 'Sam' },
            { taleId: 't1', taleTitle: 'Park day', authorName: 'Jamie' },
            { taleId: 't1', taleTitle: 'Park day', authorUid: 'me', authorName: 'Ana' },
          ],
        },
      }),
    ).toBe('Jamie, Sam and You commented on “Park day”');
  });

  it('a digest across tales counts them and opens the KinTales list', () => {
    const row = {
      key: 'kintale.comment.added',
      data: { items: [{ taleId: 't1', authorName: 'Jamie' }, { taleId: 't2', authorName: 'Jamie' }] },
    };
    expect(householdNoticeLine(row)).toBe('Jamie commented on 2 KinTales');
    expect(householdNoticeTarget(row)).toEqual({ targetType: 'kintale', targetId: '' });
  });

  it('a digest queued before names were carried counts the comments', () => {
    expect(
      householdNoticeLine({ key: 'kintale.comment.added', data: { items: [{ taleId: 't1' }, { taleId: 't1' }] } }),
    ).toBe('2 new comments on your KinTale');
  });

  it('a Kin removal declined with no Kin name says nothing rather than guess', () => {
    expect(householdNoticeLine({ key: 'kin.removal.declined', data: { kinId: 'k1' } })).toBe('');
  });

  it('joins Kin names the way a sentence does', () => {
    expect(joinKinNames('Rex')).toBe('Rex');
    expect(joinKinNames('Rex, Mochi')).toBe('Rex and Mochi');
    expect(joinKinNames(['Rex', 'Mochi', 'Pip', 'Rex'])).toBe('Rex, Mochi and Pip');
    expect(joinKinNames('')).toBe('');
  });
});

describe('the notifications list reads every row the household way, old ones too', () => {
  it('an August visit row stored with the operator wording shows the household title alone, and still opens its visit', () => {
    const item = toNotificationListItem('n1', {
      key: 'kincare.auntie.on_my_way',
      recipientUid: 'uid_household',
      title: 'Auntie on the way',
      description: 'Auntie en route to KinCare (optional ETA).',
      detail: { kinName: 'Rex', serviceType: 'Drop-in visit', bookingDate: 'Tue, Nov 10', bookingTime: '9:00 AM' },
      data: { familyId: 'fam1', batchId: 'b1', visitId: 'v1', bookingId: 'v1' },
      targetType: 'booking',
      targetId: 'v1',
    });
    expect(item.title).toBe('Your Auntie is on the way');
    // Title only: its stored words are the operator's, and its stored time
    // predates the Time Blocks rule, so no line is rebuilt from it.
    expect(item.description).toBe('');
    expect(item.targetType).toBe('booking');
    expect(item.visitId).toBe('v1');
  });

  it('an old row with no facts shows its title alone, never the stored template wording', () => {
    const item = toNotificationListItem('n2', {
      key: 'pets.updated',
      title: 'Pets updated or added',
      description: 'Kinfolk/Auntie updated or added Pets (30-min inactive debounce).',
      data: { kinfolkId: 'fam1' },
      targetType: 'kinfolk',
      targetId: 'fam1',
    });
    expect(item.title).toBe('Your Kin were updated');
    expect(item.description).toBe('');
  });

  it('a row under the retired alias reads its canonical key', () => {
    const item = toNotificationListItem('n3', {
      key: 'kincare.report.sent',
      title: 'KinTale (visit report) published',
      description: 'Your Auntie published a KinTale, the written report from a KinCare visit.',
      data: { taleId: 't9' },
      targetType: 'kintale',
      targetId: 't9',
    });
    expect(item.title).toBe('Your KinTale is ready');
    expect(item.description).toBe('');
    expect(item.targetType).toBe('kintale');
    expect(item.targetId).toBe('t9');
  });

  it('#1898: an old comment digest stored with no target opens the tale its comments are on', () => {
    const item = toNotificationListItem('n4', {
      key: 'kintale.comment.added',
      title: 'New comment on a KinTale (comment box)',
      description: 'Someone posted in the comment box under a KinTale. Collected into one message every 5 minutes.',
      data: { items: [{ taleId: 't9', commentId: 'c1' }], itemCount: 1 },
      targetType: '',
      targetId: '',
    });
    expect(item.title).toBe('New comment on your KinTale');
    expect(item.description).toBe('');
    expect(item.targetType).toBe('kintale');
    expect(item.targetId).toBe('t9');
  });

  it('#1913: a Kin removal declined row opens that Kin, and carries its line and the office note', () => {
    const item = toNotificationListItem('n5', {
      key: 'kin.removal.declined',
      title: 'Your Kin removal request was declined',
      description: 'Mochi is staying on your profile',
      householdLine: 'Mochi is staying on your profile',
      detail: { kinName: 'Mochi', householdNote: 'Mochi still has a visit booked.' },
      data: { kinfolkId: 'fam1', kinId: 'kin2', kinName: 'Mochi', note: 'Mochi still has a visit booked.' },
      targetType: 'kinfolk',
      targetId: 'fam1',
    });
    expect(item.description).toBe('Mochi is staying on your profile');
    expect(item.detail?.householdNote).toBe('Mochi still has a visit booked.');
    expect(item.targetType).toBe('kin');
    expect(item.targetId).toBe('kin2');
  });

  it('a broadcast keeps the subject and body the office wrote', () => {
    const item = toNotificationListItem('n6', {
      key: 'broadcast.message',
      title: 'Holiday hours',
      description: BROADCAST_BODY,
      data: { kinfolkId: 'fam1' },
    });
    expect(item.title).toBe('Holiday hours');
    expect(item.description).toBe(BROADCAST_BODY);
  });

  it('an old Kin removal row shows its title alone, and still opens the Kin', () => {
    const item = toNotificationListItem('n5b', {
      key: 'kin.removal.declined',
      title: 'Your Kin removal request was declined',
      description: 'The office declined to remove a Kin the household asked to remove.',
      data: { kinfolkId: 'fam1', kinId: 'kin2', kinName: 'Mochi' },
      targetType: 'kinfolk',
      targetId: 'fam1',
    });
    expect(item.description).toBe('');
    expect(item.targetType).toBe('kin');
    expect(item.targetId).toBe('kin2');
  });
  it('a long broadcast keeps its whole body, line breaks and all', () => {
    const body = `${'We are closed Thursday for the holiday. '.repeat(30)}\nSee you Friday.`;
    expect(body.length).toBeGreaterThan(1000);
    const item = toNotificationListItem('n6b', { key: 'broadcast.message', title: 'Holiday hours', description: body });
    expect(item.description).toBe(body.trim());
  });
  it('fills the business name into a household title that names it', () => {
    const item = toNotificationListItem(
      'n7',
      { key: 'message.reply', title: 'New message from the office', householdLine: 'Hi!', data: { preview: 'Hi!' }, targetType: 'conversation', targetId: 'fam1' },
      'Tribe Tails Pet Care',
    );
    expect(item.title).toBe('New message from Tribe Tails Pet Care');
    expect(item.description).toBe('Hi!');
  });

  it('leaves a row for a key a household does not receive as it was stored', () => {
    const item = toNotificationListItem('n8', {
      key: 'kincare.requested',
      title: 'KinCare requested',
      description: 'A household requested KinCare.',
      targetType: 'booking',
      targetId: 'b1',
    });
    expect(item.title).toBe('KinCare requested');
    expect(item.description).toBe('A household requested KinCare.');
  });
});
describe('#1831: the visit-step push, text and email name the Kin, and read whole without them', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Handlebars = require('handlebars') as typeof import('handlebars');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const seed = (key: string, file: string) =>
    readFileSync(`${__dirname}/../../seeds/notificationTemplates/${key}/${file}`, 'utf8');
  const render = (key: string, file: string, ctx: Record<string, unknown>) =>
    Handlebars.compile(seed(key, file))(ctx).trim();
  it('on the way: the KinCare, the Kin and the arrival estimate', () => {
    expect(render('kincare.auntie.on_my_way', 'push.txt', { serviceType: 'Drop-in visit', kinName: 'Rex', etaMinutes: 15 })).toBe(
      "Auntie is on the way. I'm headed over for your Drop-in visit with Rex, about 15 minutes out. See you soon.",
    );
    expect(render('kincare.auntie.on_my_way', 'sms.txt', { serviceType: 'Drop-in visit' })).toBe(
      "It's Auntie, on my way over for your Drop-in visit. See you shortly!",
    );
  });
  it('arrived and departed: the Kin when known, whole sentences when not', () => {
    expect(render('kincare.auntie.arrived', 'push.txt', { serviceType: 'Walk', kinName: 'Rex, Mochi' })).toBe(
      "Auntie has arrived. I'm here and starting your Walk with Rex, Mochi. Tap to follow along.",
    );
    expect(render('kincare.auntie.departed', 'sms.txt', { serviceType: 'Walk' })).toBe(
      "It's Auntie. All done with your Walk, everyone's settled and the house is locked up. KinTale coming soon!",
    );
    for (const key of ['kincare.auntie.on_my_way', 'kincare.auntie.arrived', 'kincare.auntie.departed']) {
      for (const file of ['push.txt', 'sms.txt', 'content.html']) {
        const text = render(key, file, { serviceType: 'Walk' });
        expect(text, `${key}/${file}`).not.toMatch(/\b(with|for)\s*[.,]|\{\{| {2}/);
      }
    }
  });
});
