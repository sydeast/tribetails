import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Every `*.emulator.test.ts` in this directory must take firebase-admin from
 * `../lib/firebaseAdmin`, never from `firebase-admin` or `@google-cloud/firestore`
 * directly (issue #870).
 *
 * The scripts build their writes (FieldValue.delete(), Timestamp) from the copy
 * lib/firebaseAdmin anchors at mytribe/functions/node_modules. A test importing
 * the package itself resolves by walking up from mytribe/scripts/test, which
 * never reaches that directory. On the operator machine it found a stray
 * $HOME/node_modules/firebase-admin 13.8.0, and Firestore refused to serialize
 * the scripts' 14.3.0 DeleteTransform: two backfill emulator tests had never
 * passed. A direct import also bypasses the #846 resolve guard.
 *
 * This file is named `*.test.ts`, not `*.emulator.test.ts`, so it runs in the
 * plain unit suite with no emulator, and a new emulator test that slips back to
 * a direct import fails there first.
 */

const TEST_DIR = __dirname;
const FORBIDDEN = /^(?:firebase-admin|@google-cloud\/firestore)(?:\/|$)/;

/** Module specifiers a TypeScript source imports, requires or re-exports, comments removed. */
export function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm;
  const found: string[] = [];
  for (const match of code.matchAll(pattern)) found.push(match[2]);
  return found;
}

export function forbiddenImports(source: string): string[] {
  return importSpecifiers(source).filter((s) => FORBIDDEN.test(s));
}

describe('emulator tests take firebase-admin only from lib/firebaseAdmin', () => {
  it('catches every shape of direct import, and nothing else', () => {
    expect(forbiddenImports("import { getApps } from 'firebase-admin/app';")).toEqual(['firebase-admin/app']);
    expect(forbiddenImports('import type { Firestore } from "firebase-admin/firestore";')).toEqual([
      'firebase-admin/firestore',
    ]);
    expect(forbiddenImports("import * as admin from 'firebase-admin';")).toEqual(['firebase-admin']);
    expect(forbiddenImports("import 'firebase-admin';")).toEqual(['firebase-admin']);
    expect(forbiddenImports("const a = require('firebase-admin');")).toEqual(['firebase-admin']);
    expect(forbiddenImports("const f = await import('@google-cloud/firestore');")).toEqual([
      '@google-cloud/firestore',
    ]);
    expect(forbiddenImports("export { Timestamp } from '@google-cloud/firestore';")).toEqual([
      '@google-cloud/firestore',
    ]);
    expect(
      forbiddenImports("import {\n  getApps,\n  getFirestore,\n} from 'firebase-admin/firestore';"),
    ).toEqual(['firebase-admin/firestore']);

    expect(forbiddenImports("import { getFirestore, Timestamp } from '../lib/firebaseAdmin';")).toEqual([]);
    expect(forbiddenImports("import { x } from 'firebase-admin-extra';")).toEqual([]);
    expect(forbiddenImports("// never 'firebase-admin/*' directly\nimport { a } from '../lib/firebaseAdmin';")).toEqual([]);
    expect(forbiddenImports("/* import { a } from 'firebase-admin/app'; */")).toEqual([]);
  });

  const files = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.emulator.test.ts'))
    .sort();

  it('finds the emulator tests it is guarding', () => {
    // Six existed when this check was written. Fewer means the glob or the
    // directory moved and the check below would pass on nothing.
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it.each(files)('%s imports no firebase-admin or @google-cloud/firestore directly', (file) => {
    const source = fs.readFileSync(path.join(TEST_DIR, file), 'utf8');
    expect(forbiddenImports(source), `use ../lib/firebaseAdmin in ${file}`).toEqual([]);
  });
});
