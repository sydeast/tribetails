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
 * `Settings.tsx`'s `persist` feeds a save back to every section. A bare
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
    // #1593: the server checks the whole week this panel sends, so the
    // refusal shows on open, beside the day, and holds Save.
    expect(screen.getByLabelText('Monday hours')).toHaveAccessibleErrorMessage(
      'Enter both an opening and a closing time.',
    );
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

/** #1593: a day's hours are refused beside the day, and Save waits on them. */
describe('BusinessHoursEditor checks', () => {
  const SAVE = { name: /^save$/i };
  const CLOSE_BEFORE_OPEN = 'The closing time has to be after the opening time.';
  const BOTH_TIMES = 'Enter both an opening and a closing time.';

  it('refuses a close before the open beside that day, and Save stays off', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={{ businessHours: { Monday: '09:00-17:00' } }} onSave={onSave} />);
    const close = screen.getByLabelText('Monday close time');
    await userEvent.clear(close);
    await userEvent.type(close, '08:00');
    expect(close).toHaveAttribute('aria-invalid', 'true');
    expect(close).toHaveAccessibleErrorMessage(CLOSE_BEFORE_OPEN);
    expect(screen.getByLabelText('Monday open time')).toHaveAccessibleErrorMessage(CLOSE_BEFORE_OPEN);
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a close equal to the open is refused too', async () => {
    render(<BusinessHoursEditor data={{ businessHours: { Friday: '09:00-17:00' } }} onSave={vi.fn()} />);
    const close = screen.getByLabelText('Friday close time');
    await userEvent.clear(close);
    await userEvent.type(close, '09:00');
    expect(screen.getByText(CLOSE_BEFORE_OPEN)).toBeInTheDocument();
  });

  it('refuses a cleared time instead of saving "-17:00"', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={{ businessHours: { Monday: '09:00-17:00' } }} onSave={onSave} />);
    await userEvent.clear(screen.getByLabelText('Monday open time'));
    expect(screen.getByText(BOTH_TIMES)).toBeInTheDocument();
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
  });

  it('fixing the time clears the sentence and saves the range', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={{ businessHours: { Monday: '09:00-17:00' } }} onSave={onSave} />);
    const close = screen.getByLabelText('Monday close time');
    await userEvent.clear(close);
    await userEvent.type(close, '08:00');
    await userEvent.clear(close);
    await userEvent.type(close, '18:00');
    expect(screen.queryByText(CLOSE_BEFORE_OPEN)).toBeNull();
    expect(close).not.toHaveAttribute('aria-invalid');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Monday: '09:00-18:00' } });
  });

  it('a closed day is never refused, whatever its hidden times say', async () => {
    render(<BusinessHoursEditor data={{ businessHours: { Monday: '09:00-17:00' } }} onSave={vi.fn()} />);
    const close = screen.getByLabelText('Monday close time');
    await userEvent.clear(close);
    await userEvent.type(close, '08:00');
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    expect(screen.queryByText(CLOSE_BEFORE_OPEN)).toBeNull();
    expect(screen.getByRole('button', SAVE)).toBeEnabled();
  });

  it('the text fallback is held to the same range, and clearing it reads as Closed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={{ businessHours: { Monday: 'by appointment' } }} onSave={onSave} />);
    const box = screen.getByLabelText('Monday hours');
    await userEvent.clear(box);
    await userEvent.type(box, '17:00-09:00');
    expect(box).toHaveAccessibleErrorMessage(CLOSE_BEFORE_OPEN);
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
    await userEvent.clear(box);
    expect(box).not.toHaveAttribute('aria-invalid');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Monday: '' } });
  });

  it('puts a server refusal that names a day beside that day', async () => {
    const onSave = vi.fn().mockRejectedValue(
      Object.assign(new Error(`Tuesday: ${CLOSE_BEFORE_OPEN}`), {
        details: {
          code: 'settings_refused',
          field: 'businessHours',
          refusals: [{ field: 'businessHours', message: `Tuesday: ${CLOSE_BEFORE_OPEN}` }],
        },
      }),
    );
    render(<BusinessHoursEditor data={{ businessHours: {} }} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Tuesday open' }));
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(await screen.findByText(CLOSE_BEFORE_OPEN)).toBeInTheDocument();
    expect(screen.getByLabelText('Tuesday open time')).toHaveAccessibleErrorMessage(CLOSE_BEFORE_OPEN);
    expect(screen.queryByText('Save failed')).toBeNull();
  });

  it('shows a server refusal that names no day in the banner, word for word', async () => {
    const onSave = vi.fn().mockRejectedValue(
      Object.assign(new Error('The weekly hours did not arrive as a list. Reload and try again.'), {
        details: {
          code: 'settings_refused',
          field: 'businessHours',
          refusals: [{ field: 'businessHours', message: 'The weekly hours did not arrive as a list. Reload and try again.' }],
        },
      }),
    );
    render(<BusinessHoursEditor data={{ businessHours: {} }} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Tuesday open' }));
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(await screen.findByText('The weekly hours did not arrive as a list. Reload and try again.')).toBeInTheDocument();
  });
});
