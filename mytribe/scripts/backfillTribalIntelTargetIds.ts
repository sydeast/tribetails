/**
 * backfillTribalIntelTargetIds.ts
 *
 * Issue #460, operator ruling 2026-08-18: "legacy rows should not keep names.
 * A row without an id gets one."
 *
 *   FROM  training_documents/{id}   kinfolkRef: "Jane Halbrook"   (a NAME)
 *   TO    training_documents/{id}   targetKinfolkId: "kf_7Yx..."  (an ID)
 *                                   kinfolkRef:      "kf_7Yx..."  (the same id)
 *
 * ── WHY BOTH FIELDS GET THE ID ────────────────────────────────────────────
 * The nightly Python pipeline resolves a note with
 * `log.get("targetKinfolkId") or log.get("kinfolkRef")`
 * (`auntieos-admin/web/functions-python/reconcile_comms.py:194`) and then looks
 * that value up as a `kinfolk` document id. A name misses, the note is skipped,
 * and intel an operator deliberately filed never reaches the dossier. Writing
 * the id to BOTH fields keeps that OR working whichever branch it takes, and
 * is what actually un-sticks the legacy rows.
 *
 * `targetType` is deliberately NOT touched. Issue #393 ruled that a row with no
 * stored type reads as HOUSEHOLD — the widest, non-fabricating answer — and
 * gains an explicit one the first time an operator saves it. This script is
 * about WHO the row points at, not about narrowing what it claims.
 *
 * ── THE FOUR ANSWERS, and the two it refuses to give ──────────────────────
 *   RESOLVED   the name matches exactly one kinfolk. Store that id.
 *   CREATE     the name matches none. The operator ruling is that the row gets
 *              a real id rather than staying text, so the kinfolk record is
 *              created and the row points at it. This is the loudest section of
 *              the report on purpose: a name that SHOULD have matched but did
 *              not becomes a duplicate person record, and only a human reading
 *              the dry run can catch that before it happens.
 *   AMBIGUOUS  the name matches more than one household. NEVER guessed. Listed
 *              with every candidate and left exactly as it was.
 *   DANGLING   the reference is id-shaped but names no kinfolk (a household
 *              deleted after the note was filed). Reported, never "created":
 *              a kinfolk record named after a 20-character hash is garbage, and
 *              the operator has to say who that note was really about.
 * A row with no reference at all is reported too. There is nothing in it to
 * resolve, so nothing can be invented for it.
 *
 * ── FAMILIES ──────────────────────────────────────────────────────────────
 * Creating `kinfolk/{id}` fires the deployed `onKinfolkCreate` trigger
 * (`functions/src/index.ts` exports it), which provisions the matching
 * `families/{id}` envelope. This script deliberately does not write that
 * envelope itself — two writers for one document is how they drift.
 *
 * Modes:
 *   default        DRY RUN. Prints the plan and writes nothing.
 *   --allow-prod   applies, batched under Firestore's 500-op limit.
 *
 * Runbook: run DRY first, read the CREATE and AMBIGUOUS sections, then re-run
 * with --allow-prod. This script has NOT been run against production as part of
 * the PR that ships it; it is a runbook step the operator performs.
 */
