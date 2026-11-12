// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_COVERAGE_RULES, todayIso } from '../lib/coveragePackage';

const getBusinessSettings = vi.fn();
vi.mock('../api/settings', () => ({
  getBusinessSettings: () => getBusinessSettings(),
}));

import { CoveragePackageBuilder } from './CoveragePackageBuilder';

/**
 * The screen's tests cover three rulings, in the order they were made.
 *
 * PANEL ORDER (marks 4 and 24 of the 2026-08-17 admin walk, "the package builder
 * sections need to be reordered into a proper workflow"). The order WAS: Visit
 * menu, Coverage rules for this client, Coverage window, Packages. So the screen
 * opened on a saved config panel, then asked for this client's rules, and only
 * then asked which client and which dates.
 *
 * NO SECOND RATE CARD (issue #693, "Visit menu needs to be deleted"). The Visit
 * menu panel edited a durations list in `coverage_package_config/config`, a rate
 * card parallel to `business_settings.serviceRates` that Settings already edits.
 * The menu is now read from Settings and the panel is gone.
 *
 * START DATE OPENS ON TODAY (issue #693, "date field should start at today's
 * date"). It used to initialize to '', so a fresh quote priced nothing until the
 * operator picked a date by hand.
 */

/** The operator's KinCare types, the shape `KinCareRatesEditor` saves. */
const SETTINGS = {
  serviceRates: { '30Minute': '25', '60Minute': '45', Overnight: '150' },
  serviceDurations: { Overnight: '720' },
};

/**
 * Every panel on this screen is a level-2 heading (it's a top-level screen,
 * not composed inside a `Dialog`), so querying by role and level is the real
 * proof a screen reader can navigate these, not just a DOM read.
 */
