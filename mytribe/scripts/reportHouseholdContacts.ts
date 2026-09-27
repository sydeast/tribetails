/**
 * reportHouseholdContacts.ts
 *
 * READ-ONLY. Answers the question the 2026-09-27 ruling on #829 leaves open:
 * does any `families/{id}/contacts` row hold an Emergency Contact that was
 * entered in the wrong place?
 *
 * THE RULING (operator, 2026-09-27, docket R1): "there is no true 'Contact
 * List'. There can be up to 3 ppl's contact info to a household: Primary
 * Kinfolk (PK), Secondary Kinfolk (SK), and Emergency Contact (EC). PK: contact
 * info required, portal access required. SK: contact info optional, portal
 * access optional. EC: contact info required, portal access never. EC's contact
 * info is a household item."
 *
 * The contacts list (PRs #817 and #828) is gone from every screen. Its rows,
 * its rules block and its callables stay until the operator has read this
 * report and ruled on the data. This script shows what is there.
 *
 * WHAT IT READS.
 *   - Every `contacts` document under `families/{id}`, through a collection
 *     group read. A contacts row does not need its `families/{id}` parent to
 *     exist, so walking `families` would miss the orphaned ones. Rows under
 *     any other parent are counted and skipped.
 *   - For each household that has a row: `kinfolk/{id}` (the primary's phone
 *     and name, and the Emergency Contacts, read with the same
 *     `readStoredEmergencyContacts` the callables use, so the legacy flat
 *     `emergencyContactName/Phone` pair counts) and `families/{id}/members`
 *     (secondary kinfolk phones and names).
 *   - Every `kinfolk` document, for one summary count: how many households
 *     have no Emergency Contact at all.
 *
 * WHAT IT PRINTS. Per household: the id, the row count, and whether its
 * Emergency Contact is filled (`yes`, `legacy` for the flat pair, or `NO`).
 * Per row: the id, the label as stored, the name as initials, the phone as its
 * last four digits, the email as its first letter and domain, the created
 * date, and four yes/no answers the operator would otherwise have to work out
 * from masked strings: does this row's phone match an Emergency Contact phone,
 * does its name match an Emergency Contact name, does it match somebody IN the
 * household (primary or member), and does its label read like an emergency.
 * No full phone number, email address or name is printed.
 *
 * IT WRITES NOTHING. The source contains no set, update, delete, add, batch,
 * create or transaction call, and `test/reportHouseholdContacts.test.ts` greps
 * it. There is no apply mode.
 *
 * WHICH DATABASE. The target is printed before the first read.
 *   - FIRESTORE_EMULATOR_HOST set: reads the emulator. `--allow-prod` is refused
 *     there, so a command meant for production cannot quietly read a local
 *     emulator and report "none found".
 *   - Not set: reads production only with `--allow-prod` and a project id.
 *     `--allow-prod` here confirms which database is READ; nothing is written.
 *
 * Usage (the operator runs the prod form; an agent session does not):
 *
 *   npm --prefix mytribe/functions run report:household-contacts -- --project <id> --allow-prod
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846), as in the other reports.
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import { comparablePhone, normaliseName, readStoredEmergencyContacts } from '../functions/src/lib/emergencyContacts';

export interface Args {
  projectId: string | null;
  allowProd: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { projectId: null, allowProd: false };
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
    else if (a === '--help' || a === '-h') {
      console.log(
        [
          'reportHouseholdContacts.ts: READ-ONLY count of families/{id}/contacts rows per household,',
          'next to whether that household has an Emergency Contact (#829, ruling 2026-09-27)',
          '',
          '  npm --prefix mytribe/functions run report:household-contacts -- --project <id> --allow-prod',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator and refuses --allow-prod.',
          'Writes nothing. Phones, emails and names are masked.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

export type Target =
  | { kind: 'emulator'; host: string; projectId: string }
  | { kind: 'production'; projectId: string };

/**
 * Which database this run reads, or a refusal. Decided before anything connects.
 * `env` is passed in so the unit test can drive every branch.
 */
export function resolveTarget(args: Args, env: Record<string, string | undefined>): Target {
  const host = env['FIRESTORE_EMULATOR_HOST'];
  const projectId = args.projectId ?? env['GCLOUD_PROJECT'] ?? env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (host) {
    if (args.allowProd) {
      throw new Error(
        `refusing --allow-prod while FIRESTORE_EMULATOR_HOST=${host} is set: this run would read the emulator, not production. Unset it to read production.`,
      );
    }
    return { kind: 'emulator', host, projectId: projectId ?? 'demo-report-829' };
  }
  if (!args.allowProd) {
    throw new Error('no FIRESTORE_EMULATOR_HOST, so this would read PRODUCTION: pass --allow-prod to confirm.');
  }
  if (!projectId) throw new Error('reading production needs --project <id>.');
  return { kind: 'production', projectId };
}

