import { describe, it, expect, vi } from 'vitest';
import {
  ATTRIBUTION,
  applyPlan,
  buildPlanFromRows,
  parseArgs,
  reportLines,
  resolveTarget,
} from '../backfillInvoiceSessionBacklinks';
import { FieldValue } from '../lib/firebaseAdmin';

const line = (sessionId?: string) => ({ description: 'Walk', qty: 1, unitCents: 4500, ...(sessionId ? { sessionId } : {}) });
const visit = (over: Record<string, unknown> = {}) => ({ kinfolkId: 'fam1', status: 'COMPLETED', ...over });

describe('parseArgs / resolveTarget', () => {
  it('is a dry run by default; --allow-prod is the write, as in every sibling backfill', () => {
    expect(parseArgs([])).toEqual({ projectId: null, allowProd: false, apply: false });
    expect(parseArgs(['--allow-prod'])).toMatchObject({ allowProd: true, apply: true });
    expect(parseArgs(['--project', 'p1'])).toEqual({ projectId: 'p1', allowProd: false, apply: false });
  });
  it('--dry-run beats --allow-prod in either order', () => {
    expect(parseArgs(['--allow-prod', '--dry-run']).apply).toBe(false);
    expect(parseArgs(['--dry-run', '--allow-prod']).apply).toBe(false);
  });
  it('refuses --apply out loud, an unknown flag, and a bare --project', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/--allow-prod is the write/);
    expect(() => parseArgs(['--allow-prod', '--apply'])).toThrow(/--allow-prod is the write/);
    expect(() => parseArgs(['--write'])).toThrow(/unknown arg/);
    expect(() => parseArgs(['--project'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--project', '--allow-prod'])).toThrow(/requires a value/);
  });
  it('a dry run may read production with no credentials file; a write to production needs one', () => {
    expect(resolveTarget(parseArgs([]), {})).toEqual({ kind: 'production' });
    expect(resolveTarget(parseArgs(['--allow-prod', '--dry-run']), {})).toEqual({ kind: 'production' });
    expect(() => resolveTarget(parseArgs(['--allow-prod']), {})).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/);
    expect(() => resolveTarget(parseArgs(['--allow-prod']), { GOOGLE_APPLICATION_CREDENTIALS: '  ' })).toThrow(
      /GOOGLE_APPLICATION_CREDENTIALS/,
    );
    expect(resolveTarget(parseArgs(['--allow-prod']), { GOOGLE_APPLICATION_CREDENTIALS: '/k.json' })).toEqual({ kind: 'production' });
  });
  it('the emulator host sends a dry run and a write to the emulator', () => {
    const env = { FIRESTORE_EMULATOR_HOST: 'localhost:8080' };
    expect(resolveTarget(parseArgs([]), env)).toEqual({ kind: 'emulator', host: 'localhost:8080' });
    expect(resolveTarget(parseArgs(['--allow-prod']), env)).toEqual({ kind: 'emulator', host: 'localhost:8080' });
  });
});
describe('buildPlanFromRows', () => {
  it('#1901: a visit a draft bills by a line, with a blank back-link, is marked billed by it', () => {
    const plan = buildPlanFromRows(
      [{ id: 'inv1', data: { status: 'draft', sessionIds: ['s1'], lineItems: [line('s1')] } }],
      [{ id: 's1', data: visit() }, { id: 's2', data: visit({ invoiceId: '' }) }],
    );
    expect(plan.backlinks).toEqual([{ sessionId: 's1', invoiceId: 'inv1' }]);
    expect(plan.invoiceSets).toEqual([]);
    expect(plan.findings).toEqual([]);
  });

  it('a line whose visit the invoice set left out joins the set too', () => {
    const plan = buildPlanFromRows(
      [{ id: 'inv1', data: { status: 'open', sessionIds: ['s1'], lineItems: [line('s1'), line('s2')] } }],
      [{ id: 's1', data: visit({ invoiceId: 'inv1' }) }, { id: 's2', data: visit() }],
    );
    expect(plan.backlinks).toEqual([{ sessionId: 's2', invoiceId: 'inv1' }]);
    expect(plan.invoiceSets).toEqual([{ invoiceId: 'inv1', sessionIds: ['s1', 's2'], added: ['s2'] }]);
  });

  it('an already consistent link writes nothing and reports nothing', () => {
    const plan = buildPlanFromRows(
      [
        { id: 'inv1', data: { status: 'open', sessionIds: ['s1'], lineItems: [line('s1')] } },
        { id: 'inv2', data: { status: 'paid', sessionIds: ['s2'] } },
      ],
      [{ id: 's1', data: visit({ invoiceId: 'inv1' }) }, { id: 's2', data: visit({ invoiceId: 'inv2' }) }],
    );
    expect(plan).toMatchObject({ backlinks: [], invoiceSets: [], findings: [] });
  });

  it('reports, never decides, a visit two invoices claim', () => {
    const plan = buildPlanFromRows(
      [
        { id: 'invA', data: { status: 'open', sessionIds: ['s1'], lineItems: [line('s1')] } },
        { id: 'invB', data: { status: 'draft', sessionIds: ['s1'], lineItems: [line('s1')] } },
      ],
      [{ id: 's1', data: visit() }],
    );
    expect(plan.backlinks).toEqual([]);
    expect(plan.findings).toEqual([{ kind: 'multiple_claimants', sessionId: 's1', invoiceIds: ['invA', 'invB'] }]);
  });

  it('reports a back-link naming a different invoice', () => {
    const plan = buildPlanFromRows(
      [{ id: 'inv1', data: { status: 'open', sessionIds: ['s1'], lineItems: [line('s1')] } }],
      [{ id: 's1', data: visit({ invoiceId: 'invGone' }) }],
    );
    expect(plan.backlinks).toEqual([]);
    expect(plan.findings).toEqual([{ kind: 'backlink_elsewhere', sessionId: 's1', invoiceId: 'inv1', backlink: 'invGone' }]);
  });

  it('#1970: a linked visit an itemized invoice has no line for is reported, not unlinked', () => {
    const plan = buildPlanFromRows(
      [{ id: 'inv1', data: { status: 'open', sessionIds: ['s1', 's2'], lineItems: [line('s1')] } }],
      [{ id: 's1', data: visit({ invoiceId: 'inv1' }) }, { id: 's2', data: visit({ invoiceId: 'inv1' }) }],
    );
    expect(plan.backlinks).toEqual([]);
    expect(plan.findings).toEqual([{ kind: 'linked_without_line', sessionId: 's2', invoiceId: 'inv1' }]);
  });

  it('a typed-total invoice naming a visit that does not point back is reported, not linked', () => {
    const plan = buildPlanFromRows(
      [{ id: 'inv1', data: { status: 'open', sessionIds: ['s1'] } }],
      [{ id: 's1', data: visit() }],
    );
    expect(plan.backlinks).toEqual([]);
    expect(plan.findings).toEqual([{ kind: 'linked_without_line', sessionId: 's1', invoiceId: 'inv1' }]);
  });

  it('reports a missing visit, a cancelled visit, and a visit held by a quote or a cancelled invoice', () => {
    const plan = buildPlanFromRows(
      [
        { id: 'inv1', data: { status: 'open', sessionIds: ['gone', 'sc'], lineItems: [line('gone'), line('sc')] } },
        { id: 'q1', data: { status: 'QUOTE', sessionIds: ['sq'], lineItems: [line('sq')] } },
        { id: 'c1', data: { status: 'cancelled', sessionIds: ['sx'], lineItems: [line('sx')] } },
      ],
      [
        { id: 'sc', data: visit({ status: 'cancelled' }) },
        { id: 'sq', data: visit() },
        { id: 'sx', data: visit() },
      ],
    );
    expect(plan.backlinks).toEqual([]);
    expect(plan.findings).toEqual([
      { kind: 'missing_session', sessionId: 'gone', invoiceId: 'inv1' },
      { kind: 'cancelled_session', sessionId: 'sc', invoiceId: 'inv1' },
      { kind: 'held_by_quote_or_cancelled', sessionId: 'sq', invoiceId: 'q1', state: 'quote' },
      { kind: 'held_by_quote_or_cancelled', sessionId: 'sx', invoiceId: 'c1', state: 'cancelled' },
    ]);
  });

  it('#2168: an archived draft is abandoned work, so its visits are reported and not marked billed', () => {
    const plan = buildPlanFromRows(
      [
        { id: 'd1', data: { status: 'draft', archivedAt: '2026-11-01T00:00:00Z', sessionIds: ['s1'], lineItems: [line('s1')] } },
        // A restored draft carries archivedAt: null and is repaired as usual.
        { id: 'd2', data: { status: 'draft', archivedAt: null, sessionIds: ['s2'], lineItems: [line('s2')] } },
        // An archived invoice that was sent did bill its visit.
        { id: 'o1', data: { status: 'open', archivedAt: '2026-11-01T00:00:00Z', sessionIds: ['s3'], lineItems: [line('s3')] } },
      ],
      [{ id: 's1', data: visit() }, { id: 's2', data: visit() }, { id: 's3', data: visit() }],
    );
    expect(plan.backlinks).toEqual([
      { sessionId: 's2', invoiceId: 'd2' },
      { sessionId: 's3', invoiceId: 'o1' },
    ]);
    expect(plan.findings).toEqual([{ kind: 'held_by_archived_draft', sessionId: 's1', invoiceId: 'd1' }]);
  });

  it('#2168: an archived draft is no claimant, so a visit billed since by another invoice is that invoice\'s alone', () => {
    const plan = buildPlanFromRows(
      [
        // Archived after #2168: its set emptied, its line still names the visit.
        { id: 'd1', data: { status: 'draft', archivedAt: '2026-11-01T00:00:00Z', sessionIds: [], releasedSessionIds: ['s1'], lineItems: [line('s1')] } },
        { id: 'inv2', data: { status: 'open', sessionIds: ['s1'], lineItems: [line('s1')] } },
      ],
      [{ id: 's1', data: visit({ invoiceId: 'inv2' }) }],
    );
    expect(plan).toMatchObject({ backlinks: [], invoiceSets: [], findings: [] });
  });

  it('is idempotent: the plan after applying is empty', () => {
    const invoices = [{ id: 'inv1', data: { status: 'draft', sessionIds: ['s1'], lineItems: [line('s1'), line('s2')] } }];
    const sessions = [{ id: 's1', data: visit() }, { id: 's2', data: visit() }];
    const first = buildPlanFromRows(invoices, sessions);
    const after = {
      invoices: invoices.map((i) => ({ ...i, data: { ...i.data, sessionIds: first.invoiceSets[0]!.sessionIds } })),
      sessions: sessions.map((s) => ({ ...s, data: { ...s.data, invoiceId: 'inv1' } })),
    };
    expect(buildPlanFromRows(after.invoices, after.sessions)).toMatchObject({ backlinks: [], invoiceSets: [], findings: [] });
  });
});

