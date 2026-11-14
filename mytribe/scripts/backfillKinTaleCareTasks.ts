/**
 * backfillKinTaleCareTasks.ts
 *
 * Gives every KinTale already sent its own copy of the care tasks, so deleting
 * or editing a template can no longer change what a household was shown.
 *
 * THE OPERATOR'S RULING, 2026-11-12 (issue #2058): "STAMP AT SEND". A sent
 * KinTale keeps its own copy of the care tasks; template edits and deletes
 * never change sent tales. This reverses the 2026-08-23 ruling, under which
 * every reader looked a tale's labels up in its template at read time.
 *
 * From #2058 on, the send itself takes the copy (`careTasks`, see
 * `mytribe/functions/src/lib/careTaskStamp.ts`). This script does the same for
 * the tales sent before that, from each tale's template AS IT STANDS NOW, which
 * is the only version of it there is.
 *
 * ── WHAT IT DOES TO EACH `kin_care_reports` DOC ───────────────────────────
 *
 *   draft (not sent)        nothing. A draft still follows its template.
 *   already has a copy      nothing. The idempotency branch: after one run
 *                           every stampable tale has one, so a second run
 *                           plans nothing.
 *   blank `templateId`      stamped from the built-in Standard Visit list,
 *                           which is what a blank id has always meant.
 *   template still exists   stamped from it.
 *   template is GONE        NOT stamped, and listed. Its labels cannot be
 *                           recovered from anywhere, so any copy written now
 *                           would either be empty or invented. These are the
 *                           tales the walk saw lose "Care tasks done this
 *                           visit"; the list says which they are.
 *
 * It writes `careTasks` and nothing else, inside a transaction per tale that
 * re-reads the tale and its template, so a tale sent or edited while the run is
 * going is judged on what it holds at that moment, never on the plan's read.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and the list, writes nothing.
 *   --allow-prod   applies.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either flag
 *                  order.
 *
 * Runbook: run DRY first, read the plan and the list of tales whose template
 * is gone, then re-run with --allow-prod. The real write is an operator step,
 * never an agent's.
 *
 *   npm --prefix mytribe/functions run backfill:kintale-care-tasks
 *   npm --prefix mytribe/functions run backfill:kintale-care-tasks -- --allow-prod
 */
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import {
  buildCareTaskStamp,
  isSentKinTale,
  readCareTaskStamp,
  CARE_TASKS_FIELD,
  type CareTaskStamp,
} from '../functions/src/lib/careTaskStamp';

export const REPORTS_COLLECTION = 'kin_care_reports';
export const TEMPLATES_COLLECTION = 'kintale_templates';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  // An explicit --dry-run wins in either flag order: it is remembered past the
  // loop, and only then does --allow-prod get to switch the mode.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillKinTaleCareTasks.ts: give every sent KinTale its own copy of the care tasks',
          '',
          '  npm run backfill:kintale-care-tasks                    # DRY RUN (default)',
          '  npm run backfill:kintale-care-tasks -- --allow-prod    # apply',
          '  npm run backfill:kintale-care-tasks -- --dry-run       # force dry-run, ALWAYS wins',
          '  npm run backfill:kintale-care-tasks -- --project <id>  # override project',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export type CareTaskPlan =
  | { kind: 'skip'; reason: 'draft' | 'already-stamped' }
  | { kind: 'refuse'; reason: 'template-gone'; templateId: string }
  | { kind: 'stamp'; stamp: CareTaskStamp };

/**
 * The decision for ONE tale. PURE: `template` is the tale's template doc as
 * read, `null` when it does not exist, and ignored for a blank `templateId`.
 */
export function planCareTasks(
  data: Record<string, unknown>,
  template: Record<string, unknown> | null,
  now: string,
): CareTaskPlan {
  if (!isSentKinTale(data)) return { kind: 'skip', reason: 'draft' };
  if (readCareTaskStamp(data[CARE_TASKS_FIELD]) !== null) return { kind: 'skip', reason: 'already-stamped' };
  const templateId = str(data['templateId']);
  if (templateId !== '' && template === null) return { kind: 'refuse', reason: 'template-gone', templateId };
  return {
    kind: 'stamp',
    stamp: buildCareTaskStamp({ templateId, template, fieldResponses: data['fieldResponses'], now, by: 'backfill' }),
  };
}

/** How many tasks a tale has ticked, counted the way the feed counts them. */
export function tickedCount(data: Record<string, unknown>): number {
  const map = data['fieldResponses'];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 0;
  return Object.values(map as Record<string, unknown>).filter(
    (r) => !!r && typeof r === 'object' && (r as Record<string, unknown>)['boolValue'] === true,
  ).length;
}

export interface Unrecoverable {
  reportId: string;
  kinfolkId: string;
  templateId: string;
  sentAt: string;
  ticked: number;
}

export interface Summary {
  scanned: number;
  drafts: number;
  alreadyStamped: number;
  toStamp: number;
  fromBuiltIn: number;
  fromTemplate: number;
  unrecoverable: Unrecoverable[];
}

export interface PlannedWrite {
  reportId: string;
  stamp: CareTaskStamp;
}

function sentAtText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return '';
}

async function readTemplates(db: Firestore, ids: string[]): Promise<Map<string, Record<string, unknown> | null>> {
  const out = new Map<string, Record<string, unknown> | null>();
  for (const id of ids) {
    const snap = await db.collection(TEMPLATES_COLLECTION).doc(id).get();
    out.set(id, snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null);
  }
  return out;
}

