// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ListToolbar,
  DATE_RANGE_PRESETS,
  DEFAULT_DATE_RANGE,
  rangeStartIso,
  type DateRangeKey,
  type ListToolbarProps,
} from './ListToolbar';

function renderToolbar(overrides: Partial<ListToolbarProps> = {}) {
  const props: ListToolbarProps = {
    label: 'Filter invoices',
    search: '',
    onSearchChange: vi.fn(),
    searchLabel: 'Search invoices',
    range: '7d',
    onRangeChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ListToolbar {...props} />) };
}

/** The parent that really owns the state, which is the only way this is used. */
function Controlled() {
  const [search, setSearch] = useState('');
  const [range, setRange] = useState<DateRangeKey>(DEFAULT_DATE_RANGE);
  const [household, setHousehold] = useState('');
  return (
    <>
      <ListToolbar
        label="Filter invoices"
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search invoices"
        range={range}
        onRangeChange={setRange}
        facets={[
          {
            id: 'household',
            label: 'Household',
            value: household,
            onChange: setHousehold,
            options: [
              { value: 'h1', label: 'The Bakers' },
              { value: 'h2', label: 'The Chens' },
            ],
          },
        ]}
      />
      <output>{`${range}|${search}|${household}`}</output>
    </>
  );
}

describe('ListToolbar: the date-range presets', () => {
  it('offers exactly the four Phase 4 windows, in order', () => {
    renderToolbar();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Last 7 days',
      'Last 30 days',
      'Last 90 days',
      'All (archive)',
    ]);
  });

  it('makes the last 7 days the default, and says so in one exported place', () => {
    // Screens read DEFAULT_DATE_RANGE rather than hard-coding '7d', so the
    // default is changed once rather than on three screens that drift.
    expect(DEFAULT_DATE_RANGE).toBe('7d');
    expect(DATE_RANGE_PRESETS[0]?.key).toBe('7d');
  });

  it('marks the active window selected and leaves the rest unselected', () => {
    renderToolbar({ range: '30d' });
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
  });

  it('reports a click without selecting anything itself', async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    renderToolbar({ onRangeChange });

    await user.click(screen.getByRole('tab', { name: 'All (archive)' }));

    expect(onRangeChange).toHaveBeenCalledWith('all');
    // Still showing what the PARENT passed. The toolbar owns no query state.
    expect(screen.getByRole('tab', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('groups the presets as one related set of choices, with a name', () => {
    renderToolbar();
    expect(screen.getByRole('tablist', { name: 'Date range' })).toBeInTheDocument();
  });
});

describe('ListToolbar: the presets are keyboard-navigable', () => {
  it('puts only the selected chip in the Tab order (roving tabindex)', () => {
    renderToolbar({ range: '90d' });
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual([
      '-1',
      '-1',
      '0',
      '-1',
    ]);
  });

  it('moves focus with Left/Right without changing the window', async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    renderToolbar({ onRangeChange });
    const tabs = screen.getAllByRole('tab');

    tabs[0]?.focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs[1]).toHaveFocus();
    // Manual-activation model: arrowing is browsing, not choosing.
    expect(onRangeChange).not.toHaveBeenCalled();

    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(tabs[3]).toHaveFocus();
  });

  it('activates the focused chip on Enter', async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();
    renderToolbar({ onRangeChange });

    screen.getAllByRole('tab')[0]?.focus();
    await user.keyboard('{ArrowRight}{Enter}');

    expect(onRangeChange).toHaveBeenCalledWith('30d');
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    renderToolbar();
    const tabs = screen.getAllByRole('tab');

    tabs[0]?.focus();
    await user.keyboard('{End}');
    expect(tabs[3]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tabs[0]).toHaveFocus();
  });
});

