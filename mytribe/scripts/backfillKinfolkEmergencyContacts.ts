/**
 * backfillKinfolkEmergencyContacts.ts, #829 section 1 migration.
 *
 *   FROM  kinfolk/{id}  emergencyContactName / emergencyContactPhone / emergencyContactRelation
 *   TO    kinfolk/{id}  emergencyContacts[0] = { name, phone, relationship, recordedAt, updatedAt }
 *
 * recordedAt is the doc's existing `updatedAt` (a String on most docs, a
 * Timestamp on some), else `joinDate`, else null. NEVER the migration time: a
 * record the office has held since March must not read as entered today.
 *
 * WHAT IT NEVER DOES: overwrite a non-empty array (a callable save is the newer
 * decision); bump `updatedAt`; delete the flat fields (they stay readable until
 * the operator verifies this run, and go in a follow-up); invent half a record.
 *
 * Modes: default DRY RUN, prints a per-household diff. `--allow-prod` applies.
 * Runbook: the operator runs the dry run after release, reads it, then applies.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Timestamp } from 'firebase-admin/firestore';
import { recordedAtForLegacy } from '../functions/src/lib/emergencyContacts';
import { normalizeE164 } from '../functions/src/lib/phoneNormalize';

type Mode = 'dry-run' | 'apply';
export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
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
          'backfillKinfolkEmergencyContacts.ts: flat emergencyContact* fields into emergencyContacts[0] (#829)',
          '',
          '  npm run backfill:emergency-contacts                    # DRY RUN (default)',
          '  npm run backfill:emergency-contacts -- --allow-prod    # apply',
          '  npm run backfill:emergency-contacts -- --dry-run       # always wins',
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

export interface MigratedContact {
  name: string;
  phone: string;
  relationship: string | null;
  recordedAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

export type EcPlan =
  | { action: 'migrate'; contact: MigratedContact; dateSource: 'updatedAt' | 'joinDate' | null; phoneCarriedAsTyped: boolean }
  | { action: 'skip'; reason: 'already-has-array' | 'no-flat-fields' }
  | { action: 'report'; reason: 'name-missing' | 'phone-missing' };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** The decision for ONE household. Pure. */
export function planEmergencyContactMigration(kinfolk: Record<string, unknown>): EcPlan {
  const existing = kinfolk['emergencyContacts'];
  if (Array.isArray(existing) && existing.length > 0) return { action: 'skip', reason: 'already-has-array' };
  const name = str(kinfolk['emergencyContactName']);
  const rawPhone = str(kinfolk['emergencyContactPhone']);
  if (name === '' && rawPhone === '') return { action: 'skip', reason: 'no-flat-fields' };
  if (rawPhone === '') return { action: 'report', reason: 'phone-missing' };
  if (name === '') return { action: 'report', reason: 'name-missing' };

  let phone = rawPhone;
  let phoneCarriedAsTyped = false;
  try {
    phone = normalizeE164(rawPhone) ?? rawPhone;
  } catch {
    phoneCarriedAsTyped = true;
  }
  const relationship = str(kinfolk['emergencyContactRelation']) || null;
  const dated = recordedAtForLegacy(kinfolk);
  return {
    action: 'migrate',
    contact: { name, phone, relationship, recordedAt: dated.value, updatedAt: dated.value },
    dateSource: dated.source,
    phoneCarriedAsTyped,
  };
}

export async function buildPlan(db: Firestore): Promise<Array<{ kinfolkId: string; plan: EcPlan }>> {
  const snap = await db.collection('kinfolk').get();
  return snap.docs.map((d) => ({ kinfolkId: d.id, plan: planEmergencyContactMigration(d.data() as Record<string, unknown>) }));
}

function report(rows: Array<{ kinfolkId: string; plan: EcPlan }>, mode: Mode): void {
  const migrate = rows.filter((r) => r.plan.action === 'migrate');
  console.log('');
  console.log(`=== #829 Emergency Contact migration (${mode.toUpperCase()}) ===`);
  console.log(`kinfolk scanned        : ${rows.length}`);
  console.log(`households to migrate  : ${migrate.length}`);
  console.log(`already migrated       : ${rows.filter((r) => r.plan.action === 'skip' && r.plan.reason === 'already-has-array').length}`);
  console.log(`nothing to move        : ${rows.filter((r) => r.plan.action === 'skip' && r.plan.reason === 'no-flat-fields').length}`);
  console.log(`half records (manual)  : ${rows.filter((r) => r.plan.action === 'report').length}`);
  console.log('');
  console.log('-- per household --');
  for (const { kinfolkId, plan } of rows) {
    if (plan.action === 'migrate') {
      const c = plan.contact;
      const when = c.recordedAt ? c.recordedAt.toDate().toISOString() : 'NO DATE (null)';
      console.log(`  kinfolk/${kinfolkId}  emergencyContacts: [] -> [{ name: "${c.name}", phone: "${c.phone}", relationship: ${c.relationship === null ? 'null' : `"${c.relationship}"`}, recordedAt: ${when} (from ${plan.dateSource ?? 'nothing'}) }]`);
      if (plan.phoneCarriedAsTyped) console.log(`    ! phone is not a valid number, carried exactly as typed`);
    } else if (plan.action === 'report') {
      console.log(`  kinfolk/${kinfolkId}  NOT WRITTEN: ${plan.reason}. Fix by hand in the admin.`);
    }
  }
  console.log('');
}

/** Returns how many households were written. Exported for the emulator test. */
export async function applyPlan(db: Firestore, rows: Array<{ kinfolkId: string; plan: EcPlan }>): Promise<number> {
  const targets = rows.filter((r): r is { kinfolkId: string; plan: Extract<EcPlan, { action: 'migrate' }> } => r.plan.action === 'migrate');
  const CHUNK = 200;
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = db.batch();
    for (const t of targets.slice(i, i + CHUNK)) {
      batch.update(db.collection('kinfolk').doc(t.kinfolkId), { emergencyContacts: [t.plan.contact] });
    }
    await batch.commit();
  }
  return targets.length;
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
  const projectId = args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();
  const rows = await buildPlan(db);
  report(rows, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  const n = await applyPlan(db, rows);
  console.log(`APPLIED: ${n} household(s) migrated. Flat fields left in place until verified.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
