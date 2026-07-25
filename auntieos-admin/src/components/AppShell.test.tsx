import { describe, expect, it, vi } from 'vitest';

// AppShell pulls in lib/auth for the sign-out control, which initializes the
// real Firebase app at import time. Nothing here exercises auth, so it is
// stubbed rather than booting an SDK for a nav-contract assertion.
vi.mock('../lib/auth', () => ({ signOut: vi.fn() }));

import { railPendingSlugs } from './AppShell';
import { railEntries } from '../lib/nav';

/**
 * OPERATOR ISSUE #8, the regression guard.
 *
 * `KinTaleTemplates.tsx` (756 lines) shipped and `router.tsx` registered
 * `/kintale-templates`, but the slug was never added to AppShell's `LIVE_LINKS`
 * map. The rail therefore rendered the entry as a disabled span reading
 * "KinTale templates (coming soon)", which is what the operator saw and
 * reported. The screen was fine; the rail lied about it.
 *
 * The "(coming soon)" fallback still has a legitimate job (a rail entry added
 * before its route exists), so the fix is not to delete it. It is to assert
 * that no SHIPPED entry falls through to it, which is a stronger contract than
 * checking one slug: the day someone adds a nav entry and forgets the link, the
 * suite says so instead of the operator.
 */
describe('AppShell rail: every pinned entry is a live link', () => {
  it('renders KinTale templates as a real link, not "(coming soon)"', () => {
    expect(railPendingSlugs()).not.toContain('kintale-templates');
  });

  it('leaves no rail entry at all falling through to the disabled fallback', () => {
    expect(railPendingSlugs()).toEqual([]);
  });

  it('covers every non-contextual nav slug, so the assertion above is not vacuous', () => {
    // Guards against the inverse failure: railPendingSlugs() returning [] because
    // railEntries() went empty rather than because every entry is wired.
    expect(railEntries().length).toBeGreaterThan(10);
  });
});
