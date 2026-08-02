#!/usr/bin/env node
/**
 * Which mytribe functions a release has to deploy, named exactly.
 *
 *   node scripts/function-targets.js                     every deployable name
 *   node scripts/function-targets.js --changed-from F    only the names a change
 *                                                        can reach (F holds
 *                                                        `git diff --name-status`)
 *   node scripts/function-targets.js --from-services F   lowercase Cloud Run
 *                                                        service names -> export
 *                                                        names, or refuse
 *
 * EXIT CODES ARE THE INTERFACE. release.sh branches on them:
 *   0  stdout is authoritative. Deploy exactly these names (possibly none).
 *   1  the fleet could not be enumerated at all. The caller must REFUSE; it has
 *      no list to deploy and guessing one is how functions go missing.
 *   3  the fleet is known but this change could not be attributed to a subset.
 *      The caller must deploy the FULL list. Never a failure, always a reason
 *      on stderr, and always the safe direction: more functions, not fewer.
 *
 * WHY THIS EXISTS
 * `firebase deploy --only functions:mytribe` hands the CLI all ~227 functions at
 * once. Each is its own Cloud Run service at 1 vCPU, a deploy starts a new
 * revision beside the old one, and the regional CpuAllocPerProjectRegion quota
 * is 200 vCPU. The whole fleet does not fit and cannot be made to fit. On
 * 2026-08-01 five full deploys each died partway (197/26, 131/95, 197/30,
 * 201/26, 0/26 succeeded/failed), and every recovery took the same shape:
 * redeploy the survivors BY NAME, in a batch, through safe-deploy.sh. So the
 * release now does by design what recovery did by hand, and this script is where
 * the names come from.
 *
 * WHY IT READS THE BUILT lib/ AND NOT THE SOURCE
 * The same reason scripts/declared-secrets.js does. Recovery on 2026-08-01 tried
 * to map lowercase Cloud Run service names back to exports by scanning
 * `export { ... }` blocks in src/index.ts and resolved 79 of 95: exports written
 * as `export { a, b } from` across lines, re-exported through barrels, or
 * renamed all read differently to a regex. `lib/index.js` is the module the
 * Firebase CLI itself loads, and an export carrying `__endpoint` is exactly what
 * the CLI treats as deployable. Asking the artifact agrees with the deployer by
 * construction rather than by resemblance. It resolved 227 of 227 the first time
 * it ran, and it says so on stderr every time so the claim stays checkable.
 *
 * WHAT IT CANNOT TELL YOU: whether any of these are currently deployed, or from
 * which commit. That lives in the project. `firebase functions:list` knows.
 */

const fs = require('fs');
const path = require('path');

// v1 providers (the auth trigger) build a resource name inside their own
// __endpoint getter and throw when the project environment is unset. Deploys set
// these; an analysis run has to set them too. Nothing here talks to the project.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'auntieos-ttpc';
process.env.FIREBASE_CONFIG =
  process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: process.env.GCLOUD_PROJECT });

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'mytribe', 'functions');
const LIB_DIR = path.join(FUNCTIONS_DIR, 'lib');
const LIB_INDEX = path.join(LIB_DIR, 'index.js');
const SRC_PREFIX = 'mytribe/functions/src/';
const FUNCTIONS_PREFIX = 'mytribe/functions/';

