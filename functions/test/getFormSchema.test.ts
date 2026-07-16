import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
beforeEach(() => mocks.dbFn.mockReset());

describe('getFormSchemaHandler', () => {
  it('rejects unauth', async () => {
    const { getFormSchemaHandler } = await import('../src/portal/getFormSchema');
    await expect(
      getFormSchemaHandler({ data: { schemaId: 'tribeProfile' }, auth: undefined } as any),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects when schemaId missing', async () => {
    const ctx = buildDbMock({ docs: { 'clients/u1': { kinfolkIds: ['3'] } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getFormSchemaHandler } = await import('../src/portal/getFormSchema');
    await expect(
      getFormSchemaHandler({ data: {}, auth: { uid: 'u1' } } as any),
    ).rejects.toThrow();
  });

  it('returns schema with sections + fields', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'formSchemas/tribeProfile': {
          name: 'Tribe Profile',
          sections: [
            {
              title: 'Contact',
              fields: [
                { key: 'displayName', label: 'Family Display Name', type: 'text', required: true },
                {
                  key: 'preferredCallTime',
                  label: 'Best time to call',
                  type: 'select',
                  options: ['Morning', 'Afternoon', 'Evening'],
                },
              ],
            },
          ],
        },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getFormSchemaHandler } = await import('../src/portal/getFormSchema');
    const res = await getFormSchemaHandler({ data: { schemaId: 'tribeProfile' }, auth: { uid: 'u1' } } as any);
    expect(res.id).toBe('tribeProfile');
    expect(res.name).toBe('Tribe Profile');
    expect(res.sections).toHaveLength(1);
    expect(res.sections[0].fields).toHaveLength(2);
    expect(res.sections[0].fields[0].required).toBe(true);
    expect(res.sections[0].fields[1].options).toEqual(['Morning', 'Afternoon', 'Evening']);
  });

  it('returns 404 when schema doc missing', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['3'] },
        'formSchemas/missing': null,
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const { getFormSchemaHandler } = await import('../src/portal/getFormSchema');
    await expect(
      getFormSchemaHandler({ data: { schemaId: 'missing' }, auth: { uid: 'u1' } } as any),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
