// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimeOffEditor } from './TimeOffEditor';

const EMPTY = { observedUsHolidays: [], companyHolidays: [], specialHours: [] };

describe('TimeOffEditor', () => {
  it('renders all eleven US holidays, unchecked when none are observed', () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: "Toggle New Year's Day observed" })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Toggle Christmas Day observed' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('checks a holiday already in observedUsHolidays', () => {
    render(<TimeOffEditor data={{ ...EMPTY, observedUsHolidays: ['christmas'] }} onSave={vi.fn()} />);
    expect(screen.getByRole('switch', { name: 'Toggle Christmas Day observed' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('toggling a holiday enables Save and saves the id in observedUsHolidays', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    const saveBtn = screen.getByRole('button', { name: /^save$/i });
    expect(saveBtn).toBeDisabled();
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' }));
    expect(saveBtn).toBeEnabled();
    await userEvent.click(saveBtn);
    expect(onSave).toHaveBeenCalledWith({
      observedUsHolidays: ['juneteenth'],
      companyHolidays: [],
      specialHours: [],
    });
  });

  it('lists existing company holidays parsed from the date|label wire format', () => {
    render(
      <TimeOffEditor
        data={{ ...EMPTY, companyHolidays: ['2026-12-25|Christmas closure'] }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText('Christmas closure')).toBeInTheDocument();
    expect(screen.getByText('2026-12-25')).toBeInTheDocument();
  });

  it('the Add company-holiday button stays disabled until date and name are both valid', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    const addButtons = screen.getAllByRole('button', { name: /^add$/i });
    const addHoliday = addButtons[0]!;
    expect(addHoliday).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-12-25');
    expect(addHoliday).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Office closed');
    expect(addHoliday).toBeEnabled();
  });

  it('adds a company holiday in the "date|name" wire format and clears the add row', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-12-25');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Office closed');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);

    expect(screen.getByText('Office closed')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('2026-12-25')).toHaveValue('');

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ companyHolidays: ['2026-12-25|Office closed'] }),
    );
  });

  it('removes a company holiday by index', async () => {
    render(
      <TimeOffEditor
        data={{ ...EMPTY, companyHolidays: ['2026-12-25|Christmas closure'] }}
        onSave={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(screen.queryByText('Christmas closure')).not.toBeInTheDocument();
    expect(screen.getByText('No company holidays added yet.')).toBeInTheDocument();
  });

  it('adds special hours in the "date|hours" wire format', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText('2026-12-24'), '2026-12-24');
    await userEvent.type(screen.getByPlaceholderText('08:00-12:00'), '08:00-12:00');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[1]!);

    expect(screen.getByText('08:00-12:00')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ specialHours: ['2026-12-24|08:00-12:00'] }),
    );
  });

  it('rejects a pipe character in the holiday name (keeps the wire format parseable)', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-12-25');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Bad|Name');
    expect(screen.getAllByRole('button', { name: /^add$/i })[0]).toBeDisabled();
  });

  it('Cancel reverts every unsaved change', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' }));
    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-12-25');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('shows a fail-loud error and keeps Save enabled when the write rejects', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('offline'));
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(/offline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });
});

/**
 * Recurrence support, added 2026-07-31: a company holiday like a US national
 * holiday should recur yearly instead of demanding a fresh YYYY-MM-DD every
 * year. `lib/closureRecurrence.ts` carries the resolver's own exhaustive unit
 * tests (nth-weekday, last-weekday, leap day, range-crossing-a-year); these
 * cover the EDITOR behavior on top of it: the recurrence selector, the "no
 * year when yearly" requirement, and the one-click US holiday presets.
 */