/** Refuse to enumerate. The caller must refuse the deploy. */
function cannotEnumerate(...lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

/** Known fleet, unattributable change. The caller must deploy all of it. */
function cannotNarrow(...lines) {
  for (const l of lines) console.error(l);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// The fleet.
// ---------------------------------------------------------------------------

/**
 * Every export of the built index that carries an `__endpoint`, sorted.
 *
 * A throwing getter is skipped rather than fatal, the same call the declared
 * secrets walk makes: one awkward export must not blind the enumeration. An
 * EMPTY result is fatal, because a codebase with no deployable functions is not
 * a state this repo can be in, and "found none" and "could not look" must never
 * print the same.
 */
function enumerateFleet(moduleExports) {
  const names = [];
  for (const [name, value] of Object.entries(moduleExports)) {
    let endpoint;
    try {
      endpoint = value && value.__endpoint;
    } catch {
      continue;
    }
    if (endpoint) names.push(name);
  }
  return names.sort();
}

function loadIndex() {
  if (!fs.existsSync(LIB_INDEX)) {
    cannotEnumerate(
      `no built functions at ${LIB_INDEX}.`,
      'The deployable names come from the artifact the Firebase CLI loads, so',
      'the functions have to be built first:  npm run build:functions',
    );
  }
  try {
    return require(LIB_INDEX);
  } catch (err) {
    cannotEnumerate(
      `could not load ${LIB_INDEX}: ${err.message}`,
      'Run `npm run build:functions` (and `npm run setup` if node_modules is stale).',
    );
  }
}

// ---------------------------------------------------------------------------
// Which module defines which function.
// ---------------------------------------------------------------------------

/**
 * export name -> the lib module(s) whose exports hold that exact object.
 *
 * Identity, not naming. `lib/index.js` re-exports through
 * `Object.defineProperty(exports, name, { get: ... })`, so the value handed out
 * is the SAME object the defining module exported, and `===` finds it with no
 * string matching anywhere. A function re-exported through two barrels resolves
 * to both, and both closures are unioned, which errs towards deploying more.
 */
function ownersByIdentity(fleetValues) {
  const owners = new Map();
  for (const [file, mod] of Object.entries(require.cache)) {
    if (!file.startsWith(LIB_DIR + path.sep)) continue;
    if (file === LIB_INDEX) continue;
    let exports;
    try {
      exports = mod && mod.exports;
    } catch {
      continue;
    }
    if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) continue;
    for (const key of Object.keys(exports)) {
      let value;
      try {
        value = exports[key];
      } catch {
        continue;
      }
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
      if (!fleetValues.has(value)) continue;
      if (!owners.has(value)) owners.set(value, new Set());
      owners.get(value).add(file);
    }
  }
  return owners;
}

// ---------------------------------------------------------------------------
// The module graph, read statically so LAZY requires are in it.
// ---------------------------------------------------------------------------

/**
 * Every `require("...")` edge between built lib modules.
 *
 * Static, not runtime, and that is the whole point. Several handlers require
 * their heavy dependencies inside the function body rather than at module load
 * (Sentry, the PDF writer), so a graph built from `module.children` after one
 * import would be missing exactly the edges that make a change invisible. tsc
 * emits every `import` and every `await import()` as a literal `require("...")`,
 * so scanning the emitted JS sees both kinds.
 *
 * A require whose argument is NOT a string literal, or a relative specifier that
 * does not resolve, means the graph has a hole. Either aborts narrowing (exit 3)
 * rather than producing a subset that quietly omits something.
 */
function buildGraph() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) files.push(p);
    }
  })(LIB_DIR);

  const deps = new Map();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const out = new Set();
    const re = /\brequire\s*\(/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const rest = text.slice(m.index + m[0].length);
      const quoted = /^\s*("([^"\n]*)"|'([^'\n]*)')/.exec(rest);
      if (!quoted) {
        cannotNarrow(
          `${path.relative(ROOT, file)} has a require() with a computed argument.`,
          'The module graph cannot be read statically past that, so a changed file',
          'cannot be attributed to the functions that load it. Deploying the full',
          'fleet instead, which is slower and correct.',
        );
      }
      const spec = quoted[2] !== undefined ? quoted[2] : quoted[3];
      if (!spec.startsWith('.')) continue;
      const resolved = resolveRelative(file, spec);
      if (!resolved) {
        cannotNarrow(
          `${path.relative(ROOT, file)} requires '${spec}', which resolves to nothing on disk.`,
          'A hole in the module graph makes any narrowed deploy a guess. Deploying',
          'the full fleet instead. A stale lib/ is the usual cause: npm run build:functions.',
        );
      }
      out.add(resolved);
    }
    deps.set(file, [...out]);
  }
  return { files, deps };
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.js`, path.join(base, 'index.js'), `${base}.json`];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** Every lib module reachable from `start`, `start` included. */
function closure(start, deps) {
  const seen = new Set();
  const stack = [...start];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of deps.get(file) || []) stack.push(dep);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Which changed paths matter.
// ---------------------------------------------------------------------------

/**
 * Paths under mytribe/functions that cannot reach a deployed function, because
 * nothing under lib/ is built from them and the runtime never reads them.
 *
 * Deliberately short. Everything not listed and not a compiled src file aborts
 * narrowing, so the cost of forgetting something here is a slower release, and
 * the cost of adding something wrong here is a function that does not ship.
 * package.json and package-lock.json are NOT here: a dependency bump changes
 * every function's runtime.
 */
const CANNOT_REACH_RUNTIME = [
  /^mytribe\/functions\/test\//,
  /^mytribe\/functions\/docs\//,
  /^mytribe\/functions\/scripts\//,
  /^mytribe\/functions\/[^/]*\.md$/,
  /^mytribe\/functions\/eslint\.config\.mjs$/,
  /^mytribe\/functions\/vitest[^/]*\.ts$/,
  /^mytribe\/functions\/tsconfig\.test\.json$/,
];

/**
 * Read `git diff --name-status` output.
 *
 * Only additions and modifications can be narrowed. A DELETE or a RENAME means a
 * module left its old path, and the stale lib/*.js it was compiled to may still
 * be sitting there being attributed to functions that no longer load it, so
 * those abort narrowing rather than being reasoned about.
 */
function readChanged(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    cannotNarrow(`could not read the changed-file list (${err.message}).`);
  }
  const paths = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const fields = line.split('\t');
    const status = fields[0];
    if (!/^[AM]$/.test(status)) {
      cannotNarrow(
        `the change includes '${line.replace(/\t/g, ' ')}'.`,
        'Deletes and renames move compiled output out from under the module graph,',
        'so the affected functions cannot be named. Deploying the full fleet.',
      );
    }
    paths.push(fields[fields.length - 1]);
  }
  return paths;
}

/**
 * True when a package.json edit provably cannot reach the runtime.
 *
 * `mytribe/functions/package.json` changed in 20 of the last 30 commits that
 * touched it, and most of those added a `scripts` entry for a one-off backfill.
 * Treating every one of them as "could be anything" sends a one-file release
 * through all ~227 functions, which is the cost this narrowing exists to avoid.
 * So `scripts` is compared out and EVERYTHING ELSE still aborts, dependencies
 * and devDependencies included: a typescript bump changes the emitted lib/ with
 * no source diff at all, and lib/ is gitignored, so nothing downstream would see
 * it. Needs the base commit; without one this cannot be asked and says so.
 */
function packageJsonIsRuntimeIdentical(repoPath, base) {
  if (!base) return false;
  const { execFileSync } = require('child_process');
  let before;
  try {
    before = execFileSync('git', ['show', `${base}:${repoPath}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return false;
  }
  // Key order is not meaning in JSON, so canonicalise before comparing, or a
  // reordered dependencies block reads as a changed one.
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
      return out;
    }
    return value;
  };
  const strip = (text) => {
    const parsed = JSON.parse(text);
    delete parsed.scripts;
    return JSON.stringify(canonical(parsed));
  };
  try {
    return strip(before) === strip(fs.readFileSync(path.join(ROOT, repoPath), 'utf8'));
  } catch {
    return false;
  }
}

