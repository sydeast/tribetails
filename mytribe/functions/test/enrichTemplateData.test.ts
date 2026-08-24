import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

import { enrichTemplateData, TEMPLATE_FIELDS } from '../src/notifications/enrichTemplateData';

describe('enrichTemplateData: invoice.new (the canonical gap)', () => {
  it('hydrates invoiceNumber/amount/dueDate/kinfolkName/kinName from fetched docs', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': {
          invoiceNumber: 'TT-1001',
          total: 120,
          amountDue: 120,
          dueDate: 'Jul 5, 2026',
          kinfolkName: 'The Rivera Home',
          kinfolkId: 'fam1',
        },
        'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' },
      },
      queryDocs: {
        kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('invoice.new', 'cli1', {
      invoiceId: 'inv1',
      kinfolkId: 'fam1',
    });

    expect(out.invoiceNumber).toBe('TT-1001');
    expect(out.amount).toBe('$120.00');
    expect(out.dueDate).toBe('Jul 5, 2026');
    expect(out.kinfolkName).toBe('The Rivera Home');
    expect(out.kinName).toBe('Rex');
  });

  it('does NOT overwrite an emitter-provided value', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/inv1': { invoiceNumber: 'TT-1001', amountDue: 120 },
        'families/fam1': { displayName: 'The Rivera Home' },
      },
      queryDocs: { kin: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('invoice.new', 'cli1', {
      invoiceId: 'inv1',
      kinfolkId: 'fam1',
      invoiceNumber: 'CUSTOM-OVERRIDE',
      kinfolkName: 'Emitter Name',
    });

    expect(out.invoiceNumber).toBe('CUSTOM-OVERRIDE');
    expect(out.kinfolkName).toBe('Emitter Name');
  });

  it('unresolved entity → no throw, no literal token, logs the miss', async () => {
    const ctx = buildDbMock({ docs: {}, queryDocs: { kin: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('invoice.new', 'cli1', {
      invoiceId: 'missing',
      kinfolkId: 'famX',
    });

    // Fields stay unset (Handlebars + scrub will blank them). Never a raw token.
    expect(out.invoiceNumber).toBeUndefined();
    expect(out.amount).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('{{');
    expect(mocks.logEventFn).toHaveBeenCalled();
  });
});

describe('enrichTemplateData: bookings', () => {
  it('kincare.booking.confirm: maps serviceName→serviceType, names from family + booking, and leaves the emitter’s dates alone', async () => {
    // Jul 4 2026 18:30 UTC = 14:30 America/New_York (EDT, UTC-4).
    const startMs = Date.UTC(2026, 6, 4, 18, 30);
    const ctx = buildDbMock({
      docs: {
        'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' },
        'families/fam1/bookings/b1/kinCares/v1': {
          kinNames: ['Rex', 'Bella'],
          serviceType: 'Dog Walk',
        },
        'business_settings/business_settings': { timeZone: 'America/New_York' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('kincare.booking.confirm', 'cli1', {
      kinfolkId: 'fam1',
      batchId: 'b1',
      visitId: 'v1',
      bookingId: 'v1',
      serviceName: 'Dog Walk',
      startTimeMs: startMs,
      // #536: the emitters format these two now. The seed no longer references
      // them; they are carried only so the Firestore template document that is
      // still live in production keeps rendering until the operator re-imports.
      bookingDate: 'Sat, Jul 4',
      bookingTime: '2:30 PM',
    });

    expect(out.serviceType).toBe('Dog Walk');
    expect(out.kinfolkName).toBe('The Rivera Home');
    expect(out.kinName).toBe('Rex, Bella');
    expect(out.bookingDate).toBe('Sat, Jul 4');
    expect(out.bookingTime).toBe('2:30 PM');
  });

  it('kincare.booking.confirm: does NOT hydrate bookingDate/bookingTime any more (the emitter owns them)', async () => {
    // The key's templates enumerate `visits` instead of naming one day, so the
    // enricher has no business inventing a single date for them. A dispatch that
    // omits them leaves them unset and the senders scrub the residual token:
    // never a wrong day, and never a raw `{{bookingDate}}`.
    const ctx = buildDbMock({
      docs: {
        'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' },
        'business_settings/business_settings': { timeZone: 'America/New_York' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('kincare.booking.confirm', 'cli1', {
      kinfolkId: 'fam1',
      batchId: 'b1',
      bookingId: 'b1',
      serviceName: 'Dog Walk',
      startTimeMs: Date.UTC(2026, 6, 4, 18, 30),
    });

    expect(out.bookingDate).toBeUndefined();
    expect(out.bookingTime).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('{{');
  });

  it('kincare.requested (business audience): kinfolkName comes from the family, NOT the staff recipient', async () => {
    const ctx = buildDbMock({
      docs: {
        // recipient is a staff admin; must not be used as the kinfolk name.
        'clients/admin1': { displayName: 'Auntie Admin' },
        'staff/admin1': { displayName: 'Auntie Admin' },
        'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' },
      },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('kincare.requested', 'admin1', {
      kinfolkId: 'fam1',
      serviceName: 'Dog Walk',
      bookingDate: 'Jul 4',
    });

    expect(out.kinfolkName).toBe('The Rivera Home');
    expect(out.kinName).toBe('Rex');
    expect(out.serviceType).toBe('Dog Walk');
  });
});

/**
 * #532. `kincare.requested` is the one notification about a REQUEST rather than
 * a visit, so its date token has to carry a whole envelope. Times are noon UTC
 * so the America/New_York default zone cannot roll one onto the previous day.
 */
describe('enrichTemplateData: bookingDates spans a whole envelope (#532)', () => {
  const noonUtc = (day: number) => Date.UTC(2026, 8, day, 16, 0);

  async function requested(data: Record<string, unknown>) {
    const ctx = buildDbMock({
      docs: {
        'staff/admin1': { displayName: 'Auntie Admin' },
        'families/fam1': { displayName: 'The Rivera Home', primaryUid: 'cli1' },
      },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    return enrichTemplateData('kincare.requested', 'admin1', { kinfolkId: 'fam1', ...data });
  }

  it('four visits read as a count and a range, not four dates', async () => {
    const out = await requested({
      startTimeMsList: [noonUtc(4), noonUtc(5), noonUtc(6), noonUtc(7)],
    });
    expect(out.bookingDates).toBe('4 visits, Sep 4 to Sep 7');
  });

  it('one visit keeps the weekday-led spelling the other booking templates use', async () => {
    const out = await requested({ startTimeMsList: [noonUtc(4)] });
    expect(out.bookingDates).toBe('Fri, Sep 4');
  });

  it('a thirty-visit standing request still fits one line', async () => {
    const out = await requested({
      startTimeMsList: Array.from({ length: 30 }, (_, i) => noonUtc(1 + i)),
    });
    expect(out.bookingDates).toBe('30 visits, Sep 1 to Sep 30');
  });

  it('falls back to the single startTimeMs when the list is missing', async () => {
    // The dispatch that could not read its children still names a date.
    const out = await requested({ startTimeMs: noonUtc(4) });
    expect(out.bookingDates).toBe('Fri, Sep 4');
  });

  it('leaves the token blank when there is no date at all, for the senders to scrub', async () => {
    const out = await requested({});
    expect(out.bookingDates ?? '').toBe('');
  });
});

describe('enrichTemplateData: pets + invoice variants', () => {
  it('pets.updated: kinName from families/{id}/kin/{kinId}.name (precise)', async () => {
    const ctx = buildDbMock({ docs: { 'families/fam1/kin/k9': { name: 'Mochi' } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('pets.updated', 'kinUid', {
      kinfolkId: 'fam1',
      kinId: 'k9',
    });

    expect(out.kinName).toBe('Mochi');
  });

  it('invoice.reminder: amount from emitter amountMinor (cents), invoiceNumber from invoice doc', async () => {
    const ctx = buildDbMock({
      docs: { 'invoices/inv9': { invoiceNumber: 'TT-9', amountDue: 999 } },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('invoice.reminder', 'cli1', {
      invoiceId: 'inv9',
      kinfolkId: 'fam1',
      amountMinor: 4550,
      currency: 'usd',
    });

    expect(out.amount).toBe('$45.50');
    expect(out.invoiceNumber).toBe('TT-9');
    expect(out.kinName).toBe('Rex');
  });

  it('invoice in family subcollection is found when flat doc is absent', async () => {
    const ctx = buildDbMock({
      docs: {
        'families/fam1/invoices/inv7': { invoiceNumber: 'TT-7', amountDue: 30, date: 'Jul 1, 2026' },
        'families/fam1': { displayName: 'The Rivera Home' },
      },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('invoice.overdue', 'cli1', {
      invoiceId: 'inv7',
      kinfolkId: 'fam1',
    });

    expect(out.kinfolkName).toBe('The Rivera Home');
    expect(out.kinName).toBe('Rex');
    expect(out.bookingDate).toBe('Jul 1, 2026');
  });

  it('legacy invoice without any date string falls back to createdAt (invoice.overdue bookingDate)', async () => {
    // 2026-07-03 fix: pre-`date` invoice docs rendered {{bookingDate}} blank.
    const createdMs = Date.UTC(2026, 5, 15, 12, 0, 0); // Jun 15, 2026
    const ctx = buildDbMock({
      docs: {
        'invoices/legacy1': { invoiceNumber: 'TT-1', createdAt: { toMillis: () => createdMs } },
        'families/fam1': { displayName: 'The Rivera Home' },
      },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('invoice.overdue', 'cli1', {
      invoiceId: 'legacy1',
      kinfolkId: 'fam1',
    });

    expect(out.bookingDate).toMatch(/Jun 15, 2026/);
  });

  it('legacy invoice with no date and no createdAt leaves bookingDate absent (senders scrub)', async () => {
    const ctx = buildDbMock({
      docs: {
        'invoices/legacy2': { invoiceNumber: 'TT-2' },
        'families/fam1': { displayName: 'The Rivera Home' },
      },
      queryDocs: { kin: [{ id: 'k1', data: { kinfolkId: 'fam1', name: 'Rex', status: 'active' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const out = await enrichTemplateData('invoice.overdue', 'cli1', {
      invoiceId: 'legacy2',
      kinfolkId: 'fam1',
    });

    expect(out.bookingDate).toBeUndefined();
  });
});

describe('enrichTemplateData: no-op cases', () => {
  it('returns data unchanged for a key with no enrichable fields (rating.submitted.bad)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const input = { kinfolkId: 'fam1', score: 2 };
    const out = await enrichTemplateData('rating.submitted.bad', 'admin1', input);
    expect(out).toEqual(input);
  });

  it('does not clobber when every needed field is already supplied (no fetch path)', async () => {
    const ctx = buildDbMock();
    mocks.dbFn.mockReturnValue(ctx.db);
    const input = {
      invoiceId: 'inv1',
      invoiceNumber: 'GIVEN',
      amount: '$9.00',
      dueDate: 'soon',
      kinfolkName: 'Given Home',
      kinName: 'Given Pet',
    };
    const out = await enrichTemplateData('invoice.new', 'cli1', input);
    expect(out).toMatchObject(input);
  });
});

describe('TEMPLATE_FIELDS mirrors the on-disk seed tokens (drift guard)', () => {
  const seedsDir = join(__dirname, '..', '..', 'seeds', 'notificationTemplates');

  /**
   * Every name a template asks the CONTEXT for.
   *
   * Two shapes, because #536 gave `kincare.booking.confirm` the first block
   * helpers in the corpus (`{{#each visits}}`, per the visit-date rendering
   * spec):
   *
   *   - a plain `{{token}}` or `{{a.b}}` reference, as before; and
   *   - the SUBJECT of a block helper, `{{#each visits}}` / `{{#if removed}}`,
   *     which is just as much a context field as a plain token and would
   *     otherwise be invisible to this guard.
   *
   * `{{this.x}}` inside a block is deliberately NOT counted. It names a field of
   * the loop's current item, not of the context, so the enricher can never fill
   * it and listing it in TEMPLATE_FIELDS would describe nothing.
   */
  function tokensForKey(key: string): string[] {
    const dir = join(seedsDir, key);
    const files = readdirSync(dir);
    const found = new Set<string>();
    for (const f of files) {
      const raw = readFileSync(join(dir, f), 'utf8');
      const re = /\{\{\s*(?:#(?:each|if|unless|with)\s+)?([\w.]+)\s*\}\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const token = m[1];
        if (token === 'this' || token.startsWith('this.')) continue;
        found.add(token);
      }
    }
    return [...found].sort();
  }

  const seedKeys = readdirSync(seedsDir).sort();

  it('covers exactly the same set of keys as the seeds directory', () => {
    expect(Object.keys(TEMPLATE_FIELDS).sort()).toEqual(seedKeys);
  });

  for (const key of readdirSync(seedsDir).sort()) {
    it(`${key}: token set matches seeds`, () => {
      const expected = tokensForKey(key);
      const actual = [...(TEMPLATE_FIELDS[key] ?? [])].sort();
      expect(actual).toEqual(expected);
    });
  }
});
