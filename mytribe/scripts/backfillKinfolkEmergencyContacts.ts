/**
 * backfillKinfolkEmergencyContacts.ts, #829 section 1 migration.
 *
 *   FROM  kinfolk/{id}   emergencyContactName / emergencyContactPhone / emergencyContactRelation
 *   FROM  families/{id}  customFields[] rows keyed emergencyContactName / Phone / Relation
 *                        (the portal's old store, which the admin never read)
 *   TO    kinfolk/{id}   emergencyContacts[0] = { name, phone, relationship, recordedAt, updatedAt }
 *
 * Precedence for slot 1: a non-empty kinfolk array (a callable save, the newest
 * decision), then the kinfolk flat fields (the office's copy), then the families
 * copy. A families copy is moved only when the kinfolk would otherwise have none.
 *
 * Dates are the ORIGINAL dates, never the migration time (operator ruling
 * 2026-08-04): a kinfolk copy is dated by the doc's `updatedAt`, else `joinDate`;
 * a families copy by the families doc's `updatedAt`. With neither, recordedAt is
 * null and the dry run says "date unknown".
 *
 * WHAT IT DOES TO families: deletes every emergencyContact* row from
 * customFields, in all cases (moved, superseded, half a record), keeping every
 * other row in order. The dry run prints each deleted value verbatim first, so
 * nothing leaves without the operator having seen it. A families doc with no
 * kinfolk doc is reported and left alone: there is nowhere to move it to. So is
 * a household whose kinfolk holds half a flat record: the office started a
 * contact there, the families copy must not paper over it, and the dry run
 * prints both for a person to settle in the admin.
 *
 * WHAT IT NEVER DOES: overwrite a non-empty array; bump `updatedAt` on either
 * doc (that would move the very date it copies); delete the kinfolk flat fields
 * (they stay readable until the operator verifies this run, and go in a
 * follow-up); invent half a record.
 *
 * WHAT A FAILURE LEAVES BEHIND. Both plans are read, and every write is decided
 * and checked, before the first batch commits, so an error in the plan writes
 * nothing. Every update carries the doc's `updateTime` from when the plan read
 * it (`lastUpdateTime`), so a doc someone changed between the dry run and the
 * apply fails its batch instead of being written from a stale read; the run
 * stops and names the docs that changed. A batch is all or nothing, and one
 * household's kinfolk and families writes share a batch, but batches are not
 * one transaction: a batch that fails after others committed leaves those
 * earlier households written. Re-running recovers, because a fresh plan skips a
 * kinfolk that already has the array and a families doc with no stale rows.
 *
 * Modes: default DRY RUN, prints a per-household diff. `--allow-prod` applies.
 * Runbook: the operator runs the dry run after release, reads it, then applies.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { recordedAtForLegacy, timestampFromStored } from '../functions/src/lib/emergencyContacts';
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
          'backfillKinfolkEmergencyContacts.ts: kinfolk flat fields and the families customFields copy into emergencyContacts[0] (#829)',
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

/** One emergencyContact* row as it sits in families customFields. */
export interface CustomFieldRow {
  key: string;
  label: string;
  value: string;
}

export type FamiliesEcPlan =
  | {
      action: 'move';
      contact: MigratedContact;
      dateSource: 'families.updatedAt' | null;
      phoneCarriedAsTyped: boolean;
      /** customFields with the emergencyContact* rows removed, order kept. */
      keep: unknown[];
      stale: CustomFieldRow[];
    }
  | { action: 'strip'; reason: 'kinfolk-has-contacts' | 'kinfolk-flat-wins' | 'half-record'; keep: unknown[]; stale: CustomFieldRow[] }
  | { action: 'report'; reason: 'no-kinfolk-doc'; stale: CustomFieldRow[] }
  | { action: 'report'; reason: 'kinfolk-half-record'; stale: CustomFieldRow[]; kinfolkHalf: { name: string; phone: string } };

export interface KinfolkPlanRow {
  kinfolkId: string;
  plan: EcPlan;
  /** The kinfolk doc's updateTime when the plan read it; every write is conditional on it. */
  updateTime: Timestamp;
}

export interface FamiliesPlanRow {
  kinfolkId: string;
  plan: FamiliesEcPlan;
  familiesUpdateTime: Timestamp;
  /** Null when there is no kinfolk doc (only ever a report, which writes nothing). */
  kinfolkUpdateTime: Timestamp | null;
}

const EC_KEYS = new Set(['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation']);

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isEcRow(f: unknown): f is Record<string, unknown> {
  return typeof f === 'object' && f !== null && EC_KEYS.has(String((f as Record<string, unknown>)['key']));
}