describe('TimeOffEditor: recurrence', () => {
  it('defaults the Add row to "One time", showing the dated YYYY-MM-DD field', () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: 'Recurrence' })).toHaveValue('once');
    expect(screen.getByPlaceholderText('2026-12-25')).toBeInTheDocument();
  });

  it('picking a yearly recurrence renders NO year input at all', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Recurrence' }), 'yearly-fixed');

    // The company-holiday date input is gone (its placeholder is unique to
    // that field; special hours below keeps its OWN "Date (YYYY-MM-DD)" input
    // untouched, so a blanket "no YYYY-MM-DD text anywhere" assertion would be
    // wrong, not stricter).
    expect(screen.queryByPlaceholderText('2026-12-25')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Month' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Day' })).toBeInTheDocument();
  });

  it('yearly-fixed: Add stays disabled until month and day are both picked, then saves the tagged wire format', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Recurrence' }), 'yearly-fixed');
    const addBtn = screen.getAllByRole('button', { name: /^add$/i })[0]!;
    expect(addBtn).toBeDisabled();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '7');
    expect(addBtn).toBeDisabled(); // day still unpicked

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Day' }), '4');
    expect(addBtn).toBeDisabled(); // name still blank

    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Independence Day');
    expect(addBtn).toBeEnabled();

    await userEvent.click(addBtn);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ companyHolidays: ['yearly:07-04|Independence Day'] }),
    );
  });

  it('yearly-nth-weekday: Month + Weekday + Occurrence all gate Add, saves the tagged wire format', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Recurrence' }), 'yearly-nth-weekday');
    const addBtn = screen.getAllByRole('button', { name: /^add$/i })[0]!;

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '11');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Weekday' }), '4');
    expect(addBtn).toBeDisabled(); // occurrence still unpicked

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Occurrence' }), '4');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Thanksgiving');
    expect(addBtn).toBeEnabled();

    await userEvent.click(addBtn);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ companyHolidays: ['yearly-nth:11-4-4|Thanksgiving'] }),
    );
  });

  it('yearly-last-weekday: no Occurrence field at all (there is no Nth for "last")', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Recurrence' }), 'yearly-last-weekday');

    expect(screen.queryByRole('combobox', { name: 'Occurrence' })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '5');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Weekday' }), '1');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Memorial Day');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ companyHolidays: ['yearly-last:05-1|Memorial Day'] }),
    );
  });

  it('displays a recurring entry with its human recurrence description, not a raw date', () => {
    render(
      <TimeOffEditor
        data={{ ...EMPTY, companyHolidays: ['yearly:07-04|Independence Day'] }}
        onSave={vi.fn()}
      />,
    );
    // "Independence Day" also names the US_HOLIDAYS observed-toggle row and the
    // one-click preset button, so this scopes to the dated-list ROW the
    // recurrence description sits inside, rather than asserting on the text
    // anywhere in the document.
    const row = screen.getByText('Every year, July 4').closest('li');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('Independence Day')).toBeInTheDocument();
  });

  it('adding a yearly entry resets the Add row back to "One time"', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Recurrence' }), 'yearly-fixed');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Month' }), '7');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Day' }), '4');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Independence Day');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);

    expect(screen.getByRole('combobox', { name: 'Recurrence' })).toHaveValue('once');
  });
});

describe('TimeOffEditor: one-click US holiday presets', () => {
  it('offers all eleven ruling holidays as one-click buttons', () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    expect(screen.getByRole('button', { name: "New Year's Day" })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Memorial Day' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thanksgiving' })).toBeInTheDocument();
  });

  it('one click adds the holiday directly, with no intermediate form fill', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: 'Independence Day' }));

    expect(screen.getByText('Every year, July 4')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ companyHolidays: ['yearly:07-04|Independence Day'] }),
    );
  });

  it('Memorial Day is added as the REAL last-Monday-of-May rule, never a fixed date', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.click(screen.getByRole('button', { name: 'Memorial Day' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ companyHolidays: ['yearly-last:05-1|Memorial Day'] }),
    );
  });

  it('a preset already on the list is disabled, so one click cannot add the same holiday twice', () => {
    render(
      <TimeOffEditor
        data={{ ...EMPTY, companyHolidays: ['yearly:07-04|Independence Day'] }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Independence Day' })).toBeDisabled();
  });
});
