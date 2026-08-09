// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  schemaMetaErrors,
  fieldListErrors,
  moveUp,
  moveDown,
  emptyField,
  deriveFieldKey,
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

/**
 * The split exists so the wizard can put each problem on the STEP THAT OWNS THE
 * FIELD rather than in one flat banner at the bottom of a very long form.
 * `validateSchema` stays the concatenation of the two, so the whole-schema
 * contract above is unchanged.
 */
describe('schemaMetaErrors / fieldListErrors (pure)', () => {
  it('keeps id and name problems on the schema step', () => {
    expect(schemaMetaErrors({ id: '', name: '' })).toEqual([
      'Schema id is required.',
      'Schema name is required.',
    ]);
  });

  it('leaves field problems out of the schema step', () => {
    expect(schemaMetaErrors({ id: 'ok', name: 'X' })).toEqual([]);
  });

  it('keeps the empty-list and per-field problems on the fields step', () => {
    expect(fieldListErrors([])).toEqual(['At least one field is required.']);
    expect(fieldListErrors([field({ label: '' })])).toEqual(['Field 1: Label is required.']);
  });

  it('leaves id and name problems out of the fields step', () => {
    expect(fieldListErrors([field()])).toEqual([]);
  });

  it('composes back into validateSchema, in the same order', () => {
    const input = { id: '', name: '', fields: [field({ key: '' })] };
    expect(validateSchema(input)).toEqual([
      ...schemaMetaErrors(input),
      ...fieldListErrors(input.fields),
    ]);
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

describe('deriveFieldKey (pure)', () => {
  it('camelCases a multi-word label', () => {
    expect(deriveFieldKey('First name')).toBe('firstName');
    expect(deriveFieldKey('Service address line 1')).toBe('serviceAddressLine1');
  });
  it('strips punctuation and collapses separators', () => {
    expect(deriveFieldKey("Pet's Age (yrs)")).toBe('petsAgeYrs');
    expect(deriveFieldKey('  Emergency   contact  ')).toBe('emergencyContact');
  });
  it('drops leading digits so the key satisfies KEY_RE', () => {
    expect(deriveFieldKey('2nd contact')).toBe('ndContact');
    expect(validateField(field({ key: deriveFieldKey('2nd contact'), label: '2nd contact' }), new Set()).keyError).toBeNull();
  });
  it('returns empty for a label with no letters or digits', () => {
    expect(deriveFieldKey('   ')).toBe('');
    expect(deriveFieldKey('!!!')).toBe('');
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

/**
 * The editor is a workflow modal with one section per step, so a test that
 * wants a field has to be standing on the step that owns it. These walk the
 * RAIL, which is the operator's own free-jump navigation, rather than pressing
 * Next repeatedly.
 *
 * A step that is not current is asserted by ABSENCE FROM THE DOM, never by
 * `toBeVisible`: jsdom ships no user-agent stylesheet, so `toBeVisible` passes
 * on content a browser hides.
 */
async function goToStep(label: 'Schema' | 'Fields' | 'Review') {
  await userEvent.click(screen.getByRole('button', { name: new RegExp(`^\\d ${label}`) }));
}

/** Fills in a complete, valid one-field schema, ending on the Review step. */
async function fillValidSchema() {
  await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
  await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
  await goToStep('Fields');
  await userEvent.click(screen.getByRole('button', { name: /add field/i }));
  await userEvent.type(screen.getByLabelText(/^key$/i), 'firstName');
  await userEvent.type(screen.getByLabelText(/^label$/i), 'First name');
  await goToStep('Review');
}

describe('FormSchemaEditor: the workflow modal', () => {
  it('is a labelled modal, opening on the first step', () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('New Form Schema');
    expect(screen.getByRole('navigation', { name: 'New Form Schema steps' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
  });

  it('keeps each section on its own step, so the other steps are not in the DOM', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText(/schema id/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add field/i })).toBeNull();

    await goToStep('Fields');
    expect(screen.getByRole('button', { name: /add field/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/schema id/i)).toBeNull();
  });

  it('keeps what was typed when the operator leaves the step and comes back', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Tribe Profile');
    await goToStep('Fields');
    await goToStep('Schema');
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Tribe Profile');
  });

  it('flags the step that owns a problem, from the rail', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    // Blank id + blank name on step 1; no fields at all on step 2.
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAccessibleName(
      '1 Schema 2 things to fix',
    );
    expect(screen.getByRole('button', { name: /^2 Fields/ })).toHaveAccessibleName(
      '2 Fields 1 thing to fix',
    );

    await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAccessibleName('1 Schema');
  });

  it('draws helper text, placeholder, default and group in full, never behind a disclosure', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Fields');
    await userEvent.click(screen.getByRole('button', { name: /add field/i }));
    expect(screen.getByLabelText(/helper text/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/placeholder/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/default value/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^group$/i)).toBeInTheDocument();
    expect(document.querySelector('details')).toBeNull();
  });

  it('warns before discarding typed work, and closes only when the operator says so', async () => {
    const onCancel = vi.fn();
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={onCancel} />);
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Half a schema');
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('summarises what will be written on the review step', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidSchema();
    expect(screen.getByText('1 field')).toBeInTheDocument();
    // Scoped to the summary list: the live preview beside this step renders the
    // same label as a real control, so an unscoped query matches both.
    const summary = within(screen.getByRole('list', { name: 'Fields in this schema' }));
    expect(summary.getByText('First name')).toBeInTheDocument();
    expect(summary.getByText(/firstName · text/)).toBeInTheDocument();
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
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled();

    await goToStep('Schema');
    await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled(); // no fields yet

    await goToStep('Fields');
    await userEvent.click(screen.getByRole('button', { name: /add field/i }));
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled(); // key/label blank

    await goToStep('Fields');
    await userEvent.type(screen.getByLabelText(/^key$/i), 'firstName');
    await userEvent.type(screen.getByLabelText(/^label$/i), 'First name');
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeEnabled();
  });

  it('auto-derives a blank field key from the label on blur (AO-49), never overwriting a typed key', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Fields');
    await userEvent.click(screen.getByRole('button', { name: /add field/i }));

    // Type a label, blur, the empty key is filled from it.
    const label = screen.getByLabelText(/^label$/i);
    await userEvent.type(label, 'First name');
    await userEvent.tab();
    expect(screen.getByLabelText(/^key$/i)).toHaveValue('firstName');

    // A hand-set key is preserved: a later label edit + blur leaves it alone.
    const key = screen.getByLabelText(/^key$/i);
    await userEvent.clear(key);
    await userEvent.type(key, 'customKey');
    await userEvent.clear(label);
    await userEvent.type(label, 'Last name');
    await userEvent.tab();
    expect(screen.getByLabelText(/^key$/i)).toHaveValue('customKey');
  });

  it('saves via saveFormSchema wrapping the field list in one section, and reports the new id', async () => {
    saveFormSchema.mockResolvedValue({ id: 'newSchema', version: 1 });
    const onSaved = vi.fn();
    render(<FormSchemaEditor onSaved={onSaved} onCancel={vi.fn()} />);

    await fillValidSchema();
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

    await fillValidSchema();
    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));

    expect(await screen.findByText(/saveFormSchema failed:.*validation failed/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('keeps a refusal on screen from every step, because it is the flow that failed', async () => {
    saveFormSchema.mockRejectedValue(new Error('formSchema validation failed'));
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidSchema();
    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));
    await screen.findByText(/saveFormSchema failed/i);

    await goToStep('Schema');
    expect(screen.getByText(/saveFormSchema failed/i)).toBeInTheDocument();
  });

  it('calls onCancel and never calls saveFormSchema when Cancel is clicked on a clean form', async () => {
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
    await goToStep('Fields');
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
    await goToStep('Fields');
    expect(screen.getByDisplayValue('a')).toBeInTheDocument();
    expect(screen.getByDisplayValue('b')).toBeInTheDocument();
    // The warning is about the whole record, so it follows the operator across steps.
    expect(screen.getByText(/sections merged/i)).toBeInTheDocument();
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
    await screen.findByLabelText(/schema id/i);
    await goToStep('Fields');
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
    await screen.findByLabelText(/schema id/i);
    await goToStep('Fields');
    const keyInputsBefore = screen.getAllByLabelText(/^key$/i) as HTMLInputElement[];
    expect(keyInputsBefore.map((i) => i.value)).toEqual(['a', 'b']);

    await userEvent.click(screen.getByRole('button', { name: /move field a down/i }));

    const keyInputsAfter = screen.getAllByLabelText(/^key$/i) as HTMLInputElement[];
    expect(keyInputsAfter.map((i) => i.value)).toEqual(['b', 'a']);
  });

  it('shows an options input only for select/multiselect, required by validation', async () => {
    getFormSchema.mockResolvedValue(schema());
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Fields');
    expect(screen.queryByLabelText(/options/i)).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText(/^type$/i), 'select');
    expect(await screen.findByLabelText(/options/i)).toBeInTheDocument();
    // The problem belongs to the Fields step, and the rail says so from anywhere.
    expect(screen.getByRole('button', { name: /^2 Fields/ })).toHaveAccessibleName(
      '2 Fields 1 thing to fix',
    );
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled();

    await goToStep('Fields');
    await userEvent.type(screen.getByLabelText(/options/i), 'Dog, Cat');
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeEnabled();
  });

  it('disables all actions while a save is in flight', async () => {
    getFormSchema.mockResolvedValue(schema());
    let resolveSave!: (v: { id: string; version: number }) => void;
    saveFormSchema.mockImplementation(
      () => new Promise((resolve) => { resolveSave = resolve; }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Review');

    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));
    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();

    resolveSave({ id: 'tribeProfile', version: 4 });
    await waitFor(() => expect(screen.getByRole('button', { name: /save schema/i })).toBeInTheDocument());
  });
});
/**
 * The live preview column. `page-specs/27-formschema-editor.md` item 3 has had
 * this pane gated dark behind `FF_FORMSCHEMA_LIVE_PREVIEW` for want of a render
 * path; these assertions are that path existing and tracking the editor state.
 */
describe('FormSchemaEditor: live preview', () => {
  it('renders the loaded schema as a kinfolk would see it', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          {
            title: 'Basics',
            description: 'About the household.',
            fields: [field({ key: 'homeType', label: 'Home type', type: 'select', options: ['House', 'Condo'], required: false })],
          },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    const preview = await screen.findByRole('region', { name: 'Live preview' });
    expect(preview).toHaveTextContent('Basics');
    expect(preview).toHaveTextContent('About the household.');
    expect(within(preview).getByLabelText('Home type').tagName).toBe('SELECT');
    expect(within(preview).getByRole('option', { name: 'House' })).toBeInTheDocument();
  });
  it('follows an edit to a field label without a save', async () => {
    getFormSchema.mockResolvedValue(
      schema({ sections: [{ title: 'Basics', description: null, fields: [field({ label: 'First name' })] }] }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    const preview = await screen.findByRole('region', { name: 'Live preview' });
    expect(within(preview).getByLabelText('First name *')).toBeInTheDocument();
    // The preview is the wizard's `aside`, so it sits BESIDE the Fields step
    // rather than being replaced by it. That is the whole claim: typing into a
    // field updates a pane the operator can still see while typing.
    await goToStep('Fields');
    const labelInput = screen.getAllByLabelText(/^label$/i)[0]!;
    await userEvent.clear(labelInput);
    await userEvent.type(labelInput, 'Given name');
    expect(within(preview).getByLabelText('Given name *')).toBeInTheDocument();
  });
  it('shows the empty prompt on a brand-new schema with no fields', () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(
      within(screen.getByRole('region', { name: 'Live preview' })).getByText(/No fields yet/),
    ).toBeInTheDocument();
  });
  it('renders no preview at all while the schema is still loading', () => {
    getFormSchema.mockReturnValue(new Promise(() => {}));
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Live preview' })).toBeNull();
  });
});