/** Changed repo path -> the built lib module it compiles to, or abort. */
function libCounterpart(repoPath) {
  if (repoPath === `${SRC_PREFIX}index.ts`) {
    // The barrel. Repointing `export { a } from './x'` at './y' changes what `a`
    // IS while touching neither x nor y, and no graph walk can see that: index.js
    // is the entrypoint, so it is in nobody's dependency closure. Adding an
    // export is safe here (the added file is in the diff too) but removing or
    // repointing one is not, and they are indistinguishable from the path alone.
    cannotNarrow(
      'mytribe/functions/src/index.ts changed.',
      'The barrel decides which module each exported function IS, and repointing',
      'an export changes a function without touching either module. Deploying the',
      'full fleet, because no dependency walk can see that edit.',
    );
  }
  if (!repoPath.startsWith(SRC_PREFIX) || !repoPath.endsWith('.ts')) {
    cannotNarrow(
      `${repoPath} changed, and it is not a compiled source file.`,
      'Anything outside src/ can reach the runtime in a way this walk cannot',
      'model (package.json pins the dependency versions, tsconfig.json changes',
      'the emit). Deploying the full fleet.',
    );
  }
  const rel = repoPath.slice(SRC_PREFIX.length).replace(/\.ts$/, '.js');
  const libFile = path.join(LIB_DIR, rel);
  if (!fs.existsSync(libFile)) {
    cannotNarrow(
      `${repoPath} has no built counterpart at ${path.relative(ROOT, libFile)}.`,
      'lib/ is behind src/, so the graph describes code that is not what would',
      'ship. Deploying the full fleet. Rebuild with: npm run build:functions',
    );
  }
  return libFile;
}

// ---------------------------------------------------------------------------
// Modes.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] || '';
};

