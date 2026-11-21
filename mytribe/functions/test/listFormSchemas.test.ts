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

import { listFormSchemasHandler } from '../src/admin/listFormSchemas';
import { logEvent } from '../src/lib/logger';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (logEvent as any).mockClear();
});

function req(uid: string | undefined = 'admin1'): CallableRequest<unknown> {
  return {
    data: {},
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('listFormSchemas', () => {
  // Note: unauth + non-admin denial is enforced by wrapAdminCallable
  // (covered by wrapAdminCallable.test.ts). Handler-level tests below
  // verify mapping behavior + listed event.

  it('HAPPY: empty collection returns empty array', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({ queryDocs: { formSchemas: [] } }).db,
    );
    const res = await listFormSchemasHandler(req());
    expect(res.schemas).toEqual([]);
  });

  it('HAPPY: maps docs to summaries with version + updatedBy + ISO updatedAt', async () => {
    const ts1 = new Date('2026-05-10T12:34:56Z');
    const ts2 = new Date('2026-05-15T09:00:00Z');
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          formSchemas: [
            {
              id: 'tribeProfile',
              data: {
                name: 'Tribe Profile',
                version: 5,
                updatedAt: ts1,
                updatedBy: 'admin1',
              },
            },
            {
              id: 'accountSettings',
              data: {
                name: 'Account Settings',
                version: 2,
                updatedAt: ts2,
                updatedBy: 'admin2',
              },
            },
          ],
        },
      }).db,
    );
    const res = await listFormSchemasHandler(req());
    expect(res.schemas).toHaveLength(2);
    // Sorted by name asc → "Account Settings" first
    expect(res.schemas[0].id).toBe('accountSettings');
    expect(res.schemas[0].name).toBe('Account Settings');
    expect(res.schemas[0].version).toBe(2);
    expect(res.schemas[0].updatedAt).toBe(ts2.toISOString());
    expect(res.schemas[0].updatedBy).toBe('admin2');
    expect(res.schemas[1].id).toBe('tribeProfile');
    expect(res.schemas[1].version).toBe(5);
    expect(res.schemas[1].updatedAt).toBe(ts1.toISOString());
  });

  it('HAPPY: falls back to doc id when name missing + nulls when no updatedAt/By', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          formSchemas: [
            { id: 'kinProfile', data: { version: 1 } },
          ],
        },
      }).db,
    );
    const res = await listFormSchemasHandler(req());
    expect(res.schemas[0].name).toBe('kinProfile');
    expect(res.schemas[0].updatedAt).toBeNull();
    expect(res.schemas[0].updatedBy).toBeNull();
  });

  it('HAPPY: handles Firestore Timestamp (object with toDate())', async () => {
    const fakeTs = {
      toDate: () => new Date('2026-05-19T00:00:00Z'),
    };
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          formSchemas: [
            {
              id: 'tribeProfile',
              data: { name: 'X', version: 1, updatedAt: fakeTs, updatedBy: 'u' },
            },
          ],
        },
      }).db,
    );
    const res = await listFormSchemasHandler(req());
    expect(res.schemas[0].updatedAt).toBe('2026-05-19T00:00:00.000Z');
  });

  it('HAPPY: defaults missing version field to 0', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          formSchemas: [{ id: 'tribeProfile', data: { name: 'X' } }],
        },
      }).db,
    );
    const res = await listFormSchemasHandler(req());
    expect(res.schemas[0].version).toBe(0);
  });

  it('HAPPY: emits portal.formSchema.listed log with count', async () => {
    mocks.dbFn.mockReturnValue(
      buildDbMock({
        queryDocs: {
          formSchemas: [
            { id: 'a', data: { name: 'A', version: 1 } },
            { id: 'b', data: { name: 'B', version: 1 } },
          ],
        },
      }).db,
    );
    await listFormSchemasHandler(req());
    const calls = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    const listed = calls.find((c: any) => c.event === 'portal.formSchema.listed');
    expect(listed).toBeDefined();
    expect(listed.severity).toBe('info');
    expect(listed.extra.count).toBe(2);
  });
});

/**
 * #2461 ruling, 2026-11-20: an Auntie sees the full KinTale, its custom field
 * answers included. Their labels come from the KinTale form, so she lists that
 * form and no other.
 */
describe('listFormSchemas: an Auntie lists the KinTale form only', () => {
  const auntie = (uid = 'auntie1'): CallableRequest<unknown> =>
    ({ ...req(), auth: { uid, token: { staffRole: 'auntie' } } }) as unknown as CallableRequest<unknown>;
  const FORMS = [
    { id: 'kintaleForm', data: { name: 'KinTale extras', appliesTo: 'KINTALE', version: 3, updatedBy: 'admin1' } },
    { id: 'tribeProfile', data: { name: 'Tribe Profile', appliesTo: 'KINFOLK', version: 5, updatedBy: 'admin1' } },
    { id: 'kinProfile', data: { name: 'Kin Profile', appliesTo: 'KIN', version: 1 } },
    { id: 'loose', data: { name: 'Loose', version: 1 } },
    { id: 'oddCase', data: { name: 'Odd', appliesTo: 'kintale', version: 1 } },
  ];
  const withForms = () => mocks.dbFn.mockReturnValue(buildDbMock({ queryDocs: { formSchemas: FORMS } }).db);

  it('HAPPY: she gets the KinTale form, with no record of who last edited it', async () => {
    withForms();
    const res = await listFormSchemasHandler(auntie());
    expect(res.schemas).toEqual([
      { id: 'kintaleForm', name: 'KinTale extras', appliesTo: 'KINTALE', version: 3, updatedAt: null, updatedBy: null },
    ]);
  });

  it('NEGATIVE: every other form is left out for her, a placement that only looks like KINTALE included', async () => {
    withForms();
    const ids = (await listFormSchemasHandler(auntie())).schemas.map((s) => s.id);
    for (const id of ['tribeProfile', 'kinProfile', 'loose', 'oddCase']) expect(ids).not.toContain(id);
  });

  it('NEGATIVE: an account carrying both roles is held to the KinTale form too', async () => {
    withForms();
    const both = { ...req(), auth: { uid: 'confused1', token: { admin: true, staffRole: 'auntie' } } };
    const res = await listFormSchemasHandler(both as unknown as CallableRequest<unknown>);
    expect(res.schemas.map((s) => s.id)).toEqual(['kintaleForm']);
  });

  it('SAD: with no KinTale form she gets an empty list, not an error', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ queryDocs: { formSchemas: FORMS.slice(1) } }).db);
    expect((await listFormSchemasHandler(auntie())).schemas).toEqual([]);
  });

  it('the owner still lists every form, who edited it included', async () => {
    withForms();
    const res = await listFormSchemasHandler(req());
    expect(res.schemas).toHaveLength(5);
    expect(res.schemas.find((s) => s.id === 'tribeProfile')?.updatedBy).toBe('admin1');
  });
});
