// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type FormField, type FormSection, type FormSchemaDetail } from '../api/formSchemasWrite';

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
  emptySection,
  validateField,
  validateSchema,
  schemaMetaErrors,
  sectionErrors,
  sectionListErrors,
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

function section(over: Partial<FormSection> = {}): FormSection {
  return {
    title: 'Basics',
    description: null,
    fields: [field()],
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
    sections: [section()],
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

describe('emptySection (pure)', () => {
  it('seeds a blank-titled section with no description and no fields', () => {
    expect(emptySection()).toEqual({ title: '', description: null, fields: [] });
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

describe('schemaMetaErrors (pure)', () => {
  it('keeps id and name problems on the schema step', () => {
    expect(schemaMetaErrors({ id: '', name: '' })).toEqual([
      'Schema id is required.',
      'Schema name is required.',
    ]);
  });
  it('rejects a schema id that fails the backend regex', () => {
    expect(schemaMetaErrors({ id: '1bad', name: 'X' })).toEqual(
      expect.arrayContaining([expect.stringMatching(/schema id must start with a letter/i)]),
    );
  });
  it('is empty for a valid id and name', () => {
    expect(schemaMetaErrors({ id: 'ok', name: 'X' })).toEqual([]);
  });
});

/**
 * One section's own problems: title, empty-field-list, and every field's own,
 * numbered WITHIN the section. Duplicate keys are scoped to the section, not
 * the whole schema, mirroring `SectionSchema.superRefine` on the server and
 * Android's `FormSchemaValidator` (which resets `seenKeysInSection` per
 * section).
 */
describe('sectionErrors / sectionListErrors (pure)', () => {
  it('flags a blank section title', () => {
    expect(sectionErrors(section({ title: '' }), 1)).toContain('Section 1: Section title is required.');
  });
  it('flags an empty field list', () => {
    expect(sectionErrors(section({ fields: [] }), 2)).toContain('Section 2: At least one field is required.');
  });
  it('numbers a per-field problem with both the section and the field', () => {
    expect(sectionErrors(section({ fields: [field({ label: '' })] }), 1)).toEqual(
      expect.arrayContaining(['Section 1, Field 1: Label is required.']),
    );
  });
  it('is empty for a fully valid section', () => {
    expect(sectionErrors(section(), 1)).toEqual([]);
  });

  it('requires at least one section', () => {
    expect(sectionListErrors([])).toContain('At least one section is required.');
  });
  it("concatenates every section's own errors in order", () => {
    const sections = [section({ title: '' }), section({ fields: [] })];
    expect(sectionListErrors(sections)).toEqual([
      ...sectionErrors(sections[0]!, 1),
      ...sectionErrors(sections[1]!, 2),
    ]);
  });
  it('does not flag the same key reused across two different sections', () => {
    const errs = sectionListErrors([
      section({ title: 'A', fields: [field({ key: 'shared' })] }),
      section({ title: 'B', fields: [field({ key: 'shared' })] }),
    ]);
    expect(errs.filter((e) => /duplicate/i.test(e))).toEqual([]);
  });
  it('flags a duplicate key within the same section, once, on the second occurrence', () => {
    const errs = sectionListErrors([
      section({ fields: [field({ key: 'dup' }), field({ key: 'dup' })] }),
    ]);
    expect(errs.filter((e) => /duplicate/i.test(e))).toHaveLength(1);
  });
});

describe('validateSchema (pure)', () => {
  it('requires a schema id', () => {
    expect(validateSchema({ id: '', name: 'X', sections: [section()] })).toContain('Schema id is required.');
  });
  it('requires a schema name', () => {
    expect(validateSchema({ id: 'ok', name: '', sections: [section()] })).toContain('Schema name is required.');
  });
  it('requires at least one section', () => {
    expect(validateSchema({ id: 'ok', name: 'X', sections: [] })).toContain('At least one section is required.');
  });
  it('is empty for a fully valid schema', () => {
    expect(validateSchema({ id: 'tribeProfile', name: 'Tribe Profile', sections: [section()] })).toEqual([]);
  });
  it('composes schemaMetaErrors and sectionListErrors, in that order', () => {
    const input = { id: '', name: '', sections: [section({ title: '' })] };
    expect(validateSchema(input)).toEqual([
      ...schemaMetaErrors(input),
      ...sectionListErrors(input.sections),
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
 * The editor is a workflow modal, so a test that wants a field or a section
 * has to be standing on the step that owns it. These walk the RAIL, which is
 * the operator's own free-jump navigation, rather than pressing Next
 * repeatedly.
 *
 * A step that is not current is asserted by ABSENCE FROM THE DOM, never by
 * `toBeVisible`: jsdom ships no user-agent stylesheet, so `toBeVisible` passes
 * on content a browser hides.
 */
async function goToStep(label: 'Schema' | 'Sections' | 'Review') {
  await userEvent.click(screen.getByRole('button', { name: new RegExp(`^\\d ${label}`) }));
}

/**
 * Fills in a complete, valid one-section, one-field schema, ending on the
 * Review step. A NEW schema seeds one section already (blank title, no
 * fields, parity with Android's `load(null)`), so this only has to name that
 * section and add one field to it, never call "Add section".
 */
async function fillValidSchema() {
  await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
  await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
  await goToStep('Sections');
  await userEvent.type(screen.getByLabelText(/section title/i), 'Basics');
  await userEvent.click(screen.getByRole('button', { name: /add field/i }));
  await userEvent.type(screen.getByLabelText(/^key$/i), 'firstName');
  await userEvent.type(screen.getByLabelText(/^label$/i), 'First name');
  await goToStep('Review');
}

describe('FormSchemaEditor: the workflow modal', () => {
  it('is a labelled modal, opening on the first step', () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    // The mock's SectionHeader copy, sentence case.
    expect(screen.getByRole('dialog')).toHaveAccessibleName('New form schema');
    expect(screen.getByRole('navigation', { name: 'New form schema steps' })).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
  });

  it('keeps the schema fields and the sections list on separate steps, so the other is not in the DOM', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText(/schema id/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add field/i })).toBeNull();

    await goToStep('Sections');
    expect(screen.getByRole('button', { name: /add field/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/schema id/i)).toBeNull();
  });

  it('keeps what was typed when the operator leaves the step and comes back', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Tribe Profile');
    await goToStep('Sections');
    await goToStep('Schema');
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Tribe Profile');
  });

  it('flags the step that owns a problem, from the rail', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    // Nothing is claimed about a form nobody has typed in yet (see the pristine
    // describe below); one keystroke on the schema step is what puts its own
    // problems on the rail.
    await userEvent.type(screen.getByLabelText(/schema id/i), 'x');
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAccessibleName(
      '1 Schema 1 thing to fix',
    );

    await userEvent.clear(screen.getByLabelText(/schema id/i));
    await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAccessibleName('1 Schema');
  });

  it('draws helper text, placeholder, default and group in full, never behind a disclosure', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Sections');
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

  it('draws the mock schema step: required marks, the locked-id note, the mock placeholders, a two-line description', async () => {
    getFormSchema.mockResolvedValue(schema());
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    const idInput = await screen.findByLabelText(/schema id/i);
    expect(idInput).toBeDisabled();
    expect(idInput).toHaveAttribute('placeholder', 'tribeProfile');
    // The mock's "(immutable once persisted)" note sits inside the label, so
    // the control's own name says the id is locked.
    expect(idInput).toHaveAccessibleName('Schema id (immutable once persisted)');
    expect(screen.getByLabelText(/^name$/i)).toHaveAttribute('placeholder', 'Tribe Profile');
    const description = screen.getByLabelText(/^description$/i);
    expect(description.tagName).toBe('TEXTAREA');
    expect(description).toHaveAttribute('placeholder', 'Optional admin-facing description');
    // The required mark is the stylesheet's, so the names stay the label's words.
    expect(screen.getByText('Name')).toHaveClass('fse__label--required');
    expect(screen.getByText('Description')).not.toHaveClass('fse__label--required');
    // The mock's `.bb` inputs, not boxed ones.
    expect(idInput).toHaveClass('fse__input');
  });

  it('says nothing under a step heading: the three step blurbs are gone (2026-09-11 ruling)', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(document.querySelector('.wiz__step-blurb')).toBeNull();
    await goToStep('Sections');
    expect(document.querySelector('.wiz__step-blurb')).toBeNull();
    await goToStep('Review');
    expect(document.querySelector('.wiz__step-blurb')).toBeNull();
  });

  it('draws the mock field card: Field n tag with its tools, key and label side by side, the type chips, the stack, and Yes / No for required', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Sections');
    await userEvent.click(screen.getByRole('button', { name: /add field/i }));

    const card = document.querySelector('.fse__field-card')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('.fse__field-head .fse__field-tag')).toHaveTextContent('Field 1');
    expect(within(card as HTMLElement).getByRole('button', { name: /remove field/i })).toBeInTheDocument();
    // Key and label share the mock's two-column grid.
    const grid2 = card.querySelector('.fse__grid2')!;
    expect(within(grid2 as HTMLElement).getByLabelText(/^key$/i)).toBeInTheDocument();
    expect(within(grid2 as HTMLElement).getByLabelText(/^label$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^key$/i)).toHaveAttribute('placeholder', 'householdName');

    // The nine supported types as chips, "text" chosen on a new field. No <select>.
    const types = screen.getByRole('radiogroup', { name: 'Type' });
    const chips = within(types).getAllByRole('radio');
    expect(chips.map((c) => c.textContent)).toEqual([
      'text', 'textarea', 'select', 'multiselect', 'date', 'number', 'checkbox', 'phone', 'email',
    ]);
    expect(within(types).getByRole('radio', { name: 'text' })).toHaveAttribute('aria-checked', 'true');
    expect(within(types).getByRole('radio', { name: 'text' })).toHaveClass('fse__chip--on');
    expect(card.querySelector('select')).toBeNull();

    // Required is the mock's Yes / No segmented picker, No on a new field, never a checkbox.
    const required = screen.getByRole('radiogroup', { name: 'Required' });
    expect(within(required).getByRole('radio', { name: 'No' })).toHaveAttribute('aria-checked', 'true');
    expect(within(required).getByRole('radio', { name: 'Yes' })).toHaveAttribute('aria-checked', 'false');
    expect(card.querySelector('input[type="checkbox"]')).toBeNull();
    await userEvent.click(within(required).getByRole('radio', { name: 'Yes' }));
    expect(within(required).getByRole('radio', { name: 'Yes' })).toHaveAttribute('aria-checked', 'true');
    expect(within(required).getByRole('radio', { name: 'Yes' })).toHaveClass('fse__seg-btn--on');

    // The four optional fields stack under the chips, inside the card.
    const stack = card.querySelector('.fse__stack')!;
    expect(within(stack as HTMLElement).getByLabelText(/helper text/i)).toBeInTheDocument();
    expect(within(stack as HTMLElement).getByLabelText(/^group$/i)).toBeInTheDocument();
  });

  it('lays the sections step out as the mock: Add section at the head of the list, Add field in the fields bar of each card', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Sections');
    const body = document.querySelector('.wiz__step')!;
    const order = Array.from(body.querySelectorAll('.fse__step-actions, .fse__sections')).map((el) => el.className);
    expect(order).toEqual(['fse__step-actions', 'fse__sections']);
    expect(within(body.querySelector('.fse__step-actions') as HTMLElement).getByRole('button', { name: /add section/i })).toBeInTheDocument();
    const bar = document.querySelector('.fse__section-fields-row')!;
    expect(bar).toHaveTextContent('Fields (0)');
    expect(within(bar as HTMLElement).getByRole('button', { name: /add field/i })).toBeInTheDocument();
    // The section card is the mock's gradient card, not a DenPanel.
    expect(document.querySelector('.fse__section-card .fse__section-tag')).toHaveTextContent('Section 1');
    expect(document.querySelector('.den-panel')).toBeNull();
  });

  it('marks the card, not only the input, when one of its fields is invalid', async () => {
    getFormSchema.mockResolvedValue(schema());
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Sections');
    expect(document.querySelector('.fse__field-card--invalid')).toBeNull();
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'multiselect' }));
    expect(document.querySelector('.fse__field-card--invalid')).not.toBeNull();
    expect(screen.getByLabelText(/options/i)).toHaveAttribute('aria-invalid', 'true');
  });

  it('summarises what will be written on the review step', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await fillValidSchema();
    expect(screen.getByText('1 field')).toBeInTheDocument();
    // Scoped to the section's own summary list: the live preview beside this
    // step renders the same label as a real control, so an unscoped query
    // matches both.
    const summary = within(screen.getByRole('list', { name: 'Fields in Basics' }));
    expect(summary.getByText('First name')).toBeInTheDocument();
    expect(summary.getByText(/firstName · text/)).toBeInTheDocument();
  });
});

