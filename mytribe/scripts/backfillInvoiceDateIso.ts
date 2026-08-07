/**
 * backfillInvoiceDateIso.ts
 *
 * `invoices.date` and `invoices.dueDate` hold MORE THAN ONE FORMAT, and the
 * admin's date window is built on them.
 *
 * Until this change `createInvoice` and `createQuote` typed both fields
 * `z.string().default('')`, no shape at all, while `updateInvoice` has
 * enforced `YYYY-MM-DD` on its patch since W2-1. So the collection accumulated
 * whatever each caller happened to send, and the codebase's own fixtures record
 * what that looked like: `functions/test/invoicePdf.test.ts` seeds
 * `date: 'Sep 1, 2025'`, `functions/test/enrichTemplateData.test.ts` seeds
 * `'Jul 1, 2026'`, and `auntieos-admin/src/api/invoices.test.ts` seeds
 * `'August 11, 2025'`.
 *
 * WHY THAT IS A BUG AND NOT UNTIDINESS. Firestore orders strings by UTF-8 byte,
 * and every letter (0x41 and up) outranks every digit (0x30-0x39). The admin
 * Invoices list windows the collection with `where('date','>=','2026-07-05')`
 * and orders it `date desc`. `"Feb 12, 2026"` beats that bound on its FIRST
 * character, before either year is looked at, so every letter-leading invoice
 * satisfies every ISO cutoff, and sorts above every real date, which puts
 * exactly the wrong rows at the top of page one. "Last 30 days" was returning
 * invoices six months old. `portal/getMyInvoices.ts` sorts its paid bucket with
 * `localeCompare` on the same field and mis-sorts for the same reason.
 *
 * The write side is now closed (`functions/src/lib/invoiceDay.ts`), so no NEW
 * document can carry free text. This script is the other half: the documents
 * already stored.
 *
 * WHAT IT WRITES, and only this:
 *   - `date`     the same day, re-rendered as `YYYY-MM-DD`
 *   - `dueDate`  likewise
 * Both fields in one pass, deliberately. They are one field family with one
 * failure, and two sweeps over one collection is two chances to run half of it.
 *
 * WHAT IT NEVER TOUCHES: every other field, `updatedAt` included. This
 * materializes a format, it is not an edit of the invoice, and stamping
 * `updatedAt` would make a re-render of a stored day look like an operator
 * changed the bill.
 *
 * THE GRAMMAR IT ACCEPTS is exactly one: an English month name (full or the
 * three-letter abbreviation), a day, an optional comma, and a four-digit year.
 * That form cannot be ambiguous, which is the only reason parsing stored text is
 * defensible at all. An ISO instant (`2026-06-07T12:00:00Z`) is also accepted,
 * since its day prefix is already unambiguous.
 *
 * IT REFUSES `01/02/2026` AND EVERYTHING LIKE IT. A numeric-separator date is
 * genuinely two different days depending on who typed it, and no amount of
 * corpus-gazing turns that into knowledge. Those are reported by id with their
 * text and left exactly as they are, for a person to decide. `Net 14` in a date
 * field is refused the same way. Nothing here calls `new Date()` on unrecognized
 * text, whose behaviour is implementation-defined.
 *
 * BLANK IS LEFT BLANK. `''` is the documented default for an invoice nobody has
 * dated yet, and inventing a day for it would be a fabricated fact on a bill. A
 * blank falls outside every dated window, which the Invoices screen already says
 * on screen.
 *
 * IDEMPOTENT BY CONSTRUCTION. A field that already reads as an exact
 * `YYYY-MM-DD` is classified `already_iso` and planned for nothing. After one
 * run every rewritten field is in that class, so a second run writes zero
 * documents.
 *
 * IT DOES NOT RUN ITSELF. No trigger calls it, no deploy step calls it; it is a
 * runbook procedure. Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *
 * Runbook: run DRY first, read the plan AND the refusals, then re-run with
 * --allow-prod. The PR that ships this script ran neither side against
 * production; both are operator steps.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';

export const INVOICES_COLLECTION = 'invoices';

/** The two fields this script owns. Order is the order the plan prints them. */
export const DATE_FIELDS = ['date', 'dueDate'] as const;
export type DateField = (typeof DATE_FIELDS)[number];

type Mode = 'dry-run' | 'apply';

interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
  /** Invoices read per page. Also bounds memory; writes batch at 400. */
  pageSize: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null, pageSize: 300 };
  // AN EXPLICIT --dry-run ALWAYS WINS, in either flag order. Tracked
  // separately from `args.mode` (rather than setting `args.mode = 'dry-run'`
  // inline the moment `--dry-run` is seen) because the unconditional
  // `if (args.allowProd) args.mode = 'apply'` below runs once, AFTER the
  // whole argv has been scanned — so `--allow-prod --dry-run` would silently
  // re-flip mode to 'apply' if this flag's own presence weren't remembered
  // past the loop. This is the one flag whose entire purpose is proving a
  // run is safe before it rewrites live invoice dates; getting its precedence
  // backwards defeats that purpose.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // Reject a flag as the value, not just a missing one: `--project` with no
      // id would otherwise swallow whatever followed it, and the token most
      // likely to follow is `--dry-run`, which would take the safety flag off
      // the table while `--allow-prod` stayed on. `--page-size` gets this free
      // via Number()/NaN; this branch has to say it.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--page-size') {
      const v = Number(argv[i + 1]);
      if (!Number.isInteger(v) || v < 1 || v > 1000) throw new Error('--page-size must be 1..1000');
      args.pageSize = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillInvoiceDateIso.ts: normalize invoices.date / invoices.dueDate to YYYY-MM-DD',
          '',
          'Usage (from mytribe/functions, which owns the node_modules this resolves against):',
          '  npm run backfill:invoice-date                     # DRY RUN (default)',
          '  npm run backfill:invoice-date -- --allow-prod     # apply',
          '  npm run backfill:invoice-date -- --dry-run        # force dry-run, ALWAYS wins',
          '  npm run backfill:invoice-date -- --project <id>   # override project',
          '  npm run backfill:invoice-date -- --page-size <n>  # invoices read per page (default 300)',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line (e.g. "--allow-prod --dry-run" still does not write).',
          '',
          '(Direct invocation needs NODE_PATH=node_modules ahead of ts-node: mytribe/scripts',
          ' has no node_modules of its own, and firebase-admin resolves at runtime from the',
          ' functions install.)',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS  service account JSON path (or ADC)',
          '  GCLOUD_PROJECT                  Firebase project id',
          '  FIRESTORE_EMULATOR_HOST         when set, credentials are not required',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  // `explicitDryRun` wins regardless of flag order — see the comment on its
  // declaration above. `args.allowProd` itself still reports `true` when
  // `--allow-prod` was passed, even though `mode` stays 'dry-run': the
  // startup log line prints both, so an operator who typed
  // `--allow-prod --dry-run` sees exactly what happened rather than a flag
  // that silently vanished.
  if (args.allowProd && !explicitDryRun) args.mode = 'apply';
  return args;
}

/** An exact stored day. The target shape, and the whole idempotency test. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An ISO instant, whose day prefix is already unambiguous. */
const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/;

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/**
 * "Feb 12, 2026" / "February 12 2026". Anchored, and the month must be a NAME:
 * that is what makes the reading unique. The comma is optional because it is
 * punctuation, not information.
 */
const MONTH_NAME_DAY =
  /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** The month's 0-based index for a full name or its three-letter form, or -1. */
function monthIndexOf(name: string): number {
  const n = name.toLowerCase();
  const exact = MONTHS.indexOf(n as (typeof MONTHS)[number]);
  if (exact >= 0) return exact;
  if (n.length !== 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(n));
}

/**
 * `YYYY-MM-DD` for a real calendar day, or null.
 *
 * Built through `Date.UTC` and then round-tripped, so a day that does not exist
 * ("February 30, 2026", which `Date.UTC` would roll into March) is refused
 * rather than relabelled. Nothing here depends on the timezone of whoever runs
 * the script: these are calendar labels, and both ends are pinned to UTC.
 */
