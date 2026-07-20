import { describe, it, expect, vi, beforeEach } from 'vitest';

const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../lib/fns', () => ({ call }));

import { getFormSchema, saveFormSchema, type FormSchemaDetail } from './formSchemasWrite';

beforeEach(() => call.mockReset());

function schema(over: Partial<FormSchemaDetail> = {}): FormSchemaDetail {
  return {
    id: 'tribeProfile',
    name: 'Tribe Profile',
    description: null,
    appliesTo: 'NONE',
    version: 3,
    sections: [
      {
        title: 'Fields',
        description: null,
        fields: [
          {
            key: 'firstName',
            label: 'First name',
            type: 'text',
            required: true,
            helperText: null,
            placeholder: null,
            options: null,
            defaultValue: null,
            group: null,
          },
        ],
      },
    ],
    ...over,
  };
}

describe('formSchemasWrite api', () => {
  it('getFormSchema sends { schemaId }, matching the backend contract exactly (not id)', async () => {
    const dto = schema();
    call.mockResolvedValue(dto);
    const result = await getFormSchema('tribeProfile');
    expect(call).toHaveBeenCalledWith('getFormSchema', { schemaId: 'tribeProfile' });
    expect(result).toEqual(dto);
  });

  it('getFormSchema returns the DTO unwrapped, the handler sends no envelope', async () => {
    const dto = schema({ id: 'vetInfo', name: 'Vet Info' });
    call.mockResolvedValue(dto);
    const result = await getFormSchema('vetInfo');
    expect(result.name).toBe('Vet Info');
  });

  it('getFormSchema surfaces a rejection (e.g. not-found) rather than swallowing it', async () => {
    call.mockRejectedValueOnce(new Error("Schema 'ghost' not found."));
    await expect(getFormSchema('ghost')).rejects.toThrow("Schema 'ghost' not found.");
  });

  it('saveFormSchema sends the whole schema under { schema }', async () => {
    const input = schema({ version: 0 });
    call.mockResolvedValue({ ok: true, id: 'tribeProfile', version: 1 });
    const result = await saveFormSchema(input);
    expect(call).toHaveBeenCalledWith('saveFormSchema', { schema: input });
    expect(result).toEqual({ id: 'tribeProfile', version: 1 });
  });

  it('saveFormSchema adopts the server-computed version, not the value sent', async () => {
    const input = schema({ version: 0 });
    call.mockResolvedValue({ ok: true, id: 'tribeProfile', version: 7 });
    const result = await saveFormSchema(input);
    expect(result.version).toBe(7);
  });

  it('saveFormSchema surfaces a rejection (e.g. validation failure) rather than swallowing it', async () => {
    call.mockRejectedValueOnce(new Error('formSchema validation failed'));
    await expect(saveFormSchema(schema())).rejects.toThrow('formSchema validation failed');
  });
});
