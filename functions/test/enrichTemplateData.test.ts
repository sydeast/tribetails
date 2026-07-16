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
  it('kincare.booking.confirm: maps serviceName→serviceType, formats date/time, names from family + booking', async () => {
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
    });

    expect(out.serviceType).toBe('Dog Walk');
    expect(out.kinfolkName).toBe('The Rivera Home');
    expect(out.kinName).toBe('Rex, Bella');
    expect(out.bookingDate).toMatch(/Jul/);
    expect(out.bookingTime).toMatch(/2:30/);
    expect(out.bookingTime).toMatch(/PM/i);
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

  function tokensForKey(key: string): string[] {
    const dir = join(seedsDir, key);
    const files = readdirSync(dir);
    const found = new Set<string>();
    for (const f of files) {
      const raw = readFileSync(join(dir, f), 'utf8');
      const re = /\{\{\s*([\w.]+)\s*\}\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) found.add(m[1]);
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
