// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type FormField, type FormSchemaDetail } from '../api/formSchemasWrite';

const { getFormSchema, saveFormSchema } = vi.hoisted(() => ({
  getFormSchema: vi.fn(),
  saveFormSchema: vi.fn(),
}));
vi.mock('../api/formSchemasWrite', async (orig) => ({
  ...(await orig<typeof import('../api/formSchemasWrite')>()),
  getFormSchema,
  saveFormSchema,
}));

import {
  FormSchemaEditor,
  isCreateMode,
  flattenSections,
  buildSections,
  validateField,
  validateSchema,
  moveUp,
  moveDown,
  emptyField,
} from './FormSchemaEditor';

function field(over: Partial<FormField> = {}): FormField {
  return {
    key: 'firstName',
    label: 'First name',
    type: 'text',
    required: true,
    helperText: null,
    placeholder: null,
    options: null,
    defaultValue: null,
    group: null,
    ...over,
  };
}

function schema(over: Partial<FormSchemaDetail> = {}): FormSchemaDetail {
  return {
    id: 'tribeProfile',
    name: 'Tribe Profile',
    description: null,
    appliesTo: 'NONE',
    version: 3,
    sections: [{ title: 'Basics', description: null, fields: [field()] }],
    ...over,
  };
}

beforeEach(() => {
  getFormSchema.mockReset();
  saveFormSchema.mockReset();
});

describe('isCreateMode (pure)', () => {
  it('is true for undefined, empty, and blank ids', () => {
    expect(isCreateMode(undefined)).toBe(true);
    expect(isCreateMode('')).toBe(true);
    expect(isCreateMode('   ')).toBe(true);
  });
  it('is false for a real id', () => {
    expect(isCreateMode('tribeProfile')).toBe(false);
  });
});

describe('flattenSections (pure)', () => {
  it('returns an empty field list and the default title for zero sections', () => {
    const r = flattenSections([]);
    expect(r).toEqual({ fields: [], meta: { title: 'Fields', description: null }, wasMultiSection: false });
  });

  it('preserves the single section title/description losslessly', () => {
    const r = flattenSections([{ title: 'Basics', description: 'desc', fields: [field()] }]);
    expect(r.meta).toEqual({ title: 'Basics', description: 'desc' });
    expect(r.fields).toEqual([field()]);
    expect(r.wasMultiSection).toBe(false);
  });

  it('falls back to a blank title when the single section title is blank', () => {
    const r = flattenSections([{ title: '', description: null, fields: [] }]);
    expect(r.meta.title).toBe('Fields');
  });

  it('merges multiple sections and flags wasMultiSection, dropping per-section titles', () => {
    const a = field({ key: 'a' });
    const b = field({ key: 'b' });
    const r = flattenSections([
      { title: 'Sec A', description: null, fields: [a] },
      { title: 'Sec B', description: null, fields: [b] },
    ]);
    expect(r.fields).toEqual([a, b]);
    expect(r.meta).toEqual({ title: 'Fields', description: null });
    expect(r.wasMultiSection).toBe(true);
  });
});

describe('buildSections (pure)', () => {
  it('wraps a flat field list in exactly one section carrying the given meta', () => {
    const fields = [field()];
    expect(buildSections({ title: 'Fields', description: 'd' }, fields)).toEqual([
      { title: 'Fields', description: 'd', fields },
    ]);
  });
});

describe('validateField (pure)', () => {
  it('flags a blank key', () => {
    expect(validateField(field({ key: '' }), new Set()).keyError).toMatch(/required/i);
  });
  it('flags a key that does not match the backend regex', () => {
    expect(validateField(field({ key: '1abc' }), new Set()).keyError).toMatch(/letter/i);
    expect(validateField(field({ key: 'a b' }), new Set()).keyError).toMatch(/letter/i);
  });
  it('flags a duplicate key against the seen set', () => {
    expect(validateField(field({ key: 'dup' }), new Set(['dup'])).keyError).toMatch(/duplicate/i);
  });
  it('flags a blank label', () => {
    expect(validateField(field({ label: '' }), new Set()).labelError).toMatch(/required/i);
  });
  it('requires options for select/multiselect but not for text', () => {
    expect(validateField(field({ type: 'select', options: null }), new Set()).optionsError).toMatch(/option/i);
    expect(validateField(field({ type: 'multiselect', options: [] }), new Set()).optionsError).toMatch(/option/i);
    expect(validateField(field({ type: 'select', options: ['a'] }), new Set()).optionsError).toBeNull();
    expect(validateField(field({ type: 'text', options: null }), new Set()).optionsError).toBeNull();
  });
  it('passes a fully valid field clean', () => {
    const v = validateField(field(), new Set());
    expect(v).toEqual({ keyError: null, labelError: null, optionsError: null });
  });
});

