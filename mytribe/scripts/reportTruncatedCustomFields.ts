/**
 * reportTruncatedCustomFields.ts
 *
 * READ-ONLY. Answers, as far as the stored data allows, one question for issue
 * #873: which households already lost `customFields` rows to a portal save?
 *
 * Before #873, when an admin had authored a form schema, portal web and portal
 * Android rebuilt `customFields` from the schema keys alone, and
 * `saveTribeProfile` / `saveHomeAccess` replaced the stored list whole. Every
 * stored row outside the schema was deleted on the household's next save.
 *
 * NOTHING RECORDS THE BEFORE-STATE, so "shrank" cannot be measured directly:
 *   - `activity_log` PROFILE_UPDATED entries (saveTribeProfile) carry the field
 *     NAMES that were written (`payload.fields`), never the old or new rows;
 *   - `saveHomeAccess` writes no audit entry at all, only a Cloud Logging line
 *     with field names;
 *   - Firestore keeps no document history this script can read.
 * So this reports households whose rows LOOK truncated: the list is exactly what
 * the old rebuild wrote. Every key is a schema key or a reserved card key, AND
 * every schema key is present (the rebuild wrote all of them, '' for untouched
 * ones). A household that genuinely only ever had those rows looks the same,
 * which is why each finding carries its evidence of a portal save:
 *   - families: a PROFILE_UPDATED entry whose `payload.fields` includes
 *     `customFields`;
 *   - homeAccess: `updatedByUid` on the doc, which only saveHomeAccess writes.
 * The schemas are read as they are NOW; a household truncated under an older
 * schema version is not recognised.
 *
 * NOTHING PRIVATE IS PRINTED. Output is household ids, document paths, row KEYS
 * and times. Never a value: home access rows hold gate and alarm codes.
 *
 * TARGET. With FIRESTORE_EMULATOR_HOST set it reads the emulator. Without it,
 * it reads production and requires --allow-prod. --allow-prod with
 * FIRESTORE_EMULATOR_HOST set is refused, because the two disagree about where
 * the reads go. The target is printed before anything is read.
 *
 * Usage (the operator runs this against prod; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:truncated-custom-fields -- --project auntieos-ttpc --allow-prod
 *   npm --prefix mytribe/functions run report:truncated-custom-fields -- --project auntieos-ttpc --allow-prod --samples 200
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846).
import { getApps, initializeApp, getFirestore, type Firestore, type QueryDocumentSnapshot } from './lib/firebaseAdmin';

/** Card rows the portal writes beside the schema rows. Mirrors web tribeApi.ts and TribeScreen.kt. */
export const PROFILE_RESERVED_KEYS = [
  'vetClinicId',
  'vetClinicName',
  'vetClinicPhone',
  'vetClinicAddress',
  // #829: carried through every save until the migration moves them.
  'emergencyContactName',
  'emergencyContactPhone',
  'emergencyContactRelation',
] as const;
export const HOME_RESERVED_KEYS = ['afterHoursVetName', 'afterHoursVetPhone'] as const;
/** Schema keys that are saved as top-level fields, never as customFields rows. */
export const PROFILE_SCHEMA_TOP_LEVEL = ['displayName'] as const;
export const HOME_SCHEMA_TOP_LEVEL = ['gateCode', 'keyLocation', 'wifiPassword'] as const;

const PAGE = 500;
const LOOKUP_CHUNK = 100;

export interface Args {
  projectId: string | null;
  allowProd: boolean;
  samples: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false, samples: 50 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = (): string => {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      i += 1;
      return v;
    };
    if (a === '--project') args.projectId = value();
    else if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--samples') {
      const v = value();
      if (!/^\d+$/.test(v)) throw new Error(`--samples must be a whole number, got '${v}'`);
      args.samples = Number(v);
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'reportTruncatedCustomFields.ts: READ-ONLY report of customFields that look truncated by a portal save (#873)',
          '',
          '  npm --prefix mytribe/functions run report:truncated-custom-fields -- --project <id> --allow-prod',
          '  FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm --prefix mytribe/functions run report:truncated-custom-fields -- --project <id>',
          '',
          'Writes nothing. Prints ids, paths, row keys and times only.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

export type Target = { kind: 'emulator'; host: string; projectId: string | null } | { kind: 'production'; projectId: string | null };

export function describeTarget(args: Args, env: Record<string, string | undefined>): string {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  const project = args.projectId ?? '(default credentials project)';
  return host ? `EMULATOR at ${host}, project ${project}` : `PRODUCTION Firestore, project ${project}`;
}

/** Throws when the flags and the environment disagree about where reads go. */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  if (host && args.allowProd) {
    throw new Error(
      `--allow-prod refused: FIRESTORE_EMULATOR_HOST is set (${host}), so the reads would go to the emulator, not production. ` +
        'Unset FIRESTORE_EMULATOR_HOST to read production, or drop --allow-prod to read the emulator.',
    );
  }
  if (host) return { kind: 'emulator', host, projectId: args.projectId };
  if (!args.allowProd) {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set, so this would read PRODUCTION. Pass --allow-prod to confirm.');
  }
  return { kind: 'production', projectId: args.projectId };
}

