import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ISSUE #602: the portal must not read a `kin_care_reports` DOCUMENT directly.
 *
 * `firestore.rules` no longer grants a kinfolk read on that collection, because
 * the document carries `gpsRoute` -- the coordinate trail `getMyKinTales`
 * strips on the way out -- and a rule gates a document rather than a field.
 * KinTales reach this app through `getMyKinTales`, and their threads through
 * `getMyKinTaleComments`.
 *
 * A DIRECT READ ADDED LATER WOULD NOT FAIL LOUDLY IN DEVELOPMENT. It would
 * compile, ship, and come back `permission-denied` in a household's browser,
 * which reads as "KinTales are broken" rather than as "this collection is not
 * ours to read." This test turns that into a red build instead, and names the
 * replacement in its failure message.
 *
 * THERE IS NO CARVE-OUT HERE, unlike the session guard next door. That one
 * exempts the `breadcrumbs` subcollection because live tracking genuinely
 * subscribes to it and a callable cannot push. Nothing under
 * `kin_care_reports` is read directly by this client at all -- comments
 * included -- so any mention in shipping code is an offender.
 *
 * WHAT A SOURCE SCAN CANNOT SEE, said plainly rather than implied: a collection
 * name assembled at runtime, or reached through a variable, walks past the
 * first case below. That is what the second case is for -- it pins the whole
 * set of files that touch Firestore at all, so a new direct reader has to
 * announce itself here however it spells the path. Neither case is a substitute
 * for the rule; the rule is the enforcement and these are the early warning.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = dirname(HERE);
const COLLECTION = 'kin_care_reports';

/**
 * The files that may import the Firestore SDK, and why. Both live listeners are
 * on subcollections whose rules gate them per household; neither is a report.
 * `firebase.ts` is the SDK handle itself. Kept identical to the list in
 * `sessionDirectReads.test.ts` on purpose: if a file is added there and not
 * here, one of the two guards is out of date.
 */
const FIRESTORE_IMPORTERS = ['lib/breadcrumbs.ts', 'lib/firebase.ts', 'lib/messagesListener.ts'];

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

/** `src`-relative, forward-slashed, so a failure message is greppable as written. */
function rel(file: string): string {
  return relative(SRC, file).split(/[\\/]/).join('/');
}

/** A line that is only prose. The collection is discussed in comments all over. */
function isComment(text: string): boolean {
  return /^(\/\/|\/\*|\*)/.test(text);
}

/** Every `kin_care_reports` mention in shipping CODE, line by line. */
function mentions(): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const file of sourceFiles(SRC)) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((raw, i) => {
        const text = raw.trim();
        if (!text.includes(COLLECTION) || isComment(text)) return;
        out.push({ file: rel(file), line: i + 1, text });
      });
  }
  return out;
}

describe('the portal reads KinTales through getMyKinTales, never the report document', () => {
  it('never names kin_care_reports in shipping code', () => {
    expect(
      mentions().map((m) => `src/${m.file}:${m.line}  ${m.text}`),
      'These lines reach for kin_care_reports. firestore.rules denies a kinfolk that ' +
        'read (#602), so this would ship as a permission-denied in production. Use ' +
        'getMyKinTales for tales and getMyKinTaleComments for threads (src/api/portal.ts); ' +
        'both project the document and strip gpsRoute.',
    ).toEqual([]);
  });

  it('touches Firestore from three files and no others', () => {
    const importers = sourceFiles(SRC)
      .filter((f) => /from '(firebase\/firestore|firebase-admin\/firestore)'/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();

    expect(
      importers,
      'A new file imports the Firestore SDK. That is not forbidden, but a portal ' +
        'read is rules-gated per collection and a report document is denied ' +
        'outright (#602) — so add it to FIRESTORE_IMPORTERS deliberately, after ' +
        'checking the collection has a kinfolk read branch it can actually use.',
    ).toEqual(FIRESTORE_IMPORTERS);
  });

  /** The positive half: the KinTales screen's tales and threads come from callables. */
  it('loads tales and their comments from the two callables', () => {
    const portalApi = readFileSync(join(SRC, 'api/portal.ts'), 'utf8');
    expect(
      portalApi.includes("call<GetMyKinTalesRequest, GetMyKinTalesResult>('getMyKinTales'"),
      'portal.ts no longer calls getMyKinTales. That callable is the only path a ' +
        'kinfolk has to a KinTale since #602 closed the direct document read.',
    ).toBe(true);

    const screen = readFileSync(join(SRC, 'screens/KinTales.tsx'), 'utf8');
    expect(
      screen.includes('getMyKinTaleComments'),
      'The KinTales screen no longer loads its threads through getMyKinTaleComments.',
    ).toBe(true);
  });
});