describe('FormSchemaEditor: sections', () => {
  it('adds a section via Add section, and removes one via its remove button', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Sections');
    expect(screen.getAllByLabelText(/section title/i)).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: /add section/i }));
    expect(screen.getAllByLabelText(/section title/i)).toHaveLength(2);

    await userEvent.click(screen.getAllByRole('button', { name: /remove section/i })[0]!);
    expect(screen.getAllByLabelText(/section title/i)).toHaveLength(1);
  });

  it('recovers cleanly when the only section is removed: empty state, Add section still reachable', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Sections');
    await userEvent.click(screen.getByRole('button', { name: /remove section/i }));

    expect(screen.getByText('No sections yet. Use Add section to create one.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/section title/i)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /add section/i }));
    expect(screen.getAllByLabelText(/section title/i)).toHaveLength(1);
  });

  it('reorders sections with the move-down control', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          { title: 'Sec A', description: null, fields: [field({ key: 'a' })] },
          { title: 'Sec B', description: null, fields: [field({ key: 'b' })] },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Sections');
    const before = screen.getAllByLabelText(/section title/i) as HTMLInputElement[];
    expect(before.map((i) => i.value)).toEqual(['Sec A', 'Sec B']);

    await userEvent.click(screen.getByRole('button', { name: /move sec a down/i }));

    const after = screen.getAllByLabelText(/section title/i) as HTMLInputElement[];
    expect(after.map((i) => i.value)).toEqual(['Sec B', 'Sec A']);
  });
});

