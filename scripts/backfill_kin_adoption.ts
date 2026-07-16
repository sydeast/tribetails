/**
 * backfill_kin_adoption.ts
 *
 * One-off Firestore backfill that ADOPTS AuntieOS-only pets (flat `kin/{docId}`
 * docs with no `familyKinPath` link) into the MyTribe portal tree at
 * `families/{familyId}/kin/{kinId}`, so a real kinfolk signing in to the portal
 * sees their pets instead of an empty Kin list.
 *
 * WHY: the two-way mirror only serves ALREADY-adopted pets. The family -> flat
 * mirror (functions/src/triggers/onFamilyKinWrite.ts) stamps the symmetric
 * `familyKinPath` + `legacyKinId` links when a pet is created portal-side, and
 * the flat -> family mirror (functions/src/triggers/onFlatKinWrite.ts) is a
 * hard no-op for flat docs that carry no `familyKinPath`. Pets that AuntieOS
 * staff created BEFORE the portal existed are flat-only and invisible to the
 * portal forever. This script performs the initial adoption; the deployed
 * mirror triggers take over from there.
 *
 * DISCOVERED MAPPING (verified in code, 2026-07-09)
 * --------------------------------------------------
 * The AuntieOS numeric kinfolk id IS the MyTribe family id. Identity mapping,
 * no lookup table:
 *   - functions/src/admin/inviteKinfolkToPortal.ts states it outright: "The
 *     AuntieOS kinfolk doc id IS the MyTribe family id" and creates the portal
 *     envelope at `families/{kinfolkId}` for an existing `kinfolk/{kinfolkId}`.
 *   - functions/src/lib/resolveKinfolkAccess.ts: a portal user's
 *     `clients/{uid}.kinfolkIds` holds AuntieOS numeric ids ("3","6","8"...),
 *     and every portal callable (getMyKin, kinWrites, requestBooking) reads
 *     `families/{kinfolkId}/...` with that SAME id.
 *   - functions/src/triggers/onClientsWrite.ts back-writes `uid` onto
 *     `kinfolk/{kinfolkIds[0]}` — again the same id keys both collections.
 *   - scripts/backfillNestedInvoices.ts (the existing flat<->families bridge)
 *     treats the `families/{id}` path segment as the flat doc's `kinfolkId`
 *     directly (e.g. `families/3/invoices` -> `invoices/*.kinfolkId == "3"`).
 * So: flat `kin/{docId}.kinfolkId == familyId`. A family is RESOLVABLE when
 * the `families/{kinfolkId}` doc exists (provisioned by provisionTribe or
 * inviteKinfolkToPortal). No portal envelope -> no portal account yet -> SKIP,
 * never guessed.
 *
 * FIELD MAPPING flat -> family (family doc shape per getMyKin + kinMirror)
 * ------------------------------------------------------------------------
 * AuntieOS flat Kin model (AuntieOS FirestoreClient.kt / Models.kt): name,
 * species (default "Dog"), breed, age (STRING), sex, weight, status,
 * profilePictureUrl, colorMarkings, spayedNeutered, routine, trainingCommands,
 * feedingBrand, vaccinations, medicationHealthNotes, vetInfo, reactive,
 * officeNotes, ...
 *   - name/breed         copied when non-empty.
 *   - species            normalized to the portal's Title-Case convention
 *                        ("Dog"/"Cat"/"Bird" — see seed_test_sandbox.ts and the
 *                        AuntieOS default "Dog"): "dog" -> "Dog".
 *   - photoUrl           flat `photoUrl` if present, else AuntieOS
 *                        `profilePictureUrl`.
 *   - ageYears           flat `ageYears` number if present, else the first
 *                        decimal number parsed out of the flat `age` STRING
 *                        ("4", "4 years" -> 4). Unparseable or absurd (>100,
 *                        e.g. a birth year "2019") -> omitted.
 *   - care fields        the remaining PARENT_OWNED_FIELDS (feeding/walking
 *                        instructions, medications, allergies, emergencyNotes,
 *                        sitterNotes) copied when present and non-empty (only
 *                        exist on flat docs previously touched by the mirror).
 *   - staff fields       STAFF_EDITABLE_FIELDS (sex, weight, vetInfo, ...)
 *                        copied when present and non-empty-string.
 *   - status             'active', unless the flat doc is marked
 *                        inactive/archived/noLongerWithUs -> 'noLongerWithUs'
 *                        (the ONLY inactive value getMyKin's whitelist and the
 *                        portal memorial state understand).
 *   - legacyKinId        = flat doc id (joins the_411 AI blurb in getMyKin).
 *
 * LOOP-SAFE LINK STAMPING (guards read from onFamilyKinWrite/onFlatKinWrite)
 * --------------------------------------------------------------------------
 * The family doc is created WITH `legacyKinId` + `familyKinPath` pre-stamped
 * and `_mirrorOrigin: 'flat'`; the flat doc is then stamped with
 * `familyKinPath` + `legacyKinId` + `_mirrorOrigin: 'family'`. Cascade:
 *   - family create fires onFamilyKinWrite: mirrorFamilyKinToFlat takes the
 *     UPDATE path (legacyKinId already present -> no duplicate flat doc, no
 *     name-match lookup), ensureFamilyLink is a no-op (both links already
 *     present -> no second family write), and it merges one echo of the
 *     parent-owned fields onto the flat doc with `_mirrorOrigin: 'family'`.
 *   - `_mirrorOrigin: 'flat'` on the family doc suppresses the `pets.updated`
 *     notification (WARNING-27 flat-echo guard) — a backfill must not spam
 *     every kinfolk with "your pets changed".
 *   - our flat stamp AND the trigger echo both carry `_mirrorOrigin: 'family'`,
 *     so onFlatKinWrite's origin guard skips them (its no-staff-change guard
 *     would too). The cascade terminates with zero redundant mirror writes.
 *
 * IDEMPOTENCY
 * -----------
 *   - flat docs already carrying `familyKinPath` are skipped.
 *   - a `families/{id}/kin` doc with `legacyKinId == flat id` already existing
 *     downgrades the action to a link-repair stamp of the flat doc only
 *     (converges a run that died between the two writes).
 *   - new kin ids are deterministic: `adopted-{flatDocId}` — re-runs are
 *     no-ops, never duplicates.
 *   - never touches isTestData docs or the test-kinfolk-001 sandbox tribe.
 *
 * FAMILY PROVISIONING (--provision-families)
 * -------------------------------------------
 * By default a flat pet whose `families/{kinfolkId}` envelope is missing is
 * skipped (family_not_provisioned) — historically only inviteKinfolkToPortal /
 * provisionTribe created envelopes. With --provision-families, when the
 * kinfolk/{kinfolkId} doc EXISTS (and is not isTestData) the run first plans a
 * `families/{kinfolkId}` create with the SAME envelope shape the
 * onKinfolkCreate trigger writes (functions/src/triggers/familyProvision.ts —
 * replicates inviteKinfolkToPortal, provenance `provisionedBy:
 * 'backfill_kin_adoption'`), then plans the adoption as usual. One 'provision'
 * plan-table row per new family; applied with create() so an envelope that
 * appeared meanwhile is never clobbered. Kinfolk doc absent -> still SKIP
 * (kinfolk_missing); kinfolk marked isTestData -> SKIP (kinfolk_test_data).
 * Without the flag, behavior is unchanged.
 *
 * Usage (same conventions as seed_test_sandbox.ts):
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/auntieos-ttpc-sa.json
 *   cd MyTribe/functions
 *   # dry-run (default): prints the full plan table, writes nothing
 *   npx ts-node --project ../scripts/tsconfig.json ../scripts/backfill_kin_adoption.ts
 *   # apply:
 *   npx ts-node --project ../scripts/tsconfig.json ../scripts/backfill_kin_adoption.ts --apply
 *   # provision missing family envelopes for existing kinfolk, then adopt:
 *   npx ts-node --project ../scripts/tsconfig.json ../scripts/backfill_kin_adoption.ts --provision-families --apply
 *   # scope controls:
 *   ... backfill_kin_adoption.ts --family=6        # only this familyId
 *   ... backfill_kin_adoption.ts --limit=10        # cap mutating actions
 *   ... backfill_kin_adoption.ts --project <id>    # override project
 *
 * Safety:
 *   - DRY-RUN BY DEFAULT. --apply required for any write.
 *   - GOOGLE_APPLICATION_CREDENTIALS required (fail-loud, no silent ADC
 *     fallback); FIRESTORE_EMULATOR_HOST accepted for emulator runs.
 *   - Pure planners below carry every decision; Firestore I/O is confined to
 *     the runner at the bottom and is untested by vitest on purpose.
 */

