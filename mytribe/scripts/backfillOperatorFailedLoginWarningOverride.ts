/**
 * backfillOperatorFailedLoginWarningOverride.ts
 *
 * Carries the operator's Business-tab setting for the 5-failure warning over to
 * the key that now sends it (issue #877).
 *
 * WHAT CHANGED. Before #877, `auth.failedLogin.attempts` served two audiences
 * (`audiences: { kinfolk: true, business: true }`) and reached business admins
 * through `secondaryResolver: 'businessAdmins'`. It therefore showed on the
 * Business tab, and an operator could save an override for it there
 * (`saveBusinessNotificationOverrideHandler`, admin/notificationOverrides.ts).
 * The dispatcher applied that override to the operator copy on the business
 * stream (`resolveChannels` -> `overrideForStream(override, 'business')`,
 * notifications/prefs.ts).
 *
 * #877 split the operator copy into `security.failedLogin.attempts.operator`
 * and made the old key kinfolk-only. The operator copy now reads the NEW key's
 * override, so an operator who had turned the warning off, or turned a channel
 * off, would silently start receiving it again.
 *
 * WHAT THIS COPIES. From `businessSettings/notifications.byKey`, the business
 * view of the old key's override: `enabled` and `channels`, with the
 * `streams.business` overlay winning field by field over the flat fields,
 * exactly as `overrideForStream` resolves it. It is written as the new key's
 * flat `enabled` and `channels`, because the new key serves the business
 * stream only.
 *
 * WHAT IT NEVER DOES.
 *   - It never overwrites an override the new key already has. The check runs
 *     again inside the write transaction, so a save made between the dry run
 *     and the write wins.
 *   - It never edits or deletes the old key's override. The household copy
 *     still reads its flat fields on the kinfolk stream.
 *   - It copies nothing when the old key's business view is the catalog
 *     default (enabled, no channel set), so no row turns "customized" for
 *     nothing.
 *   - Locks (`lockedEnabled`, `locked`) and `lockReason` are not copied. They
 *     are reported when present, so the operator can re-set them by hand.
 *
 * Modes:
 *   default           DRY RUN. Prints the target, the doc, each value, and the
 *                     planned write. Writes nothing.
 *   --allow-prod      writes to production. Refused while FIRESTORE_EMULATOR_HOST
 *                     is set, so an emulator shell can never be mistaken for prod.
 *   --emulator-write  writes to the emulator. Refused unless
 *                     FIRESTORE_EMULATOR_HOST is set.
 *   --dry-run         forces the dry run, and BEATS both write flags in either order.
 *   --project <id>    project override.
 *
 * RUNBOOK (the operator runs this after the release that contains #877, and
 * after importing the #877 template; it cannot be run from an agent session):
 *
 *   0. npm run test:scripts:emulator
 *   1. npm --prefix mytribe/functions run backfill:operator-warning-override
 *      Reads only. Check the printed target, the old value, and the planned value.
 *   2. npm --prefix mytribe/functions run backfill:operator-warning-override -- --allow-prod
 *      Writes. Needs GOOGLE_APPLICATION_CREDENTIALS.
 *   3. Re-run step 1. A clean second run reports `target-exists` (or the same
 *      no-op it reported before).
 */
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';

export const SETTINGS_COLLECTION = 'businessSettings';
export const SETTINGS_DOC = 'notifications';
export const OVERRIDES_PATH = `${SETTINGS_COLLECTION}/${SETTINGS_DOC}`;
/** The household key whose business-stream override is the source. Hard-coded on purpose; the unit test pins it to the catalog. */
export const SOURCE_KEY = 'auth.failedLogin.attempts';
/** The operator key #877 added. */
export const TARGET_KEY = 'security.failedLogin.attempts.operator';

export const CHANNELS = ['email', 'sms', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface CopiedOverride {
  enabled: boolean;
  channels: Partial<Record<Channel, boolean>>;
}

type Loose = Record<string, unknown>;

function asRecord(v: unknown): Loose | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : undefined;
}

/**
 * The business stream's view of a stored override: `enabled` and `channels`,
 * the `streams.business` overlay first and the flat field second, field by
 * field. Mirrors `overrideForStream` in functions/src/notifications/prefs.ts;
 * the unit test checks the two agree. Null when neither field holds a boolean.
 */