export async function buildPlan(
  db: Firestore,
  now: string = new Date().toISOString(),
): Promise<{ summary: Summary; writes: PlannedWrite[] }> {
  const snap = await db.collection(REPORTS_COLLECTION).get();
  const templateIds = Array.from(
    new Set(snap.docs.map((d) => str((d.data() as Record<string, unknown>)['templateId'])).filter((id) => id !== '')),
  );
  const templates = await readTemplates(db, templateIds);
  const summary: Summary = {
    scanned: 0,
    drafts: 0,
    alreadyStamped: 0,
    toStamp: 0,
    fromBuiltIn: 0,
    fromTemplate: 0,
    unrecoverable: [],
  };
  const writes: PlannedWrite[] = [];
  for (const doc of snap.docs) {
    summary.scanned += 1;
    const data = doc.data() as Record<string, unknown>;
    const templateId = str(data['templateId']);
    const plan = planCareTasks(data, templateId === '' ? null : (templates.get(templateId) ?? null), now);
    if (plan.kind === 'skip') {
      if (plan.reason === 'draft') summary.drafts += 1;
      else summary.alreadyStamped += 1;
      continue;
    }
    if (plan.kind === 'refuse') {
      summary.unrecoverable.push({
        reportId: doc.id,
        kinfolkId: str(data['kinfolkId']),
        templateId: plan.templateId,
        sentAt: sentAtText(data['sentAt']),
        ticked: tickedCount(data),
      });
      continue;
    }
    summary.toStamp += 1;
    if (plan.stamp.source === 'builtIn') summary.fromBuiltIn += 1;
    else summary.fromTemplate += 1;
    writes.push({ reportId: doc.id, stamp: plan.stamp });
  }
  return { summary, writes };
}

function report(summary: Summary, writes: PlannedWrite[], mode: Mode): void {
  console.log('');
  console.log(`=== KinTale care-task copies (${mode.toUpperCase()}) ===`);
  console.log(`KinTales scanned                      : ${summary.scanned}`);
  console.log(`drafts (untouched)                    : ${summary.drafts}`);
  console.log(`already carry a copy (untouched)      : ${summary.alreadyStamped}`);
  console.log(`to stamp                              : ${summary.toStamp}`);
  console.log(`  from the built-in Standard Visit    : ${summary.fromBuiltIn}`);
  console.log(`  from their template                 : ${summary.fromTemplate}`);
  console.log(`template gone, cannot be recovered    : ${summary.unrecoverable.length}`);
  if (writes.length > 0) {
    console.log('');
    console.log('-- planned copies --');
    for (const w of writes) {
      const what = w.stamp.source === 'builtIn' ? 'Standard Visit' : `"${w.stamp.templateName}"`;
      console.log(`  ${REPORTS_COLLECTION}/${w.reportId}  ${w.stamp.done.length} task(s) done, from ${what}`);
    }
  }
  if (summary.unrecoverable.length > 0) {
    console.log('');
    console.log('-- TEMPLATE GONE. Left as they are; their task labels no longer exist anywhere. --');
    for (const u of summary.unrecoverable) {
      console.log(
        `  ${u.reportId}  household=${u.kinfolkId || '(none)'}  template=${u.templateId}  sent=${u.sentAt || '(blank)'}  ticked=${u.ticked}`,
      );
    }
  }
  console.log('');
}

export interface ApplyOutcome {
  stamped: number;
  /** Changed between the plan and the write (sent, stamped or edited meanwhile) and judged again. */
  skippedOnRecheck: number;
}

/**
 * Applies the plan, one transaction per tale. Each re-reads the tale and its
 * template and re-plans, so a tale the send callable stamped meanwhile, or
 * whose template was deleted meanwhile, is not overwritten from a stale read.
 */
export async function applyPlan(db: Firestore, writes: PlannedWrite[]): Promise<ApplyOutcome> {
  const outcome: ApplyOutcome = { stamped: 0, skippedOnRecheck: 0 };
  for (const w of writes) {
    const ref = db.collection(REPORTS_COLLECTION).doc(w.reportId);
    const wrote = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = (snap.data() ?? {}) as Record<string, unknown>;
      const templateId = str(data['templateId']);
      let template: Record<string, unknown> | null = null;
      if (templateId !== '') {
        const t = await tx.get(db.collection(TEMPLATES_COLLECTION).doc(templateId));
        template = t.exists ? ((t.data() ?? {}) as Record<string, unknown>) : null;
      }
      const plan = planCareTasks(data, template, w.stamp.stampedAt);
      if (plan.kind !== 'stamp') return false;
      tx.update(ref, { [CARE_TASKS_FIELD]: plan.stamp });
      return true;
    });
    if (wrote) outcome.stamped += 1;
    else outcome.skippedOnRecheck += 1;
  }
  return outcome;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  if (args.mode === 'apply' && !args.allowProd && !emulator) {
    throw new Error('refusing to write without --allow-prod (or FIRESTORE_EMULATOR_HOST)');
  }
  if (args.mode === 'apply' && !emulator && !process.env['GOOGLE_APPLICATION_CREDENTIALS']) {
    throw new Error('a real write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)');
  }
  const projectId =
    args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();

  const { summary, writes } = await buildPlan(db);
  report(summary, writes, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  const outcome = await applyPlan(db, writes);
  console.log(
    `APPLIED: ${outcome.stamped} KinTale(s) given a copy; ${outcome.skippedOnRecheck} changed meanwhile and were left.`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
