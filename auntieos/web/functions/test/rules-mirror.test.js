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
// AuntieOS's copy is a mirror, kept only so the emulator + visual harness run
// against real rules. To change rules: edit MyTribe's file, then copy it here.
//
// Run: cd web/functions && npm test

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Machine-local sibling repo. Override with MYTRIBE_ROOT if the tree moves.
const MYTRIBE_ROOT =
  process.env.MYTRIBE_ROOT || '/Users/sydeast/Projects/testai/CascadeProjects/MyTribe';

const MIRROR = path.resolve(__dirname, '..', '..', 'firestore.rules');
const SOURCE = path.join(MYTRIBE_ROOT, 'firestore.rules');

describe('firestore.rules mirror (shared project auntieos-ttpc)', () => {
  it('the AuntieOS mirror exists', () => {
    assert.ok(fs.existsSync(MIRROR), `missing mirror: ${MIRROR}`);
  });

  it('is byte-identical to MyTribe/firestore.rules (the source of truth)', (t) => {
    if (!fs.existsSync(SOURCE)) {
      // Not a failure: the MyTribe tree is a separate repo and may not be
      // checked out here (e.g. CI). Skipping loudly beats failing spuriously,
      // and beats passing silently.
      t.skip(
        `MyTribe tree not found at ${SOURCE}. Rules-drift is UNCHECKED in this ` +
          `run. Set MYTRIBE_ROOT to enable.`,
      );
      return;
    }

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
