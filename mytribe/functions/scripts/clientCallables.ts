/**
 * clientCallables.ts
 *
 * #987: which `mytribe/functions` callables each client can reach, read from
 * the client source rather than from anyone's memory.
 *
 *   npm --prefix mytribe/functions run callables:map          the map, as text
 *   npm --prefix mytribe/functions run callables:map -- --json the map, as JSON
 *
 * WHY THIS EXISTS. App Check enforcement (`APP_CHECK_COHORT` in
 * src/lib/appCheckPolicy.ts) refuses a request that carries no verified token.
 * Only the two React web apps can send one. Android has no App Check (ruling R3,
 * 2026-09-27) and neither has the desktop build, so a callable that any Compose
 * or Android client calls must never sit in an enforced cohort. The cohort was
 * once checked by hand, the check said `getBusinessClosures` was web-only, and
 * the Android portal's booking calendar calls it. test/appCheckComposeReachable
 * .test.ts runs this extraction on every CI run so that mistake cannot recur.
 *
 * HOW A NAME COUNTS AS REACHABLE. Any string literal in a client's non-test
 * source that is exactly the name of a `mytribe/functions` `onCall` export.
 * That is a deliberate superset of "the first argument to the callable helper".
 * The Kotlin clients reach callables through at least eight spellings:
 * `fns.call("x")`, `getHttpsCallable("x")`, `platformInvokeCallable("x")`,
 * `JvmFirestoreRest.callable("x")`, `httpsCallable("x").invoke`,
 * `endpoints.functionUrl("x")`, and helpers that take the name as an argument
 * (`decideQuote("acceptQuote", ...)`, `callAndDecode("x", ...)`,
 * `name = "x"`, `const val X = "x"`). A list of helper patterns misses the next
 * helper somebody writes; a literal equal to a callable name cannot be missed.
 * A false positive (the name quoted in a comment) only makes the guard
 * stricter, which is the safe direction for this question.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export type ClientId = 'portalKmp' | 'adminAndroid' | 'adminDesktop' | 'portalWeb' | 'adminWeb';

export interface ClientTree {
  id: ClientId;
  label: string;
  /** Repository-relative source root. */
  root: string;
  language: 'kotlin' | 'typescript';
  /**
   * Whether every request this client sends can carry an App Check token.
   * False for every Compose/Android tree: Android by ruling R3, desktop because
   * the JVM has no App Check SDK, and the Compose js builds because they never
   * wired one.
   */
  sendsAppCheck: boolean;
}

export const CLIENT_TREES: readonly ClientTree[] = [
  {
    id: 'portalKmp',
    label: 'portal KMP (Android, desktop, Compose web: mytribe/src)',
    root: 'mytribe/src',
    language: 'kotlin',
    sendsAppCheck: false,
  },
  {
    id: 'adminAndroid',
    label: 'admin Android (auntieos-admin/android)',
    // `main` is the only production source set (checked 2026-09-28: `src/`
    // holds `main` and `test`). If a `release`, `debug` or flavor source set
    // is added, move this root up to `app/src` and widen the ci.yml filter.
    root: 'auntieos-admin/android/app/src/main',
    language: 'kotlin',
    sendsAppCheck: false,
  },
  {
    id: 'adminDesktop',
    label: 'admin desktop (auntieos-admin/web/composeApp)',
    root: 'auntieos-admin/web/composeApp/src',
    language: 'kotlin',
    sendsAppCheck: false,
  },
  {
    id: 'portalWeb',
    label: 'portal web (mytribe/web/src)',
    root: 'mytribe/web/src',
    language: 'typescript',
    sendsAppCheck: true,
  },
  {
    id: 'adminWeb',
    label: 'admin web (auntieos-admin/src)',
    root: 'auntieos-admin/src',
    language: 'typescript',
    sendsAppCheck: true,
  },
];

/**
 * Build output and tests. NOT `lib`: every root here is a source root, and
 * `src/lib` is where both web apps keep their callable helper (`fns.ts`) and
 * where functions keeps shared server code.
 */
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', '.gradle', 'test', 'tests', '__tests__']);

/** Kotlin test source sets: `commonTest`, `jvmTest`, `androidUnitTest`, `composeUiTest`, ... */
function isTestDir(name: string): boolean {
  return SKIP_DIRS.has(name) || /Test$/.test(name);
}

function isSourceFile(name: string, language: ClientTree['language']): boolean {
  if (language === 'kotlin') return name.endsWith('.kt');
  // `*.generated.ts` is the ADR-0001 contracts module. It names callables only
  // in doc comments, so on the web side it would credit a client with calls it
  // never makes. The web side decides nothing about safety, so skipping it only
  // makes the map more accurate. The Kotlin side skips nothing but tests.
  return (
    /\.(ts|tsx)$/.test(name) &&
    !/\.d\.ts$/.test(name) &&
    !/\.(test|spec)\.tsx?$/.test(name) &&
    !/\.generated\.ts$/.test(name)
  );
}