export function isoDayFrom(year: number, monthIndex: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return null;
  if (monthIndex < 0 || monthIndex > 11) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, monthIndex, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * The one legacy grammar, plus ISO instants, rendered as a stored day. Null for
 * anything else, including every numeric-separator form, which is ambiguous by
 * construction and is refused rather than guessed.
 *
 * PURE and exported: the whole rule is unit-tested against fixtures in
 * mytribe/scripts/test/backfillInvoiceDateIso.test.ts.
 */
export function legacyDateToIsoDay(raw: string): string | null {
  const s = str(raw);
  if (s === '') return null;

  const instant = ISO_INSTANT.exec(s);
  if (instant !== null) {
    const day = instant[1] as string;
    return isoDayFrom(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  }

  const named = MONTH_NAME_DAY.exec(s);
  if (named === null) return null;
  return isoDayFrom(Number(named[3]), monthIndexOf(named[1] as string), Number(named[2]));
}

/** What one field currently is. Only `legacy` is ever rewritten. */
export type FieldShape =
  /** Absent or blank. A real value meaning "not dated"; left alone. */
  | 'blank'
  /** Already an exact, real `YYYY-MM-DD`. Left alone; this is the idempotency branch. */
  | 'already_iso'
  /** `YYYY-MM-DD` shaped but naming a day that does not exist. Reported, never rewritten. */
  | 'impossible_day'
  /** Readable as one unambiguous day. Rewritten. */
  | 'legacy'
  /** Not readable as any one day. Reported, left exactly as it is. */
  | 'unreadable';

export interface FieldDecision {
  shape: FieldShape;
  /** The text on the doc now, for the printed plan and the refusal list. */
  before: string;
  /** The day to write. Set only when `shape === 'legacy'`. */
  after: string | null;
}

/** The decision for ONE field. PURE: no Firestore access. */
export function planField(value: unknown): FieldDecision {
  const before = str(value);
  if (before === '') return { shape: 'blank', before, after: null };

  if (ISO_DAY.test(before)) {
    const real =
      isoDayFrom(
        Number(before.slice(0, 4)),
        Number(before.slice(5, 7)) - 1,
        Number(before.slice(8, 10)),
      ) === before;
    // An impossible day is NOT rewritten to the day it rolls into. That would be
    // inventing a date on a bill, and the row deserves a person instead.
    return { shape: real ? 'already_iso' : 'impossible_day', before, after: null };
  }

  const iso = legacyDateToIsoDay(before);
  if (iso === null) return { shape: 'unreadable', before, after: null };
  return { shape: 'legacy', before, after: iso };
}

export interface InvoiceDecision {
  /** Per-field verdicts, in `DATE_FIELDS` order. */
  fields: Record<DateField, FieldDecision>;
  /** The EXACT field set to merge. Empty means this invoice is already correct. */
  update: Record<string, string>;
}

/**
 * The decision for ONE invoice. PURE: no Firestore access, so every rule is
 * unit-testable against fixtures.
 */
export function planInvoice(data: Record<string, unknown>): InvoiceDecision {
  const fields = {} as Record<DateField, FieldDecision>;
  const update: Record<string, string> = {};
  for (const field of DATE_FIELDS) {
    const decision = planField(data[field]);
    fields[field] = decision;
    if (decision.after !== null) update[field] = decision.after;
  }
  return { fields, update };
}

export interface Refusal {
  invoiceId: string;
  field: DateField;
  reason: 'impossible_day' | 'unreadable';
  value: string;
}

export interface RunResult {
  scanned: number;
  /** Invoices with at least one field rewritten. */
  rewritten: number;
  /** Field-level counts, so the plan is reviewable at a glance. */
  byShape: Record<FieldShape, number>;
  /** Fields left exactly as they are, named for a person to look at. */
  refusals: Refusal[];
}

/** Firestore caps a WriteBatch at 500 ops; stay comfortably under it. */
const WRITES_PER_BATCH = 400;

function initAdmin(projectId: string): void {
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'backfillInvoiceDateIso: missing credentials. Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path, or run against the Firestore emulator.',
    );
  }
  if (getApps().length === 0) initializeApp({ projectId });
}

