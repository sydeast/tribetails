// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BusinessSettings } from '../../api/settings';
import { BusinessHoursEditor } from './BusinessHoursEditor';

/**
 * `BusinessHoursEditor` only clears its own "dirty" state (and shows "Saved")
 * once its `data` prop reflects the just-written patch -- exactly how
 * `SettingsEdit.tsx`'s `persist` feeds a save back to every section. A bare
 * `render` with a static `data` object can never demonstrate that (the prop
 * never changes), so this harness plays the parent's role for the one test
 * that needs to see "Saved" appear.
 */
function Harness({
  initial,
  onSave,
}: {
  initial: Record<string, string>;
  onSave: (patch: Partial<BusinessSettings>) => Promise<void>;
}) {
  const [businessHours, setBusinessHours] = useState(initial);
  async function persist(patch: Partial<BusinessSettings>) {
    await onSave(patch);
    if (patch.businessHours) setBusinessHours(patch.businessHours);
  }
  return <BusinessHoursEditor data={{ businessHours }} onSave={persist} />;
}

describe('BusinessHoursEditor', () => {
  it('renders every day of the week, closed days showing "Closed" with the toggle off', () => {
    render(<BusinessHoursEditor data={{ businessHours: {} }} onSave={vi.fn()} />);
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      const sw = screen.getByRole('switch', { name: `Toggle ${day} open` });
      expect(sw).toHaveAttribute('aria-checked', 'false');
    }
    expect(screen.getAllByText('Closed')).toHaveLength(7);
  });

  it('shows open/close time pickers for a day with a valid saved range', () => {
    render(<BusinessHoursEditor data={{ businessHours: { Monday: '09:00-17:00' } }} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Monday open time')).toHaveValue('09:00');
    expect(screen.getByLabelText('Monday close time')).toHaveValue('17:00');
    expect(screen.getByRole('switch', { name: 'Toggle Monday open' })).toHaveAttribute('aria-checked', 'true');
  });

  it('flags a malformed saved value with a "Check format" fallback instead of dropping it', () => {
    render(<BusinessHoursEditor data={{ businessHours: { Monday: 'by appointment' } }} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Monday hours')).toHaveValue('by appointment');
    expect(screen.getByText('Check format')).toBeInTheDocument();
  });

  it('toggling a closed day open seeds the default range, and Save writes the full businessHours patch', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={{ Tuesday: '10:00-14:00' }} onSave={onSave} />);

    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();

    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    expect(screen.getByLabelText('Monday open time')).toHaveValue('09:00');
    expect(saveBtn).toBeEnabled();

    await userEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({
      businessHours: { Tuesday: '10:00-14:00', Monday: '09:00-17:00' },
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('toggling an open day closed writes a blank entry for that day', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={{ businessHours: { Monday: '09:00-17:00' } }} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Monday: '' } });
  });

  it('changing the open time keeps the close time untouched and re-enables Save', async () => {
    render(<BusinessHoursEditor data={{ businessHours: { Monday: '09:00-17:00' } }} onSave={vi.fn()} />);
    const openInput = screen.getByLabelText('Monday open time');
    await userEvent.clear(openInput);
    await userEvent.type(openInput, '08:00');
    // Clearing the field mid-edit must never blank the sibling close-time field
    // or flip the row into the malformed-fallback branch (see the file header).
    expect(screen.getByLabelText('Monday close time')).toHaveValue('17:00');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  it('Cancel reverts an unsaved toggle', async () => {
    render(<BusinessHoursEditor data={{ businessHours: {} }} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByRole('switch', { name: 'Toggle Monday open' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows a fail-loud error and keeps Save enabled when the write rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('permission-denied'));
    render(<BusinessHoursEditor data={{ businessHours: {} }} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/permission-denied/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