import { getApps, initializeApp, getFirestore, type Firestore } from './lib/firebaseAdmin';

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  allowProd: boolean;
  projectId: string | null;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'dry-run', allowProd: false, projectId: null };
  // AN EXPLICIT --dry-run ALWAYS WINS, in either flag order. Tracked separately
  // from `args.mode` because the `if (args.allowProd) args.mode = 'apply'` below
  // runs once, AFTER the whole argv has been scanned — so `--allow-prod
  // --dry-run` would silently re-flip mode to 'apply' if this flag's own
  // presence weren't remembered past the loop. Same shape as the sibling
  // backfills, and it matters more here: this script CREATES person records.
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--allow-prod') args.allowProd = true;
    else if (a === '--dry-run') explicitDryRun = true;
    else if (a === '--project') {
      const v = argv[i + 1];
      // Reject a flag as the value, not just a missing one: `--project` with no
      // id would otherwise swallow whatever followed it, and the token most
      // likely to follow is `--dry-run`.
      if (!v || v.startsWith('--')) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfillTribalIntelTargetIds.ts: give legacy Tribal Intel rows real target ids (issue #460)',
          '',
          '  npm run backfill:tribal-intel-ids                    # DRY RUN (default)',
          '  npm run backfill:tribal-intel-ids -- --allow-prod    # apply',
          '  npm run backfill:tribal-intel-ids -- --dry-run       # force dry-run, ALWAYS wins',
          '  npm run backfill:tribal-intel-ids -- --project <id>  # override project',
          '',
          '--dry-run overrides --allow-prod regardless of which comes first on the',
          'command line (e.g. "--allow-prod --dry-run" still does not write).',
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

// ── name matching (pure) ───────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Case- and punctuation-insensitive form used on BOTH sides of every
 * comparison, so "Halbrook, Jane" and "jane  halbrook" reduce to the same two
 * tokens and an em-dash or a double space never decides whether a note finds
 * its household.
 */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Every string a legacy import could plausibly have written for one kinfolk.
 *
 * The precedence order of `deriveKinfolkDisplayName`
 * (`functions/src/triggers/familyProvision.ts`) is the list of things this
 * codebase already treats as "the name of this household", so the same fields
 * are what a name-carrying `kinfolkRef` was most likely copied from. The
 * reversed token order is added because "Lastname Firstname" is how a spreadsheet
 * export orders a name column, and the old system's export is exactly where
 * these rows came from.
 */
export function kinfolkNameCandidates(data: Record<string, unknown>): string[] {
  const first = str(data['firstName']);
  const last = str(data['lastName']);
  const out = [
    str(data['displayName']),
    str(data['businessName']),
    `${first} ${last}`.trim(),
    `${last} ${first}`.trim(),
    str(data['email']),
  ];
  return out.map(normalizeName).filter((v) => v !== '');
}

/**
 * The key two about-to-be-created names share when they are the same name
 * written differently. Order-insensitive, because "Bell, Nora" and "Nora Bell"
 * are one person and inventing two records for them would be the sweep's own
 * duplicate.
 */
export function creationKey(name: string): string {
  return normalizeName(name).split(' ').filter((t) => t !== '').sort().join(' ');
}

export interface KinfolkRow {
  id: string;
  data: Record<string, unknown>;
}

/** Normalized name -> every kinfolk id that answers to it. More than one is an ambiguity, never a winner. */
export function buildNameIndex(rows: readonly KinfolkRow[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    for (const name of new Set(kinfolkNameCandidates(row.data))) {
      const ids = index.get(name) ?? [];
      if (!ids.includes(row.id)) ids.push(row.id);
      index.set(name, ids);
    }
  }
  return index;
}

/**
 * Whether a reference looks like a document id rather than something a person
 * wrote.
 *
 * This decides which of two things happens to a reference that matches no
 * kinfolk: a person record gets created for it, or it is reported for a human.
 * Getting it wrong in the cautious direction costs a line in the report;
 * getting it wrong in the other direction creates a `kinfolk` record called
 * "Xk92mZq0aB4cD7eF1gH3", so the rule is deliberately biased:
 *
 *   more than one token          -> written by a person ("Jane Halbrook")
 *   one plain alphabetic word    -> written by a person ("Cher", "O'Brien"),
 *     shorter than a generated id   which covers mononyms and one-word businesses
 *   anything else with no space  -> an id. Digits, underscores and dashes are
 *                                   what ids are made of ("demo-family-001"),
 *                                   and 20 characters of mixed case is exactly
 *                                   a Firestore auto-id.
 */
export function looksLikeDocumentId(value: string): boolean {
  const v = value.trim();
  if (v === '' || /\s/.test(v)) return false;
  if (v.length < 16 && /^[A-Za-z'’.]+$/.test(v)) return false;
  return true;
}

// ── the per-row decision (pure) ────────────────────────────────────────────

export type TargetPlan =
  /** Already points at a live kinfolk, and both fields agree. Nothing to do. */
  | { kind: 'ok'; id: string }
  /** Points at a live kinfolk, but the two fields disagree. Both are set to the id. */
  | { kind: 'mirror'; id: string }
  /** The reference is a name matching exactly one kinfolk. */
  | { kind: 'resolved'; name: string; id: string }
  /** The reference is a name matching no kinfolk. A record is created for it. */
  | { kind: 'create'; name: string }
  /** The reference is a name matching several households. Left untouched. */
  | { kind: 'ambiguous'; name: string; candidates: string[] }
  /** Id-shaped, but no such kinfolk. Left untouched. */
  | { kind: 'dangling'; value: string }
  /** No reference at all. Left untouched. */
  | { kind: 'empty' };

/**
 * The decision for ONE `training_documents` row. PURE: takes the pre-built
 * roster index rather than a Firestore handle, so the whole rule is unit-tested
 * against fixtures and the live run does exactly one scan of each collection.
 */
export function planTargetForRow(
  data: Record<string, unknown>,
  knownKinfolkIds: ReadonlySet<string>,
  nameIndex: ReadonlyMap<string, string[]>,
): TargetPlan {
  const explicit = str(data['targetKinfolkId']);
  const legacy = str(data['kinfolkRef']);
  // `targetKinfolkId` wins when present: it is the field the callables write and
  // the field the Python pipeline reads first.
  const anchor = explicit !== '' ? explicit : legacy;

  if (anchor === '') return { kind: 'empty' };

  if (knownKinfolkIds.has(anchor)) {
    return explicit === anchor && legacy === anchor
      ? { kind: 'ok', id: anchor }
      : { kind: 'mirror', id: anchor };
  }

  const matches = nameIndex.get(normalizeName(anchor)) ?? [];
  if (matches.length === 1) return { kind: 'resolved', name: anchor, id: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', name: anchor, candidates: [...matches] };
  return looksLikeDocumentId(anchor) ? { kind: 'dangling', value: anchor } : { kind: 'create', name: anchor };
}

// ── the kinfolk record a CREATE writes ─────────────────────────────────────

/** Greppable provenance so a record invented by this sweep can always be found again. */
export const CREATED_BY_BACKFILL = 'backfillTribalIntelTargetIds';

/**
 * Splits a written name the conventional way: the last token is the surname,
 * everything before it is the given name. One token becomes a given name with
 * no surname, because a household label built from a guessed surname would read
 * as a family this person may not have.
 */
export function splitWrittenName(name: string): { firstName: string; lastName: string } {
  const tokens = name.trim().split(/\s+/).filter((t) => t !== '');
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0], lastName: '' };
  return { firstName: tokens.slice(0, -1).join(' '), lastName: tokens[tokens.length - 1] };
}

/**
 * The kinfolk document a CREATE writes.
 *
 * The RAW string is preserved verbatim in `displayName`, so whatever the old
 * system actually recorded survives the split and nothing is lost to a naming
 * convention this script guessed at. No `joinDate`, no email, no phone: the
 * note carries none of those, and a fabricated one would read as fact.
 */
export function buildCreatedKinfolkDoc(name: string, sourceDocIds: readonly string[]): Record<string, unknown> {
  const { firstName, lastName } = splitWrittenName(name);
  return {
    firstName,
    lastName,
    displayName: name,
    status: 'active',
    _createdBy: CREATED_BY_BACKFILL,
    _createdFromTribalIntelDocIds: [...sourceDocIds],
  };
}

// ── the whole-collection plan ──────────────────────────────────────────────

export interface Creation {
  /** Allocated up front so the DRY RUN prints the exact id the apply will use. */
  kinfolkId: string;
  name: string;
  doc: Record<string, unknown>;
  trainingDocIds: string[];
}

export interface RowWrite {
  trainingDocId: string;
  targetKinfolkId: string;
  /** Why this row is being written, for the report. */
  reason: 'mirror' | 'resolved' | 'created';
  /** The value that was stored before, so the report shows the repair. */
  was: string;
}

export interface Ambiguity {
  trainingDocId: string;
  name: string;
  candidates: Array<{ id: string; label: string }>;
}

export interface Summary {
  scanned: number;
  alreadyResolvable: number;
  mirrored: number;
  resolvedByName: number;
  pointedAtNewRecords: number;
  ambiguous: Ambiguity[];
  dangling: Array<{ trainingDocId: string; value: string }>;
  noTarget: string[];
}

export interface Plan {
  summary: Summary;
  creations: Creation[];
  writes: RowWrite[];
}

export interface TrainingDocRow {
  id: string;
  data: Record<string, unknown>;
}

/** A short human label for a kinfolk, for the ambiguity list. */
export function kinfolkLabel(id: string, data: Record<string, unknown>): string {
  const name = str(data['displayName']) || `${str(data['firstName'])} ${str(data['lastName'])}`.trim();
  const email = str(data['email']);
  const parts = [name === '' ? '(no name on file)' : name];
  if (email !== '') parts.push(email);
  return `${parts.join(' · ')} [${id}]`;
}

/**
 * Turns two collection scans into the full plan. PURE apart from `newId`, which
 * is Firestore's own offline id generator (`collection.doc().id` writes
 * nothing), so the dry run can print the exact ids an apply would use.
 */
export function buildPlanFrom(
  kinfolkRows: readonly KinfolkRow[],
  trainingRows: readonly TrainingDocRow[],
  newId: () => string,
): Plan {
  const knownIds = new Set(kinfolkRows.map((r) => r.id));
  const nameIndex = buildNameIndex(kinfolkRows);
  const kinfolkById = new Map(kinfolkRows.map((r) => [r.id, r.data] as const));

  const summary: Summary = {
    scanned: 0,
    alreadyResolvable: 0,
    mirrored: 0,
    resolvedByName: 0,
    pointedAtNewRecords: 0,
    ambiguous: [],
    dangling: [],
    noTarget: [],
  };
  const writes: RowWrite[] = [];
  // Keyed by SORTED normalized tokens so twelve notes about the same missing
  // person produce ONE record, not twelve duplicates of them — including when
  // the old system wrote the name both ways round ("Nora Bell" in one row,
  // "Bell, Nora" in the next). Sorting can only ever MERGE two records that are
  // both about to be invented, and both spellings are listed in the report
  // against the one record they produced.
  const creationsByName = new Map<string, Creation>();

  for (const row of trainingRows) {
    summary.scanned += 1;
    const was = str(row.data['targetKinfolkId']) || str(row.data['kinfolkRef']);
    const plan = planTargetForRow(row.data, knownIds, nameIndex);

    switch (plan.kind) {
      case 'ok':
        summary.alreadyResolvable += 1;
        break;
      case 'mirror':
        summary.mirrored += 1;
        writes.push({ trainingDocId: row.id, targetKinfolkId: plan.id, reason: 'mirror', was });
        break;
      case 'resolved':
        summary.resolvedByName += 1;
        writes.push({ trainingDocId: row.id, targetKinfolkId: plan.id, reason: 'resolved', was });
        break;
      case 'create': {
        summary.pointedAtNewRecords += 1;
        const key = creationKey(plan.name);
        const existing = creationsByName.get(key);
        if (existing) {
          existing.trainingDocIds.push(row.id);
          writes.push({
            trainingDocId: row.id,
            targetKinfolkId: existing.kinfolkId,
            reason: 'created',
            was,
          });
          break;
        }
        const kinfolkId = newId();
        creationsByName.set(key, {
          kinfolkId,
          name: plan.name,
          doc: buildCreatedKinfolkDoc(plan.name, [row.id]),
          trainingDocIds: [row.id],
        });
        writes.push({ trainingDocId: row.id, targetKinfolkId: kinfolkId, reason: 'created', was });
        break;
      }
      case 'ambiguous':
        summary.ambiguous.push({
          trainingDocId: row.id,
          name: plan.name,
          candidates: plan.candidates.map((id) => ({
            id,
            label: kinfolkLabel(id, kinfolkById.get(id) ?? {}),
          })),
        });
        break;
      case 'dangling':
        summary.dangling.push({ trainingDocId: row.id, value: plan.value });
        break;
      case 'empty':
        summary.noTarget.push(row.id);
        break;
    }
  }

  // Every source doc id, not just the first, so the created record says which
  // notes asked for it.
  const creations = [...creationsByName.values()].map((c) => ({
    ...c,
    doc: buildCreatedKinfolkDoc(c.name, c.trainingDocIds),
  }));
  return { summary, creations, writes };
}

export async function buildPlan(db: Firestore): Promise<Plan> {
  // One scan each. A per-row lookup over a collection this size is what turns a
  // five-minute sweep into an hour of reads.
  const [kinfolkSnap, trainingSnap] = await Promise.all([
    db.collection('kinfolk').get(),
    db.collection('training_documents').get(),
  ]);
  const kinfolkRows: KinfolkRow[] = kinfolkSnap.docs.map((d) => ({
    id: d.id,
    data: (d.data() ?? {}) as Record<string, unknown>,
  }));
  const trainingRows: TrainingDocRow[] = trainingSnap.docs.map((d) => ({
    id: d.id,
    data: (d.data() ?? {}) as Record<string, unknown>,
  }));
  return buildPlanFrom(kinfolkRows, trainingRows, () => db.collection('kinfolk').doc().id);
}

// ── the report ─────────────────────────────────────────────────────────────

/** Mechanical buckets are truncated so the sections a human must READ stay visible. */
const MECHANICAL_LIST_CAP = 20;

export function reportLines(plan: Plan, mode: Mode): string[] {
  const { summary } = plan;
  const out: string[] = [];
  const untouched = summary.ambiguous.length + summary.dangling.length + summary.noTarget.length;

  out.push('');
  out.push(`=== Tribal Intel target ids, issue #460 (${mode === 'dry-run' ? 'DRY RUN' : 'APPLY'}) ===`);
  out.push(`training_documents scanned    : ${summary.scanned}`);
  out.push(`already point at a live id    : ${summary.alreadyResolvable}`);
  out.push(`id copied across both fields  : ${summary.mirrored}`);
  out.push(`names resolved to an existing : ${summary.resolvedByName}`);
  out.push(`rows pointed at a NEW record  : ${summary.pointedAtNewRecords}`);
  out.push(`kinfolk records to CREATE     : ${plan.creations.length}`);
  out.push(`AMBIGUOUS, left untouched     : ${summary.ambiguous.length}`);
  out.push(`dangling ids, left untouched  : ${summary.dangling.length}`);
  out.push(`no target at all, untouched   : ${summary.noTarget.length}`);
  out.push(`row writes planned            : ${plan.writes.length}`);
  out.push(`rows a human must decide      : ${untouched}`);

  const resolved = plan.writes.filter((w) => w.reason === 'resolved');
  if (resolved.length > 0) {
    out.push('');
    out.push('-- NAMES MATCHED TO AN EXISTING KINFOLK --');
    for (const w of resolved) {
      out.push(`  training_documents/${w.trainingDocId}  "${w.was}" -> ${w.targetKinfolkId}`);
    }
  }

  if (plan.creations.length > 0) {
    out.push('');
    out.push('-- KINFOLK RECORDS TO CREATE. READ THIS SECTION FIRST. --');
    out.push('   Each name below matched NO kinfolk on the roster. If one of them is');
    out.push('   somebody who is already a client under a different spelling, this run');
    out.push('   will create a DUPLICATE person. Fix the roster (or the note) first.');
    for (const c of plan.creations) {
      out.push(`  kinfolk/${c.kinfolkId}  from "${c.name}"`);
      out.push(`      ${JSON.stringify(c.doc)}`);
      out.push(`      pointed at by: ${c.trainingDocIds.join(', ')}`);
    }
    out.push('   The deployed onKinfolkCreate trigger provisions families/{id} for each');
    out.push('   of these; this script does not write that envelope itself.');
  }

  if (summary.ambiguous.length > 0) {
    out.push('');
    out.push('-- AMBIGUOUS: the name matches more than one household. NOT written. --');
    out.push('   Nothing is guessed here. Repoint each note by hand in Tribal Intel.');
    for (const a of summary.ambiguous) {
      out.push(`  training_documents/${a.trainingDocId}  "${a.name}" matches ${a.candidates.length}:`);
      for (const c of a.candidates) out.push(`      ${c.label}`);
    }
  }

  if (summary.dangling.length > 0) {
    out.push('');
    out.push('-- DANGLING IDS: id-shaped, but no such kinfolk. NOT written. --');
    out.push('   Probably a household deleted after the note was filed. No record is');
    out.push('   invented from an id, so a person has to say who these were about.');
    for (const d of summary.dangling) {
      out.push(`  training_documents/${d.trainingDocId}  "${d.value}"`);
    }
  }

  if (summary.noTarget.length > 0) {
    out.push('');
    out.push('-- NO TARGET AT ALL. NOT written. --');
    out.push('   These rows name nobody, so there is nothing in them to resolve.');
    for (const id of summary.noTarget) out.push(`  training_documents/${id}`);
  }

  const mirrors = plan.writes.filter((w) => w.reason === 'mirror');
  if (mirrors.length > 0) {
    out.push('');
    out.push('-- ID COPIED ACROSS BOTH FIELDS (mechanical) --');
    out.push('   These already resolve. The id is copied into whichever of');
    out.push('   targetKinfolkId / kinfolkRef was blank or stale, so the nightly');
    out.push('   pipeline resolves them down either branch of its OR.');
    for (const w of mirrors.slice(0, MECHANICAL_LIST_CAP)) {
      out.push(`  training_documents/${w.trainingDocId}  -> ${w.targetKinfolkId}`);
    }
    if (mirrors.length > MECHANICAL_LIST_CAP) {
      out.push(`  ... and ${mirrors.length - MECHANICAL_LIST_CAP} more`);
    }
  }

  out.push('');
  return out;
}

// ── apply ─────────────────────────────────────────────────────────────────

/** Applies the plan. Exported so the emulator test can prove the writes land. */
export async function applyPlan(db: Firestore, plan: Plan): Promise<void> {
  const CHUNK = 200;

  // Creations FIRST, and committed before any row points at them: a
  // training_documents row must never name a kinfolk id that does not exist
  // yet, or a reader between the two batches sees exactly the unresolvable
  // state this script exists to end.
  for (let i = 0; i < plan.creations.length; i += CHUNK) {
    const batch = db.batch();
    for (const c of plan.creations.slice(i, i + CHUNK)) {
      batch.set(db.collection('kinfolk').doc(c.kinfolkId), c.doc);
    }
    await batch.commit();
  }

  for (let i = 0; i < plan.writes.length; i += CHUNK) {
    const batch = db.batch();
    for (const w of plan.writes.slice(i, i + CHUNK)) {
      batch.set(
        db.collection('training_documents').doc(w.trainingDocId),
        // BOTH fields, because reconcile_comms.py reads either one.
        { targetKinfolkId: w.targetKinfolkId, kinfolkRef: w.targetKinfolkId },
        { merge: true },
      );
    }
    await batch.commit();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const emulator = process.env['FIRESTORE_EMULATOR_HOST'];
  // Belt and braces. `parseArgs` only ever sets mode='apply' under
  // `--allow-prod`, so this is unreachable today; it stands as a second,
  // independent assertion of the same invariant at the last moment before a run
  // that CREATES person records.
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

  const plan = await buildPlan(db);
  for (const line of reportLines(plan, args.mode)) console.log(line);

  if (args.mode === 'dry-run') {
    console.log('DRY RUN: nothing was written. Re-run with --allow-prod to apply.');
    return;
  }
  await applyPlan(db, plan);
  console.log(
    `APPLIED: ${plan.creations.length} kinfolk created, ${plan.writes.length} Tribal Intel row(s) repointed.`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
