#!/usr/bin/env node
/**
 * Ask Auntie's voice files, for a release that runs where they are not (#2399).
 *
 *   node scripts/voice-secret.mjs restore [--project P]   release step 1b
 *   node scripts/voice-secret.mjs clean                   release exit
 *   node scripts/voice-secret.mjs push [--project P]      the operator, on the Mac
 *   node scripts/voice-secret.mjs compare [--project P]   release step 1b, on the Mac
 *
 * WHY THIS EXISTS
 * `generateAuntieCopy` reads three files from auntieos-admin/web/functions/voice/
 * and answers every draft with a 500 when one is missing. The files hold real
 * households' names and the repo is public, so they are gitignored and exist
 * only on the operator's Mac. The scheduled release runs on a GitHub runner
 * from a fresh checkout, so it uploaded the admin functions without them, and
 * Ask Auntie was broken from that release until the next one from the Mac.
 *
 * The files now also live in Secret Manager, as one secret (SECRET_NAME below).
 * `push` stores them from the Mac. `restore` puts them into a checkout that has
 * none, for the length of one release. `clean` takes them out again.
 *
 * WHY SECRET MANAGER AND NOT A GITHUB SECRET. The release account already
 * reads Secret Manager (step 0c), so the runner needs no new credential and
 * the workflow needs no new input. Workload Identity hands that account a
 * token only on `main`, while a repository secret is readable by a workflow on
 * any branch a collaborator pushes. A version holds 64 KiB against GitHub's
 * 48 KB, and the files grow with every sample added.
 *
 * WHY NOT READ THEM AT RUNTIME. The function could fetch this secret itself on
 * its first draft. That would put a voice edit live without a release and
 * without checkVoice.js having seen it, so a samples file with a bad names
 * block would stop every draft the moment it was stored. It would also give
 * generate.js a second way to load its voice (the emulator and the tests still
 * need the files), and change what a release from the Mac ships. Restoring at
 * deploy time leaves one read path and keeps the check before the deploy.
 *
 * EXIT CODES OF `restore`. release.sh reads the number, so no two outcomes
 * share one:
 *   0  the stored copy passed checkVoice.js and is now in the checkout
 *   1  the stored copy cannot be used: empty, not a bundle, a file short, or
 *      refused by checkVoice.js. Nothing was written.
 *   3  Secret Manager answered, and it holds no such secret
 *   4  Secret Manager could not be asked (no gcloud, no credentials, no answer)
 *   5  Secret Manager lists the secret and would not hand over its value
 *   6  some of the voice files are already in the checkout. Nothing was
 *      written over them.
 *
 * EXIT CODES OF `compare`. It runs in a checkout that has the files, the Mac,
 * and answers one question: is the stored copy these files? A hosted release
 * ships the stored copy, so a copy that fell behind puts the older voice back
 * on the next scheduled run. release.sh warns on every answer but 0 and never
 * stops on any of them. 3, 4 and 5 mean what they mean for `restore`:
 *   0  the stored copy holds the same three files
 *   3  Secret Manager answered, and it holds no such secret
 *   4  Secret Manager could not be asked
 *   5  Secret Manager lists the secret and would not hand over its value
 *   6  the checkout does not have all three files, so there is nothing to
 *      compare
 *   7  the stored copy holds different files
 *   8  the stored copy cannot be used: empty, or not a bundle
 * The two sides are compared by SHA-256 of the files' text, in memory. Not by
 * the stored string: gzip's bytes can change with the Node that packed them,
 * and a Node upgrade would then read as an edit. The stored copy is written
 * nowhere, and no digest is printed.
 *
 * NOTHING HERE PRINTS A LINE OF A VOICE FILE, and the bundle never goes on a
 * command line. A release log is public. That includes error text: Node's
 * JSON.parse quotes the input it choked on, so its message is never printed.
 *
 * THE BUNDLE is base64 of gzip of JSON: `{ format, files: { path: text } }`.
 * Node writes and reads it on both sides, so nothing depends on which `tar` or
 * `base64` a Mac and an ubuntu runner happen to carry.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_GCLOUD_TIMEOUT_MS,
  SECRET_UNREADABLE,
  classifyAccessFailure,
  isGcloudTimeout,
  isUnreadableValue,
  listSecretsWithGcloud,
  makeGcloudFetcher,
  unreadableWhy,
} from './client-secrets.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = path.join(ROOT, 'auntieos-admin', 'web', 'functions');
const VOICE_REL = 'auntieos-admin/web/functions/voice';
// The checker and its file list, from the codebase that owns them: one list of
// which files are the voice, and the same question generate.js asks.
const { checkVoice, VOICE_FILES } = require(path.join(FUNCTIONS_DIR, 'checkVoice.js'));

export const SECRET_NAME = 'AUNTIE_VOICE_FILES';
export const BUNDLE_FORMAT = 'auntie-voice/1';
/** Secret Manager's limit on one version's payload. */
export const MAX_STORED_BYTES = 65536;

