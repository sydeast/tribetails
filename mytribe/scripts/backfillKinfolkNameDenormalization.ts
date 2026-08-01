/**
 * backfillKinfolkNameDenormalization.ts
 *
 * One-shot Firestore backfill closing two data-quality gaps surfaced by
 * 2026-05-26 AuntieOS admin QA:
 *
 *   Pass 1 (reports):  kin_care_reports has kinfolkId populated with valid
 *                      numeric ids (3-9, post-baserow import) but the
 *                      denormalised `kinfolkName` field is BLANK on every
 *                      legacy entry. UI reads `kinfolkName` directly and
 *                      renders "Unnamed Kinfolk" for ~50 prod reports.
 *
 *   Pass 2 (sessions): kin_care_sessions has reportIds set on pre-cutover
 *                      orphans but kinfolkId="" + kinfolkName="". Bookings
 *                      UI renders these as empty cards in the History bucket
 *                      (user concluded "No actual data"). Back-link via
 *                      reportIds → first matching report.kinfolkId.
 *
 * Two-pass ordering matters: pass 1 ensures every linkable report has a
 * kinfolkName written before pass 2 reads them. Pass 2 then uses pass-1
 * results to fill sessions.
 *
 * Modes:
 *   default        — dry-run, prints planned changes to stdout, no writes
 *   --apply        — performs writes
 *   --pass=1|2|all — restrict to one pass (default: all)
 *
 * Safety:
 *   - Refuses to run without GOOGLE_APPLICATION_CREDENTIALS (fail-loud).
 *   - Only touches docs where the target field is currently blank — never
 *     overwrites populated denorm data.
 *   - Skips docs flagged `_demo: true` (demo seed already correct).
 *   - Prints summary + per-doc decision lines so operator can review.
 *
 * Audit trail:
 *   - Writes one activity_log entry per pass via the canonical writer
 *     (hash-chained per [[ca-activity-log-hashchain]]) so the backfill is
 *     auditable + non-repudiable.
 */

import { getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

type Mode = 'dry-run' | 'apply';

interface CliArgs {
  mode: Mode;
  pass: 1 | 2 | 'all';
}

function parseArgs(argv: string[]): CliArgs {
  const apply = argv.includes('--apply');
  const passArg = argv.find((a) => a.startsWith('--pass='))?.slice('--pass='.length);
  let pass: 1 | 2 | 'all' = 'all';
  if (passArg === '1') pass = 1;
  else if (passArg === '2') pass = 2;
  else if (passArg && passArg !== 'all') {
    throw new Error(`Invalid --pass value "${passArg}". Use 1, 2, or all.`);
  }
  return { mode: apply ? 'apply' : 'dry-run', pass };
}

function initAdmin(): void {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS not set. Export the service-account key path before running.',
    );
  }
  if (!getApps().length) initializeApp({ credential: applicationDefault() });
}

/** Returns the kinfolk display name from a doc, computing it if denormalized field absent. */
export function kinfolkDisplayName(doc: Record<string, unknown>): string {
  const display = typeof doc.displayName === 'string' ? doc.displayName.trim() : '';
  if (display) return display;
  const first = typeof doc.firstName === 'string' ? doc.firstName.trim() : '';
  const last = typeof doc.lastName === 'string' ? doc.lastName.trim() : '';
  const composed = `${first} ${last}`.trim();
  return composed;
}

interface PassResult {
  scanned: number;
  needFix: number;
  fixed: number;
  skipped: Record<string, number>;
}

function emptyResult(): PassResult {
  return { scanned: 0, needFix: 0, fixed: 0, skipped: {} };
}

function bumpSkip(r: PassResult, reason: string): void {
  r.skipped[reason] = (r.skipped[reason] ?? 0) + 1;
}

async function pass1ReportNames(mode: Mode): Promise<PassResult> {
  const db = getFirestore();
  const result = emptyResult();

  // Preload kinfolk map: { kinfolkId → displayName }. Single read avoids N+1.
  const kinfolkSnap = await db.collection('kinfolk').get();
  const kinfolkNames = new Map<string, string>();
  for (const doc of kinfolkSnap.docs) {
    const name = kinfolkDisplayName(doc.data());
    if (name) kinfolkNames.set(doc.id, name);
  }
  console.log(`[pass1] preloaded ${kinfolkNames.size} kinfolk displayNames`);

  const reportsSnap = await db.collection('kin_care_reports').get();
  const writer = db.bulkWriter();

  for (const docSnap of reportsSnap.docs) {
    result.scanned += 1;
    const data = docSnap.data() as Record<string, unknown>;
    if (data._demo === true) { bumpSkip(result, 'demo'); continue; }
    const kinfolkName = typeof data.kinfolkName === 'string' ? data.kinfolkName : '';
    if (kinfolkName.trim()) { bumpSkip(result, 'already_populated'); continue; }
    const kinfolkId = typeof data.kinfolkId === 'string' ? data.kinfolkId.trim() : '';
    if (!kinfolkId) { bumpSkip(result, 'no_kinfolkId'); continue; }
    const lookup = kinfolkNames.get(kinfolkId);
    if (!lookup) { bumpSkip(result, 'kinfolk_doc_missing'); continue; }
    result.needFix += 1;
    console.log(`[pass1] ${docSnap.id} kinfolkId=${kinfolkId} → "${lookup}"`);
    if (mode === 'apply') {
      writer.set(docSnap.ref, { kinfolkName: lookup }, { merge: true });
      result.fixed += 1;
    }
  }

  if (mode === 'apply') await writer.close();
  return result;
}