describe('validateSchema (pure)', () => {
  it('requires a schema id', () => {
    expect(validateSchema({ id: '', name: 'X', fields: [field()] })).toContain('Schema id is required.');
  });
  it('rejects a schema id that fails the backend regex', () => {
    expect(validateSchema({ id: '1bad', name: 'X', fields: [field()] })).toEqual(
      expect.arrayContaining([expect.stringMatching(/schema id must start with a letter/i)]),
    );
  });
  it('requires a schema name', () => {
    expect(validateSchema({ id: 'ok', name: '', fields: [field()] })).toContain('Schema name is required.');
  });
  it('requires at least one field', () => {
    expect(validateSchema({ id: 'ok', name: 'X', fields: [] })).toContain('At least one field is required.');
  });
  it('flags a duplicate key across the field list, once, on the second occurrence', () => {
    const errs = validateSchema({
      id: 'ok',
      name: 'X',
      fields: [field({ key: 'dup' }), field({ key: 'dup' })],
    });
    expect(errs.filter((e) => /duplicate/i.test(e))).toHaveLength(1);
  });
  it('is empty for a fully valid schema', () => {
    expect(validateSchema({ id: 'tribeProfile', name: 'Tribe Profile', fields: [field()] })).toEqual([]);
  });
});

describe('moveUp / moveDown (pure)', () => {
  it('swaps with the previous element', () => {
    expect(moveUp(['a', 'b', 'c'], 1)).toEqual(['b', 'a', 'c']);
  });
  it('is a no-op at index 0', () => {
    expect(moveUp(['a', 'b'], 0)).toEqual(['a', 'b']);
  });
  it('swaps with the next element', () => {
    expect(moveDown(['a', 'b', 'c'], 0)).toEqual(['b', 'a', 'c']);
  });
  it('is a no-op at the last index', () => {
    expect(moveDown(['a', 'b'], 1)).toEqual(['a', 'b']);
  });
});

describe('emptyField (pure)', () => {
  it('seeds a blank text field, not required', () => {
    expect(emptyField()).toEqual({
      key: '',
      label: '',
      type: 'text',
      required: false,
      helperText: null,
      placeholder: null,
      options: null,
      defaultValue: null,
      group: null,
    });
  });
});