const SYNC_COMMAND = 'npm run sync:voice --prefix auntieos-admin/web/functions';

/** The bundle's key for a voice file: forward slashes on every platform. */
const keyOf = (file) => file.split(path.sep).join('/');
const VOICE_KEYS = VOICE_FILES.map(keyOf);

/** A bundle that cannot be used. `message` never holds any of its content. */
export class VoiceBundleError extends Error {}

/** The voice files under `dir`, as the text Secret Manager stores. */
export function packVoice(dir) {
  const files = readVoiceFiles(dir);
  const json = JSON.stringify({ format: BUNDLE_FORMAT, files });
  return zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64');
}

/** `{ key: text }` for exactly the voice files, or a VoiceBundleError. */
export function unpackVoice(stored) {
  const text = String(stored ?? '').trim();
  if (!text) throw new VoiceBundleError('it is empty');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new VoiceBundleError('it is not base64');
  }
  let json;
  try {
    // A cap on what it may inflate to, so a stored value cannot fill the disk.
    json = zlib.gunzipSync(Buffer.from(text, 'base64'), { maxOutputLength: 16 * MAX_STORED_BYTES }).toString('utf8');
  } catch {
    throw new VoiceBundleError('it does not decompress');
  }
  let bundle;
  try {
    bundle = JSON.parse(json);
  } catch {
    throw new VoiceBundleError('it does not hold a bundle');
  }
  if (!bundle || typeof bundle !== 'object' || bundle.format !== BUNDLE_FORMAT) {
    throw new VoiceBundleError(`its format is not ${BUNDLE_FORMAT}`);
  }
  const files = bundle.files && typeof bundle.files === 'object' ? bundle.files : {};
  const held = VOICE_KEYS.filter((k) => typeof files[k] === 'string' && files[k].length > 0);
  if (held.length !== VOICE_KEYS.length) {
    throw new VoiceBundleError(`it holds ${held.length} of the ${VOICE_KEYS.length} voice files`);
  }
  // Only the names asked for are ever read out of it. A path the bundle
  // carries beyond those three is counted here and written nowhere.
  const extra = Object.keys(files).filter((k) => !VOICE_KEYS.includes(k)).length;
  if (extra) throw new VoiceBundleError(`it holds ${extra} file(s) that are not voice files`);
  return Object.fromEntries(VOICE_KEYS.map((k) => [k, files[k]]));
}

/** The voice files under `dir`, as `{ key: text }`. */
function readVoiceFiles(dir) {
  return Object.fromEntries(VOICE_FILES.map((file) => [keyOf(file), fs.readFileSync(path.join(dir, file), 'utf8')]));
}

/**
 * One digest for a set of voice files: what they say, whatever packed them.
 * Each file goes in with its name and its length, so text cannot move from the
 * end of one file to the start of the next and hash the same.
 */
