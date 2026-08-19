/**
 * Pure resolution and diff logic for the runtime-options drift check (#453).
 *
 * Nothing here touches a file system, a TypeScript program, or a network
 * call — that's `extractSource.ts` and `deployedShape.ts`. This module only
 * knows how to (a) turn a source options object into a concrete shape, given
 * the fleet default and the named constants it might spread, and (b) compare
 * two concrete shapes field by field. That split is what makes the fixtures
 * in `model.test.ts` exercise the actual merge semantics without needing a
 * real `index.ts` to parse.
 */
import {
  FieldDiff,
  FunctionDiff,
  OptionsFragment,
  PartialRuntimeShape,
  ResolvedFunctionDeclaration,
  RUNTIME_KEYS,
  RuntimeKey,
  RuntimeShape,
} from './types';

/**
 * firebase-functions v2's own defaults for whatever `setGlobalOptions`
 * doesn't set. Cited, not guessed: `GLOBAL_OPTIONS` in
 * `firebase-functions/lib/v2/options.js` defaults `region` to `us-central1`
 * and `timeoutSeconds` to `60`; a fresh `CloudFunction` with no `minInstances`
 * key deploys with `minInstanceCount` unset, which Cloud Run treats as 0.
 * `cpu` and `memory` are NOT defaulted here — this codebase's
 * `setGlobalOptions` always sets both (see `index.ts`), so relying on the
 * SDK's own further-upstream default (`cpu: 'gcf_gen1'`, `memory: '256MiB'`)
 * would hide a real regression if a future edit ever dropped one of them from
 * the call. Absence of `cpu`/`memory` in the resolved global options is a
 * bug in the extractor, not a case to paper over with a fallback.
 */
export const SDK_DEFAULTS: Pick<RuntimeShape, 'minInstances' | 'timeoutSeconds' | 'region'> = {
  minInstances: 0,
  timeoutSeconds: 60,
  region: 'us-central1',
};

const MIB_BYTES = 1024 * 1024;

/**
 * Bytes per unit, keyed by the unit letter with any trailing "B" stripped and
 * case-normalized ("MiB" -> "MI", "MB" -> "M", "Mi" -> "MI", "256" alone ->
 * "MI"/default). Binary units (the "I" forms: Ki/Mi/Gi) are powers of 1024,
 * matching Kubernetes/Cloud Run's `resource.Quantity` convention, which is
 * what `gcloud functions describe --format=json` reports
 * (`serviceConfig.availableMemory`). Decimal units (K/M/G, no "I") are powers
 * of 1000, for any dump that reports them that way.
 */
const MEMORY_UNIT_BYTES: Record<string, number> = {
  K: 1_000,
  KI: 1_024,
  M: 1_000_000,
  MI: MIB_BYTES,
  G: 1_000_000_000,
  GI: 1_024 * MIB_BYTES,
};

/**
 * Parses a Cloud Functions/Cloud Run memory value to a MiB integer, so
 * '256MiB' (source), 256 (the Firebase MCP `functions_list_functions` dump,
 * which is already MiB), and '256Mi' (a `gcloud` dump) all compare equal.
 */
export function parseMemoryToMiB(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)\s*([A-Za-z]*)$/.exec(value.trim());
  if (!match) throw new Error(`Cannot parse memory value: ${JSON.stringify(value)}`);
  const amount = Number(match[1]);
  const unitToken = match[2] || 'Mi';
  const unitKey = unitToken.toUpperCase().replace(/B$/, '') || 'MI';
  const bytesPerUnit = MEMORY_UNIT_BYTES[unitKey];
  if (bytesPerUnit === undefined) {
    throw new Error(`Unknown memory unit "${unitToken}" in: ${JSON.stringify(value)}`);
  }
  return (amount * bytesPerUnit) / MIB_BYTES;
}

/** Parses a Cloud Run cpu string or bare number ('1', '0.25', 1, 0.25) to a number. */
export function parseCpu(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) throw new Error(`Cannot parse cpu value: ${JSON.stringify(value)}`);
  return n;
}

