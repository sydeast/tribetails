// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { FormField, FormSection } from '../api/formSchemasWrite';
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

function section(over: Partial<FormSection> = {}): FormSection {
  return {
    title: 'S',
    description: null,
    fields: [],
    ...over,
  };
}

describe('SchemaPreview', () => {
  it('renders the section heading and its description', () => {
    render(
      <SchemaPreview
        sections={[section({ title: 'Tribe profile', description: 'About the household.' })]}
      />,
    );
    expect(screen.getByText('Tribe profile')).toBeInTheDocument();
    expect(screen.getByText('About the household.')).toBeInTheDocument();
  });

  it('prompts rather than showing an empty card when the schema has no fields yet', () => {
    render(<SchemaPreview sections={[section({ title: 'Tribe profile' })]} />);
    expect(screen.getByText(/No fields yet/)).toBeInTheDocument();
  });

  it('prompts when there are no sections at all', () => {
    render(<SchemaPreview sections={[]} />);
    expect(screen.getByText(/No fields yet/)).toBeInTheDocument();
  });

  it('renders a text field with its label, placeholder and helper text', () => {
    render(
      <SchemaPreview
        sections={[
          section({ fields: [field({ placeholder: 'e.g. the Wrens', helperText: 'How we address you.' })] }),
        ]}
      />,
    );
    const input = screen.getByLabelText('Household name');
    expect(input).toHaveAttribute('placeholder', 'e.g. the Wrens');
    expect(screen.getByText('How we address you.')).toBeInTheDocument();
  });

  it('marks a required field the way the kinfolk form does', () => {
    render(<SchemaPreview sections={[section({ fields: [field({ required: true })] })]} />);
    expect(screen.getByLabelText('Household name *')).toBeInTheDocument();
  });

  it('renders a select with every option the schema declares', () => {
    render(
      <SchemaPreview
        sections={[
          section({
            fields: [
              field({ key: 'homeType', label: 'Home type', type: 'select', options: ['House', 'Apartment', 'Condo'] }),
            ],
          }),
        ]}
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
        sections={[section({ fields: [field({ key: 'hasGate', label: 'Gated property', type: 'checkbox' })] })]}
      />,
    );
    expect(screen.getByLabelText('Gated property')).toHaveAttribute('type', 'checkbox');
  });

  it('renders a textarea field as a textarea', () => {
    render(
      <SchemaPreview sections={[section({ fields: [field({ key: 'notes', label: 'Notes', type: 'textarea' })] })]} />,
    );
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
  });

  it('maps date, number, phone and email onto their real input types', () => {
    render(
      <SchemaPreview
        sections={[
          section({
            fields: [
              field({ key: 'moveIn', label: 'Move-in', type: 'date' }),
              field({ key: 'count', label: 'How many', type: 'number' }),
              field({ key: 'mobile', label: 'Mobile', type: 'phone' }),
              field({ key: 'inbox', label: 'Email', type: 'email' }),
            ],
          }),
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
        sections={[section({ fields: [field(), field({ key: 'hasGate', label: 'Gated', type: 'checkbox' })] })]}
      />,
    );
    expect(screen.getByLabelText('Household name')).toBeDisabled();
    expect(screen.getByLabelText('Gated')).toBeDisabled();
  });

  it('names an unlabelled field by its key rather than rendering a nameless box', () => {
    render(<SchemaPreview sections={[section({ fields: [field({ label: '  ' })] })]} />);
    expect(screen.getByLabelText('householdName')).toBeInTheDocument();
  });

  it('labels the region so a screen reader can find it', () => {
    render(<SchemaPreview sections={[section({ fields: [field()] })]} />);
    expect(screen.getByRole('region', { name: 'Live preview' })).toBeInTheDocument();
  });

  describe('multiple sections', () => {
    it('renders one card per section, each with its own title, description and fields', () => {
      render(
        <SchemaPreview
          sections={[
            section({
              title: 'Basics',
              description: 'About the household.',
              fields: [field({ key: 'householdName', label: 'Household name' })],
            }),
            section({
              title: 'Home access',
              description: 'How an auntie gets in.',
              fields: [field({ key: 'gateCode', label: 'Gate code' })],
            }),
          ]}
        />,
      );
      const region = screen.getByRole('region', { name: 'Live preview' });
      expect(region).toHaveTextContent('Basics');
      expect(region).toHaveTextContent('About the household.');
      expect(region).toHaveTextContent('Home access');
      expect(region).toHaveTextContent('How an auntie gets in.');
      expect(within(region).getByLabelText('Household name')).toBeInTheDocument();
      expect(within(region).getByLabelText('Gate code')).toBeInTheDocument();
    });

    it('shows the empty prompt inside a section that has no fields yet, while a sibling section still renders its own', () => {
      render(
        <SchemaPreview
          sections={[
            section({ title: 'Basics', fields: [] }),
            section({ title: 'Home access', fields: [field({ key: 'gateCode', label: 'Gate code' })] }),
          ]}
        />,
      );
      const region = screen.getByRole('region', { name: 'Live preview' });
      expect(within(region).getByText(/No fields yet/)).toBeInTheDocument();
      expect(within(region).getByLabelText('Gate code')).toBeInTheDocument();
    });
  });
});
