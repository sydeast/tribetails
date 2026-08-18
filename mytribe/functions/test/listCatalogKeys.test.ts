import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import { listCatalogKeysHandler } from '../src/admin/listCatalogKeys';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';
import { DIRECT_SEND_KEYS } from '../src/notifications/catalogKeys';

const FULL_CATALOG_SIZE = Object.keys(NOTIFICATION_CATALOG).length + DIRECT_SEND_KEYS.length;

beforeEach(() => {
  mocks.dbFn.mockReset();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** Bindings + a small template bank, the shape a real project has. */
function seed() {
  return buildDbMock({
    queryDocs: {
      notificationTemplateBindings: [
        { id: 'invoice.new', data: { catalogKey: 'invoice.new', templateId: 't1', active: true } },
        { id: 'invoice.reminder', data: { catalogKey: 'invoice.reminder', templateId: 't2', active: false } },
        // Legacy doc whose id differs from a stale field: id wins when field absent.
        { id: 'booking.confirmed', data: { templateId: 't3' } },
      ],
      emailTemplates: [
        { id: 't1', data: {} },
        { id: 't2', data: {} },
        { id: 't3', data: {} },
        { id: 'kincare.booking.confirm', data: {} },
      ],
    },
  });
}

/** The bug in #383: with no bindings at all, the old handler returned []. */
function emptySeed() {
  return buildDbMock({ queryDocs: { notificationTemplateBindings: [], emailTemplates: [] } });
}

describe('listCatalogKeys returns the catalog, not the bindings', () => {
  it('returns the full catalog with an EMPTY bindings collection', async () => {
    mocks.dbFn.mockReturnValue(emptySeed().db);
    const res = await listCatalogKeysHandler(req({}));
    expect(res.keys.length).toBe(FULL_CATALOG_SIZE);
    expect(res.keys).toContain('kincare.booking.confirm');
    expect(res.keys).toContain('invite.primary');
    expect(res.rows.every((r) => r.bound === false)).toBe(true);
  });

  it('keeps `keys` in step with `rows`, sorted and unique', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listCatalogKeysHandler(req({}));
    expect(res.keys).toEqual(res.rows.map((r) => r.key));
    expect(res.keys).toEqual([...res.keys].sort());
    expect(new Set(res.keys).size).toBe(res.keys.length);
  });

  it('unions the catalog with any leftover key in the bindings collection', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listCatalogKeysHandler(req({}));
    // 'booking.confirmed' is not a catalog key; it only exists because someone bound it.
    expect(res.keys.length).toBe(FULL_CATALOG_SIZE + 1);
    const stray = res.rows.find((r) => r.key === 'booking.confirmed')!;
    expect(stray.source).toBe('legacy');
    expect(stray.bound).toBe(true);
  });

  it('carries the label, category and default template for a catalog row', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listCatalogKeysHandler(req({}));
    const row = res.rows.find((r) => r.key === 'kincare.booking.confirm')!;
    expect(row).toMatchObject({
      label: 'KinCare booking confirmed',
      category: 'visit',
      audience: 'both',
      source: 'catalog',
      defaultTemplateId: 'kincare.booking.confirm',
      hasDefaultTemplate: true,
      bound: false,
      resolvedTemplateId: 'kincare.booking.confirm',
    });
  });

  it('flags a catalog key whose default template is missing from the bank', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listCatalogKeysHandler(req({}));
    expect(res.rows.find((r) => r.key === 'kincare.booking.confirm')!.hasDefaultTemplate).toBe(true);
    expect(res.rows.find((r) => r.key === 'kintale.published')!.hasDefaultTemplate).toBe(false);
  });

  it('resolves an ACTIVE binding to its template and an inactive one to the default', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listCatalogKeysHandler(req({}));
    // Matches resolveTemplateId: inactive means "revert to default", not "send nothing".
    expect(res.rows.find((r) => r.key === 'invoice.new')!.resolvedTemplateId).toBe('t1');
    const reminder = res.rows.find((r) => r.key === 'invoice.reminder')!;
    expect(reminder.bound).toBe(true);
    expect(reminder.resolvedTemplateId).toBe('invoice.reminder');
  });

  it('accepts a missing data payload (defaults to {})', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listCatalogKeysHandler(req(undefined));
    expect(res.keys.length).toBe(FULL_CATALOG_SIZE + 1);
  });

  it('applies a case-insensitive substring filter over key and label', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const byKey = await listCatalogKeysHandler(req({ filter: 'INVOICE.' }));
    expect(byKey.keys.every((k) => k.startsWith('invoice.'))).toBe(true);
    expect(byKey.keys).toContain('invoice.new');
    expect(byKey.keys).toEqual(byKey.rows.map((r) => r.key));

    const byLabel = await listCatalogKeysHandler(req({ filter: 'kincare booking confirmed' }));
    expect(byLabel.keys).toEqual(['kincare.booking.confirm']);
  });
});

describe('listCatalogKeys validation + auth', () => {
  it('rejects an over-long filter (zod throws)', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(listCatalogKeysHandler(req({ filter: 'x'.repeat(201) }))).rejects.toThrow();
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(listCatalogKeysHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
