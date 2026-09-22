import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  countFlags,
  factsOf,
  findFlagged,
  flagsFor,
  MISSING,
  millisOf,
  parseArgs,
  resolveTarget,
  describeTarget,
} from '../reportOverdueNoticesForNonBills';
import { rowOf } from '../reportDuplicateNotifications';

const T = Date.UTC(2026, 8, 1, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

describe('#871 report: arguments and target', () => {
  it('parses flags and refuses a flag as a value', () => {
    expect(parseArgs([])).toEqual({ projectId: null, allowProd: false, samples: 50 });
    expect(parseArgs(['--project', 'p', '--allow-prod', '--samples', '5'])).toEqual({ projectId: 'p', allowProd: true, samples: 5 });
    expect(() => parseArgs(['--project', '--allow-prod'])).toThrow('--project requires a value');
    expect(() => parseArgs(['--samples', 'x'])).toThrow('whole number');
    expect(() => parseArgs(['--apply'])).toThrow('unknown arg');
  });

  it('reads the emulator when FIRESTORE_EMULATOR_HOST is set, and refuses --allow-prod there', () => {
    const t = resolveTarget(parseArgs([]), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
    expect(t).toEqual({ kind: 'emulator', host: '127.0.0.1:8080', projectId: 'demo-report-871' });
    expect(describeTarget(t)).toBe('Target: EMULATOR 127.0.0.1:8080, project demo-report-871');
    expect(() => resolveTarget(parseArgs(['--allow-prod']), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toThrow(
      'refusing --allow-prod',
    );
  });

  it('never reads production without --allow-prod and a project', () => {
    expect(() => resolveTarget(parseArgs([]), {})).toThrow('pass --allow-prod');
    expect(() => resolveTarget(parseArgs(['--allow-prod']), {})).toThrow('--project');
    expect(resolveTarget(parseArgs(['--allow-prod', '--project', 'p']), {})).toEqual({ kind: 'production', projectId: 'p' });
  });
});

describe('#871 report: flags judged at the notice time', () => {
  const open = factsOf({ status: 'open', amountDue: 40, total: 40 }, []);

  it('a live bill with no history is not flagged', () => {
    expect(flagsFor(T, open)).toEqual([]);
  });

  it('paid before the notice is flagged; paid after it is not', () => {
    const paidEarly = factsOf({ status: 'paid', amountDue: 0, total: 40, paidAt: { toMillis: () => T - HOUR } }, []);
    const paidLate = factsOf({ status: 'paid', amountDue: 0, total: 40, paidAt: { toMillis: () => T + HOUR } }, []);
    expect(flagsFor(T, paidEarly)).toEqual(['paid_at_send']);
    expect(flagsFor(T, paidLate)).toEqual([]);
  });

  it('payment rows created before the notice and covering the total count as paid; a part payment does not', () => {
    const covered = factsOf({ status: 'paid', total: 40 }, [{ amountCents: 4000, createdAt: { toMillis: () => T - HOUR } }]);
    const part = factsOf({ status: 'open', amountDue: 25, total: 40 }, [{ amountCents: 1500, createdAt: { toMillis: () => T - HOUR } }]);
    const later = factsOf({ status: 'paid', total: 40 }, [{ amountCents: 4000, createdAt: { toMillis: () => T + HOUR } }]);
    expect(flagsFor(T, covered)).toContain('paid_at_send');
    expect(flagsFor(T, part)).toEqual([]);
    expect(flagsFor(T, later)).not.toContain('paid_at_send');
  });

  it('an unanswered or declined quote is flagged; a quote accepted before the notice is not; accepted after it is', () => {
    expect(flagsFor(T, factsOf({ status: 'quote', amountDue: 40, total: 40 }, []))).toEqual(['unaccepted_quote']);
    expect(flagsFor(T, factsOf({ status: 'quote', quoteDecision: 'denied', amountDue: 40, total: 40 }, []))).toEqual([
      'unaccepted_quote',
    ]);
    const acceptedBefore = { status: 'open', quoteDecision: 'accepted', quoteDecidedAt: { toMillis: () => T - HOUR }, amountDue: 40, total: 40 };
    const acceptedAfter = { ...acceptedBefore, quoteDecidedAt: { toMillis: () => T + HOUR } };
    expect(flagsFor(T, factsOf(acceptedBefore, []))).toEqual([]);
    expect(flagsFor(T, factsOf(acceptedAfter, []))).toEqual(['unaccepted_quote']);
    expect(flagsFor(T, factsOf({ status: 'open', invoiceStatus: 'quote', amountDue: 40, total: 40 }, []))).toEqual([
      'unaccepted_quote',
    ]);
  });

  it('cancelled now, archived before the notice, other non-open states and a deleted invoice are flagged', () => {
    expect(flagsFor(T, factsOf({ status: 'cancelled', amountDue: 40, total: 40 }, []))).toEqual(['cancelled']);
    expect(flagsFor(T, factsOf({ status: 'open', amountDue: 40, total: 40, archivedAt: { toMillis: () => T - HOUR } }, []))).toEqual([
      'archived_at_send',
    ]);
    expect(flagsFor(T, factsOf({ status: 'open', amountDue: 40, total: 40, archivedAt: null }, []))).toEqual([]);
    for (const status of ['draft', 'credit', 'zero']) {
      expect(flagsFor(T, factsOf({ status, amountDue: status === 'zero' ? 0 : 40, total: status === 'zero' ? 0 : 40 }, []))).toContain(
        'other_not_open_now',
      );
    }
    expect(flagsFor(T, MISSING)).toEqual(['missing']);
  });

  it('millisOf reads numbers, ISO strings and Timestamps, and nothing else', () => {
    expect(millisOf(5)).toBe(5);
    expect(millisOf('2026-09-01T12:00:00.000Z')).toBe(T);
    expect(millisOf({ toMillis: () => T })).toBe(T);
    expect(millisOf('Net 14')).toBeNull();
    expect(millisOf(null)).toBeNull();
  });
});

describe('#871 report: grouping', () => {
  it('flags only chase keys about an invoice, and counts per key and flag', () => {
    const at = { toMillis: () => T };
    const rows = [
      rowOf('notifications/a', 'notifications', { key: 'invoice.overdue', targetType: 'invoice', targetId: 'inv_c', recipientUid: 'u', createdAt: at }),
      rowOf('scheduledNotifications/b', 'scheduledNotifications', { key: 'invoice.reminder', data: { invoiceId: 'inv_c' }, recipientUid: 'u', fireAtMs: T }),
      rowOf('notifications/c', 'notifications', { key: 'invoice.overdue', targetType: 'invoice', targetId: 'inv_ok', recipientUid: 'u', createdAt: at }),
      rowOf('notifications/d', 'notifications', { key: 'invoice.updated', targetType: 'invoice', targetId: 'inv_c', recipientUid: 'u', createdAt: at }),
      rowOf('notifications/e', 'notifications', { key: 'invoice.overdue', targetType: 'invoice', targetId: 'inv_gone', recipientUid: 'u', createdAt: at }),
    ];
    const facts = new Map([
      ['inv_c', factsOf({ status: 'cancelled', amountDue: 40, total: 40 }, [])],
      ['inv_ok', factsOf({ status: 'open', amountDue: 40, total: 40 }, [])],
    ]);
    const flagged = findFlagged(rows, facts);
    expect(flagged.map((f) => [f.invoiceId, f.key, f.path, f.state, f.flags])).toEqual([
      ['inv_c', 'invoice.overdue', 'notifications/a', 'cancelled', ['cancelled']],
      ['inv_c', 'invoice.reminder', 'scheduledNotifications/b', 'cancelled', ['cancelled']],
      ['inv_gone', 'invoice.overdue', 'notifications/e', 'missing', ['missing']],
    ]);
    expect(countFlags(flagged)).toEqual({
      'invoice.overdue cancelled': 1,
      'invoice.reminder cancelled': 1,
      'invoice.overdue missing': 1,
    });
  });
});

describe('#871 report: read-only and private by construction', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'reportOverdueNoticesForNonBills.ts'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('contains no write call', () => {
    // `Map#set` is allowed (in-memory grouping); a Firestore ref, doc or collection write is not.
    expect(code).not.toMatch(/\b(ref|doc\([^)]*\)|collection\([^)]*\))\s*\.\s*(set|update|delete|create|add)\s*\(/);
    expect(code).not.toMatch(/\.(update|delete|create)\s*\(/);
    expect(code).not.toMatch(/\b(batch|runTransaction|bulkWriter|recursiveDelete)\s*\(/);
    // The only `.set(` calls are on the three in-memory maps.
    const sets = code.match(/(\w+)\.set\(/g) ?? [];
    for (const s of sets) expect(['facts.set(', 'byId.set(', 'byState.set(']).toContain(s);
  });

  it('takes firebase-admin only from lib/firebaseAdmin', () => {
    expect(code).not.toMatch(/from\s+['"](firebase-admin|@google-cloud\/firestore)/);
    expect(code).toMatch(/from '\.\/lib\/firebaseAdmin'/);
  });

  it('prints no uid, name or message field', () => {
    const printed = code.split('\n').filter((l) => l.includes('console.log'));
    for (const line of printed) expect(line).not.toMatch(/recipientUid|kinfolkName|title|\.data\b|amount/);
  });
});
