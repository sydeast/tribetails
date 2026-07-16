/**
 * Tests for backfillBookingEnvelopes.ts.
 *
 * Pure-planner only — no Firestore deps. Validates:
 *   - arg parsing (dry-run default, --allow-prod, --finalize, --project)
 *   - deterministic batchId (requestBatchId collapses co-batched docs; else
 *     legacy_{oldDocId})
 *   - rollup status correctness across the envelope status vocab
 *   - rollup counts + kinIds union + first/last startTime min/max
 *   - per-visit (kinCare) doc shape (preserved id, batchId set, source/session null)
 *   - idempotency: docs already carrying migratedToBatchId are skipped, and
 *     re-running the planner yields a deeply-equal plan
 */

import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  deriveBatchId,
  rollupEnvelopeStatus,
  isUnmigratedLegacyDoc,
  tsToMillis,
  planEnvelope,
  planFamily,
  type LegacyFlatDoc,
} from '../backfillBookingEnvelopes';

// Firestore Timestamp-like stub: enough for tsToMillis() to read it.
function ts(ms: number): { toMillis: () => number; _seconds: number; _nanoseconds: number } {
  return { toMillis: () => ms, _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1e6 };
}

function legacyVisit(
  oldDocId: string,
  over: Partial<Record<string, unknown>> = {},
): LegacyFlatDoc {
  return {
    oldDocId,
    data: {
      status: 'requested',
      serviceType: '60-minute drop-in',
      serviceName: '60-minute drop-in',
      serviceId: 'visit_60',
      title: '60-minute drop-in',
      startTime: ts(1_700_000_000_000),
      endTime: ts(1_700_003_600_000),
      kinIds: ['kin-1'],
      kinNames: ['Buddy'],
      requestedByUid: 'uid-1',
      createdAt: ts(1_699_000_000_000),
      updatedAt: ts(1_699_000_000_000),
      ...over,
    },
  };
}

describe('backfillBookingEnvelopes parseArgs', () => {
  it('defaults to dry-run', () => {
    const a = parseArgs([]);
    expect(a.mode).toBe('dry-run');
    expect(a.allowProd).toBe(false);
    expect(a.finalize).toBe(false);
  });

  it('--allow-prod implies an apply run', () => {
    const a = parseArgs(['--allow-prod']);
    expect(a.mode).toBe('apply');
    expect(a.allowProd).toBe(true);
  });

  it('captures --finalize and --project', () => {
    const a = parseArgs(['--allow-prod', '--finalize', '--project', 'mytribe-test']);
    expect(a.finalize).toBe(true);
    expect(a.projectId).toBe('mytribe-test');
  });

  it('throws on unknown args', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown arg/);
  });
});

describe('tsToMillis', () => {
  it('reads epoch number, Date, toMillis(), and _seconds/_nanoseconds', () => {
    expect(tsToMillis(1234)).toBe(1234);
    expect(tsToMillis(new Date(5000))).toBe(5000);
    expect(tsToMillis({ toMillis: () => 9000 })).toBe(9000);
    expect(tsToMillis({ _seconds: 2, _nanoseconds: 500_000_000 })).toBe(2500);
    expect(tsToMillis({ seconds: 3, nanoseconds: 0 })).toBe(3000);
    expect(tsToMillis(null)).toBeNull();
    expect(tsToMillis('nope')).toBeNull();
  });
});

describe('deriveBatchId', () => {
  it('uses requestBatchId when present (co-batched docs collapse)', () => {
    expect(deriveBatchId('docA', { requestBatchId: 'req_123' })).toBe('req_123');
    expect(deriveBatchId('docB', { requestBatchId: 'req_123' })).toBe('req_123');
  });

  it('falls back to legacy_{oldDocId} when no requestBatchId', () => {
    expect(deriveBatchId('docZ', {})).toBe('legacy_docZ');
  });
});