describe('ListToolbar: the search box', () => {
  it('is a labelled search field showing exactly what the parent passed', () => {
    renderToolbar({ search: 'baker' });
    expect(screen.getByRole('searchbox', { name: 'Search invoices' })).toHaveValue('baker');
  });

  it('reports every keystroke and never stores one', async () => {
    const user = userEvent.setup();
    const onSearchChange = vi.fn();
    renderToolbar({ onSearchChange });

    await user.type(screen.getByRole('searchbox'), 'ab');

    expect(onSearchChange.mock.calls).toEqual([['a'], ['b']]);
    // Uncontrolled state would have left 'ab' sitting in the box.
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});

describe('ListToolbar: the facet selects', () => {
  it('renders nothing extra when a screen has no facets', () => {
    renderToolbar();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('labels each facet and pins an explicit All option at the top', () => {
    renderToolbar({
      facets: [
        {
          id: 'household',
          label: 'Household',
          value: '',
          onChange: vi.fn(),
          options: [{ value: 'h1', label: 'The Bakers' }],
        },
      ],
    });

    const select = screen.getByLabelText('Household');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All households',
      'The Bakers',
    ]);
    expect(select).toHaveValue('');
  });

  it('takes a custom all-option label when "All <label>s" reads wrong', () => {
    renderToolbar({
      facets: [
        {
          id: 'status',
          label: 'Status',
          value: '',
          allLabel: 'Any status',
          onChange: vi.fn(),
          options: [{ value: 'OPEN', label: 'Open' }],
        },
      ],
    });
    expect(within(screen.getByLabelText('Status')).getAllByRole('option')[0]).toHaveTextContent(
      'Any status',
    );
  });

  it('reports a facet change by value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderToolbar({
      facets: [
        {
          id: 'household',
          label: 'Household',
          value: '',
          onChange,
          options: [
            { value: 'h1', label: 'The Bakers' },
            { value: 'h2', label: 'The Chens' },
          ],
        },
      ],
    });

    await user.selectOptions(screen.getByLabelText('Household'), 'h2');
    expect(onChange).toHaveBeenCalledWith('h2');
  });
});

describe('ListToolbar: driven by a real owner', () => {
  it('lets the parent hold every value the toolbar reports', async () => {
    const user = userEvent.setup();
    render(<Controlled />);

    await user.type(screen.getByRole('searchbox'), 'chen');
    await user.click(screen.getByRole('tab', { name: 'Last 90 days' }));
    await user.selectOptions(screen.getByLabelText('Household'), 'h2');

    expect(screen.getByRole('status')).toHaveTextContent('90d|chen|h2');
    expect(screen.getByRole('searchbox')).toHaveValue('chen');
    expect(screen.getByRole('tab', { name: 'Last 90 days' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('ListToolbar: the honesty note', () => {
  it('renders the scope line a screen hands it, and nothing when it does not', () => {
    const { unmount } = renderToolbar({ note: 'Searching the selected date range.' });
    expect(screen.getByText('Searching the selected date range.')).toBeInTheDocument();
    unmount();

    renderToolbar();
    expect(screen.queryByText(/Searching/)).not.toBeInTheDocument();
  });
});

describe('rangeStartIso', () => {
  const NOW = new Date('2026-07-25T12:00:00.000Z');

  it('walks back the preset window from the moment it is given', () => {
    expect(rangeStartIso('7d', NOW)).toBe('2026-07-18T12:00:00.000Z');
    expect(rangeStartIso('30d', NOW)).toBe('2026-06-25T12:00:00.000Z');
    expect(rangeStartIso('90d', NOW)).toBe('2026-04-26T12:00:00.000Z');
  });

  it('returns null for the archive, which is the absence of a lower bound', () => {
    // Null, not the epoch: a screen must add NO predicate rather than a
    // predicate that happens to match everything, or the composite index and
    // the query plan differ between "All" and every other window.
    expect(rangeStartIso('all', NOW)).toBeNull();
  });

  it('agrees with the days each preset advertises', () => {
    for (const preset of DATE_RANGE_PRESETS) {
      const iso = rangeStartIso(preset.key, NOW);
      if (preset.days === null) {
        expect(iso).toBeNull();
      } else {
        expect(NOW.getTime() - new Date(iso ?? '').getTime()).toBe(preset.days * 86_400_000);
      }
    }
  });
});
