import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Issue #860: qa_enable_sandbox_login.js and qa_set_sandbox_password.js
 * called the legacy admin.credential(...)/admin.firestore()/admin.auth()
 * namespace, which is `undefined` on the installed firebase-admin 14.3.0 (the
 * legacy namespace was removed in favor of the modular API). Nothing else
 * under mytribe/scripts referenced either script, so the break went
 * unnoticed until an operator actually ran one and hit a TypeError.
 *
 * This test scans every script source file under mytribe/scripts for that
 * namespace (and the sibling legacy members firebase-admin also removed:
 * admin.firestore.FieldValue/Timestamp, admin.messaging(), admin.storage())
 * so the next accidental reintroduction (a copy-pasted snippet from an old
 * doc, an AI suggestion trained on the old API, ...) fails here in CI rather
 * than silently at runtime on the next firebase-admin major.
 *
 * Comments are stripped before matching (see stripComments), so a docstring
 * that explains the old call shape in prose - like the header comment above,
 * or this file's own header - never fails this test. Stripping is naive
 * (not string-literal-aware): a `//` inside a string, e.g. a URL, gets
 * clipped along with everything after it on that line. That can only cause a
 * false NEGATIVE (a real call hidden after a stray `//` in the same
 * statement, vanishingly unlikely for these call shapes), never a false
 * POSITIVE, which is the failure mode this test exists to avoid.
 *
 * The scan excludes test/ (see EXCLUDED_DIRS), so this file is never scanned
 * and cannot match itself even though the `it()` names below do spell out
 * the call shape for a readable failure message. The regex patterns
 * themselves are still assembled from string parts rather than one literal,
 * as a second, independent guard against a future refactor of the exclusion
 * list quietly making this file scan itself.
 */
const SCRIPTS_DIR = path.resolve(__dirname, '..');
const SCAN_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);
const EXCLUDED_DIRS = new Set(['test', 'backups', 'node_modules']);

const NS = 'admin';
const LEGACY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: `${NS}.credential`, re: new RegExp(NS + '\\.' + 'credential' + '\\b') },
  { label: `${NS}.firestore()`, re: new RegExp(NS + '\\.' + 'firestore' + '\\s*\\(') },
  { label: `${NS}.auth()`, re: new RegExp(NS + '\\.' + 'auth' + '\\s*\\(') },
  {
    label: `${NS}.firestore.FieldValue`,
    re: new RegExp(NS + '\\.' + 'firestore' + '\\.' + 'FieldValue' + '\\b'),
  },
  {
    label: `${NS}.firestore.Timestamp`,
    re: new RegExp(NS + '\\.' + 'firestore' + '\\.' + 'Timestamp' + '\\b'),
  },
  { label: `${NS}.messaging()`, re: new RegExp(NS + '\\.' + 'messaging' + '\\s*\\(') },
  { label: `${NS}.storage()`, re: new RegExp(NS + '\\.' + 'storage' + '\\s*\\(') },
];

/** Strips block comments and line comments. Not string-literal-aware - see the file header. */
export function stripComments(src: string): string {
  const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlockComments.replace(/\/\/.*$/gm, '');
}

/** Returns the first legacy pattern label found in `src` outside of comments, or null. */
export function findLegacyNamespaceUsage(src: string): string | null {
  const code = stripComments(src);
  for (const { label, re } of LEGACY_PATTERNS) {
    if (re.test(code)) return label;
  }
  return null;
}

function listScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...listScriptFiles(path.join(dir, entry.name)));
      continue;
    }
    if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('findLegacyNamespaceUsage', () => {
  it('a comment mentioning the old admin.foo() shape does not fail the scan', () => {
    const src = [
      '// old code used to call admin.credential.applicationDefault() here',
      '/* also admin.firestore() and admin.auth() were removed */',
      'export const x = 1;',
    ].join('\n');
    expect(findLegacyNamespaceUsage(src)).toBeNull();
  });

  it('real (non-comment) legacy code is still caught: admin.auth()', () => {
    expect(findLegacyNamespaceUsage('const x = admin.auth();')).toBe('admin.auth()');
  });

  it('real (non-comment) legacy code is still caught: admin.credential', () => {
    expect(findLegacyNamespaceUsage('admin.credential.applicationDefault()')).toBe('admin.credential');
  });

  it('real (non-comment) legacy code is still caught: admin.firestore.FieldValue', () => {
    expect(findLegacyNamespaceUsage('const d = admin.firestore.FieldValue.delete();')).toBe(
      'admin.firestore.FieldValue',
    );
  });

  it('real (non-comment) legacy code is still caught: admin.firestore.Timestamp', () => {
    expect(findLegacyNamespaceUsage('const t = admin.firestore.Timestamp.now();')).toBe(
      'admin.firestore.Timestamp',
    );
  });

  it('real (non-comment) legacy code is still caught: admin.messaging()', () => {
    expect(findLegacyNamespaceUsage('admin.messaging().send(msg);')).toBe('admin.messaging()');
  });

  it('real (non-comment) legacy code is still caught: admin.storage()', () => {
    expect(findLegacyNamespaceUsage('admin.storage().bucket();')).toBe('admin.storage()');
  });

  it('clean modular-API code matches nothing', () => {
    expect(findLegacyNamespaceUsage("import { getAuth } from 'firebase-admin/auth';")).toBeNull();
  });
});

describe('no script under mytribe/scripts resolves the removed firebase-admin legacy namespace', () => {
  const files = listScriptFiles(SCRIPTS_DIR);

  it('found a non-trivial number of files to scan (guards against an empty/broken scan)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const rel = path.relative(SCRIPTS_DIR, file);
    it(`${rel} does not call the legacy admin.credential/admin.firestore()/admin.auth()/... namespace`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const hit = findLegacyNamespaceUsage(src);
      expect(hit, `${rel} matched legacy pattern ${hit}`).toBeNull();
    });
  }
});
