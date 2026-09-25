/**
 * generateSeedCorpus.ts
 *
 * Bundles `mytribe/seeds/notificationTemplates/` into a TypeScript module the
 * deployed functions can read, and in `--check` mode is the CI gate that keeps
 * the bundle honest.
 *
 *   npm --prefix mytribe/functions run seeds:generate   rewrite the module
 *   npm --prefix mytribe/functions run seeds:check      fail on any diff
 *
 * WHY A BUNDLE AT ALL. `firebase.json` deploys the mytribe codebase with
 * `"source": "functions"`, so everything outside `mytribe/functions/` is absent
 * from the uploaded bundle. `mytribe/seeds/` is outside it. A callable that
 * tried to `readFileSync` the corpus would work in the emulator, where the
 * whole repository is on disk, and throw ENOENT in production, which is the
 * worst of the three possible behaviours. Neither client can read the corpus
 * either: the admin web app ships as static assets and the Android app as an
 * APK. So the corpus travels with the server or the importer is a lie.
 *
 * WHY RAW FILE CONTENTS, NOT PARSED FIELDS. `subject.txt`, `headline.txt` and
 * `content.html` are read and trimmed as-is: the visual format has nothing
 * left to parse out of them. `push.txt` still runs through `parsePushTxt` (and
 * `sms.txt` through the same "is it empty" check the seed script uses), so a
 * malformed one of those two is red at generation time and therefore in CI.
 * The generator stores what it read, not what it parsed, and the importer
 * parses `push.txt` again at call time with the same function: one parse
 * authority, one set of error messages, and a change to the parser cannot
 * leave a stale interpretation frozen in a generated file.
 *
 * The seed script `mytribe/scripts/seedNotificationTemplates.ts` still reads the
 * directories directly, and stays the corpus's other reader. It is not deleted
 * and not the operator's route any more; see issue #468.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parsePushTxt } from '../src/notifications/templateParsers';

/** `<repo>/mytribe/functions/scripts` -> `<repo>`. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Where the corpus lives, relative to the repository root. */
export const CORPUS_DIR = 'mytribe/seeds/notificationTemplates';

/** Where the generated module lands, relative to the repository root. */
export const CORPUS_MODULE_PATH = 'mytribe/functions/src/notifications/seedCorpus.generated.ts';

export const SEEDS_GENERATE_COMMAND = 'npm --prefix mytribe/functions run seeds:generate';
export const SEEDS_CHECK_COMMAND = 'npm --prefix mytribe/functions run seeds:check';

/** The five files every corpus directory must carry. */
export const REQUIRED_FILES = ['subject.txt', 'headline.txt', 'content.html', 'sms.txt', 'push.txt'] as const;

/** One directory's raw contents, exactly as read off disk. */
export interface RawCorpusEntry {
  key: string;
  emailSubject: string;
  emailHeadline: string;
  emailContent: string;
  smsTxt: string;
  pushTxt: string;
}

/**
 * Reads and validates every directory under the corpus root.
 *
 * Validation is the seed script's, deliberately: the same five required files,
 * the same "sms.txt is empty" refusal, and the same push parser. A corpus this
 * generator accepts is a corpus `seed:notif-templates` would have accepted.
 */
export function readCorpus(corpusRoot: string): RawCorpusEntry[] {
  const dirNames = readdirSync(corpusRoot)
    .filter((name) => statSync(join(corpusRoot, name)).isDirectory())
    .sort();

  return dirNames.map((key) => {
    const dir = join(corpusRoot, key);
    for (const file of REQUIRED_FILES) {
      if (!existsSync(join(dir, file))) {
        throw new Error(`seed corpus: ${key}: missing required file ${file}`);
      }
    }
    const entry: RawCorpusEntry = {
      key,
      emailSubject: readFileSync(join(dir, 'subject.txt'), 'utf8').trim(),
      emailHeadline: readFileSync(join(dir, 'headline.txt'), 'utf8').trim(),
      emailContent: readFileSync(join(dir, 'content.html'), 'utf8').trim(),
      smsTxt: readFileSync(join(dir, 'sms.txt'), 'utf8'),
      pushTxt: readFileSync(join(dir, 'push.txt'), 'utf8'),
    };

    if (entry.emailSubject.length === 0) {
      throw new Error(`seed corpus: ${key}: subject.txt is empty`);
    }
    if (entry.emailHeadline.length === 0) {
      throw new Error(`seed corpus: ${key}: headline.txt is empty`);
    }
    // Parse now so a broken push.txt fails here rather than in a callable an
    // operator is watching. The result is thrown away on purpose.
    try {
      parsePushTxt(entry.pushTxt);
    } catch (err) {
      throw new Error(`seed corpus: ${key}: ${(err as Error).message}`, { cause: err });
    }
    if (entry.smsTxt.trim().length === 0) {
      throw new Error(`seed corpus: ${key}: sms.txt is empty`);
    }
    return entry;
  });
}