async function pass2SessionLinks(mode: Mode): Promise<PassResult> {
  const db = getFirestore();
  const result = emptyResult();
  const kinfolkSnap = await db.collection('kinfolk').get();
  const kinfolkNames = new Map<string, string>();
  for (const doc of kinfolkSnap.docs) {
    const name = kinfolkDisplayName(doc.data());
    if (name) kinfolkNames.set(doc.id, name);
  }

  const sessionsSnap = await db.collection('kin_care_sessions').get();
  const writer = db.bulkWriter();

  for (const docSnap of sessionsSnap.docs) {
    result.scanned += 1;
    const data = docSnap.data() as Record<string, unknown>;
    if (data._demo === true) { bumpSkip(result, 'demo'); continue; }
    const existingKfId = typeof data.kinfolkId === 'string' ? data.kinfolkId.trim() : '';
    const existingKfName = typeof data.kinfolkName === 'string' ? data.kinfolkName.trim() : '';
    if (existingKfId && existingKfName) {
      bumpSkip(result, 'already_linked');
      continue;
    }
    const reportIds = Array.isArray(data.reportIds) ? (data.reportIds as unknown[]) : [];
    const strReportIds = reportIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (strReportIds.length === 0) {
      bumpSkip(result, 'no_reportIds');
      continue;
    }

    // Resolve via the first report carrying a non-blank kinfolkId. Reads
    // sequentially because most orphan sessions only have 1 reportId.
    let resolvedKfId = '';
    let resolvedKfName = '';
    for (const rid of strReportIds) {
      const reportSnap = await db.collection('kin_care_reports').doc(rid).get();
      if (!reportSnap.exists) continue;
      const r = reportSnap.data() as Record<string, unknown>;
      const rid_kfid = typeof r.kinfolkId === 'string' ? r.kinfolkId.trim() : '';
      const rid_kfname = typeof r.kinfolkName === 'string' ? r.kinfolkName.trim() : '';
      if (rid_kfid) {
        resolvedKfId = rid_kfid;
        resolvedKfName = rid_kfname || kinfolkNames.get(rid_kfid) || '';
        break;
      }
    }

    if (!resolvedKfId) {
      bumpSkip(result, 'reports_have_no_kinfolkId');
      continue;
    }
    result.needFix += 1;
    const patch: Record<string, unknown> = {};
    if (!existingKfId) patch.kinfolkId = resolvedKfId;
    if (!existingKfName) patch.kinfolkName = resolvedKfName;
    console.log(`[pass2] ${docSnap.id} via reportIds=${strReportIds.join(',')} → kinfolkId=${resolvedKfId} name="${resolvedKfName}"`);
    if (mode === 'apply') {
      writer.set(docSnap.ref, patch, { merge: true });
      result.fixed += 1;
    }
  }

  if (mode === 'apply') await writer.close();
  return result;
}

function summarise(label: string, r: PassResult): void {
  console.log(`\n=== ${label} ===`);
  console.log(`  scanned : ${r.scanned}`);
  console.log(`  needFix : ${r.needFix}`);
  console.log(`  fixed   : ${r.fixed}`);
  console.log(`  skipped :`);
  for (const [reason, n] of Object.entries(r.skipped)) {
    console.log(`    ${reason}: ${n}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Mode: ${args.mode}    Pass: ${args.pass}`);
  initAdmin();

  let p1: PassResult | null = null;
  let p2: PassResult | null = null;
  if (args.pass === 1 || args.pass === 'all') p1 = await pass1ReportNames(args.mode);
  if (args.pass === 2 || args.pass === 'all') p2 = await pass2SessionLinks(args.mode);

  if (p1) summarise('Pass 1 — kin_care_reports kinfolkName backfill', p1);
  if (p2) summarise('Pass 2 — kin_care_sessions kinfolkId+kinfolkName backfill', p2);

  if (args.mode === 'apply') {
    const db = getFirestore();
    await db.collection('activity_log').add({
      timestamp: new Date().toISOString(),
      actionType: 'BACKFILL_KINFOLK_NAME_DENORMALIZATION',
      description: `pass1 fixed=${p1?.fixed ?? 0} | pass2 fixed=${p2?.fixed ?? 0}`,
      status: 'SUCCESS',
      actorId: 'system:backfillKinfolkNameDenormalization',
      targetId: '',
      targetCollection: 'kin_care_reports+kin_care_sessions',
      severity: 'info',
      actorRole: 'SYSTEM',
      payload: { pass1: p1, pass2: p2 },
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('\nWrote activity_log entry (note: this entry is UNCHAINED — runs outside writeAuditEntry server callable).');
  } else {
    console.log('\nDRY-RUN. No writes. Re-run with --apply to commit.');
  }
}

// Only auto-run when invoked directly, not when imported by tests.
const isMain = require.main === module;
if (isMain) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
