// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DEFAULT_COVERAGE_RULES, DEFAULT_DURATIONS } from '../lib/coveragePackage';

const getCoveragePackageConfig = vi.fn();
vi.mock('../api/coveragePackage', async (orig) => ({
  ...(await orig<typeof import('../api/coveragePackage')>()),
  getCoveragePackageConfig: () => getCoveragePackageConfig(),
}));

const saveCoveragePackageConfig = vi.fn();
vi.mock('../api/coveragePackageWrite', () => ({
  saveCoveragePackageConfig: (c: unknown) => saveCoveragePackageConfig(c),
}));

import { CoveragePackageBuilder } from './CoveragePackageBuilder';

/**
 * The screen's first tests, and they exist for one reason: mark 4 and mark 24 of
 * the 2026-08-17 admin walk are the same complaint, "the package builder sections
 * need to be reordered into a proper workflow".
 *
 * The order WAS: Visit menu, Coverage rules for this client, Coverage window,
 * Packages. So the screen opened on a saved config panel, then asked for this
 * client's rules, and only then asked which client and which dates — the panel
 * titled "for this client" came two panels before the field naming the client.
 */

const CONFIG = {
  durations: DEFAULT_DURATIONS,
  rules: DEFAULT_COVERAGE_RULES,
  updatedAt: '',
  updatedBy: '',
};

/**
 * DenPanel renders its title as a `span.den-panel-title`, not a heading, so
 * these read the DOM directly rather than by role. That is an accessibility gap
 * in DenScreenKit worth its own change; it is not this test's subject, and
 * asserting through a role that does not exist would just make the test lie.
 */
function panelTitles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.den-panel-title'));
}
function panelTitled(title: string): HTMLElement {
  const match = panelTitles().find((el) => el.textContent?.trim() === title);
  if (!match) throw new Error(`No panel titled "${title}". Found: ${panelTitles().map((el) => el.textContent?.trim()).join(', ')}`);
  return match;
}
beforeEach(() => {
  window.localStorage.clear();
  getCoveragePackageConfig.mockReset().mockResolvedValue(CONFIG);
  saveCoveragePackageConfig.mockReset();
});

describe('CoveragePackageBuilder panel order', () => {
  it('reads as a workflow: who and when, this client\'s rules, the packages, then the saved menu', async () => {
    render(<CoveragePackageBuilder />);
    // Every panel title on the screen, in DOM order. Headings, not text, so a
    // stray mention of "Packages" in body copy cannot satisfy this.
    await screen.findByLabelText(/client \(optional\)/i);
    const titles = panelTitles().map((el) => el.textContent?.trim());
    const workflow = titles.filter(
      (t): t is string =>
        t === 'Coverage window' ||
        t === 'Coverage rules for this client' ||
        t === 'Packages' ||
        t === 'Visit menu',
    );
    expect(workflow).toEqual([
      'Coverage window',
      'Coverage rules for this client',
      'Packages',
      'Visit menu',
    ]);
  });

  it('asks WHICH CLIENT before it offers rules "for this client"', async () => {
    render(<CoveragePackageBuilder />);
    const client = await screen.findByLabelText(/client \(optional\)/i);
    const rules = panelTitled('Coverage rules for this client');
    // Node.compareDocumentPosition: FOLLOWING means `rules` comes after `client`.
    // eslint-disable-next-line no-bitwise
    expect(client.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the saved Visit menu below the quote, since it is config and not a step', async () => {
    render(<CoveragePackageBuilder />);
    await screen.findByLabelText(/client \(optional\)/i);
    const packages = panelTitled('Packages');
    const menu = panelTitled('Visit menu');
    // eslint-disable-next-line no-bitwise
    expect(packages.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
