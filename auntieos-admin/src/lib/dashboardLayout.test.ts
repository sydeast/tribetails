import { describe, it, expect } from 'vitest';
import {
  DASH_KEYS,
  DEFAULT_DASHBOARD,
  hiddenKeys,
  hideWidget,
  moveWidgetDown,
  moveWidgetUp,
  packRows,
  parseDashKey,
  parseDashSize,
  parseDashboard,
  resolvedDashboard,
  setWidgetSize,
  showWidget,
  toTokens,
  type DashWidget,
} from './dashboardLayout';

/**
 * 17.3 Dashboard customization pure-helper tests (React). The first nine cases
 * are the android `DashboardLayoutTest.kt` suite translated one for one, so the
 * two ports are held to the same assertions; everything after `--- boundaries`
 * is what android's suite never covered (out-of-range indices, no-op edits,
 * malformed tokens, input immutability, the server token regex).
 */

const w = (key: string, size: string): DashWidget =>
  ({ key, size }) as unknown as DashWidget;

describe('dashboardLayout: android DashboardLayoutTest parity', () => {
  it('empty tokens resolve to the default layout', () => {
    expect(resolvedDashboard([])).toEqual([
      { key: 'stats', size: 'wide' },
      { key: 'todaysPack', size: 'compact' },
      { key: 'kintales', size: 'compact' },
    ]);
  });

  it('parse reads tokens, drops unknown keys, dedupes first-wins', () => {
    expect(parseDashboard(['bogus:wide', 'kintales:compact', 'kintales:wide'])).toEqual([
      { key: 'kintales', size: 'compact' },
    ]);
  });

  it('parse forces stats wide and an unknown size to compact', () => {
    expect(parseDashboard(['stats:compact'])).toEqual([{ key: 'stats', size: 'wide' }]);
    expect(parseDashboard(['kintales:huge'])).toEqual([{ key: 'kintales', size: 'compact' }]);
  });

  it('toTokens round-trips through parseDashboard', () => {
    const list: DashWidget[] = [
      { key: 'todaysPack', size: 'wide' },
      { key: 'kintales', size: 'compact' },
    ];
    expect(parseDashboard(toTokens(list))).toEqual(list);
  });

  it('hiddenKeys is every known key minus the shown ones, in declaration order', () => {
    expect(hiddenKeys([{ key: 'kintales', size: 'compact' }])).toEqual([
      'stats',
      'todaysPack',
      'cashFlow',
      'gatekeeper',
      'weatherWatchdog',
      'heatIndex',
      'weeklyCapacity',
      'overdueTracker',
      'petBreakdown',
      'frequentFlyers',
      'holidayRunway',
      'unreadMessages',
      'safebox',
      'careFlags',
      'expirations',
      'routeOptimizer',
      'expenseLog',
      'supplies',
    ]);
  });

  it('packRows gives a wide widget a solo row and pairs consecutive compacts', () => {
    const rows = packRows(DEFAULT_DASHBOARD);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(1);
    expect(rows[1]).toHaveLength(2);
  });

  it('packRows leaves a trailing lone compact on its own row', () => {
    const rows = packRows([
      { key: 'todaysPack', size: 'compact' },
      { key: 'kintales', size: 'compact' },
      { key: 'stats', size: 'wide' },
    ]);
    expect(rows[0]).toHaveLength(2);
    expect(rows[1]).toHaveLength(1);
  });

  it('move down then up restores, and both no-op at the bounds', () => {
    const moved = moveWidgetDown(DEFAULT_DASHBOARD, 0);
    expect(moved[0]?.key).toBe('todaysPack');
    expect(moveWidgetUp(moved, 1)).toEqual([...DEFAULT_DASHBOARD]);
    expect(moveWidgetUp(DEFAULT_DASHBOARD, 0)).toEqual([...DEFAULT_DASHBOARD]);
    expect(moveWidgetDown(DEFAULT_DASHBOARD, DEFAULT_DASHBOARD.length - 1)).toEqual([
      ...DEFAULT_DASHBOARD,
    ]);
  });

  it('setWidgetSize changes the target and keeps stats wide', () => {
    expect(
      setWidgetSize(DEFAULT_DASHBOARD, 'todaysPack', 'wide').find((x) => x.key === 'todaysPack')
        ?.size,
    ).toBe('wide');
    expect(
      setWidgetSize(DEFAULT_DASHBOARD, 'stats', 'compact').find((x) => x.key === 'stats')?.size,
    ).toBe('wide');
  });

  it('hide then show round-trips, appended at the end', () => {
    const hidden = hideWidget(DEFAULT_DASHBOARD, 'kintales');
    expect(hidden.some((x) => x.key === 'kintales')).toBe(false);
    const shown = showWidget(hidden, 'kintales');
    expect(shown.some((x) => x.key === 'kintales')).toBe(true);
    expect(shown[shown.length - 1]?.key).toBe('kintales');
  });
});