describe('reportLines / applyPlan', () => {
  const plan = buildPlanFromRows(
    [{ id: 'inv1', data: { status: 'draft', sessionIds: ['s1'], lineItems: [line('s1'), line('s2')] } }],
    [{ id: 's1', data: visit() }, { id: 's2', data: visit() }],
  );

  it('a dry run says it wrote nothing', () => {
    const text = reportLines(plan, false).join('\n');
    expect(text).toContain('DRY RUN');
    expect(text).toContain('visits marked billed              : 2');
    expect(text).toContain('nothing was written');
    expect(reportLines(plan, true).join('\n')).not.toContain('nothing was written');
  });

  it('writes only the link fields, merge on the visit and update on the invoice', async () => {
    const sets: Array<[string, unknown, unknown]> = [];
    const updates: Array<[string, unknown]> = [];
    const commit = vi.fn(async () => undefined);
    const db = {
      collection: (c: string) => ({ doc: (id: string) => ({ path: `${c}/${id}` }) }),
      batch: () => ({
        set: (ref: { path: string }, data: unknown, opts: unknown) => sets.push([ref.path, data, opts]),
        update: (ref: { path: string }, data: unknown) => updates.push([ref.path, data]),
        commit,
      }),
    };
    await applyPlan(db as never, plan, '2026-11-12T00:00:00.000Z');
    expect(sets).toEqual([
      ['kin_care_sessions/s1', { invoiceId: 'inv1', _attribution: ATTRIBUTION, _attributionAt: '2026-11-12T00:00:00.000Z' }, { merge: true }],
      ['kin_care_sessions/s2', { invoiceId: 'inv1', _attribution: ATTRIBUTION, _attributionAt: '2026-11-12T00:00:00.000Z' }, { merge: true }],
    ]);
    // An array union of the added ids only, so an edit landing between the
    // read and the write keeps its own changes to the set.
    expect(updates).toEqual([['invoices/inv1', { sessionIds: FieldValue.arrayUnion('s2') }]]);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
