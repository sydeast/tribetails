import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  resolveTarget,
  describeTarget,
  paymentRowOf,
  looksLikeDirectWrite,
  findCandidates,
} from '../reportDesktopDirectPayments';

const SOURCE = readFileSync(join(__dirname, '..', 'reportDesktopDirectPayments.ts'), 'utf8');

describe('reportDesktopDirectPayments is read-only', () => {
  it('its source contains no write call of any kind', () => {
    for (const call of ['.update(', '.delete(', '.create(', 'batch(', 'runTransaction', 'bulkWriter', 'recursiveDelete', '.add(']) {
      expect(SOURCE.includes(call), call).toBe(false);
    }
    expect(/\.doc\([^)]*\)\s*\.set\(/.test(SOURCE)).toBe(false);
    expect(/\b(ref|tx|transaction|batch|writer)\.set\(/.test(SOURCE)).toBe(false);
  });

  it('refuses --allow-prod and every other write-sounding flag', () => {
    for (const flag of ['--allow-prod', '--apply', '--write']) {
      expect(() => parseArgs(['--project', 'p1', flag])).toThrow(/refused: this report only reads/);
    }
  });
});

describe('the target', () => {
  it('reads the emulator when FIRESTORE_EMULATOR_HOST is set, and says so', () => {
    const t = resolveTarget(parseArgs(['--project', 'p1']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
    expect(t).toEqual({ kind: 'emulator', host: '127.0.0.1:8080', projectId: 'p1' });
    expect(describeTarget(t)).toBe('Target: EMULATOR 127.0.0.1:8080, project p1');
  });

  it('reads production only for a project named on the command line', () => {
    expect(() => resolveTarget(parseArgs([]), { GCLOUD_PROJECT: 'ambient' })).toThrow(/--project/);
    const t = resolveTarget(parseArgs(['--project', 'p1']), {});
    expect(describeTarget(t)).toBe('Target: PRODUCTION, project p1 (read-only)');
  });
});

const direct = paymentRowOf('abc123', { invoiceId: 'inv1', kinfolkId: 'kf1', amount: 40, paymentMethod: 'cash', date: '2026-09-01' });

describe('which rows look like the old desktop write', () => {
  it('a row with an invoice, no recordedBy, no Stripe id and no audit entry', () => {
    expect(looksLikeDirectWrite(direct, new Set())).toBe(true);
  });

  it('not a row the callable wrote (recordedBy stamped)', () => {
    const row = paymentRowOf('pay_1', { invoiceId: 'inv1', recordedBy: 'uid1' });
    expect(looksLikeDirectWrite(row, new Set())).toBe(false);
  });

  it('not a row with a payment audit entry', () => {
    expect(looksLikeDirectWrite(direct, new Set(['abc123']))).toBe(false);
  });

  it('not a Stripe row', () => {
    const row = paymentRowOf('evt_1', { invoiceId: 'inv1', stripeEventId: 'evt_1' });
    expect(looksLikeDirectWrite(row, new Set())).toBe(false);
  });

  it('not a standalone payment with no invoice', () => {
    const row = paymentRowOf('x', { invoiceId: '  ' });
    expect(looksLikeDirectWrite(row, new Set())).toBe(false);
  });
});

describe('findCandidates', () => {
  it('lists only rows whose invoice is still open, and counts the rest', () => {
    const other = paymentRowOf('def456', { invoiceId: 'inv2' });
    const gone = paymentRowOf('ghi789', { invoiceId: 'inv3' });
    const r = findCandidates(
      [direct, other, gone],
      new Set(),
      new Map([
        ['inv1', 'open'],
        ['inv2', 'paid'],
      ]),
    );
    expect(r.open.map((c) => c.row.id)).toEqual(['abc123']);
    expect(r.notOpen.map((c) => [c.row.id, c.invoiceState])).toEqual([
      ['def456', 'paid'],
      ['ghi789', 'missing'],
    ]);
  });
});
