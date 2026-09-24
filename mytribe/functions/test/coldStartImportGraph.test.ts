import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

/**
 * A guard on the one number that sets every Cloud Function's cold start.
 *
 * The Functions runtime loads the whole of `lib/index.js` on every cold start
 * whatever the target is, so the import graph reachable from `src/index.ts` is
 * paid by all ~227 deployed functions, not by the one that was called. Issue
 * #395 is what happens when that cost meets a fractional vCPU: five callables
 * on the 2026-08-17 walk took between 7.9 and 10.3 seconds on their first call
 * and 703 ms on their second.
 *
 * Measured on the built `lib/` while writing this test, node v24.14.0: the
 * graph is 1,873 modules and 13.4 MiB of JavaScript, costing 0.80-1.02 s of CPU
 * warm and about 193 MiB of resident memory. Two separate ceilings sit just
 * above that, and both have been hit before:
 *
 *   - 256MiB of memory. The fleet went over it on 2026-08-03 and OOMed before
 *     the readiness probe, which reached browsers as CORS errors.
 *   - The cold start a person waits through, which is this graph's CPU cost
 *     divided by the function's CPU share.
 *
 * So this file asserts four things that are cheap to check and expensive to
 * rediscover: no heavy SDK is imported at file scope, no NEW third-party
 * package silently joins the graph, the codebase's own eager module count stays
 * under a bound, and the fleet default stays at a full vCPU. All of it is
 * static: it reads the TypeScript sources and needs no build.
 */
const SRC = resolve(__dirname, '../src');

const ENTRY = resolve(SRC, 'index.ts');

/**
 * The SDKs that were deliberately moved out of the eager graph on 2026-08-04,
 * plus `googleapis`, which was replaced by the one-API `@googleapis/calendar`
 * because deferring it was not enough on its own (it still cost +97 MiB at
 * first use, which put the five Calendar functions over 256MiB at the moment an
 * operator pressed a button).
 *
 * Any of these appearing in a file-scope `import ... from` puts its cost back on
 * every function in the codebase. Load them inside the handler that needs them:
 * `const { X } = await import('pkg')`. A type-only import is free and is fine.
 */
const BANNED_AT_FILE_SCOPE = [
  '@anthropic-ai/sdk',
  '@google-cloud/recaptcha-enterprise',
  '@googleapis/calendar',
  'googleapis',
  'pdf-lib',
  'stripe',
  'twilio',
];

/**
 * Every third-party package the entrypoint's eager graph is allowed to reach.
 *
 * This list is the bound, and it is deliberately a list rather than a count: a
 * count tells you the graph grew, this tells you what grew it. Adding an entry
 * is allowed and is not a defect, but it is a decision that gets paid by all
 * ~227 functions, so it should happen in a review rather than by accident.
 */
const ALLOWED_EAGER_PACKAGES = [
  'firebase-admin/app',
  'firebase-admin/auth',
  'firebase-admin/firestore',
  'firebase-admin/messaging',
  'firebase-admin/storage',
  'firebase-functions/logger',
  'firebase-functions/params',
  'firebase-functions/v1',
  'firebase-functions/v2',
  'firebase-functions/v2/firestore',
  'firebase-functions/v2/https',
  'firebase-functions/v2/identity',
  'firebase-functions/v2/scheduler',
  'handlebars',
  'libphonenumber-js',
  'argon2',
  'crypto',
  'node:crypto',
  // #908: `isIP` for the per-IP key in auth/loginSecurity.ts. A Node builtin that
  // Node's own HTTP server has already loaded before any function code runs, so
  // it adds nothing to a cold start.
  'net',
  'node:net',
  'sanitize-html',
  // #953: `emailFrame.ts` parses visual-template content into text/HTML for
  // every send route (`sendFromTemplate`, `emailChannel`, `requestPasswordReset`).
  // `sendPartsFor` must stay synchronous (other in-flight PRs depend on that
  // exact signature), so this cannot move behind `await import()`. Marginal
  // cost is ~zero: `sanitize-html`, already on this list, requires the same
  // `htmlparser2@12` at ITS OWN module scope (node_modules/sanitize-html/index.js),
  // so it is already resident in the process on every cold start this list produces.
  'htmlparser2',
  '@sentry/node',
  'zod',
];

/**
 * A generous ceiling on the codebase's OWN eagerly-imported modules. Normal
 * feature work adds files here and should not fail this test; the number exists
 * so that a structural change (a barrel that pulls in a whole directory, say)
 * is noticed. Raise it deliberately, and read the header of `src/index.ts`
 * before you do.
 */
const MAX_OWN_EAGER_MODULES = 400;

interface Edge {
  spec: string;
  typeOnly: boolean;
}

/** Strip comments so a commented-out import is not counted as one. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Static import edges out of one file.
 *
 * Matches `import ... from '<spec>'` and `export ... from '<spec>'`, both of
 * which load the target at runtime, plus bare `import '<spec>'` side-effect
 * imports. It does NOT match `await import('<spec>')`, which is the whole point:
 * a dynamic import inside a handler is exactly the shape this test is asking
 * for. `import type` / `export type` are recorded as type-only and dropped,
 * because tsc erases them; an inline `import { type A, B }` still loads the
 * module and is correctly treated as eager.
 */
