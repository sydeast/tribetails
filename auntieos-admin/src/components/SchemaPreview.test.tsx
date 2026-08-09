// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FormField } from '../api/formSchemasWrite';
import { SchemaPreview } from './SchemaPreview';

function field(over: Partial<FormField> = {}): FormField {
  return {
    key: 'householdName',
    label: 'Household name',
    type: 'text',
    required: false,
    helperText: null,
    placeholder: null,
    options: null,
    defaultValue: null,
    group: null,
    ...over,
  };
}

describe('SchemaPreview', () => {
  it('renders the section heading and its description', () => {
    render(
      <SchemaPreview sectionTitle="Tribe profile" sectionDescription="About the household." fields={[]} />,
    );
    expect(screen.getByText('Tribe profile')).toBeInTheDocument();
    expect(screen.getByText('About the household.')).toBeInTheDocument();
  });

  it('prompts rather than showing an empty card when the schema has no fields yet', () => {
    render(<SchemaPreview sectionTitle="Tribe profile" sectionDescription={null} fields={[]} />);
    expect(screen.getByText(/No fields yet/)).toBeInTheDocument();
  });

  it('renders a text field with its label, placeholder and helper text', () => {
    render(
      <SchemaPreview
        sectionTitle="S"
        sectionDescription={null}
        fields={[field({ placeholder: 'e.g. the Wrens', helperText: 'How we address you.' })]}
      />,
    );
    const input = screen.getByLabelText('Household name');
    expect(input).toHaveAttribute('placeholder', 'e.g. the Wrens');
    expect(screen.getByText('How we address you.')).toBeInTheDocument();
  });

  it('marks a required field the way the kinfolk form does', () => {
    render(
      <SchemaPreview sectionTitle="S" sectionDescription={null} fields={[field({ required: true })]} />,
    );
    expect(screen.getByLabelText('Household name *')).toBeInTheDocument();
  });

  it('renders a select with every option the schema declares', () => {
    render(
      <SchemaPreview
        sectionTitle="S"
        sectionDescription={null}
        fields={[field({ key: 'homeType', label: 'Home type', type: 'select', options: ['House', 'Apartment', 'Condo'] })]}
      />,
    );
    const select = screen.getByLabelText('Home type');
    expect(select.tagName).toBe('SELECT');
    for (const opt of ['House', 'Apartment', 'Condo']) {
      expect(screen.getByRole('option', { name: opt })).toBeInTheDocument();
    }
  });

  it('renders a checkbox field as a checkbox, not a text box', () => {
    render(
      <SchemaPreview
        sectionTitle="S"
        sectionDescription={null}
        fields={[field({ key: 'hasGate', label: 'Gated property', type: 'checkbox' })]}
      />,
    );
    expect(screen.getByLabelText('Gated property')).toHaveAttribute('type', 'checkbox');
  });

  it('renders a textarea field as a textarea', () => {
    render(
      <SchemaPreview
        sectionTitle="S"
        sectionDescription={null}
        fields={[field({ key: 'notes', label: 'Notes', type: 'textarea' })]}
      />,
    );
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });

  it('maps date, number, phone and email onto their real input types', () => {
    render(
      <SchemaPreview
        sectionTitle="S"
        sectionDescription={null}
        fields={[
          field({ key: 'moveIn', label: 'Move-in', type: 'date' }),
          field({ key: 'count', label: 'How many', type: 'number' }),
          field({ key: 'mobile', label: 'Mobile', type: 'phone' }),
          field({ key: 'inbox', label: 'Email', type: 'email' }),
        ]}
      />,
    );
    expect(screen.getByLabelText('Move-in')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('How many')).toHaveAttribute('type', 'number');
    expect(screen.getByLabelText('Mobile')).toHaveAttribute('type', 'tel');
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
  });

  it('disables every control, because a preview is not a form', () => {
    render(
      <SchemaPreview
        sectionTitle="S"
        sectionDescription={null}
        fields={[field(), field({ key: 'hasGate', label: 'Gated', type: 'checkbox' })]}
      />,
    );
    expect(screen.getByLabelText('Household name')).toBeDisabled();
    expect(screen.getByLabelText('Gated')).toBeDisabled();
  });

  it('names an unlabelled field by its key rather than rendering a nameless box', () => {
    render(
      <SchemaPreview sectionTitle="S" sectionDescription={null} fields={[field({ label: '  ' })]} />,
    );
    expect(screen.getByLabelText('householdName')).toBeInTheDocument();
  });

  it('labels the region so a screen reader can find it', () => {
    render(<SchemaPreview sectionTitle="S" sectionDescription={null} fields={[field()]} />);
    expect(screen.getByRole('region', { name: 'Live preview' })).toBeInTheDocument();
  });
});
