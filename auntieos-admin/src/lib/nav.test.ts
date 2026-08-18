import { describe, expect, it } from 'vitest';
import {
  NAV,
  parseHash,
  railEntries,
  railGroup,
  routeToHash,
  routeWarning,
  screenTitle,
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

  it('places the Coverage Package Builder in Care Ops, just before Schedule', () => {
    const careOps = railGroup('careOps');
    const packages = careOps.findIndex((e) => e.dest === 'coveragePackages');
    const schedule = careOps.findIndex((e) => e.dest === 'schedule');
    expect(packages).toBeGreaterThanOrEqual(0);
    expect(schedule).toBeGreaterThanOrEqual(0);
    expect(packages).toBe(schedule - 1);
    expect(careOps[packages]?.title).toBe('Packages');
    expect(careOps[packages]?.slug).toBe('packages');
  });

  /**
   * The admin-wide invites screen is PINNED, unlike the household-scoped
   * "Members and invites" beside it. That one is contextual because a rail
   * entry would have no household to open; this one is the every-household
   * view, so it has somewhere to go from a cold start. It sits in The Den next
   * to Directory, the screen whose households it is about, rather than becoming
   * another URL-only screen nobody finds.
   */
  it('pins the admin-wide invites screen in The Den, beside Directory', () => {
    const den = railGroup('den');
    const directory = den.findIndex((e) => e.dest === 'directory');
    const invites = den.findIndex((e) => e.dest === 'invites');
    expect(directory).toBeGreaterThanOrEqual(0);
    expect(invites).toBe(directory + 1);
    expect(den[invites]?.title).toBe('Invites');
    expect(den[invites]?.slug).toBe('invites');
  });

  it('keeps the household-scoped members screen contextual, and the global one not', () => {
    expect(NAV.find((e) => e.dest === 'householdMembers')?.contextual).toBe(true);
    expect(NAV.find((e) => e.dest === 'invites')?.contextual).toBeUndefined();
  });
  /**
   * #396. The notification gate is the one screen that lists every notification
   * the platform can send, who it reaches and what fires it, and it was marked
   * `contextual`, so it appeared nowhere in the rail and was reachable only by
   * opening Settings and already knowing to look for it. The operator's report
   * was "I am blind to what could be sent out to users". This flag is a large
   * part of why. It stays pinned.
   */
  it('pins the notification gate in the rail', () => {
    expect(NAV.find((e) => e.dest === 'notificationGate')?.contextual).toBeUndefined();
    const slugs = railEntries().map((e) => e.slug);
    expect(slugs).toContain('notification-gate');
  });
  it('files the notification gate under More, beside the other what-we-emit screens', () => {
    const more = railGroup('more');
    const gate = more.findIndex((e) => e.dest === 'notificationGate');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(more[gate]?.title).toBe('Notification gate');
    // Templates is the other half of the same question (what the body says),
    // so the two must not end up at opposite ends of the group.
    const templates = more.findIndex((e) => e.dest === 'templates');
    expect(templates).toBeGreaterThanOrEqual(0);
    expect(Math.abs(gate - templates)).toBeLessThanOrEqual(4);
  });
  it('still resolves the gate by its old URL, so existing links keep working', () => {
    expect(parseHash('#/notification-gate').dest).toBe('notificationGate');
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

/**
 * `screenTitle` is what the route-level loading state says out loud while a
 * screen's chunk is in flight, so it is read by an operator and by a screen
 * reader on every slow navigation.
 */
describe('screenTitle', () => {
  it('names the screen a TanStack pathname lands on', () => {
    expect(screenTitle('/bookings')).toBe('Bookings');
    expect(screenTitle('/kintales')).toBe('KinTales');
  });

  it('uses the rail label, not the slug', () => {
    // The rail says "Auntie Time"; the slug and the code say sessions. The
    // operator clicked the words on the rail, so those are the words to echo.
    expect(screenTitle('/sessions')).toBe('Auntie Time');
    expect(screenTitle('/tribal-intel')).toBe('Tribal Intel');
  });

  it('reads the first segment only, so a detail route keeps its screen name', () => {
    expect(screenTitle('/directory/abc123')).toBe('Directory');
    expect(screenTitle('/media/kin/abc123')).toBe('Media');
  });

  it('accepts a hash as well as a pathname', () => {
    expect(screenTitle('#/invoices')).toBe('Invoices');
  });

  it('is null rather than a guess for an unknown or empty location', () => {
    expect(screenTitle('/bogus')).toBeNull();
    expect(screenTitle('/')).toBeNull();
    expect(screenTitle('')).toBeNull();
  });

  it('names every rail entry, so no pinned screen loads under a generic label', () => {
    for (const e of railEntries()) {
      expect(screenTitle(`/${e.slug}`), `no title for ${e.slug}`).toBe(e.title);
    }
  });
});