function panelTitles(): HTMLElement[] {
  return screen.getAllByRole('heading', { level: 2 });
}
function panelTitled(title: string): HTMLElement {
  const match = panelTitles().find((el) => el.textContent?.trim() === title);
  if (!match) throw new Error(`No panel titled "${title}". Found: ${panelTitles().map((el) => el.textContent?.trim()).join(', ')}`);
  return match;
}
beforeEach(() => {
  window.localStorage.clear();
  getBusinessSettings.mockReset().mockResolvedValue(SETTINGS);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('CoveragePackageBuilder panel order', () => {
  it('reads as a workflow: who and when, this client\'s rules, then the packages', async () => {
    render(<CoveragePackageBuilder />);
    // Every panel title on the screen, in DOM order. Headings, not text, so a
    // stray mention of "Packages" in body copy cannot satisfy this.
    await screen.findByLabelText(/client \(optional\)/i);
    const titles = panelTitles().map((el) => el.textContent?.trim());
    const workflow = titles.filter(
      (t): t is string =>
        t === 'Coverage window' || t === 'Coverage rules for this client' || t === 'Packages',
    );
    expect(workflow).toEqual(['Coverage window', 'Coverage rules for this client', 'Packages']);
  });

  it('asks WHICH CLIENT before it offers rules "for this client"', async () => {
    render(<CoveragePackageBuilder />);
    const client = await screen.findByLabelText(/client \(optional\)/i);
    const rules = panelTitled('Coverage rules for this client');
    // Node.compareDocumentPosition: FOLLOWING means `rules` comes after `client`.
    // eslint-disable-next-line no-bitwise
    expect(client.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('CoveragePackageBuilder visit menu (issue #693)', () => {
  it('has no Visit menu panel, so there is only one rate card', async () => {
    render(<CoveragePackageBuilder />);
    await screen.findByLabelText(/client \(optional\)/i);
    expect(panelTitles().map((el) => el.textContent?.trim())).not.toContain('Visit menu');
    // The panel's own controls go with it: no editable service rows, no add row,
    // and no Save/Revert bar for a menu this screen no longer owns.
    expect(screen.queryByLabelText(/^service name$/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/new service name/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /save visit menu|restore defaults/i })).toBeNull();
  });

  it('offers the operator\'s KinCare types as the visit lengths', async () => {
    render(<CoveragePackageBuilder />);
    const pinnedLength = await screen.findByLabelText(/pinned visit length/i);
    const options = [...pinnedLength.querySelectorAll('option')].map((o) => o.textContent);
    // Names come straight off `serviceRates`, ordered by duration.
    expect(options).toContain('30Minute');
    expect(options).toContain('60Minute');
    expect(options).toContain('Overnight');
  });

  it('labels Pinned visits plainly and explains it in an info tip (#1595)', async () => {
    render(<CoveragePackageBuilder />);
    const explain = await screen.findByText(/this client's non-negotiables/i);
    expect(explain.closest('[role="tooltip"]')).not.toBeNull();
    const label = document.querySelector('.cpb__pinnedHeading');
    expect(label?.firstChild?.textContent?.trim()).toBe('Pinned visits');
  });

  it('says where to set rates when the KinCare list is empty', async () => {
    getBusinessSettings.mockResolvedValue({ serviceRates: {}, serviceDurations: {} });
    render(<CoveragePackageBuilder />);
    expect(await screen.findByText(/no kincare types yet/i)).toBeTruthy();
    expect(screen.getByText(/settings, kincare types/i)).toBeTruthy();
  });
});

describe('CoveragePackageBuilder start date (issue #693)', () => {
  it('opens on today, not blank', async () => {
    // A local-evening instant: a UTC-based "today" would read as the next day.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 8, 9, 22, 30));
    render(<CoveragePackageBuilder />);
    const start = await screen.findByLabelText(/^start$/i);
    expect((start as HTMLInputElement).value).toBe('2026-09-09');
    expect(todayIso()).toBe('2026-09-09');
  });

  it('keeps a start date the operator already picked', async () => {
    window.localStorage.setItem(
      'tt-coverage-quote-v1',
      JSON.stringify({ clientName: '', startDate: '2026-12-24', endDate: '', overnightDurationId: '', packages: [] }),
    );
    render(<CoveragePackageBuilder />);
    const start = await screen.findByLabelText(/^start$/i);
    expect((start as HTMLInputElement).value).toBe('2026-12-24');
  });
});

/**
 * Issue #694, "Return the Lean, Balance, and Premium auto creation along with
 * the ability to create a custom package". The tiers were auto-built cards
 * (69a233c), then optional seed buttons (48dd58a), then nothing at all once
 * cd1aaab made a "degenerate" config build no pattern. The operator's own rules
 * are that config, so the Packages panel offered only "+ New package".
 */
async function packageNames(): Promise<string[]> {
  const inputs = await screen.findAllByLabelText('Package name');
  return inputs.map((el) => (el as HTMLInputElement).value);
}
function storeQuote(quote: Record<string, unknown>): void {
  window.localStorage.setItem('tt-coverage-quote-v1', JSON.stringify(quote));
}

describe('CoveragePackageBuilder tiers (issue #694)', () => {
  it('opens a fresh quote with Lean, Balance and Premium already built', async () => {
    render(<CoveragePackageBuilder />);
    expect(await packageNames()).toEqual(['Lean', 'Balance', 'Premium']);
  });

  it('seeds the tiers against the KinCare menu, not the shipped dead pin (merging after #728)', async () => {
    // DEFAULT_COVERAGE_RULES pins `d2`, an id from the deleted builder-owned menu.
    // #728 made the service NAME the duration id, so a seed that skipped
    // alignPinnedToDurations would carry `d2` straight into a visit: a $0 "no
    // duration set" line the operator never asked for.
    render(<CoveragePackageBuilder />);
    await packageNames();
    // The names paint before the persist effect has written the quote, so on
    // a slow runner the item is still null right after the names resolve.
    // Wait for the write itself rather than for its side effect on screen.
    await waitFor(() => expect(window.localStorage.getItem('tt-coverage-quote-v1')).not.toBeNull());
    const stored = JSON.parse(window.localStorage.getItem('tt-coverage-quote-v1')!);
    const knownIds = new Set(Object.keys(SETTINGS.serviceRates));
    expect(stored.packages.length).toBeGreaterThan(0);
    for (const pkg of stored.packages) {
      expect(pkg.visits.length).toBeGreaterThan(0);
      for (const visit of pkg.visits) {
        expect(visit.durationId).not.toBe('d2');
        expect(visit.durationId).not.toBe('');
        expect(knownIds.has(visit.durationId)).toBe(true);
      }
    }
  });

  it('still offers a custom package beside them', async () => {
    render(<CoveragePackageBuilder />);
    await packageNames();
    expect(screen.getByRole('button', { name: /new package/i })).toBeTruthy();
  });

  it('builds the three tiers for the config that used to build none', async () => {
    // The operator's live rules: an 11:00-14:00 day inside a 6h max gap, no
    // pinned visit. This is the case cd1aaab called degenerate.
    storeQuote({
      clientName: '',
      startDate: '',
      endDate: '',
      overnightDurationId: '',
      rules: { wakeStart: '11:00', wakeEnd: '14:00', maxGapHours: 6, pinnedTimes: [] },
      packages: [],
    });
    render(<CoveragePackageBuilder />);
    expect(await packageNames()).toEqual(['Lean', 'Balance', 'Premium']);
    // Each degraded card says why, rather than silently pricing one visit.
    expect(screen.getAllByText(/fits inside the 6h max gap/)).toHaveLength(3);
  });

  it('does not grow the tiers back on a quote whose tiers were deleted', async () => {
    storeQuote({
      clientName: 'Rex',
      startDate: '',
      endDate: '',
      overnightDurationId: '',
      rules: DEFAULT_COVERAGE_RULES,
      packages: [],
      tiersSeeded: true,
    });
    render(<CoveragePackageBuilder />);
    await screen.findByLabelText(/client \(optional\)/i);
    expect(screen.queryAllByLabelText('Package name')).toHaveLength(0);
  });

  it('keeps a hand-built package and adds the tiers beside it', async () => {
    storeQuote({
      clientName: '',
      startDate: '',
      endDate: '',
      overnightDurationId: '',
      rules: DEFAULT_COVERAGE_RULES,
      packages: [{ id: 'mine', name: 'Rex week', visits: [] }],
    });
    render(<CoveragePackageBuilder />);
    expect(await packageNames()).toEqual(['Rex week', 'Lean', 'Balance', 'Premium']);
  });
});

describe('CoveragePackageBuilder undo and duplicates (issue #1605)', () => {
  const quote = (over: Record<string, unknown> = {}) =>
    storeQuote({
      clientName: 'Rex',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      overnightDurationId: '',
      rules: DEFAULT_COVERAGE_RULES,
      packages: [
        { id: 'a', name: 'Alpha', visits: [{ id: 'va', time: 540, durationId: '30Minute', label: 'Morning' }] },
        { id: 'b', name: 'Beta', visits: [] },
      ],
      tiersSeeded: true,
      ...over,
    });
  it('gives a deleted package back, in its place, with Undo', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    expect(await packageNames()).toEqual(['Alpha', 'Beta']);
    await user.click(screen.getAllByRole('button', { name: 'Delete package' })[0]!);
    expect(await packageNames()).toEqual(['Beta']);
    expect(screen.getByText('Deleted package "Alpha".')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await packageNames()).toEqual(['Alpha', 'Beta']);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
  it('gives a removed visit back at the same spot', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    await user.click(screen.getByRole('button', { name: 'Remove visit' }));
    expect(screen.queryByDisplayValue('Morning')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByDisplayValue('Morning')).toBeTruthy();
  });
  it('puts the whole quote back after Start new quote', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    await user.click(screen.getByRole('button', { name: 'Start new quote' }));
    expect((screen.getByLabelText(/client \(optional\)/i) as HTMLInputElement).value).toBe('');
    expect(await packageNames()).toEqual(['Lean', 'Balance', 'Premium']);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByLabelText(/client \(optional\)/i) as HTMLInputElement).value).toBe('Rex');
    expect(await packageNames()).toEqual(['Alpha', 'Beta']);
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe('2026-12-01');
  });
  it('brings the Max gap back with the rules after Start new quote (#1582 with #1605)', async () => {
    const user = userEvent.setup();
    quote({ rules: { ...DEFAULT_COVERAGE_RULES, maxGapHours: 4.5 } });
    render(<CoveragePackageBuilder />);
    await packageNames();
    const gap = () => screen.getByLabelText('Max gap between visits (hrs)') as HTMLInputElement;
    expect(gap().value).toBe('4.5');
    await user.click(screen.getByRole('button', { name: 'Start new quote' }));
    expect(gap().value).toBe(String(DEFAULT_COVERAGE_RULES.maxGapHours));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(gap().value).toBe('4.5');
  });
  it('names each duplicate differently', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    const dup = () => screen.getAllByRole('button', { name: 'Duplicate package' })[0]!;
    await user.click(dup());
    await user.click(dup());
    const names = await packageNames();
    expect(names).toEqual(['Alpha', 'Beta', 'Alpha copy', 'Alpha copy 2']);
    expect(new Set(names).size).toBe(names.length);
  });
  it('shows CUSTOMIZED only once the day differs from the template', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    await user.click(screen.getAllByRole('button', { name: 'View day-by-day' })[0]!);
    await user.click((await screen.findAllByRole('button', { name: 'Customize this day' }))[0]!);
    // Forked but untouched: the editor is open, the badge is not.
    expect(screen.queryByText('Customized')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Reset to template' }).length).toBeGreaterThan(0);
    const editor = document.querySelector('.cpb__dayEditor') as HTMLElement;
    const label = within(editor).getByDisplayValue('Morning');
    await user.type(label, 'x');
    expect(screen.getByText('Customized')).toBeTruthy();
  });
});
describe('CoveragePackageBuilder Max gap (issue #1582)', () => {
  const GAP_LABEL = 'Max gap between visits (hrs)';
  const storedGap = (): number => JSON.parse(window.localStorage.getItem('tt-coverage-quote-v1')!).rules.maxGapHours;
  it('refuses a minus sign with a message beside the field and reprices nothing', async () => {
    const user = userEvent.setup();
    render(<CoveragePackageBuilder />);
    await packageNames();
    const field = (await screen.findByLabelText(GAP_LABEL)) as HTMLInputElement;
    expect(field.value).toBe('6');
    await user.clear(field);
    await user.type(field, '-5');
    // What was typed stays typed: it is refused, not rewritten into 15.
    expect(field.value).toBe('-5');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/minus sign is not allowed/i);
    expect(alert.textContent).toMatch(/Prices still use 6h/);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(storedGap()).toBe(6));
  });
  it('refuses an empty field and a gap under one hour', async () => {
    const user = userEvent.setup();
    render(<CoveragePackageBuilder />);
    await packageNames();
    const field = (await screen.findByLabelText(GAP_LABEL)) as HTMLInputElement;
    await user.clear(field);
    expect(screen.getByRole('alert').textContent).toMatch(/Enter the longest gap/);
    await user.type(field, '0');
    expect(screen.getByRole('alert').textContent).toMatch(/at least 1 hour/);
    await user.type(field, '.5');
    expect(screen.getByRole('alert').textContent).toMatch(/at least 1 hour/);
    // Every keystroke was refused, so the rule never moved off 6.
    await waitFor(() => expect(storedGap()).toBe(6));
  });
  it('takes a valid entry, clears the message and uses it', async () => {
    const user = userEvent.setup();
    render(<CoveragePackageBuilder />);
    await packageNames();
    const field = (await screen.findByLabelText(GAP_LABEL)) as HTMLInputElement;
    await user.clear(field);
    await user.type(field, '4.5');
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(storedGap()).toBe(4.5));
    // No upper bound: a long gap is the operator's call.
    await user.clear(field);
    await user.type(field, '30');
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(storedGap()).toBe(30));
  });
  it('shows a stored unreadable max gap with its message and prices at the default', async () => {
    storeQuote({
      clientName: '', startDate: '', endDate: '', overnightDurationId: '',
      rules: { wakeStart: '07:00', wakeEnd: '22:00', maxGapHours: -5, pinnedTimes: [] },
      packages: [], tiersSeeded: true,
    });
    render(<CoveragePackageBuilder />);
    const field = (await screen.findByLabelText(GAP_LABEL)) as HTMLInputElement;
    // Shown as stored, never quietly swapped: the message says what prices use.
    expect(field.value).toBe('-5');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/minus sign is not allowed/i);
    expect(alert.textContent).toMatch(/Prices still use 6h/);
    await waitFor(() => expect(storedGap()).toBe(6));
  });
});

