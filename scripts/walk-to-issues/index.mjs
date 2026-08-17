#!/usr/bin/env node
import { gunzipSync } from 'node:zlib';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { renderMarks } from './replay.mjs';
import { draftIssues, findDuplicates, fileIssues } from './issues.mjs';

/**
 * Turns one recorded walk into GitHub issues.
 *
 * The walk comes out of `packages/issue-recorder`: the operator opens the app,
 * presses Ctrl+Shift+X whenever something is wrong, and exports one `.json.gz`
 * at the end. This is the other half. It replays each marked moment, photographs
 * it, drafts an issue that a reader can act on without having been there, and
 * shows the drafts.
 *
 *   node scripts/walk-to-issues/index.mjs ~/Downloads/walk-portal-....json.gz
 *   node scripts/walk-to-issues/index.mjs <walk> --file      # actually opens them
 *
 * NOTHING IS FILED WITHOUT `--file`. Opening issues is public and irreversible,
 * and a drafting mistake would be visible on the repo to everyone. So the
 * default is a dry run that writes the drafts to disk and prints them; `--file`
 * is the operator saying yes after reading them.
 *
 * DUPLICATES ARE SHOWN, NEVER SKIPPED. Operator ruling: a mark that looks like
 * an existing issue is still worth seeing, because "we already know" is a
 * judgement about whether the same defect is still happening, and the person
 * who walked the app is the one who can make it. The dedupe pass annotates; it
 * does not filter.
 */

function usage(message) {
  if (message) console.error(`\n${message}`);
  console.error(`
Usage: node scripts/walk-to-issues/index.mjs <walk.json.gz> [options]

  --file            actually create the GitHub issues (default is a dry run)
  --out <dir>       where screenshots and drafts are written
                    (default: .walks/<walk name>/)

The walk file is what "End walk & export" drops in Downloads.
`);
  process.exit(message ? 1 : 0);
}

/** Reads the export back. Gzipped because an hour of rrweb events is tens of megabytes raw. */
function readWalk(path) {
  const raw = readFileSync(path);
  // Tolerates an already-decompressed file, because the obvious thing to do
  // with a .gz is to unzip it first, and failing on that would be a puzzle
  // rather than a message.
  const json = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  const walk = JSON.parse(json);
  if (!Array.isArray(walk.marks) || !Array.isArray(walk.events)) {
    throw new Error(`${path} does not look like a walk: no marks/events arrays`);
  }
  return walk;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage();

  const walkPath = resolve(args.find((a) => !a.startsWith('--')) ?? usage('No walk file given'));
  const shouldFile = args.includes('--file');
  const outFlag = args.indexOf('--out');
  const outDir = resolve(
    outFlag === -1 ? join('.walks', basename(walkPath).replace(/\.json(\.gz)?$/, '')) : args[outFlag + 1],
  );

  const walk = readWalk(walkPath);
  mkdirSync(outDir, { recursive: true });

  console.log(`\nWalk: ${walk.meta.app} on ${walk.meta.origin}`);
  console.log(`Started ${walk.meta.startedIso}, ${walk.marks.length} mark(s), ${walk.events.length} events`);
  if (walk.marks.length === 0) {
    console.log('\nNothing was marked, so there is nothing to file.');
    return;
  }

  console.log(`\nReplaying and photographing ${walk.marks.length} mark(s)...`);
  const shots = await renderMarks(walk, outDir);
  for (const shot of shots) {
    console.log(`  ${shot.ok ? 'ok  ' : 'FAIL'} ${shot.markId}${shot.error ? `: ${shot.error}` : ''}`);
  }

  const drafts = await findDuplicates(draftIssues(walk, shots));

  // Written to disk as well as printed. A terminal scrollback is not somewhere
  // an operator can review twelve issue bodies from.
  for (const draft of drafts) {
    writeFileSync(join(outDir, `${draft.markId}.md`), `# ${draft.title}\n\n${draft.body}\n`);
  }

  console.log(`\n${drafts.length} draft(s), written to ${outDir}\n`);
  for (const draft of drafts) {
    console.log(`  ${draft.markId}: ${draft.title}`);
    for (const dupe of draft.duplicates ?? []) {
      console.log(`      possible duplicate of #${dupe.number}: ${dupe.title}`);
    }
  }

  if (!shouldFile) {
    console.log(`\nDry run. Read the drafts, then re-run with --file to open them.`);
    return;
  }

  console.log(`\nFiling ${drafts.length} issue(s)...`);
  const filed = await fileIssues(drafts, { confirm: true });
  for (const result of filed) {
    if (result.error) console.log(`  FAIL ${result.draft.markId}: ${result.error}`);
    else if (result.skipped) console.log(`  skipped ${result.draft.markId}`);
    else console.log(`  ${result.url}`);
  }
}

main().catch((err) => {
  console.error(`\nwalk-to-issues failed: ${err.message}`);
  process.exit(1);
});
