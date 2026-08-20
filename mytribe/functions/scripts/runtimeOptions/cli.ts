/**
 * runtimeOptionsDrift.ts (issue #453)
 *
 * Diffs what `mytribe/functions/src` declares for every function's runtime
 * options (memory, cpu, minInstances, maxInstances, timeoutSeconds, region)
 * against what's actually deployed. Source is resolved exactly —
 * `setGlobalOptions`, the three named constants in `lib/runtimeOptions.ts`,
 * and every function's own override, merged in the order a JS object literal
 * would merge them (`resolveAll.ts` / `model.ts`). The deployed side has to
 * come from the operator; this process can't reach it (`gcloud` returns
 * empty with exit 0 from an agent session — see ADR-0004).
 *
 * USAGE
 *
 *   npm --prefix mytribe/functions run runtime-options:expected
 *     Prints the resolved expected shape for every function as JSON. No
 *     deployed data needed — useful on its own to sanity-check what source
 *     currently declares, and as the "something exact to compare against"
 *     issue #453 asked for.
 *
 *   npm --prefix mytribe/functions run runtime-options:diff -- --deployed <path>
 *     Diffs the expected shape against an operator-produced dump at <path>.
 *     <path> is EITHER:
 *       - the raw JSON result of the Firebase MCP `functions_list_functions`
 *         tool ({"functions":[{"function":"getMyHome","memory":256,...}]}).
 *         Only memory and region are ever populated by that tool.
 *       - `gcloud functions list --v2 --format=json > dump.json`, run by the
 *         operator (agent sessions get an empty, exit-0 result from gcloud —
 *         a false negative, not "no functions"). This is the one that can
 *         fill in cpu/minInstances/maxInstances/timeoutSeconds via
 *         serviceConfig.*.
 *     Prints ONLY the functions that disagree, plus separate buckets for
 *     "deployed but not declared here" (expect ~10-14 AuntieOS functions
 *     sharing the `auntieos-ttpc` project, per ADR-0004 — not drift in this
 *     codebase) and "declared here but not deployed at all".
 *
 * Exit code is 0 only when there is nothing to report: no mismatches, no
 * source-only functions, and nothing this tool failed to parse. A nonzero
 * exit is meant to be readable in CI/operator output, not just checked.
 */
import { writeFileSync } from 'node:fs';

import { loadDeployedFleetShape, loadDeployedTimestamps } from './deployedShape';
import { diffFleet, GEN1_COMPARABLE_FIELDS } from './model';
import { resolveAll } from './resolveAll';
import { RUNTIME_KEYS, RuntimeKey } from './types';

function formatValue(field: RuntimeKey, value: unknown): string {
  if (field === 'memory') return `${value}MiB`;
  if (field === 'cpu') return `${value} vCPU`;
  return String(value);
}

function printExpectedOnly(): number {
  const { fleetDefault, declarations, errors } = resolveAll();
  const payload = {
    fleetDefault,
    functions: declarations
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({
        name: d.name,
        file: d.file,
        line: d.line,
        trigger: d.trigger,
        generation: d.generation,
        ...d.shape,
      })),
  };
  console.log(JSON.stringify(payload, null, 2));
  if (errors.length > 0) {
    console.error(`\n${errors.length} export(s) could not be resolved from source:`);
    for (const err of errors) console.error(`  ${err.name}: ${err.message}`);
    return 1;
  }
  return 0;
}

/**
 * When the fleet actually deployed, which is a different question from what it
 * declares and the one nobody could answer before #504.
 *
 * Printed as a spread rather than a single date on purpose. A fleet deployed in
 * one window is ordinary; a fleet whose oldest function predates its newest by
 * days means some deploy did not finish, and the functions left behind are
 * serving older code while reporting nothing wrong. That is exactly what #503
 * was: 209 functions from one evening and a contiguous alphabetical block of 25
 * still on the previous day's source.
 *
 * ONLY functions this codebase declares. The `auntieos-ttpc` project is shared,
 * and AuntieOS's own functions deploy on their own schedule from another tree,
 * so including them made the first version of this report name thirteen
 * perfectly healthy functions as a stalled deploy.
 */
