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

import { loadDeployedFleetShape } from './deployedShape';
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

function printDiff(deployedPath: string, outPath: string | undefined): number {
  const { declarations, errors } = resolveAll();
  const deployed = loadDeployedFleetShape(deployedPath);
  const { matched, deployedOnly, sourceOnly } = diffFleet(declarations, deployed);

  console.log(
    `Compared ${declarations.length} source-declared function(s) against ${Object.keys(deployed).length} deployed.\n`,
  );

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