// --- boundaries android's suite does not cover ------------------------------

describe('dashboardLayout: token parsing edges', () => {
  it('parseDashKey trims and rejects anything not in the key set', () => {
    expect(parseDashKey('  kintales  ')).toBe('kintales');
    expect(parseDashKey('kinTales')).toBeNull();
    expect(parseDashKey('')).toBeNull();
    expect(parseDashKey(undefined)).toBeNull();
    expect(parseDashKey(null)).toBeNull();
  });

  it('parseDashSize trims, and defaults anything unreadable to compact', () => {
    expect(parseDashSize(' wide ')).toBe('wide');
    expect(parseDashSize('WIDE')).toBe('compact');
    expect(parseDashSize(undefined)).toBe('compact');
    expect(parseDashSize(null)).toBe('compact');
  });

  it('a token with no colon parses as that key at compact', () => {
    expect(parseDashboard(['kintales'])).toEqual([{ key: 'kintales', size: 'compact' }]);
  });

  it('a token with extra colons keeps the first two segments', () => {
    expect(parseDashboard(['kintales:wide:extra'])).toEqual([{ key: 'kintales', size: 'wide' }]);
  });

  it('blank and whitespace-only tokens are dropped, not rendered as ghosts', () => {
    expect(parseDashboard(['', '   ', ':', ':wide'])).toEqual([]);
  });

  it('parseDashboard on nothing readable is empty, and resolvedDashboard falls back', () => {
    expect(parseDashboard(['bogus:wide', 'alsoBogus'])).toEqual([]);
    expect(resolvedDashboard(['bogus:wide', 'alsoBogus'])).toEqual([...DEFAULT_DASHBOARD]);
  });

  it('resolvedDashboard keeps a genuine one-widget layout instead of restoring the default', () => {
    expect(resolvedDashboard(['kintales:wide'])).toEqual([{ key: 'kintales', size: 'wide' }]);
  });

  it('toTokens emits exactly the "key:size" strings the default ships with', () => {
    expect(toTokens(DEFAULT_DASHBOARD)).toEqual([
      'stats:wide',
      'todaysPack:compact',
      'kintales:compact',
    ]);
  });

  it('every key token is [a-zA-Z]+ so it satisfies the saveDashboardLayout regex', () => {
    const serverRegex = /^[a-zA-Z]+:(compact|wide)$/;
    const everyWidget: DashWidget[] = DASH_KEYS.map((key) => ({ key, size: 'compact' }));
    for (const token of toTokens(everyWidget)) {
      expect(token, `${token} must satisfy the server regex`).toMatch(serverRegex);
    }
  });
});

