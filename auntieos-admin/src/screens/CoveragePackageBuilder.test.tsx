// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