describe('FormSchemaEditor: create mode', () => {
  it('seeds a blank schema with one blank section and does not call getFormSchema', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByLabelText(/schema id/i)).toHaveValue('');
    expect(getFormSchema).not.toHaveBeenCalled();
    await goToStep('Sections');
    expect(screen.getAllByLabelText(/section title/i)).toHaveLength(1);
    expect(screen.getByLabelText(/section title/i)).toHaveValue('');
  });

  it('disables Save until id, name, section title, and at least one valid field are present', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Review');
    // On an untouched form Save is offered rather than greyed out, and pressing
    // it is what surfaces the problems (asserted in the pristine describe below).
    // From here on every problem is on screen, so the button goes back to being
    // the plain "nothing left to fix" gate.
    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));
    expect(saveFormSchema).not.toHaveBeenCalled();
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled();

    await goToStep('Schema');
    await userEvent.type(screen.getByLabelText(/schema id/i), 'newSchema');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'New Schema');
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled(); // section title + field still missing

    await goToStep('Sections');
    await userEvent.type(screen.getByLabelText(/section title/i), 'Basics');
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled(); // no fields yet

    await goToStep('Sections');
    await userEvent.click(screen.getByRole('button', { name: /add field/i }));
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled(); // key/label blank

    await goToStep('Sections');
    await userEvent.type(screen.getByLabelText(/^key$/i), 'firstName');
    await userEvent.type(screen.getByLabelText(/^label$/i), 'First name');
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeEnabled();
  });

  it('auto-derives a blank field key from the label on blur (AO-49), never overwriting a typed key', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Sections');
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

  it('saves via saveFormSchema with the section the operator built, and reports the new id', async () => {
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
        title: 'Basics',
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

/**
 * Screenshot review, 2026-08-09: opening a new schema greeted the operator with
 * "Fix on this step: Schema id is required. Schema name is required." and "3
 * things left to fix" before a single keystroke. Nothing had gone wrong; they
 * had opened a form.
 *
 * The rule these pin down: a step's problems appear once the operator has EDITED
 * that step, once they have ASKED TO SAVE, or straight away on a record that was
 * loaded rather than created. Never on the blank form itself. This now also
 * covers the section the form seeds by default (M17): a brand-new schema's
 * one blank-titled section must not greet the operator with "Section title is
 * required." before they have touched the Sections step.
 */
describe('FormSchemaEditor: a new schema is not accused of being empty', () => {
  it('opens quiet: no banner on the step, no flag on the rail, no counter beside Next', () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText('Fix on this step')).toBeNull();
    expect(screen.queryByText('Schema id is required.')).toBeNull();
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAccessibleName('1 Schema');
    expect(screen.getByRole('button', { name: /^2 Sections/ })).toHaveAccessibleName('2 Sections');
    expect(screen.queryByRole('button', { name: /left to fix/ })).toBeNull();
  });

  it('opens quiet on the seeded section too: no inline "Section title is required." until the step is touched', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText('Section title is required.')).toBeNull();
    await goToStep('Sections');
    // Navigating to the step is not touching it: still nothing said.
    expect(screen.queryByText('Section title is required.')).toBeNull();
  });

  it('reports the schema step once it is typed in, and still says nothing about untouched sections', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Tribe Profile');

    expect(screen.getByText('Schema id is required.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAccessibleName('1 Schema 1 thing to fix');
    // The sections step is still untouched, so its problems would be describing
    // nothing the operator has done.
    expect(screen.getByRole('button', { name: /^2 Sections/ })).toHaveAccessibleName('2 Sections');
    expect(screen.getByRole('button', { name: /left to fix/ })).toHaveTextContent('1 thing left to fix');
  });

  it('reports the sections step from the first field added, not before', async () => {
    render(<FormSchemaEditor onSaved={vi.fn()} onCancel={vi.fn()} />);
    await goToStep('Sections');
    expect(screen.queryByText('Fix on this step')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /add field/i }));
    // Adding a field to the seeded, still-untitled section touches the step, so
    // all three of its problems are now spoken: the section title, the new
    // field's key, and its label.
    expect(screen.getByRole('button', { name: /^2 Sections/ })).toHaveAccessibleName('2 Sections 3 things to fix');
  });

  it('a Save attempt on the untouched form shows every problem, lands on the first, and saves nothing', async () => {
    const onSaved = vi.fn();
    render(<FormSchemaEditor onSaved={onSaved} onCancel={vi.fn()} />);
    await goToStep('Review');
    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));

    expect(saveFormSchema).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    // Landed on the earliest problem in reading order, with it named.
    expect(screen.getByRole('heading', { name: 'Schema', level: 3 })).toBeInTheDocument();
    expect(screen.getByText('Schema id is required.')).toBeInTheDocument();
    // Section title required + at least one field required.
    expect(screen.getByRole('button', { name: /^2 Sections/ })).toHaveAccessibleName('2 Sections 2 things to fix');
    expect(screen.getByRole('button', { name: /left to fix/ })).toHaveTextContent('4 things left to fix');
  });

  it('an existing schema that is already broken says so on open, because that describes the record', async () => {
    // Not the operator's doing: a stored schema whose name is blank is a fact
    // about the record they just opened, so hiding it would hide the reason
    // their save is about to be refused.
    getFormSchema.mockResolvedValue(schema({ name: '' }));
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);

    expect(await screen.findByText('Schema name is required.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^1 Schema/ })).toHaveAccessibleName('1 Schema 1 thing to fix');
  });
});