export async function run(mode: Mode, pageSize: number, db?: Firestore): Promise<RunResult> {
  const store: Firestore = db ?? getFirestore();
  const result: RunResult = {
    scanned: 0,
    rewritten: 0,
    byShape: { blank: 0, already_iso: 0, impossible_day: 0, legacy: 0, unreadable: 0 },
    refusals: [],
  };

  let batch = store.batch();
  let batchSize = 0;
  const flush = async () => {
    if (batchSize === 0) return;
    if (mode === 'apply') await batch.commit();
    batch = store.batch();
    batchSize = 0;
  };

  // Paged by document id: present on every doc by construction, which is the one
  // thing a completeness sweep needs. Ordering by `date` here would be circular
  // (it is the broken field), and would drop every doc that lacks it, the same
  // trap backfillInvoiceStateStamp.ts documents.
  let cursor: string | null = null;
  for (;;) {
    let query = store.collection(INVOICES_COLLECTION).orderBy('__name__').limit(pageSize);
    if (cursor !== null) query = query.startAfter(cursor);
    const page = await query.get();
    if (page.docs.length === 0) break;

    for (const docSnap of page.docs) {
      result.scanned += 1;
      cursor = docSnap.id;
      const data = docSnap.data() as Record<string, unknown>;
      const decision = planInvoice(data);

      for (const field of DATE_FIELDS) {
        const f = decision.fields[field];
        result.byShape[f.shape] += 1;
        if (f.shape === 'impossible_day' || f.shape === 'unreadable') {
          result.refusals.push({
            invoiceId: docSnap.id,
            field,
            reason: f.shape,
            value: f.before,
          });
        }
      }

      if (Object.keys(decision.update).length === 0) continue;

      result.rewritten += 1;
      for (const field of DATE_FIELDS) {
        const after = decision.update[field];
        if (after !== undefined) {
          console.log(
            `[rewrite] ${INVOICES_COLLECTION}/${docSnap.id} ${field}: "${decision.fields[field].before}" -> "${after}"`,
          );
        }
      }

      // Merge of EXACTLY the fields being re-rendered. No updatedAt: this
      // materializes a format, it is not an edit of the invoice.
      batch.set(docSnap.ref, decision.update, { merge: true });
      batchSize += 1;
      if (batchSize >= WRITES_PER_BATCH) await flush();
    }

    if (page.docs.length < pageSize) break;
  }
  await flush();

  return result;
}

function summarise(mode: Mode, r: RunResult): void {
  console.log('\n=== backfillInvoiceDateIso ===');
  console.log(`  mode      : ${mode === 'apply' ? 'APPLY' : 'DRY RUN (nothing written)'}`);
  console.log(`  scanned   : ${r.scanned} invoice(s), ${DATE_FIELDS.length} date field(s) each`);
  console.log(`  ${mode === 'apply' ? 'rewritten' : 'planned  '} : ${r.rewritten} invoice(s)`);
  console.log('  fields by shape:');
  console.log(`      blank (left alone)         : ${r.byShape.blank}`);
  console.log(`      already YYYY-MM-DD         : ${r.byShape.already_iso}`);
  console.log(`      legacy text (rewritten)    : ${r.byShape.legacy}`);
  console.log(`      impossible day (REFUSED)   : ${r.byShape.impossible_day}`);
  console.log(`      unreadable (REFUSED)       : ${r.byShape.unreadable}`);

  if (r.refusals.length > 0) {
    console.log('\n  REFUSED. Left exactly as they are; nothing was guessed.');
    console.log('    unreadable     : not one unambiguous day. A numeric form like');
    console.log('                     01/02/2026 is two different days and this script');
    console.log('                     will not pick one. Needs a person.');
    console.log('    impossible_day : YYYY-MM-DD shaped but names a day that does not');
    console.log('                     exist. Rewriting it to the day it rolls into would');
    console.log('                     be inventing a date on a bill.');
    for (const f of r.refusals) {
      console.log(`      ${INVOICES_COLLECTION}/${f.invoiceId}  ${f.field}  ${f.reason}  "${f.value}"`);
    }
    console.log('\n  These stay outside every dated window on the Invoices screen, which');
    console.log('  says so on screen, until someone corrects them.');
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  console.log(`Mode: ${args.mode}    allowProd=${args.allowProd}    emulator=${usingEmulator}`);

  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  initAdmin(projectId);

  const result = await run(args.mode, args.pageSize);
  summarise(args.mode, result);

  if (args.mode === 'apply') {
    const db = getFirestore();
    await db.collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_INVOICE_DATE_ISO',
      description: `rewritten=${result.rewritten} scanned=${result.scanned} refused=${result.refusals.length}`,
      status: 'SUCCESS',
      actorId: 'system:backfillInvoiceDateIso',
      targetId: '',
      targetCollection: INVOICES_COLLECTION,
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: { result },
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('\nWrote activity_log entry (UNCHAINED: runs outside writeAuditEntry).');
  } else {
    console.log('\nDRY-RUN. No writes. Re-run with --allow-prod to commit.');
  }
}

// Only auto-run when invoked directly, not when imported by tests. Nothing else
// in this repo invokes this file: it is a runbook step, never an automatic one.
const isMain = require.main === module;
if (isMain) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
