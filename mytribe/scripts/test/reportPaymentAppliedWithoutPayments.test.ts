import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseArgs,
  resolveTarget,
  describeTarget,
  findUnbacked,
  type InvoiceFacts,
} from '../reportPaymentAppliedWithoutPayments';
import type { NotificationRow } from '../reportDuplicateNotifications';

const SOURCE = readFileSync(join(__dirname, '..', 'reportPaymentAppliedWithoutPayments.ts'), 'utf8');

function row(over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    path: 'notifications/n1',
    collection: 'notifications',
    key: 'invoice.payment.applied',
    recipientUid: 'client_1',
    identity: 'invoice:inv1',
    invoiceId: 'inv1',
    atMs: 1000,
    ...over,
  };
}

const NO_ROW: InvoiceFacts = { exists: true, state: 'zero', paidCents: null, hasPaymentRow: false };
const HAS_ROW: InvoiceFacts = { exists: true, state: 'paid', paidCents: 4000, hasPaymentRow: true };

describe('reportPaymentAppliedWithoutPayments is read-only', () => {
  it('its source contains no write call of any kind', () => {
    for (const call of ['.update(', '.delete(', '.create(', 'batch(', 'runTransaction', 'bulkWriter', 'recursiveDelete', '.add(']) {
      expect(SOURCE.includes(call), call).toBe(false);
    }
    expect(/\.doc\([^)]*\)\s*\.set\(/.test(SOURCE)).toBe(false);
    expect(/\b(ref|tx|transaction|batch|writer|invoiceDoc)\.set\(/.test(SOURCE)).toBe(false);
  });
});

describe('the target', () => {
  it('reads the emulator when FIRESTORE_EMULATOR_HOST is set, and says so', () => {
    const t = resolveTarget(parseArgs(['--project', 'p1']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
    expect(t).toEqual({ kind: 'emulator', host: '127.0.0.1:8080', projectId: 'p1' });
    expect(describeTarget(t)).toBe('Target: EMULATOR 127.0.0.1:8080, project p1');
  });

  it('REFUSES --allow-prod under FIRESTORE_EMULATOR_HOST', () => {
    expect(() =>
      resolveTarget(parseArgs(['--project', 'p1', '--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }),
    ).toThrow(/refusing --allow-prod while FIRESTORE_EMULATOR_HOST/);
  });

  it('will not read production without --allow-prod', () => {
    expect(() => resolveTarget(parseArgs(['--project', 'p1']), {})).toThrow(/pass --allow-prod/);
  });

  it('needs a project id to read production', () => {
    expect(() => resolveTarget(parseArgs(['--allow-prod']), {})).toThrow(/--project/);
  });

  it('reads production with --allow-prod and a project, and says PRODUCTION', () => {
    const t = resolveTarget(parseArgs(['--project', 'tribe-prod', '--allow-prod']), {});
    expect(describeTarget(t)).toBe('Target: PRODUCTION, project tribe-prod');
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
  });
});

describe('findUnbacked', () => {
  it('reports a notice about an invoice with no payment row, and not one about an invoice with a row', () => {
    const facts = new Map([
      ['inv1', NO_ROW],
      ['inv2', HAS_ROW],
    ]);
    const out = findUnbacked([row(), row({ path: 'notifications/n2', invoiceId: 'inv2', identity: 'invoice:inv2' })], facts);
    expect(out.map((u) => u.invoiceId)).toEqual(['inv1']);
    expect(out[0]).toMatchObject({ state: 'zero', paidCents: null });
  });

  it('groups every copy about one invoice, oldest first, household and office alike', () => {
    const out = findUnbacked(
      [row({ path: 'notifications/b', recipientUid: 'staff_1', atMs: 2000 }), row({ path: 'notifications/a', atMs: 1000 })],
      new Map([['inv1', NO_ROW]]),
    );
    expect(out[0]!.notices.map((n) => n.path)).toEqual(['notifications/a', 'notifications/b']);
  });

  it('marks an invoice whose doc is gone as missing', () => {
    const out = findUnbacked([row()], new Map([['inv1', { exists: false, state: null, paidCents: null, hasPaymentRow: false }]]));
    expect(out[0]!.state).toBe('missing');
  });

  it('ignores other keys, queued rows, and rows about no invoice', () => {
    const facts = new Map([['inv1', NO_ROW]]);
    expect(
      findUnbacked(
        [row({ key: 'invoice.updated' }), row({ collection: 'scheduledNotifications' }), row({ invoiceId: '' })],
        facts,
      ),
    ).toEqual([]);
  });
});