/** Every field key in a stored `formSchemas/{id}` doc, in schema order. */
export function schemaFieldKeys(schemaDoc: unknown): string[] {
  const sections = (schemaDoc as { sections?: unknown } | null | undefined)?.sections;
  if (!Array.isArray(sections)) return [];
  const keys: string[] = [];
  for (const section of sections) {
    const fields = (section as { fields?: unknown } | null)?.fields;
    if (!Array.isArray(fields)) continue;
    for (const f of fields) {
      const key = (f as { key?: unknown } | null)?.key;
      if (typeof key === 'string' && key !== '') keys.push(key);
    }
  }
  return keys;
}

export interface RowsVerdict {
  /** Row keys in stored order. */
  keys: string[];
  /** The list is exactly what the pre-#873 schema rebuild wrote. */
  looksTruncated: boolean;
  /** Schema rows stored with '' (the rebuild wrote untouched fields that way). */
  emptySchemaValues: number;
}

export function classifyRows(
  rows: unknown,
  schemaKeys: readonly string[],
  reservedKeys: readonly string[],
  topLevelKeys: readonly string[],
): RowsVerdict {
  const list = Array.isArray(rows) ? rows : [];
  const editable = schemaKeys.filter((k) => !topLevelKeys.includes(k));
  const allowed = new Set([...editable, ...reservedKeys]);
  const keys: string[] = [];
  let unreadable = 0;
  let emptySchemaValues = 0;
  for (const entry of list) {
    const key = (entry as { key?: unknown } | null)?.key;
    if (typeof key !== 'string') {
      unreadable += 1;
      continue;
    }
    keys.push(key);
    if (editable.includes(key) && (entry as { value?: unknown }).value === '') emptySchemaValues += 1;
  }
  const looksTruncated =
    editable.length > 0 && unreadable === 0 && keys.every((k) => allowed.has(k)) && editable.every((k) => keys.includes(k));
  return { keys, looksTruncated, emptySchemaValues };
}

export interface Finding {
  surface: 'families' | 'homeAccess';
  kinfolkId: string;
  path: string;
  keys: string[];
  emptySchemaValues: number;
  /** Evidence a portal save wrote this list (see the header). */
  portalSave: boolean;
  /** Last portal save time on record (ISO-8601), when known. */
  lastPortalSaveAt: string | null;
}

export interface Report {
  schemas: { tribeProfile: string[]; homeAccess: string[] };
  scannedFamilies: number;
  scannedHomeAccess: number;
  auditCustomFieldSaves: number;
  findings: Finding[];
}

function isoOf(v: unknown): string | null {
  if (typeof v === 'string' && v !== '') return v;
  if (v && typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

/** kinfolkId -> latest PROFILE_UPDATED time for saves that wrote customFields. */
async function profileSavesWithCustomFields(db: Firestore): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('activity_log').where('actionType', '==', 'PROFILE_UPDATED').orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) {
      const d = doc.data() as Record<string, unknown>;
      const fields = (d['payload'] as { fields?: unknown } | undefined)?.fields;
      if (!Array.isArray(fields) || !fields.includes('customFields')) continue;
      const id = typeof d['targetId'] === 'string' ? d['targetId'] : '';
      if (id === '') continue;
      const at = isoOf(d['timestamp']);
      const prev = out.get(id);
      out.set(id, prev == null || (at !== null && at > prev) ? at : prev);
    }
    if (snap.size < PAGE) return out;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) return out;
  }
}

