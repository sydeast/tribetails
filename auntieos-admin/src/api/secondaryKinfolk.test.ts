import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { decodeSecondaryKinfolk, listSecondaryKinfolk, removeSecondaryKinfolk, saveSecondaryKinfolk } from './secondaryKinfolk';

beforeEach(() => call.mockReset());

describe('secondary kinfolk callables (2026-09-27 Q3)', () => {
  it('list trims the id and decodes each person with its access state', async () => {
    call.mockResolvedValue({ people: [{ personId: 'p1', name: 'Sam', phone: null, email: 'sam@x.com', access: 'INVITED', memberUid: null }] });
    const res = await listSecondaryKinfolk(' fam1 ');
    expect(call).toHaveBeenCalledWith('listSecondaryKinfolk', { kinfolkId: 'fam1' });
    expect(res).toEqual([{ personId: 'p1', name: 'Sam', phone: null, email: 'sam@x.com', access: 'INVITED', memberUid: null }]);
  });

  it('a missing people array is an error, never "nobody"', () => {
    expect(() => decodeSecondaryKinfolk({})).toThrow(/no people array/);
    expect(decodeSecondaryKinfolk({ people: [{ personId: 'p1', name: 'A', access: 'weird' }] })[0]?.access).toBe('NONE');
  });

  it('save sends every field, blanks as null, and the person id only on an edit', async () => {
    call.mockResolvedValue({});
    await saveSecondaryKinfolk('fam1', { name: ' Sam ', phone: ' ', email: 'sam@x.com' });
    expect(call).toHaveBeenLastCalledWith('saveSecondaryKinfolk', { kinfolkId: 'fam1', name: 'Sam', phone: null, email: 'sam@x.com' });
    await saveSecondaryKinfolk('fam1', { name: 'Sam', phone: '8055550177', email: '' }, 'p1');
    expect(call).toHaveBeenLastCalledWith('saveSecondaryKinfolk', { kinfolkId: 'fam1', personId: 'p1', name: 'Sam', phone: '8055550177', email: null });
  });

  it('remove names the person', async () => {
    call.mockResolvedValue({ ok: true });
    await removeSecondaryKinfolk('fam1', 'p1');
    expect(call).toHaveBeenCalledWith('removeSecondaryKinfolk', { kinfolkId: 'fam1', personId: 'p1' });
  });
});