function coerceRuntimeValue(key: RuntimeKey, value: string | number): string | number {
  if (key === 'memory') return parseMemoryToMiB(value);
  if (key === 'cpu') return parseCpu(value);
  if (key === 'region') return String(value);
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Resolves `setGlobalOptions({...})`'s own fragments against the SDK
 * defaults. `setGlobalOptions` in this codebase is a flat literal with no
 * spread, so this only needs `prop` fragments, but it reuses the same
 * fragment type as function-level resolution so both paths exercise one
 * merge function (`applyFragments`).
 */
export function resolveFleetDefault(globalFragments: OptionsFragment[]): RuntimeShape {
  const base: Partial<RuntimeShape> = { ...SDK_DEFAULTS };
  return applyFragments(base, globalFragments, {}) as RuntimeShape;
}

/**
 * Applies fragments to a base shape IN SOURCE ORDER, exactly like a JS
 * object literal: a `spread` fragment overwrites every field the named
 * constant declares, and a later `prop` overwrites whatever came before it,
 * spread or not. A `prop` that appears BEFORE a `spread` which doesn't touch
 * that key survives — this is the shape `loginSecurity.ts` relies on:
 * `{ minInstances: 1, ...FULL_CPU }`, where `FULL_CPU` is `{ cpu: 1,
 * maxInstances: 10 }` and never mentions `minInstances`.
 */
export function applyFragments(
  base: Partial<RuntimeShape>,
  fragments: OptionsFragment[],
  namedConstants: Record<string, Partial<RuntimeShape>>,
): Partial<RuntimeShape> {
  const result: Partial<RuntimeShape> = { ...base };
  for (const fragment of fragments) {
    if (fragment.kind === 'prop') {
      (result as Record<RuntimeKey, unknown>)[fragment.key] = coerceRuntimeValue(
        fragment.key,
        fragment.value,
      );
      continue;
    }
    const constant = namedConstants[fragment.constant];
    if (!constant) {
      throw new Error(
        `Unknown named constant "...${fragment.constant}" spread into an options object. ` +
          `Known constants: ${Object.keys(namedConstants).join(', ') || '(none)'}.`,
      );
    }
    Object.assign(result, constant);
  }
  return result;
}

/**
 * Resolves one function's declared fragments against the fleet default,
 * producing a shape with every field concrete. This IS "inheritance": a
 * function with zero fragments returns the fleet default verbatim, and a
 * function that only overrides `minInstances` still gets the fleet's `cpu`,
 * `memory`, `maxInstances`, `region` and the SDK's `timeoutSeconds`.
 */
export function resolveFunctionShape(
  fleetDefault: RuntimeShape,
  fragments: OptionsFragment[],
  namedConstants: Record<string, Partial<RuntimeShape>>,
): RuntimeShape {
  return applyFragments(fleetDefault, fragments, namedConstants) as RuntimeShape;
}

/**
 * Compares one function's expected (source-resolved) shape against what a
 * deploy dump reported. Only fields BOTH sides have an opinion on are
 * compared — a deploy dump missing `cpu` (as the Firebase MCP tool's does)
 * is silently skipped for that field rather than reported as a mismatch,
 * because "unknown" and "disagrees" are different findings and conflating
 * them is exactly how 53 real rows get lost in noise.
 */
export function diffShape(
  expected: RuntimeShape,
  deployed: PartialRuntimeShape,
  comparableFields: readonly RuntimeKey[] = RUNTIME_KEYS,
): FieldDiff[] {
  const mismatches: FieldDiff[] = [];
  for (const field of comparableFields) {
    const deployedValue = deployed[field];
    if (deployedValue === undefined) continue;
    if (deployedValue !== expected[field]) {
      mismatches.push({ field, expected: expected[field], deployed: deployedValue });
    }
  }
  return mismatches;
}

/**
 * v1 Cloud Functions are deliberately out of this tool's comparable scope.
 * `cpu` and `maxInstances`/concurrency are v2-only concepts entirely. Even
 * `memory`, `timeoutSeconds` and `region` — which v1 DOES have — are excluded
 * here rather than compared against a guessed SDK default: this codebase's
 * one v1 trigger (`onAuthUserCreate`) sets no `runWith`, so there is nothing
 * in SOURCE to resolve those fields from, only an assumption about what the
 * firebase-functions v1 SDK defaults to. Diffing against a guess and calling
 * a disagreement "source says X" would be exactly the false confidence this
 * tool exists to prevent. (For the record, since it's a genuinely interesting
 * data point: the live dump pulled while building this tool shows
 * `onAuthUserCreate` deployed in `us-east1`, not `us-central1` — worth an
 * operator gut-check, but reported as an observation in the RUNBOOK, not as
 * an automated finding this tool stands behind.)
 */
export const GEN1_COMPARABLE_FIELDS: readonly RuntimeKey[] = [];

export interface FleetDiffResult {
  /** Functions present on both sides: every mismatch found, field by field. */
  matched: FunctionDiff[];
  /** Deployed names with no matching source declaration — a separate bucket
   * on purpose (ADR-0004: ~10-14 of these are AuntieOS's own functions
   * sharing the `auntieos-ttpc` project, not drift in this codebase). */
  deployedOnly: string[];
  /** Source declares these, but the deploy dump has no entry for them at all
   * — e.g. never deployed, or deployed under a different name. */
  sourceOnly: string[];
}

/**
 * Compares every resolved source declaration against a deployed fleet dump,
 * bucketing by whether each side even knows about the function before
 * diffing fields. Mixing "deployed but unknown to source" into the mismatch
 * table would misreport every AuntieOS function sharing this project as a
 * drift; keeping it a separate, expected bucket is the fix ADR-0004 asked
 * for by name.
 */
export function diffFleet(
  declarations: ResolvedFunctionDeclaration[],
  deployed: Record<string, PartialRuntimeShape>,
): FleetDiffResult {
  const matched: FunctionDiff[] = [];
  const sourceOnly: string[] = [];
  const seenDeployedNames = new Set<string>();

  for (const decl of declarations) {
    const deployedShape = deployed[decl.name];
    if (!deployedShape) {
      sourceOnly.push(decl.name);
      continue;
    }
    seenDeployedNames.add(decl.name);
    const comparableFields = decl.generation === 'gen1' ? GEN1_COMPARABLE_FIELDS : RUNTIME_KEYS;
    const mismatches = diffShape(decl.shape, deployedShape, comparableFields);
    if (mismatches.length > 0) {
      matched.push({ name: decl.name, file: decl.file, line: decl.line, mismatches });
    }
  }

  const deployedOnly = Object.keys(deployed)
    .filter((name) => !seenDeployedNames.has(name) && !declarations.some((d) => d.name === name))
    .sort();

  return { matched, deployedOnly, sourceOnly: sourceOnly.sort() };
}