function printDeployWindow(deployedAtMs: Record<string, number>, ours: Set<string>): void {
  const mine = Object.entries(deployedAtMs).filter(([name]) => ours.has(name));
  const stamps = mine.map(([, ms]) => ms);
  if (stamps.length === 0) return;
  const oldest = new Date(Math.min(...stamps));
  const newest = new Date(Math.max(...stamps));
  const spreadHours = (newest.getTime() - oldest.getTime()) / 3_600_000;
  console.log(
    `Deployed source spans ${oldest.toISOString().slice(0, 16)} to ` +
      `${newest.toISOString().slice(0, 16)} (${spreadHours.toFixed(1)}h).`,
  );
  if (spreadHours > 24) {
    const cutoff = newest.getTime() - 24 * 3_600_000;
    const stale = mine
      .filter(([, ms]) => ms < cutoff)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
    console.log(
      `  ${stale.length} function(s) are more than a day older than the newest deploy.`,
    );
    console.log('  A contiguous run of these is a deploy that stopped partway (#503):');
    for (const name of stale) console.log(`    ${name}`);
  }
  console.log('');
}
function printDiff(deployedPath: string, outPath: string | undefined): number {
  const { declarations, errors } = resolveAll();
  const deployed = loadDeployedFleetShape(deployedPath);
  const deployedAtMs = loadDeployedTimestamps(deployedPath);
  const { matched, deployedOnly, sourceOnly } = diffFleet(declarations, deployed);

  console.log(
    `Compared ${declarations.length} source-declared function(s) against ${Object.keys(deployed).length} deployed.\n`,
  );

  printDeployWindow(deployedAtMs, new Set(declarations.map((d) => d.name)));

  if (matched.length === 0) {
    console.log(
      'No field-level mismatches on any function present in both source and the deploy dump.\n',
    );
  } else {
    console.log(`${matched.length} function(s) disagree with source:\n`);
    for (const fn of matched.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${fn.name}  (${fn.file}:${fn.line})`);
      for (const m of fn.mismatches) {
        console.log(
          `    ${m.field.padEnd(14)} expected ${formatValue(m.field, m.expected)}, deployed ${formatValue(m.field, m.deployed)}`,
        );
      }
    }
    console.log('');
  }

  if (sourceOnly.length > 0) {
    console.log(
      `${sourceOnly.length} function(s) declared in source but absent from the deploy dump:`,
    );
    for (const name of sourceOnly) console.log(`  ${name}`);
    console.log(
      '  (Never deployed, deployed under a different name, or the dump is stale/partial.)\n',
    );
  }

  if (deployedOnly.length > 0) {
    console.log(
      `${deployedOnly.length} deployed function(s) not declared in mytribe/functions/src ` +
        `(expected: AuntieOS's own functions sharing the auntieos-ttpc project, and any admin codebase, per ADR-0004):`,
    );
    for (const name of deployedOnly) console.log(`  ${name}`);
    console.log('');
  }

  if (errors.length > 0) {
    console.error(
      `${errors.length} export(s) could not be resolved from source, and were NOT included in the comparison above:`,
    );
    for (const err of errors) console.error(`  ${err.name}: ${err.message}`);
    console.error('');
  }

  const report = {
    comparedSourceFunctions: declarations.length,
    comparedDeployedFunctions: Object.keys(deployed).length,
    mismatches: matched,
    sourceOnly,
    deployedOnly,
    unresolved: errors,
    deployedAtMs,
    fieldsCompared: RUNTIME_KEYS,
    gen1ComparableFields: GEN1_COMPARABLE_FIELDS,
  };
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Wrote full report to ${outPath}`);
  }

  return matched.length === 0 && sourceOnly.length === 0 && errors.length === 0 ? 0 : 1;
}

function main(): number {
  const args = process.argv.slice(2);
  const deployedIndex = args.indexOf('--deployed');
  const outIndex = args.indexOf('--out');
  const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

  if (deployedIndex === -1) {
    return printExpectedOnly();
  }
  const deployedPath = args[deployedIndex + 1];
  if (!deployedPath) {
    console.error(
      '--deployed requires a path to an operator-produced dump. See the header comment for the accepted shapes.',
    );
    return 2;
  }
  return printDiff(deployedPath, outPath);
}

process.exitCode = main();
