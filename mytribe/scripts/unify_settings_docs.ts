/**
 * unify_settings_docs.ts
 *
 * One-time, idempotent, OPERATOR-GATED Firestore migration that merges
 * `admin_settings/admin_settings` INTO `business_settings/business_settings`
 * for project auntieos-ttpc.
 *
 * Spec / binding contract:
 *   AuntieOS/docs/2026-06-05-settings-unification-design.md
 *   sections "Conflict resolution for the one-time migration" and
 *   "Work breakdown" item 3.
 *
 * Conflict rules (see mergeSettings below):
 *   - booking-config + timeBlocks + timeZone : take from admin_settings (its home).
 *   - businessName/email/phone               : business_settings wins if non-empty,
 *                                              else admin_settings.
 *   - everything else                         : keep business_settings value.
 *   - never delete: result is the UNION of keys.
 *   - idempotent: re-running after a successful merge is a no-op.
 *
 * Safety:
 *   - Refuses to run without GOOGLE_APPLICATION_CREDENTIALS (fail-loud, ADC).
 *   - BACKUP FIRST: before any write, dumps BOTH source docs to a timestamped
 *     local JSON file. No write proceeds if the backup fails (fail-loud).
 *   - DRY-RUN BY DEFAULT: without --apply, prints the computed result + diff and
 *     writes nothing.
 *   - --apply performs a MERGE write (SetOptions merge) to business_settings.
 *     admin_settings is left intact (read-only) for rollback.
 *   - Never fabricates data: if a source doc is absent, that is reported and the
 *     merge proceeds from whatever real data exists (missing admin doc => no-op).
 *
 * Modes:
 *   default        : dry-run, prints planned merge + diff, no writes
 *   --apply        : performs the merge write to business_settings
 *
 * Operator run commands:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/auntieos-ttpc-sa.json
 *   # 1. dry-run (also writes the backup JSON):
 *   ts-node --project ../scripts/tsconfig.json ../scripts/unify_settings_docs.ts
 *   # 2. apply (re-takes a fresh backup, then merges):
 *   ts-node --project ../scripts/tsconfig.json ../scripts/unify_settings_docs.ts --apply
 */