import * as admin from 'firebase-admin';
import {
  MIRROR_ORIGIN_FAMILY,
  MIRROR_ORIGIN_FLAT,
  PARENT_OWNED_FIELDS,
  STAFF_EDITABLE_FIELDS,
} from '../functions/src/triggers/kinMirror';
import {
  buildFamilyProvisionDoc,
  isAlreadyExistsError,
  PROVISIONED_BY_BACKFILL,
} from '../functions/src/triggers/familyProvision';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sandbox tribe (scripts/seed_test_sandbox.ts). NEVER adopted. */
export const TEST_TRIBE_ID = 'test-kinfolk-001';

/** Flat statuses treated as inactive (mirrors onFamilyKinWrite INACTIVE_STATUSES). */
export const INACTIVE_FLAT_STATUSES: ReadonlySet<string> = new Set([
  'noLongerWithUs',
  'inactive',
  'archived',
]);

/**
 * Parent-owned fields handled explicitly (normalized) by buildFamilyKinDoc.
 * The remaining PARENT_OWNED_FIELDS are the care-instruction block, copied
 * verbatim when present.
 */
const IDENTITY_FIELDS: readonly string[] = ['name', 'species', 'breed', 'photoUrl', 'ageYears'];
const CARE_FIELDS: readonly string[] = PARENT_OWNED_FIELDS.filter(
  (f) => !IDENTITY_FIELDS.includes(f),
);

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