const mod = loadIndex();
const fleet = enumerateFleet(mod);
if (fleet.length === 0) {
  cannotEnumerate(
    `${path.relative(ROOT, LIB_INDEX)} exports no function carrying an __endpoint.`,
    'That is not a state this codebase can be in, so it means the walk found',
    'nothing to walk rather than that there is nothing to deploy.',
  );
}

const changedFrom = flagValue('--changed-from');
const fromServices = flagValue('--from-services');

if (fromServices !== null) {
  // Recovery direction: a failed deploy leaves Cloud Run services whose names are
  // the LOWERCASED export names, and redeploying needs the exports back. Doing
  // that by eye resolved 79 of 95 on 2026-08-01. A lowercase index over the same
  // artifact the CLI reads resolves all of them or names the ones it cannot,
  // which is the whole difference between a recovery and a partial recovery.
  const byLower = new Map();
  for (const name of fleet) {
    const key = name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, []);
    byLower.get(key).push(name);
  }
  let text = '';
  try {
    text = fs.readFileSync(fromServices, 'utf8');
  } catch (err) {
    cannotEnumerate(`could not read the service list (${err.message}).`);
  }
  const wanted = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  const unresolved = [];
  const ambiguous = [];
  for (const service of wanted) {
    const hits = byLower.get(service.toLowerCase());
    if (!hits) unresolved.push(service);
    else if (hits.length > 1) ambiguous.push(`${service} -> ${hits.join(', ')}`);
    else out.push(hits[0]);
  }
  if (unresolved.length || ambiguous.length) {
    console.error(`resolved ${out.length} of ${wanted.length} service names.`);
    for (const s of unresolved) console.error(`  no export is named ${s} (case-insensitively)`);
    for (const s of ambiguous) console.error(`  ambiguous: ${s}`);
    console.error('Refusing a partial answer: a recovery that silently drops names');
    console.error('leaves exactly the functions nobody redeployed.');
    process.exit(1);
  }
  console.error(`resolved ${out.length} of ${wanted.length} Cloud Run service names to exports.`);
  for (const name of out) console.log(name);
  process.exit(0);
}

if (changedFrom === null) {
  console.error(`fleet: ${fleet.length} deployable functions in the mytribe codebase.`);
  for (const name of fleet) console.log(name);
  process.exit(0);
}

// --- narrowing -------------------------------------------------------------

const changedPaths = readChanged(changedFrom);
const base = flagValue('--base');

// Anything that provably cannot reach the runtime drops out first, so a
// test-only or docs-only commit does not drag 227 functions through a deploy.
const relevant = changedPaths.filter((p) => {
  if (!p.startsWith(FUNCTIONS_PREFIX)) return false;
  if (CANNOT_REACH_RUNTIME.some((re) => re.test(p))) return false;
  if (p === `${FUNCTIONS_PREFIX}package.json` && packageJsonIsRuntimeIdentical(p, base)) {
    console.error(`${p} changed in its scripts block only; it cannot reach the runtime.`);
    return false;
  }
  return true;
});

const fleetValues = new Set();
for (const name of fleet) fleetValues.add(mod[name]);
const owners = ownersByIdentity(fleetValues);

// PROVE IT, OR REFUSE TO NARROW. Every deployable name must resolve to at least
// one defining module; a name with no owner would silently contribute nothing to
// the affected set and so would never be deployed.
const unowned = fleet.filter((name) => !owners.has(mod[name]) || owners.get(mod[name]).size === 0);
if (unowned.length) {
  cannotNarrow(
    `${unowned.length} of ${fleet.length} functions could not be traced to a source module:`,
    `  ${unowned.slice(0, 10).join(', ')}${unowned.length > 10 ? ', ...' : ''}`,
    'A name with no module is a name no changed file can ever select, so',
    'narrowing would silently skip it. Deploying the full fleet.',
  );
}

const { deps } = buildGraph();

// One closure per function, then one membership test per changed file. The other
// way round recomputes the same walk for every path in the diff.
const reach = new Map();
for (const name of fleet) reach.set(name, closure([...owners.get(mod[name])], deps));

const affected = new Set();
for (const repoPath of relevant) {
  const libFile = libCounterpart(repoPath);
  for (const name of fleet) {
    if (reach.get(name).has(libFile)) affected.add(name);
  }
}

console.error(
  `traced ${fleet.length} of ${fleet.length} functions to source modules; ` +
    `${relevant.length} changed file(s) reach ${affected.size} of them.`,
);
for (const name of [...affected].sort()) console.log(name);
process.exit(0);