import { getApps, initializeApp, applicationDefault, getApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import * as fs from 'fs';
import * as path from 'path';

type Mode = 'dry-run' | 'apply';

export const BUSINESS_DOC_PATH = 'business_settings/business_settings';
export const ADMIN_DOC_PATH = 'admin_settings/admin_settings';

/** Generic Firestore-shaped record. */
export type SettingsDoc = Record<string, unknown>;

/**
 * Keys whose authoritative home is admin_settings. When admin_settings has the
 * key, its value wins (booking-config + timeBlocks + timeZone). When it does not
 * have the key, the business_settings value (if any) is preserved.
 */
export const ADMIN_AUTHORITATIVE_KEYS: readonly string[] = [
  // booking / scheduling config
  'defaultBookingMode',
  'defaultCalendarView',
  'allowTimeBlockBooking',
  'allowSpecificTimeBooking',
  'enableConflictDetection',
  'enableAutoReminder24h',
  'defaultTimeBlockDurationHours',
  'travelBufferMinutes',
  'observeUsHolidays',
  // time blocks (element key is `active`, preserved as-is from admin_settings)
  'timeBlocks',
  // time zone
  'timeZone',
];

/**
 * Business-profile keys: business_settings value wins IF it is a non-empty
 * string, otherwise the admin_settings value is used.
 */
export const PROFILE_PREFER_BUSINESS_KEYS: readonly string[] = [
  'businessName',
  'businessEmail',
  'businessPhone',
  // legacy aliases some docs used before the canonical names landed
  'email',
  'phone',
];

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Pure merge of admin_settings INTO business_settings per the design-doc
 * conflict rules. No Firestore, no I/O. Returns a NEW object (inputs untouched).
 *
 * Rules:
 *   1. Start from a shallow copy of businessDoc (keep all its keys).
 *   2. For every key present in adminDoc that is NOT handled by a special rule,
 *      keep the businessDoc value if present, else take the admin value
 *      (union of keys, business wins on plain overlap).
 *   3. ADMIN_AUTHORITATIVE_KEYS: admin value wins whenever admin has the key.
 *   4. PROFILE_PREFER_BUSINESS_KEYS: business value wins if non-empty string,
 *      else admin value (when admin has it).
 *
 * Idempotent: mergeSettings(mergeSettings(b, a), a) deep-equals
 * mergeSettings(b, a), because after one pass the authoritative keys already
 * equal the admin values and profile keys are non-empty (or stay absent).
 */
export function mergeSettings(businessDoc: SettingsDoc, adminDoc: SettingsDoc): SettingsDoc {
  const business = businessDoc ?? {};
  const adminSrc = adminDoc ?? {};

  // 1. Base: copy all business keys (never delete a business-owned field).
  const result: SettingsDoc = { ...business };

  const authoritative = new Set(ADMIN_AUTHORITATIVE_KEYS);
  const profile = new Set(PROFILE_PREFER_BUSINESS_KEYS);

  // 2. Union: bring over any admin-only keys that no special rule covers, but
  //    let business win on plain overlap.
  for (const key of Object.keys(adminSrc)) {
    if (authoritative.has(key) || profile.has(key)) continue;
    if (!(key in result)) {
      result[key] = adminSrc[key];
    }
    // else: plain overlap, business value already in result (keep it).
  }

  // 3. Admin-authoritative keys: admin wins whenever admin has the key.
  for (const key of ADMIN_AUTHORITATIVE_KEYS) {
    if (key in adminSrc) {
      result[key] = adminSrc[key];
    }
    // else: leave whatever business had (may be absent).
  }

  // 4. Profile keys: business wins if non-empty string, else admin (if present).
  for (const key of PROFILE_PREFER_BUSINESS_KEYS) {
    const bVal = business[key];
    if (isNonEmptyString(bVal)) {
      result[key] = bVal;
    } else if (key in adminSrc) {
      result[key] = adminSrc[key];
    }
    // else: neither has a usable value, leave as-is (may be absent or blank).
  }

  return result;
}

/** Stable JSON for deep-equality / no-op detection (sorted keys, recursive). */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * True when the merge would change nothing about the business doc (already
 * merged). Used for the idempotency / no-op report.
 */
export function isAlreadyMerged(businessDoc: SettingsDoc, adminDoc: SettingsDoc): boolean {
  const merged = mergeSettings(businessDoc, adminDoc);
  return stableStringify(merged) === stableStringify(businessDoc ?? {});
}

/** Lists the keys whose value the merge would change vs the current business doc. */
export function changedKeys(businessDoc: SettingsDoc, adminDoc: SettingsDoc): string[] {
  const merged = mergeSettings(businessDoc, adminDoc);
  const business = businessDoc ?? {};
  const keys = new Set([...Object.keys(business), ...Object.keys(merged)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (stableStringify(merged[k]) !== stableStringify(business[k])) changed.push(k);
  }
  return changed.sort();
}

function parseMode(argv: string[]): Mode {
  return argv.includes('--apply') ? 'apply' : 'dry-run';
}

function initAdmin(): void {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      'GOOGLE_APPLICATION_CREDENTIALS not set. Export the auntieos-ttpc service-account key path before running.',
    );
  }
  if (!getApps().length) {
    initializeApp({ credential: applicationDefault() });
  }
}

