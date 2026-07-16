import { describe, expect, it } from 'vitest';
import {
  NAV,
  parseHash,
  railEntries,
  railGroup,
  routeToHash,
  routeWarning,
  type Destination,
  type NavGroup,
} from './nav';

/**
 * Ported from the wasm app's NavConfigTest.kt, plus the cases the port itself
 * put at risk.
 */

describe('rail composition', () => {
  it('keeps contextual destinations out of the rail', () => {
    // Media / Account / My notifications are reachable by URL and opened from
    // the account chip, but pinning them would clutter a curated rail.
    const slugs = railEntries().map((e) => e.slug);
    expect(slugs).not.toContain('media');
    expect(slugs).not.toContain('account');
    expect(slugs).not.toContain('my-notifications');
  });

  it('still resolves contextual destinations by URL, so nothing is unreachable', () => {
    expect(parseHash('#/account').dest).toBe('accountSettings');
    expect(parseHash('#/my-notifications').dest).toBe('myNotifications');
  });

  it('renders the three groups in Den, Care Ops, More order', () => {
    const groups = railEntries().map((e) => e.group);
    const firstOf = (g: NavGroup) => groups.indexOf(g);
    expect(firstOf('den')).toBeLessThan(firstOf('careOps'));
    expect(firstOf('careOps')).toBeLessThan(firstOf('more'));
  });

  it('groups are contiguous, so the rail never interleaves them', () => {
    const groups = railEntries().map((e) => e.group);
    const seen: NavGroup[] = [];
    for (const g of groups) if (seen[seen.length - 1] !== g) seen.push(g);
    // Each group should start exactly once. Two runs of 'den' means a stray entry.
    expect(seen).toEqual(['den', 'careOps', 'more']);
  });

  it('puts Auntie Time in Care Ops under that name, not "Sessions"', () => {
    // The rail label and the route slug deliberately differ. Conflating them is
    // how a nav entry ends up pointing at a slug that does not exist.
    const e = railGroup('careOps').find((x) => x.dest === 'sessions');
    expect(e?.title).toBe('Auntie Time');
    expect(e?.slug).toBe('sessions');
  });

  it('every destination has a unique slug', () => {
    const slugs = NAV.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('parseHash', () => {
  it('empty or bare hash is Home', () => {
    expect(parseHash('')).toEqual({ dest: 'home' });
    expect(parseHash('#/')).toEqual({ dest: 'home' });
    expect(parseHash('#')).toEqual({ dest: 'home' });
  });

  it('resolves a known slug', () => {
    expect(parseHash('#/settings')).toEqual({ dest: 'settings' });
    expect(parseHash('#/tribal-intel')).toEqual({ dest: 'trainingDocs' });
  });

  it('carries a detail id', () => {
    expect(parseHash('#/directory/abc123')).toEqual({ dest: 'directory', detailId: 'abc123' });
  });

  it('falls back to Home for an unknown slug', () => {
    expect(parseHash('#/bogus')).toEqual({ dest: 'home' });
  });

  it('keeps the retired training-docs slug resolvable after the rename', () => {
    expect(parseHash('#/training-docs').dest).toBe('trainingDocs');
  });

  it('resolves both legacy template slugs to the merged screen', () => {
    expect(parseHash('#/template-bank').dest).toBe('templates');
    expect(parseHash('#/template-assignment').dest).toBe('templates');
  });
});

describe('routeWarning: a dead link must not vanish quietly', () => {
  it('is null for a valid or empty hash', () => {
    expect(routeWarning('')).toBeNull();
    expect(routeWarning('#/')).toBeNull();
    expect(routeWarning('#/settings')).toBeNull();
    expect(routeWarning('#/directory/abc123')).toBeNull();
  });

  it('names the slug that did not resolve', () => {
    expect(routeWarning('#/bogus')).toBe('The page "bogus" isn\'t available. Showing Home instead.');
  });

  it('warns for a plausible-but-wrong slug, which is the real case', () => {
    // Lived experience: "auntie-time" is the RAIL LABEL, the slug is "sessions".
    // Without the warning this silently lands on Home and looks like the nav
    // item is broken. It cost real debugging time on 2026-07-15.
    expect(routeWarning('#/auntie-time')).toContain('auntie-time');
  });

  it('does not warn for slugs that only resolve via back-compat', () => {
    expect(routeWarning('#/training-docs')).toBeNull();
    expect(routeWarning('#/template-bank')).toBeNull();
  });
});

describe('routeToHash round-trips', () => {
  it('every non-contextual destination survives a round trip', () => {
    for (const e of railEntries()) {
      expect(parseHash(routeToHash({ dest: e.dest })).dest, `round trip failed for ${e.dest}`).toBe(
        e.dest,
      );
    }
  });

  it('round-trips a detail id', () => {
    const r = { dest: 'directory' as Destination, detailId: 'abc123' };
    expect(parseHash(routeToHash(r))).toEqual(r);
  });
});
