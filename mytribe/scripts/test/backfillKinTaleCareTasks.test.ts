import { describe, it, expect } from 'vitest';
import { buildDbMock } from '../../functions/test/_helpers/mockDb';
import {
  parseArgs,
  planCareTasks,
  buildPlan,
  applyPlan,
  tickedCount,
} from '../backfillKinTaleCareTasks';
import { buildCareTaskStamp, readCareTaskStamp, CARE_TASKS_FIELD } from '../../functions/src/lib/careTaskStamp';

/**
 * #2058 backfill: every KinTale sent before the send took its own copy of the
 * care tasks gets one, from its template as it stands now. Tales whose template
 * is gone are listed, never stamped. The real write is an operator step; this
 * file proves the plan, the write, the dry run and the second run against an
 * in-memory Firestore. No emulator run (agents do not start emulators).
 */

const NOW = '2026-11-13T09:00:00.000Z';

const TEMPLATE = {
  name: 'Dog Walk',
  checklistEnabled: true,
  checklistItems: [
    { key: 'moment_walk', text: 'Long walk in the park', scope: 'PER_PET', order: 0 },
    { key: 'moment_mail', text: 'Brought the mail in', scope: 'PER_VISIT', order: 1 },
  ],
};

const ticked = (fieldKey: string, kinId: string) => ({
  [kinId === '' ? fieldKey : `${kinId}|${fieldKey}`]: { fieldKey, kinId, boolValue: true, stringValue: '' },
});

const SENT_FROM_TEMPLATE = {
  kinfolkId: 'kf-1',
  status: 'SENT',
  sentAt: '2026-10-01T10:00:00.000Z',
  templateId: 'tpl-walk',
  fieldResponses: { ...ticked('moment_walk', 'kin-a'), ...ticked('moment_mail', '') },
};
const SENT_BUILT_IN = {
  kinfolkId: 'kf-1',
  status: 'SENT',
  sentAt: '2026-10-02T10:00:00.000Z',
  templateId: '',
  fieldResponses: ticked('fed', 'kin-a'),
};
const SENT_TEMPLATE_GONE = {
  kinfolkId: 'kf-2',
  status: 'SENT',
  sentAt: '2026-10-03T10:00:00.000Z',
  templateId: 'tpl-deleted',
  fieldResponses: { ...ticked('moment_x', 'kin-b'), ...ticked('moment_y', 'kin-b') },
};
const DRAFT = { kinfolkId: 'kf-1', status: 'DRAFT', sentAt: '', templateId: 'tpl-walk', fieldResponses: {} };
// A migrated row carries a send date but no status.
const MIGRATED_SENT = { kinfolkId: 'kf-3', sentAt: 'September 3, 2025 2:02pm', templateId: '', fieldResponses: {} };

function world() {
  const reports: Record<string, Record<string, unknown>> = {
    r_tpl: { ...SENT_FROM_TEMPLATE },
    r_builtin: { ...SENT_BUILT_IN },
    r_gone: { ...SENT_TEMPLATE_GONE },
    r_draft: { ...DRAFT },
    r_migrated: { ...MIGRATED_SENT },
  };
  const docs: Record<string, Record<string, unknown> | null> = {
    'kintale_templates/tpl-walk': { ...TEMPLATE },
  };
  for (const [id, d] of Object.entries(reports)) docs[`kin_care_reports/${id}`] = d;
  const ctx = buildDbMock({ docs, writeThrough: true });
  return { ctx, docs };
}

describe('parseArgs', () => {
  it('defaults to a dry run', () => {
    expect(parseArgs([])).toEqual({ mode: 'dry-run', allowProd: false, projectId: null });
  });
  it('--allow-prod applies', () => {
    expect(parseArgs(['--allow-prod']).mode).toBe('apply');
  });
  it('--dry-run beats --allow-prod in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).mode).toBe('dry-run');
    expect(parseArgs(['--dry-run', '--allow-prod']).mode).toBe('dry-run');
  });
  it('refuses an unknown flag and a valueless --project', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--project', '--dry-run'])).toThrow(/requires a value/);
  });
});

