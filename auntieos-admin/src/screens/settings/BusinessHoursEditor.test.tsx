// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BUSINESS_SETTINGS, type BusinessSettings } from '../../api/settings';
import { foldSettingsPatch } from '../../lib/foldSettingsPatch';
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
  // The parent's own fold (`Settings.tsx` `persist`), so the kept hours of a
  // closed day move the way they do on the real screen.
  const [data, setData] = useState<BusinessSettings>({ ...DEFAULT_BUSINESS_SETTINGS, businessHours: initial });
  async function persist(patch: Partial<BusinessSettings>) {
    await onSave(patch);
    setData((d) => foldSettingsPatch(d, patch));
  }
  return <BusinessHoursEditor data={data} onSave={persist} />;
}

/** The editor's `data`: the weekly hours, and the hours kept for closed days. */
function hours(businessHours: Record<string, string>, closedDayHours: Record<string, string> = {}) {
  return { businessHours, closedDayHours };
}

/** Sets a day's two times the way a time picker commits them. */
function setTimes(day: string, open: string, close: string) {
  fireEvent.change(screen.getByLabelText(`${day} open time`), { target: { value: open } });
  fireEvent.change(screen.getByLabelText(`${day} close time`), { target: { value: close } });
}

describe('BusinessHoursEditor', () => {
  it('renders every day with the toggle off: a blank day reads "Closed", a day with no entry "Not set"', () => {
    render(<BusinessHoursEditor data={hours({ Saturday: '', Sunday: '  ' })} onSave={vi.fn()} />);
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      const sw = screen.getByRole('switch', { name: `Toggle ${day} open` });
      expect(sw).toHaveAttribute('aria-checked', 'false');
    }
    expect(screen.getAllByText('Closed')).toHaveLength(2);
    expect(screen.getAllByText('Not set')).toHaveLength(5);
  });

  it('shows open/close time pickers for a day with a valid saved range', () => {
    render(<BusinessHoursEditor data={hours({ Monday: '09:00-17:00' })} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Monday open time')).toHaveValue('09:00');
    expect(screen.getByLabelText('Monday close time')).toHaveValue('17:00');
    expect(screen.getByRole('switch', { name: 'Toggle Monday open' })).toHaveAttribute('aria-checked', 'true');
  });

  it('flags a malformed saved value with a "Check format" fallback instead of dropping it', () => {
    render(<BusinessHoursEditor data={hours({ Monday: 'by appointment' })} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Monday hours')).toHaveValue('by appointment');
    expect(screen.getByText('Check format')).toBeInTheDocument();
    // #1593: the server checks the whole week this panel sends, so the
    // refusal shows on open, beside the day, and holds Save.
    expect(screen.getByLabelText('Monday hours')).toHaveAccessibleErrorMessage(
      'Enter both an opening and a closing time.',
    );
  });

  it('toggling a day open and setting its hours writes only the changed day', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={{ Tuesday: '10:00-14:00' }} onSave={onSave} />);

    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();

    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    setTimes('Monday', '09:00', '17:00');
    expect(saveBtn).toBeEnabled();

    await userEvent.click(saveBtn);
    // Only the changed day travels (#1783); Tuesday keeps its stored string.
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Monday: '09:00-17:00' } });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('toggling an open day closed writes a blank entry for that day', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={hours({ Monday: '09:00-17:00' })} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Monday: '' } });
  });

  it('changing the open time keeps the close time untouched and re-enables Save', async () => {
    render(<BusinessHoursEditor data={hours({ Monday: '09:00-17:00' })} onSave={vi.fn()} />);
    const openInput = screen.getByLabelText('Monday open time');
    await userEvent.clear(openInput);
    await userEvent.type(openInput, '08:00');
    // Clearing the field mid-edit must never blank the sibling close-time field
    // or flip the row into the malformed-fallback branch (see the file header).
    expect(screen.getByLabelText('Monday close time')).toHaveValue('17:00');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  it('Cancel reverts an unsaved toggle', async () => {
    render(<BusinessHoursEditor data={hours({})} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByRole('switch', { name: 'Toggle Monday open' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows a fail-loud error and keeps Save enabled when the write rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('permission-denied'));
    render(<BusinessHoursEditor data={hours({})} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    setTimes('Monday', '09:00', '17:00');
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
    render(<BusinessHoursEditor data={hours({ Monday: '09:00-17:00' })} onSave={onSave} />);
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
    render(<BusinessHoursEditor data={hours({ Friday: '09:00-17:00' })} onSave={vi.fn()} />);
    const close = screen.getByLabelText('Friday close time');
    await userEvent.clear(close);
    await userEvent.type(close, '09:00');
    expect(screen.getByText(CLOSE_BEFORE_OPEN)).toBeInTheDocument();
  });

  it('refuses a cleared time instead of saving "-17:00"', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={hours({ Monday: '09:00-17:00' })} onSave={onSave} />);
    await userEvent.clear(screen.getByLabelText('Monday open time'));
    expect(screen.getByText(BOTH_TIMES)).toBeInTheDocument();
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
  });

  it('fixing the time clears the sentence and saves the range', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={hours({ Monday: '09:00-17:00' })} onSave={onSave} />);
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
    render(<BusinessHoursEditor data={hours({ Monday: '09:00-17:00' })} onSave={vi.fn()} />);
    const close = screen.getByLabelText('Monday close time');
    await userEvent.clear(close);
    await userEvent.type(close, '08:00');
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Monday open' }));
    expect(screen.queryByText(CLOSE_BEFORE_OPEN)).toBeNull();
    expect(screen.getByRole('button', SAVE)).toBeEnabled();
  });

  it('the text fallback is held to the same range, and clearing it reads as Closed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={hours({ Monday: 'by appointment' })} onSave={onSave} />);
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
    render(<BusinessHoursEditor data={hours({})} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Tuesday open' }));
    setTimes('Tuesday', '09:00', '17:00');
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
    render(<BusinessHoursEditor data={hours({})} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Tuesday open' }));
    setTimes('Tuesday', '09:00', '17:00');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(await screen.findByText('The weekly hours did not arrive as a list. Reload and try again.')).toBeInTheDocument();
  });
});
describe('a stored bad day (#1783)', () => {
  const CLOSE_BEFORE_OPEN = 'The closing time has to be after the opening time.';
  const stored = hours({ Monday: '17:00-09:00', Tuesday: '09:00-17:00' });
  it('shows its sentence beside the day as the panel opens, with Save off', () => {
    render(<BusinessHoursEditor data={stored} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Monday open time')).toHaveAccessibleErrorMessage(CLOSE_BEFORE_OPEN);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });
  it('saves a different day, sending only that day', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={stored} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Wednesday open' }));
    setTimes('Wednesday', '09:00', '17:00');
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Wednesday: '09:00-17:00' } });
    expect(screen.getByLabelText('Monday open time')).toHaveAccessibleErrorMessage(CLOSE_BEFORE_OPEN);
  });
  it('refuses the stored day once it is edited to another bad value, and saves a good one', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={stored} onSave={onSave} />);
    const open = screen.getByLabelText('Monday open time');
    fireEvent.change(open, { target: { value: '18:00' } });
    expect(open).toHaveAccessibleErrorMessage(CLOSE_BEFORE_OPEN);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    fireEvent.change(open, { target: { value: '08:00' } });
    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Monday: '08:00-09:00' } });
  });
});