type Mode = 'dry-run' | 'apply';

export interface Args {
  mode: Mode;
  family: string | null;
  limit: number | null;
  projectId: string | null;
  provisionFamilies: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: 'dry-run',
    family: null,
    limit: null,
    projectId: null,
    provisionFamilies: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') {
      args.mode = 'apply';
    } else if (a === '--dry-run') {
      args.mode = 'dry-run';
    } else if (a === '--provision-families') {
      args.provisionFamilies = true;
    } else if (a.startsWith('--family=')) {
      const v = a.slice('--family='.length);
      if (!v) throw new Error('--family requires a value (--family=<familyId>)');
      args.family = v;
    } else if (a.startsWith('--limit=')) {
      const v = a.slice('--limit='.length);
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n <= 0) {
        throw new Error('--limit requires a positive integer (--limit=N)');
      }
      args.limit = n;
    } else if (a === '--project') {
      const v = argv[i + 1];
      if (!v) throw new Error('--project requires a value');
      args.projectId = v;
      i += 1;
    } else if (a === '--help' || a === '-h') {
      console.log(
        [
          'backfill_kin_adoption.ts — adopt AuntieOS-only flat kin/ pets into families/{id}/kin',
          '',
          'Usage:',
          '  ts-node backfill_kin_adoption.ts                       # dry-run (default): full plan table',
          '  ts-node backfill_kin_adoption.ts --apply               # perform the adoption writes',
          '  ts-node backfill_kin_adoption.ts --provision-families  # also create missing families/{kinfolkId}',
          '                                                         # envelopes for EXISTING kinfolk docs',
          '  ts-node backfill_kin_adoption.ts --family=<id>         # limit to one familyId',
          '  ts-node backfill_kin_adoption.ts --limit=N             # cap mutating actions at N',
          '  ts-node backfill_kin_adoption.ts --project <id>        # override project',
          '',
          'Env:',
          '  GOOGLE_APPLICATION_CREDENTIALS  service-account JSON path (required; no silent fallback)',
          '  GCLOUD_PROJECT                  Firebase project id (default auntieos-ttpc)',
          '  FIRESTORE_EMULATOR_HOST         when set, credentials not required',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Pure field normalizers
// ---------------------------------------------------------------------------

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/**
 * Normalizes a flat species value to the portal's Title-Case convention
 * ("Dog", "Cat", "Guinea Pig"). Returns null for empty/non-string input.
 */
export function normalizeSpecies(v: unknown): string | null {
  const s = nonEmptyString(v);
  if (!s) return null;
  return s
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Parses the AuntieOS flat `age` STRING (or a pre-existing number) into
 * ageYears. Takes the first decimal number in the string ("4" -> 4,
 * "4 years" -> 4, "4.5" -> 4.5). Unparseable, negative, or absurd (>100 —
 * catches birth-year strings like "2019") -> null (field omitted).
 */
export function parseAgeYears(v: unknown): number | null {
  let n: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    n = v;
  } else if (typeof v === 'string') {
    const m = v.match(/\d+(?:\.\d+)?/);
    n = m ? parseFloat(m[0]) : null;
  }
  if (n == null || !Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

/** Deterministic family-side kin id for a flat doc, so re-runs converge. */
export function adoptedKinId(flatDocId: string): string {
  return `adopted-${flatDocId}`;
}

// ---------------------------------------------------------------------------
// Pure planners
// ---------------------------------------------------------------------------

export interface PlannedWrite {
  path: string;
  data: Record<string, unknown>;
  merge: true;
}

export interface FlatKinInput {
  flatDocId: string;
  data: Record<string, unknown>;
}

/** Per-doc facts the runner resolves from Firestore before planning. */
export interface AdoptionContext {
  /** true when the `families/{kinfolkId}` doc exists (portal tree provisioned). */
  familyExists: boolean;
  /**
   * Doc id of an existing `families/{id}/kin` doc whose legacyKinId == this
   * flat doc id (adoption already done family-side), or null.
   */
  existingFamilyKinId: string | null;
  /**
   * `kinfolk/{kinfolkId}` doc data, resolved by the runner ONLY when
   * --provision-families is set and the family envelope is missing.
   * null = kinfolk doc absent; undefined = not fetched (treated as absent
   * by the provisioning path, which the runner never lets happen).
   */
  kinfolkDoc?: Record<string, unknown> | null;
}

export type SkipReason =
  | 'test_data'
  | 'no_kinfolk_id'
  | 'already_adopted'
  | 'family_not_provisioned'
  | 'kinfolk_missing'
  | 'kinfolk_test_data'
  | 'limit_reached';

export type AdoptionDecision =
  | {
      action: 'adopt';
      flatDocId: string;
      name: string | null;
      kinfolkId: string;
      familyId: string;
      newKinId: string;
      familyWrite: PlannedWrite;
      flatStamp: PlannedWrite;
    }
  | {
      action: 'stamp-only';
      flatDocId: string;
      name: string | null;
      kinfolkId: string;
      familyId: string;
      newKinId: string;
      flatStamp: PlannedWrite;
    }
  | {
      action: 'skip';
      flatDocId: string;
      name: string | null;
      kinfolkId: string | null;
      reason: SkipReason;
    }
  | {
      /**
       * --provision-families only: create the missing families/{kinfolkId}
       * envelope (same shape as onKinfolkCreate). One row per new family;
       * flatDocId is the pet that triggered it. Applied with create(), never
       * a clobbering set.
       */
      action: 'provision';
      flatDocId: string;
      name: string | null;
      kinfolkId: string;
      familyId: string;
      familyCreate: { path: string; data: Record<string, unknown> };
    };

/**
 * Builds the family-side kin doc from a flat AuntieOS kin doc. Pure.
 * Shape follows getMyKin's mapper + kinMirror's field ownership. Links and
 * `_mirrorOrigin: 'flat'` are pre-stamped (see header: loop-safe cascade,
 * suppresses the pets.updated notification for the backfill write).
 */
export function buildFamilyKinDoc(
  flatDocId: string,
  familyId: string,
  newKinId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {};

  const name = nonEmptyString(data.name);
  if (name) doc.name = name;
  const species = normalizeSpecies(data.species);
  if (species) doc.species = species;
  const breed = nonEmptyString(data.breed);
  if (breed) doc.breed = breed;

  // Portal field is photoUrl; AuntieOS stores the pet photo as profilePictureUrl.
  const photoUrl = nonEmptyString(data.photoUrl) ?? nonEmptyString(data.profilePictureUrl);
  if (photoUrl) doc.photoUrl = photoUrl;

  // Prefer a numeric ageYears (flat docs previously touched by the mirror);
  // else parse the AuntieOS `age` string.
  const ageYears =
    typeof data.ageYears === 'number' ? parseAgeYears(data.ageYears) : parseAgeYears(data.age);
  if (ageYears != null) doc.ageYears = ageYears;

  // Care-instruction block (parent-owned) — present only on flat docs the
  // family->flat mirror already wrote to; copy verbatim when non-empty.
  for (const f of CARE_FIELDS) {
    const v = nonEmptyString(data[f]);
    if (v) doc[f] = v;
  }

  // Staff-owned descriptive fields (flat->family direction per kinMirror).
  // Skip empty strings — AuntieOS models default every string field to "".
  for (const f of STAFF_EDITABLE_FIELDS) {
    const v = data[f];
    if (v === undefined || v === null || v === '') continue;
    doc[f] = v;
  }

  const flatStatus = typeof data.status === 'string' ? data.status : '';
  doc.status = INACTIVE_FLAT_STATUSES.has(flatStatus) ? 'noLongerWithUs' : 'active';

  doc.kinfolkId = familyId;
  doc.legacyKinId = flatDocId;
  doc.familyKinPath = `families/${familyId}/kin/${newKinId}`;
  doc._mirrorOrigin = MIRROR_ORIGIN_FLAT;
  doc.backfilledFromFlat = true;

  return doc;
}

/** The flat-doc link stamp. `_mirrorOrigin: 'family'` -> onFlatKinWrite skips it. */
export function buildFlatStamp(
  flatDocId: string,
  familyId: string,
  kinId: string,
): PlannedWrite {
  return {
    path: `kin/${flatDocId}`,
    data: {
      familyKinPath: `families/${familyId}/kin/${kinId}`,
      legacyKinId: flatDocId,
      _mirrorOrigin: MIRROR_ORIGIN_FAMILY,
    },
    merge: true,
  };
}

/**
 * Decides what to do with ONE flat kin doc. Pure — all Firestore facts arrive
 * via `ctx`. Skip order: test-data guards first (never even resolve them),
 * then link idempotency, then family resolution.
 */
export function planAdoption(input: FlatKinInput, ctx: AdoptionContext): AdoptionDecision {
  const { flatDocId, data } = input;
  const name = nonEmptyString(data.name);
  const kinfolkId = nonEmptyString(data.kinfolkId);

  if (
    data.isTestData === true ||
    kinfolkId === TEST_TRIBE_ID ||
    flatDocId.startsWith(TEST_TRIBE_ID)
  ) {
    return { action: 'skip', flatDocId, name, kinfolkId, reason: 'test_data' };
  }

  if (!kinfolkId) {
    return { action: 'skip', flatDocId, name, kinfolkId: null, reason: 'no_kinfolk_id' };
  }

  if (nonEmptyString(data.familyKinPath)) {
    return { action: 'skip', flatDocId, name, kinfolkId, reason: 'already_adopted' };
  }

  if (!ctx.familyExists) {
    return { action: 'skip', flatDocId, name, kinfolkId, reason: 'family_not_provisioned' };
  }

  // Identity mapping: the AuntieOS kinfolk id IS the family id (see header).
  const familyId = kinfolkId;

  // Family-side doc already linked to this flat doc -> only the flat link is
  // missing (e.g. a prior run died between the two writes). Repair the stamp.
  if (ctx.existingFamilyKinId) {
    return {
      action: 'stamp-only',
      flatDocId,
      name,
      kinfolkId,
      familyId,
      newKinId: ctx.existingFamilyKinId,
      flatStamp: buildFlatStamp(flatDocId, familyId, ctx.existingFamilyKinId),
    };
  }

  const newKinId = adoptedKinId(flatDocId);
  return {
    action: 'adopt',
    flatDocId,
    name,
    kinfolkId,
    familyId,
    newKinId,
    familyWrite: {
      path: `families/${familyId}/kin/${newKinId}`,
      data: buildFamilyKinDoc(flatDocId, familyId, newKinId, data),
      merge: true,
    },
    flatStamp: buildFlatStamp(flatDocId, familyId, newKinId),
  };
}

export interface RunPlan {
  decisions: AdoptionDecision[];
  /** Docs excluded by --family before planning (not skips, not in the table). */
  filteredOut: number;
  summary: {
    /** Flat kin docs planned (provision rows are extra, not counted here). */
    scanned: number;
    adopt: number;
    stampOnly: number;
    /** families/{id} envelopes to create (--provision-families only). */
    provision: number;
    skipped: Record<string, number>;
  };
}

/**
 * Plans the whole run. Pure. Deterministic order (sorted by flatDocId), then
 * --family filter, then per-doc planAdoption, then --limit applied to the
 * MUTATING actions (provision/adopt/stamp-only); candidates past the cap
 * become skip:limit_reached so the dry-run table still shows them.
 *
 * With opts.provisionFamilies, a family_not_provisioned skip is upgraded:
 *   - kinfolk doc absent            -> skip kinfolk_missing
 *   - kinfolk doc isTestData        -> skip kinfolk_test_data
 *   - kinfolk doc real              -> one 'provision' row per new family
 *                                      (deduped), then adoption planned as if
 *                                      the family existed.
 * Without the flag the behavior is byte-identical to before.
 */
export function planRun(
  inputs: FlatKinInput[],
  ctxByFlatId: Map<string, AdoptionContext>,
  opts: { family: string | null; limit: number | null; provisionFamilies?: boolean },
): RunPlan {
  const sorted = [...inputs].sort((a, b) =>
    a.flatDocId < b.flatDocId ? -1 : a.flatDocId > b.flatDocId ? 1 : 0,
  );

  const decisions: AdoptionDecision[] = [];
  const provisionedFamilies = new Set<string>();
  let filteredOut = 0;
  let mutating = 0;

  const limitReached = (): boolean => opts.limit != null && mutating >= opts.limit;

  for (const input of sorted) {
    const kinfolkId = nonEmptyString(input.data.kinfolkId);
    if (opts.family && kinfolkId !== opts.family) {
      filteredOut += 1;
      continue;
    }
    const ctx = ctxByFlatId.get(input.flatDocId) ?? {
      familyExists: false,
      existingFamilyKinId: null,
    };
    let decision = planAdoption(input, ctx);

    if (
      opts.provisionFamilies === true &&
      decision.action === 'skip' &&
      decision.reason === 'family_not_provisioned' &&
      decision.kinfolkId
    ) {
      const familyId = decision.kinfolkId;
      const kinfolkDoc = ctx.kinfolkDoc;
      if (kinfolkDoc == null) {
        // Kinfolk doc absent (or unresolved) -> still a skip, sharper reason.
        decision = { ...decision, reason: 'kinfolk_missing' };
      } else if (kinfolkDoc.isTestData === true) {
        decision = { ...decision, reason: 'kinfolk_test_data' };
      } else if (provisionedFamilies.has(familyId)) {
        // Envelope already planned earlier this run -> just plan the adoption.
        decision = planAdoption(input, { ...ctx, familyExists: true });
      } else if (limitReached()) {
        decision = { ...decision, reason: 'limit_reached' };
      } else {
        decisions.push({
          action: 'provision',
          flatDocId: input.flatDocId,
          name: null,
          kinfolkId: familyId,
          familyId,
          familyCreate: {
            path: `families/${familyId}`,
            data: buildFamilyProvisionDoc(familyId, kinfolkDoc, PROVISIONED_BY_BACKFILL),
          },
        });
        provisionedFamilies.add(familyId);
        mutating += 1;
        decision = planAdoption(input, { ...ctx, familyExists: true });
      }
    }

    if (decision.action !== 'skip') {
      if (limitReached()) {
        decision = {
          action: 'skip',
          flatDocId: decision.flatDocId,
          name: decision.name,
          kinfolkId: decision.kinfolkId,
          reason: 'limit_reached',
        };
      } else {
        mutating += 1;
      }
    }
    decisions.push(decision);
  }

  const summary: RunPlan['summary'] = {
    scanned: 0,
    adopt: 0,
    stampOnly: 0,
    provision: 0,
    skipped: {},
  };
  for (const d of decisions) {
    if (d.action === 'provision') {
      summary.provision += 1;
      continue; // extra row, not a scanned flat doc
    }
    summary.scanned += 1;
    if (d.action === 'adopt') summary.adopt += 1;
    else if (d.action === 'stamp-only') summary.stampOnly += 1;
    else summary.skipped[d.reason] = (summary.skipped[d.reason] ?? 0) + 1;
  }

  return { decisions, filteredOut, summary };
}

// ---------------------------------------------------------------------------
// Plan table printing (dry-run + apply both print it).
// ---------------------------------------------------------------------------

export function formatPlanTable(decisions: AdoptionDecision[]): string {
  const headers = ['flat id', 'pet name', 'kinfolkId', 'familyId / SKIP reason', 'action', 'new kin id'];
  const rows = decisions.map((d) => [
    d.flatDocId,
    d.name ?? '-',
    d.kinfolkId ?? '-',
    d.action === 'skip' ? `SKIP: ${d.reason}` : d.familyId,
    d.action,
    d.action === 'skip' || d.action === 'provision' ? '-' : d.newKinId,
  ]);
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

// ---------------------------------------------------------------------------
// Firestore I/O. Everything below is impure and NOT unit-tested; every
// decision lives in the pure planners above.
// ---------------------------------------------------------------------------

function initAdmin(projectId: string): void {
  const usingEmulator =
    typeof process.env.FIRESTORE_EMULATOR_HOST === 'string' &&
    process.env.FIRESTORE_EMULATOR_HOST.length > 0;
  const hasGac =
    typeof process.env.GOOGLE_APPLICATION_CREDENTIALS === 'string' &&
    process.env.GOOGLE_APPLICATION_CREDENTIALS.length > 0;
  if (!hasGac && !usingEmulator) {
    throw new Error(
      'backfill_kin_adoption: GOOGLE_APPLICATION_CREDENTIALS not set. Export the ' +
        'auntieos-ttpc service-account key path (or set FIRESTORE_EMULATOR_HOST). ' +
        'Refusing to fall back silently.',
    );
  }
  if (!admin.apps.length) {
    admin.initializeApp({
      ...(hasGac ? { credential: admin.credential.applicationDefault() } : {}),
      projectId,
    });
  }
}

interface RunResult {
  familiesAdopted: Set<string>;
  familyDocsWritten: number;
  flatDocsStamped: number;
  familiesProvisioned: Set<string>;
}

async function run(args: Args): Promise<void> {
  const db = admin.firestore();

  // 1. All provisioned portal families (identity mapping targets).
  const familiesSnap = await db.collection('families').select().get();
  const familyIds = new Set<string>(familiesSnap.docs.map((d) => d.id));
  console.log(`[scan] families provisioned: ${familyIds.size}`);

  // 2. Flat kin docs (narrowed server-side when --family is given).
  const kinQuery = args.family
    ? db.collection('kin').where('kinfolkId', '==', args.family)
    : db.collection('kin');
  const kinSnap = await kinQuery.get();
  const inputs: FlatKinInput[] = kinSnap.docs.map((d) => ({
    flatDocId: d.id,
    data: d.data() as Record<string, unknown>,
  }));
  console.log(`[scan] flat kin docs: ${inputs.length}`);

  // 3. Resolve per-doc context. The family-side legacyKinId lookup is only
  //    needed for docs that would otherwise be adopted (no familyKinPath, not
  //    test data, family exists — or about to exist via --provision-families).
  //    With --provision-families, kinfolk/{id} docs are fetched (once per id)
  //    for pets whose family envelope is missing.
  const ctxByFlatId = new Map<string, AdoptionContext>();
  const kinfolkCache = new Map<string, Record<string, unknown> | null>();
  for (const input of inputs) {
    const kinfolkId =
      typeof input.data.kinfolkId === 'string' && input.data.kinfolkId.trim().length > 0
        ? input.data.kinfolkId
        : null;
    const familyExists = kinfolkId != null && familyIds.has(kinfolkId);
    let existingFamilyKinId: string | null = null;
    let kinfolkDoc: Record<string, unknown> | null | undefined;
    const passesGuards =
      kinfolkId != null &&
      kinfolkId !== TEST_TRIBE_ID &&
      input.data.isTestData !== true &&
      !(typeof input.data.familyKinPath === 'string' && input.data.familyKinPath.length > 0);
    let willResolveFamily = familyExists;
    if (args.provisionFamilies && !familyExists && passesGuards && kinfolkId) {
      if (!kinfolkCache.has(kinfolkId)) {
        const snap = await db.collection('kinfolk').doc(kinfolkId).get();
        kinfolkCache.set(
          kinfolkId,
          snap.exists ? (snap.data() as Record<string, unknown>) : null,
        );
      }
      kinfolkDoc = kinfolkCache.get(kinfolkId);
      // A family about to be provisioned can still repair a half-done adoption
      // (subcollections can outlive/predate the parent envelope doc).
      willResolveFamily = kinfolkDoc != null && kinfolkDoc.isTestData !== true;
    }
    if (passesGuards && willResolveFamily && kinfolkId) {
      const linked = await db
        .collection(`families/${kinfolkId}/kin`)
        .where('legacyKinId', '==', input.flatDocId)
        .limit(1)
        .get();
      existingFamilyKinId = linked.docs.length > 0 ? linked.docs[0].id : null;
    }
    ctxByFlatId.set(input.flatDocId, { familyExists, existingFamilyKinId, kinfolkDoc });
  }

  // 4. Pure plan.
  const plan = planRun(inputs, ctxByFlatId, {
    family: args.family,
    limit: args.limit,
    provisionFamilies: args.provisionFamilies,
  });

  console.log('\n' + formatPlanTable(plan.decisions) + '\n');
  console.log('=== backfill_kin_adoption plan ===');
  console.log(`  scanned      : ${plan.summary.scanned}`);
  if (plan.filteredOut > 0) console.log(`  filteredOut  : ${plan.filteredOut} (--family)`);
  if (args.provisionFamilies) console.log(`  provision    : ${plan.summary.provision}`);
  console.log(`  adopt        : ${plan.summary.adopt}`);
  console.log(`  stamp-only   : ${plan.summary.stampOnly}`);
  console.log(`  skipped      :`);
  for (const [reason, n] of Object.entries(plan.summary.skipped)) {
    console.log(`    ${reason}: ${n}`);
  }

  if (args.mode !== 'apply') {
    console.log('\nDRY-RUN. No writes. Re-run with --apply to commit.');
    return;
  }

  // 5. Apply. Provision rows precede their adopt rows in plan order, and the
  //    family kin doc is written before the flat link stamp, so a crash between
  //    the two is repaired by the stamp-only path on the next run.
  const result: RunResult = {
    familiesAdopted: new Set<string>(),
    familyDocsWritten: 0,
    flatDocsStamped: 0,
    familiesProvisioned: new Set<string>(),
  };
  const serverTs = admin.firestore.FieldValue.serverTimestamp();
  for (const d of plan.decisions) {
    if (d.action === 'provision') {
      try {
        // create(), not set(): an envelope that appeared meanwhile (trigger,
        // inviteKinfolkToPortal, concurrent run) is never clobbered.
        await db.doc(d.familyCreate.path).create({
          ...d.familyCreate.data,
          createdAt: serverTs,
          updatedAt: serverTs,
        });
        result.familiesProvisioned.add(d.familyId);
        console.log(
          `[provision] ${d.familyCreate.path} displayName="${String(d.familyCreate.data.displayName)}"`,
        );
      } catch (err) {
        if (isAlreadyExistsError(err)) {
          console.log(`[provision] ${d.familyCreate.path} already exists — left untouched`);
        } else {
          throw err;
        }
      }
    } else if (d.action === 'adopt') {
      await db.doc(d.familyWrite.path).set(
        { ...d.familyWrite.data, createdAt: serverTs, updatedAt: serverTs },
        { merge: true },
      );
      result.familyDocsWritten += 1;
      console.log(`[adopt] ${d.familyWrite.path} (from kin/${d.flatDocId})`);
      await db.doc(d.flatStamp.path).set(d.flatStamp.data, { merge: true });
      result.flatDocsStamped += 1;
      console.log(`[stamp] ${d.flatStamp.path} familyKinPath=${d.flatStamp.data.familyKinPath}`);
      result.familiesAdopted.add(d.familyId);
    } else if (d.action === 'stamp-only') {
      await db.doc(d.flatStamp.path).set(d.flatStamp.data, { merge: true });
      result.flatDocsStamped += 1;
      console.log(`[stamp] ${d.flatStamp.path} familyKinPath=${d.flatStamp.data.familyKinPath} (repair)`);
      result.familiesAdopted.add(d.familyId);
    }
  }

  await db.collection('activity_log').add({
    timestamp: new Date().toISOString(),
    actionType: 'BACKFILL_KIN_ADOPTION',
    description: `familyDocs=${result.familyDocsWritten} flatStamped=${result.flatDocsStamped} families=${result.familiesAdopted.size} provisioned=${result.familiesProvisioned.size}`,
    status: 'SUCCESS',
    actorId: 'system:backfill_kin_adoption',
    targetId: '',
    targetCollection: 'kin',
    severity: 'info',
    actorRole: 'SYSTEM',
    payload: {
      familyDocsWritten: result.familyDocsWritten,
      flatDocsStamped: result.flatDocsStamped,
      familiesAdopted: [...result.familiesAdopted],
      familiesProvisioned: [...result.familiesProvisioned],
      summary: plan.summary,
    },
    createdAt: serverTs,
  });
  console.log('\nWrote activity_log entry (UNCHAINED — runs outside writeAuditEntry).');
  console.log(
    `\nfinal: familyDocsWritten=${result.familyDocsWritten} flatDocsStamped=${result.flatDocsStamped} families=${result.familiesAdopted.size} familiesProvisioned=${result.familiesProvisioned.size}`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `backfill_kin_adoption  mode=${args.mode}  family=${args.family ?? 'ALL'}  limit=${args.limit ?? 'none'}  provisionFamilies=${args.provisionFamilies}`,
  );
  const projectId = args.projectId ?? process.env.GCLOUD_PROJECT ?? 'auntieos-ttpc';
  initAdmin(projectId);
  console.log(`[init] projectId=${projectId}`);
  await run(args);
}

// Run main only when invoked directly. Importing for tests does not touch Firestore.
if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
