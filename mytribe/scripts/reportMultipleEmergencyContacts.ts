/**
 * reportMultipleEmergencyContacts.ts
 *
 * READ-ONLY. Counts the households that have more than one Emergency Contact
 * on file.
 *
 * THE RULING (operator, 2026-09-27, Q2): "One Emergency Contact per household."
 * The 2026-09-13 ruling allowed two, so some households may already have two.
 * That data is kept: nothing deletes the second one. `saveEmergencyContacts`
 * now refuses more than one, and every admin client shows both with a notice
 * asking the admin to remove one. This script tells the operator how many
 * households that is.
 *
 * WHAT IT READS. Every `kinfolk` document, through the same
 * `readStoredEmergencyContacts` the callables use, so a household still on the
 * legacy flat `emergencyContactName/Phone` pair counts as one contact.
 *
 * WHAT IT PRINTS. The number of households scanned, how many have none, one,
 * and more than one. For each household with more than one: its id, the count,
 * and each contact as initials and the last four digits of the phone, with the
 * date the office first had it. No full phone number or name is printed.
 *
 * IT WRITES NOTHING. The source contains no set, update, delete, add, batch,
 * create or transaction call, and `test/reportMultipleEmergencyContacts.test.ts`
 * greps it. There is no apply mode.
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
 *   npm --prefix mytribe/functions run report:multiple-emergency-contacts -- --project <id> --allow-prod
 *
 * Needs GOOGLE_APPLICATION_CREDENTIALS (or gcloud application-default login)
 * with read access, or FIRESTORE_EMULATOR_HOST for a local run.
 */
// The single firebase-admin import point (#846), as in the other reports.
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import { readStoredEmergencyContacts } from '../functions/src/lib/emergencyContacts';
import { describeTarget, initials, maskPhone, resolveTarget, type Args } from './reportHouseholdContacts';

export { describeTarget, resolveTarget };

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
          'reportMultipleEmergencyContacts.ts: READ-ONLY count of households with more than one',
          'Emergency Contact on file (ruling 2026-09-27, Q2: one per household)',
          '',
          '  npm --prefix mytribe/functions run report:multiple-emergency-contacts -- --project <id> --allow-prod',
          '',
          'Under FIRESTORE_EMULATOR_HOST it reads the emulator and refuses --allow-prod.',
          'Writes nothing. Phones and names are masked.',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

type Data = Record<string, unknown>;

export interface MaskedContact {
  name: string;
  phone: string;
  recorded: string;
}

export interface HouseholdFinding {
  kinfolkId: string;
  legacy: boolean;
  contacts: MaskedContact[];
}

export interface Report {
  scanned: number;
  none: number;
  one: number;
  over: HouseholdFinding[];
}

function recordedOf(v: { toDate: () => Date } | null): string {
  return v === null ? 'no date' : v.toDate().toISOString().slice(0, 10);
}

/** One kinfolk doc to its finding, or null when it has at most one contact. Nothing unmasked leaves this function. */
export function findingOf(kinfolkId: string, d: Data): { count: number; finding: HouseholdFinding | null } {
  const stored = readStoredEmergencyContacts(d);
  const count = stored.contacts.length;
  if (count <= 1) return { count, finding: null };
  return {
    count,
    finding: {
      kinfolkId,
      legacy: stored.legacy,
      contacts: stored.contacts.map((c) => ({ name: initials(c.name), phone: maskPhone(c.phone), recorded: recordedOf(c.recordedAt) })),
    },
  };
}

/** Pure: the counts from a list of kinfolk docs. */
export function reportOf(docs: Array<{ id: string; data: Data }>): Report {
  const r: Report = { scanned: docs.length, none: 0, one: 0, over: [] };
  for (const doc of docs) {
    const { count, finding } = findingOf(doc.id, doc.data);
    if (count === 0) r.none += 1;
    else if (count === 1) r.one += 1;
    if (finding) r.over.push(finding);
  }
  r.over.sort((a, b) => a.kinfolkId.localeCompare(b.kinfolkId));
  return r;
}

/** Reads every kinfolk document. Writes nothing. */
export async function buildReport(db: Firestore): Promise<Report> {
  const snap = await db.collection('kinfolk').get();
  return reportOf(snap.docs.map((d) => ({ id: d.id, data: (d.data() ?? {}) as Data })));
}

export function reportLines(r: Report): string[] {
  const out: string[] = [];
  out.push('READ-ONLY report: households with more than one Emergency Contact (ruling 2026-09-27, Q2). Nothing was written.');
  out.push(`Households scanned: ${r.scanned}. None on file: ${r.none}. One: ${r.one}. More than one: ${r.over.length}.`);
  if (r.over.length === 0) {
    out.push('MORE THAN ONE: none found. Every household already meets the one-contact rule.');
    return out;
  }
  out.push('MORE THAN ONE: each of these keeps both until an admin removes one on the household edit screen.');
  for (const h of r.over) {
    out.push(`  household=${h.kinfolkId}  contacts=${h.contacts.length}${h.legacy ? '  (legacy)' : ''}`);
    h.contacts.forEach((c, i) => {
      out.push(`      ${i + 1}. name=${c.name}  phone=${c.phone}  recorded=${c.recorded}`);
    });
  }
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
