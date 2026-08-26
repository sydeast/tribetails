import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ISSUE #584: the portal must not read a `kin_care_sessions` DOCUMENT directly.
 *
 * `firestore.rules` no longer grants a kinfolk read on that collection, because
 * the document carries `gpsSummary` (start/end coordinates and the full route)
 * next to `notes` (gate codes) and the rest of AuntieOS's working state, and a
 * rule gates a document rather than a field. Visits reach this app through
 * `getMyVisits`, which projects the document field by field and honours
 * `allowClientLocationSharing`.
 *
 * A DIRECT READ ADDED LATER WOULD NOT FAIL LOUDLY IN DEVELOPMENT. It would
 * compile, ship, and come back `permission-denied` in a household's browser,
 * which reads as "the schedule is broken" rather than as "this collection is not
 * ours to read." This test turns that into a red build instead, and names the
 * replacement in its failure message.
 *
 * THE ONE ALLOWED USE is the `breadcrumbs` SUBcollection, a different document
 * with its own rule — one that does consult the operator's location switch
 * (#519). Live tracking still subscribes to it directly, because a callable
 * cannot push.
 *
 * WHAT A SOURCE SCAN CANNOT SEE, said plainly rather than implied: a collection
 * name assembled at runtime, or reached through a variable, walks past the first
 * case below. That is what the third case is for — it pins the whole set of
 * files that touch Firestore at all, so a new direct reader has to announce
 * itself here however it spells the path. Neither case is a substitute for the
 * rule; the rule is the enforcement and these two are the early warning.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = dirname(HERE);
const COLLECTION = 'kin_care_sessions';

/**
 * The files that may import the Firestore SDK, and why. Both are LIVE listeners
 * on subcollections whose rules gate them per household; neither is a session
 * document. `firebase.ts` is the SDK handle itself.
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

/** Every `kin_care_sessions` mention in shipping CODE, line by line. */
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

describe('the portal reads visits through getMyVisits, never the session document', () => {
  it('names kin_care_sessions only as the parent of a breadcrumbs path', () => {
    const offenders = mentions().filter((m) => !m.text.includes('breadcrumbs'));

    expect(
      offenders.map((m) => `src/${m.file}:${m.line}  ${m.text}`),
      'These lines reach for kin_care_sessions outside the breadcrumbs subcollection. ' +
        'firestore.rules denies a kinfolk that read (#584), so this would ship as a ' +
        'permission-denied in production. Use getMyVisits (src/api/portal.ts), which ' +
        'projects the document and honours allowClientLocationSharing.',
    ).toEqual([]);
  });

  /** Not a coverage target, a tripwire: if this empties the guard guards nothing. */
  it('still finds the live-tracking listener it is carving out', () => {
    const breadcrumbUses = mentions().filter((m) => m.text.includes('breadcrumbs'));
    expect(breadcrumbUses.map((m) => m.file)).toContain('lib/breadcrumbs.ts');
  });

  it('touches Firestore from three files and no others', () => {
    const importers = sourceFiles(SRC)
      .filter((f) => /from '(firebase\/firestore|firebase-admin\/firestore)'/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .sort();

    expect(
      importers,
      'A new file imports the Firestore SDK. That is not forbidden, but a portal ' +
        'read is rules-gated per collection and a session document is denied ' +
        'outright (#584) — so add it to FIRESTORE_IMPORTERS deliberately, after ' +
        'checking the collection has a kinfolk read branch it can actually use.',
    ).toEqual(FIRESTORE_IMPORTERS);
  });

  /** The positive half: the Schedule screen's visits come from the callable. */
  it('loads the Schedule screen visits from the getMyVisits callable', () => {
    expect(readFileSync(join(SRC, 'screens', 'Schedule.tsx'), 'utf8')).toContain('getMyVisits');
    expect(readFileSync(join(SRC, 'api', 'portal.ts'), 'utf8')).toContain(
      "call<GetMyVisitsRequest, GetMyVisitsResult>('getMyVisits'",
    );
  });
});
