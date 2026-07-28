import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the SHAPE of the invoiceMath mirror, where `invoiceMath.test.ts`
 * guards its arithmetic.
 *
 * `src/lib/invoiceMath.ts` is a deliberate SUBSET of the server's
 * `mytribe/functions/src/lib/invoiceMath.ts` (see the header of either file for
 * why a copy exists at all). The fixture tables in both trees catch a change to
 * a shared function's BEHAVIOR, but they import a fixed list of names, so they
 * are structurally blind to the export sets drifting: the server grew
 * `settleInvoice`, `invoiceTotalCentsOf` and `isPartiallyPaid` in the
 * 2026-07-25 partial-payment work and no test noticed that this file's header
 * still called the two files identical. This test is the guard that was
 * missing. It reads BOTH files off disk (same technique as
 * `src/styles/tokenUsage.test.ts`) and pins three facts:
 *
 *   1. The mirror exports exactly the declared shared subset. Nothing sneaks
 *      in, nothing falls out.
 *   2. The server still exports everything in that subset, so the mirror never
 *      claims arithmetic the authority has disowned.
 *   3. The server's FULL export list is pinned. A new server export fails here
 *      on purpose, to make its author answer one question the type checker
 *      cannot ask: does the live typing preview need this too?
 *
 * When this file goes red, it is not asking for a mechanical sync. It is
 * asking for a decision, and each failure message says which one.
 */

const here = dirname(fileURLToPath(import.meta.url)); // auntieos-admin/src/lib
const repoRoot = join(here, '..', '..', '..');

const ADMIN_FILE = join(here, 'invoiceMath.ts');
const SERVER_FILE = join(repoRoot, 'mytribe', 'functions', 'src', 'lib', 'invoiceMath.ts');

/**
 * The shared subset: what the admin mirror carries, and why it carries it.
 * Every name here must exist in BOTH files. This list is the one the mirror's
 * header prose names; if you change it, change the prose too.
 */
const SHARED_EXPORTS: readonly string[] = [
  // The five functions the live typing preview needs.
  'lineAmountCents',
  'computeInvoiceTotals',
  'paidCentsFromPayments',
  'centsToDollars',
  'validateInvoiceMoney',
  // The types those functions speak in.
  'InvoiceLineItemInput',
  'InvoiceTotals',
  'PaymentAmount',
];

/**
 * What the server owns and the admin deliberately does NOT mirror. Settlement
 * is a decision about stored money, taken where the money is stored; the
 * preview never takes it. A name belongs here only after someone has decided
 * the admin genuinely has no use for it, that is the decision this file
 * exists to force.
 */
const KNOWN_SERVER_ONLY_EXPORTS: readonly string[] = [
  // 2026-07-25 partial-payment work.
  'settleInvoice',
  'invoiceTotalCentsOf',
  'isPartiallyPaid',
  'InvoiceSettlementState',
  'InvoiceSettlement',
];

/**
 * Every top-level `export <kind> <name>` declaration in a file. Both
 * invoiceMath files declare exports only in this direct form (no `export {}`
 * lists, no re-exports, no default), and the sanity test below fails loudly if
 * that ever stops being true enough to find the anchor names.
 */
function exportedNames(file: string): Set<string> {
  const src = readFileSync(file, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(
    /^export\s+(?:async\s+)?(?:function|interface|type|const|class|enum)\s+([A-Za-z0-9_$]+)/gm,
  )) {
    names.add(m[1]!);
  }
  return names;
}

const adminExports = exportedNames(ADMIN_FILE);
const serverExports = exportedNames(SERVER_FILE);

const sorted = (names: Iterable<string>) => [...names].sort();