function readEdges(file: string): Edge[] {
  const code = stripComments(readFileSync(file, 'utf8'));

  const edges: Edge[] = [];
  // The clause character class is deliberately narrow: an import clause only
  // ever contains identifiers, braces, commas, `*`, `as` and `type`. Allowing
  // arbitrary characters here made the pattern run past a statement that had no
  // `from` of its own and swallow the next one, which turned a fragment of an
  // unrelated array literal into a "package name".

  const withFrom =
    /^[ \t]*(?:import|export)[ \t\r\n]+([A-Za-z0-9_$*{},\s]*?)\bfrom[ \t]*['"]([^'"]+)['"]/gm;
  for (const m of code.matchAll(withFrom)) {
    edges.push({ spec: m[2], typeOnly: /^type\b/.test(m[1].trim()) });
  }

  const sideEffect = /^[ \t]*import[\s]*['"]([^'"]+)['"]/gm;
  for (const m of code.matchAll(sideEffect)) {
    edges.push({ spec: m[1], typeOnly: false });
  }
  return edges;
}

/** Resolve a relative specifier the way tsc/node do for this codebase. */
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.js`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.js'),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        if (readFileSync(candidate).length >= 0) return candidate;
      } catch {
        /* a directory, keep looking */
      }
    }
  }
  return null;
}

interface Graph {
  ownFiles: Set<string>;
  packages: Set<string>;

  /** package -> the src file that pulled it in eagerly, for the failure message */
  packageOrigin: Map<string, string>;
}

function walkEagerGraph(entry: string): Graph {
  const ownFiles = new Set<string>([entry]);

  const packages = new Set<string>();

  const packageOrigin = new Map<string, string>();

  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    for (const edge of readEdges(file)) {
      if (edge.typeOnly) continue;
      if (edge.spec.startsWith('.')) {
        const target = resolveLocal(file, edge.spec);
        if (target && !ownFiles.has(target)) {
          ownFiles.add(target);
          queue.push(target);
        }
        continue;
      }
      if (!packages.has(edge.spec)) {
        packages.add(edge.spec);
        packageOrigin.set(edge.spec, relative(SRC, file));
      }
    }
  }
  return { ownFiles, packages, packageOrigin };
}

describe('cold-start import graph of the functions entrypoint', () => {
  const graph = walkEagerGraph(ENTRY);

  it('reaches no heavy SDK at file scope', () => {
    const offenders = BANNED_AT_FILE_SCOPE.filter((pkg) => graph.packages.has(pkg)).map(
      (pkg) => `${pkg} (imported by src/${graph.packageOrigin.get(pkg)})`,
    );
    expect(
      offenders,
      'These SDKs are loaded inside the handlers that use them precisely so every OTHER ' +
        'function stops paying for them. Move the import back into the handler:\n' +
        "  const { X } = await import('pkg')\n" +
        'See the header of src/index.ts for what a file-scope import of one of these costs.',
    ).toEqual([]);
  });

  it('reaches only third-party packages that have been signed off', () => {
    const unexpected = [...graph.packages]
      .filter((pkg) => !ALLOWED_EAGER_PACKAGES.includes(pkg))
      .sort()
      .map((pkg) => `${pkg} (imported by src/${graph.packageOrigin.get(pkg)})`);
    expect(
      unexpected,
      'A new package joined the graph that every deployed function loads on every cold ' +
        'start. If it belongs there, add it to ALLOWED_EAGER_PACKAGES in this file and say ' +
        'in the PR what it costs. If it is only needed by one handler, import it there ' +
        'with `await import(...)` instead.',
    ).toEqual([]);
  });

  it('does not eagerly import more of its own modules than expected', () => {
    expect(
      graph.ownFiles.size,
      `The entrypoint now eagerly imports ${graph.ownFiles.size} of this codebase's own ` +
        `modules, over the ${MAX_OWN_EAGER_MODULES} this test allows. Every function pays ` +
        'for all of them. Read the header of src/index.ts before raising the bound.',
    ).toBeLessThanOrEqual(MAX_OWN_EAGER_MODULES);
  });

  it('keeps the fleet default at a full vCPU', () => {
    const entry = readFileSync(ENTRY, 'utf8');
    const call = /setGlobalOptions\(\{([^}]*)\}\)/.exec(entry);
    expect(call, 'src/index.ts must still call setGlobalOptions').not.toBeNull();
    expect(
      (call as RegExpExecArray)[1],
      'Below a full vCPU Cloud Run pins concurrency to 1, so every concurrent request ' +
        'starts its own container and pays the whole import graph above. That is what made ' +
        'five callables take 7.9-10.3 seconds in the 2026-08-17 walk (issue #395). ' +
        'ADR-0004 decision 2 is the argument for cpu 1; do not lower it without replacing it.',
    ).toMatch(/cpu:\s*1\b/);
  });
});
