import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { NOTIFICATION_CATALOG } from '../src/notifications/catalog';

/**
 * THE PRE-LAUNCH HOUSEHOLD SEND GATE HAS ONE CHOKEPOINT, AND THIS REFUSES A
 * SECOND WAY ROUND IT.
 *
 * `enqueueNotificationDetailed` holds back every household-bound copy until the
 * operator opens the product (notifications/householdSendGate.ts). That is only
 * worth anything while it is the ONLY road to a household. A new cron that wrote
 * `scheduledNotifications` itself, or a new callable that reached for
 * `sendTemplatedEmail`, would reach real people with the gate shut and nothing
 * would say so: the send succeeds, the log is clean, and the first sign is a
 * household asking about a bill from the old system.
 *
 * So this scan fails the moment a source file touches a delivery collection or a
 * raw transport without being on a list with a reason beside it. Same shape as
 * `clientIpReaders.test.ts` (#910) and `adminAppAccessors.test.ts` (#912),
 * including their self-checks, because both of those had earlier drafts that
 * passed against an empty file list and proved nothing.
 *
 * WHAT IT DOES NOT CLAIM. It is a scan, not a proof. It cannot see a delivery
 * assembled from string fragments, and it does not follow calls. It is a
 * tripwire on the shapes that exist in this tree today, and a reviewer adding a
 * file to a list below has to write down why.
 */
const REPO = resolve(__dirname, '../../..');
const ROOT = 'mytribe/functions/src';

/** Not our source. `lib` is NOT skipped: `src/lib` is where a rogue copy would go. */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', '__tests__']);

/** Proof the walk reaches the nested directories the real hits live in. */
const MUST_SCAN = [
  'mytribe/functions/src/notifications/dispatcher.ts',
  'mytribe/functions/src/notifications/senders/emailChannel.ts',
  'mytribe/functions/src/scheduled/notificationScheduledSweep.ts',
  'mytribe/functions/src/lib/email.ts',
  'mytribe/functions/src/admin/broadcastMessage.ts',
];

/**
 * FAMILY 1: the delivery collections. Writing one of these IS dispatching; the
 * sweeps and the channel fan-out trigger pick them up and send.
 *
 * FAMILY 2: the raw transports. Anything here talks to a provider directly and
 * no gate, preference or catalog row stands between it and a phone.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ['notifications collection', /collection\(\s*['"]notifications['"]\s*\)/],
  ['pendingNotifications', /['"]pendingNotifications['"]/],
  ['scheduledNotifications', /['"]scheduledNotifications['"]/],
  ['notificationBatch', /['"]notificationBatch['"]/],
  ['notificationDispatch', /['"]notificationDispatch['"]|\bDISPATCH_COLLECTION\b/],
  ['sendTemplatedEmail', /\bsendTemplatedEmail\b/],
  ['messages.create (Twilio)', /\bmessages\s*\.\s*create\b/],
  ['messaging() (FCM)', /\bmessaging\(\)/],
];

/**
 * The files allowed to touch a delivery path, each with the reason.
 *
 * Three kinds of entry, and the third kind is a standing report rather than an
 * endorsement:
 *
 *   1. THE GATED PATH ITSELF, and the machinery that carries what it already
 *      passed (the dispatcher, the sweeps, promoteQueued, the channel senders).
 *   2. NOT A SEND AT ALL: reading, listing, marking read, archiving, cancelling.
 *   3. KNOWN BYPASSES, all operator-initiated, none on a schedule. These reach a
 *      household without passing the gate, and they are listed here rather than
 *      fixed because the approved scope of this work is the dispatcher
 *      chokepoint. They are named in the PR body. Nothing here fires by itself:
 *      each one needs the operator to press a button, and the operator is the
 *      person who decides when the product opens.
 */