export function describeTarget(t: Target): string {
  return t.kind === 'emulator'
    ? `Target: EMULATOR ${t.host}, project ${t.projectId}`
    : `Target: PRODUCTION, project ${t.projectId}`;
}

type Data = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** `…1234` for a phone with at least four digits, `…` for a shorter one, `none` for none. */
export function maskPhone(v: unknown): string {
  const digits = str(v).replace(/\D/g, '');
  if (digits === '') return str(v) === '' ? 'none' : '(no digits)';
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '…';
}

/** `a…@example.com`, or `none`. A value with no `@` prints as `(not an address)`. */
export function maskEmail(v: unknown): string {
  const s = str(v);
  if (s === '') return 'none';
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return '(not an address)';
  return `${s.charAt(0)}…@${s.slice(at + 1)}`;
}

/** `M. R.` for "Maria Rivera", `none` for a blank name. */
export function initials(v: unknown): string {
  const parts = str(v).split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return 'none';
  return parts.map((p) => `${p.charAt(0).toUpperCase()}.`).join(' ');
}

/** A label somebody typing an Emergency Contact into the wrong list would use. */
export function labelLooksEmergency(v: unknown): boolean {
  return /emerg|\bec\b|in case|\bice\b/i.test(str(v));
}

/** A Firestore Timestamp, a Date, an ISO string or ms, as a YYYY-MM-DD date; `no date` when unreadable. */
export function dateOf(v: unknown): string {
  let ms: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) ms = v;
  else if (typeof v === 'string' && v.trim() !== '') {
    const t = Date.parse(v);
    ms = Number.isNaN(t) ? null : t;
  } else if (v instanceof Date) ms = v.getTime();
  else if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    ms = (v as { toMillis: () => number }).toMillis();
  }
  return ms === null ? 'no date' : new Date(ms).toISOString().slice(0, 10);
}

export type EcState = 'yes' | 'legacy' | 'NO';

/** What the household's Emergency Contact looks like, and who is in it. Pure. */
export interface Household {
  kinfolkExists: boolean;
  ec: EcState;
  ecPhones: string[];
  ecNames: string[];
  /** The primary's two phones and every member's phone, comparable form. */
  insidePhones: string[];
  /** The primary's full name and every member's display name, normalised. */
  insideNames: string[];
}

export function householdOf(kinfolk: Data | null, members: Data[]): Household {
  const k = kinfolk ?? {};
  const stored = readStoredEmergencyContacts(k);
  const phones = (xs: unknown[]) => xs.map((p) => comparablePhone(str(p))).filter((p): p is string => p !== null);
  const names = (xs: string[]) => xs.map(normaliseName).filter((n) => n !== '');
  return {
    kinfolkExists: kinfolk !== null,
    ec: stored.contacts.length === 0 ? 'NO' : stored.legacy ? 'legacy' : 'yes',
    ecPhones: phones(stored.contacts.map((c) => c.phone)),
    ecNames: names(stored.contacts.map((c) => c.name)),
    insidePhones: phones([k['phoneNumber'], k['secondaryPhone'], ...members.map((m) => m['phone'])]),
    insideNames: names([`${str(k['firstName'])} ${str(k['lastName'])}`, ...members.map((m) => str(m['displayName']))]),
  };
}

export interface RowFinding {
  contactId: string;
  label: string;
  name: string;
  phone: string;
  email: string;
  created: string;
  phoneMatchesEc: boolean;
  nameMatchesEc: boolean;
  matchesSomeoneInside: boolean;
  labelLooksEmergency: boolean;
}

/** One contacts row reduced to what is printed. Nothing unmasked leaves this function. */
export function rowFindingOf(contactId: string, d: Data, h: Household): RowFinding {
  const phone = comparablePhone(str(d['phone']));
  const name = normaliseName(str(d['name']));
  return {
    contactId,
    label: str(d['label']) || '(no label)',
    name: initials(d['name']),
    phone: maskPhone(d['phone']),
    email: maskEmail(d['email']),
    created: dateOf(d['createdAt']),
    phoneMatchesEc: phone !== null && h.ecPhones.includes(phone),
    nameMatchesEc: name !== '' && h.ecNames.includes(name),
    matchesSomeoneInside: (phone !== null && h.insidePhones.includes(phone)) || (name !== '' && h.insideNames.includes(name)),
    labelLooksEmergency: labelLooksEmergency(d['label']),
  };
}

/** A row that reads like an Emergency Contact entered in the contacts list. */
export function looksLikeMisplacedEc(r: RowFinding, h: Household): boolean {
  return r.phoneMatchesEc || r.nameMatchesEc || r.labelLooksEmergency || (h.ec === 'NO' && !r.matchesSomeoneInside);
}

