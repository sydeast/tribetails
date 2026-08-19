import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the SHAPE of the invoiceTerms mirror, where `invoiceTerms.test.ts`
 * guards the rules it resolves.
 *
 * Same mechanism and same reasoning as `invoiceMath.parity.test.ts`, and it
 * exists for the same failure: two copies of a decision drifting apart while
 * both files' headers still call them a pair. The fixture tables in the two
 * trees catch a RULE that changed on one side only; they import a fixed list of
 * names, so they are blind to the export sets themselves drifting. This test
 * reads both files off disk and pins that.
 *
 * The terms mirror is a FULLER copy than the math mirror: everything the server
 * file exports is mirrored except `InvoiceTermsCodeArg`, which is the zod
 * request schema and therefore a server-side argument rule, not arithmetic the
 * composer needs.
 */

const here = dirname(fileURLToPath(import.meta.url)); // auntieos-admin/src/lib
const repoRoot = join(here, '..', '..', '..');

const ADMIN_FILE = join(here, 'invoiceTerms.ts');
const SERVER_FILE = join(repoRoot, 'mytribe', 'functions', 'src', 'lib', 'invoiceTerms.ts');

/** Everything both files carry. The composer previews what the server decides. */
const SHARED_EXPORTS: readonly string[] = [
  'INVOICE_TERMS_CODES',
  'InvoiceTermsCode',
  'InvoiceTermsBasis',
  'InvoiceTermsDef',
  'InvoiceTermsInput',
  'DueDateResolution',
  'invoiceTermsDef',
  'invoiceTermsDefs',
  'invoiceTermsWords',
  'parseInvoiceTermsCode',
  'isCalendarDay',
  'addDays',
  'lastServiceDay',
  'resolveDueDate',
];

/**
 * What the server owns alone. A name belongs here only once someone has decided
 * the composer genuinely has no use for it.
 */
const KNOWN_SERVER_ONLY_EXPORTS: readonly string[] = [
  // The zod request schema for the invoice-creating callables. A rule about
  // what a CALLABLE accepts, which the admin states by sending a value from
  // INVOICE_TERMS_CODES rather than by re-declaring the schema.
  'InvoiceTermsCodeArg',
];

/** Every top-level `export <kind> <name>` declaration in a file. */
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

describe('invoiceTerms export-set parity', () => {
  it('finds both files and can read exports out of them (guards the extractor itself)', () => {
    expect(
      adminExports.has('resolveDueDate'),
      `Could not find resolveDueDate among the exports parsed from ${ADMIN_FILE}. ` +
        'Either the file moved or its export syntax changed; fix the path or the extractor before trusting anything else in this suite.',
    ).toBe(true);
    expect(
      serverExports.has('resolveDueDate'),
      `Could not find resolveDueDate among the exports parsed from ${SERVER_FILE}. ` +
        'Either the server file moved or its export syntax changed; fix the path or the extractor before trusting anything else in this suite.',
    ).toBe(true);
  });

  it('keeps the mirror at exactly the declared shared set', () => {
    const extra = sorted(adminExports).filter((n) => !SHARED_EXPORTS.includes(n));
    const missing = SHARED_EXPORTS.filter((n) => !adminExports.has(n));

    expect(
      extra,
      'The admin mirror exports something the server file does not declare as shared: ' +
        `[${extra.join(', ')}]. The mirror previews a server decision. Add it to the SERVER ` +
        'file first, then to SHARED_EXPORTS here; admin-only logic belongs in its own module.',
    ).toEqual([]);

    expect(
      missing,
      'The admin mirror lost an export it promises to carry: ' +
        `[${missing.join(', ')}]. Restore it, or, if the composer no longer needs it, remove it ` +
        'from SHARED_EXPORTS and from the mirror header prose in the same change.',
    ).toEqual([]);
  });

  it('never claims a rule the server has disowned', () => {
    const disowned = SHARED_EXPORTS.filter((n) => !serverExports.has(n));
    expect(
      disowned,
      'The server no longer exports something the mirror still carries: ' +
        `[${disowned.join(', ')}]. The server is the authority; a mirror of a rule the authority ` +
        'deleted is a fork, not a preview.',
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
        `[${unaccounted.join(', ')}]. Does the composer's due-date preview need it too? If YES: ` +
        'copy it into src/lib/invoiceTerms.ts, add it to SHARED_EXPORTS, and extend the fixture ' +
        'tables in both trees. If NO: add it to KNOWN_SERVER_ONLY_EXPORTS with a comment saying why.',
    ).toEqual([]);

    expect(
      gone,
      'A server export this test pins has disappeared: ' +
        `[${gone.join(', ')}]. If it was removed deliberately, remove it here and from the mirror ` +
        'too. If not, the authority just lost a rule something still depends on.',
    ).toEqual([]);
  });

  it('keeps the two rule tables literally identical', () => {
    // The DEFS table IS the product decision: which terms exist, what each one
    // counts from, and the exact sentence a household reads. A drift here would
    // show the operator one rule in the composer and print another on the bill.
    const table = (file: string) => {
      const src = readFileSync(file, 'utf8');
      const start = src.indexOf('const DEFS');
      const end = src.indexOf('/** The rule behind one code. */');
      expect(start, `Could not find the DEFS table in ${file}`).toBeGreaterThan(-1);
      expect(end, `Could not find the end of the DEFS table in ${file}`).toBeGreaterThan(start);
      return src.slice(start, end).trim();
    };
    expect(
      table(ADMIN_FILE),
      'The terms table in the mirror is not character-for-character the server table. One of the ' +
        'two is now offering terms, or printing words on a household bill, that the other does not.',
    ).toBe(table(SERVER_FILE));
  });
});