describe('invoiceMath export-set parity', () => {
  it('finds both files and can read exports out of them (guards the extractor itself)', () => {
    // If the server tree moves, or someone rewrites a file into `export {}`
    // syntax the regex cannot see, every other assertion here would pass
    // vacuously or fail confusingly. Anchor on a name that must exist in both.
    expect(
      adminExports.has('computeInvoiceTotals'),
      `Could not find computeInvoiceTotals among the exports parsed from ${ADMIN_FILE}. ` +
        'Either the file moved or its export syntax changed; fix the path or the extractor before trusting anything else in this suite.',
    ).toBe(true);
    expect(
      serverExports.has('computeInvoiceTotals'),
      `Could not find computeInvoiceTotals among the exports parsed from ${SERVER_FILE}. ` +
        'Either the server file moved or its export syntax changed; fix the path or the extractor before trusting anything else in this suite.',
    ).toBe(true);
  });

  it('keeps the mirror at exactly the declared shared subset', () => {
    const extra = sorted(adminExports).filter((n) => !SHARED_EXPORTS.includes(n));
    const missing = SHARED_EXPORTS.filter((n) => !adminExports.has(n));

    expect(
      extra,
      'The admin mirror exports something outside the declared shared subset: ' +
        `[${extra.join(', ')}]. The mirror exists ONLY for the live typing preview. ` +
        'If the preview genuinely needs this, add it to the SERVER file first (the authority), ' +
        'then to SHARED_EXPORTS here and to the mirror header prose. If it is admin-only ' +
        'arithmetic, it does not belong in the mirror file at all; put it in its own module.',
    ).toEqual([]);

    expect(
      missing,
      'The admin mirror lost a shared export it promises to carry: ' +
        `[${missing.join(', ')}]. Either restore it, or, if the preview no longer needs it, ` +
        'remove it from SHARED_EXPORTS and from the mirror header prose in the same change.',
    ).toEqual([]);
  });

  it('never claims arithmetic the server has disowned', () => {
    const disowned = SHARED_EXPORTS.filter((n) => !serverExports.has(n));
    expect(
      disowned,
      'The server no longer exports something the admin mirror still carries: ' +
        `[${disowned.join(', ')}]. The server is the authority; a mirror of arithmetic the ` +
        'authority deleted is not a preview, it is a fork. Delete it from the mirror and from ' +
        'SHARED_EXPORTS, or restore it on the server if its removal was the mistake.',
    ).toEqual([]);
  });

  it('pins the server export list so a new server export forces a decision here', () => {
    const expected = sorted([...SHARED_EXPORTS, ...KNOWN_SERVER_ONLY_EXPORTS]);
    const actual = sorted(serverExports);

    const unaccounted = actual.filter((n) => !expected.includes(n));
    const gone = expected.filter((n) => !actual.includes(n));

    expect(
      unaccounted,
      'The server grew an export this test does not know about: ' +
        `[${unaccounted.join(', ')}]. That is not automatically wrong, but it is a decision, ` +
        'and you are the one placed to make it. Does the live typing preview in the admin need ' +
        'this too? If YES: copy it into src/lib/invoiceMath.ts, add it to SHARED_EXPORTS, and ' +
        'extend the fixture tables in both trees. If NO: add it to KNOWN_SERVER_ONLY_EXPORTS ' +
        'with a comment saying why the admin does not need it. Do not silence this test any other way.',
    ).toEqual([]);

    expect(
      gone,
      'A server export this test pins has disappeared: ' +
        `[${gone.join(', ')}]. If it was deliberately removed from the server, remove it from ` +
        'SHARED_EXPORTS or KNOWN_SERVER_ONLY_EXPORTS (and from the mirror, if it was shared). ' +
        'If not, this is the authority losing arithmetic someone still depends on.',
    ).toEqual([]);
  });

  it('never again calls the mirror an identical twin', () => {
    // The exact claim this suite replaced: the header said the two files were
    // "byte-identical" while the server was three exports richer. The subset
    // relationship is the truth; the word is banned from the mirror so the
    // false claim cannot quietly return in a comment sweep.
    const admin = readFileSync(ADMIN_FILE, 'utf8');
    expect(
      admin.includes('byte-identical'),
      'src/lib/invoiceMath.ts claims to be byte-identical to the server copy again. It is not, ' +
        'and has not been since 2026-07-25: the server also owns settleInvoice, ' +
        'invoiceTotalCentsOf and isPartiallyPaid. Describe the mirror as the deliberate subset ' +
        'it is; this suite is what keeps that description honest.',
    ).toBe(false);
  });
});
