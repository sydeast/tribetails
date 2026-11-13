import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

/**
 * A guard on the one number that sets every Cloud Function's cold start.
 *
 * Until #1337 the Functions runtime loaded the whole of `lib/index.js` on every
 * cold start whatever the target was, so the import graph reachable from
 * `src/index.ts` was paid by every deployed function, not by the one that was
 * called. Since #1337 a deployed instance loads only its FUNCTION_TARGET's
 * module (see the FUNCTIONS table in src/index.ts), but the union of all of
 * them is still loaded by deploy-time discovery, by the emulator and by
 * getIntegrationsHealth at call time, and anything in it lands on every
 * function that shares the module. So this walks the union: the index's own
 * imports plus every module the FUNCTIONS table loads. Issue
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
 *
 * 410 since #1160 (was 400, which main had reached exactly): that change adds
 * `lib/googleBusySlot.ts`, one pure module whose only import is
 * `lib/businessHours.ts`, already resident. Not a structural change.
 *
 * 420 since #1382 (main had reached 410 exactly): that change adds
 * `lib/weeklyHoursRule.ts`, the shared weekly-hours check `requestBooking` and
 * `rescheduleTimeRules` both call. One helper module over modules already
 * resident; not a structural change.
 *
 * 430 since #1316 (main had reached 420 exactly): that change adds
 * `portal/listMyNotifications.ts`, the callable behind the portal bell, and
 * `lib/recipientNotifications.ts`, the one reading of a household's rows that
 * it and `getMyHome` share. Two modules whose imports are all already
 * resident; not a structural change.
 *
 * #1507 adds `notifications/appOnly.ts`, the pure "did this reach the
 * household in the app only" read of an `EnqueueOutcome`. Its only import is a
 * type, so it costs one module and no new edges, and it is its own file rather
 * than a dispatcher export because every callable test mocks the dispatcher
 * whole. Measured at 423 after merging onto #1316, inside the 430
 * already allowed, so the bound did not move.
 *
 * 440 since #1577 (main had reached 431): that change adds
 * `lib/householdNames.ts`, the one read of `families/{id}.displayName` that
 * `listRescheduleRequests` and `listCancelRequests` share so a visit request
 * names its household. One module whose imports are already resident; not a
 * structural change.
 *
 * #1714: main reached 432 when #1679, #1682 and #1689 merged one after another,
 * each having passed alone. They added `admin/previewInvoiceNotice.ts`,
 * `lib/pastVisit.ts` and `admin/marketingCopy.ts`. The first is a FUNCTIONS
 * entry, so it is in this graph by construction. The other two, and
 * `lib/stripVideoLocationJob.ts` with the two modules only it imports, now load
 * with `await import()` inside the handlers that use them. Measured at 428
 * after merging onto #1577 (433 without this change), so the bound did not
 * move.
 *
 * #1580 adds `admin/listVisitInternalNotes.ts`, the visit's one
 * internal-notes list, and `lib/visitNotes.ts`, the path and target
 * resolution it shares with `addInternalBookingNote`. Two modules whose
 * imports are all already resident, inside the 440 already allowed, so the
 * bound did not move.
 *
 * #1610 adds `lib/broadcastMerge.ts`, the per-household merge-field fill the
 * broadcast sender and its resume sweep share. Its imports are all already
 * resident through `lib/email.ts`, so it costs one module, inside the 440
 * already allowed, and the bound did not move.
 *
 * 435 since #1718 (was 440, which #1577 set while main was over 430). #1716
 * brought main back to 428 and #1718 asked for 430, but by the time it was
 * built main had reached 435: four new FUNCTIONS entries,
 * `admin/getRecordingAudio.ts`, `admin/listVisitInternalNotes.ts`,
 * `admin/previewBroadcastAudience.ts` and
 * `triggers/onBookingEnvelopeResolve.ts`, which are in this graph by
 * construction, and three helpers, `lib/visitNotes.ts`,
 * `notifications/requestResolution.ts` and `lib/broadcastMerge.ts`, whose
 * imports are already resident. 430 is not reachable without moving modules
 * out of the graph, so the bound sits at the measured count with no slack:
 * the next eager module has to be looked at.
 *
 * 436 since #1775: `lib/sentKinTales.ts`, the one sent-tale reader that
 * `getMyKinTales` and `getMyKinPhotos` share (two entrypoints already in this
 * graph, so it is resident by construction). It holds no package import and
 * folding it into an unrelated helper to dodge the count would hide it.
 *
 * 437 since #1593 (on top of #1775's 436): `admin/saveBusinessSettings.ts` is a new FUNCTIONS entry,
 * in this graph by construction (the one Settings save; the rules now deny
 * the document to every client). Its field checks,
 * `lib/businessSettingsChecks.ts`, load with `await import()` inside the
 * handler, so the entry is the only module it adds.
 *
 * 438 since the #1593 secondary-kinfolk alignment: `lib/contactShape.ts`, the
 * email and phone shapes the admin clients check, which `portal/secondaryKinfolk.ts`
 * (an entry already in this graph) now refuses by, so the client and the server
 * agree exactly. A dozen lines with no import of its own.
 *
 * 439 since #1830: `lib/portalVisitProgress.ts`, the pure rules `getMyBookings`
 * (an entry already in this graph) reads a visit's On the way / Arrived /
 * Departed and its list by. Its one import is a type, erased at build.
 *
 * 440 since #1987 (on top of #1830's 439): `lib/homeLayout.ts`, the one test for "this portal Home
 * layout is the default", which `admin/saveBusinessSettings.ts` (stores such a
 * layout as the empty list) and `portal/getMyHome.ts` (answers with the empty
 * list for a document stored earlier) share. Both are entries already in this
 * graph. It has no import of its own, and it cannot sit behind the lazy
 * `businessSettingsChecks.ts` because `getMyHome` needs it on every call.
 *
 * 441 since #1962 (on top of #1987's 440): `lib/savedByStamp.ts`, the one
 * "last saved" stamp the four writers of the Settings documents share
 * (`saveBusinessSettings`, `removeBusinessTag`, `confirmBrandAssetUpload`,
 * `saveEmailFrame`, all entries already in this graph), so they can no longer
 * disagree about what `updatedBy` holds. One function with no import of its own.
 *
 * 442 since #1912 (on top of #1962's 441): `lib/kinLink.ts`, the one place
 * that says which admin record is a household Kin's own. `portal/kinWrites.ts`,
 * `admin/kinArchive.ts`, `admin/kinRemovalRequests.ts` and
 * `triggers/onFamilyKinWrite.ts` (four entries already in this graph) all ask
 * it, so it is resident by construction; every module it imports is too.
 *
 * 445 since #1820 (on top of #1912's 442): three helpers behind two entries
 * already in this graph. `lib/auditActor.ts` (who the caller is, for an
 * Activity Log line) and `lib/activityPayload.ts` (the allow-list for a
 * line's facts) load with `admin/logActivity.ts`; `lib/staffRoles.ts` (owner
 * or Auntie, per staff uid) loads with `admin/listStaff.ts`. Their imports
 * are zod and modules already resident (`staffGate`, `auntieAccess`,
 * `operatorAllowlist`, `firestoreAdmin`, `logger`), so they add no package
 * to a cold start.
 *
 * 446 since #2096 (on top of #1820's 445): `lib/householdMember.ts`, the one
 * household member-record shape and link decision, which
 * `membership/acceptInvite.ts` and `admin/setKinfolkClaim.ts` (entries already
 * in this graph) write through. Its runtime import is `lib/schema.ts`, already
 * here; the rest are types.
 *
 * 447 since #1872 (on top of #2096's 446): `admin/applyAccountCredit.ts` is a
 * new FUNCTIONS entry, in this graph by construction (the one callable that
 * spends account credit, by an amount the admin enters). Everything it imports
 * was already here.
 *
 * 448 since #1935 (on top of #1872's 447): `admin/templateChannels.ts` is a new
 * FUNCTIONS entry (the read and the save of a template's text-message and push
 * wording, which no client may touch directly). Its rules,
 * `lib/templateChannelWording.ts`, load with `await import()` inside the
 * handler, so the entry is the only module it adds.
 *
 * 449 since #2161 (on top of #1935's 448): `admin/kinfolkArchive.ts` is a new
 * FUNCTIONS entry (the owner-only Archive / Restore of a Kinfolk household,
 * with its Activity Log line). Its words, `lib/activityWords.ts`, load with
 * `await import()` inside the handler, so the entry is the only module it adds.
 */
