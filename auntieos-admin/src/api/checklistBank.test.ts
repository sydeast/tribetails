import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { listChecklistBank, saveChecklistBankItem } from './checklistBank';

beforeEach(() => {
  call.mockReset();
});

describe('listChecklistBank', () => {
  it('calls the deployed admin callable by name with an empty payload', async () => {
    call.mockResolvedValue({ items: [], schemaVersion: 1 });
    await listChecklistBank();
    expect(call).toHaveBeenCalledWith('listChecklistBank', {});
  });

  it('decodes the {items:[{id,text,scope}]} body the callable returns', async () => {
    call.mockResolvedValue({
      items: [
        { id: 'fresh-water', text: 'Fresh water provided', scope: 'PER_PET' },
        { id: 'home-secured', text: 'Home secured on departure', scope: 'PER_VISIT' },
      ],
      schemaVersion: 1,
    });
    expect(await listChecklistBank()).toEqual([
      { id: 'fresh-water', text: 'Fresh water provided', scope: 'PER_PET' },
      { id: 'home-secured', text: 'Home secured on departure', scope: 'PER_VISIT' },
    ]);
  });

  it('normalizes an unknown scope to PER_PET rather than persisting a third value', async () => {
    call.mockResolvedValue({ items: [{ id: 'x', text: 'Something', scope: 'WEEKLY' }] });
    const items = await listChecklistBank();
    expect(items[0]!.scope).toBe('PER_PET');
  });

  it('drops blank-texted rows, which would render as an unlabeled quick-add button', async () => {
    call.mockResolvedValue({ items: [{ id: 'x', text: '   ', scope: 'PER_PET' }, { id: 'y', text: 'Walk' }] });
    expect((await listChecklistBank()).map((i) => i.text)).toEqual(['Walk']);
  });

  it('returns an empty bank for a body with no items array, never throwing', async () => {
    call.mockResolvedValue({});
    expect(await listChecklistBank()).toEqual([]);
  });

  it('propagates a callable rejection unchanged, so the editor can name it (fail-loud)', async () => {
    call.mockRejectedValue(new Error('permission-denied'));
    await expect(listChecklistBank()).rejects.toThrow('permission-denied');
  });
});

describe('saveChecklistBankItem', () => {
  it('sends the trimmed text and the scope', async () => {
    call.mockResolvedValue({ id: 'walk', text: 'Walk', scope: 'PER_PET' });
    await saveChecklistBankItem('  Walk  ', 'PER_PET');
    expect(call).toHaveBeenCalledWith('saveChecklistBankItem', { text: 'Walk', scope: 'PER_PET' });
  });

  it('coerces an unrecognized scope to PER_PET, matching the callable zod enum', async () => {
    call.mockResolvedValue({ id: 'walk', text: 'Walk', scope: 'PER_PET' });
    await saveChecklistBankItem('Walk', 'nonsense');
    expect(call).toHaveBeenCalledWith('saveChecklistBankItem', { text: 'Walk', scope: 'PER_PET' });
  });

  it('refuses a blank item locally instead of spending a round trip on a guaranteed zod failure', async () => {
    await expect(saveChecklistBankItem('   ', 'PER_PET')).rejects.toThrow(/blank/i);
    expect(call).not.toHaveBeenCalled();
  });

  it('propagates a callable rejection unchanged', async () => {
    call.mockRejectedValue(new Error('unauthenticated'));
    await expect(saveChecklistBankItem('Walk', 'PER_PET')).rejects.toThrow('unauthenticated');
  });
});