const ALLOWED = new Map<string, string>([
  // ── 1. the gated path ──────────────────────────────────────────────────────
  [
    'mytribe/functions/src/notifications/dispatcher.ts',
    'the chokepoint itself; the gate lives in its per-recipient loop',
  ],
  [
    'mytribe/functions/src/notifications/promoteQueued.ts',
    'promotes a queue row the dispatcher already gated; it cannot create a send',
  ],
  [
    'mytribe/functions/src/scheduled/notificationDebounceSweep.ts',
    'promotes gated pendingNotifications rows, transactionally',
  ],
  [
    'mytribe/functions/src/scheduled/notificationScheduledSweep.ts',
    'promotes gated scheduledNotifications rows, transactionally',
  ],
  [
    'mytribe/functions/src/scheduled/notificationBatchSweep.ts',
    'promotes gated notificationBatch rows, transactionally',
  ],
  [
    'mytribe/functions/src/notifications/senders/emailChannel.ts',
    'the email transport, driven only by a gated work order',
  ],
  [
    'mytribe/functions/src/notifications/senders/smsChannel.ts',
    'the SMS transport, driven only by a gated work order',
  ],
  [
    'mytribe/functions/src/notifications/senders/pushChannel.ts',
    'the push transport, driven only by a gated work order',
  ],
  ['mytribe/functions/src/lib/email.ts', 'the email primitive itself; it addresses nobody on its own'],
  ['mytribe/functions/src/lib/firestoreAdmin.ts', 'the admin SDK shim; exposes messaging(), sends nothing'],

  // ── 2. not a send ──────────────────────────────────────────────────────────
  ['mytribe/functions/src/portal/markNotificationRead.ts', 'marks an existing inbox doc read'],
  ['mytribe/functions/src/portal/bulkMarkNotificationsRead.ts', 'marks existing inbox docs read'],
  ['mytribe/functions/src/portal/archiveNotification.ts', 'archives existing inbox docs'],
  ['mytribe/functions/src/admin/listNotificationDeliveries.ts', 'reads the work-order collection'],
  [
    'mytribe/functions/src/admin/marketingBlasts.ts',
    'DELETES queued blast copies on cancel; it never writes one',
  ],
  [
    'mytribe/functions/src/lib/aiCopy.ts',
    'messages.create on the ANTHROPIC client, not Twilio; drafts copy, sends nothing',
  ],

  // ── 3. known bypasses, operator-initiated, reported not fixed ──────────────
  [
    'mytribe/functions/src/admin/broadcastMessage.ts',
    'BYPASS: emails/texts/pushes households directly and writes its own inbox doc. ' +
      'Honors resolveChannels but not the gate. Operator presses Send; never scheduled.',
  ],
  [
    'mytribe/functions/src/admin/sendExternalMessage.ts',
    'BYPASS: one operator-composed email or text to one household. Never scheduled.',
  ],
  [
    'mytribe/functions/src/lib/sendFromTemplate.ts',
    'BYPASS: invite and recovery mail, outside the catalog entirely. ' +
      'Operator-initiated, and onboarding is what has to work while the gate is shut.',
  ],
  [
    'mytribe/functions/src/twilio/voicePush.ts',
    'pushes an incoming-call alert to STAFF devices, not to households',
  ],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(full));
    } else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

/** Drops block and line comments, keeping `://` inside URLs. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

export function deliveryPathsIn(text: string): string[] {
  const code = stripComments(text);
  return PATTERNS.filter(([, re]) => re.test(code)).map(([label]) => label);
}

const rel = (f: string): string => relative(REPO, f).split('\\').join('/');

describe('household send gate: the dispatcher is the only road to a household', () => {
  it('the patterns catch every spelling they are for, and ignore comments', () => {
    expect(deliveryPathsIn("db().collection('notifications').doc().set(x);")).toEqual([
      'notifications collection',
    ]);
    expect(deliveryPathsIn('db().collection("notifications").doc();')).toEqual(['notifications collection']);
    expect(deliveryPathsIn("await db().collection('scheduledNotifications').add(row);")).toEqual([
      'scheduledNotifications',
    ]);
    expect(deliveryPathsIn("const p = 'pendingNotifications';")).toEqual(['pendingNotifications']);
    expect(deliveryPathsIn("doc('notificationBatch');")).toEqual(['notificationBatch']);
    expect(deliveryPathsIn('w.set(db().collection(DISPATCH_COLLECTION).doc(id), x);')).toEqual([
      'notificationDispatch',
    ]);
    expect(deliveryPathsIn('await sendTemplatedEmail({ to });')).toEqual(['sendTemplatedEmail']);
    expect(deliveryPathsIn('await twilio.messages.create({ to });')).toEqual(['messages.create (Twilio)']);
    expect(deliveryPathsIn('getAdmin().messaging().sendEachForMulticast(m);')).toEqual(['messaging() (FCM)']);
    // Comments explaining why not to do a thing must not trip the scan.
    expect(deliveryPathsIn("// never write scheduledNotifications here\nconst a = 1;")).toEqual([]);
    expect(deliveryPathsIn('/** not `sendTemplatedEmail` */\nconst a = 1;')).toEqual([]);
    // Near misses that are not delivery paths.
    expect(deliveryPathsIn('const p = data.notificationPrefs; const q = notificationsRead;')).toEqual([]);
    expect(deliveryPathsIn("collection('notificationDedupe');")).toEqual([]);
  });

  it('the root exists and holds source, so the scan cannot pass on an empty tree', () => {
    expect(sourceFiles(resolve(REPO, ROOT)).length).toBeGreaterThan(100);
  });

  it('the walk reaches nested directories, so a skip-list edit cannot quietly shrink it', () => {
    const scanned = new Set(sourceFiles(resolve(REPO, ROOT)).map(rel));
    for (const f of MUST_SCAN) expect(scanned, `${f} is scanned`).toContain(f);
  });

  it('every allowed file still exists, so a stale entry cannot hide a new one', () => {
    for (const f of ALLOWED.keys()) {
      expect(() => statSync(resolve(REPO, f)), `${f} still exists`).not.toThrow();
    }
  });

  it('every allowed file really does match, so no entry is dead weight and no pattern is dead', () => {
    const matchedLabels = new Set<string>();
    for (const [f, reason] of ALLOWED) {
      const found = deliveryPathsIn(readFileSync(resolve(REPO, f), 'utf8'));
      expect(found, `${f} is allowed for "${reason}" but matches nothing`).not.toEqual([]);
      for (const label of found) matchedLabels.add(label);
    }
    // Every pattern is exercised by at least one real file, so none of them is
    // a regex that never fires and therefore never protects anything.
    for (const [label] of PATTERNS) {
      expect(matchedLabels, `pattern "${label}" matches no file in the tree`).toContain(label);
    }
  });

  it('no other source file writes a delivery collection or reaches a raw transport', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const file of sourceFiles(resolve(REPO, ROOT))) {
      scanned += 1;
      const r = rel(file);
      if (ALLOWED.has(r)) continue;
      const found = deliveryPathsIn(readFileSync(file, 'utf8'));
      if (found.length > 0) offenders.push(`${r}: ${found.join(', ')}`);
    }
    expect(scanned).toBeGreaterThan(100);
    expect(
      offenders,
      'send through enqueueNotificationDetailed (notifications/dispatcher.ts), which is gated',
    ).toEqual([]);
  });
});