describe('isUnmigratedLegacyDoc', () => {
  it('true for an old flat doc with startTime and no envelope fields', () => {
    expect(isUnmigratedLegacyDoc({ startTime: ts(1) })).toBe(true);
  });

  it('false when already stamped with migratedToBatchId', () => {
    expect(isUnmigratedLegacyDoc({ startTime: ts(1), migratedToBatchId: 'req_1' })).toBe(false);
  });

  it('false when it is already an envelope (has envelopeStatus / visitCount)', () => {
    expect(isUnmigratedLegacyDoc({ startTime: ts(1), envelopeStatus: 'requested' })).toBe(false);
    expect(isUnmigratedLegacyDoc({ startTime: ts(1), visitCount: 2 })).toBe(false);
  });

  it('false when there is no startTime (not a visit doc)', () => {
    expect(isUnmigratedLegacyDoc({ kinIds: [] })).toBe(false);
  });
});

describe('rollupEnvelopeStatus', () => {
  it('empty -> requested', () => {
    expect(rollupEnvelopeStatus([])).toBe('requested');
  });

  it('all requested -> requested', () => {
    expect(rollupEnvelopeStatus(['requested', 'requested'])).toBe('requested');
  });

  it('mix of confirmed + requested -> partiallyConfirmed', () => {
    expect(rollupEnvelopeStatus(['confirmed', 'requested'])).toBe('partiallyConfirmed');
  });

  it('all confirmed -> confirmed', () => {
    expect(rollupEnvelopeStatus(['confirmed', 'confirmed'])).toBe('confirmed');
  });

  it('any enRoute/active -> inProgress', () => {
    expect(rollupEnvelopeStatus(['confirmed', 'active'])).toBe('inProgress');
    expect(rollupEnvelopeStatus(['enRoute', 'requested'])).toBe('inProgress');
  });

  it('all (non-cancelled) completed -> completed', () => {
    expect(rollupEnvelopeStatus(['completed', 'completed'])).toBe('completed');
  });

  it('completed visits + a cancelled one -> completed (cancelled ignored)', () => {
    expect(rollupEnvelopeStatus(['completed', 'cancelled'])).toBe('completed');
  });

  it('every visit cancelled -> cancelled', () => {
    expect(rollupEnvelopeStatus(['cancelled', 'cancelled'])).toBe('cancelled');
  });

  it('unavailable counts as not-yet-confirmed', () => {
    expect(rollupEnvelopeStatus(['unavailable', 'requested'])).toBe('requested');
    expect(rollupEnvelopeStatus(['confirmed', 'unavailable'])).toBe('partiallyConfirmed');
  });
});

describe('planEnvelope — single batch rollup', () => {
  it('collapses co-batched docs into one envelope with correct rollup', () => {
    const docs: LegacyFlatDoc[] = [
      legacyVisit('docA', {
        requestBatchId: 'req_99',
        status: 'confirmed',
        startTime: ts(2000),
        kinIds: ['kin-1'],
        kinNames: ['Buddy'],
      }),
      legacyVisit('docB', {
        requestBatchId: 'req_99',
        status: 'requested',
        startTime: ts(1000),
        kinIds: ['kin-2'],
        kinNames: ['Whiskers'],
      }),
    ];
    const plan = planEnvelope('fam-1', 'req_99', docs);

    expect(plan.parentWrite.path).toBe('families/fam-1/bookings/req_99');
    const p = plan.parentWrite.data;
    expect(p.familyId).toBe('fam-1');
    expect(p.requestBatchId).toBe('req_99');
    expect(p.envelopeStatus).toBe('partiallyConfirmed');
    expect(p.visitCount).toBe(2);
    expect(p.confirmedCount).toBe(1);
    expect(p.completedCount).toBe(0);
    expect(p.cancelledCount).toBe(0);
    // kinIds union across both docs.
    expect(new Set(p.kinIds as string[])).toEqual(new Set(['kin-1', 'kin-2']));
    expect(new Set(p.kinNames as string[])).toEqual(new Set(['Buddy', 'Whiskers']));
    // first/last startTime = min/max (docB @1000 is earliest, docA @2000 latest).
    expect(tsToMillis(p.firstStartTime)).toBe(1000);
    expect(tsToMillis(p.lastStartTime)).toBe(2000);
    expect(p.backfilledFromLegacy).toBe(true);

    // Two visit writes, ids preserved under the kinCares path.
    expect(plan.visitWrites.map((w) => w.path).sort()).toEqual([
      'families/fam-1/bookings/req_99/kinCares/docA',
      'families/fam-1/bookings/req_99/kinCares/docB',
    ]);
    const visitA = plan.visitWrites.find((w) => w.path.endsWith('/docA'));
    expect(visitA).toBeDefined();
    expect(visitA?.data.batchId).toBe('req_99');
    expect(visitA?.data.status).toBe('confirmed');
    // serviceType mirrors serviceName.
    expect(visitA?.data.serviceType).toBe(visitA?.data.serviceName);
    // AuntieOS-owned fields nulled out.
    expect(visitA?.data.sourceBookingId).toBeNull();
    expect(visitA?.data.sessionId).toBeNull();
  });

  it('completed + cancelled rolls up to completed with correct counts', () => {
    const docs: LegacyFlatDoc[] = [
      legacyVisit('d1', { requestBatchId: 'req_5', status: 'completed', startTime: ts(10) }),
      legacyVisit('d2', { requestBatchId: 'req_5', status: 'cancelled', startTime: ts(20) }),
    ];
    const plan = planEnvelope('fam-2', 'req_5', docs);
    expect(plan.parentWrite.data.envelopeStatus).toBe('completed');
    expect(plan.parentWrite.data.completedCount).toBe(1);
    expect(plan.parentWrite.data.cancelledCount).toBe(1);
    expect(plan.parentWrite.data.confirmedCount).toBe(1); // completed counts as confirmed-plus
  });
});