describe('CoveragePackageBuilder Discount, Buffer and dates (issue #1593)', () => {
  const DISCOUNT = 'Enter a discount from 0 to 100 percent.';
  const BUFFER = 'Enter the buffer in hours, 0 or more, like 1 or 1.5.';
  const DATES = 'The end date has to be on or after the start date.';
  const storedPkg = (): Record<string, unknown> =>
    JSON.parse(window.localStorage.getItem('tt-coverage-quote-v1')!).packages[0];
  const quote = (pkgOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
    storeQuote({
      clientName: 'Rex',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      overnightDurationId: '',
      rules: DEFAULT_COVERAGE_RULES,
      packages: [{ id: 'a', name: 'Alpha', visits: [{ id: 'va', time: 540, durationId: '30Minute', label: 'Morning' }], ...pkgOver }],
      tiersSeeded: true,
      ...over,
    });
  const discount = () => screen.getByLabelText('Discount percent') as HTMLInputElement;
  const buffer = () => screen.getByLabelText('Buffer (hrs)') as HTMLInputElement;
  /** The message the field points at with aria-describedby: beside it, not a banner. */
  const messageFor = (field: HTMLElement): string | null => {
    const id = field.getAttribute('aria-describedby');
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  };
  it('refuses 150, -20 and abc in Discount beside the field and never caps them', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    // Typed a key at a time, "150" passes through "15", a real discount. That prefix
    // is not what the operator chose (#2021): every refused entry prices at the 0%
    // the package held before the typing started.
    for (const bad of ['-20', 'abc', '150']) {
      await user.clear(discount());
      await user.type(discount(), bad);
      // What was typed stays typed: refused, not rewritten into 100 or 0.
      expect(discount().value).toBe(bad);
      expect(discount().getAttribute('aria-invalid')).toBe('true');
      expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 0%.`);
      expect(screen.getByRole('alert').textContent).toBe(`${DISCOUNT} Prices still use 0%.`);
    }
    // Never capped at 100, and never the first digits of what was typed.
    expect(screen.queryByText(/Discount \(/)).toBeNull();
    await waitFor(() => expect(storedPkg().discountPct).toBe(0));
  });
  it('prices at the discount held before the edit while a typed one is refused, and fixing it clears', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    await user.type(discount(), '12.5');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Discount (12.5%)')).toBeTruthy();
    await waitFor(() => expect(storedPkg().discountPct).toBe(12.5));
    // Same edit, one more key: "12.5x" is refused, so the price is the 0% from
    // before the edit, not the "12.5" the entry passed through (#2021).
    await user.type(discount(), 'x');
    expect(discount().value).toBe('12.5x');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 0%.`);
    expect(screen.queryByText(/Discount \(/)).toBeNull();
    await user.type(discount(), '{Backspace}');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(discount().getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByText('Discount (12.5%)')).toBeTruthy();
    // Blank means no discount.
    await user.clear(discount());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Discount \(/)).toBeNull();
    await waitFor(() => expect(storedPkg().discountPct).toBe(0));
  });
  it('refuses abc, -1 and blank in Buffer beside the field and keeps the last good buffer', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    expect(buffer().value).toBe('2');
    for (const bad of ['abc', '-1', '']) {
      await user.clear(buffer());
      if (bad) await user.type(buffer(), bad);
      expect(buffer().value).toBe(bad);
      expect(buffer().getAttribute('aria-invalid')).toBe('true');
      expect(messageFor(buffer())).toBe(`${BUFFER} Prices still use 2h.`);
    }
    await waitFor(() => expect(storedPkg().overnightBufferHours).toBe(2));
    await user.type(buffer(), '1.5');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(buffer().getAttribute('aria-invalid')).toBeNull();
    await waitFor(() => expect(storedPkg().overnightBufferHours).toBe(1.5));
    // 0 is a real buffer.
    await user.clear(buffer());
    await user.type(buffer(), '0');
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(storedPkg().overnightBufferHours).toBe(0));
  });
  it('opens a stored discount and buffer the fields would refuse as stored, with their messages', async () => {
    quote({ discountPct: 150, overnightBufferHours: -1 });
    render(<CoveragePackageBuilder />);
    await packageNames();
    expect(discount().value).toBe('150');
    expect(discount().getAttribute('aria-invalid')).toBe('true');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 0%.`);
    expect(buffer().value).toBe('-1');
    expect(messageFor(buffer())).toBe(`${BUFFER} Prices still use 2h.`);
    expect(screen.queryByText(/Discount \(/)).toBeNull();
    await waitFor(() => expect(storedPkg()).toMatchObject({ discountPct: 0, overnightBufferHours: 2 }));
  });
  it('brings typed Discount and Buffer back with Undo after Start new quote', async () => {
    const user = userEvent.setup();
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    await user.type(discount(), '-20');
    await user.clear(buffer());
    await user.type(buffer(), 'abc');
    await user.click(screen.getByRole('button', { name: 'Start new quote' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(discount().value).toBe('-20');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 0%.`);
    expect(buffer().value).toBe('abc');
    expect(messageFor(buffer())).toBe(`${BUFFER} Prices still use 2h.`);
  });
  it('says beside End that it falls before Start, prices nothing, and clears once fixed', async () => {
    quote();
    render(<CoveragePackageBuilder />);
    await packageNames();
    const end = screen.getByLabelText('End') as HTMLInputElement;
    expect(screen.getByText(/3 days of coverage/)).toBeTruthy();
    fireEvent.change(end, { target: { value: '2026-11-25' } });
    expect(end.getAttribute('aria-invalid')).toBe('true');
    expect(messageFor(end)).toBe(DATES);
    expect(screen.getByRole('alert').textContent).toBe(DATES);
    expect(screen.queryByText(/days? of coverage/)).toBeNull();
    expect(screen.queryByText('Total')).toBeNull();
    expect(screen.getByText('Fix the end date above to price this.')).toBeTruthy();
    expect(screen.queryByText('Set a date range to price this.')).toBeNull();
    fireEvent.change(end, { target: { value: '2026-12-01' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(end.getAttribute('aria-invalid')).toBeNull();
    expect(screen.getByText(/1 day of coverage/)).toBeTruthy();
    expect(screen.getByText('Total')).toBeTruthy();
  });
  it('keeps the overnight nights when End is briefly set before Start', async () => {
    quote({ overnightNights: { 0: true, 1: true } });
    render(<CoveragePackageBuilder />);
    await packageNames();
    const end = screen.getByLabelText('End') as HTMLInputElement;
    fireEvent.change(end, { target: { value: '2026-11-25' } });
    expect(messageFor(end)).toBe(DATES);
    fireEvent.change(end, { target: { value: '2026-12-03' } });
    await waitFor(() => expect(storedPkg().overnightNights).toEqual({ 0: true, 1: true }));
  });
  it('opens a stored quote whose End falls before Start with the message showing', async () => {
    quote({}, { startDate: '2026-12-05', endDate: '2026-12-01' });
    render(<CoveragePackageBuilder />);
    await packageNames();
    const end = screen.getByLabelText('End') as HTMLInputElement;
    expect(end.getAttribute('aria-invalid')).toBe('true');
    expect(messageFor(end)).toBe(DATES);
  });
});

/**
 * #2021, a regression of #1593. The Discount field refused "150" with a message,
 * but every keystroke that parsed had already been priced, so the "15" on the way
 * to "150" stayed as the discount. A refused entry now prices at what the field
 * held before the edit began. Buffer and Max gap shared the handler and the fault.
 */
describe('CoveragePackageBuilder refused entries keep no typed prefix (issue #2021)', () => {
  const DISCOUNT = 'Enter a discount from 0 to 100 percent.';
  const BUFFER = 'Enter the buffer in hours, 0 or more, like 1 or 1.5.';
  const stored = (): { packages: Record<string, unknown>[]; rules: { maxGapHours: number } } =>
    JSON.parse(window.localStorage.getItem('tt-coverage-quote-v1')!);
  const quote = (pkgOver: Record<string, unknown> = {}) =>
    storeQuote({
      clientName: 'Rex',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      overnightDurationId: '',
      rules: DEFAULT_COVERAGE_RULES,
      // $25 a day for 3 days: subtotal $75.00.
      packages: [{ id: 'a', name: 'Alpha', visits: [{ id: 'va', time: 540, durationId: '30Minute', label: 'Morning' }], ...pkgOver }],
      tiersSeeded: true,
    });
  const discount = () => screen.getByLabelText('Discount percent') as HTMLInputElement;
  const buffer = () => screen.getByLabelText('Buffer (hrs)') as HTMLInputElement;
  const gap = () => screen.getByLabelText('Max gap between visits (hrs)') as HTMLInputElement;
  const messageFor = (field: HTMLElement): string | null => {
    const id = field.getAttribute('aria-describedby');
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  };
  const total = (): string => document.querySelector('.cpb__totalLine--final')!.textContent!;
  const open = async () => {
    render(<CoveragePackageBuilder />);
    await packageNames();
    return userEvent.setup();
  };
  it('prices 150 then Tab at the 0% from before the typing, then 250 the same (the walk)', async () => {
    quote();
    const user = await open();
    expect(total()).toBe('Total$75.00');
    await user.click(discount());
    await user.keyboard('150');
    await user.tab();
    expect(discount().value).toBe('150');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 0%.`);
    expect(screen.queryByText(/Discount \(/)).toBeNull();
    expect(total()).toBe('Total$75.00');
    await waitFor(() => expect(stored().packages[0]!.discountPct).toBe(0));
    // Set the box to 0, then 250.
    await user.clear(discount());
    await user.type(discount(), '0');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.clear(discount());
    await user.type(discount(), '250');
    await user.tab();
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 0%.`);
    expect(total()).toBe('Total$75.00');
    // "abc" next leaves it alone too.
    await user.clear(discount());
    await user.type(discount(), 'abc');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 0%.`);
    expect(total()).toBe('Total$75.00');
    await waitFor(() => expect(stored().packages[0]!.discountPct).toBe(0));
  });
  it('still shows the price of a good discount as it is typed', async () => {
    quote();
    const user = await open();
    await user.type(discount(), '20');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Discount (20%)')).toBeTruthy();
    expect(total()).toBe('Total$60.00');
    await waitFor(() => expect(stored().packages[0]!.discountPct).toBe(20));
  });
  it('takes 100 and 0 and blank, and refuses 101 and letters back to the discount held before', async () => {
    quote({ discountPct: 20 });
    const user = await open();
    expect(screen.getByText('Discount (20%)')).toBeTruthy();
    // 101: one over the limit. Passes through 1 and 10; prices at the 20% held before.
    await user.clear(discount());
    await user.type(discount(), '101');
    expect(discount().value).toBe('101');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 20%.`);
    expect(screen.getByText('Discount (20%)')).toBeTruthy();
    expect(total()).toBe('Total$60.00');
    await waitFor(() => expect(stored().packages[0]!.discountPct).toBe(20));
    // Not a number at all.
    await user.clear(discount());
    await user.type(discount(), '5x');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 20%.`);
    expect(total()).toBe('Total$60.00');
    // 100 is the top of the range and is taken.
    await user.clear(discount());
    await user.type(discount(), '100');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Discount (100%)')).toBeTruthy();
    expect(total()).toBe('Total$0.00');
    // 0 and blank both mean no discount.
    await user.clear(discount());
    await user.type(discount(), '0');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Discount \(/)).toBeNull();
    await user.clear(discount());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(total()).toBe('Total$75.00');
    await waitFor(() => expect(stored().packages[0]!.discountPct).toBe(0));
  });
  it('counts a discount as chosen once the field is left: 20, Tab, then 200 keeps 20%', async () => {
    quote();
    const user = await open();
    await user.type(discount(), '20');
    await user.tab();
    await user.type(discount(), '0');
    expect(discount().value).toBe('200');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 20%.`);
    expect(screen.getByText('Discount (20%)')).toBeTruthy();
    await waitFor(() => expect(stored().packages[0]!.discountPct).toBe(20));
  });
  it('counts a discount as chosen on Enter as well', async () => {
    quote();
    const user = await open();
    await user.type(discount(), '20{Enter}0');
    expect(discount().value).toBe('200');
    expect(messageFor(discount())).toBe(`${DISCOUNT} Prices still use 20%.`);
  });
  it('keeps the buffer held before the edit when 12a is typed', async () => {
    quote();
    const user = await open();
    await user.clear(buffer());
    await user.type(buffer(), '12a');
    expect(buffer().value).toBe('12a');
    expect(messageFor(buffer())).toBe(`${BUFFER} Prices still use 2h.`);
    await waitFor(() => expect(stored().packages[0]!.overnightBufferHours).toBe(2));
    await user.type(buffer(), '{Backspace}');
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(stored().packages[0]!.overnightBufferHours).toBe(12));
  });
  it('keeps the max gap held before the edit when 12a is typed, and leaves the text as typed', async () => {
    quote();
    const user = await open();
    await user.clear(gap());
    await user.type(gap(), '12a');
    expect(gap().value).toBe('12a');
    expect(gap().getAttribute('aria-invalid')).toBe('true');
    expect(messageFor(gap())).toMatch(/Enter hours as a plain number.*Prices still use 6h\./);
    await waitFor(() => expect(stored().rules.maxGapHours).toBe(6));
    await user.type(gap(), '{Backspace}');
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect(stored().rules.maxGapHours).toBe(12));
  });
});
/**
 * #1858. The line at the top of a tier ("The 2h day fits inside the 24h max gap,
 * so this tier is one check-in at 12:00 PM.") was written once, when the tier was
 * built, and stored on the package. It went on saying 24h after Max gap became 6
 * and stayed on a package whose visit had been removed. It is now worked out from
 * the rules and the visits on screen.
 */
