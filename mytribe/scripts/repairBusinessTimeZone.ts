/**
 * repairBusinessTimeZone.ts
 *
 * Sets `business_settings/business_settings.timeZone` to the zone the business
 * actually operates in.
 *
 * ── WHY THIS NEEDS A SCRIPT AND NOT A CONSOLE EDIT ────────────────────────
 *
 * This one field is about to acquire its first reader. Until `twilioVoice`
 * landed, `timeZone` was written by the settings UI and read by NOTHING:
 * `bookingAvailability.ts` and `companyHolidayConflict.ts` both say in their
 * headers that they deliberately decline to convert through it, because an
 * unvalidated IANA name that nothing else honours is not a conversion input.
 * So its stored value had never been contradicted by anything, and it was still
 * sitting on the `America/New_York` default from `DEFAULT_BUSINESS_SETTINGS`.
 *
 * The phone line now converts through it on every call. A wrong zone is a
 * wrong greeting for an hour at each end of every day, which is precisely the
 * failure mode this whole change exists to end. Making the correction here,
 * rather than by typing in a console, is the point: the console edit is what
 * put the deployed `/check-hours` out of sync with its own source in this repo
 * and left every caller hearing "we're closed" for months, with no diff anyone
 * could review.
 *
 * ── OPERATOR RULING 2026-08-11 ────────────────────────────────────────────
 *
 * The business runs on `America/Chicago`. Corroborating, though the ruling is
 * what decides it: the business's published number is a 737 (Austin, Texas),
 * and the deployed hours function had independently hardcoded `America/Chicago`
 * even while the settings document said Eastern.
 *
 * ── WHAT IT WRITES, AND ONLY THIS ─────────────────────────────────────────
 *
 *   `timeZone`   -> `America/Chicago`
 *
 * One `update()` carrying one key, never a `set()`. The document holds around
 * fifty fields, several of them the operator's own authored content
 * (`companyHolidays`, `serviceRates`, `homeGreeting`), and a whole-document
 * write is the exact bug class this repo has spent a week closing.
 *
 * `updatedAt`/`updatedBy` are deliberately NOT stamped. They record who last
 * edited settings from a UI, and a repair script is not a person.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────
 *
 * A document already holding the target zone is planned for no write, so a
 * second run commits nothing.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either flag
 *                  order.
 *   --zone <IANA>  overrides the target zone. Validated before any write.
 *
 * Runbook: run DRY first, read the before/after, then re-run with --allow-prod.
 * The real write is an operator step, never an agent's.
 *
 * STATUS (docs/RUNBOOK.md, "Scripts and the data re-upload"): still applies.
 * Run again after the reload regardless of whether `business_settings`
 * survives the wipe: a recreated document falls back to
 * `America/New_York` (DEFAULT_BUSINESS_SETTINGS), the wrong zone.
 */
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';

export const SETTINGS_DOC = 'business_settings/business_settings';

/** The historical doc id, the same fallback `getBusinessContact.ts` carries. */
export const SETTINGS_DOC_LEGACY = 'business_settings/singleton';

/** Operator ruling 2026-08-11. */
export const TARGET_TIME_ZONE = 'America/Chicago';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
  zone: string;
}

/**
 * Is this a zone `Intl` actually knows?
 *
 * The same check `lib/businessHours.ts` applies at call time, run here so a
 * typo is refused BEFORE it is stored rather than discovered by a caller
 * hearing the fail-open greeting.
 */
export function isValidTimeZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null, zone: TARGET_TIME_ZONE };
  // An explicit --dry-run always wins, in either flag order. Tracked separately
  // because the mode flip below runs once, after the whole argv is scanned.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project' || a === '--zone') {
      const v = argv[i + 1];
      // Reject a flag as the value, not just a missing one: `--zone` with no
      // value would otherwise swallow whatever followed it.
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      if (a === '--project') args.projectId = v;
      else args.zone = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'repairBusinessTimeZone.ts - set the business timezone the phone line reads',
          '',
          '  npm run repair:business-timezone                 # DRY RUN (default)',
          '  npm run repair:business-timezone -- --allow-prod  # apply',
          '',
          `  --zone <IANA>   target zone (default ${TARGET_TIME_ZONE})`,
          '  --project <id>  Firebase project id',
        ].join('\n'),
      );
      process.exit(0);
    }
  }
  if (args.allowProd) args.mode = 'apply';
  if (explicitDryRun) args.mode = 'dry-run';
  return args;
}

export interface Plan {
  /** The document path that actually holds the settings, or null if neither exists. */
  path: string | null;
  before: string | null;
  after: string;
  /** False when the stored value already matches, so nothing is written. */
  changes: boolean;
}

export async function planRepair(firestore: Firestore, zone: string): Promise<Plan> {
  for (const path of [SETTINGS_DOC, SETTINGS_DOC_LEGACY]) {
    const snap = await firestore.doc(path).get();
    if (!snap.exists) continue;
    const raw = snap.data()?.timeZone;
    const before = typeof raw === 'string' ? raw : null;
    return { path, before, after: zone, changes: before !== zone };
  }
  return { path: null, before: null, after: zone, changes: false };
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (!isValidTimeZone(args.zone)) {
    // Fail loud. Storing a zone Intl cannot resolve would make every call take
    // the `timezone-unusable` fail-open branch, which answers "open" at 3am.
    console.error(`REFUSED: "${args.zone}" is not a timezone Intl recognises.`);
    process.exitCode = 1;
    return;
  }

  if (!getApps().length) {
    initializeApp(args.projectId ? { projectId: args.projectId } : undefined);
  }
  const firestore = getFirestore();
  const plan = await planRepair(firestore, args.zone);

  if (!plan.path) {
    console.error(`REFUSED: no settings document at ${SETTINGS_DOC} or ${SETTINGS_DOC_LEGACY}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`document : ${plan.path}`);
  console.log(`before   : ${plan.before ?? '(unset)'}`);
  console.log(`after    : ${plan.after}`);

  if (!plan.changes) {
    console.log('nothing to do: already set.');
    return;
  }
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing written. Re-run with --allow-prod to apply.');
    return;
  }

  await firestore.doc(plan.path).update({ timeZone: plan.after });
  console.log('applied.');
}

/* c8 ignore start -- entrypoint guard, exercised by running the script */
if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
/* c8 ignore stop */
