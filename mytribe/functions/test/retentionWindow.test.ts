import { describe, it, expect } from 'vitest';
import {
  DAY_MS,
  MAX_RETENTION_DAYS,
  readRetentionWindow,
  resolveRetentionWindow,
} from '../src/lib/retentionWindow';

/**
 * ISSUE #519: the guard in front of two jobs that delete records permanently.
 *
 * Nearly every case here is a refusal, which is the point. The window is the
 * only thing standing between "purge routes older than 90 days" and "purge every
 * route", so the interesting behaviour is what happens when the number is not a
 * number.
 */

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

describe('resolveRetentionWindow', () => {
  it('uses a configured window and computes the cutoff from it', () => {
    const w = resolveRetentionWindow(30, 90, NOW);
    expect(w).toEqual({ ok: true, days: 30, cutoffMs: NOW - 30 * DAY_MS, source: 'configured' });
  });

  it('falls back to the shipped default when the key is absent, NOT to zero', () => {
    const w = resolveRetentionWindow(undefined, 90, NOW);
    expect(w).toEqual({ ok: true, days: 90, cutoffMs: NOW - 90 * DAY_MS, source: 'default' });
  });

  it('treats an explicit null the same as absent', () => {
    expect(resolveRetentionWindow(null, 30, NOW)).toMatchObject({ ok: true, days: 30, source: 'default' });
  });

  it('REFUSES a zero window rather than reading it as "delete everything"', () => {
    expect(resolveRetentionWindow(0, 90, NOW)).toEqual({
      ok: false,
      reason: 'retention 0 is not a positive number of days',
    });
  });

  it('REFUSES a negative window, which would put the cutoff in the future', () => {
    expect(resolveRetentionWindow(-7, 90, NOW)).toMatchObject({ ok: false });
  });

  it('refuses a fractional window', () => {
    expect(resolveRetentionWindow(30.5, 90, NOW)).toEqual({
      ok: false,
      reason: 'retention 30.5 is not a whole number of days',
    });
  });

  it('refuses a non-number, naming what it found', () => {
    expect(resolveRetentionWindow('30', 90, NOW)).toEqual({
      ok: false,
      reason: 'retention is "30", not a number',
    });
    expect(resolveRetentionWindow(Number.NaN, 90, NOW)).toMatchObject({ ok: false });
  });

  it('refuses a window past the ceiling, because that is a typo not a policy', () => {
    expect(resolveRetentionWindow(MAX_RETENTION_DAYS + 1, 90, NOW)).toMatchObject({ ok: false });
    expect(resolveRetentionWindow(MAX_RETENTION_DAYS, 90, NOW)).toMatchObject({ ok: true });
  });

  it('accepts the smallest legal window', () => {
    expect(resolveRetentionWindow(1, 90, NOW)).toMatchObject({ ok: true, days: 1 });
  });
});

describe('readRetentionWindow', () => {
  function fs(data: Record<string, unknown> | undefined) {
    return { doc: () => ({ get: async () => ({ data: () => data }) }) } as never;
  }

  it('reads the configured value off the settings document', async () => {
    const w = await readRetentionWindow(fs({ saveRoutesForDays: 14 }), 'saveRoutesForDays', 90, NOW);
    expect(w).toMatchObject({ ok: true, days: 14, source: 'configured' });
  });

  it('reads a document with no such key as the shipped default', async () => {
    const w = await readRetentionWindow(fs({}), 'draftRetentionDays', 30, NOW);
    expect(w).toMatchObject({ ok: true, days: 30, source: 'default' });
  });

  it('reads a missing document as the shipped default', async () => {
    const w = await readRetentionWindow(fs(undefined), 'draftRetentionDays', 30, NOW);
    expect(w).toMatchObject({ ok: true, days: 30, source: 'default' });
  });

  /**
   * The opposite of `lib/autoReminder.ts`'s choice, deliberately: failing open
   * there sends a message that was going out anyway; failing open here deletes
   * an archive because Firestore blinked.
   */
  it('REFUSES on a read failure rather than assuming a window', async () => {
    const broken = { doc: () => ({ get: async () => { throw new Error('offline'); } }) } as never;
    const w = await readRetentionWindow(broken, 'saveRoutesForDays', 90, NOW);
    expect(w).toMatchObject({ ok: false });
    expect((w as { reason: string }).reason).toContain('offline');
  });
});