describe('dashboardLayout: edit-transform boundaries', () => {
  it('moveWidgetUp and moveWidgetDown no-op on out-of-range indices', () => {
    for (const idx of [-1, 3, 99]) {
      expect(moveWidgetUp(DEFAULT_DASHBOARD, idx)).toEqual([...DEFAULT_DASHBOARD]);
      expect(moveWidgetDown(DEFAULT_DASHBOARD, idx)).toEqual([...DEFAULT_DASHBOARD]);
    }
  });

  it('moving inside an empty list is a no-op rather than a throw', () => {
    expect(moveWidgetUp([], 0)).toEqual([]);
    expect(moveWidgetDown([], 0)).toEqual([]);
  });

  it('setWidgetSize on a hidden key changes nothing', () => {
    expect(setWidgetSize(DEFAULT_DASHBOARD, 'safebox', 'wide')).toEqual([...DEFAULT_DASHBOARD]);
  });

  it('hideWidget on a key that is already hidden changes nothing', () => {
    expect(hideWidget(DEFAULT_DASHBOARD, 'safebox')).toEqual([...DEFAULT_DASHBOARD]);
  });

  it('showWidget on an already-shown key does not duplicate or reorder it', () => {
    expect(showWidget(DEFAULT_DASHBOARD, 'kintales')).toEqual([...DEFAULT_DASHBOARD]);
  });

  it('showWidget defaults to compact but forces stats wide', () => {
    expect(showWidget([], 'safebox')).toEqual([{ key: 'safebox', size: 'compact' }]);
    expect(showWidget([], 'safebox', 'wide')).toEqual([{ key: 'safebox', size: 'wide' }]);
    expect(showWidget([], 'stats', 'compact')).toEqual([{ key: 'stats', size: 'wide' }]);
  });

  it('hiding everything leaves an empty list, which resolves back to the default on reload', () => {
    let list: DashWidget[] = [...DEFAULT_DASHBOARD];
    for (const key of ['stats', 'todaysPack', 'kintales'] as const) list = hideWidget(list, key);
    expect(list).toEqual([]);
    expect(resolvedDashboard(toTokens(list))).toEqual([...DEFAULT_DASHBOARD]);
  });

  it('never mutates the list it was handed', () => {
    const original: DashWidget[] = [...DEFAULT_DASHBOARD];
    const snapshot = JSON.stringify(original);
    moveWidgetUp(original, 1);
    moveWidgetDown(original, 0);
    setWidgetSize(original, 'todaysPack', 'wide');
    hideWidget(original, 'kintales');
    showWidget(original, 'safebox');
    packRows(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('dashboardLayout: row packing', () => {
  it('packs nothing into no rows', () => {
    expect(packRows([])).toEqual([]);
  });

  it('gives every wide widget its own row', () => {
    expect(
      packRows([
        { key: 'stats', size: 'wide' },
        { key: 'todaysPack', size: 'wide' },
      ]),
    ).toEqual([[{ key: 'stats', size: 'wide' }], [{ key: 'todaysPack', size: 'wide' }]]);
  });

  it('does not pair a compact with the wide that follows it', () => {
    const rows = packRows([
      { key: 'todaysPack', size: 'compact' },
      { key: 'stats', size: 'wide' },
      { key: 'kintales', size: 'compact' },
      { key: 'safebox', size: 'compact' },
    ]);
    expect(rows.map((r) => r.length)).toEqual([1, 1, 2]);
  });

  it('pairs a run of four compacts two to a row', () => {
    const rows = packRows([
      { key: 'todaysPack', size: 'compact' },
      { key: 'kintales', size: 'compact' },
      { key: 'safebox', size: 'compact' },
      { key: 'supplies', size: 'compact' },
    ]);
    expect(rows.map((r) => r.map((x) => x.key))).toEqual([
      ['todaysPack', 'kintales'],
      ['safebox', 'supplies'],
    ]);
  });

  it('keeps every widget exactly once, in order', () => {
    const shown: DashWidget[] = [
      { key: 'stats', size: 'wide' },
      { key: 'todaysPack', size: 'compact' },
      { key: 'kintales', size: 'compact' },
      { key: 'safebox', size: 'compact' },
    ];
    expect(packRows(shown).flat()).toEqual(shown);
  });
});

describe('dashboardLayout: key set', () => {
  it('DASH_KEYS carries the nineteen android tokens, in the android order', () => {
    expect([...DASH_KEYS]).toEqual([
      'stats',
      'todaysPack',
      'kintales',
      'cashFlow',
      'gatekeeper',
      'weatherWatchdog',
      'heatIndex',
      'weeklyCapacity',
      'overdueTracker',
      'petBreakdown',
      'frequentFlyers',
      'holidayRunway',
      'unreadMessages',
      'safebox',
      'careFlags',
      'expirations',
      'routeOptimizer',
      'expenseLog',
      'supplies',
    ]);
  });

  it('parses a layout saved on android byte for byte', () => {
    // A layout an operator could plausibly have saved from the android app.
    const androidTokens = ['stats:wide', 'safebox:compact', 'supplies:compact', 'cashFlow:wide'];
    expect(toTokens(parseDashboard(androidTokens))).toEqual(androidTokens);
  });

  it('an unknown key from a newer client is dropped, not rendered as a blank card', () => {
    expect(parseDashboard(['stats:wide', 'someFutureWidget:compact'])).toEqual([
      { key: 'stats', size: 'wide' },
    ]);
    // The cast is the point: a token off the wire is a plain string, and the
    // model has to survive one the type system never saw.
    expect(hiddenKeys([w('someFutureWidget', 'compact')])).toEqual([...DASH_KEYS]);
  });
});