/**
 * The gate keys on the per-copy audience stream, and `streamForRecipient`
 * derives that from the collection the resolver put the recipient in. This pins
 * the equivalence the dispatcher's comment claims: a household-side resolver and
 * `audiences.kinfolk` are the same statement, said twice.
 *
 * Without this, a new catalog row with `recipientResolver: 'specificUid'` and
 * `audiences: { business: true }` would put an operator-addressed notification
 * in `clients/` and the gate would silence it. That is the safe direction, which
 * is exactly why nobody would notice.
 */
describe('household send gate: the catalog cannot drift out from under the classifier', () => {
  const HOUSEHOLD_RESOLVERS = new Set(['kinfolkAcct', 'specificUid']);

  it('a household-side resolver and audiences.kinfolk always agree', () => {
    const rows = Object.values(NOTIFICATION_CATALOG);
    expect(rows.length).toBeGreaterThan(40);

    const mismatched: string[] = [];
    let householdSided = 0;
    for (const def of rows) {
      const resolvers = [def.recipientResolver, def.secondaryResolver].filter(Boolean) as string[];
      const household = resolvers.some((r) => HOUSEHOLD_RESOLVERS.has(r));
      if (household) householdSided += 1;
      if (household !== (def.audiences.kinfolk === true)) {
        mismatched.push(`${def.key}: resolvers=[${resolvers.join(', ')}] audiences.kinfolk=${def.audiences.kinfolk}`);
      }
    }
    // Proof the loop found the case it is about, rather than passing on nothing.
    expect(householdSided, 'the catalog really does have household-side rows').toBeGreaterThan(10);
    expect(
      mismatched,
      'a clients/ recipient must mean audiences.kinfolk, or the gate classifies the wrong copies',
    ).toEqual([]);
  });
});

/**
 * A structural read of the dispatcher, because the gate's whole safety argument
 * is WHERE it sits. Below `routeByDeliveryMode` it would still suppress the
 * send, every behavioural test bar one would still pass, and the
 * `notificationDedupe` ledger would be stamped for a delivery that never
 * happened. `householdSendGate.test.ts` catches that from the outside; this
 * catches it in the diff.
 */
describe('household send gate: it sits above the dedupe ledger write', () => {
  const source = readFileSync(
    resolve(REPO, 'mytribe/functions/src/notifications/dispatcher.ts'),
    'utf8',
  );
  const code = stripComments(source);

  it('the dispatcher consults the gate at all', () => {
    expect(code).toContain('loadHouseholdSendGate');
    expect(code).toMatch(/stream === 'kinfolk'/);
  });

  /**
   * The shared fixture builder seeds the gate OPEN so that the suites written
   * before the gate existed keep describing a running business. If that seeding
   * were deleted, the whole notification estate would silently start testing a
   * shut door and stay green only because every assertion about delivery would
   * have been rewritten to match. Pinned here so it is a deliberate change.
   */
  it('the shared fixture builder still states which side of the gate it tests on', () => {
    const helper = readFileSync(resolve(REPO, 'mytribe/functions/test/_helpers/mockDb.ts'), 'utf8');
    expect(stripComments(helper)).toContain('householdNotificationsLive');
  });

  it('the gate check precedes the routeByDeliveryMode call it protects', () => {
    const gateAt = code.indexOf("stream === 'kinfolk'");
    const routeAt = code.indexOf('await routeByDeliveryMode(');
    expect(gateAt, 'the gate check is present').toBeGreaterThan(-1);
    expect(routeAt, 'routeByDeliveryMode is still called').toBeGreaterThan(-1);
    expect(gateAt, 'the gate must run BEFORE the write that stamps the dedupe ledger').toBeLessThan(routeAt);
  });
});
