/**
 * backfillBusinessPublicCard.ts (#1321)
 *
 * Writes `business_public/card`, the public business card the sign-in screen
 * reads before anyone is signed in, from the settings document that already
 * exists.
 *
 * ── WHY A SCRIPT ──────────────────────────────────────────────────────────
 *
 * The card is kept by the `onBusinessSettingsWrite` trigger, and a trigger
 * fires on a WRITE. The settings document was written long before the trigger
 * existed, so on the day the trigger deploys the card is simply not there: the
 * sign-in screen draws "MyTribe" with no business under it until the operator
 * next saves settings. This script does that first mirror on purpose, from
 * the same projection the trigger uses (`functions/src/lib/businessPublicCard.ts`),
 * so the two can never say different things.
 *
 * ── WHAT IT WRITES, AND ONLY THIS ─────────────────────────────────────────
 *
 *   `business_public/card`  <- buildBusinessPublicCard(business_settings/business_settings)
 *
 * One `set()` of the four public fields (name, phone, hours, privacyPolicyUrl).
 * The settings document itself is never touched. Nothing beyond the closed
 * list in `businessPublicCard.ts` can reach the card, whatever settings hold.
 *
 * ── IDEMPOTENT BY CONSTRUCTION ────────────────────────────────────────────
 *
 * A card already equal to the projection is planned for no write, so a second
 * run commits nothing. A settings document that does not exist is REFUSED
 * rather than mirrored as blanks: an all-blank card is what a deleted settings
 * document earns, and that is the trigger's call, not a backfill's.
 *
 * Only the canonical `business_settings/business_settings` is read. The legacy
 * `business_settings/singleton` that `repairBusinessTimeZone.ts` falls back to
 * is NOT: the trigger watches the canonical document alone, so a card built
 * from the legacy one would go stale the moment either document changed.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either order.
 *   --project <id> Firebase project id.
 *
 * Runbook: run DRY first, read the before/after, then re-run with --allow-prod.
 * The real write is an operator step, never an agent's.
 *
 * STATUS (docs/runbooks/after-release.md, "Scripts and the data re-upload"):
 * still applies. Run once after the trigger first deploys, and again after any
 * reload that recreates `business_settings` without going through a client
 * save.
 */
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import {
  BUSINESS_PUBLIC_CARD_DOC,
  BUSINESS_SETTINGS_SOURCE_DOC,
  buildBusinessPublicCard,
  sameBusinessPublicCard,
  type BusinessPublicCard,
} from '../functions/src/lib/businessPublicCard';

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
      if (!v || v.startsWith('--')) throw new Error(`${a} requires a value`);
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillBusinessPublicCard.ts - write the public business card the sign-in screen reads',
          '',
          '  npm run backfill:business-public-card                 # DRY RUN (default)',
          '  npm run backfill:business-public-card -- --allow-prod  # apply',
          '',
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
  /** False when there is no settings document to mirror; nothing is written. */
  settingsExists: boolean;
  /** The card as stored today, or null when it does not exist yet. */
  before: Record<string, unknown> | null;
  after: BusinessPublicCard;
  /** False when the stored card already equals the projection. */
  changes: boolean;
}

export async function planBackfill(firestore: Firestore): Promise<Plan> {
  const settingsSnap = await firestore.doc(BUSINESS_SETTINGS_SOURCE_DOC).get();
  const after = buildBusinessPublicCard(settingsSnap.exists ? (settingsSnap.data() as Record<string, unknown>) : undefined);
  if (!settingsSnap.exists) return { settingsExists: false, before: null, after, changes: false };
  const cardSnap = await firestore.doc(BUSINESS_PUBLIC_CARD_DOC).get();
  const before = cardSnap.exists ? ((cardSnap.data() ?? {}) as Record<string, unknown>) : null;
  return { settingsExists: true, before, after, changes: !sameBusinessPublicCard(before ?? undefined, after) };
}

/** The card as the plan prints it: which fields are set, never a phone number on a terminal. */
export function describeCard(card: Record<string, unknown> | null): string {
  if (!card) return '(no card)';
  const openDays = Object.entries((card['hours'] as Record<string, unknown>) ?? {}).filter(([, v]) => v !== '').length;
  return [
    `name=${card['name'] === '' || card['name'] === undefined ? '(unset)' : JSON.stringify(card['name'])}`,
    `phone=${card['phone'] ? 'set' : '(unset)'}`,
    `hours=${openDays} open day${openDays === 1 ? '' : 's'}`,
    `privacyPolicyUrl=${card['privacyPolicyUrl'] ? 'set' : '(unset)'}`,
  ].join(' ');
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (!getApps().length) {
    initializeApp(args.projectId ? { projectId: args.projectId } : undefined);
  }
  const firestore = getFirestore();
  const plan = await planBackfill(firestore);

  if (!plan.settingsExists) {
    console.error(`REFUSED: no settings document at ${BUSINESS_SETTINGS_SOURCE_DOC}; nothing to mirror.`);
    process.exitCode = 1;
    return;
  }

  console.log(`document : ${BUSINESS_PUBLIC_CARD_DOC}`);
  console.log(`before   : ${describeCard(plan.before)}`);
  console.log(`after    : ${describeCard(plan.after as unknown as Record<string, unknown>)}`);

  if (!plan.changes) {
    console.log('nothing to do: the card already matches settings.');
    return;
  }
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing written. Re-run with --allow-prod to apply.');
    return;
  }

  await firestore.doc(BUSINESS_PUBLIC_CARD_DOC).set(plan.after);
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