describe('CoveragePackageBuilder package note (issue #1858)', () => {
  const stored = (): { packages: Record<string, unknown>[] } => JSON.parse(window.localStorage.getItem('tt-coverage-quote-v1')!);
  /** A 3 hour day with no pinned visit: every tier is one check-in at 12:30 PM. */
  const shortDay = (maxGapHours: number) => ({ wakeStart: '11:00', wakeEnd: '14:00', maxGapHours, pinnedTimes: [] });
  const note = (hours: number): string => `The 3h day fits inside the ${hours}h max gap, so this tier is one check-in at 12:30 PM.`;
  const notes = (): string[] => [...document.querySelectorAll('.cpb__pkgNote')].map((el) => el.textContent ?? '');
  const cards = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.cpb__pkg')];
  const gap = () => screen.getByLabelText('Max gap between visits (hrs)') as HTMLInputElement;
  const fresh = (maxGapHours: number) =>
    storeQuote({ clientName: '', startDate: '2026-12-01', endDate: '2026-12-03', overnightDurationId: '', rules: shortDay(maxGapHours), packages: [] });
  it('says the max gap the rules hold now, and follows it when it changes', async () => {
    const user = userEvent.setup();
    fresh(24);
    render(<CoveragePackageBuilder />);
    expect(await packageNames()).toEqual(['Lean', 'Balance', 'Premium']);
    expect(notes()).toEqual([note(24), note(24), note(24)]);
    await user.clear(gap());
    await user.type(gap(), '6');
    expect(notes()).toEqual([note(6), note(6), note(6)]);
    // A 2h gap no longer holds the 3h day, so no tier is "one check-in because the day fits".
    await user.clear(gap());
    await user.type(gap(), '2');
    expect(notes()).toEqual([]);
  });
  it('drops a note stored with the package and never writes it back', async () => {
    // What the walk found: built under a 24h gap, opened with Max gap at 6 on a 15h day.
    storeQuote({
      clientName: '', startDate: '2026-12-01', endDate: '2026-12-03', overnightDurationId: '',
      rules: { ...DEFAULT_COVERAGE_RULES, pinnedTimes: [] },
      packages: [{
        id: 'b', name: 'Balance',
        visits: [{ id: 'vb', time: 720, durationId: '30Minute', label: 'Check-in' }],
        note: 'The 2h day fits inside the 24h max gap, so this tier is one check-in at 12:00 PM.',
      }],
      tiersSeeded: true,
    });
    render(<CoveragePackageBuilder />);
    expect(await packageNames()).toEqual(['Balance']);
    expect(screen.queryByText(/24h max gap/)).toBeNull();
    expect(notes()).toEqual([]);
    // The warning in the same card is the only word on the gap, and it says 6.
    expect(screen.getAllByText(/over your 6h max gap/).length).toBeGreaterThan(0);
    await waitFor(() => expect(stored().packages[0]).not.toHaveProperty('note'));
  });
  it('goes when the package no longer holds the check-in it describes, and returns with Undo', async () => {
    const user = userEvent.setup();
    fresh(6);
    render(<CoveragePackageBuilder />);
    await packageNames();
    expect(notes()).toHaveLength(3);
    await user.click(within(cards()[1]!).getByRole('button', { name: 'Remove visit' }));
    expect(within(cards()[1]!).getByText('No visits yet.')).toBeTruthy();
    expect(cards()[1]!.querySelector('.cpb__pkgNote')).toBeNull();
    expect(notes()).toEqual([note(6), note(6)]);
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(notes()).toEqual([note(6), note(6), note(6)]);
    // Moving the check-in off 12:30 PM makes the sentence untrue, so it goes.
    fireEvent.change(within(cards()[0]!).getByLabelText('Visit time'), { target: { value: '09:00' } });
    expect(cards()[0]!.querySelector('.cpb__pkgNote')).toBeNull();
    expect(notes()).toHaveLength(2);
  });
  it('a duplicate carries the note only while it holds the check-in (the walk)', async () => {
    const user = userEvent.setup();
    fresh(6);
    render(<CoveragePackageBuilder />);
    await packageNames();
    await user.click(within(cards()[1]!).getByRole('button', { name: 'Duplicate package' }));
    expect(await packageNames()).toEqual(['Lean', 'Balance', 'Premium', 'Balance copy']);
    expect(cards()[3]!.querySelector('.cpb__pkgNote')!.textContent).toBe(note(6));
    await user.click(within(cards()[3]!).getByRole('button', { name: 'Remove visit' }));
    expect(within(cards()[3]!).getByText('No visits yet.')).toBeTruthy();
    expect(cards()[3]!.querySelector('.cpb__pkgNote')).toBeNull();
    expect(notes()).toHaveLength(3);
  });
  it('shows no note on a tier that meets the rules or on a hand-built package', async () => {
    const user = userEvent.setup();
    render(<CoveragePackageBuilder />);
    await packageNames();
    await user.click(screen.getByRole('button', { name: 'New package' }));
    expect(await packageNames()).toHaveLength(4);
    expect(notes()).toEqual([]);
  });
});