describe('FormSchemaEditor: create mode', () => {
  it('seeds a blank schema and does not call getFormSchema', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByLabelText(/schema id/i)).toHaveValue('');
    expect(getFormSchema).not.toHaveBeenCalled();
  });

  it('disables Save until id, name, and at least one valid field are present', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled(); // no fields yet

    await userEvent.click(screen.getByRole('button', { name: /add field/i }));
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled(); // key/label blank

    await userEvent.type(screen.getByLabelText(/^key$/i), 'firstName');
    await userEvent.type(screen.getByLabelText(/^label$/i), 'First name');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeEnabled();
  });

  it('saves via saveFormSchema wrapping the field list in one section, and reports the new id', async () => {
    saveFormSchema.mockResolvedValue({ id: 'newSchema', version: 1 });
    const onSaved = vi.fn();
    render(<FormSchemaEditor onSaved={onSaved} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
    await userEvent.click(screen.getByRole('button', { name: /add field/i }));
    await userEvent.type(screen.getByLabelText(/^key$/i), 'firstName');
    await userEvent.type(screen.getByLabelText(/^label$/i), 'First name');

    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));

    await waitFor(() => expect(saveFormSchema).toHaveBeenCalledTimes(1));
    const sent = saveFormSchema.mock.calls[0]?.[0] as FormSchemaDetail;
    expect(sent.id).toBe('newSchema');
    expect(sent.name).toBe('New Schema');
    expect(sent.sections).toEqual([
      {
        title: 'Fields',
        description: null,
        fields: [
          {
            key: 'firstName',
            label: 'First name',
            type: 'text',
            required: false,
            helperText: null,
            placeholder: null,
            options: null,
            defaultValue: null,
            group: null,
          },
        ],
      },
    ]);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('newSchema'));
  });

  it('fails loud when saveFormSchema rejects, naming the callable, and does not call onSaved', async () => {
    saveFormSchema.mockRejectedValue(new Error('formSchema validation failed'));
    const onSaved = vi.fn();
    render(<FormSchemaEditor onSaved={onSaved} onCancel={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
    await userEvent.click(screen.getByRole('button', { name: /add field/i }));
    await userEvent.type(screen.getByLabelText(/^key$/i), 'firstName');
    await userEvent.type(screen.getByLabelText(/^label$/i), 'First name');
    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));

    expect(await screen.findByText(/saveFormSchema failed:.*validation failed/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('calls onCancel and never calls saveFormSchema when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(saveFormSchema).not.toHaveBeenCalled();
  });
});

describe('FormSchemaEditor: edit mode', () => {
  it('loads via getFormSchema and renders the existing name, id (locked), and field', async () => {
    getFormSchema.mockResolvedValue(schema());
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);

    expect(await screen.findByDisplayValue('Tribe Profile')).toBeInTheDocument();
    expect(getFormSchema).toHaveBeenCalledWith('tribeProfile');
    expect(screen.getByLabelText(/schema id/i)).toBeDisabled();
    expect(screen.getByDisplayValue('firstName')).toBeInTheDocument();
  });

  it('fails loud when getFormSchema rejects, naming the callable', async () => {
    getFormSchema.mockRejectedValue(new Error("Schema 'tribeProfile' not found."));
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText(/getFormSchema failed:.*not found/i)).toBeInTheDocument();
  });

  it('warns and merges when the loaded schema has more than one section', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          { title: 'Sec A', description: null, fields: [field({ key: 'a' })] },
          { title: 'Sec B', description: null, fields: [field({ key: 'b' })] },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText(/sections merged/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('a')).toBeInTheDocument();
    expect(screen.getByDisplayValue('b')).toBeInTheDocument();
  });

  it('removes a field via its remove button', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          {
            title: 'Basics',
            description: null,
            fields: [field({ key: 'a', label: 'Field A' }), field({ key: 'b', label: 'Field B' })],
          },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('a');
    await userEvent.click(screen.getByRole('button', { name: /remove field a/i }));
    expect(screen.queryByDisplayValue('a')).toBeNull();
    expect(screen.getByDisplayValue('b')).toBeInTheDocument();
  });

  it('reorders fields with the move-down control', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          {
            title: 'Basics',
            description: null,
            fields: [field({ key: 'a', label: 'Field A' }), field({ key: 'b', label: 'Field B' })],
          },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('a');
    const keyInputsBefore = screen.getAllByLabelText(/^key$/i) as HTMLInputElement[];
    expect(keyInputsBefore.map((i) => i.value)).toEqual(['a', 'b']);

    await userEvent.click(screen.getByRole('button', { name: /move field a down/i }));

    const keyInputsAfter = screen.getAllByLabelText(/^key$/i) as HTMLInputElement[];
    expect(keyInputsAfter.map((i) => i.value)).toEqual(['b', 'a']);
  });

  it('shows an options input only for select/multiselect, required by validation', async () => {
    getFormSchema.mockResolvedValue(schema());
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('firstName');
    expect(screen.queryByLabelText(/options/i)).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText(/^type$/i), 'select');
    expect(await screen.findByLabelText(/options/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/options/i), 'Dog, Cat');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeEnabled();
  });

  it('disables all actions while a save is in flight', async () => {
    getFormSchema.mockResolvedValue(schema());
    let resolveSave!: (v: { id: string; version: number }) => void;
    saveFormSchema.mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByDisplayValue('firstName');

    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();

    resolveSave({ id: 'tribeProfile', version: 4 });
    await waitFor(() => expect(screen.getByRole('button', { name: /save schema/i })).toBeInTheDocument());
  });
});