function walk(dir: string, language: ClientTree['language'], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!isTestDir(name)) walk(full, language, out);
    } else if (isSourceFile(name, language)) {
      out.push(full);
    }
  }
  return out;
}

/** Non-test source files of one client, absolute paths. Throws if the root moved. */
export function clientSourceFiles(tree: ClientTree, repoRoot: string = REPO_ROOT): string[] {
  const root = resolve(repoRoot, tree.root);
  if (!existsSync(root)) {
    throw new Error(`${tree.id}: source root ${tree.root} does not exist. Update CLIENT_TREES in scripts/clientCallables.ts.`);
  }
  return walk(root, tree.language);
}

/**
 * Every `export const <name> = onCall(...)` in mytribe/functions/src.
 *
 * The export name is the name clients dial, and the App Check gate keys on the
 * `wrapCallable` name. The two are identical for every wrapped callable in the
 * tree (checked 2026-09-28); test/appCheckComposeReachable.test.ts pins that.
 */
export function serverCallables(repoRoot: string = REPO_ROOT): Set<string> {
  const names = new Set<string>();
  const root = resolve(repoRoot, 'mytribe/functions/src');
  for (const file of walk(root, 'typescript')) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/export const (\w+)\s*(?::[^=]+)?=\s*onCall\b/g)) names.add(m[1]!);
  }
  return names;
}

/** `export const x = onCall(..., wrapCallable('y', ...))` pairs where x !== y. */
export function exportWrapNameMismatches(repoRoot: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const root = resolve(repoRoot, 'mytribe/functions/src');
  for (const file of walk(root, 'typescript')) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/export const (\w+)\s*(?::[^=]+)?=\s*onCall(?:<[^>]*>)?\(([\s\S]*?)\n\);/g)) {
      const wrap = m[2]!.match(/wrap(?:Admin)?Callable(?:<[^>]*>)?\(\s*['"](\w+)['"]/);
      if (wrap && wrap[1] !== m[1]) out.push(`${m[1]} is wrapped as ${wrap[1]}`);
    }
  }
  return out;
}

const KOTLIN_LITERAL = /"(\w+)"/g;
const TS_LITERAL = /['"`](\w+)['"`]/g;

/** Callable names one client's source names, sorted. */
export function callablesNamedBy(
  tree: ClientTree,
  server: ReadonlySet<string>,
  repoRoot: string = REPO_ROOT,
): string[] {
  const found = new Set<string>();
  const literal = tree.language === 'kotlin' ? KOTLIN_LITERAL : TS_LITERAL;
  for (const file of clientSourceFiles(tree, repoRoot)) {
    for (const m of readFileSync(file, 'utf8').matchAll(literal)) {
      if (server.has(m[1]!)) found.add(m[1]!);
    }
  }
  return [...found].sort();
}

export interface CallableMap {
  server: string[];
  byClient: Record<ClientId, string[]>;
  /** Named by at least one client that cannot send an App Check token. */
  unattestedReachable: string[];
  /** Named by a web client and by no client without App Check: the only names a cohort may hold. */
  webOnly: string[];
}

export function callableMap(repoRoot: string = REPO_ROOT): CallableMap {
  const server = serverCallables(repoRoot);
  const byClient = {} as Record<ClientId, string[]>;
  for (const tree of CLIENT_TREES) byClient[tree.id] = callablesNamedBy(tree, server, repoRoot);
  const unattested = new Set(CLIENT_TREES.filter((t) => !t.sendsAppCheck).flatMap((t) => byClient[t.id]));
  const web = new Set(CLIENT_TREES.filter((t) => t.sendsAppCheck).flatMap((t) => byClient[t.id]));
  return {
    server: [...server].sort(),
    byClient,
    unattestedReachable: [...unattested].sort(),
    webOnly: [...web].filter((n) => !unattested.has(n)).sort(),
  };
}

/** Cohort members that a client without App Check can reach. Empty is the only safe answer. */
export function cohortViolations(cohort: readonly string[], unattestedReachable: readonly string[]): string[] {
  const reachable = new Set(unattestedReachable);
  return cohort.filter((name) => reachable.has(name));
}

function main(): void {
  const map = callableMap();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(map, null, 2)}\n`);
    return;
  }
  const lines: string[] = [];
  lines.push(`mytribe/functions onCall exports: ${map.server.length}`);
  for (const tree of CLIENT_TREES) {
    const files = clientSourceFiles(tree).length;
    lines.push(
      `${tree.label}: ${map.byClient[tree.id].length} callables in ${files} files` +
        (tree.sendsAppCheck ? '' : ' (no App Check)'),
    );
  }
  lines.push('');
  lines.push(`Reachable from a client with no App Check (never enforce these): ${map.unattestedReachable.length}`);
  lines.push(`Web-only (the only names APP_CHECK_COHORT may hold): ${map.webOnly.length}`);
  for (const name of map.webOnly) {
    const who = CLIENT_TREES.filter((t) => map.byClient[t.id].includes(name)).map((t) => t.id);
    lines.push(`  ${name}  [${who.join(', ')}]`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) main();
