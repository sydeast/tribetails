import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeTarget,
  isLegacyShape,
  parseArgs,
  resolveTarget,
  storedStatusOf,
  tally,
  type ReportResult,
} from '../reportLegacyAmountDue';

/**
 * #902's read-only report. Same three obligations every report here carries: it
 * says which database it is about before it reads one, it cannot be pointed at
 * production by accident or at the emulator by accident, and it prints nothing
 * private.
 */
describe('reportLegacyAmountDue target resolution', () => {
  it('REFUSES --allow-prod under the emulator, naming the host', () => {
    expect(() =>
      resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' }),
    ).toThrow(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST=127\.0\.0\.1:8385/);
  });

  it('reads the emulator without --allow-prod, and refuses production without it', () => {
    expect(resolveTarget(parseArgs([]), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8385' })).toEqual({
      kind: 'emulator',
      host: '127.0.0.1:8385',
      projectId: 'demo-report-902',
    });
    expect(() => resolveTarget(parseArgs([]), {})).toThrow(/would read PRODUCTION/);
  });

  it('reading production needs a project id it will not guess', () => {
    expect(() => resolveTarget(parseArgs(['--allow-prod']), {})).toThrow(/needs --project/);
    expect(resolveTarget(parseArgs(['--allow-prod', '--project', 'p1']), {})).toEqual({
      kind: 'production',
      projectId: 'p1',
    });
    expect(resolveTarget(parseArgs(['--allow-prod']), { GCLOUD_PROJECT: 'p2' })).toEqual({
      kind: 'production',
      projectId: 'p2',
    });
  });

  it('describes the target in one line, which is the first thing printed', () => {
    expect(describeTarget({ kind: 'production', projectId: 'p1' })).toBe('Target: PRODUCTION, project p1');
    expect(describeTarget({ kind: 'emulator', host: 'h', projectId: 'p' })).toBe('Target: EMULATOR h, project p');
  });

  it('rejects an unknown flag and a non-numeric --samples', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--samples', 'lots'])).toThrow(/whole number/);
  });
});

describe('reportLegacyAmountDue is read-only, and prints nothing private', () => {
  const src = readFileSync(join(__dirname, '..', 'reportLegacyAmountDue.ts'), 'utf8');

  it('the source contains no write call at all, so there is no apply mode to get wrong', () => {
    for (const call of ['.set(', '.update(', '.delete(', '.add(', '.batch(', 'runTransaction(']) {
      expect(src.includes(call), call).toBe(false);
    }
  });

  it('prints no amount: a group of one would be one household’s bill', () => {
    // Every console.log in the file, checked for the money words. Counts, ids and
    // stored status spellings only.
    const printed = src.split('\n').filter((l) => l.includes('console.log'));
    expect(printed.length).toBeGreaterThan(0);
    for (const line of printed) {
      expect(line, line).not.toMatch(/amountDueCents\b|paidCents\b|totalCents\b|kinfolkId|kinfolkName|\buid\b/);
    }
  });
});

describe('reportLegacyAmountDue counting', () => {
  it('counts only a positive total with no stated balance', () => {
    expect(isLegacyShape({ status: 'sent', total: 40 })).toBe(true);
    expect(isLegacyShape({ status: 'sent', totalCents: 4000 })).toBe(true);
    expect(isLegacyShape({ status: 'sent', total: 40, amountDue: 0 })).toBe(false);
    expect(isLegacyShape({ status: 'sent', total: 0 })).toBe(false);
    expect(isLegacyShape({ status: 'credit', total: -40 })).toBe(false);
  });

  it('groups by the status spelling exactly as stored, and names an absent one', () => {
    expect(storedStatusOf({ status: 'Sent ' })).toBe('Sent');
    expect(storedStatusOf({ status: '  ' })).toBe('(empty)');
    expect(storedStatusOf({})).toBe('(none)');
    expect(storedStatusOf({ status: 7 })).toBe('(none)');
  });

  it('splits each group into what the rule says, and flags an overdraw without acting on it', () => {
    const r: ReportResult = { scanned: 0, legacy: 0, byStatus: {} };
    tally(r, 'a', { status: 'sent', total: 40 }, 0, false, 25);
    tally(r, 'b', { status: 'sent', total: 40 }, 4000, true, 25);
    tally(r, 'c', { status: 'sent', total: 40 }, 6000, true, 25);
    tally(r, 'd', { status: 'PAID', total: 40 }, 0, false, 25);
    expect(r.legacy).toBe(4);
    expect(r.byStatus['sent']).toEqual({
      invoices: 3,
      ruleOwed: 1,
      ruleSettled: 2,
      withPaymentRows: 2,
      overdrawn: 1,
      sampleIds: ['a', 'b', 'c'],
    });
    expect(r.byStatus['PAID']).toMatchObject({ invoices: 1, ruleOwed: 0, ruleSettled: 1, overdrawn: 0 });
  });

  it('caps the id list per group without capping the counts', () => {
    const r: ReportResult = { scanned: 0, legacy: 0, byStatus: {} };
    for (const id of ['a', 'b', 'c']) tally(r, id, { status: 'sent', total: 40 }, 0, false, 2);
    expect(r.byStatus['sent']!.sampleIds).toEqual(['a', 'b']);
    expect(r.byStatus['sent']!.invoices).toBe(3);
  });
});
