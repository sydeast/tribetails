import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  arrivalRuleRequired,
  arrivalVerificationMessage,
  completeRefusal,
  missingVisitSteps,
} from './completeRule';

/**
 * #1608: the client's copy of the server's COMPLETE gate. The cases are the
 * server's own (`mytribe/functions/test/arrivalVerification.test.ts`), so the
 * two cannot drift without one of these going red.
 */
describe('arrivalRuleRequired reads the raw settings the way the server does', () => {
  it('is on only for an explicit true', () => {
    expect(arrivalRuleRequired({ requireArrivalDepartureVerification: true })).toBe(true);
  });

  it('reads an absent key, a missing document and a non-boolean as off', () => {
    expect(arrivalRuleRequired({})).toBe(false);
    expect(arrivalRuleRequired(undefined)).toBe(false);
    expect(arrivalRuleRequired({ requireArrivalDepartureVerification: false })).toBe(false);
    expect(arrivalRuleRequired({ requireArrivalDepartureVerification: 'true' })).toBe(false);
  });
});

describe('missingVisitSteps', () => {
  it('names both steps, in the order they happen, on an unstamped visit', () => {
    expect(missingVisitSteps({ arrivedAt: '', departedAt: '' })).toEqual(['arrival', 'departure']);
    expect(missingVisitSteps({})).toEqual(['arrival', 'departure']);
  });

  it('treats a blank or whitespace stamp as missing, as the server does', () => {
    expect(missingVisitSteps({ arrivedAt: '   ', departedAt: '2026-11-05T20:30:00Z' })).toEqual(['arrival']);
  });

  it('names only the departure once the visit is arrived', () => {
    expect(missingVisitSteps({ arrivedAt: '2026-11-05T20:00:00Z', departedAt: '' })).toEqual(['departure']);
  });

  it('is empty once both are stamped', () => {
    expect(
      missingVisitSteps({ arrivedAt: '2026-11-05T20:00:00Z', departedAt: '2026-11-05T20:30:00Z' }),
    ).toEqual([]);
  });
});

describe('completeRefusal', () => {
  const unstamped = { arrivedAt: '', departedAt: '' };

  it('refuses an unstamped visit when the rule is on, naming both steps', () => {
    expect(completeRefusal(true, unstamped)).toBe(
      'This visit has no arrival and departure recorded, and your settings require both before a ' +
        'visit can be marked complete. Mark it on the visit card first, or turn off ' +
        '"Verify arrival and departure" in Settings.',
    );
  });

  it('refuses a visit with one step missing, naming that step', () => {
    expect(completeRefusal(true, { arrivedAt: '2026-11-05T20:00:00Z', departedAt: '' })).toMatch(
      /^This visit has no departure recorded, and your settings require it before/,
    );
  });

  it('lets a fully stamped visit through', () => {
    expect(
      completeRefusal(true, { arrivedAt: '2026-11-05T20:00:00Z', departedAt: '2026-11-05T20:30:00Z' }),
    ).toBeNull();
  });

  it('lets anything through when the rule is off', () => {
    expect(completeRefusal(false, unstamped)).toBeNull();
  });

  it('does not guess while the setting is unknown: the server decides', () => {
    expect(completeRefusal(null, unstamped)).toBeNull();
  });
});

/**
 * Word-for-word parity with the server's refusal. Read off the source rather
 * than imported, because `mytribe/functions` is not a workspace of this app.
 */
describe('parity with mytribe/functions/src/lib/arrivalVerification.ts', () => {
  const server = readFileSync(
    fileURLToPath(new URL('../../../mytribe/functions/src/lib/arrivalVerification.ts', import.meta.url)),
    'utf8',
  );

  it('reads the switch as on only for an explicit true', () => {
    expect(server).toContain('required: data?.requireArrivalDepartureVerification === true');
  });

  it('builds the same refusal sentence', () => {
    const client = arrivalVerificationMessage(['arrival', 'departure']);
    for (const fragment of [
      'This visit has no ${steps} recorded, and your settings require',
      'before a visit can be marked complete. Mark it on the visit card first, or turn off ',
      '\'"Verify arrival and departure" in Settings.\'',
    ]) {
      expect(server).toContain(fragment);
    }
    expect(client).toContain('before a visit can be marked complete. Mark it on the visit card first');
  });
});
