/**
 * rewriteVisitKinIds.ts
 *
 * #2350. Puts every visit and KinTale that names a Kin by its household card
 * id back on the id the admin screens look the Kin up by (its admin record's).
 *
 * A Kin a household added itself has two ids: its card in MyTribe and its
 * admin record. Every admin screen (Home care flags, the KinTale composer,
 * Auntie Time, visit detail, the 411 on a visit, a Kin's own page) finds a
 * visit's Kin by the admin record id, so a visit stored under the card id
 * showed that Kin nowhere. Since #2347 new visits store the admin id and since
 * #2350 an approval does too. This script moves the rows stored under a card
 * id: visits and requests from before #2347, the KinTales written for them,
 * and a visit booked while its Kin had no admin record yet. It is the only
 * writer: a link event only logs what this script would change
 * (`kin.visitIds.planned`), so the script can be run again after one.
 *
 * The decision per document is `planVisitKinIds` in
 * `mytribe/functions/src/lib/visitKinIds.ts`, the same one a link event
 * runs to log its plan. Read its header for what is written and what is not. In short:
 * `kinIds` and the legacy `kinId` on `kin_care_sessions` and
 * `kin_care_reports`, card ids replaced in place, nothing else. A document
 * that names the card id anywhere else (a per-Kin checklist answer, a mood) is
 * listed and left alone, and so is one that names a card in a crossed pair
 * (two cards that claim one admin record, or a live card tied to an archived
 * record), until the pair is healed (`repair:crossed-kin-links`), and so is
 * one where two different ids would become one record. The
 * household's own copies are never written. Before writing a household it reads
 * its Kin again and leaves it if any link changed since the plan.
 *
 * WHAT A RUN FIRES: nothing a person hears. The visit triggers react to
 * `status` and the calendar fields, the KinTale triggers to a send, its body
 * or its media. A sent KinTale with no care-task copy yet gets one from
 * `onKinTaleUpdate` on the write, exactly as `backfill:kintale-care-tasks`
 * would give it.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and the list, writes nothing.
 *   --allow-prod   applies.
 *   --dry-run      forces the dry run, and BEATS --allow-prod in either flag
 *                  order.
 *
 * Runbook: run DRY first, read the plan and the list, then re-run with
 * --allow-prod. The real write is an operator step, never an agent's. After a
 * data reload, run it after `backfill:booking-kin-roster`, which fills empty
 * rosters with household card ids.
 *
 *   npm --prefix mytribe/functions run backfill:visit-kin-ids
 *   npm --prefix mytribe/functions run backfill:visit-kin-ids -- --allow-prod
 */
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';
import {
  VISIT_KIN_ID_COLLECTIONS,
  applyHouseholdVisitKinIds,
  planHouseholdDocs,
  readHouseholdKinIdMap,
  type HouseholdKinIdPlan,
} from '../functions/src/lib/visitKinIds';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  // An explicit --dry-run wins in either flag order: it is remembered past the
  // loop, and only then does --allow-prod get to switch the mode.
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
          'rewriteVisitKinIds.ts: put visits and KinTales stored under a household card id on the admin record id',
          '',
          '  npm run backfill:visit-kin-ids                    # DRY RUN (default)',
          '  npm run backfill:visit-kin-ids -- --allow-prod    # apply',
          '  npm run backfill:visit-kin-ids -- --dry-run       # force dry-run, ALWAYS wins',
          '  npm run backfill:visit-kin-ids -- --project <id>  # override project',
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

export interface Summary {
  households: number;
  householdsWithAliases: number;
  scanned: number;
  toWrite: number;
  refused: number;
}

/**
 * One plan per household that has visits or KinTales. Reads every document of
 * the two collections once, then each such household's Kin. Writes nothing.
 */
