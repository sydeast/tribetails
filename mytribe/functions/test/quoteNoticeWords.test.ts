import { describe, it, expect, vi, beforeEach } from 'vitest';
import Handlebars from 'handlebars';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2093 and the notice half of #2092: what a quote's notices say.
 *
 *   - The household's own copy of a notice is titled to its reader (#1372):
 *     "You accepted a quote", never "Kinfolk accepted a quote". The office's
 *     copy keeps the operator's label.
 *   - A quote's notice names the Kin on THAT quote, read from the visits it
 *     holds, and no Kin when it holds none. It never falls back to the
 *     household's whole roster.
 *   - `invoice.new` sending a quote says "quote", and promises no due date.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

import { noticeTitleFor } from '../src/notifications/dispatcher';
import { getNotificationDef } from '../src/notifications/catalog';
import { enrichTemplateData } from '../src/notifications/enrichTemplateData';
import { buildNotificationDetail } from '../src/notifications/buildNotificationDetail';
import { SEED_CORPUS } from '../src/notifications/seedCorpus.generated';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

/** A household with four Kin on its roster, and a quote that holds `sessionIds`. */
function world(sessionIds: string[], sessions: Record<string, Record<string, unknown>> = {}) {
  const docs: Record<string, Record<string, unknown>> = {
    'invoices/q1': { kinfolkId: 'fam1', status: 'open', invoiceNumber: '1026', amountDue: 12, sessionIds },
    'families/fam1': { displayName: 'Test Household' },
    'business_settings/business_settings': { businessName: 'Test Business' },
  };
  for (const [id, data] of Object.entries(sessions)) docs[`kin_care_sessions/${id}`] = data;
  const ctx = buildDbMock({
    docs,
    queryDocs: {
      kin: ['Rex', 'Mo', 'Pip', 'Lu'].map((name, i) => ({ id: `k${String(i)}`, data: { kinfolkId: 'fam1', name, status: 'active' } })),
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

const accepted = { kinfolkId: 'fam1', invoiceId: 'q1', invoiceNumber: '1026', actorName: 'Jamie', actorUid: 'u1' };

describe('#2093 the title on each copy of a notice', () => {
  it('the household reads "You accepted a quote"; the office keeps its own label', async () => {
    const def = getNotificationDef('quote.accepted')!;
    expect(await noticeTitleFor(def, 'kinfolk')).toBe('You accepted a quote');
    expect(await noticeTitleFor(def, 'business')).toBe('Kinfolk accepted a quote');
    expect(await noticeTitleFor(def, 'staff')).toBe('Kinfolk accepted a quote');
  });

  it('a key with no household title keeps its label on the household copy', async () => {
    expect(await noticeTitleFor({ label: 'Some label' }, 'kinfolk')).toBe('Some label');
    expect(await noticeTitleFor({ label: 'Some label', householdTitle: '  ' }, 'kinfolk')).toBe('Some label');
  });

  it('fills the business name in a household title that carries one', async () => {
    world([]);
    const def = getNotificationDef('broadcast.message')!;
    expect(await noticeTitleFor(def, 'kinfolk')).toBe('Announcements from Test Business');
  });

  it('no household title spreads a "pet" word onto a notice', () => {
    expect(getNotificationDef('pets.updated')!.householdTitle).toBe('Your Kin were updated');
  });
});

describe('#2093 a quote names the Kin on it, never the household roster', () => {
  it('a quote holding no visit names no Kin, on either copy, and the card has no Kin line', async () => {
    world([]);
    const out = await enrichTemplateData('quote.accepted', 'u1', accepted);
    expect(out.kinName ?? '').toBe('');
    for (const stream of ['kinfolk', 'business'] as const) {
      const detail = await buildNotificationDetail('quote.accepted', 'u1', accepted, 'Jamie', stream);
      expect(detail?.kinName).toBeUndefined();
    }
  });

  it('a quote holding visits names only the Kin on those visits, once each', async () => {
    world(['s1', 's2'], {
      s1: { kinfolkId: 'fam1', kinNames: ['Mo'] },
      s2: { kinfolkId: 'fam1', kinNames: ['Mo', 'Pip'] },
    });
    const detail = await buildNotificationDetail('quote.accepted', 'u1', accepted, 'Jamie', 'kinfolk');
    expect(detail?.kinName).toBe('Mo, Pip');
    expect(detail?.kinName).not.toMatch(/Rex|Lu/);
  });

  it('invoice.new sending a quote reads the quote\'s Kin too', async () => {
    world(['s1'], { s1: { kinfolkId: 'fam1', kinNames: ['Lu'] } });
    const out = await enrichTemplateData('invoice.new', 'u1', { kinfolkId: 'fam1', invoiceId: 'q1', isQuote: true });
    expect(out.kinName).toBe('Lu');
  });

  it('an ordinary invoice.new is unchanged: it still reads the household', async () => {
    world([]);
    const out = await enrichTemplateData('invoice.new', 'u1', { kinfolkId: 'fam1', invoiceId: 'q1' });
    expect(out.kinName).toBe('Rex, Mo, Pip, Lu');
  });
});

describe('the seed templates a quote is sent and answered with', () => {
  const seed = (key: string) => SEED_CORPUS.find((e) => e.key === key)!;
  const render = (tpl: string, data: Record<string, unknown>) => Handlebars.compile(tpl, { noEscape: true })(data).trim();

  it('invoice.new on a quote says quote, asks for an answer and names no due date', () => {
    const s = seed('invoice.new');
    const data = { isQuote: true, invoiceNumber: '1026', amount: '$12.00', dueDate: 'Nov 13, 2026', kinfolkName: 'Jamie', kinName: 'Mo' };
    for (const tpl of [s.emailSubject, s.emailHeadline, s.emailContent, s.smsTxt, s.pushTxt]) {
      const out = render(tpl, data);
      expect(out).toMatch(/quote/i);
      expect(out).not.toMatch(/invoice/i);
      expect(out).not.toContain('Nov 13, 2026');
    }
    expect(render(s.emailContent, data)).toContain("your quote (1026) for Mo's care is ready");
    expect(render(s.emailContent, { ...data, kinName: '' })).toContain('your quote (1026) is ready');
  });

  it('invoice.new on an invoice reads exactly as it did', () => {
    const s = seed('invoice.new');
    const data = { invoiceNumber: '1042', amount: '$40.00', dueDate: 'Dec 1, 2026', kinfolkName: 'Jamie', kinName: 'Mo' };
    expect(render(s.emailSubject, data)).toBe('Your invoice is ready');
    expect(render(s.pushTxt, data)).toBe('Your invoice is ready. Invoice 1042 for $40.00 is due Dec 1, 2026. Tap to view.');
    expect(render(s.smsTxt, data)).toBe("It's Auntie. Your invoice 1042 for $40.00 is ready, due Dec 1, 2026.");
  });

  it('quote.accepted with no Kin on the quote reads as a whole sentence', () => {
    const s = seed('quote.accepted');
    const none = { actorName: 'You', kinName: '' };
    expect(render(s.pushTxt, none)).toBe("Quote accepted. You're all set. Tap to see the details.");
    expect(render(s.smsTxt, none)).toBe("It's Auntie. You accepted the quote, woohoo! I'll follow up with next steps.");
    expect(render(s.emailContent, none)).toContain('You accepted the quote, and');
    expect(render(s.pushTxt, { actorName: 'You', kinName: 'Mo' })).toBe(
      "Quote accepted. You're all set for Mo's care. Tap to see the details.",
    );
  });
});
