// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CollectionSpec } from '../../lib/firestore';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../../lib/firestore', () => ({ useCollection }));

import { TimeOffEditor } from './TimeOffEditor';

const EMPTY = { observedUsHolidays: [], companyHolidays: [], specialHours: [] };

/**
 * #1593: a new date has to be today or later in the business zone, so the
 * dates these tests type ("2026-12-25") are only upcoming against a pinned
 * clock. 18:00 UTC on 2026-11-09 is midday in Chicago, the default zone. The
 * closure-impact block below pins its own later day over this one.
 */
const PINNED_NOW = new Date('2026-11-09T18:00:00Z');
beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
});
afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  // Default: no existing sessions, so no editor test outside the dedicated
  // closure-impact block below has to think about the new banner at all.
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] });
});

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

describe('TimeOffEditor: one name per holiday (#1947)', () => {
  it('the switch and the quick-add chip call the October holiday the same thing', () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    const chip = screen.getByRole('button', { name: "Indigenous Peoples' Day (Columbus Day)" });
    expect(chip).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: "Toggle Indigenous Peoples' Day (Columbus Day) observed" }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Columbus Day')).toBeNull();
  });

  it('the renamed switch still saves the stored "columbus" id', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.click(
      screen.getByRole('switch', { name: "Toggle Indigenous Peoples' Day (Columbus Day) observed" }),
    );
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ observedUsHolidays: ['columbus'] }));
  });
});

describe('TimeOffEditor: company holidays in date order (#1979)', () => {
  // PINNED_NOW is 2026-11-09 in the business zone.
  const STORED = [
    'yearly:08-14|Summer break',
    'yearly:04-20|Spring B',
    'yearly:04-13|Spring A',
    '2026-12-16|Staff day',
  ];
  const listedNames = () =>
    Array.from(document.querySelectorAll('.timeOff__datedName')).map((el) => el.textContent);

  it('lists the next closure first, whatever order the list was stored in', () => {
    render(<TimeOffEditor data={{ ...EMPTY, companyHolidays: STORED }} onSave={vi.fn()} />);
    expect(listedNames()).toEqual(['Staff day', 'Spring A', 'Spring B', 'Summer break']);
  });

  it('a stored list out of date order does not open the panel as changed', () => {
    render(<TimeOffEditor data={{ ...EMPTY, companyHolidays: STORED }} onSave={vi.fn()} />);
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
  });

  it('Remove on a row takes out that holiday, not the one stored at its screen position', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={{ ...EMPTY, companyHolidays: STORED }} onSave={onSave} />);
    const firstRow = screen.getByText('Staff day').closest('li')!;
    await userEvent.click(within(firstRow).getByRole('button', { name: /remove/i }));
    expect(listedNames()).toEqual(['Spring A', 'Spring B', 'Summer break']);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        companyHolidays: ['yearly:08-14|Summer break', 'yearly:04-20|Spring B', 'yearly:04-13|Spring A'],
      }),
    );
  });

  it('a new one-time closure dated before the others lands at the top, and saves at the end of the list', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={{ ...EMPTY, companyHolidays: STORED }} onSave={onSave} />);
    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2026-11-20');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Office closed');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);
    expect(listedNames()[0]).toBe('Office closed');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ companyHolidays: [...STORED, '2026-11-20|Office closed'] }),
    );
  });

  it('a quick-add chip lands at its own date, not at the bottom', async () => {
    render(<TimeOffEditor data={{ ...EMPTY, companyHolidays: STORED }} onSave={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Thanksgiving' }));
    expect(listedNames()).toEqual(['Thanksgiving', 'Staff day', 'Spring A', 'Spring B', 'Summer break']);
  });

  it('orders by "today" in the business time zone across New Year, not this computer’s day', () => {
    // 03:30 UTC on Jan 1 2027: still Dec 31 in Chicago, already Jan 1 in UTC.
    // Whatever zone this computer is in, only one of the two renders could
    // match it, so both orders below hold only when the business zone is read.
    vi.setSystemTime(new Date('2027-01-01T03:30:00Z'));
    try {
      const yearEnd = ['yearly:01-01|New Year closure', 'yearly:12-31|Year end'];
      const { unmount } = render(
        <TimeOffEditor data={{ ...EMPTY, companyHolidays: yearEnd, timeZone: 'America/Chicago' }} onSave={vi.fn()} />,
      );
      expect(listedNames()).toEqual(['Year end', 'New Year closure']);
      unmount();
      render(<TimeOffEditor data={{ ...EMPTY, companyHolidays: yearEnd, timeZone: 'UTC' }} onSave={vi.fn()} />);
      expect(listedNames()).toEqual(['New Year closure', 'Year end']);
    } finally {
      vi.setSystemTime(PINNED_NOW);
    }
  });
});

/**
 * #1593: the add rows refuse what the server would, under the row, and the
 * Add button is never off without a sentence saying why once anything is in
 * the row.
 */