function timestampRunId(): string {
  // 2026-06-05T09-20-03-123Z, filesystem-safe.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

interface BackupPayload {
  runId: string;
  project: string;
  takenAt: string;
  business: { path: string; exists: boolean; data: SettingsDoc | null };
  admin: { path: string; exists: boolean; data: SettingsDoc | null };
}

/**
 * Dumps both source docs to a timestamped local JSON file BEFORE any write.
 * Throws (fail-loud) if the file cannot be written. Returns the absolute path.
 */
function writeBackup(payload: BackupPayload): string {
  const dir = path.resolve(__dirname, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `settings_pre_unify_${payload.runId}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  // Read it back to prove the bytes landed (fail-loud if not).
  const roundTrip = fs.readFileSync(file, 'utf8');
  if (!roundTrip || roundTrip.length === 0) {
    throw new Error(`Backup file ${file} is empty after write. Aborting before any Firestore write.`);
  }
  return file;
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const runId = timestampRunId();
  console.log(`unify_settings_docs  mode=${mode}  runId=${runId}`);
  initAdmin();

  const db = getFirestore();
  const [businessSnap, adminSnap] = await Promise.all([
    db.doc(BUSINESS_DOC_PATH).get(),
    db.doc(ADMIN_DOC_PATH).get(),
  ]);

  const businessData = (businessSnap.exists ? businessSnap.data() : {}) as SettingsDoc;
  const adminData = (adminSnap.exists ? adminSnap.data() : {}) as SettingsDoc;

  console.log(`  business_settings exists=${businessSnap.exists}  keys=${Object.keys(businessData).length}`);
  console.log(`  admin_settings    exists=${adminSnap.exists}  keys=${Object.keys(adminData).length}`);

  if (!adminSnap.exists) {
    console.log(
      '\nadmin_settings/admin_settings does not exist. Nothing to merge in. ' +
        'This is treated as already-merged (no-op).',
    );
  }

  // BACKUP FIRST, always, before any write path. Fail-loud on failure.
  const projectId = (getApp().options as { projectId?: string }).projectId ?? process.env.GCLOUD_PROJECT ?? 'unknown';
  const backupPath = writeBackup({
    runId,
    project: projectId,
    takenAt: new Date().toISOString(),
    business: { path: BUSINESS_DOC_PATH, exists: businessSnap.exists, data: businessSnap.exists ? businessData : null },
    admin: { path: ADMIN_DOC_PATH, exists: adminSnap.exists, data: adminSnap.exists ? adminData : null },
  });
  console.log(`  backup written: ${backupPath}`);

  const merged = mergeSettings(businessData, adminData);
  const noop = isAlreadyMerged(businessData, adminData);
  const changed = changedKeys(businessData, adminData);

  console.log('\n=== Merge plan ===');
  console.log(`  already merged (no-op): ${noop}`);
  console.log(`  changed keys (${changed.length}): ${changed.join(', ') || '(none)'}`);
  for (const k of changed) {
    console.log(`    ${k}:`);
    console.log(`      from: ${stableStringify((businessData as SettingsDoc)[k])}`);
    console.log(`      to  : ${stableStringify((merged as SettingsDoc)[k])}`);
  }

  if (mode !== 'apply') {
    console.log('\nDRY-RUN. No Firestore writes performed. Re-run with --apply to commit the merge.');
    return;
  }

  if (noop) {
    console.log('\n--apply requested but the merge is a no-op (already merged). No write performed.');
    return;
  }

  // MERGE write only the changed keys (merge:true never deletes siblings).
  const patch: SettingsDoc = {};
  for (const k of changed) patch[k] = (merged as SettingsDoc)[k];
  await db.doc(BUSINESS_DOC_PATH).set(patch, { merge: true });
  console.log(`\nAPPLIED. Merge-wrote ${changed.length} key(s) to ${BUSINESS_DOC_PATH}.`);
  console.log('admin_settings/admin_settings left intact (read-only) for rollback.');

  // Best-effort audit row (unchained, like the other operator scripts).
  await db.collection('activity_log').add({
    timestamp: new Date().toISOString(),
    actionType: 'UNIFY_SETTINGS_DOCS',
    description: `merged admin_settings into business_settings (changed ${changed.length} keys)`,
    status: 'SUCCESS',
    actorId: 'system:unify_settings_docs',
    targetId: 'business_settings',
    targetCollection: 'business_settings',
    severity: 'info',
    actorRole: 'SYSTEM',
    payload: { runId, changedKeys: changed, backupPath },
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log('Wrote activity_log entry (UNCHAINED: runs outside the writeAuditEntry server callable).');
}

// Only auto-run when invoked directly, not when imported by tests.
const isMain = require.main === module;
if (isMain) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