/** Reads the two schemas, the audit log, every family and its homeAccess/current. Writes nothing. */
export async function buildReport(db: Firestore): Promise<Report> {
  const [profileSchemaSnap, homeSchemaSnap] = await Promise.all([db.doc('formSchemas/tribeProfile').get(), db.doc('formSchemas/homeAccess').get()]);
  const schemas = { tribeProfile: schemaFieldKeys(profileSchemaSnap.data()), homeAccess: schemaFieldKeys(homeSchemaSnap.data()) };
  const saves = await profileSavesWithCustomFields(db);

  const findings: Finding[] = [];
  let scannedFamilies = 0;
  let scannedHomeAccess = 0;
  let cursor: QueryDocumentSnapshot | null = null;
  for (;;) {
    let q = db.collection('families').orderBy('__name__').limit(PAGE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    scannedFamilies += snap.size;
    for (const doc of snap.docs) {
      const v = classifyRows((doc.data() as Record<string, unknown>)['customFields'], schemas.tribeProfile, PROFILE_RESERVED_KEYS, PROFILE_SCHEMA_TOP_LEVEL);
      if (!v.looksTruncated) continue;
      findings.push({
        surface: 'families',
        kinfolkId: doc.id,
        path: doc.ref.path,
        keys: v.keys,
        emptySchemaValues: v.emptySchemaValues,
        portalSave: saves.has(doc.id),
        lastPortalSaveAt: saves.get(doc.id) ?? null,
      });
    }
    for (let i = 0; i < snap.docs.length; i += LOOKUP_CHUNK) {
      const refs = snap.docs.slice(i, i + LOOKUP_CHUNK).map((d) => d.ref.collection('homeAccess').doc('current'));
      for (const home of await db.getAll(...refs)) {
        if (!home.exists) continue;
        scannedHomeAccess += 1;
        const data = home.data() as Record<string, unknown>;
        const v = classifyRows(data['customFields'], schemas.homeAccess, HOME_RESERVED_KEYS, HOME_SCHEMA_TOP_LEVEL);
        if (!v.looksTruncated) continue;
        const byUid = typeof data['updatedByUid'] === 'string' && data['updatedByUid'] !== '';
        findings.push({
          surface: 'homeAccess',
          kinfolkId: home.ref.parent.parent?.id ?? '',
          path: home.ref.path,
          keys: v.keys,
          emptySchemaValues: v.emptySchemaValues,
          portalSave: byUid,
          lastPortalSaveAt: byUid ? isoOf(data['updatedAt']) : null,
        });
      }
    }
    if (snap.size < PAGE) break;
    cursor = snap.docs[snap.size - 1] ?? null;
    if (!cursor) break;
  }
  findings.sort((a, b) => Number(b.portalSave) - Number(a.portalSave) || a.surface.localeCompare(b.surface) || a.kinfolkId.localeCompare(b.kinfolkId));
  return { schemas, scannedFamilies, scannedHomeAccess, auditCustomFieldSaves: saves.size, findings };
}

function printReport(r: Report, samples: number): void {
  console.log('READ-ONLY truncated customFields report (#873). Nothing was written.');
  console.log('No before-state is recorded anywhere (audit entries carry field names only, saveHomeAccess writes no audit,');
  console.log('Firestore keeps no history), so these are households whose rows LOOK truncated, not a measured shrink.');
  console.log('');
  console.log(`Schemas now: tribeProfile [${r.schemas.tribeProfile.join(', ') || 'none'}], homeAccess [${r.schemas.homeAccess.join(', ') || 'none'}]`);
  console.log(`Scanned: families ${r.scannedFamilies}, homeAccess docs ${r.scannedHomeAccess}, households with a customFields profile save on record ${r.auditCustomFieldSaves}`);
  console.log('');
  const strong = r.findings.filter((f) => f.portalSave);
  const weak = r.findings.filter((f) => !f.portalSave);
  const households = (list: Finding[]) => new Set(list.map((f) => f.kinfolkId)).size;
  console.log(`LOOKS TRUNCATED, portal save on record: ${strong.length} list(s), ${households(strong)} household(s).`);
  console.log(`LOOKS TRUNCATED, no portal save on record: ${weak.length} list(s), ${households(weak)} household(s).`);
  const shown = r.findings.slice(0, samples);
  if (shown.length > 0) {
    console.log('');
    console.log(`First ${shown.length} of ${r.findings.length} (strong first):`);
    for (const f of shown) {
      console.log(
        `  ${f.portalSave ? 'STRONG' : 'weak  '}  ${f.surface.padEnd(10)}  ${f.path}  keys=[${f.keys.join(', ')}]  empty schema values=${f.emptySchemaValues}  last portal save=${f.lastPortalSaveAt ?? 'unknown'}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.projectId === null) args.projectId = process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  console.log(`Target: ${describeTarget(args, process.env)}`);
  resolveTarget(args, process.env);
  if (getApps().length === 0) initializeApp(args.projectId ? { projectId: args.projectId } : {});
  const report = await buildReport(getFirestore());
  printReport(report, args.samples);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
