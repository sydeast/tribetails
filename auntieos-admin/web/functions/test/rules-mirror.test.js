// Guard: web/firestore.rules must stay byte-identical to MyTribe's copy.
//
// WHY THIS EXISTS
// AuntieOS and the MyTribe portal share ONE Firebase project (auntieos-ttpc).
// Both trees' firebase.json declare a firestore.rules file, so `firebase deploy
// --only firestore` from EITHER tree overwrites the project's live rules with
// whatever that tree happens to hold.
//
// On 2026-07-15 this had already drifted: AuntieOS's copy was 3 weeks stale
// (2026-06-22 vs 2026-07-13). Deploying from AuntieOS would have reverted the
// scoped kinfolk read on /conversations and killed the live portal's realtime
// Messages screen. It went unnoticed because the header comment was copied into
// both files, so each claimed to be "the single source of truth", and it named
// sotu-hosting/ as the deploy point (that config is hosting-only and has no
// firestore block at all).
//
// MyTribe/firestore.rules is the source of truth (owner ruling 2026-07-15).
//
// The mirror used to be a hand-kept COPY, which is what drifted. It is now a
// SYMLINK to mytribe/firestore.rules, so there is no second copy to drift: the
// emulator and visual harness read the source through the link, and a rules
// deploy from this tree (already refused by scripts/safe-deploy.sh) would push
// the current source, not a stale copy. Drift is now structurally impossible.
//
// The byte-identity check below is therefore belt-and-suspenders. The primary
// guard is now the "is a symlink" test: if someone converts it back to a real
// copy, drift becomes possible again and that test fails, pointing them back to
// the symlink.
//
// Run: cd web/functions && npm test

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// MyTribe lives IN this repo now (monorepo prefix `mytribe/`), so the source of
// truth is a relative path that always resolves, including on CI.
//
// It used to point at a machine-local sibling checkout. When that tree was
// archived on 2026-07-21 this test did not fail, it SKIPPED, reporting
// "Rules-drift is UNCHECKED" into a green run. A guard that quietly stops
// guarding is worse than no guard, because the green suite says otherwise.
const MONOREPO_SOURCE = path.resolve(__dirname, '..', '..', '..', '..', 'mytribe', 'firestore.rules');

// Escape hatch for a checkout where the prefix genuinely is not present.
const SOURCE = process.env.MYTRIBE_ROOT
  ? path.join(process.env.MYTRIBE_ROOT, 'firestore.rules')
  : MONOREPO_SOURCE;

const MIRROR = path.resolve(__dirname, '..', '..', 'firestore.rules');

describe('firestore.rules mirror (shared project auntieos-ttpc)', () => {
  it('the AuntieOS mirror exists', () => {
    assert.ok(fs.existsSync(MIRROR), `missing mirror: ${MIRROR}`);
  });

  it('is a SYMLINK to the source, so no copy can drift', () => {
    // lstat, not stat: stat follows the link and would report the target's type.
    // This is the primary guard now. A regression to a real copy reintroduces the
    // whole drift class, so catch it here rather than trust byte-identity alone.
    const st = fs.lstatSync(MIRROR);
    assert.ok(
      st.isSymbolicLink(),
      'web/firestore.rules is no longer a symlink. It must point at ' +
        'mytribe/firestore.rules so the two cannot diverge. Restore it with:\n' +
        '  rm auntieos-admin/web/firestore.rules && ' +
        'ln -s ../../mytribe/firestore.rules auntieos-admin/web/firestore.rules',
    );
    const target = fs.readlinkSync(MIRROR);
    assert.strictEqual(
      target,
      '../../mytribe/firestore.rules',
      `the mirror symlink points at '${target}', not at the source of truth ` +
        '(../../mytribe/firestore.rules).',
    );
  });

  it('is byte-identical to MyTribe/firestore.rules (the source of truth)', () => {
    // FAILS rather than skips when the source is missing. Both trees are in this
    // repo, so an absent source means the checkout is broken or the layout moved,
    // and either way the drift guard is not running. That must be loud.
    assert.ok(
      fs.existsSync(SOURCE),
      `rules source not found at ${SOURCE}. The drift guard cannot run, so this ` +
        `fails instead of skipping. If the layout moved, fix the path here; to ` +
        `point at a checkout elsewhere, set MYTRIBE_ROOT.`,
    );

    const mirror = fs.readFileSync(MIRROR, 'utf8');
    const source = fs.readFileSync(SOURCE, 'utf8');

    assert.strictEqual(
      mirror,
      source,
      'web/firestore.rules has DRIFTED from MyTribe/firestore.rules. Both deploy ' +
        'to project auntieos-ttpc, so deploying from this tree would overwrite ' +
        `live rules with the stale copy. Fix: cp ${SOURCE} ${MIRROR}`,
    );
  });

  it('still carries the scoped kinfolk read the live portal depends on', (t) => {
    if (!fs.existsSync(MIRROR)) return t.skip('no mirror');
    const mirror = fs.readFileSync(MIRROR, 'utf8');
    // MyTribe web/src/lib/messagesListener.ts opens an onSnapshot on
    // /conversations/{kinfolkId}. Without this read the Messages screen goes
    // permission-denied. Two occurrences: the thread doc and its messages.
    const matches = mirror.match(
      /allow read: if isAuntie\(\) \|\| \(isKinfolk\(\) && kinfolkId == request\.auth\.token\.kinfolkId\)/g,
    );
    assert.strictEqual(
      matches && matches.length,
      2,
      'the scoped kinfolk read on /conversations is missing or changed shape; ' +
        'the portal Messages realtime listener depends on it',
    );
  });
});