/**
 * #1978: a closed day switched back on came up as 09:00 to 17:00 with Save lit,
 * hours nobody chose. It comes back with the hours it had, or blank.
 */
describe('reopening a closed day (#1978)', () => {
  const SAVE = { name: /^save$/i };
  const BOTH_TIMES = 'Enter both an opening and a closing time.';
  const toggle = (day: string) => screen.getByRole('switch', { name: `Toggle ${day} open` });

  it('close then reopen in one visit gives back the hours the day had', async () => {
    render(<BusinessHoursEditor data={hours({ Sunday: '08:00-16:00' })} onSave={vi.fn()} />);
    await userEvent.click(toggle('Sunday'));
    expect(screen.getByText('Closed')).toBeInTheDocument();
    await userEvent.click(toggle('Sunday'));
    expect(screen.getByLabelText('Sunday open time')).toHaveValue('08:00');
    expect(screen.getByLabelText('Sunday close time')).toHaveValue('16:00');
    // Back where it started: nothing to save.
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
  });

  it('after a save and a reload, the day reopens with the hours the server kept', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    // What a reload reads once Sunday was closed and saved.
    render(<BusinessHoursEditor data={hours({ Sunday: '' }, { Sunday: '08:00-16:00' })} onSave={onSave} />);
    expect(toggle('Sunday')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle('Sunday'));
    expect(screen.getByLabelText('Sunday open time')).toHaveValue('08:00');
    expect(screen.getByLabelText('Sunday close time')).toHaveValue('16:00');
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Sunday: '08:00-16:00' } });
  });

  it('a closed day with no kept hours reopens blank, asks for hours beside the day and holds Save', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={hours({ Sunday: '' })} onSave={onSave} />);
    await userEvent.click(toggle('Sunday'));
    const open = screen.getByLabelText('Sunday open time');
    const close = screen.getByLabelText('Sunday close time');
    expect(open).toHaveValue('');
    expect(close).toHaveValue('');
    expect(open).toHaveAccessibleErrorMessage(BOTH_TIMES);
    expect(close).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).not.toHaveBeenCalled();

    setTimes('Sunday', '10:00', '14:00');
    expect(screen.queryByText(BOTH_TIMES)).toBeNull();
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Sunday: '10:00-14:00' } });
  });

  it('a day that was never set opens blank too, and never shows 09:00 or 17:00', async () => {
    render(<BusinessHoursEditor data={hours({})} onSave={vi.fn()} />);
    await userEvent.click(toggle('Monday'));
    expect(screen.getByLabelText('Monday open time')).toHaveValue('');
    expect(screen.getByLabelText('Monday close time')).toHaveValue('');
    expect(screen.queryByDisplayValue('09:00')).toBeNull();
    expect(screen.queryByDisplayValue('17:00')).toBeNull();
    expect(screen.getByRole('button', SAVE)).toBeDisabled();
  });

  it('kept hours nobody can read are not shown: the day reopens blank', async () => {
    render(<BusinessHoursEditor data={hours({ Sunday: '' }, { Sunday: 'by appointment' })} onSave={vi.fn()} />);
    await userEvent.click(toggle('Sunday'));
    expect(screen.getByLabelText('Sunday open time')).toHaveValue('');
    expect(screen.getByText(BOTH_TIMES)).toBeInTheDocument();
  });

  it('a day that was never set, switched on and off again, saves as Closed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<BusinessHoursEditor data={hours({})} onSave={onSave} />);
    await userEvent.click(toggle('Monday'));
    await userEvent.click(toggle('Monday'));
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getAllByText('Not set')).toHaveLength(6);
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Monday: '' } });
  });

  it('close, save, reopen, Cancel, reopen: the hours are still there without a reload', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial={{ Sunday: '08:00-16:00' }} onSave={onSave} />);
    await userEvent.click(toggle('Sunday'));
    await userEvent.click(screen.getByRole('button', SAVE));
    expect(onSave).toHaveBeenCalledWith({ businessHours: { Sunday: '' } });
    expect(await screen.findByText('Saved')).toBeInTheDocument();

    await userEvent.click(toggle('Sunday'));
    expect(screen.getByLabelText('Sunday open time')).toHaveValue('08:00');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(toggle('Sunday')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(toggle('Sunday'));
    expect(screen.getByLabelText('Sunday open time')).toHaveValue('08:00');
    expect(screen.getByLabelText('Sunday close time')).toHaveValue('16:00');
  });
});
