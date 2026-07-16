import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({
  db: mocks.dbFn,
  auth: vi.fn(),
  getAdmin: vi.fn(),
}));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));

import { deleteFormSchemaHandler } from '../src/admin/deleteFormSchema';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { logEvent } from '../src/lib/logger';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (logEvent as any).mockClear();
  (writeAuditEntry as any).mockClear();
});

const NO_AUTH = Symbol('no-auth');

function req(data: unknown, uid: string | typeof NO_AUTH = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid !== NO_AUTH
      ? ({ uid: uid as string, token: { admin: true } as any } as any)
      : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('deleteFormSchema', () => {
  it('SAD: unauthenticated rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      deleteFormSchemaHandler(req({ id: 'tribeProfile' }, NO_AUTH)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('SAD: missing id rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(deleteFormSchemaHandler(req({}))).rejects.toThrow();
  });

  it('SAD: invalid id format rejected', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(
      deleteFormSchemaHandler(req({ id: 'bad id with spaces' })),
    ).rejects.toThrow();
  });

  it('SAD: missing doc throws not-found', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ docs: { 'formSchemas/missing': null } }).db,
    );
    await expect(
      deleteFormSchemaHandler(req({ id: 'missing' })),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('HAPPY: deletes doc and returns ok', async () => {
    const ctx = buildDbMock({
      docs: {
        'formSchemas/tribeProfile': {
          id: 'tribeProfile',
          name: 'X',
          version: 1,
          sections: [],
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await deleteFormSchemaHandler(req({ id: 'tribeProfile' }));
    expect(res).toEqual({ ok: true });
    expect(ctx.deletes).toContain('formSchemas/tribeProfile');
  });

  it('HAPPY: writes DELETE_FORM_SCHEMA audit entry with schemaId', async () => {
    const ctx = buildDbMock({
      docs: {
        'formSchemas/tribeProfile': { id: 'tribeProfile', name: 'X', version: 1, sections: [] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await deleteFormSchemaHandler(req({ id: 'tribeProfile' }));
    const auditCalls = (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0]);
    const entry = auditCalls.find(
      (a: any) => a.event === 'DELETE_FORM_SCHEMA',
    );
    expect(entry).toBeDefined();
    expect(entry.severity).toBe('warn');
    expect(entry.actorUid).toBe('admin1');
    expect(entry.actorRole).toBe('AUNTIE');
    expect(entry.payload.schemaId).toBe('tribeProfile');
  });

  it('HAPPY: emits portal.formSchema.deleted log', async () => {
    const ctx = buildDbMock({
      docs: {
        'formSchemas/tribeProfile': { id: 'tribeProfile', name: 'X', version: 1, sections: [] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await deleteFormSchemaHandler(req({ id: 'tribeProfile' }));
    const calls = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    const deleted = calls.find((c: any) => c.event === 'portal.formSchema.deleted');
    expect(deleted).toBeDefined();
    expect(deleted.severity).toBe('warn');
    expect(deleted.extra.schemaId).toBe('tribeProfile');
  });
});