describe('TimeOffEditor: add-row checks (#1593)', () => {
  const DATE_INVALID = 'Enter a real date as YYYY-MM-DD.';
  const DATE_PAST = 'That date has passed. Pick today or a later date.';
  const addButtons = () => screen.getAllByRole('button', { name: /^add$/i });
  const closureDate = () => screen.getByPlaceholderText('2026-12-25');
  const closureName = () => screen.getByPlaceholderText('Christmas closure');
  const specialDate = () => screen.getByPlaceholderText('2026-12-24');
  const specialHours = () => screen.getByPlaceholderText('08:00-12:00');

  afterEach(() => {
    vi.setSystemTime(PINNED_NOW);
  });

  it('an untouched add row refuses nothing', () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(addButtons()[0]).toBeDisabled();
  });

  it.each(['2026-13-45', '2026-02-30', '12/25/2026'])(
    'refuses a closure date of %j that is not a real date, and Add stays off',
    async (typed) => {
      render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
      await userEvent.type(closureDate(), typed);
      await userEvent.type(closureName(), 'Office closed');
      expect(closureDate()).toHaveAttribute('aria-invalid', 'true');
      expect(closureDate()).toHaveAccessibleErrorMessage(DATE_INVALID);
      expect(addButtons()[0]).toBeDisabled();
    },
  );

  it('refuses a closure date that has passed, and takes today', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.type(closureName(), 'Office closed');
    await userEvent.type(closureDate(), '2026-11-08');
    expect(closureDate()).toHaveAccessibleErrorMessage(DATE_PAST);
    expect(addButtons()[0]).toBeDisabled();
    await userEvent.clear(closureDate());
    await userEvent.type(closureDate(), '2026-11-09');
    expect(closureDate()).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(addButtons()[0]).toBeEnabled();
  });

  it('reads "today" in the business time zone, not this computer’s', async () => {
    // 03:30 UTC on the 10th: still the 9th in Chicago, already the 10th in UTC.
    vi.setSystemTime(new Date('2026-11-10T03:30:00Z'));
    const { unmount } = render(<TimeOffEditor data={{ ...EMPTY, timeZone: 'America/Chicago' }} onSave={vi.fn()} />);
    await userEvent.type(closureDate(), '2026-11-09');
    expect(closureDate()).not.toHaveAttribute('aria-invalid');
    unmount();
    render(<TimeOffEditor data={{ ...EMPTY, timeZone: 'UTC' }} onSave={vi.fn()} />);
    await userEvent.type(closureDate(), '2026-11-09');
    expect(closureDate()).toHaveAccessibleErrorMessage(DATE_PAST);
  });

  it('asks for a name once a date is in, and refuses a | in it', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.type(closureDate(), '2026-12-25');
    expect(closureName()).toHaveAccessibleErrorMessage('Give the closure a name.');
    expect(addButtons()[0]).toBeDisabled();
    await userEvent.type(closureName(), 'Closed | back Monday');
    expect(closureName()).toHaveAccessibleErrorMessage('A name cannot contain |.');
    expect(addButtons()[0]).toBeDisabled();
  });

  it('says which yearly pick is still missing', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.selectOptions(screen.getByLabelText('Recurrence'), 'yearly-nth-weekday');
    expect(screen.getByLabelText('Month')).toHaveAccessibleErrorMessage('Pick a month.');
    expect(screen.getByLabelText('Weekday')).toHaveAccessibleErrorMessage('Pick a weekday.');
    expect(screen.getByLabelText('Occurrence')).toHaveAccessibleErrorMessage('Pick which week.');
    await userEvent.selectOptions(screen.getByLabelText('Month'), '11');
    await userEvent.selectOptions(screen.getByLabelText('Weekday'), '4');
    await userEvent.selectOptions(screen.getByLabelText('Occurrence'), '4');
    await userEvent.type(closureName(), 'Thanksgiving');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(addButtons()[0]).toBeEnabled();
  });

  it.each([
    ['zz-99', 'Enter both an opening and a closing time.'],
    ['08:00', 'Enter both an opening and a closing time.'],
    ['17:00-09:00', 'The closing time has to be after the opening time.'],
  ])('refuses special hours of %j under the add row', async (typed, sentence) => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.type(specialDate(), '2026-12-24');
    await userEvent.type(specialHours(), typed);
    expect(specialHours()).toHaveAttribute('aria-invalid', 'true');
    expect(specialHours()).toHaveAccessibleErrorMessage(sentence);
    expect(addButtons()[1]).toBeDisabled();
  });

  it('refuses a special-hours date that is not real or has passed', async () => {
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    await userEvent.type(specialHours(), '08:00-12:00');
    await userEvent.type(specialDate(), '2026-13-45');
    expect(specialDate()).toHaveAccessibleErrorMessage(DATE_INVALID);
    await userEvent.clear(specialDate());
    await userEvent.type(specialDate(), '2026-01-02');
    expect(specialDate()).toHaveAccessibleErrorMessage(DATE_PAST);
    expect(addButtons()[1]).toBeDisabled();
  });

  it('fixing the special hours clears the sentence, and Add saves the entry', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.type(specialDate(), '2026-12-24');
    await userEvent.type(specialHours(), 'zz-99');
    await userEvent.clear(specialHours());
    await userEvent.type(specialHours(), '08:00-12:00');
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(addButtons()[1]!);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ specialHours: ['2026-12-24|08:00-12:00'] }));
  });

  it('never re-checks an entry already stored, even one whose date has passed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <TimeOffEditor
        data={{ ...EMPTY, companyHolidays: ['2020-01-01|Old closure'], specialHours: ['2020-01-02|bad'] }}
        onSave={onSave}
      />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: 'Toggle Juneteenth observed' }));
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(onSave).toHaveBeenCalledWith({
      observedUsHolidays: ['juneteenth'],
      companyHolidays: ['2020-01-01|Old closure'],
      specialHours: ['2020-01-02|bad'],
    });
  });

  it('shows the server refusal sentence when the save is refused', async () => {
    const onSave = vi.fn().mockRejectedValue(
      Object.assign(new Error(DATE_PAST), {
        details: { code: 'settings_refused', field: 'companyHolidays', refusals: [{ field: 'companyHolidays', message: DATE_PAST }] },
      }),
    );
    render(<TimeOffEditor data={EMPTY} onSave={onSave} />);
    await userEvent.type(closureDate(), '2026-12-25');
    await userEvent.type(closureName(), 'Office closed');
    await userEvent.click(addButtons()[0]!);
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText(DATE_PAST)).toBeInTheDocument();
  });
});