export async function buildPlan(db: Firestore): Promise<{ summary: Summary; plans: HouseholdKinIdPlan[] }> {
  const byHousehold = new Map<string, Array<{ collection: (typeof VISIT_KIN_ID_COLLECTIONS)[number]; id: string; data: Record<string, unknown> }>>();
  for (const collection of VISIT_KIN_ID_COLLECTIONS) {
    const snap = await db.collection(collection).get();
    for (const doc of snap.docs) {
      const data = (doc.data() ?? {}) as Record<string, unknown>;
      const kinfolkId = typeof data['kinfolkId'] === 'string' ? data['kinfolkId'].trim() : '';
      if (kinfolkId === '' || kinfolkId.includes('/')) continue;
      const rows = byHousehold.get(kinfolkId) ?? [];
      rows.push({ collection, id: doc.id, data });
      byHousehold.set(kinfolkId, rows);
    }
  }
  const summary: Summary = { households: byHousehold.size, householdsWithAliases: 0, scanned: 0, toWrite: 0, refused: 0 };
  const plans: HouseholdKinIdPlan[] = [];
  for (const [kinfolkId, rows] of [...byHousehold.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    summary.scanned += rows.length;
    const map = await readHouseholdKinIdMap(kinfolkId, db);
    if (map.aliases.size === 0 && map.crossed.size === 0) continue;
    summary.householdsWithAliases += 1;
    const plan = planHouseholdDocs(
      kinfolkId,
      map,
      rows.map((row) => ({ collection: row.collection, docId: row.id, data: row.data })),
    );
    summary.toWrite += plan.writes.length;
    summary.refused += plan.refusals.length;
    if (plan.writes.length > 0 || plan.refusals.length > 0) plans.push(plan);
  }
  return { summary, plans };
}

function report(summary: Summary, plans: HouseholdKinIdPlan[], mode: Mode): void {
  console.log('');
  console.log(`=== Visit and KinTale Kin ids (${mode.toUpperCase()}) ===`);
  console.log(`households with visits or KinTales     : ${summary.households}`);
  console.log(`  with a Kin whose two ids differ       : ${summary.householdsWithAliases}`);
  console.log(`documents scanned                       : ${summary.scanned}`);
  console.log(`to rewrite                              : ${summary.toWrite}`);
  console.log(`listed and left as is                   : ${summary.refused}`);
  for (const plan of plans) {
    console.log('');
    console.log(`-- household ${plan.kinfolkId} --`);
    for (const [card, stored] of plan.aliases) console.log(`  card ${card} -> record ${stored}`);
    if (plan.crossed.size > 0) console.log(`  crossed cards, not moved: ${[...plan.crossed].join(', ')}`);
    for (const w of plan.writes) {
      console.log(`  ${w.collection}/${w.docId}  ${JSON.stringify(w.update)}`);
    }
    for (const r of plan.refusals) {
      const why =
        r.reason === 'crossed-link'
          ? 'card record may be another Kin (shared with another card, or archived while the card is live): heal the pair with repair:crossed-kin-links'
          : r.reason === 'two-ids-one-record'
            ? 'two ids on it would become one record (may be two Kin)'
            : 'card id also named outside kinIds';
      console.log(`  LEFT ${r.collection}/${r.docId}  ${why}: ${r.cardIds.join(', ')}`);
    }
  }
  console.log('');
}

export async function applyPlans(db: Firestore, plans: HouseholdKinIdPlan[]): Promise<{ written: number; skippedOnRecheck: number }> {
  const total = { written: 0, skippedOnRecheck: 0 };
  for (const plan of plans) {
    if (plan.writes.length === 0) continue;
    const outcome = await applyHouseholdVisitKinIds(plan, db);
    total.written += outcome.written;
    total.skippedOnRecheck += outcome.skippedOnRecheck;
  }
  return total;
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
  const projectId =
    args.projectId ?? process.env['GCLOUD_PROJECT'] ?? process.env['GOOGLE_CLOUD_PROJECT'] ?? null;
  if (getApps().length === 0) initializeApp(projectId ? { projectId } : {});
  const db = getFirestore();

  const { summary, plans } = await buildPlan(db);
  report(summary, plans, args.mode);
  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  const outcome = await applyPlans(db, plans);
  console.log(`APPLIED: ${outcome.written} document(s) rewritten; ${outcome.skippedOnRecheck} left because they or their household changed since the plan (run again).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
