import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listFormSchemas, deleteFormSchema } from './formSchemas';

beforeEach(() => call.mockReset());

describe('formSchemas api', () => {
  it('listFormSchemas unwraps the { schemas } envelope', async () => {
    const schemas = [
      { id: 'tribeProfile', name: 'Tribe Profile', appliesTo: 'NONE', version: 3, updatedAt: '2026-07-01T00:00:00Z', updatedBy: 'admin1' },
    ];
    call.mockResolvedValue({ schemas });
    const result = await listFormSchemas();
    expect(call).toHaveBeenCalledWith('listFormSchemas', {});
    expect(result).toEqual(schemas);
  });

  it('defaults to [] when the callable returns no schemas', async () => {
    call.mockResolvedValue({});
    expect(await listFormSchemas()).toEqual([]);
  });

  it('preserves null updatedAt/updatedBy rather than coercing them', async () => {
    call.mockResolvedValue({
      schemas: [{ id: 'x', name: 'X', appliesTo: 'NONE', version: 0, updatedAt: null, updatedBy: null }],
    });
    const result = await listFormSchemas();
    expect(result[0]?.updatedAt).toBeNull();
    expect(result[0]?.updatedBy).toBeNull();
  });

  it('deleteFormSchema sends { id }, matching the backend contract exactly (not schemaId)', async () => {
    call.mockResolvedValue({ ok: true });
    await deleteFormSchema('tribeProfile');
    expect(call).toHaveBeenCalledWith('deleteFormSchema', { id: 'tribeProfile' });
  });

});