/**
 * C1: what happens to a visit that ALREADY exists on a day later marked
 * closed. Nothing automatically -- see the file header's C1 section -- but
 * this banner is how the operator finds out, before or after Save, rather
 * than the closure and the booking silently coexisting.
 */
describe('TimeOffEditor: closure-impact banner', () => {
  const ORIG_TZ = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/Chicago';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2027, 7, 15, 12, 0, 0)); // 2027-08-15
  });
  afterAll(() => {
    vi.useRealTimers();
    process.env.TZ = ORIG_TZ;
  });

  function sessionsFixture(rows: Array<{ startTime: string }>) {
    useCollection.mockReset().mockImplementation((spec: CollectionSpec) => {
      if (spec.path === 'kin_care_sessions') return { status: 'ready', data: rows };
      return { status: 'ready', data: [] };
    });
  }

  it('warns when an existing session already falls on a saved closure date', () => {
    sessionsFixture([{ startTime: '2027-12-25T15:00:00.000Z' }]);
    render(
      <TimeOffEditor data={{ ...EMPTY, companyHolidays: ['2027-12-25|Christmas'] }} onSave={vi.fn()} />,
    );
    expect(screen.getByText('Visits already scheduled on a closure date')).toBeInTheDocument();
    expect(screen.getByText(/2027-12-25: 1 visit \(Christmas\)/)).toBeInTheDocument();
  });

  it('warns for an UNSAVED (staged) closure too, before Save is even pressed', async () => {
    sessionsFixture([{ startTime: '2027-12-25T15:00:00.000Z' }]);
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    expect(screen.queryByText('Visits already scheduled on a closure date')).not.toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText('2026-12-25'), '2027-12-25');
    await userEvent.type(screen.getByPlaceholderText('Christmas closure'), 'Christmas');
    await userEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);

    expect(screen.getByText('Visits already scheduled on a closure date')).toBeInTheDocument();
  });

  it('honors yearly recurrence: a session on the RECURRING date next year is still flagged', () => {
    sessionsFixture([{ startTime: '2028-07-04T15:00:00.000Z' }]);
    render(
      <TimeOffEditor
        data={{ ...EMPTY, companyHolidays: ['yearly:07-04|Independence Day'] }}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText(/2028-07-04: 1 visit \(Independence Day\)/)).toBeInTheDocument();
  });

  it('stays silent when no existing session falls on any closure date', () => {
    sessionsFixture([{ startTime: '2027-12-24T15:00:00.000Z' }]); // day before the closure
    render(
      <TimeOffEditor data={{ ...EMPTY, companyHolidays: ['2027-12-25|Christmas'] }} onSave={vi.fn()} />,
    );
    expect(screen.queryByText('Visits already scheduled on a closure date')).not.toBeInTheDocument();
  });

  it('stays silent with no company holidays at all, even with sessions on file', () => {
    sessionsFixture([{ startTime: '2027-12-25T15:00:00.000Z' }]);
    render(<TimeOffEditor data={EMPTY} onSave={vi.fn()} />);
    expect(screen.queryByText('Visits already scheduled on a closure date')).not.toBeInTheDocument();
  });

  it('degrades to no banner (never an error) when the sessions read fails', () => {
    useCollection.mockReset().mockImplementation((spec: CollectionSpec) =>
      spec.path === 'kin_care_sessions'
        ? { status: 'error', message: 'permission-denied', retry: vi.fn() }
        : { status: 'ready', data: [] },
    );
    render(
      <TimeOffEditor data={{ ...EMPTY, companyHolidays: ['2027-12-25|Christmas'] }} onSave={vi.fn()} />,
    );
    expect(screen.queryByText('Visits already scheduled on a closure date')).not.toBeInTheDocument();
    // The rest of the panel still works; a failed advisory read is not a hard dependency.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
  });
});
