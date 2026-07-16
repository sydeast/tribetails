import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));

import { listCatalogKeysHandler } from '../src/admin/listCatalogKeys';

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

function seed() {
  return buildDbMock({
    queryDocs: {
      notificationTemplateBindings: [
        { id: 'invoice.new', data: { catalogKey: 'invoice.new', templateId: 't1' } },
        { id: 'invoice.reminder', data: { catalogKey: 'invoice.reminder', templateId: 't2' } },
        // Legacy doc whose id differs from a stale field: id wins when field absent.
        { id: 'booking.confirmed', data: { templateId: 't3' } },
      ],
    },
  });
}

describe('listCatalogKeys happy path', () => {
  it('returns the distinct sorted set of catalog keys', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listCatalogKeysHandler(req({}));
    expect(res.keys).toEqual(['booking.confirmed', 'invoice.new', 'invoice.reminder']);
  });

  it('accepts a missing data payload (defaults to {})', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listCatalogKeysHandler(req(undefined));
    expect(res.keys.length).toBe(3);
  });

  it('applies a case-insensitive substring filter', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listCatalogKeysHandler(req({ filter: 'INVOICE' }));
    expect(res.keys).toEqual(['invoice.new', 'invoice.reminder']);
  });
});

describe('listCatalogKeys validation + auth', () => {
  it('rejects an over-long filter (zod throws)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(listCatalogKeysHandler(req({ filter: 'x'.repeat(201) }))).rejects.toThrow();
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(listCatalogKeysHandler(req({}, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
