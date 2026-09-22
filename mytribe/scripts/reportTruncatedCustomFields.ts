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
 * LOCKOUT RISK (#873 review). The same scan also counts the lists a save could
 * have been refused over: more than 40 rows (the request cap before the review
 * round, and current clients send every stored row back), rows with a missing or
 * blank label (served as '', and the old request schema required one), and
 * values longer than the 1000 characters the callables still accept. Since the
 * second review round it also counts lists over 64 KiB (a save may not grow one
 * further) and over 900 KiB (near the 1 MiB document limit), measured as UTF-8
 * bytes of the list's JSON, the same way the callables measure them.
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

/** The request row cap before the #873 review round. Kept here, not imported: scripts do not import functions/src. */
export const OLD_REQUEST_ROW_CAP = 40;
/** The value length saveTribeProfile / saveHomeAccess accept. */
export const VALUE_MAX = 1000;
/**
 * The callables' growth ceiling and document backstop (CUSTOM_FIELDS_GROWTH_MAX_BYTES
 * and CUSTOM_FIELDS_HARD_MAX_BYTES in functions/src/lib/customFieldsMerge.ts),
 * copied for the same reason as the row cap above.
 */
export const GROWTH_MAX_BYTES = 64 * 1024;
export const HARD_MAX_BYTES = 900 * 1024;

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
  /** Every stored entry, readable or not. */
  rowCount: number;
  /** UTF-8 bytes of the stored list's JSON (#873 second review). */
  bytes: number;
  /** Keys of rows whose label is missing, not a string, or blank (#873 review). */
  blankLabelKeys: string[];
  /** Keys of rows whose value is longer than the callables accept (#873 review). */
  longValueKeys: string[];
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
  const blankLabelKeys: string[] = [];
  const longValueKeys: string[] = [];
  for (const entry of list) {
    const key = (entry as { key?: unknown } | null)?.key;
    if (typeof key !== 'string') {
      unreadable += 1;
      continue;
    }
    keys.push(key);
    const label = (entry as { label?: unknown }).label;
    if (typeof label !== 'string' || label.trim() === '') blankLabelKeys.push(key);
    const value = (entry as { value?: unknown }).value;
    if (typeof value === 'string' && value.length > VALUE_MAX) longValueKeys.push(key);
    if (editable.includes(key) && (entry as { value?: unknown }).value === '') emptySchemaValues += 1;
  }
  const looksTruncated =
    editable.length > 0 && unreadable === 0 && keys.every((k) => allowed.has(k)) && editable.every((k) => keys.includes(k));
  const bytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
  return { keys, rowCount: list.length, bytes, looksTruncated, emptySchemaValues, blankLabelKeys, longValueKeys };
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

/** A list a save could be refused over (#873 review). Keys and counts only. */
export interface LockoutRisk {
  surface: 'families' | 'homeAccess';
  kinfolkId: string;
  path: string;
  rows: number;
  bytes: number;
  blankLabelKeys: string[];
  longValueKeys: string[];
}

export interface Report {
  schemas: { tribeProfile: string[]; homeAccess: string[] };
  scannedFamilies: number;
  scannedHomeAccess: number;
  auditCustomFieldSaves: number;
  findings: Finding[];
  lockoutRisks: LockoutRisk[];
}

/** The risk this list carries, or null when it carries none. */
export function lockoutRiskOf(surface: LockoutRisk['surface'], kinfolkId: string, path: string, v: RowsVerdict): LockoutRisk | null {
  if (v.rowCount <= OLD_REQUEST_ROW_CAP && v.bytes <= GROWTH_MAX_BYTES && v.blankLabelKeys.length === 0 && v.longValueKeys.length === 0) return null;
  return { surface, kinfolkId, path, rows: v.rowCount, bytes: v.bytes, blankLabelKeys: v.blankLabelKeys, longValueKeys: v.longValueKeys };
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
  const lockoutRisks: LockoutRisk[] = [];
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
      const risk = lockoutRiskOf('families', doc.id, doc.ref.path, v);
      if (risk !== null) lockoutRisks.push(risk);
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
        const risk = lockoutRiskOf('homeAccess', home.ref.parent.parent?.id ?? '', home.ref.path, v);
        if (risk !== null) lockoutRisks.push(risk);
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
  lockoutRisks.sort((a, b) => a.surface.localeCompare(b.surface) || a.kinfolkId.localeCompare(b.kinfolkId));
  return { schemas, scannedFamilies, scannedHomeAccess, auditCustomFieldSaves: saves.size, findings, lockoutRisks };
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
  printLockoutRisks(r.lockoutRisks, samples);
}

/** Counts per surface, then keys only. Never a value. */
export function lockoutRiskLines(risks: LockoutRisk[], samples: number): string[] {
  const lines: string[] = ['', 'LOCKOUT RISK (#873 review): lists a save could have been refused over.'];
  for (const surface of ['families', 'homeAccess'] as const) {
    const mine = risks.filter((x) => x.surface === surface);
    const over = mine.filter((x) => x.rows > OLD_REQUEST_ROW_CAP);
    const overGrowth = mine.filter((x) => x.bytes > GROWTH_MAX_BYTES);
    const overHard = mine.filter((x) => x.bytes > HARD_MAX_BYTES);
    const blank = mine.filter((x) => x.blankLabelKeys.length > 0);
    const long = mine.filter((x) => x.longValueKeys.length > 0);
    const rowsIn = (list: LockoutRisk[], pick: (x: LockoutRisk) => string[]) => list.reduce((n, x) => n + pick(x).length, 0);
    lines.push(
      `  ${surface}: over ${OLD_REQUEST_ROW_CAP} rows ${over.length} household(s); ` +
        `over 64 KiB ${overGrowth.length} household(s); over 900 KiB ${overHard.length} household(s); ` +
        `empty or missing label ${rowsIn(blank, (x) => x.blankLabelKeys)} row(s) in ${blank.length} household(s); ` +
        `value over ${VALUE_MAX} characters ${rowsIn(long, (x) => x.longValueKeys)} row(s) in ${long.length} household(s)`,
    );
  }
  const shown = risks.slice(0, samples);
  if (shown.length > 0) {
    lines.push(`First ${shown.length} of ${risks.length}:`);
    for (const x of shown) {
      lines.push(
        `  ${x.surface.padEnd(10)}  ${x.path}  rows=${x.rows}  bytes=${x.bytes}  empty-label keys=[${x.blankLabelKeys.join(', ')}]  long-value keys=[${x.longValueKeys.join(', ')}]`,
      );
    }
  }
  return lines;
}

function printLockoutRisks(risks: LockoutRisk[], samples: number): void {
  for (const line of lockoutRiskLines(risks, samples)) console.log(line);
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
