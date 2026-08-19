/**
 * Adapters from what an operator can actually produce to the
 * `PartialRuntimeShape` map the diff needs. Two shapes are supported because
 * two tools were tried while building this (see the RUNBOOK entry this ships
 * with):
 *
 *   - The Firebase MCP `functions_list_functions` tool, which DOES work from
 *     an agent session here (confirmed while building this, 2026-08-19) but
 *     only ever reports `function`, `version`, `trigger`, `location` and
 *     `memory` — never `cpu`/`minInstances`/`maxInstances`/`timeoutSeconds`.
 *     That's not a bug in this adapter; it's the whole tool's surface, and
 *     it's exactly the gap ADR-0004's "What could not be verified" section
 *     names.
 *   - `gcloud functions describe <name> --gen2 --format=json`, or
 *     `gcloud functions list --v2 --format=json` for the whole fleet, which
 *     the operator runs (agent sessions get an empty result with exit 0 from
 *     `gcloud`, a false negative rather than an answer — also ADR-0004).
 *     This is the one that can fill in `cpu`, `minInstances`,
 *     `maxInstances` and `timeoutSeconds` via `serviceConfig.*`.
 *
 * Both normalize into the same `DeployedFleetShape`, so `cli.ts` and the diff
 * don't need to know which one produced a given dump.
 */
import { readFileSync } from 'node:fs';

import { parseCpu, parseMemoryToMiB } from './model';
import { PartialRuntimeShape } from './types';

export type DeployedFleetShape = Record<string, PartialRuntimeShape>;

/** One row as `functions_list_functions` (or its raw MCP JSON) returns it. */
interface FirebaseMcpFunctionRow {
  function: string;
  version?: string;
  trigger?: string;
  location?: string;
  memory?: number | string;
  runtime?: string;
}

interface FirebaseMcpDump {
  functions: FirebaseMcpFunctionRow[];
}

function isFirebaseMcpDump(value: unknown): value is FirebaseMcpDump {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { functions?: unknown }).functions) &&
    (value as FirebaseMcpDump).functions.every(
      (row) => typeof row === 'object' && row !== null && 'function' in row,
    )
  );
}

export function fromFirebaseMcpDump(dump: FirebaseMcpDump): DeployedFleetShape {
  const result: DeployedFleetShape = {};
  for (const row of dump.functions) {
    const shape: PartialRuntimeShape = {};
    if (row.memory !== undefined) shape.memory = parseMemoryToMiB(row.memory);
    if (row.location !== undefined) shape.region = row.location;
    result[row.function] = shape;
  }
  return result;
}

/** One row of `gcloud functions list --v2 --format=json` (Cloud Run `serviceConfig`). */
interface GcloudFunctionRow {
  name: string; // "projects/<p>/locations/<region>/functions/<name>"
  serviceConfig?: {
    availableMemory?: string;
    availableCpu?: string | number;
    timeoutSeconds?: number;
    minInstanceCount?: number;
    maxInstanceCount?: number;
  };
}

function isGcloudDump(value: unknown): value is GcloudFunctionRow[] {
  return (
    Array.isArray(value) &&
    value.every((row) => typeof row === 'object' && row !== null && 'name' in row)
  );
}

/** `projects/foo/locations/us-central1/functions/getMyHome` -> `{ name: 'getMyHome', region: 'us-central1' }`. */
function parseGcloudFullName(fullName: string): { name: string; region: string } {
  const match = /\/locations\/([^/]+)\/functions\/([^/]+)$/.exec(fullName);
  if (!match) throw new Error(`Cannot parse gcloud function name: ${JSON.stringify(fullName)}`);
  return { region: match[1], name: match[2] };
}

export function fromGcloudDump(rows: GcloudFunctionRow[]): DeployedFleetShape {
  const result: DeployedFleetShape = {};
  for (const row of rows) {
    const { name, region } = parseGcloudFullName(row.name);
    const shape: PartialRuntimeShape = { region };
    const svc = row.serviceConfig;
    if (svc?.availableMemory !== undefined) shape.memory = parseMemoryToMiB(svc.availableMemory);
    if (svc?.availableCpu !== undefined) shape.cpu = parseCpu(svc.availableCpu);
    if (svc?.timeoutSeconds !== undefined) shape.timeoutSeconds = svc.timeoutSeconds;
    if (svc?.minInstanceCount !== undefined) shape.minInstances = svc.minInstanceCount;
    if (svc?.maxInstanceCount !== undefined) shape.maxInstances = svc.maxInstanceCount;
    result[name] = shape;
  }
  return result;
}

/**
 * Loads an operator-produced dump from disk and normalizes it, auto-detecting
 * which of the two shapes above it is. Throws on anything else, naming both
 * accepted shapes, rather than guessing.
 */
export function loadDeployedFleetShape(path: string): DeployedFleetShape {
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (isFirebaseMcpDump(parsed)) return fromFirebaseMcpDump(parsed);
  if (isGcloudDump(parsed)) return fromGcloudDump(parsed);
  throw new Error(
    `${path} matches neither known shape: a Firebase MCP functions_list_functions dump ` +
      `({"functions":[{"function":...}]}) or a gcloud functions list --v2 --format=json array ` +
      `([{"name":"projects/.../functions/..."}]).`,
  );
}
