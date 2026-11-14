import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #1906: household reads match what the portal shows.
 *
 * `firestore.rules` grants a household no direct read of `invoices` (nor the
 * older `families/{fid}/invoices` copies) or of a visit's
 * `bookings/{batchId}/kinCares/{visitId}` document. Bills reach this app
 * through `getMyInvoices`, which leaves out every invoice the office has not
 * sent, and visits through `getMyBookings`, which projects only what a
 * household sees. The rule is the enforcement; this guard turns a direct read
 * added later into a red build rather than a permission-denied in a
 * household's browser.
 *
 * WHAT IT CAN SEE. The first case reads every file that imports the Firestore
 * SDK for one of those paths. The second pins that set of files, so a reader
 * that spells the path some other way still has to announce itself.
 * `reportDirectReads.test.ts` is the same guard for #602, with the same list.
 *
 * The MyTribe Android app's twin is `DirectHouseholdReadTest.kt`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = dirname(HERE);

/** Kept identical to the list in `reportDirectReads.test.ts`; see the reasons there. */
const FIRESTORE_IMPORTERS = [
  'lib/breadcrumbs.ts',
  'lib/businessPublicCard.ts',
  'lib/firebase.ts',
  'lib/kinDirectRead.ts',
  'lib/messagesListener.ts',
  'lib/vetClinicsDirectRead.ts',
];

/** A path segment a household reads only through a callable, as it would be spelled in a Firestore path. */
const CALLABLE_ONLY = /['"`/](invoices|kinCares|bookings)\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return relative(SRC, file).split(/[\\/]/).join('/');
}

function isComment(text: string): boolean {
  return /^(\/\/|\/\*|\*)/.test(text);
}

function firestoreImporters(): string[] {
  return sourceFiles(SRC).filter((f) =>
    /from '(firebase\/firestore|firebase-admin\/firestore)'/.test(readFileSync(f, 'utf8')),
  );
}

describe('#1906 the portal reads bills and visits through callables, never the documents', () => {
  it('no file that touches Firestore names a bill or a visit document', () => {
    const offenders: string[] = [];
    for (const file of firestoreImporters()) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((raw, i) => {
          const text = raw.trim();
          if (isComment(text) || !CALLABLE_ONLY.test(text)) return;
          offenders.push(`src/${rel(file)}:${i + 1}  ${text}`);
        });
    }
    expect(
      offenders,
      'These lines reach for a bill or a visit document directly. firestore.rules gives ' +
        'a household no such read (#1906), so this would ship as a permission-denied. ' +
        'Use getMyInvoices (src/api/invoicesApi.ts) for bills and getMyBookings ' +
        '(src/api/portal.ts) for visits.',
    ).toEqual([]);
  });

  it('touches Firestore from the known files and no others', () => {
    expect(
      firestoreImporters().map(rel).sort(),
      'A new file imports the Firestore SDK. Add it to FIRESTORE_IMPORTERS here and in ' +
        'reportDirectReads.test.ts deliberately, after checking the collection has a ' +
        'household read it can use: bills and visit documents have none (#1906).',
    ).toEqual(FIRESTORE_IMPORTERS);
  });

  it('loads bills and visits from the two callables', () => {
    expect(readFileSync(join(SRC, 'api/invoicesApi.ts'), 'utf8')).toContain("('getMyInvoices'");
    expect(readFileSync(join(SRC, 'api/portal.ts'), 'utf8')).toContain("('getMyBookings'");
  });
});
