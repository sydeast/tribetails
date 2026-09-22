/**
 * Bulk loads the notification template corpus into Firestore from the admin UI.
 *
 * Issue #468. The operator ruled out `npm run seed:notif-templates`, and
 * `sendFromTemplate` throws when a template document is absent, so without a
 * route that does not involve a terminal, a shipped notification cannot render.
 * This is that route.
 *
 * WHY IT IS NOT THE SEED SCRIPT WITH AN HTTP HANDLE ON IT. The script does a
 * full `.set()` per document, which drops `title`, `category`, `tags`,
 * `description`, `usageInstructions` and `sectionDefinitions`, every one of
 * which is authored in the Template Bank and none of which the corpus knows
 * about. Run it after an afternoon of categorising templates and the
 * categorising is gone. This callable merges the CONTENT fields only, so
 * importing and authoring can touch the same document without fighting.
 *
 * The overwrite rule is the other difference. The script replaces whatever is
 * there. Here, a template whose stored copy differs from the repo copy is
 * SKIPPED unless the operator named it in `overwriteIds`, so the dry run is not
 * merely a preview, it is the step where the decision gets made.
 */
import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { NOTIFICATION_KEY_ALIASES } from '../notifications/catalog';
import { SEED_CORPUS } from '../notifications/seedCorpus.generated';
import {
  CHANNEL_COLLECTIONS,
  planImport,
  plannedWrites,
  type ImportPlan,
  type TemplateChannel,
} from '../notifications/importPlanner';

// Exported for the recursive callable-contract freeze (nested/effects shape).
export const Args = z.object({
  /** Plan only. Nothing is written, whatever else is set. Defaults to true. */
  dryRun: z.boolean().optional(),
  /**
   * The template ids the operator chose to replace. An id NOT named here whose
   * stored copy differs is skipped, never quietly overwritten.
   */
  overwriteIds: z.array(z.string().min(1).max(120)).max(200).optional(),
  /** Narrows the run to these ids. Absent means the whole corpus. */
  onlyIds: z.array(z.string().min(1).max(120)).max(200).optional(),
});

/** One line of the report, as the clients render it. */
export interface ImportReportRow {
  templateId: string;
  /** Present when this id is a retired key kept for old bindings. */
  aliasOf: string | null;
  /** Per channel outcome, in email/sms/push order. */
  channels: Array<{ channel: TemplateChannel; outcome: string; notes: string[] }>;
  differsFromRepo: boolean;
  blocked: boolean;
  /**
   * Every complaint that refused this template, one operator-facing sentence
   * each, prefixed with its channel. Empty unless `blocked`. The clients show it
   * beside "Refused" (#892 review 2), since `refused` carries only the first.
   */
  issues: string[];
}

export interface ImportSeedTemplatesResult {
  dryRun: boolean;
  /** Documents actually written. Always 0 on a dry run. */
  written: number;
  counts: Record<string, number>;
  rows: ImportReportRow[];
  /** Ids that differ from the repo and were NOT overwritten, so they were skipped. */
  needsOverwriteChoice: string[];
  /** Ids refused outright, with the first complaint. */
  refused: Array<{ templateId: string; reason: string }>;
}

/**
 * Reads only the documents the corpus could touch, rather than the whole of
 * three collections. `getAll` on the same refs the planner will compare is one
 * round trip and keeps the read set exactly the write set.
 */
async function readExisting(ids: string[]): Promise<Record<string, Record<string, unknown> | undefined>> {
  const paths: string[] = [];
  for (const id of ids) {
    for (const channel of ['email', 'sms', 'push'] as const) {
      paths.push(`${CHANNEL_COLLECTIONS[channel]}/${id}`);
    }
  }
  if (paths.length === 0) return {};
  const snaps = await db().getAll(...paths.map((p) => db().doc(p)));
  const existing: Record<string, Record<string, unknown> | undefined> = {};
  snaps.forEach((snap, i) => {
    existing[paths[i]] = snap.exists ? (snap.data() as Record<string, unknown>) : undefined;
  });
  return existing;
}

