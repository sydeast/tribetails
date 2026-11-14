// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mergeBusinessSettings, type BusinessSettings } from '../../api/settings';
import { InvoiceTermsSection } from './InvoiceTermsSection';

/**
 * #1966: Settings > Invoices > Payment terms. The ruled options in the ruled
 * order, starting on due on receipt, saved as the one field through the shared
 * settings save, with a refusal shown beside the select.
 */

const SAVE = { name: 'Save payment terms' };

const RULED_LABELS = [
  'Due on receipt',
  'Due on the day of the first visit',
  'Due on the day of the last visit',
  'Due 1 day after the last visit',
  'Due 2 days after the last visit',
  'Due 3 days after the last visit',
  'Due 4 days after the last visit',
  'Due 5 days after the last visit',
  'Due 6 days after the last visit',
  'Due 7 days after the last visit',
  'Due 14 days after the last visit',
  'Due 30 days after the last visit',
  'Due 1 day before the first visit',
  'Due 2 days before the first visit',
  'Due 3 days before the first visit',
  'Due 4 days before the first visit',
  'Due 5 days before the first visit',
  'Due 6 days before the first visit',
  'Due 7 days before the first visit',
  'Due 14 days before the first visit',
  'Due 30 days before the first visit',
];

/** The shell's role: a save feeds back through `data`, as `Settings.tsx` does. */
function Shell({ onSave }: { onSave: (patch: Partial<BusinessSettings>) => Promise<void> }) {
  const [data, setData] = useState(mergeBusinessSettings(undefined));
  return (
    <InvoiceTermsSection
      data={data}
      onSave={async (patch) => {
        await onSave(patch);
        setData((d) => ({ ...d, ...patch }));
      }}
    />
  );
}

describe('Settings > Invoices > Payment terms (#1966)', () => {
  it('offers exactly the ruled options, in order, and starts on due on receipt', () => {
    render(<InvoiceTermsSection data={mergeBusinessSettings(undefined)} onSave={vi.fn()} />);
    const select = screen.getByLabelText('Payment terms');
    expect(select).toHaveValue('due_on_receipt');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(RULED_LABELS);
    // Invoice-date counts and "pick it myself" are per-invoice choices, not settings.
    expect(within(select).queryByText('A date I pick myself')).toBeNull();
    expect(within(select).queryByText('Due 14 days after the invoice date')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
  });

  it('reads a stored setting back', () => {
    const data = mergeBusinessSettings({ invoicePaymentTerms: 'net_30_before_first_visit' });
    render(<InvoiceTermsSection data={data} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Payment terms')).toHaveValue('net_30_before_first_visit');
  });

  it('reads a stored value that is not an option as due on receipt', () => {
    expect(mergeBusinessSettings({ invoicePaymentTerms: 'net_14' }).invoicePaymentTerms).toBe('due_on_receipt');
    expect(mergeBusinessSettings({ invoicePaymentTerms: 42 }).invoicePaymentTerms).toBe('due_on_receipt');
  });

  it('saves only the one field, and says Saved', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Shell onSave={onSave} />);
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Payment terms'), 'net_14_after_last_visit');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).toHaveBeenCalledWith({ invoicePaymentTerms: 'net_14_after_last_visit' });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
  });

  it('Cancel puts the stored value back', async () => {
    render(<InvoiceTermsSection data={mergeBusinessSettings(undefined)} onSave={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Payment terms'), 'due_on_last_visit');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByLabelText('Payment terms')).toHaveValue('due_on_receipt');
  });

  it('puts a server refusal beside the select', async () => {
    const message = 'Pick payment terms from the list.';
    const onSave = vi.fn().mockRejectedValue(
      Object.assign(new Error(message), {
        details: {
          code: 'settings_refused',
          field: 'invoicePaymentTerms',
          refusals: [{ field: 'invoicePaymentTerms', message }],
        },
      }),
    );
    render(<InvoiceTermsSection data={mergeBusinessSettings(undefined)} onSave={onSave} />);
    const select = screen.getByLabelText('Payment terms');
    await userEvent.selectOptions(select, 'due_on_first_visit');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(select).toHaveAccessibleErrorMessage(message);
    expect(screen.queryByText('Save failed')).toBeNull();
  });

  it('shows a save that failed for another reason in the panel', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('The network is down.'));
    render(<InvoiceTermsSection data={mergeBusinessSettings(undefined)} onSave={onSave} />);
    await userEvent.selectOptions(screen.getByLabelText('Payment terms'), 'due_on_first_visit');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(await screen.findByText('Save failed')).toBeInTheDocument();
    expect(screen.getByText('The network is down.')).toBeInTheDocument();
  });
});