export function businessView(stored: unknown): CopiedOverride | null {
  const flat = asRecord(stored);
  if (!flat) return null;
  const overlay = asRecord(asRecord(flat['streams'])?.['business']);
  const pick = (a: unknown, b: unknown): boolean | undefined =>
    typeof a === 'boolean' ? a : typeof b === 'boolean' ? b : undefined;

  const enabled = pick(overlay?.['enabled'], flat['enabled']);
  const channels: Partial<Record<Channel, boolean>> = {};
  for (const ch of CHANNELS) {
    const v = pick(asRecord(overlay?.['channels'])?.[ch], asRecord(flat['channels'])?.[ch]);
    if (v !== undefined) channels[ch] = v;
  }
  if (enabled === undefined && Object.keys(channels).length === 0) return null;
  return { enabled: enabled ?? true, channels };
}

/** Lock fields on the source override that this script does not copy, for the report. */
export function uncopiedFields(stored: unknown): string[] {
  const flat = asRecord(stored);
  if (!flat) return [];
  const out: string[] = [];
  if (flat['lockedEnabled'] !== undefined) out.push('lockedEnabled');
  if (flat['locked'] !== undefined) out.push('locked');
  if (flat['lockReason'] !== undefined) out.push('lockReason');
  const overlay = asRecord(asRecord(flat['streams'])?.['business']);
  if (overlay?.['lockedEnabled'] !== undefined) out.push('streams.business.lockedEnabled');
  if (overlay?.['locked'] !== undefined) out.push('streams.business.locked');
  return out;
}

export type Plan =
  | { action: 'no-doc' }
  | { action: 'no-source' }
  | { action: 'target-exists'; source: unknown; existing: unknown }
  | { action: 'default-only'; source: unknown }
  | { action: 'copy'; source: unknown; value: CopiedOverride };

/** What to do, given the overrides doc as stored. Pure. */
export function planCopy(docData: unknown, docExists: boolean): Plan {
  if (!docExists) return { action: 'no-doc' };
  const byKey = asRecord(asRecord(docData)?.['byKey']) ?? {};
  const source = byKey[SOURCE_KEY];
  if (source === undefined) return { action: 'no-source' };
  const existing = byKey[TARGET_KEY];
  if (existing !== undefined) return { action: 'target-exists', source, existing };
  const view = businessView(source);
  if (!view || (view.enabled && Object.keys(view.channels).length === 0)) {
    return { action: 'default-only', source };
  }
  return { action: 'copy', source, value: view };
}

type Mode = 'dry-run' | 'allow-prod' | 'emulator-write';

export interface Args {
  mode: Mode;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  let allowProd = false;
  let emulatorWrite = false;
  let explicitDryRun = false;
  let projectId: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') allowProd = true;
    else if (a === '--emulator-write') emulatorWrite = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillOperatorFailedLoginWarningOverride.ts: copy the Business-tab override (#877)',
          '',
          '  npm --prefix mytribe/functions run backfill:operator-warning-override                  # DRY RUN (default)',
          '  npm --prefix mytribe/functions run backfill:operator-warning-override -- --allow-prod  # write to prod',
          '  npm --prefix mytribe/functions run backfill:operator-warning-override -- --emulator-write',
          '',
          '--dry-run overrides both write flags regardless of flag order.',
          '--allow-prod is refused while FIRESTORE_EMULATOR_HOST is set.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (allowProd && emulatorWrite) throw new Error('--allow-prod and --emulator-write cannot be combined');
  let mode: Mode = 'dry-run';
  if (!explicitDryRun && allowProd) mode = 'allow-prod';
  if (!explicitDryRun && emulatorWrite) mode = 'emulator-write';
  return { mode, projectId };
}

export interface Env {
  FIRESTORE_EMULATOR_HOST?: string;
  GOOGLE_APPLICATION_CREDENTIALS?: string;
  GCLOUD_PROJECT?: string;
  GOOGLE_CLOUD_PROJECT?: string;
}

/**
 * Checks the flags against the environment and names the target, before any
 * Firestore call. Throws on every combination that could write somewhere the
 * operator did not mean.
 */
export function describeTarget(args: Args, env: Env): { projectId: string | null; line: string } {
  const emulator = env.FIRESTORE_EMULATOR_HOST;
  const projectId = args.projectId ?? env.GCLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? null;
  if (args.mode === 'allow-prod' && emulator) {
    throw new Error(
      `refusing --allow-prod while FIRESTORE_EMULATOR_HOST is set (${emulator}): this shell points at an emulator. ` +
        'Unset it for a production write, or use --emulator-write.',
    );
  }
  if (args.mode === 'emulator-write' && !emulator) {
    throw new Error('refusing --emulator-write: FIRESTORE_EMULATOR_HOST is not set');
  }
  if (args.mode === 'allow-prod' && !env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('a production write needs GOOGLE_APPLICATION_CREDENTIALS (fail loud, not a silent no-op)');
  }
  const where = emulator
    ? `EMULATOR ${emulator}`
    : 'PRODUCTION';
  const project = projectId ?? '(project from credentials)';
  return { projectId, line: `TARGET: ${where}, project ${project}, doc ${OVERRIDES_PATH}, mode ${args.mode.toUpperCase()}` };
}

/** Reads the doc and plans. Reads only. */
export async function buildPlan(db: Firestore): Promise<Plan> {
  const snap = await db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC).get();
  return planCopy(snap.data(), snap.exists);
}

