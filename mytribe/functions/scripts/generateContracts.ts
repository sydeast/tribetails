/**
 * generateContracts.ts
 *
 * Writes the Contracts module (CONTEXT.md) from the server zod schemas, and in
 * `--check` mode is the CI gate that makes the committed artifacts trustworthy
 * (ADR-0001 decisions 2 and 3).
 *
 *   npm --prefix mytribe/functions run contracts:generate   rewrite the files
 *   npm --prefix mytribe/functions run contracts:check      fail on any diff
 *
 * THE GATE IS THE POINT, not the writing. Committed generated code that
 * nothing verifies is a hand-mirror with a misleading header: it drifts the
 * same way, and the header makes a reader trust it more. `--check` regenerates
 * into memory and compares byte for byte, so a schema change whose fallout was
 * not regenerated is red before it merges, and a hand edit to a generated file
 * is red the moment it is pushed.
 *
 * A REFUSAL IS NOT A CRASH. When a schema uses a construct with no faithful
 * generated form, the reader throws a `ContractGenerationError` naming the
 * field path, and this script prints that message alone rather than a stack
 * trace of the generator's own internals. The operator's next move is to
 * change the schema or to teach the emitters; a stack trace helps with
 * neither.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { BOOKING_ARTIFACT_PATHS, generateArtifacts, type GeneratedArtifact } from './contracts/artifacts';
import { GENERATE_COMMAND } from './contracts/header';
import { BOOKING_CONTRACT_REGISTRY, INVOICE_CONTRACT_REGISTRY } from './contracts/registry';

/** `<repo>/mytribe/functions/scripts` -> `<repo>`. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** The first line where two texts differ, 1-based, or null when they match. */
function firstDifferingLine(expected: string, actual: string): number | null {
  if (expected === actual) return null;
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const shared = Math.min(expectedLines.length, actualLines.length);
  for (let i = 0; i < shared; i += 1) {
    if (expectedLines[i] !== actualLines[i]) return i + 1;
  }
  return shared + 1;
}

function write(artifacts: GeneratedArtifact[]): number {
  for (const artifact of artifacts) {
    const target = join(REPO_ROOT, artifact.path);
    mkdirSync(dirname(target), { recursive: true });
    const unchanged = existsSync(target) && readFileSync(target, 'utf8') === artifact.contents;
    if (!unchanged) writeFileSync(target, artifact.contents, 'utf8');
    console.log(`${unchanged ? 'unchanged' : 'written  '}  ${artifact.path}  (${artifact.consumer})`);
  }
  return 0;
}

function check(artifacts: GeneratedArtifact[]): number {
  const stale: string[] = [];
  for (const artifact of artifacts) {
    const target = join(REPO_ROOT, artifact.path);
    if (!existsSync(target)) {
      stale.push(`${artifact.path}: missing entirely`);
      continue;
    }
    const onDisk = readFileSync(target, 'utf8');
    const line = firstDifferingLine(artifact.contents, onDisk);
    if (line === null) {
      console.log(`ok        ${artifact.path}`);
    } else {
      stale.push(`${artifact.path}: first difference at line ${line}`);
    }
  }

  if (stale.length === 0) {
    console.log(`\nThe committed Contracts module matches the server schemas.`);
    return 0;
  }

  console.error('\nThe committed Contracts module does NOT match the server schemas:\n');
  for (const entry of stale) console.error(`  ${entry}`);
  console.error(
    `\nEither a schema changed without its generated fallout, or a generated file was ` +
      `hand-edited.\nRun:  ${GENERATE_COMMAND}\nand commit the result alongside the schema change.`,
  );
  return 1;
}

function main(): number {
  const checkOnly = process.argv.includes('--check');
  let artifacts: GeneratedArtifact[];
  try {
    artifacts = [
      ...generateArtifacts(INVOICE_CONTRACT_REGISTRY),
      ...generateArtifacts(BOOKING_CONTRACT_REGISTRY, BOOKING_ARTIFACT_PATHS),
    ];
  } catch (err) {
    // The reader and the Kotlin emitter both refuse by throwing a named error
    // whose message IS the report. Anything else is a real generator bug and
    // keeps its stack.
    const name = (err as Error)?.name;
    if (name === 'ContractGenerationError' || name === 'KotlinEmitError') {
      console.error(`Contract generation refused:\n\n  ${(err as Error).message}\n`);
      return 2;
    }
    throw err;
  }
  return checkOnly ? check(artifacts) : write(artifacts);
}

process.exitCode = main();