describe('FormSchemaEditor: edit mode', () => {
  it('shows the version on the review step, the mock subtitle line moved into the wizard', async () => {
    getFormSchema.mockResolvedValue(schema({ version: 3 }));
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Review');
    expect(screen.getByText('Version')).toBeInTheDocument();
    expect(screen.getByText('v3')).toBeInTheDocument();
  });

  it('loads via getFormSchema and renders the existing name, id (locked), and field', async () => {
    getFormSchema.mockResolvedValue(schema());
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);

    expect(await screen.findByDisplayValue('Tribe Profile')).toBeInTheDocument();
    expect(getFormSchema).toHaveBeenCalledWith('tribeProfile');
    expect(screen.getByLabelText(/schema id/i)).toBeDisabled();
    await goToStep('Sections');
    expect(screen.getByDisplayValue('firstName')).toBeInTheDocument();
  });

  it('fails loud when getFormSchema rejects, naming the callable', async () => {
    getFormSchema.mockRejectedValue(new Error("Schema 'tribeProfile' not found."));
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    expect(await screen.findByText(/getFormSchema failed:.*not found/i)).toBeInTheDocument();
  });

  /**
   * THE DEFECT THIS FIXES (issue #397, M17). This screen used to flatten every
   * section's fields into one list on load and re-wrap them in a single
   * implicit section on save, with a "Sections merged" warning banner. That
   * banner, and the merge it described, are both gone: a loaded schema keeps
   * every section it actually has.
   */
  it('loads a multi-section schema intact, one card per section, never merged', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          { title: 'Sec A', description: 'Desc A', fields: [field({ key: 'a', label: 'Field A' })] },
          { title: 'Sec B', description: null, fields: [field({ key: 'b', label: 'Field B' })] },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    expect(screen.queryByText(/sections merged/i)).toBeNull();

    await goToStep('Sections');
    expect(screen.getByDisplayValue('Sec A')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Sec B')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Desc A')).toBeInTheDocument();
    expect(screen.getByDisplayValue('a')).toBeInTheDocument();
    expect(screen.getByDisplayValue('b')).toBeInTheDocument();
  });

  /**
   * The round-trip requirement itself: load a multi-section schema, make one
   * edit, save, and assert the PAYLOAD (the state carrier saveFormSchema
   * actually receives), not just what is on screen. Both sections, their
   * titles, descriptions, order, and the untouched field all survive.
   */
  it('round-trips a multi-section schema losslessly: load, edit one field, save, boundaries intact', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          { title: 'Sec A', description: 'Desc A', fields: [field({ key: 'a', label: 'Field A' })] },
          { title: 'Sec B', description: null, fields: [field({ key: 'b', label: 'Field B' })] },
        ],
      }),
    );
    saveFormSchema.mockResolvedValue({ id: 'tribeProfile', version: 4 });
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Sections');

    // One small edit, in section B only.
    const labelInputs = screen.getAllByLabelText(/^label$/i);
    await userEvent.clear(labelInputs[1]!);
    await userEvent.type(labelInputs[1]!, 'Field B renamed');

    await goToStep('Review');
    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));

    await waitFor(() => expect(saveFormSchema).toHaveBeenCalledTimes(1));
    const sent = saveFormSchema.mock.calls[0]?.[0] as FormSchemaDetail;
    expect(sent.sections).toEqual([
      { title: 'Sec A', description: 'Desc A', fields: [field({ key: 'a', label: 'Field A' })] },
      { title: 'Sec B', description: null, fields: [field({ key: 'b', label: 'Field B renamed' })] },
    ]);
  });

  it('does not flag two sections sharing the same field key as a duplicate, matching the backend', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          { title: 'Sec A', description: null, fields: [field({ key: 'shared', label: 'Field A' })] },
          { title: 'Sec B', description: null, fields: [field({ key: 'shared', label: 'Field B' })] },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Sections');
    expect(screen.queryByText(/duplicate/i)).toBeNull();
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeEnabled();
  });

  it('flags a duplicate key within the same section', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          {
            title: 'Sec A',
            description: null,
            fields: [field({ key: 'dup', label: 'Field A' }), field({ key: 'dup', label: 'Field A2' })],
          },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Sections');
    // Appears twice: inline on the second field card, and again in the step's
    // aggregate "Fix on this step" banner (an edit-mode record is not
    // pristine, so both fire at once). Either is proof enough.
    expect(screen.getAllByText(/duplicate key "dup"/i).length).toBeGreaterThan(0);
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
    await goToStep('Sections');
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
    await goToStep('Sections');
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
    await goToStep('Sections');
    expect(screen.queryByLabelText(/options/i)).toBeNull();

    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'select' }));
    expect(await screen.findByLabelText(/options/i)).toBeInTheDocument();
    // The problem belongs to the Sections step, and the rail says so from anywhere.
    expect(screen.getByRole('button', { name: /^2 Sections/ })).toHaveAccessibleName(
      '2 Sections 1 thing to fix',
    );
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeDisabled();

    await goToStep('Sections');
    await userEvent.type(screen.getByLabelText(/options/i), 'Dog, Cat');
    await goToStep('Review');
    expect(screen.getByRole('button', { name: /save schema/i })).toBeEnabled();
  });

  it('does not eat a typed comma in the options field (#801)', async () => {
    getFormSchema.mockResolvedValue(schema());
    saveFormSchema.mockResolvedValue({ id: 'tribeProfile', version: 4 });
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Sections');
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'select' }));

    const input = await screen.findByLabelText(/options/i);
    await userEvent.type(input, 'a,b,c');
    // Re-parsing on every keystroke used to consume the comma the instant it
    // was typed. While the operator is still typing, the field must show
    // exactly what they typed, comma included.
    expect(input).toHaveValue('a,b,c');

    // Commit happens on blur, not on keystroke.
    await userEvent.tab();
    expect(input).toHaveValue('a, b, c');

    await goToStep('Review');
    await userEvent.click(screen.getByRole('button', { name: /save schema/i }));

    await waitFor(() => expect(saveFormSchema).toHaveBeenCalledTimes(1));
    const sent = saveFormSchema.mock.calls[0]?.[0] as FormSchemaDetail;
    expect(sent.sections[0]?.fields[0]?.options).toEqual(['a', 'b', 'c']);
  });

  it('commits the options field on Enter as well as on blur', async () => {
    getFormSchema.mockResolvedValue(schema());
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    await screen.findByLabelText(/schema id/i);
    await goToStep('Sections');
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'select' }));

    const input = await screen.findByLabelText(/options/i);
    await userEvent.type(input, 'x,y{enter}');
    expect(input).toHaveValue('x, y');
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

  it('renders every section as its own preview card', async () => {
    getFormSchema.mockResolvedValue(
      schema({
        sections: [
          { title: 'Basics', description: null, fields: [field({ key: 'a', label: 'Field A', required: false })] },
          { title: 'Home access', description: null, fields: [field({ key: 'b', label: 'Field B', required: false })] },
        ],
      }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    const preview = await screen.findByRole('region', { name: 'Live preview' });
    expect(preview).toHaveTextContent('Basics');
    expect(preview).toHaveTextContent('Home access');
    expect(within(preview).getByLabelText('Field A')).toBeInTheDocument();
    expect(within(preview).getByLabelText('Field B')).toBeInTheDocument();
  });

  it('follows an edit to a field label without a save', async () => {
    getFormSchema.mockResolvedValue(
      schema({ sections: [{ title: 'Basics', description: null, fields: [field({ label: 'First name' })] }] }),
    );
    render(<FormSchemaEditor schemaId="tribeProfile" onSaved={vi.fn()} onCancel={vi.fn()} />);
    const preview = await screen.findByRole('region', { name: 'Live preview' });
    expect(within(preview).getByLabelText('First name *')).toBeInTheDocument();
    // The preview is the wizard's `aside`, so it sits BESIDE the Sections step
    // rather than being replaced by it. That is the whole claim: typing into a
    // field updates a pane the operator can still see while typing.
    await goToStep('Sections');
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