describe('planFamily — grouping, batchId derivation, idempotency', () => {
  it('groups by requestBatchId and falls back to legacy_ id', () => {
    const flat: LegacyFlatDoc[] = [
      legacyVisit('a', { requestBatchId: 'req_1' }),
      legacyVisit('b', { requestBatchId: 'req_1' }),
      legacyVisit('solo', {}), // no requestBatchId
    ];
    const { plans, decisions } = planFamily('fam-1', flat);

    const batchIds = plans.map((pl) => pl.batchId).sort();
    expect(batchIds).toEqual(['legacy_solo', 'req_1']);

    const req1 = plans.find((pl) => pl.batchId === 'req_1');
    expect(req1?.visitIds.sort()).toEqual(['a', 'b']);
    expect(req1?.parentWrite.data.visitCount).toBe(2);

    const solo = plans.find((pl) => pl.batchId === 'legacy_solo');
    expect(solo?.visitIds).toEqual(['solo']);

    // All three are migrate decisions.
    expect(decisions.filter((d) => d.action === 'migrate')).toHaveLength(3);
  });

  it('skips docs already carrying migratedToBatchId (idempotency)', () => {
    const flat: LegacyFlatDoc[] = [
      legacyVisit('done', { requestBatchId: 'req_1', migratedToBatchId: 'req_1' }),
      legacyVisit('fresh', { requestBatchId: 'req_1' }),
    ];
    const { plans, decisions } = planFamily('fam-1', flat);

    // Only the fresh doc gets planned.
    expect(plans).toHaveLength(1);
    expect(plans[0].visitIds).toEqual(['fresh']);

    const skip = decisions.find((d) => d.action === 'skip');
    expect(skip).toBeDefined();
    if (skip?.action !== 'skip') throw new Error('expected skip');
    expect(skip.reason).toBe('already_migrated');
    expect(skip.oldDocId).toBe('done');
  });

  it('skips docs that already have the envelope shape', () => {
    const flat: LegacyFlatDoc[] = [
      { oldDocId: 'env', data: { envelopeStatus: 'requested', visitCount: 1, startTime: ts(1) } },
    ];
    const { plans, decisions } = planFamily('fam-1', flat);
    expect(plans).toHaveLength(0);
    const skip = decisions[0];
    if (skip.action !== 'skip') throw new Error('expected skip');
    expect(skip.reason).toBe('not_legacy_shape');
  });

  it('is deterministic: re-running yields a deeply-equal plan', () => {
    const flat: LegacyFlatDoc[] = [
      legacyVisit('a', { requestBatchId: 'req_1', status: 'confirmed', startTime: ts(2000) }),
      legacyVisit('b', { requestBatchId: 'req_1', status: 'requested', startTime: ts(1000) }),
    ];
    const first = planFamily('fam-1', flat);
    const second = planFamily('fam-1', flat);
    expect(second).toEqual(first);
  });
});
