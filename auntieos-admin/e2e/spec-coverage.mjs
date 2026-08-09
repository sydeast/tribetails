#!/usr/bin/env node
/**
 * Proves that every spec file under `e2e/` is collected by exactly one project.
 *
 * WHY A CHECK AND NOT A COMMENT. `playwright.config.ts` used to select specs
 * with one hand-maintained regex per project. A spec file nobody added to it
 * was collected by no project, so the run reported green having never opened
 * the file. The comment above that regex asked people to remember; a spec added
 * that day still ran zero times and passed. The config now makes `operator` the
 * default so the accident cannot happen by omission, and this check is what
 * says so out loud rather than leaving it to be re-derived from the regexes.
 *
 * HOW IT KNOWS. It asks Playwright, twice, rather than reimplementing
 * `testMatch`. `--list` collects without booting the emulators, the vite server
 * or globalSetup, so this is cheap enough to sit in front of every `npm run
 * e2e`. The second pass sets `VISUAL_CAPTURE=1`, which is the only way
 * `visual.capture.spec.ts` is ever collected: a spec has to be claimed in at
 * least one of the two modes, and within either mode by no more than one
 * project. That phrasing means the capture-only exclusion needs no second copy
 * of itself in here to be excused.
 *
 * IT ALSO CATCHES AN EMPTY SPEC. A `.spec.ts` file that declares no tests lists
 * nothing, so it reads as uncollected and fails here. That is the same
 * "executes nothing, reports success" failure wearing a different hat, and it
 * is a true positive, not noise to suppress.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = resolve(E2E_DIR, '..');
const CONFIG = relative(ADMIN_DIR, join(E2E_DIR, 'playwright.config.ts'));

/** Playwright's own output directory, and never a source of specs. */
const SKIP_DIRS = new Set(['.artifacts', '.auth', 'node_modules', 'playwright-report']);

function specFilesOnDisk(dir = E2E_DIR) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...specFilesOnDisk(join(dir, entry.name)));
    } else if (entry.name.endsWith('.spec.ts')) {
      found.push(relative(E2E_DIR, join(dir, entry.name)));
    }
  }
  return found;
}

/**
 * @param {Record<string, string>} env
 * @returns {Map<string, Set<string>>} spec file (relative to e2e/) -> project names
 */
function collectedBy(env) {
  // `--list --reporter=json` on stdout. Playwright writes its own diagnostics to
  // stderr, which is inherited so a config that fails to load is legible here.
  const raw = execFileSync(
    'npx',
    ['playwright', 'test', '--config', CONFIG, '--list', '--reporter=json'],
    { cwd: ADMIN_DIR, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
  );

  const byFile = new Map();
  const walk = (suite, inheritedFile) => {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        // Suite files are reported relative to the config's `testDir`, i.e. e2e/.
        if (!byFile.has(file)) byFile.set(file, new Set());
        byFile.get(file).add(test.projectName);
      }
    }
    for (const child of suite.suites ?? []) walk(child, file);
  };
  for (const suite of JSON.parse(raw).suites ?? []) walk(suite, undefined);
  return byFile;
}

const MODES = [
  { label: 'npm run e2e', env: {} },
  { label: 'npm run visual:react (VISUAL_CAPTURE=1)', env: { VISUAL_CAPTURE: '1' } },
];

const onDisk = specFilesOnDisk().sort();
const perMode = MODES.map((mode) => ({ ...mode, collected: collectedBy(mode.env) }));

const problems = [];

for (const file of onDisk) {
  const claims = perMode.filter((mode) => mode.collected.has(file));
  if (claims.length === 0) {
    problems.push(
      `${file} is collected by NO project, in any mode, so it would never run and the suite ` +
        `would still report green.\n` +
        `    Either it declares no tests, or a testIgnore in playwright.config.ts excludes it ` +
        `without any project claiming it back.`,
    );
  }
  for (const mode of claims) {
    const projects = [...mode.collected.get(file)].sort();
    if (projects.length > 1) {
      problems.push(
        `${file} is collected by ${projects.length} projects under ${mode.label}: ` +
          `${projects.join(', ')}.\n` +
          `    It would run twice, once with a session and once without, and only one of those ` +
          `is the run it was written for.`,
      );
    }
  }
}

// Specs Playwright collected that are not on disk would mean this check is
// reading the wrong directory, which would make a green result meaningless.
for (const mode of perMode) {
  for (const file of mode.collected.keys()) {
    if (file.endsWith('.spec.ts') && !onDisk.includes(file)) {
      problems.push(
        `${file} was collected under ${mode.label} but is not among the spec files this check ` +
          `found on disk. ${E2E_DIR} is not the directory Playwright is reading.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`\nSpec coverage check FAILED (${problems.length}):\n`);
  for (const problem of problems) console.error(`  - ${problem}\n`);
  process.exit(1);
}

const counts = perMode
  .map((mode) => {
    const specs = [...mode.collected.keys()].filter((f) => f.endsWith('.spec.ts'));
    return `${specs.length} under ${mode.label}`;
  })
  .join(', ');
console.log(`Spec coverage OK: all ${onDisk.length} spec files run in exactly one project (${counts}).`);