export function voiceDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const key of VOICE_KEYS) {
    const text = Buffer.from(files[key], 'utf8');
    hash.update(`${key}\n${text.length}\n`);
    hash.update(text);
  }
  return hash.digest('hex');
}

/** Write `files` under `dir`, with `mode` on each file. */
function writeVoice(dir, files, mode) {
  for (const file of VOICE_FILES) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, files[keyOf(file)], { mode });
    fs.chmodSync(target, mode);
  }
}

/** Remove the voice files from `dir`, and the folders that held them if empty. */
export function removeVoice(dir) {
  for (const file of VOICE_FILES) fs.rmSync(path.join(dir, file), { force: true });
  for (const sub of [...new Set(VOICE_FILES.map((f) => path.dirname(f)).filter((d) => d !== '.'))]) {
    try {
      fs.rmdirSync(path.join(dir, sub));
    } catch {
      // Holds something this did not write. Leave it.
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    // Same.
  }
}

function timeoutMs() {
  const n = Number(process.env.CLIENT_SECRETS_GCLOUD_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_GCLOUD_TIMEOUT_MS;
}

/**
 * What Secret Manager holds under SECRET_NAME.
 *   { status: 'ok', value }                  the latest version's payload
 *   { status: 'absent' }                     the store answered; no such secret
 *   { status: 'unasked', why }               the store could not be asked
 *   { status: 'unreadable', why }            listed, and the value was refused
 */
export function readStored(project, { spawn = spawnSync } = {}) {
  const quiet = () => {};
  let store = { reason: '', detail: '' };
  const names = listSecretsWithGcloud(project, {
    spawn,
    timeoutMs: timeoutMs(),
    log: quiet,
    onUnavailable: (s) => {
      store = s;
    },
  });
  if (!Array.isArray(names)) return { status: 'unasked', why: unreadableWhy(store.reason, store.detail) };
  if (!names.includes(SECRET_NAME)) return { status: 'absent' };
  const value = makeGcloudFetcher(project, names, { spawn, timeoutMs: timeoutMs(), log: quiet })(SECRET_NAME);
  if (value === SECRET_UNREADABLE) return { status: 'unreadable', why: unreadableWhy('timeout') };
  if (isUnreadableValue(value)) return { status: 'unreadable', why: unreadableWhy(value.reason, value.detail) };
  return { status: 'ok', value: value ?? '' };
}

/** True when git ignores every voice file's path, so none can be committed. */
function voiceIsIgnored() {
  return VOICE_FILES.every((file) => {
    const r = spawnSync('git', ['-C', ROOT, 'check-ignore', '-q', '--', `${VOICE_REL}/${keyOf(file)}`]);
    return r.status === 0;
  });
}

function restore(project) {
  const dir = path.join(FUNCTIONS_DIR, 'voice');
  const here = VOICE_FILES.filter((f) => fs.existsSync(path.join(dir, f))).length;
  if (here > 0) {
    console.error(
      `voice: ${here} of the ${VOICE_FILES.length} voice files are already in this checkout. ` +
        'Nothing was restored over them.',
    );
    return 6;
  }

  const stored = readStored(project);
  if (stored.status === 'absent') {
    console.error(`voice: Secret Manager holds no ${SECRET_NAME}, so there is no stored copy to restore.`);
    return 3;
  }
  if (stored.status === 'unasked') {
    console.error(`voice: Secret Manager could not be asked for ${SECRET_NAME}. ${stored.why}`);
    return 4;
  }
  if (stored.status === 'unreadable') {
    console.error(`voice: ${SECRET_NAME} is in Secret Manager and its value could not be read. ${stored.why}`);
    return 5;
  }

  let files;
  try {
    files = unpackVoice(stored.value);
  } catch (e) {
    if (!(e instanceof VoiceBundleError)) throw e;
    console.error(`voice: the stored copy (${SECRET_NAME}) cannot be used: ${e.message}.`);
    return 1;
  }

  // Checked in a private folder outside the checkout first, so a stored copy
  // generate.js would refuse never lands where a deploy could pick it up.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-restore-'));
  try {
    writeVoice(scratch, files, 0o600);
    const verdict = checkVoice(scratch);
    if (verdict.status !== 'ok') {
      console.error(`voice: the stored copy (${SECRET_NAME}) was ${verdict.status} (${verdict.code}): ${verdict.message}`);
      return 1;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  if (!voiceIsIgnored()) {
    console.error(
      `voice: git does not ignore ${VOICE_REL}/ in this checkout, so the files were not written there. ` +
        'They hold real names and must never be committable.',
    );
    return 1;
  }
  try {
    // 0644, the mode a `cp` on the Mac leaves: the deploy zips these files as
    // they are and the function reads them as another user.
    writeVoice(dir, files, 0o644);
  } catch (e) {
    removeVoice(dir);
    console.error(`voice: could not write the restored files (${e.code || 'error'}).`);
    return 1;
  }
  console.log(`voice: restored ${VOICE_FILES.length} files from Secret Manager (${SECRET_NAME}) for this run`);
  return 0;
}

function clean() {
  removeVoice(path.join(FUNCTIONS_DIR, 'voice'));
  const left = VOICE_FILES.filter((f) => fs.existsSync(path.join(FUNCTIONS_DIR, 'voice', f))).length;
  if (left) {
    console.error(`voice: ${left} restored file(s) could not be removed from ${VOICE_REL}/`);
    return 1;
  }
  console.log(`voice: nothing of the restored copy is left in ${VOICE_REL}/`);
  return 0;
}

function compare(project) {
  const dir = path.join(FUNCTIONS_DIR, 'voice');
  const here = VOICE_FILES.filter((f) => fs.existsSync(path.join(dir, f))).length;
  if (here !== VOICE_FILES.length) {
    console.error(
      `voice: ${here} of the ${VOICE_FILES.length} voice files are in this checkout, so there is nothing to ` +
        'compare the stored copy with.',
    );
    return 6;
  }
  const mine = voiceDigest(readVoiceFiles(dir));

  const stored = readStored(project);
  if (stored.status === 'absent') {
    console.error(`voice: Secret Manager holds no ${SECRET_NAME}.`);
    return 3;
  }
  if (stored.status === 'unasked') {
    console.error(`voice: Secret Manager could not be asked for ${SECRET_NAME}. ${stored.why}`);
    return 4;
  }
  if (stored.status === 'unreadable') {
    console.error(`voice: ${SECRET_NAME} is in Secret Manager and its value could not be read. ${stored.why}`);
    return 5;
  }

  let theirs;
  try {
    theirs = voiceDigest(unpackVoice(stored.value));
  } catch (e) {
    if (!(e instanceof VoiceBundleError)) throw e;
    console.error(`voice: the stored copy (${SECRET_NAME}) cannot be used: ${e.message}.`);
    return 8;
  }
  if (theirs !== mine) {
    console.error(`voice: the stored copy (${SECRET_NAME}) does not hold the files in this checkout.`);
    return 7;
  }
  console.log(`voice: the stored copy (${SECRET_NAME}) holds the same ${VOICE_FILES.length} files`);
  return 0;
}

/** One gcloud call that changes the store. Returns '' or why it failed. */
function gcloudWrite(args, input) {
  const r = spawnSync('gcloud', args, {
    encoding: 'utf8',
    input,
    timeout: timeoutMs(),
    killSignal: 'SIGKILL',
  });
  if (isGcloudTimeout(r)) return unreadableWhy('timeout');
  if (r.error || r.status !== 0) return classifyAccessFailure(r).detail || 'gcloud failed';
  return '';
}

function push(project) {
  const dir = path.join(FUNCTIONS_DIR, 'voice');
  const verdict = checkVoice(dir);
  if (verdict.status === 'absent') {
    console.error(`voice: ${verdict.message}. Nothing was stored. Copy them in first:`);
    console.error(`  ${SYNC_COMMAND}`);
    return 1;
  }
  if (verdict.status !== 'ok') {
    console.error(`voice: ${verdict.status} (${verdict.code}): ${verdict.message}`);
    console.error('voice: nothing was stored. A release would refuse these files, so a stored copy of them');
    console.error('  would refuse every scheduled release.');
    return 1;
  }

  const bundle = packVoice(dir);
  const stored = Buffer.byteLength(bundle);
  const text = VOICE_FILES.reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
  if (stored > MAX_STORED_BYTES) {
    console.error(
      `voice: the files pack to ${stored} bytes and one Secret Manager version holds ${MAX_STORED_BYTES}. ` +
        'Nothing was stored.',
    );
    return 1;
  }

  const before = readStored(project);
  if (before.status === 'unasked') {
    console.error(`voice: Secret Manager could not be asked. ${before.why} Nothing was stored.`);
    return 4;
  }
  if (before.status === 'ok' && before.value.trim() === bundle) {
    console.log(`voice: Secret Manager already holds these ${VOICE_FILES.length} files (${SECRET_NAME}). Nothing to store.`);
    return 0;
  }
  if (before.status === 'absent') {
    const why = gcloudWrite(['secrets', 'create', SECRET_NAME, '--project', project, '--replication-policy', 'automatic']);
    if (why) {
      console.error(`voice: could not create ${SECRET_NAME}. ${why}`);
      return 1;
    }
    console.log(`voice: created ${SECRET_NAME} in ${project}`);
  }
  // On stdin, never on the command line: a process list is readable by others.
  const why = gcloudWrite(['secrets', 'versions', 'add', SECRET_NAME, '--project', project, '--data-file=-'], bundle);
  if (why) {
    console.error(`voice: could not store a new version of ${SECRET_NAME}. ${why}`);
    return 1;
  }

  // Read it back. A store command that exits 0 has been wrong here before: a
  // secret saved empty looks, in every listing, like one saved whole.
  const after = readStored(project);
  if (after.status !== 'ok' || after.value.trim() !== bundle) {
    console.error(
      `voice: ${SECRET_NAME} was stored, and what Secret Manager hands back is not what was sent` +
        `${after.why ? ` (${after.why})` : ''}. Run this again.`,
    );
    return 1;
  }
  console.log(
    `voice: stored ${VOICE_FILES.length} files as ${SECRET_NAME} and read them back ` +
      `(${text} bytes of text, ${stored} of ${MAX_STORED_BYTES} bytes used)`,
  );
  console.log(`voice: sample names ${verdict.message}`);
  return 0;
}

function main(argv) {
  const at = argv.indexOf('--project');
  const project = (at >= 0 && argv[at + 1]) || process.env.GCLOUD_PROJECT || 'auntieos-ttpc';
  switch (argv[0]) {
    case 'restore':
      return restore(project);
    case 'clean':
      return clean();
    case 'push':
      return push(project);
    case 'compare':
      return compare(project);
    default:
      console.error('usage: node scripts/voice-secret.mjs restore|clean|push|compare [--project P]');
      console.error('  restore  put the stored voice files into a checkout that has none (release step 1b)');
      console.error('  clean    take them out again');
      console.error(`  push     store this checkout's voice files, after: ${SYNC_COMMAND}`);
      console.error("  compare  say whether the stored copy is this checkout's voice files");
      return 2;
  }
}

// realpathSync on both sides, for the reason client-secrets.mjs gives: under
// /tmp on macOS the two spellings differ and the script would exit 0 unrun.
const invokedAs = process.argv[1] ? fs.realpathSync(path.resolve(process.argv[1])) : '';
if (invokedAs === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    // The code, never the message: an error from reading or parsing a voice
    // file can quote the file.
    console.error(`voice: stopped on an unexpected error (${e.code || e.name || 'error'}).`);
    process.exit(1);
  }
}