/** E.164 when it parses; otherwise the phone exactly as typed, flagged. */
function normalisePhone(raw: string): { phone: string; phoneCarriedAsTyped: boolean } {
  try {
    return { phone: normalizeE164(raw) ?? raw, phoneCarriedAsTyped: false };
  } catch {
    return { phone: raw, phoneCarriedAsTyped: true };
  }
}

/** The decision for ONE household's kinfolk doc. Pure. */
export function planEmergencyContactMigration(kinfolk: Record<string, unknown>): EcPlan {
  const existing = kinfolk['emergencyContacts'];
  if (Array.isArray(existing) && existing.length > 0) return { action: 'skip', reason: 'already-has-array' };
  const name = str(kinfolk['emergencyContactName']);
  const rawPhone = str(kinfolk['emergencyContactPhone']);
  if (name === '' && rawPhone === '') return { action: 'skip', reason: 'no-flat-fields' };
  if (rawPhone === '') return { action: 'report', reason: 'phone-missing' };
  if (name === '') return { action: 'report', reason: 'name-missing' };

  const { phone, phoneCarriedAsTyped } = normalisePhone(rawPhone);
  const relationship = str(kinfolk['emergencyContactRelation']) || null;
  const dated = recordedAtForLegacy(kinfolk);
  return {
    action: 'migrate',
    contact: { name, phone, relationship, recordedAt: dated.value, updatedAt: dated.value },
    dateSource: dated.source,
    phoneCarriedAsTyped,
  };
}

/**
 * The decision for ONE household's families doc, given its kinfolk doc (null
 * when there is none). Null when customFields hold no emergencyContact* row.
 * Pure.
 */
export function planFamiliesEmergencyContacts(
  families: Record<string, unknown>,
  kinfolk: Record<string, unknown> | null,
): FamiliesEcPlan | null {
  const raw: unknown[] = Array.isArray(families['customFields']) ? (families['customFields'] as unknown[]) : [];
  const staleRows = raw.filter(isEcRow);
  if (staleRows.length === 0) return null;
  const stale: CustomFieldRow[] = staleRows.map((f) => ({
    key: String(f['key']),
    label: typeof f['label'] === 'string' ? f['label'] : '',
    value: typeof f['value'] === 'string' ? f['value'] : '',
  }));
  const keep = raw.filter((f) => !isEcRow(f));

  if (kinfolk === null) return { action: 'report', reason: 'no-kinfolk-doc', stale };
  const kinPlan = planEmergencyContactMigration(kinfolk);
  if (kinPlan.action === 'skip' && kinPlan.reason === 'already-has-array') {
    return { action: 'strip', reason: 'kinfolk-has-contacts', keep, stale };
  }
  if (kinPlan.action === 'migrate') return { action: 'strip', reason: 'kinfolk-flat-wins', keep, stale };
  if (kinPlan.action === 'report') {
    // Half a flat record on the kinfolk: the office started one. Moving the
    // families copy into slot 1 would bury it, so nothing is written for this
    // household and the dry run shows both.
    return {
      action: 'report',
      reason: 'kinfolk-half-record',
      stale,
      kinfolkHalf: { name: str(kinfolk['emergencyContactName']), phone: str(kinfolk['emergencyContactPhone']) },
    };
  }

  const valueOf = (key: string) => str(stale.find((f) => f.key === key)?.value);
  const name = valueOf('emergencyContactName');
  const rawPhone = valueOf('emergencyContactPhone');
  if (name === '' || rawPhone === '') return { action: 'strip', reason: 'half-record', keep, stale };

  const { phone, phoneCarriedAsTyped } = normalisePhone(rawPhone);
  const recordedAt = timestampFromStored(families['updatedAt']);
  return {
    action: 'move',
    contact: { name, phone, relationship: valueOf('emergencyContactRelation') || null, recordedAt, updatedAt: recordedAt },
    dateSource: recordedAt ? 'families.updatedAt' : null,
    phoneCarriedAsTyped,
    keep,
    stale,
  };
}

export async function buildPlan(db: Firestore): Promise<KinfolkPlanRow[]> {
  const snap = await db.collection('kinfolk').get();
  return snap.docs.map((d) => ({
    kinfolkId: d.id,
    plan: planEmergencyContactMigration(d.data() as Record<string, unknown>),
    updateTime: d.updateTime,
  }));
}

/** Only households whose families customFields hold an emergencyContact* row. */
export async function buildFamiliesPlan(db: Firestore): Promise<FamiliesPlanRow[]> {
  const snap = await db.collection('families').get();
  const rows: FamiliesPlanRow[] = [];
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    const fields = data['customFields'];
    if (!Array.isArray(fields) || !fields.some(isEcRow)) continue;
    const kin = await db.collection('kinfolk').doc(d.id).get();
    const plan = planFamiliesEmergencyContacts(data, kin.exists ? ((kin.data() ?? {}) as Record<string, unknown>) : null);
    if (plan) {
      rows.push({ kinfolkId: d.id, plan, familiesUpdateTime: d.updateTime, kinfolkUpdateTime: kin.exists ? (kin.updateTime ?? null) : null });
    }
  }
  return rows;
}