/** Exported for tests: the committed corpus is clean, so a refused row needs a planned corpus. */
export function toRows(plan: ImportPlan): ImportReportRow[] {
  return plan.templates.map((t) => ({
    templateId: t.templateId,
    aliasOf: NOTIFICATION_KEY_ALIASES[t.templateId]?.canonical ?? null,
    channels: t.channels.map((c) => ({ channel: c.channel, outcome: c.outcome, notes: c.notes })),
    differsFromRepo: t.differsFromRepo,
    blocked: t.blocked,
    issues: t.blocked ? t.issues : [],
  }));
}

export async function importSeedTemplatesHandler(
  req: CallableRequest<unknown>,
): Promise<ImportSeedTemplatesResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const args = Args.parse(req.data ?? {});
  // Absent means dry run. An import callable whose default writes is one
  // mis-shaped payload away from replacing 45 templates nobody reviewed.
  const dryRun = args.dryRun !== false;

  if (args.onlyIds) {
    const known = new Set(SEED_CORPUS.map((e) => e.key));
    const unknown = args.onlyIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new HttpsError(
        'not-found',
        `No seed template on file for ${unknown.join(', ')}. ` +
          `The importer only knows the ${SEED_CORPUS.length} templates committed to the repo.`,
      );
    }
  }

  const consideredIds = (args.onlyIds ?? SEED_CORPUS.map((e) => e.key)) as string[];
  const existing = await readExisting(consideredIds);

  const plan = planImport({
    corpus: SEED_CORPUS,
    existing,
    overwriteIds: args.overwriteIds,
    onlyIds: args.onlyIds,
  });

  const rows = toRows(plan);
  const needsOverwriteChoice = plan.templates
    .filter((t) => !t.blocked && t.channels.some((c) => c.outcome === 'skipped'))
    .map((t) => t.templateId);
  const refused = plan.templates
    .filter((t) => t.blocked)
    .map((t) => ({ templateId: t.templateId, reason: t.issues[0] ?? 'Refused.' }));

  const writes = plannedWrites(plan);

  if (dryRun) {
    logEvent({
      severity: 'info',
      function: 'importSeedTemplates',
      event: 'admin.templates.import.planned',
      uid,
      extra: { considered: plan.templates.length, wouldWrite: writes.length, refused: refused.length },
    });
    return { dryRun: true, written: 0, counts: plan.counts, rows, needsOverwriteChoice, refused };
  }

  // One batch. 45 templates times 3 channels is 135 documents, comfortably
  // inside Firestore's 500 write limit, and the corpus cannot grow past 200
  // without someone noticing this comment.
  if (writes.length > 450) {
    throw new HttpsError(
      'failed-precondition',
      `This import would write ${writes.length} documents, past the ${450} a single batch can carry. ` +
        `Import in smaller runs using onlyIds.`,
    );
  }

  const batch = db().batch();
  for (const write of writes) {
    const data: Record<string, unknown> = {
      ...write.content,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: uid,
      ...(write.isCreate ? { createdAt: FieldValue.serverTimestamp(), createdBy: uid } : {}),
    };
    // merge, not replace: see the header. The authoring fields on an existing
    // emailTemplates document survive an import untouched.
    batch.set(db().doc(write.path), data, { merge: true });
  }
  if (writes.length > 0) await batch.commit();

  logEvent({
    severity: 'info',
    function: 'importSeedTemplates',
    event: 'admin.templates.imported',
    uid,
    extra: {
      written: writes.length,
      created: plan.counts.create,
      overwritten: plan.counts.overwrite,
      skipped: plan.counts.skipped,
      refused: refused.length,
    },
  });

  return {
    dryRun: false,
    written: writes.length,
    counts: plan.counts,
    rows,
    needsOverwriteChoice,
    refused,
  };
}

export const importSeedTemplates = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('importSeedTemplates', importSeedTemplatesHandler),
);