describe('planCareTasks', () => {
  it('leaves a draft alone', () => {
    expect(planCareTasks(DRAFT, TEMPLATE, NOW)).toEqual({ kind: 'skip', reason: 'draft' });
  });
  it('leaves a tale that already has a copy alone', () => {
    const stamp = buildCareTaskStamp({ templateId: 'tpl-walk', template: TEMPLATE, fieldResponses: {}, now: NOW, by: 'send' });
    expect(planCareTasks({ ...SENT_FROM_TEMPLATE, careTasks: stamp }, TEMPLATE, NOW)).toEqual({
      kind: 'skip',
      reason: 'already-stamped',
    });
  });
  it('stamps from the template as it stands now', () => {
    const plan = planCareTasks(SENT_FROM_TEMPLATE, TEMPLATE, NOW);
    expect(plan.kind).toBe('stamp');
    if (plan.kind !== 'stamp') return;
    expect(plan.stamp.stampedBy).toBe('backfill');
    expect(plan.stamp.source).toBe('template');
    expect(plan.stamp.done.map((d) => d.text)).toEqual(['Long walk in the park', 'Brought the mail in']);
  });
  it('a blank templateId is the built-in, not a missing template', () => {
    const plan = planCareTasks(SENT_BUILT_IN, null, NOW);
    expect(plan.kind).toBe('stamp');
    if (plan.kind === 'stamp') expect(plan.stamp.source).toBe('builtIn');
  });
  it('refuses a tale whose template is gone', () => {
    expect(planCareTasks(SENT_TEMPLATE_GONE, null, NOW)).toEqual({
      kind: 'refuse',
      reason: 'template-gone',
      templateId: 'tpl-deleted',
    });
  });
  it('stamps a tale with nothing ticked too, so a second run plans nothing', () => {
    const plan = planCareTasks({ ...SENT_FROM_TEMPLATE, fieldResponses: {} }, TEMPLATE, NOW);
    expect(plan.kind).toBe('stamp');
    if (plan.kind === 'stamp') expect(plan.stamp.done).toEqual([]);
  });
});

describe('buildPlan and applyPlan', () => {
  it('the dry run writes nothing and lists the unrecoverable tales', async () => {
    const { ctx } = world();
    const { summary, writes } = await buildPlan(ctx.db, NOW);
    expect(ctx.writes).toEqual([]);
    expect(summary.scanned).toBe(5);
    expect(summary.drafts).toBe(1);
    expect(summary.toStamp).toBe(3);
    expect(summary.fromTemplate).toBe(1);
    expect(summary.fromBuiltIn).toBe(2);
    expect(writes.map((w) => w.reportId).sort()).toEqual(['r_builtin', 'r_migrated', 'r_tpl']);
    expect(summary.unrecoverable).toEqual([
      { reportId: 'r_gone', kinfolkId: 'kf-2', templateId: 'tpl-deleted', sentAt: '2026-10-03T10:00:00.000Z', ticked: 2 },
    ]);
  });

  it('the write stamps exactly the planned tales and touches only careTasks', async () => {
    const { ctx, docs } = world();
    const { writes } = await buildPlan(ctx.db, NOW);
    const outcome = await applyPlan(ctx.db, writes);
    expect(outcome).toEqual({ stamped: 3, skippedOnRecheck: 0 });
    for (const w of ctx.writes) expect(Object.keys(w.data)).toEqual([CARE_TASKS_FIELD]);
    expect(readCareTaskStamp(docs['kin_care_reports/r_tpl']![CARE_TASKS_FIELD])!.done).toHaveLength(2);
    expect(docs['kin_care_reports/r_gone']![CARE_TASKS_FIELD]).toBeUndefined();
    expect(docs['kin_care_reports/r_draft']![CARE_TASKS_FIELD]).toBeUndefined();
  });

  it('is idempotent: a second run plans and writes nothing', async () => {
    const { ctx } = world();
    await applyPlan(ctx.db, (await buildPlan(ctx.db, NOW)).writes);
    const writesAfterFirst = ctx.writes.length;
    const second = await buildPlan(ctx.db, NOW);
    expect(second.writes).toEqual([]);
    expect(second.summary.alreadyStamped).toBe(3);
    expect(second.summary.unrecoverable).toHaveLength(1);
    await applyPlan(ctx.db, second.writes);
    expect(ctx.writes.length).toBe(writesAfterFirst);
  });

  it('re-checks each tale at write time: one stamped meanwhile is left as it is', async () => {
    const { ctx, docs } = world();
    const { writes } = await buildPlan(ctx.db, NOW);
    const sendStamp = buildCareTaskStamp({
      templateId: 'tpl-walk',
      template: TEMPLATE,
      fieldResponses: SENT_FROM_TEMPLATE.fieldResponses,
      now: NOW,
      by: 'send',
    });
    docs['kin_care_reports/r_tpl'] = { ...docs['kin_care_reports/r_tpl']!, careTasks: sendStamp };
    const outcome = await applyPlan(ctx.db, writes);
    expect(outcome).toEqual({ stamped: 2, skippedOnRecheck: 1 });
    expect(readCareTaskStamp(docs['kin_care_reports/r_tpl']![CARE_TASKS_FIELD])!.stampedBy).toBe('send');
  });
});

describe('tickedCount', () => {
  it('counts only real ticks', () => {
    expect(tickedCount({ fieldResponses: { a: { boolValue: true }, b: { boolValue: false }, c: 'x' } })).toBe(1);
    expect(tickedCount({})).toBe(0);
  });
});