function banner(): string {
  return [
    '// GENERATED FILE. DO NOT EDIT.',
    '//',
    `// The notification template seed corpus, bundled so the deployed functions`,
    `// can read it. ${CORPUS_DIR} is outside the`,
    '// functions deploy root, so the importer callable cannot reach it at runtime',
    '// and this module is how it travels.',
    '//',
    `// Source:      ${CORPUS_DIR}/*/{${REQUIRED_FILES.join(',')}}`,
    `// Regenerate:  ${SEEDS_GENERATE_COMMAND}`,
    `// Verify:      ${SEEDS_CHECK_COMMAND}`,
    '//',
    '// CI runs the verify command and fails on any difference, so an edit to a',
    '// seed file and its bundled fallout land in one reviewable commit.',
  ].join('\n');
}

/** Renders the module. Pure, so the unit tests exercise what the CLI writes. */
export function emitCorpusModule(entries: RawCorpusEntry[]): string {
  const rows = entries
    .map((entry) =>
      [
        '  {',
        `    key: ${JSON.stringify(entry.key)},`,
        `    emailSubject: ${JSON.stringify(entry.emailSubject)},`,
        `    emailHeadline: ${JSON.stringify(entry.emailHeadline)},`,
        `    emailContent: ${JSON.stringify(entry.emailContent)},`,
        `    smsTxt: ${JSON.stringify(entry.smsTxt)},`,
        `    pushTxt: ${JSON.stringify(entry.pushTxt)},`,
        '  },',
      ].join('\n'),
    )
    .join('\n');

  return [
    banner(),
    '',
    '/** One seed directory, raw. Parsed by the importer, never pre-parsed here. */',
    'export interface SeedCorpusEntry {',
    '  /** The directory name, which is also the template id it seeds. */',
    '  readonly key: string;',
    '  readonly emailSubject: string;',
    '  readonly emailHeadline: string;',
    '  readonly emailContent: string;',
    '  readonly smsTxt: string;',
    '  readonly pushTxt: string;',
    '}',
    '',
    `/** Every directory under ${CORPUS_DIR}, sorted by key. */`,
    'export const SEED_CORPUS: readonly SeedCorpusEntry[] = [',
    rows,
    '];',
    '',
  ].join('\n');
}

/** The first line where two texts differ, 1-based, or null when they match. */
function firstDifferingLine(expected: string, actual: string): number | null {
  if (expected === actual) return null;
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const shared = Math.min(expectedLines.length, actualLines.length);
  for (let i = 0; i < shared; i += 1) {
    if (expectedLines[i] !== actualLines[i]) return i + 1;
  }
  return shared + 1;
}

function main(): number {
  const checkOnly = process.argv.includes('--check');
  let contents: string;
  try {
    contents = emitCorpusModule(readCorpus(join(REPO_ROOT, CORPUS_DIR)));
  } catch (err) {
    console.error(`Seed corpus generation refused:\n\n  ${(err as Error).message}\n`);
    return 2;
  }

  const target = join(REPO_ROOT, CORPUS_MODULE_PATH);
  if (checkOnly) {
    if (!existsSync(target)) {
      console.error(`\n${CORPUS_MODULE_PATH}: missing entirely.\nRun:  ${SEEDS_GENERATE_COMMAND}\n`);
      return 1;
    }
    const line = firstDifferingLine(contents, readFileSync(target, 'utf8'));
    if (line === null) {
      console.log(`ok        ${CORPUS_MODULE_PATH}`);
      console.log('\nThe committed seed corpus module matches the files on disk.');
      return 0;
    }
    console.error(
      `\n${CORPUS_MODULE_PATH}: first difference at line ${line}.\n\n` +
        `Either a seed file changed without its bundled fallout, or the generated ` +
        `module was hand-edited.\nRun:  ${SEEDS_GENERATE_COMMAND}\n` +
        `and commit the result alongside the seed change.\n`,
    );
    return 1;
  }

  mkdirSync(dirname(target), { recursive: true });
  const unchanged = existsSync(target) && readFileSync(target, 'utf8') === contents;
  if (!unchanged) writeFileSync(target, contents, 'utf8');
  console.log(`${unchanged ? 'unchanged' : 'written  '}  ${CORPUS_MODULE_PATH}`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}