function describeContact(c: MigratedContact, source: string | null): string {
  const when = c.recordedAt ? `${c.recordedAt.toDate().toISOString()} (from ${source})` : 'date unknown (null)';
  return `[{ name: "${c.name}", phone: "${c.phone}", relationship: ${c.relationship === null ? 'null' : `"${c.relationship}"`}, recordedAt: ${when} }]`;
}

function report(rows: KinfolkPlanRow[], families: FamiliesPlanRow[], mode: Mode): void {
  const migrate = rows.filter((r) => r.plan.action === 'migrate');
  console.log('');
  console.log(`=== #829 Emergency Contact migration (${mode.toUpperCase()}) ===`);
  console.log(`kinfolk scanned                 : ${rows.length}`);
  console.log(`households to migrate (kinfolk) : ${migrate.length}`);
  console.log(`already migrated                : ${rows.filter((r) => r.plan.action === 'skip' && r.plan.reason === 'already-has-array').length}`);
  console.log(`nothing to move                 : ${rows.filter((r) => r.plan.action === 'skip' && r.plan.reason === 'no-flat-fields').length}`);
  console.log(`half records (manual)           : ${rows.filter((r) => r.plan.action === 'report').length}`);
  console.log(`families with stale keys        : ${families.length}`);
  console.log(`  moved into kinfolk            : ${families.filter((f) => f.plan.action === 'move').length}`);
  console.log(`  deleted, kinfolk copy kept    : ${families.filter((f) => f.plan.action === 'strip' && f.plan.reason !== 'half-record').length}`);
  console.log(`  deleted, half a record        : ${families.filter((f) => f.plan.action === 'strip' && f.plan.reason === 'half-record').length}`);
  console.log(`  no kinfolk doc (left alone)   : ${families.filter((f) => f.plan.action === 'report' && f.plan.reason === 'no-kinfolk-doc').length}`);
  console.log(`  half kinfolk record (manual)  : ${families.filter((f) => f.plan.action === 'report' && f.plan.reason === 'kinfolk-half-record').length}`);
  console.log('');
  console.log('-- per household (kinfolk) --');
  for (const { kinfolkId, plan } of rows) {
    if (plan.action === 'migrate') {
      console.log(`  kinfolk/${kinfolkId}  emergencyContacts: [] -> ${describeContact(plan.contact, plan.dateSource)}`);
      if (plan.phoneCarriedAsTyped) console.log(`    ! phone is not a valid number, carried exactly as typed`);
    } else if (plan.action === 'report') {
      console.log(`  kinfolk/${kinfolkId}  NOT WRITTEN: ${plan.reason}. Fix by hand in the admin.`);
    }
  }
  console.log('');
  console.log('-- per household (families customFields) --');
  for (const { kinfolkId, plan } of families) {
    const values = plan.stale.map((f) => `${f.key}="${f.value}"`).join(', ');
    if (plan.action === 'move') {
      console.log(`  families/${kinfolkId}  MOVE -> kinfolk/${kinfolkId} emergencyContacts: [] -> ${describeContact(plan.contact, plan.dateSource)}`);
      if (plan.phoneCarriedAsTyped) console.log(`    ! phone is not a valid number, carried exactly as typed`);
      console.log(`    delete from customFields: ${values}`);
    } else if (plan.action === 'strip') {
      console.log(`  families/${kinfolkId}  DELETE (${plan.reason}): ${values}`);
    } else if (plan.reason === 'kinfolk-half-record') {
      console.log(
        `  families/${kinfolkId}  NOT WRITTEN, either doc: kinfolk/${kinfolkId} holds half a record ` +
          `(emergencyContactName="${plan.kinfolkHalf.name}", emergencyContactPhone="${plan.kinfolkHalf.phone}"); ` +
          `families copy: ${values}. Settle it by hand in the admin.`,
      );
    } else {
      console.log(`  families/${kinfolkId}  NOT WRITTEN: ${plan.reason}. Values: ${values}`);
    }
  }
  console.log('');
}

/**
 * Applies both plans. Every write is decided and checked before the first batch
 * commits, and each update is conditional on the doc's updateTime from the plan.
 * A household's kinfolk and families writes share a batch. Returns how many
 * kinfolk docs got a contact and how many families docs were cleaned. See the
 * header for what a failure part way through leaves behind. Exported for the
 * emulator test.
 */
