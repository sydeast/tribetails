/**
 * Shared types for the runtime-options drift check (issue #453).
 *
 * The six fields below are exactly the ones ADR-0004's "What could not be
 * verified" section names as unread: deployed `cpu`, `minInstances`,
 * `maxInstances` and `concurrency` were never confirmed against the running
 * fleet, only inferred from source, and memory was already known to disagree
 * for 53 functions. `concurrency` itself is not one of the six — it is not an
 * independently declared setting in either source or the deploy tooling, it
 * is `cpu >= 1 ? 80 : 1`, derived by firebase-tools' own
 * `resolveCpuAndConcurrency`. There is nothing to diff there that isn't
 * already implied by `cpu`.
 */

/** The six runtime settings source declares and a deploy can disagree on. */
export type RuntimeKey =
  'cpu' | 'memory' | 'minInstances' | 'maxInstances' | 'timeoutSeconds' | 'region';

export const RUNTIME_KEYS: readonly RuntimeKey[] = [
  'cpu',
  'memory',
  'minInstances',
  'maxInstances',
  'timeoutSeconds',
  'region',
];

/**
 * A fully resolved shape for one function: every field has a concrete value,
 * because inheritance has already been applied. `memory` is canonicalized to
 * a MiB integer and `cpu` to a number so two spellings of the same setting
 * ('256MiB' from source, `256` from a deploy dump) compare equal.
 */
export interface RuntimeShape {
  cpu: number;
  memory: number; // MiB
  minInstances: number;
  maxInstances: number;
  timeoutSeconds: number;
  region: string;
}

/**
 * The same shape, but any field the input didn't carry is `undefined` rather
 * than defaulted. Used for what a deploy dump reports: the Firebase MCP
 * `functions_list_functions` tool, for example, gives `memory` and `region`
 * only, never `cpu`/`minInstances`/`maxInstances`/`timeoutSeconds` — see
 * ADR-0004. Diffing must skip a field neither side actually reported rather
 * than manufacture a mismatch out of "undefined vs 256".
 */
export type PartialRuntimeShape = Partial<RuntimeShape>;

/** Cloud Functions generation. v1 functions don't take the v2 options this tool resolves. */
export type FunctionGeneration = 'gen1' | 'gen2';

/**
 * One property of a source options object literal, in the order it appears.
 * Mirrors JS object-literal-with-spread semantics: a `spread` expands the
 * named constant's fields at that position, and a later `prop` with the same
 * key overrides it — including a `prop` that appears BEFORE a `spread` that
 * doesn't touch that key (see `loginSecurity.ts`'s
 * `{ minInstances: 1, ...FULL_CPU }`, where `minInstances` survives because
 * `FULL_CPU` doesn't declare it).
 */
export type OptionsFragment =
  { kind: 'prop'; key: RuntimeKey; value: string | number } | { kind: 'spread'; constant: string };

/** One function as source declares it, before resolution. */
export interface RawFunctionDeclaration {
  /** The deployed callable/trigger name (the export from index.ts). */
  name: string;
  /** Path to the file the export re-exports from, relative to repo root. */
  file: string;
  /** 1-based line of the trigger-factory call, for pointing a reader at it. */
  line: number;
  /** e.g. 'onCall', 'onSchedule', 'onDocumentCreated', 'beforeUserSignedIn'. */
  trigger: string;
  generation: FunctionGeneration;
  /** In source order. Empty when the call passes no options object at all. */
  fragments: OptionsFragment[];
}

/** A function after resolving its fragments against the fleet default. */
export interface ResolvedFunctionDeclaration {
  name: string;
  file: string;
  line: number;
  trigger: string;
  generation: FunctionGeneration;
  shape: RuntimeShape;
}

export interface FieldDiff {
  field: RuntimeKey;
  expected: RuntimeShape[RuntimeKey];
  deployed: RuntimeShape[RuntimeKey];
}

export interface FunctionDiff {
  name: string;
  file?: string;
  line?: number;
  mismatches: FieldDiff[];
}