const MAX_OWN_EAGER_MODULES = 449;

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

/**
 * The module specifiers of src/index.ts's FUNCTIONS table, one per
 * `name: () => require('./module'),` entry. A thunk is not an eager edge of the
 * index, but discovery calls every one of them, so for the union graph each is.
 */
function functionTableEdges(file: string): Edge[] {
  const code = stripComments(readFileSync(file, 'utf8'));
  return [
    ...code.matchAll(/^[ \t]*[A-Za-z_$][\w$]*:[ \t]*\(\)[ \t]*=>[ \t]*require\('([^']+)'\),?$/gm),
  ].map((m) => ({ spec: m[1], typeOnly: false }));
}
function walkEagerGraph(entry: string): Graph {
  const ownFiles = new Set<string>([entry]);

  const packages = new Set<string>();

  const packageOrigin = new Map<string, string>();

  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const edges =
      file === entry ? [...readEdges(file), ...functionTableEdges(file)] : readEdges(file);
    for (const edge of edges) {
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

  it('walks from every entry of the FUNCTIONS table', () => {
    // Without this the walk could silently start from index.ts alone, whose own
    // imports are one package, and every assertion below would pass vacuously.
    const entries = functionTableEdges(ENTRY);
    const names =
      readFileSync(ENTRY, 'utf8').match(/^[ \t]*[A-Za-z_$][\w$]*: \(\) => require\(/gm) ?? [];
    expect(entries.length).toBeGreaterThan(200);
    expect(entries.length).toBe(names.length);
    expect(graph.ownFiles.size).toBeGreaterThan(entries.length / 2);
  });
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