export async function applyPlan(
  db: Firestore,
  rows: KinfolkPlanRow[],
  families: FamiliesPlanRow[] = [],
): Promise<{ migrated: number; familiesCleaned: number }> {
  const kinfolkWrites = new Map<string, { contact: MigratedContact; lastUpdateTime: Timestamp }>();
  for (const r of rows) {
    if (r.plan.action !== 'migrate') continue;
    if (kinfolkWrites.has(r.kinfolkId)) throw new Error(`kinfolk/${r.kinfolkId} appears twice in the plan; nothing was written`);
    kinfolkWrites.set(r.kinfolkId, { contact: r.plan.contact, lastUpdateTime: r.updateTime });
  }
  const familiesWrites = new Map<string, { keep: unknown[]; lastUpdateTime: Timestamp }>();
  for (const f of families) {
    if (f.plan.action === 'report') continue;
    if (familiesWrites.has(f.kinfolkId)) throw new Error(`families/${f.kinfolkId} appears twice in the plan; nothing was written`);
    if (f.plan.action === 'move') {
      if (kinfolkWrites.has(f.kinfolkId)) {
        throw new Error(`kinfolk/${f.kinfolkId} would get both its own and the families contact; nothing was written`);
      }
      if (f.kinfolkUpdateTime === null) {
        throw new Error(`kinfolk/${f.kinfolkId} has no read time in the plan for a move; nothing was written`);
      }
      kinfolkWrites.set(f.kinfolkId, { contact: f.plan.contact, lastUpdateTime: f.kinfolkUpdateTime });
    }
    familiesWrites.set(f.kinfolkId, { keep: f.plan.keep, lastUpdateTime: f.familiesUpdateTime });
  }

  // Rebuild each date from THIS module's Timestamp. The dates are made in
  // functions/src/lib/emergencyContacts.ts, and under vitest that file and this
  // one can hold different loaded instances of firebase-admin, so Firestore
  // refused the lib's Timestamp as "not from the same NPM package". This is why
  // the emulator test had never passed. Under ts-node there is one instance and
  // this is a plain copy.
  const ownTimestamp = (t: Timestamp | null): Timestamp | null => (t === null ? null : new Timestamp(t.seconds, t.nanoseconds));
  for (const [id, w] of kinfolkWrites) {
    kinfolkWrites.set(id, {
      ...w,
      contact: { ...w.contact, recordedAt: ownTimestamp(w.contact.recordedAt), updatedAt: ownTimestamp(w.contact.updatedAt) },
    });
  }

  const households = [...new Set([...kinfolkWrites.keys(), ...familiesWrites.keys()])];
  // At most two writes per household, so 200 households stay under Firestore's 500.
  const CHUNK = 200;
  for (let i = 0; i < households.length; i += CHUNK) {
    const chunk = households.slice(i, i + CHUNK);
    const expected: Array<{ path: string; lastUpdateTime: Timestamp }> = [];
    const batch = db.batch();
    for (const id of chunk) {
      const k = kinfolkWrites.get(id);
      if (k) {
        batch.update(db.collection('kinfolk').doc(id), { emergencyContacts: [k.contact] }, { lastUpdateTime: k.lastUpdateTime });
        expected.push({ path: `kinfolk/${id}`, lastUpdateTime: k.lastUpdateTime });
      }
      const f = familiesWrites.get(id);
      if (f) {
        batch.update(db.collection('families').doc(id), { customFields: f.keep }, { lastUpdateTime: f.lastUpdateTime });
        expected.push({ path: `families/${id}`, lastUpdateTime: f.lastUpdateTime });
      }
    }
    try {
      await batch.commit();
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code !== 9 && !/FAILED_PRECONDITION/i.test(message)) throw err;
      const changed: string[] = [];
      for (const e of expected) {
        const snap = await db.doc(e.path).get();
        if (!snap.exists || !snap.updateTime || !snap.updateTime.isEqual(e.lastUpdateTime)) changed.push(e.path);
      }
      const written = i === 0 ? 'Nothing was written.' : `The ${i} household(s) in earlier batches were written; this batch was not.`;
      throw new Error(
        `STOPPED: ${changed.length > 0 ? changed.join(', ') : 'a doc in this batch'} changed after the plan was read. ` +
          `${written} Re-run the dry run, read it, then apply again.`,
      );
    }
  }
  return { migrated: kinfolkWrites.size, familiesCleaned: familiesWrites.size };
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
  const families = await buildFamiliesPlan(db);
  report(rows, families, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  const { migrated, familiesCleaned } = await applyPlan(db, rows, families);
  console.log(`APPLIED: ${migrated} household(s) given an Emergency Contact, ${familiesCleaned} families doc(s) cleaned. Kinfolk flat fields left in place until verified.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