export interface HouseholdFinding {
  kinfolkId: string;
  household: Household;
  rows: RowFinding[];
}

export interface Report {
  contactsRows: number;
  otherParentRows: number;
  households: HouseholdFinding[];
  kinfolkScanned: number;
  kinfolkWithoutEc: number;
}

/** Reads the rows, then the households they sit under. Writes nothing. */
export async function buildReport(db: Firestore): Promise<Report> {
  const snap = await db.collectionGroup('contacts').get();
  const byHousehold: Array<[string, Array<{ id: string; data: Data }>]> = [];
  let otherParentRows = 0;
  for (const doc of snap.docs) {
    const parent = doc.ref.parent.parent;
    if (!parent || parent.parent.path !== 'families') {
      otherParentRows += 1;
      continue;
    }
    let entry = byHousehold.find(([id]) => id === parent.id);
    if (!entry) {
      entry = [parent.id, []];
      byHousehold.push(entry);
    }
    entry[1].push({ id: doc.id, data: (doc.data() ?? {}) as Data });
  }

  const households: HouseholdFinding[] = [];
  for (const [kinfolkId, rows] of byHousehold) {
    const kin = await db.collection('kinfolk').doc(kinfolkId).get();
    const members = await db.collection('families').doc(kinfolkId).collection('members').get();
    const household = householdOf(
      kin.exists ? ((kin.data() ?? {}) as Data) : null,
      members.docs.map((m) => (m.data() ?? {}) as Data),
    );
    households.push({
      kinfolkId,
      household,
      rows: rows.map((r) => rowFindingOf(r.id, r.data, household)).sort((a, b) => a.contactId.localeCompare(b.contactId)),
    });
  }
  households.sort((a, b) => a.kinfolkId.localeCompare(b.kinfolkId));

  const allKinfolk = await db.collection('kinfolk').get();
  const kinfolkWithoutEc = allKinfolk.docs.filter(
    (d) => readStoredEmergencyContacts((d.data() ?? {}) as Data).contacts.length === 0,
  ).length;

  return {
    contactsRows: snap.size - otherParentRows,
    otherParentRows,
    households,
    kinfolkScanned: allKinfolk.size,
    kinfolkWithoutEc,
  };
}

function yn(b: boolean): string {
  return b ? 'yes' : 'no';
}

export function reportLines(r: Report): string[] {
  const out: string[] = [];
  out.push('READ-ONLY #829 report: families/{id}/contacts rows next to each household\'s Emergency Contact. Nothing was written.');
  out.push(
    `Households with no Emergency Contact at all: ${r.kinfolkWithoutEc} of ${r.kinfolkScanned} kinfolk document(s).`,
  );
  if (r.otherParentRows > 0) {
    out.push(`Skipped ${r.otherParentRows} "contacts" document(s) that do not sit under families/{id}.`);
  }
  if (r.households.length === 0) {
    out.push('CONTACTS ROWS: none found. There is nothing in the contacts list to move or keep.');
    return out;
  }
  const suspects = r.households.flatMap((h) => h.rows.filter((row) => looksLikeMisplacedEc(row, h.household)));
  out.push(`CONTACTS ROWS: ${r.contactsRows} in ${r.households.length} household(s).`);
  out.push(`Rows that read like an Emergency Contact entered in the wrong place: ${suspects.length}.`);
  for (const h of r.households) {
    const missing = h.household.kinfolkExists ? '' : '  (no kinfolk document: the household itself is gone)';
    out.push(`  household=${h.kinfolkId}  rows=${h.rows.length}  emergencyContact=${h.household.ec}${missing}`);
    for (const row of h.rows) {
      const flag = looksLikeMisplacedEc(row, h.household) ? '  <- check' : '';
      out.push(
        `      contact=${row.contactId}  label="${row.label}"  name=${row.name}  phone=${row.phone}  email=${row.email}  created=${row.created}${flag}`,
      );
      out.push(
        `          phone matches an Emergency Contact: ${yn(row.phoneMatchesEc)}  name matches one: ${yn(row.nameMatchesEc)}  ` +
          `is someone in the household: ${yn(row.matchesSomeoneInside)}  label reads as emergency: ${yn(row.labelLooksEmergency)}`,
      );
    }
  }
  out.push('"<- check": the row matches an Emergency Contact, its label reads as one, or the household has no');
  out.push('Emergency Contact and the row is nobody in the household.');
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args, process.env);
  console.log(describeTarget(target));
  if (getApps().length === 0) initializeApp({ projectId: target.projectId });
  for (const line of reportLines(await buildReport(getFirestore()))) console.log(line);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
