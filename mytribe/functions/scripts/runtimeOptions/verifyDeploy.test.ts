import { describe, expect, it } from 'vitest';

import { CLOCK_SKEW_MS, fleetLooksComplete, verifyDeployedNames } from './verifyDeploy';

const RUN_START = Date.UTC(2026, 7, 20, 18, 0, 0);
const AFTER = RUN_START + 5 * 60 * 1000;
const LONG_BEFORE = RUN_START - 26 * 60 * 60 * 1000;

function input(over: Partial<Parameters<typeof verifyDeployedNames>[0]> = {}) {
  return {
    names: ['alpha'],
    deployedNames: new Set(['alpha']),
    deployedAtMs: { alpha: AFTER },
    sinceMs: RUN_START,
    ...over,
  };
}

describe('verifyDeployedNames', () => {
  it('passes a name that exists and was deployed during the run', () => {
    const r = verifyDeployedNames(input());
    expect(r).toMatchObject({ missing: [], stale: [], unstamped: [], checked: 1 });
  });

  /** `twilioVoice`: new, inside a batch that never landed, so never created. */
  it('reports a target the fleet does not have at all as missing', () => {
    const r = verifyDeployedNames(input({
      names: ['alpha', 'twilioVoice'],
      deployedNames: new Set(['alpha']),
    }));
    expect(r.missing).toEqual(['twilioVoice']);
    expect(r.stale).toEqual([]);
  });

  /**
   * The 24 that made 2026-08-11 invisible. They existed before and they exist
   * after, so nothing breaks; they are just still running the old code while
   * the release says it deployed them.
   */
  it('reports a target whose source predates the run as stale', () => {
    const r = verifyDeployedNames(input({
      names: ['twilioInboundCall'],
      deployedNames: new Set(['twilioInboundCall']),
      deployedAtMs: { twilioInboundCall: LONG_BEFORE },
    }));
    expect(r.stale).toEqual(['twilioInboundCall']);
    expect(r.missing).toEqual([]);
  });

  it('allows the clock skew, because generation is server time and sinceMs is not', () => {
    const justInside = RUN_START - CLOCK_SKEW_MS + 1000;
    const justOutside = RUN_START - CLOCK_SKEW_MS - 1000;
    expect(verifyDeployedNames(input({ deployedAtMs: { alpha: justInside } })).stale).toEqual([]);
    expect(verifyDeployedNames(input({ deployedAtMs: { alpha: justOutside } })).stale).toEqual(['alpha']);
  });

  it('does not call a row stale when nothing reported a generation for it', () => {
    // v1 functions carry none (onAuthUserCreate), and neither does an MCP dump.
    // Existence is still checked; freshness cannot be, and inventing a verdict
    // out of a field nobody reported would refuse a good release.
    const r = verifyDeployedNames(input({
      names: ['onAuthUserCreate'],
      deployedNames: new Set(['onAuthUserCreate']),
      deployedAtMs: {},
    }));
    expect(r.unstamped).toEqual(['onAuthUserCreate']);
    expect(r.stale).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  it('ignores functions this run did not deploy', () => {
    // A narrowed release deploys a subset on purpose. Everything outside the
    // target list is the drift diff's question, not this one.
    const r = verifyDeployedNames(input({
      names: ['alpha'],
      deployedNames: new Set(['alpha', 'somethingElse']),
      deployedAtMs: { alpha: AFTER, somethingElse: LONG_BEFORE },
    }));
    expect(r.stale).toEqual([]);
    expect(r.checked).toBe(1);
  });

  it('sorts both lists so the refusal reads the same way twice', () => {
    const r = verifyDeployedNames(input({
      names: ['zeta', 'alpha', 'mid'],
      deployedNames: new Set(['mid']),
      deployedAtMs: { mid: LONG_BEFORE },
    }));
    expect(r.missing).toEqual(['alpha', 'zeta']);
    expect(r.stale).toEqual(['mid']);
  });
});

describe('fleetLooksComplete', () => {
  it('refuses to read an empty fetch as an empty fleet', () => {
    // ADR-0004's false negative: an empty success is indistinguishable from a
    // real zero, so it has to be answered as 'cannot verify'.
    expect(fleetLooksComplete(0, 250)).toBe(false);
  });

  it('refuses a fetch far smaller than the fleet should be', () => {
    expect(fleetLooksComplete(12, 250)).toBe(false);
  });

  it('accepts a plausible fetch', () => {
    expect(fleetLooksComplete(247, 254)).toBe(true);
    expect(fleetLooksComplete(125, 250)).toBe(true);
  });
});
