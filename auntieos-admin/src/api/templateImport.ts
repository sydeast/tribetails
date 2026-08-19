import { call } from '../lib/fns';

/**
 * The Template Bank IMPORT surface: `importSeedTemplates` (admin).
 *
 * Issue #468. The operator ruled out the `seed:notif-templates` script, so the
 * corpus of notification templates committed to the repo reaches Firestore
 * through this callable and nothing else. A notification whose template
 * document is missing does not fall back to anything: `sendFromTemplate`
 * throws, the channel is stamped failed, and no email goes out.
 *
 * TWO CALLS, NOT ONE. A run starts as a dry run, which writes nothing and
 * returns the plan. Any template whose stored copy differs from the repo copy
 * comes back as `skipped`, and importing it needs a second call naming it in
 * `overwriteIds`. That is the whole safety property: an import can never
 * replace wording an operator edited in the Template Bank without them having
 * read the plan first.
 */

/** The three collections a template writes into, in report order. */
export type TemplateImportChannel = 'email' | 'sms' | 'push';

export type TemplateImportOutcome =
  | 'create'
  | 'overwrite'
  | 'skipped'
  | 'unchanged'
  | 'blocked';

export interface TemplateImportChannelRow {
  channel: TemplateImportChannel;
  outcome: TemplateImportOutcome;
  /** Operator-facing sentences: why it is blocked, or what differs. */
  notes: string[];
}

export interface TemplateImportRow {
  templateId: string;
  /** Set when this id is a retired key kept alive for old bindings. */
  aliasOf: string | null;
  channels: TemplateImportChannelRow[];
  differsFromRepo: boolean;
  blocked: boolean;
}

export interface TemplateImportReport {
  dryRun: boolean;
  /** Documents actually written. Zero on a dry run, always. */
  written: number;
  counts: Record<string, number>;
  rows: TemplateImportRow[];
  /** Ids that differ and were skipped for want of an explicit choice. */
  needsOverwriteChoice: string[];
  refused: Array<{ templateId: string; reason: string }>;
}

export interface ImportSeedTemplatesPayload {
  dryRun?: boolean;
  overwriteIds?: string[];
  onlyIds?: string[];
}

export async function importSeedTemplates(
  payload: ImportSeedTemplatesPayload,
): Promise<TemplateImportReport> {
  const result = await call<ImportSeedTemplatesPayload, TemplateImportReport>(
    'importSeedTemplates',
    payload,
  );
  return result;
}

/** The plan, with nothing written. Always the first call of a run. */
export async function planSeedTemplateImport(
  onlyIds?: string[],
): Promise<TemplateImportReport> {
  return importSeedTemplates({ dryRun: true, ...(onlyIds ? { onlyIds } : {}) });
}

/** How many documents a plan would write if applied as it stands. */
export function plannedWriteCount(report: TemplateImportReport): number {
  return report.rows.reduce(
    (total, row) =>
      total +
      row.channels.filter((c) => c.outcome === 'create' || c.outcome === 'overwrite').length,
    0,
  );
}

/** One line summarising a template for the report list. */
export function importRowSummary(row: TemplateImportRow): string {
  if (row.blocked) return 'Refused';
  const outcomes = row.channels.map((c) => c.outcome);
  if (outcomes.every((o) => o === 'unchanged')) return 'Already matches the repo';
  if (outcomes.includes('skipped')) return 'Differs, not selected for overwrite';
  if (outcomes.includes('overwrite')) return 'Will replace the stored copy';
  return 'New';
}

/**
 * What the operator is told before they press the button that writes.
 *
 * Phrased as counts of documents rather than templates, because that is the
 * unit the server writes in and the unit the report returns.
 */
export function importPlanHeadline(report: TemplateImportReport): string {
  const writes = plannedWriteCount(report);
  if (writes === 0 && report.refused.length === 0) {
    return 'Every template on file already matches the repo. There is nothing to import.';
  }
  const parts: string[] = [];
  if (report.counts.create) parts.push(`${report.counts.create} to create`);
  if (report.counts.overwrite) parts.push(`${report.counts.overwrite} to replace`);
  if (report.counts.unchanged) parts.push(`${report.counts.unchanged} already matching`);
  if (report.counts.skipped) parts.push(`${report.counts.skipped} differing and left alone`);
  if (report.counts.blocked) parts.push(`${report.counts.blocked} refused`);
  return `${parts.join(', ')}. Importing writes ${writes} document${writes === 1 ? '' : 's'}.`;
}
