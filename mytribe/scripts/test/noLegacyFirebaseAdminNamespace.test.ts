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
 * namespace so the next accidental reintroduction (a copy-pasted snippet
 * from an old doc, an AI suggestion trained on the old API, ...) fails here
 * in CI rather than silently at runtime on the next firebase-admin major.
 *
 * The scan excludes test/ (see EXCLUDED_DIRS), so this file is never scanned
 * and cannot match itself even though the `it()` names below do spell out
 * the call shape for a readable failure message. The regex patterns
 * themselves are still assembled from string parts rather than one literal,
 * as a second, independent guard against a future refactor of the exclusion
 * list quietly making this file scan itself.
 */
const SCRIPTS_DIR = path.resolve(__dirname, '..');
const SCAN_EXTENSIONS = new Set(['.ts', '.js']);
const EXCLUDED_DIRS = new Set(['test', 'backups', 'node_modules']);

const NS = 'admin';
const LEGACY_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: `${NS}.credential`, re: new RegExp(NS + '\\.' + 'credential' + '\\b') },
  { label: `${NS}.firestore()`, re: new RegExp(NS + '\\.' + 'firestore' + '\\s*\\(') },
  { label: `${NS}.auth()`, re: new RegExp(NS + '\\.' + 'auth' + '\\s*\\(') },
];

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

describe('no script under mytribe/scripts resolves the removed firebase-admin legacy namespace', () => {
  const files = listScriptFiles(SCRIPTS_DIR);

  it('found a non-trivial number of files to scan (guards against an empty/broken scan)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const rel = path.relative(SCRIPTS_DIR, file);
    it(`${rel} does not call the legacy admin.credential/admin.firestore()/admin.auth() namespace`, () => {
      const src = fs.readFileSync(file, 'utf8');
      for (const { label, re } of LEGACY_PATTERNS) {
        expect(re.test(src), `${rel} matched legacy pattern ${label}`).toBe(false);
      }
    });
  }
});