/**
 * Re-reads the doc inside a transaction and writes only when that fresh read
 * still plans a copy. Returns the plan it acted on, so a caller can see that an
 * operator save in between turned it into `target-exists`.
 */
export async function applyCopy(db: Firestore, nowMs: number = Date.now()): Promise<Plan> {
  const ref = db.collection(SETTINGS_COLLECTION).doc(SETTINGS_DOC);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const plan = planCopy(snap.data(), snap.exists);
    if (plan.action !== 'copy') return plan;
    // merge: true merges into the byKey map, so every other key's override stays.
    tx.set(ref, { byKey: { [TARGET_KEY]: plan.value }, updatedAtMs: nowMs }, { merge: true });
    return plan;
  });
}

function show(v: unknown): string {
  return JSON.stringify(v);
}

export function report(plan: Plan, log: (line: string) => void = console.log): void {
  log(`doc ${OVERRIDES_PATH}`);
  switch (plan.action) {
    case 'no-doc':
      log('  the doc does not exist: no business overrides were ever saved. Nothing to copy.');
      return;
    case 'no-source':
      log(`  byKey['${SOURCE_KEY}']: absent. The operator never set it. Nothing to copy.`);
      return;
    case 'target-exists':
      log(`  byKey['${SOURCE_KEY}']: ${show(plan.source)}`);
      log(`  byKey['${TARGET_KEY}']: ${show(plan.existing)}`);
      log('  the new key already has an override. LEFT ALONE, never overwritten.');
      return;
    case 'default-only':
      log(`  byKey['${SOURCE_KEY}']: ${show(plan.source)}`);
      log(`  business view: ${show(businessView(plan.source))}`);
      log('  the business view is the catalog default (enabled, no channel set). Nothing to copy.');
      return;
    case 'copy': {
      log(`  byKey['${SOURCE_KEY}']: ${show(plan.source)}`);
      log(`  business view: ${show(plan.value)}`);
      log(`  byKey['${TARGET_KEY}']: absent`);
      log(`  WRITE byKey['${TARGET_KEY}'] = ${show(plan.value)}`);
      const skipped = uncopiedFields(plan.source);
      if (skipped.length > 0) {
        log(`  NOT COPIED (re-set by hand on the Business tab if still wanted): ${skipped.join(', ')}`);
      }
      return;
    }
    default: {
      const never: never = plan;
      throw new Error(`unknown plan ${show(never)}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = describeTarget(args, process.env as Env);
  console.log(target.line);
  if (getApps().length === 0) initializeApp(target.projectId ? { projectId: target.projectId } : {});
  const db = getFirestore();

  const plan = await buildPlan(db);
  report(plan);
  if (args.mode === 'dry-run') {
    console.log(
      plan.action === 'copy'
        ? 'DRY RUN: nothing was written. Re-run with --allow-prod to write the value above.'
        : 'DRY RUN: nothing was written, and a write run would write nothing either.',
    );
    return;
  }
  const applied = await applyCopy(db);
  if (applied.action === 'copy') {
    console.log(`WROTE byKey['${TARGET_KEY}'] = ${show(applied.value)}`);
  } else {
    console.log(`WROTE NOTHING: the doc re-read at write time planned '${applied.action}'.`);
  }
  console.log('Re-run without a write flag to confirm it now reports target-exists.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
